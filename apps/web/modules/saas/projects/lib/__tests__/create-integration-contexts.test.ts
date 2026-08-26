/**
 * Unit tests for createIntegrationContexts — Google Drive section.
 *
 * Mocks orpcClient and fetchGoogleDriveFileContent to verify context
 * creation, error handling, and metadata shape.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock orpcClient
const mockCreate = vi.fn();
const mockList = vi.fn();
const mockEnableTeamsChatMonitor = vi.fn();
const mockEnableTeamsChannelMonitor = vi.fn();
const mockEnableSlackChannelMonitor = vi.fn();
const mockLinkSlackChannel = vi.fn();
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			contexts: {
				create: (...args: unknown[]) => mockCreate(...args),
				list: (...args: unknown[]) => mockList(...args),
			},
			teamsChatMonitor: {
				enable: (...args: unknown[]) =>
					mockEnableTeamsChatMonitor(...args),
			},
			teamsChannelMonitor: {
				enable: (...args: unknown[]) =>
					mockEnableTeamsChannelMonitor(...args),
			},
			slackChannelMonitor: {
				enable: (...args: unknown[]) =>
					mockEnableSlackChannelMonitor(...args),
				linkChannel: (...args: unknown[]) =>
					mockLinkSlackChannel(...args),
			},
		},
	},
}));

// Mock fetchGoogleDriveFileContent
const mockFetchContent = vi.fn();
vi.mock("../google-drive-content-fetcher", () => ({
	fetchGoogleDriveFileContent: (...args: unknown[]) =>
		mockFetchContent(...args),
}));

// Mock fetchNotionPageContent (needed by the module)
vi.mock("../notion-content-fetcher", () => ({
	fetchNotionPageContent: vi.fn().mockResolvedValue({
		content: "",
		contentFetchFailed: true,
	}),
}));

// Mock the WizardIntegrationsSection import
vi.mock("../../components/wizard/WizardIntegrationsSection", () => ({}));

import {
	backlogProviderToken,
	createBacklogIntegrationContext,
	createIntegrationContexts,
} from "../create-integration-contexts";

describe("createIntegrationContexts — Google Drive", () => {
	const baseParams = {
		projectId: "proj-1",
		organizationId: "org-1" as string | null,
		selectedTeamsChats: [],
		selectedNotionPages: [],
		selectedSlackChannels: [],
		selectedConfluencePages: [],
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockCreate.mockResolvedValue({ id: "ctx-new" });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("creates context for each Google Doc selection", async () => {
		mockFetchContent.mockResolvedValue({
			content: "# File Content",
			title: "Fetched Title",
			mimeType: "application/vnd.google-apps.document",
			contentFetchFailed: false,
		});

		const result = await createIntegrationContexts({
			...baseParams,
			selectedGoogleDocs: [
				{
					fileId: "f1",
					name: "Doc 1",
					mimeType: "application/vnd.google-apps.document",
					url: "https://docs.google.com/1",
					configId: "cfg-1",
				},
				{
					fileId: "f2",
					name: "Doc 2",
					configId: "cfg-1",
				},
			],
		});

		expect(mockFetchContent).toHaveBeenCalledTimes(2);
		expect(mockCreate).toHaveBeenCalledTimes(2);
		expect(result.successCount).toBe(2);
		expect(result.failCount).toBe(0);
	});

	it("creates context with correct metadata shape", async () => {
		mockFetchContent.mockResolvedValue({
			content: "Content body",
			title: "My Doc",
			mimeType: "text/plain",
			contentFetchFailed: false,
		});

		await createIntegrationContexts({
			...baseParams,
			selectedGoogleDocs: [
				{
					fileId: "f1",
					name: "Original Name",
					mimeType: "text/plain",
					url: "https://example.com",
					configId: "cfg-1",
				},
			],
		});

		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				organizationId: "org-1",
				type: "INTEGRATION",
				content: "Content body",
				metadata: expect.objectContaining({
					provider: "google-drive",
					mcpConfigId: "cfg-1",
					fileId: "f1",
					sourceTitle: "My Doc",
					mimeType: "text/plain",
					sourceUrl: "https://example.com",
					contentFetchFailed: false,
				}),
			}),
		);
	});

	it("still creates context when content fetch fails", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		mockFetchContent.mockResolvedValue({
			content: "",
			title: "Doc Title",
			mimeType: "",
			contentFetchFailed: true,
		});

		const result = await createIntegrationContexts({
			...baseParams,
			selectedGoogleDocs: [
				{ fileId: "f1", name: "Failing Doc", configId: "cfg-1" },
			],
		});

		// Should still create the context with empty content
		expect(mockCreate).toHaveBeenCalledTimes(1);
		expect(result.successCount).toBe(1);
		expect(result.failCount).toBe(0);
		expect(warnSpy).toHaveBeenCalled();

		warnSpy.mockRestore();
	});

	it("increments failCount when context creation throws", async () => {
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		mockFetchContent.mockResolvedValue({
			content: "data",
			title: "T",
			mimeType: "",
			contentFetchFailed: false,
		});
		mockCreate.mockRejectedValue(new Error("DB error"));

		const result = await createIntegrationContexts({
			...baseParams,
			selectedGoogleDocs: [
				{ fileId: "f1", name: "Will Fail", configId: "cfg-1" },
			],
		});

		expect(result.successCount).toBe(0);
		expect(result.failCount).toBe(1);

		errorSpy.mockRestore();
	});

	it("passes organizationId through to fetch and create calls", async () => {
		mockFetchContent.mockResolvedValue({
			content: "c",
			title: "t",
			mimeType: "",
			contentFetchFailed: false,
		});

		await createIntegrationContexts({
			...baseParams,
			organizationId: "org-xyz",
			selectedGoogleDocs: [
				{ fileId: "f1", name: "Doc", configId: "cfg-1" },
			],
		});

		expect(mockFetchContent).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org-xyz" }),
		);
		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org-xyz" }),
		);
	});

	it("returns zero counts when no Google Docs selected", async () => {
		const result = await createIntegrationContexts({
			...baseParams,
			selectedGoogleDocs: [],
		});

		expect(result.successCount).toBe(0);
		expect(result.failCount).toBe(0);
		expect(mockFetchContent).not.toHaveBeenCalled();
		expect(mockCreate).not.toHaveBeenCalled();
	});

	it("handles mixed success and failure results", async () => {
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		mockFetchContent.mockResolvedValue({
			content: "ok",
			title: "t",
			mimeType: "",
			contentFetchFailed: false,
		});

		mockCreate
			.mockResolvedValueOnce({ id: "ctx-1" })
			.mockRejectedValueOnce(new Error("fail"))
			.mockResolvedValueOnce({ id: "ctx-3" });

		const result = await createIntegrationContexts({
			...baseParams,
			selectedGoogleDocs: [
				{ fileId: "f1", name: "D1", configId: "c1" },
				{ fileId: "f2", name: "D2", configId: "c1" },
				{ fileId: "f3", name: "D3", configId: "c1" },
			],
		});

		expect(result.successCount).toBe(2);
		expect(result.failCount).toBe(1);

		errorSpy.mockRestore();
	});
});

// ──────────────────────────────────────────────────────────────────────────
// D8 / AC#4 — backlog → INTEGRATION context (unified-project-setup spec §5.1).
//
// Connecting a backlog must create EXACTLY ONE idempotent, tenant-scoped
// INTEGRATION ProjectContext with the PM provider + metadata and `content: ""`
// (so no auto-embed / no ProjectDocument), and must NOT create a second row on
// DRAFT re-activation or wizard revisit (guard on an existing INTEGRATION row
// with `metadata.kind === "backlog"` + matching `containerId`).
// ──────────────────────────────────────────────────────────────────────────

describe("backlogProviderToken", () => {
	it("uppercases and sanitizes the detected PM type", () => {
		expect(backlogProviderToken("azure-devops")).toBe("AZURE_DEVOPS");
		expect(backlogProviderToken("jira")).toBe("JIRA");
		expect(backlogProviderToken("gitlab")).toBe("GITLAB");
		expect(backlogProviderToken("fizzy")).toBe("FIZZY");
		expect(backlogProviderToken("linear")).toBe("LINEAR");
	});

	it("falls back to BACKLOG when nothing was detected", () => {
		expect(backlogProviderToken(null)).toBe("BACKLOG");
		expect(backlogProviderToken(undefined)).toBe("BACKLOG");
	});
});

describe("createBacklogIntegrationContext", () => {
	const baseBacklog = {
		projectId: "proj-1",
		organizationId: "org-1" as string | null,
		detectedType: "azure-devops" as string | null,
		mcpConfigId: "cfg-1" as string | null,
		mcpServerId: "srv-1" as string | null,
		containerId: "board-7" as string | null,
		containerName: "Mobile Board" as string | null,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockList.mockResolvedValue({ contexts: [] });
		mockCreate.mockResolvedValue({ context: { id: "ctx-new" } });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("creates exactly one INTEGRATION context with PM provider + metadata and empty content", async () => {
		const result = await createBacklogIntegrationContext(baseBacklog);

		expect(result.created).toBe(true);
		expect(mockCreate).toHaveBeenCalledTimes(1);
		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				organizationId: "org-1",
				type: "INTEGRATION",
				// Empty content ⇒ no auto-embed, no ProjectDocument.
				content: "",
				metadata: expect.objectContaining({
					provider: "AZURE_DEVOPS",
					kind: "backlog",
					mcpConfigId: "cfg-1",
					mcpServerId: "srv-1",
					containerId: "board-7",
					containerName: "Mobile Board",
					sourceTitle: "Mobile Board",
				}),
			}),
		);
		// No documentTag ⇒ the procedure will not synthesize a ProjectDocument.
		const meta = mockCreate.mock.calls[0]?.[0]?.metadata as Record<
			string,
			unknown
		>;
		expect(meta.documentTag).toBeUndefined();
	});

	it("does NOT create a second row when a backlog INTEGRATION row already exists (dedup on revisit/draft re-activation)", async () => {
		mockList.mockResolvedValue({
			contexts: [
				{
					id: "ctx-existing",
					type: "INTEGRATION",
					metadata: { kind: "backlog", containerId: "board-7" },
				},
			],
		});

		const result = await createBacklogIntegrationContext(baseBacklog);

		expect(result.created).toBe(false);
		expect(mockCreate).not.toHaveBeenCalled();
	});

	it("creates a row when the only existing backlog row is for a DIFFERENT container", async () => {
		mockList.mockResolvedValue({
			contexts: [
				{
					id: "ctx-other",
					type: "INTEGRATION",
					metadata: {
						kind: "backlog",
						containerId: "different-board",
					},
				},
			],
		});

		const result = await createBacklogIntegrationContext(baseBacklog);

		expect(result.created).toBe(true);
		expect(mockCreate).toHaveBeenCalledTimes(1);
	});

	it("ignores non-backlog INTEGRATION rows (Slack/Teams) when checking for duplicates", async () => {
		mockList.mockResolvedValue({
			contexts: [
				{
					id: "ctx-slack",
					type: "INTEGRATION",
					metadata: { provider: "SLACK", channelId: "C1" },
				},
			],
		});

		const result = await createBacklogIntegrationContext(baseBacklog);

		expect(result.created).toBe(true);
		expect(mockCreate).toHaveBeenCalledTimes(1);
	});

	it("scopes the row to the resolved tenant (org id passed through to list + create)", async () => {
		await createBacklogIntegrationContext({
			...baseBacklog,
			organizationId: "org-xyz",
		});

		expect(mockList).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				organizationId: "org-xyz",
			}),
		);
		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org-xyz" }),
		);
	});

	it("passes organizationId: null for the personal context", async () => {
		await createBacklogIntegrationContext({
			...baseBacklog,
			organizationId: null,
		});

		// list omits null org (undefined), create persists null for personal.
		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: null }),
		);
	});

	it("re-throws the 30-cap BAD_REQUEST so the caller can surface it (not swallowed)", async () => {
		mockCreate.mockRejectedValue(
			new Error(
				"Maximum of 30 integration contexts allowed per project.",
			),
		);

		await expect(
			createBacklogIntegrationContext(baseBacklog),
		).rejects.toThrow(/Maximum of 30 integration contexts/);
	});

	it("derives sourceTitle from the display name when no container name is present", async () => {
		await createBacklogIntegrationContext({
			...baseBacklog,
			containerId: null,
			containerName: null,
		});

		expect(mockCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({
					provider: "AZURE_DEVOPS",
					sourceTitle: "Azure DevOps",
				}),
			}),
		);
		// Container fields are omitted when absent.
		const meta = mockCreate.mock.calls[0]?.[0]?.metadata as Record<
			string,
			unknown
		>;
		expect(meta.containerId).toBeUndefined();
		expect(meta.containerName).toBeUndefined();
	});
});

/**
 * Per-monitor `enable*` batching — see comments in `create-integration-contexts.ts`.
 * After all per-row links happen server-side inside `createContextProcedure`, the
 * wizard fires ONE enable call per monitor family. This is the wiring that
 * makes the chat messages actually flow into the project's RAG store; before
 * this regression-pinning suite the wizard left the monitors disabled and the
 * "Pending"/"Ready" pill was meaningless because nothing ingested.
 */
