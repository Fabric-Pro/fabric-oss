/**
 * Tests for `runDecisionPrecheck` — the orchestrator and single degradation
 * boundary. Mocks the DB (`@repo/database`) and model (`@repo/ai`) boundaries
 * and drives the REAL select → judge → normalize pipeline end to end, proving
 * that every failure mode (query throw, LLM error, LLM timeout, no candidates,
 * no conflicts) returns a safe ok/empty result and NEVER throws.
 *
 * Run: pnpm --filter @repo/temporal test src/lib/decision-precheck
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockFindMany,
	mockGenerateObject,
	mockGetAIModelWithMetadata,
	mockLogModelUsageAsync,
	mockTrackUsage,
} = vi.hoisted(() => ({
	mockFindMany: vi.fn(),
	mockGenerateObject: vi.fn(),
	mockGetAIModelWithMetadata: vi.fn(),
	mockLogModelUsageAsync: vi.fn(),
	mockTrackUsage: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { architectureDecision: { findMany: mockFindMany } },
}));

vi.mock("@repo/ai", () => ({
	generateObject: mockGenerateObject,
	getAIModelWithMetadata: mockGetAIModelWithMetadata,
	logModelUsageAsync: mockLogModelUsageAsync,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runDecisionPrecheck } from "../index";

type Row = {
	id: string;
	identifier: string;
	title: string;
	status: string;
	domain: string | null;
	decision: string;
	rationale: string;
	contextProblem: string;
};

/** Wire the DB mock so one ACCEPTED decision is available as a candidate. */
function arrangeOneCandidate() {
	const row: Row = {
		id: "d1",
		identifier: "ADR-001",
		title: "Use Postgres",
		status: "ACCEPTED",
		domain: "data",
		decision: "We use Postgres",
		rationale: "operational familiarity",
		contextProblem: "pick a database",
	};
	// The single status-filtered candidate query returns the one ACCEPTED row.
	mockFindMany.mockResolvedValue([row]);
}

const input = {
	projectId: "p1",
	userId: "u1",
	organizationId: undefined,
	artifact: {
		surface: "backlog_proposal" as const,
		items: [
			{ ref: { index: 0, title: "Switch to Mongo" }, text: "use mongo" },
		],
	},
};

beforeEach(() => {
	vi.clearAllMocks();
	mockGetAIModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: {},
		trackUsage: mockTrackUsage,
	});
});

afterEach(() => {
	delete process.env.DECISION_PRECHECK_TIMEOUT_MS;
});

describe("runDecisionPrecheck", () => {
	it("returns conflicts when the judge flags a genuine contradiction", async () => {
		arrangeOneCandidate();
		mockGenerateObject.mockResolvedValue({
			object: {
				conflicts: [
					{
						decisionId: "d1",
						changeIndex: 0,
						natureOfConflict:
							"Mongo contradicts the Postgres decision",
						confidence: 0.9,
					},
				],
			},
			usage: {},
		});

		const result = await runDecisionPrecheck(input);

		expect(result.status).toBe("conflicts");
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0].decisionIdentifier).toBe("ADR-001");
		expect(result.findings[0].conflictType).toBe("violates_accepted");
		expect(result.findings[0].changeRef).toEqual({
			index: 0,
			title: "Switch to Mongo",
		});
		expect(typeof result.checkedAt).toBe("string");
	});

	it("returns an ok/empty result when the decision log query throws", async () => {
		mockFindMany.mockRejectedValue(new Error("decision log unavailable"));

		const result = await runDecisionPrecheck(input);

		expect(result).toEqual({
			checkedAt: expect.any(String),
			status: "ok",
			findings: [],
		});
		// Never reached the model when there are no candidates.
		expect(mockGenerateObject).not.toHaveBeenCalled();
	});

	it("returns an ok/empty result when there are no candidate decisions", async () => {
		mockFindMany.mockResolvedValue([]);

		const result = await runDecisionPrecheck(input);

		expect(result.status).toBe("ok");
		expect(result.findings).toEqual([]);
		expect(mockGenerateObject).not.toHaveBeenCalled();
	});

	it("returns an ok/empty result when the model call errors", async () => {
		arrangeOneCandidate();
		mockGenerateObject.mockRejectedValue(new Error("provider exploded"));

		const result = await runDecisionPrecheck(input);

		expect(result.status).toBe("ok");
		expect(result.findings).toEqual([]);
	});

	it("returns an ok/empty result when the model call times out", async () => {
		arrangeOneCandidate();
		process.env.DECISION_PRECHECK_TIMEOUT_MS = "20";
		mockGenerateObject.mockImplementation(
			() =>
				new Promise((resolve) =>
					setTimeout(
						() =>
							resolve({
								object: {
									conflicts: [
										{
											decisionId: "d1",
											natureOfConflict: "late",
										},
									],
								},
								usage: {},
							}),
						200,
					),
				),
		);

		const result = await runDecisionPrecheck(input);

		expect(result.status).toBe("ok");
		expect(result.findings).toEqual([]);
	});

	it("returns an ok/empty result when the judge finds no conflicts", async () => {
		arrangeOneCandidate();
		mockGenerateObject.mockResolvedValue({
			object: { conflicts: [] },
			usage: {},
		});

		const result = await runDecisionPrecheck(input);

		expect(result.status).toBe("ok");
		expect(result.findings).toEqual([]);
	});

	it("never rejects even if model resolution itself throws", async () => {
		arrangeOneCandidate();
		mockGetAIModelWithMetadata.mockRejectedValue(
			new Error("no provider configured"),
		);

		await expect(runDecisionPrecheck(input)).resolves.toEqual({
			checkedAt: expect.any(String),
			status: "ok",
			findings: [],
		});
	});
});
