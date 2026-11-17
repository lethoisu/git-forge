// REST v3 API (/api/v3/*). Every reply is application/json and carries
// X-GitHub-Request-Id (set by app.ts). Errors are JSON {"message": ...}.
// Auth is enforced by app.ts before this router runs.

import {
  ZERO_OID,
  diffTrees,
  flattenTree,
  getObject,
  isObjectId,
  lineDiffCounts,
  parseCommit,
  parseTree,
  putObject,
  reachableCommits,
} from './gitcore.ts';
import { branchFiles, commitFiles, prConflicts, squashMerge } from './gitproto.ts';
import { issueJson, pullJson, repoJson } from './store.ts';
import type { Repo, Store } from './store.ts';

export interface HandlerResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RestContext {
  store: Store;
  baseUrl: string;
}

function ok(status: number, body: unknown, headers?: Record<string, string>): HandlerResult {
  return { status, body, headers };
}

function err(status: number, message: string): HandlerResult {
  return { status, body: { message } };
}

function notFound(message = 'Not Found'): HandlerResult {
  return err(404, message);
}

function repoOr404(ctx: RestContext, owner: string, name: string): Repo | HandlerResult {
  if (owner !== ctx.store.viewer) return notFound();
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) return notFound();
  return repo;
}

function parsePositiveInt(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function paginate<T>(items: T[], page: number, perPage: number): { pageItems: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { pageItems: items.slice(start, start + perPage), totalPages };
}

function linkHeader(baseUrl: string, path: string, query: URLSearchParams, page: number, perPage: number, totalPages: number): Record<string, string> {
  if (page >= totalPages) return {};
  const q = new URLSearchParams(query);
  q.set('page', String(page + 1));
  q.set('per_page', String(perPage));
  return { link: `<${baseUrl}${path}?${q.toString()}>; rel="next"` };
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Route a REST request. `segments` are the path parts after /api/v3. */
export function routeRest(ctx: RestContext, method: string, segments: string[], query: URLSearchParams, body: unknown): HandlerResult {
  const { store } = ctx;
  const b = (body ?? {}) as Record<string, unknown>;

  // GET /api/v3/
  if (segments.length === 0) {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    return ok(200, {
      current_user_url: `${ctx.baseUrl}/api/v3/user`,
      repository_url: `${ctx.baseUrl}/api/v3/repos/{owner}/{repo}`,
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return err(405, 'Method Not Allowed');
    return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: false });
  }

  // GET /api/v3/user ; POST /api/v3/user/repos ; GET /api/v3/user/repos
  if (segments[0] === 'user') {
    if (segments.length === 1 && method === 'GET') {
      return ok(200, { login: store.viewer, id: 1, node_id: store.encodeGlobalId('user', store.viewer), type: 'User', site_admin: false });
    }
    if (segments.length === 2 && segments[1] === 'repos') {
      if (method === 'POST') {
        const name = typeof b.name === 'string' ? b.name.trim() : '';
        if (!name) return err(422, 'name is required');
        if (!/^[A-Za-z0-9._-]+$/.test(name)) return err(422, 'name is not valid');
        if (store.getRepo(store.viewer, name)) return err(422, 'name already exists on this account');
        const repo = store.createRepo(
          name,
          b.private === true,
          typeof b.description === 'string' ? b.description : '',
        );
        return ok(201, repoJson(store, repo));
      }
      if (method === 'GET') {
        const perPage = Math.min(100, Math.max(1, parsePositiveInt(query.get('per_page'), 30)));
        const page = parsePositiveInt(query.get('page'), 1);
        const repos = store.viewerRepos();
        const { pageItems, totalPages } = paginate(repos, page, perPage);
        const headers = linkHeader(ctx.baseUrl, '/api/v3/user/repos', query, page, perPage, totalPages);
        return ok(200, pageItems.map((r) => repoJson(store, r)), headers);
      }
      return err(405, 'Method Not Allowed');
    }
    return notFound();
  }

  // /api/v3/repos/:owner/:repo/...
  if (segments[0] === 'repos') {
    if (segments.length < 3) return notFound();
    const owner = decodePath(segments[1]);
    const repoName = decodePath(segments[2]);
    const repo = repoOr404(ctx, owner, repoName);
    if ('status' in repo) return repo;
    const rest = segments.slice(3);

    // /repos/:o/:r
    if (rest.length === 0) {
      if (method === 'GET') return ok(200, repoJson(store, repo));
      if (method === 'PATCH') {
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.private === 'boolean') repo.isPrivate = b.private;
        return ok(200, repoJson(store, repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(repo);
        return { status: 204 };
      }
      return err(405, 'Method Not Allowed');
    }

    // branches
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const out: Record<string, unknown>[] = [];
        for (const refName of [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort()) {
          const name = refName.slice('refs/heads/'.length);
          out.push({ name, commit: { sha: repo.refs.get(refName) }, protected: false });
        }
        return ok(200, out);
      }
      if (rest.length >= 2 && method === 'GET') {
        const branch = rest.slice(1).map(decodePath).join('/');
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) return notFound();
        return ok(200, { name: branch, commit: { sha }, object: { sha } });
      }
      return notFound();
    }

    // commits
    if (rest[0] === 'commits' && rest.length === 1) {
      if (method !== 'GET') return err(405, 'Method Not Allowed');
      const refParam = query.get('sha');
      const tip = refParam
        ? repo.refs.get(`refs/heads/${refParam}`) ?? (isObjectId(refParam) ? refParam : undefined)
        : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!tip || tip === ZERO_OID) return ok(200, []);
      const commits = reachableCommits(repo, tip);
      const out = commits.map((sha) => {
        const obj = getObject(repo, sha)!;
        const parsed = parseCommit(obj.data);
        return {
          sha,
          commit: {
            message: parsed.message,
            author: { name: parsed.author, email: '', date: '' },
            committer: { name: parsed.committer, email: '', date: '' },
          },
          parents: parsed.parents.map((p) => ({ sha: p })),
        };
      });
      return ok(200, out);
    }

    // git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const ref = typeof b.ref === 'string' ? b.ref : '';
        const sha = typeof b.sha === 'string' ? b.sha : '';
        if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return err(422, 'ref must start with refs/heads/ or refs/tags/');
        if (!isObjectId(sha) || !getObject(repo, sha)) return err(422, 'sha does not exist');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        return ok(201, { ref, object: { sha } });
      }
      if (method === 'GET' && rest.length >= 3 && rest[2] === 'heads') {
        const branch = rest.slice(3).map(decodePath).join('/');
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) return notFound();
        return ok(200, { ref: `refs/heads/${branch}`, object: { sha } });
      }
      return notFound();
    }

    // contents
    if (rest[0] === 'contents') {
      const path = rest.slice(1).map(decodePath).join('/');
      if (method === 'GET') {
        const refBranch = query.get('ref') ?? repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${refBranch}`);
        if (!tip || tip === ZERO_OID) return notFound();
        const commit = getObject(repo, tip);
        if (!commit || commit.type !== 'commit') return notFound();
        const treeOid = parseCommit(commit.data).tree;
        const flat = flattenTree(repo, treeOid);
        if (path === '') {
          return ok(200, rootListing(repo, treeOid, ''));
        }
        const entry = flat.get(path);
        if (entry) {
          const blob = getObject(repo, entry.oid)!;
          return ok(200, {
            type: 'file',
            encoding: 'base64',
            size: blob.data.length,
            name: path.split('/').pop(),
            path,
            content: blob.data.toString('base64'),
            sha: entry.oid,
          });
        }
        // directory?
        const prefix = `${path}/`;
        const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
        for (const [p, e] of flat) {
          if (!p.startsWith(prefix)) continue;
          const rest2 = p.slice(prefix.length);
          const slash = rest2.indexOf('/');
          if (slash === -1) {
            children.set(rest2, { type: 'file', name: rest2, path: p, sha: e.oid });
          } else {
            const dir = rest2.slice(0, slash);
            if (!children.has(dir)) {
              // find the dir tree oid by walking the tree
              const dirOid = findDirOid(repo, treeOid, `${path}/${dir}`);
              children.set(dir, { type: 'dir', name: dir, path: `${path}/${dir}`, sha: dirOid ?? ZERO_OID });
            }
          }
        }
        if (children.size === 0) return notFound();
        return ok(200, [...children.values()]);
      }
      if (method === 'PUT') {
        const message = typeof b.message === 'string' ? b.message : 'update';
        const contentB64 = typeof b.content === 'string' ? b.content : '';
        if (!contentB64) return err(422, 'content is required');
        const bytes = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
        const branchName = typeof b.branch === 'string' && b.branch ? b.branch : repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branchName}`);
        if (tip && tip !== ZERO_OID && !getObject(repo, tip)) return notFound();
        if (!tip && repo.refs.size > 0) return notFound('Branch not found');
        const files = branchFiles(repo, branchName);
        const existing = files.get(path);
        const sha = typeof b.sha === 'string' ? b.sha : undefined;
        if (existing && sha && sha !== existing) return err(409, 'sha does not match the current file');
        if (existing && !sha) return err(422, 'sha is required to update a file');
        if (!existing && sha) return err(422, 'sha was supplied but the file does not exist');
        const blobOid = putObject(repo, 'blob', bytes);
        files.set(path, blobOid);
        const { commitOid } = commitFiles(store, repo, branchName, files, message);
        return ok(existing ? 200 : 201, {
          content: {
            name: path.split('/').pop(),
            path,
            sha: blobOid,
            size: bytes.length,
            type: 'file',
            encoding: 'base64',
            content: contentB64,
          },
          commit: { sha: commitOid },
        });
      }
      if (method === 'DELETE') {
        const branchName = typeof b.branch === 'string' && b.branch ? b.branch : repo.defaultBranch;
        const files = branchFiles(repo, branchName);
        const existing = files.get(path);
        if (!existing) return notFound();
        const sha = typeof b.sha === 'string' ? b.sha : undefined;
        if (sha && sha !== existing) return err(409, 'sha does not match the current file');
        files.delete(path);
        const message = typeof b.message === 'string' ? b.message : 'delete';
        const { commitOid } = commitFiles(store, repo, branchName, files, message);
        return ok(200, { commit: { sha: commitOid } });
      }
      return err(405, 'Method Not Allowed');
    }

    // labels
    if (rest[0] === 'labels' && rest.length === 1) {
      if (method === 'POST') {
        const name = typeof b.name === 'string' ? b.name.trim() : '';
        if (!name) return err(422, 'name is required');
        const color = typeof b.color === 'string' ? b.color.replace(/^#/, '') : 'ededed';
        const existing = repo.labels.get(name);
        if (existing) return ok(201, { name: existing.name, color: existing.color });
        const label = { name, color };
        repo.labels.set(name, label);
        return ok(201, { name, color });
      }
      if (method === 'GET') {
        return ok(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
      }
      return err(405, 'Method Not Allowed');
    }

    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const title = typeof b.title === 'string' ? b.title : '';
          if (!title) return err(422, 'title is required');
          const labelNames = Array.isArray(b.labels) ? b.labels.map(String) : [];
          const labels: { name: string; color: string }[] = [];
          for (const name of labelNames) {
            const label = repo.labels.get(name);
            if (!label) return err(422, `Label does not exist: ${name}`);
            labels.push(label);
          }
          const seq = store.nowSeconds();
          const issue = {
            id: store.nextId(),
            number: repo.nextIssueNumber++,
            title,
            body: typeof b.body === 'string' ? b.body : '',
            state: 'open' as const,
            labels,
            comments: [],
            createdSeq: seq,
            updatedSeq: seq,
          };
          repo.issues.push(issue);
          return ok(201, issueJson(store, repo, issue));
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          const perPage = Math.min(100, Math.max(1, parsePositiveInt(query.get('per_page'), 30)));
          const page = parsePositiveInt(query.get('page'), 1);
          let list = [...repo.issues];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (sort === 'created') {
            list.sort((a, b2) => (direction === 'asc' ? a.createdSeq - b2.createdSeq : b2.createdSeq - a.createdSeq));
          }
          const { pageItems } = paginate(list, page, perPage);
          return ok(200, pageItems.map((i) => issueJson(store, repo, i)));
        }
        return err(405, 'Method Not Allowed');
      }
      const num = Number(rest[1]);
      if (!Number.isInteger(num)) return notFound();
      const issue = repo.issues.find((i) => i.number === num);
      if (!issue) return notFound();
      if (rest.length === 2) {
        if (method === 'GET') return ok(200, issueJson(store, repo, issue));
        if (method === 'PATCH') {
          if (b.state === 'open' || b.state === 'closed') {
            issue.state = b.state;
            issue.updatedSeq = store.nowSeconds();
          }
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          return ok(200, issueJson(store, repo, issue));
        }
        return err(405, 'Method Not Allowed');
      }
      if (rest[2] === 'comments') {
        if (method === 'POST') {
          const bodyText = typeof b.body === 'string' ? b.body : '';
          if (!bodyText) return err(422, 'body is required');
          const comment = { id: repo.nextCommentId++, body: bodyText, createdSeq: store.nowSeconds() };
          issue.comments.push(comment);
          return ok(201, { id: comment.id, node_id: store.commentGlobalId(repo, comment), body: comment.body });
        }
        if (method === 'GET') {
          return ok(200, issue.comments.map((c) => ({ id: c.id, node_id: store.commentGlobalId(repo, c), body: c.body })));
        }
        return err(405, 'Method Not Allowed');
      }
      return notFound();
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const head = typeof b.head === 'string' ? b.head : '';
          const base = typeof b.base === 'string' ? b.base : '';
          const title = typeof b.title === 'string' ? b.title : '';
          if (!head || !base || !title) return err(422, 'head, base and title are required');
          if (!repo.refs.has(`refs/heads/${head}`)) return err(422, 'head branch not found');
          if (!repo.refs.has(`refs/heads/${base}`)) return err(422, 'base branch not found');
          const pull = {
            id: store.nextId(),
            number: repo.nextPullNumber++,
            title,
            body: typeof b.body === 'string' ? b.body : '',
            state: 'open' as const,
            merged: false,
            mergedAt: null as string | null,
            mergeCommitSha: null as string | null,
            headRef: head,
            baseRef: base,
            createdSeq: store.nowSeconds(),
          };
          repo.pulls.push(pull);
          const json = pullJson(store, repo, pull) as Record<string, unknown>;
          json.mergeable = prConflicts(repo, head, base) ? 'CONFLICTING' : 'MERGEABLE';
          return ok(201, json);
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const perPage = Math.min(100, Math.max(1, parsePositiveInt(query.get('per_page'), 30)));
          const page = parsePositiveInt(query.get('page'), 1);
          let list = [...repo.pulls];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          const { pageItems } = paginate(list, page, perPage);
          return ok(200, pageItems.map((p) => {
            const j = pullJson(store, repo, p) as Record<string, unknown>;
            j.mergeable = prConflicts(repo, p.headRef, p.baseRef) ? 'CONFLICTING' : 'MERGEABLE';
            return j;
          }));
        }
        return err(405, 'Method Not Allowed');
      }
      const num = Number(rest[1]);
      if (!Number.isInteger(num)) return notFound();
      const pull = repo.pulls.find((p) => p.number === num);
      if (!pull) return notFound();
      if (rest.length === 2) {
        if (method === 'GET') {
          const j = pullJson(store, repo, pull) as Record<string, unknown>;
          j.mergeable = prConflicts(repo, pull.headRef, pull.baseRef) ? 'CONFLICTING' : 'MERGEABLE';
          return ok(200, j);
        }
        return err(405, 'Method Not Allowed');
      }
      if (rest[2] === 'files' && method === 'GET') {
        const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
        const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
        const headTree = headTip ? parseCommit(getObject(repo, headTip)!.data).tree : null;
        const baseTree = baseTip ? parseCommit(getObject(repo, baseTip)!.data).tree : null;
        const changes = diffTrees(repo, baseTree, headTree);
        const out = changes.map((c) => {
          const oldText = c.oldOid ? getObject(repo, c.oldOid)?.data.toString('utf8') ?? null : null;
          const newText = c.newOid ? getObject(repo, c.newOid)?.data.toString('utf8') ?? null : null;
          const { additions, deletions } = lineDiffCounts(oldText, newText);
          return {
            filename: c.path,
            status: c.status,
            additions,
            deletions,
            changes: additions + deletions,
          };
        });
        return ok(200, out);
      }
      if (rest[2] === 'merge' && method === 'PUT') {
        if (pull.state !== 'open') return err(405, 'Pull request is not open');
        if (prConflicts(repo, pull.headRef, pull.baseRef)) return err(405, 'Merge conflict');
        const mergeCommitSha = squashMerge(
          store,
          repo,
          pull.headRef,
          pull.baseRef,
          `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`,
        );
        if (!mergeCommitSha) return err(405, 'Merge conflict');
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = store.nowIso();
        pull.mergeCommitSha = mergeCommitSha;
        return ok(200, { sha: mergeCommitSha, merged: true, message: `Pull request #${pull.number} successfully merged` });
      }
      return notFound();
    }

    return notFound();
  }

  return notFound();
}

function rootListing(repo: Repo, treeOid: string, prefix: string): Record<string, unknown>[] {
  const obj = getObject(repo, treeOid);
  if (!obj || obj.type !== 'tree') return [];
  return parseTree(obj.data).map((e) => ({
    type: e.isDir ? 'dir' : 'file',
    name: e.name,
    path: prefix ? `${prefix}/${e.name}` : e.name,
    sha: e.oid,
  }));
}

function findDirOid(repo: Repo, treeOid: string, dirPath: string): string | null {
  const parts = dirPath.split('/').filter(Boolean);
  let current = treeOid;
  for (const part of parts) {
    const obj = getObject(repo, current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === part && e.isDir);
    if (!entry) return null;
    current = entry.oid;
  }
  return current;
}
