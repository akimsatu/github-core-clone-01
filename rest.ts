// GitHub REST v3 (/api/v3): repositories, branches, commits, contents, issues, comments,
// labels and pull requests, over the store in store.ts. Every reply is JSON with a
// non-empty X-GitHub-Request-Id (httputil), every error a JSON {message}, unknown routes
// 404 JSON, malformed JSON bodies 400, missing token 401, foreign-owner repos 404.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  hasAuth,
  nextRequestId,
  queryInt,
  readBody,
  requestOrigin,
  sendEmpty,
  sendError,
  sendJson,
  type ParsedBody,
} from './httputil.ts';
import {
  VIEWER,
  clock,
  collectReachable,
  decodeGlobalId,
  diffTrees,
  getCommit,
  getObject,
  globalId,
  isAncestor,
  listCommits,
  makeCommit,
  mergeBase,
  peelToCommit,
  putObject,
  squashMerge,
  store,
  treeFlatten,
  treeGet,
  treeListDir,
  treeOfCommit,
  treeSet,
  type FileChange,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';
import { ZERO_OID, buildTree, isOid, parseCommit, parseTree } from './git.ts';

// ---------------------------------------------------------------------------
// serialisers (GitHub's shapes, as the suite's shape checks require them)
// ---------------------------------------------------------------------------

function userJson(login: string, id: number) {
  return { login, id, node_id: globalId('User', id), type: 'User', site_admin: false };
}

function repoJson(repo: Repo) {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner, 1000),
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `/${repo.owner}/${repo.name}`,
  };
}

function labelJson(label: Label) {
  return {
    id: globalId('Label', `${label.name}`),
    node_id: globalId('Label', label.name),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
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
    labels: issue.labels.map(labelJson),
    user: userJson(issue.user, 1000),
    assignee: null,
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull) {
  const base = {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    locked: false,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: userJson(repo.owner, 1000),
      repo: repoJson(repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: userJson(repo.owner, 1000),
      repo: repoJson(repo),
    },
    user: userJson(pull.user, 1000),
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    author_association: 'OWNER',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
  return base;
}

/** A page of items, honouring ?per_page and ?page, with a Link rel="next" when more follow. */
function paginate<T>(req: IncomingMessage, items: readonly T[], query: URLSearchParams): { page: T[]; link: string | null } {
  const perPage = Math.min(100, Math.max(1, queryInt(query, 'per_page', 30)));
  const pageNum = Math.max(1, queryInt(query, 'page', 1));
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const origin = requestOrigin(req);
    const path = req.url?.split('?')[0] ?? '';
    const next = new URLSearchParams(query);
    next.set('per_page', String(perPage));
    next.set('page', String(pageNum + 1));
    link = `<${origin}${path}?${next.toString()}>; rel="next"`;
  }
  return { page, link };
}

function sendPage<T>(res: ServerResponse, req: IncomingMessage, items: readonly T[], query: URLSearchParams): void {
  const { page, link } = paginate(req, items, query);
  sendJson(res, 200, page, link === null ? {} : { link });
}

// ---------------------------------------------------------------------------
// git helpers for the contents / refs endpoints
// ---------------------------------------------------------------------------

/** Resolve a branch name, sha or null to a commit oid (null = unborn / unknown). */
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch) return byBranch;
  if (repo.refs.has(`refs/tags/${ref}`)) return peelToCommit(repo, repo.refs.get(`refs/tags/${ref}`)!);
  if (isOid(ref)) {
    const obj = repo.objects.get(ref);
    if (obj?.type === 'commit') return ref;
    if (obj?.type === 'tag') return peelToCommit(repo, ref);
    return null;
  }
  const direct = repo.refs.get(ref);
  if (direct) return peelToCommit(repo, direct);
  return null;
}

/**
 * Write one file into a branch: blob + new tree + commit, and move the ref. Returns the
 * new commit oid. `branch` is created from the default branch tip when it does not exist.
 */
function commitFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
  expectedBlobSha?: string,
): { commitSha: string; blobSha: string } | { error: string; status: number } {
  let tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) {
    // A missing branch is created from the default branch tip (or empty, when the
    // repository is unborn): the suite's MCP setup PUTs contents onto a branch it
    // has not created yet and expects the branch to exist afterwards.
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const baseTree = treeOfCommit(repo, tip ?? null);
  if (expectedBlobSha !== undefined) {
    const current = baseTree === null ? null : treeGet(repo, baseTree, path);
    if (!current || current.oid.toLowerCase() !== expectedBlobSha.toLowerCase()) {
      return { error: 'sha does not match the current blob', status: 409 };
    }
  }
  const blobSha = putObject(repo, 'blob', content);
  const newTree = treeSet(repo, baseTree, path, '100644', blobSha);
  const parents = tip === null || tip === undefined ? [] : [tip];
  const commitSha = makeCommit(repo, newTree, parents, message);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  repo.updatedAt = clock.nextIso();
  return { commitSha, blobSha };
}

/** Remove one file from a branch, committing the deletion. */
function deleteFile(
  repo: Repo,
  branch: string,
  path: string,
  message: string,
  expectedBlobSha?: string,
): { commitSha: string } | { error: string; status: number } {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return { error: `branch ${branch} does not exist`, status: 404 };
  const baseTree = treeOfCommit(repo, tip);
  const current = baseTree === null ? null : treeGet(repo, baseTree, path);
  if (!current) return { error: 'file does not exist', status: 404 };
  if (expectedBlobSha !== undefined && current.oid.toLowerCase() !== expectedBlobSha.toLowerCase()) {
    return { error: 'sha does not match the current blob', status: 409 };
  }
  const newTree = treeSet(repo, baseTree, path, '100644', null);
  const commitSha = makeCommit(repo, newTree, [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  repo.updatedAt = clock.nextIso();
  return { commitSha };
}

/** The line counts of a blob's text, for pull file additions/deletions. */
function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

// ---------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------

/**
 * Handle one /api/v3 request. `seg` is the path segments after /api/v3. Returns true
 * when the request was answered (every /api/v3 path is: unknown routes are JSON 404s).
 */
export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  seg: string[],
  query: URLSearchParams,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  // Every REST call needs the bearer token (a missing one is 401, JSON).
  if (!hasAuth(req)) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }

  // Bodies: a malformed JSON body on a write is 400. A body is only read when the
  // route may need one; reads happen before routing so the 400 is uniform.
  let body: ParsedBody | null = null;
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    body = await readBody(req);
    if (body.malformed) {
      sendError(res, 400, 'Problems parsing JSON');
      return true;
    }
  }
  const json = (body?.json ?? {}) as Record<string, unknown>;
  const bodyObj = typeof json === 'object' && json !== null && !Array.isArray(json) ? json : {};

  // GET /api/v3/ — the API root.
  if (seg.length === 0) {
    if (method !== 'GET') return sendError(res, 404, 'Not Found'), true;
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: '/authorizations',
      authorizations_url: '/authorizations',
      code_search_url: '/search/code?q={query}{&page,per_page,sort,order}',
      commit_search_url: '/search/commits?q={query}{&page,per_page,sort,order}',
      emails_url: '/user/emails',
      emojis_url: '/emojis',
      events_url: '/events',
      feeds_url: '/feeds',
      followers_url: '/user/followers',
      following_url: '/user/following{/target}',
      gists_url: '/gists{/gist_id}',
      hub_url: '/hub',
      issue_search_url: '/search/issues?q={query}{&page,per_page,sort,order}',
      issues_url: '/issues',
      keys_url: '/user/keys',
      label_search_url: '/search/labels?q={query}{&repository_id}{&page,per_page}',
      notifications_url: '/notifications{?since,all,participating}',
      organization_url: '/orgs/{org}',
      public_gists_url: '/gists/public',
      rate_limit_url: '/rate_limit',
      repository_url: '/repos/{owner}/{repo}',
      repository_search_url: '/search/repositories?q={query}{&page,per_page,sort,order}',
      current_user_repositories_url: '/user/repos{?type,page,per_page,sort}',
      user_url: '/users/{user}',
      user_organizations_url: '/user/orgs',
      user_repositories_url: '/users/{user}/repos{?type,page,per_page,sort}',
      user_search_url: '/search/users?q={query}{&page,per_page,sort,order}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // GET /api/v3/meta
  if (seg.length === 1 && seg[0] === 'meta') {
    if (method !== 'GET') return sendError(res, 404, 'Not Found'), true;
    sendJson(res, 200, { verifiable_password_authentication: true, installed_version: 'github-core-clone-1.0.0' });
    return true;
  }

  // GET /api/v3/user — the token owner.
  if (seg.length === 1 && seg[0] === 'user' && method === 'GET') {
    sendJson(res, 200, {
      ...userJson(VIEWER.login, VIEWER.id),
      name: VIEWER.name,
      email: VIEWER.email,
      avatar_url: '',
      html_url: `/${VIEWER.login}`,
      type: 'User',
    });
    return true;
  }

  // /api/v3/user/repos
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'GET') {
      sendPage(res, req, store.listViewerRepos(VIEWER.login).map(repoJson), query);
      return true;
    }
    if (method === 'POST') {
      const name = typeof bodyObj.name === 'string' ? bodyObj.name.trim() : '';
      if (name === '') return sendError(res, 422, 'Validation Failed: name is required'), true;
      const description = typeof bodyObj.description === 'string' ? bodyObj.description : '';
      const isPrivate = bodyObj.private === true;
      const repo = store.createRepo(VIEWER.login, name, description, isPrivate);
      if (repo === null) return sendError(res, 422, `Validation Failed: name already exists on this account`), true;
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    return sendError(res, 404, 'Not Found'), true;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (seg.length >= 3 && seg[0] === 'repos') {
    return handleRepoRoute(req, res, seg.slice(1), query, bodyObj, method);
  }

  sendError(res, 404, 'Not Found');
  return true;
}

