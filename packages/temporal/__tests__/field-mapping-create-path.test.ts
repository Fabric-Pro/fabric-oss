/**
 * Replace-mode on FIRST creation via `createOrUpdateStoryFromPMItem`.
 *
 * The list/bulk-pull create path parses only `System.Description` and the default
 * re-fetch guard skips the full get for a REAL-titled ADO story, so replace-mode
 * would otherwise never engage on first import. The fix force-refetches +
 * aggregates when replace-mode is active. This suite pins that:
 *   (a) real-titled NEW ADO story + replace-mode active → forces the get and
 *       creates with the aggregated `##` body (legacy System.Description omitted);
 *   (b) replace-mode active + all-blank configured fields → `finalDescription`
 *       undefined (no System.Description leak — "don't clobber");
 *   (c) flag-off / non-ADO → NO extra `executeMcpTool` get fires (call count 0).
 *
 * `mcpConfigId: null` + `mcpServerId: undefined` + caps without `taskUpdate` keep
 * the ONLY possible `executeMcpTool` call the forced refetch itself: the
 * post-create content pull (MCP branch needs `mcpConfigId != null`; REST branch
 * needs `mcpServerId`) and the push-back (`caps.taskUpdate`) are both skipped.
 *
 * Mock header mirrors `story-sync.test.ts` (adds `deleteStory`, `getMcpConfigById`,
 * `readFieldMappingConfig` as `vi.fn()`) — importing real `@repo/database` keeps
 * pg.Pool handles alive past vitest exit (vitest #4373).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/agent-core/backend", () => ({
	getMcpClient: vi.fn(),
	getMcpClientResult: vi.fn(),
	closeMcpClientSafe: vi.fn().mockResolvedValue(undefined),
	getDetailedMcpToolInfo: vi.fn().mockResolvedValue([]),
	canMcpToolsHandleTask: vi
		.fn()
		.mockReturnValue({ canHandle: false, matchedTools: [] }),
	generateMemoryContext: vi
		.fn()
		.mockResolvedValue({ contextString: "", memoryCount: 0 }),
	getConfiguredAIModel: vi.fn().mockResolvedValue({}),
}));

vi.mock("../src/activities/orchestrator/execution/execute-mcp-tool", () => ({
	executeMcpTool: vi.fn(),
}));

vi.mock("@repo/storage", () => ({
	getStorageProvider: vi.fn(() => ({
		getSignedUrl: vi.fn(async (key: string) => `https://signed/${key}`),
	})),
	deleteObjects: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { projectContexts: "test-project-contexts" } },
	},
}));

vi.mock("@repo/database", () => ({
	db: {
		userStory: {
			findMany: vi.fn(),
			findFirst: vi.fn(),
			findUnique: vi.fn(),
			update: vi.fn(),
		},
		storyTask: { findUnique: vi.fn() },
		organization: { findUnique: vi.fn() },
		project: { findUnique: vi.fn() },
	},
	Prisma: {},
	PmSyncStatus: {
		PENDING: "PENDING",
		SUCCESS: "SUCCESS",
		CONFLICT: "CONFLICT",
		FAILED: "FAILED",
	},
	createStory: vi.fn(),
	deleteStory: vi.fn(),
	listStoryStatuses: vi.fn(),
	getStoryById: vi.fn(),
	getMcpConfigById: vi.fn(),
	updateStory: vi.fn(),
	updateTask: vi.fn(),
	readFieldMappingConfig: vi.fn(),
	buildFabricStoryUrl: vi.fn().mockResolvedValue("https://fabric.test/s/1"),
	appendFabricBackLink: (description: string | null | undefined) =>
		description ?? "",
	HTML_BACK_LINK_RE: /View in Fabric/i,
	formatBackLinkForProvider: (description: string | null | undefined) =>
		description ?? "",
	normalizeBackLinkFromProvider: (description: string | null | undefined) =>
		description ?? "",
}));

vi.mock("../src/activities/pm-integration/record-pm-sync-log", () => ({
	recordPmSyncLog: vi.fn(),
}));

vi.mock(
	"../src/activities/pm-integration/reconcile-story-terminal-status",
	() => ({
		reconcileStoryTerminalStatus: vi.fn(),
	}),
);

import { createStory, db, readFieldMappingConfig } from "@repo/database";
import { executeMcpTool } from "../src/activities/orchestrator/execution/execute-mcp-tool";
import { createOrUpdateStoryFromPMItem } from "../src/activities/pm-integration/story-sync";

const REAL_TITLE = "Real ADO Story Title";

// ADO get-output: System.Description carries a value that MUST NOT leak into the
// created body when replace-mode is active; Custom.BusinessRules is the only
// configured field.
function adoGetOutput(businessRules: string) {
	return {
		success: true,
		output: {
			fields: {
				"System.Title": REAL_TITLE,
				"System.Description": "<p>LEGACY DESCRIPTION LEAK</p>",
				"Custom.BusinessRules": businessRules,
			},
		},
	};
}

// ADO capabilities WITHOUT taskUpdate (skips push-back) — taskGet present so the
// forced refetch can fire.
const ADO_CAPS = {
	detectedType: "azure-devops",
	taskGet: {
		toolName: "wit_get_work_item",
		idParam: "id",
		additionalRequiredParams: [],
	},
} as never;

const JIRA_CAPS = {
	detectedType: "jira",
	taskGet: {
		toolName: "getJiraIssue",
		idParam: "issueIdOrKey",
		additionalRequiredParams: [],
	},
} as never;

const CONFIG = {
	provider: "azure-devops",
	fields: [{ id: "Custom.BusinessRules", displayName: "Business Rules" }],
};

function baseInput() {
	return {
		projectId: "proj-1",
		externalId: "123",
		title: REAL_TITLE,
		description: "<p>list-path body (System.Description only)</p>",
		userId: "user-1",
		mcpConfigId: null,
		mcpServerId: undefined,
		containerId: "board-1",
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	// New story (not already imported).
	vi.mocked(db.userStory.findFirst).mockResolvedValue(null as never);
	vi.mocked(db.userStory.update).mockResolvedValue({} as never);
	vi.mocked(createStory).mockResolvedValue({
		id: "story-new-1",
		identifier: "US-1",
	} as never);
});

describe("createOrUpdateStoryFromPMItem — replace-mode on first creation", () => {
	it("(a) real-titled NEW ADO story + replace-mode active → forces the refetch and creates the aggregated ## body", async () => {
		vi.mocked(db.project.findUnique).mockResolvedValue({
			pmFieldMappingEnabled: true,
			projectManagementAdditionalContext: {},
		} as never);
		vi.mocked(readFieldMappingConfig).mockReturnValue(CONFIG as never);
		vi.mocked(executeMcpTool).mockResolvedValue(
			adoGetOutput("<p>Follow the rules</p>") as never,
		);

		const result = await createOrUpdateStoryFromPMItem({
			...baseInput(),
			capabilities: ADO_CAPS,
		});

		// The forced refetch fired (the whole point — a real title would normally
		// skip the full get).
		expect(executeMcpTool).toHaveBeenCalledTimes(1);
		expect(vi.mocked(executeMcpTool).mock.calls[0][0]).toMatchObject({
			toolName: "wit_get_work_item",
			args: { id: "123" },
		});

		// Created with the aggregated configured-field body; legacy
		// System.Description and the list-path body are BOTH gone (replace).
		expect(createStory).toHaveBeenCalledTimes(1);
		const createArg = vi.mocked(createStory).mock.calls[0][0] as {
			description?: string;
			title: string;
		};
		expect(createArg.title).toBe(REAL_TITLE);
		expect(createArg.description).toContain("## Business Rules");
		expect(createArg.description).toContain("Follow the rules");
		expect(createArg.description).not.toContain("LEGACY DESCRIPTION LEAK");
		expect(createArg.description).not.toContain("list-path body");
		expect(result.created).toBe(true);
	});

	it("(b) replace-mode active + all-blank configured fields → finalDescription undefined (no System.Description leak)", async () => {
		vi.mocked(db.project.findUnique).mockResolvedValue({
			pmFieldMappingEnabled: true,
			projectManagementAdditionalContext: {},
		} as never);
		vi.mocked(readFieldMappingConfig).mockReturnValue(CONFIG as never);
		// Configured field blank → assembled body undefined.
		vi.mocked(executeMcpTool).mockResolvedValue(adoGetOutput("") as never);

		await createOrUpdateStoryFromPMItem({
			...baseInput(),
			capabilities: ADO_CAPS,
		});

		expect(executeMcpTool).toHaveBeenCalledTimes(1);
		expect(createStory).toHaveBeenCalledTimes(1);
		const createArg = vi.mocked(createStory).mock.calls[0][0] as {
			description?: string;
		};
		// Don't clobber: undefined, NOT the legacy System.Description.
		expect(createArg.description).toBeUndefined();
	});

	it("(c1) flag OFF (ADO) → no forced refetch (executeMcpTool never called)", async () => {
		vi.mocked(db.project.findUnique).mockResolvedValue({
			pmFieldMappingEnabled: false,
			projectManagementAdditionalContext: {},
		} as never);
		vi.mocked(readFieldMappingConfig).mockReturnValue(CONFIG as never);

		await createOrUpdateStoryFromPMItem({
			...baseInput(),
			capabilities: ADO_CAPS,
		});

		// Real title + replace-mode inactive → the full get is skipped entirely.
		expect(executeMcpTool).not.toHaveBeenCalled();
		expect(createStory).toHaveBeenCalledTimes(1);
	});

	it("(c2) non-ADO provider → no field-mapping refetch (executeMcpTool never called)", async () => {
		// Non-ADO short-circuits without even loading the project field-mapping row.
		await createOrUpdateStoryFromPMItem({
			...baseInput(),
			capabilities: JIRA_CAPS,
		});

		expect(db.project.findUnique).not.toHaveBeenCalled();
		expect(executeMcpTool).not.toHaveBeenCalled();
		expect(createStory).toHaveBeenCalledTimes(1);
	});
});
