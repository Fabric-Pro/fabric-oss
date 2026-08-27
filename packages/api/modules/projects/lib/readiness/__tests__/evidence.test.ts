/**
 * How the evidence bundle is DERIVED from the database (Fizzy #2165).
 *
 * These exist because the level tests could not catch the bug they were written
 * for. Those assert what happens *given* `repositoryConnected: true`; the defect
 * was in deciding that flag in the first place — `Project.repositoryUrl` is the
 * legacy column and is null on any project attached through
 * `ProjectRepositoryIntegration`, so a project with an obvious codebase reported
 * "not connected", and Atlas, security and release notes silently vanished with
 * it because all three depend on that item.
 *
 * Verified by reverting the fix and watching these fail — which the level tests
 * did not.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb } = vi.hoisted(() => ({
	mockDb: {
		project: { findUnique: vi.fn() },
		projectContext: { groupBy: vi.fn(), count: vi.fn(), findMany: vi.fn() },
		projectDocument: { groupBy: vi.fn(), findMany: vi.fn() },
		projectMember: { count: vi.fn() },
		userStory: { count: vi.fn() },
		projectScan: { findFirst: vi.fn() },
		newsletterSettings: { findUnique: vi.fn() },
		atlasAnalysis: { findFirst: vi.fn() },
		projectRepositoryIntegration: { count: vi.fn() },
		projectCodeIndex: { findFirst: vi.fn() },
	},
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	db: mockDb,
}));

import { gatherReadinessEvidence } from "../evidence";

/** A project row with nothing configured, including no legacy repository. */
function projectRow(overrides: Record<string, unknown> = {}) {
	return {
		userId: "u1",
		organizationId: null,
		projectPhase: null,
		expectedDevelopmentStartDate: null,
		features: [],
		techStack: [],
		projectManagementMcpServerId: null,
		autoPushPmSync: false,
		readOnlyMode: false,
		pmAutoCloseEnabled: false,
		pmTerminalStatuses: [],
		teamsChannelMonitorEnabled: false,
		teamsChatMonitorEnabled: false,
		slackChannelMonitorEnabled: false,
		meetingTranscriptAutoAnalyzeEnabled: false,
		repositoryUrl: null,
		codeAnalysisStatus: null,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockDb.project.findUnique.mockResolvedValue(projectRow());
	mockDb.projectContext.groupBy.mockResolvedValue([]);
	mockDb.projectContext.count.mockResolvedValue(0);
	mockDb.projectContext.findMany.mockResolvedValue([]);
	mockDb.projectDocument.groupBy.mockResolvedValue([]);
	// Nothing generating, indexing or scanning unless a test says so.
	mockDb.projectDocument.findMany.mockResolvedValue([]);
	mockDb.projectMember.count.mockResolvedValue(0);
	mockDb.userStory.count.mockResolvedValue(0);
	mockDb.projectScan.findFirst.mockResolvedValue(null);
	mockDb.newsletterSettings.findUnique.mockResolvedValue(null);
	mockDb.atlasAnalysis.findFirst.mockResolvedValue(null);
	mockDb.projectRepositoryIntegration.count.mockResolvedValue(0);
	mockDb.projectCodeIndex.findFirst.mockResolvedValue(null);
});

describe("gatherReadinessEvidence — codebase connection", () => {
	it("counts an ACTIVE repository integration as a connected codebase", async () => {
		mockDb.projectRepositoryIntegration.count.mockResolvedValue(1);

		const result = await gatherReadinessEvidence("p1");

		expect(result?.evidence.code.repositoryConnected).toBe(true);
	});

	it("only counts ACTIVE integrations", async () => {
		// A token-expired or disconnected integration is a codebase Fabric cannot
		// currently read, which is what the checklist item is really asking.
		await gatherReadinessEvidence("p1");

		expect(mockDb.projectRepositoryIntegration.count).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ status: "ACTIVE" }),
			}),
		);
	});

	it("still honours the legacy column so older projects do not regress", async () => {
		mockDb.project.findUnique.mockResolvedValue(
			projectRow({ repositoryUrl: "https://github.com/example/repo" }),
		);

		const result = await gatherReadinessEvidence("p1");

		expect(result?.evidence.code.repositoryConnected).toBe(true);
	});

	it("reports no codebase when neither path has one", async () => {
		const result = await gatherReadinessEvidence("p1");

		expect(result?.evidence.code.repositoryConnected).toBe(false);
	});
});

