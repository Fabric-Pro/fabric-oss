/**
 * The queued half of a document generation run.
 *
 * A generation request is accepted as QUEUED and only flips to GENERATING once
 * its dependency wait clears — a wait that can legitimately last an hour. Every
 * write here is guarded, and the guards are the point: each one exists because
 * an ungated write would leave a document in a state that some other mechanism
 * then ignores forever. So these assert the WHERE clauses, not just the outcome
 * — a naive "mock resolves, row is QUEUED" test passes an unguarded `update`
 * too, and misses every race the guards were written for.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany, findUnique, updateMany } = vi.hoisted(() => ({
	findMany: vi.fn(),
	findUnique: vi.fn(),
	updateMany: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: { projectDocument: { findMany, findUnique, updateMany } },
}));

import {
	findStaleGeneratingDocuments,
	markDocumentGenerationQueued,
	markDocumentGenerationRunning,
	setDocumentGenerationQueueReason,
} from "../prisma/queries/projects/documents";

const DOCUMENT_ID = "doc-1";
const STARTED_AT = new Date("2026-09-05T10:00:00.000Z");

beforeEach(() => {
	findMany.mockReset();
	findUnique.mockReset();
	updateMany.mockReset();
	findMany.mockResolvedValue([]);
	findUnique.mockResolvedValue(null);
	updateMany.mockResolvedValue({ count: 1 });
});

describe("markDocumentGenerationQueued", () => {
	it("writes QUEUED and resets the run's progress and error", async () => {
		const result = await markDocumentGenerationQueued(DOCUMENT_ID);

		expect(updateMany).toHaveBeenCalledTimes(1);
		const [{ where, data }] = updateMany.mock.calls[0];
		expect(where.id).toBe(DOCUMENT_ID);
		expect(data).toEqual({
			status: "QUEUED",
			generationProgress: 0,
			generationError: null,
			generationStartedAt: result.generationStartedAt,
			generationNotificationEmittedAt: null,
		});
		expect(result.applied).toBe(true);
	});

	/**
	 * The notification claim is exactly-once per RUN, not per document. It is
	 * released as a new attempt is accepted rather than when the previous one
	 * finished, so the claim's whole lifetime sits inside one run and a late
	 * terminal write from the previous attempt still finds its own claim taken.
	 * Without this, regenerating a document a week later would notify nobody:
	 * the column would still hold the first run's timestamp.
	 */
	it("releases the notification claim so the new run can notify", async () => {
		await markDocumentGenerationQueued(DOCUMENT_ID);

		const [{ data }] = updateMany.mock.calls[0];
		expect(data.generationNotificationEmittedAt).toBeNull();
	});

	/**
	 * The guard, and the whole of what it is for: a write from THIS attempt
	 * landing after this attempt's own workflow already terminalized the row. A
	 * workflow that fails inside its first dependency probe writes FAILED, and
	 * an unguarded queue write landing afterwards would drag the row back to
	 * QUEUED — a state the watchdog's age ceiling skips and the client's retry
	 * affordance hides, so nothing would ever recover it.
	 *
	 * Expressed as freshness rather than status: the dispatcher mints this
	 * timestamp before `workflow.start` and marks after it, so any write the run
	 * made in between is newer than the attempt.
	 */
	it("refuses a row written since this attempt began", async () => {
		const result = await markDocumentGenerationQueued(DOCUMENT_ID);

		const [{ where }] = updateMany.mock.calls[0];
		expect(where.updatedAt).toEqual({ lt: result.generationStartedAt });
	});

	/**
	 * The main path, and the one a status guard silently broke: the editor
	 * offers Regenerate only on COMPLETE and FAILED documents, so a guard
	 * excluding the terminal pair refused every regeneration's queue mark and
	 * the document never showed as queued at all. A row COMPLETE since last week
	 * is simply older than this attempt.
	 */
	it("queues a regeneration of a row that is already COMPLETE", async () => {
		// A document finished long before this attempt was dispatched. The
		// predicate is EVALUATED rather than asserted, so this tests the
		// semantics and not the shape of the query.
		const completedLastWeek = new Date(STARTED_AT.getTime() - 604_800_000);
		updateMany.mockImplementation(
			({ where }: { where: { updatedAt: { lt: Date } } }) => ({
				count: completedLastWeek < where.updatedAt.lt ? 1 : 0,
			}),
		);

		const result = await markDocumentGenerationQueued(DOCUMENT_ID, {
			generationStartedAt: STARTED_AT,
		});

		const [{ where }] = updateMany.mock.calls[0];
		// No status predicate at all: a terminal status is not what disqualifies
		// a row here — being newer than the attempt is.
		expect(where.status).toBeUndefined();
		expect(result.applied).toBe(true);
	});

	/**
	 * The other side of the same predicate: an attempt whose workflow has
	 * already written the row — a dependency probe that failed inside the first
	 * second — is older than that write and stands down.
	 */
	it("refuses an attempt older than the row's last write", async () => {
		const terminalizedAfterStart = new Date(STARTED_AT.getTime() + 1_000);
		updateMany.mockImplementation(
			({ where }: { where: { updatedAt: { lt: Date } } }) => ({
				count: terminalizedAfterStart < where.updatedAt.lt ? 1 : 0,
			}),
		);

		const result = await markDocumentGenerationQueued(DOCUMENT_ID, {
			generationStartedAt: STARTED_AT,
		});

		expect(result.applied).toBe(false);
	});

	it("returns the generationStartedAt it wrote, so the caller can scope later writes to this attempt", async () => {
		const before = Date.now();
		const result = await markDocumentGenerationQueued(DOCUMENT_ID);
		const after = Date.now();

		const [{ data }] = updateMany.mock.calls[0];
		expect(data.generationStartedAt).toBe(result.generationStartedAt);
		expect(result.generationStartedAt.getTime()).toBeGreaterThanOrEqual(
			before,
		);
		expect(result.generationStartedAt.getTime()).toBeLessThanOrEqual(after);
	});
});

