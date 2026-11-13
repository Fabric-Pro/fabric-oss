/**
 * Living Memory decision candidates, as the Decisions tab reads them.
 *
 * Only each file's CURRENT version is offered (the extraction whose hash
 * equals the context's); entries already turned into decisions or dismissed
 * are not offered again; a candidate that reads like an existing decision
 * names it, so the tab can offer "Create as update"; a candidate links the
 * work item it came from only while the project still has it; and the files a
 * scan reads, and the files only partly read, are the ones the tab names.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	extractionFindMany: vi.fn(),
	extractionFindFirst: vi.fn(),
	extractionUpdate: vi.fn(),
	decisionFindMany: vi.fn(),
	storyFindMany: vi.fn(),
	transaction: vi.fn(),
	txExecuteRaw: vi.fn(),
	txDecisionFindMany: vi.fn(),
	txDecisionFindFirst: vi.fn(),
	txDecisionCreate: vi.fn(),
	txVersionCreate: vi.fn(),
	contextUpdateMany: vi.fn(),
	queryRaw: vi.fn(),
}));

/** A `Prisma.sql` fragment as the mock below builds it. */
type SqlFragment = { strings: readonly string[]; values: unknown[] };

vi.mock("../prisma/client", () => ({
	db: {
		projectContextDecisionExtraction: {
			findMany: mocks.extractionFindMany,
			findFirst: mocks.extractionFindFirst,
			update: mocks.extractionUpdate,
		},
		architectureDecision: { findMany: mocks.decisionFindMany },
		userStory: { findMany: mocks.storyFindMany },
		projectContext: { updateMany: mocks.contextUpdateMany },
		$transaction: mocks.transaction,
		$queryRaw: (strings: readonly string[], ...values: unknown[]) =>
			mocks.queryRaw({ strings, values }),
	},
	Prisma: {
		sql: (strings: readonly string[], ...values: unknown[]) => ({
			strings,
			values,
		}),
		empty: { strings: [""], values: [] },
	},
}));

function isSqlFragment(value: unknown): value is SqlFragment {
	return (
		typeof value === "object" &&
		value !== null &&
		"strings" in value &&
		"values" in value
	);
}

/** A raw query's SQL, nested fragments inlined and parameters as `?`. */
function render(fragment: SqlFragment): { sql: string; params: unknown[] } {
	let sql = fragment.strings[0] ?? "";
	const params: unknown[] = [];
	fragment.values.forEach((value, index) => {
		if (isSqlFragment(value)) {
			const inner = render(value);
			sql += inner.sql;
			params.push(...inner.params);
		} else {
			sql += "?";
			params.push(value);
		}
		sql += fragment.strings[index + 1] ?? "";
	});
	return { sql: sql.replace(/\s+/g, " ").trim(), params };
}

/** The last raw query the code under test ran. */
function lastRawQuery(): { sql: string; params: unknown[] } {
	const call = mocks.queryRaw.mock.calls.at(-1)?.[0];
	if (!isSqlFragment(call)) {
		throw new Error("expected a raw query");
	}
	return render(call);
}

