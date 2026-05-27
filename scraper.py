import asyncio
import json as _json
import math
import os
from datetime import datetime, timezone
from pathlib import Path

import httpx
from bs4 import BeautifulSoup

# ── DISK CACHE FOR PLAYWRIGHT RESULTS ────────────────────────────────
_PC_CACHE_DIR = Path(__file__).parent / "pc_cache"
_PC_CACHE_DIR.mkdir(exist_ok=True)


def _pc_disk_path(date_iso: str) -> Path:
    return _PC_CACHE_DIR / f"{date_iso}.json"


def _load_pc_disk(date_iso: str, max_age_minutes: int = 30) -> list[dict] | None:
    """טוען מהארכיון. max_age_minutes=0 → מחזיר תמיד ללא בדיקת גיל."""
    path = _pc_disk_path(date_iso)
    if not path.exists():
        return None
    try:
        with open(path, encoding="utf-8") as f:
            data = _json.load(f)
        if max_age_minutes > 0:
            scraped_at_str = data.get("scraped_at", "")
            if scraped_at_str:
                try:
                    scraped_at = datetime.fromisoformat(scraped_at_str)
                    age_min = (datetime.now(timezone.utc) - scraped_at).total_seconds() / 60
                    if age_min > max_age_minutes:
                        return None  # פג תוקף
                except Exception:
                    pass
        return data.get("items")
    except Exception:
        return None


def _save_pc_disk(date_iso: str, items: list[dict]) -> None:
    path = _pc_disk_path(date_iso)
    try:
        with open(path, "w", encoding="utf-8") as f:
            _json.dump(
                {"items": items, "scraped_at": datetime.now(timezone.utc).isoformat()},
                f, ensure_ascii=False, indent=2,
            )
    except Exception:
        pass

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "he-IL,he;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://www.google.com/",
}

YAHOO_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; options-agent/1.0)",
    "Accept": "application/json",
}

YAHOO_CHART_1D  = "https://query2.finance.yahoo.com/v8/finance/chart/TA35.TA?interval=1d&range=1d"
YAHOO_CHART_60D = "https://query2.finance.yahoo.com/v8/finance/chart/TA35.TA?interval=1d&range=60d"
YAHOO_VTA35     = "https://query2.finance.yahoo.com/v8/finance/chart/VTA35.TA?interval=1d&range=1d"
FINNHUB_BASE    = "https://finnhub.io/api/v1"

TIMEOUT = 8  # seconds per request — tight but fair


# ── FINNHUB ──────────────────────────────────────────────────────────

async def _finnhub_quote(client):
    """Real-time TA-35 price via Finnhub (fastest source)."""
    key = os.getenv("FINNHUB_API_KEY")
    if not key:
        return None
    try:
        resp = await client.get(
            f"{FINNHUB_BASE}/quote",
            params={"symbol": "TA35.TA", "token": key},
            headers={"Accept": "application/json"},
            timeout=TIMEOUT,
        )
        resp.raise_for_status()
        d = resp.json()
        price = d.get("c", 0)
        if not price:
            return None
        prev = d.get("pc", price) or price
        return {
            "index": "TA-35", "price": round(float(price), 2),
            "change_pct": round(float(d.get("dp", 0)), 2),
            "prev_close": round(float(prev), 2),
            "open": round(float(d.get("o") or 0), 2) or None,
            "high": round(float(d.get("h") or 0), 2) or None,
            "low":  round(float(d.get("l") or 0), 2) or None,
            "currency": "ILS", "source": "Finnhub",
        }
    except Exception:
        return None


async def _finnhub_news(client):
    """Financial news from Finnhub — instant JSON, no HTML parsing."""
    key = os.getenv("FINNHUB_API_KEY")
    if not key:
        return {"source": "Finnhub", "articles": [], "error": "no key"}
    try:
        resp = await client.get(
            f"{FINNHUB_BASE}/news",
            params={"category": "general", "token": key},
            headers={"Accept": "application/json"},
            timeout=TIMEOUT,
        )
        resp.raise_for_status()
        items = resp.json() or []
        articles = []
        for item in items[:12]:
            headline = item.get("headline", "").strip()
            if not headline or len(headline) < 8:
                continue
            articles.append({
                "headline": headline,
                "url":      item.get("url", ""),
                "source":   item.get("source", "Finnhub"),
            })
        return {"source": "Finnhub Markets", "articles": articles, "error": None}
    except Exception as exc:
        return {"source": "Finnhub", "articles": [], "error": str(exc)}


# ── HEBREW NEWS SCRAPERS ──────────────────────────────────────────────

_JUNK_HEADLINES = {
    "מדיניות פרטיות", "תנאי שימוש", "אודות", "צור קשר",
    "נגישות", "מפת האתר", "RSS", "פרסמו אצלנו", "הצהרת נגישות",
    "כל הזכויות שמורות", "כניסה לחשבון", "הרשמה", "עזרה",
    "שלח לחבר", "הדפס", "תגובות", "שתף", "כתבות נוספות",
}


