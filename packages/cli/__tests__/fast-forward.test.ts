/**
 * The session hook's fast-forward gate and what each result prints
 * (Fizzy #2878), as plain data: no git, no disk. The gate is a table over what
 * a checkout reports, the lag reason is a table over the sync's state, and
 * every outcome has exactly the lines it is documented to print, on the channel
 * it is documented to print them on.
 */
import { describe, expect, it } from "vitest";
import type { CheckoutState } from "../src/lib/instructions/checkout.js";
import {
	type FastForwardContext,
	type FastForwardFacts,
	type FfOutcome,
	fabricCopyLag,
	fastForwardEligibility,
	fastForwardLines,
	type NotSafeReason,
} from "../src/lib/instructions/fast-forward.js";
import { HOOK_PREFIX } from "../src/lib/instructions/outcome.js";

const HEAD = "a".repeat(40);
const TIP = "b".repeat(40);

function facts(
	overrides: Partial<Omit<FastForwardFacts, "state">> & {
		state?: Partial<CheckoutState>;
	} = {},
): FastForwardFacts {
	const { state, ...rest } = overrides;
	return {
		ref: "main",
		remote: "origin",
		upstream: "origin/main",
		lockFiles: false,
		heldElsewhere: false,
		...rest,
		state: {
			branch: "main",
			head: HEAD,
			clean: true,
			operation: null,
			traits: { shallow: false, sparse: false, superproject: false },
			...state,
		},
	};
}

describe("fastForwardEligibility", () => {
	it("passes a clean checkout of the branch, tracking its upstream, with nothing else going on", () => {
		expect(fastForwardEligibility(facts())).toEqual({ eligible: true });
	});

	it("passes a sparse checkout", () => {
		expect(
			fastForwardEligibility(
				facts({
					state: {
						traits: {
							shallow: false,
							sparse: true,
							superproject: false,
						},
					},
				}),
			),
		).toEqual({ eligible: true });
	});

	it.each<[string, Parameters<typeof facts>[0], NotSafeReason]>([
		["a merge in progress", { state: { operation: "merge" } }, "operation"],
		[
			"a rebase in progress",
			{ state: { operation: "rebase" } },
			"operation",
		],
		[
			"a rebase, whose HEAD is detached too",
			{ state: { operation: "rebase", branch: null } },
			"operation",
		],
		["a detached HEAD", { state: { branch: null } }, "detached"],
		["another branch", { state: { branch: "feature/x" } }, "wrong-branch"],
		[
			"a branch with no commit yet",
			{ state: { head: null } },
			"no-upstream",
		],
		[
			"a shallow clone",
			{
				state: {
					traits: {
						shallow: true,
						sparse: false,
						superproject: false,
					},
				},
			},
			"shallow",
		],
		[
			"a submodule of another repository",
			{
				state: {
					traits: {
						shallow: false,
						sparse: false,
						superproject: true,
					},
				},
			},
			"submodule",
		],
		["a branch that tracks nothing", { upstream: null }, "no-upstream"],
		[
			"a branch that tracks another remote",
			{ upstream: "fork/main" },
			"upstream-mismatch",
		],
		[
			"a branch that tracks another branch",
			{ upstream: "origin/develop" },
			"upstream-mismatch",
		],
		["uncommitted changes", { state: { clean: false } }, "dirty"],
		["an index.lock or HEAD.lock", { lockFiles: true }, "git-busy"],
		[
			"the branch held by another work tree",
			{ heldElsewhere: true },
			"branch-busy",
		],
	])("refuses %s as %s", (_label, overrides, reason) => {
		expect(fastForwardEligibility(facts(overrides))).toEqual({
			eligible: false,
			reason,
		});
	});

	it("says the operation first, whatever else is wrong", () => {
		expect(
			fastForwardEligibility(
				facts({
					state: { operation: "rebase", branch: null, clean: false },
					upstream: null,
					lockFiles: true,
					heldElsewhere: true,
				}),
			),
		).toEqual({ eligible: false, reason: "operation" });
	});

	it("tells a dirty tree from one that is merely busy by looking at the tree first", () => {
		expect(
			fastForwardEligibility(
				facts({ state: { clean: false }, lockFiles: true }),
			),
		).toEqual({ eligible: false, reason: "dirty" });
	});

	it("compares the upstream with the remote this checkout fetches from", () => {
		expect(
			fastForwardEligibility(
				facts({ remote: "upstream", upstream: "upstream/main" }),
			),
		).toEqual({ eligible: true });
		expect(
			fastForwardEligibility(
				facts({ remote: "upstream", upstream: "origin/main" }),
			),
		).toEqual({ eligible: false, reason: "upstream-mismatch" });
	});
});

