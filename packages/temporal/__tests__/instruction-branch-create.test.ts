/**
 * The member branch's pull request: create, lookup, Retry opening and
 * release (Fizzy #2738 spec §6.5, Decision 17, §4.4 "Release", §6.7 step 2;
 * plan Task 8).
 *
 * Git is real: an origin repository under `os.tmpdir()` over `file://`. The
 * provider adapter is a mock; the query layer is the in-memory fake of
 * `helpers/instruction-branch-fake-db.ts`, whose moves are the real branch
 * transition table. Every identifier is synthetic.
 */
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { InstructionPullRequestError } from "@repo/integrations/instruction-pull-requests";
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
		};
	},
);

import {
	appendBranchProposal,
	createBranchPullRequest,
	lookupBranchPullRequest,
	releaseBranch,
	retryBranchOpening,
} from "../src/activities/instruction-proposal-branches";
import { BRANCH_PULL_REQUEST_PARAGRAPH } from "../src/activities/lib/instruction-branch-support";
import { createOrigin, hasGit } from "./helpers/instruction-branch-origin";
import {
	appendInput,
	BASE_FILES,
	BRANCH_ID,
	branch,
	MEMBER_NAME,
	ORG,
	proposal,
	refFor,
	type Scenario,
	seedBranch,
	seedProposal,
	seedWorld,
} from "./helpers/instruction-branch-scenario";

let s: Scenario;

const HOUR_MS = 60 * 60 * 1000;

function observation(state: "OPEN" | "MERGED" | "CLOSED" = "OPEN") {
	return {
		externalId: "7",
		url: "https://example.com/example-org/example-repo/pull/7",
		state,
		sourceRef: refFor(1),
		targetRef: "main",
		sourceRepository: {
			provider: "GITHUB",
			owner: "example-org",
			repo: "example-repo",
		},
		headSha: branch(s).headSha as string,
	};
}

const refusal = (duplicate = false) =>
	new InstructionPullRequestError({
		code: "PR_CREATION_REFUSED",
		retryable: false,
		cause: duplicate ? "conflict" : "permission",
		...(duplicate ? { duplicate: true as const } : {}),
	});

const unanswered = () =>
	new InstructionPullRequestError({
		code: "CREATE_OUTCOME_UNKNOWN",
		retryable: true,
		cause: "transient",
	});

const ids = () => ({ branchId: BRANCH_ID, organizationId: ORG });
const create = () =>
	createBranchPullRequest({ ...ids(), branchAttempt: branch(s).attempt });
const lookup = () => lookupBranchPullRequest(ids());
const retry = () =>
	retryBranchOpening({ ...ids(), branchAttempt: branch(s).attempt });
const release = () =>
	releaseBranch({ ...ids(), branchAttempt: branch(s).attempt });

/** One appended change: the branch OPENING with an established head. */
async function appended(): Promise<void> {
	seedBranch(s, { presentation: null });
	seedProposal(s, "snap_p1", { "rules/a.md": "alpha v2\n" });
	expect(await appendBranchProposal(appendInput(s, "snap_p1"))).toEqual({
		outcome: "appended",
	});
	expect(branch(s)).toMatchObject({ state: "OPENING", createIssuedAt: null });
	s.fake.state.audits.length = 0;
}

/** A definitive refusal of the first open: BLOCKED PR_CREATION_REFUSED, the marker standing. */
async function refused(): Promise<Date> {
	await appended();
	h.adapter.open.mockRejectedValueOnce(refusal());
	expect(await create()).toEqual({ outcome: "blocked" });
	const marker = branch(s).createIssuedAt as Date;
	expect(marker).not.toBeNull();
	h.adapter.open.mockReset();
	h.adapter.findOperation.mockReset();
	h.adapter.findOperation.mockResolvedValue({ kind: "ABSENT" });
	return marker;
}

function audits(action: string) {
	return s.fake.state.audits.filter(
		(a) => a.action === `project.instructions.${action}`,
	);
}

