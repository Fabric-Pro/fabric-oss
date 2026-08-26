/**
 * List Templates Procedure
 *
 * Lists templates for a user/organization with filtering.
 */

import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

export const listTemplatesProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.REPORT_TEMPLATE_READ))
	.route({
		method: "GET",
		path: "/automation-templates",
		tags: ["Automation Templates"],
		summary: "List automation templates",
		description: "List automation templates with filtering options",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			category: z.string().optional(),
			tags: z.array(z.string()).optional(),
			includePublic: z.boolean().optional().default(true),
			limit: z.number().min(1).max(100).optional().default(20),
			offset: z.number().min(0).optional().default(0),
			search: z.string().optional(),
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

		// Build where clause with strict tenant isolation
		// Organization context: show org templates (and public ones within same org)
		// Personal context: show only personal templates (organizationId is null)
		const tenantFilter = organizationId
			? {
					organizationId,
					// In org context, optionally include public templates from the same org
					...(input.includePublic ? {} : { isPublic: false }),
				}
			: {
					// Personal context: only personal templates (not belonging to any org)
					userId: user.id,
					organizationId: null,
				};

		const where = {
			...tenantFilter,
			...(input.category ? { category: input.category } : {}),
			...(input.tags?.length ? { tags: { hasSome: input.tags } } : {}),
			...(input.search
				? {
						OR: [
							{
								name: {
									contains: input.search,
									mode: "insensitive" as const,
								},
							},
							{
								description: {
									contains: input.search,
									mode: "insensitive" as const,
								},
							},
						],
					}
				: {}),
		};

		// Get templates with count
		const [templates, total] = await Promise.all([
			db.automationTemplate.findMany({
				where,
				take: input.limit,
				skip: input.offset,
				orderBy: { updatedAt: "desc" },
			}),
			db.automationTemplate.count({ where }),
		]);

		return {
			templates,
			total,
			limit: input.limit,
			offset: input.offset,
			hasMore: input.offset + templates.length < total,
		};
	});
