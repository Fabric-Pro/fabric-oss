/**
 * cancelDraftCrawls — Unified Context Uploader Wizard.
 *
 * Batch-cancel helper for the explicit "Discard Draft" path. Iterates LINK
 * rows on a DRAFT `Project` and cancels each in-flight Temporal workflow
 * before the DRAFT is soft-deleted. Per-row cancellation reuses the same
 * Temporal `cancel()` pattern as
 * `packages/api/modules/projects/procedures/contexts/cancel-url-source-crawl.ts`
 * (lines 113-151) — this procedure is the orchestrator that wraps that
 * call in a loop and aggregates outcomes.
 *
 * Behaviour:
 *  1. `hasProjectAccess` guard (XOR-tenant aware).
 *  2. Project must be `status: "DRAFT"` — ACTIVE / ARCHIVED projects are
 *     rejected with `BAD_REQUEST` (code `NOT_A_DRAFT_PROJECT`). Real
 *     project context lifetimes belong to the per-row cancel procedure,
 *     not this batch helper.
 *  3. Query LINK rows in `PENDING` / `EXTRACTING` with a non-null
 *     `urlActiveWorkflowId` — those are the rows with a live workflow to
 *     cancel. Rows already in a terminal state (`COMPLETED`, `FAILED`,
 *     `CANCELLED`) are counted under `skippedTerminalCount` and not
 *     touched.
 *  4. For each candidate row, ask Temporal to cancel the workflow. A
 *     "not found" response is treated as silent success — the workflow
 *     already finalized between query time and our cancel call, so the
 *     caller's POV ("cancelled") is preserved (`cancelledCount++`, no
 *     entry in `errors`). Genuine Temporal failures are pushed to
 *     `errors[]` without aborting the batch — the discard flow continues
 *     regardless (see §6.2 / §6.4).
 *  5. The workflow itself is responsible for finalizing the row status to
 *     `CANCELLED` via the existing `updateParentStatusActivity` finalize
 *     step (per `cancel-url-source-crawl.ts:6-13`). We do NOT flip the row
 *     status here — that mirrors the per-row procedure.
 *
 * This is fire-and-forget from the user's POV — invoked just before
 * `softDeleteProject` in the discard handler. Errors are logged but do NOT
 * block the discard.
 */
import { ORPCError } from "@orpc/server";
import { db, hasProjectAccess } from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const cancelDraftCrawlsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/contexts/draft-crawls/cancel",
		tags: ["Projects", "Contexts"],
		summary: "Cancel all in-flight URL crawls on a DRAFT project",
		description:
			"Iterate the DRAFT project's LINK rows in PENDING/EXTRACTING state and cancel each in-flight Temporal workflow. Used by the wizard's Discard Draft path before soft-deleting the project. Silent — never emits a Notification.",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			cancelledCount: z.number().int(),
			skippedTerminalCount: z.number().int(),
			errors: z.array(
				z.object({
					contextId: z.string(),
					message: z.string(),
				}),
			),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Step 1: standard tenant/access guard. XOR enforced inside
		// `hasProjectAccess` per AGENTS.md.
		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Step 2: DRAFT-only guard. ACTIVE / ARCHIVED projects are
		// rejected — per-row cancel is the right tool for those, not this
		// batch endpoint. The XOR tenancy filter is implicit because
		// `hasProjectAccess` already validated tenant scope above.
		const project = await db.project.findFirst({
			where: {
				id: input.projectId,
				...(organizationId
					? { organizationId, userId: user.id }
					: { organizationId: null, userId: user.id }),
			},
			select: { id: true, status: true },
		});
		if (!project) {
			// Defence-in-depth — `hasProjectAccess` already covers this,
			// but a row could be soft-deleted in the milliseconds between
			// checks. Treat as NOT_FOUND so a stale tab gets a clean
			// signal instead of a misleading FORBIDDEN.
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}
		if (project.status !== "DRAFT") {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"This endpoint only cancels crawls on DRAFT projects. Use the per-row cancel procedure for active projects.",
				data: { code: "NOT_A_DRAFT_PROJECT" },
			});
		}

		// Step 3: enumerate live LINK rows. Terminal-status rows are
		// surfaced under `skippedTerminalCount` so the caller can reason
		// about why N candidates yielded < N cancellations.
		const liveLinks = await db.projectContext.findMany({
			where: {
				projectId: input.projectId,
				type: "LINK",
				extractionStatus: { in: ["PENDING", "EXTRACTING"] },
				urlActiveWorkflowId: { not: null },
			},
			select: {
				id: true,
				urlActiveWorkflowId: true,
			},
		});

		const terminalLinkCount = await db.projectContext.count({
			where: {
				projectId: input.projectId,
				type: "LINK",
				extractionStatus: { in: ["COMPLETED", "FAILED", "CANCELLED"] },
			},
		});

		// Step 4: per-row cancel loop. Wraps the same `getHandle().cancel()`
		// pattern from cancel-url-source-crawl.ts:113-151. Each iteration
		// is independent — a single failure must not abort the batch.
		const errors: Array<{ contextId: string; message: string }> = [];
		let cancelledCount = 0;

		if (liveLinks.length > 0) {
			const temporalClient = await getTemporalClient();

			for (const row of liveLinks) {
				// `liveLinks` only includes rows with non-null
				// `urlActiveWorkflowId` (Prisma filter), but the type is
				// still `string | null` because Prisma's narrow-on-where
				// inference doesn't reach selects. Guard once for TS +
				// defence-in-depth.
				const workflowId = row.urlActiveWorkflowId;
				if (!workflowId) {
					continue;
				}

				try {
					const handle =
						temporalClient.workflow.getHandle(workflowId);
					await handle.cancel();
					cancelledCount++;
					logger.info(
						`[CancelDraftCrawls] Sent cancel to workflow ${workflowId} for context ${row.id}`,
					);
				} catch (error) {
					const message =
						error instanceof Error
							? error.message
							: "Unknown error";
					// Same race-with-completion handling as the per-row
					// procedure: a "not found" response means the workflow
					// already finalized between our query and the cancel
					// call. From the caller's POV ("cancel this row")
					// that's success — don't push it to `errors[]`.
					if (/not\s+found/i.test(message)) {
						cancelledCount++;
						logger.warn(
							`[CancelDraftCrawls] Workflow ${workflowId} not found — likely completed already; treating as silent success for context ${row.id}`,
						);
						continue;
					}
					// Genuine failure — record and move on. The discard
					// path is fire-and-forget; we don't want to block on
					// any single workflow.
					logger.error(
						`[CancelDraftCrawls] Failed to cancel ${workflowId} for context ${row.id}: ${message}`,
					);
					errors.push({ contextId: row.id, message });
				}
			}
		}

		// Step 5: aggregate. The workflow's finalize activity is
		// responsible for flipping each row's `extractionStatus` to
		// `CANCELLED` — we do not write it here.
		return {
			cancelledCount,
			skippedTerminalCount: terminalLinkCount,
			errors,
		};
	});
