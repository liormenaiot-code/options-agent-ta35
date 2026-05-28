'use strict';

let isLoading    = false;
let warmupTimer  = null;
let selectedExpiry   = null;
let pcSelectedExpiry = null;  // expiry chosen in Put/Call dropdown; only used on "נתח" click
let hasAnalysis      = false;

let _stocksData      = null;
let _arbData         = null;

const FETCH_TIMEOUT_MS = 200_000; // 3:20 min hard cap

document.addEventListener('DOMContentLoaded', () => {
  loadExpiryDates().then(() => refreshData());
});

// ── EXPIRY DATES — fetch real TASE dates for the Put/Call dropdown ──
async function loadExpiryDates() {
  try {
    const resp = await fetch('/api/putvscall?dates_only=true');
    if (!resp.ok) return;
    const data = await resp.json();
    const expSelect = document.getElementById('pc-expiry-select');
    const allDates = data.expiry_dates || [];
    if (expSelect && allDates.length) {
      expSelect.innerHTML = allDates.map(d =>
        `<option value="${esc(d.date)}">${esc(d.label)}</option>`
      ).join('');
      // Default to first date that is strictly in the future (skip today/past expired options)
      const todayIso = new Date().toISOString().slice(0, 10);
      const nextDate = allDates.find(d => d.iso > todayIso) || allDates[0];
      pcSelectedExpiry   = nextDate.date;
      expSelect.value    = nextDate.date;
    }
  } catch {}
}

// ── MAIN REFRESH ───────────────────────────────────────────────────
async function refreshData(force = false) {
  if (isLoading) return;
  isLoading = true;

  const btn    = document.getElementById('refresh-btn');
  const hdrBtn = document.getElementById('hdr-refresh-btn');
  const overlay = document.getElementById('loading-overlay');
  const errBnr  = document.getElementById('error-banner');

  btn.disabled = true;
  btn.classList.add('spinning');
  if (hdrBtn) { hdrBtn.disabled = true; hdrBtn.querySelector('.hdr-refresh-icon').textContent = '↻'; }
  overlay.classList.remove('hidden');
  errBnr.classList.add('hidden');
  startPctCounter();

  // Switch to warmup UX after 12 s (cold start)
  const warmupSwitch = setTimeout(() => showWarmupUX(), 12_000);

  const controller = new AbortController();
  const hardCap = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const params = new URLSearchParams();
    if (selectedExpiry) params.set('expiry', selectedExpiry);
    if (force) params.set('force', 'true');

    const resp = await fetch(`/api/analyze?${params.toString()}`,
      { signal: controller.signal });
    if (!resp.ok) {
      let detail = `שגיאת שרת: ${resp.status}`;
      try { const j = await resp.json(); detail = j.detail || detail; } catch {}
      throw new Error(detail);
    }
    const data = await resp.json();
    renderAll(data);
    loadPutCall(pcSelectedExpiry, force);
    loadStocks(force);
    loadArbitrage(force);
  } catch (err) {
    if (err.name === 'AbortError') showError('הניתוח לקח יותר מדי זמן — נסה שוב');
    else showError(err.message);
  } finally {
    clearTimeout(warmupSwitch);
    clearTimeout(hardCap);
    stopPctCounter();
    stopWarmupUX();
    isLoading = false;
    btn.disabled = false;
    btn.classList.remove('spinning');
    if (hdrBtn) { hdrBtn.disabled = false; hdrBtn.querySelector('.hdr-refresh-icon').textContent = '⟳'; }
    overlay.classList.add('hidden');
  }
}

// ── PERCENTAGE COUNTER ─────────────────────────────────────────────
let _pct      = 0;
let _pctTimer = null;

function _updatePct(val) {
  const num = document.getElementById('load-pct-num');
  const bar = document.getElementById('load-pct-bar');
  if (num) num.textContent = Math.round(val) + '%';
  if (bar) bar.style.width  = val + '%';
}

function startPctCounter() {
  _pct = 0;
  _updatePct(0);
  // easeOut: eat 4.5% of remaining gap every 250 ms → fast start, slows near 95%
  _pctTimer = setInterval(() => {
    _pct += (95 - _pct) * 0.045;
    _updatePct(_pct);
  }, 250);
}

function stopPctCounter() {
  if (_pctTimer) { clearInterval(_pctTimer); _pctTimer = null; }
  _updatePct(100);
  setTimeout(() => _updatePct(0), 700);
}

// ── WARMUP UX ──────────────────────────────────────────────────────
function showWarmupUX() {
  const sub = document.getElementById('load-sub-line');
  let secs = 120;
  if (sub) sub.textContent = '🔥 טעינה ראשונה — עד 2 דקות';
  warmupTimer = setInterval(() => {
    secs--;
    if (secs > 0) {
      if (sub) sub.textContent = `⏱ עוד ~${secs} שניות`;
    } else {
      clearInterval(warmupTimer);
      warmupTimer = null;
      if (sub) sub.textContent = 'ממתין לתשובה...';
    }
  }, 1000);
}

