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
const APP_ID = "350V848Kr6DwMKS6qzG73";   // <- your app id from api.deriv.com
```

That is the only place the app id is used (the WebSocket URL and the OAuth URL
are both built from it). The app id is configured. If you ever reset it to the
placeholder, the page falls back to Deriv's public app id `1089`, which gives you live market data but **not**
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

## Deploy on Vercel (dashboard, no build step)

The repository is already prepared for this. In the Vercel dashboard:

1. **Add New → Project** and import `Novaforge666/the-last`.
2. Framework preset: **Other**. Build command: *(empty)*. Output directory: *(empty, defaults to the repo root)*.
   Vercel has no `index.html` on `main` yet, so point **Settings → Git → Production Branch**
   at `arena/2279a8ca-the-last` (or merge that branch into `main`) — otherwise the
   project deploys a 404.
3. Deploy. Vercel serves `index.html` from the root; you get a
   `https://<project>.vercel.app` URL and **no custom domain is required**.
4. Optional CLI flow: `npx vercel deploy --prod` from this folder (it will also
   detect a static site with no build command).

Several repository layouts were tried through the Vercel API during setup; the
first deployment of the `the-last` project still has to be created with the
settings above, because the API refuses a first deployment that has no
`projectSettings` block.

## Known limits

- **Live data works with any app id**; login and trading do not. Until you set
  your own id, the header shows a banner saying exactly that.
- Login uses the OAuth redirect `https://oauth.deriv.com/oauth2/authorize?app_id=…`;
  Deriv appends `token1` / `acct1` to the redirect URL, which the page reads,
  strips from the address bar and exchanges for an `authorize` call. The token
  is kept in `sessionStorage` only.
- Contract digit barriers use the Volatility indices' last digit of the quoted
  price, exactly as Deriv reports it.
- `ticks_history` and `profit_table` are rate limited; the market scan batches
  five markets per request and the trades table pages 25 rows at a time.

## Theme

The UI follows the THE VERT house style: near-black blueprint canvas with a
faint 44 px grid, 1 px hairline frames, square corners, zero drop shadows,
IBM Plex Mono throughout, uppercase micro-labels with wide tracking, and a
single safety-orange accent (`#FF5A1F`) for live state, calls to action and
the highlighted last digit. A micro-label readout strip under the tabs shows
connection, market, last quote, last digit, account and balance.