import {
	clearLivingMemoryDecisionScanSkip,
	countLivingMemoryFilesAwaitingDecisionScan,
	createDecisionFromLivingMemoryCandidate,
	dismissLivingMemoryDecision,
	getLivingMemoryDecisionCandidate,
	listLivingMemoryDecisionCandidates,
	listLivingMemoryFilesAwaitingDecisionScan,
	listLivingMemoryLimitedFiles,
	livingMemoryUpdateTargetId,
	parseLivingMemoryDecisions,
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

	describe("which decision a candidate is offered as an update of", () => {
		/** The real read's status filter, applied to one matching decision. */
		function matchingDecisionIs(status: string) {
			mocks.decisionFindMany.mockImplementation(
				async ({
					where,
				}: {
					where: {
						sourceKind?: string;
						status?: { in?: string[] };
					};
				}) => {
					if (where.sourceKind) {
						return [];
					}
					const row = {
						id: "dec-1",
						identifier: "ADR-001",
						title: "Postgres for persistence",
						decision: "We use Postgres for all persistence.",
						status,
					};
					return !where.status?.in || where.status.in.includes(status)
						? [row]
						: [];
				},
			);
		}

		it.each(["REJECTED", "DEPRECATED", "SUPERSEDED"])(
			"offers a statement matching a %s decision as new: accepting an update would change nothing",
			async (status) => {
				matchingDecisionIs(status);

				const [first] = await listLivingMemoryDecisionCandidates({
					projectId: "proj",
				});

				expect(first?.text).toBe(
					"We use Postgres for all persistence.",
				);
				expect(first).not.toHaveProperty("matchedDecision");
			},
		);

		it.each(["ACCEPTED", "PROPOSED"])(
			"offers a statement matching a %s decision as its update",
			async (status) => {
				matchingDecisionIs(status);

				const [first] = await listLivingMemoryDecisionCandidates({
					projectId: "proj",
				});

				expect(first?.matchedDecision?.id).toBe("dec-1");
			},
		);
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

	it("links the work item a candidate came from while the project still has it", async () => {
		mocks.extractionFindMany.mockResolvedValue([
			{
				...currentExtraction,
				decisions: [
					{
						text: "We use Postgres for all persistence.",
						workItem: { id: "story-1", identifier: "F-001" },
					},
					{
						text: "We deploy every Wednesday.",
						workItem: { id: "story-gone", identifier: "F-002" },
					},
				],
				dismissedIndexes: [],
			},
		]);
		decisionsMock([], []);
		mocks.storyFindMany.mockResolvedValue([
			{ id: "story-1", identifier: "F-001" },
		]);

		const candidates = await listLivingMemoryDecisionCandidates({
			projectId: "proj",
			organizationId: "org",
		});

		expect(candidates[0]?.workItem).toEqual({
			id: "story-1",
			identifier: "F-001",
		});
		// Deleted since the file was read: offered without a link.
		expect(candidates[1]).not.toHaveProperty("workItem");
		expect(mocks.storyFindMany).toHaveBeenCalledWith({
			where: {
				projectId: "proj",
				id: { in: ["story-1", "story-gone"] },
			},
			select: { id: true, identifier: true },
		});
	});

	it("reads no work items when no candidate names one", async () => {
		await listLivingMemoryDecisionCandidates({
			projectId: "proj",
			organizationId: "org",
		});

		expect(mocks.storyFindMany).not.toHaveBeenCalled();
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

	describe("the work item it came from", () => {
		const linked = {
			...currentExtraction,
			decisions: [
				{ text: "We use Postgres for all persistence." },
				{
					text: "We deploy every Wednesday.",
					workItem: { id: "story-7", identifier: "F-007" },
				},
			],
		};

		it("carries it, re-read, with the project's current identifier", async () => {
			mocks.extractionFindFirst.mockResolvedValue(linked);
			mocks.storyFindMany.mockResolvedValue([
				{ id: "story-7", identifier: "B-007" },
			]);

			await expect(
				getLivingMemoryDecisionCandidate(lookup),
			).resolves.toMatchObject({
				status: "found",
				candidate: {
					workItem: { id: "story-7", identifier: "B-007" },
				},
			});
			expect(mocks.storyFindMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: { projectId: "proj", id: { in: ["story-7"] } },
				}),
			);
		});

		it("drops it when the project no longer has it", async () => {
			mocks.extractionFindFirst.mockResolvedValue(linked);
			mocks.storyFindMany.mockResolvedValue([]);

			const lookedUp = await getLivingMemoryDecisionCandidate(lookup);

			expect(lookedUp.status).toBe("found");
			expect(
				lookedUp.status === "found" ? lookedUp.candidate : null,
			).not.toHaveProperty("workItem");
		});
	});
});

describe("parseLivingMemoryDecisions", () => {
	it("keeps a well-formed work item and drops a malformed one", () => {
		expect(
			parseLivingMemoryDecisions([
				{ text: "A", workItem: { id: "story-1", identifier: "F-001" } },
				{ text: "B", workItem: { id: 7, identifier: "F-002" } },
				{ text: "C", workItem: ["story-3"] },
				{ text: "D", workItem: { id: "", identifier: "F-004" } },
			]),
		).toEqual([
			{ text: "A", workItem: { id: "story-1", identifier: "F-001" } },
			{ text: "B" },
			{ text: "C" },
			{ text: "D" },
		]);
	});
});

describe("listLivingMemoryLimitedFiles", () => {
	it("names the current versions that met a limit, in the caller's tenant", async () => {
		mocks.extractionFindMany.mockResolvedValue([
			{
				contentHash: CURRENT,
				sourcePath: "docs/huge.md",
				contentTruncated: true,
				decisionsCapped: false,
				context: { contentHash: CURRENT },
			},
			{
				contentHash: CURRENT,
				sourcePath: "docs/log.md",
				contentTruncated: true,
				decisionsCapped: true,
				context: { contentHash: CURRENT },
			},
			{
				contentHash: OLDER,
				sourcePath: "docs/edited-since.md",
				contentTruncated: true,
				decisionsCapped: false,
				context: { contentHash: CURRENT },
			},
		]);

		await expect(
			listLivingMemoryLimitedFiles({
				projectId: "proj",
				organizationId: "org",
			}),
		).resolves.toEqual([
			{ sourcePath: "docs/huge.md", truncated: true, capped: false },
			{ sourcePath: "docs/log.md", truncated: true, capped: true },
		]);
		expect(mocks.extractionFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					projectId: "proj",
					organizationId: "org",
					OR: [{ contentTruncated: true }, { decisionsCapped: true }],
				},
			}),
		);
	});

	it("reads a personal project's files with no organization", async () => {
		mocks.extractionFindMany.mockResolvedValue([]);

		await expect(
			listLivingMemoryLimitedFiles({ projectId: "proj" }),
		).resolves.toEqual([]);
		expect(mocks.extractionFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ organizationId: null }),
			}),
		);
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

