import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit-level (mocked `db`), like list-publishing-topics-degrade.test.ts — NOT
// gated on RUN_DB_INTEGRATION. Exercises the in-process isolation / fail-closed
// / union control-flow, not real Postgres, so it runs in the no-Postgres suite
// and is NOT part of the db-integration real-PG count guard.
const {
	userStoryFindMany,
	projectDocumentFindMany,
	accountFindMany,
	projectFindUnique,
	workflowIntegrationFindMany,
} = vi.hoisted(() => ({
	userStoryFindMany: vi.fn(),
	projectDocumentFindMany: vi.fn(),
	accountFindMany: vi.fn(),
	projectFindUnique: vi.fn(),
	workflowIntegrationFindMany: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		userStory: { findMany: userStoryFindMany },
		projectDocument: { findMany: projectDocumentFindMany },
		account: { findMany: accountFindMany },
		// A GitHub identity reaches Fabric through connecting a REPOSITORY,
		// not through social sign-in, so the resolver reads this too — see its
		// own comment. The project read is what scopes that to one tenant.
		project: { findUnique: projectFindUnique },
		workflowIntegration: { findMany: workflowIntegrationFindMany },
	},
	Prisma: {},
}));

import { resolveProjectContributorIds } from "../prisma/queries/projects/publishing-suite";

beforeEach(() => {
	userStoryFindMany.mockReset().mockResolvedValue([]);
	projectDocumentFindMany.mockReset().mockResolvedValue([]);
	accountFindMany.mockReset().mockResolvedValue([]);
	projectFindUnique
		.mockReset()
		.mockResolvedValue({ organizationId: "org-1" });
	workflowIntegrationFindMany.mockReset().mockResolvedValue([]);
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

/**
 * §1c. The resolver read `Account(providerId: "github")` alone — the table
 * Better Auth writes when someone clicks "Sign in with GitHub". That is not
 * how Fabric learns a GitHub identity: connecting a repository runs a separate
 * OAuth flow writing `WorkflowIntegration.settings.githubUserId`, and a
 * project cannot have PRs in its suggestion context unless someone completed
 * THAT flow. Two identities against twelve in production; 6% of staging topics
 * resolved any contributor at all.
 */
describe("resolveProjectContributorIds — the GitHub connection, not the login method", () => {
	it("credits an author known only through a connected repository", async () => {
		workflowIntegrationFindMany.mockResolvedValue([
			{ userId: "u-connected", settings: { githubUserId: 12345 } },
		]);

		const ids = await resolveProjectContributorIds("p1", {
			githubAuthorIds: ["12345"],
		});

		expect(new Set(ids)).toEqual(new Set(["u-connected"]));
	});

	it("compares as strings, because GitHub sends the id as a number", async () => {
		// `githubUserId` arrives from the GitHub API as a NUMBER and is stored
		// in untyped JSON; `githubAuthorIds` are strings. A `===` between them
		// silently matches nothing, which is indistinguishable from "no such
		// contributor".
		workflowIntegrationFindMany.mockResolvedValue([
			{ userId: "u-connected", settings: { githubUserId: 999 } },
		]);

		expect(
			await resolveProjectContributorIds("p1", {
				githubAuthorIds: ["999"],
			}),
		).toEqual(["u-connected"]);
	});

	it("still fails closed when the two sources disagree about one github id", async () => {
		// FR-A6 is about the IDENTITY being ambiguous, not about which table it
		// came from — so an id reachable as two different Fabric users credits
		// nobody, however it was reached.
		accountFindMany.mockResolvedValue([
			{ accountId: "12345", userId: "u-social" },
		]);
		workflowIntegrationFindMany.mockResolvedValue([
			{ userId: "u-connected", settings: { githubUserId: 12345 } },
		]);

		expect(
			await resolveProjectContributorIds("p1", {
				githubAuthorIds: ["12345"],
			}),
		).toEqual([]);
	});

	it("ignores integrations for github ids this topic never cited", async () => {
		workflowIntegrationFindMany.mockResolvedValue([
			{ userId: "u-other", settings: { githubUserId: 55555 } },
			{ userId: "u-wanted", settings: { githubUserId: 12345 } },
		]);

		expect(
			await resolveProjectContributorIds("p1", {
				githubAuthorIds: ["12345"],
			}),
		).toEqual(["u-wanted"]);
	});

	it("skips the integration read entirely for a project with no organization", async () => {
		// Nothing to scope the read to, and an unscoped sweep of every GitHub
		// integration ever created is the thing that must not happen.
		projectFindUnique.mockResolvedValue({ organizationId: null });

		await resolveProjectContributorIds("p1", {
			githubAuthorIds: ["12345"],
		});

		expect(workflowIntegrationFindMany).not.toHaveBeenCalled();
	});

	it("keeps story contributors when the integration read throws", async () => {
		userStoryFindMany.mockResolvedValue([
			{ createdById: "u-story", assigneeId: null },
		]);
		workflowIntegrationFindMany.mockRejectedValue(new Error("boom"));

		expect(
			await resolveProjectContributorIds("p1", {
				storyIds: ["s1"],
				githubAuthorIds: ["12345"],
			}),
		).toEqual(["u-story"]);
	});
});