describe("createIntegrationContexts — monitor enablement after linking", () => {
	const baseParams = {
		projectId: "proj-1",
		organizationId: "org-1" as string | null,
		selectedNotionPages: [],
		selectedSlackChannels: [],
		selectedConfluencePages: [],
		selectedGoogleDocs: [],
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockCreate.mockResolvedValue({ id: "ctx-new" });
		mockEnableTeamsChatMonitor.mockResolvedValue({ workflowId: "wf-1" });
		mockEnableTeamsChannelMonitor.mockResolvedValue({ workflowId: "wf-2" });
		mockEnableSlackChannelMonitor.mockResolvedValue({ workflowId: "wf-3" });
		mockLinkSlackChannel.mockResolvedValue({ id: "linked-slack-1" });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("fires enableTeamsChatMonitor exactly once after N group-chat creates succeed", async () => {
		await createIntegrationContexts({
			...baseParams,
			selectedTeamsChats: [
				{
					selectionType: "chat",
					chatId: "19:abc@thread.skype",
					topic: "Chat 1",
					mcpConfigId: "mcp-1",
				},
				{
					selectionType: "chat",
					chatId: "19:def@thread.skype",
					topic: "Chat 2",
					mcpConfigId: "mcp-1",
				},
				{
					selectionType: "chat",
					chatId: "19:ghi@thread.skype",
					topic: "Chat 3",
					mcpConfigId: "mcp-1",
				},
			] as never,
		});

		expect(mockCreate).toHaveBeenCalledTimes(3);
		expect(mockEnableTeamsChatMonitor).toHaveBeenCalledTimes(1);
		expect(mockEnableTeamsChatMonitor).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-1",
		});
		expect(mockEnableTeamsChannelMonitor).not.toHaveBeenCalled();
		expect(mockEnableSlackChannelMonitor).not.toHaveBeenCalled();
	});

	it("fires enableTeamsChannelMonitor once for Teams CHANNEL selections (not enableTeamsChatMonitor)", async () => {
		await createIntegrationContexts({
			...baseParams,
			selectedTeamsChats: [
				{
					selectionType: "channel",
					teamId: "team-uuid",
					channelId: "channel-uuid",
					channelName: "general",
					teamName: "Team A",
					topic: "Team A - general",
					mcpConfigId: "mcp-1",
				},
			] as never,
		});

		expect(mockEnableTeamsChannelMonitor).toHaveBeenCalledTimes(1);
		expect(mockEnableTeamsChatMonitor).not.toHaveBeenCalled();
	});

	it("links and enables Slack — calls linkChannel + enable each once per row/family", async () => {
		await createIntegrationContexts({
			...baseParams,
			selectedTeamsChats: [],
			selectedSlackChannels: [
				{
					channelId: "C12345",
					channelName: "general",
					mcpConfigId: "mcp-2",
				},
			],
		});

		expect(mockLinkSlackChannel).toHaveBeenCalledTimes(1);
		expect(mockLinkSlackChannel).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-1",
			channelId: "C12345",
			channelName: "general",
			backfillMode: "latest-7-days",
		});
		expect(mockEnableSlackChannelMonitor).toHaveBeenCalledTimes(1);
		expect(mockEnableSlackChannelMonitor).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-1",
		});
	});

	it("Slack linkChannel failure does NOT block context creation OR monitor enable for sibling rows", async () => {
		mockLinkSlackChannel.mockRejectedValueOnce(new Error("Slack 403"));
		const result = await createIntegrationContexts({
			...baseParams,
			selectedTeamsChats: [],
			selectedSlackChannels: [
				{
					channelId: "C1",
					channelName: "ch1",
					mcpConfigId: "mcp-2",
				},
				{
					channelId: "C2",
					channelName: "ch2",
					mcpConfigId: "mcp-2",
				},
			],
		});
		expect(mockCreate).toHaveBeenCalledTimes(2);
		expect(mockLinkSlackChannel).toHaveBeenCalledTimes(2);
		// The second link succeeded, so enable should still fire once.
		expect(mockEnableSlackChannelMonitor).toHaveBeenCalledTimes(1);
		// Both context creates succeeded (failures here are link failures
		// downstream of create — the context row still exists).
		expect(result.successCount).toBe(2);
	});

	it("does NOT call any monitor enable when only Confluence is selected (no monitor exists for Confluence)", async () => {
		await createIntegrationContexts({
			...baseParams,
			selectedTeamsChats: [],
			selectedConfluencePages: [
				{
					pageId: "c1",
					title: "Confluence Page",
					mcpConfigId: "mcp-3",
					url: "https://confluence/...",
				} as never,
			],
		});

		expect(mockCreate).toHaveBeenCalledTimes(1);
		expect(mockEnableTeamsChatMonitor).not.toHaveBeenCalled();
		expect(mockEnableTeamsChannelMonitor).not.toHaveBeenCalled();
		expect(mockEnableSlackChannelMonitor).not.toHaveBeenCalled();
	});

	it("does NOT call enable when no items were created at all", async () => {
		await createIntegrationContexts({
			...baseParams,
			selectedTeamsChats: [],
		});

		expect(mockCreate).not.toHaveBeenCalled();
		expect(mockEnableTeamsChatMonitor).not.toHaveBeenCalled();
		expect(mockEnableTeamsChannelMonitor).not.toHaveBeenCalled();
		expect(mockEnableSlackChannelMonitor).not.toHaveBeenCalled();
	});

	it("swallows enable* failures so they don't roll back successful context rows", async () => {
		mockEnableTeamsChatMonitor.mockRejectedValueOnce(
			new Error("Temporal start failed"),
		);
		const result = await createIntegrationContexts({
			...baseParams,
			selectedTeamsChats: [
				{
					selectionType: "chat",
					chatId: "19:abc@thread.skype",
					topic: "Chat 1",
					mcpConfigId: "mcp-1",
				},
			] as never,
		});
		expect(result.successCount).toBe(1);
		expect(result.failCount).toBe(0);
		expect(mockEnableTeamsChatMonitor).toHaveBeenCalledTimes(1);
	});

	it("does NOT call enable when create itself failed (no linked rows for the monitor to read)", async () => {
		mockCreate.mockRejectedValueOnce(new Error("network blip"));
		const result = await createIntegrationContexts({
			...baseParams,
			selectedTeamsChats: [
				{
					selectionType: "chat",
					chatId: "19:abc@thread.skype",
					topic: "Chat 1",
					mcpConfigId: "mcp-1",
				},
			] as never,
		});
		expect(result.successCount).toBe(0);
		expect(result.failCount).toBe(1);
		expect(mockEnableTeamsChatMonitor).not.toHaveBeenCalled();
	});

	it("fires enable for EVERY monitor family that had at least one linked row", async () => {
		await createIntegrationContexts({
			...baseParams,
			selectedTeamsChats: [
				{
					selectionType: "chat",
					chatId: "19:abc@thread.skype",
					topic: "Chat",
					mcpConfigId: "mcp-1",
				},
				{
					selectionType: "channel",
					teamId: "team-uuid",
					channelId: "channel-uuid",
					channelName: "general",
					teamName: "Team A",
					topic: "Team A - general",
					mcpConfigId: "mcp-1",
				},
			] as never,
			selectedSlackChannels: [
				{
					channelId: "C1",
					channelName: "general",
					mcpConfigId: "mcp-2",
				},
			],
		});

		expect(mockEnableTeamsChatMonitor).toHaveBeenCalledTimes(1);
		expect(mockEnableTeamsChannelMonitor).toHaveBeenCalledTimes(1);
		expect(mockEnableSlackChannelMonitor).toHaveBeenCalledTimes(1);
	});
});
