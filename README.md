# pi-artifact-handoff

> **Distribution mirror.** Developed in a private source-of-truth repo and synced here for distribution
> (current sync: `pi_config@d653613`, 2026-06-12). The `main` branch is force-synced — please don't
> target PRs at it directly; file an [issue](https://github.com/psmfd/pi-artifact-handoff/issues)
> instead and fixes will land via the next sync.

Pi extension that registers the `artifact_review` tool: path-confined writes of large review artifacts (reports, ADR drafts, evidence payloads) under a `.review/` directory in the project, so they land in the PR diff for line-anchored human review instead of being dumped into the conversation.

## Install

```bash
pi install git:github.com/psmfd/pi-artifact-handoff@v0.1.0
```

Or try it for a single session without installing:

```bash
pi -e git:github.com/psmfd/pi-artifact-handoff
```

No build step — pi loads the TypeScript directly. The pi SDK and `typebox` are bundled by pi itself; this extension has no runtime dependencies of its own.

## Registered tool

| Name | Purpose |
|---|---|
| `artifact_review` | Write a review-artifact payload under `.review/`. Returns the relative path and byte count on success. |

### Parameters (typebox)

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | Path relative to the repo root that must resolve under `.review/`. Absolute paths and `..` segments are refused before resolution. |
| `content` | string | yes | UTF-8 file contents to write. |

The handler `mkdir -p`s the parent directory automatically; nested artifact paths like `.review/issue-99/findings.md` work without a separate prep step.

## Suggested workflow

`.review/` artifacts are intended to be **ephemeral**: they live on a feature branch during review and are deleted before the PR merges. If you adopt this pattern, consider a CI guard that fails any PR whose diff still adds files under `.review/` at merge time, so review artifacts never reach your integration branch.

## Refusal policy (per-rule)

| Rule | Class | Notes |
|---|---|---|
| Absolute path | **hard refusal** | `isAbsolute(rel)` — input must be relative to the repo root |
| `..` segment in input | **hard refusal** | Checked before path resolution; defense-in-depth even though the post-resolution prefix check would also catch most escapes |
| Resolves to `<cwd>/.review/` itself (writing the directory as a file) | **hard refusal** | `target.startsWith(reviewRoot + sep)` requires *strictly under* the directory |
| Resolves outside `<cwd>/.review/` | **hard refusal** | Same `startsWith(reviewRoot + sep)` check |
| Parent dir resolves through a symlink outside `<cwd>/.review/` | **hard refusal** | `fs.realpath(dirname(target))` after `mkdir -p`; re-asserts prefix — defends against `.review/dir → /etc` traversal |
| Leaf target is itself a symlink | **hard refusal** | `fs.open` with `O_NOFOLLOW` raises `ELOOP`; caller sees a clean refusal rather than the write redirecting through the link |

All are hard refusals. There is **no override mechanism** for path confinement — the `.review/` directory *is* the entire point of the tool. Use the built-in `write` tool for anything else.

## Secrets-guard interaction

`artifact_review` is a custom tool, so it does not automatically inherit a secrets guard's `write`/`edit` coverage. The companion [`pi-secrets-guard`](https://github.com/psmfd/pi-secrets-guard) extension explicitly includes `artifact_review` in the same content-scan branch as `write` — PEM private keys, AWS access keys, GitHub PATs, and vault-named-without-header files are all caught *before* the `artifact_review` handler executes. If you run this extension without `pi-secrets-guard`, artifact writes are not content-scanned.

## File layout

```text
pi-artifact-handoff/
├── index.ts        # Registers the artifact_review tool
└── README.md       # This file
```

## Development

```bash
npm install
npm run typecheck
```

## License

[MIT](LICENSE)
