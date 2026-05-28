/**
 * code-server Reverse Proxy
 *
 * Proxies all requests from /code-server/* to the local code-server instance.
 * Handles:
 *   - Session cookie authentication (code-server internal requests can't send API key headers)
 *   - HTTP reverse proxying with streaming
 *   - WebSocket bridging for editor/terminal (client WS ↔ upstream code-server WS)
 *   - Header stripping (X-Frame-Options, CSP) to allow iframe embedding
 */

import { Elysia } from "elysia";

// ── Session Management ───────────────────────────────────────────────────

interface Session {
  token: string;
  createdAt: number;
  expiresAt: number;
}

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const COOKIE_NAME = "__vibe_cs_session";

// ── URL/header sanitisation helpers ──────────────────────────────────────
//
// The `apiKey` query param is a credential meant only for the proxy
// boundary — upstream tools (code-server here) must never see it. We also
// strip the Referer header for the same reason: it can leak the apiKey
// when the browser navigated from a URL that carried `?apiKey=`.

/**
 * Return `url.search` with any `apiKey` param (case-insensitive) removed.
 * Returns "" if no params remain, or "?…" otherwise.
 */
function searchWithoutApiKey(url: URL): string {
  const sp = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (k.toLowerCase() === "apikey") continue;
    sp.append(k, v);
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/**
 * For mutating requests authenticated by a session cookie, require an
 * Origin or Referer that matches the proxy's own host. This is a CSRF
 * shield — the cookie is SameSite=None for iframe embedding, so the
 * browser will send it on cross-site requests; the origin check is what
 * prevents a malicious site from issuing state-changing requests.
 *
 * GET/HEAD are exempt (read-only). Requests authenticated purely by
 * API-key header/param are exempt — the caller already proved possession
 * of the credential, no CSRF risk.
 */
function originAllowed(request: Request): boolean {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return true;

  const proxyHost = new URL(request.url).host;
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).host === proxyHost;
    } catch {
      return false;
    }
  }
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).host === proxyHost;
    } catch {
      return false;
    }
  }
  // No Origin and no Referer on a mutating request — reject.
  return false;
}

const sessions = new Map<string, Session>();

function generateSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

function createSession(): Session {
  const token = generateSessionToken();
  const now = Date.now();
  const session: Session = {
    token,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  sessions.set(token, session);
  return session;
}

export function validateSessionToken(token: string): boolean {
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return false;
  }
  return true;
}

/** Clean up expired sessions periodically */
function cleanupSessions(): void {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now > session.expiresAt) {
      sessions.delete(token);
    }
  }
}

// Run cleanup every 10 minutes
setInterval(cleanupSessions, 10 * 60 * 1000);

/**
 * Extract a cookie value from the Cookie header.
 */
function getCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1] : null;
}

// ── Auth helpers ─────────────────────────────────────────────────────────

function isAuthed(
  request: Request,
  validateApiKey: (key: string) => boolean,
): { hasValidSession: boolean; hasValidApiKey: boolean } {
  const cookieHeader = request.headers.get("cookie");
  const sessionToken = getCookie(cookieHeader, COOKIE_NAME);
  const apiKeyHeader = request.headers.get("x-agent-api-key");
  const url = new URL(request.url);
  const apiKeyParam = url.searchParams.get("apiKey");

  const hasValidSession = sessionToken
    ? validateSessionToken(sessionToken)
    : false;
  const hasValidApiKey =
    (apiKeyHeader != null && validateApiKey(apiKeyHeader)) ||
    (apiKeyParam != null && validateApiKey(apiKeyParam));

  return { hasValidSession, hasValidApiKey };
}

// ── Path helpers ─────────────────────────────────────────────────────────

function stripPrefix(pathname: string): string {
  return pathname.replace(/^\/code-server\/?/, "/") || "/";
}

// ── Headers to strip from proxied responses (for iframe embedding) ───────

const STRIP_RESPONSE_HEADERS = new Set([
  "x-frame-options",
  "content-security-policy",
  "x-content-type-options",
]);

