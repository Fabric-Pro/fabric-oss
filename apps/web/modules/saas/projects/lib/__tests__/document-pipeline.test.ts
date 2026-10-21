import {
	GENERATION_RUN_SILENCE_CEILING_MS,
	isGenerationRunStillWriting,
} from "@repo/utils/generation-run-guard";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveGenerationClock } from "../document-generation-timestamp";
import {
	DOCUMENT_PIPELINE_LIMIT,
	getDocumentMeta,
	getDocumentPollInterval,
	getDocumentStatusView,
	getPipelineDocuments,
	getVersionStepPollInterval,
	isDocumentGenerationRunning,
	isDocumentInFlight,
	type PipelineDocument,
	type VersionStepWatch,
} from "../document-pipeline";

function doc(
	overrides: Partial<PipelineDocument> & { id: string },
): PipelineDocument {
	return {
		type: "GENERAL",
		title: "Untitled",
		status: "DRAFT",
		...overrides,
	};
}

describe("getPipelineDocuments", () => {
	it("returns an empty result for undefined or empty input", () => {
		expect(getPipelineDocuments(undefined)).toEqual({
			visible: [],
			total: 0,
			hasMore: false,
		});
		expect(getPipelineDocuments([])).toEqual({
			visible: [],
			total: 0,
			hasMore: false,
		});
	});

	it("excludes documents with isActive === false", () => {
		const result = getPipelineDocuments([
			doc({ id: "a", isActive: true }),
			doc({ id: "b", isActive: false }),
			doc({ id: "c" }),
		]);
		expect(result.total).toBe(2);
		expect(result.visible.map((d) => d.id)).toEqual(["a", "c"]);
	});

	it("orders documents by the stable pipeline sequence", () => {
		const result = getPipelineDocuments([
			doc({ id: "story", type: "USER_STORY" }),
			doc({ id: "prd", type: "PRD" }),
			doc({ id: "arch", type: "ARCHITECTURE" }),
		]);
		expect(result.visible.map((d) => d.id)).toEqual([
			"prd",
			"arch",
			"story",
		]);
	});

	it("sorts unknown types last", () => {
		const result = getPipelineDocuments([
			doc({ id: "mystery", type: "SOMETHING_NEW" }),
			doc({ id: "prd", type: "PRD" }),
		]);
		expect(result.visible.map((d) => d.id)).toEqual(["prd", "mystery"]);
	});

	it("keeps input order for documents of the same type (stable)", () => {
		const result = getPipelineDocuments([
			doc({ id: "prd-1", type: "PRD" }),
			doc({ id: "prd-2", type: "PRD" }),
			doc({ id: "prd-3", type: "PRD" }),
		]);
		expect(result.visible.map((d) => d.id)).toEqual([
			"prd-1",
			"prd-2",
			"prd-3",
		]);
	});

	it("renders one card per document, including multiple of the same type", () => {
		const result = getPipelineDocuments([
			doc({ id: "prd-1", type: "PRD" }),
			doc({ id: "prd-2", type: "PRD" }),
			doc({ id: "prd-3", type: "PRD" }),
		]);
		expect(result.total).toBe(3);
		expect(result.visible).toHaveLength(3);
	});

	it("caps the visible set at the limit and flags overflow", () => {
		const docs = Array.from({ length: 15 }, (_, i) =>
			doc({ id: `d-${i}`, title: `Doc ${i}` }),
		);
		const result = getPipelineDocuments(docs);
		expect(result.total).toBe(15);
		expect(result.visible).toHaveLength(DOCUMENT_PIPELINE_LIMIT);
		expect(result.hasMore).toBe(true);
	});

	it("shows all cards and no overflow when count equals the limit", () => {
		const docs = Array.from({ length: DOCUMENT_PIPELINE_LIMIT }, (_, i) =>
			doc({ id: `d-${i}` }),
		);
		const result = getPipelineDocuments(docs);
		expect(result.visible).toHaveLength(DOCUMENT_PIPELINE_LIMIT);
		expect(result.hasMore).toBe(false);
	});

	it("orders before capping — the visible top 6 is the highest-priority set, not the input head", () => {
		// A pipeline-last type (GENERAL) is first in the input, followed by the
		// six highest-priority types. Correct sort-then-slice drops GENERAL;
		// a slice-then-sort bug would keep it as the first visible card.
		const result = getPipelineDocuments([
			doc({ id: "general", type: "GENERAL" }),
			doc({ id: "biz", type: "BUSINESS_CASE" }),
			doc({ id: "prd", type: "PRD" }),
			doc({ id: "proposal", type: "PROPOSAL" }),
			doc({ id: "arch", type: "ARCHITECTURE" }),
			doc({ id: "tech", type: "TECHNICAL_SPEC" }),
			doc({ id: "api", type: "API_SPEC" }),
		]);
		expect(result.visible.map((d) => d.id)).toEqual([
			"biz",
			"prd",
			"proposal",
			"arch",
			"tech",
			"api",
		]);
		expect(result.visible.map((d) => d.id)).not.toContain("general");
		expect(result.hasMore).toBe(true);
	});

	it("does not let inactive documents inflate the overflow count", () => {
		const active = Array.from({ length: DOCUMENT_PIPELINE_LIMIT }, (_, i) =>
			doc({ id: `active-${i}` }),
		);
		const inactive = Array.from({ length: 3 }, (_, i) =>
			doc({ id: `inactive-${i}`, isActive: false }),
		);
		const result = getPipelineDocuments([...active, ...inactive]);
		expect(result.total).toBe(DOCUMENT_PIPELINE_LIMIT);
		expect(result.visible).toHaveLength(DOCUMENT_PIPELINE_LIMIT);
		expect(result.hasMore).toBe(false);
	});
});

