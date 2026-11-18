// The forge's whole state: repositories, git objects and refs, issues, pull requests,
// labels and comments — all in memory, all deterministic. No wall clock reaches the
// state: timestamps come from a counter seeded at the trial's opening time (or a fixed
// epoch locally), so two runs on the same request order leave identical state.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  isOid,
  parseCommit,
  parseTree,
  sortTreeEntries,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git.ts';
import { scenarioIdentities, type ScenarioUser } from './scenario.ts';

export const identities = scenarioIdentities();
export const VIEWER = identities.viewer;

/** A deterministic clock: one second per tick from the trial's opening time. */
export class Clock {
  #baseMs: number;
  #tick = 0;

  constructor() {
    const now = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = now === '' ? NaN : Date.parse(now);
    this.#baseMs = Number.isFinite(parsed) ? parsed : Date.parse('2025-01-01T00:00:00Z');
  }

  /** The next timestamp, as seconds since the epoch (git's author/committer format). */
  nextSec(): number {
    const sec = Math.floor(this.#baseMs / 1000) + this.#tick;
    this.#tick += 1;
    return sec;
  }

  /** The next timestamp, as an ISO-8601 UTC string (GitHub's created_at format). */
  nextIso(): string {
    return new Date(this.nextSec() * 1000).toISOString();
  }
}

export const clock = new Clock();

export function authorLine(user: ScenarioUser, sec: number): string {
  return `${user.name} <${user.email}> ${sec} +0000`;
}

export interface Label {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly user: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Issue {
  readonly id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Pull {
  readonly id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, Label>;
  readonly issues: Issue[];
  readonly pulls: Pull[];
  issueSeq: number;
  pullSeq: number;
  commentSeq: number;
  repoSeq: number;
}

/** Global node ids: opaque, stable, never the plain numeric id (GraphQL demands it). */
export function globalId(kind: string, id: number | string): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; value: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const at = text.indexOf(':');
    if (at <= 0) return null;
    return { kind: text.slice(0, at), value: text.slice(at + 1) };
  } catch {
    return null;
  }
}

let nextRepoId = 1;
let nextObjectId = 1;

export class Store {
  readonly repos = new Map<string, Repo>();

  static repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    const key = Store.repoKey(owner, name);
    if (this.repos.has(key)) return null;
    const now = clock.nextIso();
    const repo: Repo = {
      id: nextRepoId++,
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      issueSeq: 0,
      pullSeq: 0,
      commentSeq: 0,
      repoSeq: 0,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(Store.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(Store.repoKey(owner, name));
  }

  listViewerRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  nextId(): number {
    return nextObjectId++;
  }
}

export const store = new Store();

// ---------------------------------------------------------------------------
// git objects inside a repo
// ---------------------------------------------------------------------------

export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

/** The commit object at `oid`, parsed, or null when it is not a commit. */
export function getCommit(repo: Repo, oid: string) {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data);
}

/** Create a commit object (author/committer are the viewer) and store it. */
export function makeCommit(
  repo: Repo,
  tree: string,
  parents: readonly string[],
  message: string,
): string {
  const sec = clock.nextSec();
  const line = authorLine(VIEWER, sec);
  const data = buildCommit({
    tree,
    parents,
    message: message.endsWith('\n') ? message : `${message}\n`,
    author: line,
    committer: line,
  });
  return putObject(repo, 'commit', data);
}

/** The tree oid at a commit (null when the ref is unborn). */
export function treeOfCommit(repo: Repo, commitOid: string | null): string | null {
  if (commitOid === null) return null;
  const commit = getCommit(repo, commitOid);
  return commit ? commit.tree : null;
}

/** Is `ancestor` reachable from `descendant` (following parents)? Equal oids count. */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  if (ancestor === ZERO_OID) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = getCommit(repo, oid);
    if (!commit) continue;
    for (const parent of commit.parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** Every object reachable from the given tips (commits, trees, blobs, tags). */
export function collectReachable(repo: Repo, tips: Iterable<string>): Set<string> {
  const reachable = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (reachable.has(oid) || !isOid(oid) || oid === ZERO_OID) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    reachable.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const match = /^object ([0-9a-f]{40})$/m.exec(text);
      if (match) stack.push(match[1]);
    }
  }
  return reachable;
}

/** The merge-base of two commits: the first common ancestor found walking both histories. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestorsA = new Set<string>();
  const stackA = [a];
  while (stackA.length > 0) {
    const oid = stackA.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const commit = getCommit(repo, oid);
    if (commit) for (const parent of commit.parents) stackA.push(parent);
  }
  const stackB = [b];
  const seenB = new Set<string>();
  while (stackB.length > 0) {
    const oid = stackB.pop()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const commit = getCommit(repo, oid);
    if (commit) for (const parent of commit.parents) stackB.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------------------
// trees: read/write paths inside a tree, directory listings, diffs
// ---------------------------------------------------------------------------

/** The tree entry at `path` under `treeOid` (null tree = empty), or null when absent. */
export function treeGet(repo: Repo, treeOid: string | null, path: string): TreeEntry | null {
  if (treeOid === null) return null;
  const segments = path.split('/').filter((s) => s !== '');
  let current: string | null = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    if (current === null) return null;
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) return entry;
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/**
 * Return a new tree oid equal to `treeOid` with `path` set to (`mode`, `oid`), or removed
 * when `oid` is null. An empty tree is stored as the well-known empty-tree object.
 */