async def _scrape_news(client, url, source_name, base_url, article_pattern="/article/"):
    """Scrape article links from a Hebrew news page."""
    try:
        resp = await client.get(url, headers=HEADERS, follow_redirects=True, timeout=TIMEOUT)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
        articles, seen = [], set()
        for a in soup.find_all("a", href=True):
            href = a.get("href", "")
            if article_pattern not in href or href in seen:
                continue
            seen.add(href)
            headline = a.get_text(strip=True)
            if not headline or len(headline) < 12:
                continue
            if headline in _JUNK_HEADLINES:
                continue
            full_url = f"{base_url}{href}" if href.startswith("/") else href
            articles.append({"headline": headline, "url": full_url, "source": source_name})
            if len(articles) >= 8:
                break
        return {"source": source_name, "articles": articles, "error": None}
    except Exception as exc:
        return {"source": source_name, "articles": [], "error": str(exc)}


# ── MARKET PRICE FALLBACK ─────────────────────────────────────────────

async def _yahoo_price(client):
    try:
        resp = await client.get(YAHOO_CHART_1D, headers=YAHOO_HEADERS, timeout=TIMEOUT)
        resp.raise_for_status()
        data   = resp.json()
        result = data["chart"]["result"][0]
        meta   = result["meta"]
        quote  = result["indicators"]["quote"][0]
        price  = meta.get("regularMarketPrice", 0)
        prev   = meta.get("chartPreviousClose", price) or price
        pct    = ((price - prev) / prev * 100) if prev else 0.0
        def safe(lst):
            vals = [v for v in (lst or []) if v is not None]
            return round(vals[0], 2) if vals else None
        return {
            "index": "TA-35", "price": round(price, 2),
            "change_pct": round(pct, 2), "prev_close": round(prev, 2),
            "open": safe(quote.get("open")), "high": safe(quote.get("high")),
            "low":  safe(quote.get("low")), "currency": "ILS", "source": "Yahoo",
        }
    except Exception:
        return None


# ── TECHNICAL INDICATORS ─────────────────────────────────────────────

def _calc_rsi(closes, period=14):
    if len(closes) < period + 1:
        return None
    deltas = [closes[i] - closes[i-1] for i in range(1, len(closes))]
    gains  = [max(0, d) for d in deltas[-period:]]
    losses = [max(0, -d) for d in deltas[-period:]]
    ag, al = sum(gains) / period, sum(losses) / period
    if al == 0:
        return 100.0
    return round(100 - 100 / (1 + ag / al), 1)


def _calc_hv(closes, window=20):
    if len(closes) < window + 1:
        return None
    returns = [math.log(closes[i] / closes[i-1]) for i in range(1, len(closes))]
    r    = returns[-window:]
    mean = sum(r) / len(r)
    var  = sum((x - mean) ** 2 for x in r) / (len(r) - 1)
    return round(math.sqrt(var * 252) * 100, 1)


def _calc_bollinger(closes, window=20, num_std=2):
    if len(closes) < window:
        return None
    recent = closes[-window:]
    sma = sum(recent) / window
    std = math.sqrt(sum((x - sma) ** 2 for x in recent) / window)
    return {
        "upper": round(sma + num_std * std, 2),
        "mid":   round(sma, 2),
        "lower": round(sma - num_std * std, 2),
        "bandwidth": round((num_std * 2 * std / sma) * 100, 2),
    }


async def _fetch_vta35(_client=None):
    """
    VTA35 — מדד הפחד הישראלי (Tel Aviv Volatility Index).
    Uses Playwright (headless Chromium) to bypass Cloudflare on investing.com.
    Extracts price from the live DOM element [data-test="instrument-price-last"]
    and prev-close from [data-test="prevClose"].
    Falls back to FAQ JSON-LD regex if DOM elements not found.
    """
    import re
    try:
        from playwright.async_api import async_playwright

        async with async_playwright() as pw:
            browser = await pw.chromium.launch(headless=True)
            ctx = await browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/124.0.0.0 Safari/537.36"
                ),
                locale="he-IL",
            )
            page = await ctx.new_page()
            await page.goto(
                "https://il.investing.com/indices/tase-vta35",
                wait_until="domcontentloaded",
                timeout=25_000,
            )

            # Wait for the live price element to appear
            try:
                await page.wait_for_selector(
                    '[data-test="instrument-price-last"]', timeout=10_000
                )
            except Exception:
                pass  # fall through to regex

            html = await page.content()
            await browser.close()

        # ── Current price — live DOM element ──────────────────────
        m_price = re.search(
            r'data-test="instrument-price-last"[^>]*>\s*([\d.,]+)', html
        )
        if not m_price:
            # Fallback: FAQ JSON-LD schema "VTA35 הוא 18.94."
            m_price = re.search(r"VTA35 הוא ([\d.]+)", html)
        if not m_price:
            return None
        price = float(m_price.group(1).replace(",", ""))

        # ── Previous close ─────────────────────────────────────────
        m_prev = re.search(
            r'data-test="prevClose"[^>]*>.*?<span[^>]*>\s*([\d.]+)\s*</span>',
            html, re.DOTALL,
        )
        prev_close = float(m_prev.group(1)) if m_prev else None

        change_pct = None
        if prev_close and prev_close != 0:
            change_pct = round((price - prev_close) / prev_close * 100, 2)

        return {
            "value":      round(price, 2),
            "prev_close": prev_close,
            "change_pct": change_pct,
            "source":     "Investing.com",
        }
    except Exception:
        return None


