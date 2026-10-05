/**
 * The checkout verdict and the remote canonicaliser live in both copies of the
 * shared checks module (Fizzy #2878): `packages/cli/src/lib/instructions/checks.ts`
 * and `apps/web/modules/saas/mcp/lib/gateway/instruction-checks.ts`.
 * `checks-agree-with-gateway.test.ts` pins that the two files are
 * byte-identical after their headers; this runs one corpus through both, so a
 * divergence shows as a named case rather than as a diff, and pins what the
 * answers must be, so two copies that agree on a wrong answer still fail.
 */
import { describe, expect, it } from "vitest";
import * as gateway from "../../../apps/web/modules/saas/mcp/lib/gateway/instruction-checks.js";
import * as cli from "../src/lib/instructions/checks.js";

/** Every spelling a remote can take, and what it must canonicalise to. */
const REMOTES: Record<string, { host: string; path: string } | null> = {
	"https://github.com/example-org/example-repo": {
		host: "github.com",
		path: "example-org/example-repo",
	},
	"https://github.com/example-org/example-repo.git": {
		host: "github.com",
		path: "example-org/example-repo",
	},
	"https://github.com/example-org/example-repo/": {
		host: "github.com",
		path: "example-org/example-repo",
	},
	"https://GitHub.com/Example-Org/Example-Repo": {
		host: "github.com",
		path: "Example-Org/Example-Repo",
	},
	"ssh://git@github.com/example-org/example-repo.git": {
		host: "github.com",
		path: "example-org/example-repo",
	},
	"git@github.com:example-org/example-repo.git": {
		host: "github.com",
		path: "example-org/example-repo",
	},
	"https://gitlab.com/example-group/sub-group/example-repo.git": {
		host: "gitlab.com",
		path: "example-group/sub-group/example-repo",
	},
	"git@gitlab.com:example-group/sub-group/example-repo.git": {
		host: "gitlab.com",
		path: "example-group/sub-group/example-repo",
	},
	"https://dev.azure.com/example-org/example-project/_git/example-repo": {
		host: "dev.azure.com",
		path: "example-org/example-project/_git/example-repo",
	},
	"https://example-org@dev.azure.com/example-org/example-project/_git/example-repo":
		{
			host: "dev.azure.com",
			path: "example-org/example-project/_git/example-repo",
		},
	"https://example-org.visualstudio.com/example-project/_git/example-repo": {
		host: "dev.azure.com",
		path: "example-org/example-project/_git/example-repo",
	},
	"git@ssh.dev.azure.com:v3/example-org/example-project/example-repo": {
		host: "dev.azure.com",
		path: "example-org/example-project/_git/example-repo",
	},
	"ssh://git@ssh.dev.azure.com/v3/example-org/example-project/example-repo": {
		host: "dev.azure.com",
		path: "example-org/example-project/_git/example-repo",
	},
	"example-org@vs-ssh.visualstudio.com:v3/example-org/example-project/example-repo":
		{
			host: "dev.azure.com",
			path: "example-org/example-project/_git/example-repo",
		},
	"https://dev.azure.com/example-org/_git/example-repo": {
		host: "dev.azure.com",
		path: "example-org/_git/example-repo",
	},
	"https://example-org.visualstudio.com/_git/example-repo": {
		host: "dev.azure.com",
		path: "example-org/_git/example-repo",
	},
	"https://dev.azure.com/example-org/example-project/_GIT/example-repo": {
		host: "dev.azure.com",
		path: "example-org/example-project/_git/example-repo",
	},
	// Refused: the project's configuration is a bare host and path, and
	// anything this cannot reduce to exactly that is never taken for a match.
	"": null,
	"https://github.com:8443/example-org/example-repo": null,
	"ssh://git@github.com:22/example-org/example-repo.git": null,
	"file:///srv/example-repo": null,
	"git://github.com/example-org/example-repo": null,
	"/srv/git/example-repo": null,
	"C:\\work\\example-repo": null,
	"C:/work/example-repo": null,
	"\\\\server\\share\\example-repo": null,
	"https://github.com": null,
	"https://github.com/example-org/../example-repo": null,
	"https://github.com/example-org/example repo": null,
	"https://dev.azure.com/example-org": null,
	"https://dev.azure.com/example-org/example-project/example-repo": null,
	"https://dev.azure.com/example-org/a/b/_git/example-repo": null,
	"git@ssh.dev.azure.com:v3/example-org/example-repo": null,
	"git@ssh.dev.azure.com:v2/example-org/example-project/example-repo": null,
	"https://example-org.visualstudio.com/a/b/_git/example-repo": null,
	"https://.visualstudio.com/example-project/_git/example-repo": null,
};

const GITHUB = {
	provider: "GITHUB" as const,
	host: "github.com",
	path: "example-org/example-repo",
};
const GITLAB = {
	provider: "GITLAB" as const,
	host: "gitlab.com",
	path: "example-group/sub-group/example-repo",
};
const AZURE = {
	provider: "AZURE_DEVOPS" as const,
	host: "dev.azure.com",
	path: "example-org/example-project/_git/example-repo",
};

