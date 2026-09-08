/**
 * The generation queue, at the workflow body (Fizzy #2199).
 *
 * A document generation dispatched while its project is still ingesting reads
 * an empty index and writes a confident, wrong document. The fix is a wait, and
 * a wait is the kind of thing that is easy to write and easy to get subtly
 * wrong, so the properties pinned here are the ones a reader cannot check by
 * looking:
 *
 *  - it waits until EVERY category clears, not until the first one does;
 *  - it distinguishes a dependency that failed for good from one that failed an
 *    attempt and is still retrying — the second is `waiting`, and the workflow
 *    must not second-guess that verdict;
 *  - the token the child runs under is RE-MINTED after a wait, and the
 *    re-authorization that guards that mint happens BEFORE it. A wait is
 *    unbounded; the dispatch's authorization is not;
 *  - it polls with a widening, capped interval rather than a tight loop, and
 *    writes the queue reason only when the reason changes;
 *  - it ends rather than continuing as new, because a new run means a new runId
 *    and the document's status row correlates on the one it started with.
 *
 * Convention follows `document-generation-watchdog.test.ts`: mock the
 * `@temporalio/workflow` surface and drive the workflow body as a plain async
 * function. Determinism is gated separately by the replay-validation matrix.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	activityStubs,
	executeChildMock,
	startChildMock,
	sleepMock,
	workflowState,
} = vi.hoisted(() => ({
	activityStubs: {
		createAgentTask: vi.fn(),
		updateAgentTaskWorkflow: vi.fn(),
		updateAgentTaskStatus: vi.fn(),
		updateProjectWorkflowStatus: vi.fn(),
		probeGenerationDependencies: vi.fn(),
		assertRequesterMayGenerate: vi.fn(),
		issueGenerationToken: vi.fn(),
		recordGenerationQueueReason: vi.fn(),
		startGenerationRun: vi.fn(),
		failGenerationRun: vi.fn(),
		// The Job Hub row and the requester's notification.
		//
		// Stubbed rather than left out, and that is not tidiness. Every one
		// of these call sites swallows its own errors on purpose — a
		// bookkeeping write must never fail a generation — so an activity
		// missing from this object throws, gets logged, and disappears. The
		// suite stays green while asserting nothing about the writes at all,
		// which is exactly the hole the swallow creates.
		reportGenerationJobOpened: vi.fn(),
		reportGenerationJobStep: vi.fn(),
		notifyGenerationOutcome: vi.fn(),
	},
	executeChildMock: vi.fn(),
	startChildMock: vi.fn(),
	sleepMock: vi.fn(),
	/**
	 * Mutable so a test can put the run under history pressure, or replay a
	 * history recorded before the queue shipped (`patched: false`).
	 */
	workflowState: { continueAsNewSuggested: false, patched: true },
}));

vi.mock("@temporalio/workflow", () => {
	class ApplicationFailure extends Error {
		static nonRetryable(message: string, type?: string) {
			const failure = new ApplicationFailure(message);
			(failure as ApplicationFailure & { type?: string }).type = type;
			return failure;
		}
	}

	return {
		ApplicationFailure,
		executeChild: executeChildMock,
		startChild: startChildMock,
		log: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		},
		ParentClosePolicy: {
			PARENT_CLOSE_POLICY_ABANDON: "ABANDON",
		},
		patched: () => workflowState.patched,
		proxyActivities: () => activityStubs,
		sleep: sleepMock,
		workflowInfo: () => ({
			workflowId: "wf_1",
			runId: "run_1",
			continueAsNewSuggested: workflowState.continueAsNewSuggested,
		}),
	};
});

import { projectDocumentGenerationWorkflow } from "../src/workflows/project-document-generation";

const INPUT = {
	projectId: "proj_1",
	documentId: "doc_1",
	documentType: "PRD",
	userId: "user_1",
	organizationId: "org_1",
	aiToken: "dispatch-token",
	prompt: "",
	excludeContextId: "ctx_1",
	/** This attempt's identity, as the queue write returned it. */
	generationStartedAt: "2026-09-07T10:00:00.000Z",
};

const clear = () => ({ verdict: "clear", outstanding: [], failed: [] });

