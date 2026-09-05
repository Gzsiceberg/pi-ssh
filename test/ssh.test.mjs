import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";

// Use the installed pi, just as the extension loader does. Override for CI or
// testing another pi version: PI_TEST_PACKAGE=/path/to/pi-coding-agent.
const packageDir = process.env.PI_TEST_PACKAGE ?? join(
  execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
  "@earendil-works/pi-coding-agent",
);
const requirePi = createRequire(join(packageDir, "package.json"));
const { createJiti } = requirePi("jiti");
// The bundled entry is self-contained; some pi distributions' unbundled
// entry imports optional server packages that are not installed.
const native = await import(pathToFileURL(join(packageDir, "dist/bundle/index.js")).href);
const tui = await import(pathToFileURL(requirePi.resolve("@earendil-works/pi-tui")).href);
const jiti = createJiti(import.meta.url, {
  virtualModules: {
    "@earendil-works/pi-coding-agent": native,
    "@earendil-works/pi-tui": tui,
  },
});
const { default: extension } = await jiti.import(resolve("index.ts"));
const tools = new Map();
const commands = new Map();
let active = ["read", "write", "edit", "bash"];
let root, home, cwd, localCwd, ctx, status;
const oldPath = process.env.PATH;
const text = (result) => result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const call = (name, params, signal) => {
  const tool = tools.get(`ssh_${name}`);
  return tool.execute("test", tool.prepareArguments?.(params) ?? params, signal, undefined, ctx);
};

before(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-ssh-test-"));
  home = join(root, "remote-home");
  cwd = join(home, "project");
  localCwd = join(root, "local-session");
  const bin = join(root, "bin");
  await Promise.all([cwd, localCwd, bin].map((p) => mkdir(p, { recursive: true })));
  // Only fake SSH is used: execute the quoted remote command in an isolated
  // temporary cwd/home. No connection or user SSH configuration is required.
  await writeFile(join(bin, "ssh"), `#!/bin/sh\n[ "$1" = -- ] && shift\nshift\nexport HOME='${home}'\ncd "$HOME" || exit\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${oldPath}`;
  ctx = {
    cwd: localCwd,
    model: { input: ["text", "image"] },
    ui: { setStatus(_key, value) { status = value; }, notify() {}, theme: { fg: (_c, s) => s } },
  };
  extension({
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    on() {},
    getActiveTools: () => active,
    setActiveTools: (names) => { active = names; },
  });
  await commands.get("ssh").handler("fake:~/project", ctx);
});

after(async () => {
  process.env.PATH = oldPath;
  if (root) await rm(root, { recursive: true, force: true });
});

test("inherits current schemas, argument preparation, sampling, descriptions and guidance", () => {
  assert.equal(status, `SSH fake:${cwd}`);
  for (const name of ["read", "write", "edit"]) {
    const base = native[`create${name[0].toUpperCase()}${name.slice(1)}ToolDefinition`]("/");
    const tool = tools.get(`ssh_${name}`);
    assert.deepEqual(tool.parameters, base.parameters);
    assert.deepEqual(tool.constrainedSampling, base.constrainedSampling);
    assert.equal(tool.prepareArguments, base.prepareArguments);
    assert.equal(tool.renderShell, base.renderShell);
    assert.ok(tool.description.startsWith(base.description));
    for (const guideline of base.promptGuidelines) {
      assert.ok(tool.promptGuidelines.includes(guideline.replace(/\b(read|write|edit|bash)\b/g, "ssh_$1")));
    }
  }
});

