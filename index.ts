/**
 * artifact-handoff — pi extension
 *
 * Registers the `artifact_review` tool used by the Tier 3 review-handoff
 * workflow (ADR-0006 § Tooling, ADR-0007 § Coupled deliverables). The tool
 * writes structured review-artifact payloads under `.review/` in the project
 * root. Writes outside `.review/` are refused.
 *
 * Path confinement rules (all hard refusals):
 *   - input path must be relative (absolute paths refused)
 *   - input path must not contain `..` segments (refused before resolution)
 *   - resolved path must equal `<cwd>/.review` or live strictly under it
 *   - the `.review` root must be a real directory (not a symlink) — checked
 *     before mkdir so a planted `.review -> /evil` symlink cannot be traversed
 *   - the parent directory is opened O_DIRECTORY|O_NOFOLLOW and realpath-checked
 *     back under `.review`, and the leaf is opened O_NOFOLLOW
 *
 * Symlink threat model (#824): an adversarial branch/worktree the agent operates
 * on can commit `.review` (or a component under it) as a symlink. O_NOFOLLOW only
 * guards the trailing component, so intermediate/root symlinks are defended
 * separately (lstat the root; realpath the parent under the verified root; open
 * the parent O_DIRECTORY|O_NOFOLLOW). A residual concurrent-swap TOCTOU on an
 * intermediate directory cannot be fully closed in portable Node (no openat(2))
 * and is out of scope for ADR-0007's single-operator local-CLI trust model.
 *
 * Override mechanism: none. Path confinement is a hard invariant of the
 * Tier 3 contract per ADR-0007 — the `.review/` directory is the entire
 * point of the tool. Use `write` for anywhere else.
 *
 * Secrets-guard interaction: the `secrets-guard/` extension explicitly
 * covers `artifact_review` in its tool_call handler (same content-scan
 * path as `write`), so payloads are screened for PEM keys, AWS access
 * keys, GitHub PATs, and vault-named-without-header files before the
 * write executes. See `agent/extensions/secrets-guard/index.ts` and
 * `agent/extensions/secrets-guard/README.md` § Tool-call coverage.
 *
 * Source rules: ADR-0006, ADR-0007.
 */

import { promises as fs, constants as fsConstants } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const REVIEW_DIR = ".review";

/**
 * Error-shaped tool result. `details` is required by `AgentToolResult<T>`; on
 * refusals we surface no structured payload and set the duck-typed `isError`
 * flag pi's TUI consumes (see `pi/examples/extensions/tic-tac-toe.ts`). `T`
 * widens to `unknown` for the union with the success path's typed details.
 */