describe("fabricCopyLag", () => {
	const sync = (
		overrides: Partial<{
			automatic: boolean;
			pausedReason: string | null;
			lastRun: {
				trigger: string;
				status: string | null;
				error: string | null;
				commitSha: string | null;
				finishedAt: string | null;
			} | null;
		}> = {},
	) => ({
		automatic: true,
		pausedReason: null,
		lastRun: null,
		...overrides,
	});
	const run = (
		overrides: Partial<{ status: string | null; error: string | null }>,
	) => ({
		trigger: "WEBHOOK",
		status: "PUBLISHED" as string | null,
		error: null as string | null,
		commitSha: HEAD,
		finishedAt: "2026-10-03T10:00:00.000Z" as string | null,
		...overrides,
	});
	const lag = (
		overrides: Partial<Parameters<typeof fabricCopyLag>[0]> = {},
	) =>
		fabricCopyLag({
			headSha: TIP,
			publishedSha: HEAD,
			publishedInHistory: true,
			sync: sync(),
			...overrides,
		});

	it.each([
		[
			"a commit the secret scan refused",
			sync({
				lastRun: run({ status: "REJECTED", error: "TREE_REFUSED" }),
			}),
			"refused",
		],
		[
			"a rejected run",
			sync({ lastRun: run({ status: "REJECTED" }) }),
			"refused",
		],
		[
			"a sync still running",
			sync({ lastRun: run({ status: null }) }),
			"running",
		],
		[
			"a failed sync",
			sync({ lastRun: run({ status: "FAILED", error: "FETCH_FAILED" }) }),
			"failed",
		],
		[
			"automatic sync paused",
			sync({ pausedReason: "TOO_MANY_FAILURES" }),
			"paused",
		],
		["automatic sync off", sync({ automatic: false }), "off"],
		["nothing wrong that is known", sync(), "pending"],
	] as const)("is %s: %s", (_label, state, reason) => {
		expect(lag({ sync: state })).toBe(reason);
	});

	it("is pending when the server said nothing about the sync", () => {
		expect(lag({ sync: undefined })).toBe("pending");
	});

	it("is nothing when HEAD is the published commit", () => {
		expect(lag({ headSha: HEAD })).toBeNull();
	});

	it("is nothing when the published commit is not in HEAD's history", () => {
		expect(lag({ publishedInHistory: false })).toBeNull();
		expect(lag({ publishedInHistory: null })).toBeNull();
	});

	it("is nothing when there is no HEAD or no published commit", () => {
		expect(lag({ headSha: null })).toBeNull();
		expect(lag({ publishedSha: null })).toBeNull();
	});
});

