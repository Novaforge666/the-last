# TickForge — Deriv Volatility Terminal

A single-file, zero-build trading terminal for Deriv volatility indices.
Everything lives in **`index.html`** (HTML + CSS + vanilla JS inline): no
frameworks, no bundler, no backend, no mock data. All quotes, proposals,
balances and trades come from the official Deriv WebSocket API at
`wss://ws.derivws.com/websockets/v3`.

## What's inside

| Tab | Contents |
| --- | --- |
| **Manual Trade** | Live tick with a highlighted last digit, canvas line chart, last-digit strip, contract ticket (Over / Under / Even / Odd / Matches / Differs / Rise / Fall), live payout preview from `proposal`, Buy via `buy`, open-contract panel (`proposal_open_contract`) and recent trades (`profit_table`). |
| **Auto Bots** | Four strategies — digit streak, digit frequency threshold, even/odd imbalance, martingale recovery. Settings for market, contract, stake, take profit, stop loss, max consecutive losses and cooldown. Live log, session P/L and win rate. Demo by default; a real account needs an explicit confirmation. |
| **Analysis** | Last 1000 ticks loaded with `ticks_history` and kept live, digit distribution bars with a 25/50/100/500/1000 window switch, even/odd ratio, Over/Under probability table for every barrier, colour-coded last-digit strip, hot/cold digits and streaks. |
| **Entry Points** | Six signal cards (Over 2, Over 3, Over 4, Under 7, Under 6, Under 5) with hit rate, trend arrow, strength rating and an Entry now / Wait badge, driven by adjustable rules (recent streak ending, cold digit zone). “Trade this” pre-fills the manual ticket, “Quick” places a 1-tick trade, and a scan ranks all ten volatility markets by best signal, with an optional sound alert. |

Core plumbing: a WebSocket helper with `req_id` request/response matching,
auto-reconnect with backoff, a 30-second ping heartbeat, subscription restore
after a reconnect, Deriv OAuth redirect login (`token1` / `acct1` from the URL
→ `authorize`), and a header with account id, Demo/Real badge, live `balance`
subscription and logout.

## 1. Register an App ID

1. Go to <https://api.deriv.com> and sign in.
2. Open **Dashboard → Applications** and create a new application.
3. Grant the trading scopes and add the URL where you host this file as an
   **OAuth redirect URL** (for example `https://your-site.vercel.app/`).
4. Copy the numeric **App ID**.

## 2. Set it in the file

Open `index.html`, find the clearly marked constant at the very top of the
`<script>` block and replace the placeholder:

```js
const APP_ID = "YOUR_APP_ID";   // <- your app id from api.deriv.com
```

That is the only place the app id is used (the WebSocket URL and the OAuth URL
are both built from it). While the placeholder is left unchanged the page falls
back to Deriv's public app id `1089`, which gives you live market data but **not**
OAuth login or trading — the header banner tells you so.

## 3. Host it

Any static host works, because there is nothing to build:

- **Vercel** – import this repository; framework preset “Other”, no build
  command, output directory `.` (this repository is deployed that way).
- **Netlify / Cloudflare Pages** – publish directory `.`, no build command.
- **GitHub Pages** – serve the default branch root.
- **Plain Apache/Nginx** – drop `index.html` in the web root.

The redirect URL you registered in step 1 must match the hosting URL exactly,
including `https` and the trailing path.

## Risk warning

Deriv volatility indices are synthetic products. Trading them carries a high
risk of losing money rapidly. Signals, hit rates and bots on this site describe
past ticks only and **do not guarantee profit**. This is an independent
third-party client, not affiliated with or endorsed by Deriv.
