import { ORPCError } from "@orpc/client";
import type { DecisionPrecheckResult } from "@repo/agent-types";
import {
	createBacklogUpdateSession,
	createPendingBacklogProposal,
	db,
	finalizeBacklogUpdateSession,
	markProposalApplyDispatched,
	type Prisma,
} from "@repo/database";
import { getTemporalClient, runDecisionPrecheck } from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	buildBacklogPrecheckItems,
	filterFindingsToApprovedChanges,
	findApprovedChangeForFinding,
	recordDecisionOverridesAccepted,
	snapshotBacklogChange,
} from "../../lib/decision-override-audit";
import { backlogApplyWorkflowId } from "./workflow-id";

/**
 * Defensive guardrail for the proposal-row snapshot. Same threshold used for
 * the Stage A payload-too-large risk (~1 MB). Larger batches should be
 * approved in smaller chunks. Postgres `jsonb` itself can hold up to ~1 GB
 * but the row gets read on every inbox query and we don't want a multi-MB
 * blob shipped to the wire.
 */
const APPLY_PAYLOAD_MAX_BYTES = 1_000_000;

/**
 * Re-resolve the server-computed pre-check before anything from it is persisted
 * or written to the immutable override ledger:
 *  - keep only findings whose change is in `approvedChanges` (correlated by title
 *    via the shared `filterFindingsToApprovedChanges`) — a no-op for the apply
 *    path (the judge runs on `approvedChanges` directly), but a defensive filter;
 *  - resolve each finding's `decisionId` against the project's real architecture
 *    decisions, dropping any that don't resolve and taking the identifier + title
 *    from the DB row — the WORM ledger carries only DB-authoritative strings;
 *  - re-derive `conflictType` from the resolved decision's CURRENT status (an
 *    ACCEPTED decision is violated, a REJECTED one is reintroduced) — the judge's
 *    guess never overrides the live DB status;
 *  - remap `changeRef.index` to the correlated change's position in
 *    `approvedChanges` (identity here, since the judge already indexed that list).
 *
 * The finding count + field lengths are bounded upstream by the judge
 * (`MAX_DECISION_FINDINGS`, its output schema). Returns the filtered result;
 * `findings` is empty when nothing survives.
 */
async function resolveAppliedDecisionConflicts(
	precheck: DecisionPrecheckResult,
	projectId: string,
	approvedChanges: Array<{ title: { to: string } }>,
): Promise<DecisionPrecheckResult> {
	const applied = filterFindingsToApprovedChanges(precheck, approvedChanges);

	const decisionIds = Array.from(
		new Set(applied.findings.map((finding) => finding.decisionId)),
	);
	const decisions = decisionIds.length
		? await db.architectureDecision.findMany({
				where: { id: { in: decisionIds }, projectId, deletedAt: null },
				select: {
					id: true,
					identifier: true,
					title: true,
					status: true,
				},
			})
		: [];
	const byId = new Map(
		decisions.map((decision) => [decision.id, decision] as const),
	);

	const findings = applied.findings.flatMap((finding) => {
		const decision = byId.get(finding.decisionId);
		if (!decision) {
			return [];
		}
		const approvedIndex = approvedChanges.findIndex(
			(change) =>
				change.title.to.trim() === finding.changeRef?.title?.trim(),
		);
		return [
			{
				...finding,
				decisionIdentifier: decision.identifier,
				decisionTitle: decision.title,
				conflictType:
					decision.status === "REJECTED"
						? ("reintroduces_rejected" as const)
						: ("violates_accepted" as const),
				...(finding.changeRef && approvedIndex >= 0
					? {
							changeRef: {
								...finding.changeRef,
								index: approvedIndex,
							},
						}
					: {}),
			},
		];
	});

	return { ...applied, findings };
}

/**
 * Apply approved backlog changes via Temporal workflow.
 *
 * Starts the backlogApplyChangesWorkflow which:
 * 1. Creates/updates items in Fabric DB (hierarchy order: epics → features → stories)
 * 2. Optionally syncs to PM tool (Azure DevOps, etc.)
 *
 * AUTHORIZATION: Uses canEditProject() - verifies org membership + editor role
 */
