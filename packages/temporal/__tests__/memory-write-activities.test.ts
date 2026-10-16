/**
 * The Living Memory write activities (ADR-022): `runMemoryWrite` from a
 * receipt to how the write ended, `recordMemoryWriteOutcome`, the report that
 * follows a record that gave up, and the sync kick.
 *
 * Git is real: a bare origin under `os.tmpdir()` over `file://`, edited by the
 * test to play a teammate and a protected branch. The database is a handful of
 * mocked queries over one mutable receipt; the storage is a map; the provider
 * is a fake adapter. The activity context is Temporal's own mock, so the
 * attempt number is real. Every identifier is synthetic.
 *
 * What is pinned: the receipt is acted on only while it is `PENDING`; the live
 * checks run before anything is cloned, and again immediately before the push;
 * staged bytes are read back and must be exactly the file the write named; a
 * credential in the message is refused; a failure is retried until the last
 * attempt and then handed back as the outcome; a retry that finds the live
 * checks refusing still finds the commit an earlier attempt pushed; and the
 * record is idempotent, typed when it cannot succeed, and cleans up only after
 * a write that landed.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { MockActivityEnvironment } from "@temporalio/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BareOrigin } from "./helpers/memory-write-origin";
import { createBareOrigin } from "./helpers/memory-write-origin";

type Entry = {
	path: string;
	op: "PUT" | "DELETE";
	ifMatchOid: string | null;
	stagedKey: string | null;
	bytes: number | null;
	sha256: string | null;
};

type Row = {
	id: string;
	projectId: string;
	organizationId: string;
	userId: string;
	targetId: string;
	targetVersion: number;
	folder: string;
	mode: "PULL_REQUEST" | "DIRECT_PUSH";
	ref: string;
	repositoryIntegrationId: string;
	oauthClientId: string | null;
	via: "APP";
	message: string;
	digest: string;
	status: string;
	createdAt: Date;
	entries: Entry[];
};

const h = vi.hoisted(() => ({
	origin: null as unknown as import("./helpers/memory-write-origin").BareOrigin,
	row: null as unknown,
	storage: new Map<string, Buffer>(),
	/** The live facts; `null` fields are read as gone. */
	state: null as unknown,
	holds: { member: true, delegate: true },
	stateReads: 0,
	/** Runs when the live state is read for the Nth time (1 = the first). */
	onStateRead: null as null | ((n: number) => void),
	credentialRequests: 0,
	credentialFailure: null as null | Error,
	open: vi.fn(),
	settle: vi.fn(),
	deleted: [] as string[][],
	deleteErrors: 0,
	settleResult: null as unknown,
	settleFailure: null as null | Error,
	startSync: vi.fn(),
	/** What a start of the sync answers: a new run, or the one already open. */
	startOutcome: {
		outcome: "started",
		workflowId: "wf",
		runId: "run_1",
	} as {
		outcome: "started" | "already_running";
		workflowId: string;
		runId: string;
	},
	recordPending: vi.fn(),
	settlePending: vi.fn(),
	syncRow: null as unknown,
}));

