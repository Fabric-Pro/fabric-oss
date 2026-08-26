/**
 * RCA→BUG: turn a red automated-test result into a tracked BUG.
 *
 * Called after a pipeline sync ingests new runs, with the ids of every case the
 * sync touched. It re-reads each case's CURRENT denormalized result (never the
 * per-run verdict — a case that failed in an old run but passed in a newer one
 * must not be flagged), and for those still FAILED opens one `PIPELINE_FAILURE`
 * BUG unless an OPEN one already exists for that case (dedup on
 * `originTestCaseId` + non-terminal state). Gated per-project upstream by
 * `Project.autoCreateBugsFromFailures`, so this only runs when a project opted in.
 */

import { TERMINAL_DRAFTING_STAGES } from "../../../utils";
import { db } from "../../client";
import { createStory } from "./stories";

/**
 * How much of CI's failure output to carry into the bug body. Long enough for an
 * assertion plus a few stack frames — which is where the cause almost always is
 * — and short enough that a runner dumping a whole log file cannot bury the rest
 * of the bug. The full text stays on the run for anyone who needs it.
 */
export const FAILURE_MESSAGE_LIMIT = 1500;

function truncate(text: string, limit: number): string {
	const trimmed = text.trim();
	return trimmed.length <= limit
		? trimmed
		: `${trimmed.slice(0, limit)}\n… truncated; see the full output in the run.`;
}

/**
 * Pull the failing test's `failureMessage` for one case out of a run's
 * denormalized `results` JSON.
 *
 * It is JSON rather than a typed column, so this validates the shape it needs
 * instead of trusting it: a malformed or legacy row yields null (no failure text
 * in the body) rather than throwing and costing the whole RCA pass its bug.
 */
function findFailureMessage(
	results: unknown,
	testCaseId: string,
): string | null {
	if (!Array.isArray(results)) {
		return null;
	}
	for (const record of results) {
		if (
			record &&
			typeof record === "object" &&
			(record as { matchedCaseId?: unknown }).matchedCaseId ===
				testCaseId &&
			(record as { status?: unknown }).status === "FAILED"
		) {
			const message = (record as { failureMessage?: unknown })
				.failureMessage;
			return typeof message === "string" && message.trim().length > 0
				? message
				: null;
		}
	}
	return null;
}

export interface OpenBugsForFailedCasesInput {
	projectId: string;
	/** The user the sync is attributed to (the "Sync now" clicker) — the bug's creator. */
	createdById: string;
	/** Ids of the cases the sync touched (from the ingest result). */
	testCaseIds: string[];
}

/**
 * Open a BUG for each currently-FAILED case among `testCaseIds` that has no open
 * pipeline-failure bug yet. Returns the number of bugs opened. Idempotent per
 * case via the `originTestCaseId` dedup; concurrent syncs for one project are
 * serialized by the sync workflow's project-scoped id, so the non-unique index
 * is sufficient here.
 */
