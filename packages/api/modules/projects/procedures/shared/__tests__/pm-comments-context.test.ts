import { describe, expect, it, vi } from "vitest";

// pm-comments-context imports db/utils/logs at module level for the
// orchestration helper; stub them so the pure-mapper test stays isolated.
vi.mock("@repo/database", () => ({
	db: {},
	resolvePMConfigForUser: vi.fn(),
	isPmServerIdKeySentinel: vi.fn(),
	readPmServerIdKeySentinel: vi.fn(),
}));
vi.mock("@repo/utils", () => ({ pmServerKeyToDetectedType: vi.fn() }));
vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { pmCommentsToContextItems } from "../pm-comments-context";

describe("pmCommentsToContextItems", () => {
	it("maps comments to PM_COMMENT context items", () => {
		const items = pmCommentsToContextItems(
			[
				{
					author: "Dana",
					createdAt: "2026-05-26T10:00:00.000Z",
					body: "Decision: ship it",
				},
				{ author: null, createdAt: null, body: "follow-up" },
			],
			{
				toolLabel: "Azure DevOps",
				linkOrId: "https://dev.azure.com/x/42",
			},
		);
		expect(items).toEqual([
			{
				sourceLabel: "Azure DevOps comment",
				sourceType: "PM_COMMENT",
				sourceDate: "2026-05-26T10:00:00.000Z",
				sourceLinkOrId: "https://dev.azure.com/x/42",
				content: "From: Dana\nDecision: ship it",
			},
			{
				sourceLabel: "Azure DevOps comment",
				sourceType: "PM_COMMENT",
				sourceDate: "",
				sourceLinkOrId: "https://dev.azure.com/x/42",
				content: "follow-up",
			},
		]);
	});

	it("returns [] for no comments", () => {
		expect(
			pmCommentsToContextItems([], { toolLabel: "Fizzy", linkOrId: "1" }),
		).toEqual([]);
	});
});
