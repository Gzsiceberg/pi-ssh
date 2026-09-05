import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type BashOperations,
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	detectSupportedImageMimeTypeFromFile,
	type EditOperations,
	type EditToolDetails,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

type SshProfile = {
	name: string;
	remote: string;
	cwd?: string;
};

type ActiveSshTarget = {
	name: string;
	remote: string;
	remoteCwd: string;
	remoteHome: string;
};

type SshExecOptions = {
	stdin?: string | Buffer;
	signal?: AbortSignal;
	onStdoutData?: (data: Buffer) => void;
	onStderrData?: (data: Buffer) => void;
	timeoutSeconds?: number;
};

const SSH_STATUS_KEY = "ssh-tools";
const SSH_TOOL_NAMES = ["ssh_read", "ssh_write", "ssh_edit", "ssh_bash"] as const;
const SSH_CONFIG_PATH = join(homedir(), ".ssh", "config");

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

// Opaque ASCII paths keep pi's local path fallbacks and mutation queue from
// consulting real local files. The same host + normalized path shares a queue.
const FILE_WORKSPACE = join(tmpdir(), `pi-ssh-${randomUUID()}`);

function resolveRemotePath(input: string, target: ActiveSshTarget): string {
	let path = input.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ").replace(/^@/, "");
	if (path === "~") path = target.remoteHome;
	else if (path.startsWith("~/")) path = posix.join(target.remoteHome, path.slice(2));
	if (path.startsWith("file://")) path = fileURLToPath(path);
	return posix.resolve(target.remoteCwd, path);
}

function fileWorkspacePath(target: ActiveSshTarget, path: string): string {
	const key = createHash("sha256").update(JSON.stringify([target.remote, path])).digest("hex");
	return join(FILE_WORKSPACE, key);
}

function remotePrompt(text: string): string {
	return text.replace(/\b(read|write|edit|bash)\b/g, "ssh_$1");
}

// Keep user-facing paths (including unified patch headers) out of the opaque
// local namespace. No file content is stored at a workspace path.
async function withRemoteFile<T extends { content: Array<{ type: string; text?: string }>; details?: unknown }>(
	target: ActiveSshTarget,
	path: string,
	execute: (workspacePath: string) => Promise<T>,
): Promise<T> {
	const workspacePath = fileWorkspacePath(target, path);
	const restore = (text: string) => text.replaceAll(workspacePath, path);
	try {
		const result = await execute(workspacePath);
		for (const item of result.content) {
			if (item.type === "text" && item.text) item.text = restore(item.text);
		}
		const details = result.details as { patch?: string } | undefined;
		if (details?.patch) details.patch = restore(details.patch);
		return result;
	} catch (error) {
		if (error instanceof Error) error.message = restore(error.message);
		throw error;
	}
}

