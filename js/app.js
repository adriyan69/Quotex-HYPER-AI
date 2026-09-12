import { AlertManager } from './alerts/alertManager.js';
import { getSignals, clearHistory, countSignals } from './history/historyStore.js';
import { sampleCandles } from './core/sampleData.js';
import { normalizeCandles } from './core/CandleNormalizer.js';

// ---- Service worker registration (required for installability) ----
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch((err) => {
      console.error('SW registration failed', err);
    });
  });
}

// ---- Optional on-device debug console (no PC needed) ----
// Open the app with ?debug=1 to load a small floating console for viewing
// JS errors/logs directly on your phone.
if (new URLSearchParams(location.search).get('debug') === '1') {
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/eruda';
  s.onload = () => window.eruda && window.eruda.init();
  document.body.appendChild(s);
}

// ---- Elements ----
const collapsedEl = document.getElementById('collapsed');
const expandedEl = document.getElementById('expanded');
const dragHandle = document.getElementById('dragHandle');
const collapseBtn = document.getElementById('collapseBtn');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const restartBtn = document.getElementById('restartBtn');
const useSampleBtn = document.getElementById('useSampleBtn');
const fileInput = document.getElementById('fileInput');
const notifyBtn = document.getElementById('notifyBtn');
const historyBtn = document.getElementById('historyBtn');
const historyOverlay = document.getElementById('historyOverlay');
const historyCloseBtn = document.getElementById('historyCloseBtn');
const historyList = document.getElementById('historyList');
const historyCount = document.getElementById('historyCount');
const historyClearBtn = document.getElementById('historyClearBtn');
const backtestBtn = document.getElementById('backtestBtn');
const backtestOverlay = document.getElementById('backtestOverlay');
const backtestCloseBtn = document.getElementById('backtestCloseBtn');
const backtestRunBtn = document.getElementById('backtestRunBtn');
const backtestResults = document.getElementById('backtestResults');
const dashboardBtn = document.getElementById('dashboardBtn');
const dashboardOverlay = document.getElementById('dashboardOverlay');
const dashboardCloseBtn = document.getElementById('dashboardCloseBtn');
const dashboardRunBtn = document.getElementById('dashboardRunBtn');
const dashboardResults = document.getElementById('dashboardResults');
const mlBtn = document.getElementById('mlBtn');
const mlOverlay = document.getElementById('mlOverlay');
const mlCloseBtn = document.getElementById('mlCloseBtn');
const mlRunBtn = document.getElementById('mlRunBtn');
const mlResults = document.getElementById('mlResults');

// ---- Alerts: dedup/cooldown decision (AlertManager) + the actual
// notification/sound/visual-flash triggering (this file, UI thread only —
// Notification/Audio/DOM APIs aren't available inside the Web Worker).
const alertManager = new AlertManager({ minStrength: 70, cooldownMs: 60_000 });
let audioCtx = null;

function unlockAudio() {
  // Browsers block audio until a user gesture "unlocks" it. Start/notifyBtn
  // clicks are real user gestures, so create/resume the AudioContext there
  // rather than waiting until an alert actually needs to play a sound.
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}

function playAlertTone(direction) {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.value = direction === 'bearish' ? 440 : 880; // lower tone for SELL, higher for BUY
  gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.35);
}

function flashAlert(direction) {
  const cls = direction === 'bearish' ? 'alert-flash-sell' : 'alert-flash-buy';
  [collapsedEl, expandedEl].forEach((el) => {
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), 1500);
  });
}

async function showAlertNotification(payload) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const title = `${STATE_LABELS[payload.signalState] || payload.signalState} \u2014 ${payload.strength}/100`;
  const time = new Date(payload.timestamp).toLocaleTimeString();
  const options = {
    body: `${payload.asset} \u00b7 ${payload.timeframe}\n${payload.reasons?.[0] || ''}\nSignal time: ${time}`,
    icon: 'icons/icon-192.png',
    tag: 'market-ai-signal', // replaces any previous notification instead of stacking
  };

  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) {
      await reg.showNotification(title, options);
      return;
    }
  } catch (err) {
    // fall through to the plain Notification constructor
  }
  try {
    new Notification(title, options);
  } catch (err) {
    console.error('Notification failed', err);
  }
}

function triggerAlert(payload) {
  const direction = payload.signalState.includes('SELL') ? 'bearish' : 'bullish';
  flashAlert(direction);
  playAlertTone(direction);
  showAlertNotification(payload);
}

notifyBtn.addEventListener('click', async () => {
  unlockAudio();
  if (!('Notification' in window)) {
    notifyBtn.textContent = 'Notifications unsupported';
    return;
  }
  const result = await Notification.requestPermission();
  updateNotifyBtn(result);
});