async def _fetch_technicals(client):
    try:
        resp = await client.get(YAHOO_CHART_60D, headers=YAHOO_HEADERS, timeout=TIMEOUT)
        resp.raise_for_status()
        data   = resp.json()
        result = data["chart"]["result"][0]
        q      = result["indicators"]["quote"][0]
        closes = [c for c in q.get("close",  []) if c is not None]
        highs  = [h for h in q.get("high",   []) if h is not None]
        lows   = [l for l in q.get("low",    []) if l is not None]
        vols   = [v for v in q.get("volume", []) if v is not None]

        if len(closes) < 20:
            return {"error": "insufficient history"}

        sma20 = round(sum(closes[-20:]) / 20, 2)
        sma50 = round(sum(closes[-50:]) / 50, 2) if len(closes) >= 50 else None
        current = closes[-1]
        avg_vol  = round(sum(vols[-20:]) / min(20, len(vols)), 0) if vols else None
        vol_ratio = round(vols[-1] / avg_vol, 2) if avg_vol and vols else None

        return {
            "hv20":            _calc_hv(closes, 20),
            "hv10":            _calc_hv(closes, 10),
            "rsi14":           _calc_rsi(closes, 14),
            "bollinger":       _calc_bollinger(closes, 20),
            "sma20":           sma20,
            "sma50":           sma50,
            "pct_from_sma20":  round((current - sma20) / sma20 * 100, 2) if sma20 else None,
            "pct_from_sma50":  round((current - sma50) / sma50 * 100, 2) if sma50 else None,
            "range_52w_high":  round(max(highs), 2) if highs else None,
            "range_52w_low":   round(min(lows),  2) if lows  else None,
            "volume_ratio":    vol_ratio,
            "closes_5d":       [round(c, 2) for c in closes[-5:]],
            "error": None,
        }
    except Exception as exc:
        return {"error": str(exc)}


# ── EXPIRY STATISTICS (TradeBoost historical data) ────────────────────

# ── VERIFIED from 968 TA-35 expiry records pulled directly from TradeBoost Supabase ──
# Metric: opening_change_percent = % move from previous close to 10:00 AM settlement price
# This is the EXACT price at which options expire — the only metric that matters for P&L
_EXPIRY_STATS_FALLBACK = {
    "total_records": 968,
    "metric": "opening_change_percent",
    "metric_note": "תנועה ממחיר סגירה קודם למחיר סגר האופציות ב-10:00 — הנתון שקובע את רווח/הפסד",
    "avg_settlement_move_pct": 0.528,   # average absolute move to settlement
    "pct_bullish": 53.1,               # settlement above previous close
    "pct_bearish": 45.8,               # settlement below previous close
    # How often the settlement stays within ±X% (seller wins if underlying stays in range)
    "settlement_ranges": {
        "0.25pct": {"prob_seller_wins": 35.5, "bull_exceed_pct": 34.5, "bear_exceed_pct": 30.0},
        "0.5pct":  {"prob_seller_wins": 60.2, "bull_exceed_pct": 21.4, "bear_exceed_pct": 18.4},
        "0.75pct": {"prob_seller_wins": 78.4, "bull_exceed_pct": 11.1, "bear_exceed_pct": 10.5},
        "1pct":    {"prob_seller_wins": 87.3, "bull_exceed_pct":  6.4, "bear_exceed_pct":  6.3},
        "1.25pct": {"prob_seller_wins": 91.6, "bull_exceed_pct":  3.9, "bear_exceed_pct":  4.4},
        "1.5pct":  {"prob_seller_wins": 94.4, "bull_exceed_pct":  2.8, "bear_exceed_pct":  2.8},
        "1.75pct": {"prob_seller_wins": 96.6, "bull_exceed_pct":  1.9, "bear_exceed_pct":  1.5},
        "2pct":    {"prob_seller_wins": 97.6, "bull_exceed_pct":  1.2, "bear_exceed_pct":  1.1},
        "2.5pct":  {"prob_seller_wins": 99.1, "bull_exceed_pct":  0.5, "bear_exceed_pct":  0.4},
        "3pct":    {"prob_seller_wins": 99.6, "bull_exceed_pct":  0.2, "bear_exceed_pct":  0.2},
        "4pct":    {"prob_seller_wins": 99.9, "bull_exceed_pct":  0.0, "bear_exceed_pct":  0.1},
    },
    # Settlement volatility by day of week (lower avg = more stable = better for selling premium)
    "by_day_of_week": {
        "שלישי":  {"count": 149, "avg_move_pct": 0.428, "within_0.5pct": 67.8, "within_1pct": 94.0, "within_1.5pct": 96.6, "note": "הכי יציב"},
        "חמישי":  {"count": 662, "avg_move_pct": 0.519, "within_0.5pct": 61.5, "within_1pct": 87.6, "within_1.5pct": 94.6, "note": "יום הפקיעה העיקרי"},
        "שישי":   {"count":  33, "avg_move_pct": 0.530, "within_0.5pct": 63.6, "within_1pct": 84.8, "within_1.5pct": 93.9, "note": "פקיעה חודשית בעיקר"},
        "ראשון":  {"count":  89, "avg_move_pct": 0.692, "within_0.5pct": 41.6, "within_1pct": 77.5, "within_1.5pct": 94.4, "note": "תנודתי יחסית"},
        "שני":    {"count":  21, "avg_move_pct": 0.759, "within_0.5pct": 42.9, "within_1pct": 76.2, "within_1.5pct": 81.0, "note": "הכי תנודתי"},
        "רביעי":  {"count":  14, "avg_move_pct": 0.510, "within_0.5pct": 64.3, "within_1pct": 85.7, "within_1.5pct": 92.9, "note": "נדיר"},
    },
    # Percentiles of absolute settlement move
    "percentiles": {
        "p25": 0.19, "p50": 0.39, "p75": 0.72, "p90": 1.17, "p95": 1.51, "p99": 2.53
    },
    "source": "tradeboost.co.il — 968 רשומות שנמשכו ישירות ממסד הנתונים",
}


