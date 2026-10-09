/**
 * A project in the trash is gone as far as the MCP gateway is concerned
 * (security audit of the MCP gateway, finding 6).
 *
 * The shared project-access queries keep resolving a trashed project on
 * purpose, because the web app's trash and restore flows need them to. The
 * gateway adds its own check, and refuses with the same words as a project
 * that does not exist or that the caller may not see.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	isProjectSoftDeleted: vi.fn(),
	getProjectAccessContext: vi.fn(),
	resolveProjectAccess: vi.fn(),
	getStoryById: vi.fn(),
	moveStory: vi.fn(),
}));

vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: vi
		.fn()
		.mockResolvedValue({ availability: "UPLOAD", readState: "DIRECT" }),
}));

vi.mock("@repo/database", () => ({
	db: {},
	isProjectSoftDeleted: mocks.isProjectSoftDeleted,
	getProjectAccessContext: mocks.getProjectAccessContext,
	resolveProjectAccess: mocks.resolveProjectAccess,
	getStoryById: mocks.getStoryById,
	moveStory: mocks.moveStory,
	StoryMoveTargetNotFoundError: class StoryMoveTargetNotFoundError extends Error {},
	hasPermission: (permissions: string[], required: string) =>
		permissions.includes(required),
	Permissions: { PROJECT_UPDATE: "project:update" },
}));

import { executePlatformTool } from "../platform-tools";
import type { GatewaySession } from "../types";

const session: GatewaySession = {
	sessionId: "session-1",
	userId: "user-1",
	organizationId: "org-1",
	projectId: null,
	userName: "Example Agent",
	email: "agent@example.com",
	role: "user",
	credential: "personal-key",
	scopes: ["*"],
	createdAt: new Date("2026-10-04T12:00:00Z"),
	expiresAt: new Date("2026-10-05T12:00:00Z"),
};

const NOT_FOUND = "Project not found or access denied";

function error(result: { content: Array<{ text: string }> }): string {
	return JSON.parse(result.content[0].text).error;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isProjectSoftDeleted.mockResolvedValue(false);
	mocks.getProjectAccessContext.mockResolvedValue({
		organizationId: "org-1",
	});
	mocks.resolveProjectAccess.mockResolvedValue({
		organizationId: "org-1",
		source: "owner",
		isVisible: true,
		permissions: ["project:update"],
	});
	mocks.getStoryById.mockResolvedValue(null);
});

describe("a trashed project on the organization-wide URL", () => {
	it("is refused to a read as if it did not exist", async () => {
		mocks.isProjectSoftDeleted.mockResolvedValue(true);

		const result = await executePlatformTool(
			"fabric_get_feature",
			{ projectId: "project-1", featureId: "feature-1" },
			session,
		);

		expect(result.isError).toBe(true);
		expect(error(result)).toBe(NOT_FOUND);
		expect(mocks.getStoryById).not.toHaveBeenCalled();
	});

	it("is refused to a write as if it did not exist", async () => {
		mocks.isProjectSoftDeleted.mockResolvedValue(true);

		const result = await executePlatformTool(
			"fabric_update_feature_status",
			{ projectId: "project-1", featureId: "feature-1", statusId: "s-1" },
			session,
		);

		expect(result.isError).toBe(true);
		expect(error(result)).toBe(NOT_FOUND);
		expect(mocks.moveStory).not.toHaveBeenCalled();
	});

	it("leaves a live project alone", async () => {
		const result = await executePlatformTool(
			"fabric_get_feature",
			{ projectId: "project-1", featureId: "feature-1" },
			session,
		);

		expect(error(result)).toBe("Feature not found");
		expect(mocks.isProjectSoftDeleted).toHaveBeenCalledWith("project-1");
	});
});
