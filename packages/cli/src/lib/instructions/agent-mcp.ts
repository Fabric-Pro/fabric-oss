/**
 * Registering a project's Fabric MCP server with each coding tool, as part of
 * `fabric instructions init`.
 *
 * The server is the project's own gateway, `<origin>/api/mcp-gateway/projects/
 * <id>`, so the tool reaches that project and nothing else. Each tool is written
 * through its own command line (`claude mcp add ...`, `codex mcp add ...`), never
 * by editing its configuration files. What is registered already is read from
 * those files, as data (`agent-mcp-config.ts`), and never by asking the tool:
 * Claude Code's `mcp get` and `mcp list` health-check the servers they name, and
 * in a checkout one of them can be the repository's own project-scope `fabric`.
 * Nothing here prints what a tool says, and a name read from a file is shown only
 * if it is plain.
 *
 * What a run does for a tool that already has a server of that name:
 *
 *   - the same URL: nothing, it is already done;
 *   - another URL that is a Fabric gateway of this deployment, in the scope this
 *     run writes to: replaced, it is Fabric's to replace;
 *   - anything else: left alone, and said so with the line to do it by hand.
 *
 * A line to do something by hand is printed only when every word of it is plain
 * (`shell-words.ts`); a deployment address that is not is never written into one
 * and never repeated, and the person is told so instead.
 *
 * Signing the tool in is the person's browser step. At a terminal the tool's own
 * `mcp login` is run with the terminal handed to it; otherwise its line is
 * printed. A login that does not finish never fails `init`.
 */
import { isGatewayUrlOf, projectResource } from "../oauth/project-resource.js";
import { NO_LINE_FOR_ADDRESS, pasteableLine } from "../shell-words.js";
import {
	type AgentMcpFact,
	type ClaudeServer,
	readClaudeServers,
	readCodexServers,
	readRegistration,
} from "./agent-mcp-config.js";
import type { AgentCommand, AgentRun, AgentRunner } from "./agent-run.js";
import { findSessionStartHooks, type InstructionsHookTool } from "./hook.js";

/** Claude Code's server for a project, kept in the checkout's own (local) scope. */
const CLAUDE_SERVER_NAME = "fabric";

/** How long each step may take. */
const WRITE_TIMEOUT_MS = 20_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

const TOOL_LABEL: Record<InstructionsHookTool, string> = {
	"claude-code": "Claude Code",
	codex: "Codex",
};

const TOOL_COMMAND: Record<InstructionsHookTool, AgentCommand> = {
	"claude-code": "claude",
	codex: "codex",
};

type AgentMcpOutcome =
	| { kind: "registered" }
	| { kind: "replaced" }
	| { kind: "already" }
	| { kind: "left"; reason: "foreign" | "other-scope" }
	/** The tool's command is not on PATH. */
	| { kind: "skipped" }
	/**
	 * Left for the person to run: the tool signs in as part of adding the server,
	 * which opens a browser and waits for it, and nobody is at the terminal.
	 */
	| { kind: "manual" }
	/** The tool could not write the server, or what is registered could not be read. */
	| { kind: "failed" };

/** How signing the tool in to the server went. */
type AgentMcpLogin =
	| "completed"
	| "not-finished"
	/** Printed for the person to run, because nobody was there to walk through it. */
	| "printed"
	/** Printed for a server that was registered before, which may not be signed in. */
	| "hint"
	| "unneeded";

export interface AgentMcpResult {
	tool: InstructionsHookTool;
	/** The name the server is registered under, as it may be shown. */
	name: string;
	/** The name a run registers it under, which an earlier registration may not use. */
	expectedName: string;
	url: string;
	outcome: AgentMcpOutcome;
	login: AgentMcpLogin;
	/** The line that registers the server by hand, or `null` when it cannot be written as one. */
	registerLine: string | null;
	/** The line that signs the tool in to it, or `null` when it cannot be written as one. */
	loginLine: string | null;
}

/** Whether every selected tool has this project's server registered. */
export function mcpRegistrationComplete(
	results: readonly AgentMcpResult[],
): boolean {
	return results.every(
		(result) =>
			result.outcome.kind === "registered" ||
			result.outcome.kind === "replaced" ||
			result.outcome.kind === "already",
	);
}

/** Whether registration completed but the coding tool still needs its own OAuth sign-in. */
export function mcpAuthenticationPending(
	results: readonly AgentMcpResult[],
): boolean {
	return results.some(
		(result) =>
			result.login === "printed" || result.login === "not-finished",
	);
}

/** How much of a project's id ends its server name, to tell it from another project's. */
const SERVER_ID_SUFFIX_LENGTH = 6;