def _scrape_expiry_stats() -> dict:
    """Return verified baseline stats — no network call needed.
    Data was extracted directly from TradeBoost Supabase (968 records, May 2026).
    These stats change by <0.1% per month — refreshing from DB adds no value.
    """
    return {**_EXPIRY_STATS_FALLBACK, "error": None}


# ── TASE PUT/CALL OPEN INTEREST (via Playwright) ──────────────────────

# ── TRADEBOOST CONFIG ─────────────────────────────────────────────────
# מקור ראשי לתאריכי פקיעה מאומתים — מסד הנתונים של TradeBoost
_TB_SUPABASE_URL = "https://ddwjzjgzhjixamsmavot.supabase.co"
_TB_ANON_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
    ".eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRkd2p6emd6aGppeGFtc21hdm90Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzI1MDg3NTQsImV4cCI6MjA0ODA4NDc1NH0"
    ".ozHi_jh_qO2h6RwdyvvBXI0yPuSstgHEcqPEIhLirgA"
)

_TASE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
    "Origin": "https://market.tase.co.il",
    "Referer": "https://market.tase.co.il/en/market_data/derivatives/01/putcallchart",
}

_TASE_EXPIRY_URL  = "https://api.tase.co.il/api/derivatives/fltrputvscallexpdates"
_TASE_CHART_URL   = "https://api.tase.co.il/api/derivatives/putvscallchartdata"

# מקור רשמי — אתר הבורסה לניירות ערך בתל אביב
TASE_PUTVSCALL_SOURCE_URL = "https://market.tase.co.il/he/market_data/derivatives/01/major_data/putvscall"


def _calc_max_pain(points: list) -> float | None:
    if not points:
        return None
    best, best_strike = float("inf"), None
    for P_row in points:
        P = P_row[0]
        total = sum(
            (P - r[0]) * r[1] if P > r[0] else (r[0] - P) * r[2]
            for r in points if P != r[0]
        )
        if total < best:
            best, best_strike = total, P
    return best_strike


def _compute_expiry_dates(weeks_ahead: int = 6, active_weekdays: set | None = None) -> list[dict]:
    """
    מחשב תאריכי פקיעה עתידיים לפי הימים הפעילים שאומתו מ-TradeBoost.
    ברירת מחדל: שני–שישי (0–4), עם סימון חודשי לשישי האחרון של כל חודש.
    """
    from datetime import date, timedelta

    today = date.today()
    if active_weekdays is None:
        active_weekdays = {0, 1, 2, 3, 4}   # Mon-Fri (Python weekday)

    # שישי אחרון של כל חודש = פקיעה חודשית
    monthly: set[date] = set()
    for m_offset in range(4):
        m = today.month + m_offset
        y = today.year + (m - 1) // 12
        m = (m - 1) % 12 + 1
        last = date(y + 1, 1, 1) - timedelta(1) if m == 12 else date(y, m + 1, 1) - timedelta(1)
        while last.weekday() != 4:
            last -= timedelta(1)
        monthly.add(last)

    he_days = {0: "שני", 1: "שלישי", 2: "רביעי", 3: "חמישי", 4: "שישי", 6: "ראשון"}
    results: list[dict] = []
    d = today
    end = today + timedelta(weeks=weeks_ahead)
    while d <= end:
        if d.weekday() in active_weekdays:
            is_monthly = d in monthly
            label_type = "חודשי" if is_monthly else "שבועי"
            results.append({
                "date":  d.strftime("%d/%m/%Y"),
                "label": f"{d.strftime('%d/%m/%Y')} ({he_days.get(d.weekday(), '')}) ({label_type})",
                "type":  "monthly" if is_monthly else "weekly",
                "iso":   d.isoformat(),
            })
        d += timedelta(1)
    return results


async def _fetch_tradeboost_expiry_dates() -> list[dict]:
    """
    שולף תאריכי פקיעה אמיתיים מ-TradeBoost Supabase.
    מחזיר רשומות היסטוריות (שבועיים אחרונים) כדי לאמת את ימי הפקיעה הפעילים,
    ואז מחשב תאריכים עתידיים לפי אותו תבנית.
    """
    from datetime import date, timedelta

    today = date.today()
    since = (today - timedelta(days=21)).isoformat()

    url = f"{_TB_SUPABASE_URL}/rest/v1/tlv35_expirations_history"
    headers = {
        "apikey": _TB_ANON_KEY,
        "Authorization": f"Bearer {_TB_ANON_KEY}",
        "Accept": "application/json",
    }
    params = {
        "date": f"gte.{since}",
        "order": "date.asc",
        "limit": "60",
    }

    try:
        async with httpx.AsyncClient(timeout=8) as client:
            resp = await client.get(url, headers=headers, params=params)
            if resp.status_code == 200:
                rows = resp.json()
                if rows:
                    # זהה אילו ימי שבוע פעילים לאחרונה
                    from datetime import date as dt_date
                    active_weekdays: set[int] = set()
                    for row in rows:
                        try:
                            d = dt_date.fromisoformat(row["date"][:10])
                            active_weekdays.add(d.weekday())
                        except Exception:
                            pass
                    # הסר יום שבת (5) אם הוא נכנס בטעות
                    active_weekdays.discard(5)
                    if active_weekdays:
                        return _compute_expiry_dates(active_weekdays=active_weekdays)
    except Exception:
        pass

    # fallback: שני–שישי (מבוסס על נתוני TradeBoost ידועים)
    return _compute_expiry_dates()


