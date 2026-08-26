/**
 * Workflow-level integration tests for `storySyncWorkflow`.
 *
 * Covers the activity-call orchestration for:
 *   1. REST pull (mcpConfigId=null, synthetic GitLab REST capabilities).
 *      Exercises the path added in T7-T11 where the workflow proceeds past
 *      `discoverPMToolCapabilities` even when no MCPConfig exists, then
 *      dispatches `listWorkItemsFromPM` + `createOrUpdateStoryFromPMItem`
 *      against the REST source.
 *   2. MCP pull regression (mcpConfigId="cfg-1"). Confirms the historical
 *      MCP path is unchanged after T11's input-widening refactor.
 *   3. REST push deferral. The workflow's push branch isn't yet wired to
 *      REST: when capabilities.taskCreation/taskUpdate are absent (which
 *      is what the synthetic REST PMToolCapabilities deliberately returns
 *      per `story-sync.ts:849`), each story falls through to the
 *      "PM tool does not support task creation" error and the workflow
 *      surfaces failedCount > 0 with success=false.
 *
 * Test harness pattern follows existing workflow tests in this repo
 * (e.g. `orchestrator-memory-regression.test.ts`,
 * `incident-lifecycle.test.ts`): we mock `@temporalio/workflow` so
 * `proxyActivities` returns plain vi.fn stubs, then invoke the workflow
 * as a regular async function. This trades Temporal-specific behaviour
 * (retries, signals, queries, timers) for full control over activity
 * return values — the deterministic-replay surface is covered by
 * `__tests__/replay-validation.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const activityStubs = vi.hoisted(() => ({
	getStoriesToSync: vi.fn(),
	updateStoryExternalRefs: vi.fn(),
	discoverPMToolCapabilities: vi.fn(),
	listAllFizzyCards: vi.fn(),
	listWorkItemsFromPM: vi.fn(),
	fetchPMItemsByIds: vi.fn(),
	createOrUpdateStoryFromPMItem: vi.fn(),
	deleteStoriesNotInPMList: vi.fn(),
	executeMcpTool: vi.fn(),
}));

vi.mock("@temporalio/workflow", async () => {
	// Pull the real `ApplicationFailure` / `ActivityFailure` so the
	// workflow's `error instanceof ApplicationFailure` branches still
	// behave correctly when activities reject.
	const actual = await vi.importActual<typeof import("@temporalio/workflow")>(
		"@temporalio/workflow",
	);
	return {
		ApplicationFailure: actual.ApplicationFailure,
		ActivityFailure: actual.ActivityFailure,
		log: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		},
		defineSignal: (name: string) => ({ name, type: "signal" as const }),
		defineQuery: (name: string) => ({ name, type: "query" as const }),
		setHandler: vi.fn(),
		proxyActivities: vi.fn(() => activityStubs),
	};
});

import { storySyncWorkflow } from "../story-sync-workflow";

// =============================================================================
// Capability fixtures
// =============================================================================

/**
 * Mirror of the synthetic REST-GitLab capabilities produced by
 * `discoverPMToolCapabilities` when `mcpConfigId == null`. Keeping this
 * inline (rather than importing from the activity) makes the contract
 * the workflow depends on explicit at the test boundary.
 */
const REST_GITLAB_CAPABILITIES = {
	hasPMCapabilities: true,
	containerHierarchy: [],
	taskList: {
		toolName: "rest:gitlab.issues.list",
		containerParam: "containerId",
		allParams: [{ name: "containerId" }],
	},
	taskGet: {
		toolName: "rest:gitlab.issues.get",
		idParam: "id",
		allParams: [{ name: "id" }],
	},
	// taskCreation / taskUpdate intentionally absent — REST push is a
	// separate follow-up (see story-sync.ts:849).
	detectedType: "gitlab" as const,
	availableTools: ["rest:gitlab.issues.list", "rest:gitlab.issues.get"],
};

/**
 * Equivalent MCP-side capability shape for a Fizzy-style server. Includes
 * taskCreation + taskUpdate so a hypothetical push regression test (not
 * required by T12) could re-use this fixture.
 */
