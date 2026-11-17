// MCP endpoint (POST /mcp): JSON-RPC 2.0 over Streamable HTTP, modern
// `server/discover` era with a legacy `initialize` fallback. Tools act on
// the same store as REST/GraphQL, so the three surfaces stay in parity.

import { prConflicts, squashMerge } from './gitproto.ts';
import { issueJson, pullJson, repoJson } from './store.ts';
import type { Store } from './store.ts';

export interface McpResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required: string[] };
}

// Built once and reused verbatim, so two tools/list calls return
// byte-identical tool arrays.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'number', description: 'Issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Pull request state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
];

interface ToolOutcome {
  ok: boolean;
  object?: Record<string, unknown>;
  error?: string;
}

function toolResult(obj: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  const repo = owner && repoName ? store.getRepo(owner, repoName) : undefined;

  switch (name) {
    case 'create_repo': {
      const repoNameArg = typeof args.name === 'string' ? args.name.trim() : '';
      if (!repoNameArg) return { ok: false, error: 'missing required argument: name' };
      if (store.getRepo(store.viewer, repoNameArg)) {
        return { ok: false, error: `name already exists on this account` };
      }
      const created = store.createRepo(
        repoNameArg,
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
      );
      return { ok: true, object: repoJson(store, created) as Record<string, unknown> };
    }
    case 'get_repo': {
      if (!repo) return { ok: false, error: 'repository not found' };
      return { ok: true, object: repoJson(store, repo) as Record<string, unknown> };
    }
    case 'create_issue': {
      if (!repo) return { ok: false, error: 'repository not found' };
      const title = typeof args.title === 'string' ? args.title : '';
      if (!title) return { ok: false, error: 'missing required argument: title' };
      const seq = store.nowSeconds();
      const issue = {
        id: store.nextId(),
        number: repo.nextIssueNumber++,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        labels: [],
        comments: [],
        createdSeq: seq,
        updatedSeq: seq,
      };
      repo.issues.push(issue);
      return { ok: true, object: issueJson(store, repo, issue) as Record<string, unknown> };
    }
    case 'list_issues': {
      if (!repo) return { ok: false, error: 'repository not found' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = state === 'all' ? repo.issues : repo.issues.filter((i) => i.state === state);
      return { ok: true, object: { issues: list.map((i) => issueJson(store, repo, i)) } };
    }
    case 'get_issue': {
      if (!repo) return { ok: false, error: 'repository not found' };
      const num = Number(args.issue_number ?? args.number);
      const issue = repo.issues.find((i) => i.number === num);
      if (!issue) return { ok: false, error: 'issue not found' };
      return { ok: true, object: issueJson(store, repo, issue) as Record<string, unknown> };
    }
    case 'create_pull_request': {
      if (!repo) return { ok: false, error: 'repository not found' };
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      if (!title) return { ok: false, error: 'missing required argument: title' };
      if (!head) return { ok: false, error: 'missing required argument: head' };
      if (!base) return { ok: false, error: 'missing required argument: base' };
      if (!repo.refs.has(`refs/heads/${head}`)) return { ok: false, error: 'head branch not found' };
      if (!repo.refs.has(`refs/heads/${base}`)) return { ok: false, error: 'base branch not found' };
      const pull = {
        id: store.nextId(),
        number: repo.nextPullNumber++,
        title,
        body: typeof args.body === 'string' ? args.body : '',
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
      return { ok: true, object: json };
    }
    case 'list_pull_requests': {
      if (!repo) return { ok: false, error: 'repository not found' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = state === 'all' ? repo.pulls : repo.pulls.filter((p) => p.state === state);
      return { ok: true, object: { pull_requests: list.map((p) => pullJson(store, repo, p)) } };
    }
    case 'merge_pull_request': {
      if (!repo) return { ok: false, error: 'repository not found' };
      const num = Number(args.pull_number ?? args.number ?? args.pr_number);
      const pull = repo.pulls.find((p) => p.number === num);
      if (!pull) return { ok: false, error: 'pull request not found' };
      if (pull.state !== 'open') return { ok: false, error: 'pull request is not open' };
      if (prConflicts(repo, pull.headRef, pull.baseRef)) return { ok: false, error: 'merge conflict' };
      const sha = squashMerge(store, repo, pull.headRef, pull.baseRef, `Merge pull request #${pull.number}`);
      if (!sha) return { ok: false, error: 'merge conflict' };
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = store.nowIso();
      pull.mergeCommitSha = sha;
      return { ok: true, object: { number: pull.number, merged: true, state: 'closed', sha, merge_commit_sha: sha } };
    }
    default:
      return { ok: false, error: `unknown tool ${name}` };
  }
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

/** Handle one JSON-RPC request object. Returns null for notifications. */
export function handleMcp(store: Store, body: unknown): McpResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const req = body as Record<string, unknown>;
  const method = typeof req.method === 'string' ? req.method : '';
  const id = 'id' in req ? req.id : undefined;
  const isNotification = id === undefined;
  const params = (req.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    const result = {
      supportedVersions: SUPPORTED_VERSIONS,
      serverInfo: SERVER_INFO,
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    };
    if (isNotification) return { status: 202 };
    return { status: 200, body: rpcResult(id, result) };
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    const result = {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    };
    if (isNotification) return { status: 202 };
    return { status: 200, body: rpcResult(id, result), headers: { 'mcp-session-id': 'forge-session-1' } };
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202 };
  }
  if (method === 'ping') {
    if (isNotification) return { status: 202 };
    return { status: 200, body: rpcResult(id, {}) };
  }
  if (method === 'tools/list') {
    if (isNotification) return { status: 202 };
    return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
  }
  if (method === 'tools/call') {
    if (isNotification) return { status: 202 };
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((t) => t.name === toolName);
    if (!tool) {
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${toolName}`) };
    }
    // Required-argument check before dispatch.
    for (const required of tool.inputSchema.required) {
      if (args[required] === undefined || args[required] === null || args[required] === '') {
        return { status: 200, body: rpcResult(id, toolError(`missing required argument: ${required}`)) };
      }
    }
    const outcome = callTool(store, toolName, args);
    if (!outcome.ok) {
      return { status: 200, body: rpcResult(id, toolError(outcome.error ?? 'tool call failed')) };
    }
    return { status: 200, body: rpcResult(id, toolResult(outcome.object ?? {})) };
  }
  if (isNotification) return { status: 202 };
  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}