describe("markDocumentGenerationRunning", () => {
	it("flips QUEUED to GENERATING and clears the queue reason", async () => {
		const outcome = await markDocumentGenerationRunning(
			DOCUMENT_ID,
			STARTED_AT,
		);

		expect(updateMany).toHaveBeenCalledWith({
			where: {
				id: DOCUMENT_ID,
				status: "QUEUED",
				generationStartedAt: STARTED_AT,
			},
			data: {
				status: "GENERATING",
				generationQueueReason: null,
			},
		});
		expect(outcome).toBe("started");
	});

	/**
	 * A wait can outlive its own row — the user re-ran, the watchdog swept it,
	 * the workflow already failed. A probe resolving after any of those must not
	 * resurrect the row as GENERATING, so the write carries this attempt's
	 * identity and is a silent no-op when the row has moved on.
	 *
	 * Which of the two reasons it was decides whether the caller may continue,
	 * so the no-op is not one answer but two — and the row's own identity is
	 * what tells them apart.
	 */
	it("reports supersession when a later attempt owns the row", async () => {
		updateMany.mockResolvedValue({ count: 0 });
		findUnique.mockResolvedValue({
			generationStartedAt: new Date(STARTED_AT.getTime() + 1_000),
		});

		expect(
			await markDocumentGenerationRunning(DOCUMENT_ID, STARTED_AT),
		).toBe("superseded");
	});

	/**
	 * The dispatcher stamps QUEUED only after `workflow.start` returns, so a
	 * worker that picks the run up immediately arrives before its own mark. That
	 * is an ordering gap, not a lost row, and calling it supersession would kill
	 * a healthy run and strand its document waiting on nothing.
	 */
	it("reports the write as not yet visible when no later attempt owns the row", async () => {
		updateMany.mockResolvedValue({ count: 0 });
		findUnique.mockResolvedValue({ generationStartedAt: null });

		expect(
			await markDocumentGenerationRunning(DOCUMENT_ID, STARTED_AT),
		).toBe("not-yet-visible");
	});

	it("reports supersession when the document is gone entirely", async () => {
		updateMany.mockResolvedValue({ count: 0 });
		findUnique.mockResolvedValue(null);

		expect(
			await markDocumentGenerationRunning(DOCUMENT_ID, STARTED_AT),
		).toBe("superseded");
	});
});

