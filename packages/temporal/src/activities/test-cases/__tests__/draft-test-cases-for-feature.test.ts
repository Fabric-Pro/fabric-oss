import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/ai", () => ({
	draftTestCases: vi.fn(),
	// Pure sizing helpers the activity uses to raise the cap toward the
	// criteria count. Constant + simple count stub keep
	// this mock free of the real module's model-stack imports.
	MAX_DRAFTED_TEST_CASES: 12,
	countAcceptanceCriteria: vi.fn(() => 3),
}));
vi.mock("@repo/database", () => ({
	bulkCreateTestCases: vi.fn(),
	createContext: vi.fn(async () => ({ id: "ctx1" })),
	setTestCaseContextId: vi.fn(),
	// Stable stand-in — what matters here is that the drafter stamps SOMETHING
	// derived from the feature, not what the hash of that text works out to.
	// The fingerprint's own behaviour is covered where it lives.
	fingerprintSpecText: vi.fn(() => "spec-hash"),
}));
vi.mock("@repo/database/prisma/client", () => ({
	db: {
		userStory: { findFirst: vi.fn() },
		testCaseDraftJob: { findFirst: vi.fn() },
		// The dedupe pass reads the feature's existing cases before creating.
		testCase: { findMany: vi.fn() },
	},
}));
vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("../../../client", () => ({
	getTemporalClient: vi.fn(async () => ({
		workflow: { start: vi.fn() },
	})),
}));

import { countAcceptanceCriteria, draftTestCases } from "@repo/ai";
import { bulkCreateTestCases } from "@repo/database";
import { db } from "@repo/database/prisma/client";
import { logger } from "@repo/logs";
// Deliberately NOT mocked: one test drives the real encryption module so the
// redaction stays coupled to the error that module actually throws.
import { decryptApiKey, encryptApiKey } from "@repo/utils";
import { draftTestCasesForFeature } from "../draft-test-cases-for-feature";

const restoreEnv = (key: string, value: string | undefined) => {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
};

const input = {
	jobId: "job1",
	projectId: "p1",
	storyId: "s1",
	userId: "u1",
	organizationId: undefined,
};

/** A story that clears the acceptance-criteria gate. */
const storyWithAcs = {
	identifier: "F-012",
	title: "Quotas",
	description: "Body",
	acceptanceCriteria: "AC 1: enforce the ceiling",
};

const drafted = (overrides: Record<string, unknown> = {}) => ({
	title: "Org data is not visible from a personal workspace",
	preconditions: "Org Acme has quota 5; signed in as an Admin of Acme",
	acceptanceCriterionRef: "AC 1",
	state: "DRAFT" as const,
	priority: "CRITICAL" as const,
	automationStatus: "NOT_AUTOMATED" as const,
	steps: [{ action: "Open the list", expected: "No Acme rows are shown" }],
	...overrides,
});

/** A persisted case as `bulkCreateTestCases` hands it back. */
const created = (id: string) => ({
	id,
	identifier: "TC-001",
	title: "T",
	state: "DRAFT",
	priority: "CRITICAL",
	description: null,
	steps: [],
	workItemLinks: [],
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(db.userStory.findFirst).mockResolvedValue(storyWithAcs as never);
	// Default: the run is live — every draft activity executes after
	// beginTestCaseDraftJob advanced the job to RUNNING.
	vi.mocked(db.testCaseDraftJob.findFirst).mockResolvedValue({
		status: "RUNNING",
	} as never);
	// Default: the feature has no cases yet, so nothing is deduped away.
	vi.mocked(db.testCase.findMany).mockResolvedValue([] as never);
	vi.mocked(bulkCreateTestCases).mockResolvedValue([created("tc1")] as never);
});