function repoOr404(res: ServerResponse, owner: string, name: string): Repo | null {
  const repo = store.getRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return null;
  }
  return repo;
}

async function handleRepoRoute(
  req: IncomingMessage,
  res: ServerResponse,
  seg: string[],
  query: URLSearchParams,
  bodyObj: Record<string, unknown>,
  method: string,
): Promise<boolean> {
  const [owner, name, ...rest] = seg;
  const repo = repoOr404(res, owner, name);
  if (!repo) return true;

  // The repository itself: GET / PATCH / DELETE.
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH') {
      if (typeof bodyObj.description === 'string') repo.description = bodyObj.description;
      if (typeof bodyObj.private === 'boolean') repo.private = bodyObj.private;
      repo.updatedAt = clock.nextIso();
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, name);
      sendEmpty(res, 204);
      return true;
    }
    return sendError(res, 404, 'Not Found'), true;
  }

  const head = rest[0];

  // GET /repos/{o}/{r}/branches and /branches/{branch}
  if (head === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => ({
          name: branch,
          commit: { sha: repo.refs.get(`refs/heads/${branch}`)! },
          protected: false,
        }));
      sendJson(res, 200, branches);
      return true;
    }
    if (method === 'GET' && rest.length === 2) {
      const sha = repo.refs.get(`refs/heads/${rest[1]}`);
      if (!sha) return sendError(res, 404, 'Branch not found'), true;
      sendJson(res, 200, { name: rest[1], commit: { sha }, protected: false });
      return true;
    }
    return sendError(res, 404, 'Not Found'), true;
  }

  // GET /repos/{o}/{r}/commits[?sha=]
  if (head === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const ref = query.get('sha');
      const tip = resolveRef(repo, ref);
      if (tip === null) return sendError(res, 404, 'No commit found for this ref'), true;
      const commits = listCommits(repo, tip).map((c) => {
        const parsed = parseCommit(getObject(repo, c.sha)!.data);
        return {
          sha: c.sha,
          node_id: globalId('Commit', c.sha),
          commit: {
            // GitHub returns the message without the trailing newline the object carries.
            message: parsed.message.replace(/\n+$/, ''),
            author: { name: VIEWER.name, email: VIEWER.email, date: new Date(c.sec * 1000).toISOString() },
            committer: { name: VIEWER.name, email: VIEWER.email, date: new Date(c.sec * 1000).toISOString() },
            tree: { sha: parsed.tree },
          },
          author: userJson(VIEWER.login, VIEWER.id),
          committer: userJson(VIEWER.login, VIEWER.id),
          parents: parsed.parents.map((p) => ({ sha: p })),
          url: `/api/v3/repos/${owner}/${name}/commits/${c.sha}`,
        };
      });
      sendPage(res, req, commits, query);
      return true;
    }
    return sendError(res, 404, 'Not Found'), true;
  }

  // POST /repos/{o}/{r}/git/refs and GET /git/refs[/heads/{branch}]
  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = typeof bodyObj.ref === 'string' ? bodyObj.ref : '';
      const sha = typeof bodyObj.sha === 'string' ? bodyObj.sha : '';
      if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) {
        return sendError(res, 422, 'Validation Failed: ref and sha are required'), true;
      }
      if (repo.refs.has(ref)) return sendError(res, 422, 'Validation Failed: Reference already exists'), true;
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, node_id: globalId('Ref', ref), object: { sha, type: 'commit' } });
      return true;
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = rest.slice(2).join('/');
      const sha = repo.refs.get(ref);
      if (!sha) return sendError(res, 404, 'Not Found'), true;
      sendJson(res, 200, { ref, node_id: globalId('Ref', ref), object: { sha, type: 'commit' } });
      return true;
    }
    return sendError(res, 404, 'Not Found'), true;
  }

  // /repos/{o}/{r}/contents/{path...}
  if (head === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') return handleContentsGet(req, res, repo, path, query);
    if (method === 'PUT') return handleContentsPut(res, repo, path, query, bodyObj);
    if (method === 'DELETE') return handleContentsDelete(res, repo, path, bodyObj);
    return sendError(res, 404, 'Not Found'), true;
  }

  // /repos/{o}/{r}/labels
  if (head === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      sendJson(res, 200, [...repo.labels.values()].map(labelJson));
      return true;
    }
    if (method === 'POST' && rest.length === 1) {
      const labelName = typeof bodyObj.name === 'string' ? bodyObj.name.trim() : '';
      if (labelName === '') return sendError(res, 422, 'Validation Failed: name is required'), true;
      if (repo.labels.has(labelName)) return sendError(res, 422, 'Validation Failed: label already exists'), true;
      const color = typeof bodyObj.color === 'string' ? bodyObj.color.replace(/^#/, '') : 'ededed';
      const description = typeof bodyObj.description === 'string' ? bodyObj.description : '';
      const label: Label = { name: labelName, color, description };
      repo.labels.set(labelName, label);
      sendJson(res, 201, labelJson(label));
      return true;
    }
    return sendError(res, 404, 'Not Found'), true;
  }

  // /repos/{o}/{r}/issues[/{n}[/comments]]
  if (head === 'issues') return handleIssues(req, res, repo, rest.slice(1), query, bodyObj, method);

  // /repos/{o}/{r}/pulls[/{n}[/files|merge]]
  if (head === 'pulls') return handlePulls(req, res, repo, rest.slice(1), query, bodyObj, method);

  return sendError(res, 404, 'Not Found'), true;
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

