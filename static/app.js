'use strict';

let isLoading    = false;
let stepTimer    = null;
let warmupTimer  = null;
let selectedExpiry = null;
let hasAnalysis  = false;

const FETCH_TIMEOUT_MS = 200_000; // 3:20 min hard cap

document.addEventListener('DOMContentLoaded', () => {
  loadExpiryDates().then(() => {
    refreshData();
    loadPutCall();  // load Put/Call independently
  });
});

// ── EXPIRY (kept for API param, no UI dropdown) ─────────────────────
async function loadExpiryDates() {
  try {
    const resp = await fetch('/api/expiry-dates');
    if (!resp.ok) return;
    const { expiry_dates } = await resp.json();
    if (expiry_dates?.length) selectedExpiry = expiry_dates[0].label;
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
  animateSteps();

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
  } catch (err) {
    if (err.name === 'AbortError') showError('הניתוח לקח יותר מדי זמן — נסה שוב');
    else showError(err.message);
  } finally {
    clearTimeout(warmupSwitch);
    clearTimeout(hardCap);
    clearTimeout(stepTimer);
    stopWarmupUX();
    isLoading = false;
    btn.disabled = false;
    btn.classList.remove('spinning');
    if (hdrBtn) { hdrBtn.disabled = false; hdrBtn.querySelector('.hdr-refresh-icon').textContent = '⟳'; }
    overlay.classList.add('hidden');
  }
}

// ── WARMUP UX ──────────────────────────────────────────────────────
function showWarmupUX() {
  const el = document.querySelector('.load-steps');
  if (!el) return;
  el.innerHTML = `
    <div class="warmup-msg">
      <div class="warmup-title">🔥 מאתחל את הסוכן</div>
      <div class="warmup-sub">הטעינה הראשונה לוקחת עד 2 דקות.</div>
      <div class="warmup-sub">הפעמים הבאות יהיו מיידיות.</div>
      <div id="warmup-counter" class="warmup-counter">⏱ 120 שניות</div>
    </div>`;
  let secs = 120;
  warmupTimer = setInterval(() => {
    secs--;
    const counter = document.getElementById('warmup-counter');
    if (secs > 0) {
      if (counter) counter.textContent = `⏱ ${secs} שניות`;
    } else {
      clearInterval(warmupTimer);
      warmupTimer = null;
      if (counter) counter.textContent = 'ממתין לתשובה...';
    }
  }, 1000);
}

function stopWarmupUX() {
  if (warmupTimer) { clearInterval(warmupTimer); warmupTimer = null; }
  const el = document.querySelector('.load-steps');
  if (!el) return;
  el.innerHTML = `
    <div class="lstep" id="lstep-1"><span class="lstep-dot"></span>אוסף נתוני שוק בזמן אמת</div>
    <div class="lstep" id="lstep-2"><span class="lstep-dot"></span>סורק כותרות מהמקורות</div>
    <div class="lstep" id="lstep-3"><span class="lstep-dot"></span>מנתח עם בינה מלאכותית</div>`;
}

