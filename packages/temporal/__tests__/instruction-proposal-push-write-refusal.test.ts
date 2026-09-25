/**
 * The open activity against a push refused at the HTTP level (Fizzy #2563).
 *
 * A GitHub App whose Contents permission is read-only makes `git push` fail
 * with "Write access to repository not granted." and a 403 before any ref is
 * reported. The open activity must read that as a branch-write refusal
 * (`BRANCH_WRITE_REFUSED`, the record returned to not issued, the same ref
 * kept), not as a retryable `GIT_FAILED` that burns a new `-N` ref per retry;
 * a GitHub SAML SSO wall with the same 403 must instead go to credential
 * recovery. Unlike the main activities suite, `pushCreateOnly` here is the
 * real one, spawning a fake `git` that prints the provider's stderr, and
 * `isGitAuthError` is the real predicate.
 *
 * The in-memory database and provider fakes are copied from
 * instruction-proposal-pull-request-activities.test.ts, which exports none
 * of them. Every identifier is synthetic; the token is assembled at runtime.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const TOKEN = ["tok", "placeholder", "proposal"].join("-");
const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const OP = `op${"0".repeat(21)}1`;
const BRANCH = `fabric/instructions/${OP}`;
const EMAIL = ["user", "example.com"].join("@");
const NOW = new Date("2026-09-24T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

type Rec = {
	attempt: number;
	ref: string;
	sha: string;
	pushIssuedAt?: string;
	pushAckedAt?: string;
	createIssuedAt?: string;
	settledAt?: string;
	confirmations: number;
	outcome?: string;
};
type Pr = {
	externalId: string;
	url: string;
	state: "OPEN" | "MERGED" | "CLOSED";
	sourceRef: string;
	targetRef: string;
	sourceRepository: unknown;
	headSha: string;
	mergedAt?: string;
	closedAt?: string;
	mergeCommitSha?: string;
};

const m = vi.hoisted(() => {
	class CancelledFailure extends Error {
		constructor(message = "cancelled") {
			super(message);
			this.name = "CancelledFailure";
		}
	}
	return {
		CancelledFailure,
		state: {
			row: null as Record<string, unknown> | null,
			clock: new Date(0),
			audits: [] as Array<{ action: string; metadata?: unknown }>,
			transitions: [] as Array<Record<string, unknown>>,
			sync: null as Record<string, unknown> | null,
			integration: null as Record<string, unknown> | null,
			remote: new Map<string, string>(),
			prs: [] as Pr[],
			nextPr: 100,
			activity: null as {
				cancellationSignal: AbortSignal;
				info?: {
					startToCloseTimeoutMs: number;
					scheduleToCloseTimeoutMs: number;
					scheduledTimestampMs: number;
					currentAttemptScheduledTimestampMs: number;
					heartbeatTimeoutMs?: number;
				};
			} | null,
			/** The signal each Temporal client call ran under. */
			clientSignals: [] as AbortSignal[],
			receipts: [] as Array<Record<string, unknown>>,
		},
		settings: vi.fn(),
		selectDue: vi.fn(),
		defer: vi.fn(),
		describe: vi.fn(),
		start: vi.fn(),
		startSync: vi.fn(),
		canCreate: vi.fn(),
		canRead: vi.fn(),
		getSync: vi.fn(),
		listFiles: vi.fn(),
		resolveFreshRepoToken: vi.fn(),
		forceReExchangeRepoCredentials: vi.fn(),
		markRepoReauthRequired: vi.fn(),
		downloadFile: vi.fn(),
		heartbeat: vi.fn(),
		cloneTreeless: vi.fn(),
		fetchPinnedCommit: vi.fn(),
		revParseHead: vi.fn(),
		listTreeRaw: vi.fn(),
		pushCreateOnly: vi.fn(),
		lsRemoteRef: vi.fn(),
		deleteBranch: vi.fn(),
		buildProposalCommit: vi.fn(),
		findOperation: vi.fn(),
		open: vi.fn(),
		get: vi.fn(),
		close: vi.fn(),
		log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	};
});

