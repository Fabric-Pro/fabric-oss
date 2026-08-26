/**
 * The sweep's fan-out step.
 *
 * This activity has one job and one safety property, and the safety property is
 * the entire reason the feature does not need a dedupe table: a refresh is
 * started under a DETERMINISTIC workflow id, so a retried dispatch — or a sweep
 * that fires again while the previous refresh is still running — collides with
 * the in-flight execution instead of starting a second one. The collision
 * surfaces as `WorkflowExecutionAlreadyStartedError`, which this activity
 * swallows as SUCCESS.
 *
 * Swallowing an error is exactly the kind of thing a later "cleanup" deletes, so
 * every clause of it is pinned here:
 *   - the id is deterministic and comes from find-due, not from the clock;
 *   - AlreadyStarted resolves rather than throws (idempotency);
 *   - every OTHER error propagates (so Temporal actually retries a real outage);
 *   - the reuse policy stays ALLOW_DUPLICATE (see the test for why).
 *
 * The real `WorkflowExecutionAlreadyStartedError` class is used deliberately
 * rather than a stub: the activity's branch is an `instanceof` check, and a
 * hand-rolled stand-in would still pass if production imported the error from
 * the wrong module.
 */

import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getClientMock, startMock } = vi.hoisted(() => ({
	getClientMock: vi.fn(),
	startMock: vi.fn(),
}));

// heartbeat() throws outside a real activity context — no-op it.
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// From __tests__/ → ../../../client is the same module the activity imports as
// ../../client.
vi.mock("../../../client", () => ({ getTemporalClient: getClientMock }));

import { dispatchDocumentRefreshActivity } from "../dispatch-document-refresh";
import type { DueDocument } from "../find-due-documents";

const DUE: DueDocument = {
	documentId: "doc_1",
	projectId: "proj_1",
	documentTitle: "PRD",
	organizationId: null,
	userId: "user_1",
	triggeredByUserId: "user_1",
	// Produced by find-due — `document-refresh-<documentId>-<cadence bucket>`.
	workflowId: "document-refresh-doc_1-1342",
};

const DUE_IN_ORG: DueDocument = {
	...DUE,
	organizationId: "org_1",
	userId: null,
};

/** The options object the activity handed to `client.workflow.start`. */
function startOptions() {
	return startMock.mock.calls[0]?.[1];
}

beforeEach(() => {
	vi.clearAllMocks();
	startMock.mockResolvedValue({ firstExecutionRunId: "run_1" });
	getClientMock.mockResolvedValue({ workflow: { start: startMock } });
});