const waitingOn = (...categories: string[]) => ({
	verdict: "waiting",
	outstanding: categories.map((category) => ({ category, count: 1 })),
	failed: [],
});

const failedOn = (category: string) => ({
	verdict: "failed",
	outstanding: [],
	failed: [{ category, count: 1 }],
});

/** The args object the parent enumerated for the generation child. */
function childArgs(): Record<string, unknown> {
	const call = executeChildMock.mock.calls[0];
	if (!call) {
		throw new Error("executeChild was never called");
	}
	return (call[1] as { args: Record<string, unknown>[] }).args[0];
}

/** Every delay the run actually asked for, in order. */
function sleptFor(): number[] {
	return sleepMock.mock.calls.map((call) => call[0] as number);
}

/**
 * Every Job Hub step write, in order, as `step:status` — with a trailing `!`
 * when the write also closed the row.
 */
function jobSteps(): string[] {
	return activityStubs.reportGenerationJobStep.mock.calls.map((call) => {
		const write = call[0] as {
			step: string;
			status: string;
			closesJob?: boolean;
		};
		return `${write.step}:${write.status}${write.closesJob ? "!" : ""}`;
	});
}

/** The message the Job Hub row was closed with. */
function jobFailureMessage(): string | undefined {
	const last = activityStubs.reportGenerationJobStep.mock.calls.at(-1);
	return (last?.[0] as { error?: string } | undefined)?.error;
}

beforeEach(() => {
	vi.resetAllMocks();
	workflowState.continueAsNewSuggested = false;
	workflowState.patched = true;

	sleepMock.mockResolvedValue(undefined);
	startChildMock.mockResolvedValue(undefined);
	executeChildMock.mockResolvedValue({
		success: true,
		documentId: "doc_1",
		documentContent: "# Generated",
		metrics: {
			contextCount: 2,
			episodeCount: 0,
			integrationMessageCount: 0,
			teamsSearchCount: 0,
			documentLength: 11,
			wordCount: 2,
			durationMs: 1,
		},
	});

	activityStubs.createAgentTask.mockResolvedValue({ id: "task_1" });
	activityStubs.updateAgentTaskWorkflow.mockResolvedValue(undefined);
	activityStubs.updateAgentTaskStatus.mockResolvedValue(undefined);
	activityStubs.updateProjectWorkflowStatus.mockResolvedValue(undefined);

	activityStubs.probeGenerationDependencies.mockResolvedValue(clear());
	activityStubs.assertRequesterMayGenerate.mockResolvedValue(undefined);
	activityStubs.issueGenerationToken.mockResolvedValue({
		aiToken: "re-issued-token",
	});
	activityStubs.recordGenerationQueueReason.mockResolvedValue(undefined);
	activityStubs.startGenerationRun.mockResolvedValue({ outcome: "started" });
	activityStubs.failGenerationRun.mockResolvedValue(undefined);
	activityStubs.reportGenerationJobOpened.mockResolvedValue(undefined);
	activityStubs.reportGenerationJobStep.mockResolvedValue(undefined);
	activityStubs.notifyGenerationOutcome.mockResolvedValue(undefined);
});

