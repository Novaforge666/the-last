/*
 * Same-origin relay for the two Deriv Options REST calls the page needs.
 *
 * Browsers do not always get CORS permission from https://api.derivws.com, and
 * a blocked cross-origin read is indistinguishable from a network failure in
 * fetch(). The page therefore tries Deriv directly first and only falls back to
 * this relay when that call throws. Nothing here is a secret: the caller's own
 * Bearer token is forwarded verbatim and never stored or logged.
 *
 * Request (JSON):
 *   { path, method?, token, authKind?, appId?, body? }
 *   path must be one of:
 *     /trading/v1/options/accounts
 *     /trading/v1/options/accounts/<account_id>/otp
 *
 * Response: Deriv's status code and JSON body, unchanged.
 */

const API_BASE = "https://api.derivws.com";
const ACCOUNTS_PATH = "/trading/v1/options/accounts";
const OTP_PATH_RE = /^\/trading\/v1\/options\/accounts\/[A-Za-z0-9_-]{1,64}\/otp$/;
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
      if (raw.length > 10000) { reject(new Error("request_too_large")); req.destroy(); }
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { reject(new Error("invalid_json")); }
    });
    req.on("error", reject);
  });
}

function pathIsAllowed(path) {
  return path === ACCOUNTS_PATH || OTP_PATH_RE.test(path);
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

  const path = String(body.path || "").trim();
  const token = String(body.token || "").trim();
  const method = String(body.method || "GET").toUpperCase();
  const appId = String(body.appId || "").trim();

  if (!pathIsAllowed(path)) {
    return setJson(res, 403, { error: "path_not_allowed", error_description: "This relay only serves the Options account and OTP endpoints." });
  }
  if (method !== "GET" && method !== "POST") {
    return setJson(res, 405, { error: "method_not_allowed", error_description: "Only GET and POST are relayed." });
  }
  if (!token || token.length > 4096) {
    return setJson(res, 401, { error: "missing_token", error_description: "A Bearer token is required." });
  }

  const headers = {
    "Accept": "application/json",
    "Authorization": "Bearer " + token
  };
  // A PAT is scoped to one registered application; OAuth Bearer tokens are not.
  if (body.authKind === "pat") {
    if (!APP_ID_RE.test(appId)) {
      return setJson(res, 400, { error: "invalid_app_id", error_description: "A Deriv-App-ID is required for PAT requests." });
    }
    headers["Deriv-App-ID"] = appId;
  }
  if (body.body !== undefined && body.body !== null) headers["Content-Type"] = "application/json";

  let upstream;
  try {
    upstream = await fetch(API_BASE + path, {
      method,
      headers,
      body: body.body === undefined || body.body === null ? undefined : JSON.stringify(body.body)
    });
  } catch (_) {
    return setJson(res, 502, { error: "deriv_unreachable", error_description: "Could not reach Deriv." });
  }

  let payload = null;
  try { payload = await upstream.json(); } catch (_) {}
  return setJson(res, upstream.status, payload === null ? { error: "bad_deriv_response" } : payload);
};