// ---------------------------------------------------------------------------
// The in-memory database (Task 5 semantics)
// ---------------------------------------------------------------------------

const clone = <T>(v: T): T => structuredClone(v);
const rowOf = () => m.state.row as Record<string, unknown>;
const recordsOf = () => (rowOf().pullRequestAttempts as Rec[]) ?? [];

function applyPatch(r: Rec, patch: Record<string, unknown>): Rec {
	const next: Record<string, unknown> = { ...r };
	for (const [k, v] of Object.entries(patch)) {
		if (v === null || v === undefined) {
			delete next[k];
		} else {
			next[k] = v;
		}
	}
	return next as Rec;
}

function meets(r: Rec, expect: Record<string, unknown>): boolean {
	for (const f of [
		"pushIssuedAt",
		"pushAckedAt",
		"createIssuedAt",
		"settledAt",
		"outcome",
	] as const) {
		const want = expect[f];
		if (want === undefined) {
			continue;
		}
		const present = r[f] !== undefined && r[f] !== null;
		if (want === null ? present : !present) {
			return false;
		}
	}
	return (
		expect.confirmations === undefined ||
		r.confirmations === expect.confirmations
	);
}

function writeRecord(i: {
	identity: { attempt: number; ref: string };
	expect: Record<string, unknown>;
	patch: Record<string, unknown>;
	row?: { states?: string[]; attempt?: number };
	append?: boolean;
}): boolean {
	const row = rowOf();
	if (
		i.row?.states &&
		!i.row.states.includes(row.pullRequestState as string)
	) {
		return false;
	}
	if (
		i.row?.attempt !== undefined &&
		row.pullRequestAttempt !== i.row.attempt
	) {
		return false;
	}
	const records = recordsOf();
	const index = records.findIndex(
		(r) => r.attempt === i.identity.attempt && r.ref === i.identity.ref,
	);
	if (i.append) {
		if (index !== -1) {
			return false;
		}
		const created = applyPatch(
			{ ...i.identity, sha: "", confirmations: 0 },
			i.patch,
		);
		if (!created.sha) {
			throw new Error("An appended attempt record needs its sha");
		}
		row.pullRequestAttempts = [...records, created];
		return true;
	}
	if (index === -1 || !meets(records[index] as Rec, i.expect)) {
		return false;
	}
	row.pullRequestAttempts = records.map((r, n) =>
		n === index ? applyPatch(r, i.patch) : r,
	);
	return true;
}

const STATUS: Record<string, string> = {
	QUEUED: "PENDING",
	OPENING: "PENDING",
	OPEN: "PENDING",
	CLOSE_REQUESTED: "PENDING",
	BLOCKED: "PENDING",
	MERGED: "MERGED",
	CLOSED: "CLOSED",
	CANCELED: "REJECTED",
};

function transition(i: {
	event: string;
	from: string[];
	expectedAttempt: number | null;
	to: string;
	bumpAttempt: boolean;
	data?: Record<string, unknown>;
	audit?: unknown;
}): { ok: true; attempt: number } | { ok: false } {
	const row = rowOf();
	m.state.transitions.push({
		event: i.event,
		from: i.from,
		to: i.to,
		expectedAttempt: i.expectedAttempt,
	});
	if (!i.from.includes(row.pullRequestState as string)) {
		return { ok: false };
	}
	if (
		i.expectedAttempt !== null &&
		row.pullRequestAttempt !== i.expectedAttempt
	) {
		return { ok: false };
	}
	Object.assign(row, clone(i.data ?? {}));
	if (i.to !== "unchanged") {
		row.pullRequestState = i.to;
		row.proposalStatus = STATUS[i.to];
	}
	if (i.bumpAttempt) {
		row.pullRequestAttempt = (row.pullRequestAttempt as number) + 1;
	}
	const audits =
		i.audit === undefined
			? []
			: Array.isArray(i.audit)
				? i.audit
				: [i.audit];
	m.state.audits.push(...(audits as Array<{ action: string }>));
	return { ok: true, attempt: row.pullRequestAttempt as number };
}

