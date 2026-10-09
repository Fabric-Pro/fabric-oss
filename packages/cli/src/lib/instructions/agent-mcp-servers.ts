/**
 * What every server a coding tool holds is, to this project: its own gateway,
 * another project's, the deployment's organization-wide one, someone else's, or
 * a command. `init` and `doctor` ask it the same question of the same files, so
 * both read the tool's servers through here and neither keeps a second copy of
 * the rules.
 *
 * A server is classified by its address alone, never by running it. An address
 * on the deployment's own origin that is not spelled like any published gateway
 * is asked about once, by the probe the caller hands in (`gateway-probe.ts`);
 * without one, or when it does not answer, it is `unknown` and counts for
 * nothing. Only the servers a tool will actually use are `effective`: Claude
 * Code takes, for a name, the first of its local, project and user entries.
 *
 * What is kept of a server is its name, the scope it is in, what it is, and a
 * host that is plain enough to print. Never a path, header or token.
 */
import {
	classifyGatewayUrl,
	type GatewayRelation,
} from "../oauth/project-resource.js";
import { isSafeArgument } from "../shell-words.js";
import {
	type AgentMcpFact,
	type ClaudeScope,
	LEGACY_SERVER_NAME,
	type ReadClaudeInput,
	type ReadCodexInput,
	type RegistrationState,
	readClaudeServers,
	readCodexServers,
} from "./agent-mcp-config.js";
import type { GatewayProbe } from "./gateway-probe.js";
import type { InstructionsHookTool } from "./hook.js";

type ServerKind =
	| Exclude<GatewayRelation, "unfamiliar">
	/** Runs a command, so it has no address. */
	| "command"
	/** On the deployment's origin, and a probe could not say what it is. */
	| "unknown";

export interface ClassifiedServer {
	name: string;
	/** Claude Code's scope, or `null` for a tool with no scopes. */
	scope: ClaudeScope | null;
	kind: ServerKind;
	/** Where it points, as it may be shown: a plain host, `a local command`, or `another address`. */
	points: string;
	/** The tool will use this one for its name, not a different scope's. */
	effective: boolean;
}

/** More than this many unfamiliar addresses are not asked about. */
const MAX_PROBES = 4;

const SCOPE_PRECEDENCE: readonly ClaudeScope[] = ["local", "project", "user"];

/** What a server may be called for its name to be shown, which is what Codex accepts. */
const PLAIN_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A name read out of a file somebody else may have written, as it may be shown.
 * One with a character a terminal reads, or one that is not plain, is said to be
 * unusual and not repeated.
 */
export function shownName(name: string): string {
	return PLAIN_NAME.test(name) ? name : "(a name with unusual characters)";
}

/** Where a server points, for a sentence: its host when that is plain enough to print, otherwise only what kind of place it is. */
export function describeTarget(url: string | null): string {
	if (url === null) {
		return "a local command";
	}
	try {
		const { host } = new URL(url);
		return host !== "" && isSafeArgument(host) ? host : "another address";
	} catch {
		return "another address";
	}
}

interface RawServer {
	name: string;
	scope: ClaudeScope | null;
	url: string | null;
}

function effectiveFlags(servers: readonly RawServer[]): boolean[] {
	const winners = new Map<string, ClaudeScope>();
	for (const server of servers) {
		const current = winners.get(server.name);
		if (
			server.scope !== null &&
			(current === undefined ||
				SCOPE_PRECEDENCE.indexOf(server.scope) <
					SCOPE_PRECEDENCE.indexOf(current))
		) {
			winners.set(server.name, server.scope);
		}
	}
	return servers.map(
		(server) =>
			server.scope === null || winners.get(server.name) === server.scope,
	);
}

interface ClassifyContext {
	origin: string;
	projectId: string;
	probe?: GatewayProbe | undefined;
}

async function classifyServers(
	servers: readonly RawServer[],
	context: ClassifyContext,
): Promise<ClassifiedServer[]> {
	const flags = effectiveFlags(servers);
	const probed = new Map<string, Promise<ServerKind>>();
	const classified: ClassifiedServer[] = [];
	for (const [index, server] of servers.entries()) {
		const points = describeTarget(server.url);
		const effective = flags[index] === true;
		const base = {
			name: server.name,
			scope: server.scope,
			points,
			effective,
		};
		if (server.url === null) {
			classified.push({ ...base, kind: "command" });
			continue;
		}
		const relation = classifyGatewayUrl(
			context.origin,
			context.projectId,
			server.url,
		);
		if (relation !== "unfamiliar") {
			classified.push({ ...base, kind: relation });
			continue;
		}
		const url = server.url;
		let answer = probed.get(url);
		if (answer === undefined) {
			answer =
				context.probe === undefined || probed.size >= MAX_PROBES
					? Promise.resolve("unknown")
					: context.probe(url).catch((): ServerKind => "unknown");
			probed.set(url, answer);
		}
		classified.push({ ...base, kind: await answer });
	}
	return classified;
}

export type ServersInspection =
	| { state: "read"; servers: ClassifiedServer[] }
	/** The tool's file exists and could not be used. */
	| { state: "unreadable" }
	/** There is no home folder to look in. */
	| { state: "unlocated" };

export interface InspectInput extends ReadClaudeInput, ReadCodexInput {
	tool: InstructionsHookTool;
	origin: string;
	projectId: string;
	probe?: GatewayProbe | undefined;
}

/** Every server the tool holds, read from its files and classified. */
export async function inspectServers(
	input: InspectInput,
): Promise<ServersInspection> {
	if (input.tool === "codex") {
		const read = await readCodexServers(input);
		return read.state === "read"
			? {
					state: "read",
					servers: await classifyServers(
						read.servers.map((server) => ({
							...server,
							scope: null,
						})),
						input,
					),
				}
			: { state: read.state };
	}
	const read = await readClaudeServers(input);
	return read.state === "read"
		? { state: "read", servers: await classifyServers(read.servers, input) }
		: { state: read.state };
}

function names(servers: readonly ClassifiedServer[]): string[] {
	return [...new Set(servers.map((server) => server.name))];
}

/** The servers the tool will use that point at this project's gateway. */
export function projectServersOf(
	servers: readonly ClassifiedServer[],
): ClassifiedServer[] {
	return servers.filter(
		(server) => server.effective && server.kind === "this-project",
	);
}

/** The servers the tool will use that are the organization-wide gateway. */
export function orgWideServersOf(
	servers: readonly ClassifiedServer[],
): ClassifiedServer[] {
	return servers.filter(
		(server) => server.effective && server.kind === "org-wide",
	);
}

/** What the tool's servers say about the project's, for one tool. */
export function registrationOf(
	servers: readonly ClassifiedServer[],
	name: string,
): Pick<
	AgentMcpFact,
	"state" | "projectServers" | "orgWide" | "foreignSameName"
> {
	const here = names(projectServersOf(servers));
	const sameName = servers.filter((server) => server.name === name);
	const state: RegistrationState =
		here.length === 0
			? sameName.length > 0
				? "elsewhere"
				: "missing"
			: !here.includes(name) &&
					here.every((n) => n === LEGACY_SERVER_NAME)
				? "legacy"
				: "registered";
	return {
		state,
		projectServers: here.map(shownName),
		orgWide: names(orgWideServersOf(servers)).map(shownName),
		foreignSameName: sameName.some(
			(server) =>
				server.effective &&
				(server.kind === "foreign" ||
					server.kind === "command" ||
					server.kind === "unknown"),
		),
	};
}
