/**
 * The member proposal branch append (Fizzy #2738 spec §6.3, §6.4 steps
 * 1-10, the no-op guard, Decisions 5-8 and 12; plan Task 7).
 *
 * Git is real: an origin repository under `os.tmpdir()` over `file://`,
 * edited by the test with plumbing to play the member's hand edits,
 * merges, rewrites and a refusing hook. The query layer is the in-memory
 * fake of `helpers/instruction-branch-fake-db.ts`, whose lifecycle decisions
 * are the real pure reducer and transition table. Every identifier is
 * synthetic.
 */
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	fake: null as unknown as import("./helpers/instruction-branch-fake-db").FakeDatabase,
	origin: null as unknown as import("./helpers/instruction-branch-origin").Origin,
	storage: new Map<string, Buffer>(),
	adapter: {
		findOperation: vi.fn(),
		open: vi.fn(),
		get: vi.fn(),
		close: vi.fn(),
		pullRequestHeadRef: vi.fn(),
	},
	beforePush: null as null | (() => void),
	/** Awaited after each workspace clone: holds one attempt at its start. */
	afterInit: null as null | (() => Promise<void>),
	/** Awaited after each create-only push, with its answer. */
	afterCreate: null as null | ((kind: string) => Promise<void>),
	diff: null as null | ((entries: unknown[]) => unknown[]),
	credentialPhases: [] as string[],
}));

vi.mock("@repo/database", async (importOriginal) => {
	const real = await importOriginal<typeof import("@repo/database")>();
	const { createFakeDatabase } = await import(
		"./helpers/instruction-branch-fake-db"
	);
	h.fake = createFakeDatabase(real);
	return h.fake.module;
});
vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({
		downloadFile: async (key: string) => {
			const data = h.storage.get(key);
			if (!data) {
				throw new Error("missing object");
			}
			return { data };
		},
	}),
}));
vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { skills: "skills" } } },
}));
vi.mock("@repo/logs", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@repo/integrations", () => ({
	resolveFreshRepoToken: vi.fn(),
	forceReExchangeRepoCredentials: vi.fn(),
	markRepoReauthRequired: vi.fn(),
	REPO_REAUTH_STEP_BOUND_MS: 20_000,
	isGitAuthError: (e: unknown) =>
		String((e as Error)?.message)
			.toLowerCase()
			.includes("authentication failed"),
}));
vi.mock(
	"../src/activities/lib/instruction-branch-credential",
	async (importOriginal) => {
		const real =
			await importOriginal<
				typeof import("../src/activities/lib/instruction-branch-credential")
			>();
		return {
			...real,
			withBranchRepoCredential: async (
				input: Parameters<typeof real.withBranchRepoCredential>[0],
				fn: Parameters<typeof real.withBranchRepoCredential>[1],
			) => {
				const destination = real.destinationOf(
					input.branch,
					input.phase,
				);
				h.credentialPhases.push(input.phase);
				const runDir = mkdtempSync(path.join(h.origin.root, "run-"));
				try {
					return await fn({
						destination,
						url: h.origin.url,
						env: h.origin.env,
						secrets: [],
						runDir,
						workDir: path.join(runDir, "repo"),
						signal: input.signal,
						adapter: h.adapter as never,
						target: {
							auth: { token: "placeholder", authMethod: "OAUTH" },
							repository: destination.repository,
							signal: input.signal,
						},
						integrationId: destination.integrationId,
					});
				} finally {
					rmSync(runDir, { recursive: true, force: true });
				}
			},
		};
	},
);
vi.mock(
	"../src/activities/lib/instruction-branch-git",
	async (importOriginal) => {
		const real =
			await importOriginal<
				typeof import("../src/activities/lib/instruction-branch-git")
			>();
		return {
			...real,
			initBranchWorkspace: async (
				i: Parameters<typeof real.initBranchWorkspace>[0],
			) => {
				await real.initBranchWorkspace(i);
				await h.afterInit?.();
			},
			pushFastForward: async (
				i: Parameters<typeof real.pushFastForward>[0],
			) => {
				h.beforePush?.();
				return real.pushFastForward(i);
			},
		};
	},
);
vi.mock(
	"../src/activities/lib/instruction-sync-git",
	async (importOriginal) => {
		const real =
			await importOriginal<
				typeof import("../src/activities/lib/instruction-sync-git")
			>();
		return {
			...real,
			diffTreeEntries: async (
				i: Parameters<typeof real.diffTreeEntries>[0],
			) => {
				const entries = await real.diffTreeEntries(i);
				return h.diff ? (h.diff(entries) as typeof entries) : entries;
			},
			pushCreateOnly: async (
				i: Parameters<typeof real.pushCreateOnly>[0],
			) => {
				const pushed = await real.pushCreateOnly(i);
				await h.afterCreate?.(pushed.kind);
				return pushed;
			},
		};
	},
);