vi.mock("@repo/database", async (importOriginal) => {
	const real = await importOriginal<typeof import("@repo/database")>();
	return {
		...real,
		db: {
			projectContextRepositorySync: {
				findFirst: async () => h.syncRow,
			},
		},
		REPOSITORY_SYNC_SUBJECT_STORES: {
			context: {
				recordPendingHead: h.recordPending,
				settlePendingHead: h.settlePending,
			},
		},
		getMemoryWriteForRun: async () => h.row,
		getProjectRepoIntegration: async () => ({
			provider: "GITHUB",
			repositoryUrl: "https://github.com/example/example",
		}),
		getMemoryWriteRunState: async () => {
			h.stateReads++;
			h.onStateRead?.(h.stateReads);
			return h.state;
		},
		canCreateProjectContexts: async (_project: string, user: string) =>
			user === "user_member" ? h.holds.member : h.holds.delegate,
		settleMemoryWrite: async (i: unknown) => {
			h.settle(i);
			if (h.settleFailure) {
				throw h.settleFailure;
			}
			return h.settleResult;
		},
	};
});
vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({
		getFileMetadata: async (key: string) => {
			const data = h.storage.get(key);
			return data ? { size: data.length } : null;
		},
		downloadFile: async (key: string) => {
			const data = h.storage.get(key);
			if (!data) {
				throw new Error("missing object");
			}
			return { data };
		},
		deleteObjects: async (keys: string[]) => {
			h.deleted.push(keys);
			return {
				deleted: keys.length,
				errors: Array.from({ length: h.deleteErrors }, () => ({
					key: "k",
					message: "no",
				})),
			};
		},
	}),
}));
vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { skills: "skills" } },
		mails: { from: "Fabric <noreply@example.com>" },
	},
}));
vi.mock("@repo/logs", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@repo/integrations", () => ({
	resolveFreshRepoToken: vi.fn(),
	forceReExchangeRepoCredentials: vi.fn(),
	markRepoReauthRequired: vi.fn(),
	REPO_REAUTH_STEP_BOUND_MS: 20_000,
	isGitAuthError: () => false,
}));
vi.mock("../src/activities/lib/context-sync-start", () => ({
	startAutomaticContextSync: async (i: unknown) => {
		h.startSync(i);
		return h.startOutcome;
	},
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
				h.credentialRequests++;
				if (h.credentialFailure) {
					throw h.credentialFailure;
				}
				// The destination is the real parse: what the workflow builds must
				// satisfy the schema the credential helper holds it to.
				const destination = real.destinationOf(
					input.branch,
					input.phase,
				);
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
						adapter: {
							findOperation: async () => ({ kind: "ABSENT" }),
							open: async (i: unknown) => {
								h.open(i);
								return {
									externalId: "11",
									url: "https://example.com/pull/11",
									state: "OPEN",
									sourceRef: "x",
									targetRef: "main",
									sourceRepository: destination.repository,
									headSha: "a".repeat(40),
								};
							},
						} as never,
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

import { renderMemoryWriteText } from "@repo/instructions/pull-request-text";
import { ApplicationFailure } from "@temporalio/activity";
import { ProposalStepFailure } from "../src/activities/lib/instruction-proposal-boundary";
import {
	recordMemoryWriteOutcome,
	reportMemoryWriteSettleFailed,
	runMemoryWrite,
	startMemoryWriteSync,
} from "../src/activities/memory-write";

const INPUT = {
	writeId: "cmemwrite00000001",
	projectId: "proj_example",
	organizationId: "org_example",
};

const sha256 = (bytes: Buffer) =>
	createHash("sha256").update(bytes).digest("hex");

/** A synthetic token, built at run time so no source line is one. */
const githubToken = () => `ghp_${"A1".repeat(18)}`;

function stage(content: string, projectId = INPUT.projectId) {
	const bytes = Buffer.from(content, "utf8");
	const stagedKey = `memory-writes/${projectId}/${randomUUID()}`;
	h.storage.set(stagedKey, bytes);
	return { stagedKey, bytes: bytes.length, sha256: sha256(bytes) };
}

function put(
	filePath: string,
	content: string,
	ifMatchOid: string | null = null,
): Entry {
	return { path: filePath, op: "PUT", ifMatchOid, ...stage(content) };
}

function row(overrides: Partial<Row> = {}): Row {
	return {
		id: INPUT.writeId,
		projectId: INPUT.projectId,
		organizationId: INPUT.organizationId,
		userId: "user_member",
		targetId: "target_1",
		targetVersion: 2,
		folder: "docs/ai",
		mode: "DIRECT_PUSH",
		ref: "main",
		repositoryIntegrationId: "int_1",
		oauthClientId: "client_example",
		via: "APP",
		message: "Add notes\n\nAn agent's notes.",
		digest: "digest",
		status: "PENDING",
		createdAt: new Date(Date.now() - 5_000),
		entries: [put("docs/ai/new.md", "# New\n")],
		...overrides,
	};
}

function liveState(overrides: Record<string, unknown> = {}) {
	return {
		readOnlyMode: false,
		sync: {
			id: "sync_1",
			generation: 4,
			userId: "user_delegate",
			ref: "main",
			repositoryIntegrationId: "int_1",
			paths: ["docs"],
			excludedPaths: [],
			automatic: true,
			automaticPausedReason: null,
			integration: {
				id: "int_1",
				projectId: INPUT.projectId,
				provider: "GITHUB",
				repositoryUrl: "https://github.com/example/example",
				status: "ACTIVE",
			},
		},
		target: {
			id: "target_1",
			version: 2,
			folder: "docs/ai",
			mode: "DIRECT_PUSH",
		},
		instructionRoots: [],
		userName: "Example Member",
		...overrides,
	};
}

/** Runs an activity under Temporal's mock context, as the Nth of three attempts. */
function runAs<I, O>(
	activity: (input: I) => Promise<O>,
	input: I,
	attempt = 3,
): Promise<O> {
	const env = new MockActivityEnvironment({
		attempt,
		// Generous budgets: the mock's default (one second) is already past the
		// cooperative deadline the activity keeps inside it.
		startToCloseTimeoutMs: 10 * 60_000,
		scheduleToCloseTimeoutMs: 0,
		heartbeatTimeoutMs: 0,
	});
	return env.run(activity, input);
}

let origin: BareOrigin;

beforeEach(() => {
	vi.clearAllMocks();
	origin = createBareOrigin({
		"docs/README.md": "# Docs\n",
		"docs/ai/existing.md": "existing\n",
	});
	h.origin = origin;
	h.storage.clear();
	h.row = row();
	h.state = liveState();
	h.holds = { member: true, delegate: true };
	h.stateReads = 0;
	h.onStateRead = null;
	h.credentialRequests = 0;
	h.credentialFailure = null;
	h.deleted = [];
	h.deleteErrors = 0;
	h.settleResult = { applied: true, status: "COMMITTED" };
	h.settleFailure = null;
	h.startOutcome = { outcome: "started", workflowId: "wf", runId: "run_1" };
	h.syncRow = { id: "sync_1", generation: 4 };
	h.recordPending.mockResolvedValue({ applied: true });
	h.settlePending.mockResolvedValue({ applied: true, settled: "applied" });
});

afterEach(() => {
	origin.cleanup();
});

describe("runMemoryWrite", () => {
	it("commits a direct push and answers the outcome, without writing the receipt", async () => {
		const result = await runAs(runMemoryWrite, INPUT);

		expect(result).toMatchObject({
			kind: "outcome",
			outcome: { status: "COMMITTED", ref: "main", fileCount: 1 },
		});
		const { sha } = (result as { outcome: { sha: string } }).outcome;
		expect(origin.tip()).toBe(sha);
		expect(origin.file(sha, "docs/ai/new.md")).toBe("# New");
		expect(origin.message(sha)).toContain(
			`Fabric-Memory-Write: ${INPUT.writeId}\nFabric-Agent: client_example`,
		);
		expect(h.settle).not.toHaveBeenCalled();
		// Before anything is cloned, and again immediately before the push.
		expect(h.stateReads).toBe(2);
	});

	it("stops when the receipt is gone or no longer pending", async () => {
		h.row = null;
		expect(await runAs(runMemoryWrite, INPUT)).toEqual({ kind: "stopped" });

		h.row = row({ status: "COMMITTED" });
		expect(await runAs(runMemoryWrite, INPUT)).toEqual({ kind: "stopped" });
		expect(h.credentialRequests).toBe(0);
	});

	it("refuses with the live check's code before anything is cloned", async () => {
		h.state = liveState({ readOnlyMode: true });

		expect(await runAs(runMemoryWrite, INPUT, 1)).toEqual({
			kind: "outcome",
			outcome: { status: "REFUSED", code: "READ_ONLY_MODE" },
		});
		expect(h.credentialRequests).toBe(0);
		expect(origin.tip()).toBe(origin.base);
	});

	it("refuses when a target was edited since the write was admitted", async () => {
		h.state = liveState({
			target: {
				id: "target_1",
				version: 3,
				folder: "docs/ai",
				mode: "DIRECT_PUSH",
			},
		});

		expect(await runAs(runMemoryWrite, INPUT)).toMatchObject({
			outcome: { status: "REFUSED", code: "TARGET_CHANGED" },
		});
	});

	it.each([
		[
			"a staged object whose bytes changed after admission",
			(entry: Entry) => {
				h.storage.set(
					entry.stagedKey as string,
					Buffer.from("# Swapped\n"),
				);
			},
		],
		[
			"a staged object that is gone",
			(entry: Entry) => {
				h.storage.delete(entry.stagedKey as string);
			},
		],
		[
			"a staged object of another size",
			(entry: Entry) => {
				h.storage.set(
					entry.stagedKey as string,
					Buffer.from("# New\n\n\n"),
				);
			},
		],
	])("refuses %s, cloning nothing", async (_name, tamper) => {
		tamper((h.row as Row).entries[0] as Entry);

		expect(await runAs(runMemoryWrite, INPUT)).toEqual({
			kind: "outcome",
			outcome: { status: "REFUSED", code: "STAGED_BYTES_CHANGED" },
		});
		expect(h.credentialRequests).toBe(0);
		expect(origin.tip()).toBe(origin.base);
	});

	it("refuses a staged key that is not one of this project's", async () => {
		const other = stage("# New\n", "proj_other");
		h.row = row({
			entries: [
				{
					path: "docs/ai/new.md",
					op: "PUT",
					ifMatchOid: null,
					...other,
				},
			],
		});

		expect(await runAs(runMemoryWrite, INPUT)).toMatchObject({
			outcome: { status: "REFUSED", code: "STAGED_BYTES_CHANGED" },
		});
	});

	it("refuses a message that holds a credential, and one that spells a trailer of Fabric's own", async () => {
		h.row = row({ message: `notes ${githubToken()}` });
		expect(await runAs(runMemoryWrite, INPUT)).toMatchObject({
			outcome: { status: "REFUSED", code: "MESSAGE_REJECTED" },
		});

		h.row = row({
			message: "notes\n\nFabric-Memory-Write: cforged00000001",
		});
		expect(await runAs(runMemoryWrite, INPUT)).toMatchObject({
			outcome: { status: "REFUSED", code: "MESSAGE_REJECTED" },
		});
		expect(h.credentialRequests).toBe(0);
	});

	it("settles a conflict from the tip with the blob there, and pushes nothing", async () => {
		h.row = row({ entries: [put("docs/ai/existing.md", "clobber\n")] });

		const result = await runAs(runMemoryWrite, INPUT);

		expect(result).toMatchObject({
			outcome: {
				status: "CONFLICT",
				paths: [{ path: "docs/ai/existing.md", code: "PATH_EXISTS" }],
			},
		});
		expect(origin.tip()).toBe(origin.base);
	});

	it("refuses, rather than pushes, when the live checks refuse immediately before the push", async () => {
		// The second read is the one made right before the push.
		h.onStateRead = (n) => {
			if (n === 2) {
				h.holds = { member: false, delegate: true };
			}
		};

		expect(await runAs(runMemoryWrite, INPUT)).toEqual({
			kind: "outcome",
			outcome: { status: "REFUSED", code: "PERMISSION_REVOKED" },
		});
		expect(origin.tip()).toBe(origin.base);
	});

	it("opens a pull request when the branch refuses the push, and never touches the synced branch", async () => {
		origin.protectMain(true);

		const result = await runAs(runMemoryWrite, INPUT);

		expect(result).toMatchObject({
			outcome: {
				status: "PULL_REQUEST",
				reason: "protected",
				branch: `fabric/memory/${INPUT.writeId}`,
				url: "https://example.com/pull/11",
			},
		});
		expect(origin.tip()).toBe(origin.base);
		expect(h.open).toHaveBeenCalledTimes(1);
	});

	it("opens a pull request for a PULL_REQUEST folder, reason configured", async () => {
		h.row = row({ mode: "PULL_REQUEST" });
		h.state = liveState({
			target: {
				id: "target_1",
				version: 2,
				folder: "docs/ai",
				mode: "PULL_REQUEST",
			},
		});

		expect(await runAs(runMemoryWrite, INPUT)).toMatchObject({
			outcome: { status: "PULL_REQUEST", reason: "configured" },
		});
		expect(origin.tip()).toBe(origin.base);
	});

	describe("a failure", () => {
		const unavailable = () =>
			new ProposalStepFailure({
				code: "AUTHENTICATION_FAILED",
				phase: "append",
				retryable: true,
			});

		it("is rethrown for a retry until the last attempt", async () => {
			h.credentialFailure = unavailable();

			await expect(runAs(runMemoryWrite, INPUT, 1)).rejects.toBe(
				h.credentialFailure,
			);
			await expect(runAs(runMemoryWrite, INPUT, 2)).rejects.toBe(
				h.credentialFailure,
			);
		});

		it("is handed back as the write's FAILED outcome on the last attempt, typed", async () => {
			h.credentialFailure = unavailable();

			expect(await runAs(runMemoryWrite, INPUT, 3)).toEqual({
				kind: "outcome",
				outcome: {
					status: "FAILED",
					code: "AUTHENTICATION_FAILED",
					retryable: true,
				},
			});
		});

		it("is not retried when it cannot be fixed by retrying", async () => {
			h.credentialFailure = new ProposalStepFailure({
				code: "REPOSITORY_CHANGED",
				phase: "append",
				retryable: false,
			});

			expect(await runAs(runMemoryWrite, INPUT, 1)).toEqual({
				kind: "outcome",
				outcome: {
					status: "FAILED",
					code: "REPOSITORY_CHANGED",
					retryable: false,
				},
			});
		});

		it("treats an error nobody classified as UNEXPECTED: retried, then recorded without its text", async () => {
			h.credentialFailure = new Error(
				"secret detail the outcome must not carry",
			);

			await expect(runAs(runMemoryWrite, INPUT, 1)).rejects.toThrow();
			const last = await runAs(runMemoryWrite, INPUT, 3);

			expect(last).toEqual({
				kind: "outcome",
				outcome: {
					status: "FAILED",
					code: "UNEXPECTED",
					retryable: false,
				},
			});
			expect(JSON.stringify(last)).not.toContain("secret detail");
		});
	});

	describe("a retry", () => {
		it("finds the commit an earlier attempt pushed although the live checks now refuse, and answers it", async () => {
			const first = await runAs(runMemoryWrite, INPUT, 1);
			const { sha } = (first as { outcome: { sha: string } }).outcome;
			// The earlier attempt pushed and lost its acknowledgement; then the
			// member lost the right.
			h.holds = { member: false, delegate: true };

			const retried = await runAs(runMemoryWrite, INPUT, 2);

			expect(retried).toMatchObject({
				kind: "outcome",
				outcome: { status: "COMMITTED", sha },
			});
			expect(origin.tip()).toBe(sha);
		});

		it("answers the refusal on the first attempt: nothing could have been pushed", async () => {
			const first = await runAs(runMemoryWrite, INPUT, 1);
			expect(first).toMatchObject({ outcome: { status: "COMMITTED" } });
			h.holds = { member: false, delegate: true };
			const credentialsBefore = h.credentialRequests;

			expect(await runAs(runMemoryWrite, INPUT, 1)).toEqual({
				kind: "outcome",
				outcome: { status: "REFUSED", code: "PERMISSION_REVOKED" },
			});
			expect(h.credentialRequests).toBe(credentialsBefore);
		});

		it("looks only for a direct push: a pull request write is refused as it was", async () => {
			h.row = row({ mode: "PULL_REQUEST" });
			h.state = liveState({
				target: {
					id: "target_1",
					version: 2,
					folder: "docs/ai",
					mode: "PULL_REQUEST",
				},
			});
			h.holds = { member: false, delegate: true };

			expect(await runAs(runMemoryWrite, INPUT, 2)).toMatchObject({
				outcome: { status: "REFUSED", code: "PERMISSION_REVOKED" },
			});
			expect(h.credentialRequests).toBe(0);
		});
	});

	it("builds the attribution from the member's name and the deployment's address", async () => {
		const result = await runAs(runMemoryWrite, INPUT);
		const { sha } = (result as { outcome: { sha: string } }).outcome;

		expect(
			origin.git(["log", "-n", "1", "--format=%an <%ae>|%cn <%ce>", sha]),
		).toBe(
			"Example Member <noreply@example.com>|Fabric <noreply@example.com>",
		);
		// The same text the activity renders, for the record.
		const rendered = renderMemoryWriteText({
			message: "Add notes\n\nAn agent's notes.",
			proposerName: "Example Member",
			mailFrom: "Fabric <noreply@example.com>",
			writeId: INPUT.writeId,
			agentId: "client_example",
		});
		expect(rendered.ok && rendered.commitMessage.trimEnd()).toBe(
			origin.message(sha).trimEnd(),
		);
	});
});

describe("recordMemoryWriteOutcome", () => {
	const committed = {
		status: "COMMITTED" as const,
		sha: "a".repeat(40),
		ref: "main",
		fileCount: 2,
	};

	it("settles the receipt with the typed outcome and the audit metadata of its status", async () => {
		expect(
			await recordMemoryWriteOutcome({ ...INPUT, outcome: committed }),
		).toEqual({ kind: "settled", status: "COMMITTED" });
		expect(h.settle).toHaveBeenCalledWith({
			...INPUT,
			status: "COMMITTED",
			outcome: committed,
			metadata: { sha: "a".repeat(40) },
		});
	});

	it.each([
		[
			{
				status: "PULL_REQUEST" as const,
				sha: "a".repeat(40),
				ref: "main",
				branch: "fabric/memory/x",
				url: "https://example.com/pull/1",
				externalId: "1",
				reason: "protected" as const,
				fileCount: 1,
			},
			{
				sha: "a".repeat(40),
				branch: "fabric/memory/x",
				externalId: "1",
				reason: "protected",
			},
		],
		[
			{
				status: "CONFLICT" as const,
				paths: [{ path: "docs/a.md", code: "PATH_EXISTS" as const }],
			},
			{ conflictCount: 1 },
		],
		[
			{
				status: "REFUSED" as const,
				code: "PATH_REFUSED" as const,
				paths: [{ path: "docs/a.md", code: "PATH_EXCLUDED" as const }],
			},
			{ code: "PATH_REFUSED", pathCount: 1 },
		],
		[
			{ status: "FAILED" as const, code: "BRANCH_BUSY", retryable: true },
			{ code: "BRANCH_BUSY", retryable: true },
		],
	])(
		"records %j with counts, codes and ids only",
		async (outcome, metadata) => {
			h.settleResult = { applied: true, status: outcome.status };

			await recordMemoryWriteOutcome({ ...INPUT, outcome });

			expect(h.settle).toHaveBeenCalledWith(
				expect.objectContaining({ status: outcome.status, metadata }),
			);
			expect(
				JSON.stringify(h.settle.mock.calls[0]?.[0].metadata),
			).not.toContain("docs/a.md");
		},
	);

	it("leaves a receipt that is settled already as it is, answering its status", async () => {
		h.settleResult = { applied: false, status: "FAILED" };

		expect(
			await recordMemoryWriteOutcome({ ...INPUT, outcome: committed }),
		).toEqual({ kind: "settled", status: "FAILED" });
		expect(h.deleted).toEqual([]);
	});

	it("is a typed non-retryable failure for an outcome that does not parse and for a receipt that is gone", async () => {
		await expect(
			recordMemoryWriteOutcome({
				...INPUT,
				outcome: { status: "COMMITTED", sha: "nope" } as never,
			}),
		).rejects.toMatchObject({
			type: "MEMORY_WRITE_OUTCOME_INVALID",
			nonRetryable: true,
		});

		h.settleResult = { applied: false, status: null };
		await expect(
			recordMemoryWriteOutcome({ ...INPUT, outcome: committed }),
		).rejects.toMatchObject({
			type: "MEMORY_WRITE_MISSING",
			nonRetryable: true,
		});
	});

	it("turns a database write that would be refused again into RECORD_REJECTED, and rethrows a fault that can pass", async () => {
		h.settleFailure = Object.assign(new Error("fk"), {
			name: "PrismaClientKnownRequestError",
			code: "P2003",
		});
		await expect(
			recordMemoryWriteOutcome({ ...INPUT, outcome: committed }),
		).rejects.toMatchObject({
			type: "RECORD_REJECTED",
			nonRetryable: true,
		});

		h.settleFailure = new Error("the database is unreachable");
		const error = await recordMemoryWriteOutcome({
			...INPUT,
			outcome: committed,
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(ApplicationFailure);
	});

	it("removes the staged bytes of a write that landed, and only of one that landed", async () => {
		h.row = row({
			entries: [put("docs/ai/a.md", "a\n"), put("docs/ai/b.md", "b\n")],
		});
		const keys = (h.row as Row).entries.map((e) => e.stagedKey);

		await recordMemoryWriteOutcome({ ...INPUT, outcome: committed });
		expect(h.deleted).toEqual([keys]);

		h.deleted = [];
		h.settleResult = { applied: true, status: "CONFLICT" };
		await recordMemoryWriteOutcome({
			...INPUT,
			outcome: { status: "CONFLICT", paths: [] },
		});
		expect(h.deleted).toEqual([]);
	});

	it("does not fail a write that landed because its staged bytes could not be removed", async () => {
		h.deleteErrors = 1;

		expect(
			await recordMemoryWriteOutcome({ ...INPUT, outcome: committed }),
		).toEqual({ kind: "settled", status: "COMMITTED" });
	});
});

describe("reportMemoryWriteSettleFailed", () => {
	it("marks the receipt FAILED SETTLE_FAILED, retryable, naming the commit when one reached the repository", async () => {
		await reportMemoryWriteSettleFailed({ ...INPUT, sha: "a".repeat(40) });

		expect(h.settle).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "FAILED",
				outcome: {
					status: "FAILED",
					code: "SETTLE_FAILED",
					retryable: true,
					sha: "a".repeat(40),
				},
			}),
		);
	});

	it("names no commit when nothing was pushed", async () => {
		await reportMemoryWriteSettleFailed({ ...INPUT, sha: null });

		expect(h.settle.mock.calls[0]?.[0].outcome).toEqual({
			status: "FAILED",
			code: "SETTLE_FAILED",
			retryable: true,
		});
	});
});

describe("startMemoryWriteSync", () => {
	const SHA = "b".repeat(40);

	it("starts an automatic run for the row the write was made against, with nothing more to do", async () => {
		await startMemoryWriteSync({ ...INPUT, sha: SHA });

		expect(h.startSync).toHaveBeenCalledWith({
			projectId: INPUT.projectId,
			organizationId: INPUT.organizationId,
			trigger: "WEBHOOK",
			expected: { syncId: "sync_1", generation: 4 },
		});
		expect(h.recordPending).not.toHaveBeenCalled();
	});

	it("records the pushed head on the row when a run is already open, and settles it against that run", async () => {
		h.startOutcome = {
			outcome: "already_running",
			workflowId: "wf",
			runId: "run_open",
		};

		await startMemoryWriteSync({ ...INPUT, sha: SHA });

		const row = {
			id: "sync_1",
			projectId: INPUT.projectId,
			organizationId: INPUT.organizationId,
			generation: 4,
		};
		expect(h.recordPending).toHaveBeenCalledWith(
			expect.anything(),
			row,
			SHA,
		);
		expect(h.settlePending).toHaveBeenCalledWith(
			expect.anything(),
			row,
			"run_open",
		);
	});

	it("settles nothing when the row was re-configured since (the marker was not applied)", async () => {
		h.startOutcome = {
			outcome: "already_running",
			workflowId: "wf",
			runId: "r",
		};
		h.recordPending.mockResolvedValue({ applied: false });

		await startMemoryWriteSync({ ...INPUT, sha: SHA });

		expect(h.settlePending).not.toHaveBeenCalled();
	});

	it("does nothing when the project no longer has a sync, and throws a failed start for the workflow to ignore", async () => {
		h.syncRow = null;
		await startMemoryWriteSync({ ...INPUT, sha: SHA });
		expect(h.startSync).not.toHaveBeenCalled();

		h.syncRow = { id: "sync_1", generation: 4 };
		h.startSync.mockImplementationOnce(() => {
			throw new Error("temporal is unreachable");
		});
		await expect(
			startMemoryWriteSync({ ...INPUT, sha: SHA }),
		).rejects.toThrow("temporal is unreachable");
	});
});
