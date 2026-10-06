/**
 * The fast-forward run's decisions that real git cannot produce on demand
 * (Fizzy #2878): a fetch that fails for each reason, a git that outlives the
 * budget, a merge that races another writer. `git.js` is scripted, so this
 * proves what `runFastForward` does with each answer — which verb it calls, with
 * what budget, what it says and where, and that it never merges after a failed
 * or late fetch.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
	PublishedInstructionRepository,
	PublishedInstructionSnapshot,
} from "@fabricorg/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckoutReport } from "../src/lib/instructions/checkout.js";
import {
	MERGE_RESERVE_MS,
	runFastForward,
} from "../src/lib/instructions/fast-forward-run.js";

const HEAD = "a".repeat(40);
const TIP = "b".repeat(40);

const { scripted } = vi.hoisted(() => ({
	scripted: {
		branch: "main" as string | null,
		head: "a".repeat(40) as string | null,
		clean: true,
		upstream: "origin/main" as string | null,
		unreadable: false,
		fetch: vi.fn(),
		merge: vi.fn(),
		ancestor: vi.fn(),
		factReads: 0,
		advanceAtFactRead: null as number | null,
		commonDir: "",
	},
}));

vi.mock("../src/lib/instructions/git.js", () => {
	const ok = <T>(value: T) =>
		scripted.unreadable
			? { kind: "unavailable" as const, reason: "git timed out" }
			: { kind: "ok" as const, value };
	return {
		currentBranch: async () => {
			scripted.factReads += 1;
			if (scripted.advanceAtFactRead === scripted.factReads) {
				vi.setSystemTime(deadline - MERGE_RESERVE_MS + 1);
			}
			return ok(scripted.branch);
		},
		headSha: async () => ok(scripted.head),
		isClean: async () => ok(scripted.clean),
		operationInProgress: async () => ok(null),
		upstreamOf: async () => ok(scripted.upstream),
		lockFilesPresent: async () => ok(false),
		worktreesOnBranch: async () => ok([]),
		commonDir: async () => ({ kind: "ok", value: scripted.commonDir }),
		fetchRef: (...args: unknown[]) => scripted.fetch(...args),
		fastForwardTo: (...args: unknown[]) => scripted.merge(...args),
		isAncestor: (...args: unknown[]) => scripted.ancestor(...args),
		isCommitSha: (value: string) => /^[0-9a-f]{40}$/.test(value),
	};
});

const REPOSITORY: PublishedInstructionRepository = {
	provider: "GITHUB",
	host: "github.com",
	path: "example-org/rules",
	ref: "main",
	rootPath: "",
	generation: 1,
	sync: { automatic: true, pausedReason: null, lastRun: null },
};

const SNAPSHOT: PublishedInstructionSnapshot = {
	id: "snap-1",
	version: 12,
	digest: "d".repeat(64),
	fileCount: 1,
	publishedAt: null,
	source: { kind: "REPOSITORY", ref: "main", commitSha: TIP, current: true },
};

const BEHIND =
	"fabric: coding instructions v12 (bbbbbbb) is on main; this checkout is behind — run: git pull --ff-only origin main";

function report(): CheckoutReport {
	return {
		classification: {
			class: "matching",
			remote: "origin",
			toplevel: "/work/rules",
			traits: { shallow: false, sparse: false, superproject: false },
		},
		state: {
			branch: "main",
			head: HEAD,
			clean: true,
			operation: null,
			traits: { shallow: false, sparse: false, superproject: false },
		},
		contains: false,
		line: BEHIND,
		reportKind: "behind",
		json: { class: "matching", traits: [], line: BEHIND },
	};
}

let deadline: number;

async function run(
	overrides: { optedOut?: boolean } = {},
): ReturnType<typeof runFastForward> {
	return runFastForward({
		classification: {
			class: "matching",
			remote: "origin",
			toplevel: "/work/rules",
			traits: { shallow: false, sparse: false, superproject: false },
		},
		repository: REPOSITORY,
		snapshot: SNAPSHOT,
		report: report(),
		projectId: "project-1",
		deadline,
		optedOut: overrides.optedOut ?? false,
	});
}

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-10-03T10:00:00.000Z"));
	deadline = Date.now() + 9_000;
	scripted.branch = "main";
	scripted.head = HEAD;
	scripted.clean = true;
	scripted.upstream = "origin/main";
	scripted.unreadable = false;
	scripted.commonDir = await mkdtemp(path.join(tmpdir(), "fabric-ffscript-"));
	scripted.fetch.mockReset();
	scripted.fetch.mockResolvedValue({ kind: "fetched", tip: TIP });
	scripted.merge.mockReset();
	scripted.merge.mockResolvedValue({ kind: "merged", head: TIP });
	scripted.ancestor.mockReset();
	scripted.ancestor.mockResolvedValue({ kind: "ok", value: true });
	scripted.factReads = 0;
	scripted.advanceAtFactRead = null;
});

afterEach(() => {
	vi.useRealTimers();
});

describe("a fast-forward that works", () => {
	it("fetches under the budget minus the merge reserve, then merges to the fetched tip under the whole budget", async () => {
		const result = await run();

		expect(result.outcome).toEqual({
			kind: "fast-forwarded",
			from: HEAD,
			to: TIP,
		});
		expect(scripted.fetch).toHaveBeenCalledTimes(1);
		expect(scripted.fetch).toHaveBeenCalledWith(
			"/work/rules",
			"origin",
			"main",
			deadline - MERGE_RESERVE_MS,
		);
		expect(scripted.merge).toHaveBeenCalledTimes(1);
		expect(scripted.merge).toHaveBeenCalledWith(
			"/work/rules",
			TIP,
			deadline,
		);
	});

	it("reserves a second and a half for the merge", () => {
		expect(MERGE_RESERVE_MS).toBe(1_500);
	});

	it("does not merge when another Git process changes branches during the fetch", async () => {
		scripted.fetch.mockImplementation(async () => {
			scripted.branch = "feature/other";
			scripted.upstream = "origin/feature/other";
			return { kind: "fetched", tip: TIP };
		});

		const result = await run();

		expect(result.outcome).toEqual({
			kind: "not-safe",
			reason: "wrong-branch",
		});
		expect(scripted.merge).not.toHaveBeenCalled();
	});

	it("does not merge when HEAD changes after ancestry was checked", async () => {
		scripted.ancestor.mockImplementation(async () => {
			scripted.head = "c".repeat(40);
			return { kind: "ok", value: true };
		});

		const result = await run();

		expect(result.outcome).toEqual({
			kind: "not-safe",
			reason: "git-busy",
		});
		expect(scripted.merge).not.toHaveBeenCalled();
	});
});

describe("a fetch that fails", () => {
	it("is a line for the agent when credentials are missing, every time, and never merges", async () => {
		scripted.fetch.mockResolvedValue({ kind: "failed", reason: "auth" });

		const first = await run();
		const second = await run();

		for (const result of [first, second]) {
			expect(result.outcome).toEqual({
				kind: "fetch-failed",
				reason: "auth",
			});
			expect(result.stdout).toEqual([
				"fabric: coding instructions: could not fetch github.com/example-org/rules: git has no credentials for github.com. Run: gh auth login",
				BEHIND,
			]);
		}
		expect(scripted.merge).not.toHaveBeenCalled();
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
		"is only a line in the log when it was %s",
		async (reason, words) => {
			scripted.fetch.mockResolvedValue({ kind: "failed", reason });

			const result = await run();

			expect(result.outcome).toEqual({ kind: "fetch-failed", reason });
			expect(result.stderr).toEqual([
				`fabric: coding instructions sync skipped: ${words}`,
			]);
			expect(result.stdout).toEqual([BEHIND]);
			expect(scripted.merge).not.toHaveBeenCalled();
		},
	);

	it("is a fetch-failed other when git could not be run at all", async () => {
		scripted.fetch.mockResolvedValue({ kind: "unavailable", reason: "x" });

		const result = await run();

		expect(result.outcome).toEqual({
			kind: "fetch-failed",
			reason: "other",
		});
	});
});

describe("the budget", () => {
	it("is a deadline, with no merge, when the fetch is killed", async () => {
		scripted.fetch.mockResolvedValue({ kind: "timed-out" });

		const result = await run();

		expect(result.outcome).toEqual({ kind: "deadline" });
		expect(scripted.merge).not.toHaveBeenCalled();
		expect(result.stderr).toEqual([
			"fabric: coding instructions sync skipped: gave up after 10 s",
		]);
		expect(result.stdout).toEqual([BEHIND]);
	});

	it("is a deadline, with no fetch, when the reserve alone is all that is left", async () => {
		deadline = Date.now() + MERGE_RESERVE_MS;

		const result = await run();

		expect(result.outcome).toEqual({ kind: "deadline" });
		expect(scripted.fetch).not.toHaveBeenCalled();
		expect(scripted.merge).not.toHaveBeenCalled();
	});

	it("does not merge when the fetch finished but the reserve is gone", async () => {
		scripted.fetch.mockImplementation(async () => {
			vi.setSystemTime(deadline - MERGE_RESERVE_MS + 1);
			return { kind: "fetched", tip: TIP };
		});

		const result = await run();

		expect(result.outcome).toEqual({ kind: "deadline" });
		expect(scripted.merge).not.toHaveBeenCalled();
	});

	it("merges when exactly the reserve is left", async () => {
		scripted.fetch.mockImplementation(async () => {
			vi.setSystemTime(deadline - MERGE_RESERVE_MS);
			return { kind: "fetched", tip: TIP };
		});

		const result = await run();

		expect(result.outcome.kind).toBe("fast-forwarded");
	});

	it("does not start a merge when the final facts read consumes its reserve", async () => {
		scripted.advanceAtFactRead = 4;

		const result = await run();

		expect(result.outcome).toEqual({ kind: "deadline" });
		expect(scripted.merge).not.toHaveBeenCalled();
	});

	it("is a deadline when git cannot answer and the budget is gone", async () => {
		scripted.unreadable = true;
		deadline = Date.now() - 1;

		const result = await run();

		expect(result.outcome).toEqual({ kind: "deadline" });
	});

	it("leaves the checkout alone, as busy, when git cannot answer and there is time", async () => {
		scripted.unreadable = true;

		const result = await run();

		expect(result.outcome).toEqual({
			kind: "not-safe",
			reason: "git-busy",
		});
		expect(scripted.fetch).not.toHaveBeenCalled();
	});
});

describe("a merge that does not go through", () => {
	it.each([
		[
			"a timeout",
			{ kind: "timed-out" },
			{ kind: "merge-failed", reason: "timeout" },
		],
		[
			"a refusal",
			{ kind: "failed", reason: "other" },
			{ kind: "merge-failed", reason: "other" },
		],
		[
			"a diverged branch",
			{ kind: "failed", reason: "diverged" },
			{ kind: "merge-failed", reason: "diverged" },
		],
		[
			"another writer",
			{ kind: "failed", reason: "busy" },
			{ kind: "not-safe", reason: "git-busy" },
		],
		[
			"git not running",
			{ kind: "unavailable", reason: "x" },
			{ kind: "merge-failed", reason: "other" },
		],
	])("is %s", async (_label, answer, expected) => {
		scripted.merge.mockResolvedValue(answer);

		const result = await run();

		expect(result.outcome).toEqual(expected);
	});
});

describe("when there is nothing to move", () => {
	it("makes no merge when the fetched tip is HEAD", async () => {
		scripted.fetch.mockResolvedValue({ kind: "fetched", tip: HEAD });

		const result = await run();

		expect(result.outcome).toEqual({ kind: "already-current" });
		expect(scripted.merge).not.toHaveBeenCalled();
	});

	it("makes no merge when HEAD already has the tip in its history", async () => {
		scripted.ancestor.mockImplementation(
			async (_root: string, ancestor: string) => ({
				kind: "ok",
				value: ancestor === TIP,
			}),
		);

		const result = await run();

		expect(result.outcome).toEqual({ kind: "already-current" });
		expect(scripted.merge).not.toHaveBeenCalled();
	});

	it("makes no merge, and says diverged, when neither has the other", async () => {
		scripted.ancestor.mockResolvedValue({ kind: "ok", value: false });

		const result = await run();

		expect(result.outcome).toEqual({
			kind: "merge-failed",
			reason: "diverged",
		});
		expect(scripted.merge).not.toHaveBeenCalled();
	});

	it("touches neither fetch nor merge when the person opted out", async () => {
		const result = await run({ optedOut: true });

		expect(result.outcome).toEqual({ kind: "opted-out" });
		expect(result.stdout).toEqual([BEHIND]);
		expect(scripted.fetch).not.toHaveBeenCalled();
		expect(scripted.merge).not.toHaveBeenCalled();
	});
});

describe("a checkout it must leave alone", () => {
	it("calls neither verb when the tree is dirty", async () => {
		scripted.clean = false;

		const result = await run();

		expect(result.outcome).toEqual({ kind: "not-safe", reason: "dirty" });
		expect(scripted.fetch).not.toHaveBeenCalled();
		expect(scripted.merge).not.toHaveBeenCalled();
	});

	it("calls neither verb on another branch", async () => {
		scripted.branch = "feature/x";

		const result = await run();

		expect(result.outcome).toEqual({
			kind: "not-safe",
			reason: "wrong-branch",
		});
		expect(scripted.fetch).not.toHaveBeenCalled();
	});

	it("calls neither verb when the upstream is another branch", async () => {
		scripted.upstream = "origin/develop";

		const result = await run();

		expect(result.outcome).toEqual({
			kind: "not-safe",
			reason: "upstream-mismatch",
		});
		expect(scripted.fetch).not.toHaveBeenCalled();
	});
});
