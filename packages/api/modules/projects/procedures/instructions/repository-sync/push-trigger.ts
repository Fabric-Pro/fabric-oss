/**
 * The GitHub push webhook's automatic-sync hook (spec §6.2).
 *
 * `handleGitHubPushWebhook` calls this after the repository resolved to an
 * integration and before its code-indexing branch check. For every
 * repository-sync subject kind (Decision 46), the subject's
 * `findByRepository` returns each sync that follows the pushed branch on an
 * ACTIVE integration of the pushed repository, keeping only rows whose
 * integration belongs to the row's own project and organization
 * (Review Focus 1). Tenant context comes ONLY from those rows. Each eligible
 * row gets a WEBHOOK run through its subject's `startRun` (one workflow id
 * per project, FAIL on conflict), carrying the request's correlation memo,
 * so a burst of pushes costs one run per project at a time.
 *
 * Honest limit: the signature proves only possession of the deployment-wide
 * `GITHUB_WEBHOOK_SECRET`. A holder can trigger a sync of any project whose
 * repository URL they know. The run acts as the row's delegate and reads
 * only the configured repository and branch, so no data crosses tenants.
 * `after` is only a skip hint: a forged value either skips (the poll still
 * checks the real head, normally 15 to 20 minutes after the push; longer
 * while it works through a backlog or the sync is backing off after
 * failures), starts a run that reads the real head, or, while a run is open,
 * costs one early poll check that reads the real head.
 *
 * A push that finds the project's run already open (`already_running`) may
 * have landed after that run read the branch, and the run's completion
 * would schedule the next check 15 minutes out. So when the push names a
 * valid head, the hook leaves a re-check request on the row through the
 * subject's `recordPendingHead`, which that completion turns into "due now"
 * (Fizzy #2682). The hook never writes `nextCheckAt` itself: the completion
 * would overwrite it, and it would end a poll check's lease.
 *
 * `already_running` proves only that the workflow has not closed: its
 * completion may already have committed, and would then never read a marker
 * written after it. So the hook settles the marker against the open run's
 * receipt under the sync-row lock (`settlePendingHead`, with the run id the
 * answer carried): an unfinished receipt means that completion is still to
 * come and will consume it; a finished one means it is applied on the spot.
 *
 * Bounded (Decision 36): each subject's lookup and each row's start runs in
 * its own try/catch under `Promise.allSettled`, so one failure or one slow
 * start never stops another, and the hook returns after
 * `WEBHOOK_SYNC_START_BUDGET_MS` even when a start still hangs. A start
 * still in flight then finishes on its own; one that never happened is
 * picked up by the poll. The start input is exactly
 * `{ projectId, organizationId, trigger, expected }`: the sync workflow adds
 * its own run id to `begin` and `record` (Decision 44), and `begin` refuses
 * the run when the row has moved since this lookup found it (Decision 56).
 */
import { db, type RepositorySyncPushRow } from "@repo/database";
import { shouldStartAutomaticSync } from "@repo/instructions";
import { logger } from "@repo/logs";
import {
	REPOSITORY_SYNC_SUBJECT_KINDS,
	type RepositorySyncSubject,
	repositorySyncSubject,
} from "@repo/temporal/repository-sync-subjects";
import { withCorrelationMemo } from "../../../../../lib/temporal-correlation";

/** The most the hook adds to a push webhook's response time (Decision 36). */
export const WEBHOOK_SYNC_START_BUDGET_MS = 5_000;

const BRANCH_REF_PREFIX = "refs/heads/";
/** GitHub's `after` for a deleted branch. The poll reports the missing branch. */
const DELETED_BRANCH_SHA = /^0+$/;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function errorClass(error: unknown): string {
	return error instanceof Error ? error.name : typeof error;
}

