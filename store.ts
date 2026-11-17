// In-memory store: the single source of truth for REST, GraphQL, MCP and
// the git smart-HTTP endpoints. Nothing is persisted to disk (the trial
// mounts the repo read-only and only /tmp is writable), so all state lives
// here for the life of the process.
//
// Determinism: every timestamp the forge emits comes from a monotonic
// counter rooted at a fixed epoch, never from the wall clock, so a live run
// and its replay produce byte-identical state exports.

import { viewerLogin } from './scenario.ts';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  createdSeq: number;
  updatedSeq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  createdSeq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
}

/** Fixed epoch for the deterministic clock: 2025-01-01T00:00:00Z. */
export const CLOCK_EPOCH = 1735689600;

export class Store {
  readonly viewer: string;
  private repos = new Map<string, Repo>();
  private reposById = new Map<number, Repo>();
  private nextRepoId = 1;
  private nextGlobalId = 1;
  private clockSeq = 0;
  private requestSeq = 0;

  constructor() {
    this.viewer = viewerLogin();
  }

  /** Monotonic deterministic "now": seconds since the fixed epoch. */
  nowSeconds(): number {
    return CLOCK_EPOCH + this.clockSeq++;
  }

  nowIso(): string {
    return new Date(this.nowSeconds() * 1000).toISOString();
  }

  nextRequestId(): string {
    return `req-${++this.requestSeq}`;
  }

  nextId(): number {
    return this.nextGlobalId++;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  getRepoById(id: number): Repo | undefined {
    return this.reposById.get(id);
  }

  /** Repos owned by the viewer, in creation order. */
  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === this.viewer) out.push(repo);
    }
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const seq = this.clockSeq++;
    const repo: Repo = {
      id: this.nextRepoId++,
      owner: this.viewer,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdSeq: seq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
    };
    this.repos.set(this.repoKey(repo.owner, name), repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
    this.reposById.delete(repo.id);
  }

  // -- opaque global ids (base64url of a prefixed string) ------------------
  encodeGlobalId(kind: string, payload: string): string {
    return Buffer.from(`${kind}:${payload}`, 'utf8').toString('base64url');
  }

  decodeGlobalId(id: string): { kind: string; payload: string } | null {
    try {
      const text = Buffer.from(id, 'base64url').toString('utf8');
      const idx = text.indexOf(':');
      if (idx <= 0) return null;
      return { kind: text.slice(0, idx), payload: text.slice(idx + 1) };
    } catch {
      return null;
    }
  }

  repoGlobalId(repo: Repo): string {
    return this.encodeGlobalId('repo', `${repo.owner}/${repo.name}`);
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return this.encodeGlobalId('issue', `${repo.owner}/${repo.name}:${issue.number}`);
  }

  pullGlobalId(repo: Repo, pull: Pull): string {
    return this.encodeGlobalId('pr', `${repo.owner}/${repo.name}:${pull.number}`);
  }

  commentGlobalId(repo: Repo, comment: IssueComment): string {
    return this.encodeGlobalId('comment', `${repo.owner}/${repo.name}:${comment.id}`);
  }

  /** Resolve a global id produced by repoGlobalId / issueGlobalId / pullGlobalId. */
  resolveGlobalId(id: string): { repo: Repo; issue?: Issue; pull?: Pull } | null {
    const decoded = this.decodeGlobalId(id);
    if (!decoded) return null;
    const [owner, rest] = decoded.payload.split('/');
    if (!owner || rest === undefined) return null;
    const [name, numText] = rest.split(':');
    const repo = this.getRepo(owner, name);
    if (!repo) return null;
    if (decoded.kind === 'repo') return { repo };
    const num = Number(numText);
    if (!Number.isInteger(num)) return null;
    if (decoded.kind === 'issue') {
      const issue = repo.issues.find((i) => i.number === num);
      return issue ? { repo, issue } : null;
    }
    if (decoded.kind === 'pr') {
      const pull = repo.pulls.find((p) => p.number === num);
      return pull ? { repo, pull } : null;
    }
    return null;
  }
}

// -- shared REST shapes ------------------------------------------------------

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: store.repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: new Date((CLOCK_EPOCH + repo.createdSeq) * 1000).toISOString(),
    updated_at: new Date((CLOCK_EPOCH + repo.createdSeq) * 1000).toISOString(),
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: store.issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    comments: issue.comments.length,
    created_at: new Date((CLOCK_EPOCH + issue.createdSeq) * 1000).toISOString(),
    updated_at: new Date((CLOCK_EPOCH + issue.updatedSeq) * 1000).toISOString(),
    user: { login: store.viewer },
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? '';
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '';
  return {
    id: pull.id,
    node_id: store.pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    created_at: new Date((CLOCK_EPOCH + pull.createdSeq) * 1000).toISOString(),
    updated_at: new Date((CLOCK_EPOCH + pull.createdSeq) * 1000).toISOString(),
    user: { login: store.viewer },
  };
}