function updateNotifyBtn(permission) {
  if (permission === 'granted') {
    notifyBtn.textContent = 'Notifications on';
    notifyBtn.classList.add('chip-active');
  } else if (permission === 'denied') {
    notifyBtn.textContent = 'Notifications blocked';
    notifyBtn.classList.remove('chip-active');
  } else {
    notifyBtn.textContent = 'Enable notifications';
    notifyBtn.classList.remove('chip-active');
  }
}
if ('Notification' in window) updateNotifyBtn(Notification.permission);
else notifyBtn.textContent = 'Notifications unsupported';

// ---- Drag-anywhere-on-screen support (touch + mouse via Pointer Events) ----
function makeDraggable(handleEl, moveTargetEl, onTap) {
  let dragging = false;
  let moved = false;
  let startX, startY, origRight, origBottom;

  handleEl.addEventListener('pointerdown', (e) => {
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    const rect = moveTargetEl.getBoundingClientRect();
    origRight = window.innerWidth - rect.right;
    origBottom = window.innerHeight - rect.bottom;
    handleEl.setPointerCapture(e.pointerId);
  });

  handleEl.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true;
    if (!moved) return;

    const rect = moveTargetEl.getBoundingClientRect();
    let newRight = origRight - dx;
    let newBottom = origBottom - dy;

    // Clamp within viewport so the widget never gets dragged off-screen.
    newRight = Math.min(Math.max(newRight, 0), window.innerWidth - rect.width);
    newBottom = Math.min(Math.max(newBottom, 0), window.innerHeight - rect.height);

    moveTargetEl.style.right = `${newRight}px`;
    moveTargetEl.style.bottom = `${newBottom}px`;
  });

  handleEl.addEventListener('pointerup', (e) => {
    dragging = false;
    handleEl.releasePointerCapture(e.pointerId);
    if (!moved && onTap) onTap();
  });
}

makeDraggable(collapsedEl, collapsedEl, () => setExpanded(true));
makeDraggable(dragHandle, expandedEl, null);

collapseBtn.addEventListener('click', () => setExpanded(false));

function setExpanded(expanded) {
  collapsedEl.classList.toggle('hidden', expanded);
  expandedEl.classList.toggle('hidden', !expanded);
}

// ---- Analysis engine (runs in a Web Worker, fully separate from the UI) ----
const engine = new Worker('js/worker/engine.worker.js', { type: 'module' });

startBtn.addEventListener('click', () => {
  unlockAudio();
  engine.postMessage({ type: 'start' });
  startBtn.disabled = true;
  stopBtn.disabled = false;
});

stopBtn.addEventListener('click', () => {
  engine.postMessage({ type: 'stop' });
  startBtn.disabled = false;
  stopBtn.disabled = true;
});

restartBtn.addEventListener('click', () => {
  engine.postMessage({ type: 'restart' });
  startBtn.disabled = false;
  stopBtn.disabled = true;
});

// ---- Data source: synthetic sample (default) vs. an imported file ----
// File reading happens here on the UI thread (Workers can't use the File
// API the same way), gets normalized, then handed to the worker as plain
// data via postMessage — the worker never touches the File object itself.
// currentCandlesForBacktest tracks whichever dataset is active, so the
// Backtest overlay always runs against what's actually loaded.
let currentCandlesForBacktest = normalizeCandles(sampleCandles);

useSampleBtn.addEventListener('click', () => {
  engine.postMessage({ type: 'restart' }); // safest default: restart the bundled sample
  setActiveSourceChip(useSampleBtn);
  document.getElementById('datasetLabel').textContent = 'Synthetic sample (not real market data)';
  currentCandlesForBacktest = normalizeCandles(sampleCandles);
});

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const text = await file.text();
  const { parseCandleCSV } = await import('./core/CandleNormalizer.js');

  let candles;
  try {
    if (file.name.toLowerCase().endsWith('.json')) {
      candles = normalizeCandles(JSON.parse(text));
    } else {
      candles = parseCandleCSV(text);
    }
  } catch (err) {
    alert('Could not parse that file. Expected CSV with a header row (time,open,high,low,close) or a JSON array of candles.');
    return;
  }

  if (!candles.length) {
    alert('No valid candles found in that file after normalization.');
    return;
  }

  currentCandlesForBacktest = candles;
  engine.postMessage({ type: 'loadCandles', payload: { candles, label: file.name } });
  setActiveSourceChip(fileInput.closest('.chip'));
  document.getElementById('datasetLabel').textContent = `${file.name} (${candles.length} candles)`;
  startBtn.disabled = false;
  stopBtn.disabled = true;
});

