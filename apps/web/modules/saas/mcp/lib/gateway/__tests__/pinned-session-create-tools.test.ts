/**
 * `fabric_create_feature` and `fabric_create_bug` for a session limited to a
 * meeting's project.
 *
 * Drafting a body takes the better part of a minute, which a voice meeting
 * cannot wait for. A pinned service session files the item from the words it
 * was given and has the body drafted afterwards; every other session drafts
 * inline, as it always did.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getProjectAccessContext: vi.fn(),
	canCreateProjectStory: vi.fn(),
	findFirst: vi.fn(),
	isOrganizationMember: vi.fn(),
	findOpenBacklogTitleCollision: vi.fn(),
	createStoryFromProposal: vi.fn(),
	triggerStoryBodyDraft: vi.fn(),
	dispatchLifecycleEvent: vi.fn(),
	recordAuditFromRequest: vi.fn(),
}));

vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: vi
		.fn()
		.mockResolvedValue({ availability: "UPLOAD", readState: "DIRECT" }),
}));
vi.mock("@repo/database", () => ({
	db: { userStory: { findFirst: mocks.findFirst } },
	isOrganizationMember: mocks.isOrganizationMember,
	isProjectSoftDeleted: vi.fn().mockResolvedValue(false),
	getProjectAccessContext: mocks.getProjectAccessContext,
	canCreateProjectStory: mocks.canCreateProjectStory,
	findOpenBacklogTitleCollision: mocks.findOpenBacklogTitleCollision,
	TERMINAL_DRAFTING_STAGES: ["DECLINED", "CLOSED"],
}));
vi.mock("@repo/temporal", () => ({
	createStoryFromProposal: mocks.createStoryFromProposal,
	triggerStoryBodyDraft: mocks.triggerStoryBodyDraft,
	dispatchLifecycleEvent: mocks.dispatchLifecycleEvent,
}));
vi.mock("@repo/api/lib/audit", () => ({
	recordAuditFromRequest: mocks.recordAuditFromRequest,
}));

import { PARLUME_GRANT_SCOPES } from "@repo/api/lib/agent-service-auth";
import { executePlatformTool } from "../platform-tools";
import { serviceSessionScopes } from "../tool-scope";
import type { GatewaySession } from "../types";

const PROJECT = "project-meeting";

function pinned(): GatewaySession {
	return {
		sessionId: "sess-1",
		userId: "user-1",
		organizationId: "org-1",
		projectId: null,
		pinnedProjectId: PROJECT,
		userName: "Example Agent",
		email: "agent@example.com",
		role: "user",
		credential: "service",
		scopes: serviceSessionScopes({
			projectId: PROJECT,
			scopes: PARLUME_GRANT_SCOPES,
		}),
		createdAt: new Date("2026-01-01T00:00:00Z"),
		expiresAt: new Date("2026-01-02T00:00:00Z"),
	};
}

function personalKey(): GatewaySession {
	return {
		...pinned(),
		pinnedProjectId: null,
		credential: "personal-key",
		scopes: ["*"],
	};
}

function payload(result: { content: Array<{ text: string }> }) {
	return JSON.parse(result.content[0].text);
}

const storyOf = (kind: "FEATURE" | "BUG") => ({
	id: `story-${kind}`,
	identifier: "42",
	title: "Export the roadmap",
	kind,
	priority: "P2_MEDIUM",
	size: null,
	draftingStage: "PLACEHOLDER",
	statusId: "st1",
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getProjectAccessContext.mockResolvedValue({
		organizationId: "org-1",
	});
	mocks.canCreateProjectStory.mockResolvedValue(true);
	mocks.findFirst.mockResolvedValue(null);
	mocks.isOrganizationMember.mockResolvedValue(true);
	mocks.findOpenBacklogTitleCollision.mockResolvedValue(null);
	mocks.dispatchLifecycleEvent.mockResolvedValue(undefined);
	mocks.triggerStoryBodyDraft.mockResolvedValue({ workflowId: "w" });
	mocks.createStoryFromProposal.mockImplementation(
		async ({ kind }: { kind: "FEATURE" | "BUG" }) => ({
			story: storyOf(kind),
			aiDrafted: false,
		}),
	);
});

describe.each([
	["fabric_create_feature", "FEATURE"],
	["fabric_create_bug", "BUG"],
] as const)("%s on a pinned session", (tool, kind) => {
	it("files the item from the words given, without drafting the body inline", async () => {
		const result = await executePlatformTool(
			tool,
			{ title: "Export the roadmap", description: "As a CSV" },
			pinned(),
		);

		expect(result.isError).toBeUndefined();
		expect(mocks.createStoryFromProposal).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: PROJECT,
				kind,
				skipClassifier: true,
				skipDrafting: true,
				bodyAlreadyDrafted: true,
			}),
		);
	});

	it("has the body drafted afterwards, for the kind it was filed as", async () => {
		await executePlatformTool(
			tool,
			{ title: "Export the roadmap" },
			pinned(),
		);

		expect(mocks.triggerStoryBodyDraft).toHaveBeenCalledWith({
			storyId: `story-${kind}`,
			projectId: PROJECT,
			userId: "user-1",
			organizationId: "org-1",
			targetKind: kind,
		});
	});

	it("answers at once with the identifier, saying the body follows", async () => {
		const result = await executePlatformTool(
			tool,
			{ title: "Export the roadmap" },
			pinned(),
		);

		expect(payload(result)).toMatchObject({
			success: true,
			created: true,
			identifier: "42",
			draftingInBackground: true,
		});
	});

	it("files in the meeting's project when the call leaves the project out", async () => {
		await executePlatformTool(
			tool,
			{ title: "Export the roadmap" },
			pinned(),
		);

		expect(mocks.createStoryFromProposal).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: PROJECT }),
		);
	});

	it("still files the item when the drafting could not be queued", async () => {
		mocks.triggerStoryBodyDraft.mockResolvedValue(null);

		const result = await executePlatformTool(
			tool,
			{ title: "Export the roadmap" },
			pinned(),
		);

		expect(payload(result)).toMatchObject({ created: true });
	});

	it("is refused for another project before anything is filed", async () => {
		const result = await executePlatformTool(
			tool,
			{ title: "Export the roadmap", projectId: "another-project" },
			pinned(),
		);

		expect(result.isError).toBe(true);
		expect(mocks.createStoryFromProposal).not.toHaveBeenCalled();
	});

	it("does not defer drafting for a session that is not pinned", async () => {
		const result = await executePlatformTool(
			tool,
			{ title: "Export the roadmap", projectId: PROJECT },
			personalKey(),
		);

		const [params] = mocks.createStoryFromProposal.mock.calls[0] ?? [];
		expect(params).not.toHaveProperty("skipDrafting");
		expect(params).not.toHaveProperty("bodyAlreadyDrafted");
		expect(mocks.triggerStoryBodyDraft).not.toHaveBeenCalled();
		expect(payload(result)).not.toHaveProperty("draftingInBackground");
	});
});
