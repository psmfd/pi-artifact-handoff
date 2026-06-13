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
        return {
          content: [
            {
              type: "text",
              text: `artifact_review: refusing '${rel}' — absolute paths and '..' segments are not permitted. Pass a path relative to the repo root that resolves under ${REVIEW_DIR}/.`,
            },
          ],
          // `details` is required by AgentToolResult<T>; on error paths we
          // surface no structured payload. `isError: true` is the duck-typed
          // extra field pi's TUI consumes (see tic-tac-toe.ts example in
          // pi/examples/extensions). T widens to `unknown` for the union
          // with the success-path's typed details object.
          details: undefined,
          isError: true,
        };
      }

      const reviewRoot = resolve(ctx.cwd, REVIEW_DIR);
      const target = resolve(ctx.cwd, rel);
      if (!target.startsWith(reviewRoot + sep)) {
        // Rejects both `.review` (resolves to reviewRoot exactly — writing the
        // directory itself) and any path that resolves outside reviewRoot.
        return {
          content: [
            {
              type: "text",
              text: `artifact_review: refusing '${rel}' — resolves to '${target}', which is not strictly under ${reviewRoot}/. The artifact_review tool only writes files under ${REVIEW_DIR}/; use the write tool for any other location.`,
            },
          ],
          details: undefined,
          isError: true,
        };
      }

      await fs.mkdir(dirname(target), { recursive: true });

      // Symlink defense: path.resolve() is lexical only and does not follow
      // symlinks. An adversarial branch could plant `.review/dir → /etc` or
      // `.review/leaf → ~/.ssh/authorized_keys` and the write would escape
      // the directory. Realpath the parent and re-assert prefix; then open
      // the leaf with O_NOFOLLOW so a leaf symlink fails with ELOOP rather
      // than redirecting the write.
      let realReviewRoot: string;
      let realParent: string;
      try {
        realReviewRoot = await fs.realpath(reviewRoot);
        realParent = await fs.realpath(dirname(target));
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `artifact_review: refusing '${rel}' — could not realpath parent directory: ${(err as Error).message}`,
            },
          ],
          details: undefined,
          isError: true,
        };
      }
      if (
        realParent !== realReviewRoot &&
        !realParent.startsWith(realReviewRoot + sep)
      ) {
        return {
          content: [
            {
              type: "text",
              text: `artifact_review: refusing '${rel}' — parent directory resolves through a symlink to '${realParent}', which is outside '${realReviewRoot}/'.`,
            },
          ],
          details: undefined,
          isError: true,
        };
      }

      let handle;
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
          return {
            content: [
              {
                type: "text",
                text: `artifact_review: refusing '${rel}' — target is a symbolic link (O_NOFOLLOW). Tier 3 payloads must be regular files under ${REVIEW_DIR}/.`,
              },
            ],
            details: undefined,
            isError: true,
          };
        }
        throw err;
      }
      try {
        await handle.writeFile(content, { encoding: "utf-8" });
      } finally {
        await handle.close();
      }

      const bytes = Buffer.byteLength(content, "utf-8");
      return {
        content: [
          {
            type: "text",
            text: `Wrote ${rel} (${bytes} bytes).`,
          },
        ],
        details: { path: rel, bytes },
      };
    },
  });
}
