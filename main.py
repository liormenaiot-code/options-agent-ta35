import asyncio
import json as _json
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from functools import partial
from hashlib import md5

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

load_dotenv()

if not os.getenv("OPENROUTER_API_KEY"):
    import warnings
    warnings.warn("OPENROUTER_API_KEY is not set.", stacklevel=1)

import httpx

from analyzer import analyze_market_sync
from scraper import (
    scrape_all, get_expiry_dates,
    _fetch_tase_putvscall, _fetch_tradeboost_expiry_dates, TASE_PUTVSCALL_SOURCE_URL,
    _fetch_ta35_stock_prices,
)

# ── IN-MEMORY CACHE ──────────────────────────────────────────────────
_cache: dict = {}
CACHE_TTL      = 1800   # 30 min — data freshness
PREWARM_DELAY  = 1500   # 25 min — start next refresh before TTL expires

# Per-key in-progress future (so parallel requests share one AI call)
_in_flight: dict[str, asyncio.Future] = {}

_prewarm_handle: asyncio.TimerHandle | None = None


def _cache_key(expiry, profile_str):
    raw = f"{expiry or ''}|{profile_str or ''}"
    return md5(raw.encode()).hexdigest()


def _get_cached(key):
    entry = _cache.get(key)
    if entry:
        age = time.time() - entry["ts"]
        return entry["data"], age < CACHE_TTL
    return None, False


def _set_cached(key, data):
    _cache[key] = {"data": data, "ts": time.time()}
# ─────────────────────────────────────────────────────────────────────


async def _run_analysis(expiry=None, trader_profile=None) -> dict | None:
    """
    Scrape + AI analysis.  Uses an in-flight future so N concurrent callers
    for the same key share a single AI round-trip.
    """
    profile_str = _json.dumps(trader_profile) if trader_profile else None
    key = _cache_key(expiry, profile_str)

    # If another coroutine is already working on this key, piggyback on it
    if key in _in_flight:
        try:
            return await asyncio.shield(_in_flight[key])
        except Exception:
            return None

    loop = asyncio.get_event_loop()
    fut: asyncio.Future = loop.create_future()
    _in_flight[key] = fut

    try:
        scraped_data = await scrape_all()
        result = await loop.run_in_executor(
            None, partial(analyze_market_sync, scraped_data, expiry, trader_profile)
        )
        if result.get("error"):
            fut.set_result(None)
            return None

        payload = {
            "scraped_data": scraped_data,
            "analysis":     result["analysis"],
            "usage":        result.get("usage"),
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "from_cache":   False,
        }
        _set_cached(key, payload)
        fut.set_result(payload)
        _schedule_prewarm(expiry, trader_profile)
        return payload

    except Exception as exc:
        if not fut.done():
            fut.set_exception(exc)
        return None
    finally:
        _in_flight.pop(key, None)


def _schedule_prewarm(expiry=None, trader_profile=None):
    """Schedule silent refresh 25 min after last cache write."""
    global _prewarm_handle
    if _prewarm_handle:
        _prewarm_handle.cancel()

    def _trigger():
        asyncio.create_task(_run_analysis(expiry, trader_profile))

    loop = asyncio.get_event_loop()
    _prewarm_handle = loop.call_later(PREWARM_DELAY, _trigger)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Fire pre-warm 2 s after startup so the port is bound first
    async def _prewarm():
        await asyncio.sleep(2)
        await _run_analysis()

    asyncio.create_task(_prewarm())
    yield
    if _prewarm_handle:
        _prewarm_handle.cancel()


app = FastAPI(
    title='אנליזת אופציות ת"א 35',
    docs_url=None, redoc_url=None,
    lifespan=lifespan,
)
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def serve_index():
    return FileResponse("static/index.html", headers={"Cache-Control": "no-store"})


@app.get("/health")
async def health():
    warming = bool(_in_flight)   # tells client if a warm-up is in progress
    return {"status": "ok", "warming": warming,
            "timestamp": datetime.now(timezone.utc).isoformat()}


@app.get("/api/expiry-dates")
async def expiry_dates_endpoint():
    return JSONResponse({"expiry_dates": get_expiry_dates()})


@app.get("/api/analyze")
async def get_analysis(
    expiry:  str  = Query(default=None),
    profile: str  = Query(default=None),
    force:   bool = Query(default=False),
):
    try:
        trader_profile = None
        if profile:
            try:
                trader_profile = _json.loads(profile)
            except Exception:
                pass

        key = _cache_key(expiry, profile)

        if not force:
            cached_data, is_fresh = _get_cached(key)
            if cached_data:
                # Stale data? Queue a background refresh but return instantly
                if not is_fresh:
                    asyncio.create_task(_run_analysis(expiry, trader_profile))
                return JSONResponse({**cached_data, "from_cache": True})

        # No fresh cache — run analysis (or join the already-running one)
        payload = await _run_analysis(expiry, trader_profile)
        if payload is None:
            raise HTTPException(status_code=502, detail="Analysis failed")
        return JSONResponse(payload)

    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/api/refresh")
async def refresh_analysis():
    return await get_analysis(force=True)


# ── TA-35 STOCKS CACHE ───────────────────────────────────────────────
_stocks_cache: dict = {"data": None, "ts": 0.0}
STOCKS_CACHE_TTL = 300  # 5 minutes


@app.get("/api/stocks")
async def get_stocks(force: bool = Query(default=False)):
    """Returns real-time prices for all TA-35 component stocks."""
    global _stocks_cache

    if not force:
        entry = _stocks_cache
        if entry["data"] and time.time() - entry["ts"] < STOCKS_CACHE_TTL:
            return JSONResponse({**entry["data"], "from_cache": True})

    try:
        async with httpx.AsyncClient(timeout=12) as client:
            stocks = await _fetch_ta35_stock_prices(client)

        payload = {
            "stocks":     stocks,
            "fetched_at": datetime.now(timezone.utc).isoformat(),
            "from_cache": False,
        }
        _stocks_cache = {"data": payload, "ts": time.time()}
        return JSONResponse(payload)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ── PUT/CALL LIVE DATA ────────────────────────────────────────────────
_pc_cache: dict = {}
PC_CACHE_TTL = 600  # 10 minutes per expiry date

@app.get("/api/putvscall")
async def get_putvscall(
    expiry: str = Query(default=None),
    force: bool = Query(default=False),
    dates_only: bool = Query(default=False),
):
    """
    Returns TASE Put vs Call open interest for the given expiry date.
    Data is live from market.tase.co.il via Playwright interception.
    Results are cached for 10 minutes per expiry date.
    """
    if dates_only:
        expiry_dates = await _fetch_tradeboost_expiry_dates()
        return JSONResponse({"expiry_dates": expiry_dates, "source_url": TASE_PUTVSCALL_SOURCE_URL})

    cache_key = expiry or "__default__"

    if not force:
        entry = _pc_cache.get(cache_key)
        if entry and time.time() - entry["ts"] < PC_CACHE_TTL:
            return JSONResponse({**entry["data"], "from_cache": True})

    try:
        data = await _fetch_tase_putvscall(expiry_date=expiry, force=force)
        _pc_cache[cache_key] = {"data": data, "ts": time.time()}
        return JSONResponse({**data, "from_cache": False})
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
