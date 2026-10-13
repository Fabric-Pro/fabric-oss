/**
 * The single-story push's create (`syncStoryToPM`) persists the new item's
 * link, in the write that settles its PM create claim, before any optional
 * work that follows the create: for Jira with a hybrid Atlassian Cloud
 * target, the post-create attachment upload and the follow-up update that
 * swaps the description. That work can take long or fail; it must neither
 * hold back the link (a recovery may clear the claim once it is old enough,
 * after which the link write is refused) nor lose it.
 *
 * Harness: the one `story-sync-title.test.ts` uses, with the Jira Cloud
 * helpers in `story-sync-media` replaced so the order can be observed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => [] as string[]);

vi.mock("../story-sync-media", async (importOriginal) => ({
	...(await importOriginal<object>()),
	resolveJiraCloudTarget: vi.fn(async () => ({
		accessToken: "token",
		cloudId: "cloud-1",
		siteUrl: "https://example.atlassian.net",
		mcpConfigId: "mcp-1",
		resources: [],
	})),
	resolveIssueSite: vi.fn(() => ({
		cloudId: "cloud-1",
		siteUrl: "https://example.atlassian.net",
	})),
	uploadJiraImagesAndRewriteDescription: vi.fn(async () => {
		events.push("attachment-upload");
		return {
			description: "Body with uploaded images",
			uploaded: 1,
			skipped: 0,
			failed: 0,
			errors: [],
		};
	}),
}));

// The create claim (`pm-create-claim.ts`) has its own tests
// (pm-create-claim.test.ts); here every create takes it.
vi.mock("../pm-create-claim", async (importOriginal) => ({
	...(await importOriginal<object>()),
	acquirePmCreateClaim: vi.fn(async () => ({ claimId: "claim-test" })),
	releasePmCreateClaim: vi.fn(async () => true),
}));

vi.mock("@temporalio/activity", async () => {
	const actual = await vi.importActual<object>("@temporalio/activity");
	return {
		...actual,
		Context: {
			current: () => ({ heartbeat: vi.fn() }),
		},
	};
});

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}));

vi.mock("@repo/agent-core/backend", () => ({
	getMcpClient: vi.fn(),
	getMcpClientResult: vi.fn(),
	closeMcpClientSafe: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../orchestrator/execution/execute-mcp-tool", () => ({
	executeMcpTool: vi.fn(),
}));

const { resolvePmSource, PMSourceNotFound } = vi.hoisted(() => {
	class PMSourceNotFound extends Error {
		constructor(public reason: string) {
			super(`PM source not resolvable: ${reason}`);
			this.name = "PMSourceNotFound";
		}
	}
	return { resolvePmSource: vi.fn(), PMSourceNotFound };
});
vi.mock("../../pm-source", () => ({
	resolvePmSource,
	PMSourceNotFound,
	assertPmMcpTargetOrigin: async () => undefined,
}));

const { callPmToolWithFallback } = vi.hoisted(() => ({
	callPmToolWithFallback: vi.fn(),
}));
vi.mock("../../pm-tool-fallback", () => ({
	callPmToolWithFallback,
	GITLAB_REST_CAPABILITIES: {},
}));

const { getStoryById, updateStory, getMcpConfigById, findManyStatuses } =
	vi.hoisted(() => ({
		getStoryById: vi.fn(),
		updateStory: vi.fn(),
		getMcpConfigById: vi.fn(),
		findManyStatuses: vi.fn(),
	}));

// Mock @repo/database with a synchronous factory (no importOriginal) so we
// never evaluate the Prisma client. Mirror only what story-sync.ts and
// gitlab-rest-story-sync.ts actually import.
vi.mock("@repo/database", () => ({
	// The organization gate on the config owner (Fizzy #2903): a member whose
	// role allows MCP read and connect.
	canConnectOrganizationMcpConfigs: vi.fn(async () => true),
	canReadOrganizationMcpConfigs: vi.fn(async () => true),
	isOrganizationMember: vi.fn(async () => true),
	createStory: vi.fn(),
	deleteStory: vi.fn(),
	getStoryById,
	updateStory,
	updateTask: vi.fn(),
	getMcpConfigById,
	// Read-only mode gate — default: project is writable
	isProjectReadOnly: vi.fn(async () => false),
	listStoryStatuses: vi.fn().mockResolvedValue([]),
	// Identity back-link formatter so the description we observe in the PM-tool
	// call equals what `buildStoryDescription` produced.
	formatBackLinkForProvider: (desc: string) => desc,
	normalizeBackLinkFromProvider: (desc: string) => desc,
	HTML_BACK_LINK_RE:
		/<p>\s*<a\s+[^>]*href=["']([^"']+)["'][^>]*>\s*View in Fabric\s*<\/a>\s*<\/p>/i,
	db: {
		projectStoryStatus: { findMany: findManyStatuses },
		// The REST push (update and create) reads the project's status-sync
		// switch (Fizzy #2304 §4.5). No row → switch off → the payloads
		// asserted here are unchanged.
		project: { findUnique: vi.fn().mockResolvedValue(null) },
	},
}));

vi.mock("@repo/integrations/pm", () => ({
	applyLabelStatusMapOnPull: (_state: unknown, _labels: string[]) => ({
		statusId: null,
		labels: [],
	}),
	computeLabelDeltaOnPush: () => ({ addLabels: [], removeLabels: [] }),
	readLabelStatusMap: () => ({}),
}));

// `syncGitLabStoryViaRest` now stamps a baseline hash via
// `stampPmSyncSuccess` on every successful push/pull (and uses the matching
// guard helpers on update). The real helpers call `db.userStory.update` →
// Prisma client, which isn't available under this test's synchronous
// `@repo/database` mock. Stubbing the hierarchy-sync helpers here mirrors the
// approach in `gitlab-rest-story-sync.test.ts`.
vi.mock("../hierarchy-sync", () => ({
	getPmSyncBaseline: vi.fn().mockResolvedValue(null),
	stampPmSyncConflict: vi.fn().mockResolvedValue(undefined),
	stampPmSyncSuccess: vi.fn().mockResolvedValue(undefined),
}));

import { executeMcpTool } from "../../orchestrator/execution/execute-mcp-tool";
import { syncStoryToPM } from "../story-sync";
import { uploadJiraImagesAndRewriteDescription } from "../story-sync-media";

function makeStory() {
	return {
		id: "story-1",
		projectId: "proj-1",
		identifier: "12",
		title: "Add login",
		// Fabric-authored markdown: the shape the Jira Cloud attachment pass
		// runs on.
		description: "## Overview\n\n- Sign in with an email address",
		acceptanceCriteria: null,
		releaseNotes: null,
		priority: null,
		size: null,
		storyPoints: null,
		labels: [],
		statusId: "status-todo",
		lastSyncedStatusId: null,
		externalId: null,
		externalUrl: null,
		externalMcpServerId: null,
	};
}

const jiraCapabilities = {
	hasPMCapabilities: true,
	containerHierarchy: [],
	availableTools: ["createJiraIssue", "editJiraIssue"],
	detectedType: "jira",
	taskUpdate: {
		toolName: "editJiraIssue",
		idParam: "issueIdOrKey",
		titleParam: "summary",
		descriptionParam: "description",
		updatesBased: undefined,
		allParams: [
			{ name: "issueIdOrKey", type: "string", required: true },
			{ name: "summary", type: "string", required: false },
			{ name: "description", type: "string", required: false },
		],
	},
	taskCreation: {
		toolName: "createJiraIssue",
		containerParam: "projectKey",
		titleParam: "summary",
		descriptionParam: "description",
		fieldsBased: undefined,
		allParams: [
			{ name: "projectKey", type: "string", required: true },
			{ name: "summary", type: "string", required: true },
			{ name: "description", type: "string", required: false },
		],
	},
};

const input = {
	storyId: "story-1",
	projectId: "proj-1",
	mcpConfigId: "mcp-1",
	mcpServerId: "server-1",
	containerId: "PROJ",
	direction: "push" as const,
	userId: "user-1",
	organizationId: "org-1",
	additionalContext: {},
	capabilities: jiraCapabilities as never,
};

/** Whether this `updateStory` call is the link write that settles the claim. */
function isLinkWrite(call: unknown[]): boolean {
	const context = call[3] as { settlesPmCreateClaim?: string } | undefined;
	return context?.settlesPmCreateClaim !== undefined;
}

