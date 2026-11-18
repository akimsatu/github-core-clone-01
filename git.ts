// Git object model: SHA-1 ids, loose object encode/decode, tree/commit/tag builders and
// parsers, and packfile v2 read/write. Standard library only (node:crypto, node:zlib).
// No git binary anywhere: every byte the suite's in-process client speaks is built here.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
const OID_RE = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return OID_RE.test(value);
}

/** The SHA-1 of `"<type> <size>\0" + data`, as git computes it. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function makeObject(type: GitObjectType, data: Buffer): { oid: string; object: GitObject } {
  return { oid: hashObject(type, data), object: { type, data } };
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object's entries (mode, name, 20-byte oid each). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree: no space after mode');
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0) throw new Error('malformed tree: no NUL after name');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    if (oid.length !== 40) throw new Error('malformed tree: short oid');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Encode tree entries. Callers sort with git's rule (directories sort as name + '/'). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Git's tree sort key: a directory entry sorts as if its name ended with '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
}

export interface CommitParts {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
  readonly gpgsig?: string;
}

/** Parse a commit object into its headers and message. */
export function parseCommit(data: Buffer): CommitParts & { readonly raw: Buffer } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message, raw: data };
}

/** Encode a commit object. The message is used verbatim (callers add the trailing newline). */
export function buildCommit(parts: CommitParts): Buffer {
  const lines: string[] = [`tree ${parts.tree}`];
  for (const parent of parts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${parts.author}`);
  lines.push(`committer ${parts.committer}`);
  if (parts.gpgsig) lines.push(`gpgsig ${parts.gpgsig}`);
  return Buffer.from(`${lines.join('\n')}\n\n${parts.message}`, 'utf8');
}

export interface TagParts {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTag(data: Buffer): TagParts {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag(parts: TagParts): Buffer {
  const lines = [`object ${parts.object}`, `type ${parts.type}`, `tag ${parts.tag}`, `tagger ${parts.tagger}`];
  return Buffer.from(`${lines.join('\n')}\n\n${parts.message}`, 'utf8');
}

// ---------------------------------------------------------------------------
// pkt-line framing (gitformat-protocol-common)
// ---------------------------------------------------------------------------

/** Encode one pkt-line: 4 hex digits of (payload length + 4), then the payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'utf8'), body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'utf8');
export const PKT_DELIM = Buffer.from('0001', 'utf8');
export const PKT_RESPONSE_END = Buffer.from('0002', 'utf8');

export interface Pkt {
  readonly kind: 'data' | 'flush' | 'delim' | 'response-end';
  readonly payload: Buffer;
}

/** Split a buffer into pkt-lines. Throws on a malformed length. */
export function parsePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const lenHex = buf.subarray(offset, offset + 4).toString('utf8');
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len)) throw new Error(`bad pkt-line length ${JSON.stringify(lenHex)}`);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (offset + len > buf.length) throw new Error('truncated pkt-line');
    out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  if (offset !== buf.length) throw new Error('trailing bytes after pkt-lines');
  return out;
}

// ---------------------------------------------------------------------------
// packfile v2 (gitformat-pack)
// ---------------------------------------------------------------------------

const PACK_TYPE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_TYPE_NAME: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Encode an object's type+size header (the varint at the start of a pack entry). */
function packEntryHeader(type: GitObjectType, size: number): Buffer {
  const typeNum = PACK_TYPE[type];
  const bytes: number[] = [];
  let first = (typeNum << 4) | (size & 0x0f);
  size >>>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/**
 * Write a packfile holding the given objects as full (undelted) entries, in map order.
 * Deterministic for the same input order: zlib at a fixed level, no timestamps in a pack.
 */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(packEntryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data, { level: 6 }));
  }
  const withoutChecksum = Buffer.concat(parts);
  const checksum = createHash('sha1').update(withoutChecksum).digest();
  return Buffer.concat([withoutChecksum, checksum]);
}

interface PackEntryHeader {
  readonly type: number;
  readonly size: number;
  readonly headerBytes: number;
}

/** Read one pack entry header at `offset`. */
function readPackEntryHeader(buf: Buffer, offset: number): PackEntryHeader {
  const first = buf[offset];
  const type = (first >> 4) & 0x07;
  let size = first & 0x0f;
  let shift = 4;
  let pos = offset + 1;
  while ((buf[pos - 1] & 0x80) !== 0) {
    const b = buf[pos];
    size |= (b & 0x7f) << shift;
    shift += 7;
    pos += 1;
  }
  return { type, size, headerBytes: pos - offset };
}

/** Apply a git delta (copy/insert ops) to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[pos++];
      value |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) return value;
    }
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error(`delta base size ${baseSize} != ${base.length}`);
  const resultSize = readVarint();
  const chunks: Buffer[] = [];
  let total = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset |= delta[pos++];
      if (op & 0x02) offset |= delta[pos++] << 8;
      if (op & 0x04) offset |= delta[pos++] << 16;
      if (op & 0x08) offset |= delta[pos++] << 24;
      if (op & 0x10) size |= delta[pos++];
      if (op & 0x20) size |= delta[pos++] << 8;
      if (op & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      chunks.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op !== 0) {
      chunks.push(delta.subarray(pos, pos + op));
      pos += op;
      total += op;
    } else {
      throw new Error('delta op 0x00 is invalid');
    }
  }
  if (total !== resultSize) throw new Error(`delta result size ${total} != ${resultSize}`);
  return Buffer.concat(chunks);
}

/**
 * Read a whole packfile into objects (oid -> object). Resolves OFS_DELTA (type 6) and
 * REF_DELTA (type 7) against entries already read (git writes deltas after their base, and
 * the suite's client does the same). The trailing 20-byte checksum is ignored.
 */
export function readPack(
  buf: Buffer,
  options: { resolveBase?: (oid: string) => GitObject | undefined } = {},
): Map<string, GitObject> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile (missing PACK magic)');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryStart = offset;
    const { type, size, headerBytes } = readPackEntryHeader(buf, offset);
    offset += headerBytes;
    let baseOid: string | null = null;
    let baseOffset = -1;
    if (type === 6) {
      // OFS_DELTA: the base's offset back from this entry, as a git varint.
      let b = buf[offset++];
      let value = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = buf[offset++];
        value = ((value + 1) << 7) | (b & 0x7f);
      }
      baseOffset = entryStart - value;
    } else if (type === 7) {
      baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const { data: inflated, consumed } = inflatePrefix(buf.subarray(offset));
    offset += consumed;
    if (type === 6 || type === 7) {
      // A thin pack may delta against an object the receiver already has: fall back
      // to the caller's resolver (the server's object store) before giving up.
      const base =
        baseOid !== null
          ? (objects.get(baseOid) ?? options.resolveBase?.(baseOid))
          : byOffset.get(baseOffset);
      if (!base) throw new Error('delta base object is missing from the pack');
      const data = applyDelta(base.data, inflated);
      const obj: GitObject = { type: base.type, data };
      const oid = hashObject(obj.type, obj.data);
      objects.set(oid, obj);
      byOffset.set(entryStart, obj);
    } else {
      const objType = PACK_TYPE_NAME[type];
      if (!objType) throw new Error(`unknown pack object type ${type}`);
      if (inflated.length !== size) throw new Error(`pack object size ${inflated.length} != header ${size}`);
      const obj: GitObject = { type: objType, data: inflated };
      const oid = hashObject(obj.type, obj.data);
      objects.set(oid, obj);
      byOffset.set(entryStart, obj);
    }
  }
  return objects;
}

/**
 * Inflate the zlib stream at the start of `buf` and report how many bytes it consumed.
 * Node's inflateSync ignores trailing bytes but throws on a truncated stream, so the
 * shortest prefix that inflates cleanly is exactly the stream's end (binary search).
 */
function inflatePrefix(buf: Buffer): { data: Buffer; consumed: number } {
  let lo = 1;
  let hi = buf.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(0, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return { data: inflateSync(buf.subarray(0, lo)), consumed: lo };
}