vi.mock("@repo/database", async (importOriginal) => ({
	// Real: the parser the repository identity gate reads a live URL with.
	parseRepoUrl: (await importOriginal<typeof import("@repo/database")>())
		.parseRepoUrl,
	getProposalOperation: vi.fn(
		async (i: {
			snapshotId: string;
			projectId: string;
			organizationId: string;
		}) => {
			const row = m.state.row;
			if (
				!row ||
				row.id !== i.snapshotId ||
				row.projectId !== i.projectId ||
				row.organizationId !== i.organizationId
			) {
				return null;
			}
			return { ...clone(row), databaseNow: new Date(m.state.clock) };
		},
	),
	claimPullRequestOpen: vi.fn(
		async (i: {
			expectedAttempt: number;
			retryCreate?: { expectedAttempt: number };
		}) => {
			const row = m.state.row;
			const state = row?.pullRequestState as string | null;
			if (!row || state === null) {
				return { kind: "not_claimable" };
			}
			if (state === "OPEN") {
				return { kind: "open" };
			}
			if (state === "CLOSE_REQUESTED") {
				return { kind: "close_requested" };
			}
			if (["MERGED", "CLOSED", "CANCELED"].includes(state)) {
				return { kind: "terminal" };
			}
			if (row.pullRequestAttempt !== i.expectedAttempt) {
				return { kind: "not_claimable" };
			}
			const marker = recordsOf().some(
				(r) => r.createIssuedAt && !r.settledAt,
			);
			const next = row.pullRequestNextAttemptAt as Date | null;
			const due = !next || next.getTime() <= m.state.clock.getTime();
			const failure = row.pullRequestFailure as {
				retryable?: boolean;
			} | null;
			const claimable = i.retryCreate
				? state === "BLOCKED" &&
					row.pullRequestAttempt === i.retryCreate.expectedAttempt
				: !marker &&
					(state === "QUEUED" ||
						state === "OPENING" ||
						(state === "BLOCKED" &&
							due &&
							failure?.retryable === true));
			if (!claimable) {
				return { kind: "not_claimable" };
			}
			row.pullRequestState = "OPENING";
			row.proposalStatus = "PENDING";
			row.pullRequestAttempt = i.expectedAttempt + 1;
			return { kind: "claimed", attempt: i.expectedAttempt + 1 };
		},
	),
	transitionPullRequest: vi.fn(async (i: Parameters<typeof transition>[0]) =>
		transition(i),
	),
	writeAttemptRecord: vi.fn(async (i: Parameters<typeof writeRecord>[0]) =>
		writeRecord(i),
	),
	applyPullRequestChange: vi.fn(
		async (i: {
			records?: Array<Parameters<typeof writeRecord>[0]>;
			transition?: Parameters<typeof transition>[0];
		}) => {
			const saved = clone(m.state.row);
			const savedAudits = [...m.state.audits];
			const undo = () => {
				m.state.row = saved;
				m.state.audits = savedAudits;
				return { ok: false as const };
			};
			for (const r of i.records ?? []) {
				if (!writeRecord(r)) {
					return undo();
				}
			}
			if (!i.transition) {
				return { ok: true, attempt: null };
			}
			const moved = transition(i.transition);
			return moved.ok ? moved : undo();
		},
	),
	storePullRequestHeadSha: vi.fn(
		async (i: { attempt: number; sha: string; ref: string }) => {
			const row = rowOf();
			if (
				row.pullRequestState !== "OPENING" ||
				row.pullRequestAttempt !== i.attempt
			) {
				return "moved";
			}
			if (row.pullRequestHeadSha && row.pullRequestHeadSha !== i.sha) {
				return "mismatch";
			}
			row.pullRequestHeadSha = i.sha;
			row.pullRequestRef ??= i.ref;
			return "stored";
		},
	),
	getInstructionRepositorySyncForProposal: m.getSync,
	canCreateProjectInstructions: m.canCreate,
	canReadProjectInstructions: m.canRead,
	listInstructionFiles: m.listFiles,
	getProjectRepoIntegration: vi.fn(async () => m.state.integration),
	getProjectInstructionSettings: m.settings,
	selectDueProposalOperations: m.selectDue,
	deferProposalOperation: m.defer,
	getSyncRunReceiptByRunId: vi.fn(
		async (i: { runId: string }) =>
			m.state.receipts.find((r) =>
				String(r.id).endsWith(`:${i.runId}`),
			) ?? null,
	),
	findMergeTriggeredRun: vi.fn(
		async (i: {
			syncId: string;
			generation: number;
			startedAtOrAfter: Date;
		}) =>
			m.state.receipts
				.filter(
					(r) =>
						r.syncId === i.syncId &&
						r.generation === i.generation &&
						r.trigger === "PULL_REQUEST_MERGED" &&
						(r.startedAt as Date).getTime() >=
							i.startedAtOrAfter.getTime(),
				)
				.sort(
					(a, b) =>
						(b.startedAt as Date).getTime() -
						(a.startedAt as Date).getTime(),
				)[0] ?? null,
	),
	clearMergeSyncRequest: vi.fn(
		async (i: {
			kind: "acknowledged" | "gave_up";
			expected: unknown;
			audit?: { action: string };
			failure?: unknown;
		}) => {
			const row = rowOf();
			if (
				row.pullRequestState !== "MERGED" ||
				!row.mergeSyncRequestedAt ||
				JSON.stringify(row.mergeSyncExpected ?? null) !==
					JSON.stringify(i.expected ?? null)
			) {
				return false;
			}
			row.mergeSyncRequestedAt = null;
			row.mergeSyncDispatchedAt = null;
			if (i.kind === "gave_up") {
				row.mergeSyncRunId = null;
				row.pullRequestFailure = clone(i.failure);
				row.pullRequestNextAttemptAt = null;
			} else if (i.audit) {
				m.state.audits.push(i.audit);
			}
			return true;
		},
	),
	markMergeSyncDispatched: vi.fn(
		async (i: {
			lastExpected: unknown;
			next: unknown;
			dispatchedAt: Date;
			nextAttemptAt: Date;
		}) => {
			const row = rowOf();
			if (
				row.pullRequestState !== "MERGED" ||
				!row.mergeSyncRequestedAt ||
				JSON.stringify(row.mergeSyncExpected ?? null) !==
					JSON.stringify(i.lastExpected ?? null)
			) {
				return false;
			}
			row.mergeSyncDispatchedAt = i.dispatchedAt;
			row.mergeSyncExpected = clone(i.next);
			row.mergeSyncRunId = null;
			row.pullRequestNextAttemptAt = i.nextAttemptAt;
			return true;
		},
	),
	recordMergeSyncRun: vi.fn(
		async (i: { expected: unknown; runId: string }) => {
			const row = rowOf();
			if (
				!row.mergeSyncDispatchedAt ||
				JSON.stringify(row.mergeSyncExpected) !==
					JSON.stringify(i.expected)
			) {
				return false;
			}
			row.mergeSyncRunId = i.runId;
			row.pullRequestFailure = null;
			return true;
		},
	),
	nextRetryDelayMs: (
		code: string,
		ctx: {
			retryAfterSeconds?: number;
			markerAgeMs?: number;
			recoveries?: number;
		},
	) => {
		const table: Record<string, number | null> = {
			VALIDATION_TIMEOUT: HOUR,
			REMOTE_REF_CONFLICT: 6 * HOUR,
			AUTHENTICATION_FAILED: 6 * HOUR,
			CLOSE_CREDENTIALS_UNAVAILABLE: 6 * HOUR,
			BRANCH_WRITE_REFUSED: 6 * HOUR,
			PERMISSION_REVOKED: null,
			CONFIGURATION_CHANGED: null,
			PR_CREATION_REFUSED: null,
		};
		if (code === "CREATE_OUTCOME_UNKNOWN") {
			if ((ctx.markerAgeMs ?? 0) >= 24 * HOUR) {
				return null;
			}
			return [1, 5, 15, 60][Math.min(ctx.recoveries ?? 0, 3)] * 60_000;
		}
		if (code === "PROVIDER_RATE_LIMITED") {
			return (ctx.retryAfterSeconds ?? 900) * 1000;
		}
		return code in table ? table[code] : 15 * 60_000;
	},
}));
vi.mock("@repo/integrations", async () => {
	// The package barrel pulls in modules this suite's database mock does not
	// serve, so the real predicate is loaded from its own module.
	const real = await vi.importActual<
		typeof import("../../integrations/src/repo-auth")
	>("../../integrations/src/repo-auth");
	return {
		resolveFreshRepoToken: m.resolveFreshRepoToken,
		forceReExchangeRepoCredentials: m.forceReExchangeRepoCredentials,
		markRepoReauthRequired: m.markRepoReauthRequired,
		REPO_REAUTH_STEP_BOUND_MS: 20_000,
		isGitAuthError: real.isGitAuthError,
	};
});
vi.mock(
	"@repo/integrations/instruction-pull-requests",
	async (importOriginal) => {
		const real =
			await importOriginal<
				typeof import("@repo/integrations/instruction-pull-requests")
			>();
		return {
			...real,
			adapterFor: () => ({
				findOperation: m.findOperation,
				open: m.open,
				get: m.get,
				close: m.close,
			}),
		};
	},
);
vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({ downloadFile: m.downloadFile }),
}));
vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { skills: "skills" } } },
}));
vi.mock("@repo/logs", () => ({ logger: m.log }));
vi.mock("@temporalio/activity", () => ({
	heartbeat: m.heartbeat,
	CancelledFailure: m.CancelledFailure,
	Context: {
		current: () => {
			if (!m.state.activity) {
				throw new Error("not in an activity");
			}
			return m.state.activity;
		},
	},
	ApplicationFailure: {
		create: (o: { message: string }) => new Error(o.message),
		nonRetryable: (message: string) => new Error(message),
	},
}));
vi.mock("../src/client", () => ({
	getTemporalClient: async () => ({
		withAbortSignal: <T>(signal: AbortSignal, fn: () => Promise<T>) => {
			m.state.clientSignals.push(signal);
			return fn();
		},
		workflow: {
			getHandle: (workflowId: string, runId?: string) => ({
				describe: () => m.describe(workflowId, runId),
			}),
			start: m.start,
		},
	}),
}));
vi.mock("../src/activities/lib/instruction-sync-start", () => ({
	startAutomaticInstructionSync: m.startSync,
}));
// A real scratch directory: the real push spawns git inside the clone path.
vi.mock("../src/activities/lib/instruction-sync-temp", () => ({
	createSyncRunDir: vi.fn(async () => {
		const fs = await import("node:fs/promises");
		const os = await import("node:os");
		const nodePath = await import("node:path");
		return fs.mkdtemp(nodePath.join(os.tmpdir(), "proposal-run-"));
	}),
	removeSyncRunDir: vi.fn(async (dir: string) => {
		const fs = await import("node:fs/promises");
		await fs.rm(dir, { recursive: true, force: true });
	}),
}));
vi.mock(
	"../src/activities/lib/instruction-sync-git",
	async (importOriginal) => {
		const real =
			await importOriginal<
				typeof import("../src/activities/lib/instruction-sync-git")
			>();
		return {
			...real,
			cloneTreeless: m.cloneTreeless,
			fetchPinnedCommit: m.fetchPinnedCommit,
			revParseHead: m.revParseHead,
			listTreeRaw: m.listTreeRaw,
			pushCreateOnly: m.pushCreateOnly,
			lsRemoteRef: m.lsRemoteRef,
			deleteBranch: m.deleteBranch,
		};
	},
);
vi.mock(
	"../src/activities/lib/instruction-proposal-commit",
	async (importOriginal) => {
		const real =
			await importOriginal<
				typeof import("../src/activities/lib/instruction-proposal-commit")
			>();
		return { ...real, buildProposalCommit: m.buildProposalCommit };
	},
);