const MCP_FIZZY_CAPABILITIES = {
	hasPMCapabilities: true,
	containerHierarchy: [],
	taskCreation: {
		toolName: "create_card",
		containerParam: "board_id",
		titleParam: "title",
		descriptionParam: "description",
		allParams: [
			{ name: "board_id" },
			{ name: "title" },
			{ name: "description" },
		],
	},
	taskUpdate: {
		toolName: "update_card",
		idParam: "card_id",
		titleParam: "title",
		descriptionParam: "description",
		allParams: [
			{ name: "card_id" },
			{ name: "title" },
			{ name: "description" },
		],
	},
	taskGet: {
		toolName: "get_card",
		idParam: "card_id",
		allParams: [{ name: "card_id" }],
	},
	taskList: {
		toolName: "list_cards",
		containerParam: "board_id",
		allParams: [{ name: "board_id" }],
	},
	detectedType: "fizzy" as const,
	availableTools: ["create_card", "update_card", "get_card", "list_cards"],
};

// =============================================================================
// Pull tests
// =============================================================================

describe("storySyncWorkflow — pull orchestration", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Defaults that apply to both REST and MCP pull paths.
		activityStubs.getStoriesToSync.mockResolvedValue([]);
		activityStubs.listWorkItemsFromPM.mockResolvedValue({
			items: [
				{
					id: "1",
					title: "Issue 1",
					description: "first",
					url: "https://gitlab.example/issues/1",
				},
				{
					id: "2",
					title: "Issue 2",
					description: "second",
					url: "https://gitlab.example/issues/2",
				},
			],
			total: 2,
		});
		activityStubs.fetchPMItemsByIds.mockResolvedValue({
			items: [
				{
					id: "1",
					title: "Issue 1",
					description: "first",
					url: "https://gitlab.example/issues/1",
				},
				{
					id: "2",
					title: "Issue 2",
					description: "second",
					url: "https://gitlab.example/issues/2",
				},
			],
			failedIds: [],
			failedIdErrors: {},
		});
		activityStubs.createOrUpdateStoryFromPMItem
			.mockResolvedValueOnce({
				created: true,
				storyId: "s-1",
				identifier: "F-1",
				externalId: "1",
				externalUrl: "https://gitlab.example/issues/1",
			})
			.mockResolvedValueOnce({
				created: true,
				storyId: "s-2",
				identifier: "F-2",
				externalId: "2",
				externalUrl: "https://gitlab.example/issues/2",
			});
		activityStubs.deleteStoriesNotInPMList.mockResolvedValue({
			deletedCount: 0,
		});
		activityStubs.updateStoryExternalRefs.mockResolvedValue(undefined);
		activityStubs.listAllFizzyCards.mockResolvedValue(null);
	});

	it("REST pull: synthetic GitLab capabilities → workflow imports 2 stories", async () => {
		activityStubs.discoverPMToolCapabilities.mockResolvedValue(
			REST_GITLAB_CAPABILITIES,
		);

		const output = await storySyncWorkflow({
			projectId: "proj-1",
			mcpServerId: "srv-gl",
			mcpConfigId: null, // REST path
			containerId: "100",
			userId: "user-1",
			organizationId: "org-1",
			direction: "pull",
		});

		expect(output.success).toBe(true);
		expect(output.totalStories).toBe(2);
		expect(output.syncedCount).toBe(2);
		expect(output.failedCount).toBe(0);

		// Capability guard ran with the REST-shaped input.
		expect(activityStubs.discoverPMToolCapabilities).toHaveBeenCalledWith(
			expect.objectContaining({
				mcpConfigId: null,
				mcpServerId: "srv-gl",
				containerId: "100",
			}),
		);

		// listWorkItemsFromPM was called with mcpConfigId=null — the REST
		// path is plumbed end-to-end through `callPmToolWithFallback`.
		expect(activityStubs.listWorkItemsFromPM).toHaveBeenCalledWith(
			expect.objectContaining({
				mcpConfigId: null,
				mcpServerId: "srv-gl",
				containerId: "100",
			}),
		);

		// Each PM item produced exactly one story-create call.
		expect(
			activityStubs.createOrUpdateStoryFromPMItem,
		).toHaveBeenCalledTimes(2);
		expect(
			activityStubs.createOrUpdateStoryFromPMItem,
		).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				externalId: "1",
				title: "Issue 1",
				mcpConfigId: null,
				mcpServerId: "srv-gl",
				capabilities: REST_GITLAB_CAPABILITIES,
			}),
		);
		expect(
			activityStubs.createOrUpdateStoryFromPMItem,
		).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				externalId: "2",
				title: "Issue 2",
				mcpConfigId: null,
				mcpServerId: "srv-gl",
			}),
		);

		// Orphan deletion ran for a full (non-selective) pull, with the
		// list of PM IDs we just imported.
		expect(activityStubs.deleteStoriesNotInPMList).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-1",
			pmExternalIds: ["1", "2"],
		});
	});

	it("MCP pull regression: existing MCP path still completes with mcpConfigId=cfg-1", async () => {
		activityStubs.discoverPMToolCapabilities.mockResolvedValue(
			MCP_FIZZY_CAPABILITIES,
		);
		// Fizzy uses listAllFizzyCards when detectedType === "fizzy".
		activityStubs.listAllFizzyCards.mockResolvedValue({
			items: [
				{
					id: "1",
					title: "Issue 1",
					description: "first",
				},
				{
					id: "2",
					title: "Issue 2",
					description: "second",
				},
			],
		});

		const output = await storySyncWorkflow({
			projectId: "proj-2",
			mcpServerId: "srv-fizzy",
			mcpConfigId: "cfg-1", // MCP path
			containerId: "board-xyz",
			userId: "user-2",
			organizationId: "org-2",
			direction: "pull",
		});

		expect(output.success).toBe(true);
		expect(output.syncedCount).toBe(2);
		expect(output.failedCount).toBe(0);

		// The MCP path threads mcpConfigId="cfg-1" through every activity
		// — this is the regression we want to guard.
		expect(activityStubs.discoverPMToolCapabilities).toHaveBeenCalledWith(
			expect.objectContaining({ mcpConfigId: "cfg-1" }),
		);
		expect(activityStubs.listAllFizzyCards).toHaveBeenCalledWith(
			expect.objectContaining({ mcpConfigId: "cfg-1" }),
		);
		expect(
			activityStubs.createOrUpdateStoryFromPMItem,
		).toHaveBeenCalledWith(
			expect.objectContaining({ mcpConfigId: "cfg-1" }),
		);
	});

	it("REST pull (selective): uses fetchPMItemsByIds fast path and skips orphan deletion", async () => {
		activityStubs.discoverPMToolCapabilities.mockResolvedValue(
			REST_GITLAB_CAPABILITIES,
		);

		const output = await storySyncWorkflow({
			projectId: "proj-3",
			mcpServerId: "srv-gl",
			mcpConfigId: null,
			containerId: "100",
			userId: "user-1",
			organizationId: "org-1",
			direction: "pull",
			pmExternalIds: ["1", "2"],
		});

		expect(output.success).toBe(true);
		expect(output.syncedCount).toBe(2);
		// Selective pull takes the taskGet fast path — listWorkItemsFromPM
		// must NOT be called (otherwise we'd re-introduce the backlog-
		// pagination failure mode the fast path exists to bypass).
		expect(activityStubs.listWorkItemsFromPM).not.toHaveBeenCalled();
		expect(activityStubs.fetchPMItemsByIds).toHaveBeenCalledWith(
			expect.objectContaining({
				mcpConfigId: null,
				externalIds: ["1", "2"],
			}),
		);
		// Selective pull deliberately skips orphan deletion (the fetched
		// list is intentionally partial).
		expect(activityStubs.deleteStoriesNotInPMList).not.toHaveBeenCalled();
	});
});

