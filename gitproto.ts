// Git smart HTTP: info/refs, git-upload-pack (protocol v2, with a v0 fallback) and
// git-receive-pack (v0). The suite speaks this protocol in process, with no git
// binary, so every byte here is built by hand on git.ts's pkt-line and packfile
// primitives. Repositories are created through REST; a push can never invent one.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { hasAuth, readBody, sendError } from './httputil.ts';
import {
  ZERO_OID,
  isOid,
  parsePktLines,
  parseTree,
  pktLine,
  readPack,
  writePack,
  PKT_FLUSH,
  type GitObject,
} from './git.ts';
import {
  getCommit,
  isAncestor,
  peelToCommit,
  store,
  type Repo,
} from './store.ts';
import { clock } from './store.ts';

const AGENT = 'github-core-clone/1.0.0';

function sendGit(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(body);
}

function sendGitError(res: ServerResponse, status: number, message: string): void {
  sendError(res, status, message);
}

/** All refs of a repo, sorted by name: HEAD first (the symref the v0 parser reads), then
 *  the real refs, with a peeled `^{}` line after every annotated tag. */
function listRefs(repo: Repo): { name: string; oid: string }[] {
  const out: { name: string; oid: string }[] = [];
  const main = repo.refs.get('refs/heads/main');
  if (main) out.push({ name: 'HEAD', oid: main });
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name)!;
    out.push({ name, oid });
    const obj = repo.objects.get(oid);
    if (obj?.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      if (peeled !== oid) out.push({ name: `${name}^{}`, oid: peeled });
    }
  }
  return out;
}

/** The v0 capability list for upload-pack, as one space-separated string. */
function uploadPackV0Caps(repo: Repo): string {
  const caps = [
    'multi_ack',
    'thin-pack',
    'side-band',
    'side-band-64k',
    'ofs-delta',
    'shallow',
    'deepen-since',
    'deepen-not',
    'deepen-relative',
    'no-progress',
    'include-tag',
    'multi_ack_detailed',
    'allow-tip-sha1-in-want',
    'allow-reachable-sha1-in-want',
    'no-done',
    'filter',
    'object-format=sha1',
    `agent=${AGENT}`,
  ];
  const main = repo.refs.get('refs/heads/main');
  if (main) caps.push('symref=HEAD:refs/heads/main');
  return caps.join(' ');
}

/** The v0 capability list for receive-pack. */
function receivePackV0Caps(repo: Repo): string {
  const caps = ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', 'quiet', `agent=${AGENT}`];
  if (repo.refs.has('refs/heads/main')) caps.push('symref=HEAD:refs/heads/main');
  return caps.join(' ');
}

/** A v0 ref advertisement: preamble, then refs (capabilities on the first line). */
function v0Advertisement(service: string, refs: { name: string; oid: string }[], caps: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, i) => {
      parts.push(pktLine(i === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** A v2 capability advertisement: "version 2", then one capability line each. */
function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done filter\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ];
  return Buffer.concat(parts);
}

/** Frame pack bytes as side-band-64k pkt-lines (band byte 0x01). A pkt-line is at most
 * 65520 bytes including its 4-byte length, so a band-1 packet carries at most 65515 data bytes. */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLine(payload));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------

async function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo | undefined,
  service: string,
): Promise<void> {
  if (!repo) {
    sendGitError(res, 404, 'Not Found');
    return;
  }
  const protocol = (req.headers['git-protocol'] ?? '') as string;
  if (service === 'git-receive-pack') {
    const refs = listRefs(repo);
    sendGit(res, 200, 'application/x-git-receive-pack-advertisement', v0Advertisement(service, refs, receivePackV0Caps(repo)));
    return;
  }
  if (protocol === 'version=2') {
    sendGit(res, 200, 'application/x-git-upload-pack-advertisement', v2Advertisement());
    return;
  }
  const refs = listRefs(repo);
  sendGit(res, 200, 'application/x-git-upload-pack-advertisement', v0Advertisement(service, refs, uploadPackV0Caps(repo)));
}

