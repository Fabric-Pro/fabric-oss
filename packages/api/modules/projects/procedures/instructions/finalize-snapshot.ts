import { ORPCError } from "@orpc/client";
import { getInstructionSnapshot } from "@repo/database";
import { z } from "zod";
import {
	assertProjectPermission,
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { finalizeInstructionSnapshot } from "./finalize";
import { requireHostingOrganizationId } from "./hosting-organization";
import { unwrapInstructionWorkflowError } from "./instruction-workflow-start";
import { assertInstructionSnapshotMutationAccess } from "./proposal-authorization";

/**
 * AUTHORIZATION: tenantProtectedProcedure + requireProjectPermission(INSTRUCTION_CREATE).
 *
 * Finishes an upload: starts `projectInstructionSnapshotWorkflow` and only
 * THEN flips the snapshot to VALIDATING. The snapshot lookup is tenant-scoped
 * (`getInstructionSnapshot(id, projectId, organizationId)`) before anything
 * else runs, so the workflow only ever starts for a snapshot this caller's
 * organization actually owns.
 *
 * The start itself — its ordering rules, its tolerance of
 * `WorkflowExecutionAlreadyStartedError`, and which statuses may be restarted
 * — lives in `finalizeInstructionSnapshot` (`./finalize.ts`), shared with the
 * inline-content entry point in `submit-change.ts` so the CLI and the MCP
 * proposal tool finish an upload exactly the way the browser does.
 *
 * A snapshot opted into publishing before its secret scan (Fizzy #2737) also
 * needs the publish permission (INSTRUCTION_UPDATE) from whoever finishes it:
 * finishing it is what publishes it, and a CREATE-only member must not be able
 * to set off the publication of someone else's acknowledged upload.
 */
// The baseline middleware proves project visibility. The snapshot-aware guard
// below then requires CREATE for direct versions, or READ plus proposer
// ownership for a pending proposal.
export const finalizeSnapshotProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/snapshots/:snapshotId/finalize",
		tags: ["Projects", "Instructions"],
		summary: "Finish the upload and start validation",
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
		const snapshot = await getInstructionSnapshot(
			input.snapshotId,
			input.projectId,
			organizationId,
		);
		if (!snapshot) {
			throw new ORPCError("NOT_FOUND", { message: "Upload not found" });
		}
		await assertInstructionSnapshotMutationAccess({
			projectId: input.projectId,
			userId: context.user.id,
			snapshot,
		});
		if (snapshot.publishBeforeScan) {
			await assertProjectPermission(
				input.projectId,
				context.user.id,
				Permissions.INSTRUCTION_UPDATE,
			);
		}
		try {
			return await finalizeInstructionSnapshot({
				snapshot,
				projectId: input.projectId,
				organizationId,
				userId: context.user.id,
			});
		} catch (error) {
			// The "start never happened" wrapper exists for ONE caller — the
			// inline entry point, which has a snapshot row to close out and
			// needs to know whether a workflow could own it. The browser has
			// no such decision to make, and dressing a connection failure up
			// as a wrapper whose message names Temporal would replace the
			// error this procedure used to surface, and that its error
			// middleware and the tab's "Try again" were written against.
			throw unwrapInstructionWorkflowError(error);
		}
	});
