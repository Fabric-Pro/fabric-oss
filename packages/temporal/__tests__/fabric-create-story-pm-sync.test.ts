/**
 * Unit tests for `fabric_create_story`'s new PM-sync auto-enqueue behavior.
 *
 * Bug fix: when the in-app agent creates a story in a project with a PM tool
 * (Fizzy/Jira/etc.) wired up, that story now also pushes to the PM tool —
 * previously it was Fabric-only forever because the tool never called
 * `enqueuePmSync`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		canCreateProjectStory: vi.fn(),
		organizationFindUnique: vi.fn(),
		userStoryUpdate: vi.fn(),
		projectFindUnique: vi.fn(),
		generateStoryTitleFromDescription: vi.fn(),
		createStoryFromProposal: vi.fn(),
		dispatchLifecycleEvent: vi.fn(),
		buildBacklogDedupGuard: vi.fn(),
		enqueuePmSyncFromActivity: vi.fn(),
		getTemporalClient: vi.fn(),
	},
}));

vi.mock("@repo/ai", () => ({
	tool: (def: { execute: unknown; description: string }) => def,
}));

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	canCreateProjectStory: mocks.canCreateProjectStory,
	db: {
		organization: { findUnique: mocks.organizationFindUnique },
		userStory: { update: mocks.userStoryUpdate },
		project: { findUnique: mocks.projectFindUnique },
	},
	getMergedSearchProviderConfigs: vi.fn(),
	getSearchProviderConfig: vi.fn(),
	resolveModelWithCredentials: vi.fn(),
	buildBacklogDedupGuard: mocks.buildBacklogDedupGuard,
	inferDedupFamily: (change: {
		kindOverride?: string | null;
		type: string;
	}) =>
		change.kindOverride === "BUG" || change.type === "bug"
			? "BUG"
			: "FEATURE",
}));

vi.mock("@repo/ai/lib/story-title-generator", () => ({
	generateStoryTitleFromDescription: mocks.generateStoryTitleFromDescription,
	mapStoryTitleSourceToEnum: () => null,
	mapCreationSource: () => "API",
}));

vi.mock("@repo/search", () => ({ createProvider: vi.fn() }));
vi.mock("@repo/storage", () => ({ uploadFile: vi.fn() }));
vi.mock("@repo/utils", () => ({
	decryptApiKey: vi.fn(),
	getBaseUrl: () => "https://app.test",
}));

vi.mock("../src/lib/lifecycle-dispatcher", () => ({
	dispatchLifecycleEvent: mocks.dispatchLifecycleEvent,
}));

vi.mock("../src/lib/create-story-from-proposal", () => ({
	createStoryFromProposal: mocks.createStoryFromProposal,
}));

// built-in-tools.ts also does `await import("../../lib/trigger-duplicate-detection")`
// after the create. Stub it (own dedicated unit test) so this PM-sync suite
// stays hermetic and no Temporal client / embedding calls fire.
vi.mock("../src/lib/trigger-duplicate-detection", () => ({
	triggerDuplicateDetection: vi.fn(async () => ({
		workflowId: "dup-detect-test",
	})),
}));

// The new code in built-in-tools.ts does `await import("../../lib/enqueue-pm-sync-from-activity")`
// and `await import("../../client")` — match those specifiers to intercept.
vi.mock("../src/lib/enqueue-pm-sync-from-activity", () => ({
	enqueuePmSyncFromActivity: mocks.enqueuePmSyncFromActivity,
}));

vi.mock("../src/client", () => ({
	getTemporalClient: mocks.getTemporalClient,
}));

vi.mock("../src/activities/direct-chat/rag-retrieval", () => ({
	retrieveWorkspaceDocumentsActivity: vi.fn(),
}));

vi.mock("../src/activities/orchestrator/utils", () => ({
	jsonSchemaToZod: () => ({}),
}));

const { createBuiltInTools } = await import(
	"../src/activities/direct-chat/built-in-tools"
);

type ExecuteFn = (
	args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

async function getExecute(): Promise<ExecuteFn> {
	const tools = (await createBuiltInTools({
		userId: "user-1",
		organizationId: "org-1",
		projectId: "project-1",
		enabledFabricToolIds: ["fabric_create_story"],
	})) as Record<string, { execute: ExecuteFn }>;
	const tool = tools.fabric_create_story;
	expect(tool).toBeDefined();
	return tool.execute;
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset();
	}
	mocks.canCreateProjectStory.mockResolvedValue(true);
	mocks.organizationFindUnique.mockResolvedValue({ slug: "acme" });
	mocks.userStoryUpdate.mockResolvedValue({});
	mocks.dispatchLifecycleEvent.mockResolvedValue({});
	mocks.buildBacklogDedupGuard.mockResolvedValue({
		findCollision: () => null,
		recordCreated: () => {},
	});
	mocks.createStoryFromProposal.mockResolvedValue({
		story: {
			id: "story-pm-1",
			identifier: "F-555",
			title: "Auto SSO config",
			statusId: "status-1",
			kind: "FEATURE",
		},
		aiDrafted: false,
	});
	mocks.getTemporalClient.mockResolvedValue({
		workflow: { start: vi.fn() },
	});
	mocks.enqueuePmSyncFromActivity.mockResolvedValue({
		enqueued: true,
		workflowId: "wf-agent-1",
	});
});

describe("fabric_create_story — PM sync auto-enqueue", () => {
	it("project HAS PM configured → enqueue called + enablePmAutoSync=true passed to createStoryFromProposal", async () => {
		mocks.projectFindUnique.mockResolvedValueOnce({
			projectManagementMcpConfigId: "mcp-cfg-1",
			projectManagementContainerId: "container-1",
		});

		const execute = await getExecute();
		const result = await execute({
			title: "Auto SSO config",
			request: "Add SSO via Google.",
			kind: "FEATURE",
		});

		expect(mocks.createStoryFromProposal).toHaveBeenCalledTimes(1);
		const csfpArg = mocks.createStoryFromProposal.mock.calls[0]?.[0] as {
			enablePmAutoSync?: boolean;
		};
		expect(csfpArg.enablePmAutoSync).toBe(true);

		expect(mocks.enqueuePmSyncFromActivity).toHaveBeenCalledTimes(1);
		expect(mocks.enqueuePmSyncFromActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				itemId: "story-pm-1",
				itemType: "story",
				projectId: "project-1",
				userId: "user-1",
				triggerSource: "agent-create",
			}),
		);

		// Story URL still returned to the agent.
		expect(result).toEqual(
			expect.objectContaining({ storyId: "story-pm-1" }),
		);
	});

	it("project has NO PM configured → no enqueue, no flag", async () => {
		mocks.projectFindUnique.mockResolvedValueOnce({
			projectManagementMcpConfigId: null,
			projectManagementContainerId: null,
		});

		const execute = await getExecute();
		await execute({
			title: "Auto SSO config",
			request: "Add SSO via Google.",
			kind: "FEATURE",
		});

		const csfpArg = mocks.createStoryFromProposal.mock.calls[0]?.[0] as {
			enablePmAutoSync?: boolean;
		};
		expect(csfpArg.enablePmAutoSync).toBeUndefined();
		expect(mocks.enqueuePmSyncFromActivity).not.toHaveBeenCalled();
	});

	it("BUG kind → enqueue called with itemType=bug", async () => {
		mocks.projectFindUnique.mockResolvedValueOnce({
			projectManagementMcpConfigId: "mcp-cfg-1",
			projectManagementContainerId: "container-1",
		});
		mocks.createStoryFromProposal.mockResolvedValueOnce({
			story: {
				id: "story-pm-bug-1",
				identifier: "B-007",
				title: "Login crash",
				statusId: "status-1",
				kind: "BUG",
			},
			aiDrafted: false,
		});

		const execute = await getExecute();
		await execute({
			title: "Login crash",
			request: "Login button crashes on iOS.",
			kind: "BUG",
		});

		expect(mocks.enqueuePmSyncFromActivity).toHaveBeenCalledTimes(1);
		const arg = mocks.enqueuePmSyncFromActivity.mock.calls[0]?.[0] as {
			itemType: string;
		};
		expect(arg.itemType).toBe("bug");
	});

	it("enqueue throws → story URL still returned, no crash", async () => {
		mocks.projectFindUnique.mockResolvedValueOnce({
			projectManagementMcpConfigId: "mcp-cfg-1",
			projectManagementContainerId: "container-1",
		});
		mocks.enqueuePmSyncFromActivity.mockRejectedValueOnce(
			new Error("Temporal unreachable"),
		);

		const execute = await getExecute();
		const result = await execute({
			title: "Auto SSO config",
			request: "Add SSO via Google.",
			kind: "FEATURE",
		});

		expect(result).toEqual(
			expect.objectContaining({ storyId: "story-pm-1" }),
		);
		expect(mocks.enqueuePmSyncFromActivity).toHaveBeenCalledTimes(1);
	});
});
