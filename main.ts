// Forecast for gta6-trophy-rarity-forecast-01 (Node 22, standard library only): for every trophy of
// Grand Theft Auto VI on PlayStation 5, five quantiles of its earn rate on Exophase at the case's
// target, from the reads in the case file alone. Offline, deterministic, no network.
//
// Model, per trophy, in logit space (logit(p) = ln(p / (100 - p)), p clamped to 0.01..99.99):
//   - Two trends, both weighted toward recent reads (24h half-life): a log-time trend of the logit
//     rate against ln(1 + hours since 2026-11-19T00:00:00Z), and a players trend of the logit rate
//     against ln(players tracked), read at a forecast player count at the target (players fit by
//     ln(players) vs log-time, extrapolated, capped at 20x the last count, floored at the last
//     count). The two trend predictions are averaged in logit space.
//   - Shrinkage: the median moves only 70% of the way from the last rate's logit toward the trend,
//     and never more than 2.5 logit units, so a flat history forecasts the last rate and a far
//     extrapolation cannot run away.
//   - Spread: a random walk (0.5 logit units per square-root day) plus a term for how far the
//     median moved plus the log-time fit's residual variance (floored 0.05, capped 1.0).
//   - q_tau = 100 / (1 + exp(-(median_logit + z_tau * sigma))), z = [-1.645, -0.674, 0, 0.674,
//     1.645], rounded to 4 decimals, clamped to 0.01..99.99, forced non-decreasing.
// Edge cases: a trophy with no usable rate falls back to its last non-null rate, or 0.5% if none;
// an empty history falls back to a 1% median with the random-walk spread; a 100% trophy stays
// near 100% through the clamp.
//
// Local run (the grader's container uses /input and /output instead of these two variables):
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** The random-walk spread, in logit units per square-root day. */
const SIGMA0 = 0.5;
/** Log-time is measured from launch, 2026-11-19T00:00:00Z. */
const T0 = Date.parse('2026-11-19T00:00:00Z');
/** How far the median moves from the last rate toward the trend prediction. */
const SHRINK = 0.7;
/** The median's move from the last rate's logit is capped at this many logit units. */
const MAX_MOVE = 2.5;
/** Reads lose half their weight every 24 hours. */
const HALF_LIFE_HOURS = 24;
/** The forecast player count is capped at this multiple of the last observed count. */
const MAX_PLAYERS_MULT = 20;
/** Floor / cap for the per-trophy residual variance of the log-time fit. */
const RESID_VAR_MIN = 0.05;
const RESID_VAR_MAX = 1.0;

interface Trophy {
  id: number;
}

interface Read {
  at: string;
  players_tracked: number;
  rates: Array<number | null>;
}

interface Case {
  levels: number[];
  horizon_minutes: number;
  target: string;
  trophies: Trophy[];
  history: Read[];
}

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const invLogitPct = (l: number): number => 100 / (1 + Math.exp(-l));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
/** ln(1 + hours since launch) for a timestamp, guarded so the argument stays positive. */
const logTime = (ms: number): number => Math.log(Math.max(1 + (ms - T0) / 3600000, 1e-3));

/** Weighted least squares for y ~ intercept + slope * x. Degenerate input gives slope 0. */
function wls(xs: number[], ys: number[], ws: number[]): { slope: number; intercept: number } {
  let sw = 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < xs.length; i++) {
    sw += ws[i];
    mx += ws[i] * xs[i];
    my += ws[i] * ys[i];
  }
  if (sw <= 0) return { slope: 0, intercept: 0 };
  mx /= sw;
  my /= sw;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxx += ws[i] * dx * dx;
    sxy += ws[i] * dx * dy;
  }
  const slope = sxx > 1e-12 ? sxy / sxx : 0;
  return { slope, intercept: my - slope * mx };
}

