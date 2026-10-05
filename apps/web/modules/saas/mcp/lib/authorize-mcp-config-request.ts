/**
 * Organization gate for the Next.js routes that run a caller's MCP config.
 *
 * An MCPConfig row carries its own stored credential and outlives its owner's
 * membership. The routes that load one by `{ configId, userId, organizationId }`
 * already stop one person from using another's config, but the `userId` match
 * says nothing about whether the caller still belongs to that organization, or
 * whether their role there still allows the action. Without this gate a person
 * removed from an organization keeps calling tools through the configs they
 * created in it (Fizzy #2897).
 *
 * This is the route-handler equivalent of the oRPC checks the same actions go
 * through — `requirePermission(MCP_CONNECT)` on `mcp.executeTool` and
 * `requirePermission(MCP_READ)` on the tool and resource listings — evaluated
 * against the organization the route is about to use, the way
 * `authorizeInputOrganization` in `packages/api/orpc/middleware/require-permission.ts`
 * does. Each route calls it before it loads the config or builds (or reuses
 * from cache) an MCP client, so a cached client can never outlive membership.
 *
 * No organization means the personal arm: there is no organization role to
 * evaluate, and the config lookup that follows only matches a row with
 * `organizationId: null` owned by the caller. That matches `requirePermission`,
 * which skips personal context. Routes keep resolving the organization exactly
 * as before; this gate never adds a session fallback, which would change which
 * config row is found.
 *
 * `RBAC_DRY_RUN` is not honoured here. The oRPC middleware downgrades only the
 * role half of its check to a warning, and its refusal helper throws an oRPC
 * error rather than answering a route. Both refusals below are enforced
 * unconditionally, so the membership refusal can never be downgraded.
 */

import {
	canConnectOrganizationMcpConfigs,
	canReadOrganizationMcpConfigs,
	isOrganizationMember,
} from "@repo/database";

/** The caller is not (or is no longer) a member of the named organization. */
export const MCP_ORGANIZATION_MEMBERSHIP_REQUIRED =
	"ORGANIZATION_MEMBERSHIP_REQUIRED";

/** The caller is a member, but their organization role does not allow the action. */
export const MCP_PERMISSION_DENIED = "MCP_PERMISSION_DENIED";

/**
 * What the route is about to do with the config. `read` lists a server's tools
 * or resources or reads a resource (MCP_READ); `connect` executes a tool
 * (MCP_CONNECT). Executing any tool is `connect`, including a tool that only
 * reads, such as a board or column lookup: the permission follows the protocol
 * operation, as `mcp.executeTool` does, not what the tool happens to do.
 */
export type McpConfigAction = "read" | "connect";

export type McpConfigRequestAuthorization =
	| { ok: true }
	| { ok: false; response: Response };

const PERMISSION_CHECKS: Record<
	McpConfigAction,
	(userId: string, organizationId: string) => Promise<boolean>
> = {
	read: canReadOrganizationMcpConfigs,
	connect: canConnectOrganizationMcpConfigs,
};

function refuse(error: string, code: string, action?: McpConfigAction) {
	return {
		ok: false as const,
		response: Response.json(
			action ? { error, code, action } : { error, code },
			{ status: 403 },
		),
	};
}

/**
 * Decide whether `userId` may use an MCP config in `organizationId` for
 * `action`.
 *
 * Returns `{ ok: true }` to proceed, or the 403 response to send. The two
 * refusals carry different `code`s so a client can tell a lost membership from
 * a role that does not allow the action; neither message names an id.
 *
 * The allowed path costs one read: the permission question already requires a
 * membership row. Only a "no" is followed by a membership read, to tell the
 * two refusals apart.
 *
 * Fails closed: an organization id that is not a string is refused, an
 * unknown stored role resolves to no permissions, and a failed read throws to
 * the route's own error handling rather than allowing.
 */
export async function authorizeMcpConfigRequest(params: {
	userId: string;
	organizationId: string | null | undefined;
	action: McpConfigAction;
}): Promise<McpConfigRequestAuthorization> {
	const { userId, organizationId, action } = params;

	if (
		organizationId === undefined ||
		organizationId === null ||
		organizationId === ""
	) {
		return { ok: true };
	}

	// The routes read this from an untyped JSON body or query string.
	if (typeof organizationId !== "string") {
		return refuse(
			"You are not a member of this organization",
			MCP_ORGANIZATION_MEMBERSHIP_REQUIRED,
		);
	}

	if (await PERMISSION_CHECKS[action](userId, organizationId)) {
		return { ok: true };
	}

	if (!(await isOrganizationMember(userId, organizationId))) {
		return refuse(
			"You are not a member of this organization",
			MCP_ORGANIZATION_MEMBERSHIP_REQUIRED,
		);
	}

	return refuse(
		"Your organization role does not allow this MCP action",
		MCP_PERMISSION_DENIED,
		action,
	);
}
