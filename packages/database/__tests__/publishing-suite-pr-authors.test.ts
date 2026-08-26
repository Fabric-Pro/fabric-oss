import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit-level (mocked `db`), like list-publishing-topics-degrade.test.ts — NOT
// gated on RUN_DB_INTEGRATION. Exercises the in-process isolation / fail-closed
// / union control-flow, not real Postgres, so it runs in the no-Postgres suite
// and is NOT part of the db-integration real-PG count guard.
const { userStoryFindMany, projectDocumentFindMany, accountFindMany } =
	vi.hoisted(() => ({
		userStoryFindMany: vi.fn(),
		projectDocumentFindMany: vi.fn(),
		accountFindMany: vi.fn(),
	}));

vi.mock("../prisma/client", () => ({
	db: {
		userStory: { findMany: userStoryFindMany },
		projectDocument: { findMany: projectDocumentFindMany },
		account: { findMany: accountFindMany },
	},
	Prisma: {},
}));

import { resolveProjectContributorIds } from "../prisma/queries/projects/publishing-suite";

beforeEach(() => {
	userStoryFindMany.mockReset().mockResolvedValue([]);
	projectDocumentFindMany.mockReset().mockResolvedValue([]);
	accountFindMany.mockReset().mockResolvedValue([]);
	vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("resolveProjectContributorIds — PR-author attribution (FR-A2/A4/A6)", () => {
	it("unions a linked PR author (single Account) and queries by github accountId", async () => {
		accountFindMany.mockResolvedValue([
			{ accountId: "12345", userId: "u-pr" },
		]);
		const ids = await resolveProjectContributorIds("p1", {
			githubAuthorIds: ["12345"],
		});
		expect(new Set(ids)).toEqual(new Set(["u-pr"]));
		expect(accountFindMany).toHaveBeenCalledWith({
			where: { providerId: "github", accountId: { in: ["12345"] } },
			select: { accountId: true, userId: true },
		});
	});

	it("dedups a PR author already present as a story contributor", async () => {
		userStoryFindMany.mockResolvedValue([
			{ createdById: "u1", assigneeId: null },
		]);
		accountFindMany.mockResolvedValue([
			{ accountId: "12345", userId: "u1" },
		]);
		const ids = await resolveProjectContributorIds("p1", {
			storyIds: ["s1"],
			githubAuthorIds: ["12345"],
		});
		expect(ids).toEqual(["u1"]);
	});

	it("credits nobody for an author with no linked Account (unlinked / bot)", async () => {
		userStoryFindMany.mockResolvedValue([
			{ createdById: "u1", assigneeId: null },
		]);
		accountFindMany.mockResolvedValue([]);
		const ids = await resolveProjectContributorIds("p1", {
			storyIds: ["s1"],
			githubAuthorIds: ["999"],
		});
		expect(ids).toEqual(["u1"]);
	});

	it("FR-A6: fails closed on an ambiguous github id (>=2 users) — credits nobody for it, still credits an unambiguous co-author", async () => {
		accountFindMany.mockResolvedValue([
			{ accountId: "12345", userId: "u-a" },
			{ accountId: "12345", userId: "u-b" }, // ambiguous → dropped
			{ accountId: "678", userId: "u-c" }, // unambiguous → credited
		]);
		const ids = await resolveProjectContributorIds("p1", {
			githubAuthorIds: ["12345", "678"],
		});
		expect(new Set(ids)).toEqual(new Set(["u-c"]));
	});

	it("FR-A4 isolation: an Account-query failure keeps the story/doc contributors (never [])", async () => {
		userStoryFindMany.mockResolvedValue([
			{ createdById: "u1", assigneeId: "u2" },
		]);
		accountFindMany.mockRejectedValue(new Error("account query down"));
		const ids = await resolveProjectContributorIds("p1", {
			storyIds: ["s1"],
			githubAuthorIds: ["12345"],
		});
		// PR authors dropped, story contributors preserved — NOT [].
		expect(new Set(ids)).toEqual(new Set(["u1", "u2"]));
	});

	it("skips the Account query entirely when there are no github author ids", async () => {
		userStoryFindMany.mockResolvedValue([
			{ createdById: "u1", assigneeId: null },
		]);
		const ids = await resolveProjectContributorIds("p1", {
			storyIds: ["s1"],
		});
		expect(ids).toEqual(["u1"]);
		expect(accountFindMany).not.toHaveBeenCalled();
	});

	it("returns [] when all provenance is empty and never queries Account", async () => {
		const ids = await resolveProjectContributorIds("p1", {});
		expect(ids).toEqual([]);
		expect(accountFindMany).not.toHaveBeenCalled();
	});
});
