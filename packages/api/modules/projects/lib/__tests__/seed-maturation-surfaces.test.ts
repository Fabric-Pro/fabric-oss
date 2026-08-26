import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Auto-seed orchestrator. Summary generation, question extraction, and the
 * hash writes are mocked; the real combine + the hash gates run, so these tests
 * assert the actual branch behavior:
 *   - questions extract only when the spec hash changed (`lastQuestionScanHash`);
 *   - the summary regenerates when (spec + bound Summary prompt) changed
 *     (`lastSummaryHash`) — demo feedback #4a — and no-ops otherwise.
 *
 * Hash-dependent tests CAPTURE the hashes the orchestrator actually computes
 * (rather than re-deriving the formula here) so they stay correct if the gate's
 * hash composition changes.
 */

const SUMMARY_INSTRUCTIONS = "INSTRUCTIONS (bound or default)";

const mocks = vi.hoisted(() => ({
	setSummaryDigest: vi.fn(),
	setLastQuestionScanHash: vi.fn(),
	setLastSummaryHash: vi.fn(),
	generateMaturationSummary: vi.fn(),
	resolveSummaryInstructions: vi.fn(),
	extractMaturationQuestions: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	setSummaryDigest: mocks.setSummaryDigest,
	setLastQuestionScanHash: mocks.setLastQuestionScanHash,
	setLastSummaryHash: mocks.setLastSummaryHash,
}));

vi.mock("../generate-summary-digest", () => ({
	generateMaturationSummary: mocks.generateMaturationSummary,
	resolveSummaryInstructions: mocks.resolveSummaryInstructions,
}));

vi.mock("../extract-maturation-questions", () => ({
	extractMaturationQuestions: mocks.extractMaturationQuestions,
}));

const { seedMaturationSurfaces } = await import("../seed-maturation-surfaces");

const baseFeature = {
	id: "story-1",
	projectId: "project-1",
	title: "Login",
	description: "# Login\n\nUsers authenticate before the dashboard.",
	acceptanceCriteria: "- AC#1: email + password.",
	summaryDigest: null,
	workingNotesContent: null,
	lastQuestionScanHash: null,
	lastSummaryHash: null,
	lastContextUpdateAt: null,
	maturationV2OptedIn: true,
	cleanSpecApprovalMode: null,
	decisionLogApprovalMode: null,
	summaryQuestionsApprovalMode: null,
} as never;

const tenantFilter = { organizationId: "org-1", userId: "user-1" } as const;

function feature(overrides: Record<string, unknown> = {}) {
	return { ...(baseFeature as object), ...overrides } as never;
}

/**
 * Run the orchestrator once on a fresh feature and return the question-scan +
 * summary hashes it wrote, then clear call history (keeping mock impls).
 */
async function captureHashes(): Promise<{
	questionHash: string;
	summaryHash: string;
}> {
	await seedMaturationSurfaces({ feature: feature(), tenantFilter });
	const questionHash = mocks.setLastQuestionScanHash.mock.calls[0][0].hash;
	const summaryHash = mocks.setLastSummaryHash.mock.calls[0][0].hash;
	for (const m of Object.values(mocks)) {
		m.mockClear();
	}
	return { questionHash, summaryHash };
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	mocks.setSummaryDigest.mockResolvedValue(1);
	mocks.setLastQuestionScanHash.mockResolvedValue(1);
	mocks.setLastSummaryHash.mockResolvedValue(1);
	mocks.generateMaturationSummary.mockResolvedValue("A short digest.");
	mocks.resolveSummaryInstructions.mockResolvedValue(SUMMARY_INSTRUCTIONS);
	mocks.extractMaturationQuestions.mockResolvedValue({
		extracted: 2,
		minted: 2,
		skipped: 0,
		softClosed: 0,
		reactivated: 0,
		questions: [],
	});
});