describe("dispatchDocumentRefreshActivity", () => {
	it("starts the refresh workflow on the document-refresh task queue", async () => {
		await dispatchDocumentRefreshActivity(DUE);

		expect(startMock).toHaveBeenCalledTimes(1);
		expect(startMock.mock.calls[0]?.[0]).toBe("documentRefreshWorkflow");
		expect(startOptions()).toMatchObject({
			taskQueue: "document-refresh",
			workflowId: "document-refresh-doc_1-1342",
		});
	});

	it("passes the due document through to the workflow untouched", async () => {
		// The workflow gets its tenant, its actor and its title from this payload —
		// it never re-reads them.
		await dispatchDocumentRefreshActivity(DUE);

		expect(startOptions().args).toEqual([DUE]);
	});

	it("carries the organization tenant through", async () => {
		await dispatchDocumentRefreshActivity(DUE_IN_ORG);

		expect(startOptions().args).toEqual([DUE_IN_ORG]);
		expect(startOptions().args[0]).toMatchObject({
			organizationId: "org_1",
			userId: null,
		});
	});

	it("uses the workflow id find-due computed, rather than deriving its own", async () => {
		// The id must not be a function of the dispatch's own clock: an activity
		// RETRY would then produce a different id and start a second refresh of the
		// same document.
		await dispatchDocumentRefreshActivity({
			...DUE,
			workflowId: "document-refresh-doc_9-77",
		});

		expect(startOptions().workflowId).toBe("document-refresh-doc_9-77");
	});

	it("is idempotent across a retried dispatch — the same id, every time", async () => {
		await dispatchDocumentRefreshActivity(DUE);
		await dispatchDocumentRefreshActivity(DUE);

		const ids = startMock.mock.calls.map((call) => call[1].workflowId);
		expect(ids).toEqual([
			"document-refresh-doc_1-1342",
			"document-refresh-doc_1-1342",
		]);
	});

	it("keeps ALLOW_DUPLICATE — REJECT_DUPLICATE would silently stop every retry", async () => {
		// LOAD-BEARING, and the single most tempting thing in this file to "harden".
		//
		// The workflow id contains the cadence bucket, which is 7-30 DAYS wide. A
		// failed refresh retries after 6 hours — under the SAME id, in the SAME
		// bucket. REJECT_DUPLICATE rejects a reused id whose previous execution has
		// CLOSED, so it would reject exactly the retries: every failing document
		// would get one attempt per cadence period and then go quiet for up to a
		// month, with no error anywhere to say why.
		await dispatchDocumentRefreshActivity(DUE);

		expect(startOptions().workflowIdReusePolicy).toBe("ALLOW_DUPLICATE");
	});

	it("bounds a wedged refresh so the next sweep gets a clean slate", async () => {
		await dispatchDocumentRefreshActivity(DUE);

		expect(startOptions().workflowExecutionTimeout).toBe("1 hour");
	});

	describe("idempotency", () => {
		it("treats an already-running refresh as success, not as an error", async () => {
			// THE load-bearing mechanism. Two consecutive sweeps can both see a
			// document as due while the first refresh is still generating (the model
			// call takes minutes). The second start collides with the first, and that
			// collision is the DESIRED outcome — not a failure to be retried.
			//
			// If this rethrew, the dispatch activity would fail, Temporal would retry
			// it, it would collide again, and the sweep would eventually surface a
			// spurious failure for a document that is refreshing perfectly well.
			startMock.mockRejectedValue(
				new WorkflowExecutionAlreadyStartedError(
					"already started",
					DUE.workflowId,
					"documentRefreshWorkflow",
				),
			);

			await expect(
				dispatchDocumentRefreshActivity(DUE),
			).resolves.toBeUndefined();
		});

		it("does not retry the start after an already-started collision", async () => {
			startMock.mockRejectedValue(
				new WorkflowExecutionAlreadyStartedError(
					"already started",
					DUE.workflowId,
					"documentRefreshWorkflow",
				),
			);

			await dispatchDocumentRefreshActivity(DUE);

			// Swallowed, not re-attempted — the running execution is left alone.
			expect(startMock).toHaveBeenCalledTimes(1);
		});
	});

	describe("real failures still propagate", () => {
		it("rethrows a transient Temporal outage so the activity is retried", async () => {
			// The counterweight to the swallow above: if EVERY error were swallowed,
			// a Temporal outage would look like a successful sweep and the documents
			// in it would never be refreshed — silently, with the cadence clock
			// untouched, so nothing would ever notice.
			startMock.mockRejectedValue(new Error("temporal is down"));

			await expect(dispatchDocumentRefreshActivity(DUE)).rejects.toThrow(
				"temporal is down",
			);
		});

		it("rethrows a failure to even obtain a client", async () => {
			getClientMock.mockRejectedValue(new Error("no connection"));

			await expect(dispatchDocumentRefreshActivity(DUE)).rejects.toThrow(
				"no connection",
			);
			expect(startMock).not.toHaveBeenCalled();
		});

		it("does not swallow an error that merely LOOKS like the already-started one", async () => {
			// The branch is an instanceof check, not a string match on the message —
			// so a genuine failure that happens to mention "already started" must
			// still propagate.
			startMock.mockRejectedValue(
				new Error("workflow already started somewhere else"),
			);

			await expect(dispatchDocumentRefreshActivity(DUE)).rejects.toThrow(
				"workflow already started somewhere else",
			);
		});
	});
});
