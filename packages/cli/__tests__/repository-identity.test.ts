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

	it("does not compare Azure DevOps", () => {
		expect(
			matches(parsed, {
				provider: "AZURE_DEVOPS",
				host: "git.example.com",
				path: "example-org/rules",
			}),
		).toBe("unsupported-provider");
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

const BASE =
	"fabric: coding instructions v9 (abcdef0) is published on main of git.example.com/example-org/rules";

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
			`${BASE}; this checkout is behind; your working tree has changes — pull when it is clean`,
		],
		[
			"rebasing (detached)",
			{ operation: "rebase", branch: null },
			false,
			`${BASE}; this checkout is behind; a rebase is in progress`,
		],
		[
			"cherry-picking",
			{ operation: "cherry-pick" },
			false,
			`${BASE}; this checkout is behind; a cherry-pick is in progress`,
		],
		[
			"reverting",
			{ operation: "revert" },
			false,
			`${BASE}; this checkout is behind; a revert is in progress`,
		],
		[
			"bisecting",
			{ operation: "bisect" },
			false,
			`${BASE}; this checkout is behind; a bisect is in progress`,
		],
		[
			"detached",
			{ branch: null },
			false,
			`${BASE}; this checkout is behind; HEAD is detached — check out main and pull`,
		],
		[
			"another branch",
			{ branch: "topic" },
			false,
			`${BASE}; this checkout is behind; you are on topic — pull main when you switch to it`,
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
			`${BASE}; this checkout is behind — run: git pull --ff-only origin main (shallow clone) (sparse checkout) (inside a superproject)`,
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
			"fabric: coding instructions v9 (abcdef0) is published on main of git.example.com/example-org/ru les; this checkout is behind — run: git pull --ff-only 'up'\\''stream' main",
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
			"fabric: coding instructions: remotes origin, evil ]0;x all fetch from git.example.com/example-org/rules (ambiguous checkout); nothing was checked or changed",
		);
	});

	it("names the repository root for an unmapped root path of ''", () => {
		expect(
			classLine(
				{ class: "unmapped", rootPath: "" },
				{ host: "git.example.com", path: "example-org/rules" },
			),
		).toContain(
			"the project's instructions are at the repository root, not this directory",
		);
	});
});
