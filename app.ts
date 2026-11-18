// The forge's HTTP server: one process, four surfaces, no UI.
//
//   GET  /healthz                  the env's boot probe: 200 {"ok": true}
//   /api/v3/...                    GitHub REST v3 (rest.ts)
//   POST /api/graphql             GitHub GraphQL v4 (graphql.ts)
//   POST /mcp                     Model Context Protocol, streamable HTTP (mcp.ts)
//   /{owner}/{repo}.git/...       git smart HTTP (gitproto.ts)
//   anything else                 404 {"message": "Not Found"}
//
// Every surface answers JSON except the git pack streams; a handler that throws
// answers 500 JSON instead of dropping the connection, so one bad request can
// never take the server down mid-trial.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathSegments, queryOf, sendError, sendJson } from './httputil.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './gitproto.ts';

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void dispatch(req, res).catch((err: unknown) => {
      try {
        sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
      } catch {
        // The connection is already gone; there is nothing left to answer.
      }
    });
  });
}

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const seg = pathSegments(req);
  const query = queryOf(req);

  if (method === 'GET' && seg.length === 1 && seg[0] === 'healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (seg.length >= 1 && seg[0] === 'api') {
    if (seg.length >= 2 && seg[1] === 'v3') {
      await handleRest(req, res, seg.slice(2), query);
      return;
    }
    if (seg.length === 2 && seg[1] === 'graphql') {
      await handleGraphQL(req, res);
      return;
    }
  }

  if (seg.length === 1 && seg[0] === 'mcp') {
    await handleMcp(req, res);
    return;
  }

  // git smart HTTP: /{owner}/{repo}.git/info/refs, /git-upload-pack, /git-receive-pack.
  if (seg.length >= 3 && seg[1].endsWith('.git')) {
    await handleGit(req, res, seg[0], seg[1].slice(0, -'.git'.length), seg.slice(2), query);
    return;
  }

  sendError(res, 404, 'Not Found');
}
