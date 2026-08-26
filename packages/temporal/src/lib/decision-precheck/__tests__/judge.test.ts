/**
 * Tests for `judgeDecisionContradictions` — the LLM-judge + in-code
 * normalization. `generateObject` is mocked so every assertion targets the
 * NORMALIZATION contract (the untrusted model output is validated/resolved
 * against the candidate set), not the model itself.
 *
 * Run: pnpm --filter @repo/temporal test src/lib/decision-precheck
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockGenerateObject,
	mockGetAIModelWithMetadata,
	mockLogModelUsageAsync,
	mockTrackUsage,
} = vi.hoisted(() => ({
	mockGenerateObject: vi.fn(),
	mockGetAIModelWithMetadata: vi.fn(),
	mockLogModelUsageAsync: vi.fn(),
	mockTrackUsage: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	generateObject: mockGenerateObject,
	getAIModelWithMetadata: mockGetAIModelWithMetadata,
	logModelUsageAsync: mockLogModelUsageAsync,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { judgeDecisionContradictions } from "../judge";
import type { CandidateDecision } from "../select-candidates";

function candidate(
	over: Partial<CandidateDecision> & { id: string },
): CandidateDecision {
	return {
		identifier: `ADR-${over.id}`,
		title: `Title ${over.id}`,
		status: "ACCEPTED",
		domain: null,
		decision: `Decision ${over.id}`,
		rationale: `Rationale ${over.id}`,
		contextProblem: "",
		...over,
	};
}

const baseInput = {
	projectId: "p1",
	userId: "u1",
	organizationId: undefined as string | undefined,
};

/** Make `generateObject` return one model call's raw conflicts. */
function modelReturns(conflicts: unknown[]) {
	mockGenerateObject.mockResolvedValue({
		object: { conflicts },
		usage: { inputTokens: 1, outputTokens: 1 },
	});
}

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

describe("judgeDecisionContradictions — normalization", () => {
	it("drops a conflict whose decisionId is not in the candidate set", async () => {
		modelReturns([
			{ decisionId: "ghost", natureOfConflict: "made up" },
			{ decisionId: "real", natureOfConflict: "genuine" },
		]);

		const findings = await judgeDecisionContradictions({
			...baseInput,
			candidates: [candidate({ id: "real" })],
			items: [{ text: "some output" }],
		});

		expect(findings).toHaveLength(1);
		expect(findings[0].decisionId).toBe("real");
	});

	it("resolves identifier and title from the candidate, ignoring model echoes", async () => {
		modelReturns([
			{
				decisionId: "d1",
				decisionIdentifier: "WRONG-999",
				natureOfConflict: "contradicts the chosen store",
			},
		]);

		const findings = await judgeDecisionContradictions({
			...baseInput,
			candidates: [
				candidate({
					id: "d1",
					identifier: "ADR-012",
					title: "Use Postgres",
				}),
			],
			items: [{ text: "let us use Mongo" }],
		});

		expect(findings[0].decisionIdentifier).toBe("ADR-012");
		expect(findings[0].decisionTitle).toBe("Use Postgres");
	});

	it("maps a recognized conflictType string", async () => {
		modelReturns([
			{
				decisionId: "d1",
				natureOfConflict: "reintroduces the ruled-out option",
				conflictType: "reintroduces_rejected",
			},
		]);

		const findings = await judgeDecisionContradictions({
			...baseInput,
			candidates: [candidate({ id: "d1", status: "REJECTED" })],
			items: [{ text: "output" }],
		});

		expect(findings[0].conflictType).toBe("reintroduces_rejected");
	});

	it("derives conflictType from candidate status when the model string is unrecognized", async () => {
		modelReturns([
			{
				decisionId: "acc",
				natureOfConflict: "violates it",
				conflictType: "totally-unknown-label",
			},
			{
				decisionId: "rej",
				natureOfConflict: "brings it back",
				conflictType: "gibberish",
			},
		]);

		const findings = await judgeDecisionContradictions({
			...baseInput,
			candidates: [
				candidate({ id: "acc", status: "ACCEPTED" }),
				candidate({ id: "rej", status: "REJECTED" }),
			],
			items: [{ text: "output" }],
		});

		const byId = new Map(findings.map((f) => [f.decisionId, f]));
		expect(byId.get("acc")?.conflictType).toBe("violates_accepted");
		expect(byId.get("rej")?.conflictType).toBe("reintroduces_rejected");
	});

	it("coerces and clamps confidence (string, out-of-range, unparseable, missing)", async () => {
		modelReturns([
			{ decisionId: "s", natureOfConflict: "x", confidence: "0.8" },
			{ decisionId: "hi", natureOfConflict: "x", confidence: 5 },
			{ decisionId: "lo", natureOfConflict: "x", confidence: -2 },
			{ decisionId: "nan", natureOfConflict: "x", confidence: "abc" },
			{ decisionId: "none", natureOfConflict: "x" },
		]);

		const findings = await judgeDecisionContradictions({
			...baseInput,
			candidates: [
				candidate({ id: "s" }),
				candidate({ id: "hi" }),
				candidate({ id: "lo" }),
				candidate({ id: "nan" }),
				candidate({ id: "none" }),
			],
			items: [{ text: "output" }],
		});

		const byId = new Map(findings.map((f) => [f.decisionId, f.confidence]));
		expect(byId.get("s")).toBeCloseTo(0.8);
		expect(byId.get("hi")).toBe(1);
		expect(byId.get("lo")).toBe(0);
		expect(byId.get("nan")).toBe(0.5);
		expect(byId.get("none")).toBe(0.5);
	});

	it("attaches a bounds-checked changeRef and drops an out-of-range changeIndex", async () => {
		modelReturns([
			{ decisionId: "in", natureOfConflict: "x", changeIndex: 1 },
			{ decisionId: "out", natureOfConflict: "x", changeIndex: 9 },
		]);

		const findings = await judgeDecisionContradictions({
			...baseInput,
			candidates: [candidate({ id: "in" }), candidate({ id: "out" })],
			items: [
				{ ref: { index: 10, title: "First" }, text: "a" },
				{ ref: { index: 11, title: "Second" }, text: "b" },
			],
		});

		const byId = new Map(findings.map((f) => [f.decisionId, f]));
		// changeIndex 1 → items[1], carrying that item's real change index + title.
		expect(byId.get("in")?.changeRef).toEqual({
			index: 11,
			title: "Second",
		});
		// changeIndex 9 is out of range → no changeRef.
		expect(byId.get("out")?.changeRef).toBeUndefined();
	});
});

