# Phase 12 — Connecting a Legitimate Live Market-Data Feed

This is the last item on the original roadmap, and it's a guide rather
than new app behavior: how to replace the synthetic sample / imported-file
replay with a real, legitimate, licensed data feed — **without ever
touching Quotex directly.**

## The hard boundary, restated

This has held since Phase 1 and doesn't change now:

- No logging into Quotex programmatically, no reading its session/auth
  tokens, no scraping its app or website, no reverse-engineering its
  private endpoints, no defeating its anti-bot protections.
- If Quotex doesn't offer an official, public API meant for third-party
  developers to consume (it doesn't, as of this writing, for this kind of
  use), that's a hard stop on using Quotex itself as a data source — not a
  problem to be engineered around.

What you *can* legitimately do: point this app's existing
`MarketDataProvider` interface at a licensed market-data vendor's own
public API, built for exactly this purpose. The candles you see in the
app from that point on represent *that vendor's* price feed, not
necessarily Quotex's own OTC quotes — Quotex's OTC pairs are its own
synthetic pricing even on the real platform, so no external vendor will
match them tick-for-tick. Treat a live feed as "real market data to
analyze," not "Quotex's exact prices."

## Picking a provider

A few well-established vendors offer real forex/market data via public
REST and/or WebSocket APIs with a free or low-cost tier suitable for a
personal project like this one. Specifics (free-tier limits, pricing,
exact endpoints) change over time, so verify current terms on each
provider's own site before committing — don't take the numbers below as
permanent:

