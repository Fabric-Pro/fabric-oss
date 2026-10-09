/**
 * Registering a project's Fabric MCP server with each coding tool, as part of
 * `fabric instructions init`.
 *
 * The server is the project's own gateway, `<origin>/api/mcp-gateway/projects/
 * <id>`, so the tool reaches that project and nothing else. Each tool is written
 * through its own command line (`claude mcp add ...`, `codex mcp add ...`), never
 * by editing its configuration files. What is registered already is read from
 * those files, as data, every server of every name (`agent-mcp-config.ts`), and
 * classified by its address alone (`agent-mcp-servers.ts`): this project's
 * gateway, another project's, the organization-wide one, someone else's, or a
 * command. Nothing here prints what a tool says, and a name read from a file is
 * shown only if it is plain.
 *
 * What a run does for each tool:
 *
 *   - a server the tool will use already points at this project, under any
 *     name: nothing, it is already done;
 *   - a server of one of the names Fabric registers under (`fabric-<id>`, or the
 *     older `fabric`, which earlier versions wrote to the checkout's local scope)
 *     points at another project of this deployment, in the one scope this run
 *     writes to: replaced, it is Fabric's to replace;
 *   - the organization-wide server, and any server that is someone else's or
 *     that could not be told: never touched, and the project's server is added
 *     beside it. Only an entry holding the very name the project's server needs
 *     can get in the way, and then it is said so with the line to do it by hand.
 *
 * Once the project's server is there, Claude Code is asked about that one
 * server (`claude mcp get <name>`) whether it is connected, and Codex, which has
 * no such question, is not.
 *
 * A line to do something by hand is printed only when every word of it is plain
 * (`shell-words.ts`); a deployment address that is not is never written into one
 * and never repeated, and the person is told so instead.
 *
 * Signing the tool in is the person's browser step. At a terminal the tool's own
 * `mcp login` is run with the terminal handed to it; otherwise its line is
 * printed. A login that does not finish never fails `init`.
 */
import {
	normalizeServerUrl,
	projectResource,
} from "../oauth/project-resource.js";
import { NO_LINE_FOR_ADDRESS, pasteableLine } from "../shell-words.js";
import {
	type AgentMcpFact,
	LEGACY_SERVER_NAME,
	readCodexServers,
} from "./agent-mcp-config.js";
import {
	type ClassifiedServer,
	describeTarget,
	inspectServers,
	orgWideServersOf,
	projectServersOf,
	registrationOf,
	shownName,
} from "./agent-mcp-servers.js";
import type { AgentCommand, AgentRun, AgentRunner } from "./agent-run.js";
import type { GatewayProbe } from "./gateway-probe.js";
import { findSessionStartHooks, type InstructionsHookTool } from "./hook.js";

/** How long each step may take. */
const WRITE_TIMEOUT_MS = 20_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const STATUS_TIMEOUT_MS = 5_000;

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
	/**
	 * A server of the same name that is not this project's gateway, in the one
	 * place that is the person's own explicit choice for this checkout. `scope`
	 * is Claude Code's local scope, or `null` for a tool with no scopes.
	 */
	| { kind: "left"; scope: "local" | null; points: string }
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
	/** The tool itself reported the server connected, so it is signed in. */
	| "signed-in"
	| "unneeded";

/**
 * What the tool says of the project's server when asked about that one server:
 * only Claude Code can be, so Codex's is `unavailable`, and so is a tool that
 * could not be asked or answered in a way that says nothing.
 */
type AgentMcpStatus =
	| "connected"
	| "needs-sign-in"
	| "unreachable"
	| "unavailable"
	/** Not asked: machine-readable output walks nothing through and starts nothing. */
	| "unchecked";

export interface AgentMcpResult {
	tool: InstructionsHookTool;
	/** The name the server is registered under, as it may be shown. */
	name: string;
	/** The name a run registers it under, which an earlier registration may not use. */
	expectedName: string;
	url: string;
	outcome: AgentMcpOutcome;
	/** Same-name servers in wider scopes that this project's local entry takes precedence over. */
	shadowed: readonly ShadowedServer[];
	/** The name of the person's organization-wide Fabric server, which is left as it is. */
	orgWide: string | null;
	/** Servers whose address is on this deployment but that could not be told apart from Fabric's, and were left as they are. */
	unverified: readonly UnverifiedServer[];
	status: AgentMcpStatus;
	/** The host the project's server is at, as it may be shown, for a status that names it. */
	host: string;
	login: AgentMcpLogin;
	/** The line that registers the server by hand, or `null` when it cannot be written as one. */
	registerLine: string | null;
	/** The line that signs the tool in to it, or `null` when it cannot be written as one. */
	loginLine: string | null;
}

