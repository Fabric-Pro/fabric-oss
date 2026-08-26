/**
 * Symbol Search Procedure
 *
 * Searches extracted code symbols by name (fuzzy match) with optional type filter.
 * Used by the `symbol_search` tool for symbol-level code navigation.
 *
 * TENANT ISOLATION: Uses tenantProtectedProcedure with XOR pattern.
 * Requires PROJECT_READ permission.
 */

import { ORPCError } from "@orpc/client";
import { hasProjectAccess, searchCodeSymbols } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

const symbolSearchInputSchema = z.object({
	projectId: z.string(),
	query: z.string().min(1).max(200),
	type: z.string().optional(),
	organizationId: z.string().nullable().optional(),
});

export const symbolSearchProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_READ, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "GET",
		path: "/agents/symbol-search",
		tags: ["Agents", "Code Index"],
		summary: "Search code symbols by name",
	})
	.input(symbolSearchInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify project access
		const canAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
			organizationId,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Search symbols
		const symbols = await searchCodeSymbols({
			projectId: input.projectId,
			query: input.query,
			type: input.type ?? null,
			userId: context.user.id,
			organizationId: organizationId ?? null,
			limit: 20,
		});

		return {
			symbols: symbols.map((s) => ({
				id: s.id,
				name: s.name,
				type: s.type,
				filePath: s.filePath,
				lineStart: s.lineStart,
				lineEnd: s.lineEnd,
				signature: s.signature,
				language: s.language,
			})),
		};
	});
