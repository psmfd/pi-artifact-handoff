# artifact-handoff

First-party pi extension to this repo. Registers the `artifact_review` tool for the Tier 3 review-handoff workflow.

- **Source rules:** [ADR-0006](../../../adrs/0006-artifact-handoff-and-review-format.md) § Tooling, [ADR-0007](../../../adrs/0007-tier-3-payload-path.md) § Coupled deliverables
- **Companion infrastructure:** [`.review/`](../../../.review/README.md), [`.github/workflows/artifact-review-guard.yml`](../../../.github/workflows/artifact-review-guard.yml), [`CODEOWNERS`](../../../CODEOWNERS), [`agent/rules/github-flow.md`](../../rules/github-flow.md) § `artifact-review`-labeled-draft-PR carve-out

## Registered tool

| Name | Purpose |
|---|---|
| `artifact_review` | Write a Tier 3 review-artifact payload under `.review/`. Returns the relative path and byte count on success. |

### Parameters (typebox)

| Field | Type | Required | Description |
|---|---|---|---|
| `path` | string | yes | Path relative to the repo root that must resolve under `.review/`. Absolute paths and `..` segments are refused before resolution. |
| `content` | string | yes | UTF-8 file contents to write. The orchestrator is expected to author the artifact body following [ADR-0006](../../../adrs/0006-artifact-handoff-and-review-format.md) § 1 conventions (`<!-- block:* id=cN -->` / `<!-- review:* id=aN -->` sentinels). |

The handler `mkdir -p`s the parent directory automatically; nested artifact paths like `.review/issue-99/findings.md` work without a separate prep step.

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

## Secrets-guard interaction (in-scope; not a separate refusal)

`artifact_review` is a custom tool, so it does not automatically inherit secrets-guard's `write`/`edit` coverage. The `secrets-guard/` extension's tool-call handler is explicitly extended to include `artifact_review` in the same content-scan branch as `write`. This means PEM private keys, AWS access keys, GitHub PATs, and vault-named-without-header files are all caught by secrets-guard *before* the `artifact_review` handler executes.

The smoke test `scripts/validate.sh` § 6b — secrets-guard SKIP_PATH_GLOBS smoke test asserts that `.review/**` is **NOT** in `SKIP_PATH_GLOBS`. If a future change to `secrets-guard/index.ts` adds `.review/**` to the skip list (effectively disabling scans), `validate.sh` fails. See [ADR-0006 § Consequences](../../../adrs/0006-artifact-handoff-and-review-format.md) for the original commitment.

## Override mechanisms

None. See § Refusal policy. To bypass the secrets-guard content scan specifically, see `agent/extensions/secrets-guard/README.md` (the `SKIP_SECRETS_GUARD=1` and `.secrets-guard-allowlist` overrides are session-scoped and audited).

## File layout

```text
agent/extensions/artifact-handoff/
├── index.ts        # Registers the artifact_review tool
└── README.md       # This file
```

No `package.json`, no `tsconfig.json`. Pi loads `.ts` via jiti; the typebox + `@earendil-works/pi-coding-agent` types are pi-provided "available imports".