// =============================================================================
// Push tests
// =============================================================================

describe("storySyncWorkflow — push orchestration", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		activityStubs.getStoriesToSync.mockResolvedValue([
			{
				id: "story-1",
				identifier: "F-1",
				title: "First story",
				description: "Body",
				externalId: null,
				externalUrl: null,
			},
		]);
		activityStubs.executeMcpTool.mockResolvedValue({
			success: true,
			output: {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							id: "new-1",
							url: "https://gitlab.example/issues/new-1",
						}),
					},
				],
			},
			durationMs: 10,
		});
		activityStubs.updateStoryExternalRefs.mockResolvedValue(undefined);
	});

	it("REST push deferral: synthetic capabilities lack taskCreation → workflow surfaces failure", async () => {
		// REST capabilities deliberately omit taskCreation/taskUpdate
		// (per story-sync.ts:849) so the workflow's push branch falls
		// through to the explicit "does not support task creation"
		// error. This guards the deferred-push contract: REST push is
		// out-of-scope until a follow-up task wires it through.
		activityStubs.discoverPMToolCapabilities.mockResolvedValue(
			REST_GITLAB_CAPABILITIES,
		);

		const output = await storySyncWorkflow({
			projectId: "proj-4",
			mcpServerId: "srv-gl",
			mcpConfigId: null,
			containerId: "100",
			userId: "user-1",
			organizationId: "org-1",
			direction: "push",
		});

		// Workflow completes (doesn't throw) but every story failed.
		expect(output.success).toBe(false);
		expect(output.failedCount).toBe(1);
		expect(output.syncedCount).toBe(0);
		expect(output.results[0]?.error ?? "").toContain(
			"does not support task creation",
		);
		// executeMcpTool was never called — we never reached an MCP dispatch.
		expect(activityStubs.executeMcpTool).not.toHaveBeenCalled();
	});

	it("MCP push regression: full Fizzy capabilities → workflow creates via executeMcpTool", async () => {
		activityStubs.discoverPMToolCapabilities.mockResolvedValue(
			MCP_FIZZY_CAPABILITIES,
		);

		const output = await storySyncWorkflow({
			projectId: "proj-5",
			mcpServerId: "srv-fizzy",
			mcpConfigId: "cfg-1",
			containerId: "board-xyz",
			userId: "user-2",
			organizationId: "org-2",
			direction: "push",
		});

		expect(output.success).toBe(true);
		expect(output.syncedCount).toBe(1);
		expect(output.failedCount).toBe(0);

		// The MCP path uses executeMcpTool with the discovered create tool.
		expect(activityStubs.executeMcpTool).toHaveBeenCalledWith(
			expect.objectContaining({
				toolName: "create_card",
				mcpConfigId: "cfg-1",
			}),
		);
		// External refs were persisted for the newly-created card.
		expect(activityStubs.updateStoryExternalRefs).toHaveBeenCalledWith(
			expect.objectContaining({
				storyId: "story-1",
				externalId: "new-1",
			}),
		);
	});
});