describe("the wait itself", () => {
	it("runs the child immediately when nothing is outstanding", async () => {
		await projectDocumentGenerationWorkflow(INPUT);

		expect(activityStubs.probeGenerationDependencies).toHaveBeenCalledTimes(
			1,
		);
		expect(sleepMock).not.toHaveBeenCalled();
		expect(executeChildMock).toHaveBeenCalledTimes(1);
	});

	it("sleeps, re-probes, and then runs the child once the dependency clears", async () => {
		activityStubs.probeGenerationDependencies
			.mockResolvedValueOnce(waitingOn("sourceExtraction"))
			.mockResolvedValueOnce(clear());

		await projectDocumentGenerationWorkflow(INPUT);

		expect(activityStubs.probeGenerationDependencies).toHaveBeenCalledTimes(
			2,
		);
		expect(sleptFor()).toEqual([10_000]);
		expect(executeChildMock).toHaveBeenCalledTimes(1);
	});

	/**
	 * The property a single-category test cannot see. Two sources finishing at
	 * different times is the ordinary case — a repository indexing while files
	 * extract — and a loop that stopped at the first clear category would start
	 * generating against half a project.
	 */
	it("keeps waiting until both outstanding categories are gone", async () => {
		activityStubs.probeGenerationDependencies
			.mockResolvedValueOnce(
				waitingOn("codebaseIndexing", "sourceExtraction"),
			)
			.mockResolvedValueOnce(waitingOn("sourceExtraction"))
			.mockResolvedValueOnce(clear());

		await projectDocumentGenerationWorkflow(INPUT);

		expect(activityStubs.probeGenerationDependencies).toHaveBeenCalledTimes(
			3,
		);
		expect(sleptFor()).toEqual([10_000, 20_000]);
		expect(executeChildMock).toHaveBeenCalledTimes(1);
	});

	/**
	 * A dependency that failed ONE attempt and is still being retried comes back
	 * as `waiting`, not `failed` — that distinction lives in the query, beside
	 * the rows that carry the retry state. The workflow's job is to honour the
	 * verdict rather than re-derive it: a run refused on the strength of an
	 * error message that a retry then cleared is a document the user never gets
	 * and cannot explain.
	 */
	it("keeps waiting through an attempt that failed but is still being retried", async () => {
		activityStubs.probeGenerationDependencies
			.mockResolvedValueOnce(waitingOn("sourceExtraction"))
			.mockResolvedValueOnce(waitingOn("sourceExtraction"))
			.mockResolvedValueOnce(clear());

		await projectDocumentGenerationWorkflow(INPUT);

		expect(sleptFor()).toEqual([10_000, 20_000]);
		expect(executeChildMock).toHaveBeenCalledTimes(1);
	});

	it("refuses, naming the category, when a dependency has failed for good", async () => {
		activityStubs.probeGenerationDependencies.mockResolvedValue(
			failedOn("sourceExtraction"),
		);

		await expect(projectDocumentGenerationWorkflow(INPUT)).rejects.toThrow(
			/sourceExtraction/,
		);

		expect(executeChildMock).not.toHaveBeenCalled();
		expect(activityStubs.issueGenerationToken).not.toHaveBeenCalled();
		expect(sleepMock).not.toHaveBeenCalled();
	});

	/**
	 * `continueAsNew` would be the textbook answer and is the wrong one here: it
	 * mints a new runId, and both `updateProjectWorkflowStatus` and the
	 * stale-generation watchdog's liveness lookup correlate on the runId this
	 * execution started with. The wait ends instead, saying what it was waiting
	 * for.
	 */
	it("ends the run rather than continuing as new when history grows too long", async () => {
		workflowState.continueAsNewSuggested = true;
		activityStubs.probeGenerationDependencies.mockResolvedValue(
			waitingOn("monitorIngestion"),
		);

		await expect(projectDocumentGenerationWorkflow(INPUT)).rejects.toThrow(
			/monitorIngestion/,
		);

		expect(executeChildMock).not.toHaveBeenCalled();
		expect(sleepMock).not.toHaveBeenCalled();
	});

	/**
	 * A tight poll is the difference between a queue and a denial of service.
	 * Ten seconds catches a nearly-finished extraction almost at once; the cap
	 * keeps an hour-long codebase index down to a dozen probes.
	 */
	it("widens the poll interval and caps it", async () => {
		let outstandingProbes = 8;
		activityStubs.probeGenerationDependencies.mockImplementation(
			async () => {
				outstandingProbes -= 1;
				return outstandingProbes >= 0
					? waitingOn("codebaseIndexing")
					: clear();
			},
		);

		await projectDocumentGenerationWorkflow(INPUT);

		expect(sleptFor()).toEqual([
			10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000,
		]);
	});

	it("asks the probe about this run's tenant, and excludes this run's own rows", async () => {
		await projectDocumentGenerationWorkflow(INPUT);

		expect(activityStubs.probeGenerationDependencies).toHaveBeenCalledWith({
			projectId: "proj_1",
			// The query's fail-closed scope. Without it every probe reads
			// "nothing to wait for".
			organizationId: "org_1",
			documentType: "PRD",
			// This run's own row is already QUEUED, and the source it supplied
			// is being embedded in parallel with the dispatch. Both are the
			// reason for the wait, not something to wait on.
			excludeDocumentId: "doc_1",
			excludeContextId: "ctx_1",
			// Bounds the arms that can refuse rather than delay. Without it the
			// query falls back to a liveness window, and a source that failed
			// long before this request would refuse it.
			generationStartedAt: INPUT.generationStartedAt,
		});
	});

	it("refuses to generate once the row stopped being this attempt's", async () => {
		// The guarded flip is what AUTHORIZES the model call, and the call does
		// not re-check: the child writes the document by id with no attempt
		// guard. A run that lost ownership while it waited — swept by the
		// watchdog, replaced by a newer dispatch — would otherwise spend a model
		// call and then overwrite whatever took its place, including a person's
		// edits.
		activityStubs.probeGenerationDependencies
			.mockResolvedValueOnce(waitingOn("codebaseIndexing"))
			.mockResolvedValueOnce(clear());
		activityStubs.startGenerationRun.mockResolvedValue({
			outcome: "superseded",
		});

		await expect(projectDocumentGenerationWorkflow(INPUT)).rejects.toThrow(
			/superseded/i,
		);

		expect(executeChildMock).not.toHaveBeenCalled();
	});

	it("waits for its own queue write rather than calling itself superseded", async () => {
		// The dispatcher stamps the row QUEUED only AFTER `workflow.start`
		// returns, so a worker that picks the run up immediately reaches the
		// flip first. That reads identically to losing the row, and treating it
		// as supersession would kill a healthy run and leave its row QUEUED with
		// nothing left to advance it.
		activityStubs.startGenerationRun
			.mockResolvedValueOnce({ outcome: "not-yet-visible" })
			.mockResolvedValueOnce({ outcome: "not-yet-visible" })
			.mockResolvedValue({ outcome: "started" });

		await projectDocumentGenerationWorkflow(INPUT);

		expect(activityStubs.startGenerationRun).toHaveBeenCalledTimes(3);
		expect(executeChildMock).toHaveBeenCalledTimes(1);
	});

	it("gives up when its queue write never lands at all", async () => {
		// The other half of the same argument. A dispatcher that died between
		// starting this run and marking its row leaves no row naming this
		// attempt, and none is coming — so nobody owns the document, and nobody
		// may overwrite it.
		activityStubs.startGenerationRun.mockResolvedValue({
			outcome: "not-yet-visible",
		});

		await expect(projectDocumentGenerationWorkflow(INPUT)).rejects.toThrow(
			/superseded/i,
		);

		expect(executeChildMock).not.toHaveBeenCalled();
	});

	it("skips the probe entirely when the caller opts out", async () => {
		await projectDocumentGenerationWorkflow({
			...INPUT,
			skipDependencyWait: true,
		});

		expect(
			activityStubs.probeGenerationDependencies,
		).not.toHaveBeenCalled();
		expect(sleepMock).not.toHaveBeenCalled();
		expect(executeChildMock).toHaveBeenCalledTimes(1);
	});
});