describe("getDocumentMeta", () => {
	it("returns the correct human label for a known type", () => {
		expect(getDocumentMeta("PROPOSAL").label).toBe("Proposal");
		expect(getDocumentMeta("PRD").label).toBe("Requirements Document");
		expect(getDocumentMeta("API_SPEC").label).toBe("API Specification");
		expect(getDocumentMeta("DESIGN_SYSTEM").label).toBe("Design System");
	});

	it("does not carry the old mismatched labels", () => {
		expect(getDocumentMeta("PROPOSAL").label).not.toBe("Frontend Design");
		expect(getDocumentMeta("API_SPEC").label).not.toBe(
			"Security Guidelines",
		);
	});

	it("falls back to a default for unknown types", () => {
		expect(getDocumentMeta("SOMETHING_NEW").label).toBe("Document");
	});
});

describe("getDocumentStatusView", () => {
	it("maps COMPLETE to Ready", () => {
		expect(getDocumentStatusView("COMPLETE")).toEqual({
			label: "Ready",
			tone: "complete",
		});
	});

	it("maps in-flight statuses to Active", () => {
		expect(getDocumentStatusView("GENERATING").label).toBe("Active");
		expect(getDocumentStatusView("IN_PROGRESS").label).toBe("Active");
	});

	/**
	 * Fizzy #2199 — a queued run has been accepted and is waiting on the
	 * project's own context work. Falling through to "Pending" told the reader
	 * the generation had never been asked for.
	 */
	it("maps QUEUED to Active, not Pending", () => {
		expect(getDocumentStatusView("QUEUED")).toEqual({
			label: "Active",
			tone: "active",
		});
	});

	it("maps everything else to Pending", () => {
		for (const status of ["DRAFT", "REVIEW", "FAILED", "UNKNOWN"]) {
			expect(getDocumentStatusView(status).label).toBe("Pending");
		}
	});
});

/**
 * The two predicates the queue split apart (Fizzy #2199). `isDocumentInFlight`
 * answers "is this document being worked on" — it drives roll-up counts and the
 * status badge, and a human editing a draft counts. `isDocumentGenerationRunning`
 * answers "is a generation run under way" — it drives polling and closes off
 * every control that would start a second run, and a human editing a draft does
 * not count, because no amount of polling advances one.
 */
describe("in-flight predicates", () => {
	it("counts a queued run as both in flight and generation-running", () => {
		expect(isDocumentInFlight("QUEUED")).toBe(true);
		expect(isDocumentGenerationRunning("QUEUED")).toBe(true);
	});

	it("counts an editing draft as in flight but not generation-running", () => {
		expect(isDocumentInFlight("IN_PROGRESS")).toBe(true);
		expect(isDocumentGenerationRunning("IN_PROGRESS")).toBe(false);
	});

	it("counts neither for settled or untouched statuses", () => {
		for (const status of ["DRAFT", "REVIEW", "COMPLETE", "FAILED"]) {
			expect(isDocumentInFlight(status)).toBe(false);
			expect(isDocumentGenerationRunning(status)).toBe(false);
		}
	});
});

/**
 * The editor stops treating a run as writing when its poll stops, and the
 * server judges the editor's save over a run with the shared rule
 * (Fizzy #2946). Both must answer alike, or the editor sends saves the server
 * refuses, or holds back saves the server would take.
 */