/**
 * Codex keeps one global list of servers, so each project's carries its own
 * name: `fabric-` and the last six letters and digits of the project's id, which
 * is the name VS Code's and Cursor's links give a server with no project name to
 * slug (`editorServerName` in the web app, which this CLI cannot import). The
 * name comes from the id alone because `doctor` reads Codex's file with no
 * project name to hand, and `init --project` has none either. An id with no
 * letter or digit in it is used whole.
 */
export function codexServerName(projectId: string): string {
	const suffix = projectId
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "")
		.slice(-SERVER_ID_SUFFIX_LENGTH);
	return `fabric-${suffix === "" ? projectId : suffix}`;
}

export function serverNameFor(
	tool: InstructionsHookTool,
	projectId: string,
): string {
	return tool === "codex" ? codexServerName(projectId) : CLAUDE_SERVER_NAME;
}

/** What a server may be called for its name to be shown, which is what Codex accepts. */
const PLAIN_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A name read out of a file somebody else may have written, as it may be shown.
 * One with a character a terminal reads, or one that is not plain, is said to be
 * unusual and not repeated.
 */
function shownName(name: string): string {
	return PLAIN_NAME.test(name) ? name : "(a name with unusual characters)";
}

function registerArguments(
	tool: InstructionsHookTool,
	name: string,
	url: string,
): string[] {
	return tool === "codex"
		? ["mcp", "add", name, "--url", url]
		: ["mcp", "add", "--scope", "local", "--transport", "http", name, url];
}

function loginArguments(name: string): string[] {
	return ["mcp", "login", name];
}

/** One line to run by hand, or `null` when any word of it is not plain. */
function lineOf(command: AgentCommand, args: readonly string[]): string | null {
	return pasteableLine([command, ...args]);
}

/** `run: <line>` for a sentence that ends in what to do, or why there is nothing to run. */
function byHand(line: string | null): string {
	return line === null ? NO_LINE_FOR_ADDRESS : `run: ${line}`;
}

/**
 * What each coding tool this project's hook is installed for says about the
 * project's server, read from the tool's configuration and never by running it
 * (`doctor` runs nothing). A tool with no hook for the project is not one the
 * person uses it with here, so it is not asked about.
 */
export async function agentRegistrationFacts(input: {
	root: string;
	/** The checkout's top folder, where Claude Code's local scope is the project. */
	cwd: string;
	projectId: string;
	origin: string;
	home: string | null;
	env: Readonly<Record<string, string | undefined>>;
	platform: NodeJS.Platform;
}): Promise<AgentMcpFact[]> {
	const url = projectResource(input.origin, "mcp", input.projectId);
	const facts: AgentMcpFact[] = [];
	for (const tool of ["claude-code", "codex"] as const) {
		const hooks = await findSessionStartHooks({
			root: input.root,
			projectId: input.projectId,
			tool,
		});
		if (hooks.state !== "ok" || hooks.commands.length === 0) {
			continue;
		}
		const name = serverNameFor(tool, input.projectId);
		facts.push({
			tool,
			name,
			state: await readRegistration({
				tool,
				name,
				url,
				cwd: input.cwd,
				home: input.home,
				env: input.env,
				platform: input.platform,
			}),
			registerLine: lineOf(
				TOOL_COMMAND[tool],
				registerArguments(tool, name, url),
			),
		});
	}
	return facts;
}

function succeeded(run: AgentRun): boolean {
	return run.kind === "exited" && run.code === 0;
}

interface Registration {
	outcome: AgentMcpOutcome;
	/** The name the server ended up under, which may be one the person chose. */
	name: string;
	/** How the sign-in went, when the command that registered the server also signed in. */
	login?: AgentMcpLogin;
}

interface Where {
	cwd: string;
	origin: string;
	url: string;
	home: string | null;
	env: Readonly<Record<string, string | undefined>>;
	platform: NodeJS.Platform;
}

/** Whether a server of this deployment's own gateway, whichever project it is for. */
function isOurs(origin: string, url: string | null): boolean {
	return url !== null && isGatewayUrlOf(origin, url);
}

