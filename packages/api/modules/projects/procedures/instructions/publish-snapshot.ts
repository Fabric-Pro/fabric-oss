import { ORPCError } from "@orpc/client";
import { publishInstructionSnapshot } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireHostingOrganizationId } from "./hosting-organization";

/**
 * AUTHORIZATION: tenantProtectedProcedure + requireProjectPermission(INSTRUCTION_UPDATE).
 *
 * Publishes a READY snapshot as the project's pointer. Delegates the actual
 * pointer move to `publishInstructionSnapshot`, which is atomic and
 * idempotent under retry (see its own doc comment) — this handler only maps
 * its result to the right error and audits an actual publish. A
 * `published: true` reason (including the idempotent "already the pointer"
 * case) always resolves the same way; only the API-side reason mapping below
 * distinguishes NOT_FOUND / BAD_REQUEST / CONFLICT for a refusal, and only
 * `changed` decides whether an audit row is written.
 *
 * Deliberately WITHOUT `requireBaseUnmoved`. That fast-forward rule exists to
 * stop an automatic publish-on-ready from silently reverting someone else's
 * edit; here a person has opened History and chosen this version knowing what
 * is published, so the ordinary "newer version wins" rule is the right one.
 */
export const publishSnapshotProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.INSTRUCTION_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/snapshots/:snapshotId/publish",
		tags: ["Projects", "Instructions"],
		summary: "Publish a READY snapshot",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			snapshotId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const result = await publishInstructionSnapshot({
			snapshotId: input.snapshotId,
			projectId: input.projectId,
			organizationId,
		});
		if (!result.published) {
			if (result.reason === "not_found") {
				throw new ORPCError("NOT_FOUND", {
					message: "Snapshot not found",
				});
			}
			if (result.reason === "not_ready") {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"Only a snapshot that passed checks can be published",
				});
			}
			throw new ORPCError("CONFLICT", {
				message: "A newer version is already published",
			});
		}
		// Only for the call that actually MOVED the pointer. The query reports
		// `published: true` for the idempotent case too (this snapshot is
		// already the pointer), which is exactly what a lost response plus a
		// client retry produces — auditing on `published` recorded two
		// publications for one pointer transition. The Temporal activity gates
		// on `changed` for the same reason.
		if (result.changed) {
			recordAuditFromRequest(context, {
				action: "project.instructions.published",
				category: "project",
				organizationId,
				projectId: input.projectId,
				resource: {
					type: "project_instruction_snapshot",
					id: input.snapshotId,
					name: null,
				},
				metadata: {},
			});
		}
		return { published: true as const };
	});