describe("canonicalizeRepositoryRemote", () => {
	describe.each(Object.entries(REMOTES))("%j", (url, expected) => {
		it("canonicalises as pinned, identically in both copies", () => {
			expect(cli.canonicalizeRepositoryRemote(url)).toEqual(expected);
			expect(gateway.canonicalizeRepositoryRemote(url)).toEqual(expected);
		});
	});

	it("never carries userinfo into the canonical form", () => {
		const withUserinfo = [
			"https://x-access-token:",
			"credential-marker",
			"@github.com/example-org/example-repo",
		].join("");

		for (const copy of [cli, gateway]) {
			expect(
				JSON.stringify(copy.canonicalizeRepositoryRemote(withUserinfo)),
			).not.toMatch(/credential-marker|x-access-token/);
		}
	});
});

describe("remoteMatchesRepository", () => {
	const CASES: Array<
		[
			string,
			{ host: string; path: string },
			Parameters<typeof cli.remoteMatchesRepository>[1],
			boolean,
		]
	> = [
		[
			"the same repository",
			{ host: "github.com", path: "example-org/example-repo" },
			GITHUB,
			true,
		],
		[
			"a GitHub path in another case",
			{ host: "github.com", path: "Example-Org/Example-Repo" },
			GITHUB,
			true,
		],
		[
			"another repository",
			{ host: "github.com", path: "example-org/other" },
			GITHUB,
			false,
		],
		[
			"another host",
			{ host: "gitlab.com", path: "example-org/example-repo" },
			GITHUB,
			false,
		],
		[
			"a GitLab path in another case",
			{
				host: "gitlab.com",
				path: "Example-Group/sub-group/example-repo",
			},
			GITLAB,
			false,
		],
		[
			"a GitLab path exactly",
			{
				host: "gitlab.com",
				path: "example-group/sub-group/example-repo",
			},
			GITLAB,
			true,
		],
		[
			"an Azure DevOps path in another case",
			{
				host: "dev.azure.com",
				path: "Example-Org/Example-Project/_git/Example-Repo",
			},
			AZURE,
			true,
		],
		[
			"an Azure DevOps path without the project",
			{ host: "dev.azure.com", path: "example-org/_git/example-repo" },
			AZURE,
			false,
		],
	];

	it.each(CASES)("%s", (_label, remote, repository, expected) => {
		expect(cli.remoteMatchesRepository(remote, repository)).toBe(expected);
		expect(gateway.remoteMatchesRepository(remote, repository)).toBe(
			expected,
		);
	});
});

const PUBLISHED = "a".repeat(40);
const TIP = "b".repeat(40);
const OLDER = "c".repeat(40);

function repository(sync: Record<string, unknown> = {}) {
	return {
		...GITHUB,
		ref: "main",
		rootPath: "",
		generation: 2,
		cloneUrl: "https://github.com/example-org/example-repo",
		sync: { automatic: true, pausedReason: null, lastRun: null, ...sync },
	} as Parameters<typeof cli.decideCheckoutVerdict>[0]["repository"];
}

function published(current = true) {
	return {
		kind: "REPOSITORY" as const,
		ref: "main",
		commitSha: PUBLISHED,
		current,
	};
}

function facts(overrides: Record<string, unknown> = {}) {
	return {
		remoteUrl: "https://github.com/example-org/example-repo",
		headSha: PUBLISHED,
		branch: "main" as string | null,
		clean: true,
		...overrides,
	} as Parameters<typeof cli.decideCheckoutVerdict>[0]["checkout"];
}

function refusedRun(commitSha = TIP) {
	return {
		trigger: "WEBHOOK" as const,
		status: "REJECTED" as const,
		error: "TREE_REFUSED" as const,
		commitSha,
		finishedAt: "2026-10-02T09:30:00.000Z",
	};
}

