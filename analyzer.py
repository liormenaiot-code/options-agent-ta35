import json
import os

from openai import OpenAI

SYSTEM_PROMPT = """\
אתה אנליסט שוק מקצועי לשוק ת"א 35. תפקידך לנתח את המצב ולהציג את העובדות בצורה ברורה — לא להמליץ על עסקאות. הסוחר מחליט בעצמו. החזר JSON בלבד, ללא טקסט נוסף. עברית בלבד. קצר ותמציתי.

## מה לנתח:

1. כיוון השוק: שורי/דובי/ניטרלי + רמת ביטחון (0-100) + הסיבה העיקרית במשפט אחד.
2. תנודתיות: נמוכה/בינונית/גבוהה + הסבר קצר. אם VTA35 סופק — בסס עליו בעיקר.
3. שלוש החדשות הבולטות שהכי עלולות להזיז את ת"א 35 — ממוינות לפי חשיבות יורדת.
4. גורמי סיכון: 3 סיכונים קצרים וספציפיים.
5. 5 חדשות נוספות רלוונטיות לת"א 35 עם השפעה.

## כלל ברזל:
אל תמליץ על אסטרטגיה, סטרייק, או עסקה. ניתוח עובדות בלבד.

פורמט מדויק — JSON בלבד, ללא markdown:
{"market_direction":{"signal":"שורי|דובי|ניטרלי","confidence_pct":0-100,"reasoning":"משפט אחד"},"volatility":{"level":"נמוכה|בינונית|גבוהה","explanation":"משפט אחד"},"breaking_news":[{"headline":"כותרת","direction":"שורי|דובי|ניטרלי","urgency":"גבוהה|בינונית|נמוכה"},{"headline":"כותרת","direction":"שורי|דובי|ניטרלי","urgency":"גבוהה|בינונית|נמוכה"},{"headline":"כותרת","direction":"שורי|דובי|ניטרלי","urgency":"גבוהה|בינונית|נמוכה"}],"key_risks":["סיכון א","סיכון ב","סיכון ג"],"top_news":[{"headline":"כותרת","source":"מקור","url":"https://...","impact":"שורי|דובי|ניטרלי"}],"disclaimer":"המידע לצרכי לימוד בלבד — אין ייעוץ השקעות"}
"""