import { InstructionPullRequestError } from "@repo/integrations/instruction-pull-requests";
import { openInstructionProposalPullRequest } from "../src/activities/instruction-proposal-pull-requests";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPOSITORIES = {
	GITHUB: { provider: "GITHUB", owner: "example-org", repo: "example-repo" },
	GITLAB: { provider: "GITLAB", projectPath: "example-org/example-repo" },
	AZURE_DEVOPS: {
		provider: "AZURE_DEVOPS",
		apiOrigin: "https://dev.azure.com",
		organization: "example-org",
		project: "Example Project",
		repository: "example-repo",
	},
} as const;
const URLS = {
	GITHUB: "https://github.com/example-org/example-repo",
	GITLAB: "https://gitlab.com/example-org/example-repo",
	AZURE_DEVOPS:
		"https://dev.azure.com/example-org/Example%20Project/_git/example-repo",
} as const;
type Provider = keyof typeof REPOSITORIES;

function contextFor(provider: Provider = "GITHUB") {
	return {
		v: 1,
		integrationId: "int_1",
		syncId: "sync_1",
		syncGeneration: 3,
		provider,
		targetRef: "main",
		rootPath: "",
		baseCommitSha: BASE,
		repository: REPOSITORIES[provider],
		branch: BRANCH,
		author: { name: "Example User", email: EMAIL },
		committer: { name: "Example User", email: EMAIL },
		title: "Update the review rules",
		body: "Proposed in Fabric.",
		message: "Update the review rules\n\nProposed in Fabric.",
		committedAt: "2026-09-24T11:00:00Z",
	};
}