async function registerWithClaude(
	run: AgentRunner,
	context: Where,
): Promise<Registration> {
	const name = CLAUDE_SERVER_NAME;
	const read = await readClaudeServers({
		name,
		cwd: context.cwd,
		home: context.home,
		env: context.env,
		platform: context.platform,
	});
	if (read.state !== "read") {
		return { outcome: { kind: "failed" }, name };
	}
	const existing: readonly ClaudeServer[] = read.servers;

	if (existing.some((server) => server.url === context.url)) {
		return { outcome: { kind: "already" }, name };
	}
	if (existing.some((server) => !isOurs(context.origin, server.url))) {
		return { outcome: { kind: "left", reason: "foreign" }, name };
	}
	const replacing = existing.length > 0;
	if (replacing) {
		if (!existing.some((server) => server.scope === "local")) {
			return { outcome: { kind: "left", reason: "other-scope" }, name };
		}
		const removed = await run(
			"claude",
			["mcp", "remove", name, "--scope", "local"],
			{ cwd: context.cwd, timeoutMs: WRITE_TIMEOUT_MS },
		);
		if (removed.kind === "missing") {
			return { outcome: { kind: "skipped" }, name };
		}
		if (!succeeded(removed)) {
			return { outcome: { kind: "failed" }, name };
		}
	}

	const added = await run(
		"claude",
		registerArguments("claude-code", name, context.url),
		{ cwd: context.cwd, timeoutMs: WRITE_TIMEOUT_MS },
	);
	if (added.kind === "missing") {
		return { outcome: { kind: "skipped" }, name };
	}
	return {
		outcome: succeeded(added)
			? { kind: replacing ? "replaced" : "registered" }
			: { kind: "failed" },
		name,
	};
}

/**
 * Codex signs in as part of `codex mcp add`: once the server answers an
 * unauthenticated request with an OAuth challenge, which a project's gateway
 * does, the command registers it, opens the browser and waits for the callback,
 * and there is no option that skips that. So the add is run only where a person
 * can finish it, with the terminal handed over, and is not followed by a login.
 * Nowhere else is it run at all: it would block until it timed out, report a
 * failure for a server it had written, and open a browser nobody asked for.
 */
async function registerWithCodex(
	run: AgentRunner,
	context: Where & { name: string },
	interactive: boolean,
): Promise<Registration> {
	const read = await readCodexServers({
		home: context.home,
		env: context.env,
	});
	if (read.state !== "read") {
		return { outcome: { kind: "failed" }, name: context.name };
	}
	const servers = read.servers;

	const sameUrl = servers.find((server) => server.url === context.url);
	if (sameUrl !== undefined) {
		return { outcome: { kind: "already" }, name: sameUrl.name };
	}
	const sameName = servers.find((server) => server.name === context.name);
	if (sameName !== undefined && !isOurs(context.origin, sameName.url)) {
		return {
			outcome: { kind: "left", reason: "foreign" },
			name: context.name,
		};
	}

	if (!interactive) {
		return { outcome: { kind: "manual" }, name: context.name };
	}
	// `codex mcp add` of an existing name replaces it, so a gateway that is
	// this deployment's own, on another project, is replaced by the same call.
	const written = sameName === undefined ? "registered" : "replaced";
	const added = await run(
		"codex",
		registerArguments("codex", context.name, context.url),
		{ cwd: context.cwd, timeoutMs: LOGIN_TIMEOUT_MS, interactive: true },
	);
	if (added.kind === "missing") {
		return { outcome: { kind: "skipped" }, name: context.name };
	}
	if (succeeded(added)) {
		return {
			outcome: { kind: written },
			name: context.name,
			login: "completed",
		};
	}
	// The add writes the server before it waits for the sign-in, so a command
	// that failed or was cut off may have registered it all the same: what is
	// registered is read again, and a server that is there is reported as
	// registered and not signed in.
	const after = await readCodexServers({
		home: context.home,
		env: context.env,
	});
	const registered =
		after.state === "read" &&
		after.servers.some(
			(server) =>
				server.name === context.name && server.url === context.url,
		);
	return registered
		? {
				outcome: { kind: written },
				name: context.name,
				login: "not-finished",
			}
		: { outcome: { kind: "failed" }, name: context.name };
}

export interface RegisterAgentMcpInput {
	tools: readonly InstructionsHookTool[];
	projectId: string;
	/** The deployment, as an origin. */
	origin: string;
	/** The checkout's top folder, where Claude Code's local scope is the project. */
	cwd: string;
	/** Where the tools keep their files: what is registered is read from there. */
	home: string | null;
	env: Readonly<Record<string, string | undefined>>;
	platform: NodeJS.Platform;
	run: AgentRunner;
	/** A person is at the terminal, so each tool's sign-in may be walked through now. */
	interactive: boolean;
}

/**
 * Register the project's MCP server with each tool, then sign each tool in that
 * was newly set up. Never throws and never fails the caller: every step that
 * does not work is a result that says so, with the line that does it by hand.
 */