// ── Loading overlay ──────────────────────────────────────────────────────
//
// Injected into the main code-server HTML document so the user sees a spinner
// instead of a blank white page while `workbench.js` downloads and the remote
// connection is established. The overlay removes itself as soon as the VS Code
// workbench mounts (`.monaco-workbench`), with a hard fallback so it can never
// get stuck. Inline <style>/<script> are safe because this proxy strips the
// upstream Content-Security-Policy above.

const EDITOR_LOADER_SNIPPET = `<div id="vibe-cs-loader" role="status" aria-label="Starting editor" style="position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:#1e1e1e;color:#cccccc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="width:42px;height:42px;border:3px solid rgba(255,255,255,0.15);border-top-color:#3794ff;border-radius:50%;animation:vibe-cs-spin 0.8s linear infinite;"></div>
<div style="font-size:13px;letter-spacing:0.3px;opacity:0.85;">Starting editor…</div>
<style>@keyframes vibe-cs-spin{to{transform:rotate(360deg)}}</style>
</div>
<script>(function(){function r(){var l=document.getElementById('vibe-cs-loader');if(l&&l.parentNode)l.parentNode.removeChild(l);}var o;try{o=new MutationObserver(function(){if(document.querySelector('.monaco-workbench')){r();o.disconnect();}});o.observe(document.documentElement,{childList:true,subtree:true});}catch(e){}setTimeout(function(){r();if(o)o.disconnect();},30000);})();</script>`;

/**
 * Insert the loading overlay right after the opening <body> tag so it paints
 * immediately. Falls back to prepending if no <body> is found.
 */
function injectEditorLoader(html: string): string {
  const bodyOpen = html.match(/<body[^>]*>/i);
  if (bodyOpen && bodyOpen.index !== undefined) {
    const at = bodyOpen.index + bodyOpen[0].length;
    return html.slice(0, at) + EDITOR_LOADER_SNIPPET + html.slice(at);
  }
  return EDITOR_LOADER_SNIPPET + html;
}

// ── WebSocket bridge state ───────────────────────────────────────────────

interface BridgeState {
  upstream: WebSocket | null;
  upstreamReady: boolean;
  buffer: Array<string | ArrayBufferLike>;
}

const bridges = new Map<string, BridgeState>();
let bridgeCounter = 0;

// ── Create proxy ─────────────────────────────────────────────────────────

/**
 * Create the reverse proxy Elysia instance.
 *
 * @param getPort - Returns the port code-server is running on, or null if not running
 * @param validateApiKey - Validates an API key string against the agent's key
 */