_TASE_BASE_URL = "https://market.tase.co.il/he/market_data/derivatives/01/major_data/putvscall"


async def _fetch_tase_expiry_dates() -> list[dict]:
    """
    שולף תאריכי פקיעה אמיתיים מ-API של הבורסה (httpx — מהיר, ללא Playwright).
    זהו מקור האמת: רק תאריכים שקיימים בפועל במסחר.
    """
    he_days = {0: "שני", 1: "שלישי", 2: "רביעי", 3: "חמישי", 4: "שישי", 5: "שבת", 6: "ראשון"}
    try:
        from datetime import date as dt_date
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                _TASE_EXPIRY_URL,
                params={"objId": "01", "lang": 1, "dType": 2, "date": ""},
                headers=_TASE_HEADERS,
            )
            if resp.status_code == 200:
                items_raw = resp.json().get("DerivativeExpirationDateItems", [])
                results = []
                for item in items_raw:
                    # פורמט אפשרי: "2026-05-17T00:00:00" או "17/05/2026"
                    raw = (item.get("ExpirationDate") or item.get("Date") or "").strip()
                    if not raw:
                        continue
                    try:
                        if "T" in raw or "-" in raw:
                            d = dt_date.fromisoformat(raw[:10])
                            ddmmyyyy = d.strftime("%d/%m/%Y")
                        else:
                            parts = raw.split("/")
                            d = dt_date(int(parts[2]), int(parts[1]), int(parts[0]))
                            ddmmyyyy = raw
                        exp_type = item.get("ExpirationTypeName", item.get("Type", "שבועי"))
                        is_monthly = "חודשי" in str(exp_type)
                        results.append({
                            "date":  ddmmyyyy,
                            "label": f"{ddmmyyyy} ({he_days.get(d.weekday(), '')}) ({'חודשי' if is_monthly else 'שבועי'})",
                            "type":  "monthly" if is_monthly else "weekly",
                            "iso":   d.isoformat(),
                        })
                    except Exception:
                        pass
                if results:
                    return results
    except Exception:
        pass
    # Fallback: חישוב שני–שישי
    return _compute_expiry_dates()


