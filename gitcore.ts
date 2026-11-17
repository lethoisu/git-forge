// Core git object model: hashing, trees, commits, tags, reachability,
// packfile read/write (no deltas on write; delta resolution on read),
// and tree diffs. Pure functions over the store's object maps; no I/O.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync as zlibInflateSync } from 'node:zlib';
import type { GitObject, GitObjectType, Repo } from './store.ts';

export const ZERO_OID = '0'.repeat(40);
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

// -- trees -------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
  isDir: boolean;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw new Error('malformed tree: no mode terminator');
    const mode = data.toString('utf8', offset, space);
    const nul = data.indexOf(0, space + 1);
    if (nul === -1 || nul + 21 > data.length) throw new Error('malformed tree: no name terminator');
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid, isDir: mode === '40000' });
    offset = nul + 21;
  }
  return entries;
}

function gitTreeSortKey(entry: TreeEntry): string {
  return entry.isDir ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: TreeEntry[]): { oid: string; data: Buffer } {
  const sorted = [...entries].sort((a, b) =>
    gitTreeSortKey(a) < gitTreeSortKey(b) ? -1 : gitTreeSortKey(a) > gitTreeSortKey(b) ? 1 : 0,
  );
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  const data = Buffer.concat(parts);
  return { oid: hashObject('tree', data), data };
}

/** Build (and store) a tree for a flat path -> blob-oid map. */
export function treeFromFiles(repo: Repo, files: Map<string, string>): string {
  const build = (prefix: string): string => {
    const entries: TreeEntry[] = [];
    const seenDirs = new Set<string>();
    for (const [path, blobOid] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        entries.push({ mode: '100644', name: rest, oid: blobOid, isDir: false });
      } else {
        const dir = rest.slice(0, slash);
        if (!seenDirs.has(dir)) {
          seenDirs.add(dir);
          const sub = build(`${prefix}${dir}/`);
          entries.push({ mode: '40000', name: dir, oid: sub, isDir: true });
        }
      }
    }
    const { oid, data } = buildTree(entries);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build('');
}

/** Flatten a tree oid into path -> {blobOid, mode}. Missing tree = empty. */
export function flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      if (entry.isDir) walk(entry.oid, `${prefix}${entry.name}/`);
      else out.set(`${prefix}${entry.name}`, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

// -- commits / tags ------------------------------------------------------------

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const header = sep === -1 ? text : text.slice(0, sep);
  const message = sep === -1 ? '' : text.slice(sep + 2);
  const out: ParsedCommit = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) out.author = line.slice(7);
    else if (line.startsWith('committer ')) out.committer = line.slice(10);
  }
  return out;
}

export interface ParsedTag {
  object: string;
  type: GitObjectType;
  tag: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const header = sep === -1 ? text : text.slice(0, sep);
  const message = sep === -1 ? '' : text.slice(sep + 2);
  const out: ParsedTag = { object: '', type: 'commit', tag: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
  }
  return out;
}

export interface CommitFields {
  tree: string;
  parents?: string[];
  message: string;
  author?: string;
  committer?: string;
  timestamp?: number;
}

