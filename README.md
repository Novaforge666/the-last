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
| **Auto Bots** | Four strategies — digit streak, digit frequency threshold, even/odd imbalance, martingale recovery. Settings for market, contract, stake, take profit, stop loss, max consecutive losses and cooldown. Live log, session P/L and win rate. Demo by default; a real account needs an explicit confirmation. |
| **Analysis** | Last 1000 ticks loaded with `ticks_history` and kept live, digit distribution bars with a 25/50/100/500/1000 window switch, even/odd ratio, Over/Under probability table for every barrier, colour-coded last-digit strip, hot/cold digits and streaks. |
| **Entry Points** | Six signal cards (Over 2, Over 3, Over 4, Under 7, Under 6, Under 5) with hit rate, trend arrow, strength rating and an Entry now / Wait badge, driven by adjustable rules (recent streak ending, cold digit zone). “Trade this” pre-fills the manual ticket, “Quick” places a 1-tick trade, and a scan ranks all ten volatility markets by best signal, with an optional sound alert. |

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

## 3. Logging in with an API token (optional)

1. Create a PAT with the `trade` scope in the developer dashboard.
2. Click **API token** (top right), paste it, press **Find accounts**.
3. Pick an account. Demo connects immediately; real asks first.
4. The token is kept in `sessionStorage` for this tab and sent only to Deriv. It
   is never written to the repository, the page source, analytics or logs.

Under the hood this is `GET /trading/v1/options/accounts` with
`Authorization: Bearer …` + `Deriv-App-ID: …`, then `POST …/{account_id}/otp`,
then the returned `wss://…/ws/demo|real?otp=…` URL.

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

The UI follows the THE VERT house style: near-black blueprint canvas with a
faint 44 px grid, 1 px hairline frames, square corners, zero drop shadows,
IBM Plex Mono throughout, uppercase micro-labels with wide tracking, and a
single safety-orange accent (`#FF5A1F`) for live state, calls to action and
the highlighted last digit. A micro-label readout strip under the tabs shows
connection, market, last quote, last digit, account and balance.
