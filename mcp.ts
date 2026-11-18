// Model Context Protocol (POST /mcp): JSON-RPC 2.0 over Streamable HTTP, both eras.
// Modern (2026-07-28): server/discover answers supportedVersions; legacy (2025-11-25
// and earlier): initialize + notifications/initialized. The six tools the suite drives
// act on the same store as REST, so an MCP-created repo/issue reads back over /api/v3.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { hasAuth, nextRequestId, readBody, sendError, sendJson } from './httputil.ts';
import {
  VIEWER,
  clock,
  globalId,
  mergeBase,
  squashMerge,
  store,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { pullIsMergeable } from './rest.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, { type: string; description: string }>;
    readonly required: string[];
  };
}

/** The tool list: one constant, so two tools/list calls answer byte for byte alike. */
const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'number', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_repos',
    description: 'List repositories owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function repoJson(repo: Repo) {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function issueJson(repo: Repo, issue: Issue) {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    user: { login: issue.user },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull) {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    user: { login: pull.user },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

/** A tool result: the object as text and as structured content, for either reader. */
function toolOk(id: unknown, value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], structuredContent: value } };
}

function toolError(id: unknown, message: string) {
  return {
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text: message }], isError: true },
  };
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Check the required arguments of a tool; returns the missing names. */
function missingArgs(tool: ToolDef, args: Record<string, unknown>): string[] {
  return tool.inputSchema.required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

function callTool(tool: ToolDef, args: Record<string, unknown>, id: unknown): unknown {
  const missing = missingArgs(tool, args);
  if (missing.length > 0) {
    return rpcError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`);
  }
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER.login;
  const repoName = typeof args.repo === 'string' ? args.repo : '';

  switch (tool.name) {
    case 'create_repo': {
      const name = String(args.name);
      const description = typeof args.description === 'string' ? args.description : '';
      const isPrivate = args.private === true;
      const repo = store.createRepo(VIEWER.login, name, description, isPrivate);
      if (!repo) return toolError(id, `Repository ${name} already exists`);
      return toolOk(id, repoJson(repo));
    }
    case 'list_repos': {
      return toolOk(id, { repositories: store.listViewerRepos(VIEWER.login).map(repoJson) });
    }
    case 'get_repo': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(id, `Repository ${owner}/${repoName} not found`);
      return toolOk(id, repoJson(repo));
    }
    case 'create_issue': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(id, `Repository ${owner}/${repoName} not found`);
      const now = clock.nextIso();
      const issue: Issue = {
        id: store.nextId(),
        number: repo.issues.length + 1,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        comments: [],
        user: VIEWER.login,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      };
      repo.issues.push(issue);
      return toolOk(id, issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(id, `Repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const list = state === 'all' ? repo.issues : repo.issues.filter((i) => i.state === state);
      return toolOk(id, { issues: list.map((i) => issueJson(repo, i)) });
    }
    case 'get_issue': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(id, `Repository ${owner}/${repoName} not found`);
      const number = Number(args.issue_number);
      const issue = repo.issues.find((i) => i.number === number);
      if (!issue) return toolError(id, `Issue #${number} not found`);
      return toolOk(id, issueJson(repo, issue));
    }
    case 'create_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(id, `Repository ${owner}/${repoName} not found`);
      const headRef = String(args.head);
      const baseRef = String(args.base);
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (!headSha || !baseSha) return toolError(id, 'Head or base branch does not exist');
      const now = clock.nextIso();
      const pull: Pull = {
        id: store.nextId(),
        number: repo.pulls.length + 1,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef,
        baseRef,
        headSha,
        baseSha,
        mergeBaseSha: mergeBase(repo, headSha, baseSha) ?? '0000000000000000000000000000000000000000',
        user: VIEWER.login,
        createdAt: now,
        updatedAt: now,
      };
      repo.pulls.push(pull);
      return toolOk(id, pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(id, `Repository ${owner}/${repoName} not found`);
      const number = Number(args.pull_number);
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) return toolError(id, `Pull request #${number} not found`);
      if (!pullIsMergeable(repo, pull)) return toolError(id, 'Pull request is not mergeable');
      const merged = squashMerge(repo, pull);
      if ('error' in merged) return toolError(id, merged.error);
      return toolOk(id, { ...pullJson(repo, pull), sha: merged.sha, merged: true });
    }
    default:
      return rpcError(id, -32601, `Unknown tool: ${tool.name}`);
  }
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if ((req.method ?? 'GET') !== 'POST') {
    sendError(res, 404, 'Not Found');
    return true;
  }
  if (!hasAuth(req)) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }
  const parsed = await readBody(req);
  if (parsed.malformed || parsed.empty) {
    // A body that is not JSON: HTTP 400 with JSON-RPC -32700 (the modern transport).
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const body = parsed.json as Record<string, unknown> | null;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const id = body.id ?? null;
  const method = typeof body.method === 'string' ? body.method : '';
  const params = (body.params ?? {}) as Record<string, unknown>;

  // A notification (no id): acknowledge and stay quiet.
  if (id === null && method.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': nextRequestId() });
    res.end();
    return true;
  }

  switch (method) {
    case 'server/discover': {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          supportedVersions: [...SUPPORTED_VERSIONS],
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          capabilities: { tools: {} },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
        },
      });
      return true;
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : SUPPORTED_VERSIONS[0];
      const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : SUPPORTED_VERSIONS[0];
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      });
      return true;
    }
    case 'ping': {
      sendJson(res, 200, { jsonrpc: '2.0', id, result: {} });
      return true;
    }
    case 'tools/list': {
      sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return true;
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        sendJson(res, 200, rpcError(id, -32601, `Unknown tool: ${name}`));
        return true;
      }
      sendJson(res, 200, callTool(tool, args, id));
      return true;
    }
    default: {
      sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
      return true;
    }
  }
}
