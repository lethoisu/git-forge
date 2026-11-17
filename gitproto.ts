// Git smart-HTTP wire protocol: pkt-lines, v0/v2 advertisements,
// ls-refs / fetch (upload-pack) and push (receive-pack) with ref rules.
// Every response here is built from the store; no git binary is used.

import {
  ZERO_OID,
  buildCommit,
  flattenTree,
  getObject,
  hashObject,
  isAncestor,
  mergeBase,
  parseCommit,
  parsePack,
  parseTag,
  parseTree,
  peelToCommit,
  reachableCommits,
  writePack,
} from './gitcore.ts';
import type { GitObjectType, Repo, Store } from './store.ts';

export const AGENT = 'forge/1.0';

// -- pkt-lines ----------------------------------------------------------------------

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  if (len > 65520) throw new Error('pkt-line too large');
  const header = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export interface Pkt {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/** Parse a pkt-line stream. Throws on a malformed length prefix. */
export function parsePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const hex = buf.toString('ascii', offset, offset + 4);
    const len = parseInt(hex, 16);
    if (Number.isNaN(len)) throw new Error(`invalid pkt-line length ${JSON.stringify(hex)}`);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else {
      if (len < 4 || offset + len > buf.length) throw new Error('truncated pkt-line');
      out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
      offset += len;
    }
  }
  return out;
}