async def _fetch_weekly_playwright(target_iso: str, force: bool = False) -> dict:
    """
    שולף טבלת Put/Call מאתר הבורסה באמצעות Playwright.
    מחזיר dict עם:
      - items: רשימת strikes
      - expiry_dates: תאריכי פקיעה אמיתיים מה-TASE dropdown
      - actual_expiry: התאריך שנבחר בפועל

    תיקונים ב-v2:
      1. בוחר "יום מסחר אחרון" (לא קודם)
      2. אם התאריך לא בדרופדאון → בוחר הראשון הזמין
      3. call_last_rate / 100 → נקודות אינדקס
      4. מחזיר גם את תאריכי הפקיעה האמיתיים מה-TASE
    """
    max_age = 2 if force else 30
    cached = _load_pc_disk(target_iso, max_age_minutes=max_age)
    if cached is not None:
        # cache returns items list for backward compat
        return {"items": cached, "expiry_dates": [], "actual_expiry": target_iso}

    try:
        from playwright.async_api import async_playwright
    except ImportError:
        return {"items": [], "expiry_dates": [], "actual_expiry": target_iso}

    # המר YYYY-MM-DD → DD/MM/YYYY לזיהוי ב-dropdown
    try:
        y, m, d = target_iso.split("-")
        target_ddmmyyyy = f"{d}/{m}/{y}"
    except Exception:
        target_ddmmyyyy = ""

    def parse_int(s: str) -> int:
        s = str(s or "").strip().replace(",", "").replace("—", "").replace("-", "")
        try:
            return int(float(s)) if s else 0
        except Exception:
            return 0

    def parse_rate(s: str) -> float | None:
        """שער אחרון מה-TASE — מחלקים ב-100 לקבלת נקודות אינדקס."""
        s = str(s or "").strip().replace(",", "")
        if not s or s in ("—", "-", ""):
            return None
        try:
            val = float(s)
            return round(val / 100, 2)   # agorot → index points
        except Exception:
            return None

    items: list[dict] = []
    tase_expiry_dates: list[dict] = []
    actual_expiry = target_iso
    he_days = {0: "שני", 1: "שלישי", 2: "רביעי", 3: "חמישי", 4: "שישי", 5: "שבת", 6: "ראשון"}

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        try:
            ctx = await browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/124.0.0.0 Safari/537.36"
                ),
                locale="he-IL",
            )
            page = await ctx.new_page()
            await page.goto(_TASE_BASE_URL, wait_until="domcontentloaded", timeout=45_000)

            # ── המתן ל-dropdown עם options ────────────────────────────
            await page.wait_for_selector("select#filterOptions", timeout=25_000)
            for _ in range(40):
                opt_count = await page.evaluate(
                    "() => document.querySelector('select#filterOptions')?.options?.length || 0"
                )
                if opt_count > 1:
                    break
                await page.wait_for_timeout(500)

            # ── בחר "יום מסחר אחרון" (radio button) ──────────────────
            await page.evaluate("""
                () => {
                    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
                    // מחפש את ה-radio שמכיל "אחרון" בתווית שלו
                    for (const r of radios) {
                        const label = r.closest('label') || document.querySelector(`label[for="${r.id}"]`);
                        const txt = label ? label.innerText : (r.nextSibling ? r.nextSibling.textContent : '');
                        if (txt && txt.includes('אחרון')) {
                            r.click();
                            r.dispatchEvent(new Event('change', {bubbles: true}));
                            return;
                        }
                    }
                    // fallback: click first radio
                    if (radios.length > 0) { radios[0].click(); }
                }
            """)
            await page.wait_for_timeout(300)

            # ── קרא את כל תאריכי הפקיעה האמיתיים מה-TASE ────────────
            raw_options = await page.evaluate("""
                () => Array.from(document.querySelector('select#filterOptions').options)
                    .map(o => ({value: o.value, text: o.text.trim()}))
            """)

            # בנה רשימת תאריכים מהאפשרויות (דלג על "הכל" = value 0)
            from datetime import date as dt_date
            for opt in raw_options:
                if opt["value"] == "0" or not opt["text"]:
                    continue
                # text format: "29/05/2026 שבועי" or "28/06/2026 חודשי"
                parts = opt["text"].split()
                raw_date = parts[0] if parts else ""
                exp_type = parts[1] if len(parts) > 1 else "שבועי"
                if not raw_date or "/" not in raw_date:
                    continue
                try:
                    dp = raw_date.split("/")
                    d_obj = dt_date(int(dp[2]), int(dp[1]), int(dp[0]))
                    tase_expiry_dates.append({
                        "date":  raw_date,
                        "label": f"{raw_date} ({he_days.get(d_obj.weekday(), '')}) ({exp_type})",
                        "type":  "monthly" if "חודשי" in exp_type else "weekly",
                        "iso":   d_obj.isoformat(),
                        "dropdown_value": str(opt["value"]),
                    })
                except Exception:
                    pass

            # ── בחר תאריך בדרופדאון ──────────────────────────────────
            matched_value = None
            actual_expiry = target_iso

            # נסה למצוא את התאריך המבוקש
            for opt in raw_options:
                if target_ddmmyyyy and target_ddmmyyyy in opt["text"]:
                    matched_value = str(opt["value"])
                    break

            # אם לא נמצא → בחר את הראשון הזמין (לא "הכל")
            if matched_value is None:
                for opt in raw_options:
                    if opt["value"] != "0" and opt["text"]:
                        matched_value = str(opt["value"])
                        # עדכן actual_expiry לתאריך שנבחר בפועל
                        if tase_expiry_dates:
                            actual_expiry = tase_expiry_dates[0]["iso"]
                        break

            if matched_value is not None:
                await page.select_option("select#filterOptions", value=matched_value)
                await page.wait_for_timeout(300)

            # ── לחץ "סנן רשימה" ───────────────────────────────────────
            filter_btn = page.locator("button", has_text="סנן רשימה").first
            await filter_btn.click(timeout=10_000)

            # ── המתן לטבלה ────────────────────────────────────────────
            for _ in range(50):
                count = await page.evaluate(
                    "() => document.querySelectorAll('table tbody tr').length"
                )
                if count >= 3:
                    break
                await page.wait_for_timeout(500)

            # ── גלול לטעינת כל השורות (lazy-load) ────────────────────
            prev_count = 0
            for _ in range(40):
                await page.evaluate("""
                    () => {
                        const tbl = document.querySelector('table');
                        if (tbl) tbl.scrollIntoView(false);
                        window.scrollTo(0, document.body.scrollHeight);
                    }
                """)
                await page.wait_for_timeout(500)
                new_count = await page.evaluate(
                    "() => document.querySelectorAll('table tbody tr').length"
                )
                if new_count == prev_count:
                    break
                prev_count = new_count

            # ── סרוק שורות ────────────────────────────────────────────
            rows_data: list[list[str]] = await page.evaluate("""
                () => Array.from(document.querySelectorAll('table tbody tr')).map(
                    row => Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim())
                )
            """)

            for cells in rows_data:
                if len(cells) < 11:
                    continue
                # [put_open_pos, put_vol, put_last, put_time, put_name,
                #  strike,
                #  call_name, call_time, call_last, call_vol, call_open_pos]
                strike = parse_int(cells[5])
                if strike < 500:   # skip synthetic/invalid rows
                    continue
                items.append({
                    "strike":         strike,
                    "call_last_rate": parse_rate(cells[8]),
                    "call_vol":       parse_int(cells[9]),
                    "call_open_pos":  parse_int(cells[10]),
                    "put_last_rate":  parse_rate(cells[2]),
                    "put_vol":        parse_int(cells[1]),
                    "put_open_pos":   parse_int(cells[0]),
                })

        finally:
            await browser.close()

    _save_pc_disk(actual_expiry, items)
    return {"items": items, "expiry_dates": tase_expiry_dates, "actual_expiry": actual_expiry}