describe("gatherReadinessEvidence — codebase analysis", () => {
	it("counts a completed full index as analysis done", async () => {
		mockDb.projectCodeIndex.findFirst.mockResolvedValue({ id: "idx1" });

		const result = await gatherReadinessEvidence("p1");

		expect(result?.evidence.code.analysisCompleted).toBe(true);
	});

	it("keys on a completed full index, not on current status", async () => {
		// Status flips to INDEXING on every refresh. Keying on it would make a
		// long-satisfied item blink back to incomplete each time the repository
		// re-indexes, which is how Fabric- Main looked when this was wrong.
		await gatherReadinessEvidence("p1");

		expect(mockDb.projectCodeIndex.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					lastFullIndexAt: { not: null },
				}),
			}),
		);
	});

	it("still honours the legacy codeAnalysisStatus column", async () => {
		mockDb.project.findUnique.mockResolvedValue(
			projectRow({ codeAnalysisStatus: "COMPLETED" }),
		);

		const result = await gatherReadinessEvidence("p1");

		expect(result?.evidence.code.analysisCompleted).toBe(true);
	});

	it("reports analysis incomplete when neither signal is present", async () => {
		const result = await gatherReadinessEvidence("p1");

		expect(result?.evidence.code.analysisCompleted).toBe(false);
	});
});

/**
 * A document a re-run is working on (Fizzy #2165).
 *
 * Regeneration mutates the same row — GENERATING while it runs, FAILED if it
 * dies — so a status-only read dropped a PRD the project plainly had the moment
 * its owner hit Refresh, and left it dropped when the run failed at the model's
 * output-token limit. Reported from staging with the checklist offering "Create
 * PRD" beside a Documents tab showing one.
 *
 * These assert which rows the read SELECTS rather than restating its shape: the
 * `where` the code actually passed is applied to plain rows below.
 */
interface DocumentRow {
	status: string;
	content: string;
	isActive: boolean;
}

type WhereClause = Record<string, unknown>;

/** Understands only the operators this read uses: `in`, `not`, and `OR`. */
function clauseMatches(clause: WhereClause, row: DocumentRow): boolean {
	return Object.entries(clause).every(([field, condition]) => {
		if (field === "OR") {
			return (condition as WhereClause[]).some((branch) =>
				clauseMatches(branch, row),
			);
		}
		if (!(field in row)) {
			// Scoping fields a document row of this fixture does not model.
			return true;
		}
		const value = row[field as keyof DocumentRow];
		if (condition !== null && typeof condition === "object") {
			const operator = condition as { in?: unknown[]; not?: unknown };
			if (operator.in) {
				return operator.in.includes(value);
			}
			if ("not" in operator) {
				return value !== operator.not;
			}
		}
		return value === condition;
	});
}

async function documentReadSelects(row: DocumentRow): Promise<boolean> {
	await gatherReadinessEvidence("p1");
	const call = mockDb.projectDocument.groupBy.mock.calls.at(0)?.[0] as
		| { where: WhereClause }
		| undefined;
	if (!call) {
		throw new Error("the document read was never issued");
	}
	return clauseMatches(call.where, row);
}

describe("gatherReadinessEvidence — documents under a re-run", () => {
	it("counts a document being regenerated, whose previous content is still there", async () => {
		expect(
			await documentReadSelects({
				status: "GENERATING",
				content: "# Product Requirements\n...",
				isActive: true,
			}),
		).toBe(true);
	});

	it("counts a document whose re-run failed", async () => {
		// The failure wrote a status and an error. It did not take away the
		// version already on the row, which retrieval still reads.
		expect(
			await documentReadSelects({
				status: "FAILED",
				content: "# Product Requirements\n...",
				isActive: true,
			}),
		).toBe(true);
	});

	it("does not count a first generation that has produced nothing yet", async () => {
		// The create route writes the row empty for the run to fill. This is
		// precisely when the item should read In Progress, not done.
		expect(
			await documentReadSelects({
				status: "GENERATING",
				content: "",
				isActive: true,
			}),
		).toBe(false);
	});

	it("does not count a first generation that failed", async () => {
		expect(
			await documentReadSelects({
				status: "FAILED",
				content: "",
				isActive: true,
			}),
		).toBe(false);
	});

	it("still counts a finished document", async () => {
		expect(
			await documentReadSelects({
				status: "COMPLETE",
				content: "# Product Requirements\n...",
				isActive: true,
			}),
		).toBe(true);
	});

	it("still ignores a draft that no run has ever completed", async () => {
		// Widening the status list instead of adding the branch would have
		// started counting these, which no rule asks for.
		expect(
			await documentReadSelects({
				status: "DRAFT",
				content: "# Notes\n...",
				isActive: true,
			}),
		).toBe(false);
	});

	it("keys the re-run branch on content, the column that survives a failure", async () => {
		await gatherReadinessEvidence("p1");

		// Named explicitly: the matcher above skips fields a row does not model,
		// so a mistyped column here would otherwise select nothing and still
		// satisfy every assertion in this block.
		const branches = (
			mockDb.projectDocument.groupBy.mock.calls.at(0)?.[0] as {
				where: { OR: WhereClause[] };
			}
		).where.OR;

		expect(branches).toContainEqual(
			expect.objectContaining({ content: { not: "" } }),
		);
	});

	it("still ignores a document that has been stood down", async () => {
		expect(
			await documentReadSelects({
				status: "COMPLETE",
				content: "# Product Requirements\n...",
				isActive: false,
			}),
		).toBe(false);
	});
});
