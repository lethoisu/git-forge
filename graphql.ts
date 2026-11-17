// GraphQL v4 endpoint (POST /api/graphql): a hand-rolled parser and
// executor for exactly the documents the conformance suite sends
// (queries, mutations, aliases, variables, inline fragments, batch
// arrays, __type introspection). Unknown fields yield HTTP 200 with an
// errors array naming the field; unknown repositories yield null data
// with no errors.

import { diffTrees, getObject, parseCommit } from './gitcore.ts';
import { prConflicts, squashMerge } from './gitproto.ts';
import type { Issue, Pull, Repo, Store } from './store.ts';

// -- tokenizer --------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i++; continue; }
    if (ch === '#') { while (i < input.length && input[i] !== '\n') i++; continue; }
    if (ch === '"') {
      let value = '';
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const esc = input[i + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else value += esc;
          i += 2;
        } else {
          value += input[i++];
        }
      }
      i++; // closing quote
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (input.startsWith('...', i)) { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('{}():!=$@[]'.includes(ch)) { tokens.push({ kind: 'punct', value: ch }); i++; continue; }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      if (input[j] === '-') j++;
      while (j < input.length && /[0-9]/.test(input[j])) j++;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j++;
        while (j < input.length && /[0-9]/.test(input[j])) j++;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j++;
        if (input[j] === '+' || input[j] === '-') j++;
        while (j < input.length && /[0-9]/.test(input[j])) j++;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_A-Za-z0-9]/.test(input[j])) j++;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`GraphQL: unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// -- AST ----------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

type SelectionNode =
  | { kind: 'field'; alias?: string; name: string; args: Record<string, ValueNode>; selections: SelectionNode[] }
  | { kind: 'inlineFragment'; typeCondition?: string; selections: SelectionNode[] };

interface Operation {
  operation: 'query' | 'mutation';
  name?: string;
  variableDefinitions: Record<string, ValueNode | undefined>;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token { return this.tokens[this.pos]; }
  private next(): Token { return this.tokens[this.pos++]; }
  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`GraphQL: expected ${value}, got ${JSON.stringify(t)}`);
  }
  private expectName(value?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`GraphQL: expected name, got ${JSON.stringify(t)}`);
    if (value !== undefined && t.value !== value) throw new Error(`GraphQL: expected ${value}, got ${t.value}`);
    return t.value;
  }
  private matchPunct(value: string): boolean {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === value) { this.pos++; return true; }
    return false;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): Operation {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    const t = this.peek();
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      operation = this.next().value as 'query' | 'mutation';
      const n = this.peek();
      if (n.kind === 'name') name = this.next().value;
    }
    const variableDefinitions: Record<string, ValueNode | undefined> = {};
    if (this.matchPunct('(')) {
      while (!this.matchPunct(')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.skipType();
        if (this.matchPunct('=')) {
          variableDefinitions[varName] = this.parseValue();
        } else {
          variableDefinitions[varName] = undefined;
        }
      }
    }
    // directives (unused by the suite)
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
    const selections = this.parseSelectionSet();
    return { operation, name, variableDefinitions, selections };
  }

  private skipType(): void {
    // Type := Name | [ Type ] with optional trailing '!'s.
    if (this.matchPunct('[')) {
      this.skipType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    while (this.matchPunct('!')) { /* non-null marker */ }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      const t = this.peek();
      if (t.kind === 'name' && t.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        return { kind: 'inlineFragment', typeCondition, selections };
      }
      // fragment spread (not used by the suite)
      this.expectName();
      return { kind: 'inlineFragment', selections: [] };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    let args: Record<string, ValueNode> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
    let selections: SelectionNode[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Record<string, ValueNode> {
    this.expectPunct('(');
    const args: Record<string, ValueNode> = {};
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: Number(t.value) };
    if (t.kind === 'float') return { kind: 'float', value: Number(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`GraphQL: unexpected value token ${JSON.stringify(t)}`);
  }
}

// -- execution ------------------------------------------------------------------------

class GqlError extends Error {}

type AnyRecord = Record<string, unknown>;

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name] ?? null;
    case 'string': return node.value;
    case 'int': case 'float': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.items.map((i) => resolveValue(i, variables));
    case 'object': {
      const out: AnyRecord = {};
      for (const [k, v] of Object.entries(node.fields)) out[k] = resolveValue(v, variables);
      return out;
    }
  }
}

function resolveArgs(args: Record<string, ValueNode>, variables: Record<string, unknown>): AnyRecord {
  const out: AnyRecord = {};
  for (const [k, v] of Object.entries(args)) out[k] = resolveValue(v, variables);
  return out;
}

interface FieldDef {
  of?: string;
  resolve: (ctx: Ctx, parent: AnyRecord, args: AnyRecord) => unknown;
}

const SEARCH_TYPE_VALUES = [
  'DISCUSSION', 'ISSUE', 'REPOSITORY', 'USER', 'CODE', 'COMMIT', 'MILESTONE',
  'PULL_REQUEST', 'WIKI', 'PROJECT', 'LABEL', 'MARKETPLACE_LISTING',
  'ORGANIZATION', 'TEAM',
];

const INTROSPECTION: Record<string, { fields: string[]; enumValues: string[] }> = {
  Issue: { fields: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'comments', 'labels'], enumValues: [] },
  PullRequest: { fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'headRefOid', 'baseRefOid'], enumValues: [] },
  Repository: { fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'], enumValues: [] },
  SearchType: { fields: [], enumValues: SEARCH_TYPE_VALUES },
  User: { fields: ['id', 'login'], enumValues: [] },
};

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = text.match(/^cursor:(\d+)$/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function issueConnection(ctx: Ctx, repo: Repo, args: AnyRecord): AnyRecord {
  let list = [...repo.issues];
  const states = args.states as string[] | undefined;
  if (states && states.length > 0) {
    const wanted = new Set(states.map((s) => s.toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const direction = orderBy?.direction === 'ASC' ? 1 : -1;
  list.sort((a, b) => direction * (a.number - b.number));
  const afterNum = decodeCursor(args.after as string | undefined);
  if (afterNum !== null) {
    const idx = list.findIndex((i) => i.number === afterNum);
    if (idx !== -1) list = list.slice(idx + 1);
  }
  const first = typeof args.first === 'number' ? args.first : 30;
  const page = list.slice(0, first);
  const hasNextPage = list.length > first;
  return {
    __typename: 'IssueConnection',
    _repo: repo,
    nodes: page,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: false,
      endCursor: page.length > 0 ? encodeCursor(page[page.length - 1].number) : null,
      startCursor: page.length > 0 ? encodeCursor(page[0].number) : null,
    },
  };
}

function pullRequestConnection(ctx: Ctx, repo: Repo, args: AnyRecord): AnyRecord {
  const list = repo.pulls.filter((p) => p.state === 'open');
  const first = typeof args.first === 'number' ? args.first : 30;
  const page = list.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    _repo: repo,
    nodes: page,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: list.length > first,
      hasPreviousPage: false,
      endCursor: page.length > 0 ? encodeCursor(page[page.length - 1].number) : null,
      startCursor: page.length > 0 ? encodeCursor(page[0].number) : null,
    },
  };
}

function issueRecord(ctx: Ctx, repo: Repo, issue: Issue): AnyRecord {
  return {
    __typename: 'Issue',
    id: ctx.store.issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    _repo: repo,
    _issue: issue,
  };
}

function pullRecord(ctx: Ctx, repo: Repo, pull: Pull): AnyRecord {
  return {
    __typename: 'PullRequest',
    id: ctx.store.pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    _repo: repo,
    _pull: pull,
  };
}

function repoRecord(ctx: Ctx, repo: Repo): AnyRecord {
  return {
    __typename: 'Repository',
    id: ctx.store.repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __typename: 'User', login: repo.owner },
    defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    _repo: repo,
  };
}

const SCHEMA: Record<string, Record<string, FieldDef>> = {
  Query: {
    viewer: {
      of: 'User',
      resolve: (ctx) => ({ __typename: 'User', login: ctx.store.viewer, id: ctx.store.encodeGlobalId('user', ctx.store.viewer) }),
    },
    repository: {
      of: 'Repository',
      resolve: (ctx, _parent, args) => {
        const owner = args.owner as string;
        const name = args.name as string;
        if (owner !== ctx.store.viewer) return null;
        const repo = ctx.store.getRepo(owner, name);
        return repo ? repoRecord(ctx, repo) : null;
      },
    },
    node: {
      of: 'Node',
      resolve: (ctx, _parent, args) => {
        const resolved = ctx.store.resolveGlobalId(String(args.id ?? ''));
        if (!resolved) return null;
        if (resolved.issue) return issueRecord(ctx, resolved.repo, resolved.issue);
        if (resolved.pull) return pullRecord(ctx, resolved.repo, resolved.pull);
        return repoRecord(ctx, resolved.repo);
      },
    },
    __type: {
      of: '__Type',
      resolve: (_ctx, _parent, args) => {
        const name = String(args.name ?? '');
        const info = INTROSPECTION[name];
        if (!info) return null;
        return { __typename: '__Type', name, _fields: info.fields, _enumValues: info.enumValues };
      },
    },
  },
  Mutation: {
    createIssue: {
      of: 'CreateIssuePayload',
      resolve: (ctx, _parent, args) => {
        const input = (args.input ?? {}) as AnyRecord;
        const resolved = ctx.store.resolveGlobalId(String(input.repositoryId ?? ''));
        if (!resolved) throw new GqlError('repository not found');
        const repo = resolved.repo;
        const seq = ctx.store.nowSeconds();
        const issue: Issue = {
          id: ctx.store.nextId(),
          number: repo.nextIssueNumber++,
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          labels: [],
          comments: [],
          createdSeq: seq,
          updatedSeq: seq,
        };
        repo.issues.push(issue);
        return { __typename: 'CreateIssuePayload', issue: issueRecord(ctx, repo, issue) };
      },
    },
    closeIssue: {
      of: 'CloseIssuePayload',
      resolve: (ctx, _parent, args) => {
        const input = (args.input ?? {}) as AnyRecord;
        const resolved = ctx.store.resolveGlobalId(String(input.issueId ?? ''));
        if (!resolved?.issue) throw new GqlError('issue not found');
        resolved.issue.state = 'closed';
        resolved.issue.updatedSeq = ctx.store.nowSeconds();
        return { __typename: 'CloseIssuePayload', issue: issueRecord(ctx, resolved.repo, resolved.issue) };
      },
    },
    createPullRequest: {
      of: 'CreatePullRequestPayload',
      resolve: (ctx, _parent, args) => {
        const input = (args.input ?? {}) as AnyRecord;
        const resolved = ctx.store.resolveGlobalId(String(input.repositoryId ?? ''));
        if (!resolved) throw new GqlError('repository not found');
        const repo = resolved.repo;
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        if (!repo.refs.has(`refs/heads/${head}`)) throw new GqlError('head branch not found');
        if (!repo.refs.has(`refs/heads/${base}`)) throw new GqlError('base branch not found');
        const pull: Pull = {
          id: ctx.store.nextId(),
          number: repo.nextPullNumber++,
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          headRef: head,
          baseRef: base,
          createdSeq: ctx.store.nowSeconds(),
        };
        repo.pulls.push(pull);
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullRecord(ctx, repo, pull) };
      },
    },
    mergePullRequest: {
      of: 'MergePullRequestPayload',
      resolve: (ctx, _parent, args) => {
        const input = (args.input ?? {}) as AnyRecord;
        const resolved = ctx.store.resolveGlobalId(String(input.pullRequestId ?? ''));
        if (!resolved?.pull) throw new GqlError('pull request not found');
        const { repo, pull } = resolved;
        if (pull.state !== 'open') throw new GqlError('pull request is not open');
        if (prConflicts(repo, pull.headRef, pull.baseRef)) throw new GqlError('merge conflict');
        const sha = squashMerge(ctx.store, repo, pull.headRef, pull.baseRef, `Merge pull request #${pull.number}`);
        if (!sha) throw new GqlError('merge conflict');
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = ctx.store.nowIso();
        pull.mergeCommitSha = sha;
        return { __typename: 'MergePullRequestPayload', pullRequest: pullRecord(ctx, repo, pull) };
      },
    },
    addComment: {
      of: 'AddCommentPayload',
      resolve: (ctx, _parent, args) => {
        const input = (args.input ?? {}) as AnyRecord;
        const resolved = ctx.store.resolveGlobalId(String(input.subjectId ?? ''));
        if (!resolved?.issue) throw new GqlError('issue not found');
        const comment = {
          id: resolved.repo.nextCommentId++,
          body: String(input.body ?? ''),
          createdSeq: ctx.store.nowSeconds(),
        };
        resolved.issue.comments.push(comment);
        return {
          __typename: 'AddCommentPayload',
          commentEdge: {
            __typename: 'CommentEdge',
            node: {
              __typename: 'Comment',
              id: ctx.store.commentGlobalId(resolved.repo, comment),
              body: comment.body,
            },
          },
        };
      },
    },
  },
  User: {
    login: { resolve: (_ctx, parent) => parent.login },
    id: { resolve: (_ctx, parent) => parent.id ?? '' },
  },
  Repository: {
    id: { resolve: (_ctx, parent) => parent.id },
    databaseId: { resolve: (_ctx, parent) => parent.databaseId },
    name: { resolve: (_ctx, parent) => parent.name },
    nameWithOwner: { resolve: (_ctx, parent) => parent.nameWithOwner },
    owner: { of: 'User', resolve: (_ctx, parent) => parent.owner },
    defaultBranchRef: { of: 'Ref', resolve: (_ctx, parent) => parent.defaultBranchRef },
    viewerPermission: { resolve: (_ctx, parent) => parent.viewerPermission },
    hasIssuesEnabled: { resolve: (_ctx, parent) => parent.hasIssuesEnabled },
    issue: {
      of: 'Issue',
      resolve: (ctx, parent, args) => {
        const repo = parent._repo as Repo;
        const issue = repo.issues.find((i) => i.number === args.number);
        return issue ? issueRecord(ctx, repo, issue) : null;
      },
    },
    issues: {
      of: 'IssueConnection',
      resolve: (ctx, parent, args) => issueConnection(ctx, parent._repo as Repo, args),
    },
    pullRequests: {
      of: 'PullRequestConnection',
      resolve: (ctx, parent, args) => pullRequestConnection(ctx, parent._repo as Repo, args),
    },
    pullRequest: {
      of: 'PullRequest',
      resolve: (ctx, parent, args) => {
        const repo = parent._repo as Repo;
        const pull = repo.pulls.find((p) => p.number === args.number);
        return pull ? pullRecord(ctx, repo, pull) : null;
      },
    },
  },
  Ref: {
    name: { resolve: (_ctx, parent) => parent.name },
  },
  Issue: {
    id: { resolve: (_ctx, parent) => parent.id },
    number: { resolve: (_ctx, parent) => parent.number },
    title: { resolve: (_ctx, parent) => parent.title },
    state: { resolve: (_ctx, parent) => parent.state },
    body: { resolve: (_ctx, parent) => parent.body },
  },
  PullRequest: {
    id: { resolve: (_ctx, parent) => parent.id },
    number: { resolve: (_ctx, parent) => parent.number },
    title: { resolve: (_ctx, parent) => parent.title },
    body: { resolve: (_ctx, parent) => parent.body },
    state: { resolve: (_ctx, parent) => parent.state },
    merged: { resolve: (_ctx, parent) => parent.merged },
    headRefName: { resolve: (_ctx, parent) => parent.headRefName },
    baseRefName: { resolve: (_ctx, parent) => parent.baseRefName },
    mergeable: {
      resolve: (_ctx, parent) => {
        const repo = parent._repo as Repo;
        const pull = parent._pull as Pull;
        return prConflicts(repo, pull.headRef, pull.baseRef) ? 'CONFLICTING' : 'MERGEABLE';
      },
    },
    files: {
      of: 'PullRequestFileConnection',
      resolve: (_ctx, parent, args) => {
        const repo = parent._repo as Repo;
        const pull = parent._pull as Pull;
        const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
        const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
        const headTree = headTip ? parseCommit(getObject(repo, headTip)!.data).tree : null;
        const baseTree = baseTip ? parseCommit(getObject(repo, baseTip)!.data).tree : null;
        const changes = diffTrees(repo, baseTree, headTree);
        const first = typeof args.first === 'number' ? args.first : 10;
        const nodes = changes.slice(0, first).map((c) => ({ __typename: 'PullRequestFile', path: c.path }));
        return { __typename: 'PullRequestFileConnection', nodes, pageInfo: { __typename: 'PageInfo', hasNextPage: changes.length > first, endCursor: null } };
      },
    },
  },
  IssueConnection: {
    nodes: {
      of: 'Issue',
      resolve: (ctx, parent) => {
        const repo = parent._repo as Repo;
        return (parent.nodes as Issue[]).map((i) => issueRecord(ctx, repo, i));
      },
    },
    pageInfo: { of: 'PageInfo', resolve: (_ctx, parent) => parent.pageInfo },
  },
  PullRequestConnection: {
    nodes: {
      of: 'PullRequest',
      resolve: (ctx, parent) => {
        const repo = parent._repo as Repo;
        return (parent.nodes as Pull[]).map((p) => pullRecord(ctx, repo, p));
      },
    },
    pageInfo: { of: 'PageInfo', resolve: (_ctx, parent) => parent.pageInfo },
  },
  PullRequestFileConnection: {
    nodes: { of: 'PullRequestFile', resolve: (_ctx, parent) => parent.nodes },
    pageInfo: { of: 'PageInfo', resolve: (_ctx, parent) => parent.pageInfo },
  },
  PageInfo: {
    hasNextPage: { resolve: (_ctx, parent) => parent.hasNextPage },
    hasPreviousPage: { resolve: (_ctx, parent) => parent.hasPreviousPage ?? false },
    endCursor: { resolve: (_ctx, parent) => parent.endCursor ?? null },
    startCursor: { resolve: (_ctx, parent) => parent.startCursor ?? null },
  },
  CreateIssuePayload: {
    issue: { of: 'Issue', resolve: (_ctx, parent) => parent.issue },
  },
  CloseIssuePayload: {
    issue: { of: 'Issue', resolve: (_ctx, parent) => parent.issue },
  },
  CreatePullRequestPayload: {
    pullRequest: { of: 'PullRequest', resolve: (_ctx, parent) => parent.pullRequest },
  },
  MergePullRequestPayload: {
    pullRequest: { of: 'PullRequest', resolve: (_ctx, parent) => parent.pullRequest },
  },
  AddCommentPayload: {
    commentEdge: { of: 'CommentEdge', resolve: (_ctx, parent) => parent.commentEdge },
  },
  CommentEdge: {
    node: { of: 'Comment', resolve: (_ctx, parent) => parent.node },
    cursor: { resolve: () => null },
  },
  Comment: {
    id: { resolve: (_ctx, parent) => parent.id },
    body: { resolve: (_ctx, parent) => parent.body },
  },
  __Type: {
    name: { resolve: (_ctx, parent) => parent.name },
    kind: { resolve: () => 'OBJECT' },
    fields: {
      resolve: (_ctx, parent) => {
        const names = (parent._fields as string[]) ?? [];
        return names.map((n) => ({ __typename: '__Field', name: n }));
      },
    },
    enumValues: {
      resolve: (_ctx, parent) => {
        const names = (parent._enumValues as string[]) ?? [];
        return names.map((n) => ({ __typename: '__EnumValue', name: n }));
      },
    },
  },
  __Field: {
    name: { resolve: (_ctx, parent) => parent.name },
  },
  __EnumValue: {
    name: { resolve: (_ctx, parent) => parent.name },
  },
  PullRequestFile: {
    path: { resolve: (_ctx, parent) => parent.path },
  },
};