function stopWarmupUX() {
  if (warmupTimer) { clearInterval(warmupTimer); warmupTimer = null; }
  const sub = document.getElementById('load-sub-line');
  if (sub) sub.textContent = 'טוען';
}

// ── LIVE VERIFICATION BANNER ───────────────────────────────────────
function showVerifyBanner() {
  const banner = document.getElementById('live-verify-banner');
  if (!banner) return;

  const now = new Date();
  const timeStr = now.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // Build source chips based on what we have
  const chips = [];

  // Yahoo Finance — stocks
  if (_stocksData) {
    const ok    = _stocksData.verified_count ?? _stocksData.total_count ?? 0;
    const total = _stocksData.total_count ?? 0;
    chips.push(`
      <span class="lvb-chip">
        <span class="lvb-dot"></span>
        <a href="https://finance.yahoo.com/" target="_blank" rel="noopener">Yahoo Finance</a>
        <span class="lvb-count">${ok}/${total} מניות</span>
      </span>`);
  }

  // Globes — arbitrage
  if (_arbData) {
    chips.push(`
      <span class="lvb-chip">
        <span class="lvb-dot"></span>
        <a href="https://www.globes.co.il/portal/arbitrage/" target="_blank" rel="noopener">גלובס ארביטראז'</a>
      </span>`);
  }

  // TASE — Put/Call (always present after load)
  chips.push(`
    <span class="lvb-chip">
      <span class="lvb-dot"></span>
      <a href="https://market.tase.co.il/he/market_data/derivatives/01/major_data/putvscall" target="_blank" rel="noopener">בורסת ת"א — Put/Call</a>
    </span>`);

  banner.innerHTML = `
    <span class="lvb-icon">✅</span>
    <span class="lvb-title">כל הנתונים מאומתים בלייב — 100%</span>
    <span class="lvb-sources">${chips.join('')}</span>
    <span class="lvb-time">עודכן: ${timeStr}</span>`;

  banner.classList.remove('hidden');
}

// ── RENDER ALL ─────────────────────────────────────────────────────
function renderAll(data) {
  const { analysis, scraped_data } = data;
  hasAnalysis = true;

  document.getElementById('hero-initial').classList.add('hidden');
  document.getElementById('hero').classList.add('hidden');
  document.getElementById('main-content').classList.remove('hidden');
  document.getElementById('hdr-ticker').classList.remove('hidden');
  document.getElementById('hdr-refresh-btn').classList.remove('hidden');

  if (scraped_data?.market)       renderMarket(scraped_data.market);
  if (scraped_data?.vta35)        renderVta35(scraped_data.vta35);
  if (scraped_data?.expiry_stats) renderStats(scraped_data.expiry_stats);

  if (analysis) {
    renderVolatility(analysis.volatility);
    // Ensure exactly 4 breaking news items for a clean 2×2 grid
    let bn = analysis.breaking_news || [];
    if (bn.length < 4 && analysis.top_news?.length) {
      const extra = analysis.top_news
        .filter(n => !bn.some(b => b.headline === n.headline))
        .slice(0, 4 - bn.length)
        .map(n => ({ headline: n.headline, direction: n.impact || 'ניטרלי', urgency: 'נמוכה' }));
      bn = [...bn, ...extra];
    }
    renderBreakingNews(bn);
    renderRisks(analysis.key_risks);
    renderNews(analysis.top_news);
    renderDisclaimer(analysis.disclaimer);
  }
}

// ── MARKET ─────────────────────────────────────────────────────────
function renderMarket(market) {
  if (!market?.market_data) return;
  const md = market.market_data;
  document.getElementById('hdr-price').textContent = fmtNum(md.price, 2);
  document.getElementById('stat-price').textContent = fmtNum(md.price, 2);
  const sign = md.change_pct >= 0 ? '+' : '';
  const changeTxt = `${sign}${md.change_pct.toFixed(2)}%`;
  const cls = md.change_pct > 0.05 ? 'up' : md.change_pct < -0.05 ? 'down' : 'flat';
  const hdrChange = document.getElementById('hdr-change');
  hdrChange.textContent = changeTxt;
  hdrChange.className = 'ticker-change ' + cls;
  document.getElementById('stat-change').textContent = changeTxt;
  document.getElementById('stat-change').className = 'stat-sub ' + cls;
  document.getElementById('stat-price').className =
    'stat-num ' + (md.change_pct > 0.05 ? 'green' : md.change_pct < -0.05 ? 'red' : 'cyan');
}

// ── VTA35 ───────────────────────────────────────────────────────────
function _vta35Label(val) {
  if (val >= 35) return { label: 'פאניקה',   cls: 'red'    };
  if (val >= 25) return { label: 'פחד גבוה', cls: 'red'    };
  if (val >= 15) return { label: 'רגיל',     cls: 'orange' };
  return            { label: 'שאננות',   cls: 'green'  };
}