/** Split a buffer into sideband packets (band 1 = data). */
export function sidebandWrap(band: number, data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const MAX = 65515;
  if (data.length === 0) return Buffer.concat(parts);
  for (let i = 0; i < data.length; i += MAX) {
    const chunk = data.subarray(i, Math.min(data.length, i + MAX));
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return Buffer.concat(parts);
}

// -- ref listing --------------------------------------------------------------------

export interface RefEntry {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

export function listRefs(repo: Repo): RefEntry[] {
  const entries: RefEntry[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: RefEntry = { oid, name };
    const obj = getObject(repo, oid);
    if (obj && obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      const peeled = peelToCommit(repo, target);
      if (peeled) entry.peeled = peeled;
    }
    entries.push(entry);
  }
  return entries;
}

function headSymrefTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// -- advertisements ------------------------------------------------------------------

export function uploadPackAdvertisement(repo: Repo, protocolV2: boolean): Buffer {
  const parts: Buffer[] = [];
  const service = '# service=git-upload-pack\n';
  const refs = listRefs(repo);
  const tip = refs.find((r) => r.name === headSymrefTarget(repo))?.oid ?? ZERO_OID;
  if (protocolV2) {
    parts.push(pktLine(service), FLUSH);
    parts.push(pktLine('version 2\n'));
    parts.push(pktLine(`agent=${AGENT}\n`));
    parts.push(pktLine('ls-refs=unborn\n'));
    parts.push(pktLine('fetch=shallow\n'));
    parts.push(pktLine('object-format=sha1\n'));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  // v0
  parts.push(pktLine(service), FLUSH);
  const caps = `side-band-64k thin-pack ofs-delta shallow multi_ack symref=HEAD:${headSymrefTarget(repo)}`;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headLine = `${tip} HEAD\0${caps}\n`;
    parts.push(pktLine(headLine));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

export function receivePackAdvertisement(repo: Repo): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('# service=git-receive-pack\n'), FLUSH);
  const refs = listRefs(repo);
  const tip = refs.find((r) => r.name === headSymrefTarget(repo))?.oid ?? ZERO_OID;
  const caps = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${tip} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// -- upload-pack: ls-refs (v2) --------------------------------------------------------

export function lsRefsResponse(repo: Repo, args: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): Buffer {
  const parts: Buffer[] = [];
  const refs = listRefs(repo);
  const headTarget = headSymrefTarget(repo);
  const tip = refs.find((r) => r.name === headTarget)?.oid ?? ZERO_OID;
  const matches = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  if (refs.length === 0) {
    if (args.unborn && matches('HEAD')) {
      const line = args.symrefs
        ? `unborn HEAD symref-target:${headTarget}\n`
        : `unborn HEAD\n`;
      parts.push(pktLine(line));
    }
  } else {
    if (matches('HEAD')) {
      const attrs = args.symrefs ? ` symref-target:${headTarget}` : '';
      parts.push(pktLine(`${tip} HEAD${attrs}\n`));
    }
    for (const ref of refs) {
      if (!matches(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (args.peel && ref.peeled) line += ` peeled:${ref.peeled}`;
      if (args.symrefs && ref.name === headTarget) line += ` symref-target:${headTarget}`;
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// -- upload-pack: fetch -----------------------------------------------------------------

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallows: string[];
  depth: number | null;
}

/** Collect a tree's full closure (tree + subtrees + blobs) into `out`. */
function collectTree(repo: Repo, treeOid: string, out: Set<string>): void {
  const obj = getObject(repo, treeOid);
  if (!obj || obj.type !== 'tree') return;
  if (out.has(treeOid)) return;
  out.add(treeOid);
  for (const entry of parseTree(obj.data)) {
    if (entry.isDir) collectTree(repo, entry.oid, out);
    else out.add(entry.oid);
  }
}

/**
 * Objects held by the client: everything reachable from `haves`, except
 * the ancestry beyond a shallow boundary (the boundary commit's tree and
 * blobs are held, but its parents are not).
 */
function heldObjects(repo: Repo, haves: string[], shallowBoundaries: string[]): Set<string> {
  const out = new Set<string>();
  const boundarySet = new Set(shallowBoundaries);
  const visited = new Set<string>();
  const stack = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const obj = getObject(repo, oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      collectTree(repo, c.tree, out);
      if (!boundarySet.has(oid)) {
        for (const p of c.parents) stack.push(p);
      }
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      collectTree(repo, oid, out);
    }
  }
  return out;
}

/**
 * Objects to send for a fetch, plus shallow-info lines.
 * depth: null = full history; N = at most N generations from each want.
 * Commits outside the included set are never walked into, and objects the
 * client already holds (per haves + shallow boundaries) are never re-sent.
 */
export function computeFetch(repo: Repo, req: FetchRequest): { objects: { type: GitObjectType; data: Buffer; oid: string }[]; shallow: string[]; unshallow: string[] } {
  const boundary = new Set<string>();
  const includedCommits = new Set<string>();
  const tagWants = new Set<string>();

  if (req.depth !== null) {
    // BFS from wants, generation-limited.
    const queue: { oid: string; gen: number }[] = [];
    for (const want of req.wants) {
      const obj = getObject(repo, want);
      if (obj?.type === 'tag') {
        tagWants.add(want);
        const peeled = peelToCommit(repo, want);
        if (peeled) queue.push({ oid: peeled, gen: 0 });
      } else if (obj?.type === 'commit') {
        queue.push({ oid: want, gen: 0 });
      }
    }
    const seen = new Set<string>();
    while (queue.length > 0) {
      const { oid, gen } = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = getObject(repo, oid);
      if (!obj || obj.type !== 'commit') continue;
      includedCommits.add(oid);
      if (gen === req.depth - 1) {
        boundary.add(oid);
      } else {
        for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, gen: gen + 1 });
      }
    }
  } else {
    for (const want of req.wants) {
      const obj = getObject(repo, want);
      if (obj?.type === 'tag') tagWants.add(want);
      const peeled = peelToCommit(repo, want);
      if (peeled) {
        for (const c of reachableCommits(repo, peeled)) includedCommits.add(c);
      }
    }
  }

  // Collect the send set: included commits (following parents only within
  // the included set) plus their trees/blobs, plus wanted tag objects.
  const sendSet = new Set<string>();
  const visited = new Set<string>();
  const stack = [...includedCommits, ...tagWants];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const obj = getObject(repo, oid);
    if (!obj) continue;
    sendSet.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      collectTree(repo, c.tree, sendSet);
      for (const p of c.parents) {
        if (includedCommits.has(p)) stack.push(p);
      }
    } else if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      const peeled = peelToCommit(repo, target);
      if (peeled && includedCommits.has(peeled)) stack.push(peeled);
    }
  }

  const held = req.haves.length > 0 ? heldObjects(repo, req.haves, req.shallows) : new Set<string>();
  const objects: { type: GitObjectType; data: Buffer; oid: string }[] = [];
  for (const oid of sendSet) {
    if (held.has(oid)) continue;
    const obj = getObject(repo, oid);
    if (obj) objects.push({ type: obj.type, data: obj.data, oid });
  }

  const shallow = [...boundary].sort();
  const unshallow = req.shallows.filter((s) => includedCommits.has(s) && !boundary.has(s)).sort();
  return { objects, shallow, unshallow };
}

export function fetchResponseV2(repo: Repo, req: FetchRequest): Buffer {
  const { objects, shallow, unshallow } = computeFetch(repo, req);
  const parts: Buffer[] = [];
  // Protocol v2: the acknowledgments section is only sent when the client
  // sent haves. Real git rejects an acknowledgments section on a fetch
  // with no haves ("expected 'packfile', received 'acknowledgments'").
  if (req.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    parts.push(pktLine('NAK\n'));
    parts.push(FLUSH);
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  if (objects.length > 0) {
    parts.push(pktLine('packfile\n'));
    const pack = writePack(objects);
    parts.push(sidebandWrap(1, pack));
    parts.push(FLUSH);
  }
  return Buffer.concat(parts);
}

export function fetchResponseV0(repo: Repo, req: FetchRequest): Buffer {
  const { objects, shallow, unshallow } = computeFetch(repo, req);
  const parts: Buffer[] = [];
  parts.push(pktLine('NAK\n'));
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (objects.length > 0) {
    const pack = writePack(objects);
    parts.push(sidebandWrap(1, pack));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// -- upload-pack request parsing ------------------------------------------------------

export interface UploadPackRequest {
  protocol: 2 | 0;
  command?: string;
  lsRefsArgs?: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] };
  fetch?: FetchRequest;
}

/** Parse a POST git-upload-pack body (v2 or v0). Throws on malformed input. */
export function parseUploadPack(body: Buffer, protocolV2: boolean): UploadPackRequest {
  const packets = parsePktLines(body);
  if (!protocolV2) {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallows: string[] = [];
    let depth: number | null = null;
    let section = 0;
    for (const pkt of packets) {
      if (pkt.kind === 'flush') {
        section++;
        continue;
      }
      if (pkt.kind !== 'data') continue;
      const line = pkt.payload.toString('utf8').trimEnd();
      if (section === 0) {
        if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
        else if (line.startsWith('shallow ')) shallows.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
      } else {
        if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      }
    }
    return { protocol: 0, fetch: { wants, haves, shallows, depth } };
  }
  // v2
  let command: string | undefined;
  let section = 0;
  const lsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
  const fetch: FetchRequest = { wants: [], haves: [], shallows: [], depth: null };
  for (const pkt of packets) {
    if (pkt.kind === 'delim') {
      section = 1;
      continue;
    }
    if (pkt.kind === 'flush') {
      section = 2;
      continue;
    }
    const line = pkt.payload.toString('utf8').trimEnd();
    if (section === 0) {
      if (line.startsWith('command=')) command = line.slice(8);
    } else if (section === 1) {
      if (command === 'ls-refs') {
        if (line === 'peel') lsRefsArgs.peel = true;
        else if (line === 'symrefs') lsRefsArgs.symrefs = true;
        else if (line === 'unborn') lsRefsArgs.unborn = true;
        else if (line.startsWith('ref-prefix ')) lsRefsArgs.prefixes.push(line.slice(11));
      } else if (command === 'fetch') {
        if (line.startsWith('want ')) fetch.wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) fetch.haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) fetch.shallows.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) fetch.depth = Number(line.slice(7).trim());
      }
    }
  }
  if (!command) throw new Error('upload-pack: no command');
  if (command === 'ls-refs') return { protocol: 2, command, lsRefsArgs };
  if (command === 'fetch') return { protocol: 2, command, fetch };
  throw new Error(`upload-pack: unsupported command ${command}`);
}