function setActiveSourceChip(activeEl) {
  document.querySelectorAll('.chip').forEach((c) => c.classList.remove('chip-active'));
  if (activeEl) activeEl.classList.add('chip-active');
}

const STATE_LABELS = {
  STRONG_BUY: 'STRONG BUY', BUY: 'BUY', WAIT: 'WAIT',
  SELL: 'SELL', STRONG_SELL: 'STRONG SELL', NO_TRADE: 'NO TRADE',
};
const STATE_CLASS = {
  STRONG_BUY: 'state-strong-buy', BUY: 'state-buy', WAIT: 'state-wait',
  SELL: 'state-sell', STRONG_SELL: 'state-strong-sell', NO_TRADE: 'state-no-trade',
};

engine.onmessage = (e) => render(e.data);

function render(payload) {
  document.getElementById('assetVal').textContent = payload.asset;
  document.getElementById('tfVal').textContent = payload.timeframe;
  document.getElementById('marketVal').textContent = payload.marketStatus;

  if (alertManager.shouldAlert(payload)) {
    triggerAlert(payload);
  }

  if (payload.dataset) {
    document.getElementById('datasetLabel').textContent = payload.dataset;
  }

  const lastCandleVal = document.getElementById('lastCandleVal');
  if (payload.lastCandle) {
    const c = payload.lastCandle;
    const t = new Date(c.time).toLocaleTimeString();
    lastCandleVal.textContent = `${t}  O:${c.open.toFixed(5)} H:${c.high.toFixed(5)} L:${c.low.toFixed(5)} C:${c.close.toFixed(5)}`;
  } else {
    lastCandleVal.textContent = '--';
  }

  if (payload.marketStatus === 'CLOSED') {
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }

  renderIndicators(payload.indicators);
  renderStructure(payload.structure);

  const stateEl = document.getElementById('signalState');
  stateEl.textContent = STATE_LABELS[payload.signalState] || payload.signalState;
  stateEl.className = 'signal-state ' + (STATE_CLASS[payload.signalState] || '');

  document.getElementById('strengthVal').textContent = `${payload.strength}/100`;
  document.getElementById('strengthFill').style.width = `${payload.strength}%`;
  document.getElementById('buyScoreVal').textContent = `BUY ${payload.buyScore ?? 0}`;
  document.getElementById('sellScoreVal').textContent = `SELL ${payload.sellScore ?? 0}`;

  const reasonsList = document.getElementById('reasonsList');
  reasonsList.innerHTML = '';
  (payload.reasons || []).forEach((r) => {
    const li = document.createElement('li');
    li.textContent = `• ${r}`;
    reasonsList.appendChild(li);
  });

  const warningsList = document.getElementById('warningsList');
  warningsList.innerHTML = '';
  (payload.warnings || []).forEach((w) => {
    const li = document.createElement('li');
    li.textContent = `⚠ ${w}`;
    warningsList.appendChild(li);
  });

  document.getElementById('collapsedSignal').textContent =
    (STATE_LABELS[payload.signalState] || '--').split(' ')[0];
}

function setIndVal(id, text, tone) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.classList.remove('ind-bullish', 'ind-bearish', 'ind-neutral');
  if (tone) el.classList.add(tone);
}

function toneFromLabel(label) {
  if (!label) return null;
  const l = label.toLowerCase();
  if (l.includes('bullish') || l.includes('oversold') || l.includes('positive') || l.includes('below lower')) return 'ind-bullish';
  if (l.includes('bearish') || l.includes('overbought') || l.includes('negative') || l.includes('above upper')) return 'ind-bearish';
  return null;
}

function renderIndicators(indicators) {
  if (!indicators) return;

  setIndVal('indTrend', indicators.trend.label, toneFromLabel(indicators.trend.label));

  const rsi = indicators.momentum.rsi;
  setIndVal(
    'indRsi',
    rsi === null ? 'Insufficient data' : `${rsi.toFixed(1)} — ${indicators.momentum.rsiLabel}`,
    toneFromLabel(indicators.momentum.rsiLabel)
  );

  const hist = indicators.momentum.macd.histogram;
  setIndVal(
    'indMacd',
    hist === null ? 'Insufficient data' : `${hist.toFixed(6)} — ${indicators.momentum.macdLabel}`,
    toneFromLabel(indicators.momentum.macdLabel)
  );

  const roc = indicators.momentum.roc;
  setIndVal(
    'indRoc',
    roc === null ? 'Insufficient data' : `${roc.toFixed(3)}% — ${indicators.momentum.rocLabel}`,
    toneFromLabel(indicators.momentum.rocLabel)
  );

  const atrVal = indicators.volatility.atr;
  setIndVal('indAtr', atrVal === null ? 'Insufficient data' : atrVal.toFixed(6), null);

  setIndVal(
    'indBollinger',
    indicators.volatility.bollingerLabel,
    toneFromLabel(indicators.volatility.bollingerLabel)
  );
}

