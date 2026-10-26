import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/client";
import type { DecisionPrecheckResult } from "@repo/agent-types";
import {
	claimPendingProposalWithReview,
	createBacklogUpdateSession,
	createPendingBacklogProposal,
	db,
	finalizeBacklogUpdateSession,
	finalizeClaimedProposal,
	getAppliedChangeIndexes,
	getBoundPromptForAgent,
	getPendingBacklogProposal,
	markProposalApplyDispatched,
	type Prisma,
} from "@repo/database";
import { getTemporalClient, runDecisionPrecheck } from "@repo/temporal";
import {
	CLEAN_SPEC_DOCUMENT_TYPE,
	cleanSpecAgentForKind,
} from "@repo/temporal/clean-spec-agent-for-kind";
import { describeSyncErrorForUser } from "@repo/temporal/pm-sync-user-error";
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
import {
	buildProposalReviewEntries,
	buildSidebarReviewEntries,
	PROPOSAL_REVIEW_MAX_CHANGES,
	resolveApprovedChangeIndexes,
} from "./proposal-review";
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

import {
	changeItemSchema,
	readProposalChanges,
	remapPmSyncOverrides,
} from "./change-item-schema";

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
			operationKey: z.string().min(1).max(200).optional(),
			organizationId: z.string().nullable().optional(),
			approvedChanges: z.array(changeItemSchema),
			approvedChangeIndexes: z
				.array(z.number().int().min(0).max(PROPOSAL_REVIEW_MAX_CHANGES))
				.max(PROPOSAL_REVIEW_MAX_CHANGES)
				.optional(),
			offeredChanges: z
				.array(
					z.object({
						action: z.enum(["create", "update"]),
						type: z.enum(["epic", "feature", "story", "bug"]),
						title: z.string(),
					}),
				)
				.max(PROPOSAL_REVIEW_MAX_CHANGES)
				.optional(),
			/**
			 * Optional PendingBacklogProposal being applied. When set, the
			 * handler claims the row (plan §F3) before starting the workflow
			 * and passes the proposal id through so every change is recorded.
			 */
			proposalId: z.string().optional(),
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

		if (!input.operationKey && input.approvedChanges.length === 0) {
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
		const payloadBytes = Buffer.byteLength(
			JSON.stringify({
				approvedChanges: input.approvedChanges,
				offeredChanges: input.offeredChanges,
			}),
			"utf8",
		);
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
		const resolvedOrganizationId = input.operationKey
			? (project.organizationId ?? undefined)
			: (organizationId ?? project.organizationId ?? undefined);

		// The existing primary key fences concurrent row creation; the fingerprint
		// in sourceMetadata binds retries to the original approved request.
		if (input.operationKey && input.proposalId) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Operation keys apply to new AI Update approvals only.",
			});
		}
		const operationId = input.operationKey
			? createHash("sha256")
					.update(
						JSON.stringify([
							input.projectId,
							user.id,
							input.operationKey,
						]),
					)
					.digest("hex")
			: undefined;
		const operationRowId = operationId
			? `backlog-apply-op-${operationId}`
			: undefined;
		const workflowId = backlogApplyWorkflowId(
			input.projectId,
			operationId ? `op-${operationId}` : undefined,
		);
		const fingerprint = operationId
			? createHash("sha256")
					.update(
						JSON.stringify(
							{
								projectId: input.projectId,
								userId: user.id,
								organizationId: project.organizationId,
								approvedChanges: input.approvedChanges,
								approvedChangeIndexes:
									input.approvedChangeIndexes,
								offeredChanges: input.offeredChanges,
								syncToPM: input.syncToPM,
								pmConfig: input.pmConfig,
								pmSyncOverrides: input.pmSyncOverrides,
								conversationId: input.conversationId,
								messages: input.messages,
							},
							(_key, value) =>
								value &&
								typeof value === "object" &&
								!Array.isArray(value)
									? Object.fromEntries(
											Object.entries(value).sort(
												([a], [b]) =>
													a < b ? -1 : a > b ? 1 : 0,
											),
										)
									: value,
						),
					)
					.digest("hex")
			: undefined;
		const assertOperation = (row: {
			projectId: string;
			userId: string | null;
			sourceMetadata: unknown;
		}) => {
			if (
				row.projectId !== input.projectId ||
				row.userId !== user.id ||
				(
					row.sourceMetadata as {
						applyInputFingerprint?: string;
					} | null
				)?.applyInputFingerprint !== fingerprint
			) {
				throw new ORPCError("CONFLICT", {
					message:
						"This apply operation key was already used with different inputs.",
				});
			}
		};
		const existingWorkflow = async (proposalId: string) => {
			const client = await getTemporalClient();
			try {
				const description = await client.workflow
					.getHandle(workflowId)
					.describe();
				await markProposalApplyDispatched({
					proposalId,
					applyWorkflowId: workflowId,
					mode: "claimed",
				}).catch(() => 0);
				return {
					workflowId,
					runId: description.runId,
					proposalId,
					message: "Backlog apply already started",
				};
			} catch (error) {
				if (
					error instanceof Error &&
					error.name === "WorkflowNotFoundError"
				) {
					const row = await db.pendingBacklogProposal.findUnique({
						where: { id: proposalId },
					});
					// This operation's dispatch stamp or claimed APPLIED outcome can
					// outlive Temporal history. Other terminal statuses alone do
					// not confirm dispatch: rejection or timeout can precede start.
					if (
						row?.applyWorkflowId === workflowId &&
						(row.applyStartedAt !== null ||
							row.status === "APPLIED")
					) {
						return {
							workflowId,
							proposalId,
							message:
								"Backlog apply already dispatched; open Review proposals for its outcome.",
						};
					}
					return undefined;
				}
				throw error;
			}
		};
		if (operationRowId) {
			const existing = await db.pendingBacklogProposal.findUnique({
				where: { id: operationRowId },
			});
			if (existing) {
				assertOperation(existing);
				try {
					const started = await existingWorkflow(existing.id);
					if (started) {
						return started;
					}
				} catch (_error) {
					throw new ORPCError("INTERNAL_SERVER_ERROR", {
						message:
							"Could not check the existing apply operation. Retry apply.",
					});
				}
			}
		}
		if (input.approvedChanges.length === 0) {
			return {
				workflowId: null,
				message: "No changes to apply",
				proposalId: null,
			};
		}
		const sidebarEntries = !input.proposalId
			? buildSidebarReviewEntries(
					input.approvedChanges,
					input.approvedChangeIndexes,
					input.offeredChanges,
					input.pmSyncOverrides,
				)
			: undefined;
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

		// Optional proposal claim (plan §F3). When the review UI applies an
		// existing PendingBacklogProposal (Teams / scope-intake inbox), resolve
		// the approved changes to their stored indexes and claim the row BEFORE
		// starting the workflow, so a concurrent approve gets CONFLICT and no
		// second workflow is ever started for the same proposal. Changes already
		// recorded as applied (a retry after a crash) are dropped here.
		let approvedChanges = input.approvedChanges;
		let approvedChangeIndexes: number[] | undefined;
		// Positions in `input.approvedChanges` that survive retry filtering.
		// `pmSyncOverrides` is keyed by submitted position and the workflow
		// reads it by position in the array it receives, so the map must be
		// re-keyed whenever changes are dropped below.
		let keptPositions = input.approvedChanges.map(
			(_c, position) => position,
		);

		if (input.proposalId) {
			const existing = await getPendingBacklogProposal(input.proposalId);
			if (!existing || existing.projectId !== input.projectId) {
				throw new ORPCError("NOT_FOUND", {
					message: "Proposal not found",
				});
			}
			const proposalChanges = readProposalChanges(existing.proposal);
			const indexes = resolveApprovedChangeIndexes(
				proposalChanges,
				input.approvedChanges,
				input.approvedChangeIndexes,
			);
			const indexed = input.approvedChanges.map((change, position) => ({
				change,
				index: indexes[position]!,
				position,
			}));
			const alreadyApplied = await getAppliedChangeIndexes(
				input.proposalId,
			);
			for (const index of existing.appliedChangeIndexes ?? [])
				alreadyApplied.add(index);
			const remaining = indexed.filter(
				({ index }) => !alreadyApplied.has(index),
			);
			// Fizzy #2208 (FR27): an accepted recommendation is drafted through
			// the Clean Spec prompt, never as a stub. Refuse up front when no
			// prompt is bound rather than failing every item inside the apply.
			const isRecommendation =
				existing.source === "ROADMAP_RECOMMENDATION";
			if (isRecommendation) {
				const cleanSpecPrompt = await getBoundPromptForAgent({
					agentName: cleanSpecAgentForKind("FEATURE"),
					documentType: CLEAN_SPEC_DOCUMENT_TYPE,
					storyKind: "FEATURE",
					userId: user.id,
					organizationId: resolvedOrganizationId,
					projectId: existing.projectId,
				});
				if (!cleanSpecPrompt?.version?.content?.trim()) {
					throw new ORPCError("PRECONDITION_FAILED", {
						message:
							"Accepting recommended features needs the feature specification prompt. Ask a project admin to bind the Clean Spec prompt, then try again.",
					});
				}
			}
			const claimed = await claimPendingProposalWithReview({
				proposalId: input.proposalId,
				reviewedBy: user.id,
				applyWorkflowId: workflowId,
				syncToPM: input.syncToPM,
				offeredListComplete: true,
				pmConfig: input.pmConfig,
				entries: buildProposalReviewEntries(
					proposalChanges,
					input.approvedChanges,
					indexes,
					input.pmSyncOverrides,
				),
				...(isRecommendation ? { admitBacklog: true } : {}),
			});
			if (!claimed) {
				throw new ORPCError("CONFLICT", {
					message:
						"Proposal is already being applied or was already reviewed",
				});
			}
			if (remaining.length === 0) {
				await finalizeClaimedProposal({
					proposalId: input.proposalId,
					applyWorkflowId: workflowId,
					outcome: "applied",
				});
				return {
					workflowId: null,
					message: "All approved changes were already applied",
					proposalId: input.proposalId,
				};
			}
			approvedChanges = remaining.map((r) => r.change);
			approvedChangeIndexes = remaining.map((r) => r.index);
			keptPositions = remaining.map((r) => r.position);
		}

		// AC #1: write the PendingBacklogProposal row BEFORE starting the
		// workflow. Order matters — the workflow's terminal handler flips
		// this row to APPLIED / FAILED, and we don't want a race where the
		// workflow finishes before the row exists. The PM-sync gate is
		// honored downstream by the workflow's existing `enqueuePmSync`
		// contract on newly-created stories; dedup-collision matches do
		// NOT mutate `pmAutoSyncEnabled` on the existing target story.
		let proposalId: string;
		if (input.proposalId) {
			// Claimed above: the row already exists and carries the claim.
			proposalId = input.proposalId;
		} else {
			try {
				const proposalData = {
					projectId: input.projectId,
					source: "AI_UPDATE_SIDEBAR" as const,
					proposal: {
						changes: input.approvedChanges,
					} as unknown as Prisma.InputJsonValue,
					summary: `${input.approvedChanges.length} proposed change(s) from AI Update`,
					changeCount: input.approvedChanges.length,
					sourceMetadata: {
						syncToPM: input.syncToPM,
						pmConfig: input.pmConfig ?? null,
						conversationId: input.conversationId ?? null,
						...(operationId
							? { applyInputFingerprint: fingerprint }
							: {}),
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
				};
				const { decisionPrecheck: storedPrecheck, ...createData } =
					proposalData;
				const proposal = operationRowId
					? await db.pendingBacklogProposal
							.upsert({
								where: { id: operationRowId },
								update: {},
								create: {
									...createData,
									id: operationRowId,
									sourceMetadata: {
										...(createData.sourceMetadata as Prisma.InputJsonObject),
										...(storedPrecheck
											? {
													decisionPrecheck:
														storedPrecheck,
												}
											: {}),
									},
								},
							})
							.catch(async (error: unknown) => {
								// Prisma may emulate an upsert; reconcile a competing insert by its primary key.
								if (
									(error as { code?: unknown })?.code ===
									"P2002"
								) {
									const row =
										await db.pendingBacklogProposal.findUnique(
											{ where: { id: operationRowId } },
										);
									if (row) {
										return row;
									}
								}
								throw error;
							})
					: await createPendingBacklogProposal(proposalData);
				if (operationRowId) {
					assertOperation(proposal);
				}
				proposalId = proposal.id;
			} catch (error) {
				if (error instanceof ORPCError) {
					throw error;
				}
				console.error(
					"[backlog] apply-changes failed to persist proposal row:",
					error,
				);
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message:
						error instanceof Error
							? `Failed to persist proposal row: ${describeSyncErrorForUser(error)}`
							: "Failed to persist proposal row",
				});
			}
		}

		// Session history: record this AI Backlog Update run so it appears in the
		// read-only "Session history" tab. Created with status APPLYING; the apply
		// workflow's finalize activity flips it to a terminal status (correlated by
		// `pendingProposalId`). Best-effort — a session-row failure must never break
		// the apply (the history tab is the only consumer).
		let createdSessionId: string | undefined;
		try {
			const createCount = input.approvedChanges.filter(
				(change) => change.action === "create",
			).length;
			const sessionInput = {
				projectId: input.projectId,
				pendingProposalId: proposalId,
				conversationId: input.conversationId ?? null,
				source: input.proposalId
					? "PENDING_PROPOSAL"
					: "AI_UPDATE_SIDEBAR",
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
			};
			if (operationId) {
				// Serialize keyed history creation on the durable proposal, before dispatch.
				// The lock and insert share a transaction, so concurrent deliveries see the winner's session.
				// FOR NO KEY UPDATE still serializes duplicate deliveries without blocking other
				// transactions' FK inserts that reference this proposal (FK checks take FOR KEY SHARE).
				createdSessionId = await db.$transaction(
					async (tx) => {
						await tx.$queryRaw`SELECT "id" FROM "pending_backlog_proposal" WHERE "id" = ${proposalId} FOR NO KEY UPDATE`;
						const existing =
							await tx.backlogUpdateSession.findFirst({
								where: { pendingProposalId: proposalId },
								select: { id: true },
							});
						if (!existing) {
							const session = await createBacklogUpdateSession(
								sessionInput,
								tx,
							);
							return session.id;
						}
					},
					{ timeout: 10000, maxWait: 10000 },
				);
			} else {
				const session = await createBacklogUpdateSession(sessionInput);
				createdSessionId = session.id;
			}
		} catch {
			// Non-fatal: a missing session row only affects the history tab.
		}

		let sidebarClaimed = false;
		try {
			const client = await getTemporalClient();

			if (operationRowId) {
				const existing = await existingWorkflow(proposalId);
				if (existing) {
					return existing;
				}
			}
			if (!input.proposalId) {
				// Claim before dispatch: even an immediately finishing workflow must
				// see its own APPLYING row. Keyed redelivery may reuse that claim,
				// but cannot resurrect a terminal row or take another workflow's row.
				// Reusing APPLYING requires a null stamp so a concurrent confirmation
				// after reconciliation is preserved rather than cleared.
				const claimed = await claimPendingProposalWithReview({
					proposalId,
					reviewedBy: user.id,
					applyWorkflowId: workflowId,
					reuseReviewForAttempt: true,
					claimWhere: {
						OR: [
							{ status: "PENDING", applyWorkflowId: null },
							{
								status: "APPLYING",
								applyWorkflowId: workflowId,
								applyStartedAt: null,
							},
						],
					},
					syncToPM: input.syncToPM,
					pmConfig: input.pmConfig,
					entries: sidebarEntries!,
					offeredListComplete: input.offeredChanges !== undefined,
				});
				if (!claimed) {
					// A keyed delivery may have dispatched between reconciliation
					// and the claim. Recheck through the shared evidence gate.
					if (operationRowId) {
						const existing = await existingWorkflow(proposalId);
						if (existing) {
							return existing;
						}
					}
					if (createdSessionId) {
						// Only this call's insert belongs to the failed claim. A keyed
						// redelivery may have reused another call's session instead.
						await db.backlogUpdateSession
							.updateMany({
								where: {
									id: createdSessionId,
									status: "APPLYING",
								},
								data: {
									status: "FAILED",
									appliedCount: 0,
									failedCount: input.approvedChanges.length,
									finalizedAt: new Date(),
								},
							})
							.catch(() => 0);
					}
					throw new ORPCError("CONFLICT", {
						message:
							"This proposal is no longer available to apply.",
					});
				}
				sidebarClaimed = true;
			}
			const handle = await client.workflow.start(
				"backlogApplyChangesWorkflow",
				withCorrelationMemo({
					taskQueue: "ai-chat",
					workflowId,
					...(operationId
						? { workflowIdReusePolicy: "REJECT_DUPLICATE" as const }
						: {}),
					args: [
						{
							projectId: input.projectId,
							userId: user.id,
							approvedByName: user.name ?? null,
							// A person clicked and waits for this: it may run on their own ChatGPT plan (Fizzy #2770).
							planEligible: true,
							organizationId: resolvedOrganizationId,
							approvedChanges,
							approvedChangeIndexes,
							syncToPM: input.syncToPM,
							pmSyncOverrides: input.pmSyncOverrides
								? remapPmSyncOverrides(
										input.pmSyncOverrides,
										keptPositions,
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
							// APPLYING and surface as an unfinished proposal.
							pendingProposalId: proposalId,
							// See input-schema comment.
							conversationId: input.conversationId,
						},
					],
				}),
			);

			// Record confirmed dispatch. A late stamp after finalization or a
			// replacement claim is a no-op. If stamping fails, the watchdog falls
			// back to reviewedAt / createdAt until dispatch can be confirmed.
			await markProposalApplyDispatched({
				proposalId,
				applyWorkflowId: workflowId,
				mode: "claimed",
			}).catch(() => 0);

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
				message: `Applying ${approvedChanges.length} change(s)`,
				proposalId,
			};
		} catch (error) {
			if (error instanceof ORPCError) {
				throw error;
			}
			if (operationRowId) {
				// Start may have committed before transport failure. Reconcile the
				// same id; if unknown, retain the row for an identical retry.
				try {
					const existing = await existingWorkflow(proposalId);
					if (existing) {
						return existing;
					}
				} catch {
					/* The caller can retry this durable operation. */
				}
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message:
						"Could not confirm apply dispatch. Retry apply with the same approval.",
				});
			}
			console.error(
				"[backlog] apply-changes failed to start workflow:",
				error,
			);
			if (input.proposalId) {
				// Release the claim (plan §F3) so the proposal is retryable
				// from the inbox; the failure is recorded on the row.
				await finalizeClaimedProposal({
					proposalId: input.proposalId,
					applyWorkflowId: workflowId,
					outcome: "failed",
					errorMessage:
						error instanceof Error
							? describeSyncErrorForUser(error)
							: "Failed to start apply changes workflow",
				}).catch(() => {});
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message:
						error instanceof Error
							? describeSyncErrorForUser(error)
							: "Failed to start apply changes workflow",
				});
			}
			// Preparation or workflow start failed after this request persisted the row.
			// Fail only its unclaimed PENDING row or its current APPLYING attempt.
			// The update is best-effort; the rethrown error is what the client sees.
			await db.pendingBacklogProposal
				.updateMany({
					where: {
						id: proposalId,
						status: sidebarClaimed ? "APPLYING" : "PENDING",
						applyWorkflowId: sidebarClaimed ? workflowId : null,
					},
					data: {
						status: "FAILED",
						errorClass: sidebarClaimed
							? "TemporalScheduleFailed"
							: "ProposalReviewFailed",
						errorMessage: "Background job couldn't start.",
						applyError: (error instanceof Error
							? describeSyncErrorForUser(error)
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
						? describeSyncErrorForUser(error)
						: "Failed to start apply changes workflow",
			});
		}
	});