export function createCodeServerProxy(
  getPort: () => number | null,
  validateApiKey: (key: string) => boolean,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  return (
    new Elysia({ prefix: "/code-server" })
      // ── WebSocket bridge for code-server remote connections ──────
      .ws("/*", {
        open(ws) {
          const wsData = ws.data as unknown as {
            request?: Request;
            headers?: Record<string, string | undefined>;
            query?: Record<string, string | undefined>;
          };

          // Auth: check session cookie from the upgrade request headers
          const cookieHeader =
            wsData.headers?.cookie ??
            (wsData.request?.headers?.get("cookie") || null);
          const sessionToken = getCookie(cookieHeader ?? null, COOKIE_NAME);
          const apiKeyParam = wsData.query?.apiKey ?? null;

          const hasSession = sessionToken
            ? validateSessionToken(sessionToken)
            : false;
          const hasKey = apiKeyParam ? validateApiKey(apiKeyParam) : false;

          if (!hasSession && !hasKey) {
            ws.close(1008, "Unauthorized");
            return;
          }

          const port = getPort();
          if (!port) {
            ws.close(1011, "code-server not running");
            return;
          }

          // Determine upstream path from the original request URL
          const requestUrl =
            wsData.request?.url ??
            (wsData.headers?.["x-forwarded-uri"] || "/code-server/");
          let upstreamPath: string;
          try {
            const url = new URL(requestUrl, `http://127.0.0.1:${port}`);
            upstreamPath = stripPrefix(url.pathname) + url.search;
          } catch {
            upstreamPath = "/";
          }

          const bridgeId = `cs-bridge-${++bridgeCounter}`;
          (wsData as Record<string, unknown>)._bridgeId = bridgeId;

          const state: BridgeState = {
            upstream: null,
            upstreamReady: false,
            buffer: [],
          };
          bridges.set(bridgeId, state);

          // Connect upstream WS to code-server
          const upstreamUrl = `ws://127.0.0.1:${port}${upstreamPath}`;
          const upstreamWs = new WebSocket(upstreamUrl);
          state.upstream = upstreamWs;

          upstreamWs.addEventListener("open", () => {
            state.upstreamReady = true;
            // Flush buffered messages
            for (const msg of state.buffer) {
              upstreamWs.send(msg);
            }
            state.buffer.length = 0;
          });

          // Forward: upstream code-server → client browser
          upstreamWs.addEventListener("message", (event) => {
            try {
              const data = event.data;
              if (data instanceof ArrayBuffer) {
                ws.send(new Uint8Array(data));
              } else if (data instanceof Blob) {
                data.arrayBuffer().then((ab) => {
                  try {
                    ws.send(new Uint8Array(ab));
                  } catch {
                    /* client gone */
                  }
                });
              } else {
                ws.send(data);
              }
            } catch {
              /* client gone */
            }
          });

          upstreamWs.addEventListener("close", (event) => {
            bridges.delete(bridgeId);
            try {
              ws.close(event.code || 1000, event.reason || "Upstream closed");
            } catch {
              /* already closed */
            }
          });

          upstreamWs.addEventListener("error", () => {
            bridges.delete(bridgeId);
            try {
              ws.close(1011, "Upstream error");
            } catch {
              /* already closed */
            }
          });
        },

        message(ws, message) {
          const wsData = ws.data as unknown as { _bridgeId?: string };
          const bridgeId = wsData._bridgeId;
          if (!bridgeId) return;

          const state = bridges.get(bridgeId);
          if (!state) return;

          // Normalise message
          let payload: string | ArrayBuffer;
          if (typeof message === "string") {
            payload = message;
          } else if (message instanceof ArrayBuffer) {
            payload = message;
          } else if (
            message instanceof Uint8Array ||
            Buffer.isBuffer(message)
          ) {
            const copy = new ArrayBuffer(message.byteLength);
            new Uint8Array(copy).set(
              new Uint8Array(
                message.buffer,
                message.byteOffset,
                message.byteLength,
              ),
            );
            payload = copy;
          } else if (typeof message === "object" && message !== null) {
            payload = JSON.stringify(message);
          } else {
            payload = String(message);
          }

          if (
            state.upstream &&
            state.upstreamReady &&
            state.upstream.readyState === WebSocket.OPEN
          ) {
            try {
              state.upstream.send(payload);
            } catch {
              /* upstream gone */
            }
          } else {
            state.buffer.push(payload);
          }
        },

        close(ws) {
          const wsData = ws.data as unknown as { _bridgeId?: string };
          const bridgeId = wsData._bridgeId;
          if (bridgeId) {
            const state = bridges.get(bridgeId);
            if (
              state?.upstream &&
              state.upstream.readyState === WebSocket.OPEN
            ) {
              state.upstream.close(1000, "Client disconnected");
            }
            bridges.delete(bridgeId);
          }
        },
      })

      // ── HTTP proxy: all paths ───────────────────────────────────
      .all("/*", async ({ request }) => {
        return handleProxyRequest(request, getPort, validateApiKey);
      })
      .all("/", async ({ request }) => {
        return handleProxyRequest(request, getPort, validateApiKey);
      })
  );
}

