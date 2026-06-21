const fs = require("fs");

const file = process.argv[2];
if (!file) throw new Error("CSV path is required");

const PIP = 100;
const RSI_PERIOD = 14;
const MAX_HOLD = 180;
const SPREAD = 0.8;
const RULES = [
  { id: "core_rule_e", name: "Core Rule E", rsiLimit: 25, dropLimit: -10 },
  { id: "core_rule_f_lite", name: "Core Rule F Lite", rsiLimit: 25, dropLimit: -8 },
];

const text = fs.readFileSync(file, "utf8");
const parsed = parseCsvBars(text);
const bars = dedupeAndSortBars(parsed.bars);
enrichBars(bars);

const byRule = Object.fromEntries(RULES.map((r) => [r.id, []]));
for (let i = 30; i < bars.length - MAX_HOLD - 1; i++) {
  const b = bars[i];
  if (!validFeatureBar(b)) continue;
  if (!isJstRange(b.time, 0, 2)) continue;
  if (!b.lowUpdate3) continue;
  for (const rule of RULES) {
    if (b.rsi < rule.rsiLimit && b.recent3 <= rule.dropLimit) {
      const exit = simulateTrail(bars, i, 10, 5);
      if (!exit) continue;
      byRule[rule.id].push({
        year: b.time.getFullYear(),
        pips: exit.pips - SPREAD,
      });
    }
  }
}

const out = {
  rows: parsed.loadedRows,
  bars: bars.length,
  start: bars[0]?.time,
  end: bars.at(-1)?.time,
  results: [],
};
for (const rule of RULES) {
  for (const year of [2023, 2024, 2025, 2026]) {
    const trades = byRule[rule.id].filter((t) => t.year === year);
    out.results.push({ rule: rule.name, year, ...calcMetrics(trades.map((t) => t.pips)) });
  }
  out.results.push({ rule: rule.name, year: "All", ...calcMetrics(byRule[rule.id].map((t) => t.pips)) });
}
console.log(JSON.stringify(out, null, 2));

function simulateTrail(data, i, startPips, trailPips) {
  const entry = data[i]?.close;
  if (!Number.isFinite(entry)) return null;
  let best = entry;
  for (let j = i + 1; j < Math.min(data.length, i + MAX_HOLD + 1); j++) {
    const b = data[j];
    if (!validBar(b)) continue;
    if (b.high > best) best = b.high;
    const mfe = (best - entry) * PIP;
    if (mfe >= startPips && (best - b.low) * PIP >= trailPips) {
      return { pips: (best - trailPips / PIP - entry) * PIP };
    }
  }
  const last = data[Math.min(data.length - 1, i + MAX_HOLD)];
  return last ? { pips: (last.close - entry) * PIP } : null;
}