async function resolveRemoteReadPath(path: string, target: ActiveSshTarget, signal?: AbortSignal): Promise<string> {
	// Match pi's screenshot/Unicode fallbacks, but test existence on the host.
	const nfd = path.normalize("NFD");
	const candidates = [...new Set([
		path,
		path.replace(/ (AM|PM)\./gi, "\u202F$1."),
		nfd,
		path.replace(/'/g, "\u2019"),
		nfd.replace(/'/g, "\u2019"),
	])];
	const script = candidates.map((candidate, index) =>
		`if test -e ${shellQuote(candidate)}; then printf '%s' ${index}; exit 0; fi`,
	).join("\n");
	const found = (await sshOk(target.remote, `${script}\nprintf '%s' 0`, { signal })).toString("utf8");
	return candidates[Number(found)] ?? path;
}

function parseSshConfigProfiles(): SshProfile[] {
	if (!existsSync(SSH_CONFIG_PATH)) {
		return [];
	}

	const text = readFileSync(SSH_CONFIG_PATH, "utf8");
	const profiles = new Map<string, SshProfile>();

	for (const rawLine of text.split("\n")) {
		const withoutComment = rawLine.replace(/\s+#.*$/, "").trim();
		if (!withoutComment) continue;

		const match = withoutComment.match(/^Host\s+(.+)$/i);
		if (!match) continue;

		const aliases = match[1]
			.split(/\s+/)
			.map((alias) => alias.trim())
			.filter(Boolean)
			.filter((alias) => !alias.includes("*") && !alias.includes("?") && !alias.startsWith("!"));

		for (const alias of aliases) {
			if (!profiles.has(alias)) {
				profiles.set(alias, { name: alias, remote: alias });
			}
		}
	}

	return Array.from(profiles.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeTargetArg(arg: string, profiles: SshProfile[]): SshProfile {
	const trimmed = arg.trim();
	const matchedProfile = profiles.find((profile) => profile.name === trimmed);
	if (matchedProfile) {
		return matchedProfile;
	}

	const separatorIndex = trimmed.indexOf(":");
	if (separatorIndex > 0) {
		return {
			name: trimmed.slice(0, separatorIndex),
			remote: trimmed.slice(0, separatorIndex),
			cwd: trimmed.slice(separatorIndex + 1),
		};
	}

	return { name: trimmed, remote: trimmed };
}

function sshExec(remote: string, command: string, options: SshExecOptions = {}) {
	return new Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number | null }>((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		const child = spawn("ssh", ["--", remote, command], { stdio: ["pipe", "pipe", "pipe"] });
		// A remote command may exit before consuming stdin (e.g. permission denied).
		child.stdin.on("error", () => {});
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let timedOut = false;
		const timer =
			typeof options.timeoutSeconds === "number" && options.timeoutSeconds > 0
				? setTimeout(() => {
						timedOut = true;
						child.kill();
					}, options.timeoutSeconds * 1000)
				: undefined;

		const cleanup = () => {
			if (timer) clearTimeout(timer);
			if (options.signal) options.signal.removeEventListener("abort", onAbort);
		};

		const onAbort = () => {
			child.kill();
		};

		child.stdout.on("data", (data: Buffer) => {
			stdoutChunks.push(data);
			options.onStdoutData?.(data);
		});
		child.stderr.on("data", (data: Buffer) => {
			stderrChunks.push(data);
			options.onStderrData?.(data);
		});
		child.on("error", (error) => {
			cleanup();
			reject(error);
		});
		child.on("close", (exitCode) => {
			cleanup();
			if (options.signal?.aborted) {
				reject(new Error("aborted"));
				return;
			}
			if (timedOut) {
				reject(new Error(`timeout:${options.timeoutSeconds}`));
				return;
			}
			resolve({
				stdout: Buffer.concat(stdoutChunks),
				stderr: Buffer.concat(stderrChunks),
				exitCode,
			});
		});

		if (options.signal) {
			if (options.signal.aborted) {
				onAbort();
			} else {
				options.signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		if (options.stdin !== undefined) {
			child.stdin.write(options.stdin);
		}
		child.stdin.end();
	});
}

async function sshOk(remote: string, command: string, options: SshExecOptions = {}): Promise<Buffer> {
	const { stdout, stderr, exitCode } = await sshExec(remote, command, options);
	if (exitCode !== 0) {
		const errorText = stderr.toString("utf8").trim() || stdout.toString("utf8").trim() || "unknown ssh error";
		throw new Error(`SSH failed (${exitCode}): ${errorText}`);
	}
	return stdout;
}

async function resolveRemoteTarget(profile: SshProfile): Promise<ActiveSshTarget> {
	const info = (await sshOk(profile.remote, `printf '%s\\0' "$HOME"; pwd`)).toString("utf8");
	const [remoteHome, cwd] = info.split("\0");
	if (!remoteHome?.startsWith("/") || !cwd?.startsWith("/")) {
		throw new Error("SSH host did not return an absolute home and working directory.");
	}
	const target = { name: profile.name, remote: profile.remote, remoteHome, remoteCwd: cwd.replace(/\n$/, "") };
	if (profile.cwd?.trim()) {
		const path = resolveRemotePath(profile.cwd.trim(), target);
		target.remoteCwd = (await sshOk(profile.remote, `cd ${shellQuote(path)} && pwd`)).toString("utf8").replace(/\n$/, "");
	}
	return target;
}

function createRemoteReadOps(target: ActiveSshTarget, path: string, signal?: AbortSignal): ReadOperations {
	let contents: Promise<Buffer> | undefined;
	const readFile = () => contents ??= sshOk(target.remote, `cat ${shellQuote(path)}`, { signal });
	return {
		readFile,
		access: () => sshOk(target.remote, `test -r ${shellQuote(path)}`, { signal }).then(() => {}),
		detectImageMimeType: async () => {
			// Use pi's exported detector rather than maintaining a second signature
			// implementation. Only its sniffing prefix is staged, with mode 0600.
			const buffer = await readFile();
			const dir = await mkdtemp(join(tmpdir(), "pi-ssh-image-"));
			try {
				const file = join(dir, "header");
				await writeFile(file, buffer.subarray(0, 4100), { mode: 0o600 });
				return await detectSupportedImageMimeTypeFromFile(file);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		},
	};
}

function createRemoteWriteOps(target: ActiveSshTarget, path: string, signal?: AbortSignal): WriteOperations {
	return {
		writeFile: async (_absolutePath, content) => {
			await sshOk(target.remote, `cat > ${shellQuote(path)}`, { stdin: content, signal });
		},
		mkdir: () => sshOk(target.remote, `mkdir -p ${shellQuote(posix.dirname(path))}`, { signal }).then(() => {}),
	};
}

function createRemoteEditOps(target: ActiveSshTarget, path: string, signal?: AbortSignal): EditOperations {
	return {
		readFile: () => sshOk(target.remote, `cat ${shellQuote(path)}`, { signal }),
		writeFile: createRemoteWriteOps(target, path, signal).writeFile,
		access: () => sshOk(target.remote, `test -r ${shellQuote(path)} && test -w ${shellQuote(path)}`, { signal }).then(() => {}),
	};
}

function createRemoteBashOps(target: ActiveSshTarget): BashOperations {
	return {
		exec: async (command, _cwd, { onData, signal, timeout }) => {
			// Pi may pass the local session cwd; remote commands must use the SSH target cwd.
			const script = `cd ${shellQuote(target.remoteCwd)}\n${command}\n`;
			const { exitCode } = await sshExec(target.remote, "exec bash -se", {
				stdin: script,
				signal,
				timeoutSeconds: timeout,
				onStdoutData: onData,
				onStderrData: onData,
			});
			return { exitCode };
		},
	};
}

function enableSshTools(pi: ExtensionAPI) {
	const next = new Set(pi.getActiveTools());
	for (const name of SSH_TOOL_NAMES) {
		next.add(name);
	}
	pi.setActiveTools(Array.from(next));
}

function disableSshTools(pi: ExtensionAPI) {
	const next = pi.getActiveTools().filter((name) => !SSH_TOOL_NAMES.includes(name as (typeof SSH_TOOL_NAMES)[number]));
	pi.setActiveTools(next);
}

export default function sshToolsExtension(pi: ExtensionAPI) {
	let activeTarget: ActiveSshTarget | null = null;

	const readBase = createReadToolDefinition("/");
	const writeBase = createWriteToolDefinition("/");
	const editBase = createEditToolDefinition("/");
	const bashBase = createBashToolDefinition("/");

	const requireActiveTarget = (): ActiveSshTarget => {
		if (!activeTarget) {
			throw new Error("SSH mode is off. Use /ssh <host> first.");
		}
		return activeTarget;
	};

	const refreshProfiles = () => parseSshConfigProfiles();

	const updateStatus = (ctx: ExtensionContext) => {
		if (!activeTarget) {
			ctx.ui.setStatus(SSH_STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(
			SSH_STATUS_KEY,
			ctx.ui.theme.fg("accent", `SSH ${activeTarget.name}:${activeTarget.remoteCwd}`),
		);
	};

	const activate = async (profile: SshProfile, ctx: ExtensionCommandContext) => {
		activeTarget = await resolveRemoteTarget(profile);
		enableSshTools(pi);
		updateStatus(ctx);
		ctx.ui.notify(`SSH mode on: ${activeTarget.name} (${activeTarget.remoteCwd})`, "info");
	};

	const deactivate = (ctx: ExtensionCommandContext) => {
		activeTarget = null;
		disableSshTools(pi);
		updateStatus(ctx);
		ctx.ui.notify("SSH mode off", "info");
	};

	pi.registerTool({
		...readBase,
		name: "ssh_read",
		label: "ssh_read",
		description: `${readBase.description} Operates on the active SSH host; relative paths use the remote cwd and ~ uses the remote home.`,
		promptSnippet: `${readBase.promptSnippet} on the active SSH host`,
		promptGuidelines: [
			...(readBase.promptGuidelines ?? []).map(remotePrompt),
			"Use ssh_read when the task is on the active SSH host instead of the local machine.",
		],
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const target = requireActiveTarget();
			const path = await resolveRemoteReadPath(resolveRemotePath(params.path, target), target, signal);
			const tool = createReadToolDefinition(FILE_WORKSPACE, { operations: createRemoteReadOps(target, path, signal) });
			const result = await withRemoteFile(target, path, (workspacePath) =>
				tool.execute(toolCallId, { ...params, path: workspacePath }, signal, onUpdate, { ...ctx, cwd: FILE_WORKSPACE }),
			);
			// Pi's long-line fallback must not tell the model to run a local shell.
			for (const item of result.content) {
				if (item.type === "text" && item.text.startsWith("[Line ") && result.details?.truncation?.firstLineExceedsLimit) {
					item.text = item.text.replace("Use bash:", "Use ssh_bash:")
						.replace(`${path} | head`, `${shellQuote(path)} | head`);
				}
			}
			return result;
		},
		renderCall(args, theme) {
			const path = typeof args?.path === "string" ? args.path : "...";
			const targetLabel = activeTarget ? activeTarget.name : "inactive";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("ssh_read"))} ${theme.fg("accent", path)} ${theme.fg("muted", `[${targetLabel}]`)}`,
				0,
				0,
			);
		},
		renderResult: readBase.renderResult,
	});

	pi.registerTool({
		...writeBase,
		name: "ssh_write",
		label: "ssh_write",
		description: `${writeBase.description} Operates on the active SSH host; relative paths use the remote cwd and ~ uses the remote home.`,
		promptSnippet: `${writeBase.promptSnippet} on the active SSH host`,
		promptGuidelines: (writeBase.promptGuidelines ?? []).map(remotePrompt),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const target = requireActiveTarget();
			const path = resolveRemotePath(params.path, target);
			const tool = createWriteToolDefinition(FILE_WORKSPACE, { operations: createRemoteWriteOps(target, path, signal) });
			return withRemoteFile(target, path, (workspacePath) =>
				tool.execute(toolCallId, { ...params, path: workspacePath }, signal, onUpdate, { ...ctx, cwd: FILE_WORKSPACE }),
			);
		},
		renderCall(args, theme) {
			const path = typeof args?.path === "string" ? args.path : "...";
			const targetLabel = activeTarget ? activeTarget.name : "inactive";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("ssh_write"))} ${theme.fg("accent", path)} ${theme.fg("muted", `[${targetLabel}]`)}`,
				0,
				0,
			);
		},
		renderResult: writeBase.renderResult,
	});

	pi.registerTool<typeof editBase.parameters, EditToolDetails | undefined>({
		...editBase,
		name: "ssh_edit",
		label: "ssh_edit",
		description: `${editBase.description} Operates on the active SSH host; relative paths use the remote cwd and ~ uses the remote home. Absolute paths and ../ are allowed.`,
		promptSnippet: `${editBase.promptSnippet} on the active SSH host`,
		promptGuidelines: (editBase.promptGuidelines ?? []).map(remotePrompt),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const target = requireActiveTarget();
			const path = resolveRemotePath(params.path, target);
			const tool = createEditToolDefinition(FILE_WORKSPACE, { operations: createRemoteEditOps(target, path, signal) });
			return withRemoteFile(target, path, (workspacePath) =>
				tool.execute(toolCallId, { ...params, path: workspacePath }, signal, onUpdate, { ...ctx, cwd: FILE_WORKSPACE }),
			);
		},
		renderCall(args, theme, context) {
			const path = typeof args?.path === "string" ? args.path : "...";
			const targetLabel = activeTarget ? activeTarget.name : "inactive";
			// Native edit's renderCall computes previews from the LOCAL filesystem.
			// Keep a remote-only header, with padding owned by the self-rendered shell.
			const box = (context.lastComponent as Box | undefined) ?? new Box(1, 1);
			context.state.sshHeader = box;
			box.setBgFn((text) => theme.bg(context.isError ? "toolErrorBg" : context.state.sshSettled ? "toolSuccessBg" : "toolPendingBg", text));
			box.clear();
			box.addChild(new Text(
				`${theme.fg("toolTitle", theme.bold("ssh_edit"))} ${theme.fg("accent", path)} ${theme.fg("muted", `[${targetLabel}]`)}`,
				0,
				0,
			));
			return box;
		},
		renderResult(result, options, theme, context) {
			context.state.sshSettled = !options.isPartial;
			const box = context.state.sshHeader as Box | undefined;
			box?.setBgFn((text) => theme.bg(context.isError ? "toolErrorBg" : options.isPartial ? "toolPendingBg" : "toolSuccessBg", text));
			return editBase.renderResult!(result, options, theme, context);
		},
	});

	pi.registerTool({
		name: "ssh_bash",
		label: "ssh_bash",
		description: "Execute a bash command on the active SSH host in the active remote working directory.",
		promptSnippet: "Execute bash commands on the active SSH host",
		promptGuidelines: ["Use ssh_bash when the command must run on the active SSH host rather than locally."],
		parameters: bashBase.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const target = requireActiveTarget();
			const tool = createBashToolDefinition(target.remoteCwd, { operations: createRemoteBashOps(target) });
			return tool.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			const command = typeof args?.command === "string" ? args.command : "...";
			const targetLabel = activeTarget ? activeTarget.name : "inactive";
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				`${theme.fg("toolTitle", theme.bold("ssh_bash"))} ${theme.fg("accent", command)} ${theme.fg("muted", `[${targetLabel}]`)}`,
			);
			return text;
		},
		renderResult: bashBase.renderResult,
	});

	pi.registerCommand("ssh", {
		description: "Toggle remote SSH tools: /ssh, /ssh off, /ssh status, /ssh <host>[:/path]",
		getArgumentCompletions: (prefix) => {
			const options = ["off", "status", ...refreshProfiles().map((profile) => profile.name)];
			const filtered = options.filter((option) => option.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((option) => ({ value: option, label: option })) : null;
		},
		handler: async (args, ctx) => {
			const input = args.trim();
			const profiles = refreshProfiles();

			if (input === "status") {
				if (!activeTarget) {
					ctx.ui.notify("SSH mode is off", "info");
					return;
				}
				ctx.ui.notify(`SSH mode: ${activeTarget.name} (${activeTarget.remote}:${activeTarget.remoteCwd})`, "info");
				return;
			}

			if (input === "off") {
				if (!activeTarget) {
					ctx.ui.notify("SSH mode is already off", "info");
					return;
				}
				deactivate(ctx);
				return;
			}

			if (!input) {
				if (profiles.length === 0) {
					ctx.ui.notify("No SSH hosts found in ~/.ssh/config. Use /ssh <host>[:/path]", "warning");
					return;
				}
				const items = [...(activeTarget ? ["off"] : []), ...profiles.map((profile) => profile.name)];
				const picked = await ctx.ui.select("SSH target", items);
				if (!picked) {
					return;
				}
				if (picked === "off") {
					deactivate(ctx);
					return;
				}
				await activate(normalizeTargetArg(picked, profiles), ctx);
				return;
			}

			await activate(normalizeTargetArg(input, profiles), ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		activeTarget = null;
		disableSshTools(pi);
		updateStatus(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		if (!activeTarget) {
			return;
		}
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\nSSH mode is active for this turn.\nRemote host: ${activeTarget.remote}\nRemote working directory: ${activeTarget.remoteCwd}\nUse ssh_read, ssh_write, ssh_edit, and ssh_bash for remote work. Local read/write/edit/bash still operate on the local machine.`,
		};
	});
}