function handleContentsGet(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  path: string,
  query: URLSearchParams,
): boolean {
  const ref = query.get('ref');
  const tip = resolveRef(repo, ref);
  if (tip === null) return sendError(res, 404, 'Not Found'), true;
  const tree = treeOfCommit(repo, tip);
  if (path === '') {
    // The repository root, as a directory listing.
    const entries = treeListDir(repo, tree, '');
    sendJson(res, 200, entries.map((e) => ({
      type: e.mode === '40000' ? 'dir' : 'file',
      name: e.name,
      path: e.name,
      sha: e.oid,
      size: e.mode === '40000' ? 0 : getObject(repo, e.oid)?.data.length ?? 0,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${e.name}`,
    })));
    return true;
  }
  const entry = tree === null ? null : treeGet(repo, tree, path);
  if (!entry) return sendError(res, 404, 'Not Found'), true;
  const name = path.split('/').pop()!;
  if (entry.mode === '40000') {
    const entries = treeListDir(repo, tree, path);
    sendJson(res, 200, entries.map((e) => ({
      type: e.mode === '40000' ? 'dir' : 'file',
      name: e.name,
      path: `${path}/${e.name}`,
      sha: e.oid,
      size: e.mode === '40000' ? 0 : getObject(repo, e.oid)?.data.length ?? 0,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}/${e.name}`,
    })));
    return true;
  }
  const blob = getObject(repo, entry.oid);
  if (!blob) return sendError(res, 404, 'Not Found'), true;
  sendJson(res, 200, {
    type: 'file',
    encoding: 'base64',
    size: blob.data.length,
    name,
    path,
    content: blob.data.toString('base64'),
    sha: entry.oid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
  });
  return true;
}

