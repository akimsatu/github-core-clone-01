# github-core-clone — a standalone GitHub-compatible git forge

A single Node 22 process (no git binary, no outside service, no UI) that serves:

- **git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2 (ls-refs, fetch
  with shallow/deepen, thin-pack aware) and receive-pack v0 (fast-forward enforcement,
  per-ref report-status, thin-pack import)
- **REST v3** at `/api/v3` — repos, branches, commits, contents, labels, issues,
  comments, pull requests (squash merge, mergeability)
- **GraphQL** at `/api/graphql` — viewer, repository, node, issues/pulls connections,
  mutations, and `__type`/`__schema` introspection
- **MCP** at `/mcp` — JSON-RPC 2.0 (`server/discover`, `initialize`, `tools/list`,
  `tools/call` over 8 tools)

State is fully in-memory and deterministic: a logical clock ticks 1 s per mutation from
`MAKEFUN_TRIAL_NOW` (or a fixed epoch), and identities come from the published scenario
seed, so a state-export replay is byte-identical.

## Layout

| file | what it holds |
| --- | --- |
| `main.ts` | lifecycle: ephemeral bind → register with `$MAKEFUN_ENV_URL` → poll `/done` → exit 0; standalone mode when the env URL is unset (local testing) |
| `app.ts` | HTTP router for `/healthz`, `/api/v3/*`, `/api/graphql`, `/mcp`, `/{owner}/{repo}.git/*` |
| `scenario.ts` | the published scenario PRNG (xorshift64\* + FNV-1a) — viewer `adaiversen`, teammates, org, labels |
| `store.ts` | in-memory state, deterministic clock, object/commit/tree helpers, squash merge |
| `git.ts` | SHA-1 objects, pkt-lines, packfile v2 read/write (OFS/REF deltas, thin-pack bases) |
| `gitproto.ts` | smart-HTTP advertisements, v2/v0 fetch planning, receive-pack |
| `rest.ts` | REST v3 |
| `graphql.ts` | hand-written GraphQL lexer/parser/executor |
| `mcp.ts` | MCP JSON-RPC server |
| `httputil.ts` | body parsing, JSON replies, auth, request ids |

## Local test

```sh
MAKEFUN_SHOP_TOKEN=test-token FORGE_PORT=18080 node --experimental-strip-types main.ts
# in the kit directory:
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:18080 --token test-token --perf --json
```

Local result (2026-11-14): **120/120 checks, feature 600, agent 200, perf 151, score 951**.
Real git CLI verified: push (new branch, fast-forward, thin pack), non-fast-forward
refused, tag push, full and shallow (`--depth 1`) clones round-trip byte-exactly.

## License

MIT