function toneFromBiasOrEvent(text) {
  if (!text) return null;
  const l = text.toLowerCase();
  if (l.includes('bullish') || l.includes('uptrend')) return 'ind-bullish';
  if (l.includes('bearish') || l.includes('downtrend')) return 'ind-bearish';
  if (l.includes('ranging') || l.includes('choch')) return 'ind-neutral';
  return null;
}

function renderStructure(structure) {
  if (!structure) return;

  setIndVal('structBias', structure.biasLabel, toneFromBiasOrEvent(structure.biasLabel));

  setIndVal(
    'structEvent',
    structure.event ? structure.event.label : 'No BOS/CHoCH yet',
    structure.event ? toneFromBiasOrEvent(structure.event.label) : null
  );

  setIndVal(
    'structSwingHigh',
    structure.lastSwingHigh ? `${structure.lastSwingHigh.price.toFixed(5)} (${structure.lastSwingHigh.label ?? '--'})` : '--',
    null
  );

  setIndVal(
    'structSwingLow',
    structure.lastSwingLow ? `${structure.lastSwingLow.price.toFixed(5)} (${structure.lastSwingLow.label ?? '--'})` : '--',
    null
  );
}

// ---- Signal history overlay (Phase 8) ----

const STATE_TONE_CLASS = {
  STRONG_BUY: 'state-buy-side', BUY: 'state-buy-side',
  STRONG_SELL: 'state-sell-side', SELL: 'state-sell-side',
  WAIT: 'state-neutral', NO_TRADE: 'state-neutral',
};

let historyStateFilter = 'ALL';
let historyMinStrength = 0;

historyBtn.addEventListener('click', () => {
  historyOverlay.classList.remove('hidden');
  refreshHistoryList();
});

historyCloseBtn.addEventListener('click', () => {
  historyOverlay.classList.add('hidden');
});

document.querySelectorAll('[data-state-filter]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-state-filter]').forEach((b) => b.classList.remove('chip-active'));
    btn.classList.add('chip-active');
    historyStateFilter = btn.dataset.stateFilter;
    refreshHistoryList();
  });
});

document.querySelectorAll('[data-min-strength]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-min-strength]').forEach((b) => b.classList.remove('chip-active'));
    btn.classList.add('chip-active');
    historyMinStrength = Number(btn.dataset.minStrength);
    refreshHistoryList();
  });
});

historyClearBtn.addEventListener('click', async () => {
  if (!confirm('Clear all logged signal history? This cannot be undone.')) return;
  await clearHistory();
  refreshHistoryList();
});

async function refreshHistoryList() {
  const [records, total] = await Promise.all([
    getSignals({ limit: 200, stateFilter: historyStateFilter, minStrength: historyMinStrength }),
    countSignals(),
  ]);

  historyCount.textContent = `${total} signal${total === 1 ? '' : 's'} logged total \u2014 showing ${records.length}`;

  historyList.innerHTML = '';
  if (!records.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = total === 0 ? 'No signals logged yet \u2014 tap START to begin.' : 'No signals match this filter.';
    historyList.appendChild(empty);
    return;
  }

  for (const record of records) {
    historyList.appendChild(renderHistoryItem(record));
  }
}

function renderHistoryItem(record) {
  const item = document.createElement('div');
  item.className = 'history-item';

  const top = document.createElement('div');
  top.className = 'history-item-top';

  const stateEl = document.createElement('span');
  stateEl.className = 'history-item-state ' + (STATE_TONE_CLASS[record.signalState] || 'state-neutral');
  stateEl.textContent = STATE_LABELS[record.signalState] || record.signalState;

  const strengthEl = document.createElement('span');
  strengthEl.className = 'history-item-strength';
  strengthEl.textContent = `${record.strength}/100`;

  top.appendChild(stateEl);
  top.appendChild(strengthEl);

  const meta = document.createElement('div');
  meta.className = 'history-item-meta';
  const time = new Date(record.timestamp).toLocaleString();
  const price = record.entryPrice !== null && record.entryPrice !== undefined ? record.entryPrice.toFixed(5) : '--';
  meta.textContent = `${time} \u00b7 ${record.asset} \u00b7 ${record.timeframe} \u00b7 price ${price}`;

  const reason = document.createElement('div');
  reason.className = 'history-item-reason';
  reason.textContent = record.reason || '';

  item.appendChild(top);
  item.appendChild(meta);
  item.appendChild(reason);
  return item;
}

// ---- Backtest overlay (Phase 9) ----
// Runs in its own dedicated Worker, separate from the live engine.worker.js
// loop, so a potentially heavier one-off computation never competes with
// live analysis.

