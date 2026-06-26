# artifact-handoff

A pi extension that registers the `artifact_review` tool for a review-handoff
workflow: it writes review-artifact payloads under a repo-local `.review/`
directory, with strict path confinement.

- **Source rules:** [ADR-0006](https://github.com/psmfd/pi-config/blob/main/adrs/0006-artifact-handoff-and-review-format.md) § Tooling, [ADR-0007](https://github.com/psmfd/pi-config/blob/main/adrs/0007-tier-3-payload-path.md) § Coupled deliverables
- **Companion infrastructure (in the source distribution):** a tracked `.review/`
  directory, an `artifact-review-guard` CI workflow, `CODEOWNERS`, and the
  github-flow rule's `artifact-review`-labeled-draft-PR carve-out.

## Registered tool

| Name | Purpose |
|---|---|
| `artifact_review` | Write a review-artifact payload under `.review/`. Returns the relative path and byte count on success. |

### Parameters (typebox)

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | Path relative to the repo root that must resolve under `.review/`. Absolute paths and `..` segments are refused before resolution. |
| `content` | string | yes | UTF-8 file contents to write. The orchestrator authors the artifact body following [ADR-0006](https://github.com/psmfd/pi-config/blob/main/adrs/0006-artifact-handoff-and-review-format.md) § 1 conventions (`<!-- block:* id=cN -->` / `<!-- review:* id=aN -->` sentinels). |

The handler `mkdir -p`s the parent directory automatically; nested artifact paths
like `.review/issue-99/findings.md` work without a separate prep step.

## Refusal policy (per-rule)

| Rule | Class | Notes |
|---|---|---|
| Absolute path | **hard refusal** | `isAbsolute(rel)` — input must be relative to the repo root |
| `..` segment in input | **hard refusal** | Checked before path resolution; defense-in-depth even though the post-resolution prefix check would also catch most escapes |
| Resolves to `<cwd>/.review/` itself (writing the directory as a file) | **hard refusal** | `target.startsWith(reviewRoot + sep)` requires *strictly under* the directory |
| Resolves outside `<cwd>/.review/` | **hard refusal** | Same `startsWith(reviewRoot + sep)` check |
| Parent dir resolves through a symlink outside `<cwd>/.review/` | **hard refusal** | `fs.realpath(dirname(target))` after `mkdir -p`; re-asserts prefix — defends against `.review/dir → /etc` traversal |
| Leaf target is itself a symlink | **hard refusal** | `fs.open` with `O_NOFOLLOW` raises `ELOOP`; caller sees a clean refusal rather than the write redirecting through the link |

All are hard refusals. There is **no override mechanism** for path confinement —
the `.review/` directory *is* the entire point of the tool. Use the built-in
`write` tool for anything else.

## Secrets-guard interaction (in-scope; not a separate refusal)

`artifact_review` is a custom tool, so it does not automatically inherit the
[secrets-guard](https://github.com/psmfd/pi-secrets-guard) extension's
`write`/`edit` coverage. The secrets-guard tool-call handler is explicitly
extended to include `artifact_review` in the same content-scan branch as `write`.
This means PEM private keys, AWS access keys, GitHub PATs, and
vault-named-without-header files are all caught by secrets-guard *before* the
`artifact_review` handler executes.

## Override mechanisms

None. See § Refusal policy. To bypass the secrets-guard content scan specifically,
see the [secrets-guard](https://github.com/psmfd/pi-secrets-guard) extension (the
`SKIP_SECRETS_GUARD=1` and `.secrets-guard-allowlist` overrides are session-scoped
and audited).

## File layout

```text
artifact-handoff/
├── index.ts        # Registers the artifact_review tool
└── README.md       # This file
```

Pi loads `.ts` via jiti; the typebox + `@earendil-works/pi-coding-agent` types are
pi-provided "available imports".

---

> This is the public distribution mirror of the `artifact-handoff` pi extension.
> It is a derived, force-synced artifact — development happens in the upstream
> source repository. Open issues and PRs here; fixes land upstream and sync out.
