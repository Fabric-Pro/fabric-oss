/**
 * A scripted stand-in for `src/lib/instructions/git.js` (Fizzy #2708), for the
 * command-level tests that must not depend on a real git checkout.
 *
 * Mount it with
 *
 *   vi.mock("../src/lib/instructions/git.js", async (importOriginal) => ({
 *     ...(await importOriginal()),
 *     ...(await import("./helpers/git-fake.js")).gitFake,
 *   }));
 *
 * — the pure helpers (`isBranchLiteral`, `isCommitSha`) stay real, and every
 * question that would spawn git is answered from `fakeGit.state`. This module
 * imports nothing from `src/` at runtime, so importing it inside a hoisted
 * mock factory cannot deadlock on a module the consumer also mocks.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
	CheckoutTraits,
	CloneResult,
	GitOperation,
	GitResult,
} from "../../src/lib/instructions/git.js";
import type {
	FetchResult,
	MergeResult,
} from "../../src/lib/instructions/git-write.js";

export interface FakeCheckoutState {
	/** `null`: not a git checkout (`absent`). */
	toplevel: string | null;
	/** Set: every question answers `unavailable` with this reason. */
	unavailable: string | null;
	/**
	 * Set: every question behaves like a git that never answers — it waits
	 * until the deadline it was given, then answers "timed out", exactly as
	 * `git.ts` kills a stalled child at its deadline.
	 */
	stall: boolean;
	/** Remote name → EFFECTIVE fetch URL (`null`: none). */
	remotes: Record<string, string | null>;
	branch: string | null;
	head: string | null;
	clean: boolean;
	operation: GitOperation | null;
	traits: CheckoutTraits;
	/** Ancestor sha → the answer; a sha not listed is `unavailable`. */
	ancestors: Record<string, boolean>;
	/** Whether `check-ref-format` accepts the branch. */
	refValid: boolean;
	/**
	 * Paths (relative to the work tree) git is said to ignore already. A path
	 * not listed is not ignored, unless `ignoreEverything`.
	 */
	ignored: string[];
	/** The default: every path is already ignored, so `init` writes no exclude. */
	ignoreEverything: boolean;
	/** Where `git rev-parse --git-path info/exclude` points; `null`: git cannot say. */
	excludeFile: string | null;
	/** What `cloneInto` answers. A success makes the folder a checkout of the URL. */
	cloneResult: CloneResult;
	/** Folders, relative to the clone, a successful clone makes: what the repository holds. */
	cloneCreates: string[];
	/** The branch's upstream, as `<remote>/<branch>`. */
	upstream: string | null;
	/** An `index.lock` or `HEAD.lock` exists. */
	lockFiles: boolean;
	/** The work trees that have the project's branch checked out. */
	worktrees: string[];
	/** Where the fast-forward lock and notice live; `null`: a temp folder made on first use. */
	commonDir: string | null;
	/** What `fetchRef` answers. */
	fetchResult: FetchResult;
	/** What `fastForwardTo` answers. A success moves HEAD to the commit. */
	mergeResult: MergeResult | null;
}

export const HEAD_SHA = "1".repeat(40);
/** The tip the fake remote has, unless a test says another. */
export const TIP_SHA = "2".repeat(40);

export function defaultFakeState(): FakeCheckoutState {
	return {
		toplevel: null,
		unavailable: null,
		stall: false,
		remotes: {},
		branch: "main",
		head: HEAD_SHA,
		clean: true,
		operation: null,
		traits: { shallow: false, sparse: false, superproject: false },
		ancestors: {},
		refValid: true,
		ignored: [],
		ignoreEverything: true,
		excludeFile: null,
		cloneResult: { kind: "cloned" },
		cloneCreates: [],
		upstream: "origin/main",
		lockFiles: false,
		worktrees: [],
		commonDir: null,
		fetchResult: { kind: "fetched", tip: TIP_SHA },
		mergeResult: null,
	};
}

export const fakeGit = {
	state: defaultFakeState(),
	/** Every question asked, by name, in order. */
	calls: [] as string[],
	/** Every deadline a question was given, in order. */
	deadlines: [] as number[],
	/** Every ancestry question, as `[ancestor, descendant]`. */
	ancestry: [] as Array<[string, string]>,
	/** Every clone asked for, as `{ dir, url, ref }`. */
	clones: [] as Array<{ dir: string; url: string; ref: string }>,
	/** Every fetch asked for. */
	fetches: [] as Array<{ remote: string; ref: string; deadline: number }>,
	/** Every fast-forward asked for. */
	merges: [] as Array<{ sha: string; deadline: number }>,
	reset(): void {
		this.state = defaultFakeState();
		this.calls = [];
		this.deadlines = [];
		this.ancestry = [];
		this.clones = [];
		this.fetches = [];
		this.merges = [];
	},
};

async function gate<T>(
	name: string,
	deadline: number,
	answer: () => T,
): Promise<GitResult<T>> {
	fakeGit.calls.push(name);
	fakeGit.deadlines.push(deadline);
	const { state } = fakeGit;
	if (state.stall) {
		await new Promise((resolve) =>
			setTimeout(resolve, Math.max(0, deadline - Date.now())),
		);
		return { kind: "unavailable", reason: "git timed out" };
	}
	if (state.unavailable !== null) {
		return { kind: "unavailable", reason: state.unavailable };
	}
	if (state.toplevel === null) {
		return { kind: "absent" };
	}
	return { kind: "ok", value: answer() };
}

