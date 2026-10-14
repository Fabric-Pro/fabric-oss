/**
 * `projects.stories.linkPmItem`: declares STORY_UPDATE on the project, takes
 * a trimmed, non-empty id of at most 200 characters, and hands the story
 * and the caller to the shared `linkPmItem` (covered in
 * `lib/__tests__/link-pm-item.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

const mocks = vi.hoisted(() => ({ linkPmItem: vi.fn() }));

vi.mock("../../../lib/link-pm-item", () => ({
	linkPmItem: mocks.linkPmItem,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	for (const m of ["use", "route", "output"]) {
		chain[m] = () => chain;
	}
	chain.input = (schema: unknown) => {
		chain.__input = schema;
		return chain;
	};
	chain.handler = (fn: unknown) => ({
		handler: fn,
		__permission: chain.__permission,
		__input: chain.__input,
	});
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: (p: string) => {
			chain.__permission = p;
			return () => chain;
		},
		Permissions: {
			STORY_READ: "story:read",
			STORY_UPDATE: "story:update",
		},
	};
});

import { linkStoryPmItemProcedure } from "../link-pm-item";

const proc = linkStoryPmItemProcedure as unknown as {
	handler: (ctx: { input: unknown; context: unknown }) => Promise<unknown>;
	__permission: string;
	__input: z.ZodTypeAny;
};

const PROJECT_ID = "ckproject000000000000000a";
const STORY_ID = "ckstory00000000000000000a";

beforeEach(() => {
	mocks.linkPmItem.mockReset();
});

describe("linkStoryPmItemProcedure", () => {
	it("declares STORY_UPDATE as the permission its middleware checks", () => {
		expect(proc.__permission).toBe("story:update");
	});

	it("trims the id and refuses an empty or over-long one", () => {
		const base = { projectId: PROJECT_ID, storyId: STORY_ID };
		expect(
			proc.__input.parse({ ...base, externalId: "  PROJ-12  " })
				.externalId,
		).toBe("PROJ-12");
		expect(
			proc.__input.safeParse({ ...base, externalId: "   " }).success,
		).toBe(false);
		expect(
			proc.__input.safeParse({ ...base, externalId: "x".repeat(201) })
				.success,
		).toBe(false);
	});

	it("links the story through the shared lib as the caller", async () => {
		mocks.linkPmItem.mockResolvedValue({
			linked: true,
			externalId: "PROJ-12",
			externalUrl: null,
		});

		const res = await proc.handler({
			input: {
				projectId: PROJECT_ID,
				storyId: STORY_ID,
				externalId: "PROJ-12",
			},
			context: { user: { id: "user-1" } },
		});

		expect(res).toEqual({
			linked: true,
			externalId: "PROJ-12",
			externalUrl: null,
		});
		expect(mocks.linkPmItem).toHaveBeenCalledWith({
			row: { storyId: STORY_ID },
			projectId: PROJECT_ID,
			externalId: "PROJ-12",
			userId: "user-1",
		});
	});
});
