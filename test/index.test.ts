/**
 * artifact-handoff — index.ts path-confinement tests (#824).
 *
 * Exercises every documented hard-refusal rule plus the success path against
 * REAL temp directories and REAL symlinks (mkdtemp scratch cwd + symlinkSync), so
 * the security boundary is verified, not asserted in prose. The headline case is
 * the #824 Critical: a top-level `.review` symlink must be refused and must NOT
 * redirect the write into the link target.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import artifactHandoff from "../index.ts";

interface ToolResult {
  isError?: boolean;
  content: { readonly text: string }[];
  details?: { path: string; bytes: number } | undefined;
}
interface Tool {
  name: string;
  execute: (
    id: string,
    params: { path: string; content: string },
    signal: unknown,
    onUpdate: unknown,
    ctx: { cwd: string },
  ) => Promise<ToolResult>;
}

function loadTool(): Tool {
  let captured: Tool | undefined;
  const pi = {
    registerTool(t: Tool) {
      captured = t;
    },
  };
  artifactHandoff(pi as never);
  if (!captured) throw new Error("artifact_review tool was not registered");
  return captured;
}

const tool = loadTool();
const scratches: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "artifact-handoff-test-"));
  scratches.push(dir);
  return dir;
}

function call(cwd: string, path: string, content = "payload"): Promise<ToolResult> {
  return tool.execute("t", { path, content }, undefined, undefined, { cwd });
}

test.after(() => {
  for (const d of scratches) rmSync(d, { recursive: true, force: true });
});

test("tool registers under the expected name", () => {
  assert.equal(tool.name, "artifact_review");
});

test("writes a payload under .review/ (auto-creating the root)", async () => {
  const cwd = scratch();
  const r = await call(cwd, ".review/findings.md", "hello");
  assert.ok(!r.isError, r.content[0]?.text);
  assert.equal(readFileSync(join(cwd, ".review/findings.md"), "utf8"), "hello");
  assert.equal(r.details?.path, ".review/findings.md");
  assert.equal(r.details?.bytes, 5);
});

test("auto-mkdir -p's nested artifact paths", async () => {
  const cwd = scratch();
  const r = await call(cwd, ".review/issue-99/sub/findings.md", "x");
  assert.ok(!r.isError, r.content[0]?.text);
  assert.ok(existsSync(join(cwd, ".review/issue-99/sub/findings.md")));
});

test("refuses an absolute path", async () => {
  const r = await call(scratch(), "/etc/passwd");
  assert.ok(r.isError);
  assert.ok(r.content[0]?.text.includes("absolute paths and '..'"), r.content[0]?.text);
});

test("refuses a '..' segment before resolution", async () => {
  const r = await call(scratch(), ".review/../secrets.md");
  assert.ok(r.isError);
  assert.ok(r.content[0]?.text.includes("absolute paths and '..'"), r.content[0]?.text);
});

test("refuses a path that resolves outside .review/", async () => {
  const r = await call(scratch(), "notreview/x.md");
  assert.ok(r.isError);
  assert.ok(r.content[0]?.text.includes("not strictly under"), r.content[0]?.text);
});

test("refuses writing .review itself (the directory as a file)", async () => {
  const r = await call(scratch(), ".review");
  assert.ok(r.isError);
  assert.ok(r.content[0]?.text.includes("not strictly under"), r.content[0]?.text);
});

test("refuses a sibling-prefix directory like .reviewX/ (startsWith + sep)", async () => {
  const r = await call(scratch(), ".reviewX/x.md");
  assert.ok(r.isError);
  assert.ok(r.content[0]?.text.includes("not strictly under"), r.content[0]?.text);
});

test("CRITICAL (#824): refuses when .review itself is a symlink, without writing through it", async () => {
  const cwd = scratch();
  const victim = scratch();
  writeFileSync(join(victim, "authorized_keys"), "ORIGINAL", { mode: 0o600 });
  symlinkSync(victim, join(cwd, ".review")); // .review -> victim dir

  const r = await call(cwd, ".review/authorized_keys", "ATTACKER");
  assert.ok(r.isError, "must refuse a symlinked .review root");
  assert.ok(r.content[0]?.text.includes("symbolic link"), r.content[0]?.text);
  // The victim file must be untouched — the escape is fully blocked.
  assert.equal(readFileSync(join(victim, "authorized_keys"), "utf8"), "ORIGINAL");
});

test("refuses when an intermediate .review/subdir is a symlink", async () => {
  const cwd = scratch();
  const victim = scratch();
  mkdirSync(join(cwd, ".review"));
  symlinkSync(victim, join(cwd, ".review/sub")); // .review/sub -> victim dir

  const r = await call(cwd, ".review/sub/x.md", "ATTACKER");
  assert.ok(r.isError, "must refuse a symlinked intermediate directory");
  assert.ok(r.content[0]?.text.includes("symbolic link") || r.content[0]?.text.includes("outside"), r.content[0]?.text);
  assert.ok(!existsSync(join(victim, "x.md")), "must not write through the intermediate symlink");
});

test("refuses when the leaf target is a symlink (O_NOFOLLOW / ELOOP)", async () => {
  const cwd = scratch();
  const victim = scratch();
  writeFileSync(join(victim, "file"), "ORIGINAL");
  mkdirSync(join(cwd, ".review"));
  symlinkSync(join(victim, "file"), join(cwd, ".review/leaf")); // .review/leaf -> victim file

  const r = await call(cwd, ".review/leaf", "ATTACKER");
  assert.ok(r.isError, "must refuse a symlinked leaf");
  assert.ok(r.content[0]?.text.includes("symbolic link"), r.content[0]?.text);
  assert.equal(readFileSync(join(victim, "file"), "utf8"), "ORIGINAL");
});