def _build_user_message(scraped_data: dict, expiry: str | None = None, profile: dict | None = None) -> str:
    parts = []

    if expiry:
        parts.append(f"## תאריך פקיעה שנבחר: {expiry}")
        parts.append("")

    # ── Expiry statistics ──
    es = scraped_data.get("expiry_stats")
    if es:
        sr = es.get("settlement_ranges", {})
        bd = es.get("by_day_of_week", {})
        parts.append("## סטטיסטיקה היסטורית — 968 פקיעות ת\"א 35")
        parts.append(f"ממוצע תנועה לסגר: {es.get('avg_settlement_move_pct',0.528)}% | שורי: {es.get('pct_bullish',53.1)}% | דובי: {es.get('pct_bearish',45.8)}%")
        rows = []
        for label, key in [("±0.5%","0.5pct"),("±1%","1pct"),("±1.5%","1.5pct"),("±2%","2pct")]:
            r = sr.get(key, {})
            rows.append(f"{label}: {r.get('prob_seller_wins','—')}% בטווח")
        parts.append(" | ".join(rows))
        parts.append("")

    # ── VTA35 ──
    vta35 = scraped_data.get("vta35")
    if vta35:
        v_str = f"VTA35: {vta35['value']}"
        if vta35.get("change_pct") is not None:
            v_str += f" ({vta35['change_pct']:+.2f}%)"
        if vta35.get("prev_close"):
            v_str += f" | סגירה קודמת: {vta35['prev_close']}"
        parts.append(f"## מדד הפחד הישראלי")
        parts.append(v_str)
        parts.append("(VTA35 < 15: שאננות | 15-25: רגיל | > 25: פחד | > 35: פאניקה)")
        parts.append("")

    # ── Market price ──
    market = scraped_data.get("market", {})
    md = market.get("market_data")
    if md:
        parts.append("## נתוני שוק")
        parts.append(
            f"מחיר ת\"א 35: {md['price']} | שינוי: {md['change_pct']:+.2f}% | "
            f"פתיחה: {md.get('open')} | גבוה: {md.get('high')} | נמוך: {md.get('low')}"
        )
        parts.append("")

    # ── Technical indicators ──
    tech = scraped_data.get("technicals", {})
    if tech and not tech.get("error"):
        parts.append("## אינדיקטורים טכניים")
        rsi = tech.get("rsi14")
        hv20 = tech.get("hv20")
        hv10 = tech.get("hv10")
        sma20 = tech.get("sma20")
        sma50 = tech.get("sma50")
        bol = tech.get("bollinger", {})
        pct20 = tech.get("pct_from_sma20")
        pct50 = tech.get("pct_from_sma50")
        vol_r = tech.get("volume_ratio")

        if rsi is not None:
            rsi_note = "קנוי יתר" if rsi > 70 else "מכור יתר" if rsi < 30 else "ניטרלי"
            parts.append(f"RSI(14): {rsi} ({rsi_note})")
        if hv20:
            parts.append(f"HV20: {hv20}% | HV10: {hv10}%")
        if sma20:
            parts.append(f"SMA20: {sma20} ({pct20:+.2f}%)" if pct20 else f"SMA20: {sma20}")
        if sma50:
            parts.append(f"SMA50: {sma50} ({pct50:+.2f}%)" if pct50 else f"SMA50: {sma50}")
        if bol:
            parts.append(
                f"Bollinger: עליון={bol.get('upper')} | אמצע={bol.get('mid')} | "
                f"תחתון={bol.get('lower')} | רוחב={bol.get('bandwidth')}%"
            )
        if vol_r:
            parts.append(f"נפח יחסי: {vol_r}x")
        closes5 = tech.get("closes_5d", [])
        if closes5:
            parts.append(f"5 סגירות אחרונות: {closes5}")
        parts.append("")

    # ── News ──
    for src in scraped_data.get("news_sources", []):
        name     = src.get("source", "")
        articles = src.get("articles", [])
        if articles:
            parts.append(f"### {name}")
            for i, art in enumerate(articles[:5], 1):
                parts.append(f"{i}. [{art['headline']}]({art.get('url', '')})")
            parts.append("")

    return "\n".join(parts)


def analyze_market_sync(scraped_data: dict, expiry: str | None = None, profile: dict | None = None) -> dict:
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        return {"analysis": None, "error": "OPENROUTER_API_KEY not set"}

    client = OpenAI(
        base_url="https://openrouter.ai/api/v1",
        api_key=api_key,
        default_headers={
            "HTTP-Referer": "https://options-agent-ta35.onrender.com",
            "X-Title": "Options Agent TA-35",
        },
    )

    user_message = _build_user_message(scraped_data, expiry, profile)

    try:
        response = client.chat.completions.create(
            model="minimax/minimax-m2.5:free",
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user",   "content": user_message},
            ],
            max_tokens=500,
            temperature=0.15,
        )

        raw = response.choices[0].message.content or ""
        raw = raw.strip()
        if raw.startswith("```"):
            raw = raw.split("```", 2)[1]
            if raw.startswith("json"):
                raw = raw[4:]
            raw = raw.strip()
        analysis = json.loads(raw)

        return {
            "analysis": analysis,
            "usage": {
                "input_tokens":  response.usage.prompt_tokens if response.usage else 0,
                "output_tokens": response.usage.completion_tokens if response.usage else 0,
            },
            "error": None,
        }

    except json.JSONDecodeError as exc:
        return {"analysis": None, "error": f"JSON parse error: {exc}"}
    except Exception as exc:
        return {"analysis": None, "error": f"OpenRouter error: {exc}"}