describe("seedMaturationSurfaces", () => {
	it("is a no-op when the Clean Spec is empty (no model calls, no writes)", async () => {
		const out = await seedMaturationSurfaces({
			feature: feature({ description: "", acceptanceCriteria: "" }),
			tenantFilter,
		});

		expect(out).toEqual({
			summaryGenerated: false,
			questionsScanned: false,
			minted: 0,
		});
		expect(mocks.generateMaturationSummary).not.toHaveBeenCalled();
		expect(mocks.extractMaturationQuestions).not.toHaveBeenCalled();
	});

	it("generates the digest and extracts questions on first scan (hashes null)", async () => {
		const out = await seedMaturationSurfaces({
			feature: feature(),
			tenantFilter,
		});

		expect(out).toEqual({
			summaryGenerated: true,
			questionsScanned: true,
			minted: 2,
		});
		expect(mocks.extractMaturationQuestions).toHaveBeenCalledTimes(1);
		expect(mocks.setLastQuestionScanHash).toHaveBeenCalledTimes(1);
		expect(mocks.setLastSummaryHash).toHaveBeenCalledTimes(1);
		expect(mocks.generateMaturationSummary).toHaveBeenCalledTimes(1);
	});

	it("does NOT re-extract or regenerate when spec and prompt are unchanged", async () => {
		const { questionHash, summaryHash } = await captureHashes();

		const out = await seedMaturationSurfaces({
			feature: feature({
				summaryDigest: "Existing.",
				lastQuestionScanHash: questionHash,
				lastSummaryHash: summaryHash,
			}),
			tenantFilter,
		});

		expect(out).toEqual({
			summaryGenerated: false,
			questionsScanned: false,
			minted: 0,
		});
		expect(mocks.extractMaturationQuestions).not.toHaveBeenCalled();
		expect(mocks.setLastQuestionScanHash).not.toHaveBeenCalled();
		expect(mocks.generateMaturationSummary).not.toHaveBeenCalled();
		expect(mocks.setSummaryDigest).not.toHaveBeenCalled();
	});

	it("re-extracts when the spec changed since the last scan (stale hash)", async () => {
		const out = await seedMaturationSurfaces({
			feature: feature({
				summaryDigest: "Existing.",
				lastQuestionScanHash: "stale-hash-from-an-older-spec",
				lastSummaryHash: "stale-summary-hash",
			}),
			tenantFilter,
		});

		expect(out.questionsScanned).toBe(true);
		expect(mocks.extractMaturationQuestions).toHaveBeenCalledTimes(1);
		expect(mocks.setLastQuestionScanHash).toHaveBeenCalledTimes(1);
	});

	it("regenerates the digest when the Summary prompt changed (#4a)", async () => {
		const { questionHash, summaryHash } = await captureHashes();

		// Spec unchanged (question scan no-ops) but the bound Summary prompt text
		// now differs from what produced `summaryHash` → summary must regenerate.
		mocks.resolveSummaryInstructions.mockResolvedValue(
			"EDITED INSTRUCTIONS",
		);
		await seedMaturationSurfaces({
			feature: feature({
				summaryDigest: "Existing digest.",
				lastQuestionScanHash: questionHash,
				lastSummaryHash: summaryHash,
			}),
			tenantFilter,
		});

		expect(mocks.generateMaturationSummary).toHaveBeenCalledTimes(1);
		expect(mocks.setSummaryDigest).toHaveBeenCalledTimes(1);
		expect(mocks.setLastSummaryHash).toHaveBeenCalledTimes(1);
		// Question extraction stays gated on the (unchanged) spec hash.
		expect(mocks.extractMaturationQuestions).not.toHaveBeenCalled();
	});

	it("regenerates a missing digest even when the summary hash matches", async () => {
		const { questionHash, summaryHash } = await captureHashes();

		await seedMaturationSurfaces({
			feature: feature({
				summaryDigest: null,
				lastQuestionScanHash: questionHash,
				lastSummaryHash: summaryHash,
			}),
			tenantFilter,
		});

		expect(mocks.generateMaturationSummary).toHaveBeenCalledTimes(1);
		expect(mocks.setSummaryDigest).toHaveBeenCalledTimes(1);
	});
});