export const applyChangesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/backlog/apply",
		tags: ["Projects", "Backlog"],
		summary: "Apply backlog changes",
		description:
			"Start a Temporal workflow to apply approved backlog changes",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			approvedChanges: z.array(
				z.object({
					type: z.enum(["epic", "feature", "story", "bug"]),
					action: z.enum(["create", "update"]),
					existingId: z.string().nullable().optional(),
					existingIdentifier: z.string().nullable().optional(),
					existingExternalId: z.string().nullable().optional(),
					title: z.object({
						from: z.string().nullable().optional(),
						to: z.string(),
					}),
					description: z
						.object({
							from: z.string().nullable().optional(),
							to: z.string(),
						})
						.nullable()
						.optional(),
					acceptanceCriteria: z
						.object({
							from: z.string().nullable().optional(),
							to: z.string(),
						})
						.nullable()
						.optional(),
					priority: z
						.object({
							from: z.string().nullable().optional(),
							to: z.string(),
						})
						.nullable()
						.optional(),
					size: z
						.object({
							from: z.string().nullable().optional(),
							to: z.string(),
						})
						.nullable()
						.optional(),
					parentEpicIdentifier: z.string().nullable().optional(),
					parentFeatureIdentifier: z.string().nullable().optional(),
					parentEpicTitle: z.string().nullable().optional(),
					parentFeatureTitle: z.string().nullable().optional(),
					// Annotation, not payload — see the note on the generation
					// schema in `analyze-context.ts`. The analyzer is allowed to
					// return a change without either field, so demanding them
					// here would only move the failure to the Apply click, after
					// the reviewer has already spent the effort. The enum still
					// holds for a sourceContext that IS present.
					reasoning: z.string().nullable().optional(),
					sourceContext: z
						.enum([
							"teams_messages",
							"meeting_transcript",
							"notion_page",
							"slack_messages",
							"multiple",
						])
						.nullable()
						.optional(),
					/**
					 * Inline PM override of the AI classifier's kind decision.
					 * Honored by `applyBacklogChanges` for create rows —
					 * passes `kind` + `skipClassifier: true` to
					 * createStoryFromProposal so the user's selection wins.
					 */
					kindOverride: z
						.enum(["BUG", "FEATURE"])
						.nullable()
						.optional(),
					/**
					 * Safe-hold flag stamped by the structure-preserving update
					 * pass when AI could not safely produce a targeted edit and the
					 * existing body was kept unchanged. Passed through so the apply
					 * audit records the safe-hold (the "+ flag" of "safe-hold + flag").
					 */
					bodyMergeFallback: z.boolean().optional(),
					/**
					 * Set when the analysis-time pass already structure-preserved
					 * this update's body. Passed through so `applyBacklogChanges`
					 * skips re-merging (no double LLM call); proposals that bypassed
					 * analysis arrive without it and are merged at apply time.
					 */
					structurePreserved: z.boolean().optional(),
					/**
					 * Set when a CREATE's body was drafted through the kind prompt at
					 * review time (lazy draft on open). Apply persists it verbatim
					 * (no re-draft, bugs included), carrying `needsMoreInfo`.
					 */
					predrafted: z.boolean().optional(),
					/** Bug triage flag captured by the review-time draft. */
					needsMoreInfo: z.boolean().optional(),
				}),
			),
			syncToPM: z.boolean().default(false),
			pmConfig: z
				.object({
					mcpConfigId: z.string(),
					containerId: z.string(),
					additionalContext: z
						.record(z.string(), z.string())
						.optional(),
				})
				.optional(),
			pmSyncOverrides: z
				.record(
					z.string(),
					z.object({
						pushAnyway: z.boolean().optional(),
						skip: z.boolean().optional(),
					}),
				)
				.optional(),
			/**
			 * Optional `AgentConversation` ID for the
			 * persistent operation-result message. Same shape and intent
			 * as `start-analysis.ts`; see that file's input-schema doc
			 * for the architectural rationale.
			 */
			conversationId: z.string().max(200).optional(),
			/**
			 * Read-only snapshot of the AI Update chat transcript (role +
			 * content), captured client-side at apply time so the Session
			 * history can show the conversation that produced these changes.
			 */
			messages: z
				.array(
					z.object({
						role: z.string(),
						content: z.string(),
					}),
				)
				.max(100)
				.optional(),
			// NOTE: the decision pre-check result is NOT accepted from the client.
			// The override log must not be suppressible by client input, so the
			// judge is re-run server-side at apply time (below) — the ride-along
			// `proposal.decisionConflicts` still drives the sidebar's inline note
			// for the user, but never the WORM ledger.
		}),
	)
	.output(
		z.object({
			workflowId: z.string().nullable(),
			runId: z.string().optional(),
			message: z.string(),
			/**
			 * Id of the `PendingBacklogProposal` row written before the
			 * workflow starts. Returned so the frontend can correlate the
			 * apply (and a later retry / dismiss) with the row. `null` only
			 * on the no-op zero-changes short-circuit.
			 */
			proposalId: z.string().nullable().optional(),
			pmSyncResults: z
				.array(
					z.object({
						storyId: z.string(),
						itemType: z.enum(["epic", "feature", "story", "bug"]),
						status: z.enum(["SUCCESS", "CONFLICT", "FAILED"]),
						errorClass: z.string().optional(),
						message: z.string().optional(),
						pmCurrent: z
							.object({
								title: z.string(),
								description: z.string(),
							})
							.optional(),
						pmUrl: z.string().optional(),
					}),
				)
				.optional(),
			pmSyncOutage: z
				.object({
					tool: z.string(),
					errorClass: z.string(),
					count: z.number(),
					items: z.array(
						z.object({
							id: z.string(),
							itemType: z.enum([
								"epic",
								"feature",
								"story",
								"bug",
							]),
						}),
					),
				})
				.optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		if (input.approvedChanges.length === 0) {
			return {
				workflowId: null,
				message: "No changes to apply",
				proposalId: null,
			};
		}

		// Defensive guardrail: oversize batches are rejected here so the
		// proposal-row snapshot doesn't blow the JSON column. The frontend
		// gets a clear nudge instead of a 500. (The server-computed pre-check is
		// bounded by the judge's own `MAX_DECISION_FINDINGS`, so it can't blow the
		// ceiling on its own.)
		const payloadBytes = JSON.stringify(input.approvedChanges).length;
		if (payloadBytes > APPLY_PAYLOAD_MAX_BYTES) {
			throw new ORPCError("RESOURCE_EXHAUSTED", {
				message: "Batch too large; approve in smaller chunks",
			});
		}

		// Get project to confirm existence and get organizationId + PM container info
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: {
				id: true,
				organizationId: true,
				projectManagementContainerName: true,
			},
		});

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found",
			});
		}

		// Resolve the effective tenancy pair the proposal row will carry.
		// Both `organizationId` and `userId` are stamped on the row so
		// downstream XOR queries (failed-count, retry, dismiss) can filter
		// `{ organizationId, userId }` exclusively per the standards.
		const resolvedOrganizationId =
			organizationId ?? project.organizationId ?? undefined;

		// Server-AUTHORITATIVE decision pre-check. The override ledger must not be
		// suppressible by client input (a forged `ok`, an omitted finding, or the
		// chat "skip analysis" / fast-apply paths that relay nothing), so we
		// ALWAYS re-run the judge here against the changes actually being applied —
		// the client's ride-along result is never trusted for the WORM write.
		// `runDecisionPrecheck` short-circuits BEFORE the LLM when no logged
		// decision is semantically near the changes (`candidates.length === 0`),
		// so the common apply pays only a candidate-selection query, not the judge.
		// It is the degradation boundary (never throws; returns an empty `ok` on
		// any failure), so a judge hiccup can never block apply.
		// `resolveAppliedDecisionConflicts` then re-resolves each finding's decision
		// against the project's real decisions (authoritative identifier / title /
		// conflictType) before anything is persisted or written to the ledger.
		const serverPrecheck = await runDecisionPrecheck({
			projectId: input.projectId,
			userId: user.id,
			organizationId: resolvedOrganizationId,
			artifact: {
				surface: "backlog_proposal",
				items: buildBacklogPrecheckItems(input.approvedChanges),
			},
		});
		const decisionPrecheck =
			serverPrecheck.status === "conflicts"
				? await resolveAppliedDecisionConflicts(
						serverPrecheck,
						input.projectId,
						input.approvedChanges,
					)
				: null;
		const hasUnresolvedDecisionConflicts =
			decisionPrecheck !== null && decisionPrecheck.findings.length > 0;

		// AC #1: write the PendingBacklogProposal row BEFORE starting the
		// workflow. Order matters — the workflow's terminal handler flips
		// this row to APPLIED / FAILED, and we don't want a race where the
		// workflow finishes before the row exists. The PM-sync gate is
		// honored downstream by the workflow's existing `enqueuePmSync`
		// contract on newly-created stories; dedup-collision matches do
		// NOT mutate `pmAutoSyncEnabled` on the existing target story.
		let proposalId: string;
		try {
			const proposal = await createPendingBacklogProposal({
				projectId: input.projectId,
				source: "AI_UPDATE_SIDEBAR",
				proposal: {
					changes: input.approvedChanges,
				} as unknown as Prisma.InputJsonValue,
				summary: `${input.approvedChanges.length} proposed change(s) from AI Update`,
				changeCount: input.approvedChanges.length,
				sourceMetadata: {
					syncToPM: input.syncToPM,
					pmConfig: input.pmConfig ?? null,
					conversationId: input.conversationId ?? null,
				} as unknown as Prisma.InputJsonValue,
				// Fold the narrowed pre-check under `sourceMetadata.decisionPrecheck`
				// (the query merges it) so the review UI + Overrides list read it
				// back durably. Undefined when flag-off / no conflicts ⇒ metadata
				// is written exactly as before.
				decisionPrecheck: hasUnresolvedDecisionConflicts
					? (decisionPrecheck as unknown as Prisma.InputJsonValue)
					: undefined,
				userId: user.id,
				organizationId: resolvedOrganizationId,
			});
			proposalId = proposal.id;
		} catch (error) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					error instanceof Error
						? `Failed to persist proposal row: ${error.message}`
						: "Failed to persist proposal row",
			});
		}

		// Session history: record this AI Backlog Update run so it appears in the
		// read-only "Session history" tab. Created with status APPLYING; the apply
		// workflow's finalize activity flips it to a terminal status (correlated by
		// `pendingProposalId`). Best-effort — a session-row failure must never break
		// the apply (the history tab is the only consumer).
		try {
			const createCount = input.approvedChanges.filter(
				(change) => change.action === "create",
			).length;
			await createBacklogUpdateSession({
				projectId: input.projectId,
				pendingProposalId: proposalId,
				conversationId: input.conversationId ?? null,
				source: "AI_UPDATE_SIDEBAR",
				summary: `${input.approvedChanges.length} proposed change(s) from AI Update`,
				// Store only the lightweight {action,type,title} the session log
				// renders — NOT the full change payload (which can be ~1MB and would
				// then be SELECTed for every row of the history list).
				changes: input.approvedChanges.map((change) => ({
					action: change.action,
					type: change.type,
					title: change.title.to,
				})) as unknown as Prisma.InputJsonValue,
				changeCount: input.approvedChanges.length,
				createCount,
				updateCount: input.approvedChanges.length - createCount,
				messages:
					input.messages && input.messages.length > 0
						? (input.messages as unknown as Prisma.InputJsonValue)
						: undefined,
				userId: user.id,
				organizationId: resolvedOrganizationId,
			});
		} catch {
			// Non-fatal: a missing session row only affects the history tab.
		}

		try {
			const client = await getTemporalClient();

			const workflowId = backlogApplyWorkflowId(input.projectId);

			const handle = await client.workflow.start(
				"backlogApplyChangesWorkflow",
				withCorrelationMemo({
					taskQueue: "ai-chat",
					workflowId,
					args: [
						{
							projectId: input.projectId,
							userId: user.id,
							approvedByName: user.name ?? null,
							organizationId: resolvedOrganizationId,
							approvedChanges: input.approvedChanges,
							syncToPM: input.syncToPM,
							pmSyncOverrides: input.pmSyncOverrides
								? Object.fromEntries(
										Object.entries(
											input.pmSyncOverrides,
										).map(([k, v]) => [Number(k), v]),
									)
								: undefined,
							pmConfig: input.pmConfig
								? {
										...input.pmConfig,
										containerName:
											project.projectManagementContainerName ??
											undefined,
									}
								: undefined,
							// Threaded so the workflow can flip the row to
							// APPLIED on success or FAILED on per-change
							// error. Without this the row would stay
							// PENDING and surface as a leaked proposal.
							pendingProposalId: proposalId,
							// See input-schema comment.
							conversationId: input.conversationId,
						},
					],
				}),
			);

			// Stamp the dispatch so the stuck-apply watchdog + manual cancel can
			// find and terminate this apply. Best-effort: the workflow has
			// already started, so a stamp failure must NOT fail the apply — it
			// only means the watchdog can't auto-recover this row (the user can
			// still dismiss / retry it from the inbox).
			await markProposalApplyDispatched(proposalId, workflowId).catch(
				() => {},
			);

			// Server-authoritative override log: the user applied AI output that
			// contradicts a logged decision. Write one immutable
			// `decision.override_accepted` row per conflicting decision, all
			// sharing this proposal row as the artifact. Reached only once the
			// apply is successfully dispatched (a start failure returns via the
			// catch below and never logs). Flag-gated + best-effort inside the
			// helper — a failed audit write never breaks the apply.
			if (hasUnresolvedDecisionConflicts) {
				recordDecisionOverridesAccepted(context, {
					projectId: input.projectId,
					organizationId: resolvedOrganizationId ?? null,
					surface: "backlog_proposal",
					artifactType: "pending_backlog_proposal",
					artifactId: proposalId,
					precheck: decisionPrecheck,
					// Snapshot the change that was ACTUALLY applied (matched by
					// title), not `approvedChanges[changeRef.index]` — the finding's
					// index is the full analysis-time position while
					// `approvedChanges` is the re-indexed selected subset.
					resolveSnapshot: (finding) =>
						snapshotBacklogChange(
							findApprovedChangeForFinding(
								finding,
								input.approvedChanges,
							),
						),
				});
			}

			return {
				workflowId: handle.workflowId,
				runId: handle.firstExecutionRunId,
				message: `Applying ${input.approvedChanges.length} change(s)`,
				proposalId,
			};
		} catch (error) {
			// Workflow start failed AFTER we persisted the proposal row. Mark
			// the row as FAILED so it surfaces in the inbox / banner — without
			// this, the row would be stuck PENDING forever and the user would
			// have no way to retry or dismiss it. Best-effort: the rethrown
			// error is what the client sees; the row update is the safety net.
			await db.pendingBacklogProposal
				.update({
					where: { id: proposalId },
					data: {
						status: "FAILED",
						errorClass: "TemporalScheduleFailed",
						errorMessage: "Background job couldn't start.",
						applyError: (error instanceof Error
							? error.message
							: "Failed to start apply changes workflow"
						).slice(0, 4000),
						failedAt: new Date(),
					},
				})
				.catch(() => {
					// non-fatal — surfaced via the thrown ORPCError below.
				});
			// Mirror the failure onto the session-history row (best-effort; no-op
			// when no session exists) so the apply isn't orphaned in APPLYING when
			// the workflow never started and its finalize activity never runs.
			try {
				await finalizeBacklogUpdateSession({
					pendingProposalId: proposalId,
					status: "FAILED",
				});
			} catch {
				// Non-fatal: a stuck session row only affects the history tab.
			}
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					error instanceof Error
						? error.message
						: "Failed to start apply changes workflow",
			});
		}
	});
