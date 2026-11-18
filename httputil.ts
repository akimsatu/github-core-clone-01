// HTTP plumbing shared by every surface: body reading, JSON replies (always
// application/json, always with a non-empty X-GitHub-Request-Id), bearer auth, and
// the small helpers routers need. Nothing here reads a clock for state.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** The next request id: deterministic, non-empty, unique within the process. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

/** The bearer token the process accepts (MAKEFUN_SHOP_TOKEN in a trial). */
export function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/**
 * Whether the request carries acceptable auth: `Authorization: Bearer <token>`.
 * With no token configured (local runs) any non-empty bearer is accepted; a missing
 * or empty header is never accepted.
 */
export function hasAuth(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer (.+)$/.exec(header.trim());
  if (!match) return false;
  const presented = match[1].trim();
  if (presented === '') return false;
  const expected = expectedToken();
  if (expected === '') return true;
  return presented === expected;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(text);
}

/** A 204 with no body (DELETE /repos answers this; the request id still rides along). */
export function sendEmpty(res: ServerResponse, status: number, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId(), ...extra });
  res.end();
}

export function sendError(res: ServerResponse, status: number, message: string, extra: Record<string, string> = {}): void {
  sendJson(res, status, { message }, extra);
}

export interface ParsedBody {
  /** The parsed JSON value, when the body parsed and was an object/array. */
  readonly json: unknown;
  /** True when a body was present but did not parse as JSON. */
  readonly malformed: boolean;
  /** True when no body bytes arrived at all. */
  readonly empty: boolean;
  /** The raw bytes, for endpoints that need them (git packs). */
  readonly raw: Buffer;
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Read the whole request body (up to 64 MiB) and JSON-parse it when possible. */
export async function readBody(req: IncomingMessage): Promise<ParsedBody> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks);
  if (raw.length === 0) return { json: undefined, malformed: false, empty: true, raw };
  try {
    return { json: JSON.parse(raw.toString('utf8')), malformed: false, empty: false, raw };
  } catch {
    return { json: undefined, malformed: true, empty: false, raw };
  }
}

/** The path segments of a request URL, percent-decoded, without empty parts. */
export function pathSegments(req: IncomingMessage): string[] {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return url.pathname.split('/').filter((s) => s !== '').map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  } catch {
    return [];
  }
}

/** Query parameters of a request URL. */
export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** The request's own origin (scheme://host) as the client dialled it, for Link headers. */
export function requestOrigin(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

/** Parse an integer query value with a default; NaN falls back to the default. */
export function queryInt(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}
