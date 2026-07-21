# TradeCore Pro — User Guide

A plain-language tour of what each part of the app does and how to read it.
This is for someone *using* the running dashboard. To deploy the app, see
[`HANDOFF.md`](./HANDOFF.md); for an evaluator's overview, see
[`PRODUCT_OVERVIEW.md`](./PRODUCT_OVERVIEW.md).

New to it? Click **"Explore the live demo — no signup"** on the login page to
walk through a fully-populated, read-only account first.

---

## Getting started (with your own account)

1. **Create an account** — username + password (or Google/Apple if the
   operator enabled them).
2. **Connect a broker** in **Account & Safety**:
   - *Crypto* → Binance API key + secret. Use **testnet** keys
     (`testnet.binance.vision`) to paper-trade first, with no real funds.
   - *Forex* → an OANDA API token + account id. Start on an OANDA **practice**
     account.
   Keys are encrypted at rest and never leave your server.
3. **Pick your market** at the top-left switcher: **Crypto** or **Forex**.
   The two are completely independent — separate settings, positions, and
   history. Only one engine runs at a time.
4. **Set your risk** (see *Risk settings* below), then press **START** on the
   Cockpit.

## The Cockpit (dashboard)

Your live control panel: engine on/off, account balance, today's P&L, win
rate, and **open positions** with their live entry/stop/target levels and
unrealized P&L. Below that, live views show what the engine is seeing right
now — the market monitor, the current decision pipeline, and the scanner.

For **forex**, a banner shows whether the market is **open or closed** (forex
doesn't trade weekends), with the next open/close time — so a quiet engine on
a Sunday reads as "market closed," not "broken."

## Strategies

Each market has its own catalog of strategies. For every strategy you can see
what indicators it reads and set its **dollar plan**: *Trade Amount* (the
position notional), *Max Loss* (the most you'll lose if the stop hits), and
*Target Profit*. You can enable/disable each one. The engine only lets a
strategy act in the market **regime** it's designed for.

## Build your own strategy (Strategy Builder)

The **Builder** page lets you create your own strategies without writing any
code. You compose entry rules from the indicators the engine already computes
every scan — RSI, ADX, volume, market regime, MACD, time of day, distance
from recent highs/lows, and more:

1. **Add conditions** to the long and/or short side. Each side is an AND
   list — *every* condition must hold for that side to propose a trade
   (e.g. *long when RSI < 32 AND regime is range AND volume > 1.2×*).
2. **Pick a stop mode**: an ATR multiple (volatility-scaled), a fixed %, or
   a swing level (the lowest low / highest high of recent 15-minute bars —
   "the price that proves the idea wrong").
3. **Save.** The strategy appears on the Strategies page next to the
   built-ins, where you give it a dollar plan like any other strategy.

Two safety properties are built in:

- **Backtest first.** A new (or edited) custom strategy cannot be enabled
  for live trading until a backtest of its current rules has completed —
  use the *Backtest now* shortcut on its card. Editing the rules re-arms
  this gate, because a changed strategy is an untested strategy.
- **Same risk pipeline.** Custom strategies run through exactly the same
  engine machinery as the built-ins — dollar-risk sizing, cost gates, the
  reward:risk floor, the circuit breaker, and the Decisions journal (each
  of your conditions appears in the decision report with its observed
  value). A custom strategy can never bypass a risk control; the worst a
  bad rule set can do is lose its configured Max Loss per trade.

Up to 10 custom strategies per market section. The builder covers
threshold-style rules; developers who want logic beyond that (multi-bar
patterns, cross-indicator math) can implement the engine's TypeScript
`Strategy` interface directly — see the white paper.

## Decisions feed

The engine's "why I traded / why I passed" journal. Every setup it genuinely
considered appears here as one of:

- **Executed** — a trade was opened (links to the trade).
- **Rejected** — it considered a trade and declined, with the exact reason and
  stage (e.g. *"net reward:risk below the floor after costs,"* *"target
  unreachable within the hold window,"* *"chasing an extended breakout"*).

This is the fastest way to understand *why the engine is or isn't trading* — a
wall of "no qualifying signal" is normal; a repeated Order-stage rejection
means the exchange refused something and is worth investigating.

## Analytics

- **Edge Forensics** (top card): the honest breakdown of where your results
  come from. Key ideas:
  - **Adjusted win rate** excludes *scratches* — break-even exits (the stop
    moved to entry after taking partial profit) and washes. A raw win rate can
    look terrible while the account is really just scratching a lot; the
    adjusted number is the truthful one.
  - **Verdicts** name the biggest leaks in dollars: scratch miscounts,
    fast "noise" stop-outs (stops sitting inside normal candle wiggle), fee
    drag, and negative strategy/symbol/hour cells.
  - **Stop-vs-noise audit** flags any strategy×symbol whose stop is tighter
    than the instrument's current volatility — a classic cause of pathological
    win rates. (Needs the engine running for live volatility.)
  Use it to decide what to fix: widen a too-tight stop, retune a bleeding
  strategy, or stop trading a losing hour.
- **Hourly heatmap**, **daily report** (with CSV export), and headline
  metrics round out the page.

## Backtesting Lab

Replay history through the **same** engine that trades live — same signals,
sizing, and costs — so results mean what they say. Pick strategies, symbols, a
date range, and a risk plan, then run. Crypto uses Binance public data; forex
downloads OANDA candles with your connected account.

**Optimization Autopsy** (the panel at the top of the Lab, also reachable from
a strategy's "Diagnose" button) answers *"what's wrong with MY settings?"* for
one strategy. It sweeps that strategy's knobs on a training window and then
**validates the winner on a later window it never saw**. Verdicts:

- **Improved** — a better config beat your current one *out of sample*; the
  suggested changes are shown with the evidence.
- **No better** — your current config held up; nothing to change (a real,
  useful result).
- **Not enough trades** — widen the date range or symbols and re-run.

Only apply changes the Autopsy validated out-of-sample — that's what keeps it a
diagnosis rather than curve-fitting to noise.

## Risk settings (Account & Safety)

- **Risk model** — *dollar* (recommended): state Max Loss and Target Profit
  per trade; the engine derives everything else. *Percent* is the legacy
  price-percentage mode.
- **Daily loss limit** — a circuit breaker; once hit, no new entries open for
  the rest of the day (open positions are still managed).
- **Max open positions / portfolio risk** — caps on concurrent exposure.
- **Leverage & margin** (futures only) — the engine never exceeds your cap and
  refuses a trade whose stop sits inside the liquidation distance.
- **Alerts** — an optional Discord/Slack/Telegram webhook for risk events.

## Memory Core

The engine's long-term memory: every closed trade is automatically analyzed,
graded (A–F on entry conviction, exit quality, risk adherence, and cost drag),
and explained — plus a blacklist of symbols that have been performing poorly.

## A note on expectations

TradeCore Pro automates *discipline* — consistent sizing, honest costs, logged
reasoning, and evidence-based diagnostics. It does **not** guarantee profit; no
strategy does. Start on testnet/practice, use Backtesting and the Autopsy to
build confidence, and scale risk up only once you've seen it behave.
