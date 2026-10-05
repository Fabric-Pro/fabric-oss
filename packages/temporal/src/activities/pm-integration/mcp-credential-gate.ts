/**
 * Organization gate for the PM sync paths that read an MCP config's stored
 * credential directly instead of through an MCP client: the ADO PAT and Fizzy
 * API key used to upload or re-host images, and the Jira Cloud token used for
 * attachments.
 *
 * Those reads happen before the push's first `executeMcpTool` call, and a
 * workflow that discovered capabilities in an earlier activity hands them in
 * (`preDiscoveredCapabilities`), so no client factory — and so no
 * organization check (`createMcpClientForConfig`'s `access` gate) — has run in
 * the activity by then. Without this gate a removed or downgraded owner's
 * credential would still upload attachments until the push itself is refused
 * (Fizzy #2903).
 */

import { logger } from "@repo/logs";
import { checkMcpConfigOrganizationAccess } from "@repo/mcp";

/**
 * Whether the owner of `mcpConfigId` (the sync's `userId`) may still have its
 * stored credential used in `organizationId`: the same `connect` check the MCP
 * client factory applies, because the credential is used to write to the PM
 * tool. `false` means treat the config as gone, exactly as after the
 * offboarding cascade deletes it; the push's own `executeMcpTool` is then
 * refused by the client factory. No organization (personal arm) is not
 * checked. A failed read throws: it never allows.
 */
export async function mayUseMcpConfigCredential(args: {
	mcpConfigId: string;
	userId: string;
	organizationId?: string | null;
}): Promise<boolean> {
	const refusal = await checkMcpConfigOrganizationAccess({
		userId: args.userId,
		organizationId: args.organizationId,
		access: "connect",
	});
	if (!refusal) {
		return true;
	}
	logger.warn(
		"[PM Sync] Not using the MCP config's stored credential: its owner may not use it in this organization",
		{ mcpConfigId: args.mcpConfigId, code: refusal.code },
	);
	return false;
}
