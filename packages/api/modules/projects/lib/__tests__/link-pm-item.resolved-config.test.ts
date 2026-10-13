/**
 * `linkPmItem` through the REAL `resolvePmTarget`. The project pins config A,
 * which belongs to a teammate; the caller's own config for the same PM server
 * is B. The MCP client's caller-scoped lookup refuses A, so every call Link
 * makes to the PM tool (capability discovery, the verifying read, and the
 * test-case capability gate) must carry B's id.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
	userStoryFindFirst: vi.fn(),
	applyPmLink: vi.fn(),
	discover: vi.fn(),
	fetchPMItemsByIds: vi.fn(),
	resolveProjectPMConfigForUser: vi.fn(),
	getTemporalClient: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: mocks.projectFindUnique },
		userStory: { findFirst: mocks.userStoryFindFirst },
		testCase: { findFirst: vi.fn() },
		mCPServer: { findUnique: vi.fn() },
	},
	applyPmLink: mocks.applyPmLink,
	pmCreateClaimRecoveryCutoff: async () => new Date(Date.now() - 5 * 60_000),
	pmCreateClaimRecoverableAt: () => null,
	isPmServerIdKeySentinel: () => false,
	readPmServerIdKeySentinel: () => null,
}));
vi.mock("@repo/integrations/gitlab", () => ({
	findUsableGitLabConnection: vi.fn(),
	GitLabPmOriginMismatchError: class extends Error {},
	gitlabPmOriginMatches: () => true,
	resolveProjectPMConfigForUser: mocks.resolveProjectPMConfigForUser,
}));
vi.mock("@repo/temporal", async () => {
	const refs = await import(
		"../../../../../temporal/src/activities/pm-integration/created-item-refs"
	);
	return {
		extractCreatedWorkItemRefs: refs.extractCreatedWorkItemRefs,
		readCreatedTestCaseRefs: refs.readCreatedTestCaseRefs,
		getTemporalClient: mocks.getTemporalClient,
	};
});
vi.mock("@repo/temporal/pm-sync-start", () => ({
	describePmSyncWorkflow: vi.fn(),
	testCaseSyncWorkflowId: () => "tc-sync",
}));
vi.mock("@repo/temporal/activities", () => ({
	fetchPMItemsByIds: mocks.fetchPMItemsByIds,
	discoverPMToolCapabilitiesResult: mocks.discover,
}));

import { linkPmItem } from "../link-pm-item";

const PINNED_ID = "cfg-pinned-by-teammate";
const CALLER_ID = "cfg-callers-own";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.projectFindUnique.mockResolvedValue({
		organizationId: "org-1",
		projectManagementMcpServerId: "srv-jira",
		projectManagementMcpConfigId: PINNED_ID,
		projectManagementContainerId: "container-1",
		projectManagementContainerName: "Example Project",
		projectManagementAdditionalContext: null,
	});
	mocks.userStoryFindFirst.mockResolvedValue({
		identifier: "US-1",
		externalId: null,
		pmCreateClaimId: null,
		pmCreateClaimedAt: null,
		lastPmSyncStatus: null,
		lastPmSyncAttemptId: null,
	});
	// The caller-scoped lookup: the pinned config is a teammate's, so the
	// resolver falls back to the caller's own config for that server.
	mocks.resolveProjectPMConfigForUser.mockResolvedValue({
		id: CALLER_ID,
		enabled: true,
		mcpServerId: "srv-jira",
	});
	mocks.discover.mockResolvedValue({
		ok: true,
		capabilities: { detectedType: "jira", availableTools: [] },
	});
	mocks.fetchPMItemsByIds.mockResolvedValue({
		items: [
			{
				id: "PROJ-12",
				url: "https://pm.example.com/browse/PROJ-12",
				raw: { id: "10001", key: "PROJ-12" },
			},
		],
		hasNextPage: false,
		failedIds: [],
		notFoundIds: [],
	});
	mocks.applyPmLink.mockResolvedValue({ status: "linked" });
});

describe("linkPmItem with a teammate's pinned config", () => {
	it("dispatches the caller's own config, not the pinned one", async () => {
		const assertTargetSupported = vi.fn();

		await linkPmItem({
			row: { storyId: "story-1" },
			projectId: "proj-1",
			externalId: "PROJ-12",
			userId: "user-1",
			assertTargetSupported,
		});

		expect(mocks.resolveProjectPMConfigForUser).toHaveBeenCalledWith(
			expect.objectContaining({ configId: PINNED_ID }),
		);
		expect(mocks.discover).toHaveBeenCalledWith(
			expect.objectContaining({ mcpConfigId: CALLER_ID }),
		);
		expect(mocks.fetchPMItemsByIds).toHaveBeenCalledWith(
			expect.objectContaining({ mcpConfigId: CALLER_ID }),
		);
		expect(assertTargetSupported).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "mcp", mcpConfigId: CALLER_ID }),
			"org-1",
		);
		for (const call of [
			...mocks.discover.mock.calls,
			...mocks.fetchPMItemsByIds.mock.calls,
		]) {
			expect(call[0].mcpConfigId).not.toBe(PINNED_ID);
		}
	});
});