function seed(
	over: Record<string, unknown> = {},
	provider: Provider = "GITHUB",
) {
	m.state.row = {
		id: "snap_1",
		projectId: "proj_1",
		organizationId: "org_1",
		userId: "user_1",
		version: 7,
		status: "READY",
		proposalStatus: "PENDING",
		proposalDestination: "REPOSITORY",
		baseSnapshotId: "snap_0",
		createdAt: new Date(NOW.getTime() - HOUR),
		pullRequestOperationId: OP,
		pullRequestState: "QUEUED",
		pullRequestAttempt: 0,
		pullRequestContext: contextFor(provider),
		pullRequestHeadSha: null,
		pullRequestRef: null,
		pullRequestAttempts: [],
		pullRequestUrl: null,
		pullRequestExternalId: null,
		pullRequestObservation: null,
		pullRequestFailure: null,
		pullRequestLastCheckedAt: null,
		pullRequestNextAttemptAt: null,
		mergeSyncRequestedAt: null,
		mergeSyncDispatchedAt: null,
		mergeSyncRunId: null,
		mergeSyncExpected: null,
		...over,
	};
	m.state.integration = {
		id: "int_1",
		projectId: "proj_1",
		provider,
		authMethod: provider === "AZURE_DEVOPS" ? "PAT" : "OAUTH",
		status: "ACTIVE",
		repositoryUrl: URLS[provider],
	};
	m.state.sync = {
		id: "sync_1",
		projectId: "proj_1",
		organizationId: "org_1",
		userId: "user_2",
		repositoryIntegrationId: "int_1",
		ref: "main",
		rootPath: "",
		generation: 3,
		allowReaderProposals: false,
		repositoryIntegration: {
			id: "int_1",
			projectId: "proj_1",
			status: "ACTIVE",
			provider,
			repositoryUrl: URLS[provider],
		},
	};
}

