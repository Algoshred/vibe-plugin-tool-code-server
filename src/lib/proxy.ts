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

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const COOKIE_NAME = "__vibe_cs_session";

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

function validateSessionToken(token: string): boolean {
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
  const upstreamUrl = `http://127.0.0.1:${port}${strippedPath}${url.search}`;

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