export function treeSet(repo: Repo, treeOid: string | null, path: string, mode: string, oid: string | null): string {
  const segments = path.split('/').filter((s) => s !== '');
  const setIn = (tree: string | null, depth: number): string | null => {
    const entries = tree === null ? [] : parseTree(repo.objects.get(tree)!.data);
    const name = segments[depth];
    const last = depth === segments.length - 1;
    const next: TreeEntry[] = [];
    let found = false;
    for (const entry of entries) {
      if (entry.name !== name) {
        next.push(entry);
        continue;
      }
      found = true;
      if (last) {
        if (oid !== null) next.push({ mode, name, oid });
      } else {
        const child = setIn(entry.oid, depth + 1);
        if (child !== null) next.push({ mode: '40000', name, oid: child });
      }
    }
    if (!found) {
      if (last) {
        if (oid !== null) next.push({ mode, name, oid });
      } else {
        const child = setIn(null, depth + 1);
        if (child !== null) next.push({ mode: '40000', name, oid: child });
      }
    }
    if (next.length === 0) return null;
    const sorted = sortTreeEntries(next);
    return putObject(repo, 'tree', buildTree(sorted));
  };
  const result = setIn(treeOid, 0);
  if (result === null) return putObject(repo, 'tree', buildTree([]));
  return result;
}

/** The direct children of directory `dir` under `treeOid` ('' = root). */
export function treeListDir(repo: Repo, treeOid: string | null, dir: string): TreeEntry[] {
  if (treeOid === null) return [];
  const segments = dir.split('/').filter((s) => s !== '');
  let current: string | null = treeOid;
  for (const segment of segments) {
    if (current === null) return [];
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tree') return [];
    const entry = parseTree(obj.data).find((e) => e.name === segment);
    if (!entry || entry.mode !== '40000') return [];
    current = entry.oid;
  }
  if (current === null) return [];
  const obj = repo.objects.get(current);
  if (!obj || obj.type !== 'tree') return [];
  return parseTree(obj.data);
}

/** Flatten a tree into path -> {mode, oid} for every blob (and submodule) it holds. */
export function treeFlatten(repo: Repo, treeOid: string | null, prefix = ''): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  if (treeOid === null) return out;
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [p, e] of treeFlatten(repo, entry.oid, path)) out.set(p, e);
    } else {
      out.set(path, entry);
    }
  }
  return out;
}

export interface FileChange {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly oldOid: string | null;
  readonly newOid: string | null;
}

/** The file-level diff between two trees (base -> head). */
export function diffTrees(repo: Repo, baseTree: string | null, headTree: string | null): FileChange[] {
  const base = treeFlatten(repo, baseTree);
  const head = treeFlatten(repo, headTree);
  const changes: FileChange[] = [];
  for (const [path, entry] of head) {
    const old = base.get(path);
    if (!old) changes.push({ path, status: 'added', oldOid: null, newOid: entry.oid });
    else if (old.oid !== entry.oid) changes.push({ path, status: 'modified', oldOid: old.oid, newOid: entry.oid });
  }
  for (const [path, entry] of base) {
    if (!head.has(path)) changes.push({ path, status: 'removed', oldOid: entry.oid, newOid: null });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return changes;
}

/** Commits reachable from `tip`, newest first (by author time, then oid for stability). */
export function listCommits(repo: Repo, tip: string): { sha: string; message: string; sec: number }[] {
  const seen = new Set<string>();
  const stack = [tip];
  const out: { sha: string; message: string; sec: number }[] = [];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = getCommit(repo, oid);
    if (!commit) continue;
    const authorSec = Number.parseInt(commit.author.trim().split(' ').at(-2) ?? '0', 10) || 0;
    out.push({ sha: oid, message: commit.message, sec: authorSec });
    for (const parent of commit.parents) stack.push(parent);
  }
  out.sort((a, b) => b.sec - a.sec || (a.sha < b.sha ? -1 : 1));
  return out;
}

/** Peel an annotated tag object to its commit, following tag objects. */
export function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.objects.get(current);
    if (!obj) return current;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const match = /^object ([0-9a-f]{40})$/m.exec(text);
      if (!match) return current;
      current = match[1];
      continue;
    }
    return current;
  }
  return current;
}

// ---------------------------------------------------------------------------
// squash merge (shared by REST, GraphQL and MCP)
// ---------------------------------------------------------------------------

/**
 * Squash-merge a pull request onto its base branch: apply the head's diff
 * (merge-base -> head) onto the base tip's tree, commit it with the base tip as
 * its only parent, move the base ref, and close the pull request. Returns the
 * merge commit sha, or an error string when the pull cannot merge.
 */
export function squashMerge(repo: Repo, pull: Pull): { sha: string } | { error: string } {
  if (pull.state !== 'open' || pull.merged) return { error: 'Pull Request is not mergeable' };
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!baseTip) return { error: 'Base branch not found' };
  const baseTree = treeOfCommit(repo, baseTip);
  const mergeBaseTree = pull.mergeBaseSha === ZERO_OID ? null : treeOfCommit(repo, pull.mergeBaseSha);
  const headTree = treeOfCommit(repo, pull.headSha);
  const changes = diffTrees(repo, mergeBaseTree, headTree);
  let newTree = baseTree;
  for (const change of changes) {
    newTree = treeSet(repo, newTree, change.path, '100644', change.newOid);
  }
  const mergeSha = makeCommit(repo, newTree, [baseTip], `${pull.title} (#${pull.number})`);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = clock.nextIso();
  pull.mergeCommitSha = mergeSha;
  pull.updatedAt = clock.nextIso();
  repo.updatedAt = clock.nextIso();
  return { sha: mergeSha };
}