const ADO_CAPABILITIES = {
	hasPMCapabilities: true,
	containerHierarchy: [],
	taskCreation: {
		toolName: "wit_create_work_item",
		containerParam: "project",
		titleParam: "System.Title",
		additionalRequiredParams: [],
		allParams: [
			{ name: "project", type: "string", required: true },
			{ name: "workItemType", type: "string", required: true },
			{ name: "fields", type: "array", required: true },
		],
		fieldsBased: {
			titleKey: "System.Title",
			descriptionKey: "System.Description",
			workItemTypeParam: "workItemType",
			fieldsParam: "fields",
		},
	},
	taskUpdate: {
		toolName: "wit_update_work_item",
		idParam: "id",
		allParams: [
			{ name: "id", type: "number", required: true },
			{ name: "updates", type: "array", required: true },
		],
	},
	taskGet: {
		toolName: "wit_get_work_item",
		idParam: "id",
		allParams: [{ name: "id", type: "number", required: true }],
	},
	taskList: {
		toolName: "wit_list_work_items",
		containerParam: "project",
		allParams: [{ name: "project", type: "string", required: true }],
	},
	detectedType: "azure-devops" as const,
	availableTools: [
		"wit_create_work_item",
		"wit_update_work_item",
		"wit_get_work_item",
	],
};

function lastCreateArgs() {
	const calls = activityStubs.executeMcpTool.mock.calls;
	const call = calls.find(
		(c: any[]) => c[0]?.toolName === "wit_create_work_item",
	);
	return call?.[0]?.args as Record<string, unknown> | undefined;
}

function adoCreateResult() {
	return {
		success: true,
		output: {
			content: [
				{
					type: "text",
					text: JSON.stringify({
						id: 99,
						_links: {
							html: {
								href: "https://dev.azure.com/org/proj/_workitems/edit/99",
							},
						},
					}),
				},
			],
		},
		durationMs: 5,
	};
}

