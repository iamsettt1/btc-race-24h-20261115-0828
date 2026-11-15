// BTC dip-buyer for make.fun btc-race-24h-20261115-0828.
// Protocol: agent-fun/bars-replay/v1. The harness sends hello once, then one
// batch per 1-minute bar, then done. This bot answers every batch with exactly
// one reply echoing its seq, carrying zero or one order.
//
// Strategy: mean-reversion dip-buying on 1-minute CBBTC closes.
//  - Flat: buy when the close is far below its SMA-60, RSI(14) is oversold,
//    and the bar ticked up off the low (bounce confirmation).
//  - Long: sell the whole position on take-profit, stop-loss, a 180-bar time
//    stop, a close back above SMA-20, or a trailing exit off the peak.
// All money math is BigInt. No clock, no randomness, no environment reads:
// fully deterministic, so the two graded runs produce identical action logs.

import { runBars } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const BPS = 10000n;
const MIN_NOTIONAL = 1000000n; // 1 USDC in quote units
const MAX_SLIPPAGE_BPS = 150;

// Tunable parameters (v1 defaults).
const DIP_BPS = 90n; // entry: close >= 0.9% below SMA-60
const RSI_ENTRY = 3500n; // entry: RSI(14) < 35 (scaled x100)
const BOUNCE_BPS = 30n; // bounce: close >= 0.3% above the 30-bar low
const SIZE_BPS = 5000n; // buy 50% of equity
const TP_BPS = 80n; // take-profit +0.8% above entry
const SL_BPS = 120n; // stop-loss -1.2% below entry
const TIME_STOP_BARS = 180;
const TRAIL_ARM_BPS = 50n; // trailing arms once up >= 0.5%
const TRAIL_DROP_BPS = 40n; // trailing exit: close 0.4% below peak

const closes: bigint[] = [];
let entryPrice: bigint | null = null;
let entrySeq = -1;
let peakSinceEntry: bigint | null = null;
let buyCount = 0;
let sellCount = 0;

function sma(period: number): bigint | null {
  if (closes.length < period) return null;
  let sum = 0n;
  for (let i = closes.length - period; i < closes.length; i++) sum += closes[i]!;
  return sum / BigInt(period);
}

function lowOf(period: number): bigint | null {
  if (closes.length < period) return null;
  let low = closes[closes.length - 1]!;
  for (let i = closes.length - period; i < closes.length; i++) {
    if (closes[i]! < low) low = closes[i]!;
  }
  return low;
}

// RSI(14) scaled by 100 (3500 == 35.0), from the last 14 one-bar changes.
function rsi14(): bigint | null {
  if (closes.length < 15) return null;
  let gain = 0n;
  let loss = 0n;
  for (let i = closes.length - 14; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0n) gain += d;
    else loss -= d;
  }
  const total = gain + loss;
  if (total === 0n) return 5000n;
  return (gain * 10000n) / total;
}

await runBars({
  onBatch(state, batch) {
    // Learn entry prices from fills first: a buy decided on batch t fills at
    // the next bar's open, and this batch reports it.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        entryPrice = BigInt(fill.price);
        entrySeq = state.seq;
        peakSinceEntry = entryPrice;
      } else if (fill.side === 'sell') {
        entryPrice = null;
        peakSinceEntry = null;
      }
    }

    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    const prevClose = closes.length > 0 ? closes[closes.length - 1]! : null;
    closes.push(close);

    const held = state.positions.get(SYMBOL);
    const qty = held?.qty ?? 0n;

    // While long, track the highest close since entry for the trailing exit.
    if (qty > 0n && entryPrice !== null) {
      if (peakSinceEntry === null || close > peakSinceEntry) peakSinceEntry = close;
    }

    if (state.warmingUp) return [];

    // ---- EXIT: sell the entire position when any exit fires. ----
    if (qty > 0n && entryPrice !== null) {
      const sma20 = sma(20);
      const barsHeld = state.seq - entrySeq;
      const tp = (entryPrice * (BPS + TP_BPS)) / BPS;
      const sl = (entryPrice * (BPS - SL_BPS)) / BPS;
      let exit = false;
      if (close >= tp) exit = true; // take-profit
      else if (close <= sl) exit = true; // stop-loss
      else if (barsHeld >= TIME_STOP_BARS) exit = true; // time stop
      else if (sma20 !== null && close > sma20) exit = true; // back above SMA-20
      else if (
        peakSinceEntry !== null &&
        peakSinceEntry >= (entryPrice * (BPS + TRAIL_ARM_BPS)) / BPS &&
        close <= (peakSinceEntry * (BPS - TRAIL_DROP_BPS)) / BPS
      ) {
        exit = true; // trailing exit off the peak
      }
      if (exit) {
        sellCount++;
        return [
          {
            side: 'sell',
            symbol: SYMBOL,
            qty,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
            client_id: `s${sellCount}`,
          },
        ];
      }
      return [];
    }

    // ---- ENTRY: only when flat. ----
    if (qty === 0n) {
      const sma60 = sma(60);
      const rsi = rsi14();
      const low30 = lowOf(30);
      if (sma60 === null || rsi === null || low30 === null || prevClose === null) return [];
      const dipped = close * BPS <= sma60 * (BPS - DIP_BPS);
      const oversold = rsi < RSI_ENTRY;
      const tickedUp = close > prevClose;
      const aboveLow = close * BPS >= low30 * (BPS + BOUNCE_BPS);
      if (dipped && oversold && (tickedUp || aboveLow)) {
        let notional = (state.equity * SIZE_BPS) / BPS;
        if (notional < MIN_NOTIONAL) notional = MIN_NOTIONAL;
        if (notional > state.cash) notional = state.cash;
        if (notional < MIN_NOTIONAL) return [];
        buyCount++;
        return [
          {
            side: 'buy',
            symbol: SYMBOL,
            notional_quote_units: notional,
            max_slippage_bps: MAX_SLIPPAGE_BPS,
            client_id: `b${buyCount}`,
          },
        ];
      }
    }
    return [];
  },
});