// ── STEP ANIMATION ─────────────────────────────────────────────────
function animateSteps() {
  const ids = ['lstep-1','lstep-2','lstep-3'];
  let i = 0;
  resetSteps();
  const el0 = document.getElementById(ids[0]);
  if (el0) el0.classList.add('active');
  function next() {
    const cur = document.getElementById(ids[i]);
    if (!cur || i >= ids.length - 1) return;
    cur.classList.replace('active','done');
    i++;
    const nxt = document.getElementById(ids[i]);
    if (nxt) nxt.classList.add('active');
    stepTimer = setTimeout(next, 5000);
  }
  stepTimer = setTimeout(next, 4500);
}
function resetSteps() {
  ['lstep-1','lstep-2','lstep-3'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active','done');
  });
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
    renderBreakingNews(analysis.breaking_news);
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
  const body      = document.getElementById('pc-body');
  const expSelect = document.getElementById('pc-expiry-select');
  const dateLbl   = document.getElementById('pc-trade-date');
  if (!body) return;

  const items = data.items || [];
  
  // Populate expiry dropdown if we have dates
  if (expSelect && data.expiry_dates?.length) {
    const currentVal = expSelect.value;
    expSelect.innerHTML = data.expiry_dates.map(d => 
      `<option value="${esc(d.date)}" ${d.date === data.expiry_date ? 'selected' : ''}>${esc(d.label)}</option>`
    ).join('');
    
    // If we didn't have a selection yet, or if it changed
    if (data.expiry_date) selectedExpiry = data.expiry_date;
  }

  if (!items.length) {
    body.innerHTML = '<div class="pc-loading">אין נתונים זמינים לתאריך זה</div>';
    return;
  }

  if (dateLbl) dateLbl.textContent = data.trade_date ? `נכון ל: ${data.trade_date}` : '';

  // Compute summary totals
  let totalCallOI = 0, totalPutOI = 0;
  items.forEach(r => {
    totalCallOI += r.call_open_pos || 0;
    totalPutOI  += r.put_open_pos  || 0;
  });
  const totalOI  = totalCallOI + totalPutOI || 1;
  const pcRatio  = totalPutOI > 0 ? (totalCallOI / totalPutOI).toFixed(2) : '—';
  const callPct  = Math.round(totalCallOI / totalOI * 100);
  const putPct   = 100 - callPct;

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

  // Build rows — sorted by strike ascending
  const sorted = [...items].sort((a, b) => a.strike - b.strike);

  const rows = sorted.map(r => {
    const isAtm = atmStrike && r.strike === atmStrike;
    const atmClass = isAtm ? ' class="pc-atm"' : '';

    const callOI     = r.call_open_pos != null ? r.call_open_pos.toLocaleString('he-IL') : '—';
    const callChg    = r.call_pos_change != null ? fmtChg(r.call_pos_change) : '';
    const callDeals  = r.call_deals != null ? r.call_deals : '—';
    const putOI      = r.put_open_pos  != null ? r.put_open_pos.toLocaleString('he-IL')  : '—';
    const putChg     = r.put_pos_change  != null ? fmtChg(r.put_pos_change)  : '';
    const putDeals   = r.put_deals  != null ? r.put_deals  : '—';
    const strike     = r.strike?.toLocaleString('he-IL') || '—';

    const callBarW = Math.round((r.call_open_pos || 0) / maxOI * 60);
    const putBarW  = Math.round((r.put_open_pos  || 0) / maxOI * 60);

    return `<tr${atmClass}>
      <td class="pc-td-call">
        <div class="pc-oi-bar-wrap">
          <span>${callOI}</span>
          <div class="pc-oi-bar call" style="width:${callBarW}px"></div>
        </div>
      </td>
      <td class="pc-td-call" style="font-size:0.75rem">${callChg}</td>
      <td class="pc-td-call" style="font-size:0.75rem">${callDeals}</td>
      <td class="pc-td-mid">${strike}${isAtm ? ' ◉' : ''}</td>
      <td class="pc-td-put" style="font-size:0.75rem">${putDeals}</td>
      <td class="pc-td-put" style="font-size:0.75rem">${putChg}</td>
      <td class="pc-td-put">
        <div class="pc-oi-bar-wrap" style="flex-direction:row-reverse">
          <span>${putOI}</span>
          <div class="pc-oi-bar put" style="width:${putBarW}px"></div>
        </div>
      </td>
    </tr>`;
  }).join('');

  body.innerHTML = `
    <!-- Summary bar -->
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
    <!-- Visual ratio bar -->
    <div class="pc-ratio-bar-wrap">
      <div class="pc-ratio-bar-call" style="width:${callPct}%"></div>
      <div class="pc-ratio-bar-put"  style="width:${putPct}%"></div>
    </div>
    <!-- Table -->
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
            <th class="pc-th-call">שינוי</th>
            <th class="pc-th-call">עסקות</th>
            <th class="pc-th-mid">Strike</th>
            <th class="pc-th-put">עסקות</th>
            <th class="pc-th-put">שינוי</th>
            <th class="pc-th-put">פוזיציות פתוחות</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function onPcExpiryChange(val) {
  selectedExpiry = val;
  loadPutCall(val);
}

function fmtChg(n) {
  if (n == null || n === 0) return '';
  const sign = n > 0 ? '+' : '';
  return `<span style="color:${n > 0 ? 'var(--green)' : 'var(--red)'}">${sign}${n.toLocaleString('he-IL')}</span>`;
}
