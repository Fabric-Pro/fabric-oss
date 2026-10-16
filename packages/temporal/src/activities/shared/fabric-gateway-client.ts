/**
 * Fabric's own MCP gateway as a client sees it: connect as the service
 * credential acting for a user, list the tools, call one.
 *
 * The agent that answers in the Fabric Agent drawer is an MCP client of Fabric
 * MCP exactly like Claude Code is: it reaches `/api/mcp-gateway` with the agent
 * service secret and the acting grant its web route minted, and names the user
 * and organization it acts for (the gateway re-checks both and the membership
 * on every request). Nothing connects until it is needed: the tool list is
 * remembered for a few minutes (it is the same for every user) and the client
 * is opened by the first call a turn makes.
 */

import { closeMcpClientSafe } from "@repo/agent-core/backend";
import { createMcpClient, type McpClientType } from "@repo/mcp";
import { getBaseUrl } from "@repo/utils";
import type { ReadOnlyBlockedOutput } from "@repo/utils/read-only-mode";
import {
	buildFabricServiceHeaders,
	type FabricServiceActor,
	readActingGrantExpiry,
} from "../../lib/fabric-mcp-service-headers";
import { toolAccess } from "../../lib/fabric-tool-definition";
import {
	FIRST_PARTY_MCP_TOOL_TIMEOUT_MS,
	runWithTimeout,
} from "../orchestrator/execution/mcp-call-timeout";
import { agentToolAbortSignal } from "./agent-tool-runtime";
import { guardToolWriteForReadOnly } from "./read-only-gate";

const logger = {
	warn: (message: string, data?: Record<string, unknown>) =>
		console.warn(`[FabricGateway] ${message}`, data || ""),
};

const DEFINITIONS_TTL_MS = 5 * 60_000;
const CONNECT_TIMEOUT_MS = 8_000;
const FAILURE_BACKOFF_MS = 60_000;

/** A tool as the gateway lists it: what a client has to go on, and nothing more. */
export interface GatewayToolListing {
	name: string;
	description?: string;
	inputSchema: { properties?: Record<string, unknown> } & Record<
		string,
		unknown
	>;
	annotations?: { readOnlyHint?: boolean };
	_meta?: Record<string, unknown>;
}

let definitionsCache: {
	fetchedAt: number;
	definitions: GatewayToolListing[];
} | null = null;
let lastFailureAt = 0;

/** Test seam: forget what the gateway listed and any recent failure. */
export function resetFabricGatewayCache(): void {
	definitionsCache = null;
	lastFailureAt = 0;
}

/**
 * A tool result as the model and the chat read it: the JSON a gateway tool
 * returned, or `{ error }` (with whatever else the error carried) when it
 * refused.
 */
export function unwrapGatewayResult(raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null) {
		return raw;
	}
	const structured =
		"structuredContent" in raw ? raw.structuredContent : null;
	const isError = "isError" in raw && raw.isError === true;
	let text: string | undefined;
	if ("content" in raw && Array.isArray(raw.content)) {
		const part = raw.content.find(
			(entry: unknown): entry is { type: "text"; text: string } =>
				typeof entry === "object" &&
				entry !== null &&
				"type" in entry &&
				entry.type === "text" &&
				"text" in entry &&
				typeof entry.text === "string",
		);
		text = part?.text;
	}
	let parsed: unknown = structured ?? undefined;
	if (parsed === undefined && text !== undefined) {
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = undefined;
		}
	}
	if (!isError) {
		return parsed ?? text ?? null;
	}
	if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
		return parsed;
	}
	return { error: text ?? "The tool failed" };
}

function isUnauthorized(error: unknown): boolean {
	return (
		error instanceof Error && /\b401\b|unauthori[sz]ed/i.test(error.message)
	);
}