describe("what the document tells its reader while it waits", () => {
	it("writes the queue reason when the category changes, and not on every poll", async () => {
		activityStubs.probeGenerationDependencies
			.mockResolvedValueOnce(waitingOn("sourceExtraction"))
			.mockResolvedValueOnce(waitingOn("sourceExtraction"))
			.mockResolvedValueOnce(waitingOn("codebaseIndexing"))
			.mockResolvedValueOnce(clear());

		await projectDocumentGenerationWorkflow(INPUT);

		// Three waiting polls, two writes: the row is polled for as long as an
		// hour, and re-writing the same category would be a database write per
		// poll that tells its reader nothing new.
		expect(
			activityStubs.recordGenerationQueueReason.mock.calls.map(
				(call) => call[0],
			),
		).toEqual([
			{ documentId: "doc_1", reason: "sourceExtraction" },
			{ documentId: "doc_1", reason: "codebaseIndexing" },
		]);
	});

	it("flips the queued row to generating against this attempt's identity", async () => {
		await projectDocumentGenerationWorkflow(INPUT);

		expect(activityStubs.startGenerationRun).toHaveBeenCalledWith({
			documentId: "doc_1",
			startedAt: "2026-09-07T10:00:00.000Z",
		});
	});

	/**
	 * Deploy skew, in the direction that actually happens: a new worker picks
	 * up a run an OLD API dispatched. `patched()` cannot see that — it gates
	 * the replay of an existing history, not the caller's version, and returns
	 * true for every brand-new execution. The missing attempt identity is the
	 * only evidence there is, and it is conclusive: that dispatcher marked the
	 * row GENERATING up front, so there is no queued row to flip, the flip
	 * could not be scoped to this attempt anyway, and the stale sweep would
	 * measure the whole wait against its thirty-minute ceiling and fail a run
	 * that is very much alive.
	 */
	it("skips the wait entirely when the dispatcher sent no attempt identity", async () => {
		const { generationStartedAt: _identity, ...withoutIdentity } = INPUT;

		await projectDocumentGenerationWorkflow(withoutIdentity);

		expect(
			activityStubs.probeGenerationDependencies,
		).not.toHaveBeenCalled();
		expect(sleepMock).not.toHaveBeenCalled();
		expect(activityStubs.startGenerationRun).not.toHaveBeenCalled();
		expect(executeChildMock).toHaveBeenCalledTimes(1);
		// The row is already GENERATING and the run is under way, so the panel
		// still gets its card — only the wait is skipped, not the bookkeeping.
		expect(jobSteps()).toEqual([
			"awaitContext:running",
			"awaitContext:completed",
			"generate:running",
			"generate:completed!",
		]);
	});
});

