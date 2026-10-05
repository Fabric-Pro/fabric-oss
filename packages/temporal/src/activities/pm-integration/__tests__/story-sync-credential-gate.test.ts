/**
 * A story push reads the MCP config's stored credential directly — the ADO
 * PAT that uploads images as work-item attachments — before its first
 * `executeMcpTool` call. With capabilities discovered by an earlier activity
 * (`capabilities` in the input), no MCP client factory, and so no organization
 * check, has run in this activity by then.
 *
 * An owner who has left the organization, or whose role no longer allows
 * running the config's tools, must have the config treated as gone, as after
 * the offboarding cascade deletes it: the credential is never decrypted
 * (Fizzy #2903). The push itself is then refused by the client factory
 * inside `executeMcpTool` (mocked here).
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

vi.mock("../../pm-source", () => ({
	resolvePmSource: vi.fn(),
	PMSourceNotFound: class extends Error {},
	assertPmMcpTargetOrigin: async () => undefined,
}));

vi.mock("../../pm-tool-fallback", () => ({
	callPmToolWithFallback: vi.fn(),
	GITLAB_REST_CAPABILITIES: {},
}));

const h = vi.hoisted(() => ({
	getStoryById: vi.fn(),
	updateStory: vi.fn(),
	getMcpConfigById: vi.fn(),
	canConnect: vi.fn(),
	isMember: vi.fn(),
	decryptApiKey: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	canConnectOrganizationMcpConfigs: (...args: unknown[]) =>
		h.canConnect(...args),
	canReadOrganizationMcpConfigs: vi.fn(async () => true),
	isOrganizationMember: (...args: unknown[]) => h.isMember(...args),
	createStory: vi.fn(),
	deleteStory: vi.fn(),
	getStoryById: h.getStoryById,
	updateStory: h.updateStory,
	updateTask: vi.fn(),
	getMcpConfigById: h.getMcpConfigById,
	isProjectReadOnly: vi.fn(async () => false),
	listStoryStatuses: vi.fn().mockResolvedValue([]),
	formatBackLinkForProvider: (desc: string) => desc,
	normalizeBackLinkFromProvider: (desc: string) => desc,
	HTML_BACK_LINK_RE:
		/<p>\s*<a\s+[^>]*href=["']([^"']+)["'][^>]*>\s*View in Fabric\s*<\/a>\s*<\/p>/i,
	db: { projectStoryStatus: { findMany: vi.fn().mockResolvedValue([]) } },
}));

vi.mock("@repo/utils", async (importOriginal) => ({
	...(await importOriginal<object>()),
	decryptApiKey: (value: string) => h.decryptApiKey(value),
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

const ADO_CAPABILITIES = {
	hasPMCapabilities: true,
	containerHierarchy: [],
	availableTools: ["wit_update_work_item"],
	detectedType: "azure-devops",
	taskUpdate: {
		toolName: "wit_update_work_item",
		idParam: "id",
		titleParam: "title",
		descriptionParam: "description",
		updatesBased: undefined,
		allParams: [
			{ name: "id", type: "string", required: true },
			{ name: "title", type: "string", required: false },
			{ name: "description", type: "string", required: false },
		],
	},
	taskGet: {
		toolName: "wit_get_work_item",
		idParam: "id",
		additionalRequiredParams: [],
		allParams: [],
	},
};

function pushInput() {
	return {
		storyId: "story-1",
		projectId: "proj-1",
		mcpConfigId: "mcp-1",
		mcpServerId: "server-1",
		containerId: "Example Project",
		direction: "push" as const,
		userId: "user-1",
		organizationId: "org-1",
		additionalContext: {},
		capabilities: ADO_CAPABILITIES as never,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	h.getStoryById.mockResolvedValue({
		id: "story-1",
		projectId: "proj-1",
		identifier: "12",
		title: "Add login",
		// Fabric-authored markdown: takes the ADO HTML/attachment path.
		description: "## Steps\n\n- Sign in\n- See the dashboard",
		acceptanceCriteria: null,
		releaseNotes: null,
		priority: null,
		size: null,
		storyPoints: null,
		labels: [],
		statusId: "status-todo",
		lastSyncedStatusId: null,
		externalId: "252",
		externalUrl:
			"https://dev.azure.com/example-org/proj/_workitems/edit/252",
		externalMcpServerId: "server-1",
	});
	h.updateStory.mockResolvedValue(undefined);
	h.getMcpConfigById.mockResolvedValue({
		baseUrl: null,
		mcpServerId: "server-1",
		mcpServer: { defaultUrl: null },
		encryptedApiKey: "enc:stored-pat",
		commandArgs: ["example-org"],
	});
	h.decryptApiKey.mockImplementation((value: string) =>
		value.replace(/^enc:/, ""),
	);
	vi.mocked(executeMcpTool).mockResolvedValue({
		success: true,
		output: {},
	} as never);
});

function patDecrypted(): boolean {
	return h.decryptApiKey.mock.calls.some(
		([value]) => value === "enc:stored-pat",
	);
}

describe("syncStoryToPM — the stored credential and the owner's organization access", () => {
	it("uses the stored PAT for a member allowed to run the config's tools", async () => {
		h.canConnect.mockResolvedValue(true);

		await syncStoryToPM(pushInput());

		expect(h.canConnect).toHaveBeenCalledWith("user-1", "org-1");
		expect(patDecrypted()).toBe(true);
	});

	it.each([
		["has left the organization", false],
		["is a viewer", true],
	])(
		"never decrypts the stored PAT when the owner %s",
		async (_label, member) => {
			h.canConnect.mockResolvedValue(false);
			h.isMember.mockResolvedValue(member);

			await syncStoryToPM(pushInput());

			expect(h.getMcpConfigById).not.toHaveBeenCalled();
			expect(patDecrypted()).toBe(false);
		},
	);

	it("never decrypts the stored PAT, and pushes nothing, when the access read fails", async () => {
		h.canConnect.mockRejectedValue(new Error("database unavailable"));

		await syncStoryToPM(pushInput()).catch(() => undefined);

		expect(patDecrypted()).toBe(false);
		expect(executeMcpTool).not.toHaveBeenCalled();
	});
});