// -- receive-pack -----------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushResult {
  ref: string;
  ok: boolean;
  reason?: string;
}

/** Parse a POST git-receive-pack body: command lines, then the pack bytes. */
export function parseReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer; sideband: boolean } {
  const commands: PushCommand[] = [];
  let sideband = false;
  // Re-walk the raw buffer to find where the pkt-line section ends (the
  // flush that terminates the command list), so the pack bytes are exact.
  // The pack itself is binary and must NOT be parsed as pkt-lines.
  let packStart = body.length;
  let offset = 0;
  let sawFlush = false;
  while (offset < body.length && !sawFlush) {
    const len = parseInt(body.toString('ascii', offset, offset + 4), 16);
    if (Number.isNaN(len)) throw new Error('invalid pkt-line in receive-pack');
    if (len === 0) {
      sawFlush = true;
      offset += 4;
    } else if (len === 1) {
      offset += 4;
    } else {
      offset += len;
    }
  }
  packStart = offset;
  // Parse the command lines from the pkt section.
  const section = body.subarray(0, packStart);
  const lines = parsePktLines(section);
  for (const pkt of lines) {
    if (pkt.kind !== 'data') continue;
    const text = pkt.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const head = nul === -1 ? text : text.slice(0, nul);
    if (nul !== -1) {
      const caps = text.slice(nul + 1).trim().split(/\s+/);
      if (caps.includes('side-band-64k')) sideband = true;
    }
    const m = head.trimEnd().match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/);
    if (!m) throw new Error(`malformed push command ${JSON.stringify(head)}`);
    commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
  }
  return { commands, pack: body.subarray(packStart), sideband };
}