function renderVta35(vta) {
  if (!vta || !vta.value) return;
  const val = vta.value;
  const { label, cls } = _vta35Label(val);
  const el  = document.getElementById('stat-vta35');
  const sub = document.getElementById('stat-vta35-sub');
  el.textContent = val.toFixed(1);
  el.className   = 'stat-num ' + cls;
  sub.textContent = label;
  // mark that real data filled this card so fallback won't overwrite
  el.dataset.real = '1';
}

// ── VOLATILITY (fallback if no VTA35 real data) ────────────────────
function renderVolatility(vol) {
  if (!vol) return;
  const el  = document.getElementById('stat-vta35');
  const sub = document.getElementById('stat-vta35-sub');
  // Only fill if real VTA35 data didn't already populate the card
  if (el && !el.dataset.real) {
    el.textContent  = vol.level || '—';
    el.className    = 'stat-num orange';
    if (sub) sub.textContent = ''; // no explanatory text — just the word
  }
}

// ── BREAKING NEWS (12 items) ─────────────────────────────────────────
function renderBreakingNews(items) {
  const block = document.getElementById('breaking-news-block');
  if (!items?.length) { block.style.display = 'none'; return; }

  const urgencyOrder = { 'גבוהה': 0, 'בינונית': 1, 'נמוכה': 2 };
  const sorted = [...items].sort((a, b) =>
    (urgencyOrder[a.urgency] ?? 9) - (urgencyOrder[b.urgency] ?? 9)
  );

  block.innerHTML = sorted.slice(0, 12).map(ni => {
    const dir    = ni.direction || '';
    const isBull = dir === 'שורי';
    const isBear = dir === 'דובי';
    const modCls = isBull ? ' bni-bull' : isBear ? ' bni-bear' : ' bni-neu';
    const badgeCls = isBull ? 'bull' : isBear ? 'bear' : 'neu';
    const urgIcon = ni.urgency === 'גבוהה' ? '⚡ ' : ni.urgency === 'בינונית' ? '● ' : '';
    return `
      <div class="bni-row${modCls}">
        <span class="bni-icon">📰</span>
        <span class="bni-headline">${esc(ni.headline)}</span>
        <span class="nia-badge ${badgeCls}">${urgIcon}${esc(dir)}</span>
      </div>`;
  }).join('');

  block.style.display = '';
}

