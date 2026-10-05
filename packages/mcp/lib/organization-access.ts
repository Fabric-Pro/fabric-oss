/**
 * Organization gate for every MCP client built from a stored config.
 *
 * An MCPConfig row carries its own stored credential and outlives its owner's
 * membership: the offboarding cascade deletes it later, a cascade can fail,
 * and a role downgrade deletes nothing. The config lookup in
 * `createMcpClientForConfig` matches `{ configId, userId, organizationId }`,
 * which says the config belongs to that person in that organization, not that
 * the person still belongs to the organization or that their role there still
 * allows the action. Background callers (Temporal activities, agents) take the
 * user and organization from their stored input, so without this gate a
 * scheduled run keeps executing tools with the credential of someone who has
 * left (Fizzy #2903).
 *
 * This is the client-factory equivalent of `authorizeMcpConfigRequest` on the
 * Next.js routes (Fizzy #2897) and of `requirePermission(MCP_CONNECT)` /
 * `requirePermission(MCP_READ)` on the oRPC procedures, and it uses the same
 * refusal codes.
 *
 * No organization means the personal arm: there is no organization role to
 * evaluate, and the config lookup only matches a row with
 * `organizationId: null` owned by the caller.
 */

import {
	canConnectOrganizationMcpConfigs,
	canReadOrganizationMcpConfigs,
	isOrganizationMember,
} from "@repo/database";

/** The config owner is not (or is no longer) a member of the organization. */
export const MCP_ORGANIZATION_MEMBERSHIP_REQUIRED =
	"ORGANIZATION_MEMBERSHIP_REQUIRED";

/** The config owner is a member, but their role does not allow the action. */
export const MCP_PERMISSION_DENIED = "MCP_PERMISSION_DENIED";

/**
 * What the caller will do with the client. `read` lists a server's tools or
 * resources or reads a resource (MCP_READ, which viewers hold); `connect`
 * executes a tool (MCP_CONNECT, member and above). Executing any tool is
 * `connect`, including one that only reads: the permission follows the
 * protocol operation, as `mcp.executeTool` does, not what the tool does.
 */
export type McpConfigAccess = "read" | "connect";

export interface McpOrganizationAccessRefusal {
	code:
		| typeof MCP_ORGANIZATION_MEMBERSHIP_REQUIRED
		| typeof MCP_PERMISSION_DENIED;
	message: string;
}

/**
 * Whether `userId` may use their MCP config in `organizationId` for `access`.
 *
 * Returns `null` to proceed, or the refusal. The allowed path costs one read
 * (the permission question already needs the membership row); only a "no" is
 * followed by a membership read, to tell the two refusals apart. Neither
 * message names an id.
 *
 * Fails closed: an access value other than `read` is checked as `connect`, an
 * unknown stored role resolves to no permissions, and a failed read rejects
 * rather than allowing.
 */
export async function checkMcpConfigOrganizationAccess(args: {
	userId: string;
	organizationId?: string | null;
	access?: McpConfigAccess;
}): Promise<McpOrganizationAccessRefusal | null> {
	const { userId, organizationId } = args;
	if (!organizationId) {
		return null;
	}
	const access: McpConfigAccess = args.access === "read" ? "read" : "connect";

	const allowed =
		access === "read"
			? await canReadOrganizationMcpConfigs(userId, organizationId)
			: await canConnectOrganizationMcpConfigs(userId, organizationId);
	if (allowed) {
		return null;
	}

	if (!(await isOrganizationMember(userId, organizationId))) {
		return {
			code: MCP_ORGANIZATION_MEMBERSHIP_REQUIRED,
			message:
				"The owner of this MCP connection is no longer a member of this organization.",
		};
	}

	return {
		code: MCP_PERMISSION_DENIED,
		message:
			access === "read"
				? "The organization role of this MCP connection's owner does not allow reading through it."
				: "The organization role of this MCP connection's owner does not allow running its tools.",
	};
}