export const gitFake = {
	async findWorkTree(_dir: string, deadline: number) {
		return gate("findWorkTree", deadline, () => ({
			toplevel: fakeGit.state.toplevel as string,
			gitDir: `${fakeGit.state.toplevel}/.git`,
			shallow: fakeGit.state.traits.shallow,
			superproject: null,
		}));
	},
	async remotes(_root: string, deadline: number) {
		return gate("remotes", deadline, () =>
			Object.keys(fakeGit.state.remotes),
		);
	},
	async effectiveFetchUrl(_root: string, remote: string, deadline: number) {
		return gate(
			"effectiveFetchUrl",
			deadline,
			() => fakeGit.state.remotes[remote] ?? null,
		);
	},
	async currentBranch(_root: string, deadline: number) {
		return gate("currentBranch", deadline, () => fakeGit.state.branch);
	},
	async headSha(_root: string, deadline: number) {
		return gate("headSha", deadline, () => fakeGit.state.head);
	},
	async isAncestor(
		_root: string,
		ancestor: string,
		descendant: string,
		deadline: number,
	) {
		fakeGit.ancestry.push([ancestor, descendant]);
		const result = await gate(
			"isAncestor",
			deadline,
			() => fakeGit.state.ancestors[ancestor],
		);
		if (result.kind === "ok" && result.value === undefined) {
			return {
				kind: "unavailable" as const,
				reason: "the commit is not in this clone",
			};
		}
		return result as GitResult<boolean>;
	},
	async isClean(_root: string, deadline: number) {
		return gate("isClean", deadline, () => fakeGit.state.clean);
	},
	async operationInProgress(_root: string, deadline: number) {
		return gate(
			"operationInProgress",
			deadline,
			() => fakeGit.state.operation,
		);
	},
	async checkoutTraits(_root: string, deadline: number) {
		return gate("checkoutTraits", deadline, () => fakeGit.state.traits);
	},
	async checkRefFormat(_root: string, _ref: string, deadline: number) {
		return gate("checkRefFormat", deadline, () => fakeGit.state.refValid);
	},
	async isIgnored(_root: string, relativePath: string, deadline: number) {
		return gate(
			"isIgnored",
			deadline,
			() =>
				fakeGit.state.ignoreEverything ||
				fakeGit.state.ignored.includes(relativePath),
		);
	},
	async excludeFilePath(_root: string, deadline: number) {
		const result = await gate(
			"excludeFilePath",
			deadline,
			() => fakeGit.state.excludeFile,
		);
		if (result.kind === "ok" && result.value === null) {
			return {
				kind: "unavailable" as const,
				reason: "git answered unexpectedly",
			};
		}
		return result as GitResult<string>;
	},
	async upstreamOf(_root: string, _branch: string, deadline: number) {
		return gate("upstreamOf", deadline, () => fakeGit.state.upstream);
	},
	async lockFilesPresent(_root: string, deadline: number) {
		return gate(
			"lockFilesPresent",
			deadline,
			() => fakeGit.state.lockFiles,
		);
	},
	async worktreesOnBranch(_root: string, _ref: string, deadline: number) {
		return gate(
			"worktreesOnBranch",
			deadline,
			() => fakeGit.state.worktrees,
		);
	},
	async commonDir(_root: string, deadline: number) {
		return gate("commonDir", deadline, () => {
			if (fakeGit.state.commonDir === null) {
				fakeGit.state.commonDir = mkdtempSync(
					path.join(tmpdir(), "fabric-fake-common-"),
				);
			}
			return fakeGit.state.commonDir;
		});
	},
	async fetchRef(
		_root: string,
		remote: string,
		ref: string,
		deadline: number,
	) {
		fakeGit.calls.push("fetchRef");
		fakeGit.fetches.push({ remote, ref, deadline });
		return fakeGit.state.fetchResult;
	},
	async fastForwardTo(_root: string, sha: string, deadline: number) {
		fakeGit.calls.push("fastForwardTo");
		fakeGit.merges.push({ sha, deadline });
		const result: MergeResult = fakeGit.state.mergeResult ?? {
			kind: "merged",
			head: sha,
		};
		if (result.kind === "merged") {
			fakeGit.state.head = result.head;
		}
		return result;
	},
	/**
	 * A clone that works makes the folder a checkout whose `origin` is the URL
	 * it was given, exactly as a real one would. The real URL check still
	 * runs, because `cloneableUrl` is not faked.
	 */
	async cloneInto(dir: string, url: string, ref: string, _deadline: number) {
		fakeGit.clones.push({ dir, url, ref });
		const result = fakeGit.state.cloneResult;
		if (result.kind === "cloned") {
			fakeGit.state.toplevel = dir;
			fakeGit.state.remotes = { origin: url };
			for (const folder of fakeGit.state.cloneCreates) {
				mkdirSync(path.join(dir, folder), { recursive: true });
			}
		}
		return result;
	},
};