async def _fetch_tase_putvscall(expiry_date: str | None = None, force: bool = False) -> dict:
    """
    שולף נתוני Put vs Call מאתר הבורסה דרך Playwright.
    תאריכי פקיעה מגיעים מ-TradeBoost (מקור ראשי).
    force=True: מדלג על כל קאש ומסרק מחדש.
    expiry_date: DD/MM/YYYY or YYYY-MM-DD. אם None — ברירת מחדל לתאריך הקרוב.
    """
    computed_dates = await _fetch_tradeboost_expiry_dates()
    result: dict = {
        "items": [], "expiry_dates": computed_dates, "trade_date": None,
        "max_pain": None, "expiry_date": expiry_date, "error": None,
        "source_url": TASE_PUTVSCALL_SOURCE_URL,
    }
    try:
        # ── Resolve target expiry → YYYY-MM-DD ───────────────────────
        target_iso: str | None = None
        if expiry_date:
            raw = expiry_date.split(" (")[0].strip()
            if "/" in raw:
                p = raw.split("/")
                if len(p) == 3:
                    yr = p[2] if len(p[2]) == 4 else "20" + p[2]
                    target_iso = f"{yr}-{p[1]}-{p[0]}"
            else:
                target_iso = raw
        else:
            # Default: first upcoming date
            if computed_dates:
                target_iso = computed_dates[0].get("iso") or _ddmmyyyy_to_iso(computed_dates[0]["date"])

        if not target_iso:
            result["error"] = "no expiry dates available"
            return result

        result["expiry_date"] = target_iso

        # ── All dates → Playwright DOM scrape ────────────────────────
        pw_result = await _fetch_weekly_playwright(target_iso, force=force)
        result["items"]        = pw_result["items"]
        result["trade_date"]   = pw_result.get("actual_expiry", target_iso)
        result["actual_expiry"] = pw_result.get("actual_expiry", target_iso)
        # Prefer real TASE expiry dates over computed ones
        if pw_result.get("expiry_dates"):
            result["expiry_dates"] = pw_result["expiry_dates"]

        # ── Max Pain calculation ───────────────────────────────────────
        items_list = result["items"]
        if items_list:
            # Build compact [strike, call_oi, put_oi] list for _calc_max_pain
            mp_points = [
                [it["strike"], it.get("call_open_pos", 0), it.get("put_open_pos", 0)]
                for it in items_list
                if it.get("strike", 0) > 0
            ]
            result["max_pain"] = _calc_max_pain(mp_points)

    except Exception as exc:
        result["error"] = str(exc)

    return result


def _ddmmyyyy_to_iso(date_str: str) -> str | None:
    """Convert DD/MM/YYYY → YYYY-MM-DD."""
    parts = date_str.split("/")
    if len(parts) == 3:
        yr = parts[2] if len(parts[2]) == 4 else "20" + parts[2]
        return f"{yr}-{parts[1]}-{parts[0]}"
    return None


# ── MAIN ──────────────────────────────────────────────────────────────

async def scrape_all() -> dict:
    # No retries — fail fast, don't waste time on dead endpoints
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        (
            fh_quote, fh_news,
            ynet_eco, calcalist, globes,
            yh_price, technicals,
            vta35,
        ) = await asyncio.gather(
            _finnhub_quote(client),
            _finnhub_news(client),
            _scrape_news(client,
                "https://www.ynet.co.il/economy",
                "ynet - כלכלה", "https://www.ynet.co.il"),
            _scrape_news(client,
                "https://www.calcalist.co.il/home/0,7340,L-8,00.html",
                "כלכליסט", "https://www.calcalist.co.il"),
            _scrape_news(client,
                "https://www.globes.co.il/news/markets.aspx",
                "גלובס", "https://www.globes.co.il",
                article_pattern="article.aspx"),
            _yahoo_price(client),
            _fetch_technicals(client),
            _fetch_vta35(client),
        )

    # Expiry stats are hardcoded from 968 verified records — no network needed
    expiry_stats = _scrape_expiry_stats()

    market_data = fh_quote or yh_price

    # Combine news: Finnhub global + Hebrew sources
    news_sources = [fh_news, ynet_eco, calcalist, globes]

    return {
        "news_sources":  news_sources,
        "market":        {"market_data": market_data, "error": None if market_data else "no market data"},
        "technicals":    technicals,
        "vta35":         vta35,
        "expiry_stats":  expiry_stats,
        "options":       {"available": False},   # TASE options not available via free APIs
        "scraped_at":    datetime.now(timezone.utc).isoformat(),
    }


