import { ORPCError } from "@orpc/server";
import {
	createScanFindingGrouping,
	hasActiveScanFindingGrouping,
	hasProjectAccess,
	updateScanFindingGrouping,
} from "@repo/database";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Start an on-demand run of the security/accessibility finding-grouping
 * pipeline (spec `2026-07-01-security-finding-tickets`). Creates a
 * `ScanFindingGrouping` row and dispatches the separate
 * `securityFindingGroupingWorkflow` on the general-purpose `fabric-worker`
 * queue. Unlike `scan.review.*`, there is no later "apply" step — tickets and
 * comments are written during the run itself (D18).
 *
 * Deduped against an in-flight grouping run so a double-click can't spawn
 * redundant runs. Permission mirrors triage edits (PROJECT_UPDATE) — grouping
 * is an action the user triggers, not a read.
 *
 * Deliberately does NOT check `ProjectScanConfig.agentTicketGenerationEnabled`
 * before dispatching: the row is always created and the workflow always
 * started, which itself takes the D14 prerequisite-ticket fallback path when
 * access is off. This keeps a single, consistent code path for "access is
 * off" regardless of trigger source (manual today; a future scheduler per D15
 * would hit the identical path). The frontend button is separately disabled
 * client-side as the primary UX guard — this is defense-in-depth only.
 */
export const startGroupingProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/scan/grouping/start",
		tags: ["Projects", "Security"],
		summary:
			"Group open security & accessibility findings into thematic tickets",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { projectId, organizationId } = input;
		const user = context.user;

		const hasAccess = await hasProjectAccess(
			projectId,
			user.id,
			organizationId ?? undefined,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Dedupe: if a grouping run is already PENDING/RUNNING, return it as a
		// conflict so the client can poll the existing run instead of starting
		// another.
		if (await hasActiveScanFindingGrouping(projectId)) {
			throw new ORPCError("CONFLICT", {
				message: "A findings grouping run is already in progress.",
			});
		}

		const grouping = await createScanFindingGrouping({
			projectId,
			userId: user.id,
			organizationId: organizationId ?? null,
		});

		// Lazy-load @repo/temporal so importing this procedure doesn't pull the
		// temporal worker graph into the module graph (matches start-review.ts).
		const { getTemporalClient } = await import("@repo/temporal");
		const client = await getTemporalClient();
		const workflowId = `security-ticket-grouping-${grouping.id}`;
		try {
			const handle = await client.workflow.start(
				"securityFindingGroupingWorkflow",
				withCorrelationMemo({
					taskQueue: "fabric-worker",
					workflowId,
					args: [
						{
							groupingId: grouping.id,
							projectId,
							userId: user.id,
							organizationId: organizationId ?? null,
						},
					],
					workflowExecutionTimeout: "30 minutes",
				}),
			);
			await updateScanFindingGrouping(grouping.id, {
				workflowId: handle.workflowId,
			});
			return { groupingId: grouping.id, status: grouping.status };
		} catch (error) {
			// Dispatch failed — mark the row FAILED so it never hangs in PENDING
			// and the page can surface a retry rather than spin forever.
			await updateScanFindingGrouping(grouping.id, {
				status: "FAILED",
				error:
					error instanceof Error
						? error.message
						: "Failed to start findings grouping",
			}).catch(() => {});
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to start findings grouping",
			});
		}
	});