describe("the token the child actually runs under", () => {
	it("is re-issued when the run waited", async () => {
		activityStubs.probeGenerationDependencies
			.mockResolvedValueOnce(waitingOn("sourceExtraction"))
			.mockResolvedValueOnce(clear());
		activityStubs.issueGenerationToken.mockResolvedValue({
			aiToken: "fresh-token",
		});

		await projectDocumentGenerationWorkflow(INPUT);

		// The dispatch mints for a fifteen-minute run; the wait can outlast
		// that many times over.
		expect(childArgs().aiToken).toBe("fresh-token");
		expect(childArgs().aiToken).not.toBe(INPUT.aiToken);
	});

	/**
	 * A queued run is a LONGER run, not a shorter one. The issuer's default is
	 * five minutes; the generation child it feeds allows fifteen per attempt
	 * with five attempts behind it, and the API's dispatch mints accordingly.
	 * Taking the default here would make waiting for your dependencies the
	 * thing that expires your token.
	 */
	it("is minted for the same window the dispatch uses", async () => {
		activityStubs.probeGenerationDependencies
			.mockResolvedValueOnce(waitingOn("sourceExtraction"))
			.mockResolvedValueOnce(clear());

		await projectDocumentGenerationWorkflow(INPUT);

		expect(activityStubs.issueGenerationToken).toHaveBeenCalledWith({
			userId: "user_1",
			organizationId: "org_1",
			expirySeconds: 900,
		});
	});

	it("is the dispatch's own when the run never waited", async () => {
		await projectDocumentGenerationWorkflow(INPUT);

		expect(childArgs().aiToken).toBe("dispatch-token");
		expect(activityStubs.issueGenerationToken).not.toHaveBeenCalled();
	});

	/**
	 * The reason the re-authorization exists at all. `issueAIToken` signs
	 * whatever it is handed, so re-minting after an unbounded wait without
	 * re-asking would hand a requester who was removed from the organization a
	 * brand-new key to that organization's provider.
	 */
	it("is never minted for a requester who lost access while waiting", async () => {
		activityStubs.probeGenerationDependencies
			.mockResolvedValueOnce(waitingOn("sourceExtraction"))
			.mockResolvedValueOnce(clear());
		activityStubs.assertRequesterMayGenerate.mockRejectedValue(
			new Error(
				"The person who requested this document no longer has permission to generate it.",
			),
		);

		await expect(projectDocumentGenerationWorkflow(INPUT)).rejects.toThrow(
			/no longer has permission/,
		);

		expect(activityStubs.issueGenerationToken).not.toHaveBeenCalled();
		expect(executeChildMock).not.toHaveBeenCalled();
	});
});

