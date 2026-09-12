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