describe("syncStoryToPM: the link is written before the post-create attachment work", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		events.length = 0;
		getStoryById.mockResolvedValue(makeStory());
		findManyStatuses.mockResolvedValue([]);
		getMcpConfigById.mockResolvedValue({
			id: "mcp-1",
			baseUrl: null,
			mcpServerId: "server-1",
			mcpServer: { defaultUrl: null },
		});
		updateStory.mockImplementation(async (...call: unknown[]) => {
			if (isLinkWrite(call)) {
				events.push("link-write");
			}
			return undefined;
		});
		vi.mocked(executeMcpTool).mockImplementation((async (args: {
			toolName: string;
		}) => {
			events.push(args.toolName);
			return {
				success: true,
				output:
					args.toolName === "createJiraIssue"
						? {
								key: "PROJ-7",
								url: "https://example.atlassian.net/browse/PROJ-7",
							}
						: {},
			};
		}) as never);
	});

	it("commits the link (and settles the claim) before uploading attachments or sending the follow-up update", async () => {
		const result = await syncStoryToPM(input);

		expect(result).toMatchObject({ success: true, externalId: "PROJ-7" });
		expect(events).toEqual([
			"createJiraIssue",
			"link-write",
			"attachment-upload",
			"editJiraIssue",
		]);
	});

	it("an attachment upload that fails keeps the link it followed", async () => {
		vi.mocked(uploadJiraImagesAndRewriteDescription).mockImplementationOnce(
			async () => {
				events.push("attachment-upload");
				throw new Error("attachment service unavailable");
			},
		);

		const result = await syncStoryToPM(input);

		expect(result).toMatchObject({ success: true, externalId: "PROJ-7" });
		expect(events).toEqual([
			"createJiraIssue",
			"link-write",
			"attachment-upload",
		]);
		const linkWrites = updateStory.mock.calls.filter(isLinkWrite);
		expect(linkWrites).toHaveLength(1);
		expect(linkWrites[0]?.[2]).toMatchObject({ externalId: "PROJ-7" });
	});
});
