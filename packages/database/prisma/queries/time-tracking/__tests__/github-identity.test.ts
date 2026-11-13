/**
 * Which member a GitHub login names, for time evidence.
 *
 * Prisma's delegate is mocked, so this pins the WHERE the credentials are
 * read with and the fail-closed answers: no member, or more than one, names
 * nobody.
 *
 * Run with:
 *   pnpm --filter @repo/database test github-identity
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	credential: { findMany: vi.fn() },
}));

vi.mock("../../../client", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, db: mocks };
});

const { findMemberByGitHubLogin, isGitHubDotComPullRequest } = await import(
	"../github-identity"
);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.credential.findMany.mockResolvedValue([]);
});

describe("findMemberByGitHubLogin", () => {
	it("reads members' own verified github.com credentials, ignoring the login's case", async () => {
		await findMemberByGitHubLogin({
			organizationId: "org-1",
			login: "Octo-Example",
		});

		expect(mocks.credential.findMany).toHaveBeenCalledWith({
			where: {
				organizationId: "org-1",
				userId: { not: null },
				provider: "GITHUB",
				kind: { not: "APP_INSTALLATION" },
				status: { not: "REVOKED" },
				origin: "https://github.com",
				externalAccountLogin: { not: null },
				OR: [
					{
						externalAccountLogin: {
							equals: "Octo-Example",
							mode: "insensitive",
						},
					},
				],
			},
			select: { userId: true },
		});
	});

	it("names the one member whose credentials carry the login", async () => {
		mocks.credential.findMany.mockResolvedValue([
			{ userId: "user-1" },
			{ userId: "user-1" },
		]);

		await expect(
			findMemberByGitHubLogin({
				organizationId: "org-1",
				login: "octo-example",
			}),
		).resolves.toBe("user-1");
	});

	it("names nobody when no member's credential carries the login", async () => {
		await expect(
			findMemberByGitHubLogin({
				organizationId: "org-1",
				login: "octo-example",
			}),
		).resolves.toBeNull();
	});

	it("names nobody when two members' credentials carry the login", async () => {
		mocks.credential.findMany.mockResolvedValue([
			{ userId: "user-1" },
			{ userId: "user-2" },
		]);

		await expect(
			findMemberByGitHubLogin({
				organizationId: "org-1",
				login: "octo-example",
			}),
		).resolves.toBeNull();
	});

	it("reads nothing for an empty login", async () => {
		await expect(
			findMemberByGitHubLogin({ organizationId: "org-1", login: "  " }),
		).resolves.toBeNull();
		expect(mocks.credential.findMany).not.toHaveBeenCalled();
	});
});

describe("isGitHubDotComPullRequest", () => {
	it.each([
		["GITHUB", "https://github.com/example-org/example-repo/pull/7", true],
		[
			"GITHUB",
			"https://git.example.com/example-org/example-repo/pull/7",
			false,
		],
		["GITHUB", null, false],
		["GITLAB", "https://github.com/example-org/example-repo/pull/7", false],
		["AZURE_DEVOPS", null, false],
	])("%s %s → %s", (provider, prUrl, expected) => {
		expect(isGitHubDotComPullRequest({ provider, prUrl })).toBe(expected);
	});
});