/**
 * The bookkeeping that makes a queued run visible — and the reason it is easy
 * to leave untested. Every write here is deliberately swallowed at its call
 * site, so a missing activity fails silently and the suite goes green anyway.
 * These cases exist to say the writes actually happen, in order, with the right
 * arguments.
 */
describe("the Job Hub row and the requester's notification", () => {
	it("opens the row for this document and walks both steps to completion", async () => {
		await projectDocumentGenerationWorkflow(INPUT);

		expect(activityStubs.reportGenerationJobOpened).toHaveBeenCalledWith({
			projectId: "proj_1",
			documentId: "doc_1",
			documentType: "PRD",
			userId: "user_1",
			organizationId: "org_1",
		});
		// The wait is the run's first step and says so from the outset, and the
		// row closes the moment the child returns — the evaluation child and
		// the status writes after it are bookkeeping nobody is waiting on.
		expect(jobSteps()).toEqual([
			"awaitContext:running",
			"awaitContext:completed",
			"generate:running",
			"generate:completed!",
		]);
	});

	it("tells the requester the document is ready", async () => {
		await projectDocumentGenerationWorkflow(INPUT);

		// The one message a person who closed the tab an hour ago will see.
		expect(activityStubs.notifyGenerationOutcome).toHaveBeenCalledWith({
			documentId: "doc_1",
			userId: "user_1",
			outcome: "COMPLETED",
			// Scopes the claim: a superseded run must not spend the claim its
			// replacement needs.
			generationStartedAt: INPUT.generationStartedAt,
		});
	});

	it("closes the row on the step that was running when the wait was refused", async () => {
		activityStubs.probeGenerationDependencies.mockResolvedValue(
			failedOn("sourceExtraction"),
		);

		await expect(
			projectDocumentGenerationWorkflow(INPUT),
		).rejects.toThrow();

		// `awaitContext`, not `generate`: "it never got its inputs" and "the
		// model call failed" are two failures a user answers very differently.
		expect(jobSteps()).toEqual([
			"awaitContext:running",
			"awaitContext:failed!",
		]);
		expect(activityStubs.notifyGenerationOutcome).toHaveBeenCalledWith({
			documentId: "doc_1",
			userId: "user_1",
			outcome: "FAILED",
			// Scopes the claim: a superseded run must not spend the claim its
			// replacement needs.
			generationStartedAt: INPUT.generationStartedAt,
		});
	});

	it("closes the row on the generate step when the child is what failed", async () => {
		executeChildMock.mockRejectedValue(new Error("model call blew up"));

		await expect(
			projectDocumentGenerationWorkflow(INPUT),
		).rejects.toThrow();

		expect(jobSteps()).toEqual([
			"awaitContext:running",
			"awaitContext:completed",
			"generate:running",
			"generate:failed!",
		]);
		expect(activityStubs.notifyGenerationOutcome).toHaveBeenCalledWith({
			documentId: "doc_1",
			userId: "user_1",
			outcome: "FAILED",
			// Scopes the claim: a superseded run must not spend the claim its
			// replacement needs.
			generationStartedAt: INPUT.generationStartedAt,
		});
	});

	/**
	 * The Job Hub renders this string verbatim to whoever can see the row. A
	 * raw workflow error is whatever a model call, a provider SDK or a database
	 * driver produced, and that can carry hostnames, deployment names and
	 * internal ids — the same reason the notification writer refuses to quote
	 * one. So the card gets the run's OWN sentence when it has one, and a fixed
	 * generic line otherwise.
	 */
	it("repeats the run's own refusal, and nothing else", async () => {
		activityStubs.probeGenerationDependencies.mockResolvedValue(
			failedOn("sourceExtraction"),
		);

		await expect(
			projectDocumentGenerationWorkflow(INPUT),
		).rejects.toThrow();

		expect(jobFailureMessage()).toContain("sourceExtraction");
	});

	it("keeps a raw failure out of the row", async () => {
		executeChildMock.mockRejectedValue(
			new Error("connect ECONNREFUSED internal-host:5432"),
		);

		await expect(projectDocumentGenerationWorkflow(INPUT)).rejects.toThrow(
			/ECONNREFUSED/,
		);

		// The run still reports its real error to Temporal — the assertion above
		// is on the rethrow. Only the surface a person reads is scrubbed.
		expect(jobFailureMessage()).not.toContain("ECONNREFUSED");
		expect(jobFailureMessage()).toBeTruthy();
	});
});

