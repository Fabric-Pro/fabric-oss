/**
 * Withdrawal after append: the revert (Fizzy #2738 spec §6.8, §4.3 revert
 * rows, Decision 18; plan Task 8).
 *
 * Git is real: an origin repository under `os.tmpdir()` over `file://`,
 * where the tests play the member's hand edits. The query layer is the
 * in-memory fake of `helpers/instruction-branch-fake-db.ts`, whose
 * lifecycle decisions are the real pure reducer and transition table.
 * Every identifier is synthetic.
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
	/** Awaited after each fast-forward push, with its answer. */
	afterPush: null as null | ((kind: string) => Promise<void>),
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
				const pushed = await real.pushFastForward(i);
				await h.afterPush?.(pushed.kind);
				return pushed;
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
		};
	},
);

import {
	appendBranchProposal,
	revertBranchProposal,
} from "../src/activities/instruction-proposal-branches";
import { createOrigin, hasGit } from "./helpers/instruction-branch-origin";
import {
	appendInput,
	BASE_FILES,
	BRANCH_ID,
	branch,
	ORG,
	opsOf,
	proposal,
	refFor,
	type Scenario,
	seedBranch,
	seedProposal,
	seedWorld,
	USER,
	withdraw,
} from "./helpers/instruction-branch-scenario";

let s: Scenario;

async function append(snapshotId: string) {
	expect(await appendBranchProposal(appendInput(s, snapshotId))).toEqual({
		outcome: "appended",
	});
}

function revert(snapshotId: string) {
	return revertBranchProposal({
		branchId: BRANCH_ID,
		organizationId: ORG,
		snapshotId,
		proposalAttempt: proposal(s, snapshotId).pullRequestAttempt,
	});
}

const tip = () => h.origin.refSha(refFor(1)) as string;

/**
 * P1 writes `a`, P2 writes `b`, both appended; then the member withdraws
 * P1 with `scope`. Returns the tip before the revert.
 */
async function withdrawnAfterAppend(
	scope: "change" | "branch" = "change",
	p1: Record<string, string | null> = { "rules/a.md": "alpha v2\n" },
): Promise<string> {
	seedBranch(s);
	seedProposal(s, "snap_p1", p1);
	seedProposal(s, "snap_p2", { "rules/b.md": "beta v2\n" });
	await append("snap_p1");
	await append("snap_p2");
	expect(proposal(s, "snap_p1").pullRequestState).toBe("OPEN");
	withdraw(s, "snap_p1", scope);
	s.fake.state.audits.length = 0;
	return tip();
}

function expectRefused(paths: string[]) {
	expect(proposal(s, "snap_p1")).toMatchObject({
		pullRequestState: "OPEN",
		pullRequestFailure: expect.objectContaining({
			code: "WITHDRAW_CONFLICT",
			phase: "revert",
			retryable: false,
			params: { paths: paths.join(", "), count: paths.length },
		}),
		pendingCommand: null,
		pendingCommandSeq: null,
	});
	expect(opsOf(s, "snap_p1").some((op) => op.kind === "REVERT")).toBe(false);
}