function enrichBars(data) {
  let gains = 0, losses = 0;
  for (let i = 1; i < data.length; i++) {
    const diff = data[i].close - data[i - 1].close;
    if (i <= RSI_PERIOD) {
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    if (i === RSI_PERIOD) {
      data[i].avgGain = gains / RSI_PERIOD;
      data[i].avgLoss = losses / RSI_PERIOD;
      data[i].rsi = rsiFrom(data[i].avgGain, data[i].avgLoss);
    } else if (i > RSI_PERIOD) {
      const gain = Math.max(diff, 0), loss = Math.max(-diff, 0);
      data[i].avgGain = (data[i - 1].avgGain * (RSI_PERIOD - 1) + gain) / RSI_PERIOD;
      data[i].avgLoss = (data[i - 1].avgLoss * (RSI_PERIOD - 1) + loss) / RSI_PERIOD;
      data[i].rsi = rsiFrom(data[i].avgGain, data[i].avgLoss);
    }
    if (i >= 3) {
      data[i].recent3 = (data[i].close - data[i - 3].close) * PIP;
      data[i].lowUpdate3 = data[i].low <= Math.min(data[i - 1].low, data[i - 2].low, data[i - 3].low);
    }
  }
}

function rsiFrom(avgGain, avgLoss) {
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcMetrics(values) {
  const count = values.length;
  const wins = values.filter((v) => v > 0);
  const losses = values.filter((v) => v < 0);
  const grossProfit = sum(wins);
  const grossLoss = Math.abs(sum(losses));
  const totalPips = sum(values);
  return {
    count,
    winRate: count ? (wins.length / count) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0,
    expectancy: count ? totalPips / count : 0,
    totalPips,
    maxDrawdown: maxDrawdown(values),
  };
}
function maxDrawdown(values) {
  let equity = 0, peak = 0, dd = 0;
  for (const v of values) {
    equity += v;
    if (equity > peak) peak = equity;
    dd = Math.max(dd, peak - equity);
  }
  return dd;
}
function sum(values) { return values.reduce((a, b) => a + b, 0); }

function parseCsvBars(text) {
  const rows = parseCsv(text).filter((r) => r.some((c) => String(c).trim() !== ""));
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const idx = detectColumns(header);
  const start = idx.hasHeader ? 1 : 0;
  const bars = [];
  for (let r = start; r < rows.length; r++) {
    const row = rows[r];
    const b = {
      time: parseDate(row[idx.time]),
      open: toNumber(row[idx.open]),
      high: toNumber(row[idx.high]),
      low: toNumber(row[idx.low]),
      close: toNumber(row[idx.close]),
    };
    if (validBar(b)) bars.push(b);
  }
  return { bars, loadedRows: Math.max(0, rows.length - start) };
}
function detectColumns(header) {
  const hasHeader = header.some((h) => /(time|date|datetime|日時|日付)/i.test(h));
  if (!hasHeader) return { hasHeader: false, time: 0, open: 1, high: 2, low: 3, close: 4 };
  const find = (patterns) => header.findIndex((h) => patterns.some((p) => p.test(h)));
  const idx = {
    hasHeader: true,
    time: find([/datetime/, /time/, /date/, /日時/, /日付/]),
    open: find([/^open$/, /始値/]),
    high: find([/^high$/, /高値/]),
    low: find([/^low$/, /安値/]),
    close: find([/^close$/, /終値/]),
  };
  for (const k of ["time", "open", "high", "low", "close"]) {
    if (idx[k] < 0) idx[k] = { time: 0, open: 1, high: 2, low: 3, close: 4 }[k];
  }
  return idx;
}
function parseCsv(text) {
  const rows = []; let row = [], cell = "", quote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (quote && ch === '"' && next === '"') { cell += '"'; i++; continue; }
    if (ch === '"') { quote = !quote; continue; }
    if (!quote && ch === ",") { row.push(cell); cell = ""; continue; }
    if (!quote && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = ""; continue;
    }
    cell += ch;
  }
  row.push(cell); rows.push(row); return rows;
}
function parseDate(v) {
  const raw = String(v || "").trim();
  const s = raw.replace(/\./g, "-").replace(/\//g, "-").replace("T", " ");
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (m) {
    const [, y, mo, d, h = "0", mi = "0", sec = "0"] = m;
    return new Date(+y, +mo - 1, +d, +h, +mi, +sec);
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}
function toNumber(v) {
  const n = Number(String(v ?? "").trim().replace(/,/g, ""));
  return Number.isFinite(n) ? n : NaN;
}
function validBar(b) {
  return b && b.time instanceof Date && !Number.isNaN(b.time.getTime()) && [b.open, b.high, b.low, b.close].every(Number.isFinite);
}
function validFeatureBar(b) { return validBar(b) && Number.isFinite(b.rsi) && Number.isFinite(b.recent3); }
function dedupeAndSortBars(data) {
  const map = new Map();
  for (const b of data) map.set(b.time.getTime(), b);
  return [...map.values()].sort((a, b) => a.time - b.time);
}
function isJstRange(date, startHour, endHour) {
  const h = date.getHours();
  if (startHour < endHour) return h >= startHour && h < endHour;
  return h >= startHour || h < endHour;
}
