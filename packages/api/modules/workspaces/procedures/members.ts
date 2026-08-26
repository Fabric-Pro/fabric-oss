import { ORPCError } from "@orpc/server";
import {
	addWorkspaceAgent,
	addWorkspaceMember,
	canManageWorkspace,
	changeWorkspaceMemberGroup,
	getWorkspaceMembers,
	hasWorkspaceAccess,
	removeWorkspaceAgent,
	removeWorkspaceMember,
	searchUsersForWorkspace,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const WorkspaceGroupSchema = z.enum([
	"administrators",
	"contributors",
	"stakeholders",
]);

/**
 * Get all members of a workspace
 */
export const getWorkspaceMembersProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.input(
		z.object({
			workspaceId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		// TENANT ISOLATION (SOC 2 CC6.1): verify the caller can access this
		// workspace before returning its members (names + emails). Without this,
		// any authenticated user could enumerate any workspace's members by id.
		const hasAccess = await hasWorkspaceAccess(
			input.workspaceId,
			context.user.id,
		);
		if (!hasAccess) {
			throw new ORPCError("NOT_FOUND", {
				message: "Workspace not found",
			});
		}
		const members = await getWorkspaceMembers(input.workspaceId);

		return members;
	});

/**
 * Add a user to a workspace group
 */
export const addWorkspaceMemberProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.input(
		z.object({
			workspaceId: z.string(),
			userId: z.string(),
			group: WorkspaceGroupSchema,
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;

		const canManage = await canManageWorkspace(input.workspaceId, user.id);
		if (!canManage) {
			throw new ORPCError("FORBIDDEN", {
				message: "Only administrators can add members",
			});
		}

		await addWorkspaceMember(
			input.workspaceId,
			input.userId,
			input.group,
			user.id,
		);

		return { success: true };
	});

/**
 * Remove a user from a workspace
 */
export const removeWorkspaceMemberProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.input(
		z.object({
			workspaceId: z.string(),
			userId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;

		await removeWorkspaceMember(input.workspaceId, input.userId, user.id);

		return { success: true };
	});

/**
 * Change a member's group
 */
export const changeWorkspaceMemberGroupProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.input(
		z.object({
			workspaceId: z.string(),
			userId: z.string(),
			newGroup: WorkspaceGroupSchema,
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;

		await changeWorkspaceMemberGroup(
			input.workspaceId,
			input.userId,
			input.newGroup,
			user.id,
		);

		return { success: true };
	});

/**
 * Add an agent to workspace
 */
export const addWorkspaceAgentProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.input(
		z.object({
			workspaceId: z.string(),
			agentId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;

		const canManage = await canManageWorkspace(input.workspaceId, user.id);
		if (!canManage) {
			throw new ORPCError("FORBIDDEN", {
				message: "Only administrators can add agents",
			});
		}

		await addWorkspaceAgent(input.workspaceId, input.agentId, user.id);

		return { success: true };
	});

/**
 * Remove an agent from workspace
 */
export const removeWorkspaceAgentProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.input(
		z.object({
			workspaceId: z.string(),
			agentId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;

		await removeWorkspaceAgent(input.workspaceId, input.agentId, user.id);

		return { success: true };
	});

/**
 * Search users who can be added to a workspace
 */
export const searchUsersForWorkspaceProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.input(
		z.object({
			workspaceId: z.string(),
			query: z.string().min(1),
			limit: z.number().min(1).max(20).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		// TENANT ISOLATION (SOC 2 CC6.1): searching users to add requires manage
		// access to the target workspace. Without this gate the endpoint was a
		// global email-harvesting oracle — any authenticated user could search
		// every user by substring via their own workspace id.
		const canManage = await canManageWorkspace(
			input.workspaceId,
			context.user.id,
		);
		if (!canManage) {
			throw new ORPCError("FORBIDDEN", {
				message: "Only administrators can search users for a workspace",
			});
		}
		const users = await searchUsersForWorkspace(
			input.workspaceId,
			input.query,
			input.limit,
		);

		return users;
	});
