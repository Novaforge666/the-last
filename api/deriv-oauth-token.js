/*
 * Same-origin OAuth token exchange for the static TickForge page.
 *
 * Deriv's OAuth 2.0 flow is Authorization Code + PKCE. The browser redirects
 * to https://auth.deriv.com/oauth2/auth and comes back with a single-use code.
 * This function exchanges that code server-side so the browser never handles
 * the token endpoint directly. No client secret exists for Deriv third-party
 * OAuth apps; the PKCE code_verifier binds the exchange to this browser tab.
 *
 * Request (JSON):
 *   { grant_type, client_id?, code, code_verifier, redirect_uri }
 * Response:
 *   { access_token, token_type, expires_in }
 *
 * Nothing is logged and no token is persisted by this function.
 */

const DERIV_TOKEN_URL = "https://auth.deriv.com/oauth2/token";
const APP_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

function setJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  if (req.body !== undefined) {
    if (typeof req.body === "string") {
      if (req.body.length > 10000) return Promise.reject(new Error("request_too_large"));
      return Promise.resolve(req.body ? JSON.parse(req.body) : {});
    }
    if (Buffer.isBuffer(req.body)) {
      if (req.body.length > 10000) return Promise.reject(new Error("request_too_large"));
      const text = req.body.toString("utf8");
      return Promise.resolve(text ? JSON.parse(text) : {});
    }
    return Promise.resolve(req.body || {});
  }

  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 10000) {
        reject(new Error("request_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (_) { reject(new Error("invalid_json")); }
    });
    req.on("error", reject);
  });
}

function redirectUriIsAllowed(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol === "https:" && url.hostname.endsWith(".vercel.app")) return true;
    if (url.protocol === "https:" && url.hostname === "the-last-weld.vercel.app") return true;
    if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) return true;
    return false;
  } catch (_) {
    return false;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return setJson(res, 405, { error: "method_not_allowed", error_description: "Use POST." });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    const message = err && err.message === "request_too_large" ? "Request body is too large." : "Invalid JSON body.";
    return setJson(res, 400, { error: "invalid_request", error_description: message });
  }

  const code = String(body.code || "").trim();
  const verifier = String(body.code_verifier || "").trim();
  const redirectUri = String(body.redirect_uri || "").trim();
  const clientId = String(process.env.DERIV_CLIENT_ID || body.client_id || "").trim();

  if (!code || code.length > 2048) {
    return setJson(res, 400, { error: "invalid_request", error_description: "Missing or invalid code." });
  }
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
    return setJson(res, 400, { error: "invalid_request", error_description: "Missing or invalid code_verifier." });
  }
  if (!APP_ID_RE.test(clientId)) {
    return setJson(res, 400, { error: "invalid_client", error_description: "Missing or invalid client_id." });
  }
  if (!redirectUriIsAllowed(redirectUri)) {
    return setJson(res, 400, { error: "invalid_request", error_description: "redirect_uri is not allowed for this deployment." });
  }

  const form = new URLSearchParams();
  form.set("grant_type", "authorization_code");
  form.set("client_id", clientId);
  form.set("code", code);
  form.set("code_verifier", verifier);
  form.set("redirect_uri", redirectUri);

  let derivResponse;
  try {
    derivResponse = await fetch(DERIV_TOKEN_URL, {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form.toString()
    });
  } catch (_) {
    return setJson(res, 502, { error: "deriv_unreachable", error_description: "Could not reach Deriv's token endpoint." });
  }

  let derivBody = null;
  try { derivBody = await derivResponse.json(); } catch (_) {}

  if (!derivResponse.ok) {
    return setJson(res, derivResponse.status, {
      error: (derivBody && (derivBody.error || derivBody.code)) || "invalid_grant",
      error_description: (derivBody && (derivBody.error_description || derivBody.message)) || "Deriv rejected the authorization code."
    });
  }
  if (!derivBody || !derivBody.access_token) {
    return setJson(res, 502, { error: "bad_deriv_response", error_description: "Deriv did not return an access token." });
  }

  return setJson(res, 200, {
    access_token: derivBody.access_token,
    token_type: derivBody.token_type || "Bearer",
    expires_in: Number(derivBody.expires_in || 0)
  });
};
