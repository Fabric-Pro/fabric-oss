/**
 * What a page may be saved declaring in `runtimeTools`: the tools its script
 * calls through `window.fabric` as whoever views it. Checked when a page is
 * created, changed or forked with tools, against the platform table (which
 * knows every tool and which a page may call) and, for a connected read, the
 * author's own servers.
 */

import { parseConnectedDeclaration } from "@repo/temporal/fabric-page-tool-definitions";
import { connectedDeclarationRefusal } from "../connected-reads";
import { errorResult } from "../tool-results";
import type { GatewaySession, ToolCallResult } from "../types";

/** Whether a page may declare a tool of this name in `runtimeTools`. */
export type PageToolValidator = (name: string) => boolean;

/** The entries of `runtimeTools`, trimmed. Entries that are not strings are left to the frame service, which reports the shape of the list. */
function declaredEntries(args: Record<string, unknown>): string[] {
	return Array.isArray(args.runtimeTools)
		? args.runtimeTools
				.filter((entry): entry is string => typeof entry === "string")
				.map((entry) => entry.trim())
				.filter(Boolean)
		: [];
}

/**
 * The names in `runtimeTools` that cannot be declared: not a tool of the
 * platform table, or one a page may not call. A `connected:` declaration is
 * not a tool name; it is checked against the author's servers instead.
 */
function undeclarableRuntimeTools(
	args: Record<string, unknown>,
	pageMayDeclare: PageToolValidator,
): string[] {
	return declaredEntries(args).filter(
		(name) =>
			parseConnectedDeclaration(name) === null && !pageMayDeclare(name),
	);
}

/**
 * Why a page cannot be saved with these `runtimeTools`, or null: a name that is
 * no tool a page may call, or a connected read the author's own server does not
 * mark read-only.
 */
export async function runtimeToolsRefusal(
	args: Record<string, unknown>,
	pageMayDeclare: PageToolValidator,
	session: GatewaySession,
): Promise<ToolCallResult | null> {
	const refused = undeclarableRuntimeTools(args, pageMayDeclare);
	if (refused.length > 0) {
		return errorResult(
			`runtimeTools can only name Fabric platform tools a page may call, or connected:<provider>/<tool>; not usable: ${refused.join(", ")}. Call fabric_list_page_tools to discover valid names and their exact input schemas before retrying.${refused.includes("fabric_list_project_features") ? " fabric_list_project_features is chat-only; a page uses fabric_list_features with required projectId." : ""}`,
		);
	}
	const connected = declaredEntries(args)
		.map(parseConnectedDeclaration)
		.filter((entry) => entry !== null);
	const connectedRefusal = await connectedDeclarationRefusal(
		connected,
		session,
	);
	return connectedRefusal ? errorResult(connectedRefusal) : null;
}
