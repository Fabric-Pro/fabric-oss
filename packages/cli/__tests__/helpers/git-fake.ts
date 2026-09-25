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
import type {
	CheckoutTraits,
	GitOperation,
	GitResult,
} from "../../src/lib/instructions/git.js";

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
}

export const HEAD_SHA = "1".repeat(40);

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
	reset(): void {
		this.state = defaultFakeState();
		this.calls = [];
		this.deadlines = [];
		this.ancestry = [];
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
};
