/**
 * Code Generation Procedure
 *
 * Generates executable TypeScript code from a visual workflow.
 * Based on Vercel workflow-builder-template code generation pattern.
 * @see https://github.com/vercel-labs/workflow-builder-template
 */

import { ORPCError } from "@orpc/client";
import { getWorkflowById, hasWorkflowAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";
import type {
	CodegenEdge as WorkflowEdge,
	CodegenNode as WorkflowNode,
} from "../lib/workflow-codegen";
import {
	generateWorkflowCode,
	sanitizeFilename,
} from "../lib/workflow-codegen";

export const generateCodeProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.route({
		method: "GET",
		path: "/workflows/{id}/generate-code",
		tags: ["Workflows"],
		summary: "Generate TypeScript code from workflow",
		description:
			"Convert a visual workflow into executable TypeScript code",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
			format: z
				.enum(["typescript", "json"])
				.optional()
				.default("typescript"),
		}),
	)
	.output(
		z.object({
			code: z.string(),
			filename: z.string(),
			language: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify organization membership if in org context
		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		// Check workflow access
		const hasAccess = await hasWorkflowAccess(
			input.id,
			user.id,
			organizationId,
		);

		if (!hasAccess) {
			throw new ORPCError("NOT_FOUND", {
				message: "Workflow not found",
			});
		}

		// Get workflow
		const workflow = await getWorkflowById(
			input.id,
			user.id,
			organizationId,
		);

		if (!workflow) {
			throw new ORPCError("NOT_FOUND", {
				message: "Workflow not found",
			});
		}

		const nodes = (workflow.nodes as unknown as WorkflowNode[]) || [];
		const edges = (workflow.edges as unknown as WorkflowEdge[]) || [];

		if (input.format === "json") {
			return {
				code: JSON.stringify({ nodes, edges }, null, 2),
				filename: `${sanitizeFilename(workflow.name)}.json`,
				language: "json",
			};
		}

		// Generate TypeScript code
		const code = generateWorkflowCode(workflow.name, nodes, edges);

		return {
			code,
			filename: `${sanitizeFilename(workflow.name)}.ts`,
			language: "typescript",
		};
	});