export async function registerAgentMcp(
	input: RegisterAgentMcpInput,
): Promise<AgentMcpResult[]> {
	const url = projectResource(input.origin, "mcp", input.projectId);
	const where: Where = {
		cwd: input.cwd,
		origin: input.origin,
		url,
		home: input.home,
		env: input.env,
		platform: input.platform,
	};
	const results: AgentMcpResult[] = [];

	for (const tool of input.tools) {
		const intendedName = serverNameFor(tool, input.projectId);
		const command = TOOL_COMMAND[tool];
		const registration =
			tool === "codex"
				? await registerWithCodex(
						input.run,
						{ ...where, name: intendedName },
						input.interactive,
					)
				: await registerWithClaude(input.run, where);
		const loginLine = lineOf(command, loginArguments(registration.name));
		results.push({
			tool,
			name: shownName(registration.name),
			expectedName: intendedName,
			url,
			outcome: registration.outcome,
			login:
				registration.login ??
				(registration.outcome.kind === "already" && loginLine !== null
					? "hint"
					: "unneeded"),
			registerLine: lineOf(
				command,
				registerArguments(tool, intendedName, url),
			),
			loginLine,
		});
	}

	// A server a command registered without signing in, and that was new, is
	// signed in now; one that was registered before is only told how.
	for (const result of results) {
		if (
			result.login !== "unneeded" ||
			(result.outcome.kind !== "registered" &&
				result.outcome.kind !== "replaced")
		) {
			continue;
		}
		if (!input.interactive || result.loginLine === null) {
			result.login = "printed";
			continue;
		}
		const login = await input.run(
			TOOL_COMMAND[result.tool],
			loginArguments(result.name),
			{
				cwd: input.cwd,
				timeoutMs: LOGIN_TIMEOUT_MS,
				interactive: true,
			},
		);
		result.login =
			login.kind === "exited" && login.code === 0
				? "completed"
				: "not-finished";
	}
	return results;
}

/** What a run says about each tool, one line each, and the line to finish a sign-in. */
export function agentMcpLines(results: readonly AgentMcpResult[]): string[] {
	const lines: string[] = [];
	for (const result of results) {
		const label = TOOL_LABEL[result.tool];
		const outcome = result.outcome;
		switch (outcome.kind) {
			case "registered":
				lines.push(
					`Registered the Fabric MCP server for ${label} as "${result.name}".`,
				);
				break;
			case "replaced":
				lines.push(
					`Replaced the Fabric MCP server "${result.name}" in ${label} with this project's.`,
				);
				break;
			case "already":
				lines.push(
					`The Fabric MCP server is already registered for ${label}${result.name === result.expectedName ? "" : ` as "${result.name}"`}.`,
				);
				break;
			case "left":
				lines.push(
					outcome.reason === "foreign"
						? `${label} already has a server named "${result.name}" that is not a Fabric gateway, so it was left alone. Remove it, then ${byHand(result.registerLine)}`
						: `${label} has a "${result.name}" server in another scope that points at a different Fabric gateway, so it was left alone. Remove it with: ${TOOL_COMMAND[result.tool]} mcp remove ${result.name}, then ${byHand(result.registerLine)}`,
				);
				break;
			case "skipped":
				lines.push(
					`Skipped the ${label} MCP server: ${TOOL_COMMAND[result.tool]} is not on PATH. Once it is, ${byHand(result.registerLine)}`,
				);
				break;
			case "manual":
				lines.push(
					`${label} signs in as part of adding the Fabric MCP server, which opens your browser and waits for you, so init did not run it. ${result.registerLine === null ? NO_LINE_FOR_ADDRESS : `Run: ${result.registerLine}`}`,
				);
				break;
			case "failed":
				lines.push(
					`Could not register the Fabric MCP server for ${label}. ${result.registerLine === null ? NO_LINE_FOR_ADDRESS : `Run: ${result.registerLine}`}`,
				);
				break;
			default: {
				const unreachable: never = outcome;
				return unreachable;
			}
		}
		if (result.login === "printed") {
			lines.push(
				result.loginLine === null
					? `To finish, sign ${label} in to the server with its own mcp login command.`
					: `To finish, sign ${label} in to it: ${result.loginLine}`,
			);
		} else if (result.login === "hint") {
			if (result.loginLine !== null) {
				lines.push(
					`If ${label} has not signed in to it yet, run: ${result.loginLine}`,
				);
			}
		} else if (result.login === "not-finished") {
			lines.push(
				result.loginLine === null
					? `The ${label} sign-in did not finish. Sign in to the server with ${label}'s own mcp login command.`
					: `The ${label} sign-in did not finish. Run: ${result.loginLine}`,
			);
		}
	}
	return lines;
}
