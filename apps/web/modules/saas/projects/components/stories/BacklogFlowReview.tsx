"use client";
import { useQueryClient } from "@tanstack/react-query";
import type { MutableRefObject } from "react";
import { orpcClient } from "../../../../shared/lib/orpc-client";
import {
	BacklogChangeProposal,
	type ChangeItem,
} from "./BacklogChangeProposal";
import {
	type BacklogFlow,
	type BacklogFlowController,
	beforeDeadline,
	pollWorkflowProgress,
	workflowPollMessage,
} from "./backlog-flow-controller";

const APPLY_PROPOSAL_CHECK_INTERVAL_MS = 10000;

async function readApplyProgress(
	input: {
		projectId: string;
		organizationId: string | null;
		workflowId: string;
		proposalId?: string | null;
	},
	checkProposal: boolean,
) {
	const progress = await orpcClient.projects.backlog.applyProgress({
		projectId: input.projectId,
		workflowId: input.workflowId,
	});
	if (
		(!checkProposal && progress.status !== "failed") ||
		!input.proposalId ||
		(progress.status !== "applying" &&
			progress.status !== "syncing_pm" &&
			progress.status !== "failed")
	) {
		return progress;
	}
	try {
		const row = await orpcClient.projects.backlog.getPendingProposal({
			projectId: input.projectId,
			organizationId: input.organizationId,
			proposalId: input.proposalId,
		});
		if (
			row.applyWorkflowId === input.workflowId &&
			row.status === "FAILED" &&
			(row.errorClass === "Cancelled" || row.errorClass === "TimedOut")
		) {
			return {
				...progress,
				status:
					row.errorClass === "Cancelled"
						? ("cancelled" as const)
						: ("failed" as const),
				message:
					row.errorMessage ??
					row.applyError ??
					"Apply stopped. Open Review proposals to retry.",
			};
		}
	} catch {
		// The workflow read remains usable if the optional row read fails.
	}
	return progress;
}

export type ReviewSettings = {
	projectId: string;
	organizationId: string | null;
	hasPMTool: boolean;
	pmToolName?: string;
	pmConfig?: {
		mcpConfigId: string;
		containerId: string;
		additionalContext?: Record<string, string>;
	};
	ensureBacklogConversationId: () => Promise<string>;
	liveMessagesRef: MutableRefObject<unknown[]>;
	onChangesApplied: () => void;
};
type Props = ReviewSettings & {
	flow: BacklogFlow;
	controller: BacklogFlowController;
	settingsRef?: MutableRefObject<ReviewSettings>;
};
function snapshotBacklogMessages(
	messages: unknown,
): { role: string; content: string }[] {
	if (!Array.isArray(messages)) {
		return [];
	}
	const out: { role: string; content: string }[] = [];
	for (const m of messages) {
		if (!m || typeof m !== "object") {
			continue;
		}
		const role = (m as { role?: unknown }).role;
		const content = (m as { content?: unknown }).content;
		if (
			(role === "user" || role === "assistant") &&
			typeof content === "string" &&
			content.trim().length > 0
		) {
			out.push({
				role,
				content:
					content.length > 4000
						? `${content.slice(0, 4000)}…`
						: content,
			});
		}
	}
	// Keep the most recent 60 messages to bound the persisted payload.
	return out.slice(-60);
}