function pr(over: Partial<Pr> = {}): Pr {
	const externalId = String(m.state.nextPr++);
	return {
		externalId,
		url: `https://example.com/example-org/example-repo/pull/${externalId}`,
		state: "OPEN",
		sourceRef: BRANCH,
		targetRef: "main",
		sourceRepository: REPOSITORIES.GITHUB,
		headSha: HEAD,
		...over,
	};
}

const ids = {
	snapshotId: "snap_1",
	projectId: "proj_1",
	organizationId: "org_1",
	operationId: OP,
};
const row = () => rowOf();
const failure = () =>
	row().pullRequestFailure as {
		code: string;
		phase: string;
		retryable: boolean;
		params: Record<string, unknown>;
	} | null;

beforeEach(() => {
	vi.clearAllMocks();
	// Also drop any once-queue a failing test left behind, so no answer
	// leaks into the next test; every default is set again below.
	for (const value of [...Object.values(m), ...Object.values(m.log)]) {
		if (vi.isMockFunction(value)) {
			value.mockReset();
		}
	}
	m.state.clock = new Date(NOW);
	m.state.audits = [];
	m.state.transitions = [];
	m.state.remote = new Map();
	m.state.prs = [];
	m.state.nextPr = 100;
	m.state.activity = null;
	m.state.clientSignals = [];
	m.state.receipts = [];
	seed();
	m.settings.mockResolvedValue({
		ignoreGlobs: null,
		sourceOfTruth: "REPOSITORY",
	});
	m.defer.mockResolvedValue(true);
	m.describe.mockRejectedValue(
		Object.assign(new Error("not found"), {
			name: "WorkflowNotFoundError",
		}),
	);
	m.start.mockResolvedValue({ firstExecutionRunId: "run_new" });
	m.startSync.mockResolvedValue({
		outcome: "started",
		workflowId: "project-instruction-repository-sync-proj_1",
		runId: "run_new",
	});
	m.canCreate.mockResolvedValue(true);
	m.canRead.mockResolvedValue(true);
	m.getSync.mockImplementation(async () => clone(m.state.sync));
	m.listFiles.mockResolvedValue([]);
	m.resolveFreshRepoToken.mockResolvedValue({
		token: TOKEN,
		authMethod: "OAUTH",
		provider: "GITHUB",
	});
	m.forceReExchangeRepoCredentials.mockResolvedValue({ refreshed: false });
	m.markRepoReauthRequired.mockResolvedValue(undefined);
	m.cloneTreeless.mockResolvedValue(undefined);
	m.fetchPinnedCommit.mockResolvedValue(undefined);
	m.revParseHead.mockResolvedValue(BASE);
	m.listTreeRaw.mockResolvedValue({ ok: true, entries: [] });
	m.buildProposalCommit.mockResolvedValue({ ok: true, sha: HEAD });
	m.pushCreateOnly.mockImplementation(
		async (i: { branch: string; sha: string }) => {
			if (m.state.remote.has(i.branch)) {
				return { kind: "exists" };
			}
			m.state.remote.set(i.branch, i.sha);
			return { kind: "created" };
		},
	);
	m.lsRemoteRef.mockImplementation(async (i: { branch: string }) =>
		m.state.remote.has(i.branch)
			? { kind: "found", sha: m.state.remote.get(i.branch) }
			: { kind: "missing" },
	);
	m.deleteBranch.mockImplementation(
		async (i: { branch: string; sha: string }) => {
			if (!m.state.remote.has(i.branch)) {
				return { kind: "absent" };
			}
			if (m.state.remote.get(i.branch) !== i.sha) {
				return { kind: "stale" };
			}
			m.state.remote.delete(i.branch);
			return { kind: "deleted" };
		},
	);
	m.findOperation.mockImplementation(async (i: { sourceRef: string }) => {
		const found = m.state.prs.filter((p) => p.sourceRef === i.sourceRef);
		if (found.length === 0) {
			return { kind: "ABSENT" };
		}
		if (found.length > 1) {
			return { kind: "INCONCLUSIVE", cause: "conflict" };
		}
		return { kind: "FOUND", value: clone(found[0]) };
	});
	m.open.mockImplementation(
		async (i: { sourceRef: string; targetRef: string }) => {
			const created = pr({
				sourceRef: i.sourceRef,
				targetRef: i.targetRef,
			});
			m.state.prs.push(created);
			return clone(created);
		},
	);
	m.get.mockImplementation(async (i: { externalId: string }) => {
		const found = m.state.prs.find((p) => p.externalId === i.externalId);
		if (!found) {
			throw new InstructionPullRequestError({
				code: "REPOSITORY_UNAVAILABLE",
				retryable: true,
				cause: "not_found",
			});
		}
		return clone(found);
	});
	m.close.mockImplementation(async (i: { externalId: string }) => {
		const found = m.state.prs.find((p) => p.externalId === i.externalId);
		if (!found) {
			throw new Error("no such pull request");
		}
		if (found.state === "OPEN") {
			found.state = "CLOSED";
			found.closedAt = NOW.toISOString();
		}
		return clone(found);
	});
});