/** Build a commit's bytes exactly like the suite's buildCommit (fixed ts). */
export function buildCommit(fields: CommitFields): Buffer {
  const timestamp = fields.timestamp ?? 1700000000;
  const who = `${fields.author ?? 'Conformance <conformance@make.fun>'} ${timestamp} +0000`;
  const committer = `${fields.committer ?? 'Conformance <conformance@make.fun>'} ${timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Peel an oid to its commit (through annotated tags), or null. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let i = 0; i < 16; i++) {
    const obj = repo.objects.get(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') current = parseTag(obj.data).object;
    else return null;
  }
  return null;
}

// -- reachability ---------------------------------------------------------------

/** All objects reachable from `roots` (commits, trees, blobs, tags). */
export function reachableObjects(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** Commits reachable from `tip`, newest-first by generation order (BFS). */
export function reachableCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    queue.push(...parseCommit(obj.data).parents);
  }
  return out;
}

export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    queue.push(...parseCommit(obj.data).parents);
  }
  return false;
}

/** First common ancestor of two commits (merge-base), or null. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const aSet = new Set(reachableCommits(repo, a));
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (aSet.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    queue.push(...parseCommit(obj.data).parents);
  }
  return null;
}

// -- packfiles ------------------------------------------------------------------

const PACK_TYPE_BY_NAME: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_NAME_BY_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** Write a pack with full objects only (no deltas), deterministic order. */
export function writePack(objects: { type: GitObjectType; data: Buffer; oid: string }[]): Buffer {
  const sorted = [...objects].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const obj of sorted) {
    parts.push(packObjectHeader(PACK_TYPE_BY_NAME[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('truncated delta');
      const byte = delta[offset++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readVarint();
  const out: Buffer[] = [];
  let total = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i++) {
        if ((op & (1 << i)) !== 0) {
          if (offset >= delta.length) throw new Error('truncated delta copy offset');
          copyOffset |= delta[offset++] << (8 * i);
        }
      }
      for (let i = 0; i < 3; i++) {
        if ((op & (0x10 << i)) !== 0) {
          if (offset >= delta.length) throw new Error('truncated delta copy size');
          copySize |= delta[offset++] << (8 * i);
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy out of range');
      const chunk = base.subarray(copyOffset, copyOffset + copySize);
      out.push(chunk);
      total += chunk.length;
    } else if (op !== 0) {
      if (offset + op > delta.length) throw new Error('truncated delta insert');
      const chunk = delta.subarray(offset, offset + op);
      out.push(chunk);
      total += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (total !== resultSize) throw new Error('delta result size mismatch');
  return Buffer.concat(out);
}

/** Parse a packfile, resolving OFS_DELTA (6) and REF_DELTA (7) against the
 *  pack itself and the repo's existing objects. Returns oid -> object. */
export function parsePack(buf: Buffer, repo: Repo): Map<string, GitObject> {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let offset = 12;
  for (let i = 0; i < count; i++) {
    const entryStart = offset;
    if (offset >= buf.length) throw new Error('truncated pack');
    let byte = buf[offset++];
    const type = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (offset >= buf.length) throw new Error('truncated pack size');
      byte = buf[offset++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | null = null;
    let baseOffset = 0;
    if (type === 6) {
      // OFS_DELTA: negative offset varint
      if (offset >= buf.length) throw new Error('truncated ofs delta');
      byte = buf[offset++];
      baseOffset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (offset >= buf.length) throw new Error('truncated ofs delta');
        byte = buf[offset++];
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryStart - baseOffset;
    } else if (type === 7) {
      if (offset + 20 > buf.length) throw new Error('truncated ref delta');
      baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const { data: realData, consumed } = inflateWithLength(buf.subarray(offset));
    offset += consumed;
    let resolvedType: GitObjectType;
    let resolvedData: Buffer;
    if (type === 6 || type === 7) {
      const base = type === 6 ? byOffset.get(baseOffset) : objects.get(baseOid!) ?? repo.objects.get(baseOid!);
      if (!base) throw new Error('delta base not found');
      resolvedData = applyDelta(base.data, realData);
      resolvedType = base.type;
    } else {
      resolvedType = PACK_NAME_BY_TYPE[type];
      if (!resolvedType) throw new Error(`unknown pack type ${type}`);
      if (realData.length !== size) throw new Error('pack object size mismatch');
      resolvedData = realData;
    }
    const oid = hashObject(resolvedType, resolvedData);
    const obj: GitObject = { type: resolvedType, data: resolvedData };
    objects.set(oid, obj);
    byOffset.set(entryStart, obj);
  }
  return objects;
}

/** Inflate a deflate stream and report exactly how many bytes it consumed.
 *  Node's inflateSync ignores trailing bytes and throws on a truncated
 *  stream, so the smallest prefix that inflates cleanly is the stream. */
function inflateWithLength(buf: Buffer): { data: Buffer; consumed: number } {
  // Binary-search the smallest prefix that inflates cleanly to a full stream.
  // Deflate streams are self-terminating; a prefix that ends mid-stream
  // throws, so the minimal working prefix is the stream length.
  let lo = 1;
  let hi = buf.length;
  let data: Buffer | null = null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      data = zlibInflateSync(buf.subarray(0, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  if (data === null) {
    data = zlibInflateSync(buf.subarray(0, lo));
  }
  return { data, consumed: lo };
}

// -- tree diffs -------------------------------------------------------------------

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** Flatten-diff two trees (by oid; missing tree = empty). */
export function diffTrees(repo: Repo, baseTreeOid: string | null, headTreeOid: string | null): FileChange[] {
  const base = baseTreeOid ? flattenTree(repo, baseTreeOid) : new Map();
  const head = headTreeOid ? flattenTree(repo, headTreeOid) : new Map();
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) out.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
    else if (!b && h) out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
    else if (b && h && b.oid !== h.oid) out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
  }
  return out;
}

/** Line counts for a PR file entry: added lines, deleted lines. */
export function lineDiffCounts(oldText: string | null, newText: string | null): { additions: number; deletions: number } {
  if (oldText === null && newText === null) return { additions: 0, deletions: 0 };
  if (oldText === null) {
    const lines = newText!.split('\n');
    return { additions: newText!.length === 0 ? 0 : lines.length, deletions: 0 };
  }
  if (newText === null) {
    const lines = oldText.split('\n');
    return { additions: 0, deletions: oldText.length === 0 ? 0 : lines.length };
  }
  const a = oldText.split('\n');
  const b = newText.split('\n');
  // LCS on lines (files are small in the suite).
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const common = dp[0][0];
  return { additions: n - common, deletions: m - common };
}