function refuse(text: string) {
  return {
    content: [{ type: "text" as const, text: `artifact_review: ${text}` }],
    details: undefined,
    isError: true,
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "artifact_review",
    label: "Artifact Review",
    description:
      "Write a Tier 3 review-artifact payload under .review/. Path must be " +
      "relative to the repo root and resolve under .review/. Companion to " +
      "the artifact-review-guard CI workflow (ADR-0006, ADR-0007).",
    promptSnippet:
      "Persist Tier 3 review-artifact payloads under .review/ via artifact_review.",
    promptGuidelines: [
      "Use artifact_review when producing a Tier 3 handoff artifact per ADR-0006/0007 — do not use write for paths under .review/.",
      "artifact_review paths must be relative to the repo root and resolve under .review/. Absolute paths and '..' segments are refused.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description:
          "Relative path under .review/ (for example: '.review/issue-99/findings.md'). " +
          "Absolute paths and paths containing '..' are refused.",
      }),
      content: Type.String({
        description: "UTF-8 file contents to write.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { path: rel, content } = params;

      if (isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
        return refuse(
          `refusing '${rel}' — absolute paths and '..' segments are not permitted. Pass a path relative to the repo root that resolves under ${REVIEW_DIR}/.`,
        );
      }

      const reviewRoot = resolve(ctx.cwd, REVIEW_DIR);
      const target = resolve(ctx.cwd, rel);
      const targetParent = dirname(target);
      if (!target.startsWith(reviewRoot + sep)) {
        // Rejects both `.review` (resolves to reviewRoot exactly — writing the
        // directory itself) and any path that resolves outside reviewRoot.
        return refuse(
          `refusing '${rel}' — resolves to '${target}', which is not strictly under ${reviewRoot}/. The artifact_review tool only writes files under ${REVIEW_DIR}/; use the write tool for any other location.`,
        );
      }

      // The `.review` ROOT must be a real directory, never a symlink — checked
      // BEFORE mkdir -p so a pre-planted `.review -> /evil` symlink cannot cause
      // mkdir (and the later write) to escape into the link target. Absent is
      // fine: mkdir creates it as a real directory below. (#824 Critical: an
      // adversarial branch/worktree can commit `.review` as a symlink; O_NOFOLLOW
      // guards only the leaf, and realpath(reviewRoot)===realpath(parent) made the
      // old subdirectory-only check pass, so the write escaped confinement.)
      try {
        const rootInfo = await fs.lstat(reviewRoot);
        if (rootInfo.isSymbolicLink()) {
          return refuse(
            `refusing '${rel}' — '${REVIEW_DIR}' is a symbolic link; the ${REVIEW_DIR}/ root must be a real directory.`,
          );
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          return refuse(
            `refusing '${rel}' — could not stat ${REVIEW_DIR}/: ${(err as Error).message}`,
          );
        }
      }

      await fs.mkdir(targetParent, { recursive: true });

      // A symlinked parent directory yields a deterministic, clear refusal here.
      // The O_DIRECTORY|O_NOFOLLOW open below is the atomic backstop, but its errno
      // for a symlinked directory varies by platform (ELOOP on Linux, ENOTDIR on
      // macOS), so classify the symlink explicitly first. (A deeper symlinked
      // INTERMEDIATE component — where the final parent component is itself real —
      // is not a symlink by lstat and is caught by the realpath check below.)
      try {
        const parentInfo = await fs.lstat(targetParent);
        if (parentInfo.isSymbolicLink()) {
          return refuse(
            `refusing '${rel}' — the parent directory is a symbolic link; Tier 3 payloads must live under a real ${REVIEW_DIR}/ tree.`,
          );
        }
      } catch (err) {
        return refuse(
          `refusing '${rel}' — could not stat parent directory: ${(err as Error).message}`,
        );
      }

      // Dir-fd hardening (#824). Open the parent directory itself with
      // O_DIRECTORY|O_NOFOLLOW: this atomically rejects a symlinked final parent
      // component (ELOOP) at the moment of use — stronger than a lexical realpath a
      // later step could race — and yields a handle held across the leaf open. We
      // then realpath the parent and re-assert it resolves under the verified-real
      // `.review` root, catching a symlinked INTERMEDIATE component too. Residual:
      // a concurrent local writer could still swap an intermediate dir between this
      // check and the leaf open; fully closing that needs openat(2), which portable
      // Node's fs API lacks (no dir-fd-relative open), and is out of scope for
      // ADR-0007's single-operator trust model. The window is now two adjacent
      // syscalls rather than a realpath→mkdir→open span.
      let parentHandle: fs.FileHandle;
      try {
        parentHandle = await fs.open(
          targetParent,
          fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
        );
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ELOOP") {
          return refuse(
            `refusing '${rel}' — the parent directory is a symbolic link (O_NOFOLLOW). Tier 3 payloads must live under a real ${REVIEW_DIR}/ tree.`,
          );
        }
        if (code === "ENOTDIR") {
          return refuse(`refusing '${rel}' — the parent path is not a directory.`);
        }
        return refuse(
          `refusing '${rel}' — could not open parent directory: ${(err as Error).message}`,
        );
      }

      let handle: fs.FileHandle | undefined;
      try {
        let realReviewRoot: string;
        let realParent: string;
        try {
          realReviewRoot = await fs.realpath(reviewRoot);
          realParent = await fs.realpath(targetParent);
        } catch (err) {
          return refuse(
            `refusing '${rel}' — could not realpath parent directory: ${(err as Error).message}`,
          );
        }
        if (
          realParent !== realReviewRoot &&
          !realParent.startsWith(realReviewRoot + sep)
        ) {
          return refuse(
            `refusing '${rel}' — parent directory resolves through a symlink to '${realParent}', which is outside '${realReviewRoot}/'.`,
          );
        }

        // Leaf open with O_NOFOLLOW: a symlinked leaf fails with ELOOP rather than
        // redirecting the write through the link.
        try {
          handle = await fs.open(
            target,
            fsConstants.O_WRONLY |
              fsConstants.O_CREAT |
              fsConstants.O_TRUNC |
              fsConstants.O_NOFOLLOW,
            0o644,
          );
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ELOOP") {
            return refuse(
              `refusing '${rel}' — target is a symbolic link (O_NOFOLLOW). Tier 3 payloads must be regular files under ${REVIEW_DIR}/.`,
            );
          }
          throw err;
        }
      } finally {
        await parentHandle.close();
      }

      try {
        await handle.writeFile(content, { encoding: "utf-8" });
      } finally {
        await handle.close();
      }

      const bytes = Buffer.byteLength(content, "utf-8");
      return {
        content: [{ type: "text" as const, text: `Wrote ${rel} (${bytes} bytes).` }],
        details: { path: rel, bytes },
      };
    },
  });
}