describe("setDocumentGenerationQueueReason", () => {
	it("writes the reason only while the row is still QUEUED", async () => {
		await setDocumentGenerationQueueReason(DOCUMENT_ID, "CONTEXT");

		expect(updateMany).toHaveBeenCalledWith({
			where: { id: DOCUMENT_ID, status: "QUEUED" },
			data: { generationQueueReason: "CONTEXT" },
		});
	});

	/**
	 * A dependency probe can resolve after the wait cleared or after the run
	 * died. A reason left on a GENERATING, COMPLETE or FAILED row reads as
	 * current in the UI — a finished document explaining what it is waiting for.
	 */
	it("does not touch a row that is no longer waiting", async () => {
		updateMany.mockResolvedValue({ count: 0 });

		await expect(
			setDocumentGenerationQueueReason(DOCUMENT_ID, "CONTEXT"),
		).resolves.toBeUndefined();
	});
});

describe("findStaleGeneratingDocuments", () => {
	const cutoff = new Date("2026-09-05T09:30:00.000Z");

	/** `count` rows of one status, enough to fill a page on their own. */
	const rows = (prefix: string, count: number, status: string) =>
		Array.from({ length: count }, (_, index) => ({
			id: `${prefix}-${index}`,
			status,
		}));

	/** Answer each arm's query with the rows that arm is meant to find. */
	const respond = (aged: unknown[], queued: unknown[]) => {
		findMany.mockImplementation(
			({ where }: { where: { status: string } }) =>
				where.status === "GENERATING" ? aged : queued,
		);
	};

	/** Each arm's WHERE clause, in call order. */
	type ArmWhere = {
		status?: string;
		generationStartedAt?: unknown;
		workflowId?: unknown;
		OR?: unknown;
	};
	const wheresOf = (): ArmWhere[] =>
		findMany.mock.calls.map((call) => call[0].where as ArmWhere);

	it("applies the age ceiling to GENERATING rows", async () => {
		await findStaleGeneratingDocuments({ cutoff, limit: 50 });

		expect(wheresOf()).toContainEqual({
			status: "GENERATING",
			generationStartedAt: { lt: cutoff },
		});
	});

	/**
	 * The asymmetry this sweep now depends on. An hour-long dependency wait is
	 * the queue working as designed, so no age makes a queued row suspicious —
	 * the liveness check downstream is the only thing allowed to condemn one,
	 * which is why the row must carry a workflow to ask about.
	 */
	it("selects QUEUED rows with a workflow at any age", async () => {
		await findStaleGeneratingDocuments({ cutoff, limit: 50 });

		const wheres = wheresOf();
		expect(wheres).toContainEqual({
			status: "QUEUED",
			workflowId: { not: null },
		});
		const queuedArm = wheres.find((where) => where.status === "QUEUED");
		expect(queuedArm?.generationStartedAt).toBeUndefined();
	});

	/**
	 * The two arms are asked for SEPARATELY. Under one `OR` and one `take` they
	 * share a page, and sharing means starving: a project holding a backlog of
	 * healthy live QUEUED rows fills the page on `generationStartedAt asc` and
	 * the aged GENERATING rows never enter the batch at all.
	 */
	it("queries each arm on its own budget", async () => {
		await findStaleGeneratingDocuments({ cutoff, limit: 50 });

		expect(findMany).toHaveBeenCalledTimes(2);
		for (const [args] of findMany.mock.calls) {
			expect(args.where.OR).toBeUndefined();
			expect(args.take).toBe(50);
		}
	});

	it("keeps aged rows in the page when the queue is backed up", async () => {
		respond(rows("aged", 50, "GENERATING"), rows("queued", 50, "QUEUED"));

		const page = await findStaleGeneratingDocuments({ cutoff, limit: 50 });

		expect(page).toHaveLength(50);
		expect(page.filter((row) => row.status === "GENERATING")).toHaveLength(
			25,
		);
		expect(page.filter((row) => row.status === "QUEUED")).toHaveLength(25);
	});

	/**
	 * The reserve is a floor, not a quota: with nothing waiting in the queue the
	 * sweep still works through a full page of aged rows.
	 */
	it("hands the whole page to one arm when the other is empty", async () => {
		respond(rows("aged", 80, "GENERATING"), []);

		const page = await findStaleGeneratingDocuments({ cutoff, limit: 50 });

		expect(page).toHaveLength(50);
	});

	it("returns the status so the sweep knows which arm produced the row", async () => {
		await findStaleGeneratingDocuments({ cutoff, limit: 50 });

		for (const [{ select }] of findMany.mock.calls) {
			expect(select.status).toBe(true);
			expect(select.workflowId).toBe(true);
			expect(select.generationStartedAt).toBe(true);
		}
	});
});