describe("a run still writing: the poll and the shared rule agree", () => {
	const NOW = Date.parse("2026-10-20T12:00:00.000Z");
	const ago = (ms: number) => new Date(NOW - ms);
	const CEILING = GENERATION_RUN_SILENCE_CEILING_MS;

	// With no stamp at all the poll measures from the wall clock.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const polled = (
		status: string,
		generationStartedAt: Date | string | null,
		updatedAt: Date | string | null,
	) =>
		isDocumentGenerationRunning(status) &&
		getDocumentPollInterval(
			status,
			resolveGenerationClock(status, generationStartedAt, updatedAt),
			NOW,
		) !== false;

	const stamps: Array<[string, Date | string | null]> = [
		["none", null],
		["empty", ""],
		["now", ago(0)],
		["a minute ago", ago(60 * 1000)],
		["at the ceiling", ago(CEILING)],
		["just past the ceiling", ago(CEILING + 1)],
		["just past the ceiling, as a string", ago(CEILING + 1).toISOString()],
		["an hour ago", ago(60 * 60 * 1000)],
	];
	const cases = [
		"QUEUED",
		"GENERATING",
		"COMPLETE",
		"DRAFT",
		"FAILED",
		"IN_PROGRESS",
		"",
	].flatMap((status) =>
		stamps.flatMap(([accepted, generationStartedAt]) =>
			stamps.map(([written, updatedAt]) => ({
				status,
				accepted,
				written,
				generationStartedAt,
				updatedAt,
			})),
		),
	);

	it.each(cases)(
		"'$status', accepted $accepted, last written $written",
		({ status, generationStartedAt, updatedAt }) => {
			expect(
				isGenerationRunStillWriting(
					{ status, generationStartedAt, updatedAt },
					NOW,
				),
			).toBe(polled(status, generationStartedAt, updatedAt));
		},
	);

	it("stops counting a generating run at the poll's own ceiling", () => {
		const generating = (silentForMs: number) =>
			isGenerationRunStillWriting(
				{ status: "GENERATING", updatedAt: ago(silentForMs) },
				NOW,
			);

		expect(generating(CEILING)).toBe(true);
		expect(generating(CEILING + 1)).toBe(false);
		expect(
			getDocumentPollInterval("GENERATING", NOW - CEILING, NOW),
		).not.toBe(false);
		expect(
			getDocumentPollInterval("GENERATING", NOW - CEILING - 1, NOW),
		).toBe(false);
	});
});

/**
 * A run's version step comes after its COMPLETE save and sends no nudge, so
 * the document is asked about again for a while after the run ends
 * (Fizzy #2946).
 */
describe("getVersionStepPollInterval", () => {
	const T0 = Date.parse("2026-10-20T12:00:00.000Z");

	/** Feeds the answers in order, each at its time, as the query sees them. */
	function replay(answers: Array<[number, string, number]>) {
		let watch: VersionStepWatch | undefined;
		return answers.map(([at, status, version]) => {
			const next = getVersionStepPollInterval(
				watch,
				{ status, version },
				T0 + at,
			);
			watch = next.watch;
			return next.interval;
		});
	}

	it("keeps asking after a run ends, from 3s and widening, until a later version arrives", () => {
		expect(
			replay([
				[0, "GENERATING", 2],
				[1000, "COMPLETE", 2],
				[4000, "COMPLETE", 2],
				[10_000, "COMPLETE", 3],
				[13_000, "COMPLETE", 3],
			]),
		).toEqual([false, 3000, 6000, false, false]);
	});

	// The version step waits for the run's decision pre-check, which may
	// take up to two minutes.
	it("gives up 150s after the run ended when no later version comes", () => {
		expect(
			replay([
				[0, "QUEUED", 2],
				[1000, "COMPLETE", 2],
				[4000, "COMPLETE", 2],
				[10_000, "COMPLETE", 2],
				[22_000, "COMPLETE", 2],
				[46_000, "COMPLETE", 2],
				[150_999, "COMPLETE", 2],
				[151_000, "COMPLETE", 2],
				[154_000, "COMPLETE", 2],
			]),
		).toEqual([
			false,
			3000,
			6000,
			12_000,
			24_000,
			30_000,
			30_000,
			false,
			false,
		]);
	});

	it("does not ask when the answer that shows the run COMPLETE already carries its step", () => {
		expect(
			replay([
				[0, "GENERATING", 2],
				[3000, "COMPLETE", 3],
				[6000, "COMPLETE", 3],
			]),
		).toEqual([false, false, false]);
	});

	it("does not ask about a document COMPLETE from its first answer", () => {
		expect(
			replay([
				[0, "COMPLETE", 2],
				[3000, "COMPLETE", 2],
			]),
		).toEqual([false, false]);
		expect(getVersionStepPollInterval(undefined, undefined, T0)).toEqual(
			expect.objectContaining({ interval: false }),
		);
	});

	it("stops when the run is under way again, or ends FAILED", () => {
		expect(
			replay([
				[0, "GENERATING", 2],
				[1000, "COMPLETE", 2],
				[2000, "GENERATING", 2],
				[3000, "FAILED", 2],
				[6000, "FAILED", 2],
			]),
		).toEqual([false, 3000, false, false, false]);
	});

	it("answers the same answer alike however often it is asked", () => {
		const running = getVersionStepPollInterval(
			undefined,
			{ status: "GENERATING", version: 2 },
			T0,
		).watch;
		const ended = getVersionStepPollInterval(
			running,
			{ status: "COMPLETE", version: 2 },
			T0 + 1000,
		);
		const again = getVersionStepPollInterval(
			ended.watch,
			{ status: "COMPLETE", version: 2 },
			T0 + 1000,
		);
		expect(again).toEqual(ended);
	});
});