async function handleProxyRequest(
  request: Request,
  getPort: () => number | null,
  validateApiKey: (key: string) => boolean,
): Promise<Response> {
  const { hasValidSession, hasValidApiKey } = isAuthed(request, validateApiKey);

  if (!hasValidSession && !hasValidApiKey) {
    return new Response(
      JSON.stringify({
        error: "Unauthorized — provide a valid API key or session",
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  // CSRF guard for cookie-authed mutating requests. If the caller has a
  // valid API key they've already proven possession of the credential and
  // are exempt from the origin check.
  if (!hasValidApiKey && hasValidSession && !originAllowed(request)) {
    return new Response(
      JSON.stringify({ error: "Forbidden — invalid Origin" }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }

  // If authenticated via API key but no session cookie, create session and
  // serve the proxied content directly (with Set-Cookie header).
  // We avoid a 302 redirect because cross-origin iframes won't carry the
  // cookie on the redirected request (SameSite restrictions).
  let sessionCookieHeader: string | null = null;
  if (!hasValidSession && hasValidApiKey) {
    const session = createSession();
    sessionCookieHeader = `${COOKIE_NAME}=${session.token}; Path=/code-server/; HttpOnly; SameSite=None; Secure; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
  }

  // Verify code-server is running
  const port = getPort();
  if (!port) {
    return new Response(
      JSON.stringify({ error: "code-server is not running" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  const response = await handleHttpProxy(request, port);

  // Attach the session cookie to the proxied response
  if (sessionCookieHeader) {
    const headers = new Headers(response.headers);
    headers.set("Set-Cookie", sessionCookieHeader);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return response;
}

/**
 * Proxy an HTTP request to the local code-server instance.
 */
async function handleHttpProxy(
  request: Request,
  port: number,
): Promise<Response> {
  const url = new URL(request.url);
  const strippedPath = stripPrefix(url.pathname);
  // Strip apiKey from the query before forwarding — it's a proxy-boundary
  // credential and must never reach code-server.
  const sanitisedSearch = searchWithoutApiKey(url);
  const upstreamUrl = `http://127.0.0.1:${port}${strippedPath}${sanitisedSearch}`;

  // Build upstream headers (copy most, skip hop-by-hop)
  const upstreamHeaders = new Headers();
  const hopByHopHeaders = new Set([
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "proxy-authorization",
    "proxy-authenticate",
    // Drop Referer — it may contain `?apiKey=` from the parent iframe URL.
    "referer",
  ]);

  request.headers.forEach((value, key) => {
    if (!hopByHopHeaders.has(key.toLowerCase())) {
      upstreamHeaders.set(key, value);
    }
  });

  // Override Host header for code-server
  upstreamHeaders.set("Host", `127.0.0.1:${port}`);

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers: upstreamHeaders,
      body:
        request.method !== "GET" && request.method !== "HEAD"
          ? request.body
          : undefined,
      redirect: "manual",
    });

    // Build response headers, stripping iframe-blocking ones
    const responseHeaders = new Headers();
    upstreamResponse.headers.forEach((value, key) => {
      if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    });

    // Inject the loading overlay ONLY into the top-level VS Code workbench
    // document. We gate on the GET method (skips HEAD, whose body is empty) and
    // a workbench bootstrap marker in the HTML — not a path heuristic — so the
    // spinner never shows on /static/ assets, the hidden web-worker iframe, or
    // code-server's login/error pages. Reading the body decodes any
    // content-encoding and changes its length, so both headers are recomputed.
    const contentType = upstreamResponse.headers.get("content-type") ?? "";
    if (
      request.method === "GET" &&
      upstreamResponse.ok &&
      contentType.includes("text/html")
    ) {
      const body = await upstreamResponse.text();
      const isWorkbenchDoc = body.includes("code/didStartRenderer");
      const out = isWorkbenchDoc ? injectEditorLoader(body) : body;
      responseHeaders.delete("content-encoding");
      // The body no longer matches the upstream representation (decoded, and
      // injected for the workbench doc), so its cache validators are stale —
      // drop them so conditional requests / caches don't serve the wrong entity.
      responseHeaders.delete("etag");
      responseHeaders.delete("last-modified");
      responseHeaders.set(
        "content-length",
        String(Buffer.byteLength(out, "utf8")),
      );
      return new Response(out, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders,
      });
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: "Failed to proxy to code-server",
        details: err instanceof Error ? err.message : "Unknown error",
      }),
      {
        status: 502,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

export default createCodeServerProxy;
