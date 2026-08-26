/**
 * A failed-pull media placeholder must never be pushed back to the PM tool.
 *
 * When an image or file attachment cannot be downloaded from a PM tool, the
 * pull ingester substitutes a bracketed token — `[Image could not be imported
 * from Azure DevOps: shot.png]` — in place of the URL (Fizzy card 2027). If
 * that token is then pushed back, it OVERWRITES the live attachment reference
 * in the PM tool: the real `_apis/wit/attachments/…` markup becomes inert
 * text and the image is lost from the work item permanently.
 *
 * `syncGitLabStoryViaRest` has stripped these since the placeholders were
 * introduced. The MCP push path — which carries Azure DevOps, Jira, GitHub,
 * Fizzy and Linear — did not, so the data-loss window was open for exactly the
 * integration the card was filed against. These tests pin the strip on the
 * shared MCP path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@temporalio/activity", async () => {
	const actual = await vi.importActual<object>("@temporalio/activity");
	return {
		...actual,
		Context: { current: () => ({ heartbeat: vi.fn() }) },
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
vi.mock("../../pm-source", () => ({ resolvePmSource, PMSourceNotFound }));

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

vi.mock("@repo/database", () => ({
	createStory: vi.fn(),
	deleteStory: vi.fn(),
	getStoryById,
	updateStory,
	updateTask: vi.fn(),
	getMcpConfigById,
	isProjectReadOnly: vi.fn(async () => false),
	listStoryStatuses: vi.fn().mockResolvedValue([]),
	formatBackLinkForProvider: (desc: string) => desc,
	normalizeBackLinkFromProvider: (desc: string) => desc,
	HTML_BACK_LINK_RE:
		/<p>\s*<a\s+[^>]*href=["']([^"']+)["'][^>]*>\s*View in Fabric\s*<\/a>\s*<\/p>/i,
	db: { projectStoryStatus: { findMany: findManyStatuses } },
}));

vi.mock("@repo/integrations/pm", () => ({
	applyLabelStatusMapOnPull: () => ({ statusId: null, labels: [] }),
	computeLabelDeltaOnPush: () => ({ addLabels: [], removeLabels: [] }),
	readLabelStatusMap: () => ({}),
}));

vi.mock("../hierarchy-sync", () => ({
	getPmSyncBaseline: vi.fn().mockResolvedValue(null),
	stampPmSyncConflict: vi.fn().mockResolvedValue(undefined),
	stampPmSyncSuccess: vi.fn().mockResolvedValue(undefined),
}));

import { executeMcpTool } from "../../orchestrator/execution/execute-mcp-tool";
import { syncStoryToPM } from "../story-sync";

const IMAGE_PLACEHOLDER =
	"[Image could not be imported from Azure DevOps: shot.png]";
const FILE_PLACEHOLDER =
	"[Attachment could not be imported from Azure DevOps: spec.pdf]";

function makeStory(description: string) {
	return {
		id: "story-1",
		projectId: "proj-1",
		identifier: "12",
		title: "Add login",
		description,
		acceptanceCriteria: null,
		releaseNotes: null,
		priority: null,
		size: null,
		storyPoints: null,
		labels: [],
		statusId: "status-todo",
		lastSyncedStatusId: null,
		externalId: "ext-1",
		externalUrl: "https://dev.azure.com/org/proj/_workitems/edit/252",
		externalMcpServerId: "server-1",
	};
}

function makeCapabilities(detectedType: string) {
	return {
		hasPMCapabilities: true,
		containerHierarchy: [],
		availableTools: ["create_card", "update_card"],
		detectedType,
		taskUpdate: {
			toolName: "update_card",
			idParam: "card_id",
			titleParam: "title",
			descriptionParam: "description",
			updatesBased: undefined,
			allParams: [
				{ name: "card_id", type: "string", required: true },
				{ name: "title", type: "string", required: false },
				{ name: "description", type: "string", required: false },
			],
		},
		taskCreation: {
			toolName: "create_card",
			containerParam: "board_id",
			titleParam: "title",
			descriptionParam: "description",
			fieldsBased: undefined,
			allParams: [
				{ name: "board_id", type: "string", required: true },
				{ name: "title", type: "string", required: true },
				{ name: "description", type: "string", required: false },
			],
		},
		taskGet: {
			toolName: "get_card",
			idParam: "card_id",
			additionalRequiredParams: [],
			allParams: [],
		},
	};
}

function input(detectedType: string) {
	return {
		storyId: "story-1",
		projectId: "proj-1",
		mcpConfigId: "mcp-1",
		mcpServerId: "server-1",
		containerId: "board-1",
		direction: "push" as const,
		userId: "user-1",
		organizationId: "org-1",
		additionalContext: {},
		capabilities: makeCapabilities(detectedType) as never,
	};
}

function pushedDescription(): string {
	const call = vi
		.mocked(executeMcpTool)
		.mock.calls.find(
			([arg]) => (arg as { toolName: string }).toolName === "update_card",
		);
	if (!call) {
		throw new Error("update_card was never called");
	}
	const args = (call[0] as { args: Record<string, unknown> }).args;
	return String(args.description ?? "");
}

describe("failed-media placeholders are stripped before an MCP push", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		updateStory.mockResolvedValue(undefined);
		findManyStatuses.mockResolvedValue([]);
		getMcpConfigById.mockResolvedValue({
			baseUrl: null,
			mcpServerId: "server-1",
			mcpServer: { defaultUrl: null },
		});
		vi.mocked(executeMcpTool).mockResolvedValue({
			success: true,
			output: {},
		} as never);
	});

	it("does not push an image placeholder to Azure DevOps", async () => {
		getStoryById.mockResolvedValue(
			makeStory(
				`<p>Before</p><p><em>${IMAGE_PLACEHOLDER}</em></p><p>After</p>`,
			),
		);

		await syncStoryToPM(input("azure-devops"));

		expect(pushedDescription()).not.toContain("could not be imported");
	});

	it("does not push a file-attachment placeholder to Azure DevOps", async () => {
		getStoryById.mockResolvedValue(
			makeStory(`<p>Before</p><p><em>${FILE_PLACEHOLDER}</em></p>`),
		);

		await syncStoryToPM(input("azure-devops"));

		expect(pushedDescription()).not.toContain("could not be imported");
	});

	it("keeps the surrounding description intact when stripping", async () => {
		getStoryById.mockResolvedValue(
			makeStory(
				`<p>Before</p><p><em>${IMAGE_PLACEHOLDER}</em></p><p>After</p>`,
			),
		);

		await syncStoryToPM(input("azure-devops"));

		const description = pushedDescription();
		expect(description).toContain("Before");
		expect(description).toContain("After");
	});

	it("strips on the other MCP providers too", async () => {
		getStoryById.mockResolvedValue(
			makeStory(`<p><em>${IMAGE_PLACEHOLDER}</em></p><p>Body</p>`),
		);

		await syncStoryToPM(input("jira"));

		expect(pushedDescription()).not.toContain("could not be imported");
	});

	it("leaves ordinary prose that mentions importing alone", async () => {
		getStoryById.mockResolvedValue(
			makeStory("<p>The importer could not be imported by hand.</p>"),
		);

		await syncStoryToPM(input("azure-devops"));

		expect(pushedDescription()).toContain("could not be imported by hand");
	});
});