describe.skipIf(!hasGit())("member branch pull request (spec §6.5)", () => {
	beforeEach(() => {
		h.origin = createOrigin(BASE_FILES);
		h.storage.clear();
		h.beforePush = null;
		h.diff = null;
		h.credentialPhases.length = 0;
		for (const fn of Object.values(h.adapter)) {
			fn.mockReset();
		}
		h.adapter.findOperation.mockResolvedValue({ kind: "ABSENT" });
		s = { fake: h.fake, origin: h.origin, storage: h.storage };
		s.fake.reset();
		seedWorld(s);
	});
	afterEach(() => {
		h.origin.cleanup();
	});

	describe("createBranchPullRequest", () => {
		it("writes the marker before open, with the rendered title, and records the receipt", async () => {
			await appended();
			const seen: { marker: unknown; state: string }[] = [];
			h.adapter.open.mockImplementation(async () => {
				seen.push({
					marker: branch(s).createIssuedAt,
					state: branch(s).state,
				});
				return observation();
			});
			expect(await create()).toEqual({ outcome: "opened" });
			expect(seen).toEqual([
				{ marker: s.fake.state.now, state: "OPENING" },
			]);
			const [call] = h.adapter.open.mock.calls[0] as [
				{
					title: string;
					body: string;
					sourceRef: string;
					targetRef: string;
				},
			];
			expect(call.title).toBe(
				`Coding instruction changes from ${MEMBER_NAME}`,
			);
			expect(call.body).toContain(BRANCH_PULL_REQUEST_PARAGRAPH);
			expect(call.body).toContain(
				`Opened from Fabric project Example Project by ${MEMBER_NAME}`,
			);
			expect(call).toMatchObject({
				sourceRef: refFor(1),
				targetRef: "main",
			});
			expect(h.adapter.findOperation).toHaveBeenCalledTimes(1);
			expect(branch(s)).toMatchObject({
				state: "OPEN",
				pullRequestExternalId: "7",
				pullRequestUrl:
					"https://example.com/example-org/example-repo/pull/7",
				createIssuedAt: null,
				failure: null,
			});
			expect(audits("pull_request_opened")).toEqual([
				expect.objectContaining({
					metadata: expect.objectContaining({
						externalId: "7",
						adopted: false,
					}),
				}),
			]);
		});

		it("looks up and adopts on a duplicate refusal", async () => {
			await appended();
			h.adapter.open.mockRejectedValueOnce(refusal(true));
			h.adapter.findOperation
				.mockResolvedValueOnce({ kind: "ABSENT" })
				.mockResolvedValueOnce({ kind: "FOUND", value: observation() });
			expect(await create()).toEqual({ outcome: "adopted" });
			expect(h.adapter.open).toHaveBeenCalledTimes(1);
			expect(h.adapter.findOperation).toHaveBeenCalledTimes(2);
			expect(branch(s)).toMatchObject({
				state: "OPEN",
				pullRequestExternalId: "7",
			});
			expect(audits("pull_request_opened")[0]?.metadata).toMatchObject({
				adopted: true,
			});
		});

		it("adopts a pull request already on the ref without opening one", async () => {
			await appended();
			h.adapter.findOperation.mockResolvedValue({
				kind: "FOUND",
				value: observation(),
			});
			expect(await create()).toEqual({ outcome: "adopted" });
			expect(h.adapter.open).not.toHaveBeenCalled();
			expect(branch(s)).toMatchObject({
				state: "OPEN",
				createIssuedAt: null,
			});
		});

		it("PR_CREATION_REFUSED is BLOCKED, the marker standing", async () => {
			const marker = await refused();
			expect(branch(s)).toMatchObject({
				state: "BLOCKED",
				createIssuedAt: marker,
				pullRequestExternalId: null,
				failure: expect.objectContaining({
					code: "PR_CREATION_REFUSED",
					phase: "create",
					retryable: false,
				}),
			});
			expect(proposal(s, "snap_p1").pullRequestState).toBe("OPEN");
			expect(audits("pull_request_opened")).toEqual([]);
		});

		it("a revoked permission refuses before the marker and before any provider call", async () => {
			await appended();
			s.fake.state.canCreate = false;
			expect(await create()).toEqual({ outcome: "blocked" });
			expect(h.adapter.findOperation).not.toHaveBeenCalled();
			expect(h.adapter.open).not.toHaveBeenCalled();
			expect(branch(s)).toMatchObject({
				state: "BLOCKED",
				createIssuedAt: null,
				failure: expect.objectContaining({
					code: "PERMISSION_REVOKED",
					retryable: false,
				}),
			});
		});
	});

	describe("CREATE_OUTCOME_UNKNOWN never re-issues on the same ref", () => {
		it("an unanswered open leaves the marker; create, lookup and Retry opening never open again", async () => {
			await appended();
			h.adapter.open.mockRejectedValueOnce(unanswered());
			expect(await create()).toEqual({ outcome: "unknown" });
			const marker = branch(s).createIssuedAt;
			expect(marker).not.toBeNull();
			expect(branch(s)).toMatchObject({
				state: "BLOCKED",
				failure: expect.objectContaining({
					code: "CREATE_OUTCOME_UNKNOWN",
					retryable: true,
				}),
			});

			expect(await create()).toEqual({ outcome: "stopped" });
			expect(await lookup()).toEqual({ outcome: "absent" });
			expect(branch(s)).toMatchObject({
				state: "BLOCKED",
				createIssuedAt: marker,
				failure: expect.objectContaining({
					code: "CREATE_OUTCOME_UNKNOWN",
					phase: "recover",
					retryable: true,
				}),
			});

			branch(s).retryRequestedAt = new Date(s.fake.state.now);
			expect(await retry()).toEqual({ outcome: "blocked" });
			expect(branch(s).retryRequestedAt).toBeNull();

			// A day after the marker: still no re-issue, looked at hourly.
			s.fake.state.now = new Date(
				s.fake.state.now.getTime() + 25 * HOUR_MS,
			);
			expect(await lookup()).toEqual({ outcome: "absent" });
			expect(branch(s)).toMatchObject({
				failure: expect.objectContaining({
					code: "CREATE_OUTCOME_UNKNOWN",
					retryable: false,
				}),
				nextAttemptAt: new Date(s.fake.state.now.getTime() + HOUR_MS),
			});
			expect(await create()).toEqual({ outcome: "stopped" });
			expect(h.adapter.open).toHaveBeenCalledTimes(1);
		});

		it("a duplicate refusal with nothing found is CREATE_OUTCOME_UNKNOWN", async () => {
			await appended();
			h.adapter.open.mockRejectedValueOnce(refusal(true));
			expect(await create()).toEqual({ outcome: "unknown" });
			expect(branch(s).failure).toMatchObject({
				code: "CREATE_OUTCOME_UNKNOWN",
			});
			expect(await create()).toEqual({ outcome: "stopped" });
			expect(h.adapter.open).toHaveBeenCalledTimes(1);
		});

		it("the lookup adopts the pull request an unanswered open made", async () => {
			await appended();
			h.adapter.open.mockRejectedValueOnce(unanswered());
			expect(await create()).toEqual({ outcome: "unknown" });
			h.adapter.findOperation.mockResolvedValue({
				kind: "FOUND",
				value: observation(),
			});
			expect(await lookup()).toEqual({ outcome: "adopted" });
			expect(branch(s)).toMatchObject({
				state: "OPEN",
				createIssuedAt: null,
				failure: null,
			});
		});
	});

	describe("lookup after PR_CREATION_REFUSED", () => {
		it("keeps the refusal and looks again in an hour; it never opens", async () => {
			await refused();
			expect(await lookup()).toEqual({ outcome: "absent" });
			expect(branch(s)).toMatchObject({
				state: "BLOCKED",
				failure: expect.objectContaining({
					code: "PR_CREATION_REFUSED",
				}),
				nextAttemptAt: new Date(s.fake.state.now.getTime() + HOUR_MS),
			});
			expect(h.adapter.open).not.toHaveBeenCalled();
		});
	});

	describe("retryBranchOpening (Decision 17)", () => {
		it("does nothing without a member's request", async () => {
			await refused();
			expect(await retry()).toEqual({ outcome: "blocked" });
			expect(h.adapter.findOperation).not.toHaveBeenCalled();
			expect(h.adapter.open).not.toHaveBeenCalled();
		});

		it("runs only from PR_CREATION_REFUSED: another failure clears the request", async () => {
			await appended();
			s.fake.state.canCreate = false;
			expect(await create()).toEqual({ outcome: "blocked" });
			branch(s).retryRequestedAt = new Date(s.fake.state.now);
			expect(await retry()).toEqual({ outcome: "blocked" });
			expect(branch(s)).toMatchObject({
				retryRequestedAt: null,
				failure: expect.objectContaining({
					code: "PERMISSION_REVOKED",
				}),
			});
			expect(h.adapter.open).not.toHaveBeenCalled();
		});

		it("looks up first and adopts what it finds", async () => {
			await refused();
			branch(s).retryRequestedAt = new Date(s.fake.state.now);
			h.adapter.findOperation.mockResolvedValue({
				kind: "FOUND",
				value: observation(),
			});
			expect(await retry()).toEqual({ outcome: "adopted" });
			expect(h.adapter.open).not.toHaveBeenCalled();
			expect(branch(s)).toMatchObject({
				state: "OPEN",
				retryRequestedAt: null,
				createIssuedAt: null,
			});
		});

		it("re-issues on the same ref with a fresh marker and clears the request", async () => {
			const first = await refused();
			s.fake.state.now = new Date(s.fake.state.now.getTime() + HOUR_MS);
			branch(s).retryRequestedAt = new Date(s.fake.state.now);
			const order: string[] = [];
			h.adapter.findOperation.mockImplementation(async () => {
				order.push("lookup");
				return { kind: "ABSENT" };
			});
			const seen: unknown[] = [];
			h.adapter.open.mockImplementation(
				async (i: { sourceRef: string }) => {
					order.push("open");
					seen.push({
						sourceRef: i.sourceRef,
						marker: branch(s).createIssuedAt,
						retryRequestedAt: branch(s).retryRequestedAt,
						state: branch(s).state,
					});
					return observation();
				},
			);
			expect(await retry()).toEqual({ outcome: "opened" });
			expect(order).toEqual(["lookup", "open"]);
			expect(seen).toEqual([
				{
					sourceRef: refFor(1),
					marker: s.fake.state.now,
					retryRequestedAt: null,
					state: "OPENING",
				},
			]);
			expect(s.fake.state.now).not.toEqual(first);
			expect(branch(s)).toMatchObject({
				state: "OPEN",
				pullRequestExternalId: "7",
				retryRequestedAt: null,
			});
		});

		it("rechecks permission after the lookup before reissuing the pull request", async () => {
			await refused();
			branch(s).retryRequestedAt = new Date(s.fake.state.now);
			h.adapter.findOperation.mockImplementation(async () => {
				s.fake.state.canCreate = false;
				return { kind: "ABSENT" };
			});

			expect(await retry()).toEqual({ outcome: "blocked" });
			expect(h.adapter.open).not.toHaveBeenCalled();
			expect(branch(s)).toMatchObject({
				state: "BLOCKED",
				retryRequestedAt: null,
				failure: expect.objectContaining({
					code: "PERMISSION_REVOKED",
				}),
			});
		});

		it("a second refusal is BLOCKED again with the request answered", async () => {
			await refused();
			branch(s).retryRequestedAt = new Date(s.fake.state.now);
			h.adapter.open.mockRejectedValueOnce(refusal());
			expect(await retry()).toEqual({ outcome: "blocked" });
			expect(h.adapter.open).toHaveBeenCalledTimes(1);
			expect(branch(s)).toMatchObject({
				state: "BLOCKED",
				retryRequestedAt: null,
				failure: expect.objectContaining({
					code: "PR_CREATION_REFUSED",
				}),
			});
			expect(branch(s).createIssuedAt).not.toBeNull();
		});

		it("an inconclusive lookup clears the request and keeps the refusal, never opening", async () => {
			await refused();
			branch(s).retryRequestedAt = new Date(s.fake.state.now);
			h.adapter.findOperation.mockResolvedValue({
				kind: "INCONCLUSIVE",
				cause: "rate_limit",
			});
			expect(await retry()).toEqual({ outcome: "blocked" });
			expect(h.adapter.open).not.toHaveBeenCalled();
			expect(branch(s)).toMatchObject({
				state: "BLOCKED",
				retryRequestedAt: null,
				failure: expect.objectContaining({
					code: "PR_CREATION_REFUSED",
				}),
			});
		});
	});

	describe("releaseBranch (spec §4.4 Release, §6.7 step 2)", () => {
		/** An established head stranded by a pre-create refusal. */
		async function stranded(): Promise<string> {
			await appended();
			s.fake.state.canCreate = false;
			expect(await create()).toEqual({ outcome: "blocked" });
			expect(branch(s)).toMatchObject({
				state: "BLOCKED",
				createIssuedAt: null,
				pullRequestExternalId: null,
			});
			return branch(s).headSha as string;
		}

		it("adopts a pull request found on the ref", async () => {
			await stranded();
			h.adapter.findOperation.mockResolvedValue({
				kind: "FOUND",
				value: observation(),
			});
			expect(await release()).toEqual({ outcome: "adopted" });
			expect(branch(s)).toMatchObject({
				state: "OPEN",
				pullRequestExternalId: "7",
			});
			expect(proposal(s, "snap_p1").pullRequestState).toBe("OPEN");
			expect(h.origin.refSha(refFor(1))).not.toBeNull();
		});

		it("deletes a Fabric-owned ref and cancels the branch and its proposals", async () => {
			await stranded();
			expect(await release()).toEqual({ outcome: "released" });
			expect(h.origin.refSha(refFor(1))).toBeNull();
			expect(branch(s)).toMatchObject({
				state: "CANCELED",
				deletedAt: s.fake.state.now,
				settledAt: s.fake.state.now,
			});
			expect(proposal(s, "snap_p1")).toMatchObject({
				pullRequestState: "CANCELED",
				pullRequestFailure: expect.objectContaining({
					code: "PERMISSION_REVOKED",
				}),
			});
			expect(h.adapter.open).not.toHaveBeenCalled();
		});

		it("keeps a ref carrying a foreign commit and still cancels", async () => {
			const head = await stranded();
			const hand = h.origin.commit({
				parents: [head],
				changes: { "CLAUDE.md": "# Hand\n" },
			});
			h.origin.setRef(refFor(1), hand);
			expect(await release()).toEqual({ outcome: "released" });
			expect(h.origin.refSha(refFor(1))).toBe(hand);
			expect(branch(s)).toMatchObject({
				state: "CANCELED",
				deletedAt: null,
			});
			expect(proposal(s, "snap_p1").pullRequestState).toBe("CANCELED");
		});

		it("keeps a ref whose push had only been observed (no deletion authority)", async () => {
			await stranded();
			const [op] = s.fake.state.ops;
			Object.assign(op as object, { outcome: "observed" });
			expect(await release()).toEqual({ outcome: "released" });
			expect(h.origin.refSha(refFor(1))).not.toBeNull();
			expect(branch(s)).toMatchObject({
				state: "CANCELED",
				deletedAt: null,
			});
		});

		it("keeps the branch when the provider refuses the delete", async () => {
			await stranded();
			h.origin.refusePushes(true);
			expect(await release()).toEqual({ outcome: "kept" });
			expect(h.origin.refSha(refFor(1))).not.toBeNull();
			expect(branch(s).state).toBe("BLOCKED");
			expect(proposal(s, "snap_p1").pullRequestState).toBe("OPEN");
		});

		it("keeps the branch when the lookup cannot answer", async () => {
			await stranded();
			h.adapter.findOperation.mockResolvedValue({
				kind: "INCONCLUSIVE",
				cause: "transient",
			});
			expect(await release()).toEqual({ outcome: "kept" });
			expect(branch(s).state).toBe("BLOCKED");
			expect(h.origin.refSha(refFor(1))).not.toBeNull();
		});
	});
});
