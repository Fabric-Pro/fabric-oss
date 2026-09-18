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
 * Deliberately WITHOUT `requireBaseUnmoved` and WITH `allowRollback`. Both
 * rules the flags replace are race guards against an automatic
 * publish-on-ready silently moving the pointer behind someone's back. Neither
 * describes what happens here: a person opened History, saw which version is
 * published, and chose another one. That includes choosing an EARLIER one —
 * "A newer version is already published" was the version rule refusing a
 * rollback it was never written to refuse.
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
			allowRollback: true,
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
			if (result.reason === "proposal_not_approved") {
				throw new ORPCError("FORBIDDEN", {
					message:
						"A file proposal can only be published through proposal approval",
				});
			}
			// Kept as a fail-closed default, not as a case this handler can
			// produce. `base_moved` is only ever derived under
			// `requireBaseUnmoved`, which this call does not pass;
			// `allowRollback` replaces the version rule that produced
			// `older_than_current`, its write is serialized on the project
			// row it already matched, and the one pointer its predicate
			// excludes — this snapshot — comes back as the idempotent
			// `published: true` above. The old text ("A newer version is
			// already published") was the version rule's message and cannot be
			// true of anything reaching here, so it is not left as the only
			// thing a person could be told.
			throw new ORPCError("CONFLICT", {
				message:
					"The published version could not be changed. Reload the history and try again",
			});
		}
		// Only for the call that actually MOVED the pointer. The query reports
		// `published: true` for the idempotent case too (this snapshot is
		// already the pointer), which is exactly what a lost response plus a
		// client retry produces — auditing on `published` recorded two
		// publications for one pointer transition. The Temporal activity gates
		// on `changed` for the same reason.
		if (result.changed) {
			// VERSION NUMBERS ONLY. A rollback is unreadable from the action
			// alone — the row would say a version was published and leave
			// "which one, replacing what?" to be reconstructed from the order
			// of rows — so both ends of the move are recorded, and `rollback`
			// names the direction rather than making a reader compare them.
			// The action itself stays `project.instructions.published`: this
			// is the same pointer move, and a second action would change the
			// closed audit-action set. Nothing here carries a file path or any
			// file content, which is user data the audit log must not repeat.
			const version = result.version ?? null;
			const previousVersion = result.previousVersion ?? null;
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
				metadata: {
					version,
					previousVersion,
					rollback:
						typeof version === "number" &&
						typeof previousVersion === "number" &&
						version < previousVersion,
				},
			});
		}
		return { published: true as const };
	});
