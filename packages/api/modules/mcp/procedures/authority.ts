/**
 * Authority Session & Grant API Procedures
 *
 * oRPC procedures for managing runtime authority sessions.
 * Used by the authority approval UI and admin dashboard.
 */

import { ORPCError } from "@orpc/server";
import {
	approveAuthoritySession,
	denyAuthoritySession,
	getAuthoritySession,
	listAuthoritySessions,
	revokeAuthoritySession,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	protectedProcedure,
	requirePermission,
	resolveOrganizationId,
} from "../../../orpc/procedures";

/**
 * List authority sessions for the current user/org context.
 */
export const listAuthoritySessionsProcedure = protectedProcedure
	.use(requirePermission(Permissions.MCP_READ))
	.route({ method: "GET", path: "/authority/sessions", tags: ["Authority"] })
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			status: z
				.enum(["PENDING", "ACTIVE", "EXPIRED", "REVOKED", "COMPLETED"])
				.optional(),
			limit: z.number().min(1).max(100).default(20),
			offset: z.number().min(0).default(0),
		}),
	)
	.handler(async ({ input, context }) => {
		const orgId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		return listAuthoritySessions({
			userId: context.user.id,
			organizationId: orgId ?? undefined,
			status: input.status,
			limit: input.limit,
			offset: input.offset,
		});
	});

/**
 * Get a specific authority session with grants.
 */
export const getAuthoritySessionProcedure = protectedProcedure
	.use(requirePermission(Permissions.MCP_READ))
	.route({
		method: "GET",
		path: "/authority/sessions/{sessionId}",
		tags: ["Authority"],
	})
	.input(
		z.object({
			sessionId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const orgId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const session = await getAuthoritySession(
			input.sessionId,
			context.user.id,
			orgId ?? undefined,
		);

		if (!session) {
			throw new ORPCError("NOT_FOUND", {
				message: "Authority session not found",
			});
		}

		return session;
	});

/**
 * Approve a pending authority session.
 * This is the human-in-the-loop approval endpoint called from the UI.
 */
export const approveAuthoritySessionProcedure = protectedProcedure
	.use(requirePermission(Permissions.MCP_UPDATE))
	.route({
		method: "POST",
		path: "/authority/sessions/{sessionId}/approve",
		tags: ["Authority"],
	})
	.input(
		z.object({
			sessionId: z.string(),
			organizationId: z.string().nullable().optional(),
			instructions: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const orgId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify session exists and belongs to user
		const session = await getAuthoritySession(
			input.sessionId,
			context.user.id,
			orgId ?? undefined,
		);

		if (!session) {
			throw new ORPCError("NOT_FOUND", {
				message: "Authority session not found",
			});
		}

		if (session.status !== "PENDING") {
			throw new ORPCError("BAD_REQUEST", {
				message: `Cannot approve session with status "${session.status}"`,
			});
		}

		const approved = await approveAuthoritySession(
			input.sessionId,
			context.user.id,
			input.instructions,
		);

		return approved;
	});

/**
 * Deny a pending authority session.
 */
export const denyAuthoritySessionProcedure = protectedProcedure
	.use(requirePermission(Permissions.MCP_UPDATE))
	.route({
		method: "POST",
		path: "/authority/sessions/{sessionId}/deny",
		tags: ["Authority"],
	})
	.input(
		z.object({
			sessionId: z.string(),
			organizationId: z.string().nullable().optional(),
			reason: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const orgId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const session = await getAuthoritySession(
			input.sessionId,
			context.user.id,
			orgId ?? undefined,
		);

		if (!session) {
			throw new ORPCError("NOT_FOUND", {
				message: "Authority session not found",
			});
		}

		if (session.status !== "PENDING") {
			throw new ORPCError("BAD_REQUEST", {
				message: `Cannot deny session with status "${session.status}"`,
			});
		}

		await denyAuthoritySession(
			input.sessionId,
			context.user.id,
			input.reason,
		);
		return { success: true };
	});

/**
 * Revoke an active authority session.
 */
export const revokeAuthoritySessionProcedure = protectedProcedure
	.use(requirePermission(Permissions.MCP_UPDATE))
	.route({
		method: "POST",
		path: "/authority/sessions/{sessionId}/revoke",
		tags: ["Authority"],
	})
	.input(
		z.object({
			sessionId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const orgId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const session = await getAuthoritySession(
			input.sessionId,
			context.user.id,
			orgId ?? undefined,
		);

		if (!session) {
			throw new ORPCError("NOT_FOUND", {
				message: "Authority session not found",
			});
		}

		if (session.status !== "ACTIVE") {
			throw new ORPCError("BAD_REQUEST", {
				message: `Cannot revoke session with status "${session.status}"`,
			});
		}

		await revokeAuthoritySession(input.sessionId);
		return { success: true };
	});