export async function openBugsForFailedCases(
	input: OpenBugsForFailedCasesInput,
): Promise<number> {
	if (input.testCaseIds.length === 0) {
		return 0;
	}

	// Only cases still FAILED right now get a bug (re-read, not per-run verdict).
	const failed = await db.testCase.findMany({
		where: {
			id: { in: input.testCaseIds },
			projectId: input.projectId,
			deletedAt: null,
			currentResult: "FAILED",
		},
		select: {
			id: true,
			identifier: true,
			title: true,
			lastRunByLabel: true,
		},
	});
	if (failed.length === 0) {
		return 0;
	}

	const failedIds = failed.map((c) => c.id);

	// Dedup: which of these already have an OPEN pipeline-failure bug?
	const existing = await db.userStory.findMany({
		where: {
			projectId: input.projectId,
			kind: "BUG",
			source: "PIPELINE_FAILURE",
			originTestCaseId: { in: failedIds },
			draftingStage: { notIn: TERMINAL_DRAFTING_STAGES },
			pmAutoHidden: false,
		},
		select: { originTestCaseId: true },
	});
	const alreadyOpen = new Set(
		existing
			.map((e) => e.originTestCaseId)
			.filter((id): id is string => id != null),
	);

	// Latest FAILED event per case → the failing test, run link, and the run it
	// came from (which carries the assertion text).
	//
	// One `findFirst` per case, batched into a single round trip, rather than one
	// `findMany` over every FAILED event these cases ever produced followed by a
	// dedupe in Node. The old shape read the case's ENTIRE failure history to use
	// one row of it, so its cost grew with how long a test had been flaky — the
	// worst possible scaling for the exact projects this feature is for. A `take`
	// would have been the cheaper edit and the wrong one: it caps the scan
	// without capping the waste, and it can drop a case whose latest failure sits
	// behind a noisier neighbour's history.
	const latestEvents = await db.$transaction(
		failedIds.map((testCaseId) =>
			db.testResultEvent.findFirst({
				where: { testCaseId, result: "FAILED" },
				orderBy: { occurredAt: "desc" },
				select: {
					testCaseId: true,
					note: true,
					externalRunUrl: true,
					actorLabel: true,
					pipelineRunId: true,
				},
			}),
		),
	);
	const latestEventByCase = new Map<
		string,
		NonNullable<(typeof latestEvents)[number]>
	>();
	for (const e of latestEvents) {
		if (e) {
			latestEventByCase.set(e.testCaseId, e);
		}
	}

	// The runs those events came from. `failureMessage` — the actual assertion
	// text CI reported — lives only in the run's denormalized `results` JSON, so
	// a bug body without it made the reader open the provider to learn ANYTHING
	// about why the test failed. Branch and commit come along because "which
	// commit broke it" is the next question after "what broke".
	const runIds = [
		...new Set(
			[...latestEventByCase.values()]
				.map((e) => e.pipelineRunId)
				.filter((id): id is string => id != null),
		),
	];
	const runs = runIds.length
		? await db.testPipelineRun.findMany({
				where: { id: { in: runIds }, projectId: input.projectId },
				select: {
					id: true,
					results: true,
					branch: true,
					commitSha: true,
					pipelineName: true,
				},
			})
		: [];
	const runById = new Map(runs.map((r) => [r.id, r]));

	let opened = 0;
	for (const c of failed) {
		if (alreadyOpen.has(c.id)) {
			continue;
		}
		const evt = latestEventByCase.get(c.id);
		const runLabel =
			evt?.actorLabel ?? c.lastRunByLabel ?? "a CI pipeline run";
		const run = evt?.pipelineRunId
			? runById.get(evt.pipelineRunId)
			: undefined;
		const failureMessage = findFailureMessage(run?.results, c.id);

		const lines = [
			`The automated test linked to ${c.identifier} — “${c.title}” — is failing in ${runLabel}.`,
			"",
			evt?.note ? `Failing test: ${evt.note}` : null,
			run?.branch ? `Branch: ${run.branch}` : null,
			run?.commitSha ? `Commit: ${run.commitSha.slice(0, 8)}` : null,
			evt?.externalRunUrl ? `Run: ${evt.externalRunUrl}` : null,
			// The assertion CI actually printed. Fenced so a stack trace keeps its
			// formatting instead of being re-wrapped into soup by the markdown
			// renderer, and truncated because some runners emit whole log files.
			failureMessage
				? `\nWhat CI reported:\n\n\`\`\`\n${truncate(failureMessage, FAILURE_MESSAGE_LIMIT)}\n\`\`\``
				: null,
			"",
			// No internal ticket reference here: this text is persisted into the
			// CUSTOMER's own roadmap, where a Fabric card number means nothing.
			"Opened automatically from a pipeline result. It will not be re-opened while this bug stays open; close it once the test is green.",
		].filter((l): l is string => l !== null);

		try {
			await createStory({
				projectId: input.projectId,
				createdById: input.createdById,
				kind: "BUG",
				source: "PIPELINE_FAILURE",
				originTestCaseId: c.id,
				title: `Automated test failing: ${c.title}`,
				description: lines.join("\n"),
				priority: "P2_MEDIUM",
			});
			opened++;
		} catch (err) {
			// One case failing to open a bug must not fail the whole RCA pass (the
			// sync's cursor advance is gated on RCA — a throw here would wedge it).
			// Log and continue; the case stays FAILED and is retried on the next run.
			console.warn("[pipeline-rca] failed to open bug for failing case", {
				testCaseId: c.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return opened;
}