describe("storySyncWorkflow — pull workItemType threading (#1305)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.FEATURE_PM_TYPE_MAPPING;
		activityStubs.discoverPMToolCapabilities.mockResolvedValue(
			REST_GITLAB_CAPABILITIES,
		);
		activityStubs.getStoriesToSync.mockResolvedValue([]);
		activityStubs.listWorkItemsFromPM.mockResolvedValue({
			items: [
				{
					id: "bug-1",
					title: "Login crash",
					description: "Steps to repro...",
					url: "https://gitlab.example/issues/bug-1",
					workItemType: "Bug",
				},
			],
			total: 1,
		});
		activityStubs.createOrUpdateStoryFromPMItem.mockResolvedValue({
			created: true,
			storyId: "s-bug-1",
			identifier: "F-BUG-1",
			externalId: "bug-1",
			externalUrl: "https://gitlab.example/issues/bug-1",
		});
		activityStubs.deleteStoriesNotInPMList.mockResolvedValue({
			deletedCount: 0,
		});
		activityStubs.updateStoryExternalRefs.mockResolvedValue(undefined);
		activityStubs.listAllFizzyCards.mockResolvedValue(null);
	});

	afterEach(() => {
		delete process.env.FEATURE_PM_TYPE_MAPPING;
	});

	it("pull with workItemType='Bug' + flag on → createOrUpdateStoryFromPMItem receives workItemType='Bug'", async () => {
		process.env.FEATURE_PM_TYPE_MAPPING = "true";

		const output = await storySyncWorkflow({
			projectId: "proj-pull-wt",
			mcpServerId: "srv-gl",
			mcpConfigId: null,
			containerId: "100",
			userId: "user-1",
			organizationId: "org-1",
			direction: "pull",
		});

		expect(output.success).toBe(true);
		expect(output.syncedCount).toBe(1);

		expect(
			activityStubs.createOrUpdateStoryFromPMItem,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				externalId: "bug-1",
				workItemType: "Bug",
			}),
		);
	});

	it("pull threads input.enableTypeMapping into createOrUpdateStoryFromPMItem (no worker env reliance) (#1305)", async () => {
		// process.env stays unset (beforeEach clears it): the workflow must pass
		// the flag through as an activity arg so the pull reverse-map works on a
		// worker that never sees FEATURE_PM_TYPE_MAPPING.
		const output = await storySyncWorkflow({
			projectId: "proj-pull-flag",
			mcpServerId: "srv-gl",
			mcpConfigId: null,
			containerId: "100",
			userId: "user-1",
			organizationId: "org-1",
			direction: "pull",
			enableTypeMapping: true,
		});

		expect(output.success).toBe(true);
		expect(
			activityStubs.createOrUpdateStoryFromPMItem,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				externalId: "bug-1",
				workItemType: "Bug",
				enableTypeMapping: true,
			}),
		);
	});
});

describe("storySyncWorkflow — push workItemType resolution via enableTypeMapping (#1305)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		activityStubs.discoverPMToolCapabilities.mockResolvedValue(
			ADO_CAPABILITIES,
		);
		activityStubs.getStoriesToSync.mockResolvedValue([
			{
				id: "s-wt-1",
				identifier: "F-WI-1",
				title: "Feature X",
				kind: "FEATURE",
				externalId: null,
				externalUrl: null,
			},
		]);
		activityStubs.executeMcpTool.mockResolvedValue(adoCreateResult());
		activityStubs.updateStoryExternalRefs.mockResolvedValue(undefined);
	});

	it("flag on + mapping { FEATURE: 'Epic' } + kind='FEATURE' → executeMcpTool called with workItemType='Epic'", async () => {
		const output = await storySyncWorkflow({
			projectId: "proj-wt-1",
			mcpServerId: "srv-ado",
			mcpConfigId: "cfg-ado",
			containerId: "MyProject",
			userId: "user-1",
			organizationId: "org-1",
			direction: "push",
			enableTypeMapping: true,
			additionalContext: {
				workItemTypeMapping: { FEATURE: "Epic" },
			} as any,
		});

		expect(output.success).toBe(true);
		expect(output.syncedCount).toBe(1);

		expect(activityStubs.executeMcpTool).toHaveBeenCalledWith(
			expect.objectContaining({
				toolName: "wit_create_work_item",
				args: expect.objectContaining({ workItemType: "Epic" }),
			}),
		);
	});

	it("flag off → workItemType stays 'User Story' (legacy)", async () => {
		const output = await storySyncWorkflow({
			projectId: "proj-wt-2",
			mcpServerId: "srv-ado",
			mcpConfigId: "cfg-ado",
			containerId: "MyProject",
			userId: "user-1",
			organizationId: "org-1",
			direction: "push",
			enableTypeMapping: false,
			additionalContext: {
				workItemTypeMapping: { FEATURE: "Epic" },
			} as any,
		});

		expect(output.success).toBe(true);
		expect(lastCreateArgs()?.workItemType).toBe("User Story");
	});

	it("flag on + no mapping → 'User Story'", async () => {
		const output = await storySyncWorkflow({
			projectId: "proj-wt-3",
			mcpServerId: "srv-ado",
			mcpConfigId: "cfg-ado",
			containerId: "MyProject",
			userId: "user-1",
			organizationId: "org-1",
			direction: "push",
			enableTypeMapping: true,
		});

		expect(output.success).toBe(true);
		expect(lastCreateArgs()?.workItemType).toBe("User Story");
	});
});
