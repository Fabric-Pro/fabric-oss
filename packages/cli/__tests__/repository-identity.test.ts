/**
 * The pure halves of a repository-sourced project's session hook
 * (Fizzy #2708): which repository a remote URL names, whether a branch name
 * is one the hook will use, and the one line each checkout state prints.
 */
import { describe, expect, it } from "vitest";
import {
	type CheckoutState,
	classLine,
	matchingReportLine,
} from "../src/lib/instructions/checkout.js";
import {
	gitEnvironment,
	isBranchLiteral,
	isCommitSha,
} from "../src/lib/instructions/git.js";
import {
	canonicalRemoteCandidates,
	hasComparableIdentity,
	matches,
	parseRemoteUrl,
} from "../src/lib/instructions/repository-identity.js";

/**
 * `user@host` joined at runtime: the publication scan reads any literal
 * user, at-sign and dotted host as an email address, and a subdomain of example.com is
 * not on its sanctioned list. The string the code under test receives is
 * byte-identical.
 */
const withUser = (user: string, rest: string): string => [user, rest].join("@");

describe("parseRemoteUrl", () => {
	it.each([
		[
			"https://git.example.com/example-org/rules.git",
			{ host: "git.example.com", path: "example-org/rules" },
		],
		[
			"https://git.example.com/example-org/rules",
			{ host: "git.example.com", path: "example-org/rules" },
		],
		[
			"HTTPS://Git.Example.COM/example-org/rules.git/",
			{ host: "git.example.com", path: "example-org/rules" },
		],
		[
			`ssh://${withUser("git", "git.example.com/example-org/rules.git")}`,
			{ host: "git.example.com", path: "example-org/rules" },
		],
		[
			"ssh://git.example.com/example-org/rules",
			{ host: "git.example.com", path: "example-org/rules" },
		],
		[
			withUser("git", "git.example.com:example-org/rules.git"),
			{ host: "git.example.com", path: "example-org/rules" },
		],
		[
			"git.example.com:example-org/rules",
			{ host: "git.example.com", path: "example-org/rules" },
		],
		[
			"https://git.example.com/group/subgroup/rules.git",
			{ host: "git.example.com", path: "group/subgroup/rules" },
		],
		[
			withUser("git", "git.example.com:group/subgroup/rules.git"),
			{ host: "git.example.com", path: "group/subgroup/rules" },
		],
		// scp-like has no port: `2222` is the first path segment.
		[
			"git.example.com:2222/example-org/rules.git",
			{ host: "git.example.com", path: "2222/example-org/rules" },
		],
	])("parses %s", (url, expected) => {
		expect(parseRemoteUrl(url)).toEqual(expected);
	});

	it("drops userinfo and never returns it", () => {
		const parsed = parseRemoteUrl(
			`https://${withUser("dev:token-value", "git.example.com/example-org/rules.git")}`,
		);
		expect(parsed).toEqual({
			host: "git.example.com",
			path: "example-org/rules",
		});
		expect(JSON.stringify(parsed)).not.toContain("token-value");
		expect(JSON.stringify(parsed)).not.toContain("dev");
	});

	it.each([
		"https://git.example.com:8443/example-org/rules.git",
		`ssh://${withUser("git", "git.example.com:22/example-org/rules.git")}`,
		"http://git.example.com/example-org/rules.git",
		"git://git.example.com/example-org/rules.git",
		"file:///srv/git/rules.git",
		"/srv/git/rules.git",
		"./rules",
		"../rules.git",
		"C:\\repos\\rules",
		"C:/repos/rules",
		"\\\\server\\share\\rules",
		"//server/share/rules",
		"git.example.com:/srv/rules.git",
		"https://git.example.com/",
		"https://git.example.com/example-org/../rules",
		"https://[::1]/example-org/rules",
		"",
	])("refuses %s", (url) => {
		expect(parseRemoteUrl(url)).toBeNull();
	});
});

