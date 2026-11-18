// GitHub GraphQL v4 (POST /api/graphql): a small hand-written executor for the documents
// gh and github-mcp-server actually send. No GraphQL library is available (stdlib only),
// so this is a lexer + recursive-descent parser + resolver over the store. Unknown fields
// answer HTTP 200 with an errors array naming the field; unknown repositories answer
// data.repository = null with no errors; unauthenticated requests are exactly 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { hasAuth, readBody, sendError, sendJson } from './httputil.ts';
import {
  VIEWER,
  clock,
  decodeGlobalId,
  diffTrees,
  getObject,
  globalId,
  listCommits,
  makeCommit,
  mergeBase,
  squashMerge,
  store,
  treeOfCommit,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { pullIsMergeable } from './rest.ts';
import { treeSet } from './store.ts';

// ---------------------------------------------------------------------------
// schema: the fields each type answers (drives validation + introspection)
// ---------------------------------------------------------------------------

const SCHEMA: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt', 'isPrivate', 'fork'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'url'],
  IssueConnection: ['nodes', 'totalCount', 'pageInfo'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'createdAt', 'updatedAt', 'mergedAt', 'author', 'url', 'headRefOid', 'baseRefOid'],
  PullRequestConnection: ['nodes', 'totalCount', 'pageInfo'],
  FileConnection: ['nodes', 'totalCount', 'pageInfo'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Schema: ['types'],
  __Field: ['name'],
  __EnumValue: ['name'],
  User: ['login', 'id', 'name'],
  Ref: ['name', 'target'],
  GitObject: ['oid'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Label: ['name', 'color', 'description'],
  IssueComment: ['id', 'body'],
  IssueCommentEdge: ['node'],
  AddCommentPayload: ['commentEdge'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
};

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

const INTROSPECTION_TYPES = [...Object.keys(SCHEMA), ...Object.keys(ENUM_VALUES)];

// ---------------------------------------------------------------------------
// lexer + parser (GraphQL documents, the subset the suite sends)
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():!=$@[]'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      tokens.push({ kind: 'int', value: Number.parseInt(input.slice(i, j), 10) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_A-Za-z0-9]/.test(input[j])) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

interface Selection {
  readonly kind: 'field' | 'fragment';
  readonly name: string;
  readonly alias: string | null;
  readonly args: Record<string, unknown>;
  readonly selections: Selection[];
  readonly typeCondition: string | null;
}

interface Operation {
  readonly kind: 'query' | 'mutation';
  readonly name: string | null;
  readonly variables: Record<string, unknown>;
  readonly selections: Selection[];
}

class Parser {
  #tokens: Token[];
  #pos = 0;

  constructor(tokens: Token[]) {
    this.#tokens = tokens;
  }

  #peek(): Token {
    return this.#tokens[this.#pos];
  }

  #next(): Token {
    return this.#tokens[this.#pos++];
  }

  #expectPunct(value: string): void {
    const tok = this.#next();
    if (tok.kind !== 'punct' || tok.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  #expectName(): string {
    const tok = this.#next();
    if (tok.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return tok.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.#peek().kind !== 'eof') {
      const tok = this.#peek();
      if (tok.kind === 'punct' && tok.value === '{') {
        operations.push({ kind: 'query', name: null, variables: {}, selections: this.#parseSelections() });
        continue;
      }
      if (tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation')) {
        this.#next();
        const kind = tok.value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.#peek().kind === 'name') name = this.#next().value as string;
        let variables: Record<string, unknown> = {};
        if (this.#peek().kind === 'punct' && this.#peek().value === '(') variables = this.#parseVariableDefinitions();
        operations.push({ kind, name, variables, selections: this.#parseSelections() });
        continue;
      }
      if (tok.kind === 'name' && tok.value === 'fragment') {
        // Named fragments are not used by the suite's documents; skip the definition.
        this.#next();
        this.#expectName();
        if (this.#peek().kind === 'name' && this.#peek().value === 'on') {
          this.#next();
          this.#expectName();
        }
        this.#parseSelections();
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(tok)} in GraphQL document`);
    }
    return operations;
  }

  #parseVariableDefinitions(): Record<string, unknown> {
    this.#expectPunct('(');
    const vars: Record<string, unknown> = {};
    while (!(this.#peek().kind === 'punct' && this.#peek().value === ')')) {
      this.#expectPunct('$');
      const name = this.#expectName();
      this.#expectPunct(':');
      this.#parseType();
      if (this.#peek().kind === 'punct' && this.#peek().value === '=') {
        this.#next();
        this.#parseValue();
      }
      vars[name] = null;
    }
    this.#expectPunct(')');
    return vars;
  }

  #parseType(): void {
    const tok = this.#peek();
    if (tok.kind === 'punct' && tok.value === '[') {
      this.#next();
      this.#parseType();
      this.#expectPunct(']');
    } else {
      this.#expectName();
    }
    if (this.#peek().kind === 'punct' && this.#peek().value === '!') this.#next();
  }

  #parseSelections(): Selection[] {
    this.#expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.#peek().kind === 'punct' && this.#peek().value === '}')) {
      selections.push(this.#parseSelection());
    }
    this.#expectPunct('}');
    return selections;
  }

  #parseSelection(): Selection {
    const tok = this.#peek();
    if (tok.kind === 'punct' && tok.value === '...') {
      this.#next();
      let typeCondition: string | null = null;
      if (this.#peek().kind === 'name' && this.#peek().value === 'on') {
        this.#next();
        typeCondition = this.#expectName();
      }
      const selections = this.#parseSelections();
      return { kind: 'fragment', name: '', alias: null, args: {}, selections, typeCondition };
    }
    let name = this.#expectName();
    let alias: string | null = null;
    if (this.#peek().kind === 'punct' && this.#peek().value === ':') {
      this.#next();
      alias = name;
      name = this.#expectName();
    }
    let args: Record<string, unknown> = {};
    if (this.#peek().kind === 'punct' && this.#peek().value === '(') args = this.#parseArguments();
    // Directives (@...) are skipped; the suite's documents use none.
    while (this.#peek().kind === 'punct' && this.#peek().value === '@') {
      this.#next();
      this.#expectName();
      if (this.#peek().kind === 'punct' && this.#peek().value === '(') this.#parseArguments();
    }
    let selections: Selection[] = [];
    if (this.#peek().kind === 'punct' && this.#peek().value === '{') selections = this.#parseSelections();
    return { kind: 'field', name, alias, args, selections, typeCondition: null };
  }

  #parseArguments(): Record<string, unknown> {
    this.#expectPunct('(');
    const args: Record<string, unknown> = {};
    while (!(this.#peek().kind === 'punct' && this.#peek().value === ')')) {
      const name = this.#expectName();
      this.#expectPunct(':');
      args[name] = this.#parseValue();
    }
    this.#expectPunct(')');
    return args;
  }

  #parseValue(): unknown {
    const tok = this.#next();
    if (tok.kind === 'punct' && tok.value === '$') return { __var: this.#expectName() };
    if (tok.kind === 'punct' && tok.value === '[') {
      const items: unknown[] = [];
      while (!(this.#peek().kind === 'punct' && this.#peek().value === ']')) items.push(this.#parseValue());
      this.#expectPunct(']');
      return items;
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const obj: Record<string, unknown> = {};
      while (!(this.#peek().kind === 'punct' && this.#peek().value === '}')) {
        const name = this.#expectName();
        this.#expectPunct(':');
        obj[name] = this.#parseValue();
      }
      this.#expectPunct('}');
      return obj;
    }
    if (tok.kind === 'string') return tok.value;
    if (tok.kind === 'int') return tok.value;
    if (tok.kind === 'name') {
      if (tok.value === 'true') return true;
      if (tok.value === 'false') return false;
      if (tok.value === 'null') return null;
      return { __enum: tok.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(tok)}`);
  }
}

/** Resolve variables / enums in a parsed value against the request's variables. */
function resolveValue(value: unknown, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object') {
    if ('__var' in (value as Record<string, unknown>)) {
      return variables[(value as { __var: string }).__var] ?? null;
    }
    if ('__enum' in (value as Record<string, unknown>)) {
      return (value as { __enum: string }).__enum;
    }
    if (Array.isArray(value)) return value.map((v) => resolveValue(v, variables));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveValue(v, variables);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

interface TypedValue {
  readonly type: string;
  readonly value: unknown;
}

interface ExecContext {
  readonly variables: Record<string, unknown>;
  readonly errors: { message: string }[];
}

function isRepoValue(value: unknown): value is Repo {
  return typeof value === 'object' && value !== null && 'defaultBranch' in (value as Record<string, unknown>);
}

function isIssueValue(value: unknown): value is { repo: Repo; issue: Issue } {
  return typeof value === 'object' && value !== null && 'issue' in (value as Record<string, unknown>);
}

function isPullValue(value: unknown): value is { repo: Repo; pull: Pull } {
  return typeof value === 'object' && value !== null && 'pull' in (value as Record<string, unknown>);
}

/** Resolve one field of a typed value. Unknown fields record an error and yield null. */
function resolveField(ctx: ExecContext, typed: TypedValue, sel: Selection): TypedValue {
  const { type, value } = typed;
  const field = sel.name;
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sel.args)) args[k] = resolveValue(v, ctx.variables);

  if (field === '__typename') return { type: 'String', value: type };

  const known = SCHEMA[type] ?? [];
  if (!known.includes(field)) {
    ctx.errors.push({ message: `Cannot query field "${field}" on type "${type}".` });
    return { type: 'Unknown', value: null };
  }

  // Introspection.
  if (type === 'Query' && field === '__type') {
    const name = args.name as string;
    if (typeof name !== 'string' || !INTROSPECTION_TYPES.includes(name)) return { type: '__Type', value: null };
    return { type: '__Type', value: { name, kind: ENUM_VALUES[name] ? 'ENUM' : 'OBJECT' } };
  }
  if (type === 'Query' && field === '__schema') {
    return { type: '__Schema', value: { types: INTROSPECTION_TYPES.map((n) => ({ name: n })) } };
  }
  if (type === '__Schema' && field === 'types') {
    return { type: 'FieldList', value: (value as { types: unknown[] }).types };
  }
  if (type === '__Type' && field === 'fields') {
    const typeName = (value as { name: string }).name;
    const fields = SCHEMA[typeName] ?? [];
    return { type: 'FieldList', value: fields.map((name) => ({ name })) };
  }
  if (type === '__Type' && field === 'enumValues') {
    const typeName = (value as { name: string }).name;
    const values = ENUM_VALUES[typeName] ?? [];
    return { type: 'EnumList', value: values.map((name) => ({ name })) };
  }
  if (type === '__Type' && field === 'name') return { type: 'String', value: (value as { name: string }).name };
  if (type === '__Type' && field === 'kind') return { type: 'String', value: (value as { kind: string }).kind };
  if (type === '__Field' && field === 'name') return { type: 'String', value: (value as { name: string }).name };
  if (type === '__EnumValue' && field === 'name') return { type: 'String', value: (value as { name: string }).name };

  // Query root.
  if (type === 'Query' && field === 'viewer') {
    return { type: 'User', value: { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name } };
  }
  if (type === 'Query' && field === 'repository') {
    const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
    return { type: 'Repository', value: repo ?? null };
  }
  if (type === 'Query' && field === 'node') {
    const decoded = typeof args.id === 'string' ? decodeGlobalId(args.id) : null;
    if (!decoded) return { type: 'Node', value: null };
    if (decoded.kind === 'Repository') {
      const id = Number.parseInt(decoded.value, 10);
      for (const repo of store.repos.values()) if (repo.id === id) return { type: 'Repository', value: repo };
      return { type: 'Node', value: null };
    }
    if (decoded.kind === 'Issue') {
      const [repoId, number] = decoded.value.split(':');
      for (const repo of store.repos.values()) {
        if (repo.id === Number.parseInt(repoId, 10)) {
          const issue = repo.issues.find((i) => i.number === Number.parseInt(number, 10));
          if (issue) return { type: 'Issue', value: { repo, issue } };
        }
      }
      return { type: 'Node', value: null };
    }
    if (decoded.kind === 'PullRequest') {
      const [repoId, number] = decoded.value.split(':');
      for (const repo of store.repos.values()) {
        if (repo.id === Number.parseInt(repoId, 10)) {
          const pull = repo.pulls.find((p) => p.number === Number.parseInt(number, 10));
          if (pull) return { type: 'PullRequest', value: { repo, pull } };
        }
      }
      return { type: 'Node', value: null };
    }
    return { type: 'Node', value: null };
  }

  // Repository fields.
  if (type === 'Repository' && isRepoValue(value)) {
    const repo = value as Repo;
    switch (field) {
      case 'id': return { type: 'ID', value: globalId('Repository', repo.id) };
      case 'databaseId': return { type: 'Int', value: repo.id };
      case 'name': return { type: 'String', value: repo.name };
      case 'nameWithOwner': return { type: 'String', value: `${repo.owner}/${repo.name}` };
      case 'owner': return { type: 'User', value: { login: repo.owner, id: 1000, name: repo.owner } };
      case 'defaultBranchRef': {
        const sha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return { type: 'Ref', value: sha ? { name: repo.defaultBranch, sha } : null };
      }
      case 'viewerPermission': return { type: 'String', value: 'ADMIN' };
      case 'hasIssuesEnabled': return { type: 'Boolean', value: true };
      case 'description': return { type: 'String', value: repo.description };
      case 'url': return { type: 'String', value: `/${repo.owner}/${repo.name}` };
      case 'createdAt': return { type: 'String', value: repo.createdAt };
      case 'updatedAt': return { type: 'String', value: repo.updatedAt };
      case 'isPrivate': return { type: 'Boolean', value: repo.private };
      case 'fork': return { type: 'Boolean', value: false };
      case 'issue': {
        const number = args.number as number;
        const issue = repo.issues.find((i) => i.number === number);
        return { type: 'Issue', value: issue ? { repo, issue } : null };
      }
      case 'issues': return { type: 'IssueConnection', value: issueConnection(repo, args) };
      case 'pullRequests': return { type: 'PullRequestConnection', value: pullConnection(repo, args) };
      case 'pullRequest': {
        const number = args.number as number;
        const pull = repo.pulls.find((p) => p.number === number);
        return { type: 'PullRequest', value: pull ? { repo, pull } : null };
      }
    }
  }

  // Issue fields.
  if (type === 'Issue' && isIssueValue(value)) {
    const { repo, issue } = value as { repo: Repo; issue: Issue };
    switch (field) {
      case 'id': return { type: 'ID', value: globalId('Issue', `${repo.id}:${issue.number}`) };
      case 'number': return { type: 'Int', value: issue.number };
      case 'title': return { type: 'String', value: issue.title };
      case 'state': return { type: 'String', value: issue.state.toUpperCase() };
      case 'body': return { type: 'String', value: issue.body };
      case 'createdAt': return { type: 'String', value: issue.createdAt };
      case 'updatedAt': return { type: 'String', value: issue.updatedAt };
      case 'closedAt': return { type: 'String', value: issue.closedAt };
      case 'author': return { type: 'User', value: { login: issue.user, id: 1000, name: issue.user } };
      case 'labels': return { type: 'LabelList', value: issue.labels.map((l) => ({ name: l.name, color: l.color, description: l.description })) };
      case 'comments': return { type: 'CommentList', value: issue.comments.map((c) => ({ id: c.id, body: c.body })) };
      case 'url': return { type: 'String', value: `/${repo.owner}/${repo.name}/issues/${issue.number}` };
    }
  }

  // PullRequest fields.
  if (type === 'PullRequest' && isPullValue(value)) {
    const { repo, pull } = value as { repo: Repo; pull: Pull };
    switch (field) {
      case 'id': return { type: 'ID', value: globalId('PullRequest', `${repo.id}:${pull.number}`) };
      case 'number': return { type: 'Int', value: pull.number };
      case 'title': return { type: 'String', value: pull.title };
      case 'body': return { type: 'String', value: pull.body };
      case 'state': return { type: 'String', value: pull.merged ? 'MERGED' : pull.state.toUpperCase() };
      case 'merged': return { type: 'Boolean', value: pull.merged };
      case 'headRefName': return { type: 'String', value: pull.headRef };
      case 'baseRefName': return { type: 'String', value: pull.baseRef };
      case 'mergeable': return { type: 'String', value: pullIsMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING' };
      case 'files': {
        const first = typeof args.first === 'number' ? args.first : 100;
        const mergeBaseTree = pull.mergeBaseSha === '0000000000000000000000000000000000000000' ? null : treeOfCommit(repo, pull.mergeBaseSha);
        const headTree = treeOfCommit(repo, pull.headSha);
        const changes = diffTrees(repo, mergeBaseTree, headTree).slice(0, first);
        return { type: 'FileConnection', value: changes.map((c) => ({ path: c.path, additions: 0, deletions: 0, changeType: c.status.toUpperCase() })) };
      }
      case 'createdAt': return { type: 'String', value: pull.createdAt };
      case 'updatedAt': return { type: 'String', value: pull.updatedAt };
      case 'mergedAt': return { type: 'String', value: pull.mergedAt };
      case 'author': return { type: 'User', value: { login: pull.user, id: 1000, name: pull.user } };
      case 'url': return { type: 'String', value: `/${repo.owner}/${repo.name}/pull/${pull.number}` };
      case 'headRefOid': return { type: 'String', value: pull.headSha };
      case 'baseRefOid': return { type: 'String', value: pull.baseSha };
    }
  }

  // User / Ref / scalar containers.
  if (type === 'User') {
    const user = value as { login: string; id: number; name: string };
    if (field === 'login') return { type: 'String', value: user.login };
    if (field === 'id') return { type: 'ID', value: globalId('User', user.id) };
    if (field === 'name') return { type: 'String', value: user.name };
  }
  if (type === 'Ref') {
    const ref = value as { name: string; sha: string };
    if (field === 'name') return { type: 'String', value: ref.name };
    if (field === 'target') return { type: 'GitObject', value: { oid: ref.sha } };
  }
  if (type === 'GitObject') {
    const obj = value as { oid: string };
    if (field === 'oid') return { type: 'String', value: obj.oid };
  }
  if (type === 'PageInfo') {
    const info = value as { hasNextPage: boolean; hasPreviousPage: boolean; endCursor: string | null; startCursor: string | null };
    if (field === 'hasNextPage') return { type: 'Boolean', value: info.hasNextPage };
    if (field === 'hasPreviousPage') return { type: 'Boolean', value: info.hasPreviousPage };
    if (field === 'endCursor') return { type: 'String', value: info.endCursor };
    if (field === 'startCursor') return { type: 'String', value: info.startCursor };
  }
  if (type === 'IssueConnection' || type === 'PullRequestConnection') {
    const conn = value as { nodes: unknown[]; pageInfo: unknown };
    if (field === 'nodes') return { type: 'NodeList', value: conn.nodes };
    if (field === 'totalCount') return { type: 'Int', value: conn.nodes.length };
    if (field === 'pageInfo') return { type: 'PageInfo', value: conn.pageInfo };
  }
  if (type === 'FileConnection') {
    const files = value as { path: string }[];
    if (field === 'nodes') return { type: 'NodeList', value: files };
  }
  if (type === 'PullRequestChangedFile') {
    const file = value as { path: string; additions: number; deletions: number; changeType: string };
    if (field === 'path') return { type: 'String', value: file.path };
    if (field === 'additions') return { type: 'Int', value: file.additions };
    if (field === 'deletions') return { type: 'Int', value: file.deletions };
    if (field === 'changeType') return { type: 'String', value: file.changeType };
  }
  if (type === 'Label') {
    const label = value as { name: string; color: string; description: string };
    if (field === 'name') return { type: 'String', value: label.name };
    if (field === 'color') return { type: 'String', value: label.color };
    if (field === 'description') return { type: 'String', value: label.description };
  }
  if (type === 'IssueComment') {
    const comment = value as { id: number; body: string };
    if (field === 'id') return { type: 'ID', value: globalId('IssueComment', comment.id) };
    if (field === 'body') return { type: 'String', value: comment.body };
  }

  ctx.errors.push({ message: `Cannot query field "${field}" on type "${type}".` });
  return { type: 'Unknown', value: null };
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

function issueConnection(repo: Repo, args: Record<string, unknown>) {
  let list = [...repo.issues];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    list = list.filter((i) => wanted.has(i.state.toUpperCase()));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const direction = orderBy?.direction === 'ASC' ? 1 : -1;
  // CREATED_AT order is the creation order, which is the issue number here.
  list.sort((a, b) => direction * (a.number - b.number));
  const after = decodeCursor(args.after);
  if (after !== null) {
    list = list.filter((i) => (direction === 1 ? i.number > after : i.number < after));
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  const hasNextPage = list.length > page.length;
  const last = page[page.length - 1];
  return {
    nodes: page.map((issue) => ({ repo, issue })),
    pageInfo: {
      hasNextPage,
      hasPreviousPage: after !== null,
      endCursor: last ? encodeCursor(last.number) : null,
      startCursor: page[0] ? encodeCursor(page[0].number) : null,
    },
  };
}

function pullConnection(repo: Repo, args: Record<string, unknown>) {
  const first = typeof args.first === 'number' ? args.first : 100;
  const list = [...repo.pulls].sort((a, b) => b.number - a.number).slice(0, first);
  return {
    nodes: list.map((pull) => ({ repo, pull })),
    pageInfo: { hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null },
  };
}

/** Execute a selection set against a typed value, building the response object. */
function executeSelections(ctx: ExecContext, typed: TypedValue, selections: Selection[]): Record<string, unknown> | null {
  if (typed.value === null || typed.value === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition !== null && sel.typeCondition !== typed.type) continue;
      const inner = executeSelections(ctx, typed, sel.selections);
      if (inner) Object.assign(out, inner);
      continue;
    }
    const isPayload = typed.type.endsWith('Payload') || typed.type === 'IssueCommentEdge';
    const resolved = isPayload ? resolvePayloadField(ctx, typed, sel) : resolveField(ctx, typed, sel);
    const key = sel.alias ?? sel.name;
    out[key] = executeValue(ctx, resolved, sel.selections);
  }
  return out;
}

function executeValue(ctx: ExecContext, resolved: TypedValue, selections: Selection[]): unknown {
  const { type, value } = resolved;
  if (value === null || value === undefined) return null;
  if (selections.length === 0) return value;
  if (type === 'NodeList' || type === 'FieldList' || type === 'EnumList' || type === 'LabelList' || type === 'CommentList') {
    const items = value as unknown[];
    const itemType =
      type === 'FieldList' ? '__Field' : type === 'EnumList' ? '__EnumValue' : type === 'LabelList' ? 'Label' : type === 'CommentList' ? 'IssueComment' : inferNodeItemType(items);
    return items.map((item) => executeSelections(ctx, { type: itemType, value: item }, selections));
  }
  if (type === '__Field') {
    const out: Record<string, unknown> = {};
    for (const sel of selections) if (sel.name === 'name') out[sel.alias ?? sel.name] = (value as { name: string }).name;
    return out;
  }
  if (type === '__EnumValue') {
    const out: Record<string, unknown> = {};
    for (const sel of selections) if (sel.name === 'name') out[sel.alias ?? sel.name] = (value as { name: string }).name;
    return out;
  }
  return executeSelections(ctx, resolved, selections);
}

function inferNodeItemType(items: unknown[]): string {
  const first = items[0] as Record<string, unknown> | undefined;
  if (!first || typeof first !== 'object') return 'Unknown';
  if ('issue' in first) return 'Issue';
  if ('pull' in first) return 'PullRequest';
  if ('path' in first) return 'PullRequestChangedFile';
  return 'Unknown';
}

// ---------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------

function findRepoByGlobalId(id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Repository') return null;
  const dbId = Number.parseInt(decoded.value, 10);
  for (const repo of store.repos.values()) if (repo.id === dbId) return repo;
  return null;
}

function findIssueByGlobalId(id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Issue') return null;
  const [repoId, number] = decoded.value.split(':');
  for (const repo of store.repos.values()) {
    if (repo.id === Number.parseInt(repoId, 10)) {
      const issue = repo.issues.find((i) => i.number === Number.parseInt(number, 10));
      if (issue) return { repo, issue };
    }
  }
  return null;
}

function findPullByGlobalId(id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'PullRequest') return null;
  const [repoId, number] = decoded.value.split(':');
  for (const repo of store.repos.values()) {
    if (repo.id === Number.parseInt(repoId, 10)) {
      const pull = repo.pulls.find((p) => p.number === Number.parseInt(number, 10));
      if (pull) return { repo, pull };
    }
  }
  return null;
}

function executeMutation(ctx: ExecContext, sel: Selection): unknown {
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sel.args)) args[k] = resolveValue(v, ctx.variables);
  const input = (args.input ?? {}) as Record<string, unknown>;

  if (sel.name === 'createIssue') {
    const repo = findRepoByGlobalId(input.repositoryId);
    if (!repo) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
      return null;
    }
    const title = typeof input.title === 'string' ? input.title : '';
    const now = clock.nextIso();
    const issue: Issue = {
      id: store.nextId(),
      number: repo.issues.length + 1,
      title,
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      comments: [],
      user: VIEWER.login,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    repo.issues.push(issue);
    return executeSelections(ctx, { type: 'CreateIssuePayload', value: { issue: { repo, issue } } }, sel.selections);
  }

  if (sel.name === 'closeIssue') {
    const found = findIssueByGlobalId(input.issueId);
    if (!found) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
      return null;
    }
    found.issue.state = 'closed';
    found.issue.closedAt = clock.nextIso();
    found.issue.updatedAt = clock.nextIso();
    return executeSelections(ctx, { type: 'CloseIssuePayload', value: { issue: found } }, sel.selections);
  }

  if (sel.name === 'createPullRequest') {
    const repo = findRepoByGlobalId(input.repositoryId);
    if (!repo) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
      return null;
    }
    const headRef = String(input.headRefName ?? '');
    const baseRef = String(input.baseRefName ?? repo.defaultBranch);
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (!headSha || !baseSha) {
      ctx.errors.push({ message: 'Head or base ref does not exist.' });
      return null;
    }
    const now = clock.nextIso();
    const pull: Pull = {
      id: store.nextId(),
      number: repo.pulls.length + 1,
      title: typeof input.title === 'string' ? input.title : '',
      body: typeof input.body === 'string' ? input.body : '',
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
    return executeSelections(ctx, { type: 'CreatePullRequestPayload', value: { pullRequest: { repo, pull } } }, sel.selections);
  }

  if (sel.name === 'mergePullRequest') {
    const found = findPullByGlobalId(input.pullRequestId);
    if (!found) {
      ctx.errors.push({ message: 'Could not resolve to a PullRequest with the global id.' });
      return null;
    }
    const { repo, pull } = found;
    if (pull.state !== 'open' || pull.merged) {
      ctx.errors.push({ message: 'Pull request is not open.' });
      return null;
    }
    if (!pullIsMergeable(repo, pull)) {
      ctx.errors.push({ message: 'Pull request is not mergeable.' });
      return null;
    }
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (!baseTip) {
      ctx.errors.push({ message: 'Base branch not found.' });
      return null;
    }
    const merged = squashMerge(repo, pull);
    if ('error' in merged) {
      ctx.errors.push({ message: merged.error });
      return null;
    }
    return executeSelections(ctx, { type: 'MergePullRequestPayload', value: { pullRequest: { repo, pull } } }, sel.selections);
  }

  if (sel.name === 'addComment') {
    const found = findIssueByGlobalId(input.subjectId);
    if (!found) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
      return null;
    }
    const now = clock.nextIso();
    const comment = { id: store.nextId(), body: typeof input.body === 'string' ? input.body : '', user: VIEWER.login, createdAt: now, updatedAt: now };
    found.issue.comments.push(comment);
    return executeSelections(ctx, { type: 'AddCommentPayload', value: { commentEdge: { node: comment } } }, sel.selections);
  }

  ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "Mutation".` });
  return null;
}

// Payload field resolution: the payload objects above carry their inner value.
function resolvePayloadField(ctx: ExecContext, typed: TypedValue, sel: Selection): TypedValue {
  const { type, value } = typed;
  const record = value as Record<string, unknown>;
  if (type === 'CreateIssuePayload' || type === 'CloseIssuePayload') {
    if (sel.name === 'issue') return { type: 'Issue', value: record.issue };
  }
  if (type === 'CreatePullRequestPayload' || type === 'MergePullRequestPayload') {
    if (sel.name === 'pullRequest') return { type: 'PullRequest', value: record.pullRequest };
  }
  if (type === 'AddCommentPayload') {
    if (sel.name === 'commentEdge') return { type: 'IssueCommentEdge', value: record.commentEdge };
  }
  if (type === 'IssueCommentEdge') {
    if (sel.name === 'node') return { type: 'IssueComment', value: record.node };
  }
  ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${type}".` });
  return { type: 'Unknown', value: null };
}