// ---------------------------------------------------------------------------
// upload-pack v2: ls-refs and fetch
// ---------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  unborn: boolean;
  symrefs: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(packets: ReturnType<typeof parsePktLines>): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, unborn: false, symrefs: false, prefixes: [] };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trim();
    // Command lines (command=, agent=, object-format=) match none of these.
    if (line === 'peel') args.peel = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  // HEAD is reported only when no prefix filters it out (a prefix of "HEAD" or none);
  // the suite's prefix check fails when a refs/heads/ answer carries a HEAD line.
  const headWanted = args.prefixes.length === 0 || args.prefixes.some((p) => 'HEAD'.startsWith(p));
  const main = repo.refs.get('refs/heads/main');
  if (args.symrefs && headWanted) {
    const headOid = main ?? ZERO_OID;
    const attrs = [`symref-target:refs/heads/${repo.defaultBranch}`];
    if (!main && args.unborn) {
      parts.push(pktLine(`unborn HEAD ${attrs.join(' ')}\n`));
    } else {
      parts.push(pktLine(`${headOid} HEAD ${attrs.join(' ')}\n`));
    }
  }
  // listRefs carries the synthetic HEAD line and peeled `^{}` lines; neither belongs here.
  const refs = listRefs(repo).filter((ref) => ref.name !== 'HEAD' && !ref.name.endsWith('^{}'));
  const wanted = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  for (const ref of refs) {
    if (!wanted(ref.name)) continue;
    const attrs: string[] = [];
    if (args.peel) {
      const peeled = peelToCommit(repo, ref.oid);
      if (peeled !== ref.oid) attrs.push(`peeled:${peeled}`);
    }
    parts.push(pktLine(attrs.length > 0 ? `${ref.oid} ${ref.name} ${attrs.join(' ')}\n` : `${ref.oid} ${ref.name}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  filter: string | null;
  done: boolean;
}

function parseFetchArgs(packets: ReturnType<typeof parsePktLines>): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, filter: null, done: false };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trim();
    // Command lines (command=, agent=, object-format=, thin-pack, ...) match none of these.
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim().split(' ')[0]);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.deepen = Number.parseInt(line.slice(7), 10);
    else if (line.startsWith('filter ')) args.filter = line.slice(7).trim();
    else if (line === 'done') args.done = true;
  }
  return args;
}

// ---------------------------------------------------------------------------
// fetch planning: which objects a fetch sends
// ---------------------------------------------------------------------------

/** A commit plus its tree closure (trees and blobs), never its parents. */
function commitTreeClosure(repo: Repo, commitOid: string): Set<string> {
  const out = new Set<string>([commitOid]);
  const commit = getCommit(repo, commitOid);
  if (!commit) return out;
  const stack = [commit.tree];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'tree') for (const entry of parseTree(obj.data)) stack.push(entry.oid);
  }
  return out;
}

interface FetchPlan {
  readonly objects: GitObject[];
  readonly shallow: string[];
  readonly unshallow: string[];
}

/**
 * Plan a fetch: the objects reachable from `wants` but not from `haves`, honouring
 * a shallow `deepen` limit. The boundary commits (depth == deepen - 1, or the tips
 * of a depth-1 fetch) are the new shallow lines; client boundaries that are now
 * fully sent are the unshallow lines.
 */
function planFetch(repo: Repo, args: FetchArgs): FetchPlan {
  // What the client already has. A have that is also a shallow boundary is only possessed
  // up to itself: the client holds its tree but not its parents, so the walk stops there
  // instead of swallowing the ancestors a deepen is meant to deliver.
  const boundaries = new Set(args.shallow ?? []);
  const haveSet = new Set<string>();
  for (const have of args.haves) {
    const stack = [have];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      for (const object of commitTreeClosure(repo, oid)) haveSet.add(object);
      if (boundaries.has(oid)) continue;
      const commit = getCommit(repo, oid);
      if (commit) for (const parent of commit.parents) stack.push(parent);
    }
  }
  const deepen = args.deepen;

  // The wanted commits, with their depth from the nearest want (0 = the want).
  const depth = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  const extra = new Set<string>();
  for (const want of args.wants) {
    const obj = repo.objects.get(want);
    if (!obj) continue;
    if (obj.type === 'tag') {
      extra.add(want);
      queue.push([peelToCommit(repo, want), 0]);
    } else if (obj.type === 'commit') {
      queue.push([want, 0]);
    }
  }
  while (queue.length > 0) {
    const [oid, d] = queue.shift()!;
    if (depth.has(oid)) continue;
    if (deepen !== null && d >= deepen) continue;
    depth.set(oid, d);
    const commit = getCommit(repo, oid);
    if (commit) for (const parent of commit.parents) queue.push([parent, d + 1]);
  }

  const shallow: string[] = [];
  for (const [oid] of depth) {
    const commit = getCommit(repo, oid);
    if (commit && commit.parents.some((parent) => !depth.has(parent))) shallow.push(oid);
  }
  shallow.sort();
  const unshallow = (args.shallow ?? [])
    .filter((boundary) => depth.has(boundary) && !shallow.includes(boundary))
    .sort();

  const send = new Set<string>(extra);
  for (const oid of depth.keys()) {
    for (const object of commitTreeClosure(repo, oid)) send.add(object);
  }
  for (const oid of haveSet) send.delete(oid);

  // A stable order: commits, then trees, then blobs, then tags, each by oid.
  const typeOrder: Record<string, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
  const objects = [...send]
    .map((oid) => ({ oid, object: repo.objects.get(oid)! }))
    .filter((entry) => entry.object !== undefined)
    .sort((a, b) => typeOrder[a.object.type] - typeOrder[b.object.type] || (a.oid < b.oid ? -1 : 1))
    .map((entry) => entry.object);
  return { objects, shallow, unshallow };
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

function fetchV2Response(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const pack = writePack(plan.objects);
  // The acknowledgments section only exists when the client sent haves to negotiate
  // over: a fresh clone sends none, and real git expects the packfile section next.
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    parts.push(
      pktLine('acknowledgments\n'),
      pktLine('NAK\n'),
      pktLine('ready\n'),
      PKT_FLUSH,
    );
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV0Response(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

async function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const parsed = await readBody(req);
  let packets;
  try {
    packets = parsePktLines(parsed.raw);
  } catch {
    sendGitError(res, 400, 'malformed pkt-line stream');
    return;
  }
  const firstLine = packets.find((p) => p.kind === 'data')?.payload.toString('utf8').trim() ?? '';
  const protocol = (req.headers['git-protocol'] ?? '') as string;
  if (firstLine.startsWith('command=ls-refs')) {
    sendGit(res, 200, 'application/x-git-upload-pack-result', lsRefsResponse(repo, parseLsRefsArgs(packets)));
    return;
  }
  if (protocol === 'version=2' && firstLine.startsWith('command=') && firstLine !== 'command=fetch') {
    sendGitError(res, 400, `unsupported v2 command ${JSON.stringify(firstLine)}`);
    return;
  }
  if (protocol === 'version=2') {
    sendGit(res, 200, 'application/x-git-upload-pack-result', fetchV2Response(repo, parseFetchArgs(packets)));
    return;
  }
  sendGit(res, 200, 'application/x-git-upload-pack-result', fetchV0Response(repo, parseFetchArgs(packets)));
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/**
 * Parse a receive-pack request: command pkt-lines (capabilities on the first, after
 * a NUL), a flush, then the raw packfile. Returns null when the framing is unusable.
 */
function parsePushRequest(raw: Buffer): { commands: PushCommand[]; sideband: boolean; pack: Buffer } | null {
  let offset = 0;
  const commands: PushCommand[] = [];
  let sideband = false;
  let first = true;
  for (;;) {
    if (offset + 4 > raw.length) return null;
    const len = parseInt(raw.subarray(offset, offset + 4).toString('utf8'), 16);
    if (Number.isNaN(len)) return null;
    if (len === 0) {
      offset += 4;
      break;
    }
    if (len < 4 || offset + len > raw.length) return null;
    const line = raw.subarray(offset + 4, offset + len).toString('utf8');
    offset += len;
    const nul = line.indexOf('\0');
    const caps = nul >= 0 ? line.slice(nul + 1) : '';
    const head = (nul >= 0 ? line.slice(0, nul) : line).trim();
    const parts = head.split(' ');
    if (parts.length !== 3) return null;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isOid(oldOid) || !isOid(newOid)) return null;
    if (first && caps.includes('side-band-64k')) sideband = true;
    first = false;
    commands.push({ oldOid, newOid, ref });
  }
  return { commands, sideband, pack: raw.subarray(offset) };
}

async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const parsed = await readBody(req);
  const request = parsePushRequest(parsed.raw);
  if (!request || request.commands.length === 0) {
    sendGitError(res, 400, 'malformed receive-pack request');
    return;
  }

  // Import the pack first: the new tips must resolve before any ref moves.
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (request.pack.length > 0) {
    try {
      const objects = readPack(request.pack, {
        resolveBase: (oid) => repo.objects.get(oid),
      });
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpacker error';
    }
  }

  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const command of request.commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // A delete.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'unable to read the new object' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // A create.
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    // An update: the old value must be the current tip, and the new tip must
    // descend from it. Anything else is a non-fast-forward, refused per ref.
    if (current === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
    } else if (command.oldOid !== current || !isAncestor(repo, command.oldOid, command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else {
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
    }
  }
  repo.updatedAt = clock.nextIso();

  const inner: Buffer[] = [pktLine(`unpack ${unpackDetail}\n`)];
  for (const result of results) {
    inner.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  // The report stream itself ends with a flush packet: git reads lines until it sees
  // one, and a bare end of stream is reported as "the remote end hung up".
  inner.push(PKT_FLUSH);
  const innerBytes = Buffer.concat(inner);
  const body = request.sideband
    ? Buffer.concat([sidebandPack(innerBytes), PKT_FLUSH])
    : innerBytes;
  sendGit(res, 200, 'application/x-git-receive-pack-result', body);
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  rest: string[],
  query: URLSearchParams,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (!hasAuth(req)) {
    sendGitError(res, 401, 'Requires authentication');
    return true;
  }
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendGitError(res, 404, 'Not Found');
    return true;
  }
  if (method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
    const service = query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendGitError(res, 400, `unknown service ${JSON.stringify(service)}`);
      return true;
    }
    await handleInfoRefs(req, res, repo, service);
    return true;
  }
  if (method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
    await handleUploadPack(req, res, repo);
    return true;
  }
  if (method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
    await handleReceivePack(req, res, repo);
    return true;
  }
  sendGitError(res, 404, 'Not Found');
  return true;
}