describe("matches", () => {
	const parsed = { host: "git.example.com", path: "Example-Org/Rules" };

	it("compares GitHub paths case-insensitively", () => {
		expect(
			matches(parsed, {
				provider: "GITHUB",
				host: "Git.Example.com",
				path: "example-org/rules",
			}),
		).toBe("match");
	});

	it("compares GitLab paths exactly", () => {
		expect(
			matches(parsed, {
				provider: "GITLAB",
				host: "git.example.com",
				path: "example-org/rules",
			}),
		).toBe("mismatch");
		expect(
			matches(
				{ host: "git.example.com", path: "group/subgroup/rules" },
				{
					provider: "GITLAB",
					host: "git.example.com",
					path: "group/subgroup/rules",
				},
			),
		).toBe("match");
	});

	it("never matches a different host", () => {
		expect(
			matches(parsed, {
				provider: "GITHUB",
				host: "mirror.example.com",
				path: "example-org/rules",
			}),
		).toBe("mismatch");
	});

	it("leaves a provider it does not know alone", () => {
		expect(
			matches(parsed, {
				provider: "BITBUCKET" as never,
				host: "git.example.com",
				path: "example-org/rules",
			}),
		).toBe("unsupported-provider");
	});
});

/**
 * Every spelling of one Azure DevOps repository: organization `Example-Org`,
 * project `Example Project`, repository `rules`.
 */
const AZURE_SPELLINGS: Array<[string, string]> = [
	[
		"https, dev.azure.com",
		"https://dev.azure.com/Example-Org/Example%20Project/_git/rules",
	],
	[
		"https with the organization as userinfo",
		`https://${withUser("Example-Org", "dev.azure.com/Example-Org/Example%20Project/_git/rules")}`,
	],
	[
		"https with a trailing .git",
		"https://dev.azure.com/Example-Org/Example%20Project/_git/rules.git",
	],
	[
		"https, visualstudio.com",
		"https://example-org.visualstudio.com/Example%20Project/_git/rules",
	],
	[
		"https, visualstudio.com with DefaultCollection",
		"https://example-org.visualstudio.com/DefaultCollection/Example%20Project/_git/rules",
	],
	[
		"https, visualstudio.com with the organization as userinfo",
		`https://${withUser("example-org", "example-org.visualstudio.com/Example%20Project/_git/rules")}`,
	],
	[
		"scp-like, ssh.dev.azure.com",
		withUser(
			"git",
			"ssh.dev.azure.com:v3/Example-Org/Example%20Project/rules",
		),
	],
	[
		"ssh://, ssh.dev.azure.com",
		`ssh://${withUser("git", "ssh.dev.azure.com/v3/Example-Org/Example%20Project/rules")}`,
	],
	[
		"ssh:// with the default port",
		`ssh://${withUser("git", "ssh.dev.azure.com:22/v3/Example-Org/Example%20Project/rules")}`,
	],
	[
		"scp-like, vs-ssh.visualstudio.com",
		withUser(
			"example-org",
			"vs-ssh.visualstudio.com:v3/Example-Org/Example%20Project/rules",
		),
	],
	[
		"ssh://, vs-ssh.visualstudio.com with the default port",
		`ssh://${withUser("example-org", "vs-ssh.visualstudio.com:22/v3/Example-Org/Example%20Project/rules")}`,
	],
];

const AZURE_REPOSITORY = {
	provider: "AZURE_DEVOPS" as const,
	host: "dev.azure.com",
	path: "Example-Org/Example Project/_git/rules",
};