/** One case's forecast: one row per trophy, five quantiles each. */
function forecastCase(c: Case): { trophies: Array<{ id: number; q: number[] }> } {
  const horizonDays = c.horizon_minutes / 1440;
  const rw = SIGMA0 * Math.sqrt(horizonDays);
  const xTarget = logTime(Date.parse(c.target));
  const hist = c.history ?? [];
  const last = hist[hist.length - 1];

  // Time axis and recency weights, shared by every trophy.
  const xs: number[] = [];
  const ws: number[] = [];
  const lastMs = last !== undefined ? Date.parse(last.at) : Date.parse(c.target);
  for (const r of hist) {
    const t = Date.parse(r.at);
    xs.push(logTime(t));
    ws.push(Math.pow(0.5, Math.max(0, (lastMs - t) / 3600000) / HALF_LIFE_HOURS));
  }

  // Forecast the player count at the target: fit ln(players) on log-time, extrapolate, cap at
  // 20x the last count, floor at the last count (tracked players do not fall in a launch week).
  // Reads whose players_tracked is missing or not a positive number are skipped, so a bad
  // count cannot poison the fit; with no usable count the target stays at the last count.
  let lnPlayersTarget = 0;
  if (hist.length > 0 && last !== undefined) {
    const pXs: number[] = [];
    const pYs: number[] = [];
    const pWs: number[] = [];
    for (let j = 0; j < hist.length; j++) {
      const pl = hist[j].players_tracked;
      if (!Number.isFinite(pl) || pl <= 0) continue;
      pXs.push(xs[j]);
      pYs.push(Math.log(pl));
      pWs.push(ws[j]);
    }
    const lastPl = last.players_tracked;
    const lastPlayers = Number.isFinite(lastPl) && lastPl > 0 ? lastPl : 1;
    if (pXs.length > 0) {
      const fit = wls(pXs, pYs, pWs);
      let playersTarget = Math.exp(fit.intercept + fit.slope * xTarget);
      playersTarget = Math.min(Math.max(playersTarget, lastPlayers), MAX_PLAYERS_MULT * lastPlayers);
      lnPlayersTarget = Math.log(playersTarget);
    } else {
      lnPlayersTarget = Math.log(lastPlayers);
    }
  }

  const trophies = c.trophies.map((t, i) => {
    // The trophy's last usable rate: the newest non-null read, or 0.5% if none.
    let lastRate: number | null = null;
    for (let j = hist.length - 1; j >= 0; j--) {
      const r = hist[j].rates[i];
      if (r !== null && r !== undefined && Number.isFinite(r)) {
        lastRate = r;
        break;
      }
    }
    if (hist.length === 0 || lastRate === null) {
      // Empty history: 1% median. No usable rate: 0.5%. Random-walk spread only.
      const med = hist.length === 0 ? 1 : 0.5;
      const l = logit(med);
      const q = Z.map((z) => round4(clampPct(invLogitPct(l + z * rw)))).sort((a, b) => a - b);
      return { id: t.id, q };
    }
    const lastL = logit(lastRate);

    // Usable points for this trophy: log-time, logit rate, weight; and the players points
    // (ln players, logit rate, weight), which skip reads with an unusable players count.
    const px: number[] = [];
    const py: number[] = [];
    const pw: number[] = [];
    const qx: number[] = [];
    const qy: number[] = [];
    const qw: number[] = [];
    for (let j = 0; j < hist.length; j++) {
      const r = hist[j].rates[i];
      if (r === null || r === undefined || !Number.isFinite(r)) continue;
      px.push(xs[j]);
      py.push(logit(r));
      pw.push(ws[j]);
      const pl = hist[j].players_tracked;
      if (Number.isFinite(pl) && pl > 0) {
        qx.push(Math.log(pl));
        qy.push(logit(r));
        qw.push(ws[j]);
      }
    }

    // Trend: average of the log-time prediction and the players prediction, in logit space.
    // With one point or a flat history both fits return the (weighted) mean logit, so the
    // trend equals the last rate and the median stays put. With no usable players points the
    // players prediction falls back to the last rate.
    let trendL = lastL;
    let residVar = RESID_VAR_MIN;
    if (px.length >= 1) {
      const ft = wls(px, py, pw);
      const predTime = ft.intercept + ft.slope * xTarget;
      const fp = qx.length >= 1 ? wls(qx, qy, qw) : null;
      const predPlayers = fp !== null ? fp.intercept + fp.slope * lnPlayersTarget : lastL;
      trendL = (predTime + predPlayers) / 2;
      if (px.length >= 2) {
        let sw = 0;
        let s = 0;
        for (let k = 0; k < px.length; k++) {
          const res = py[k] - (ft.intercept + ft.slope * px[k]);
          s += pw[k] * res * res;
          sw += pw[k];
        }
        residVar = sw > 0 ? s / sw : 0;
        residVar = Math.min(RESID_VAR_MAX, Math.max(RESID_VAR_MIN, residVar));
      }
    }

    // Shrinkage toward the trend, with the move capped.
    let medL = lastL + SHRINK * (trendL - lastL);
    medL = lastL + Math.min(MAX_MOVE, Math.max(-MAX_MOVE, medL - lastL));

    const sigma = Math.sqrt(rw * rw + Math.pow(0.4 * Math.abs(medL - lastL), 2) + residVar);
    const q = Z.map((z) => round4(clampPct(invLogitPct(medL + z * sigma)))).sort((a, b) => a - b);
    return { id: t.id, q };
  });
  return { trophies };
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const out = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify(out)}\n`);
}