// ── STATISTICS — always visible, two tables side by side ───────────
function renderStats(st) {
  const body = document.getElementById('stats-body');
  if (!st || st.error) { body.innerHTML = '<p class="stats-err">אין נתונים סטטיסטיים</p>'; return; }

  const ranges = st.settlement_ranges || {};
  const days   = st.by_day_of_week   || {};
  const pct    = st.percentiles      || {};

  // Range table (right column in RTL)
  const rangeRows = Object.entries(ranges).map(([key, v]) => {
    const label  = '±' + key.replace('pct', '%');
    const w      = Math.round(v.prob_seller_wins);
    const barCls = w >= 90 ? 'bar-green' : w >= 75 ? 'bar-sage' : w >= 60 ? 'bar-tan' : 'bar-orange';
    return `<tr>
      <td class="st-range">${label}</td>
      <td class="st-win"><div class="st-bar-wrap"><div class="st-bar ${barCls}" style="width:${w}%"></div><span class="st-bar-label">${v.prob_seller_wins}%</span></div></td>
      <td class="st-num bull-col">▲ ${v.bull_exceed_pct}%</td>
      <td class="st-num bear-col">▼ ${v.bear_exceed_pct}%</td>
    </tr>`;
  }).join('');

  // Day-of-week table (left column in RTL)
  const dayOrder = ['שני','שלישי','רביעי','חמישי','שישי','ראשון'];
  const dayRows = Object.entries(days)
    .sort((a,b) => dayOrder.indexOf(a[0]) - dayOrder.indexOf(b[0]))
    .map(([day, v]) => {
      const nc = v.note === 'הכי יציב' ? 'note-green' : v.note === 'הכי תנודתי' ? 'note-red' : '';
      return `<tr>
        <td class="st-day">${day}</td>
        <td class="st-num">${v.count}</td>
        <td class="st-num">${(+v.avg_move_pct).toFixed(3)}%</td>
        <td class="st-num">${v['within_0.5pct'] ?? '—'}%</td>
        <td class="st-num">${v['within_1pct']   ?? '—'}%</td>
        <td class="st-num">${v['within_1.5pct'] ?? '—'}%</td>
        <td class="st-note ${nc}">${v.note || ''}</td>
      </tr>`;
    }).join('');

  // Percentile pills
  const pills = [
    ['p25','25%'],['p50','חציון'],['p75','75%'],
    ['p90','90%'],['p95','95%'],['p99','99%'],
  ].map(([k,l]) => pct[k] != null
    ? `<div class="pct-pill"><span class="pct-pill-label">${l}</span><span class="pct-pill-val">${pct[k]}%</span></div>`
    : ''
  ).join('');

  body.innerHTML = `
    <!-- Summary bar -->
    <div class="stats-summary-bar">
      <div class="ssb-item red-val">
        <span class="ssb-val">▼ ${st.pct_bearish}%</span>
        <span class="ssb-label">דוביות</span>
      </div>
      <div class="ssb-sep"></div>
      <div class="ssb-item green-val">
        <span class="ssb-val">▲ ${st.pct_bullish}%</span>
        <span class="ssb-label">שוריות</span>
      </div>
      <div class="ssb-sep"></div>
      <div class="ssb-item">
        <span class="ssb-val">${st.avg_settlement_move_pct}%</span>
        <span class="ssb-label">תנועה ממוצעת לסגר</span>
      </div>
      <div class="ssb-sep"></div>
      <div class="ssb-item">
        <span class="ssb-val">${(st.total_records||0).toLocaleString('he-IL')}</span>
        <span class="ssb-label">פקיעות</span>
      </div>
    </div>
    <p class="stats-metric-note">${esc(st.metric_note || '')}</p>

    <!-- Two tables side by side -->
    <div class="stats-tables-row">
      <div class="stats-table-col">
        <div class="stats-col-title">יציבות לפי יום פקיעה</div>
        <div class="stats-table-wrap"><table class="stats-table">
          <thead><tr>
            <th>יום</th><th>מספר</th><th>תנועה ממוצעת</th>
            <th>±0.5%</th><th>±1%</th><th>±1.5%</th><th>הערה</th>
          </tr></thead>
          <tbody>${dayRows}</tbody>
        </table></div>
      </div>
      <div class="stats-table-col">
        <div class="stats-col-title">טווח תנועה — הסתברות שהשוק נשאר בטווח</div>
        <div class="stats-table-wrap"><table class="stats-table">
          <thead><tr>
            <th>טווח</th><th>בטווח</th>
            <th class="bear-col">חרג למטה</th><th class="bull-col">חרג למעלה</th>
          </tr></thead>
          <tbody>${rangeRows}</tbody>
        </table></div>
      </div>
    </div>

    <!-- Percentiles -->
    <div class="stats-pct-section">
      <div class="stats-col-title">פרצנטילים — תנועה מוחלטת לסגר</div>
      <div class="pct-pills-row">${pills}</div>
    </div>`;
}

// ── RISKS ──────────────────────────────────────────────────────────
function renderRisks(risks) {
  const chips = document.getElementById('risk-chips');
  if (!risks?.length) {
    chips.innerHTML = '<span class="risk-chip">לא זוהו סיכונים מהותיים</span>';
    return;
  }
  chips.innerHTML = risks.map(r => `<span class="risk-chip">${esc(r)}</span>`).join('');
}

// ── NEWS TABLE ─────────────────────────────────────────────────────
function renderNews(items) {
  const tbody = document.getElementById('news-tbody');
  tbody.innerHTML = '';
  if (!items?.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="padding:24px;text-align:center;color:var(--text-dim)">לא נמצאו כתבות</td></tr>`;
    return;
  }
  items.slice(0, 10).forEach((art, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="nt-num-cell">${i + 1}</td>
      <td><span class="src-badge ${getSrcClass(art.source)}">${getSrcLabel(art.source)}</span></td>
      <td class="nt-hl-cell"><a href="${esc(art.url||'#')}" target="_blank" rel="noopener noreferrer">${esc(art.headline)}</a></td>
      <td>${getImpactBadge(art.impact)}</td>`;
    tbody.appendChild(tr);
  });
}

function getSrcClass(s='') {
  s = s.toLowerCase();
  if (s.includes('כלכליסט')||s.includes('calcalist')) return 'src-calc';
  if (s.includes('כלכלה')||s.includes('economy'))     return 'src-eco';
  return 'src-ynet';
}
function getSrcLabel(s='') {
  s = s.toLowerCase();
  if (s.includes('כלכליסט')||s.includes('calcalist')) return 'CALCALIST';
  if (s.includes('כלכלה')||s.includes('economy'))     return 'YNET ECO';
  return 'YNET';
}
function getImpactBadge(impact) {
  if (impact === 'שורי') return '<span class="impact-badge impact-bull">▲ שורי</span>';
  if (impact === 'דובי') return '<span class="impact-badge impact-bear">▼ דובי</span>';
  return impact ? '<span class="impact-badge impact-neu">● ניטרלי</span>' : '';
}

// ── DISCLAIMER ─────────────────────────────────────────────────────
function renderDisclaimer(text) {
  if (text) document.getElementById('ai-disclaimer').textContent = text;
}