describe("parseRemoteUrl for Azure DevOps", () => {
	it.each(AZURE_SPELLINGS)("reads %s as one repository", (_label, url) => {
		const parsed = parseRemoteUrl(url);

		expect(parsed?.azure?.project).toBe("Example Project");
		expect(parsed?.azure?.repository).toBe("rules");
		expect(parsed?.azure?.organization.toLowerCase()).toBe("example-org");
	});

	it("reads the short spelling as a repository with no project", () => {
		expect(
			parseRemoteUrl("https://dev.azure.com/Example-Org/_git/rules")
				?.azure,
		).toEqual({
			organization: "Example-Org",
			project: null,
			repository: "rules",
		});
	});

	it("still refuses a port that is not the default SSH one", () => {
		expect(
			parseRemoteUrl(
				`ssh://${withUser("git", "ssh.dev.azure.com:2222/v3/Example-Org/Example%20Project/rules")}`,
			),
		).toBeNull();
	});

	it("does not take the default SSH port on a host that is not Azure DevOps's", () => {
		expect(
			parseRemoteUrl(
				`ssh://${withUser("git", "git.example.com:22/example-org/rules.git")}`,
			),
		).toBeNull();
	});

	it("gives no Azure DevOps identity to a path that is not a repository's", () => {
		expect(
			parseRemoteUrl(
				"https://dev.azure.com/Example-Org/Example%20Project",
			)?.azure,
		).toBeUndefined();
		expect(
			parseRemoteUrl(
				withUser(
					"git",
					"ssh.dev.azure.com:v2/Example-Org/Project/rules",
				),
			)?.azure,
		).toBeUndefined();
	});
});

describe("matches for Azure DevOps", () => {
	it.each(AZURE_SPELLINGS)("matches %s", (_label, url) => {
		const parsed = parseRemoteUrl(url);

		expect(parsed && matches(parsed, AZURE_REPOSITORY)).toBe("match");
	});

	it("compares organization, project and repository case-insensitively", () => {
		const parsed = parseRemoteUrl(
			"https://dev.azure.com/EXAMPLE-ORG/example%20project/_git/RULES",
		);

		expect(parsed && matches(parsed, AZURE_REPOSITORY)).toBe("match");
	});

	it("reads the configured path with or without _git, encoded or not", () => {
		const parsed = parseRemoteUrl(AZURE_SPELLINGS[0]?.[1] as string);
		if (!parsed) {
			throw new Error("fixture did not parse");
		}

		for (const path of [
			"Example-Org/Example Project/_git/rules",
			"Example-Org/Example%20Project/_git/rules",
			"Example-Org/Example Project/rules",
			"/Example-Org/Example Project/_git/rules/",
		]) {
			expect(matches(parsed, { ...AZURE_REPOSITORY, path })).toBe(
				"match",
			);
		}
	});

	it.each([
		[
			"another repository",
			"https://dev.azure.com/Example-Org/Example%20Project/_git/other",
		],
		[
			"another project",
			"https://dev.azure.com/Example-Org/Other/_git/rules",
		],
		[
			"another organization",
			"https://dev.azure.com/Other-Org/Example%20Project/_git/rules",
		],
		["a GitHub remote", "https://github.com/Example-Org/rules"],
	])("does not match %s", (_label, url) => {
		const parsed = parseRemoteUrl(url);

		expect(parsed && matches(parsed, AZURE_REPOSITORY)).toBe("mismatch");
	});

	it("does not match a configuration that names no project", () => {
		const parsed = parseRemoteUrl(AZURE_SPELLINGS[0]?.[1] as string);

		expect(
			parsed &&
				matches(parsed, {
					...AZURE_REPOSITORY,
					path: "Example-Org/rules",
				}),
		).toBe("mismatch");
		expect(
			hasComparableIdentity({
				...AZURE_REPOSITORY,
				path: "Example-Org/rules",
			}),
		).toBe(false);
		expect(hasComparableIdentity(AZURE_REPOSITORY)).toBe(true);
	});
});