describe.skipIf(!hasGit())("revertBranchProposal (spec §6.8)", () => {
	beforeEach(() => {
		h.origin = createOrigin(BASE_FILES);
		h.storage.clear();
		h.beforePush = null;
		h.afterInit = null;
		h.afterPush = null;
		h.diff = null;
		h.credentialPhases.length = 0;
		for (const fn of Object.values(h.adapter)) {
			fn.mockReset();
		}
		s = { fake: h.fake, origin: h.origin, storage: h.storage };
		s.fake.reset();
		seedWorld(s);
	});
	afterEach(() => {
		h.origin.cleanup();
	});

	it("restores the append's before entries: REVERT acked, the proposal CANCELED, the message Withdraw + trailer", async () => {
		const before = await withdrawnAfterAppend();
		expect(await revert("snap_p1")).toEqual({ outcome: "reverted" });
		const after = tip();
		expect(h.origin.parents(after)).toEqual([before]);
		expect(h.origin.content(after, "rules/a.md")).toBe("alpha");
		expect(h.origin.content(after, "rules/b.md")).toBe("beta v2");
		expect(h.origin.message(after)).toBe(
			"Withdraw: Update rules (snap_p1)\n\nFabric-Withdraw: pr_op_snap_p1",
		);
		const [appendOp, revertOp] = opsOf(s, "snap_p1");
		expect(revertOp).toMatchObject({
			kind: "REVERT",
			outcome: "acked",
			parentSha: before,
			sha: after,
		});
		expect(revertOp?.entries).toEqual(appendOp?.entries);
		expect(proposal(s, "snap_p1")).toMatchObject({
			pullRequestState: "CANCELED",
			pendingCommand: null,
		});
		expect(proposal(s, "snap_p2").pullRequestState).toBe("OPEN");
		expect(branch(s)).toMatchObject({ headSha: after, foreignTipAt: null });
		expect(
			s.fake.state.audits.find(
				(a) =>
					a.action ===
						"project.instructions.pull_request_branch_updated" &&
					a.metadata?.kind === "REVERT",
			)?.metadata,
		).toMatchObject({ recovered: false, actorUserId: USER });
	});

	it("an overlapping attempt whose pass finds the first attempt's revert issued stops before it reads the branch: no spurious WITHDRAW_CONFLICT", async () => {
		const before = await withdrawnAfterAppend();
		const gate = () => {
			let open = () => {};
			const opened = new Promise<void>((resolve) => {
				open = resolve;
			});
			return { open, opened };
		};
		const bCloned = gate();
		const releaseB = gate();
		const aPushed = gate();
		const bDone = gate();
		let inits = 0;
		h.afterInit = async () => {
			if (++inits === 1) {
				bCloned.open();
				await releaseB.opened;
			}
		};
		let pushes = 0;
		h.afterPush = async () => {
			if (++pushes === 1) {
				aPushed.open();
				await bDone.opened;
			}
		};
		const attempt = proposal(s, "snap_p1").pullRequestAttempt;

		// B passed its entry check with nothing issued; it holds after its
		// clone. A issues and pushes the revert; its acknowledgement waits.
		const b = revert("snap_p1");
		await bCloned.opened;
		const a = revert("snap_p1");
		await aPushed.opened;
		releaseB.open();
		const bResult = await b;
		expect(proposal(s, "snap_p1")).toMatchObject({
			pullRequestState: "CLOSE_REQUESTED",
			pullRequestAttempt: attempt,
			pullRequestFailure: null,
			pendingCommand: "WITHDRAW",
		});
		bDone.open();
		const aResult = await a;

		expect(bResult).toEqual({ outcome: "retry_later" });
		expect(aResult).toEqual({ outcome: "reverted" });
		expect(pushes).toBe(1);
		const reverts = opsOf(s, "snap_p1").filter(
			(op) => op.kind === "REVERT",
		);
		expect(reverts.map((op) => op.outcome)).toEqual(["acked"]);
		expect(h.origin.parents(tip())).toEqual([before]);
		expect(proposal(s, "snap_p1").pullRequestState).toBe("CANCELED");
	});

	it("restores a deleted 100755 file with its mode", async () => {
		await withdrawnAfterAppend("change", { "scripts/run.sh": null });
		expect(h.origin.entry(tip(), "scripts/run.sh")).toBeNull();
		expect(await revert("snap_p1")).toEqual({ outcome: "reverted" });
		expect(h.origin.entry(tip(), "scripts/run.sh")).toMatchObject({
			mode: "100755",
			oid: h.origin.hashObject(BASE_FILES["scripts/run.sh"]),
		});
		const [appendOp] = opsOf(s, "snap_p1");
		expect(appendOp?.entries[0]?.before).toMatchObject({ mode: "100755" });
		expect(proposal(s, "snap_p1").pullRequestState).toBe("CANCELED");
	});

	it("a later established operation on the path refuses it, nothing pushed", async () => {
		// P2 then P3 write the path after P1, P3 back to P1's bytes: the tip
		// holds P1's own entry and no foreign commit touched the path, so only
		// the later write can refuse it.
		seedBranch(s);
		seedProposal(s, "snap_p1", { "rules/a.md": "alpha v2\n" });
		seedProposal(s, "snap_p2", { "rules/a.md": "alpha v3\n" });
		seedProposal(s, "snap_p3", { "rules/a.md": "alpha v2\n" });
		await append("snap_p1");
		await append("snap_p2");
		await append("snap_p3");
		withdraw(s, "snap_p1");
		const before = tip();
		expect(h.origin.entry(before, "rules/a.md")?.oid).toBe(
			opsOf(s, "snap_p1")[0]?.entries[0]?.after?.oid,
		);
		expect(await revert("snap_p1")).toEqual({
			outcome: "withdraw_conflict",
		});
		expect(tip()).toBe(before);
		expectRefused(["rules/a.md"]);
	});

	it("a foreign edit is WITHDRAW_CONFLICT: OPEN, the command and the change intent cleared", async () => {
		const before = await withdrawnAfterAppend();
		const hand = h.origin.commit({
			parents: [before],
			changes: { "rules/a.md": "alpha by hand\n" },
		});
		h.origin.setRef(refFor(1), hand);
		expect(await revert("snap_p1")).toEqual({
			outcome: "withdraw_conflict",
		});
		expect(tip()).toBe(hand);
		expectRefused(["rules/a.md"]);
		expect(proposal(s, "snap_p1")).toMatchObject({
			withdrawScope: null,
			withdrawRequestedAt: null,
		});
		expect(branch(s).foreignTipAt).not.toBeNull();
	});

	it("a hand edit B to C to B of its own file is refused (provenance, not equality)", async () => {
		const before = await withdrawnAfterAppend();
		const c = h.origin.commit({
			parents: [before],
			changes: { "rules/a.md": "alpha by hand\n" },
		});
		const b = h.origin.commit({
			parents: [c],
			changes: { "rules/a.md": "alpha v2\n" },
		});
		expect(h.origin.entry(b, "rules/a.md")).toEqual(
			h.origin.entry(before, "rules/a.md"),
		);
		h.origin.setRef(refFor(1), b);
		expect(await revert("snap_p1")).toEqual({
			outcome: "withdraw_conflict",
		});
		expectRefused(["rules/a.md"]);
	});

	it("a foreign commit on another path does not block it", async () => {
		const before = await withdrawnAfterAppend();
		const hand = h.origin.commit({
			parents: [before],
			changes: { "CLAUDE.md": "# Hand\n" },
		});
		h.origin.setRef(refFor(1), hand);
		expect(await revert("snap_p1")).toEqual({ outcome: "reverted" });
		expect(h.origin.parents(tip())).toEqual([hand]);
		expect(h.origin.content(tip(), "CLAUDE.md")).toBe("# Hand");
		expect(branch(s).foreignTipAt).not.toBeNull();
		expect(proposal(s, "snap_p1").pullRequestState).toBe("CANCELED");
	});

	it("a branch intent survives WITHDRAW_CONFLICT", async () => {
		const before = await withdrawnAfterAppend("branch");
		const requestedAt = proposal(s, "snap_p1").withdrawRequestedAt;
		h.origin.setRef(
			refFor(1),
			h.origin.commit({
				parents: [before],
				changes: { "rules/a.md": "alpha by hand\n" },
			}),
		);
		expect(await revert("snap_p1")).toEqual({
			outcome: "withdraw_conflict",
		});
		expectRefused(["rules/a.md"]);
		expect(proposal(s, "snap_p1")).toMatchObject({
			withdrawScope: "branch",
			withdrawRequestedAt: requestedAt,
		});
	});

	it("a revoked member's authorized withdrawal still runs", async () => {
		await withdrawnAfterAppend();
		s.fake.state.canCreate = false;
		s.fake.state.canRead = false;
		expect(await revert("snap_p1")).toEqual({ outcome: "reverted" });
		expect(proposal(s, "snap_p1").pullRequestState).toBe("CANCELED");
	});

	it("withdraw-again whose earlier revert re-observes as present is CANCELED without issuing", async () => {
		const before = await withdrawnAfterAppend();
		expect(await revert("snap_p1")).toEqual({ outcome: "reverted" });
		const reverted = tip();
		// The acknowledgement was lost: the revert `unknown`, the proposal
		// OPEN with WITHDRAW_OUTCOME_UNKNOWN (§4.3 row 4).
		const revertOp = opsOf(s, "snap_p1").find((op) => op.kind === "REVERT");
		Object.assign(revertOp as object, {
			outcome: "unknown",
			pushAckedAt: null,
		});
		Object.assign(branch(s), { headSha: before, headExecutionSeq: 2 });
		Object.assign(proposal(s, "snap_p1"), {
			pullRequestState: "OPEN",
			pullRequestFailure: {
				phase: "revert",
				code: "WITHDRAW_OUTCOME_UNKNOWN",
				retryable: false,
				at: "2026-09-26T12:00:00.000Z",
				params: {},
			},
			withdrawRequestedAt: null,
			withdrawScope: null,
			pendingCommand: null,
			pendingCommandSeq: null,
		});
		withdraw(s, "snap_p1");
		const issued = s.fake.state.ops.length;
		expect(await revert("snap_p1")).toEqual({
			outcome: "canceled_by_evidence",
		});
		expect(s.fake.state.ops.length).toBe(issued);
		expect(revertOp?.outcome).toBe("observed");
		expect(tip()).toBe(reverted);
		expect(proposal(s, "snap_p1").pullRequestState).toBe("CANCELED");
	});

	it("the ref gone is WITHDRAW_CONFLICT", async () => {
		await withdrawnAfterAppend();
		h.origin.deleteRef(refFor(1));
		expect(await revert("snap_p1")).toEqual({
			outcome: "withdraw_conflict",
		});
		expect(proposal(s, "snap_p1")).toMatchObject({
			pullRequestState: "OPEN",
			pullRequestFailure: expect.objectContaining({
				code: "WITHDRAW_CONFLICT",
			}),
		});
	});

	it("a refusing hook is BRANCH_WRITE_REFUSED, retried later on CLOSE_REQUESTED", async () => {
		const before = await withdrawnAfterAppend();
		h.origin.refusePushes(true);
		expect(await revert("snap_p1")).toEqual({ outcome: "retry_later" });
		expect(tip()).toBe(before);
		const revertOp = opsOf(s, "snap_p1").find((op) => op.kind === "REVERT");
		expect(revertOp?.outcome).toBe("not_pushed");
		expect(proposal(s, "snap_p1")).toMatchObject({
			pullRequestState: "CLOSE_REQUESTED",
			pullRequestFailure: expect.objectContaining({
				code: "BRANCH_WRITE_REFUSED",
				retryable: true,
			}),
			pendingCommand: "WITHDRAW",
		});
		expect(proposal(s, "snap_p1").pullRequestNextAttemptAt).not.toBeNull();
	});
});