export async function startInstructionSyncsForPush(push: {
	repositoryUrl: string;
	ref: string | undefined;
	after: string | undefined;
}): Promise<{ started: number; failed: number; deferred: number }> {
	const outcome = { started: 0, failed: 0, deferred: 0 };
	if (!push.ref?.startsWith(BRANCH_REF_PREFIX)) {
		return outcome;
	}
	if (push.after !== undefined && DELETED_BRANCH_SHA.test(push.after)) {
		return outcome;
	}
	const pushedBranch = push.ref.slice(BRANCH_REF_PREFIX.length);
	const headSha =
		push.after !== undefined && OBJECT_ID.test(push.after)
			? push.after
			: undefined;

	// Lookups and starts not yet settled: one lookup per subject kind, then
	// one start per row a lookup returned.
	let unsettled = REPOSITORY_SYNC_SUBJECT_KINDS.length;
	const startFor = async (
		subject: RepositorySyncSubject,
		row: RepositorySyncPushRow,
	): Promise<void> => {
		let stage: "start" | "record_pending" | "settle_pending" = "start";
		try {
			if (!shouldStartAutomaticSync(row, headSha).start) {
				return;
			}
			const started = await subject.startRun(row, "WEBHOOK", {
				expected: { syncId: row.id, generation: row.generation },
				decorate: withCorrelationMemo,
			});
			if (started.outcome === "started") {
				outcome.started++;
				return;
			}
			// The open run's completion re-checks the branch (Fizzy #2682).
			// Without a valid head the push has nothing to record, and the poll
			// stays the fallback.
			if (headSha === undefined) {
				return;
			}
			stage = "record_pending";
			const { applied } = await subject.recordPendingHead(
				db,
				row,
				headSha,
			);
			// Not applied: the row was re-configured (which made it due now)
			// or removed since the lookup. There is no marker to settle.
			if (!applied) {
				return;
			}
			// The open run's completion may already have committed; its
			// receipt, read under the row lock, says whether it is still to
			// come or the marker must be applied now.
			stage = "settle_pending";
			const { settled } = await subject.settlePendingHead(
				db,
				row,
				started.runId,
			);
			if (settled === "stale") {
				return;
			}
			outcome.deferred++;
			logger.info(
				{
					event: "instructions.sync.webhook_deferred",
					kind: subject.kind,
					projectId: row.projectId,
					syncId: row.id,
					settled,
				},
				"[RepositorySync] a GitHub push reached an open sync run; the branch will be re-checked when it finishes",
			);
		} catch (error) {
			outcome.failed++;
			logger.warn(
				{
					event: "instructions.sync.webhook_start_failed",
					kind: subject.kind,
					projectId: row.projectId,
					stage,
					errorClass: errorClass(error),
				},
				"[RepositorySync] could not start a sync for a GitHub push",
			);
		} finally {
			unsettled--;
		}
	};
	const forKind = async (
		kind: (typeof REPOSITORY_SYNC_SUBJECT_KINDS)[number],
	): Promise<void> => {
		const subject = repositorySyncSubject(kind);
		let rows: RepositorySyncPushRow[];
		try {
			rows = await subject.findByRepository({
				repositoryUrl: push.repositoryUrl,
				ref: pushedBranch,
			});
		} catch (error) {
			unsettled--;
			outcome.failed++;
			logger.warn(
				{
					event: "instructions.sync.webhook_lookup_failed",
					kind,
					errorClass: errorClass(error),
				},
				"[RepositorySync] could not look up the syncs a GitHub push reaches",
			);
			return;
		}
		// This lookup settled; its rows' starts are now in flight.
		unsettled += rows.length - 1;
		await Promise.allSettled(rows.map((row) => startFor(subject, row)));
	};
	const work = Promise.allSettled(REPOSITORY_SYNC_SUBJECT_KINDS.map(forKind));

	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<"expired">((resolve) => {
		timer = setTimeout(
			() => resolve("expired"),
			WEBHOOK_SYNC_START_BUDGET_MS,
		);
	});
	try {
		const first = await Promise.race([
			work.then(() => "settled" as const),
			expired,
		]);
		if (first === "expired") {
			logger.warn(
				{
					event: "instructions.sync.webhook_budget_exhausted",
					unsettled,
				},
				"[RepositorySync] a GitHub push's sync starts outlived their budget",
			);
		}
	} finally {
		clearTimeout(timer);
	}
	// A copy: a start that settles after the budget must not change what the
	// webhook already reported.
	return { ...outcome };
}