describe("draftTestCasesForFeature", () => {
	it("does not re-create a case the feature already has", async () => {
		// Drafting APPENDS. Re-running it over a changed feature used to produce
		// the whole set again alongside the originals — the trap the spec names
		// as blocking TDD step 6.
		vi.mocked(draftTestCases).mockResolvedValue([drafted()] as never);
		vi.mocked(db.testCase.findMany).mockResolvedValue([
			{
				// Same case, cosmetically different wording — exactly what a
				// second drafting run emits.
				title: "Verify org data is NOT visible from a personal workspace.",
				workItemLinks: [{ acceptanceCriterionRefs: ["AC 1"] }],
			},
		] as never);

		const result = await draftTestCasesForFeature(input);

		expect(bulkCreateTestCases).not.toHaveBeenCalled();
		expect(result?.status).toBe("DRAFTED");
		expect(result?.caseIds).toEqual([]);
		// Reported, not silently swallowed: "generated 1, created 0" is what the
		// person who pressed the button needs to see.
		expect(result?.skippedDuplicates).toEqual([
			"Org data is not visible from a personal workspace",
		]);
	});

	it("still creates a genuinely new case alongside an existing one", async () => {
		// The failure that would matter: an over-eager rule dropping real
		// coverage. Similar subject, different assertion — it must survive.
		vi.mocked(draftTestCases).mockResolvedValue([drafted()] as never);
		vi.mocked(db.testCase.findMany).mockResolvedValue([
			{
				title: "Something entirely unrelated",
				workItemLinks: [{ acceptanceCriterionRefs: ["AC 1"] }],
			},
		] as never);

		const result = await draftTestCasesForFeature(input);

		expect(bulkCreateTestCases).toHaveBeenCalledTimes(1);
		expect(result?.skippedDuplicates).toBeUndefined();
	});

	it("scopes the feature lookup to the project", async () => {
		// The activity runs in a worker with no request context, so it re-applies
		// the project scope itself rather than trusting the id it was handed.
		vi.mocked(draftTestCases).mockResolvedValue([drafted()] as never);

		await draftTestCasesForFeature(input);

		expect(db.userStory.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "s1", projectId: "p1" } }),
		);
	});

	it("reports a story outside the project as NOT_FOUND without billing a generation", async () => {
		vi.mocked(db.userStory.findFirst).mockResolvedValue(null as never);

		await expect(draftTestCasesForFeature(input)).resolves.toMatchObject({
			status: "NOT_FOUND",
			caseIds: [],
		});
		expect(draftTestCases).not.toHaveBeenCalled();
	});

	it("skips a feature with no acceptance criteria before billing a generation", async () => {
		// Acceptance criteria are the drafting contract — without them the model
		// has nothing falsifiable to test and invents junk.
		for (const acceptanceCriteria of [null, "", "   "]) {
			vi.mocked(db.userStory.findFirst).mockResolvedValue({
				...storyWithAcs,
				acceptanceCriteria,
			} as never);

			await expect(
				draftTestCasesForFeature(input),
			).resolves.toMatchObject({ status: "NO_ACCEPTANCE_CRITERIA" });
		}
		expect(draftTestCases).not.toHaveBeenCalled();
		expect(bulkCreateTestCases).not.toHaveBeenCalled();
	});

	it("returns null without billing when the job was cancelled while queued", async () => {
		// Cancel-before-spend: Stop pressed while this activity sat in the task
		// queue — the generation must not be billed for a dead run.
		vi.mocked(db.testCaseDraftJob.findFirst).mockResolvedValue({
			status: "CANCELLED",
		} as never);

		await expect(draftTestCasesForFeature(input)).resolves.toBeNull();
		expect(draftTestCases).not.toHaveBeenCalled();
		expect(bulkCreateTestCases).not.toHaveBeenCalled();
	});

	it("returns null without persisting when the job was cancelled during the generation", async () => {
		// THE live-observed leak: cancel landed while the model was generating;
		// the old code appended the cases anyway, 20s after the user was told
		// the run was cancelled. The generation is a sunk cost — the cases must
		// not land.
		vi.mocked(db.testCaseDraftJob.findFirst)
			.mockResolvedValueOnce({ status: "RUNNING" } as never)
			.mockResolvedValueOnce({ status: "CANCELLED" } as never);
		vi.mocked(draftTestCases).mockResolvedValue([drafted()] as never);

		await expect(draftTestCasesForFeature(input)).resolves.toBeNull();
		expect(draftTestCases).toHaveBeenCalledTimes(1);
		expect(bulkCreateTestCases).not.toHaveBeenCalled();
	});

	it("treats a vanished job row as not live", async () => {
		vi.mocked(db.testCaseDraftJob.findFirst).mockResolvedValue(
			null as never,
		);

		await expect(draftTestCasesForFeature(input)).resolves.toBeNull();
		expect(draftTestCases).not.toHaveBeenCalled();
	});

	it("sizes maxTestCases to the criteria count, floored at the default cap", async () => {
		vi.mocked(draftTestCases).mockResolvedValue([drafted()] as never);

		// 3 criteria (the mock's count) < 12 → the default cap holds.
		await draftTestCasesForFeature(input);
		expect(vi.mocked(draftTestCases).mock.calls[0][0].maxTestCases).toBe(
			12,
		);

		// 15 criteria → the cap rises to the count so per-criterion coverage
		// stays satisfiable.
		vi.mocked(countAcceptanceCriteria).mockReturnValue(15);
		await draftTestCasesForFeature(input);
		expect(vi.mocked(draftTestCases).mock.calls[1][0].maxTestCases).toBe(
			15,
		);
	});

	it("persists preconditions into description and the AC ref onto the work-item link", async () => {
		vi.mocked(draftTestCases).mockResolvedValue([drafted()] as never);

		await draftTestCasesForFeature(input);

		expect(bulkCreateTestCases).toHaveBeenCalledTimes(1);
		const cases = vi.mocked(bulkCreateTestCases).mock.calls[0][0].cases;
		expect(cases[0]).toMatchObject({
			// `TestCase.description` IS the preconditions column.
			description: "Org Acme has quota 5; signed in as an Admin of Acme",
			state: "DRAFT",
			// The link column is the PLURAL `acceptanceCriterionRefs`. Writing
			// the legacy singular key here once passed tsc (excess-property
			// checks die through `.map()`) while storing no criterion on any
			// link — coverage read 0% after every successful draft run.
			workItemLinks: [
				{ userStoryId: "s1", acceptanceCriterionRefs: ["AC 1"] },
			],
		});
	});

	it("writes an empty refs array when the model names no criterion", async () => {
		// The drafter may decline to name one. The link still has to be written
		// with an explicit empty array — `normaliseCriterionRefs(undefined)`
		// would also store [], but the shape this sends is what the writer sees.
		vi.mocked(draftTestCases).mockResolvedValue([
			drafted({ acceptanceCriterionRef: null }),
		] as never);

		await draftTestCasesForFeature(input);

		const cases = vi.mocked(bulkCreateTestCases).mock.calls[0][0].cases;
		expect(cases[0].workItemLinks).toEqual([
			{ userStoryId: "s1", acceptanceCriterionRefs: [] },
		]);
	});

	it("dedupes against an existing link that covers several criteria", async () => {
		// A stored link can name more than one criterion. A re-draft naming any
		// of them must find it — matching only the first ref would append a
		// near-duplicate on every re-run.
		vi.mocked(draftTestCases).mockResolvedValue([drafted()] as never);
		vi.mocked(db.testCase.findMany).mockResolvedValue([
			{
				title: "Verify org data is NOT visible from a personal workspace.",
				workItemLinks: [{ acceptanceCriterionRefs: ["AC 2", "AC 1"] }],
			},
		] as never);

		const result = await draftTestCasesForFeature(input);

		expect(bulkCreateTestCases).not.toHaveBeenCalled();
		expect(result?.skippedDuplicates).toEqual([
			"Org data is not visible from a personal workspace",
		]);
	});

	it("carries the model's priority through instead of flattening it to MEDIUM", async () => {
		vi.mocked(draftTestCases).mockResolvedValue([
			drafted({ priority: "CRITICAL" }),
			drafted({ title: "Label renders", priority: "LOW" }),
		] as never);

		await draftTestCasesForFeature(input);

		const cases = vi.mocked(bulkCreateTestCases).mock.calls[0][0].cases;
		expect(cases.map((c) => c.priority)).toEqual(["CRITICAL", "LOW"]);
	});

	it("nulls an empty precondition rather than writing an empty string", async () => {
		vi.mocked(draftTestCases).mockResolvedValue([
			drafted({ preconditions: "" }),
		] as never);

		await draftTestCasesForFeature(input);

		const cases = vi.mocked(bulkCreateTestCases).mock.calls[0][0].cases;
		expect(cases[0].description).toBeNull();
	});

	it("stamps the tenant scope it was handed onto every case it writes", async () => {
		vi.mocked(draftTestCases).mockResolvedValue([drafted()] as never);

		await draftTestCasesForFeature({ ...input, organizationId: "org1" });

		expect(bulkCreateTestCases).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org1",
				userId: "u1",
				projectId: "p1",
			}),
		);
	});

	it("records WHICH version of the feature text it drafted from", async () => {
		// Without this stamp a case can never be told apart from the feature as it
		// stands later, so the suite goes on asserting a flow the product no
		// longer has — coverage that reads as coverage.
		vi.mocked(draftTestCases).mockResolvedValue([drafted()] as never);

		await draftTestCasesForFeature(input);

		expect(bulkCreateTestCases).toHaveBeenCalledWith(
			expect.objectContaining({ draftedFromSpecHash: "spec-hash" }),
		);
	});

	it("records a genuine generation failure with the provider's reason instead of throwing", async () => {
		// A failing feature must not abort the batch — it becomes a recorded
		// outcome the run reports, and Temporal never sees a throw to retry
		// (which would re-bill the generation).
		vi.mocked(draftTestCases).mockRejectedValue(
			new Error("credit balance too low"),
		);

		await expect(draftTestCasesForFeature(input)).resolves.toMatchObject({
			status: "FAILED",
			error: "credit balance too low",
			caseIds: [],
		});
		expect(bulkCreateTestCases).not.toHaveBeenCalled();
	});

	it("does not put this deployment's key management in front of the user", async () => {
		// Staging surfaced this verbatim in a product toast: "Couldn't draft:
		// Feature 1 failed to generate: Encryption key version "2" not found in
		// ENCRYPTION_KEYS (key may have been retired)." Every part of that is
		// either useless to the user or useful to an attacker, and it fails
		// BEFORE the model call, so no retry they can perform will help.
		vi.mocked(draftTestCases).mockRejectedValue(
			new Error(
				'Encryption key version "2" not found in ENCRYPTION_KEYS (key may have been retired)',
			),
		);

		const result = await draftTestCasesForFeature(input);

		expect(result?.status).toBe("FAILED");
		expect(result?.error).not.toMatch(/ENCRYPTION_KEYS/);
		expect(result?.error).not.toMatch(/key version/i);
		expect(result?.error).toMatch(/administrator/i);
		// Says the money question out loud, because the user cannot tell from a
		// failure whether they were charged for it.
		expect(result?.error).toMatch(/nothing was billed/i);
	});

	it("logs the raw failure even though the user never sees it", async () => {
		// These fail before the model is constructed, so they are billed nothing
		// and never reach the AI usage ledger. Without a log line a fully broken
		// drafting path is invisible to anything watching spend.
		vi.mocked(draftTestCases).mockRejectedValue(
			new Error(
				'Encryption key version "2" not found in ENCRYPTION_KEYS',
			),
		);

		await draftTestCasesForFeature(input);

		expect(logger.error).toHaveBeenCalledWith(
			"qa.test_cases.draft_failed",
			expect.objectContaining({
				error: expect.stringContaining("ENCRYPTION_KEYS"),
			}),
		);
	});

	it("redacts the error the encryption module ACTUALLY throws, not a copy of it", async () => {
		// The two tests above hand-write the failure string. That proves the
		// activity handles a message shaped like the real one — it cannot prove
		// the real one is still shaped that way. Reword
		// `getKeyMaterialByVersion`'s throw and the redaction silently stops
		// matching while every hand-written test stays green, which is exactly
		// how this reached a product toast in the first place.
		//
		// So produce the failure for real: encrypt under a versioned key, take
		// the key away, and let `decryptApiKey` raise its own error.
		const savedKeys = process.env.ENCRYPTION_KEYS;
		const savedActive = process.env.ENCRYPTION_ACTIVE_KEY_VERSION;
		let realError: unknown;
		try {
			process.env.ENCRYPTION_KEYS = JSON.stringify({
				"2": "k".repeat(64),
			});
			process.env.ENCRYPTION_ACTIVE_KEY_VERSION = "2";
			const ciphertext = encryptApiKey("sk-provider-key");
			expect(ciphertext.startsWith("k2:")).toBe(true);

			// The retirement the message hypothesises, performed for real.
			process.env.ENCRYPTION_KEYS = "{}";
			realError = (() => {
				try {
					decryptApiKey(ciphertext);
					return null;
				} catch (error) {
					return error;
				}
			})();
		} finally {
			restoreEnv("ENCRYPTION_KEYS", savedKeys);
			restoreEnv("ENCRYPTION_ACTIVE_KEY_VERSION", savedActive);
		}

		expect(realError).toBeInstanceOf(Error);
		vi.mocked(draftTestCases).mockRejectedValue(realError);

		const result = await draftTestCasesForFeature(input);

		expect(result?.status).toBe("FAILED");
		expect(result?.error).not.toMatch(/ENCRYPTION_KEYS/);
		expect(result?.error).not.toMatch(/key version/i);
		expect(result?.error).toMatch(/administrator/i);
		// And the operator still gets the real thing, verbatim.
		expect(logger.error).toHaveBeenCalledWith(
			"qa.test_cases.draft_failed",
			expect.objectContaining({
				error: (realError as Error).message,
			}),
		);
	});

	it("redacts internal shapes from an otherwise passed-through provider message", async () => {
		vi.mocked(draftTestCases).mockRejectedValue(
			new Error(
				"upstream refused: see https://internal.example.invalid/trace/9 (FABRIC_SECRET_TOKEN missing)",
			),
		);

		const result = await draftTestCasesForFeature(input);

		expect(result?.error).not.toMatch(/internal\.example\.invalid/);
		expect(result?.error).not.toMatch(/FABRIC_SECRET_TOKEN/);
		// The provider's own words survive — that half IS actionable.
		expect(result?.error).toMatch(/upstream refused/);
	});

	it("redacts a huge provider message without stalling the event loop", async () => {
		// The stack-frame pattern is quadratic on repeated "at fn (" with no
		// closing paren: ~37ms at 30K chars, ~3.6s at 300K. This activity's own
		// 15s heartbeat runs on the same event loop, so an unbounded redaction
		// turns a cheap failure into a heartbeat timeout and a retry. The input
		// is bounded before redaction, so this must stay fast.
		vi.mocked(draftTestCases).mockRejectedValue(
			new Error("at fn (".repeat(60_000)),
		);

		const started = Date.now();
		const result = await draftTestCasesForFeature(input);
		const elapsed = Date.now() - started;

		expect(result?.status).toBe("FAILED");
		// Generous by 2 orders of magnitude against the ~3.6s unbounded case —
		// this asserts "bounded", not a benchmark that flakes on a slow machine.
		expect(elapsed).toBeLessThan(1000);
		expect((result?.error ?? "").length).toBeLessThanOrEqual(301);
	});

	it("falls back to a usable sentence when redaction eats the whole message", async () => {
		// A bare stack frame redacts to nothing, and "failed to generate: "
		// reads as a broken product rather than a failed run.
		vi.mocked(draftTestCases).mockRejectedValue(
			new Error("at handler (/srv/app/dist/worker/index.js:12:9)"),
		);

		const result = await draftTestCasesForFeature(input);

		expect(result?.error).toBe("AI generation failed. Please try again.");
	});

	it("reports the no-provider case as its own advisory outcome, not a failure", async () => {
		// `draftTestCases` returns null (not throws) when no provider is
		// configured — telling the user to configure one they already have would
		// be the wrong message.
		vi.mocked(draftTestCases).mockResolvedValue(null as never);

		await expect(draftTestCasesForFeature(input)).resolves.toMatchObject({
			status: "NO_AI_PROVIDER",
		});
		expect(bulkCreateTestCases).not.toHaveBeenCalled();
	});

	it("distinguishes a model that produced nothing usable from a missing provider", async () => {
		vi.mocked(draftTestCases).mockResolvedValue([] as never);

		await expect(draftTestCasesForFeature(input)).resolves.toMatchObject({
			status: "NO_CASES",
		});
		expect(bulkCreateTestCases).not.toHaveBeenCalled();
	});

	it("returns the ids it created so the run can address the batch afterwards", async () => {
		vi.mocked(draftTestCases).mockResolvedValue([drafted()] as never);
		vi.mocked(bulkCreateTestCases).mockResolvedValue([
			created("tc1"),
			created("tc2"),
		] as never);

		await expect(draftTestCasesForFeature(input)).resolves.toMatchObject({
			status: "DRAFTED",
			storyIdentifier: "F-012",
			caseIds: ["tc1", "tc2"],
		});
	});
});