const open = (over: Record<string, unknown> = {}) =>
	openInstructionProposalPullRequest({
		...ids,
		expectedAttempt: row().pullRequestAttempt as number,
		...over,
	});

// ---------------------------------------------------------------------------
// The real push against a fake git (Fizzy #2563)
// ---------------------------------------------------------------------------

const REMOTE = "https://github.com/example-org/example-repo.git/";
const HTTP_403 = `fatal: unable to access '${REMOTE}': The requested URL returned error: 403`;
const READ_ONLY_APP = `remote: Write access to repository not granted.\n${HTTP_403}`;
const SAML_SSO = `remote: The 'example-org' organization has enabled or enforced SAML SSO.\nremote: To access this repository, you must re-authorize the OAuth Application.\n${HTTP_403}`;

let fakeBin: string;
let savedPath: string | undefined;
const remoteSays = (stderr: string) =>
	writeFile(path.join(fakeBin, "stderr"), `${stderr}\n`);

beforeAll(async () => {
	fakeBin = await mkdtemp(path.join(tmpdir(), "proposal-fake-git-"));
	// Every git call fails as a refused push does: the provider's stderr and
	// exit 128, with no porcelain ref line on stdout. The stderr is read from a
	// file, since buildGitEnv passes only an allow-list of variables to git.
	await writeFile(
		path.join(fakeBin, "git"),
		[
			"#!/bin/sh",
			`cat '${path.join(fakeBin, "stderr")}' >&2`,
			"exit 128",
			"",
		].join("\n"),
	);
	await chmod(path.join(fakeBin, "git"), 0o755);
	// buildGitEnv passes PATH through from the worker's environment.
	savedPath = process.env.PATH;
	// The fake shadows any real git; the rest of PATH still serves `cat`.
	process.env.PATH = `${fakeBin}${path.delimiter}${savedPath ?? ""}`;
});
afterAll(async () => {
	process.env.PATH = savedPath;
	await rm(fakeBin, { recursive: true, force: true });
});

