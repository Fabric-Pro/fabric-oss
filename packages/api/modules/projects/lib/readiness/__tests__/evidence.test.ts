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
		projectContext: { groupBy: vi.fn(), count: vi.fn() },
		projectDocument: { groupBy: vi.fn() },
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
	mockDb.projectDocument.groupBy.mockResolvedValue([]);
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
