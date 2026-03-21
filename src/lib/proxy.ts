/**
 * code-server Reverse Proxy
 *
 * Proxies all requests from /code-server/* to the local code-server instance.
 * Handles:
 *   - Session cookie authentication (code-server internal requests can't send API key headers)
 *   - HTTP reverse proxying with streaming
 *   - WebSocket proxying for editor/terminal
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

// ── Headers to strip from proxied responses (for iframe embedding) ───────

const STRIP_RESPONSE_HEADERS = new Set([
  "x-frame-options",
  "content-security-policy",
  "x-content-type-options",
]);

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
  return new Elysia({ prefix: "/code-server" })
    .all("/*", async ({ request }) => {
      return handleProxyRequest(request, getPort, validateApiKey);
    })
    .all("/", async ({ request }) => {
      return handleProxyRequest(request, getPort, validateApiKey);
    });
}

async function handleProxyRequest(
  request: Request,
  getPort: () => number | null,
  validateApiKey: (key: string) => boolean,
): Promise<Response> {
  // ── Auth check ────────────────────────────────────────────────

  const cookieHeader = request.headers.get("cookie");
  const sessionToken = getCookie(cookieHeader, COOKIE_NAME);
  const apiKeyHeader = request.headers.get("x-agent-api-key");
  const url = new URL(request.url);
  const apiKeyParam = url.searchParams.get("apiKey");

  const hasValidSession = sessionToken
    ? validateSessionToken(sessionToken)
    : false;
  const hasValidApiKey =
    (apiKeyHeader && validateApiKey(apiKeyHeader)) ||
    (apiKeyParam && validateApiKey(apiKeyParam));

  if (!hasValidSession && !hasValidApiKey) {
    return new Response(
      JSON.stringify({
        error: "Unauthorized — provide a valid API key or session",
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  // If authenticated via API key but no session cookie, create one and redirect
  if (!hasValidSession && hasValidApiKey) {
    const session = createSession();

    // Strip apiKey from URL if present and redirect
    url.searchParams.delete("apiKey");
    const redirectUrl = url.pathname + url.search;

    return new Response(null, {
      status: 302,
      headers: {
        Location: redirectUrl,
        "Set-Cookie": `${COOKIE_NAME}=${session.token}; Path=/code-server/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      },
    });
  }

  // ── Verify code-server is running ─────────────────────────────

  const port = getPort();
  if (!port) {
    return new Response(
      JSON.stringify({ error: "code-server is not running" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  // ── Check for WebSocket upgrade ───────────────────────────────

  const upgradeHeader = request.headers.get("upgrade");
  if (upgradeHeader?.toLowerCase() === "websocket") {
    return handleWebSocketProxy(request, port);
  }

  // ── HTTP reverse proxy ────────────────────────────────────────

  return handleHttpProxy(request, port);
}

/**
 * Proxy an HTTP request to the local code-server instance.
 */
async function handleHttpProxy(
  request: Request,
  port: number,
): Promise<Response> {
  const url = new URL(request.url);

  // Construct upstream URL — code-server expects paths under /code-server/
  const upstreamUrl = `http://127.0.0.1:${port}${url.pathname}${url.search}`;

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

/**
 * Proxy a WebSocket upgrade request to the local code-server instance.
 *
 * Forwards the upgrade request as-is to the upstream code-server.
 * Bun's fetch supports WebSocket upgrades natively via the standard
 * Request/Response mechanism.
 */
async function handleWebSocketProxy(
  request: Request,
  port: number,
): Promise<Response> {
  const url = new URL(request.url);
  const upstreamUrl = `http://127.0.0.1:${port}${url.pathname}${url.search}`;

  try {
    // Forward the upgrade request to code-server
    // Bun handles WebSocket upgrade transparently
    const upstreamHeaders = new Headers();
    request.headers.forEach((value, key) => {
      upstreamHeaders.set(key, value);
    });
    upstreamHeaders.set("Host", `127.0.0.1:${port}`);

    const response = await fetch(upstreamUrl, {
      method: request.method,
      headers: upstreamHeaders,
      body: request.body,
      redirect: "manual",
    });

    return response;
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: "WebSocket proxy failed",
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