import { appendBranchProposal } from "../src/activities/instruction-proposal-branches";
import { createOrigin, hasGit } from "./helpers/instruction-branch-origin";
import {
	appendInput,
	BASE_FILES,
	BRANCH_ID,
	branch,
	opsOf,
	proposal,
	refFor,
	type Scenario,
	seedBranch,
	seedProposal,
	seedWorld,
	tryAgain,
} from "./helpers/instruction-branch-scenario";

let s: Scenario;

async function append(snapshotId: string) {
	return appendBranchProposal(appendInput(s, snapshotId));
}

/** P1 appended on a fresh branch: rules/a.md changed. Returns its commit. */
async function firstAppend(): Promise<string> {
	seedBranch(s);
	seedProposal(s, "snap_p1", { "rules/a.md": "alpha v2\n" });
	expect(await append("snap_p1")).toEqual({ outcome: "appended" });
	return h.origin.refSha(branch(s).ref) as string;
}

describe.skipIf(!hasGit())("appendBranchProposal (spec §6.4)", () => {
	beforeEach(() => {
		h.origin = createOrigin(BASE_FILES);
		h.storage.clear();
		h.beforePush = null;
		h.afterInit = null;
		h.afterCreate = null;
		h.diff = null;
		h.credentialPhases.length = 0;
		for (const fn of Object.values(h.adapter)) {
			fn.mockReset();
		}
		// First import creates the fake; later tests reuse it.
		s = { fake: h.fake, origin: h.origin, storage: h.storage };
	});
	afterEach(() => {
		h.origin.cleanup();
	});

	async function ready() {
		// Loads the mocked module graph (and with it the fake) once.
		await import("@repo/database");
		s = { fake: h.fake, origin: h.origin, storage: h.storage };
		s.fake.reset();
		seedWorld(s);
	}

	it("arm (w): the first push is create-only; the next append's parent is the first", async () => {
		await ready();
		const c1 = await firstAppend();
		const [op1] = opsOf(s, "snap_p1");
		expect(op1).toMatchObject({
			kind: "APPEND",
			parentSha: null,
			outcome: "acked",
			ref: refFor(1),
		});
		expect(h.origin.parents(c1)).toEqual([h.origin.base]);
		expect(h.origin.message(c1)).toBe(
			"Update rules (snap_p1)\n\nFabric-Change: pr_op_snap_p1",
		);
		expect(h.origin.content(c1, "rules/a.md")).toBe("alpha v2");
		expect(branch(s)).toMatchObject({
			state: "OPENING",
			headSha: c1,
			startSha: h.origin.base,
			foreignTipAt: null,
		});
		expect(proposal(s, "snap_p1").pullRequestState).toBe("OPEN");
		expect(s.fake.state.audits.map((a) => a.action)).toContain(
			"project.instructions.pull_request_branch_updated",
		);

		seedProposal(s, "snap_p2", { "rules/b.md": "beta v2\n" });
		expect(await append("snap_p2")).toEqual({ outcome: "appended" });
		const c2 = h.origin.refSha(refFor(1)) as string;
		expect(h.origin.parents(c2)).toEqual([c1]);
		expect(opsOf(s, "snap_p2")[0]).toMatchObject({
			parentSha: c1,
			outcome: "acked",
		});
		expect(branch(s).headSha).toBe(c2);
		expect(proposal(s, "snap_p2").pullRequestState).toBe("OPEN");
	});

	it("arm (d): a tip that already holds the bytes pushes nothing and cancels ALREADY_ON_BRANCH", async () => {
		await ready();
		const c1 = await firstAppend();
		seedProposal(s, "snap_resend", { "rules/a.md": "alpha v2\n" });
		expect(await append("snap_resend")).toEqual({
			outcome: "already_on_branch",
		});
		expect(opsOf(s, "snap_resend")).toEqual([]);
		expect(h.origin.refSha(refFor(1))).toBe(c1);
		expect(proposal(s, "snap_resend")).toMatchObject({
			pullRequestState: "CANCELED",
			pullRequestFailure: expect.objectContaining({
				code: "ALREADY_ON_BRANCH",
			}),
			pendingCommand: null,
		});
	});

	it("a hand restoration of the start version, then a proposal on that file, is BRANCH_CONFLICT naming it (Review Focus 2)", async () => {
		await ready();
		const c1 = await firstAppend();
		const hand = h.origin.commit({
			parents: [c1],
			changes: { "rules/a.md": "alpha\n" },
		});
		h.origin.setRef(refFor(1), hand);
		seedProposal(s, "snap_p2", { "rules/a.md": "alpha v3\n" });
		expect(await append("snap_p2")).toEqual({ outcome: "blocked" });
		expect(proposal(s, "snap_p2")).toMatchObject({
			pullRequestState: "BLOCKED",
			pullRequestFailure: expect.objectContaining({
				code: "BRANCH_CONFLICT",
				phase: "append",
				retryable: false,
				params: { paths: "rules/a.md", count: 1 },
			}),
		});
		expect(opsOf(s, "snap_p2")).toEqual([]);
		expect(h.origin.refSha(refFor(1))).toBe(hand);
		expect(branch(s).foreignTipAt).not.toBeNull();
	});

	it("an update-branch merge of the target touching the path is a conflict", async () => {
		await ready();
		const c1 = await firstAppend();
		const main = h.origin.commit({
			parents: [h.origin.base],
			changes: { "rules/a.md": "alpha from main\n" },
		});
		h.origin.setRef("main", main);
		const merge = h.origin.commit({
			parents: [c1, main],
			treeFrom: main,
			message: "Merge main",
		});
		h.origin.setRef(refFor(1), merge);
		seedProposal(s, "snap_p2", { "rules/a.md": "alpha v3\n" });
		expect(await append("snap_p2")).toEqual({ outcome: "blocked" });
		expect(proposal(s, "snap_p2").pullRequestFailure).toMatchObject({
			code: "BRANCH_CONFLICT",
			params: { paths: "rules/a.md", count: 1 },
		});
		expect(opsOf(s, "snap_p2")).toEqual([]);
	});

	it("a foreign commit on another path: the append succeeds and foreignTipAt is set", async () => {
		await ready();
		const c1 = await firstAppend();
		const hand = h.origin.commit({
			parents: [c1],
			changes: { "CLAUDE.md": "# Hand edit\n" },
		});
		h.origin.setRef(refFor(1), hand);
		seedProposal(s, "snap_p2", { "rules/b.md": "beta v2\n" });
		expect(await append("snap_p2")).toEqual({ outcome: "appended" });
		const c2 = h.origin.refSha(refFor(1)) as string;
		expect(h.origin.parents(c2)).toEqual([hand]);
		expect(h.origin.content(c2, "CLAUDE.md")).toBe("# Hand edit");
		expect(branch(s).foreignTipAt).not.toBeNull();
		expect(branch(s).headSha).toBe(c2);
	});

	it("a mode-only foreign change to the path is a conflict", async () => {
		await ready();
		const c1 = await firstAppend();
		const hand = h.origin.commit({
			parents: [c1],
			changes: { "rules/b.md": { content: "beta\n", mode: "100755" } },
		});
		h.origin.setRef(refFor(1), hand);
		seedProposal(s, "snap_p2", { "rules/b.md": "beta v2\n" });
		expect(await append("snap_p2")).toEqual({ outcome: "blocked" });
		expect(proposal(s, "snap_p2").pullRequestFailure).toMatchObject({
			code: "BRANCH_CONFLICT",
			params: { paths: "rules/b.md", count: 1 },
		});
	});

	it("rewritten history conflicts on every written path and sets foreignTipAt", async () => {
		await ready();
		await firstAppend();
		const root = h.origin.commit({
			parents: [],
			treeFrom: h.origin.base,
			message: "rewritten root",
		});
		const rewritten = h.origin.commit({
			parents: [root],
			changes: { "rules/a.md": "alpha v2\n" },
			message: "rewritten",
		});
		h.origin.setRef(refFor(1), rewritten);
		seedProposal(s, "snap_p2", {
			"rules/a.md": "alpha v3\n",
			"rules/b.md": "beta v2\n",
		});
		expect(await append("snap_p2")).toEqual({ outcome: "blocked" });
		expect(proposal(s, "snap_p2").pullRequestFailure).toMatchObject({
			code: "BRANCH_CONFLICT",
			params: { paths: "rules/a.md, rules/b.md", count: 2 },
		});
		expect(branch(s).foreignTipAt).not.toBeNull();
		expect(h.origin.refSha(refFor(1))).toBe(rewritten);
	});

	it("an older resumed proposal after a newer write is SUPERSEDED; Try again then applies it on top", async () => {
		await ready();
		seedBranch(s);
		seedProposal(
			s,
			"snap_newer",
			{ "rules/a.md": "alpha newer\n" },
			{ proposalIntentOrder: 200n },
		);
		expect(await append("snap_newer")).toEqual({ outcome: "appended" });
		const newer = h.origin.refSha(refFor(1)) as string;
		seedProposal(
			s,
			"snap_older",
			{ "rules/a.md": "alpha older\n" },
			{ proposalIntentOrder: 150n },
		);
		expect(await append("snap_older")).toEqual({ outcome: "blocked" });
		expect(proposal(s, "snap_older").pullRequestFailure).toMatchObject({
			code: "SUPERSEDED_BY_LATER_CHANGE",
			retryable: false,
			params: { paths: "rules/a.md", count: 1 },
		});
		expect(opsOf(s, "snap_older")).toEqual([]);

		tryAgain(s, "snap_older", 300n);
		expect(await append("snap_older")).toEqual({ outcome: "appended" });
		const tip = h.origin.refSha(refFor(1)) as string;
		expect(h.origin.parents(tip)).toEqual([newer]);
		expect(h.origin.content(tip, "rules/a.md")).toBe("alpha older");
		expect(proposal(s, "snap_older")).toMatchObject({
			pullRequestState: "OPEN",
			pullRequestFailure: null,
			pendingCommand: null,
		});
	});

	it("an add over a Fabric add, and a modify after a Fabric delete, both write", async () => {
		await ready();
		seedBranch(s);
		seedProposal(s, "snap_add1", { "rules/new.md": "one\n" });
		expect(await append("snap_add1")).toEqual({ outcome: "appended" });
		seedProposal(s, "snap_add2", { "rules/new.md": "two\n" });
		expect(await append("snap_add2")).toEqual({ outcome: "appended" });
		let tip = h.origin.refSha(refFor(1)) as string;
		expect(h.origin.content(tip, "rules/new.md")).toBe("two");
		expect(opsOf(s, "snap_add2")[0]?.entries[0]).toMatchObject({
			path: "rules/new.md",
			before: expect.objectContaining({ mode: "100644" }),
			beforeSource: "snap_add1",
			afterSource: "snap_add2",
		});

		seedProposal(s, "snap_delete", { "scripts/run.sh": null });
		expect(await append("snap_delete")).toEqual({ outcome: "appended" });
		tip = h.origin.refSha(refFor(1)) as string;
		expect(h.origin.entry(tip, "scripts/run.sh")).toBeNull();
		seedProposal(s, "snap_modify", {
			"scripts/run.sh": "#!/bin/sh\necho changed\n",
		});
		expect(await append("snap_modify")).toEqual({ outcome: "appended" });
		tip = h.origin.refSha(refFor(1)) as string;
		expect(h.origin.entry(tip, "scripts/run.sh")?.mode).toBe("100755");
		expect(h.origin.content(tip, "scripts/run.sh")).toBe(
			"#!/bin/sh\necho changed",
		);
	});

	it("name bump: a create-only refusal is not_pushed, the reservation refused, the ref moved to /2, and the restart succeeds", async () => {
		await ready();
		h.origin.setRef(refFor(1), h.origin.base);
		seedBranch(s);
		seedProposal(s, "snap_p1", { "rules/a.md": "alpha v2\n" });
		expect(await append("snap_p1")).toEqual({ outcome: "appended" });
		const [refused, pushed] = opsOf(s, "snap_p1");
		expect(refused).toMatchObject({
			ref: refFor(1),
			outcome: "not_pushed",
		});
		expect(pushed).toMatchObject({ ref: refFor(2), outcome: "acked" });
		expect(
			s.fake.state.reservations.find((r) => r.ref === refFor(1))?.status,
		).toBe("refused");
		expect(branch(s).ref).toBe(refFor(2));
		expect(h.origin.refSha(refFor(1))).toBe(h.origin.base);
		expect(h.origin.refSha(refFor(2))).toBe(pushed?.sha);
		expect(proposal(s, "snap_p1").pullRequestState).toBe("OPEN");
	});

	it("after five refused names the proposal is BRANCH_NAME_UNAVAILABLE", async () => {
		await ready();
		for (let n = 1; n <= 5; n++) {
			h.origin.setRef(refFor(n), h.origin.base);
		}
		seedBranch(s);
		seedProposal(s, "snap_p1", { "rules/a.md": "alpha v2\n" });
		expect(await append("snap_p1")).toEqual({ outcome: "blocked" });
		expect(opsOf(s, "snap_p1").map((op) => op.outcome)).toEqual([
			"not_pushed",
			"not_pushed",
			"not_pushed",
			"not_pushed",
			"not_pushed",
		]);
		expect(proposal(s, "snap_p1").pullRequestFailure).toMatchObject({
			code: "BRANCH_NAME_UNAVAILABLE",
			retryable: false,
		});
		expect(h.origin.refSha(refFor(6))).toBeNull();
	});

	it("three lease refusals are BLOCKED BRANCH_MOVED (retryable), each operation not_pushed, the reducer run before each restart", async () => {
		await ready();
		await firstAppend();
		let moves = 0;
		h.beforePush = () => {
			const tip = h.origin.refSha(refFor(1)) as string;
			const hand = h.origin.commit({
				parents: [tip],
				changes: { "CLAUDE.md": `# Moved ${++moves}\n` },
			});
			h.origin.setRef(refFor(1), hand);
		};
		seedProposal(s, "snap_p2", { "rules/b.md": "beta v2\n" });
		const before = s.fake.state.trace.length;
		expect(await append("snap_p2")).toEqual({ outcome: "blocked" });
		const ops = opsOf(s, "snap_p2");
		expect(ops.map((op) => op.outcome)).toEqual([
			"not_pushed",
			"not_pushed",
			"not_pushed",
		]);
		const trace = s.fake.state.trace.slice(before);
		for (const op of ops) {
			const outcome = trace.indexOf(`outcome:${op.id}:not_pushed:apply`);
			expect(outcome).toBeGreaterThanOrEqual(0);
			expect(trace[outcome + 1]).toMatch(/^reconcile:snap_p2:/);
		}
		// Each restart issued only after the previous refusal was reconciled.
		const issues = trace
			.map((t, n) => (t.startsWith("issue:") ? n : -1))
			.filter((n) => n >= 0);
		expect(issues).toHaveLength(3);
		expect(
			trace.indexOf(`outcome:${ops[0]?.id}:not_pushed:apply`),
		).toBeLessThan(issues[1] as number);
		expect(proposal(s, "snap_p2")).toMatchObject({
			pullRequestState: "BLOCKED",
			pullRequestFailure: expect.objectContaining({
				code: "BRANCH_MOVED",
				retryable: true,
			}),
		});
		expect(proposal(s, "snap_p2").pullRequestNextAttemptAt).not.toBeNull();
	});

	describe("overlapping attempts of one claim (a heartbeat-timeout retry beside the original)", () => {
		function gate() {
			let open = () => {};
			const opened = new Promise<void>((resolve) => {
				open = resolve;
			});
			return { open, opened };
		}

		it("the first push lands unacknowledged, the retry's create-only push finds the ref: the retry issues nothing, the branch keeps /1, and /1 is tracked", async () => {
			await ready();
			seedBranch(s);
			seedProposal(s, "snap_p1", { "rules/a.md": "alpha v2\n" });
			const input = appendInput(s, "snap_p1");
			const aAtIssue = gate();
			const releaseA = gate();
			const bAtIssue = gate();
			const aPushed = gate();
			const bDone = gate();
			let issues = 0;
			s.fake.state.beforeIssue = async () => {
				issues++;
				if (issues === 1) {
					aAtIssue.open();
					await releaseA.opened;
				} else if (issues === 2) {
					bAtIssue.open();
					await aPushed.opened;
				}
			};
			let creates = 0;
			h.afterCreate = async (kind) => {
				creates++;
				if (creates === 1) {
					expect(kind).toBe("created");
					// A's push landed; its acknowledgement waits for B.
					aPushed.open();
					await bDone.opened;
				}
			};

			// A has built its commit; nothing is issued yet.
			const a = appendBranchProposal(input);
			await aAtIssue.opened;
			// B passes the entry and per-pass checks with nothing issued,
			// and reaches its own issue.
			const b = appendBranchProposal(input);
			await bAtIssue.opened;
			// A issues and pushes /1; B issues only after that push.
			releaseA.open();
			const bResult = await b;
			bDone.open();
			const aResult = await a;

			expect(bResult).toEqual({ outcome: "retry_later" });
			expect(aResult).toEqual({ outcome: "appended" });
			expect(creates).toBe(1);
			const ops = opsOf(s, "snap_p1");
			expect(ops).toHaveLength(1);
			expect(ops[0]).toMatchObject({
				ref: refFor(1),
				parentSha: null,
				outcome: "acked",
			});
			expect(branch(s)).toMatchObject({
				ref: refFor(1),
				headSha: ops[0]?.sha,
				state: "OPENING",
			});
			expect(h.origin.refSha(refFor(1))).toBe(ops[0]?.sha);
			expect(h.origin.refSha(refFor(2))).toBeNull();
			expect(
				s.fake.state.reservations.find((r) => r.ref === refFor(1))
					?.status,
			).toBe("current");
			expect(
				s.fake.state.reservations.some((r) => r.ref === refFor(2)),
			).toBe(false);
			expect(proposal(s, "snap_p1").pullRequestState).toBe("OPEN");
		});

		it("an operation issued after the entry check stops the next pass before it builds or issues", async () => {
			await ready();
			seedBranch(s);
			seedProposal(s, "snap_p1", { "rules/a.md": "alpha v2\n" });
			const input = appendInput(s, "snap_p1");
			const bCloned = gate();
			const releaseB = gate();
			const aPushed = gate();
			const bDone = gate();
			let inits = 0;
			h.afterInit = async () => {
				inits++;
				if (inits === 1) {
					bCloned.open();
					await releaseB.opened;
				}
			};
			let issues = 0;
			s.fake.state.beforeIssue = async () => {
				issues++;
			};
			let creates = 0;
			h.afterCreate = async () => {
				if (++creates === 1) {
					aPushed.open();
					await bDone.opened;
				}
			};

			// B passed its entry check with nothing issued; it holds after
			// its clone, before its first pass.
			const b = appendBranchProposal(input);
			await bCloned.opened;
			// A issues and pushes; its acknowledgement waits for B.
			const a = appendBranchProposal(input);
			await aPushed.opened;
			releaseB.open();
			const bResult = await b;
			bDone.open();
			const aResult = await a;

			expect(bResult).toEqual({ outcome: "retry_later" });
			expect(issues).toBe(1);
			expect(aResult).toEqual({ outcome: "appended" });
			expect(opsOf(s, "snap_p1").map((op) => op.outcome)).toEqual([
				"acked",
			]);
			expect(branch(s).ref).toBe(refFor(1));
		});
	});

	it("a hook refusal is BRANCH_WRITE_REFUSED", async () => {
		await ready();
		const c1 = await firstAppend();
		h.origin.refusePushes(true);
		seedProposal(s, "snap_p2", { "rules/b.md": "beta v2\n" });
		expect(await append("snap_p2")).toEqual({ outcome: "blocked" });
		expect(opsOf(s, "snap_p2").map((op) => op.outcome)).toEqual([
			"not_pushed",
		]);
		expect(proposal(s, "snap_p2").pullRequestFailure).toMatchObject({
			code: "BRANCH_WRITE_REFUSED",
			retryable: true,
		});
		expect(h.origin.refSha(refFor(1))).toBe(c1);
	});

	it("a recorded head whose ref is gone retires the branch BRANCH_MISSING and releases the claim", async () => {
		await ready();
		await firstAppend();
		h.origin.deleteRef(refFor(1));
		seedProposal(s, "snap_p2", { "rules/b.md": "beta v2\n" });
		const attempt = proposal(s, "snap_p2").pullRequestAttempt;
		expect(await append("snap_p2")).toEqual({ outcome: "released" });
		expect(branch(s)).toMatchObject({ retiredReason: "BRANCH_MISSING" });
		expect(branch(s).retiredAt).not.toBeNull();
		expect(proposal(s, "snap_p2")).toMatchObject({
			pullRequestState: "QUEUED",
			pullRequestAttempt: attempt + 1,
			proposalBranchId: BRANCH_ID,
		});
		expect(opsOf(s, "snap_p2")).toEqual([]);
	});

	it("the diff-tree(T, C) verifier refuses a commit that is not exactly the plan, before recording", async () => {
		await ready();
		const c1 = await firstAppend();
		h.diff = (entries) => entries.slice(1);
		seedProposal(s, "snap_p2", {
			"rules/b.md": "beta v2\n",
			"CLAUDE.md": "# Changed\n",
		});
		expect(await append("snap_p2")).toEqual({ outcome: "blocked" });
		expect(opsOf(s, "snap_p2")).toEqual([]);
		expect(proposal(s, "snap_p2").pullRequestFailure).toMatchObject({
			code: "GIT_FAILED",
			retryable: false,
		});
		expect(h.origin.refSha(refFor(1))).toBe(c1);
	});

	it("a pull request that is no longer open is observed and the claim released", async () => {
		await ready();
		await firstAppend();
		const b = branch(s);
		b.state = "OPEN";
		b.pullRequestExternalId = "42";
		h.adapter.get.mockResolvedValue({
			externalId: "42",
			url: "https://example.com/pr/42",
			state: "MERGED",
			sourceRef: b.ref,
			targetRef: "main",
			sourceRepository: {
				provider: "GITHUB",
				owner: "example-org",
				repo: "example-repo",
			},
			headSha: b.headSha,
		});
		seedProposal(s, "snap_p2", { "rules/b.md": "beta v2\n" });
		expect(await append("snap_p2")).toEqual({ outcome: "released" });
		expect(branch(s).state).toBe("MERGED");
		expect(proposal(s, "snap_p2").pullRequestState).toBe("QUEUED");
		expect(opsOf(s, "snap_p2")).toEqual([]);
	});

	it("the creation checks refuse a member whose permission was revoked", async () => {
		await ready();
		seedBranch(s);
		seedProposal(s, "snap_p1", { "rules/a.md": "alpha v2\n" });
		s.fake.state.canCreate = false;
		s.fake.state.canRead = false;
		expect(await append("snap_p1")).toEqual({ outcome: "blocked" });
		expect(proposal(s, "snap_p1").pullRequestFailure).toMatchObject({
			code: "PERMISSION_REVOKED",
			retryable: false,
		});
		expect(h.credentialPhases).toEqual([]);
	});

	describe("the no-op guard (Decision 12)", () => {
		/** P2 appended, then its acknowledgement lost: `unknown`, BLOCKED, head back at P1's. */
		async function lostAcknowledgement(): Promise<{
			c1: string;
			u: string;
		}> {
			const c1 = await firstAppend();
			seedProposal(s, "snap_p2", { "rules/b.md": "beta v2\n" });
			expect(await append("snap_p2")).toEqual({ outcome: "appended" });
			const u = h.origin.refSha(refFor(1)) as string;
			const [op] = opsOf(s, "snap_p2");
			(op as { outcome: string }).outcome = "unknown";
			Object.assign(branch(s), { headSha: c1, headExecutionSeq: 1 });
			Object.assign(proposal(s, "snap_p2"), {
				pullRequestState: "BLOCKED",
				pullRequestFailure: {
					phase: "append",
					code: "PUSH_OUTCOME_UNKNOWN",
					retryable: false,
					at: "2026-09-26T12:00:00.000Z",
					params: {},
				},
			});
			return { c1, u };
		}

		it("U unknown, Try again queued, U actually on origin: U observed and the proposal OPEN, never ALREADY_ON_BRANCH", async () => {
			await ready();
			const { u } = await lostAcknowledgement();
			tryAgain(s, "snap_p2", 500n);
			expect(await append("snap_p2")).toEqual({ outcome: "stopped" });
			expect(opsOf(s, "snap_p2")).toHaveLength(1);
			expect(opsOf(s, "snap_p2")[0]?.outcome).toBe("observed");
			expect(branch(s).headSha).toBe(u);
			expect(proposal(s, "snap_p2")).toMatchObject({
				pullRequestState: "OPEN",
				pullRequestFailure: null,
				pendingCommand: null,
			});
			expect(
				s.fake.state.audits.some(
					(a) =>
						a.action ===
							"project.instructions.pull_request_branch_updated" &&
						a.metadata?.recovered === true,
				),
			).toBe(true);
			expect(
				s.fake.state.trace.some((t) =>
					t.startsWith("proposal:snap_p2:branch_evidence:CANCELED"),
				),
			).toBe(false);
		});

		it("U not an ancestor of the tip: BLOCKED PUSH_OUTCOME_UNKNOWN, never terminal", async () => {
			await ready();
			const { c1, u } = await lostAcknowledgement();
			// The member reset the branch and made the same change by hand.
			const hand = h.origin.commit({
				parents: [c1],
				changes: { "rules/b.md": "beta v2\n" },
				message: "same change by hand",
			});
			expect(hand).not.toBe(u);
			h.origin.setRef(refFor(1), hand);
			tryAgain(s, "snap_p2", 500n);
			expect(await append("snap_p2")).toEqual({ outcome: "blocked" });
			expect(opsOf(s, "snap_p2").map((op) => op.outcome)).toEqual([
				"unknown",
			]);
			expect(proposal(s, "snap_p2")).toMatchObject({
				pullRequestState: "BLOCKED",
				pullRequestFailure: expect.objectContaining({
					code: "PUSH_OUTCOME_UNKNOWN",
				}),
			});
		});

		it("mixed, U1 in T and current U2 unknown: U1 observed, lifecycle unchanged, ends BLOCKED PUSH_OUTCOME_UNKNOWN", async () => {
			await ready();
			const { c1, u } = await lostAcknowledgement();
			// A second attempt U2 of the same submission, never on origin.
			const u2 = h.origin.commit({
				parents: [c1],
				changes: { "rules/b.md": "beta v2\n" },
				message: "u2",
			});
			s.fake.state.ops.push({
				...(opsOf(
					s,
					"snap_p2",
				)[0] as (typeof s.fake.state.ops)[number]),
				id: "op_u2",
				executionSeq: branch(s).nextExecutionSeq++,
				sha: u2,
				outcome: "unknown",
			});
			tryAgain(s, "snap_p2", 500n);
			const before = s.fake.state.trace.length;
			expect(await append("snap_p2")).toEqual({ outcome: "blocked" });
			const u1 = opsOf(s, "snap_p2").find((op) => op.sha === u);
			expect(u1?.outcome).toBe("observed");
			expect(
				opsOf(s, "snap_p2").find((op) => op.id === "op_u2")?.outcome,
			).toBe("unknown");
			const trace = s.fake.state.trace.slice(before);
			const observed = trace.indexOf(`outcome:${u1?.id}:observed:apply`);
			expect(trace[observed + 1]).toBe("reconcile:snap_p2:row6:false");
			expect(proposal(s, "snap_p2")).toMatchObject({
				pullRequestState: "BLOCKED",
				pullRequestFailure: expect.objectContaining({
					code: "PUSH_OUTCOME_UNKNOWN",
				}),
			});
		});

		it("mixed, U1 unknown and current U2 in T: OPEN, and the claim stops", async () => {
			await ready();
			const { c1, u } = await lostAcknowledgement();
			// U1 was never on origin; the current U2 is the tip.
			const [first] = opsOf(s, "snap_p2");
			const u1 = h.origin.commit({
				parents: [c1],
				changes: { "rules/b.md": "beta v1\n" },
				message: "u1",
			});
			Object.assign(first as object, { sha: u1 });
			s.fake.state.ops.push({
				...(first as (typeof s.fake.state.ops)[number]),
				id: "op_u2",
				executionSeq: branch(s).nextExecutionSeq++,
				sha: u,
				outcome: "unknown",
			});
			tryAgain(s, "snap_p2", 500n);
			expect(await append("snap_p2")).toEqual({ outcome: "stopped" });
			expect(
				opsOf(s, "snap_p2").find((op) => op.id === "op_u2")?.outcome,
			).toBe("observed");
			expect(proposal(s, "snap_p2").pullRequestState).toBe("OPEN");
			expect(opsOf(s, "snap_p2")).toHaveLength(2);
		});
	});
});