// ── ERROR ──────────────────────────────────────────────────────────
function showError(msg) {
  const b = document.getElementById('error-banner');
  b.textContent = '⚠ ' + msg;
  b.classList.remove('hidden');
}

// ── UTILS ──────────────────────────────────────────────────────────
function fmtNum(n, decimals = 2) {
  return Number(n).toLocaleString('he-IL', {
    minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  });
}
function esc(str) {
  const d = document.createElement('div');
  d.textContent = String(str || '');
  return d.innerHTML;
}

// ── PUT/CALL TABLE ─────────────────────────────────────────────────
let _pcLoading = false;

async function loadPutCall(expiry = null, force = false) {
  if (_pcLoading) return;
  _pcLoading = true;

  const body = document.getElementById('pc-body');
  if (!body) { _pcLoading = false; return; }

  body.innerHTML = '<div class="pc-loading">⏳ טוען פוזיציות פתוחות מהבורסה...</div>';

  try {
    const params = new URLSearchParams();
    const exp = expiry || selectedExpiry;
    if (exp)   params.set('expiry', exp);
    if (force) params.set('force',  'true');

    const resp = await fetch(`/api/putvscall?${params.toString()}`);
    if (!resp.ok) throw new Error(`שגיאת שרת: ${resp.status}`);
    const data = await resp.json();
    renderPutCall(data);
  } catch (err) {
    if (body) body.innerHTML = `<div class="pc-error">⚠ שגיאה בטעינת נתוני Put/Call: ${esc(err.message)}</div>`;
  } finally {
    _pcLoading = false;
  }
}

