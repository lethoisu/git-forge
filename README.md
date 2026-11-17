# git-forge

A GitHub-compatible git forge in one Node 22 process, stdlib only, no model
calls. It serves git smart HTTP (protocol v0 and v2), the REST v3 API,
GraphQL v4 and MCP from a single in-memory store, so all four surfaces
always agree with each other.

Built for the make.fun bounty **"Build a GitHub-compatible git forge"**
(`github-core-clone-01`, $500). The entry point is `main.ts` (the kit's
lifecycle: bind an ephemeral port, register with the env, poll `/done`);
the server is `app.ts`.

## Layout

| File | What it does |
| --- | --- |
| `main.ts` | Entry/env lifecycle (unchanged from the kit starter). |
| `app.ts` | HTTP server: routing, Bearer auth, body handling. |
| `store.ts` | In-memory store (repos, objects, refs, issues, PRs, labels) + deterministic clock + opaque global ids. |
| `scenario.ts` | Derives the viewer login (`adaiversen`) from the scenario PRNG, exactly as the suite does. |
| `gitcore.ts` | Git object model: hashing, trees, commits, tags, reachability, pack read/write (no deltas on write, delta resolution on read), tree diffs. |
| `gitproto.ts` | Git wire protocol: pkt-lines, v0/v2 advertisements, ls-refs/fetch, receive-pack with fast-forward rules, contents commits, squash merges. |
| `rest.ts` | REST v3: repos, branches, commits, contents, labels, issues, comments, pull requests, merges. |
| `graphql.ts` | GraphQL v4: hand-rolled parser + executor for the suite's documents (queries, mutations, aliases, variables, inline fragments, batch arrays, `__type`). |
| `mcp.ts` | MCP (JSON-RPC 2.0): `server/discover`, legacy `initialize`, `tools/list`, `tools/call` (8 tools). |

## Design notes

- **One store, four surfaces.** REST, GraphQL, MCP and git all read and
  write the same maps, so a repo created over REST is immediately
  cloneable over git and readable over GraphQL.
- **Deterministic.** Every timestamp the forge emits comes from a
  monotonic counter rooted at a fixed epoch — never the wall clock, never
  unseeded randomness — so a live run and its replay produce identical
  state.
- **No deltas on the wire out.** Packs the forge sends contain full
  objects only; packs it receives may contain OFS/REF deltas and are
  resolved on ingest (real `git` clients send delta-compressed packs).
- **Shallow fetches are exact.** A depth-1 clone sends only the tip
  commit, its tree and its blobs, and names the tip in `shallow-info`;
  a deepen moves the boundary by exactly one generation and reports
  `unshallow` for the old boundary.
- **Real git works.** Verified with the `git` CLI: empty clone, push,
  branch push, re-clone — byte-identical contents.

## Local verification

Against the kit's sealed env (`program/env/server.mjs`) run locally:

- **Conformance: 120/120 checks passed** (git 30, repos 15, issues 15,
  pulls 20, graphql 20, mcp 15, protocol 5), stable across repeated runs.
- **Perf: 141–175 / 200** depending on machine load (push 32–43, clone
  29–39, read 24–50, write 26–43). Reference forge scores ~100/200.
- **Total estimate: ~940–975 / 1000** (feature 600 + agent 200 + perf).

See `BUILD_LOG.md` (in the workspace, not the repo) for the full
verification record, and `verification/` for the grade exports.

## Run it

```sh
MAKEFUN_SHOP_TOKEN=<token> MAKEFUN_ENV_URL=http://127.0.0.1:8080 npm start
```

The server binds an ephemeral port, registers it with the env, and exits
when the env says done. `GET /healthz` answers `{"ok": true}` without
auth; every other route requires `Authorization: Bearer <token>`.

## License

MIT.