export function BacklogFlowReview({
	flow,
	controller,
	projectId,
	organizationId,
	hasPMTool,
	pmToolName,
	pmConfig,
	ensureBacklogConversationId,
	liveMessagesRef,
	onChangesApplied,
	settingsRef,
}: Props) {
	const queryClient = useQueryClient();
	const applyProgressMsg = flow.apply?.progress ?? "";
	const applyingProposalId =
		flow.phase === "applying" ? flow.apply?.proposalId : undefined;
	const applyResult = flow.apply?.result ?? null;
	const setApplyProgressMsg = (progress: string) =>
		controller.patchApply(flow.flowId, { progress });
	const setApplyResult = (result: NonNullable<typeof applyResult>) =>
		controller.patchApply(flow.flowId, { result });
	const invalidateFailedCount = () =>
		queryClient.invalidateQueries({
			queryKey: [
				"projects.backlog.proposals.failedCount",
				projectId,
				organizationId ?? null,
			],
		});
	const finishCancelledApply = () => {
		if (controller.finishCancelledApply(flow.flowId)) {
			(settingsRef?.current.onChangesApplied ?? onChangesApplied)();
			void invalidateFailedCount();
		}
	};
	const cancelApply = async (proposalId: string) => {
		try {
			const result = await orpcClient.projects.backlog.proposals.cancel({
				projectId,
				organizationId,
				proposalId,
			});
			if (result.cancelled) {
				finishCancelledApply();
			}
		} catch (error) {
			console.warn("[BacklogChat] Cancel apply failed", error);
		}
	};
	const storedProposal = flow.proposal;
	if (!storedProposal) {
		return null;
	}
	const { changes, summary, contextSummary, visionSuggestions } =
		storedProposal;
	const decisionConflicts =
		flow.decisionConflicts ?? storedProposal.decisionConflicts ?? null;
	const decisionPrecheckPending = flow.decisionPrecheckPending ?? false;
	return (
		<>
			{(flow.phase === "reviewing" || flow.phase === "apply-failed") &&
			flow.apply?.error ? (
				<div
					role="alert"
					className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
				>
					{flow.apply.error}
				</div>
			) : null}
			<BacklogChangeProposal
				panel="ai-update"
				approval={{
					state:
						flow.phase === "reviewing" ? "reviewing" : "approved",
					count: flow.apply?.approvedCount ?? 0,
				}}
				summary={summary}
				contextSummary={contextSummary}
				changes={changes}
				decisionConflicts={decisionConflicts}
				decisionPrecheckPending={decisionPrecheckPending}
				visionSuggestions={visionSuggestions}
				hasPMTool={hasPMTool}
				pmToolName={pmToolName}
				projectId={projectId}
				organizationId={organizationId ?? null}
				applyProgressMsg={applyProgressMsg}
				onCancelApply={
					applyingProposalId
						? () => cancelApply(applyingProposalId)
						: undefined
				}
				applyResult={applyResult}
				onApprove={async (
					approvedChanges,
					syncToPM,
					pmSyncOverrides,
					approvedChangeIndexes,
				) => {
					const current = settingsRef?.current;
					const selectedPmConfig = structuredClone(
						current ? current.pmConfig : pmConfig,
					);
					const shouldSync =
						syncToPM &&
						(current?.hasPMTool ?? hasPMTool) &&
						!!selectedPmConfig;
					const approvedSnapshot = structuredClone(approvedChanges);
					const indexesSnapshot = structuredClone(
						approvedChangeIndexes,
					);
					const offeredSnapshot = changes.map(
						(change: ChangeItem) => ({
							action: change.action,
							type: change.type,
							title: change.title.to,
						}),
					);
					const overridesSnapshot = structuredClone(pmSyncOverrides);
					const messagesSnapshot = snapshotBacklogMessages(
						liveMessagesRef.current,
					);
					let request:
						| Promise<
								Parameters<
									typeof orpcClient.projects.backlog.applyChanges
								>[0]
						  >
						| undefined;
					return controller.applyProposal(
						flow.flowId,
						storedProposal,
						approvedChanges.length,
						async (operationKey) => {
							request ??= (async () => {
								// Reuse (or lazy-create) the
								// same `AgentConversation` the analyze step
								// used. The apply phase's Step 6 lands in the
								// same thread as the analyze phase's Step 6,
								// so the user sees a chronological pair of
								// system messages tied to the same session.
								//
								// Code-reviewer #4 fix: identical
								// defensive shape to the analyze handler —
								// a `create` failure must not block the
								// apply workflow itself; Step 6 simply
								// short-circuits.
								let conversationId: string | undefined;
								try {
									conversationId = await (
										settingsRef?.current
											.ensureBacklogConversationId ??
										ensureBacklogConversationId
									)();
								} catch (createError) {
									console.warn(
										"[BacklogChat] Failed to create backlog conversation; system message will be skipped for this apply run.",
										createError,
									);
								}
								return {
									projectId,
									organizationId: organizationId ?? null,
									approvedChanges: approvedSnapshot,
									approvedChangeIndexes: indexesSnapshot,
									offeredChanges: offeredSnapshot,
									operationKey,
									syncToPM: shouldSync,
									pmConfig: shouldSync
										? selectedPmConfig
										: undefined,
									pmSyncOverrides: overridesSnapshot,
									conversationId,
									messages: messagesSnapshot,
									// The decision pre-check is NOT relayed for the
									// override log — the server re-runs the judge at
									// apply time so the WORM ledger can't be
									// suppressed by client input (card #1365). The
									// inline note the user sees still comes from the
									// poll above.
								};
							})();
							const frozenRequest = await beforeDeadline(
								request,
								Date.now() + 300000,
								"Apply preparation timed out. Retry apply.",
							);
							if (!controller.canApply(flow.flowId)) {
								return;
							}
							const result = await beforeDeadline(
								orpcClient.projects.backlog.applyChanges(
									frozenRequest,
								),
								Date.now() + 300000,
								"Apply request timed out. Retry apply.",
							);

							if (!result.workflowId) {
								setApplyResult({
									status: "success",
									createdCount: 0,
									updatedCount: 0,
									failedCount: 0,
									batchTotal: approvedSnapshot.length,
									syncedToPM: false,
									items: [],
									message: "No changes to apply.",
								});
								return;
							}

							// Workflow dispatched — expose the proposal id so the
							// progress banner can offer a Cancel control.
							controller.patchApply(flow.flowId, {
								workflowId: result.workflowId,
								proposalId: result.proposalId ?? undefined,
							});

							const workflowId = result.workflowId;
							let message = "Applying...";
							let nextProposalCheckAt = Date.now();
							const observation = new AbortController();
							const unsubscribe = controller.subscribe(() => {
								if (!controller.canObserveApply(flow.flowId)) {
									observation.abort();
								}
							});
							try {
								for await (const {
									progress,
									slow,
								} of pollWorkflowProgress(
									() => {
										const checkProposal =
											Date.now() >= nextProposalCheckAt;
										if (checkProposal) {
											nextProposalCheckAt =
												Date.now() +
												APPLY_PROPOSAL_CHECK_INTERVAL_MS;
										}
										return readApplyProgress(
											{
												projectId,
												organizationId,
												workflowId,
												proposalId: result.proposalId,
											},
											checkProposal,
										);
									},
									(slow) =>
										setApplyProgressMsg(
											workflowPollMessage(
												message,
												slow,
												"apply",
											),
										),
									() =>
										controller.canObserveApply(flow.flowId),
									false,
									observation.signal,
								)) {
									message = progress.message ?? "Applying...";
									setApplyProgressMsg(
										workflowPollMessage(
											message,
											slow,
											"apply",
										),
									);

									if (progress.status === "cancelled") {
										finishCancelledApply();
										return;
									}

									if (progress.status === "completed") {
										const created =
											progress.createdItems ?? [];
										const updated =
											progress.updatedItems ?? [];
										const appliedTotal =
											created.length + updated.length;
										const progressErrors =
											(
												progress as {
													errors?: string[];
												}
											).errors ?? [];
										const skipped =
											(
												progress as {
													skippedItems?: Array<{
														type: string;
														title: string;
														identifier: string;
														reason: string;
													}>;
												}
											).skippedItems ?? [];
										const failed =
											(
												progress as {
													failedItems?: Array<{
														type: string;
														title: string;
														reason: string;
													}>;
												}
											).failedItems ?? [];
										// Skipping creates that already existed is
										// not a failure; a non-apply with at least one
										// hard failure counts as "nothing applied".
										const nothingApplied =
											appliedTotal === 0 &&
											failed.length > 0;

										if (!nothingApplied) {
											(
												settingsRef?.current
													.onChangesApplied ??
												onChangesApplied
											)();
										}

										const allItems = [
											...created.map(
												(
													i: Record<string, unknown>,
												) => ({
													...i,
													_action: "created",
												}),
											),
											...updated.map(
												(
													i: Record<string, unknown>,
												) => ({
													...i,
													_action: "updated",
												}),
											),
											...skipped.map((sk) => ({
												type: sk.type,
												identifier: sk.identifier,
												title: sk.title,
												_action: "skipped",
												reason: sk.reason,
											})),
											...failed.map((fl) => ({
												type: fl.type,
												identifier: "",
												title: fl.title,
												_action: "failed",
												reason: fl.reason,
											})),
										];

										const batchTotal =
											approvedSnapshot.length;
										const failedCount = failed.length;
										const skippedCount = skipped.length;
										const partialFailure =
											!nothingApplied && failedCount > 0;
										const allSkipped =
											appliedTotal === 0 &&
											failedCount === 0 &&
											skippedCount > 0;
										setApplyResult({
											status: nothingApplied
												? "failed"
												: "success",
											createdCount: created.length,
											updatedCount: updated.length,
											failedCount,
											skippedCount,
											batchTotal,
											syncedToPM: shouldSync,
											items: allItems,
											message: nothingApplied
												? progressErrors.length > 0
													? progressErrors.join("; ")
													: "No items were applied — they may not have been found in the backlog"
												: allSkipped
													? `All ${skippedCount} item(s) already existed in the backlog — nothing new to add`
													: partialFailure
														? `${appliedTotal} of ${batchTotal} added to roadmap${skippedCount > 0 ? `, ${skippedCount} skipped` : ""} — ${failedCount} failed, open Review proposals to retry`
														: skippedCount > 0
															? `${appliedTotal} item(s) applied, ${skippedCount} skipped (already existed)`
															: `${appliedTotal} item(s) applied`,
											pmSyncOutage:
												(
													progress as {
														pmSyncOutage?: {
															tool: string;
															errorClass: string;
															count: number;
															items: Array<{
																id: string;
																itemType:
																	| "epic"
																	| "feature"
																	| "story"
																	| "bug";
															}>;
														};
													}
												).pmSyncOutage ?? undefined,
										});

										// Failed-count refetch so any failed-count
										// consumer picks up the just-stamped
										// FAILED row (per-item errors land on the
										// up-front PendingBacklogProposal row
										// written by the apply procedure; it
										// shows in the Review proposals inbox's
										// Failed group).
										queryClient.invalidateQueries({
											queryKey: [
												"projects.backlog.proposals.failedCount",
												projectId,
												organizationId ?? null,
											],
										});

										return;
									}
									if (progress.status === "failed") {
										(
											settingsRef?.current
												.onChangesApplied ??
											onChangesApplied
										)();
										setApplyResult({
											status: "failed",
											createdCount: 0,
											updatedCount: 0,
											failedCount:
												approvedSnapshot.length,
											batchTotal: approvedSnapshot.length,
											syncedToPM: false,
											items: [],
											message:
												progress.message ??
												"Unknown error",
										});

										// Workflow-level failure also needs to
										// refetch the banner count — the apply
										// procedure wrote the proposal row
										// up-front and the workflow's terminal
										// branch will stamp it FAILED.
										queryClient.invalidateQueries({
											queryKey: [
												"projects.backlog.proposals.failedCount",
												projectId,
												organizationId ?? null,
											],
										});
										return;
									}
								}
								if (!controller.canObserveApply(flow.flowId)) {
									return;
								}
								setApplyProgressMsg("");
								setApplyResult({
									status: "unconfirmed",
									createdCount: 0,
									updatedCount: 0,
									failedCount: 0,
									batchTotal: approvedSnapshot.length,
									syncedToPM: false,
									items: [],
									message:
										"Lost track of this apply. It may still be running. If it finished, the new items are on the roadmap; anything that failed appears in Review proposals.",
								});
								(
									settingsRef?.current.onChangesApplied ??
									onChangesApplied
								)();
								void invalidateFailedCount();
							} finally {
								unsubscribe();
							}
						},
					);
				}}
				onReject={() => {
					controller.decide(flow.flowId, storedProposal, "rejected");
				}}
			/>
		</>
	);
}
