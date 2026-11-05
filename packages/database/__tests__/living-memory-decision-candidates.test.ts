/**
 * Living Memory decision candidates, as the Decisions tab reads them.
 *
 * Only each file's CURRENT version is offered (the extraction whose hash
 * equals the context's); entries already turned into decisions or dismissed
 * are not offered again; and a candidate that reads like an existing decision
 * names it, so the tab can offer "Create as update".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	extractionFindMany: vi.fn(),
	extractionFindFirst: vi.fn(),
	extractionUpdate: vi.fn(),
	decisionFindMany: vi.fn(),
	transaction: vi.fn(),
	txExecuteRaw: vi.fn(),
	txDecisionFindMany: vi.fn(),
	txDecisionFindFirst: vi.fn(),
	txDecisionCreate: vi.fn(),
	txVersionCreate: vi.fn(),
	contextFindMany: vi.fn(),
	contextUpdateMany: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		projectContextDecisionExtraction: {
			findMany: mocks.extractionFindMany,
			findFirst: mocks.extractionFindFirst,
			update: mocks.extractionUpdate,
		},
		architectureDecision: { findMany: mocks.decisionFindMany },
		projectContext: {
			findMany: mocks.contextFindMany,
			updateMany: mocks.contextUpdateMany,
		},
		$transaction: mocks.transaction,
	},
}));

import {
	clearLivingMemoryDecisionScanSkip,
	countLivingMemoryFilesSkippedAtFirstSync,
	createDecisionFromLivingMemoryCandidate,
	dismissLivingMemoryDecision,
	getLivingMemoryDecisionCandidate,
	listLivingMemoryDecisionCandidates,
	listLivingMemoryFilesSkippedAtFirstSync,
	livingMemoryUpdateTargetId,
	summarizeOpenLivingMemoryDecisions,
} from "../prisma/queries/projects/living-memory-decisions";

const CURRENT = "a".repeat(64);
const OLDER = "b".repeat(64);
const EXTRACTED_AT = new Date("2026-11-04T10:00:00.000Z");

const currentExtraction = {
	id: "ext-current",
	contextId: "ctx-1",
	contentHash: CURRENT,
	sourcePath: "docs/architecture.md",
	extractedAt: EXTRACTED_AT,
	decisions: [
		{
			text: "We use Postgres for all persistence.",
			rationale: "One store.",
		},
		{ text: "We deploy every Wednesday." },
		{ text: "We review every pull request." },
		{ text: "We keep a changelog for every release." },
	],
	dismissedIndexes: [2],
	context: { contentHash: CURRENT },
};

const olderExtraction = {
	...currentExtraction,
	id: "ext-older",
	contentHash: OLDER,
	decisions: [{ text: "We use MySQL." }],
	dismissedIndexes: [],
};

/** Calls of `architectureDecision.findMany` whose `where` names a sourceKind. */
function decisionsMock(
	existing: Array<Record<string, unknown>>,
	converted: Array<Record<string, unknown>>,
) {
	mocks.decisionFindMany.mockImplementation(
		async ({ where }: { where: { sourceKind?: string } }) =>
			where.sourceKind ? converted : existing,
	);
}

beforeEach(() => {
	for (const fn of Object.values(mocks)) {
		fn.mockReset();
	}
	mocks.extractionFindMany.mockResolvedValue([
		currentExtraction,
		olderExtraction,
	]);
	decisionsMock(
		[
			{
				id: "dec-1",
				identifier: "ADR-001",
				title: "Postgres for persistence",
				decision: "We use Postgres for all persistence.",
			},
		],
		[
			{
				sourceMetadata: {
					contextId: "ctx-1",
					contentHash: CURRENT,
					index: 3,
				},
			},
		],
	);
});