describe("files not read for decisions yet", () => {
	/** What both reads share: the tenant, store-only files, never-read files. */
	function expectAwaitingScanWhere(sql: string) {
		expect(sql).toContain('FROM project_context c WHERE c."projectId" = ?');
		expect(sql).toContain('AND c."organizationId" IS NOT DISTINCT FROM ?');
		expect(sql).toContain('AND c."indexingExcluded" = false');
		// A synced, embedded file whose current version has no extraction.
		expect(sql).toContain(
			'OR ( c."sourcePath" IS NOT NULL AND c."contentHash" IS NOT NULL AND c."embeddedAt" IS NOT NULL AND NOT EXISTS ( SELECT 1 FROM project_context_decision_extraction e WHERE e."contextId" = c.id AND e."contentHash" = c."contentHash" ) )',
		);
	}

	it("counts first-sync files still unread and never-read files, in the caller's tenant", async () => {
		mocks.queryRaw.mockResolvedValue([{ count: 4 }]);

		await expect(
			countLivingMemoryFilesAwaitingDecisionScan({
				projectId: "p-1",
				organizationId: "org-1",
			}),
		).resolves.toBe(4);
		const { sql, params } = lastRawQuery();
		expect(sql).toContain("SELECT count(*)::integer AS count");
		expectAwaitingScanWhere(sql);
		// A first-sync mark counts only while it names the current version.
		expect(sql).toContain(
			'( c."decisionScanSkippedHash" = c."contentHash" OR',
		);
		expect(params).toEqual(["p-1", "org-1"]);
	});

	it("counts a personal project's files with no organization", async () => {
		mocks.queryRaw.mockResolvedValue([{ count: 0 }]);

		await expect(
			countLivingMemoryFilesAwaitingDecisionScan({ projectId: "p-1" }),
		).resolves.toBe(0);
		expect(lastRawQuery().params).toEqual(["p-1", null]);
	});

	it("pages by id after the cursor, through every first-sync mark it can clear", async () => {
		mocks.queryRaw.mockResolvedValue([
			{ id: "c-6", projectId: "p-1", organizationId: "org-1" },
		]);

		await expect(
			listLivingMemoryFilesAwaitingDecisionScan({
				projectId: "p-1",
				organizationId: "org-1",
				afterId: "c-5",
				limit: 20,
			}),
		).resolves.toEqual([
			{ id: "c-6", projectId: "p-1", organizationId: "org-1" },
		]);
		const { sql, params } = lastRawQuery();
		expect(sql).toContain('SELECT c.id, c."projectId", c."organizationId"');
		expectAwaitingScanWhere(sql);
		expect(sql).toContain('( c."decisionScanSkippedHash" IS NOT NULL OR');
		expect(sql).toContain(
			"AND c.id > ? ORDER BY c.id ASC LIMIT ?::integer",
		);
		expect(params).toEqual(["p-1", "org-1", "c-5", 20]);
	});

	it("starts the first page with no cursor", async () => {
		mocks.queryRaw.mockResolvedValue([]);

		await listLivingMemoryFilesAwaitingDecisionScan({
			projectId: "p-1",
			organizationId: null,
			limit: 20,
		});

		const { sql, params } = lastRawQuery();
		expect(sql).not.toContain("c.id >");
		expect(params).toEqual(["p-1", null, 20]);
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