export interface FabricGateway {
	/** The gateway's tool list, or null when it cannot be reached (logged; backed off). */
	listTools(): Promise<GatewayToolListing[] | null>;
	/**
	 * The refusal a write gets in a project in Read-only mode, or null. A tool
	 * the listing does not know is taken for a write.
	 */
	readOnlyRefusal(name: string): Promise<ReadOnlyBlockedOutput | null>;
	/**
	 * Calls one tool and answers with the unwrapped result, or `{ error }`. A
	 * write to a project in Read-only mode is answered with the refusal instead
	 * of being sent: this is the one place a call leaves for the gateway.
	 */
	call(
		name: string,
		args: Record<string, unknown>,
		abortSignal?: AbortSignal,
	): Promise<unknown>;
	close(): Promise<void>;
}

/** What a person is told when the grant their turn started with has run out. */
const GRANT_EXPIRED_RESULT = {
	error: "This chat turn has been running longer than Fabric's tools allow, so they can no longer act for you. Ask the user to send their message again.",
};

/**
 * Opens the gateway for one turn. `null` when it cannot be used at all: no
 * service secret on this worker, or nothing to act with.
 */
export function openFabricGateway(
	actor: FabricServiceActor,
): FabricGateway | null {
	const secret = process.env.AGENT_SERVICE_SECRET;
	if (!secret) {
		logger.warn(
			"AGENT_SERVICE_SECRET is not set; Fabric tools unavailable",
		);
		return null;
	}
	if (Date.now() - lastFailureAt < FAILURE_BACKOFF_MS) {
		return null;
	}

	const connection: { client: Promise<McpClientType> | null } = {
		client: null,
	};
	const getClient = () => {
		connection.client ??= createMcpClient({
			serverUrl: `${getBaseUrl()}/api/mcp-gateway`,
			transport: "HTTP",
			headers: buildFabricServiceHeaders(secret, actor),
		});
		return connection.client;
	};
	const grantExpired = () => {
		const expiry = readActingGrantExpiry(actor.actingGrant);
		return expiry !== null && expiry * 1000 <= Date.now();
	};

	const readOnlyRefusal = (name: string) => {
		const listing = definitionsCache?.definitions.find(
			(definition) => definition.name === name,
		);
		return listing && toolAccess(listing) === "READ"
			? Promise.resolve(null)
			: guardToolWriteForReadOnly(actor.projectId, name, {
					accessOverride: "WRITE",
				});
	};

	return {
		readOnlyRefusal,
		async listTools() {
			if (
				definitionsCache &&
				Date.now() - definitionsCache.fetchedAt < DEFINITIONS_TTL_MS
			) {
				return definitionsCache.definitions;
			}
			try {
				const listed = await runWithTimeout(
					getClient().then((client) => client.listTools()),
					CONNECT_TIMEOUT_MS,
					() => {
						throw new Error("Timed out listing Fabric tools");
					},
				);
				definitionsCache = {
					fetchedAt: Date.now(),
					definitions: listed.tools,
				};
				return listed.tools;
			} catch (error) {
				lastFailureAt = Date.now();
				logger.warn(
					"Could not load Fabric tools; continuing without them",
					{
						error:
							error instanceof Error
								? error.message
								: String(error),
					},
				);
				await connection.client?.then(
					closeMcpClientSafe,
					() => undefined,
				);
				return null;
			}
		},
		async call(name, args, abortSignal) {
			if (grantExpired()) {
				return GRANT_EXPIRED_RESULT;
			}
			const blocked = await readOnlyRefusal(name);
			if (blocked) {
				return blocked;
			}
			try {
				const client = await getClient();
				return await runWithTimeout<unknown>(
					client
						.callTool({
							name,
							arguments: args,
							options: {
								signal: agentToolAbortSignal(abortSignal),
							},
						})
						.then(unwrapGatewayResult),
					FIRST_PARTY_MCP_TOOL_TIMEOUT_MS,
					() => ({
						error: `${name} did not respond in time. Check before trying again.`,
					}),
				);
			} catch (error) {
				// The gateway refused the grant (expired between the check above
				// and the call, or not vouched for): the person has to start the
				// turn again, which is the only thing that mints a new one.
				if (isUnauthorized(error)) {
					return GRANT_EXPIRED_RESULT;
				}
				throw error;
			}
		},
		async close() {
			const client = await connection.client?.catch(() => null);
			if (client) {
				await closeMcpClientSafe(client);
			}
		},
	};
}