export function applyPush(repo: Repo, commands: PushCommand[], pack: Buffer): { results: PushResult[]; unpackOk: boolean; unpackError?: string } {
  let unpackOk = true;
  let unpackError: string | undefined;
  if (pack.length > 0) {
    try {
      const objects = parsePack(pack, repo);
      for (const [oid, obj] of objects) repo.objects.set(oid, obj);
    } catch (err) {
      unpackOk = false;
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }
  const results: PushResult[] = [];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref) ?? ZERO_OID;
    const isTag = cmd.ref.startsWith('refs/tags/');
    if (!unpackOk) {
      results.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    if (cmd.oldOid !== current) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (cmd.newOid === ZERO_OID) {
      // delete
      if (current === ZERO_OID) {
        results.push({ ref: cmd.ref, ok: false, reason: 'ref does not exist' });
      } else {
        repo.refs.delete(cmd.ref);
        results.push({ ref: cmd.ref, ok: true });
      }
      continue;
    }
    if (!getObject(repo, cmd.newOid)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'unresolved new object' });
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      // create
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true });
      continue;
    }
    if (isTag) {
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true });
      continue;
    }
    // branch update: must be a fast-forward (or a no-op)
    if (cmd.newOid === cmd.oldOid || isAncestor(repo, cmd.oldOid, cmd.newOid)) {
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true });
    } else {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
    }
  }
  return { results, unpackOk, unpackError };
}

export function pushReportResponse(results: PushResult[], unpackOk: boolean, unpackError: string | undefined, sideband: boolean): Buffer {
  const lines: string[] = [];
  if (unpackOk) lines.push('unpack ok');
  else lines.push(`unpack ${unpackError ?? 'failed'}`);
  for (const r of results) {
    lines.push(r.ok ? `ok ${r.ref}` : `ng ${r.ref} ${r.reason ?? 'failed'}`);
  }
  const report = Buffer.concat([...lines.map((l) => pktLine(`${l}\n`)), FLUSH]);
  if (!sideband) return report;
  return Buffer.concat([sidebandWrap(1, report), FLUSH]);
}

// -- helpers shared with REST (contents commits, merges) --------------------------------

/** Create a commit on `branch` from a full file map (path -> blob oid). */
export function commitFiles(
  store: Store,
  repo: Repo,
  branch: string,
  files: Map<string, string>,
  message: string,
): { commitOid: string; treeOid: string } {
  const treeOid = buildTreeFromFiles(repo, files);
  const refName = `refs/heads/${branch}`;
  const parent = repo.refs.get(refName);
  const parents = parent && parent !== ZERO_OID ? [parent] : [];
  const identity = `${store.viewer} <${store.viewer}@example.invalid>`;
  const commitData = buildCommit({
    tree: treeOid,
    parents,
    message,
    author: identity,
    committer: identity,
    timestamp: store.nowSeconds(),
  });
  const commitOid = hashObject('commit', commitData);
  repo.objects.set(commitOid, { type: 'commit', data: commitData });
  repo.refs.set(refName, commitOid);
  return { commitOid, treeOid };
}