describe("fastForwardLines", () => {
	const BEHIND = `${HOOK_PREFIX} v12 (a1b2c3d) is on main; this checkout is behind and has uncommitted changes — commit or stash, then pull.`;
	const OTHER = `${HOOK_PREFIX}: the project is repository-sourced but nothing has been published from github.com/example-org/rules yet`;
	const context = (
		overrides: Partial<FastForwardContext> = {},
	): FastForwardContext => ({
		repo: "github.com/example-org/rules",
		host: "github.com",
		ref: "main",
		remote: "origin",
		login: "gh auth login",
		commands: {
			pull: "git pull --ff-only origin main",
			rebase: "git pull --rebase origin main",
			setUpstream: "git branch --set-upstream-to=origin/main main",
			unshallow: "git fetch --unshallow origin",
			fetch: "git fetch origin main",
		},
		report: { kind: "behind", line: BEHIND },
		version: 12,
		lag: null,
		head: TIP,
		gaveUpAfter: "10 s",
		...overrides,
	});
	const lines = (
		outcome: FfOutcome,
		overrides?: Partial<FastForwardContext>,
	) => fastForwardLines(outcome, context(overrides));

	describe("a fast-forward", () => {
		const outcome: FfOutcome = {
			kind: "fast-forwarded",
			from: HEAD,
			to: TIP,
		};

		it("says where the branch went, with the version when that is the published commit", () => {
			expect(lines(outcome)).toEqual({
				stdout: [
					`${HOOK_PREFIX}: fast-forwarded main from aaaaaaa to bbbbbbb (v12).`,
				],
				stderr: [],
			});
		});

		it("leaves the version out when the published commit is not where it went", () => {
			expect(lines(outcome, { version: null }).stdout).toEqual([
				`${HOOK_PREFIX}: fast-forwarded main from aaaaaaa to bbbbbbb.`,
			]);
		});

		it("drops the behind line, which the update made stale", () => {
			expect(lines(outcome).stdout.join("\n")).not.toContain("is behind");
		});

		it("keeps a line about what was published, which the update did not change", () => {
			const result = lines(outcome, {
				report: { kind: "other", line: OTHER },
			});

			expect(result.stdout).toEqual([
				`${HOOK_PREFIX}: fast-forwarded main from aaaaaaa to bbbbbbb (v12).`,
				OTHER,
			]);
		});

		it("then says that Fabric's copy lags, and why", () => {
			const result = lines(outcome, { version: null, lag: "refused" });

			expect(result.stdout).toEqual([
				`${HOOK_PREFIX}: fast-forwarded main from aaaaaaa to bbbbbbb.`,
				`${HOOK_PREFIX}: main is at bbbbbbb; Fabric's copy is behind (a commit was refused by the secret scan — see the project's Coding Instructions tab).`,
			]);
		});
	});

	describe("already current", () => {
		it("is silent", () => {
			expect(lines({ kind: "already-current" })).toEqual({
				stdout: [],
				stderr: [],
			});
		});

		it.each([
			[
				"refused",
				"a commit was refused by the secret scan — see the project's Coding Instructions tab",
			],
			["running", "a sync is in progress"],
			[
				"failed",
				"the last sync failed — see the project's Coding Instructions tab",
			],
			[
				"paused",
				"automatic sync is paused — see the project's Coding Instructions tab",
			],
			[
				"off",
				"automatic sync is off — see the project's Coding Instructions tab",
			],
			["pending", "the next sync has not run yet"],
		] as const)("says Fabric's copy lags when %s", (lag, words) => {
			expect(lines({ kind: "already-current" }, { lag }).stdout).toEqual([
				`${HOOK_PREFIX}: main is at bbbbbbb; Fabric's copy is behind (${words}).`,
			]);
		});
	});

	describe("a checkout it left alone", () => {
		it.each<NotSafeReason>([
			"dirty",
			"wrong-branch",
			"detached",
			"operation",
		])(
			"says %s with the behind line the report already has, once",
			(reason) => {
				expect(lines({ kind: "not-safe", reason })).toEqual({
					stdout: [BEHIND],
					stderr: [],
				});
			},
		);

		it.each<NotSafeReason>([
			"dirty",
			"wrong-branch",
			"detached",
			"operation",
		])(
			"says nothing about %s when the checkout is not behind anything",
			(reason) => {
				expect(
					lines(
						{ kind: "not-safe", reason },
						{ report: { kind: "current", line: null } },
					),
				).toEqual({ stdout: [], stderr: [] });
			},
		);

		it.each([
			[
				"shallow",
				"this is a shallow clone, so main was not updated. Run: git fetch --unshallow origin && git pull --ff-only origin main",
			],
			[
				"submodule",
				"this checkout is inside another repository, so main was not updated. Update it from the superproject.",
			],
			[
				"no-upstream",
				"main does not track origin/main, so it was not updated. Run: git branch --set-upstream-to=origin/main main",
			],
			[
				"upstream-mismatch",
				"main tracks another branch than origin/main, so it was not updated. Run: git branch --set-upstream-to=origin/main main",
			],
			[
				"git-busy",
				"git is busy in this checkout (an index.lock or HEAD.lock exists), so main was not updated. When it finishes, run: git pull --ff-only origin main",
			],
			[
				"branch-busy",
				"main is checked out in another work tree of this repository, so it was not updated here. Update it there.",
			],
		] as const)(
			"says %s in its own words when the checkout is behind",
			(reason, words) => {
				expect(lines({ kind: "not-safe", reason })).toEqual({
					stdout: [`${HOOK_PREFIX}: ${words}`],
					stderr: [],
				});
			},
		);

		it.each([
			"shallow",
			"submodule",
			"no-upstream",
			"upstream-mismatch",
			"git-busy",
			"branch-busy",
		] as const)(
			"says nothing about %s when the checkout is not behind anything",
			(reason) => {
				expect(
					lines(
						{ kind: "not-safe", reason },
						{ report: { kind: "current", line: null } },
					),
				).toEqual({ stdout: [], stderr: [] });
			},
		);

		it("says what was published even when it cannot say anything about the checkout", () => {
			expect(
				lines(
					{ kind: "not-safe", reason: "shallow" },
					{ report: { kind: "other", line: OTHER } },
				).stdout,
			).toEqual([OTHER]);
		});
	});

	describe("a fetch that failed", () => {
		it("tells the agent about missing credentials, with the command that gives them", () => {
			expect(lines({ kind: "fetch-failed", reason: "auth" })).toEqual({
				stdout: [
					`${HOOK_PREFIX}: could not fetch github.com/example-org/rules: git has no credentials for github.com. Run: gh auth login`,
					BEHIND,
				],
				stderr: [],
			});
		});

		it.each([
			[
				"network",
				"could not fetch github.com/example-org/rules: github.com did not answer; nothing was updated.",
			],
			[
				"missing-ref",
				"could not fetch github.com/example-org/rules: it has no branch main; nothing was updated.",
			],
			[
				"timeout",
				"could not fetch github.com/example-org/rules: github.com answered too slowly; nothing was updated.",
			],
			[
				"other",
				"could not fetch github.com/example-org/rules. Run: git fetch origin main to see why.",
			],
		] as const)(
			"keeps %s to the log, and still says where the checkout stands",
			(reason, words) => {
				expect(lines({ kind: "fetch-failed", reason })).toEqual({
					stdout: [BEHIND],
					stderr: [`${HOOK_PREFIX} sync skipped: ${words}`],
				});
			},
		);
	});

	describe("a merge that failed", () => {
		it("tells the agent a diverged branch is the developer's to settle, and does not say it is behind", () => {
			expect(lines({ kind: "merge-failed", reason: "diverged" })).toEqual(
				{
					stdout: [
						`${HOOK_PREFIX}: main and origin/main have diverged, so nothing was updated. Run: git pull --rebase origin main, or merge origin/main yourself.`,
					],
					stderr: [],
				},
			);
		});

		it.each([
			["timeout", "updating main took too long; nothing was changed."],
			[
				"other",
				"git could not fast-forward main. Run: git pull --ff-only origin main to see why.",
			],
		] as const)("keeps %s to the log", (reason, words) => {
			expect(lines({ kind: "merge-failed", reason })).toEqual({
				stdout: [BEHIND],
				stderr: [`${HOOK_PREFIX} sync skipped: ${words}`],
			});
		});
	});

	it("says another fabric process holds the checkout, and nothing else about it", () => {
		expect(lines({ kind: "locked" })).toEqual({
			stdout: [
				`${HOOK_PREFIX}: another fabric process is updating this checkout; nothing was changed.`,
			],
			stderr: [],
		});
	});

	it("reports only, as `check` does, when the person opted out", () => {
		expect(lines({ kind: "opted-out" })).toEqual({
			stdout: [BEHIND],
			stderr: [],
		});
		expect(
			lines(
				{ kind: "opted-out" },
				{ report: { kind: "current", line: null } },
			),
		).toEqual({ stdout: [], stderr: [] });
	});

	it("keeps a ran-out budget to the log, and still says where the checkout stands", () => {
		expect(lines({ kind: "deadline" })).toEqual({
			stdout: [BEHIND],
			stderr: [`${HOOK_PREFIX} sync skipped: gave up after 10 s`],
		});
	});

	it("never prints a path, a URL with credentials, a digest, or a word git said", () => {
		const everything: FfOutcome[] = [
			{ kind: "fast-forwarded", from: HEAD, to: TIP },
			{ kind: "already-current" },
			{ kind: "locked" },
			{ kind: "opted-out" },
			{ kind: "deadline" },
			...(
				[
					"dirty",
					"wrong-branch",
					"detached",
					"operation",
					"shallow",
					"submodule",
					"no-upstream",
					"upstream-mismatch",
					"git-busy",
					"branch-busy",
				] as const
			).map((reason) => ({ kind: "not-safe", reason }) as const),
			...(
				["auth", "network", "missing-ref", "timeout", "other"] as const
			).map((reason) => ({ kind: "fetch-failed", reason }) as const),
			...(["diverged", "timeout", "other"] as const).map(
				(reason) => ({ kind: "merge-failed", reason }) as const,
			),
		];
		for (const outcome of everything) {
			const { stdout, stderr } = lines(outcome, { lag: "refused" });
			for (const text of [...stdout, ...stderr]) {
				expect(text).not.toMatch(/[A-Za-z]:\\/);
				expect(text).not.toMatch(/\/(Users|home|tmp|var)\//);
				expect(text).not.toMatch(/\b[0-9a-f]{64}\b/);
				expect(text).not.toMatch(/\b[0-9a-f]{40}\b/);
				expect(text).not.toContain("\n");
				expect(text).not.toContain("fatal:");
			}
		}
	});
});