describe("summarizeOpenLivingMemoryDecisions", () => {
	it("agrees with what the tab lists: current versions only, minus settled entries", async () => {
		const input = { projectId: "proj", organizationId: "org" };

		await expect(
			summarizeOpenLivingMemoryDecisions(input),
		).resolves.toEqual({
			candidateCount: (await listLivingMemoryDecisionCandidates(input))
				.length,
			fileCount: 1,
		});
		await expect(
			summarizeOpenLivingMemoryDecisions(input),
		).resolves.toMatchObject({ candidateCount: 2 });
	});

	it("does not count a file whose entries are all settled", async () => {
		mocks.extractionFindMany.mockResolvedValue([
			{
				...currentExtraction,
				contextId: "ctx-2",
				decisions: [{ text: "We ship on Fridays." }],
				dismissedIndexes: [0],
			},
		]);

		await expect(
			summarizeOpenLivingMemoryDecisions({ projectId: "proj" }),
		).resolves.toEqual({ candidateCount: 0, fileCount: 0 });
	});
});

describe("listLivingMemoryDecisionCandidates", () => {
	it("offers the current version only, minus converted and dismissed entries", async () => {
		const candidates = await listLivingMemoryDecisionCandidates({
			projectId: "proj",
			organizationId: "org",
		});

		expect(
			candidates.map((c) => [c.extractionId, c.decisionIndex]),
		).toEqual([
			["ext-current", 0],
			["ext-current", 1],
		]);
		expect(candidates[1]).toEqual({
			extractionId: "ext-current",
			contextId: "ctx-1",
			contentHash: CURRENT,
			sourcePath: "docs/architecture.md",
			extractedAt: EXTRACTED_AT,
			decisionIndex: 1,
			text: "We deploy every Wednesday.",
		});
		expect(mocks.extractionFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { projectId: "proj", organizationId: "org" },
			}),
		);
	});

	it("names the existing decision a candidate most likely updates", async () => {
		const [first] = await listLivingMemoryDecisionCandidates({
			projectId: "proj",
			organizationId: "org",
		});

		expect(first?.rationale).toBe("One store.");
		expect(first?.matchedDecision).toEqual({
			id: "dec-1",
			identifier: "ADR-001",
			title: "Postgres for persistence",
		});
	});

	it("does not offer again a decision converted or dismissed in an earlier version of the file", async () => {
		mocks.extractionFindMany.mockResolvedValue([
			currentExtraction,
			{
				...olderExtraction,
				decisions: [
					{ text: "We use MySQL." },
					{ text: "we deploy  every Wednesday." },
					{ text: "We use Postgres for all persistence." },
				],
				dismissedIndexes: [1],
			},
		]);
		decisionsMock(
			[],
			[
				{
					sourceMetadata: {
						contextId: "ctx-1",
						contentHash: OLDER,
						index: 2,
					},
				},
			],
		);

		const candidates = await listLivingMemoryDecisionCandidates({
			projectId: "proj",
			organizationId: "org",
		});

		// 0 was converted and 1 dismissed in the older version; 2 is dismissed
		// in this one; 3 is no longer converted in this fixture.
		expect(candidates.map((c) => c.decisionIndex)).toEqual([3]);
	});

	it("still offers the same text when it was settled in another file", async () => {
		mocks.extractionFindMany.mockResolvedValue([
			currentExtraction,
			{
				...olderExtraction,
				contextId: "ctx-2",
				decisions: [{ text: "We deploy every Wednesday." }],
				dismissedIndexes: [0],
				context: { contentHash: OLDER },
			},
		]);

		const candidates = await listLivingMemoryDecisionCandidates({
			projectId: "proj",
			organizationId: "org",
		});

		expect(candidates.map((c) => [c.contextId, c.decisionIndex])).toEqual([
			["ctx-1", 0],
			["ctx-1", 1],
		]);
	});

	it("is empty, not an error, for a project with no synced files", async () => {
		mocks.extractionFindMany.mockResolvedValue([]);

		await expect(
			listLivingMemoryDecisionCandidates({
				projectId: "proj",
				organizationId: null,
			}),
		).resolves.toEqual([]);
		expect(mocks.extractionFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { projectId: "proj", organizationId: null },
			}),
		);
	});
});

