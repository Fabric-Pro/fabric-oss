/**
 * Publish a customer-facing status announcement.
 *
 * Auth: `adminProcedure`. Writing text that every customer will read is a
 * platform-staff action, not an org-owner one — an org admin has no standing to
 * make a statement on Fabric's behalf.
 *
 * Component keys are validated against the platform-component registry so a
 * typo cannot produce an announcement that silently attaches to no component
 * and therefore never changes any status a customer sees.
 */

import { ORPCError } from "@orpc/server";
import { createStatusUpdate } from "@repo/database";
import { listPlatformComponents } from "@repo/observability";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import { adminProcedure } from "../../../../orpc/procedures";

const lifecycleSchema = z.enum([
	"INVESTIGATING",
	"IDENTIFIED",
	"MONITORING",
	"RESOLVED",
	"SCHEDULED",
	"IN_PROGRESS",
	"COMPLETED",
]);

export const publishStatusUpdateProcedure = adminProcedure
	.route({
		method: "POST",
		path: "/system-health/admin/status-updates",
		tags: ["System Health"],
		summary: "Publish a customer-facing status announcement",
	})
	.input(
		z.object({
			title: z.string().trim().min(1).max(200),
			body: z.string().trim().min(1).max(10_000),
			lifecycle: lifecycleSchema.default("INVESTIGATING"),
			impact: z.enum(["NONE", "MINOR", "MAJOR", "CRITICAL"]),
			affectedComponentKeys: z.array(z.string()).default([]),
			affectedProviderKeys: z.array(z.string()).default([]),
			startedAt: z.coerce.date().optional(),
			scheduledFor: z.coerce.date().nullable().default(null),
			componentIncidentId: z.string().nullable().default(null),
			integrationIncidentId: z.string().nullable().default(null),
		}),
	)
	.handler(async ({ input, context }) => {
		const known = new Set(listPlatformComponents().map((c) => c.key));
		const unknown = input.affectedComponentKeys.filter(
			(k) => !known.has(k),
		);
		if (unknown.length > 0) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Unknown component keys: ${unknown.join(", ")}`,
			});
		}

		const created = await createStatusUpdate({
			...input,
			authorUserId: context.user.id,
		});

		recordAuditFromRequest(context, {
			action: "statusUpdate.published",
			category: "statusUpdate",
			outcome: "success",
			severity: "warning",
			resource: {
				type: "status_update",
				id: created.id,
				name: input.title,
			},
			metadata: {
				impact: input.impact,
				lifecycle: input.lifecycle,
				affectedComponentKeys: input.affectedComponentKeys,
				affectedProviderKeys: input.affectedProviderKeys,
			},
		});

		return { id: created.id };
	});