function isRegistered(result: AgentMcpResult): boolean {
	return (
		result.outcome.kind === "registered" ||
		result.outcome.kind === "replaced" ||
		result.outcome.kind === "already"
	);
}

/** Whether every selected tool actually has this project's server registered. */
export function mcpRegistrationComplete(
	results: readonly AgentMcpResult[],
): boolean {
	return results.every(isRegistered);
}

/**
 * Whether a tool could not be set up, as opposed to being left for the person
 * on purpose: Codex signs in as part of adding the server and waits for a
 * browser, so where nobody is at the terminal `init` does not run it, prints
 * the line and goes on (`manual`). That is a note, not a failure.
 */
export function mcpSetupFailed(results: readonly AgentMcpResult[]): boolean {
	return results.some(
		(result) => !isRegistered(result) && result.outcome.kind !== "manual",
	);
}

/** The tools left for the person to finish, each with the line to run. */
export function mcpManualSteps(
	results: readonly AgentMcpResult[],
): Array<{ tool: InstructionsHookTool; registerLine: string | null }> {
	return results
		.filter((result) => result.outcome.kind === "manual")
		.map((result) => ({
			tool: result.tool,
			registerLine: result.registerLine,
		}));
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

/** Every tool's server for a project has the one name, so a project's server is the same wherever it is read. */
export function serverNameFor(projectId: string): string {
	return codexServerName(projectId);
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
	/** Asks where an address on the deployment's origin points, when it is spelled unlike any gateway. */
	probe?: GatewayProbe | undefined;
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
		const name = serverNameFor(input.projectId);
		const inspected = await inspectServers({
			tool,
			origin: input.origin,
			projectId: input.projectId,
			probe: input.probe,
			cwd: input.cwd,
			home: input.home,
			env: input.env,
			platform: input.platform,
		});
		facts.push({
			tool,
			name,
			...(inspected.state === "read"
				? registrationOf(inspected.servers, name)
				: {
						state:
							inspected.state === "unlocated"
								? "missing"
								: "unreadable",
						projectServers: [],
						orgWide: [],
						foreignSameName: false,
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

/** A same-name server in a wider scope that the project's own entry takes precedence over. */
interface ShadowedServer {
	scope: "user" | "project";
	/** Where it points, as it may be shown: a plain host, `a local command`, or `another address`. */
	points: string;
}

/** A server in this tool that could not be told apart from Fabric's, and was left as it is. */
interface UnverifiedServer {
	name: string;
	points: string;
}

/** What a run found around the project's server, to be said and not acted on. */
interface Surroundings {
	shadowed?: ShadowedServer[];
	/** The name of the person's organization-wide Fabric server, which is left as it is. */
	orgWide?: string;
	unverified?: UnverifiedServer[];
}

interface Registration extends Surroundings {
	outcome: AgentMcpOutcome;
	/** The name the server ended up under, which may be one the person chose. */
	name: string;
	/** How the sign-in went, when the command that registered the server also signed in. */
	login?: AgentMcpLogin;
}

interface Where {
	projectId: string;
	cwd: string;
	origin: string;
	url: string;
	home: string | null;
	env: Readonly<Record<string, string | undefined>>;
	platform: NodeJS.Platform;
	probe?: GatewayProbe | undefined;
}

/**
 * Whether two server URLs are the same address however they are spelled (a
 * trailing slash, a host in capitals). Claude Code keeps its OAuth sign-in
 * under the server's name and URL, shared by every checkout that registers
 * the same one, so an entry that already points here must never be removed
 * and added again: `claude mcp remove` signs out every other checkout that
 * holds the same server. Only an entry that points somewhere else is removed.
 */
function sameServerUrl(left: string | null, right: string): boolean {
	if (left === null) {
		return false;
	}
	const normal = normalizeServerUrl(left);
	return normal === null
		? left === right
		: normal === normalizeServerUrl(right);
}

/** What a run says about the servers beside the project's, which it never touches. */
function surroundingsOf(servers: readonly ClassifiedServer[]): Surroundings {
	const orgWide = orgWideServersOf(servers)[0];
	const unverified = servers
		.filter((server) => server.effective && server.kind === "unknown")
		.map((server) => ({
			name: shownName(server.name),
			points: server.points,
		}));
	return {
		...(orgWide === undefined ? {} : { orgWide: shownName(orgWide.name) }),
		unverified,
	};
}

/** The name the project's server is found under: the one Fabric registers, else the older one, else whatever the person chose. */
function foundUnder(
	here: readonly ClassifiedServer[],
	name: string,
): string | undefined {
	return (
		here.find((server) => server.name === name) ??
		here.find((server) => server.name === LEGACY_SERVER_NAME) ??
		here[0]
	)?.name;
}

async function registerWithClaude(
	run: AgentRunner,
	context: Where,
): Promise<Registration> {
	const name = serverNameFor(context.projectId);
	const inspected = await inspectServers({
		tool: "claude-code",
		origin: context.origin,
		projectId: context.projectId,
		probe: context.probe,
		cwd: context.cwd,
		home: context.home,
		env: context.env,
		platform: context.platform,
	});
	if (inspected.state !== "read") {
		return { outcome: { kind: "failed" }, name };
	}
	const servers = inspected.servers;
	const around = surroundingsOf(servers);

	// Whatever name the person gave it, a server Claude Code will use that
	// points at this project is the project's server.
	const alreadyAs = foundUnder(projectServersOf(servers), name);
	if (alreadyAs !== undefined) {
		return { outcome: { kind: "already" }, name: alreadyAs, ...around };
	}

	// Only this checkout's local scope is written to, so only an entry there can
	// be in the way of the name, and only one of Fabric's own names at another of
	// this deployment's projects is stale: the person's other servers, the
	// organization-wide one and a `fabric` of another make are never touched.
	const local = servers.find(
		(server) => server.scope === "local" && server.name === name,
	);
	if (local !== undefined && local.kind !== "other-project") {
		return {
			outcome: { kind: "left", scope: "local", points: local.points },
			name,
			...around,
		};
	}
	const stale = servers
		.filter(
			(server) =>
				server.scope === "local" &&
				server.kind === "other-project" &&
				(server.name === name || server.name === LEGACY_SERVER_NAME),
		)
		.map((server) => server.name);
	// Reached only when no server in use points at this URL, so none removed
	// here is one other checkouts rely on for it.
	for (const staleName of stale) {
		const removed = await run(
			"claude",
			["mcp", "remove", staleName, "--scope", "local"],
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
	return succeeded(added)
		? {
				outcome: { kind: stale.length > 0 ? "replaced" : "registered" },
				name,
				...around,
				shadowed: servers.flatMap((server) =>
					server.name === name &&
					(server.scope === "user" || server.scope === "project")
						? [{ scope: server.scope, points: server.points }]
						: [],
				),
			}
		: { outcome: { kind: "failed" }, name };
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
	const inspected = await inspectServers({
		tool: "codex",
		origin: context.origin,
		projectId: context.projectId,
		probe: context.probe,
		cwd: context.cwd,
		home: context.home,
		env: context.env,
		platform: context.platform,
	});
	if (inspected.state !== "read") {
		return { outcome: { kind: "failed" }, name: context.name };
	}
	const servers = inspected.servers;
	const around = surroundingsOf(servers);

	const alreadyAs = foundUnder(projectServersOf(servers), context.name);
	if (alreadyAs !== undefined) {
		return { outcome: { kind: "already" }, name: alreadyAs, ...around };
	}
	const sameName = servers.find((server) => server.name === context.name);
	if (sameName !== undefined && sameName.kind !== "other-project") {
		return {
			outcome: { kind: "left", scope: null, points: sameName.points },
			name: context.name,
			...around,
		};
	}

	if (!interactive) {
		return { outcome: { kind: "manual" }, name: context.name, ...around };
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
			...around,
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
				server.name === context.name &&
				sameServerUrl(server.url, context.url),
		);
	return registered
		? {
				outcome: { kind: written },
				name: context.name,
				login: "not-finished",
				...around,
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
	/**
	 * Ask Claude Code whether it is already signed in (`claude mcp get`). Off
	 * for machine-readable output, where nothing is walked through and the
	 * extra process only costs time.
	 */
	checkSignIn?: boolean;
	/** Asks where an address on the deployment's origin points, when it is spelled unlike any gateway. */
	probe?: GatewayProbe;
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
		projectId: input.projectId,
		cwd: input.cwd,
		origin: input.origin,
		url,
		home: input.home,
		env: input.env,
		platform: input.platform,
		probe: input.probe,
	};
	const results: AgentMcpResult[] = [];

	for (const tool of input.tools) {
		const intendedName = serverNameFor(input.projectId);
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
			shadowed: registration.shadowed ?? [],
			orgWide: registration.orgWide ?? null,
			unverified: registration.unverified ?? [],
			status: "unchecked",
			host: describeTarget(url),
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

	// Ask Claude Code about the project's server, and only that one, before
	// saying a sign-in is pending: another checkout's sign-in covers this one,
	// and a person who signed in earlier is not asked again. It points at this
	// project's gateway, so what `mcp get` starts is a request to Fabric and
	// nothing else. Codex has no question for one server, so it is not asked.
	for (const result of results) {
		if (!isRegistered(result)) {
			continue;
		}
		if (result.tool === "codex") {
			result.status = "unavailable";
		} else if (input.checkSignIn !== false) {
			result.status = await claudeStatus(
				input.run,
				result.name,
				input.cwd,
			);
		}
		if (result.status === "connected") {
			result.login = "signed-in";
		} else if (
			result.status === "needs-sign-in" &&
			result.outcome.kind === "already" &&
			result.loginLine !== null
		) {
			result.login = "printed";
		}
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

const STATUS_LINE = /^\s*Status:\s*(?:[^\sA-Za-z0-9]+\s+)?(.+?)\s*$/m;

/** What `claude mcp get` says of one server it was asked about, by its `Status:` line. */
async function claudeStatus(
	run: AgentRunner,
	name: string,
	cwd: string,
): Promise<AgentMcpStatus> {
	const answer = await run("claude", ["mcp", "get", name], {
		cwd,
		timeoutMs: STATUS_TIMEOUT_MS,
	});
	if (answer.kind !== "exited" || answer.code !== 0) {
		return "unavailable";
	}
	const status = STATUS_LINE.exec(answer.stdout)?.[1]?.toLowerCase() ?? "";
	if (status === "connected") {
		return "connected";
	}
	if (status === "needs authentication") {
		return "needs-sign-in";
	}
	return /^(?:failed|disconnected|not connected|error)\b/.test(status)
		? "unreachable"
		: "unavailable";
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
					`${label} already has a server named "${result.name}" ${outcome.scope === "local" ? "in this checkout's local settings" : "in its settings"} that points at ${outcome.points}, not at this project's gateway, so it was left alone. Remove it, then ${byHand(result.registerLine)}`,
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
		if (result.orgWide !== null && isRegistered(result)) {
			lines.push(
				`Your organization-wide Fabric server "${result.orgWide}" stays as it is; coding instructions use the project server "${result.name}".`,
			);
		}
		for (const server of result.unverified) {
			lines.push(
				`${label} has a server "${server.name}" at ${server.points} that could not be told apart from Fabric's, so it was left as it is.`,
			);
		}
		for (const server of result.shadowed) {
			lines.push(
				`${label} also has a "${result.name}" server in your ${server.scope} settings (${server.points}); in this checkout the project's gateway takes precedence.`,
			);
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

/**
 * One line per tool for the end of a run: what the project's server is in it,
 * and how far the sign-in has got where the tool can say.
 */
export function agentMcpSummaryLines(
	results: readonly AgentMcpResult[],
): string[] {
	return results.map((result) => {
		const label = TOOL_LABEL[result.tool];
		const outcome = result.outcome;
		if (!isRegistered(result)) {
			return outcome.kind === "manual"
				? `${label}: not registered yet, see above.`
				: `${label}: nothing usable for this project, see above.`;
		}
		const server = `"${result.name}"`;
		if (result.login === "completed" || result.login === "signed-in") {
			return `${label}: ${server} connected.`;
		}
		switch (result.status) {
			case "connected":
				return `${label}: ${server} connected.`;
			case "needs-sign-in":
				return `${label}: ${server} registered, needs sign-in.`;
			case "unreachable":
				return `${label}: ${server} registered, unreachable (${result.host}).`;
			case "unavailable":
				return result.tool === "codex"
					? `${label}: ${server} registered; sign-in status not available for Codex.`
					: `${label}: ${server} registered; its status could not be read.`;
			case "unchecked":
				return `${label}: ${server} registered.`;
			default: {
				const unreachable: never = result.status;
				return unreachable;
			}
		}
	});
}