describe("getLivingMemoryDecisionCandidate", () => {
	const lookup = {
		projectId: "proj",
		organizationId: "org",
		extractionId: "ext-current",
		decisionIndex: 1,
	};

	it("finds a current, unconverted candidate", async () => {
		mocks.extractionFindFirst.mockResolvedValue(currentExtraction);

		await expect(getLivingMemoryDecisionCandidate(lookup)).resolves.toEqual(
			{
				status: "found",
				candidate: expect.objectContaining({
					text: "We deploy every Wednesday.",
					contentHash: CURRENT,
				}),
			},
		);
	});

	it("refuses a candidate from a version the file no longer holds", async () => {
		mocks.extractionFindFirst.mockResolvedValue({
			...currentExtraction,
			context: { contentHash: OLDER },
		});

		await expect(getLivingMemoryDecisionCandidate(lookup)).resolves.toEqual(
			{ status: "stale" },
		);
	});

	it("refuses a candidate already turned into a decision", async () => {
		mocks.extractionFindFirst.mockResolvedValue(currentExtraction);

		await expect(
			getLivingMemoryDecisionCandidate({ ...lookup, decisionIndex: 3 }),
		).resolves.toEqual({ status: "converted" });
	});

	it("answers not_found for an index past the list", async () => {
		mocks.extractionFindFirst.mockResolvedValue(currentExtraction);

		await expect(
			getLivingMemoryDecisionCandidate({ ...lookup, decisionIndex: 9 }),
		).resolves.toEqual({ status: "not_found" });
	});
});

describe("createDecisionFromLivingMemoryCandidate", () => {
	const candidate = {
		contextId: "ctx-1",
		contentHash: CURRENT,
		decisionIndex: 1,
	};
	const decisionInput = {
		projectId: "proj",
		createdById: "user-1",
		editedByName: "Reviewer",
		title: "Weekly deploys",
		contextProblem: "Captured from a Living Memory file.",
		decision: "We deploy every Wednesday.",
		rationale: "",
		sourceKind: "living_memory",
		sourceMetadata: {
			contextId: "ctx-1",
			contentHash: CURRENT,
			index: 1,
		},
		userId: "user-1",
		organizationId: "org",
	};
	/** Decisions committed so far, as a fresh transaction would read them. */
	let committed: Array<{ sourceMetadata: unknown }>;

	beforeEach(() => {
		committed = [];
		const tx = {
			$executeRaw: mocks.txExecuteRaw,
			architectureDecision: {
				findMany: mocks.txDecisionFindMany,
				findFirst: mocks.txDecisionFindFirst,
				create: mocks.txDecisionCreate,
			},
			architectureDecisionVersion: { create: mocks.txVersionCreate },
		};
		mocks.transaction.mockImplementation(
			async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
		);
		mocks.txDecisionFindMany.mockImplementation(async () => committed);
		mocks.txDecisionFindFirst.mockResolvedValue({ identifier: "ADR-004" });
		mocks.txDecisionCreate.mockImplementation(
			async ({ data }: { data: { sourceMetadata: unknown } }) => {
				committed.push({ sourceMetadata: data.sourceMetadata });
				return { id: "dec-new", identifier: "ADR-005", ...data };
			},
		);
	});

	it("creates the decision under a lock on the candidate", async () => {
		const result = await createDecisionFromLivingMemoryCandidate(
			candidate,
			decisionInput,
		);

		expect(result).toMatchObject({
			status: "created",
			decision: { id: "dec-new", identifier: "ADR-005" },
		});
		expect(mocks.txExecuteRaw).toHaveBeenCalledTimes(1);
		expect(mocks.txExecuteRaw.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.txDecisionFindMany.mock.invocationCallOrder[0]!,
		);
		expect(mocks.txDecisionFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					projectId: "proj",
					sourceKind: "living_memory",
				}),
			}),
		);
		expect(mocks.txVersionCreate).toHaveBeenCalledTimes(1);
	});

	it("answers converted to a second request for the same candidate and creates nothing more", async () => {
		await createDecisionFromLivingMemoryCandidate(candidate, decisionInput);
		const second = await createDecisionFromLivingMemoryCandidate(
			candidate,
			decisionInput,
		);

		expect(second).toEqual({ status: "converted" });
		expect(mocks.txDecisionCreate).toHaveBeenCalledTimes(1);
		expect(mocks.txExecuteRaw).toHaveBeenCalledTimes(2);
	});
});

