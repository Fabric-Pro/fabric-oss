/**
 * Fabric's own tools for the in-app agent, taken from Fabric MCP.
 *
 * The workflow and frame tools exist once, in the gateway's tool table, and
 * every surface that offers them — the chat engines here, external coding
 * agents, the browser — calls that table. This turns the gateway's tool list
 * into AI SDK tools for one chat turn: `./fabric-gateway-client` reaches the
 * gateway, `./fabric-confirmation` holds back a call that needs the person's
 * yes, and what is left here is the allowlist and the tool wrapper (a write to
 * a Read-only project is refused before the person is asked, and again by the
 * client at the call). The allowlist is the names in Fabric's own definitions
 * that a chat has a use for (`fabric-gateway-tools`): whatever else a gateway
 * lists, and the tools only a page's script uses, the model does not get.
 */

import { jsonSchema, tool } from "@repo/ai";
import { isFabricChatTool } from "../../lib/fabric-gateway-tools";
import type { FabricServiceActor } from "../../lib/fabric-mcp-service-headers";
import {
	FABRIC_PORTAL_EXCLUDED_TOOL_NAMES,
	isFabricPortalTool,
} from "../../lib/fabric-portal-tools";
import {
	toolAccess,
	withoutDryRun,
	withoutDryRunNote,
} from "../../lib/fabric-tool-definition";
import {
	createConfirmationGate,
	listingNeedsConfirmation,
} from "./fabric-confirmation";
import {
	type GatewayToolListing,
	isDefiniteRefusal,
	openFabricGateway,
} from "./fabric-gateway-client";

export {
	resetFabricGatewayCache as resetFabricPlatformMcpCache,
	unwrapGatewayResult,
} from "./fabric-gateway-client";

/**
 * A turn that holds a project grant (a Parlume meeting) lists the portal tools
 * as well as the base set. `offer` says whether this turn's model is given
 * their schemas: they are about 6 KB of tokens a turn, so a turn that does not
 * ask for them does not carry them.
 */
export interface FabricPlatformToolOptions {
	portal?: { offer: boolean };
}

export interface FabricPlatformTools {
	/** AI SDK tools keyed by the gateway's tool names. */
	tools: Record<string, unknown>;
	/**
	 * Whether each tool reads or changes things, as the gateway's own listing
	 * says (`readOnlyHint`); a tool that does not say reads as a change.
	 */
	access: Record<string, "READ" | "WRITE">;
	/**
	 * Runs a call the person approved in chat, with exactly the arguments they
	 * were shown. Refused (an error result) for a tool that needs no approval
	 * or that the gateway does not offer.
	 */
	runApproved(
		toolName: string,
		args: Record<string, unknown>,
	): Promise<unknown>;
	/**
	 * Runs a call the caller has already authorized by its own means — the
	 * Orchestrator's runtime-authority round asks the person before a write
	 * reaches here — so a tool that needs confirmation is not asked about
	 * again. An error result for a tool the gateway does not offer.
	 */
	callAuthorized(
		toolName: string,
		args: Record<string, unknown>,
		abortSignal?: AbortSignal,
	): Promise<unknown>;
	close(): Promise<void>;
}

/**
 * The schema the model sees: the gateway's own JSON Schema, passed on as it
 * came, minus `dryRun`, which is the wrapper's to send and never the model's.
 * The cast is the one place a remote server's schema meets the SDK's type.
 */
function toModelSchema(listing: GatewayToolListing) {
	const schema = withoutDryRun(listing.inputSchema);
	return jsonSchema<Record<string, unknown>>({
		...schema,
		type: "object",
		properties: schema.properties ?? {},
		additionalProperties: false,
	} as Parameters<typeof jsonSchema>[0]);
}

/**
 * Loads Fabric's tools for one chat turn, or null when the gateway cannot be
 * reached (logged; the turn goes on without them — there is no in-process
 * fallback for the workflow tools).
 */
export async function loadFabricPlatformTools(
	actor: FabricServiceActor,
	options: FabricPlatformToolOptions = {},
): Promise<FabricPlatformTools | null> {
	const gateway = openFabricGateway(
		actor,
		options.portal ? "portal" : "base",
	);
	if (!gateway) {
		return null;
	}
	const listed = await gateway.listTools();
	if (!listed) {
		await gateway.close();
		return null;
	}

	const offered = listed.filter(
		(listing) =>
			(!options.portal ||
				!FABRIC_PORTAL_EXCLUDED_TOOL_NAMES.includes(listing.name)) &&
			(isFabricChatTool(listing.name) ||
				(options.portal?.offer === true &&
					isFabricPortalTool(listing.name))),
	);
	const byName = new Map(offered.map((listing) => [listing.name, listing]));
	const confirmation = createConfirmationGate(actor, gateway, (name) =>
		byName.has(name),
	);

	const run = async (
		listing: GatewayToolListing,
		args: Record<string, unknown>,
		abortSignal: AbortSignal | undefined,
	): Promise<unknown> => {
		// Refused before the person is asked to approve what cannot run.
		const blocked = await gateway.readOnlyRefusal(listing.name);
		if (blocked) {
			return blocked;
		}
		const verdict = await confirmation.check(listing, args, abortSignal);
		if (verdict.kind === "answer") {
			return verdict.result;
		}
		const result = await gateway.call(listing.name, args, abortSignal);
		if (isDefiniteRefusal(result)) {
			verdict.refund?.();
		}
		confirmation.noteResult(listing.name, result);
		return result;
	};

	const runAuthorized = (
		listing: GatewayToolListing,
		args: Record<string, unknown>,
		abortSignal: AbortSignal | undefined,
	) =>
		confirmation.asApproved(listing.name, args, () =>
			run(listing, args, abortSignal),
		);

	const tools: Record<string, unknown> = {};
	for (const listing of offered) {
		tools[listing.name] = tool({
			description: withoutDryRunNote(listing.description ?? listing.name),
			inputSchema: toModelSchema(listing),
			execute: (args, executionOptions) =>
				run(listing, args, executionOptions?.abortSignal),
		});
	}

	return {
		tools,
		access: Object.fromEntries(
			offered.map((listing) => [listing.name, toolAccess(listing)]),
		),
		runApproved: async (toolName, args) => {
			const listing = byName.get(toolName);
			if (!listing || !listingNeedsConfirmation(listing, args)) {
				return {
					error: `${toolName} is not an action that needs approval`,
				};
			}
			return runAuthorized(listing, args, undefined);
		},
		callAuthorized: async (toolName, args, abortSignal) => {
			const listing = byName.get(toolName);
			if (!listing) {
				return { error: `${toolName} is not available` };
			}
			return runAuthorized(listing, args, abortSignal);
		},
		close: () => gateway.close(),
	};
}
