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
useSampleBtn.addEventListener('click', () => {
  engine.postMessage({ type: 'restart' }); // safest default: restart the bundled sample
  setActiveSourceChip(useSampleBtn);
  document.getElementById('datasetLabel').textContent = 'Synthetic sample (not real market data)';
});

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const text = await file.text();
  const { normalizeCandles, parseCandleCSV } = await import('./core/CandleNormalizer.js');

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

  const stateEl = document.getElementById('signalState');
  stateEl.textContent = STATE_LABELS[payload.signalState] || payload.signalState;
  stateEl.className = 'signal-state ' + (STATE_CLASS[payload.signalState] || '');

  document.getElementById('strengthVal').textContent = `${payload.strength}/100`;
  document.getElementById('strengthFill').style.width = `${payload.strength}%`;

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