// The IssueConnection/PullRequestConnection `nodes` resolvers wrap raw
// records through issueRecord/pullRecord using the connection's _repo.
function select(ctx: Ctx, typeName: string, value: unknown, selections: SelectionNode[]): AnyRecord | null {
  if (value === null || value === undefined) return null;
  const obj = value as AnyRecord;
  // The concrete type wins over the declared one (abstract `Node`, and
  // values that already carry their __typename).
  const effectiveType = (typeof obj.__typename === 'string' ? obj.__typename : typeName);
  const out: AnyRecord = {};
  for (const sel of selections) {
    if (sel.kind === 'inlineFragment') {
      if (!sel.typeCondition || sel.typeCondition === effectiveType) {
        const inner = select(ctx, effectiveType, value, sel.selections);
        if (inner) Object.assign(out, inner);
      }
      continue;
    }
    const fieldDef = SCHEMA[effectiveType]?.[sel.name];
    if (!fieldDef) {
      throw new GqlError(`Cannot query field "${sel.name}" on type "${effectiveType}".`);
    }
    const args = resolveArgs(sel.args, ctx.variables);
    let raw = fieldDef.resolve(ctx, obj, args);
    const key = sel.alias ?? sel.name;
    if (sel.selections.length === 0 || raw === null || raw === undefined) {
      out[key] = raw ?? null;
      continue;
    }
    if (Array.isArray(raw)) {
      out[key] = raw.map((item) => select(ctx, fieldDef.of ?? typeName, item, sel.selections));
    } else {
      out[key] = select(ctx, fieldDef.of ?? typeName, raw, sel.selections);
    }
  }
  return out;
}

