/**
 * A page's reads of the viewer's own connected servers.
 *
 * A page declares `connected:<providerKey>/<tool>` in `runtimeTools`. The usual
 * `prefix__tool` name cannot be declared: the prefix comes from each person's
 * own display name for the server, so it would name a different server for
 * every viewer. The provider key is read off the same display name: a server a
 * person calls "GitHub" is `github`, and any name that matches no known
 * provider is `custom:<prefix>`. So the key says what a person named a server,
 * not which service it reaches.
 *
 * What a connected read is held to is the run, not the save. It runs as the
 * viewer, on the viewer's own server, and only when that server marks the tool
 * `readOnlyHint: true`: a tool whose name merely looks harmless is never read,
 * and a viewer who has no such server gets `not_connected` for the page to
 * show. A result is capped, since it goes to a page's script. Saving the
 * declaration asks the author's own server for the same annotation, which tells
 * the author early that the read cannot work; it is not an independent control,
 * because it matches the key against the author's own server names and trusts
 * the annotation of the author's own server, so it says nothing about what the
 * viewer's server of that name is.
 */

import { PAGE_CONNECTED_RESULT_MAX_BYTES } from "@repo/temporal/fabric-page-tool-definitions";
import { resolveProviderKeyFromToolPrefix } from "./authority-service";
import {
	executeConnectedServerTool,
	getConnectedServers,
} from "./tool-aggregator";
import { errorResult, jsonResult } from "./tool-results";
import type {
	ConnectedServerInfo,
	GatewaySession,
	ToolCallResult,
} from "./types";

type ToolOwner = Pick<GatewaySession, "userId" | "organizationId">;

type ConnectedToolLookup =
	| { status: "found"; server: ConnectedServerInfo }
	| { status: "not_connected" }
	| { status: "tool_not_found" }
	| { status: "not_read_only" };

/**
 * The person's server for `provider` that offers `tool`, and whether the
 * server itself marks it read-only. Servers are matched on the provider key the
 * authority machinery uses for them.
 */
export function locateConnectedTool(
	servers: ConnectedServerInfo[],
	provider: string,
	tool: string,
): ConnectedToolLookup {
	const ofProvider = servers.filter(
		(server) =>
			resolveProviderKeyFromToolPrefix(server.toolPrefix, servers)
				?.providerKey === provider,
	);
	if (ofProvider.length === 0) {
		return { status: "not_connected" };
	}
	for (const server of ofProvider) {
		const offered = server.tools.find(
			(candidate) => candidate.name === tool,
		);
		if (offered) {
			return offered.annotations?.readOnlyHint === true
				? { status: "found", server }
				: { status: "not_read_only" };
		}
	}
	return { status: "tool_not_found" };
}

const SAVE_REFUSALS: Record<
	Exclude<ConnectedToolLookup["status"], "found">,
	(provider: string, tool: string) => string
> = {
	not_connected: (provider, tool) =>
		`connected:${provider}/${tool} can only be declared by someone who has ${provider} connected, so the tool can be checked as read-only.`,
	tool_not_found: (provider, tool) =>
		`Your ${provider} server has no tool ${tool}.`,
	not_read_only: (provider, tool) =>
		`${tool} is not marked read-only by your ${provider} server, so a page cannot declare it.`,
};

/**
 * Why a page cannot be saved with these connected declarations, or null. The
 * author's own servers are the check: every declared tool must exist there and
 * be marked read-only by the server.
 */
export async function connectedDeclarationRefusal(
	declarations: ReadonlyArray<{ provider: string; tool: string }>,
	owner: ToolOwner,
): Promise<string | null> {
	if (declarations.length === 0) {
		return null;
	}
	const servers = await getConnectedServers(owner);
	for (const { provider, tool } of declarations) {
		const lookup = locateConnectedTool(servers, provider, tool);
		if (lookup.status !== "found") {
			return SAVE_REFUSALS[lookup.status](provider, tool);
		}
	}
	return null;
}

/**
 * Runs the page's declared read on the viewer's own server. The page's
 * declaration was checked by the caller (`checkPageCall`); this checks what the
 * viewer's server says about the tool.
 */
export async function readConnectedTool(input: {
	provider: string;
	tool: string;
	args: Record<string, unknown>;
	session: GatewaySession;
}): Promise<ToolCallResult> {
	const { provider, tool, args, session } = input;
	const servers = await getConnectedServers(session);
	const lookup = locateConnectedTool(servers, provider, tool);
	switch (lookup.status) {
		case "not_connected":
			return jsonResult({ error: "not_connected", provider });
		case "tool_not_found":
			return errorResult(`Your ${provider} server has no tool ${tool}.`);
		case "not_read_only":
			return errorResult(
				`${tool} is not marked read-only by your ${provider} server, so a page cannot call it.`,
			);
		case "found":
			break;
		default: {
			const unreachable: never = lookup;
			return unreachable;
		}
	}

	const result = await executeConnectedServerTool(
		`${lookup.server.toolPrefix}__${tool}`,
		args,
		session,
		servers,
	);
	const bytes = result.content.reduce(
		(sum, part) => sum + Buffer.byteLength(part.text, "utf8"),
		0,
	);
	return bytes > PAGE_CONNECTED_RESULT_MAX_BYTES
		? errorResult(
				`${tool} returned ${bytes} bytes; a page reads at most ${PAGE_CONNECTED_RESULT_MAX_BYTES}. Ask for less.`,
			)
		: result;
}