let backtestMinStrength = 70;
let backtestHoldingPeriod = 1;
let backtestWorker = null;

backtestBtn.addEventListener('click', () => {
  backtestOverlay.classList.remove('hidden');
});

backtestCloseBtn.addEventListener('click', () => {
  backtestOverlay.classList.add('hidden');
});

document.querySelectorAll('[data-bt-strength]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-bt-strength]').forEach((b) => b.classList.remove('chip-active'));
    btn.classList.add('chip-active');
    backtestMinStrength = Number(btn.dataset.btStrength);
  });
});

document.querySelectorAll('[data-bt-holding]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-bt-holding]').forEach((b) => b.classList.remove('chip-active'));
    btn.classList.add('chip-active');
    backtestHoldingPeriod = Number(btn.dataset.btHolding);
  });
});

backtestRunBtn.addEventListener('click', () => {
  backtestResults.innerHTML = '<div class="backtest-loading">Running backtest…</div>';
  backtestRunBtn.disabled = true;

  if (!backtestWorker) {
    backtestWorker = new Worker('js/worker/backtest.worker.js', { type: 'module' });
    backtestWorker.onmessage = (e) => {
      backtestRunBtn.disabled = false;
      if (e.data.type === 'result') {
        renderBacktestResults(e.data.result);
      } else if (e.data.type === 'error') {
        backtestResults.innerHTML = `<div class="backtest-loading">Backtest failed: ${e.data.message}</div>`;
      }
    };
  }

  backtestWorker.postMessage({
    type: 'run',
    payload: {
      candles: currentCandlesForBacktest,
      options: { minStrength: backtestMinStrength, holdingPeriod: backtestHoldingPeriod },
    },
  });
});

function statTone(value, goodIfAbove) {
  if (value === null || value === undefined) return '';
  return value >= goodIfAbove ? 'tone-good' : 'tone-bad';
}