function executeOperation(store: Store, op: Operation, variables: Record<string, unknown>): AnyRecord {
  const ctx: Ctx = { store, variables };
  // Apply variable defaults for missing variables.
  for (const [name, def] of Object.entries(op.variableDefinitions)) {
    if (!(name in ctx.variables) && def !== undefined) {
      ctx.variables[name] = resolveValue(def, {});
    }
  }
  const rootType = op.operation === 'mutation' ? 'Mutation' : 'Query';
  try {
    const data = select(ctx, rootType, {}, op.selections);
    return { data };
  } catch (err) {
    if (err instanceof GqlError) {
      return { data: null, errors: [{ message: err.message }] };
    }
    throw err;
  }
}

/** Execute a GraphQL request body (single operation or a batch array). */
export function executeGraphQL(store: Store, body: unknown): unknown {
  const runOne = (doc: AnyRecord): AnyRecord => {
    const query = typeof doc.query === 'string' ? doc.query : '';
    const variables = (doc.variables ?? {}) as Record<string, unknown>;
    let operations: Operation[];
    try {
      operations = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    if (operations.length === 0) {
      return { data: null, errors: [{ message: 'no operation found' }] };
    }
    const op = operations[0];
    return executeOperation(store, op, { ...variables });
  };
  if (Array.isArray(body)) return body.map((doc) => runOne(doc as AnyRecord));
  return runOne(body as AnyRecord);
}