describe("dismissLivingMemoryDecision", () => {
	const input = {
		projectId: "proj",
		organizationId: "org",
		extractionId: "ext-current",
		decisionIndex: 1,
	};

	it("records the dismissed index, scoped to the project and tenant", async () => {
		mocks.extractionFindFirst.mockResolvedValue(currentExtraction);

		await expect(dismissLivingMemoryDecision(input)).resolves.toBe(true);
		expect(mocks.extractionFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "ext-current",
					projectId: "proj",
					organizationId: "org",
				},
			}),
		);
		expect(mocks.extractionUpdate).toHaveBeenCalledWith({
			where: { id: "ext-current" },
			data: { dismissedIndexes: { push: 1 } },
		});
	});

	it("answers false for an extraction outside the project", async () => {
		mocks.extractionFindFirst.mockResolvedValue(null);

		await expect(dismissLivingMemoryDecision(input)).resolves.toBe(false);
		expect(mocks.extractionUpdate).not.toHaveBeenCalled();
	});
});

describe("livingMemoryUpdateTargetId", () => {
	const kind = "living_memory";

	it("reads the decision a Living Memory update replaces", () => {
		expect(
			livingMemoryUpdateTargetId({
				sourceKind: kind,
				sourceMetadata: { supersedes: "dec-1" },
			}),
		).toBe("dec-1");
	});

	it.each([
		[{ sourceKind: kind, sourceMetadata: {} }],
		[{ sourceKind: kind, sourceMetadata: null }],
		[{ sourceKind: kind, sourceMetadata: ["dec-1"] }],
		[{ sourceKind: kind, sourceMetadata: { supersedes: 7 } }],
		[{ sourceKind: "meeting", sourceMetadata: { supersedes: "dec-1" } }],
		[{ sourceKind: null, sourceMetadata: { supersedes: "dec-1" } }],
	])("is null for anything else: %j", (decision) => {
		expect(livingMemoryUpdateTargetId(decision)).toBeNull();
	});
});

describe("files a repository's first sync did not read", () => {
	it("counts only versions still unread, in the caller's tenant", async () => {
		mocks.contextFindMany.mockResolvedValue([
			{ contentHash: CURRENT, decisionScanSkippedHash: CURRENT },
			{ contentHash: CURRENT, decisionScanSkippedHash: OLDER },
		]);

		await expect(
			countLivingMemoryFilesSkippedAtFirstSync({
				projectId: "p-1",
				organizationId: "org-1",
			}),
		).resolves.toBe(1);
		expect(mocks.contextFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					projectId: "p-1",
					organizationId: "org-1",
					decisionScanSkippedHash: { not: null },
					indexingExcluded: false,
				},
			}),
		);
	});

	it("pages by id after the cursor", async () => {
		mocks.contextFindMany.mockResolvedValue([]);

		await listLivingMemoryFilesSkippedAtFirstSync({
			projectId: "p-1",
			organizationId: "org-1",
			afterId: "c-5",
			limit: 20,
		});

		expect(mocks.contextFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: { gt: "c-5" } }),
				orderBy: { id: "asc" },
				take: 20,
			}),
		);
	});

	it("clears one file by its id, project and tenant", async () => {
		mocks.contextUpdateMany.mockResolvedValue({ count: 1 });

		await clearLivingMemoryDecisionScanSkip({
			id: "c-1",
			projectId: "p-1",
			organizationId: "org-1",
		});

		expect(mocks.contextUpdateMany).toHaveBeenCalledWith({
			where: { id: "c-1", projectId: "p-1", organizationId: "org-1" },
			data: { decisionScanSkippedHash: null },
		});
	});
});
