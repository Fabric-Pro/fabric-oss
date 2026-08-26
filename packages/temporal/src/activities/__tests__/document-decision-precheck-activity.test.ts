/**
 * Behavioral tests for `runDocumentDecisionPrecheckActivity`.
 *
 * The doc contradiction banner's freshness gate is
 * `precheck.checkedContentHash === currentContentHash`, where `currentContentHash`
 * is now recomputed from the live content on every read (see
 * `getDocumentById` → `computeDocumentContentHash`) rather than read from the
 * embed-owned `contentHash` column. So this activity:
 *   - stores `decisionPrecheck.checkedContentHash` and NEVER writes `contentHash`
 *     (the embed step keeps sole ownership of that column), and
 *   - persists via a content-guarded `updateMany` so a superseded run (an older
 *     workflow TERMINATE_EXISTING-d but whose activity kept running) matches 0
 *     rows and no-ops instead of clobbering a newer run's findings.
 *
 * `@repo/database` (real `computeDocumentContentHash` kept) and the pre-check
 * module are mocked; `generateContentHash` (`@repo/rag`) runs for real, so the
 * persisted `checkedContentHash` is asserted equal to the exact value the read
 * path (`computeDocumentContentHash`) computes for the banner comparison.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		findUnique: vi.fn(),
		updateMany: vi.fn(),
		runDecisionPrecheck: vi.fn(),
	},
}));

// Partial mock: keep every real `@repo/database` export (transitive packages
// wire themselves up at import — e.g. `@repo/payments`' `setAiUsageRecorder`, and
// the real `computeDocumentContentHash` we assert against) and only swap the
// `db.projectDocument` reads/writes the activity touches.
vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return {
		...actual,
		db: {
			projectDocument: {
				findUnique: (...args: unknown[]) => mocks.findUnique(...args),
				updateMany: (...args: unknown[]) => mocks.updateMany(...args),
			},
		},
	};
});

vi.mock("../../lib/decision-precheck", () => ({
	runDecisionPrecheck: (...args: unknown[]) =>
		mocks.runDecisionPrecheck(...args),
}));

const { computeDocumentContentHash } = await import("@repo/database");
const { runDocumentDecisionPrecheckActivity } = await import(
	"../project-document-generation"
);

const params = {
	documentId: "doc-1",
	projectId: "project-1",
	userId: "user-1",
	organizationId: "org-1",
};

const CONTENT = "Adopt MongoDB as the primary datastore.";

const conflictResult = {
	checkedAt: "2020-01-01T00:00:00.000Z",
	status: "conflicts" as const,
	findings: [
		{
			decisionId: "dec-1",
			decisionIdentifier: "ADR-012",
			decisionTitle: "Use Postgres",
			natureOfConflict: "Proposes MongoDB",
			conflictType: "violates_accepted" as const,
			confidence: 0.9,
		},
	],
};

beforeEach(() => {
	mocks.findUnique.mockReset();
	mocks.updateMany.mockReset();
	mocks.runDecisionPrecheck.mockReset();
	mocks.updateMany.mockResolvedValue({ count: 1 });
	mocks.runDecisionPrecheck.mockResolvedValue(conflictResult);
});

const updateCall = () =>
	mocks.updateMany.mock.calls[0]?.[0] as {
		where: Record<string, unknown>;
		data: Record<string, unknown>;
	};

describe("runDocumentDecisionPrecheckActivity", () => {
	it("persists via a content-guarded updateMany and never writes contentHash", async () => {
		mocks.findUnique.mockResolvedValue({ content: CONTENT });

		await runDocumentDecisionPrecheckActivity(params);

		expect(mocks.updateMany).toHaveBeenCalledTimes(1);
		const { where, data } = updateCall();

		// Superseded-run guard: the write is conditioned on the row still holding
		// exactly the content that was judged.
		expect(where).toEqual({ id: "doc-1", content: CONTENT });

		const precheck = data.decisionPrecheck as {
			checkedContentHash: string;
		};
		// The stored hash equals the value the read path computes for the banner
		// comparison — decoupled from (and never touching) `contentHash`.
		expect(precheck.checkedContentHash).toBe(
			computeDocumentContentHash(CONTENT),
		);
		expect("contentHash" in data).toBe(false);
	});

	it("no-ops without throwing when the content changed since it was judged (superseded run)", async () => {
		mocks.findUnique.mockResolvedValue({ content: CONTENT });
		// A newer run replaced the content, so the content-guarded write matches
		// no rows and must not clobber the newer findings.
		mocks.updateMany.mockResolvedValue({ count: 0 });

		await expect(
			runDocumentDecisionPrecheckActivity(params),
		).resolves.toBeUndefined();

		expect(mocks.updateMany).toHaveBeenCalledTimes(1);
		expect(updateCall().where).toEqual({ id: "doc-1", content: CONTENT });
	});

	it("skips empty content without writing", async () => {
		mocks.findUnique.mockResolvedValue({ content: "   " });

		await runDocumentDecisionPrecheckActivity(params);

		expect(mocks.runDecisionPrecheck).not.toHaveBeenCalled();
		expect(mocks.updateMany).not.toHaveBeenCalled();
	});

	it("swallows a persistence failure (never throws) and leaves the document untouched", async () => {
		mocks.findUnique.mockResolvedValue({ content: CONTENT });
		mocks.updateMany.mockRejectedValue(new Error("db down"));

		await expect(
			runDocumentDecisionPrecheckActivity(params),
		).resolves.toBeUndefined();
	});
});