function renderBacktestResults(r) {
  backtestResults.innerHTML = '';

  if (r.totalTrades === 0) {
    backtestResults.innerHTML = '<div class="backtest-loading">No qualifying trades at this threshold/holding period — try lowering the minimum strength.</div>';
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'bt-stat-grid';

  const stats = [
    ['Total trades', r.totalTrades, ''],
    ['Win rate', `${r.winRate.toFixed(1)}%`, statTone(r.winRate, 50)],
    ['Wins / Losses', `${r.wins} / ${r.losses}`, ''],
    ['Profit factor', r.profitFactor === Infinity ? '∞' : r.profitFactor.toFixed(2), statTone(r.profitFactor === Infinity ? 99 : r.profitFactor, 1)],
    ['Avg return', r.averageReturn.toFixed(6), statTone(r.averageReturn, 0)],
    ['Max drawdown', r.maxDrawdown.toFixed(6), ''],
    ['Max win streak', r.maxWinStreak, ''],
    ['Max loss streak', r.maxLossStreak, ''],
    ['Signal freq.', `${r.signalFrequencyPer100.toFixed(1)}/100 candles`, ''],
    ['Candles processed', r.candlesProcessed, ''],
  ];

  for (const [label, value, tone] of stats) {
    const stat = document.createElement('div');
    stat.className = 'bt-stat';
    stat.innerHTML = `<div class="bt-stat-label">${label}</div><div class="bt-stat-value ${tone}">${value}</div>`;
    grid.appendChild(stat);
  }
  backtestResults.appendChild(grid);

  const directionTitle = document.createElement('div');
  directionTitle.className = 'reasons-title';
  directionTitle.textContent = 'By direction';
  backtestResults.appendChild(directionTitle);

  for (const dir of ['BUY', 'SELL']) {
    const d = r.byDirection[dir];
    const row = document.createElement('div');
    row.className = 'bt-direction-row';
    row.innerHTML = `<span>${dir}-side (${d.total})</span><span>${d.total ? d.winRate.toFixed(1) + '% win rate' : '--'}</span>`;
    backtestResults.appendChild(row);
  }

  const exclusions = document.createElement('div');
  exclusions.className = 'bt-exclusions';
  exclusions.textContent = `${r.signalsBelowThreshold} signal(s) excluded below strength ${r.minStrength}; ${r.signalsExcludedInsufficientFutureData} excluded near the end of the dataset (no future candle to grade against).`;
  backtestResults.appendChild(exclusions);

  const recentTitle = document.createElement('div');
  recentTitle.className = 'reasons-title';
  recentTitle.style.marginTop = '10px';
  recentTitle.textContent = 'Recent trades (newest first)';
  backtestResults.appendChild(recentTitle);

  for (const t of r.recentTrades) {
    const item = document.createElement('div');
    item.className = 'bt-trade-item';
    const time = new Date(t.time).toLocaleTimeString();
    item.innerHTML = `<span>${time} ${t.direction} @ ${t.entryPrice.toFixed(5)}</span><span class="${t.win ? 'bt-trade-win' : 'bt-trade-loss'}">${t.win ? 'WIN' : 'LOSS'} ${t.return >= 0 ? '+' : ''}${t.return.toFixed(5)}</span>`;
    backtestResults.appendChild(item);
  }
}

// ---- Performance dashboard (Phase 10) ----
// Combines two honestly-distinct data sources, kept visually separate so
// they're never confused for one another:
//   1. The logged signal history (Phase 8) — what the app actually showed
//      you, across however many runs/datasets you've had loaded over time.
//   2. A fresh backtest re-run (Phase 9's engine, at minStrength=0 to
//      cover every strength band) against the CURRENTLY loaded dataset —
//      this is what supplies the graded win/loss numbers, since the
//      history log has no ground-truth outcome to grade against.
// Neither of these is "live trading performance" — there is none yet.

let dashboardWorker = null;

dashboardBtn.addEventListener('click', () => {
  dashboardOverlay.classList.remove('hidden');
  runDashboard();
});

dashboardCloseBtn.addEventListener('click', () => {
  dashboardOverlay.classList.add('hidden');
});

dashboardRunBtn.addEventListener('click', runDashboard);

async function runDashboard() {
  dashboardResults.innerHTML = '<div class="backtest-loading">Loading…</div>';
  dashboardRunBtn.disabled = true;

  const historyStats = await computeHistoryStats();

  if (!dashboardWorker) {
    dashboardWorker = new Worker('js/worker/backtest.worker.js', { type: 'module' });
  }
  dashboardWorker.onmessage = (e) => {
    dashboardRunBtn.disabled = false;
    if (e.data.type === 'result') {
      renderDashboard(historyStats, e.data.result);
    } else if (e.data.type === 'error') {
      dashboardResults.innerHTML = `<div class="backtest-loading">Dashboard failed: ${e.data.message}</div>`;
    }
  };
  dashboardWorker.postMessage({
    type: 'run',
    payload: { candles: currentCandlesForBacktest, options: { minStrength: 0, holdingPeriod: 1 } },
  });
}

async function computeHistoryStats() {
  const records = await getSignals({ limit: 5000, stateFilter: 'ALL', minStrength: 0 });
  const counts = { STRONG_BUY: 0, BUY: 0, WAIT: 0, SELL: 0, STRONG_SELL: 0, NO_TRADE: 0 };
  let strengthSum = 0;
  let strengthCount = 0;

  for (const r of records) {
    if (counts[r.signalState] !== undefined) counts[r.signalState]++;
    if (r.signalState !== 'NO_TRADE') {
      strengthSum += r.strength;
      strengthCount++;
    }
  }

  return {
    total: records.length,
    counts,
    avgStrength: strengthCount ? strengthSum / strengthCount : null,
  };
}

function renderDashboard(historyStats, bt) {
  dashboardResults.innerHTML = '';

  const histTitle = document.createElement('div');
  histTitle.className = 'reasons-title';
  histTitle.textContent = 'From your logged signal history';
  dashboardResults.appendChild(histTitle);

  const rows = [
    ['Total signals logged', historyStats.total],
    ['STRONG BUY', historyStats.counts.STRONG_BUY],
    ['BUY', historyStats.counts.BUY],
    ['WAIT', historyStats.counts.WAIT],
    ['SELL', historyStats.counts.SELL],
    ['STRONG SELL', historyStats.counts.STRONG_SELL],
    ['NO TRADE', historyStats.counts.NO_TRADE],
    ['Avg strength (excl. NO TRADE)', historyStats.avgStrength !== null ? historyStats.avgStrength.toFixed(1) : '--'],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'dash-summary-row';
    row.innerHTML = `<span>${label}</span><span>${value}</span>`;
    dashboardResults.appendChild(row);
  }

  const btTitle = document.createElement('div');
  btTitle.className = 'reasons-title';
  btTitle.style.marginTop = '14px';
  btTitle.textContent = `Backtest re-run on current dataset (all strengths, holding 1 candle)`;
  dashboardResults.appendChild(btTitle);

  if (bt.totalTrades === 0) {
    const none = document.createElement('div');
    none.className = 'backtest-loading';
    none.textContent = 'No qualifying trades in the current dataset yet.';
    dashboardResults.appendChild(none);
    return;
  }

  const btRows = [
    ['Total trades', bt.totalTrades],
    ['Win rate', `${bt.winRate.toFixed(1)}%`],
    ['Wins / Losses', `${bt.wins} / ${bt.losses}`],
    ['Max win streak', bt.maxWinStreak],
    ['Max loss streak', bt.maxLossStreak],
  ];
  for (const [label, value] of btRows) {
    const row = document.createElement('div');
    row.className = 'dash-summary-row';
    row.innerHTML = `<span>${label}</span><span>${value}</span>`;
    dashboardResults.appendChild(row);
  }

  const bucketTitle = document.createElement('div');
  bucketTitle.className = 'reasons-title';
  bucketTitle.style.marginTop = '14px';
  bucketTitle.textContent = 'Signal strength vs actual win rate';
  dashboardResults.appendChild(bucketTitle);

  const bucketTable = document.createElement('div');
  bucketTable.className = 'dash-bucket-table';
  const header = document.createElement('div');
  header.className = 'dash-bucket-row header';
  header.innerHTML = '<span>Strength</span><span>Trades</span><span>Win rate</span>';
  bucketTable.appendChild(header);

  for (const b of bt.strengthBuckets) {
    const row = document.createElement('div');
    row.className = 'dash-bucket-row';
    const wr = b.winRate;
    const tone = wr === null ? '' : wr >= 50 ? 'tone-good' : 'tone-bad';
    row.innerHTML = `
      <span>${b.label}</span>
      <span>${b.total}</span>
      <span>${wr !== null ? wr.toFixed(1) + '%' : '--'}</span>
      <div class="dash-bucket-bar-wrap"><div class="dash-bucket-bar ${tone}" style="width:${wr !== null ? wr.toFixed(0) : 0}%"></div></div>
    `;
    bucketTable.appendChild(row);
  }
  dashboardResults.appendChild(bucketTable);

  const hourTitle = document.createElement('div');
  hourTitle.className = 'reasons-title';
  hourTitle.textContent = 'Results by hour (from candle timestamps)';
  dashboardResults.appendChild(hourTitle);

  const hourTable = document.createElement('div');
  hourTable.className = 'dash-bucket-table';
  const hourHeader = document.createElement('div');
  hourHeader.className = 'dash-bucket-row header';
  hourHeader.innerHTML = '<span>Hour</span><span>Trades</span><span>Win rate</span>';
  hourTable.appendChild(hourHeader);

  for (const h of bt.hourBuckets) {
    const row = document.createElement('div');
    row.className = 'dash-bucket-row';
    const wr = h.winRate;
    const tone = wr === null ? '' : wr >= 50 ? 'tone-good' : 'tone-bad';
    row.innerHTML = `
      <span>${String(h.hour).padStart(2, '0')}:00</span>
      <span>${h.total}</span>
      <span>${wr !== null ? wr.toFixed(1) + '%' : '--'}</span>
      <div class="dash-bucket-bar-wrap"><div class="dash-bucket-bar ${tone}" style="width:${wr !== null ? wr.toFixed(0) : 0}%"></div></div>
    `;
    hourTable.appendChild(row);
  }
  dashboardResults.appendChild(hourTable);

  const note = document.createElement('div');
  note.className = 'bt-exclusions';
  note.textContent = 'Only one asset/timeframe is ever loaded in this app, so there\u2019s no separate "by asset" or "by timeframe" breakdown to show \u2014 it would just repeat the same row.';
  dashboardResults.appendChild(note);
}

// ---- ML experiment overlay (Phase 11, optional) ----
// Entirely separate from the live SIGNAL — this never feeds back into
// scoringEngine.js. Runs in its own dedicated worker.

let mlWorker = null;

mlBtn.addEventListener('click', () => {
  mlOverlay.classList.remove('hidden');
});

mlCloseBtn.addEventListener('click', () => {
  mlOverlay.classList.add('hidden');
});

mlRunBtn.addEventListener('click', () => {
  mlResults.innerHTML = '<div class="backtest-loading">Training…</div>';
  mlRunBtn.disabled = true;

  if (!mlWorker) {
    mlWorker = new Worker('js/worker/ml.worker.js', { type: 'module' });
  }
  mlWorker.onmessage = (e) => {
    mlRunBtn.disabled = false;
    if (e.data.type === 'result') {
      renderMlResults(e.data.result);
    } else if (e.data.type === 'error') {
      mlResults.innerHTML = `<div class="backtest-loading">Training failed: ${e.data.message}</div>`;
    }
  };
  mlWorker.postMessage({
    type: 'run',
    payload: { candles: currentCandlesForBacktest, options: { holdingPeriod: 1 } },
  });
});

function renderMlResults(r) {
  mlResults.innerHTML = '';

  if (r.insufficientData) {
    mlResults.innerHTML = `<div class="backtest-loading">Not enough usable candles yet (have ${r.sampleSize}, need 40+) — let more data load or import a larger file.</div>`;
    return;
  }

  const splitTitle = document.createElement('div');
  splitTitle.className = 'reasons-title';
  splitTitle.textContent = 'Chronological split (never shuffled)';
  mlResults.appendChild(splitTitle);

  const splitRows = [
    ['Train', r.splitSizes.train],
    ['Validation', r.splitSizes.validation],
    ['Test (out-of-sample)', r.splitSizes.test],
  ];
  for (const [label, value] of splitRows) {
    const row = document.createElement('div');
    row.className = 'dash-summary-row';
    row.innerHTML = `<span>${label}</span><span>${value} candles</span>`;
    mlResults.appendChild(row);
  }

  const accTitle = document.createElement('div');
  accTitle.className = 'reasons-title';
  accTitle.style.marginTop = '14px';
  accTitle.textContent = 'Accuracy by split';
  mlResults.appendChild(accTitle);

  const accRows = [
    ['Train accuracy', r.trainAccuracy, false],
    ['Validation accuracy', r.validationAccuracy, false],
    ['Test accuracy (out-of-sample)', r.testAccuracy, true],
  ];
  for (const [label, value, emphasize] of accRows) {
    const row = document.createElement('div');
    row.className = 'dash-summary-row';
    const tone = value >= 55 ? 'tone-good' : value <= 45 ? 'tone-bad' : '';
    row.innerHTML = `<span>${emphasize ? '<strong>' + label + '</strong>' : label}</span><span class="${tone}">${value.toFixed(1)}%</span>`;
    mlResults.appendChild(row);
  }

  if (r.trainAccuracy - r.testAccuracy > 15) {
    const warn = document.createElement('div');
    warn.className = 'bt-exclusions';
    warn.textContent = `Train accuracy is ${(r.trainAccuracy - r.testAccuracy).toFixed(0)} points higher than test accuracy — a sign of overfitting on this small sample, not a model you'd want to trust.`;
    mlResults.appendChild(warn);
  }

  const calTitle = document.createElement('div');
  calTitle.className = 'reasons-title';
  calTitle.style.marginTop = '14px';
  calTitle.textContent = 'Predicted probability vs actual outcome (test set)';
  mlResults.appendChild(calTitle);

  const calTable = document.createElement('div');
  calTable.className = 'dash-bucket-table';
  const calHeader = document.createElement('div');
  calHeader.className = 'dash-bucket-row header';
  calHeader.innerHTML = '<span>Predicted</span><span>n</span><span>Actual up-rate</span>';
  calTable.appendChild(calHeader);
  for (const c of r.calibration) {
    const row = document.createElement('div');
    row.className = 'dash-bucket-row';
    const tone = c.actualUpRate >= 50 ? 'tone-good' : 'tone-bad';
    row.innerHTML = `
      <span>${c.label}</span>
      <span>${c.count}</span>
      <span>${c.actualUpRate.toFixed(1)}%</span>
      <div class="dash-bucket-bar-wrap"><div class="dash-bucket-bar ${tone}" style="width:${c.actualUpRate.toFixed(0)}%"></div></div>
    `;
    calTable.appendChild(row);
  }
  mlResults.appendChild(calTable);

  const wfTitle = document.createElement('div');
  wfTitle.className = 'reasons-title';
  wfTitle.style.marginTop = '14px';
  wfTitle.textContent = 'Walk-forward validation (expanding window)';
  mlResults.appendChild(wfTitle);

  if (r.walkForward.ran) {
    const wfRow = document.createElement('div');
    wfRow.className = 'dash-summary-row';
    wfRow.innerHTML = `<span>Average accuracy across ${r.walkForward.folds} folds</span><span>${r.walkForward.averageAccuracy.toFixed(1)}%</span>`;
    mlResults.appendChild(wfRow);
    const foldsRow = document.createElement('div');
    foldsRow.className = 'bt-exclusions';
    foldsRow.textContent = `Per-fold: ${r.walkForward.foldAccuracies.map((a) => a.toFixed(0) + '%').join(', ')} — each fold retrains on everything before it and tests only on the next chronological chunk.`;
    mlResults.appendChild(foldsRow);
  } else {
    const none = document.createElement('div');
    none.className = 'bt-exclusions';
    none.textContent = `Walk-forward not run: ${r.walkForward.reason}`;
    mlResults.appendChild(none);
  }

  const noteFinal = document.createElement('div');
  noteFinal.className = 'bt-exclusions';
  noteFinal.style.marginTop = '10px';
  noteFinal.textContent = 'This experiment never feeds back into the live SIGNAL — scoringEngine.js remains 100% rule-based regardless of anything shown here.';
  mlResults.appendChild(noteFinal);
}
