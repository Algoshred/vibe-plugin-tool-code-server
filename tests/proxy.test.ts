/**
 * Reverse-proxy response-encoding tests.
 *
 * Regression coverage for the code-server editor rendering with missing icons:
 * Bun's `fetch()` transparently DECODES a gzip/br upstream body but leaves the
 * stale `content-encoding` + (compressed) `content-length` headers on the
 * response. Forwarding those verbatim corrupts binary assets — the codicon
 * icon font fails to decode ("incorrect file size in WOFF header"). The proxy
 * must strip those headers on the streaming passthrough path.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { gzipSync } from "bun";
import createCodeServerProxy from "../src/lib/proxy.js";

const API_KEY = "test-agent-key";

// Deterministic binary "font" payload — bytes that would be mangled if the
// browser tried to gunzip them a second time or truncate to a shorter length.
function makeFont(size: number): Uint8Array {
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 31 + 7) & 0xff;
  return buf;
}

const FONT = makeFont(8192);
const GZ_FONT = gzipSync(FONT);
const PLAIN_CSS = new TextEncoder().encode(".codicon{font-family:codicon}");

// Fake upstream code-server: serves a gzip-encoded font (like a real static
// server with compression on) and a plain, uncompressed asset.
const upstream = Bun.serve({
  port: 0,
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/static/codicon.ttf") {
      return new Response(GZ_FONT, {
        headers: {
          "content-type": "font/ttf",
          "content-encoding": "gzip",
          "content-length": String(GZ_FONT.byteLength),
          etag: '"font-v1"',
        },
      });
    }
    if (pathname === "/static/plain.css") {
      return new Response(PLAIN_CSS, {
        headers: {
          "content-type": "text/css",
          "content-length": String(PLAIN_CSS.byteLength),
        },
      });
    }
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => upstream.stop(true));

const proxy = createCodeServerProxy(
  () => upstream.port,
  (key: string) => key === API_KEY,
);

function csRequest(path: string, withKey = true): Request {
  const suffix = withKey ? `?apiKey=${API_KEY}` : "";
  return new Request(`http://agent.local/code-server${path}${suffix}`);
}

describe("code-server proxy — compressed asset passthrough", () => {
  test("gzip font is delivered decoded, full-length, without stale encoding headers", async () => {
    const res: Response = await proxy.handle(csRequest("/static/codicon.ttf"));

    expect(res.status).toBe(200);
    // The decoded body must NOT be labelled gzip — that is the corruption bug.
    expect(res.headers.get("content-encoding")).toBeNull();
    // The stale (compressed) content-length must be gone so the browser does
    // not truncate the decoded font. If present at all it must match the
    // decoded length, never the compressed one.
    const contentLength = res.headers.get("content-length");
    if (contentLength !== null) {
      expect(Number(contentLength)).toBe(FONT.byteLength);
      expect(Number(contentLength)).not.toBe(GZ_FONT.byteLength);
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    // Full, byte-exact decoded font — not truncated, not double-compressed.
    expect(bytes.byteLength).toBe(FONT.byteLength);
    expect(Array.from(bytes.slice(0, 16))).toEqual(
      Array.from(FONT.slice(0, 16)),
    );
    expect(Array.from(bytes.slice(-16))).toEqual(Array.from(FONT.slice(-16)));
  });

  test("uncompressed asset passes through intact with correct content-length", async () => {
    const res: Response = await proxy.handle(csRequest("/static/plain.css"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    const body = await res.text();
    expect(body).toBe(new TextDecoder().decode(PLAIN_CSS));
    const contentLength = res.headers.get("content-length");
    if (contentLength !== null) {
      expect(Number(contentLength)).toBe(PLAIN_CSS.byteLength);
    }
  });

  test("unauthenticated asset request is rejected", async () => {
    const res: Response = await proxy.handle(
      csRequest("/static/codicon.ttf", false),
    );
    expect(res.status).toBe(401);
  });
});