/**
 * A run refused BEFORE the child starts has no child to write the document a
 * terminal status, so without this the row stays QUEUED and the reader watches
 * "waiting" for a run that already gave up — until the stale sweep gets to it
 * half an hour later.
 */
describe("the status the document itself is left in", () => {
	it("fails this attempt's row when the dependency will not arrive", async () => {
		activityStubs.probeGenerationDependencies.mockResolvedValue(
			failedOn("sourceExtraction"),
		);

		await expect(
			projectDocumentGenerationWorkflow(INPUT),
		).rejects.toThrow();

		expect(activityStubs.failGenerationRun).toHaveBeenCalledWith({
			documentId: "doc_1",
			// Scoped to THIS attempt, exactly as the queued → generating flip is:
			// a row a newer attempt owns, or one already terminal, is left alone.
			startedAt: "2026-09-07T10:00:00.000Z",
			reason: expect.stringContaining("sourceExtraction"),
		});
	});

	it("fails this attempt's row when the requester lost access while waiting", async () => {
		activityStubs.probeGenerationDependencies
			.mockResolvedValueOnce(waitingOn("sourceExtraction"))
			.mockResolvedValueOnce(clear());
		activityStubs.assertRequesterMayGenerate.mockRejectedValue(
			new Error("The person who requested this document no longer has"),
		);

		await expect(
			projectDocumentGenerationWorkflow(INPUT),
		).rejects.toThrow();

		expect(activityStubs.failGenerationRun).toHaveBeenCalledTimes(1);
	});

	it("does not write a row it holds no identity for", async () => {
		const { generationStartedAt: _identity, ...withoutIdentity } = INPUT;
		executeChildMock.mockRejectedValue(new Error("model call blew up"));

		await expect(
			projectDocumentGenerationWorkflow(withoutIdentity),
		).rejects.toThrow();

		// Nothing to scope the write to, and a terminal write on a guess could
		// land on a newer attempt's row.
		expect(activityStubs.failGenerationRun).not.toHaveBeenCalled();
	});

	it("keeps a raw failure out of the reason the document shows", async () => {
		executeChildMock.mockRejectedValue(
			new Error("connect ECONNREFUSED internal-host:5432"),
		);

		await expect(
			projectDocumentGenerationWorkflow(INPUT),
		).rejects.toThrow();

		const [write] = activityStubs.failGenerationRun.mock.calls[0] as [
			{ reason: string },
		];
		expect(write.reason).not.toContain("ECONNREFUSED");
		expect(write.reason.length).toBeGreaterThan(0);
	});
});

/**
 * The other side of the gate, which nothing exercised while `patched` was
 * hardcoded true.
 *
 * A history recorded before the queue shipped has none of these commands in it
 * — no probe activity, no timer, no Job Hub writes, no notification — and
 * replaying it against this worker has to produce exactly the command stream it
 * recorded. That is the entire reason the gate exists, and it is the one branch
 * a green suite could not previously say anything about.
 */