// ---------------------------------------------------------------------------
// operation execution + HTTP entry point
// ---------------------------------------------------------------------------

function executeOperation(operation: Operation, variables: Record<string, unknown>): { data: unknown; errors?: { message: string }[] } {
  const ctx: ExecContext = { variables, errors: [] };
  if (operation.kind === 'mutation') {
    const out: Record<string, unknown> = {};
    for (const sel of operation.selections) {
      if (sel.kind === 'fragment') continue;
      const key = sel.alias ?? sel.name;
      if (!SCHEMA.Mutation.includes(sel.name)) {
        ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "Mutation".` });
        out[key] = null;
        continue;
      }
      out[key] = executeMutation(ctx, sel);
    }
    const body: { data: unknown; errors?: { message: string }[] } = { data: out };
    if (ctx.errors.length > 0) body.errors = ctx.errors;
    return body;
  }
  const data = executeSelections(ctx, { type: 'Query', value: {} }, operation.selections);
  const body: { data: unknown; errors?: { message: string }[] } = { data: ctx.errors.length > 0 ? null : data };
  if (ctx.errors.length > 0) body.errors = ctx.errors;
  return body;
}

function executeOne(body: unknown): { data: unknown; errors?: { message: string }[] } | { __parseError: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { __parseError: 'GraphQL request body must be a JSON object with query and variables' };
  }
  const record = body as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { __parseError: 'GraphQL request needs a query string' };
  }
  const variables = (record.variables ?? {}) as Record<string, unknown>;
  let operations: Operation[];
  try {
    operations = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'failed to parse the query' }] };
  }
  if (operations.length === 0) return { data: null, errors: [{ message: 'the query holds no operation' }] };
  let operation = operations[0];
  const operationName = record.operationName;
  if (typeof operationName === 'string' && operationName !== '') {
    operation = operations.find((op) => op.name === operationName) ?? operation;
  }
  return executeOperation(operation, variables);
}

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!hasAuth(req)) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }
  if ((req.method ?? 'GET') !== 'POST') {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const parsed = await readBody(req);
  if (parsed.malformed || parsed.empty) {
    sendError(res, 400, 'Problems parsing JSON');
    return true;
  }
  const body = parsed.json;
  if (Array.isArray(body)) {
    // Batched operations: one envelope per operation, in request order.
    const responses = body.map((op) => {
      const result = executeOne(op);
      if ('__parseError' in result) return { data: null, errors: [{ message: result.__parseError }] };
      return result;
    });
    sendJson(res, 200, responses);
    return true;
  }
  const result = executeOne(body);
  if ('__parseError' in result) {
    sendError(res, 400, result.__parseError);
    return true;
  }
  sendJson(res, 200, result);
  return true;
}