test("relative paths use remote cwd, not ctx.cwd or process.cwd", async () => {
  await writeFile(join(localCwd, "same.txt"), "local untouched");
  await call("write", { path: "same.txt", content: "remote old\n" });
  assert.equal(text(await call("read", { path: "same.txt" })), "remote old\n");
  const result = await call("edit", { path: "same.txt", edits: [{ oldText: "old", newText: "new" }] });
  assert.match(result.details.patch, /same\.txt/);
  assert.doesNotMatch(JSON.stringify(result), /pi-ssh-[a-f0-9-]+\//);
  assert.equal(await readFile(join(cwd, "same.txt"), "utf8"), "remote new\n");
  assert.equal(await readFile(join(localCwd, "same.txt"), "utf8"), "local untouched");
});

test("remote home, @ prefix, parent paths, absolute paths and root cwd work", async () => {
  for (const path of ["@~/home.txt", "../parent.txt", join(root, "absolute.txt"), "nested/deep/file.txt"]) {
    await call("write", { path, content: "before" });
    await call("edit", { path, oldText: "before", newText: "after" });
    assert.equal(text(await call("read", { path })), "after");
  }
  await commands.get("ssh").handler("fake:/", ctx);
  try {
    await call("edit", { path: join(root, "absolute.txt"), edits: [{ oldText: "after", newText: "root" }] });
  } finally {
    await commands.get("ssh").handler("fake:~/project", ctx);
  }
});

test("read applies remote screenshot, NFD and curly quote fallbacks", async () => {
  for (const [actual, input] of [
    ["Screenshot 10.00.00\u202fAM.png", "Screenshot 10.00.00 AM.png"],
    ["cafe\u0301.txt", "café.txt"],
    ["Capture d’écran.txt", "Capture d'écran.txt"],
    ["café d’écran.txt".normalize("NFD"), "café d'écran.txt"],
  ]) {
    await writeFile(join(cwd, actual), "not an image");
    const result = await call("read", { path: input }).catch((error) => { throw new Error(`Fallback failed for ${input}`, { cause: error }); });
    assert.equal(text(result), "not an image");
  }
});

test("quoted paths and literal shell metacharacters are safe", async () => {
  const path = "a 'quoted' $(touch SHOULD_NOT_EXIST) file.txt";
  await call("write", { path, content: "original" });
  await call("edit", { path, edits: [{ oldText: "original", newText: "changed" }] });
  assert.equal(text(await call("read", { path })), "changed");
  assert.ok(!(await readdir(home)).includes("SHOULD_NOT_EXIST"));
});

test("multi-edits preserve BOM/CRLF and reject ambiguity, overlaps and missing text", async () => {
  const path = "multi.txt";
  await call("write", { path, content: "\ufeffalpha\r\nbeta\r\ngamma\r\n" });
  await call("edit", { path, edits: [{ oldText: "alpha\nbeta", newText: "ALPHA\nBETA" }, { oldText: "gamma", newText: "GAMMA" }] });
  assert.equal(await readFile(join(cwd, path), "utf8"), "\ufeffALPHA\r\nBETA\r\nGAMMA\r\n");
  for (const edits of [
    [{ oldText: "A", newText: "x" }],
    [{ oldText: "ALPHA", newText: "x" }, { oldText: "LPH", newText: "y" }],
    [{ oldText: "missing", newText: "x" }],
  ]) {
    await assert.rejects(call("edit", { path, edits }));
  }
  assert.equal(await readFile(join(cwd, path), "utf8"), "\ufeffALPHA\r\nBETA\r\nGAMMA\r\n");
});

test("read retains offsets, limits, truncation and remote-only long-line hint", async () => {
  await call("write", { path: "lines.txt", content: Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n") });
  assert.match(text(await call("read", { path: "lines.txt" })), /Use offset=2001/);
  assert.match(text(await call("read", { path: "lines.txt", offset: 2, limit: 1 })), /^line 1\n/);
  await assert.rejects(call("read", { path: "lines.txt", offset: 3000 }), /beyond end/);
  await call("write", { path: "long.txt", content: "x".repeat(60000) });
  const hint = text(await call("read", { path: "long.txt" }));
  assert.match(hint, /Use ssh_bash:/);
  assert.ok(hint.includes(join(cwd, "long.txt")));
  assert.ok(!hint.includes("pi-ssh-image"));
});

test("image detection matches native pi for content, including BMP and misleading extensions", async () => {
  const bmp = Buffer.alloc(58);
  bmp.write("BM"); bmp.writeUInt32LE(58, 2); bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(1, 18); bmp.writeInt32LE(1, 22);
  bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
  const apng = Buffer.concat([png.subarray(0, 33), Buffer.from([0, 0, 0, 8]), Buffer.from("acTL"), Buffer.alloc(12), png.subarray(33)]);
  const fixtures = [
    ["image-no-extension", png], ["bitmap.dat", bmp], ["fake.png", Buffer.from("plain text")],
    ["animated.png", apng], ["not-bitmap.bmp", Buffer.from("BM is not a valid BMP")],
    ["lossless.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xf7])],
    ["tiny.gif", Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64")],
  ];
  for (const [name, bytes] of fixtures) {
    const path = join(cwd, name);
    await writeFile(path, bytes);
    const expected = await native.createReadToolDefinition(cwd).execute("native", { path }, undefined, undefined, { ...ctx, cwd });
    const actual = await call("read", { path: name });
    assert.deepEqual(actual, expected);
    if (["image-no-extension", "bitmap.dat", "tiny.gif"].includes(name)) {
      assert.ok(actual.content.some((item) => item.type === "image"), `${name} must produce an actual image attachment`);
    }
  }
});

test("same-path writes and edits share the native mutation queue", async () => {
  await call("write", { path: "queue.txt", content: "a b" });
  await Promise.all([
    call("edit", { path: "queue.txt", edits: [{ oldText: "a", newText: "A" }] }),
    call("edit", { path: "./queue.txt", edits: [{ oldText: "b", newText: "B" }] }),
  ]);
  assert.equal(await readFile(join(cwd, "queue.txt"), "utf8"), "A B");
  await Promise.all([
    call("write", { path: "queue.txt", content: "reset" }),
    call("edit", { path: join(cwd, "queue.txt"), edits: [{ oldText: "reset", newText: "done" }] }),
  ]);
  assert.equal(await readFile(join(cwd, "queue.txt"), "utf8"), "done");
});

test("edit header owns its shell without scheduling a local preview", async () => {
  const tool = tools.get("ssh_edit");
  const state = {};
  const args = { path: join(localCwd, "same.txt"), edits: [{ oldText: "local", newText: "oops" }] };
  const renderContext = { args, state, cwd: localCwd, argsComplete: true, executionStarted: true, isError: false,
    invalidate() { assert.fail("No asynchronous local preview should be scheduled"); } };
  const theme = { fg: (_c, s) => s, bg: (_c, s) => s, bold: (s) => s };
  const header = tool.renderCall(args, theme, renderContext);
  assert.equal(state.callComponent, undefined);
  assert.equal(state.sshHeader, header);
  assert.ok(header.render(100).join("\n").includes("ssh_edit"));
  const result = tool.renderResult({ content: [{ type: "text", text: "remote error" }] }, { isPartial: false }, theme, { ...renderContext, isError: true });
  assert.ok(result.render(100).join("\n").includes("remote error"));
  assert.equal(state.sshSettled, true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await readFile(join(localCwd, "same.txt"), "utf8"), "local untouched");
});

test("failed cwd activation leaves the previous target intact", async () => {
  await assert.rejects(commands.get("ssh").handler("fake:~/no-such-directory", ctx), /SSH failed/);
  assert.equal(text(await call("read", { path: "same.txt" })), "remote new\n");
});

test("errors expose remote paths, cancellation prevents writes, and local tools remain active", async () => {
  await assert.rejects(call("edit", { path: "missing.txt", edits: [{ oldText: "a", newText: "b" }] }), (error) => {
    assert.ok(error.message.includes(join(cwd, "missing.txt")));
    assert.ok(!/pi-ssh-[a-f0-9-]+\//.test(error.message));
    return true;
  });
  const controller = new AbortController(); controller.abort();
  for (const name of ["read", "write", "edit"]) {
    await assert.rejects(call(name, { path: "cancelled.txt", content: "oops", edits: [{ oldText: "a", newText: "b" }] }, controller.signal), /abort/i);
  }
  assert.ok(!(await readdir(cwd)).includes("cancelled.txt"));
  assert.ok(active.includes("read") && active.includes("ssh_read"));
  await commands.get("ssh").handler("off", ctx);
  assert.deepEqual(active, ["read", "write", "edit", "bash"]);
  await assert.rejects(call("read", { path: "same.txt" }), /SSH mode is off/);
});