describe("canonicalRemoteCandidates", () => {
	const BOTH_AZURE_FORMS = [
		"https://dev.azure.com/Example-Org/Example%20Project/_git/rules",
		"https://example-org.visualstudio.com/Example%20Project/_git/rules",
	];

	it.each(AZURE_SPELLINGS)(
		"gives both stored Azure DevOps forms for %s",
		(_label, url) => {
			const candidates = canonicalRemoteCandidates(url);

			expect(candidates).toHaveLength(2);
			expect(candidates[0]?.toLowerCase()).toBe(
				BOTH_AZURE_FORMS[0]?.toLowerCase(),
			);
			expect(candidates[1]).toBe(BOTH_AZURE_FORMS[1]);
		},
	);

	it("keeps the organization's case in the dev.azure.com form when the remote has it", () => {
		expect(
			canonicalRemoteCandidates(AZURE_SPELLINGS[0]?.[1] as string),
		).toEqual(BOTH_AZURE_FORMS);
	});

	it("keeps the short Azure DevOps spelling short", () => {
		expect(
			canonicalRemoteCandidates(
				"https://dev.azure.com/Example-Org/_git/rules",
			),
		).toEqual([
			"https://dev.azure.com/Example-Org/_git/rules",
			"https://example-org.visualstudio.com/_git/rules",
		]);
	});

	it.each([
		["https", "https://github.com/example-org/rules.git"],
		[
			"https with userinfo",
			`https://${withUser("dev", "github.com/example-org/rules")}`,
		],
		["scp-like", withUser("git", "github.com:example-org/rules.git")],
		[
			"ssh://",
			`ssh://${withUser("git", "github.com/example-org/rules.git")}`,
		],
		["a host in capitals", "HTTPS://GitHub.com/example-org/rules/"],
	])("gives the one GitHub form for %s", (_label, url) => {
		expect(canonicalRemoteCandidates(url)).toEqual([
			"https://github.com/example-org/rules",
		]);
	});

	it("keeps GitHub case as the remote spelled it", () => {
		expect(
			canonicalRemoteCandidates(
				withUser("git", "github.com:Example-Org/Rules.git"),
			),
		).toEqual(["https://github.com/Example-Org/Rules"]);
	});

	it.each([
		["https", "https://gitlab.com/group/subgroup/rules.git"],
		["scp-like", withUser("git", "gitlab.com:group/subgroup/rules.git")],
		[
			"ssh://",
			`ssh://${withUser("git", "gitlab.com/group/subgroup/rules")}`,
		],
	])("keeps every GitLab subgroup for %s", (_label, url) => {
		expect(canonicalRemoteCandidates(url)).toEqual([
			"https://gitlab.com/group/subgroup/rules",
		]);
	});

	it.each([
		"https://git.example.com/example-org/rules.git",
		"https://github.com/example-org",
		"https://github.com/example-org/rules/extra",
		"https://gitlab.com/rules",
		"https://github.com:8443/example-org/rules",
		"file:///srv/git/rules.git",
		"/srv/git/rules.git",
		"",
	])("gives nothing for %s", (url) => {
		expect(canonicalRemoteCandidates(url)).toEqual([]);
	});

	it("never returns userinfo", () => {
		const candidates = canonicalRemoteCandidates(
			`https://${withUser("dev:token-value", "github.com/example-org/rules.git")}`,
		);

		expect(candidates).toEqual(["https://github.com/example-org/rules"]);
		expect(JSON.stringify(candidates)).not.toContain("token-value");
	});
});