describe("a history recorded before the queue shipped", () => {
	beforeEach(() => {
		workflowState.patched = false;
	});

	it("goes straight to the child, with the pre-queue argument shape", async () => {
		await projectDocumentGenerationWorkflow(INPUT);

		expect(executeChildMock).toHaveBeenCalledTimes(1);
		expect(childArgs()).toEqual({
			projectId: "proj_1",
			documentId: "doc_1",
			documentType: "PRD",
			userId: "user_1",
			organizationId: "org_1",
			// The dispatch's own token: nothing waited, so nothing re-minted.
			aiToken: "dispatch-token",
			prompt: "",
			excludeContextId: "ctx_1",
		});
	});

	it("issues none of the queue's commands", async () => {
		await projectDocumentGenerationWorkflow(INPUT);

		expect(
			activityStubs.probeGenerationDependencies,
		).not.toHaveBeenCalled();
		expect(sleepMock).not.toHaveBeenCalled();
		expect(
			activityStubs.recordGenerationQueueReason,
		).not.toHaveBeenCalled();
		expect(activityStubs.startGenerationRun).not.toHaveBeenCalled();
		expect(activityStubs.issueGenerationToken).not.toHaveBeenCalled();
		expect(activityStubs.reportGenerationJobOpened).not.toHaveBeenCalled();
		expect(activityStubs.reportGenerationJobStep).not.toHaveBeenCalled();
		expect(activityStubs.notifyGenerationOutcome).not.toHaveBeenCalled();
	});

	it("issues none of them on its failure path either", async () => {
		executeChildMock.mockRejectedValue(new Error("model call blew up"));

		await expect(
			projectDocumentGenerationWorkflow(INPUT),
		).rejects.toThrow();

		// The closing writes are behind the same marker as the opening ones, so
		// an old history replays without them too — including the terminal
		// document write, which such a run never had.
		expect(activityStubs.reportGenerationJobStep).not.toHaveBeenCalled();
		expect(activityStubs.notifyGenerationOutcome).not.toHaveBeenCalled();
		expect(activityStubs.failGenerationRun).not.toHaveBeenCalled();
	});
});

describe("dependency wait (source assertions)", () => {
	const parent = readFileSync(
		join(__dirname, "../src/workflows/project-document-generation.ts"),
		"utf8",
	);

	/** The block this unit added: the gate through to the child call. */
	const waitBlock = parent.slice(
		parent.indexOf(
			'patched("document-generation-dependency-wait-2026-09-07")',
		),
		parent.indexOf("const childResult = await executeChild("),
	);

	it("schedules the wait with `sleep` and nothing else", () => {
		expect(waitBlock.length).toBeGreaterThan(0);
		// A delay computed from the clock (`while (Date.now() - start < …)`) is
		// a busy loop that never yields the workflow thread, and `setTimeout` /
		// `Math.random` are not the workflow's to call at all. The `Date.now()`
		// elsewhere in this file is Temporal's replay-safe clock, used to log a
		// duration — the wait must not derive its schedule from it.
		expect(waitBlock).not.toContain("Date.now");
		expect(waitBlock).not.toContain("Math.random");
		expect(waitBlock).not.toContain("setTimeout");
		expect(waitBlock).toContain("await sleep(delayMs);");
	});

	it("re-authorizes before it re-issues the token", () => {
		const assertIdx = waitBlock.indexOf("assertRequesterMayGenerate(");
		const issueIdx = waitBlock.indexOf("issueGenerationToken(");

		expect(assertIdx).toBeGreaterThan(-1);
		expect(issueIdx).toBeGreaterThan(assertIdx);
	});

	it("introduces exactly one patch marker id", () => {
		// The gate is required: the wait adds a probe activity to every run's
		// command stream and a timer to every run that waits, so a history
		// recorded before it must replay with the gate false.
		//
		// Asserted over the set of UNIQUE ids, not over the number of textual
		// occurrences. `patched()` answers identically for every call within one
		// execution, so naming the same marker at several sites is a re-read,
		// not a second gate — `template-instance-execution.ts` does exactly that
		// at its two notification calls. Counting occurrences instead would
		// force the answer to be smuggled out in a boolean and threaded to
		// every downstream site, which is a worse file for no replay benefit.
		// What the assertion still catches is the thing that matters: a SECOND,
		// different marker, or a new command with no gate at all.
		const ids = [
			...new Set(parent.match(/patched\("([^"]+)"\)/g) ?? []),
		].sort();
		expect(ids).toEqual([
			'patched("document-generation-dependency-wait-2026-09-07")',
		]);
	});

	it("does not continue as new out of the wait", () => {
		// A new run means a new runId, and the document's workflow-status row
		// and the watchdog's liveness lookup both correlate on this one.
		expect(waitBlock).toContain("continueAsNewSuggested");
		expect(parent).not.toContain("continueAsNew<");
		expect(parent).not.toContain("await continueAsNew(");
	});
});