function buildTreeFromFiles(repo: Repo, files: Map<string, string>): string {
  const build = (prefix: string): string => {
    const entries: { mode: string; name: string; oid: string; isDir: boolean }[] = [];
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
    const sorted = [...entries].sort((a, b) => {
      const ka = a.isDir ? `${a.name}/` : a.name;
      const kb = b.isDir ? `${b.name}/` : b.name;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const parts: Buffer[] = [];
    for (const entry of sorted) {
      parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
      parts.push(Buffer.from(entry.oid, 'hex'));
    }
    const data = Buffer.concat(parts);
    const oid = hashObject('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build('');
}

/** Current full file map of a branch tip (path -> blob oid). */
export function branchFiles(repo: Repo, branch: string): Map<string, string> {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip || tip === ZERO_OID) return new Map();
  const obj = getObject(repo, tip);
  if (!obj || obj.type !== 'commit') return new Map();
  const treeOid = parseCommit(obj.data).tree;
  const flat = flattenTree(repo, treeOid);
  const out = new Map<string, string>();
  for (const [path, entry] of flat) out.set(path, entry.oid);
  return out;
}

/** 3-way merge tree: base tree + head changes applied over base-tip tree.
 *  Returns the merged file map, or null when a path conflicts. */
export function mergeTrees(
  repo: Repo,
  baseTip: string,
  headTip: string,
  mergeBaseOid: string | null,
): Map<string, string> | null {
  const baseFiles = branchFilesFromTip(repo, baseTip);
  const headFiles = branchFilesFromTip(repo, headTip);
  const ancestorFiles = mergeBaseOid ? branchFilesFromTip(repo, mergeBaseOid) : new Map<string, string>();
  const merged = new Map<string, string>(baseFiles);
  const paths = new Set([...ancestorFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const anc = ancestorFiles.get(path);
    const head = headFiles.get(path);
    const base = baseFiles.get(path);
    const headChanged = head !== anc;
    const baseChanged = base !== anc;
    if (headChanged && baseChanged && head !== base) return null;
    if (headChanged) {
      if (head === undefined) merged.delete(path);
      else merged.set(path, head);
    }
  }
  return merged;
}

export function branchFilesFromTip(repo: Repo, tip: string): Map<string, string> {
  const obj = getObject(repo, tip);
  if (!obj || obj.type !== 'commit') return new Map();
  const treeOid = parseCommit(obj.data).tree;
  const flat = flattenTree(repo, treeOid);
  const out = new Map<string, string>();
  for (const [path, entry] of flat) out.set(path, entry.oid);
  return out;
}

/** Does the PR head-vs-base conflict (same path changed both ways)? */
export function prConflicts(repo: Repo, headRef: string, baseRef: string): boolean {
  const headTip = repo.refs.get(`refs/heads/${headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
  if (!headTip || !baseTip) return false;
  const base = mergeBase(repo, headTip, baseTip);
  return mergeTrees(repo, baseTip, headTip, base) === null;
}

/** Squash-merge a PR onto its base branch; returns the merge commit oid. */
export function squashMerge(
  store: Store,
  repo: Repo,
  headRef: string,
  baseRef: string,
  message: string,
): string | null {
  const headTip = repo.refs.get(`refs/heads/${headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
  if (!headTip || !baseTip) return null;
  const base = mergeBase(repo, headTip, baseTip);
  const merged = mergeTrees(repo, baseTip, headTip, base);
  if (merged === null) return null;
  const treeOid = buildTreeFromFiles(repo, merged);
  const identity = `${store.viewer} <${store.viewer}@example.invalid>`;
  const commitData = buildCommit({
    tree: treeOid,
    parents: [baseTip],
    message,
    author: identity,
    committer: identity,
    timestamp: store.nowSeconds(),
  });
  const commitOid = hashObject('commit', commitData);
  repo.objects.set(commitOid, { type: 'commit', data: commitData });
  repo.refs.set(`refs/heads/${baseRef}`, commitOid);
  return commitOid;
}
