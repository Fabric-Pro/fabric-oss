/**
 * The merge-triggered repository sync of a classified branch (Fizzy #2738
 * spec §6.6 "Merge sync", #2563 §9.1): the dispatch of the sync run, its
 * receipt, and the give-up when the destination no longer matches.
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */
import {
	clearBranchMergeSyncRequest,
	findMergeTriggeredRun,
	getInstructionRepositorySyncForProposal,
	getProjectInstructionSettings,
	getProposalBranch,
	getSyncRunReceiptByRunId,
	instructionRepositoryImportAllowed,
	type MergeSyncTuple,
	markBranchMergeSyncDispatched,
	parseBranchDestination,
	recordBranchMergeSyncRun,
	transitionBranch,
} from "@repo/database";
import { instructionRepositorySyncWorkflowId } from "@repo/instructions/workflow-ids";
import { getTemporalClient } from "../../client";
import {
	asJson,
	assertMayContinue,
	cancellationOf,
	failureJson,
	ProposalStepFailure,
} from "./instruction-proposal-boundary";
import {
	branchMergeSyncTarget,
	classifyMergeSyncReceipt,
	mergeSyncBackoffMs,
	mergeSyncDispatchesBefore,
} from "./instruction-proposal-merge-sync";
import { startAutomaticInstructionSync } from "./instruction-sync-start";

// ---------------------------------------------------------------------------
// Merge sync (spec §6.6 "Merge sync", #2563 §9.1)
// ---------------------------------------------------------------------------

function mergeSyncTupleOf(value: unknown): MergeSyncTuple | null {
	const v = value as { syncId?: unknown; generation?: unknown } | null;
	return typeof v?.syncId === "string" && typeof v.generation === "number"
		? { syncId: v.syncId, generation: v.generation }
		: null;
}

/** Temporal client calls under the attempt's signal (as #2563's dispatcher). */
async function withClientSignal<T>(
	signal: AbortSignal,
	fn: (client: Awaited<ReturnType<typeof getTemporalClient>>) => Promise<T>,
): Promise<T> {
	assertMayContinue(signal);
	const client = await getTemporalClient();
	return client.withAbortSignal(signal, () => fn(client));
}

/** Whether the sync workflow's run `runId` is still running; unknown counts as running. */
async function syncRunRunning(
	projectId: string,
	runId: string,
	signal: AbortSignal,
): Promise<boolean> {
	try {
		const description = await withClientSignal(signal, (client) =>
			client.workflow
				.getHandle(
					instructionRepositorySyncWorkflowId(projectId),
					runId,
				)
				.describe(),
		);
		return description.status.name === "RUNNING";
	} catch (error) {
		const stopped = cancellationOf(error);
		if (stopped) {
			throw stopped;
		}
		return !(
			error instanceof Error && error.name === "WorkflowNotFoundError"
		);
	}
}

export type BranchMergeSyncResult =
	| "idle"
	| "waiting"
	| "acknowledged"
	| "dispatched"
	| "failed"
	| "gave_up"
	| "moved";

/**
 * `dispatchBranchMergeSync`: #2563 §9.1 steps 1-5 once per MERGED branch
 * with a merge-sync request (set by classification unless `targetMismatch`):
 * give up after 24 h or when the destination changed; adopt the run it
 * dispatched (by run id, else the newest merge-triggered run for the tuple);
 * acknowledge a consuming receipt, wait on one in flight, and re-dispatch
 * on a retaining receipt or none with the 5, 15, then 60 minute backoff.
 */