# ── TA-35 COMPONENT STOCKS ───────────────────────────────────────────
# (name_he, yahoo_tase_ticker, us_ticker_or_None, us_exchange_or_None)
TA35_STOCKS: list[tuple] = [
    # (name_he, yahoo_tase_ticker, us_ticker, us_exchange)
    # Yahoo Finance TASE tickers verified May 2026
    ("בזק",               "BEZQ.TA",   None,    None),
    ("כלל עסקי ביטוח",   "CLIS.TA",   None,    None),
    ("ניו-מד אנרג",       "NWMD.TA",   None,    None),   # DEDR on investing.com
    ("דלק קבוצה",         "DLEKG.TA",  None,    None),
    ("דיסקונט",           "DSCT.TA",   None,    None),
    ("אלביט מערכות",      "ESLT.TA",   "ESLT",  "NASDAQ"),
    ("בינלאומי",          "FIBI.TA",   None,    None),
    ("הראל השקעות",       "HARL.TA",   None,    None),   # HRAL on investing.com
    ("איי.סי.אל",         "ICL.TA",    "ICL",   "NYSE"),
    ("לאומי",             "LUMI.TA",   None,    None),
    ("מגדל ביטוח",        "MGDL.TA",   None,    None),
    ("מליסרון",           "MLSR.TA",   None,    None),
    ("מנורה מב החזקות",   "MMHD.TA",   None,    None),   # MNRH on investing.com
    ("מזרחי טפחות",       "MZTF.TA",   None,    None),
    ("נייס",              "NICE.TA",   "NICE",  "NASDAQ"),
    ("הפניקס",            "PHOE.TA",   None,    None),   # PNIX on investing.com
    ("פועלים",            "POLI.TA",   None,    None),
    ("שופרסל",            "SAE.TA",    None,    None),   # SPRS on investing.com
    ("שטראוס גרופ",       "STRS.TA",   None,    None),
    ("טבע",               "TEVA.TA",   "TEVA",  "NYSE"),
    ("טאואר",             "TSEM.TA",   "TSEM",  "NASDAQ"),
    ("קמטק",              "CAMT.TA",   "CAMT",  "NASDAQ"),
    ("דמרי",              "DIMRI.TA",  None,    None),   # DMRI on investing.com
    ("נובה",              "NVMI.TA",   "NVMI",  "NASDAQ"),
    ("עזריאלי קבוצה",     "AZRG.TA",   None,    None),
    ("ביג",               "BIG.TA",    None,    None),
    ("מגה אור",           "MGOR.TA",   None,    None),   # MGAO on investing.com
    ("אנלייט אנרגיה",     "ENLT.TA",   None,    None),
    ("קנון הולדינגס",     "KEN.TA",    None,    None),   # KNON on investing.com
    ("שפיר הנדסה",        "SPEN.TA",   None,    None),   # SPIR on investing.com
    ("אורמת טכנולוגיות",  "ORA.TA",    "ORA",   "NYSE"),
    ("או.פי.סי אנרגיה",   "OPCE.TA",   None,    None),   # OPCI on investing.com
    ("נאוויטס פטרו",      "NVPT.TA",   None,    None),   # NVTP on investing.com
    ("הבורסה לניע בתא",   "TASE.TA",   None,    None),
    ("נקסט ויז׳ן",        "NXSN.TA",   None,    None),   # NXVS on investing.com
]


async def _fetch_one_stock(client, name_he: str, tase_ticker: str,
                           us_ticker, us_exchange) -> dict:
    """Fetch price for a single TASE stock via Yahoo Finance v8 chart."""
    base = {
        "name_he":     name_he,
        "tase_ticker": tase_ticker.replace(".TA", ""),
        "us_ticker":   us_ticker,
        "us_exchange": us_exchange,
        "price":       None,
        "change_pct":  None,
        "dual_listed": us_ticker is not None,
    }
    url = (
        f"https://query2.finance.yahoo.com/v8/finance/chart/{tase_ticker}"
        "?interval=1d&range=1d"
    )
    try:
        resp = await client.get(url, headers=YAHOO_HEADERS, timeout=10)
        if resp.status_code != 200:
            return base
        meta = resp.json()["chart"]["result"][0]["meta"]
        price = meta.get("regularMarketPrice")
        prev  = meta.get("chartPreviousClose") or meta.get("previousClose") or price
        if price and prev:
            # Yahoo Finance returns TASE prices in ILA (Israeli Agorot = 1/100 ILS).
            # Divide by 100 to get the real shekel (₪) price shown on the TASE.
            if meta.get("currency") == "ILA":
                price = price / 100
                prev  = prev  / 100
            pct = (price - prev) / prev * 100
            base["price"]      = round(float(price), 2)
            base["change_pct"] = round(float(pct),   2)
    except Exception:
        pass
    return base


async def _fetch_ta35_stock_prices(client) -> list[dict]:
    """
    Fetch real-time prices for all TA-35 component stocks via Yahoo Finance v8/chart.
    All 35 requests are fired concurrently.
    Returns list of dicts: name_he, tase_ticker, us_ticker, us_exchange,
                           price, change_pct, dual_listed.
    """
    tasks = [
        _fetch_one_stock(client, name_he, tase_ticker, us_ticker, us_exchange)
        for name_he, tase_ticker, us_ticker, us_exchange in TA35_STOCKS
    ]
    return list(await asyncio.gather(*tasks))


def get_expiry_dates() -> list[dict]:
    from datetime import date, timedelta
    today = date.today()
    results = []
    day_names_he = ["שני", "שלישי", "רביעי", "חמישי", "שישי"]
    monday = today - timedelta(days=today.weekday())
    for week_offset in range(2):
        for day_offset in range(5):
            d = monday + timedelta(weeks=week_offset, days=day_offset)
            if d >= today:
                results.append({
                    "date":  d.strftime("%d/%m/%y"),
                    "label": f"{d.strftime('%d/%m/%y')} ({day_names_he[day_offset]}) (W)",
                    "type":  "weekly", "iso": d.isoformat(),
                })
    for months_ahead in range(1, 4):
        m = today.month + months_ahead
        y = today.year + (m - 1) // 12
        m = (m - 1) % 12 + 1
        last_day = (
            date(y + 1, 1, 1) - timedelta(days=1)
            if m == 12 else date(y, m + 1, 1) - timedelta(days=1)
        )
        while last_day.weekday() != 4:
            last_day -= timedelta(days=1)
        results.append({
            "date":  last_day.strftime("%d/%m/%y"),
            "label": f"{last_day.strftime('%d/%m/%y')} (שישי) (M)",
            "type":  "monthly", "iso": last_day.isoformat(),
        })
    return results


if __name__ == "__main__":
    import json, sys
    result = asyncio.run(scrape_all())
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False, indent=2).encode("utf-8"))
    sys.stdout.buffer.write(b"\n")