describe("openInstructionProposalPullRequest: a push refused before any ref is reported", () => {
	beforeEach(async () => {
		const real = await vi.importActual<
			typeof import("../src/activities/lib/instruction-sync-git")
		>("../src/activities/lib/instruction-sync-git");
		m.pushCreateOnly.mockImplementation(real.pushCreateOnly);
		// The clone is faked; the real push only needs its directory to exist.
		m.cloneTreeless.mockImplementation(async (i: { dir: string }) => {
			await mkdir(i.dir, { recursive: true });
		});
	});

	it("a GitHub App with read-only Contents blocks BRANCH_WRITE_REFUSED on the same ref", async () => {
		await remoteSays(READ_ONLY_APP);
		expect(await open()).toEqual({ kind: "blocked" });
		expect(m.pushCreateOnly).toHaveBeenCalledTimes(1);
		expect(recordsOf()).toHaveLength(1);
		expect(recordsOf()[0]).toMatchObject({ attempt: 1, ref: BRANCH });
		expect(recordsOf()[0]?.pushIssuedAt).toBeUndefined();
		expect(row().pullRequestRef).toBe(BRANCH);
		expect(failure()).toMatchObject({
			code: "BRANCH_WRITE_REFUSED",
			retryable: true,
		});
		expect(failure()?.code).not.toBe("GIT_FAILED");
		expect(m.open).not.toHaveBeenCalled();
	});

	it("a GitHub SAML SSO wall beside the same 403 goes to credential recovery", async () => {
		await remoteSays(SAML_SSO);
		expect(await open()).toEqual({ kind: "blocked" });
		expect(m.forceReExchangeRepoCredentials).toHaveBeenCalled();
		expect(failure()?.code).not.toBe("BRANCH_WRITE_REFUSED");
		expect(failure()).toMatchObject({ code: "AUTHENTICATION_FAILED" });
		expect(m.open).not.toHaveBeenCalled();
	});
});
