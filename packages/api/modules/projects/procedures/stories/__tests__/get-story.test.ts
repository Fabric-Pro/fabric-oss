/**
 * `getStoryProcedure`'s `canEdit`, which gates the story editor and the AI
 * assistant's Confirm. It must answer the way the writes' permission
 * middleware does: project-authoritative, so a ProjectMember role overrides
 * the organization role. Resolved organization-role-first, it handed a
 * project viewer an editable editor and a Confirm whose save was refused.
 */

import { Permissions as P } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (args: {
	input: Record<string, unknown>;
	context: Record<string, unknown>;
}) => Promise<unknown>;

const captured = vi.hoisted((): { handler: Handler | null } => ({
	handler: null,
}));

const mocks = vi.hoisted(() => ({
	hasProjectAccess: vi.fn(),
	getStory: vi.fn(),
	resolveEffective: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	hasProjectAccess: mocks.hasProjectAccess,
	getStoryByIdWithSourceMeeting: mocks.getStory,
	resolveMeetingDisplayName: () => null,
}));

vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: mocks.resolveEffective,
}));

vi.mock("../../../lib/resolve-story-media-urls-in-content", () => ({
	resolveStoryMediaUrlsInContent: async (text: string | null) => text,
}));

vi.mock("../../../lib/strip-internal-story-fields", () => ({
	stripInternalStoryFields: <T>(story: T) => story,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {
		use: () => builder,
		route: () => builder,
		input: () => builder,
		output: () => builder,
		handler: (fn: Handler) => {
			captured.handler = fn;
			return builder;
		},
	};
	return {
		Permissions: { STORY_READ: "story:read" },
		requireProjectPermission: () => "require",
		resolveOrganizationId: () => "org-1",
		tenantProtectedProcedure: builder,
	};
});

import "../get-story";

async function getStory(): Promise<{
	canEdit: boolean;
	canAddTags: boolean;
}> {
	if (!captured.handler) {
		throw new Error("getStoryProcedure handler was not captured");
	}
	return (await captured.handler({
		input: { projectId: "p1", storyId: "s1", organizationId: "org-1" },
		context: { user: { id: "u1" }, session: {} },
	})) as { canEdit: boolean; canAddTags: boolean };
}

describe("getStoryProcedure canEdit", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.hasProjectAccess.mockResolvedValue(true);
		mocks.getStory.mockResolvedValue({
			id: "s1",
			description: "Body",
			acceptanceCriteria: null,
			sourceMeetingTranscript: null,
		});
	});

	it("is false for a project viewer whose organization role could edit", async () => {
		// The effective permissions of an organization member who is a
		// viewer on this project: the project role wins.
		mocks.resolveEffective.mockResolvedValue({
			permissions: [P.STORY_READ],
		});

		const result = await getStory();

		expect(result.canEdit).toBe(false);
		expect(result.canAddTags).toBe(false);
	});

	it("is true when the effective permissions include story:update", async () => {
		mocks.resolveEffective.mockResolvedValue({
			permissions: [P.STORY_READ, P.STORY_UPDATE],
		});

		const result = await getStory();

		expect(result.canEdit).toBe(true);
	});

	it("is false when the project grants nothing", async () => {
		mocks.resolveEffective.mockResolvedValue(null);

		const result = await getStory();

		expect(result.canEdit).toBe(false);
	});
});