describe("judgeDecisionContradictions — prompt budget", () => {
	/** The prompt string handed to the (mocked) model for this run. */
	async function promptFor(input: {
		candidates: CandidateDecision[];
		items: { ref?: { index: number; title?: string }; text: string }[];
	}): Promise<string> {
		modelReturns([]);
		await judgeDecisionContradictions({ ...baseInput, ...input });
		return mockGenerateObject.mock.calls[0][0].prompt as string;
	}

	it("truncates a huge artifact item instead of sending it verbatim", async () => {
		const prompt = await promptFor({
			candidates: [candidate({ id: "d1" })],
			items: [{ text: `${"x".repeat(60_000)}TAIL_SENTINEL` }],
		});

		expect(prompt).toContain("truncated");
		// The far tail of the oversized item never reaches the model.
		expect(prompt).not.toContain("TAIL_SENTINEL");
		// Whole prompt stays comfortably bounded (artifact budget + decision +
		// framing), not ~60k chars.
		expect(prompt.length).toBeLessThan(30_000);
	});

	it("truncates an over-long decision body field", async () => {
		const prompt = await promptFor({
			candidates: [
				candidate({
					id: "d1",
					rationale: `${"y".repeat(5_000)}RATIONALE_TAIL`,
				}),
			],
			items: [{ text: "short output" }],
		});

		expect(prompt).not.toContain("RATIONALE_TAIL");
	});

	it("leaves a normal-sized document intact", async () => {
		const body = "We chose Postgres over Mongo for the primary store.";
		const prompt = await promptFor({
			candidates: [candidate({ id: "d1" })],
			items: [{ text: body }],
		});

		expect(prompt).toContain(body);
		expect(prompt).not.toContain("truncated");
	});
});

describe("judgeDecisionContradictions — degradation", () => {
	it("returns [] and never calls the model when there are no candidates", async () => {
		const findings = await judgeDecisionContradictions({
			...baseInput,
			candidates: [],
			items: [{ text: "output" }],
		});

		expect(findings).toEqual([]);
		expect(mockGenerateObject).not.toHaveBeenCalled();
	});

	it("returns [] when the model call throws", async () => {
		mockGenerateObject.mockRejectedValue(new Error("provider exploded"));

		const findings = await judgeDecisionContradictions({
			...baseInput,
			candidates: [candidate({ id: "d1" })],
			items: [{ text: "output" }],
		});

		expect(findings).toEqual([]);
	});

	it("returns [] when the model call exceeds the timeout budget", async () => {
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

		const findings = await judgeDecisionContradictions({
			...baseInput,
			candidates: [candidate({ id: "d1" })],
			items: [{ text: "output" }],
		});

		expect(findings).toEqual([]);
	});

	it("logs usage on a successful judge call", async () => {
		modelReturns([]);

		await judgeDecisionContradictions({
			...baseInput,
			candidates: [candidate({ id: "d1" })],
			items: [{ text: "output" }],
		});

		expect(mockTrackUsage).toHaveBeenCalledTimes(1);
		expect(mockLogModelUsageAsync).toHaveBeenCalledTimes(1);
	});
});
