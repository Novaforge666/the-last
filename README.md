# TickForge — Deriv Volatility Terminal

A zero-build trading terminal for Deriv volatility indices. The whole UI lives
in **`index.html`** (HTML + CSS + vanilla JS inline): no frameworks, no
bundler, no mock data. The only server-side code is two small Vercel Functions:
`api/deriv-oauth-token.js` (the OAuth 2.0 code → token exchange Deriv requires a
backend to do) and `api/deriv-rest.js` (a narrow same-origin relay used only
when the browser cannot read Deriv's REST responses because of CORS).

Market data, quotes, proposals, balances and trades come from Deriv's official
Options API:

| Purpose | Endpoint |
| --- | --- |
| Guest market data | `wss://api.derivws.com/trading/v1/options/ws/public` |
| Authenticated trading | `wss://api.derivws.com/trading/v1/options/ws/demo\|real?otp=…` (single-use OTP) |
| REST (accounts, OTP) | `https://api.derivws.com/trading/v1/options/…` |
| OAuth authorize | `https://auth.deriv.com/oauth2/auth` |
| OAuth token exchange | `https://auth.deriv.com/oauth2/token` (server-side only) |

## What's inside

| Tab | Contents |
| --- | --- |
| **Manual Trade** | Live tick with a highlighted last digit, canvas line chart, last-digit strip, contract ticket (Over / Under / Even / Odd / Matches / Differs / Rise / Fall), live payout preview from `proposal`, Buy via `buy`, open-contract panel (`proposal_open_contract`) and recent trades (`profit_table`). |
| **Auto Bots** | Four strategies — digit streak, digit frequency threshold, even/odd imbalance, martingale recovery. Settings for market, contract, stake, take profit, stop loss, max consecutive losses, cooldown and execution mode. **Continuous** (default): once an entry point is found the bot stays armed and trades the same contract back and forth on every tick interval with no cooldown, until take profit / stop loss / max losses stops it. **Signal only** keeps the old behaviour — re-arm and wait for the next entry point after every trade. Live log, session P/L and win rate. Demo by default; a real account needs an explicit confirmation. |
| **Free bots** | The terminal's own bots as a gallery, with mythological names matched to their function: Pythia (the bundled over-3 sample), Janus (Over/Under), Hecate (Even/Odd), Orpheus (Digit Differs), Narcissus (Digit Matches), Icarus (Rise/Fall), Chronos (the zero-analysis direct-execution bot) and Tabula Rasa (a blank workspace). Opening a card loads that bot into the **DBots** tab — nothing trades until you press Run there. |
| **DBots** | Editing and parameters only: the block canvas, the **My bots** library (drag and drop, file picker, or the bundled sample), and the Run settings (stake, take profit, stop loss, cooldown). Each bot is parsed into its trade definition (market, contract, barrier, duration), variables, before / during / after purchase stacks and full block tree, then stored in `localStorage`. The runner executes the supported block subset on every live tick, buys through `proposal` + `buy`, watches the contract, applies take profit / stop loss and logs everything. The **Execution speed** switch is real: **FAST** is continuous execution — every tick interval is an entry with no cooldown gap; **NORMAL** applies the configured cooldown. Unsupported blocks are listed and **block the run** rather than being emulated. Export downloads the XML again. |
| **Analysis** | Last 1000 ticks loaded with `ticks_history` and kept live, digit distribution bars with a 25/50/100/500/1000 window switch, even/odd ratio, Over/Under probability table for every barrier, Matches/Differs probability table for every digit (plus the rate at which the newest digit repeats the previous one), colour-coded last-digit strip, hot/cold digits and streaks. |
| **Entry Points** | Two sub-tabs in one panel — only the open family's cards are shown. **Over / Under**: six signal cards (Over 2, Over 3, Over 4, Under 7, Under 6, Under 5). **Matches / Differs**: twenty cards (Matches 0–9, Differs 0–9) with the same hit rate, trend arrow, strength rating and Entry now / Wait badge, driven by adjustable rules (recent streak ending, hot/cold digit zone — a hot digit triggers Matches, a cold digit triggers Differs). “Trade this” pre-fills the manual ticket, “Quick” places a 1-tick trade, and a scan ranks all ten volatility markets by best signal of the open family, with an optional sound alert. |

Core plumbing: a WebSocket helper with `req_id` request/response matching,
auto-reconnect with backoff, a 30-second ping heartbeat, subscription restore
after a reconnect, **OAuth 2.0 login (Authorization Code + PKCE)**, an optional
**API-token login** (PAT → REST account discovery → single-use OTP WebSocket),
an account picker for logins with several Options accounts, REST calls that fall
back to a same-origin relay when CORS blocks the direct read, and a header with
account id, Demo/Real badge, live `balance` subscription and logout.

## 1. Register the application

Everything is driven by one constant at the top of the `<script>` block:

```js
const APP_ID = "350V848Kr6DwMKS6qzG73";   // <- client_id of the registered app
```

That app must be registered in the [Deriv developer dashboard](https://developers.deriv.com)
as an **OAuth 2.0 application** with:

- **Redirect URI:** `https://the-last-weld.vercel.app/` — byte-for-byte, including
  `https`, the host and the trailing slash. Deriv compares it exactly; a mismatch
  fails authorization with `redirect_uri` mismatch and the token exchange with
  `invalid_grant`.
- **Scope:** `trade`. The page requests `scope=trade` only. Asking for a scope the
  app does not have produces `invalid_scope`.
- **Client id:** the same value as `APP_ID`.

For the fallback **API token** button, create a PAT with the `trade` scope. PATs
must come from a PAT-type application; keep the app id and the token from the
same kind of application.

If `APP_ID` is left as the placeholder, the page still streams live ticks but
shows a banner and refuses to start login — there is no silent fallback to a
public app id.

## 2. How the OAuth login works

1. **Generate PKCE.** A random 64-byte `code_verifier` (base64url) and
   `code_challenge = BASE64URL(SHA256(verifier))`, plus a random `state`. The
   verifier and state are kept in `sessionStorage` for this tab only.
2. **Redirect** to
   `https://auth.deriv.com/oauth2/auth?response_type=code&client_id=…&redirect_uri=…&scope=trade&state=…&code_challenge=…&code_challenge_method=S256`.
3. Deriv shows its own login/consent screens and returns to the registered
   redirect URI with `?code=…&state=…` (or `?error=…&error_description=…`).
4. **Verify `state`** against the stored value. A mismatch aborts the login.
   `code`, `state` and any error parameters are then stripped from the address
   bar with `history.replaceState`, so a refresh cannot replay the code.
5. **Exchange the code** with a same-origin `POST /api/deriv-oauth-token`. The
   Function validates the body (code length, PKCE verifier shape, client id,
   redirect-URI allowlist) and forwards a form-encoded request to
   `https://auth.deriv.com/oauth2/token`. It stores and logs nothing.
6. **Pick an account.** The access token is used as a Bearer token against
   `GET https://api.derivws.com/trading/v1/options/accounts`. The page restores
   the account used before, otherwise prefers a demo account, otherwise uses the
   only account, otherwise opens the account picker. A real account always needs
   an explicit confirmation.
7. **Connect the trading socket.** `POST …/accounts/{id}/otp` returns a
   single-use WebSocket URL. That socket is already authenticated, so the page
   never sends an `authorize` message. OTP URLs expire, so every reconnect mints
   a fresh one through the stored token.

REST calls (`GET /accounts`, `POST /otp`) go to `https://api.derivws.com`
directly. If the browser cannot read that response (a CORS preflight rejection
surfaces as a plain network error in `fetch`), the same call is retried once
through `POST /api/deriv-rest`. That relay accepts only those two Options paths,
forwards the caller's Bearer token (and `Deriv-App-ID` for PATs) verbatim,
stores and logs nothing, and returns Deriv's status and body unchanged.

Properties:

- Tokens live in `sessionStorage` only. Closing the tab forgets them.
- OAuth Bearer tokens are sent **without** a `Deriv-App-ID` header; PAT requests
  include it.
- **No refresh token.** Deriv does not issue them to third-party apps. When
  `expires_in` elapses (or any REST call returns `401`), the page clears the
  session and asks the user to log in again — which reruns the PKCE flow.

## 3. API-token login (removed)

**This section no longer describes working UI.** Login is OAuth-only: the
"API token" button, paste field and account finder were removed, so there is no
way to sign in with a PAT from the page. The PAT helpers
(`PAT_TOKEN_KEY`, `isPat()`, `getStoredPatToken()`) and the `authKind === "pat"`
branch in `api/deriv-rest.js` still exist but are unreachable from the UI.

The original instructions are kept below only as reference for anyone who wants
to restore the feature.

### Original API-token flow (not currently reachable)

1. Create a PAT with the `trade` scope in the developer dashboard.
2. Click **API token** (top right), paste it, press **Find accounts**.
3. Pick an account. Demo connects immediately; real asks first.
4. The token is kept in `sessionStorage` for this tab and sent only to Deriv. It
   is never written to the repository, the page source, analytics or logs.

Under the hood this is `GET /trading/v1/options/accounts` with
`Authorization: Bearer …` + `Deriv-App-ID: …`, then `POST …/{account_id}/otp`,
then the returned `wss://…/ws/demo|real?otp=…` URL.

## 3a. Building a bot without XML

The DBots rail has a **＋ Build bot** button that opens a four-step builder
(Trade parameters · Purchase conditions · Trade options · Sell & restart).
It does not invent a new file format: it loads the bundled template, rewrites
the fields you chose into that XML, and imports the result through the same
`add()` path as a pasted file. So anything you build is a real, inspectable,
exportable DBot file, and it inherits the same block-subset limits.

The **Run panel** beside the canvas has three tabs — Summary, Transactions,
Journal — instead of stacked panels. Summary leads with six stat tiles (total
stake, total payout, runs, contracts lost, contracts won, total P/L) and a
**Reset stats** button that is disabled while a bot is running.

## 3b. DBots — running Deriv Bot `.xml` files

Deriv Bot saves a strategy as a Blockly XML file (`<xml is_dbot="true">` with
`trade_definition`, `before_purchase`, `during_purchase` and `after_purchase`
blocks). The **DBots** tab reads that format directly:

1. **Import** — drop the `.xml` on the drop zone, click it, or press
   *Load sample* to load `over3_1tick_bot.xml` (Over 3 on Volatility 100 (1s),
   1 tick, entry after three digits ≤ 3 in a row). The file is parsed in the
   browser and kept in `localStorage`; nothing is uploaded.
2. **Inspect** — the panel shows what was understood: market, contract,
   barrier, duration, every variable with its initial value, a warning list,
   and the full block tree. Anything the parser could not resolve is stated
   explicitly (for example a contract type it cannot trade).
3. **Run** — *Run settings* overrides Stake, Take profit, Stop loss and
   Cooldown; the file's own `Stake` / `TakeProfit` / `StopLoss` variables are
   used as defaults. On a **real** account a confirmation dialog is required
   first. The bot needs a login (OAuth or API token) but nothing else.
4. **Export** — *Download XML* saves the stored file back out unchanged.

### Supported block subset

| Area | Blocks |
| --- | --- |
| Trade definition | `trade_definition_market`, `trade_definition_tradetype`, `trade_definition_contracttype`, `trade_definition_tradeoptions` (duration, prediction/barrier, amount), restart-on-error |
| Before / after purchase | `variables_set`, `variables_get`, `math_change`, `controls_if` (including `elseif` / `else`), `controls_repeat_ext`, `controls_whileUntil`, `purchase`, `trade_again`, `notify`, `text_print` |
| Expressions | `math_number`, `math_constant`, `text`, `logic_boolean`, `last_digit`, `total_profit`, `math_arithmetic`, `math_single`, `math_modulo`, `math_round`, `logic_compare`, `logic_operation`, `logic_negate` |

Contracts map straight across: Digit Over / Under / Even / Odd / Matches /
Differs and Rise / Fall. The Over/Under digit is read from the `PREDICTION`
value (or the trade-option field, or a purchase-block field), including the
`<shadow>` blocks DBot writes there.

### Deliberate limits

- The runner is **not** a Blockly VM. A file that uses a block outside the
  table above is flagged in the warning list and the start button stays
  disabled — it will never trade on a guess.
- `controls_repeat_ext` and `controls_whileUntil` are capped (500 iterations,
  5 000 statements per evaluation) so a bad loop cannot hang the tab.
- Trading is driven by the ticks this tab already streams; the tab must stay
  open. Closing it stops the bot (no server-side copy runs).
- A DBot file describes a strategy, not a guarantee. Every file is shown with
  the same risk language as the rest of the terminal.
- `bots/over3_1tick_bot.xml` is the copy that ships with the page (it is also
  embedded in `index.html` for the zero-request first load).

## 3c. Landing page and the OAuth gate

`landing.html` is the public front door. `index.html` starts with a small
`<script>` gate:

| Visitor arrives at | What happens |
| --- | --- |
| `/` with no session | redirected to `/landing.html` |
| `/?app=1` | the terminal, gate skipped |
| `/?code=…` or `/?state=…` or `/?error=…` | the terminal — redirecting these would drop the OAuth code before it is exchanged |
| `/` with a session in the tab | the terminal |

**The rule to preserve:** landing CTAs point at **`/?app=1`**, never at `/`.
`location.pathname` is still exactly `/` there, so `currentRedirectUri()`
returns the registered `https://the-last-weld.vercel.app/` and the code exchange
keeps working. Auth that pointed at `/` would bounce a logged-out visitor
straight back to the landing page in a loop, and any other path would break the
redirect URI match. `?app=1` is deliberately kept in the address bar when the
callback params are stripped, so a refresh right after login does not eject the
user to the landing page mid-session.

`landing.html` is static: system-font stack plus inline SVG only, with one tiny
script that reveals a "Continue to the terminal" shortcut when a session already
exists. No CDN, no framework, nothing to build.

## 4. Deploy

The repository is deployed on Vercel with no build step:

- `index.html` is served from the repository root.
- `api/deriv-oauth-token.js` and `api/deriv-rest.js` are picked up automatically
  as Node.js Functions (plain `module.exports = handler(req, res)`, global
  `fetch`, no dependencies, no environment variables required).

To deploy your own copy:

1. Import the repository into Vercel (framework preset **Other**, empty build
   command, empty output directory).
2. Register the resulting `https://<project>.vercel.app/` URL as the OAuth
   redirect URI and update `APP_ID` if you use a different client id.
3. Push. Vercel redeploys `main` automatically.

Any static host can serve the guest view, but OAuth login needs an equivalent
same-origin POST endpoint that forwards the exchange to
`https://auth.deriv.com/oauth2/token` (and, for browsers that block Deriv's
CORS, a relay equivalent to `api/deriv-rest.js`). A purely static host has
nowhere to keep the token exchange off the browser, so the **API token** path is
the fallback there.

The repository is deployed at **<https://the-last-weld.vercel.app>**, with the
domain `the-last-weld.vercel.app` attached to the project.

For local development, `vercel dev` serves both the page and the Function at
`http://localhost:3000/`. The Function's redirect-URI allowlist accepts
`http://localhost` and `https://*.vercel.app` only.

## Risk warning

Deriv volatility indices are synthetic products. Trading them carries a high
risk of losing money rapidly. Signals, hit rates and bots on this site describe
past ticks only and **do not guarantee profit**. This is an independent
third-party client, not affiliated with or endorsed by Deriv.

Deriv Bot `.xml` files imported on the DBots tab are third-party strategies.
The importer shows exactly which blocks it understood and refuses to start a
bot that uses blocks it cannot execute; that is a safety limit, not an
endorsement of the strategy.

## Fixed defects worth remembering

- **DBots never traded.** Two independent bugs, both silent:
  1. `DBots.runtime()` called `lastDigit(t.quote, sym)` but `sym` was never
     declared or passed — every evaluation threw `ReferenceError`. Because
     `Markets.push()` wraps listeners in `try/catch` to protect the feed, the
     failure produced no message at all: the bot logged "Streaming…", showed as
     running, and never traded.
  2. `DBots.start()` shadowed the global `money()` formatter with
     `const money = this.moneyFor(...)` and then called `money(stake)` a few
     lines later. The `TypeError` was thrown from `begin()` **after**
     `this.running = true`, so the bot reported itself as running while never
     subscribing to ticks.
  Both are fixed, the local is now `mm`, and a runner-level failure in the tick
  handler is reported and stops the bot instead of vanishing.
- **Digit percentages did not match Deriv.** Deriv measures each digit over the
  last **1000** ticks (its published shares are always exact multiples of 0.1%
  and sum to ~100). The ticket defaulted to a **100**-tick window, so it could
  only ever produce 1%-granularity values. The default window is now 1000, and
  shares use largest-remainder rounding so the ten digits always sum to exactly
  100.0 instead of drifting to 99.8 or 100.3.

## Known limits

- **No token refresh.** Re-login is required when the access token expires or a
  request returns `401`. Deriv does not offer refresh tokens to third-party apps.
- **Exact redirect URI.** Trailing slash, scheme and host must match the
  dashboard entry. Preview deployments on other `*.vercel.app` hosts will pass
  the Function's allowlist but still be rejected by Deriv unless that URL is
  registered too.
- **One account at a time.** Switching accounts restarts the socket with a fresh
  OTP; open contracts stay on Deriv and reappear in the trades table.
- **Rate limits.** `ticks_history` and `profit_table` are throttled by Deriv; the
  market scan batches five markets per request and the trades table pages 25 rows
  at a time.
- **Never paste a token into chat or a commit.** If a token was shared anywhere
  outside Deriv, revoke and rotate it in the dashboard.
- **Login is real, not simulated.** If Deriv rejects the app (`invalid_client`,
  redirect mismatch, `invalid_scope`), the banner shows the provider's error text
  as-is.

## Theme

Two references are combined:

- **THE VERT** (the-vert-eight.vercel.app) supplies the identity — night-black
  surfaces (`#070707`), rounded cards, Syne display type, Inter body copy,
  JetBrains Mono for numbers, pill controls, and one hot yellow signal colour
  (`#facc15`) that is only ever used for live state and the primary action.
- **DBTraders** supplies the layout language of a trading product — a compact
  dark shell, a tab rail, a grid of bordered cards with soft elevation, a
  ticker/readout band, green/red market semantics (`#22c55e` / `#ef4444`), and
  pill-shaped status chips.

Concretely: the header brand is Syne `TICK*FORGE*` with a yellow rounded tile;
tabs are a segmented pill rail with the active tab filled yellow; every panel
is a 16 px rounded card with a subtle inner highlight; panel titles are Syne
with a glowing yellow tick; market numbers, balances and tables use JetBrains
Mono with tabular figures; the price chart is emerald when rising and red when
falling; form controls are rounded with a yellow focus ring. A readout pill row
under the tabs shows connection, market, last quote, last digit, account and
balance.
