import { beforeEach, describe, expect, it, vi } from "vitest";

const { getLatestProjectScanMock, listScanFindingsMock } = vi.hoisted(() => ({
	getLatestProjectScanMock: vi.fn(),
	listScanFindingsMock: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	generateText: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	logModelUsageAsync: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {},
	getLatestProjectScan: getLatestProjectScanMock,
	listArchitectureDecisions: vi.fn(),
	listScanFindings: listScanFindingsMock,
}));
vi.mock("@repo/integrations/microsoft", () => ({
	executeMicrosoftTeamsTool: vi.fn(),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@repo/mcp", () => ({ getCachedMcpClientForConfig: vi.fn() }));
vi.mock("@repo/rag", () => ({
	formatContextsForPrompt: vi.fn(),
	retrieveProjectContexts: vi.fn(),
}));
vi.mock("@repo/utils", () => ({ getBaseUrl: vi.fn() }));
vi.mock("../../../lib/redis-cache", () => ({
	RedisCache: { get: vi.fn(), set: vi.fn() },
	CacheKeys: {},
	CacheTTL: {},
}));
vi.mock("../../search-project-slack-messages", () => ({
	fetchRecentSlackMessages: vi.fn(),
}));
vi.mock("../../search-project-teams-messages", () => ({
	fetchRecentTeamsMessages: vi.fn(),
}));

import { fetchSecurityFindingsForBacklog } from "../fetch-context";

function finding(index: number) {
	return {
		severity: "HIGH",
		title: `Finding ${index}`,
		category: "SECURITY",
		ruleSource: "Security review",
		location: null,
		story: null,
		description: "Description",
		remediation: "Remediation",
	};
}

describe("fetchSecurityFindingsForBacklog", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getLatestProjectScanMock.mockResolvedValue({
			id: "scan-1",
			securityFindingCount: 0,
			completedAt: new Date("2026-08-01T01:00:00.000Z"),
		});
		listScanFindingsMock.mockResolvedValue([]);
	});

	it("queries live open security findings even when the scan snapshot is zero", async () => {
		listScanFindingsMock.mockResolvedValue([finding(1)]);

		const result = await fetchSecurityFindingsForBacklog({
			projectId: "project-1",
		});

		expect(listScanFindingsMock).toHaveBeenCalledWith("project-1", {
			scanId: "scan-1",
			category: "SECURITY",
			status: "OPEN",
			sort: "severity",
			limit: 51,
		});
		expect(result.findingCount).toBe(1);
		expect(result.formattedFindings).toContain(
			"1 open security finding from the latest security scan (2026-08-01):",
		);
	});

	it("shows 50 findings and reports when more security findings exist", async () => {
		getLatestProjectScanMock.mockResolvedValue({
			id: "scan-1",
			securityFindingCount: 500,
			completedAt: new Date("2026-08-01T01:00:00.000Z"),
		});
		listScanFindingsMock.mockResolvedValue(
			Array.from({ length: 51 }, (_, index) => finding(index + 1)),
		);

		const result = await fetchSecurityFindingsForBacklog({
			projectId: "project-1",
		});

		expect(result.findingCount).toBe(50);
		expect(result.formattedFindings).toContain(
			"Showing the first 50 open security findings from the latest security scan (2026-08-01). More findings exist:",
		);
		expect(result.formattedFindings).toContain("Finding 50");
		expect(result.formattedFindings).not.toContain("Finding 51");
	});
});
