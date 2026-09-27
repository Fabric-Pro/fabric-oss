import { describe, expect, it } from "vitest";
import {
	type RepositoryIdentity,
	repositoryIdentity,
	repositoryKey,
	sameRepository,
} from "../../src/instruction-pull-requests";

// The canonical provider identity of a stored integration URL (Fizzy #2563
// spec §5.2): what admission freezes into a proposal's context, and what
// every later step compares the live integration against.
describe("repositoryIdentity", () => {
	it.each([
		[
			"GITHUB",
			"https://github.com/example-org/example-repo",
			{ provider: "GITHUB", owner: "example-org", repo: "example-repo" },
		],
		[
			"GITHUB",
			"https://github.com/example-org/example-repo.git",
			{ provider: "GITHUB", owner: "example-org", repo: "example-repo" },
		],
		[
			"GITLAB",
			"https://gitlab.com/example-group/sub/example-repo",
			{
				provider: "GITLAB",
				projectPath: "example-group/sub/example-repo",
			},
		],
		[
			"AZURE_DEVOPS",
			`https://example-org@${"dev.azure.com"}/example-org/Example%20Project/_git/example-repo`,
			{
				provider: "AZURE_DEVOPS",
				apiOrigin: "https://dev.azure.com",
				organization: "example-org",
				project: "Example Project",
				repository: "example-repo",
			},
		],
	])("reads a %s URL as its provider identity", (provider, url, expected) => {
		expect(repositoryIdentity(provider, url)).toEqual(expected);
	});

	it.each([
		[
			"another provider than the integration's",
			"GITLAB",
			"https://github.com/example-org/example-repo",
		],
		[
			"an Azure DevOps URL without a project",
			"AZURE_DEVOPS",
			"https://dev.azure.com/example-org/_git/example-repo",
		],
		[
			"a query",
			"GITHUB",
			"https://github.com/example-org/example-repo?x=1",
		],
		[
			"a fragment",
			"GITHUB",
			"https://github.com/example-org/example-repo#x",
		],
		["plain HTTP", "GITHUB", "http://github.com/example-org/example-repo"],
		[
			"an SCP-style address",
			"GITHUB",
			"git@github.com:example-org/example-repo.git",
		],
		["no URL at all", "GITHUB", "not a url"],
	])("refuses %s", (_name, provider, url) => {
		expect(repositoryIdentity(provider, url)).toBeNull();
	});
});

describe("sameRepository", () => {
	const ado: RepositoryIdentity = {
		provider: "AZURE_DEVOPS",
		apiOrigin: "https://dev.azure.com",
		organization: "example-org",
		project: "Example Project",
		repository: "example-repo",
	};

	it("holds for the same identity", () => {
		expect(
			sameRepository(
				{
					provider: "GITHUB",
					owner: "example-org",
					repo: "example-repo",
				},
				{
					provider: "GITHUB",
					owner: "example-org",
					repo: "example-repo",
				},
			),
		).toBe(true);
		expect(sameRepository(ado, { ...ado })).toBe(true);
	});

	it.each([
		[
			"the provider",
			{ provider: "GITLAB", projectPath: "example-org/example-repo" },
		],
		[
			"the owner",
			{ provider: "GITHUB", owner: "other-org", repo: "example-repo" },
		],
		[
			"the repository",
			{ provider: "GITHUB", owner: "example-org", repo: "other-repo" },
		],
	] as const)("fails on a different %s", (_field, other) => {
		expect(
			sameRepository(
				{
					provider: "GITHUB",
					owner: "example-org",
					repo: "example-repo",
				},
				other,
			),
		).toBe(false);
	});

	// GitHub resolves an owner or repository path case-insensitively (as the
	// OAuth identity check compares it), so a URL whose case alone changed
	// still names the frozen repository. GitLab paths are case-sensitive.
	it("holds for a GitHub identity whose case alone differs", () => {
		expect(
			sameRepository(
				{
					provider: "GITHUB",
					owner: "Example-Org",
					repo: "Example-Repo",
				},
				repositoryIdentity(
					"GITHUB",
					"https://github.com/example-org/EXAMPLE-repo",
				) as RepositoryIdentity,
			),
		).toBe(true);
	});

	it("fails for a GitLab project path whose case alone differs", () => {
		expect(
			sameRepository(
				{
					provider: "GITLAB",
					projectPath: "example-group/example-repo",
				},
				{
					provider: "GITLAB",
					projectPath: "Example-Group/example-repo",
				},
			),
		).toBe(false);
	});

	it.each([
		["apiOrigin", "https://example-org.visualstudio.com"],
		["organization", "other-org"],
		["project", "Other Project"],
		["repository", "other-repo"],
	] as const)("fails on a different Azure DevOps %s", (field, value) => {
		expect(sameRepository(ado, { ...ado, [field]: value })).toBe(false);
	});
});