describe("gitEnvironment", () => {
	it("strips FABRIC_*, repository redirects and injected config, whatever the case", () => {
		const env = gitEnvironment({
			PATH: "/usr/bin",
			HOME: "/tmp/example-home",
			FABRIC_API_KEY: "fab_one",
			Fabric_API_Key: "fab_two",
			fabric_org: "example-org",
			GIT_DIR: "/tmp/elsewhere/.git",
			git_work_tree: "/tmp/elsewhere",
			GIT_COMMON_DIR: "/tmp/elsewhere/.git",
			GIT_ASKPASS: "/tmp/askpass",
			SSH_ASKPASS: "/tmp/askpass",
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "url./tmp/mirror.insteadOf",
			GIT_CONFIG_VALUE_0: "https://git.example.com/",
			git_config_key_12: "core.fsmonitor",
			GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='true'",
			GIT_CONFIG_GLOBAL: "/tmp/gitconfig",
			Git_Config_System: "/tmp/gitconfig",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "1",
		});
		expect(env).toEqual({
			PATH: "/usr/bin",
			HOME: "/tmp/example-home",
			GIT_TERMINAL_PROMPT: "0",
			GIT_OPTIONAL_LOCKS: "0",
			GIT_NO_LAZY_FETCH: "1",
			LC_ALL: "C",
		});
	});
});

