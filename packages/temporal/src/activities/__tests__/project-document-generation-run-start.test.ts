/**
 * `startGenerationRun` tells the project's open pages when a queued document
 * starts generating (Fizzy #2946).
 *
 * Nothing else announces the QUEUED → GENERATING flip, so a page already open
 * on the document would learn of a run someone else started only from its
 * first live section. Covered here:
 *
 *  - a flip that landed sends one `document_change` nudge, ids only, read off
 *    the row because the activity is handed no project id;
 *  - a flip that did not land (superseded, not yet visible, an unparseable
 *    identity) sends nothing and reads nothing;
 *  - a retry whose own flip already landed (its first answer was lost)
 *    reports `started` to the run without sending the nudge again;
 *  - nothing after the flip fails the activity: a nudge that rejects, a row
 *    read that throws, a row that is gone and a nudge that never answers all
 *    still report `started`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	markDocumentGenerationRunning: vi.fn(),
	projectDocumentFindUnique: vi.fn(),
	emitDocumentChange: vi.fn(),
	activityLoggerWarn: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		projectDocument: {
			findUnique: (...args: unknown[]) =>
				mocks.projectDocumentFindUnique(...args),
		},
	},
	markDocumentGenerationRunning: (...args: unknown[]) =>
		mocks.markDocumentGenerationRunning(...args),
	listEmbeddedDocumentsForSweep: vi.fn().mockResolvedValue([]),
}));

vi.mock("@repo/utils/realtime-emit", () => ({
	emitDocumentChange: (...args: unknown[]) =>
		mocks.emitDocumentChange(...args),
}));

vi.mock("@repo/rag", () => ({
	buildDocumentRetrievalQuery: () => "build document retrieval query",
	searchSimilarProjectContexts: vi.fn(),
	extractBaseContextId: (id: string) => id,
	enrichContextsWithRoleTags: vi.fn(),
	applyContextSummary: vi.fn(),
	rerankContexts: vi.fn(),
	embedProjectDocument: vi.fn(),
	reembedProjectDocument: vi.fn(),
	deleteStaleDocumentEmbeddingChunks: vi.fn(),
	searchSimilarEpisodes: vi.fn().mockResolvedValue([]),
}));

vi.mock("@repo/ai", () => ({
	DEFAULT_BASE_URLS: {},
	getAIModelWithMetadata: vi.fn(),
	logModelUsageAsync: vi.fn(),
	streamText: vi.fn(),
}));

vi.mock("@temporalio/activity", () => ({
	Context: { current: { heartbeat: vi.fn() } },
	heartbeat: vi.fn(),
	ApplicationFailure: { nonRetryable: (msg: string) => new Error(msg) },
}));

vi.mock("../lib/activity-logger", () => ({
	activityLogger: {
		info: vi.fn(),
		warn: (...args: unknown[]) => mocks.activityLoggerWarn(...args),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Import AFTER mocks
import { startGenerationRun } from "../project-document-generation";

const DOCUMENT_ID = "doc-1";
const PROJECT_ID = "project-1";
const STARTED_AT = "2026-10-20T10:00:00.000Z";

function start(startedAt = STARTED_AT) {
	return startGenerationRun({ documentId: DOCUMENT_ID, startedAt });
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.markDocumentGenerationRunning.mockResolvedValue("started");
	mocks.projectDocumentFindUnique.mockResolvedValue({
		projectId: PROJECT_ID,
		type: "PROPOSAL",
	});
	mocks.emitDocumentChange.mockResolvedValue(undefined);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("startGenerationRun — the page is told the run started", () => {
	it("flips this attempt's row and nudges the document's page once, ids only", async () => {
		const result = await start();

		expect(result).toEqual({ outcome: "started" });
		const [documentId, startedAt] =
			mocks.markDocumentGenerationRunning.mock.calls[0];
		expect(documentId).toBe(DOCUMENT_ID);
		expect((startedAt as Date).toISOString()).toBe(STARTED_AT);
		expect(mocks.emitDocumentChange).toHaveBeenCalledTimes(1);
		expect(mocks.emitDocumentChange.mock.calls[0][0]).toEqual({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
			action: "updated",
			userId: expect.stringMatching(/\S/),
			userName: expect.stringMatching(/\S/),
			documentType: "PROPOSAL",
		});
		const [flipOrder] =
			mocks.markDocumentGenerationRunning.mock.invocationCallOrder;
		const [nudgeOrder] = mocks.emitDocumentChange.mock.invocationCallOrder;
		expect(flipOrder).toBeLessThan(nudgeOrder);
	});

	it.each(["superseded", "not-yet-visible"] as const)(
		"sends nothing when the flip did not land (%s)",
		async (outcome) => {
			mocks.markDocumentGenerationRunning.mockResolvedValue(outcome);

			const result = await start();

			expect(result).toEqual({ outcome });
			expect(mocks.projectDocumentFindUnique).not.toHaveBeenCalled();
			expect(mocks.emitDocumentChange).not.toHaveBeenCalled();
		},
	);

	it("reports a retry that finds its own flip landed as started, without nudging again", async () => {
		mocks.markDocumentGenerationRunning.mockResolvedValue(
			"already-started",
		);

		const result = await start();

		// The workflow continues only on `started`; anything else waits or
		// stops the run as superseded.
		expect(result).toEqual({ outcome: "started" });
		expect(mocks.projectDocumentFindUnique).not.toHaveBeenCalled();
		expect(mocks.emitDocumentChange).not.toHaveBeenCalled();
	});

	it("sends nothing for an identity nobody can parse", async () => {
		const result = await start("not-a-timestamp");

		expect(result).toEqual({ outcome: "superseded" });
		expect(mocks.markDocumentGenerationRunning).not.toHaveBeenCalled();
		expect(mocks.emitDocumentChange).not.toHaveBeenCalled();
	});
});

describe("startGenerationRun — nothing after the flip fails the activity", () => {
	it("still reports started when the nudge fails, and logs it without the message", async () => {
		mocks.emitDocumentChange.mockRejectedValue(
			new Error("realtime unreachable: internal-host"),
		);

		const result = await start();

		expect(result).toEqual({ outcome: "started" });
		expect(mocks.activityLoggerWarn).toHaveBeenCalledTimes(1);
		const [, context] = mocks.activityLoggerWarn.mock.calls[0];
		expect(context).toEqual({ documentId: DOCUMENT_ID, error: "Error" });
	});

	it("still reports started when the row cannot be read, and sends nothing", async () => {
		mocks.projectDocumentFindUnique.mockRejectedValue(
			Object.assign(new Error("connection reset"), { code: "P1017" }),
		);

		const result = await start();

		expect(result).toEqual({ outcome: "started" });
		expect(mocks.emitDocumentChange).not.toHaveBeenCalled();
		expect(mocks.activityLoggerWarn).toHaveBeenCalledWith(
			expect.any(String),
			{ documentId: DOCUMENT_ID, error: "P1017" },
		);
	});

	it("still reports started when the row is gone, and sends nothing", async () => {
		mocks.projectDocumentFindUnique.mockResolvedValue(null);

		const result = await start();

		expect(result).toEqual({ outcome: "started" });
		expect(mocks.emitDocumentChange).not.toHaveBeenCalled();
		expect(mocks.activityLoggerWarn).not.toHaveBeenCalled();
	});

	it("stops waiting for a nudge that never answers, well inside the activity's timeout", async () => {
		vi.useFakeTimers();
		mocks.emitDocumentChange.mockReturnValue(new Promise(() => {}));

		const pending = start();
		await vi.advanceTimersByTimeAsync(10_000);

		await expect(pending).resolves.toEqual({ outcome: "started" });
		expect(mocks.activityLoggerWarn).toHaveBeenCalledWith(
			expect.any(String),
			{ documentId: DOCUMENT_ID, error: "TIMEOUT" },
		);
	});
});