// The key member proposal branches reserve refs under (Fizzy #2738 spec
// Decision 3). Its equality must be exactly `sameRepository`'s: a looser key
// would let two repositories share a reservation namespace needlessly, and a
// stricter one would let one repository reissue a ref.
describe("repositoryKey", () => {
	const identities: RepositoryIdentity[] = [
		{ provider: "GITHUB", owner: "example-org", repo: "example-repo" },
		{ provider: "GITHUB", owner: "Example-Org", repo: "EXAMPLE-repo" },
		{ provider: "GITHUB", owner: "example-org", repo: "other-repo" },
		{ provider: "GITHUB", owner: "other-org", repo: "example-repo" },
		{ provider: "GITLAB", projectPath: "example-org/example-repo" },
		{ provider: "GITLAB", projectPath: "Example-Org/example-repo" },
		{ provider: "GITLAB", projectPath: "example-group/sub/example-repo" },
		{
			provider: "AZURE_DEVOPS",
			apiOrigin: "https://dev.azure.com",
			organization: "example-org",
			project: "Example Project",
			repository: "example-repo",
		},
		{
			provider: "AZURE_DEVOPS",
			apiOrigin: "https://example-org.visualstudio.com",
			organization: "example-org",
			project: "Example Project",
			repository: "example-repo",
		},
		{
			provider: "AZURE_DEVOPS",
			apiOrigin: "https://dev.azure.com",
			organization: "example-org",
			project: "Example Project/example-repo",
			repository: "x",
		},
		{
			provider: "AZURE_DEVOPS",
			apiOrigin: "https://dev.azure.com",
			organization: "example-org",
			project: "Example Project",
			repository: "example-repo/x",
		},
	];

	it("is equal exactly when sameRepository holds, for every pair", () => {
		for (const a of identities) {
			for (const b of identities) {
				expect(repositoryKey(a) === repositoryKey(b)).toBe(
					sameRepository(a, b),
				);
			}
		}
	});

	it("reads as the provider and the repository's path", () => {
		expect(
			repositoryKey({
				provider: "GITHUB",
				owner: "Example-Org",
				repo: "Example-Repo",
			}),
		).toBe("github:example-org/example-repo");
		expect(
			repositoryKey({
				provider: "GITLAB",
				projectPath: "example-group/sub/example-repo",
			}),
		).toBe("gitlab:example-group/sub/example-repo");
		expect(
			repositoryKey({
				provider: "AZURE_DEVOPS",
				apiOrigin: "https://dev.azure.com",
				organization: "example-org",
				project: "Example Project",
				repository: "example-repo",
			}),
		).toBe(
			"azure_devops:https://dev.azure.com/example-org/Example%20Project/example-repo",
		);
	});

	it("keys the identity a stored URL parses to the same as the frozen one", () => {
		const frozen: RepositoryIdentity = {
			provider: "GITHUB",
			owner: "example-org",
			repo: "example-repo",
		};
		const live = repositoryIdentity(
			"GITHUB",
			"https://github.com/Example-Org/example-repo.git",
		) as RepositoryIdentity;
		expect(repositoryKey(live)).toBe(repositoryKey(frozen));
	});
});