/** Every case: the facts, the published state, and the verdict and status it must get. */
const DECISIONS: Array<{
	label: string;
	checkout: ReturnType<typeof facts>;
	repository?: ReturnType<typeof repository>;
	published?: ReturnType<typeof published>;
	verdict: (typeof cli.CHECKOUT_VERDICTS)[number];
	status: "pass" | "warn" | "skip";
}> = [
	{
		label: "a clean checkout at the published commit",
		checkout: facts(),
		verdict: "current",
		status: "pass",
	},
	{
		label: "another branch at the published commit",
		checkout: facts({ branch: "feature/example" }),
		verdict: "current",
		status: "pass",
	},
	{
		label: "a detached HEAD at the published commit",
		checkout: facts({ branch: null }),
		verdict: "current",
		status: "pass",
	},
	{
		label: "a dirty tree at the published commit",
		checkout: facts({ clean: false }),
		verdict: "dirty",
		status: "warn",
	},
	{
		label: "a checkout of another repository",
		checkout: facts({
			remoteUrl: "https://github.com/other-org/other-repo",
		}),
		verdict: "foreign",
		status: "skip",
	},
	{
		label: "a remote that is not comparable",
		checkout: facts({ remoteUrl: "file:///srv/example" }),
		verdict: "foreign",
		status: "skip",
	},
	{
		label: "a checkout behind the published commit",
		checkout: facts({ headSha: OLDER }),
		verdict: "behind-or-diverged",
		status: "warn",
	},
	{
		label: "a dirty checkout behind the published commit",
		checkout: facts({ headSha: OLDER, clean: false }),
		verdict: "behind-or-diverged",
		status: "warn",
	},
	{
		label: "another branch away from the published commit",
		checkout: facts({ headSha: OLDER, branch: "feature/example" }),
		verdict: "other-branch",
		status: "skip",
	},
	{
		label: "a detached HEAD away from the published commit",
		checkout: facts({ headSha: OLDER, branch: null }),
		verdict: "other-branch",
		status: "skip",
	},
	{
		label: "the tip a refused sync evaluated",
		checkout: facts({ headSha: TIP }),
		repository: repository({ lastRun: refusedRun() }),
		verdict: "fabric-lags",
		status: "warn",
	},
	{
		label: "the tip of a sync still running",
		checkout: facts({ headSha: TIP }),
		repository: repository({
			lastRun: {
				...refusedRun(),
				status: null,
				error: null,
				finishedAt: null,
			},
		}),
		verdict: "fabric-lags",
		status: "warn",
	},
	{
		label: "the tip with automatic sync off",
		checkout: facts({ headSha: TIP }),
		repository: repository({
			automatic: false,
			lastRun: { ...refusedRun(), status: "SUCCEEDED", error: null },
		}),
		verdict: "fabric-lags",
		status: "warn",
	},
	{
		label: "a published copy from another branch",
		checkout: facts(),
		published: published(false),
		verdict: "fabric-lags",
		status: "warn",
	},
	{
		label: "a deployment that sent no sync block, behind the published commit",
		checkout: facts({ headSha: OLDER }),
		repository: { ...repository(), sync: undefined },
		verdict: "behind-or-diverged",
		status: "warn",
	},
	{
		label: "a deployment that sent no sync block, with a published copy from another branch",
		checkout: facts(),
		repository: { ...repository(), sync: undefined },
		published: published(false),
		verdict: "fabric-lags",
		status: "warn",
	},
	{
		label: "behind a tip the last sync did not take",
		checkout: facts({ headSha: OLDER }),
		repository: repository({ lastRun: refusedRun() }),
		verdict: "behind-or-diverged",
		status: "warn",
	},
	{
		label: "a clean checkout ahead of the published commit, by ancestry",
		checkout: facts({ headSha: TIP, containsPublished: true }),
		verdict: "ahead",
		status: "pass",
	},
	{
		label: "a dirty checkout ahead of the published commit",
		checkout: facts({
			headSha: TIP,
			containsPublished: true,
			clean: false,
		}),
		verdict: "ahead",
		status: "warn",
	},
	{
		label: "a checkout whose history does not contain the published commit",
		checkout: facts({ headSha: OLDER, containsPublished: false }),
		verdict: "behind-or-diverged",
		status: "warn",
	},
	{
		label: "ahead by ancestry, but on another branch",
		checkout: facts({
			headSha: TIP,
			branch: "feature/example",
			containsPublished: true,
		}),
		verdict: "other-branch",
		status: "skip",
	},
	{
		label: "the refused tip, even when ancestry says ahead",
		checkout: facts({ headSha: TIP, containsPublished: true }),
		repository: repository({ lastRun: refusedRun() }),
		verdict: "fabric-lags",
		status: "warn",
	},
];

describe("decideCheckoutVerdict", () => {
	it.each(DECISIONS)("$label", (c) => {
		const input = {
			checkout: c.checkout,
			repository: c.repository ?? repository(),
			published: c.published ?? published(),
		};

		const fromCli = cli.decideCheckoutVerdict(input);
		const fromGateway = gateway.decideCheckoutVerdict(input);

		expect(fromGateway).toEqual(fromCli);
		expect(fromCli).toMatchObject({ verdict: c.verdict, status: c.status });
		expect(fromCli.detail).toMatch(/\S/);
	});

	it("exercises every verdict, so two copies agreeing on one answer cannot pass as agreement", () => {
		expect(new Set(DECISIONS.map((c) => c.verdict))).toEqual(
			new Set(cli.CHECKOUT_VERDICTS),
		);
		expect([...gateway.CHECKOUT_VERDICTS]).toEqual([
			...cli.CHECKOUT_VERDICTS,
		]);
	});

	it("grants no authority in any remedy, and never prints the remote as given", () => {
		const withUserinfo = [
			"https://x-access-token:",
			"credential-marker",
			"@github.com/other-org/other-repo.git",
		].join("");

		for (const c of DECISIONS) {
			const decision = cli.decideCheckoutVerdict({
				checkout: {
					...c.checkout,
					remoteUrl: c.label.includes("another repository")
						? withUserinfo
						: c.checkout.remoteUrl,
				},
				repository: c.repository ?? repository(),
				published: c.published ?? published(),
			});
			expect(decision.fix?.command).toBeUndefined();
			expect(JSON.stringify(decision)).not.toMatch(
				/credential-marker|x-access-token/,
			);
		}
	});
});
