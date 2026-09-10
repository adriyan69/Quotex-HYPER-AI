/**
 * CandleNormalizer
 *
 * Every MarketDataProvider (mock, replay, or a future licensed live feed)
 * can emit slightly different raw shapes. This module is the single place
 * that converts anything into the canonical shape the rest of the pipeline
 * depends on:
 *
 *   { time: <ms epoch>, open, high, low, close, volume? }
 *
 * Keeping this separate means indicators/structure/signal code (Phases 3-5)
 * never has to know or care where a candle came from.
 */

function toCanonical(raw) {
  // Accepts either an object with named fields, or a positional array
  // [time, open, high, low, close, volume?] which is the most common shape
  // exported by broker/data-vendor CSV downloads.
  let time, open, high, low, close, volume;

  if (Array.isArray(raw)) {
    [time, open, high, low, close, volume] = raw;
  } else if (raw && typeof raw === 'object') {
    time = raw.time ?? raw.timestamp ?? raw.t ?? raw.date;
    open = raw.open ?? raw.o;
    high = raw.high ?? raw.h;
    low = raw.low ?? raw.l;
    close = raw.close ?? raw.c;
    volume = raw.volume ?? raw.v;
  } else {
    return null;
  }

  time = normalizeTime(time);
  open = Number(open);
  high = Number(high);
  low = Number(low);
  close = Number(close);
  volume = volume === undefined ? undefined : Number(volume);

  if (
    time === null ||
    [open, high, low, close].some((v) => Number.isNaN(v))
  ) {
    return null; // malformed candle — dropped, not guessed at
  }

  // A candle's high/low must bound its open/close, or the row is corrupt.
  if (high < Math.max(open, close) || low > Math.min(open, close)) {
    return null;
  }

  const candle = { time, open, high, low, close };
  if (volume !== undefined && !Number.isNaN(volume)) candle.volume = volume;
  return candle;
}

function normalizeTime(t) {
  if (t === undefined || t === null || t === '') return null;
  if (typeof t === 'number') {
    // Treat plausible seconds-based epoch as seconds, else assume ms.
    return t < 10_000_000_000 ? t * 1000 : t;
  }
  const parsed = Date.parse(t);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Normalizes an array of raw candles: converts, drops malformed rows,
 * sorts ascending by time, and de-duplicates same-timestamp entries
 * (keeping the last occurrence).
 */
export function normalizeCandles(rawList) {
  const byTime = new Map();
  for (const raw of rawList) {
    const c = toCanonical(raw);
    if (c) byTime.set(c.time, c);
  }
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

/**
 * Minimal CSV parser for candle files: expects a header row containing
 * some combination of time/timestamp/date, open, high, low, close,
 * volume (case-insensitive, any order).
 */
export function parseCandleCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const idx = {
    time: header.findIndex((h) => ['time', 'timestamp', 'date'].includes(h)),
    open: header.findIndex((h) => h === 'open' || h === 'o'),
    high: header.findIndex((h) => h === 'high' || h === 'h'),
    low: header.findIndex((h) => h === 'low' || h === 'l'),
    close: header.findIndex((h) => h === 'close' || h === 'c'),
    volume: header.findIndex((h) => h === 'volume' || h === 'v'),
  };

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = lines[i].split(',');
    rows.push({
      time: idx.time >= 0 ? cols[idx.time] : undefined,
      open: idx.open >= 0 ? cols[idx.open] : undefined,
      high: idx.high >= 0 ? cols[idx.high] : undefined,
      low: idx.low >= 0 ? cols[idx.low] : undefined,
      close: idx.close >= 0 ? cols[idx.close] : undefined,
      volume: idx.volume >= 0 ? cols[idx.volume] : undefined,
    });
  }
  return normalizeCandles(rows);
}