export async function runBranchMergeSync(i: {
	branchId: string;
	organizationId: string;
	signal: AbortSignal;
}): Promise<BranchMergeSyncResult> {
	const branch = await getProposalBranch(i);
	const requestedAt = branch?.mergeSyncRequestedAt ?? null;
	if (
		!branch ||
		branch.untracked ||
		requestedAt === null ||
		branch.state !== "MERGED"
	) {
		return "idle";
	}
	const ids = { branchId: branch.id, organizationId: branch.organizationId };
	const expected = mergeSyncTupleOf(branch.mergeSyncExpected);
	const giveUp = async (
		code: "CONFIGURATION_CHANGED" | "MERGE_SYNC_FAILED",
	): Promise<BranchMergeSyncResult> => {
		const cleared = await clearBranchMergeSyncRequest({
			kind: "gave_up",
			...ids,
			expected,
			failure: {
				phase: "merge_sync",
				code,
				retryable: false,
				at: branch.databaseNow.toISOString(),
				params: {},
			},
		});
		return cleared ? "gave_up" : "moved";
	};
	const elapsed = branch.databaseNow.getTime() - requestedAt.getTime();
	const [sync, settings] = await Promise.all([
		getInstructionRepositorySyncForProposal(
			branch.projectId,
			branch.organizationId,
		),
		getProjectInstructionSettings(branch.projectId, branch.organizationId),
	]);
	const target = branchMergeSyncTarget({
		elapsedMs: elapsed,
		destination: parseBranchDestination(branch.destination),
		sync: sync
			? {
					id: sync.id,
					generation: sync.generation,
					repositoryIntegrationId: sync.repositoryIntegrationId,
					ref: sync.ref,
					rootPath: sync.rootPath,
				}
			: null,
		sourceOfTruth: settings.sourceOfTruth,
	});
	if (target.kind === "give_up") {
		return giveUp(target.code);
	}
	const current = target.tuple;

	// Step 2: adopt what was dispatched.
	if (branch.mergeSyncDispatchedAt && expected) {
		const receipt = branch.mergeSyncRunId
			? await getSyncRunReceiptByRunId({
					projectId: branch.projectId,
					organizationId: branch.organizationId,
					runId: branch.mergeSyncRunId,
				})
			: await findMergeTriggeredRun({
					projectId: branch.projectId,
					organizationId: branch.organizationId,
					syncId: expected.syncId,
					generation: expected.generation,
					startedAtOrAfter: requestedAt,
				});
		if (receipt) {
			const verdict = classifyMergeSyncReceipt(receipt, {
				projectId: branch.projectId,
				syncId: expected.syncId,
				generation: expected.generation,
				requestedAt,
			});
			if (verdict === "wait") {
				return "waiting";
			}
			if (verdict === "consuming") {
				const acknowledged = await clearBranchMergeSyncRequest({
					kind: "acknowledged",
					...ids,
					expected: {
						syncId: receipt.syncId,
						generation: receipt.generation,
					},
					audit: {
						action: "project.instructions.pull_request_merge_sync_requested",
						category: "project",
						actor: { type: "system" },
						organizationId: branch.organizationId,
						projectId: branch.projectId,
						resource: {
							type: "project_instruction_proposal_branch",
							id: branch.id,
							name: `#${branch.number}`,
						},
						metadata: {
							branchId: branch.id,
							syncRunKey: receipt.id,
						},
					},
				});
				return acknowledged ? "acknowledged" : "moved";
			}
		} else if (
			branch.mergeSyncRunId &&
			(await syncRunRunning(
				branch.projectId,
				branch.mergeSyncRunId,
				i.signal,
			))
		) {
			return "waiting"; // started, no receipt yet
		}
	}

	// Step 3: dispatch, after one conditional write.
	if (!instructionRepositoryImportAllowed(settings, current.syncId)) {
		const acknowledged = await clearBranchMergeSyncRequest({
			kind: "direct_read",
			...ids,
			expected,
			audit: {
				action: "project.instructions.pull_request_merge_observed",
				category: "project",
				actor: { type: "system" },
				organizationId: branch.organizationId,
				projectId: branch.projectId,
				resource: {
					type: "project_instruction_proposal_branch",
					id: branch.id,
					name: `#${branch.number}`,
				},
				metadata: { branchId: branch.id, readState: "DIRECT" },
			},
		});
		return acknowledged ? "acknowledged" : "moved";
	}
	const backoff = mergeSyncBackoffMs(mergeSyncDispatchesBefore(elapsed));
	const nextAttempt = new Date(branch.databaseNow.getTime() + backoff);
	assertMayContinue(i.signal);
	const marked = await markBranchMergeSyncDispatched({
		...ids,
		lastExpected: expected,
		next: current,
		dispatchedAt: branch.databaseNow,
		nextAttemptAt: nextAttempt,
	});
	if (!marked) {
		return "moved";
	}
	let runId: string;
	try {
		({ runId } = await withClientSignal(i.signal, () =>
			startAutomaticInstructionSync({
				projectId: branch.projectId,
				organizationId: branch.organizationId,
				trigger: "PULL_REQUEST_MERGED",
				expected: current,
			}),
		));
	} catch (error) {
		const cancelled = cancellationOf(error);
		if (cancelled) {
			throw cancelled;
		}
		// The outcome is unknown: the dispatch mark stays, so the next tick
		// adopts a run the server did start before starting another.
		const failed = new ProposalStepFailure({
			code: "SYNC_START_FAILED",
			phase: "merge_sync",
			retryable: true,
		});
		await transitionBranch({
			...ids,
			from: ["MERGED"],
			expectedAttempt: branch.attempt,
			to: "unchanged",
			bumpAttempt: false,
			data: {
				failure: asJson(failureJson(failed)),
				nextAttemptAt: nextAttempt,
			},
		});
		return "failed";
	}
	await recordBranchMergeSyncRun({ ...ids, expected: current, runId });
	return "dispatched";
}