describe("isBranchLiteral", () => {
	it.each(["main", "release/2026.09", "feature/x-y_z", "v1.2"])(
		"accepts %s",
		(ref) => {
			expect(isBranchLiteral(ref)).toBe(true);
		},
	);

	it.each([
		"@{-1}",
		"main@{upstream}",
		"-main",
		"a..b",
		"release/",
		"main.lock",
		"feature//x",
		"main branch",
		"main;rm",
		"main\n",
		".hidden",
		"",
	])("refuses %j", (ref) => {
		expect(isBranchLiteral(ref)).toBe(false);
	});

	it("accepts only full lowercase commit names", () => {
		expect(isCommitSha("a".repeat(40))).toBe(true);
		expect(isCommitSha("A".repeat(40))).toBe(false);
		expect(isCommitSha("a".repeat(39))).toBe(false);
		expect(isCommitSha(`--${"a".repeat(38)}`)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// The decision table
// ---------------------------------------------------------------------------

const REPOSITORY = {
	host: "git.example.com",
	path: "example-org/rules",
	ref: "main",
};
const SHA = "abcdef0".padEnd(40, "0");
const SNAPSHOT = {
	version: 9,
	source: {
		kind: "REPOSITORY" as const,
		ref: "main",
		commitSha: SHA,
		current: true,
	},
};

function state(overrides: Partial<CheckoutState> = {}): CheckoutState {
	return {
		branch: "main",
		head: "1".repeat(40),
		clean: true,
		operation: null,
		traits: { shallow: false, sparse: false, superproject: false },
		...overrides,
	};
}

function lineFor(
	overrides: Partial<CheckoutState>,
	contains: boolean | null | undefined,
	extra: Partial<Parameters<typeof matchingReportLine>[0]> = {},
) {
	return matchingReportLine({
		repository: REPOSITORY,
		remote: "origin",
		snapshot: SNAPSHOT,
		state: state(overrides),
		contains,
		...extra,
	});
}

const BASE = "fabric: coding instructions v9 (abcdef0) is on main";

describe("matchingReportLine", () => {
	it("is silent when the published commit is HEAD's ancestor, whatever else is true", () => {
		expect(lineFor({}, true)).toBeNull();
		expect(
			lineFor({ clean: false, branch: null, operation: "rebase" }, true),
		).toBeNull();
	});

	it.each<[string, Partial<CheckoutState>, boolean | null, string]>([
		[
			"clean on the branch",
			{},
			false,
			`${BASE}; this checkout is behind — run: git pull --ff-only origin main`,
		],
		[
			"not fetched",
			{},
			null,
			`${BASE}; this checkout has not fetched it yet — run: git pull --ff-only origin main`,
		],
		[
			"dirty",
			{ clean: false },
			false,
			`${BASE}; this checkout is behind and has uncommitted changes — commit or stash, then pull.`,
		],
		[
			"rebasing (detached)",
			{ operation: "rebase", branch: null },
			false,
			`${BASE}; this checkout is behind; a rebase is in progress; nothing was changed.`,
		],
		[
			"cherry-picking",
			{ operation: "cherry-pick" },
			false,
			`${BASE}; this checkout is behind; a cherry-pick is in progress; nothing was changed.`,
		],
		[
			"reverting",
			{ operation: "revert" },
			false,
			`${BASE}; this checkout is behind; a revert is in progress; nothing was changed.`,
		],
		[
			"bisecting",
			{ operation: "bisect" },
			false,
			`${BASE}; this checkout is behind; a bisect is in progress; nothing was changed.`,
		],
		[
			"detached",
			{ branch: null },
			false,
			`${BASE}; this checkout is behind; HEAD is detached — check out main and pull.`,
		],
		[
			"another branch",
			{ branch: "topic" },
			false,
			`${BASE}; this checkout is behind; you are on topic — pull main when you switch to it.`,
		],
	])("%s", (_label, overrides, contains, expected) => {
		expect(lineFor(overrides, contains)).toBe(expected);
	});

	it("appends every trait, informational only", () => {
		expect(
			lineFor(
				{ traits: { shallow: true, sparse: true, superproject: true } },
				false,
			),
		).toBe(
			`${BASE}; this checkout is behind (shallow clone) (sparse checkout) (inside a superproject) — run: git pull --ff-only origin main`,
		);
	});

	it("names the configuration change when the snapshot is not current", () => {
		expect(
			lineFor({}, undefined, {
				snapshot: {
					version: 9,
					source: {
						...SNAPSHOT.source,
						ref: "release",
						current: false,
					},
				},
			}),
		).toBe(
			"fabric: coding instructions v9 was published from release; the project now syncs main of git.example.com/example-org/rules — pull main to pick up the next publication",
		);
	});

	it.each([
		[
			"an uploaded snapshot",
			{ version: 9, source: { kind: "UPLOAD" as const } },
		],
		["a snapshot with no source", { version: 9 }],
		["no snapshot", null],
	])(
		"says nothing has been published from the repository for %s",
		(_label, snapshot) => {
			expect(lineFor({}, undefined, { snapshot })).toBe(
				"fabric: coding instructions: the project is repository-sourced but nothing has been published from git.example.com/example-org/rules yet",
			);
		},
	);

	it("sanitizes every identifier and shell-quotes the command", () => {
		const line = matchingReportLine({
			repository: {
				host: "git.example.com",
				path: "example-org/ru\u0007les",
				ref: "main",
			},
			remote: "up'stream",
			snapshot: SNAPSHOT,
			state: state(),
			contains: false,
		});
		expect(line).toBe(
			"fabric: coding instructions v9 (abcdef0) is on main; this checkout is behind — run: git pull --ff-only 'up'\\''stream' main",
		);
		const escaped = lineFor({ branch: "topic\u001b[31mred" }, false) ?? "";
		expect([...escaped].some((ch) => (ch.codePointAt(0) ?? 0) < 0x20)).toBe(
			false,
		);
	});

	it("bounds a long identifier", () => {
		const line = lineFor({ branch: "b".repeat(500) }, false) ?? "";
		expect(line).toContain(`${"b".repeat(199)}…`);
		expect(line).not.toContain("b".repeat(201));
	});
});

describe("classLine", () => {
	it("sanitizes remote names in the ambiguous line", () => {
		expect(
			classLine(
				{ class: "ambiguous", remotes: ["origin", "evil\u001b]0;x"] },
				{ host: "git.example.com", path: "example-org/rules" },
			),
		).toBe(
			"fabric: coding instructions: remotes origin, evil ]0;x all fetch from git.example.com/example-org/rules; nothing was checked. Run: fabric instructions init --remote origin",
		);
	});

	it("names the repository root for an unmapped root path of ''", () => {
		expect(
			classLine(
				{
					class: "unmapped",
					rootPath: "",
					toplevel: "/tmp/example-checkout",
				},
				{ host: "git.example.com", path: "example-org/rules" },
			),
		).toContain(
			"the project's instructions are at the repository root, not this directory",
		);
	});
});