function handleContentsPut(
  res: ServerResponse,
  repo: Repo,
  path: string,
  query: URLSearchParams,
  bodyObj: Record<string, unknown>,
): boolean {
  const message = typeof bodyObj.message === 'string' ? bodyObj.message : 'Update file';
  const contentB64 = typeof bodyObj.content === 'string' ? bodyObj.content : '';
  if (contentB64 === '') return sendError(res, 422, 'Validation Failed: content is required'), true;
  let content: Buffer;
  try {
    content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  } catch {
    return sendError(res, 422, 'Validation Failed: content is not valid base64'), true;
  }
  const branch = typeof bodyObj.branch === 'string' && bodyObj.branch !== '' ? bodyObj.branch : repo.defaultBranch;
  const sha = typeof bodyObj.sha === 'string' ? bodyObj.sha : undefined;
  const isUpdate = (() => {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (!tip) return false;
    const tree = treeOfCommit(repo, tip);
    return tree !== null && treeGet(repo, tree, path) !== null;
  })();
  const result = commitFile(repo, branch, path, content, message, sha);
  if ('error' in result) return sendError(res, result.status, result.error), true;
  sendJson(res, isUpdate ? 200 : 201, {
    content: { name: path.split('/').pop()!, path, sha: result.blobSha, size: content.length, encoding: 'base64' },
    commit: { sha: result.commitSha, message },
  });
  return true;
}

function handleContentsDelete(
  res: ServerResponse,
  repo: Repo,
  path: string,
  bodyObj: Record<string, unknown>,
): boolean {
  const message = typeof bodyObj.message === 'string' ? bodyObj.message : 'Delete file';
  const branch = typeof bodyObj.branch === 'string' && bodyObj.branch !== '' ? bodyObj.branch : repo.defaultBranch;
  const sha = typeof bodyObj.sha === 'string' ? bodyObj.sha : undefined;
  const result = deleteFile(repo, branch, path, message, sha);
  if ('error' in result) return sendError(res, result.status, result.error), true;
  sendJson(res, 200, { commit: { sha: result.commitSha, message } });
  return true;
}

// ---------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------

function parseLabelRefs(value: unknown): { names: string[]; ok: boolean } {
  if (value === undefined) return { names: [], ok: true };
  if (!Array.isArray(value)) return { names: [], ok: false };
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') names.push(item);
    else if (typeof item === 'object' && item !== null && typeof (item as Record<string, unknown>).name === 'string') {
      names.push((item as Record<string, unknown>).name as string);
    } else return { names: [], ok: false };
  }
  return { names, ok: true };
}