| Provider | What it offers | Good for |
|---|---|---|
| [Twelve Data](https://twelvedata.com) | REST + WebSocket, forex/stocks/crypto, a metered free tier | Real-time streaming via WebSocket |
| [Polygon.io](https://polygon.io) | REST + WebSocket, forex included, free tier with real-time data for major pairs | Real-time streaming via WebSocket |
| [Alpha Vantage](https://www.alphavantage.co) | REST only, FX rates + historical, free API key | Simple polling, no WebSocket needed |
| [Finnhub](https://finnhub.io) | REST + WebSocket, broad market coverage, free tier | Alternative if the above don't fit |
| [OANDA](https://developer.oanda.com) | REST + streaming API, requires an OANDA account (a free practice/demo account qualifies) | If you want an actual broker-grade forex feed |

Whichever you pick, read its **Terms of Service** before wiring it in —
specifically: is personal/non-commercial use of the API permitted, are
there restrictions on displaying or redistributing the data, and what
attribution (if any) is required. This app already shows the active
dataset's label in the UI (`Synthetic sample`, your filename, etc.) — if
you connect a live feed, update that label to name the provider, so
anyone looking at the app (including future-you) knows exactly where the
numbers came from.

## The one hard problem: API keys in a client-only app

Every provider above authenticates requests with an API key. This app is
a static site with no server — which means **any API key embedded in its
JavaScript is visible to anyone who opens DevTools** on your published
GitHub Pages site, key included. For a `public` GitHub repo (what we've
used throughout this build, since GitHub Pages on the free tier needs a
public repo to serve to the open internet), that's effectively anyone on
the internet, not just you.

Three honest options, in order of effort:

1. **Accept the exposure, mitigate it.** Use a free-tier key from a
   provider where a leaked free-tier key is low-stakes (can't rack up
   charges, rate-limited enough that abuse is self-limiting), and either
   keep the GitHub repo private (note: whether a private repo's GitHub
   Pages site is still reachable by a visitor without a GitHub login
   depends on your current GitHub plan — check your account's Pages
   settings, this has changed over the years) or accept that the key may
   get scraped and occasionally hit its rate limit from unrelated traffic.
   Simplest to set up; weakest protection.
2. **Restrict the key at the provider**, if they support it — some
   providers let you lock a key to specific HTTP referrer domains (so it
   only works when called from `yourname.github.io`). This doesn't hide
   the key, but it does stop it from being usable from a random script
   elsewhere. Check whether your chosen provider offers this.
3. **Put a tiny proxy in front of it** (the actually-correct answer): a
   small serverless function (Cloudflare Workers' free tier is a common
   choice, and deployable from Termux — `npm install -g wrangler` works
   there) that holds the real API key as a server-side secret, and the PWA
   calls *your* proxy URL instead of the vendor's directly. The key never
   ships to the browser. This is genuinely more setup — a second small
   project — but it's the only option that actually keeps the key private.

For a personal, single-device tool like this one, option 1 or 2 is
usually proportionate. If you ever plan to share the app's link with
other people, move to option 3.

## The provider contract (unchanged)

Every provider implementation — live or otherwise — fulfills the exact
same interface `MarketDataProvider` has defined since Phase 1:

```js
export class MarketDataProvider {
  async getCandles(asset, timeframe, count) { /* ... */ }
  async getLatestPrice(asset) { /* ... */ }
  subscribeToRealtimeData(asset, timeframe, onData) { /* returns an unsubscribe function */ }
  async getMarketStatus(asset) { /* ... */ }
}
```

`js/core/LiveDataProvider.js` in this guide's attached files is a working
template that implements this contract generically — REST for historical
candles, WebSocket for streaming, normalized through the existing
`CandleNormalizer` before anything downstream (indicators, structure,
scoring) ever sees it, exactly like `ReplayDataProvider` and
`MockDataProvider` already do. It has clearly marked `TODO` sections for
your chosen provider's actual endpoint URLs, auth header/param, and
message format — those three things are the only parts that differ
between vendors; everything else (reconnect/backoff, normalization,
candle-close detection) is written generically.

## Wiring it into the app

In `js/worker/engine.worker.js`, the provider is constructed in one place:

```js
let provider = new ReplayDataProvider(normalizeCandles(sampleCandles), { intervalMs: 2000, label: 'synthetic sample' });
```

To add a live option alongside the existing sample/import choices (not
instead of them — keeping replay available is good for testing without
burning API calls):

1. Add `LiveDataProvider.js` to `js/core/`.
2. Import it in `engine.worker.js`.
3. Add a third data-source control in the UI (next to "Synthetic sample"
   and "Import file") — e.g. "Live feed" — that posts a new message type,
   say `{ type: 'useLiveFeed', payload: { apiKey, asset } }`, which the
   worker handles by swapping `provider` to a new `LiveDataProvider`
   instance, the same way `loadCandles` already swaps in a
   `ReplayDataProvider`.
4. Everything downstream — `RealtimeEngine`, `ScoringEngine`, alerts,
   history logging, backtesting, the ML experiment — needs **no changes
   at all**. That's the entire point of having built behind the
   `MarketDataProvider` interface from Phase 1 onward: the data source was
   always meant to be swappable without touching analysis code.

## Before you flip it on, a few real-world things that change

- **Market hours.** Forex markets close on weekends; `getMarketStatus()`
  needs to actually reflect this for a live feed (the replay provider's
  ACTIVE/CLOSED only ever meant "is there more replay data left," not
  "is the market open right now" — a live provider's CLOSED should mean
  the latter).
- **Rate limits.** A free tier might allow far fewer requests than this
  app's current 2-second replay cadence assumes. You may need a longer
  poll interval for REST-only providers, or lean on WebSocket providers
  specifically to avoid this.
- **Gaps and reconnects.** A real network connection drops sometimes. The
  template below includes basic reconnect-with-backoff for the WebSocket
  path; REST polling is naturally resilient (just retries next interval).
- **The 1-minute noise problem doesn't go away.** Real 1-minute price
  data is exactly as noisy as the project's very first message warned —
  connecting a real feed doesn't make the rule-based signal any more
  predictive than it was on synthetic data. Phase 9's backtester and
  Phase 10's dashboard are there specifically so you can check that
  against real data before trusting anything the SIGNAL says.
