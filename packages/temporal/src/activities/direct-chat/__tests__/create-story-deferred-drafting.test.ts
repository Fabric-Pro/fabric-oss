/**
 * `fabric_create_story` for a run that answers a person while it works.
 *
 * Drafting a work item through the stage prompt takes the better part of a
 * minute, which a voice meeting cannot wait for. A run that asks for deferred
 * drafting (the runtime's `deferStoryDrafting`) creates the item from the
 * person's own words at once and has the body drafted afterwards; every other
 * run drafts inline, as before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createStory: vi.fn(),
	triggerDraft: vi.fn(),
	triggerDuplicates: vi.fn(),
}));

vi.mock("@repo/database", async (original) => ({
	...(await original<typeof import("@repo/database")>()),
	canCreateProjectStory: vi.fn(async () => true),
	buildBacklogDedupGuard: vi.fn(async () => ({
		findCollision: () => null,
	})),
	db: {
		organization: {
			findUnique: vi.fn(async () => ({ slug: "example-org" })),
		},
		project: {
			findUnique: vi.fn(async () => ({
				projectManagementMcpConfigId: null,
				projectManagementContainerId: null,
			})),
		},
		userStory: { update: vi.fn(async () => ({})) },
	},
}));
vi.mock("../../../lib/create-story-from-proposal", () => ({
	createStoryFromProposal: mocks.createStory,
}));
vi.mock("../../../lib/trigger-story-body-draft", () => ({
	triggerStoryBodyDraft: mocks.triggerDraft,
}));
vi.mock("../../../lib/trigger-duplicate-detection", () => ({
	triggerDuplicateDetection: mocks.triggerDuplicates,
}));
vi.mock("../../../lib/lifecycle-dispatcher", () => ({
	dispatchLifecycleEvent: vi.fn(async () => undefined),
}));
vi.mock("../../../lib/enqueue-pm-sync-from-activity", () => ({
	enqueuePmSyncFromActivity: vi.fn(),
}));
vi.mock("../../../client", () => ({ getTemporalClient: vi.fn() }));

const { createFabricTool } = await import("../built-in-tools");
const { withAgentToolRuntime } = await import(
	"../../shared/agent-tool-runtime"
);

type StoryTool = {
	execute: (
		args: Record<string, unknown>,
	) => Promise<Record<string, unknown>>;
};

async function createStory(args: Record<string, unknown>, defer: boolean) {
	const tools = await createFabricTool("fabric_create_story", {
		userId: "user",
		organizationId: "org",
		projectId: "project",
	});
	const tool = tools.fabric_create_story as StoryTool;
	return withAgentToolRuntime(
		{ invoke: vi.fn(), deferStoryDrafting: defer },
		() => tool.execute(args),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.createStory.mockResolvedValue({
		story: {
			id: "story-1",
			identifier: "251",
			title: "Parlume test",
			kind: "FEATURE",
			statusId: "status",
		},
		aiDrafted: false,
	});
});

describe("fabric_create_story when drafting is deferred", () => {
	it("creates the item from the person's words without the classifier or the drafting model", async () => {
		await createStory(
			{ title: "Parlume test", request: "A test item" },
			true,
		);

		expect(mocks.createStory).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Parlume test",
				description: "A test item",
				skipClassifier: true,
				skipDrafting: true,
				bodyAlreadyDrafted: true,
			}),
		);
	});

	it("has the body drafted afterwards, for the kind the item was stored as", async () => {
		mocks.createStory.mockResolvedValue({
			story: {
				id: "bug-1",
				identifier: "9",
				title: "Login fails",
				kind: "BUG",
				statusId: "status",
			},
			aiDrafted: false,
		});

		await createStory(
			{ title: "Login fails", request: "Login fails", kind: "BUG" },
			true,
		);

		expect(mocks.triggerDraft).toHaveBeenCalledWith({
			storyId: "bug-1",
			projectId: "project",
			userId: "user",
			organizationId: "org",
			targetKind: "BUG",
		});
	});

	it("returns the identifier and link at once, saying the body follows", async () => {
		const result = await createStory(
			{ title: "Parlume test", request: "A test item" },
			true,
		);

		expect(result).toMatchObject({
			storyId: "story-1",
			identifier: "251",
			title: "Parlume test",
			url: expect.stringContaining("/stories/story-1"),
			aiDrafted: false,
			draftingInBackground: true,
		});
	});

	it("still creates the item when the drafting could not be queued", async () => {
		mocks.triggerDraft.mockResolvedValue(null);

		const result = await createStory(
			{ title: "Parlume test", request: "A test item" },
			true,
		);

		expect(result).toMatchObject({ storyId: "story-1" });
		expect(result).not.toHaveProperty("error");
	});
});

describe("fabric_create_story when drafting is not deferred", () => {
	it("drafts inline through the classifier and the stage prompt, as before", async () => {
		const result = await createStory(
			{ title: "Parlume test", request: "A test item" },
			false,
		);

		const [params] = mocks.createStory.mock.calls[0] ?? [];
		expect(params).not.toHaveProperty("skipClassifier");
		expect(params).not.toHaveProperty("skipDrafting");
		expect(params).not.toHaveProperty("bodyAlreadyDrafted");
		expect(mocks.triggerDraft).not.toHaveBeenCalled();
		expect(result).not.toHaveProperty("draftingInBackground");
	});
});