function handleIssues(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  seg: string[],
  query: URLSearchParams,
  bodyObj: Record<string, unknown>,
  method: string,
): boolean {
  // POST /issues and GET /issues (the collection).
  if (seg.length === 0) {
    if (method === 'POST') {
      const title = typeof bodyObj.title === 'string' ? bodyObj.title : '';
      if (title === '') return sendError(res, 422, 'Validation Failed: title is required'), true;
      const parsed = parseLabelRefs(bodyObj.labels);
      if (!parsed.ok) return sendError(res, 422, 'Validation Failed: labels must be an array'), true;
      const labels: Label[] = [];
      for (const labelName of parsed.names) {
        const label = repo.labels.get(labelName);
        if (!label) return sendError(res, 422, `Validation Failed: label "${labelName}" does not exist`), true;
        labels.push(label);
      }
      const body = typeof bodyObj.body === 'string' ? bodyObj.body : '';
      const now = clock.nextIso();
      const issue: Issue = {
        id: store.nextId(),
        number: repo.issues.length + 1,
        title,
        body,
        state: 'open',
        labels,
        comments: [],
        user: VIEWER.login,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      };
      repo.issues.push(issue);
      sendJson(res, 201, issueJson(repo, issue));
      return true;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let list = [...repo.issues];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      if (sort === 'created') {
        list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      }
      sendPage(res, req, list.map((i) => issueJson(repo, i)), query);
      return true;
    }
    return sendError(res, 404, 'Not Found'), true;
  }

  const number = Number.parseInt(seg[0], 10);
  if (!Number.isInteger(number)) return sendError(res, 404, 'Not Found'), true;
  const issue = repo.issues.find((i) => i.number === number);
  if (!issue) return sendError(res, 404, 'Not Found'), true;

  // GET / PATCH /issues/{n}
  if (seg.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return true;
    }
    if (method === 'PATCH') {
      if (typeof bodyObj.state === 'string' && (bodyObj.state === 'open' || bodyObj.state === 'closed')) {
        issue.state = bodyObj.state;
        issue.closedAt = bodyObj.state === 'closed' ? clock.nextIso() : null;
      }
      if (typeof bodyObj.title === 'string') issue.title = bodyObj.title;
      if (typeof bodyObj.body === 'string') issue.body = bodyObj.body;
      issue.updatedAt = clock.nextIso();
      sendJson(res, 200, issueJson(repo, issue));
      return true;
    }
    return sendError(res, 404, 'Not Found'), true;
  }

  // /issues/{n}/comments
  if (seg.length === 2 && seg[1] === 'comments') {
    if (method === 'POST') {
      const commentBody = typeof bodyObj.body === 'string' ? bodyObj.body : '';
      if (commentBody === '') return sendError(res, 422, 'Validation Failed: body is required'), true;
      const now = clock.nextIso();
      const comment = {
        id: store.nextId(),
        body: commentBody,
        user: VIEWER.login,
        createdAt: now,
        updatedAt: now,
      };
      issue.comments.push(comment);
      sendJson(res, 201, {
        id: comment.id,
        node_id: globalId('IssueComment', comment.id),
        body: comment.body,
        user: userJson(comment.user, 1000),
        created_at: comment.createdAt,
        updated_at: comment.updatedAt,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${number}/comments/${comment.id}`,
      });
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((c) => ({
        id: c.id,
        node_id: globalId('IssueComment', c.id),
        body: c.body,
        user: userJson(c.user, 1000),
        created_at: c.createdAt,
        updated_at: c.updatedAt,
      })));
      return true;
    }
    return sendError(res, 404, 'Not Found'), true;
  }

  return sendError(res, 404, 'Not Found'), true;
}

// ---------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------

/** Is the pull request mergeable (no file changed on both sides since the merge-base)? */
export function pullIsMergeable(repo: Repo, pull: Pull): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!baseTip) return false;
  const mergeBaseSha = pull.mergeBaseSha;
  if (mergeBaseSha === ZERO_OID || mergeBaseSha === null) return true;
  const baseTree = treeOfCommit(repo, baseTip);
  const mergeBaseTree = treeOfCommit(repo, mergeBaseSha);
  const headTree = treeOfCommit(repo, pull.headSha);
  const headChanges = diffTrees(repo, mergeBaseTree, headTree);
  const baseChanges = treeFlatten(repo, baseTree);
  const mergeBaseFiles = treeFlatten(repo, mergeBaseTree);
  for (const change of headChanges) {
    const atBase = baseChanges.get(change.path);
    const atMergeBase = mergeBaseFiles.get(change.path);
    const baseMoved = (atBase?.oid ?? null) !== (atMergeBase?.oid ?? null);
    const headDiffersFromBase = (change.newOid ?? null) !== (atBase?.oid ?? null);
    if (baseMoved && headDiffersFromBase) return false;
  }
  return true;
}

function pullFiles(repo: Repo, pull: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const mergeBaseTree = pull.mergeBaseSha === ZERO_OID ? null : treeOfCommit(repo, pull.mergeBaseSha);
  const headTree = treeOfCommit(repo, pull.headSha);
  const changes = diffTrees(repo, mergeBaseTree, headTree);
  return changes.map((change: FileChange) => {
    const newBlob = change.newOid ? getObject(repo, change.newOid) : undefined;
    const oldBlob = change.oldOid ? getObject(repo, change.oldOid) : undefined;
    const additions = change.status === 'removed' ? 0 : newBlob ? Math.max(1, lineCount(newBlob.data)) : 1;
    const deletions = change.status === 'added' ? 0 : oldBlob ? lineCount(oldBlob.data) : 0;
    return {
      filename: change.path,
      status: change.status === 'added' ? 'added' : change.status === 'removed' ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    };
  });
}

function handlePulls(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  seg: string[],
  query: URLSearchParams,
  bodyObj: Record<string, unknown>,
  method: string,
): boolean {
  // POST /pulls and GET /pulls (the collection).
  if (seg.length === 0) {
    if (method === 'POST') {
      const title = typeof bodyObj.title === 'string' ? bodyObj.title : '';
      const headRef = typeof bodyObj.head === 'string' ? bodyObj.head : '';
      const baseRef = typeof bodyObj.base === 'string' ? bodyObj.base : repo.defaultBranch;
      if (title === '' || headRef === '') return sendError(res, 422, 'Validation Failed: title and head are required'), true;
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (!headSha || !baseSha) return sendError(res, 422, 'Validation Failed: head or base branch does not exist'), true;
      const mergeBaseSha = mergeBase(repo, headSha, baseSha) ?? ZERO_OID;
      const now = clock.nextIso();
      const pull: Pull = {
        id: store.nextId(),
        number: repo.pulls.length + 1,
        title,
        body: typeof bodyObj.body === 'string' ? bodyObj.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef,
        baseRef,
        headSha,
        baseSha,
        mergeBaseSha,
        user: VIEWER.login,
        createdAt: now,
        updatedAt: now,
      };
      repo.pulls.push(pull);
      sendJson(res, 201, pullJson(repo, pull));
      return true;
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.pulls];
      if (state !== 'all') list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.number - a.number);
      sendPage(res, req, list.map((p) => pullJson(repo, p)), query);
      return true;
    }
    return sendError(res, 404, 'Not Found'), true;
  }

  const number = Number.parseInt(seg[0], 10);
  if (!Number.isInteger(number)) return sendError(res, 404, 'Not Found'), true;
  const pull = repo.pulls.find((p) => p.number === number);
  if (!pull) return sendError(res, 404, 'Not Found'), true;

  // GET /pulls/{n}
  if (seg.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, pullJson(repo, pull));
      return true;
    }
    return sendError(res, 404, 'Not Found'), true;
  }

  // GET /pulls/{n}/files
  if (seg.length === 2 && seg[1] === 'files') {
    if (method === 'GET') {
      sendJson(res, 200, pullFiles(repo, pull));
      return true;
    }
    return sendError(res, 404, 'Not Found'), true;
  }

  // GET /pulls/{n}/merge (204 when merged) and PUT /pulls/{n}/merge.
  if (seg.length === 2 && seg[1] === 'merge') {
    if (method === 'GET') {
      if (pull.merged) {
        res.writeHead(204, { 'x-github-request-id': nextRequestId() });
        res.end();
      } else {
        sendError(res, 404, 'Not Found');
      }
      return true;
    }
    if (method === 'PUT') {
      if (pull.state !== 'open' || pull.merged) {
        return sendError(res, 405, 'Pull Request is not mergeable'), true;
      }
      if (!pullIsMergeable(repo, pull)) {
        return sendError(res, 405, 'Merge conflict: the pull request is not mergeable'), true;
      }
      const merged = squashMerge(repo, pull);
      if ('error' in merged) return sendError(res, 405, merged.error), true;
      sendJson(res, 200, { sha: merged.sha, merged: true, message: 'Pull Request successfully merged' });
      return true;
    }
    return sendError(res, 404, 'Not Found'), true;
  }

  return sendError(res, 404, 'Not Found'), true;
}