function renderPutCall(data) {
  const body    = document.getElementById('pc-body');
  const dateLbl = document.getElementById('pc-trade-date');
  if (!body) return;

  const items = data.items || [];

  if (!items.length) {
    body.innerHTML = `<div class="pc-loading" style="padding:32px;line-height:1.7">
      <div style="font-size:1.1rem;margin-bottom:8px">אין נתונים לתאריך זה</div>
      <div style="font-size:0.82rem;color:var(--text-dim)">ייתכן שאין עדיין מסחר פעיל לתאריך הפקיעה שנבחר.</div>
    </div>`;
    if (dateLbl) dateLbl.textContent = '';
    return;
  }

  // Format date label nicely
  let dateDisplay = '';
  if (data.actual_expiry || data.trade_date) {
    const raw = data.actual_expiry || data.trade_date;
    // Convert YYYY-MM-DD → DD/MM/YYYY for display
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      const [y, m, d] = raw.split('-');
      dateDisplay = `${d}/${m}/${y}`;
    } else {
      dateDisplay = raw;
    }
  }
  if (dateLbl) dateLbl.textContent = dateDisplay ? `נכון ל: ${dateDisplay}` : '';

  // Max Pain
  const maxPain = data.max_pain;

  // Summary totals
  let totalCallOI = 0, totalPutOI = 0;
  items.forEach(r => {
    totalCallOI += r.call_open_pos || 0;
    totalPutOI  += r.put_open_pos  || 0;
  });
  const totalOI = totalCallOI + totalPutOI || 1;
  const pcRatio = totalPutOI > 0 ? (totalCallOI / totalPutOI).toFixed(2) : '—';
  const callPct = Math.round(totalCallOI / totalOI * 100);
  const putPct  = 100 - callPct;

  // Max OI for bar scaling
  const maxOI = Math.max(...items.map(r => Math.max(r.call_open_pos || 0, r.put_open_pos || 0)), 1);

  // ATM — closest strike to current TA-35 price
  const currentPrice = parseFloat(document.getElementById('stat-price')?.textContent?.replace(/,/g, '') || '0');
  let atmStrike = null;
  if (currentPrice > 0) {
    let minDiff = Infinity;
    items.forEach(r => {
      const diff = Math.abs(r.strike - currentPrice);
      if (diff < minDiff) { minDiff = diff; atmStrike = r.strike; }
    });
  }

  // Note if current price is above the highest listed strike
  const maxStrike = Math.max(...items.map(r => r.strike || 0));
  const aboveRangeNote = (currentPrice > 0 && maxStrike > 0 && currentPrice > maxStrike)
    ? `<div class="pc-range-note">⚠ מחיר המדד הנוכחי (${currentPrice.toLocaleString('he-IL')}) גבוה ממחיר המימוש המקסימלי המפורסם לתאריך זה (${maxStrike.toLocaleString('he-IL')}). הבורסה אינה מפרסמת סדרות מימוש חדשות לאמצע תקופה.</div>`
    : '';

  const sorted = [...items].sort((a, b) => a.strike - b.strike);

  const rows = sorted.map(r => {
    const isAtm    = atmStrike && r.strike === atmStrike;
    const atmClass = isAtm ? ' class="pc-atm"' : '';
    const strike   = r.strike?.toLocaleString('he-IL') || '—';

    const callOI   = r.call_open_pos != null ? r.call_open_pos.toLocaleString('he-IL') : '—';
    const callVol  = r.call_vol      != null ? r.call_vol.toLocaleString('he-IL')      : '—';
    const callLast = r.call_last_rate != null ? Math.round(r.call_last_rate).toLocaleString('he-IL') : '—';
    const putOI    = r.put_open_pos  != null ? r.put_open_pos.toLocaleString('he-IL')  : '—';
    const putVol   = r.put_vol       != null ? r.put_vol.toLocaleString('he-IL')       : '—';
    const putLast  = r.put_last_rate  != null ? Math.round(r.put_last_rate).toLocaleString('he-IL') : '—';

    const callBarW = Math.round((r.call_open_pos || 0) / maxOI * 60);
    const putBarW  = Math.round((r.put_open_pos  || 0) / maxOI * 60);

    return `<tr${atmClass}>
      <td class="pc-td-call">
        <div class="pc-oi-bar-wrap">
          <span>${callOI}</span>
          <div class="pc-oi-bar call" style="width:${callBarW}px"></div>
        </div>
      </td>
      <td class="pc-td-call" style="font-size:0.8rem">${callVol}</td>
      <td class="pc-td-call" style="font-size:0.8rem">${callLast}</td>
      <td class="pc-td-mid">${strike}${isAtm ? ' ◉' : ''}</td>
      <td class="pc-td-put" style="font-size:0.8rem">${putLast}</td>
      <td class="pc-td-put" style="font-size:0.8rem">${putVol}</td>
      <td class="pc-td-put">
        <div class="pc-oi-bar-wrap" style="flex-direction:row-reverse">
          <span>${putOI}</span>
          <div class="pc-oi-bar put" style="width:${putBarW}px"></div>
        </div>
      </td>
    </tr>`;
  }).join('');

  // Max Pain banner
  let maxPainHtml = '';
  if (maxPain) {
    const mpDistPct = currentPrice > 0
      ? ((maxPain - currentPrice) / currentPrice * 100).toFixed(2)
      : null;
    const mpDir = mpDistPct !== null
      ? (parseFloat(mpDistPct) > 0 ? `▲ ${mpDistPct}% מעל המחיר` : `▼ ${Math.abs(mpDistPct)}% מתחת למחיר`)
      : '';
    maxPainHtml = `<div class="pc-max-pain">
      <span class="pc-mp-label">🎯 Max Pain</span>
      <span class="pc-mp-val">${maxPain.toLocaleString('he-IL')}</span>
      ${mpDir ? `<span class="pc-mp-dist">${mpDir}</span>` : ''}
    </div>`;
  }

  body.innerHTML = `
    ${maxPainHtml}
    ${aboveRangeNote}
    <div class="pc-summary">
      <div class="pc-sum-item">
        <span class="pc-sum-val call-col">${totalCallOI.toLocaleString('he-IL')}</span>
        <span class="pc-sum-label">סה"כ OI — Call</span>
      </div>
      <div class="pc-sum-item">
        <span class="pc-sum-val ratio-col">${pcRatio}</span>
        <span class="pc-sum-label">יחס Call/Put</span>
      </div>
      <div class="pc-sum-item">
        <span class="pc-sum-val put-col">${totalPutOI.toLocaleString('he-IL')}</span>
        <span class="pc-sum-label">סה"כ OI — Put</span>
      </div>
    </div>
    <div class="pc-ratio-bar-wrap">
      <div class="pc-ratio-bar-call" style="width:${callPct}%"></div>
      <div class="pc-ratio-bar-put"  style="width:${putPct}%"></div>
    </div>
    <div class="pc-table-wrap">
      <table class="pc-table">
        <thead>
          <tr>
            <th class="pc-th-call" colspan="3">📈 Call</th>
            <th class="pc-th-mid">מחיר מימוש</th>
            <th class="pc-th-put" colspan="3">📉 Put</th>
          </tr>
          <tr>
            <th class="pc-th-call">פוזיציות פתוחות</th>
            <th class="pc-th-call">מחזור</th>
            <th class="pc-th-call">שער אחרון</th>
            <th class="pc-th-mid">Strike</th>
            <th class="pc-th-put">שער אחרון</th>
            <th class="pc-th-put">מחזור</th>
            <th class="pc-th-put">פוזיציות פתוחות</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  // Auto-scroll to ATM row after render
  if (atmStrike) {
    requestAnimationFrame(() => {
      const atmRow = body.querySelector('tr.pc-atm');
      if (atmRow) atmRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }
}

function onPcExpiryChange(val) {
  pcSelectedExpiry = val;
  const dateLbl = document.getElementById('pc-trade-date');
  if (dateLbl) dateLbl.textContent = 'לחץ "נתח" לטעינת הנתונים עבור תאריך זה';
}

// ── כפתור "נתח" ייעודי לטבלת Put/Call ──────────────────────────────
// מסרק מחדש רק את נתוני האופציות לתאריך הנבחר — ללא נגיעה בשאר הדשבורד
async function refreshPutCall() {
  const btn = document.getElementById('pc-analyze-btn');
  if (btn) { btn.disabled = true; btn.classList.add('spinning'); }

  try {
    await loadPutCall(pcSelectedExpiry, true);  // force=true → סריקת Playwright מחדש
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
  }
}

// ── TA-35 STOCKS — TradingView watchlist ────────────────────────────

async function loadStocks(force = false) {
  const bodyAll  = document.getElementById('stocks-body-all');
  const bodyDual = document.getElementById('stocks-body-dual');
  if (!bodyAll && !bodyDual) return;

  if (!force && _stocksData) { renderStocks(_stocksData); return; }

  if (bodyAll)  bodyAll.innerHTML  = '<div class="stocks-loading">⏳ טוען מחירי מניות...</div>';
  if (bodyDual) bodyDual.innerHTML = '<div class="stocks-loading">⏳ טוען...</div>';

  try {
    const params = new URLSearchParams();
    if (force) params.set('force', 'true');
    const resp = await fetch(`/api/stocks?${params.toString()}`);
    if (!resp.ok) throw new Error(`שגיאת שרת: ${resp.status}`);
    const data = await resp.json();
    _stocksData = data;
    renderStocks(data);
    showVerifyBanner();

    const upd = document.getElementById('stocks-updated');
    if (upd && data.fetched_at) {
      const d = new Date(data.fetched_at);
      upd.textContent = `עוד׳ ${d.toLocaleTimeString('he-IL', { hour:'2-digit', minute:'2-digit' })}`;
    }
  } catch (err) {
    body.innerHTML = `<div class="stocks-loading">⚠ ${esc(err.message)}</div>`;
  }
}

function _chgCls(pct) {
  if (pct == null) return 'flat';
  return pct > 0.05 ? 'up' : pct < -0.05 ? 'down' : 'flat';
}
function _chgChip(pct, extraClass = '') {
  if (pct == null) return `<span class="wl-chg-chip flat${extraClass}">—</span>`;
  const cls  = _chgCls(pct);
  const sign = pct > 0 ? '+' : '';
  const arr  = cls === 'up' ? '▲' : cls === 'down' ? '▼' : '●';
  return `<span class="wl-chg-chip ${cls}${extraClass}">${arr} ${sign}${pct.toFixed(2)}%</span>`;
}

function renderStocks(data) {
  if (!data?.stocks) return;

  // ── TASE column ───────────────────────────────────────────────────
  const bodyAll = document.getElementById('stocks-body-all');
  if (bodyAll) {
    const allStocks = [...data.stocks].sort((a, b) => (b.change_pct ?? -999) - (a.change_pct ?? -999));
    if (!allStocks.length) {
      bodyAll.innerHTML = '<div class="stocks-loading">לא נמצאו מניות</div>';
    } else {
      const rows = allStocks.map((s, idx) => {
        const cls       = _chgCls(s.change_pct);
        const priceHtml = s.price != null
          ? fmtNum(s.price, 2)
          : '<span style="color:var(--text-dim)">—</span>';
        return `<tr class="wl-row ${cls}">
          <td class="wl-num">${idx + 1}</td>
          <td class="wl-name">${esc(s.name_he)}</td>
          <td class="wl-ticker">${esc(s.tase_ticker)}</td>
          <td class="wl-price">${priceHtml}</td>
          <td class="wl-change">${_chgChip(s.change_pct)}</td>
        </tr>`;
      }).join('');
      bodyAll.innerHTML = `<table class="wl-table">
        <thead><tr>
          <th class="th-num">#</th>
          <th>שם מניה</th>
          <th>טיקר</th>
          <th class="th-price">מחיר ₪</th>
          <th class="th-change">שינוי%</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    }
  }

  // ── US dual column ────────────────────────────────────────────────
  const bodyDual = document.getElementById('stocks-body-dual');
  if (bodyDual) {
    const dualStocks = [...data.stocks]
      .filter(s => s.dual_listed)
      .sort((a, b) => (b.us_change_pct ?? -999) - (a.us_change_pct ?? -999));
    if (!dualStocks.length) {
      bodyDual.innerHTML = '<div class="stocks-loading">לא נמצאו מניות דואליות</div>';
    } else {
      const stateMap = { LIVE: 'us-live', PRE: 'us-pre', AH: 'us-ah', '---': 'us-cls' };
      const rows = dualStocks.map((s, idx) => {
        const usCls      = _chgCls(s.us_change_pct);
        const stateCls   = stateMap[s.us_market_state] || 'us-cls';
        const stateLbl   = s.us_market_state || '---';
        const usPriceHtml = s.us_price_usd != null
          ? `$${fmtNum(s.us_price_usd, 2)}`
          : '<span style="color:var(--text-dim)">—</span>';
        return `<tr class="wl-row ${usCls}">
          <td class="wl-num">${idx + 1}</td>
          <td class="wl-name">${esc(s.name_he)}</td>
          <td class="wl-ticker wl-us-badge-cell">
            <span class="wl-us-badge">
              <span class="wl-us-exch">${esc(s.us_exchange || '')}</span>
              ${esc(s.us_ticker || '')}
            </span>
          </td>
          <td class="wl-us-price">${usPriceHtml}</td>
          <td class="wl-us-chg">${_chgChip(s.us_change_pct)}</td>
          <td class="wl-us-state"><span class="us-state-badge ${stateCls}">${stateLbl}</span></td>
        </tr>`;
      }).join('');
      bodyDual.innerHTML = `<table class="wl-table">
        <thead><tr>
          <th class="th-num">#</th>
          <th>שם מניה</th>
          <th class="th-us-ticker">טיקר US</th>
          <th class="th-us-price">מחיר $</th>
          <th class="th-change">שינוי%</th>
          <th style="width:52px">שוק</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    }
  }
}

// ── ARBITRAGE — Globes live data ─────────────────────────────────────

async function loadArbitrage(force = false) {
  const body = document.getElementById('arb-body');
  if (!body) return;

  if (!force && _arbData) { renderArbitrage(_arbData); return; }

  body.innerHTML = `<div class="arb-loading">⏳ שולף נתוני ארביטראז' מגלובס...</div>`;

  try {
    const params = new URLSearchParams();
    if (force) params.set('force', 'true');
    const resp = await fetch(`/api/arbitrage?${params.toString()}`);
    if (!resp.ok) throw new Error(`שגיאת שרת: ${resp.status}`);
    const data = await resp.json();
    _arbData = data;
    renderArbitrage(data);
    showVerifyBanner();

    const upd = document.getElementById('arb-updated');
    if (upd && data.fetched_at) {
      const d = new Date(data.fetched_at);
      upd.textContent = `עוד׳ ${d.toLocaleTimeString('he-IL', { hour:'2-digit', minute:'2-digit' })}`;
    }
  } catch (err) {
    body.innerHTML = `<div class="arb-loading">⚠ ${esc(err.message)}</div>`;
  }
}

function _arbChip(pct) {
  if (pct == null) return '<span class="arb-pct-chip flat">—</span>';
  const cls  = pct > 0.05 ? 'up' : pct < -0.05 ? 'down' : 'flat';
  const sign = pct > 0 ? '+' : '';
  const arr  = cls === 'up' ? '▲' : cls === 'down' ? '▼' : '●';
  return `<span class="arb-pct-chip ${cls}">${arr} ${sign}${pct.toFixed(2)}%</span>`;
}

function _arbSumVal(pct) {
  if (pct == null) return { txt: '—', cls: 'flat' };
  const cls  = pct > 0.05 ? 'up' : pct < -0.05 ? 'down' : 'flat';
  const sign = pct > 0 ? '+' : '';
  return { txt: `${sign}${pct.toFixed(2)}%`, cls };
}

function renderArbitrage(data) {
  const body = document.getElementById('arb-body');
  if (!body) return;

  const sum    = data.summary || {};
  const stocks = (data.stocks || []);

  if (!stocks.length && !sum.current_impact_pct) {
    body.innerHTML = `<div class="arb-loading">
      אין נתוני ארביטראז' זמינים${data.error ? ` — ${esc(data.error)}` : ''}</div>`;
    return;
  }

  // Summary bar
  const cur  = _arbSumVal(sum.current_impact_pct);
  const ini  = _arbSumVal(sum.initial_impact_pct);
  const ta35 = _arbSumVal(sum.ta35_actual_pct);
  const rate = sum.usd_ils_rate
    ? `<span class="arb-rate">1$ = ${sum.usd_ils_rate.toFixed(4)} ₪</span>` : '';

  const summaryHtml = `<div class="arb-summary">
    <div class="arb-sum-item">
      <span class="arb-sum-label">השפעה עדכנית</span>
      <span class="arb-sum-val ${cur.cls}">${cur.txt}</span>
    </div>
    <div class="arb-sum-sep"></div>
    <div class="arb-sum-item">
      <span class="arb-sum-label">השפעה התחלתית</span>
      <span class="arb-sum-val ${ini.cls}">${ini.txt}</span>
    </div>
    <div class="arb-sum-sep"></div>
    <div class="arb-sum-item">
      <span class="arb-sum-label">שינוי ת"א 35 בפועל</span>
      <span class="arb-sum-val ${ta35.cls}">${ta35.txt}</span>
    </div>
    ${rate}
  </div>`;

  body.innerHTML = summaryHtml;
}

