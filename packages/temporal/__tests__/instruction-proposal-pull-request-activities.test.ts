/**
 * The proposal pull-request activities (Fizzy #2563 spec §6, §6.1, §6.2,
 * spec §14 "Open and workflow", "Settlement, close and retry").
 *
 * The database is an in-memory model of the Task 5 primitives (their
 * fences and conditional writes are pinned against real Postgres in
 * packages/database), git is a fake remote keyed by branch, and the provider
 * is a fake pull-request list, so each case can assert which effects ran and
 * which never did. Every identifier is synthetic; the token is assembled at
 * runtime.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	onTestFinished,
	vi,
} from "vitest";

const TOKEN = ["tok", "placeholder", "proposal"].join("-");
const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const FOREIGN = "d".repeat(40);
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
vi.mock("@repo/integrations", () => ({
	resolveFreshRepoToken: m.resolveFreshRepoToken,
	forceReExchangeRepoCredentials: m.forceReExchangeRepoCredentials,
	markRepoReauthRequired: m.markRepoReauthRequired,
	REPO_REAUTH_STEP_BOUND_MS: 20_000,
	isGitAuthError: (e: unknown) =>
		String((e as Error)?.message)
			.toLowerCase()
			.includes("authentication failed"),
}));
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
vi.mock("../src/activities/lib/instruction-sync-temp", () => ({
	createSyncRunDir: vi.fn(async () => "/nonexistent/fabric-proposal-run"),
	removeSyncRunDir: vi.fn(async () => {}),
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

import {
	applyPullRequestChange,
	claimPullRequestOpen,
	getProjectRepoIntegration,
	getProposalOperation,
	transitionPullRequest,
	writeAttemptRecord,
} from "@repo/database";
import { InstructionPullRequestError } from "@repo/integrations/instruction-pull-requests";
import {
	checkInstructionProposalReadiness,
	closeInstructionProposalPullRequest,
	dispatchInstructionProposalMergeSync,
	dispatchInstructionProposalPullRequest,
	openInstructionProposalPullRequest,
	reconcileInstructionProposalPullRequest,
	recoverInstructionProposalPullRequest,
	selectDueInstructionProposalOperations,
} from "../src/activities/instruction-proposal-pull-requests";
import { ProposalDeadlineExceeded } from "../src/activities/lib/instruction-proposal-boundary";
import { abandonedPush } from "../src/activities/lib/instruction-proposal-settlement";
import { GitCommandError } from "../src/activities/lib/instruction-sync-git";

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
const actions = () => m.state.audits.map((a) => a.action);
const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const ack = (over: Partial<Rec> = {}): Rec => ({
	attempt: 1,
	ref: BRANCH,
	sha: HEAD,
	pushIssuedAt: iso(-HOUR),
	pushAckedAt: iso(-HOUR),
	confirmations: 0,
	...over,
});

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

const readiness = (over: Record<string, unknown> = {}) =>
	checkInstructionProposalReadiness({ ...ids, ...over });
const open = (over: Record<string, unknown> = {}) =>
	openInstructionProposalPullRequest({
		...ids,
		expectedAttempt: row().pullRequestAttempt as number,
		...over,
	});
const recover = (over: Record<string, unknown> = {}) =>
	recoverInstructionProposalPullRequest({ ...ids, ...over });
const close = (over: Record<string, unknown> = {}) =>
	closeInstructionProposalPullRequest({ ...ids, ...over });
const remoteIo = () =>
	m.cloneTreeless.mock.calls.length +
	m.pushCreateOnly.mock.calls.length +
	m.lsRemoteRef.mock.calls.length +
	m.deleteBranch.mock.calls.length +
	m.findOperation.mock.calls.length +
	m.open.mock.calls.length +
	m.get.mock.calls.length +
	m.close.mock.calls.length;

// ---------------------------------------------------------------------------
// Open and workflow (spec §14)
// ---------------------------------------------------------------------------

describe("checkInstructionProposalReadiness", () => {
	it("answers ready with the attempt read beside the READY verdict", async () => {
		seed({ pullRequestAttempt: 4, pullRequestState: "BLOCKED" });
		expect(await readiness()).toEqual({ kind: "ready", attempt: 4 });
	});

	it.each([
		["RECEIVING", false],
		["VALIDATING", false],
		["FAILED", true],
	])("answers pending for %s", async (status, validationFailed) => {
		seed({ status });
		expect(await readiness()).toEqual({
			kind: "pending",
			validationFailed,
		});
	});

	it("records VALIDATION_FAILED once, keeping QUEUED, and READY clears it", async () => {
		seed({ status: "FAILED" });
		await readiness();
		expect(row().pullRequestState).toBe("QUEUED");
		expect(failure()).toMatchObject({
			code: "VALIDATION_FAILED",
			phase: "validation",
			retryable: true,
		});
		await readiness();
		expect(
			m.state.transitions.filter((t) => t.event === "validation_failed"),
		).toHaveLength(1);
		row().status = "READY";
		expect(await readiness()).toEqual({ kind: "ready", attempt: 0 });
		expect(failure()).toBeNull();
	});

	it.each([
		["REJECTED snapshot", { status: "REJECTED" }],
		[
			"another operation",
			{ pullRequestOperationId: `op${"0".repeat(21)}2` },
		],
		["a FABRIC proposal", { proposalDestination: "FABRIC" }],
		["an OPEN row", { pullRequestState: "OPEN" }],
		["a CLOSE_REQUESTED row", { pullRequestState: "CLOSE_REQUESTED" }],
		["a CANCELED row", { pullRequestState: "CANCELED" }],
		["a MERGED row", { pullRequestState: "MERGED" }],
		["a decided proposal", { proposalStatus: "REJECTED" }],
	])("stops for %s", async (_label, over) => {
		seed(over);
		expect(await readiness()).toEqual({ kind: "stop" });
	});

	it("stops for a missing row", async () => {
		m.state.row = null;
		expect(await readiness()).toEqual({ kind: "stop" });
	});

	// A REJECTED snapshot left pre-create (its verdict's cancel never ran)
	// is selected by the sweeper's Restart sub-batch on every tick; the stop
	// must settle it, or the workflow is started for it forever.
	it("cancels a QUEUED operation on a REJECTED snapshot, and a second call writes nothing", async () => {
		seed({
			status: "REJECTED",
			proposalStatus: "REJECTED",
			rejection: [{ path: "a.md", reason: "secret" }],
		});
		expect(await readiness()).toEqual({ kind: "stop" });
		expect(row()).toMatchObject({
			pullRequestState: "CANCELED",
			proposalStatus: "REJECTED",
			pullRequestAttempt: 1,
			pullRequestNextAttemptAt: null,
		});
		expect(failure()).toMatchObject({
			code: "VALIDATION_REJECTED",
			phase: "validation",
			retryable: false,
			params: {},
		});
		expect(m.state.transitions).toEqual([
			expect.objectContaining({
				event: "validation_rejected",
				from: ["QUEUED"],
				to: "CANCELED",
				expectedAttempt: 0,
			}),
		]);
		expect(m.state.audits).toEqual([
			expect.objectContaining({
				action: "project.instructions.pull_request_reconciled",
				metadata: expect.objectContaining({
					outcome: "canceled",
					code: "VALIDATION_REJECTED",
					operationId: OP,
				}),
			}),
		]);

		expect(await readiness()).toEqual({ kind: "stop" });
		expect(m.state.transitions).toHaveLength(1);
		expect(m.state.audits).toHaveLength(1);
		expect(row().pullRequestAttempt).toBe(1);
	});

	it("cancels an abandoned upload's operation as abandonment", async () => {
		seed({
			status: "REJECTED",
			rejection: [
				{
					path: "(upload)",
					reason: "abandoned",
					detail: "staging cleared",
				},
			],
		});
		expect(await readiness()).toEqual({ kind: "stop" });
		expect(row().pullRequestState).toBe("CANCELED");
		expect(m.state.transitions).toEqual([
			expect.objectContaining({ event: "abandoned", to: "CANCELED" }),
		]);
		expect(failure()).toMatchObject({
			code: "VALIDATION_REJECTED",
			params: { reason: "abandoned" },
		});
	});

	it("cancels a BLOCKED validation-timeout operation whose snapshot was then REJECTED", async () => {
		seed({
			status: "REJECTED",
			pullRequestState: "BLOCKED",
			pullRequestAttempt: 2,
			pullRequestFailure: {
				code: "VALIDATION_TIMEOUT",
				phase: "validation",
				retryable: true,
				params: {},
			},
		});
		expect(await readiness()).toEqual({ kind: "stop" });
		expect(row()).toMatchObject({
			pullRequestState: "CANCELED",
			pullRequestAttempt: 3,
		});
	});

	it.each([
		["a head SHA", { pullRequestHeadSha: HEAD }],
		[
			"an issued push",
			{
				pullRequestState: "OPENING",
				pullRequestAttempts: [
					{
						attempt: 1,
						ref: BRANCH,
						sha: HEAD,
						pushIssuedAt: NOW.toISOString(),
						confirmations: 0,
					},
				],
			},
		],
		[
			"an issued create",
			{
				pullRequestState: "OPENING",
				pullRequestAttempts: [
					{
						attempt: 1,
						ref: BRANCH,
						sha: HEAD,
						createIssuedAt: NOW.toISOString(),
						confirmations: 0,
					},
				],
			},
		],
	])(
		"leaves a REJECTED snapshot's operation with %s to settlement",
		async (_label, over) => {
			seed({ status: "REJECTED", ...over });
			expect(await readiness()).toEqual({ kind: "stop" });
			expect(m.state.transitions).toEqual([]);
			expect(m.state.audits).toEqual([]);
		},
	);

	it("writes nothing for a READY snapshot whose proposal is decided", async () => {
		seed({ proposalStatus: "REJECTED" });
		expect(await readiness()).toEqual({ kind: "stop" });
		expect(m.state.transitions).toEqual([]);
		expect(row().pullRequestState).toBe("QUEUED");
	});

	it("writes BLOCKED VALIDATION_TIMEOUT at the 6 h deadline and stops", async () => {
		seed({ status: "VALIDATING" });
		expect(await readiness({ deadlineReached: true })).toEqual({
			kind: "stop",
		});
		expect(row().pullRequestState).toBe("BLOCKED");
		expect(failure()).toMatchObject({
			code: "VALIDATION_TIMEOUT",
			retryable: true,
		});
		expect(row().pullRequestNextAttemptAt).toEqual(
			new Date(NOW.getTime() + HOUR),
		);
	});
});

describe("openInstructionProposalPullRequest: the happy path", () => {
	it("claims, builds, pushes create-only, marks, creates once and records the receipt", async () => {
		expect(await open()).toEqual({ kind: "open" });
		const r = row();
		expect(r.pullRequestState).toBe("OPEN");
		expect(r.pullRequestAttempt).toBe(1);
		expect(r.pullRequestHeadSha).toBe(HEAD);
		expect(r.pullRequestRef).toBe(BRANCH);
		expect(r.pullRequestExternalId).toBe("100");
		expect(r.pullRequestFailure).toBeNull();
		expect(m.state.remote.get(BRANCH)).toBe(HEAD);
		expect(m.pushCreateOnly).toHaveBeenCalledTimes(1);
		expect(m.open).toHaveBeenCalledTimes(1);
		expect(m.open.mock.calls[0]?.[0]).toMatchObject({
			sourceRef: BRANCH,
			targetRef: "main",
			title: "Update the review rules",
		});
		const [record] = recordsOf();
		expect(record).toMatchObject({
			attempt: 1,
			ref: BRANCH,
			sha: HEAD,
			outcome: "opened",
		});
		expect(record?.pushAckedAt).toBeDefined();
		expect(record?.createIssuedAt).toBeUndefined();
		expect(actions()).toEqual(["project.instructions.pull_request_opened"]);
		expect(m.state.audits[0]?.metadata).toMatchObject({
			provider: "GITHUB",
			operationId: OP,
			externalId: "100",
			adopted: false,
		});
	});

	it("reads the proposal's bytes from the instructions bucket and passes the token only as a credential", async () => {
		m.buildProposalCommit.mockImplementation(
			async (i: { readBytes(key: string): Promise<Buffer> }) => {
				await i.readBytes("key-1");
				return { ok: true, sha: HEAD };
			},
		);
		m.downloadFile.mockResolvedValue({ data: Buffer.from("x") });
		await open();
		expect(m.downloadFile).toHaveBeenCalledWith("key-1", {
			bucket: "skills",
		});
		const cloneCall = m.cloneTreeless.mock.calls[0]?.[0] as {
			url: string;
			env: Record<string, string>;
		};
		expect(cloneCall.url).toBe(URLS.GITHUB);
		expect(cloneCall.url).not.toContain(TOKEN);
		expect(cloneCall.env.FABRIC_GIT_CREDENTIAL).toBe(TOKEN);
		expect(m.open.mock.calls[0]?.[0]).toMatchObject({
			auth: { token: TOKEN, authMethod: "OAUTH" },
		});
	});
});

describe("openInstructionProposalPullRequest: the claim and due confirmations", () => {
	it("returns not_claimable for a stale attempt with no due confirmation, and does no remote I/O", async () => {
		seed({ pullRequestAttempt: 2 });
		expect(await open({ expectedAttempt: 1 })).toEqual({
			kind: "not_claimable",
		});
		expect(remoteIo()).toBe(0);
		expect(m.resolveFreshRepoToken).not.toHaveBeenCalled();
		expect(row().pullRequestAttempt).toBe(2);
	});

	it("runs a due confirmation, identity-fenced, then refuses the stale claim with no build, push or create", async () => {
		const settledRef = `${BRANCH}-2`;
		seed({
			pullRequestState: "QUEUED",
			pullRequestAttempt: 5,
			pullRequestAttempts: [
				ack({ attempt: 2, ref: settledRef, settledAt: iso(-2 * HOUR) }),
			],
		});
		expect(await open({ expectedAttempt: 4 })).toEqual({
			kind: "not_claimable",
		});
		expect(m.findOperation).toHaveBeenCalledWith(
			expect.objectContaining({ sourceRef: settledRef }),
		);
		expect(recordsOf()[0]?.confirmations).toBe(1);
		expect(m.cloneTreeless).not.toHaveBeenCalled();
		expect(m.pushCreateOnly).not.toHaveBeenCalled();
		expect(m.open).not.toHaveBeenCalled();
		expect(row().pullRequestAttempt).toBe(5);
	});

	it.each([
		["OPEN", "open"],
		["MERGED", "terminal"],
		["CLOSE_REQUESTED", "close_requested"],
	])(
		"runs due confirmations on a %s row before the claim returns early",
		async (state, kind) => {
			seed({
				pullRequestState: state,
				pullRequestAttempts: [
					ack({
						ref: `${BRANCH}-2`,
						attempt: 2,
						settledAt: iso(-2 * HOUR),
					}),
				],
			});
			expect(await open()).toEqual({ kind });
			expect(recordsOf()[0]?.confirmations).toBe(1);
		},
	);

	it("never claims a row with a create marker without retryCreate, and never calls adapter.open", async () => {
		seed({
			pullRequestState: "BLOCKED",
			pullRequestAttempt: 1,
			pullRequestFailure: {
				phase: "create",
				code: "CREATE_OUTCOME_UNKNOWN",
				retryable: true,
				at: NOW.toISOString(),
				params: {},
			},
			pullRequestAttempts: [ack({ createIssuedAt: iso(-HOUR) })],
		});
		expect(await open()).toEqual({ kind: "not_claimable" });
		expect(m.open).not.toHaveBeenCalled();
	});
});

/**
 * A refusal a human must act on after an acknowledged push leaves no owner
 * for the branch unless it is released: deleted only at the pushed SHA, its
 * record settled, the row's state and failure kept, and its 1 h and 24 h
 * confirmations then run by Close on the record's own clock.
 */
async function expectBranchReleased() {
	const code = failure()?.code;
	expect(m.deleteBranch).toHaveBeenCalledTimes(1);
	expect(m.deleteBranch).toHaveBeenCalledWith(
		expect.objectContaining({ branch: BRANCH, sha: HEAD }),
	);
	expect(m.state.remote.has(BRANCH)).toBe(false);
	expect(recordsOf()).toHaveLength(1);
	expect(recordsOf()[0]).toMatchObject({
		ref: BRANCH,
		sha: HEAD,
		pushAckedAt: expect.any(String),
		settledAt: NOW.toISOString(),
		confirmations: 0,
		outcome: "settled",
	});
	expect(recordsOf()[0]?.createIssuedAt).toBeUndefined();
	expect(row().pullRequestState).toBe("BLOCKED");
	expect(failure()).toMatchObject({ code, retryable: false });

	for (const [at, count] of [
		[HOUR, 1],
		[25 * HOUR, 2],
	] as const) {
		m.findOperation.mockClear();
		m.state.clock = new Date(NOW.getTime() + at);
		expect(await close()).toEqual({ kind: "pending" });
		expect(m.findOperation).toHaveBeenCalledWith(
			expect.objectContaining({ sourceRef: BRANCH }),
		);
		expect(recordsOf()[0]?.confirmations).toBe(count);
	}
	expect(row().pullRequestState).toBe("BLOCKED");
	expect(failure()).toMatchObject({ code, retryable: false });
}

describe("openInstructionProposalPullRequest: creation checks run before every new effect", () => {
	// Spec §13 revoked access (plan Task 19): revocation during the build.
	it("stops a push after the proposer loses INSTRUCTION_CREATE with PERMISSION_REVOKED", async () => {
		m.canCreate.mockResolvedValueOnce(true).mockResolvedValue(false);
		expect(await open()).toEqual({ kind: "blocked" });
		expect(m.buildProposalCommit).toHaveBeenCalledTimes(1);
		expect(m.pushCreateOnly).not.toHaveBeenCalled();
		expect(row().pullRequestState).toBe("BLOCKED");
		expect(failure()).toMatchObject({
			code: "PERMISSION_REVOKED",
			phase: "push",
			retryable: false,
		});
		expect(row().pullRequestNextAttemptAt).toBeNull();
	});

	it("revocation after the push and before the create writes PERMISSION_REVOKED, sets no marker and never calls adapter.open", async () => {
		m.canCreate
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(true)
			.mockResolvedValue(false);
		expect(await open()).toEqual({ kind: "blocked" });
		expect(m.pushCreateOnly).toHaveBeenCalledTimes(1);
		expect(m.open).not.toHaveBeenCalled();
		expect(recordsOf()[0]?.createIssuedAt).toBeUndefined();
		expect(failure()).toMatchObject({
			code: "PERMISSION_REVOKED",
			phase: "create",
		});
		await expectBranchReleased();
	});

	it("a generation change between build and push gives CONFIGURATION_CHANGED with no push", async () => {
		m.getSync
			.mockImplementationOnce(async () => clone(m.state.sync))
			.mockImplementation(async () => ({
				...clone(m.state.sync),
				generation: 4,
			}));
		expect(await open()).toEqual({ kind: "blocked" });
		expect(m.pushCreateOnly).not.toHaveBeenCalled();
		expect(failure()).toMatchObject({
			code: "CONFIGURATION_CHANGED",
			phase: "push",
			retryable: false,
		});
	});

	it("a rootPath change between push and create gives CONFIGURATION_CHANGED with no marker", async () => {
		m.getSync
			.mockImplementationOnce(async () => clone(m.state.sync))
			.mockImplementationOnce(async () => clone(m.state.sync))
			.mockImplementation(async () => ({
				...clone(m.state.sync),
				rootPath: "docs",
			}));
		expect(await open()).toEqual({ kind: "blocked" });
		expect(m.pushCreateOnly).toHaveBeenCalledTimes(1);
		expect(m.open).not.toHaveBeenCalled();
		expect(recordsOf()[0]?.createIssuedAt).toBeUndefined();
		expect(failure()).toMatchObject({ code: "CONFIGURATION_CHANGED" });
		await expectBranchReleased();
	});

	it("turning reader proposals off gives a reader proposer PERMISSION_REVOKED before the create", async () => {
		m.canCreate.mockResolvedValue(false);
		m.state.sync = { ...m.state.sync, allowReaderProposals: true };
		m.getSync
			.mockImplementationOnce(async () => clone(m.state.sync))
			.mockImplementationOnce(async () => clone(m.state.sync))
			.mockImplementation(async () => ({
				...clone(m.state.sync),
				allowReaderProposals: false,
			}));
		expect(await open()).toEqual({ kind: "blocked" });
		expect(m.pushCreateOnly).toHaveBeenCalledTimes(1);
		expect(m.open).not.toHaveBeenCalled();
		expect(failure()).toMatchObject({ code: "PERMISSION_REVOKED" });
	});

	// Spec §6.1 creation requires an ACTIVE integration. TOKEN_EXPIRED is
	// the one status a reconnect fixes, so it is a retryable
	// AUTHENTICATION_FAILED (the card offers reconnect); every other status
	// is a changed configuration a human must resolve.
	it.each([
		["TOKEN_EXPIRED", "AUTHENTICATION_FAILED", true],
		["REPO_UNAVAILABLE", "CONFIGURATION_CHANGED", false],
		["ERROR", "CONFIGURATION_CHANGED", false],
		["DISCONNECTED", "CONFIGURATION_CHANGED", false],
	] as const)(
		"a %s integration at the creation check gives %s (retryable %s) and builds nothing",
		async (status, code, retryable) => {
			const sync = m.state.sync as Record<string, unknown>;
			m.state.sync = {
				...sync,
				repositoryIntegration: {
					...(sync.repositoryIntegration as Record<string, unknown>),
					status,
				},
			};
			expect(await open()).toEqual({ kind: "blocked" });
			expect(m.buildProposalCommit).not.toHaveBeenCalled();
			expect(m.pushCreateOnly).not.toHaveBeenCalled();
			expect(row().pullRequestState).toBe("BLOCKED");
			expect(failure()).toMatchObject({
				code,
				phase: "prepare",
				retryable,
			});
		},
	);

	it("a status the switch does not list is never silently CONFIGURATION_CHANGED: it fails closed as UNEXPECTED and builds nothing", async () => {
		// The switch is exhaustive over RepositoryIntegrationStatus (a new
		// member fails the type-check); a value the schema does not know yet,
		// read from a newer database, reaches the exhaustive guard.
		const sync = m.state.sync as Record<string, unknown>;
		m.state.sync = {
			...sync,
			repositoryIntegration: {
				...(sync.repositoryIntegration as Record<string, unknown>),
				status: "SUSPENDED",
			},
		};
		expect(await open()).toEqual({ kind: "blocked" });
		expect(m.buildProposalCommit).not.toHaveBeenCalled();
		expect(m.pushCreateOnly).not.toHaveBeenCalled();
		expect(failure()).toMatchObject({
			code: "UNEXPECTED",
			phase: "prepare",
			retryable: true,
		});
	});

	it("an ACTIVE integration passes the creation check and opens", async () => {
		expect(m.state.sync?.repositoryIntegration).toMatchObject({
			status: "ACTIVE",
		});
		expect(await open()).toEqual({ kind: "open" });
		expect(m.open).toHaveBeenCalledTimes(1);
	});

	it("a cancel landing mid-open stops at the next check, writing nothing", async () => {
		m.buildProposalCommit.mockImplementation(async () => {
			row().pullRequestState = "CLOSE_REQUESTED";
			row().pullRequestAttempt = 2;
			return { ok: true, sha: HEAD };
		});
		expect(await open()).toEqual({ kind: "close_requested" });
		expect(m.pushCreateOnly).not.toHaveBeenCalled();
		expect(row().pullRequestFailure).toBeNull();
	});

	it("a validation verdict landing mid-open stops at the next check", async () => {
		m.buildProposalCommit.mockImplementation(async () => {
			row().pullRequestState = "CANCELED";
			row().pullRequestAttempt = 2;
			return { ok: true, sha: HEAD };
		});
		expect(await open()).toEqual({ kind: "terminal" });
		expect(m.pushCreateOnly).not.toHaveBeenCalled();
	});
});

describe("the live integration must still name the frozen repository", () => {
	// Admission froze `context.repository` from the integration's URL. The
	// id and generation alone do not pin it: re-pointing the integration's
	// URL keeps both, so every load and gate re-derives the identity from
	// the live URL and refuses CONFIGURATION_CHANGED on any difference.
	const repoint = (
		url: string,
		where: { integration?: boolean; sync?: boolean } = {
			integration: true,
			sync: true,
		},
	) => {
		if (where.integration) {
			m.state.integration = {
				...m.state.integration,
				repositoryUrl: url,
			};
		}
		if (where.sync) {
			const sync = m.state.sync as Record<string, unknown>;
			m.state.sync = {
				...sync,
				repositoryIntegration: {
					...(sync.repositoryIntegration as Record<string, unknown>),
					repositoryUrl: url,
				},
			};
		}
	};

	it.each([
		[
			"GITHUB",
			"another repository",
			"https://github.com/example-org/other-repo",
		],
		[
			"GITHUB",
			"another owner",
			"https://github.com/other-org/example-repo",
		],
		[
			"GITLAB",
			"another project path",
			"https://gitlab.com/example-org/sub/example-repo",
		],
		[
			"AZURE_DEVOPS",
			"another project",
			"https://dev.azure.com/example-org/Other%20Project/_git/example-repo",
		],
		[
			"AZURE_DEVOPS",
			"another origin",
			"https://example-org.visualstudio.com/Example%20Project/_git/example-repo",
		],
		["GITHUB", "no repository at all", "https://github.com/example-org"],
	] as const)(
		"on %s, %s under the same integration id and generation: no token, clone, push, lookup or open",
		async (provider, _change, url) => {
			seed({}, provider);
			repoint(url);
			expect(await open()).toEqual({ kind: "blocked" });
			expect(remoteIo()).toBe(0);
			expect(m.resolveFreshRepoToken).not.toHaveBeenCalled();
			expect(m.buildProposalCommit).not.toHaveBeenCalled();
			expect(row().pullRequestState).toBe("BLOCKED");
			expect(failure()).toMatchObject({
				code: "CONFIGURATION_CHANGED",
				retryable: false,
			});
		},
	);

	it("the creation gate compares it too: a sync read naming another repository builds nothing", async () => {
		repoint("https://github.com/example-org/other-repo", { sync: true });
		expect(await open()).toEqual({ kind: "blocked" });
		expect(m.buildProposalCommit).not.toHaveBeenCalled();
		expect(m.pushCreateOnly).not.toHaveBeenCalled();
		expect(m.open).not.toHaveBeenCalled();
		expect(failure()).toMatchObject({
			code: "CONFIGURATION_CHANGED",
			phase: "prepare",
			retryable: false,
		});
	});

	it("a repository change between build and push pushes nothing", async () => {
		m.getSync
			.mockImplementationOnce(async () => clone(m.state.sync))
			.mockImplementation(async () => {
				const sync = clone(m.state.sync) as Record<string, unknown>;
				return {
					...sync,
					repositoryIntegration: {
						...(sync.repositoryIntegration as Record<
							string,
							unknown
						>),
						repositoryUrl:
							"https://github.com/example-org/other-repo",
					},
				};
			});
		expect(await open()).toEqual({ kind: "blocked" });
		expect(m.buildProposalCommit).toHaveBeenCalledTimes(1);
		expect(m.pushCreateOnly).not.toHaveBeenCalled();
		expect(failure()).toMatchObject({
			code: "CONFIGURATION_CHANGED",
			phase: "push",
			retryable: false,
		});
	});

	it("a repository change between push and create never calls adapter.open", async () => {
		m.getSync
			.mockImplementationOnce(async () => clone(m.state.sync))
			.mockImplementationOnce(async () => clone(m.state.sync))
			.mockImplementation(async () => {
				const sync = clone(m.state.sync) as Record<string, unknown>;
				return {
					...sync,
					repositoryIntegration: {
						...(sync.repositoryIntegration as Record<
							string,
							unknown
						>),
						repositoryUrl:
							"https://github.com/example-org/other-repo",
					},
				};
			});
		expect(await open()).toEqual({ kind: "blocked" });
		expect(m.pushCreateOnly).toHaveBeenCalledTimes(1);
		expect(m.open).not.toHaveBeenCalled();
		expect(recordsOf()[0]?.createIssuedAt).toBeUndefined();
		expect(failure()).toMatchObject({
			code: "CONFIGURATION_CHANGED",
			phase: "create",
			retryable: false,
		});
	});

	it.each([
		[
			"GITHUB",
			"a .git suffix",
			"https://github.com/example-org/example-repo.git",
		],
		[
			"AZURE_DEVOPS",
			"the Clone button's userinfo",
			`https://example-org@${"dev.azure.com"}/example-org/Example%20Project/_git/example-repo`,
		],
	] as const)(
		"on %s the same repository spelled with %s still opens",
		async (provider, _spelling, url) => {
			seed({}, provider);
			repoint(url);
			expect(await open()).toEqual({ kind: "open" });
			expect(m.open).toHaveBeenCalledTimes(1);
		},
	);

	it.each([
		[
			"a case-only change proceeds and opens",
			"https://github.com/Example-Org/EXAMPLE-REPO",
			{ kind: "open" },
		],
		[
			"another repository still refuses",
			"https://github.com/example-org/other-repo",
			{ kind: "blocked" },
		],
	] as const)(
		"GitHub paths are case-insensitive: %s",
		async (_case, url, result) => {
			repoint(url);
			expect(await open()).toEqual(result);
			if (result.kind === "open") {
				expect(m.resolveFreshRepoToken).toHaveBeenCalled();
				expect(m.pushCreateOnly).toHaveBeenCalledTimes(1);
				expect(m.open).toHaveBeenCalledTimes(1);
			} else {
				expect(remoteIo()).toBe(0);
				expect(m.resolveFreshRepoToken).not.toHaveBeenCalled();
				expect(failure()).toMatchObject({
					code: "CONFIGURATION_CHANGED",
					retryable: false,
				});
			}
		},
	);

	it("a case-only GitHub URL change still loads the credential for close", async () => {
		const opened = pr();
		m.state.prs.push(opened);
		seed({
			pullRequestState: "CLOSE_REQUESTED",
			pullRequestAttempt: 2,
			pullRequestHeadSha: HEAD,
			pullRequestRef: BRANCH,
			pullRequestExternalId: opened.externalId,
			pullRequestAttempts: [ack({ outcome: "opened" })],
		});
		m.state.remote.set(BRANCH, HEAD);
		repoint("https://github.com/EXAMPLE-ORG/example-repo");
		expect(await close()).toEqual({ kind: "closed" });
		expect(m.state.prs[0]?.state).toBe("CLOSED");
		expect(m.state.remote.has(BRANCH)).toBe(false);
	});

	it("recovery refuses before any lookup", async () => {
		seed({
			pullRequestState: "BLOCKED",
			pullRequestAttempt: 1,
			pullRequestHeadSha: HEAD,
			pullRequestRef: BRANCH,
			pullRequestFailure: {
				phase: "create",
				code: "CREATE_OUTCOME_UNKNOWN",
				retryable: true,
				at: NOW.toISOString(),
				params: { recoveries: 0 },
			},
			pullRequestAttempts: [ack({ createIssuedAt: iso(-HOUR) })],
		});
		m.state.prs.push(pr());
		repoint("https://github.com/example-org/other-repo");
		expect(await recover()).toEqual({ kind: "failed" });
		expect(remoteIo()).toBe(0);
		expect(m.resolveFreshRepoToken).not.toHaveBeenCalled();
		expect(failure()).toMatchObject({
			code: "CONFIGURATION_CHANGED",
			retryable: false,
		});
	});

	it("close refuses before any lookup, close or delete", async () => {
		const opened = pr();
		m.state.prs.push(opened);
		seed({
			pullRequestState: "CLOSE_REQUESTED",
			pullRequestAttempt: 2,
			pullRequestHeadSha: HEAD,
			pullRequestRef: BRANCH,
			pullRequestExternalId: opened.externalId,
			pullRequestAttempts: [ack({ outcome: "opened" })],
		});
		m.state.remote.set(BRANCH, HEAD);
		repoint("https://github.com/example-org/other-repo");
		expect(await close()).toEqual({ kind: "pending" });
		expect(remoteIo()).toBe(0);
		expect(m.state.prs[0]?.state).toBe("OPEN");
		expect(m.state.remote.get(BRANCH)).toBe(HEAD);
		expect(row().pullRequestState).toBe("CLOSE_REQUESTED");
		expect(failure()).toMatchObject({
			code: "CONFIGURATION_CHANGED",
			phase: "close",
			retryable: false,
		});
	});
});

describe("an acknowledged branch a refusal left without an owner", () => {
	const revokedAtCreate = () =>
		m.canCreate
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(true)
			.mockResolvedValue(false);
	const absentThen = (answer: unknown) =>
		m.findOperation
			.mockResolvedValueOnce({ kind: "ABSENT" })
			.mockResolvedValue(answer);

	it("a refusal before any push releases nothing", async () => {
		m.canCreate.mockResolvedValue(false);
		expect(await open()).toEqual({ kind: "blocked" });
		expect(m.pushCreateOnly).not.toHaveBeenCalled();
		expect(m.deleteBranch).not.toHaveBeenCalled();
		expect(failure()).toMatchObject({ code: "PERMISSION_REVOKED" });
	});

	it("a release that cannot finish keeps the refusal and leaves the record for Close", async () => {
		revokedAtCreate();
		absentThen({ kind: "INCONCLUSIVE", cause: "transient" });
		expect(await open()).toEqual({ kind: "blocked" });
		expect(m.deleteBranch).not.toHaveBeenCalled();
		expect(m.state.remote.get(BRANCH)).toBe(HEAD);
		expect(recordsOf()[0]?.settledAt).toBeUndefined();
		expect(recordsOf()[0]?.outcome).toBeUndefined();
		expect(row().pullRequestState).toBe("BLOCKED");
		expect(failure()).toMatchObject({
			code: "PERMISSION_REVOKED",
			retryable: false,
		});
		expect(row().pullRequestNextAttemptAt).toBeNull();
		expect(m.log.info).toHaveBeenCalledWith(
			{
				event: "instruction_proposal.branch_release_deferred",
				code: "LOOKUP_INCONCLUSIVE",
			},
			expect.any(String),
		);
	});

	it("an untyped exception in the release keeps the refusal and logs only its class", async () => {
		revokedAtCreate();
		m.deleteBranch.mockRejectedValue(
			new TypeError("detail that stays out"),
		);
		expect(await open()).toEqual({ kind: "blocked" });
		expect(recordsOf()[0]?.settledAt).toBeUndefined();
		expect(failure()).toMatchObject({
			code: "PERMISSION_REVOKED",
			retryable: false,
		});
		expect(m.log.info).toHaveBeenCalledWith(
			{
				event: "instruction_proposal.branch_release_deferred",
				code: "UNEXPECTED",
				errorClass: "TypeError",
			},
			expect.any(String),
		);
		expect(JSON.stringify(m.log.info.mock.calls)).not.toContain(
			"stays out",
		);
	});

	it("never deletes a tip Fabric did not write: the record takes outcome conflict", async () => {
		revokedAtCreate();
		const other = "d".repeat(40);
		m.pushCreateOnly.mockImplementation(async (i: { branch: string }) => {
			m.state.remote.set(i.branch, other); // overwritten right after
			return { kind: "created" };
		});
		expect(await open()).toEqual({ kind: "blocked" });
		expect(m.deleteBranch).not.toHaveBeenCalled();
		expect(m.state.remote.get(BRANCH)).toBe(other);
		expect(recordsOf()[0]).toMatchObject({ outcome: "conflict" });
		expect(recordsOf()[0]?.settledAt).toBeUndefined();
		expect(failure()).toMatchObject({ code: "PERMISSION_REVOKED" });
	});

	it("adopts a pull request found on the branch instead of deleting it", async () => {
		revokedAtCreate();
		m.pushCreateOnly.mockImplementation(
			async (i: { branch: string; sha: string }) => {
				m.state.remote.set(i.branch, i.sha);
				m.state.prs.push(pr({ sourceRef: i.branch }));
				return { kind: "created" };
			},
		);
		expect(await open()).toEqual({ kind: "open" });
		expect(m.open).not.toHaveBeenCalled();
		expect(m.deleteBranch).not.toHaveBeenCalled();
		expect(row().pullRequestState).toBe("OPEN");
		expect(recordsOf()[0]).toMatchObject({ outcome: "opened" });
		expect(actions()).toEqual(["project.instructions.pull_request_opened"]);
	});
});

describe("closeInstructionProposalPullRequest: an abandoned acknowledged push", () => {
	const revoked = {
		phase: "create",
		code: "PERMISSION_REVOKED",
		retryable: false,
		at: NOW.toISOString(),
	};
	const abandoned = (over: Record<string, unknown> = {}) => {
		seed({
			pullRequestState: "BLOCKED",
			pullRequestAttempt: 1,
			pullRequestHeadSha: HEAD,
			pullRequestRef: BRANCH,
			pullRequestFailure: revoked,
			pullRequestAttempts: [ack()],
			...over,
		});
		m.state.remote.set(BRANCH, HEAD);
	};

	it("releases the branch at its SHA, settles the record and keeps the row's state and failure", async () => {
		abandoned();
		expect(await close({ expectedAttempt: 1 })).toEqual({
			kind: "pending",
		});
		expect(m.deleteBranch).toHaveBeenCalledWith(
			expect.objectContaining({ branch: BRANCH, sha: HEAD }),
		);
		expect(m.state.remote.has(BRANCH)).toBe(false);
		expect(recordsOf()[0]).toMatchObject({
			settledAt: NOW.toISOString(),
			confirmations: 0,
			outcome: "settled",
		});
		expect(row().pullRequestState).toBe("BLOCKED");
		expect(row().pullRequestAttempt).toBe(1);
		expect(row().pullRequestFailure).toEqual(revoked);
		expect(m.open).not.toHaveBeenCalled();
		expect(m.defer).not.toHaveBeenCalled();
	});

	it.each([
		[
			"a retryable failure (Recover (2) and Restart own it)",
			{ pullRequestFailure: { ...revoked, retryable: true } },
		],
		["a recorded pull request", { pullRequestExternalId: "7" }],
		[
			"an outstanding create marker",
			{ pullRequestAttempts: [ack({ createIssuedAt: iso(-HOUR) })] },
		],
		[
			"a settled record",
			{
				pullRequestAttempts: [
					ack({ settledAt: iso(-60_000), outcome: "settled" }),
				],
			},
		],
		[
			"a record with an outcome",
			{ pullRequestAttempts: [ack({ outcome: "conflict" })] },
		],
		[
			"an unacknowledged push",
			{ pullRequestAttempts: [ack({ pushAckedAt: undefined })] },
		],
		["another state", { pullRequestState: "QUEUED" }],
	])("leaves a row with %s alone", async (_case, over) => {
		abandoned(over);
		m.get.mockResolvedValue(pr());
		await close({ expectedAttempt: 1 });
		expect(m.deleteBranch).not.toHaveBeenCalled();
		expect(m.lsRemoteRef).not.toHaveBeenCalled();
		expect(m.findOperation).not.toHaveBeenCalled();
		expect(m.state.remote.get(BRANCH)).toBe(HEAD);
	});

	it("is fenced by the attempt the sweeper read", async () => {
		abandoned();
		expect(await close({ expectedAttempt: 0 })).toEqual({
			kind: "pending",
		});
		expect(remoteIo()).toBe(0);
		expect(recordsOf()[0]?.settledAt).toBeUndefined();
	});

	it("a failed release keeps the failure and defers the row by its retry delay", async () => {
		abandoned();
		m.findOperation.mockResolvedValue({
			kind: "INCONCLUSIVE",
			cause: "transient",
		});
		expect(await close({ expectedAttempt: 1 })).toEqual({
			kind: "pending",
		});
		expect(m.deleteBranch).not.toHaveBeenCalled();
		expect(row().pullRequestFailure).toEqual(revoked);
		expect(recordsOf()[0]?.settledAt).toBeUndefined();
		expect(m.defer).toHaveBeenCalledWith({
			snapshotId: "snap_1",
			organizationId: "org_1",
			attempt: 1,
			minutes: 15,
		});
	});

	it("a rate-limited release reports the integration and waits out Retry-After", async () => {
		abandoned();
		m.findOperation.mockResolvedValue({
			kind: "INCONCLUSIVE",
			cause: "rate_limit",
			retryAfterSeconds: 120,
		});
		expect(await close({ expectedAttempt: 1 })).toEqual({
			kind: "pending",
			rateLimitedIntegrationId: "int_1",
		});
		expect(m.defer).toHaveBeenCalledWith(
			expect.objectContaining({ minutes: 2 }),
		);
	});

	it("a release refused before any effect is looked at again in 6 hours", async () => {
		abandoned();
		m.state.integration = {
			...m.state.integration,
			repositoryUrl: "https://github.com/example-org/other-repo",
		};
		expect(await close({ expectedAttempt: 1 })).toEqual({
			kind: "pending",
		});
		expect(remoteIo()).toBe(0);
		expect(row().pullRequestFailure).toEqual(revoked);
		expect(m.defer).toHaveBeenCalledWith(
			expect.objectContaining({ minutes: 360 }),
		);
	});

	it("an untyped exception after the delete and before the settlement keeps the refusal, defers by UNEXPECTED's delay and leaves the row to Close", async () => {
		abandoned();
		class SettlementWriteBroke extends Error {}
		vi.mocked(writeAttemptRecord).mockRejectedValueOnce(
			new SettlementWriteBroke(
				"connection reset with a secret-ish detail",
			),
		);
		expect(await close({ expectedAttempt: 1 })).toEqual({
			kind: "pending",
		});
		expect(m.deleteBranch).toHaveBeenCalledTimes(1);
		expect(m.state.remote.has(BRANCH)).toBe(false);
		// Nothing recorded over the refusal: still non-retryable, still BLOCKED
		// at the same attempt, the record still unsettled.
		expect(row().pullRequestFailure).toEqual(revoked);
		expect(row().pullRequestState).toBe("BLOCKED");
		expect(row().pullRequestAttempt).toBe(1);
		expect(abandonedPush(row() as never)).not.toBeNull();
		expect(m.defer).toHaveBeenCalledWith({
			snapshotId: "snap_1",
			organizationId: "org_1",
			attempt: 1,
			minutes: 15,
		});
		// Only the class name reaches the log.
		expect(m.log.warn).toHaveBeenCalledWith(
			{
				event: "instruction_proposal.branch_release_failed",
				errorClass: "SettlementWriteBroke",
			},
			expect.any(String),
		);
		expect(JSON.stringify(m.log.warn.mock.calls)).not.toContain("secret");
		// A deferral that cannot be written records nothing either.
		m.defer.mockRejectedValueOnce(new SettlementWriteBroke("down"));
		vi.mocked(writeAttemptRecord).mockRejectedValueOnce(
			new SettlementWriteBroke("again"),
		);
		expect(await close({ expectedAttempt: 1 })).toEqual({
			kind: "pending",
		});
		expect(row().pullRequestFailure).toEqual(revoked);
		expect(m.log.warn).toHaveBeenCalledWith(
			{
				event: "instruction_proposal.branch_release_defer_failed",
				errorClass: "SettlementWriteBroke",
			},
			expect.any(String),
		);
		// Close's next look finishes it: the branch is gone, so it settles.
		m.state.clock = new Date(NOW.getTime() + 15 * 60_000);
		expect(await close({ expectedAttempt: 1 })).toEqual({
			kind: "pending",
		});
		expect(recordsOf()[0]).toMatchObject({ outcome: "settled" });
		expect(row().pullRequestFailure).toEqual(revoked);
	});
});

describe("openInstructionProposalPullRequest: ownership comes from the record alone", () => {
	it("an acknowledged ref at its SHA skips build and push and creates", async () => {
		seed({
			pullRequestState: "BLOCKED",
			pullRequestAttempt: 1,
			pullRequestFailure: {
				phase: "create",
				code: "PROVIDER_TEMPORARY",
				retryable: true,
				at: NOW.toISOString(),
				params: {},
			},
			pullRequestHeadSha: HEAD,
			pullRequestRef: BRANCH,
			pullRequestAttempts: [ack()],
		});
		m.state.remote.set(BRANCH, HEAD);
		expect(await open()).toEqual({ kind: "open" });
		expect(m.cloneTreeless).not.toHaveBeenCalled();
		expect(m.pushCreateOnly).not.toHaveBeenCalled();
		expect(m.open).toHaveBeenCalledTimes(1);
	});

	it("an acknowledged ref that moved is REMOTE_REF_CONFLICT", async () => {
		seed({
			pullRequestState: "OPENING",
			pullRequestAttempt: 1,
			pullRequestHeadSha: HEAD,
			pullRequestRef: BRANCH,
			pullRequestAttempts: [ack()],
		});
		m.state.remote.set(BRANCH, FOREIGN);
		expect(await open()).toEqual({ kind: "blocked" });
		expect(failure()).toMatchObject({
			code: "REMOTE_REF_CONFLICT",
			retryable: false,
		});
		expect(m.deleteBranch).not.toHaveBeenCalled();
		expect(m.open).not.toHaveBeenCalled();
	});

	it("an issued, unacknowledged push with the ref absent records push_unknown_absent and opens on a new record", async () => {
		seed({
			pullRequestState: "OPENING",
			pullRequestAttempt: 1,
			pullRequestHeadSha: HEAD,
			pullRequestRef: BRANCH,
			pullRequestAttempts: [
				{
					attempt: 1,
					ref: BRANCH,
					sha: HEAD,
					pushIssuedAt: iso(-HOUR),
					confirmations: 0,
				},
			],
		});
		expect(await open()).toEqual({ kind: "open" });
		const [first, second] = recordsOf();
		expect(first).toMatchObject({
			ref: BRANCH,
			outcome: "push_unknown_absent",
		});
		expect(second).toMatchObject({
			attempt: 2,
			ref: `${BRANCH}-2`,
			outcome: "opened",
		});
		expect(row().pullRequestRef).toBe(`${BRANCH}-2`);
		expect(m.open.mock.calls[0]?.[0]).toMatchObject({
			sourceRef: `${BRANCH}-2`,
		});
		expect(m.state.remote.has(BRANCH)).toBe(false);
	});

	it.each([
		["at our SHA", HEAD],
		["at a foreign SHA", FOREIGN],
	])(
		"an issued, unacknowledged push with the ref present %s is a conflict: no delete, no create",
		async (_label, tip) => {
			seed({
				pullRequestState: "OPENING",
				pullRequestAttempt: 1,
				pullRequestHeadSha: HEAD,
				pullRequestRef: BRANCH,
				pullRequestAttempts: [
					{
						attempt: 1,
						ref: BRANCH,
						sha: HEAD,
						pushIssuedAt: iso(-HOUR),
						confirmations: 0,
					},
				],
			});
			m.state.remote.set(BRANCH, tip);
			expect(await open()).toEqual({ kind: "blocked" });
			expect(recordsOf()[0]?.outcome).toBe("conflict");
			expect(row().pullRequestState).toBe("BLOCKED");
			expect(failure()).toMatchObject({ code: "REMOTE_REF_CONFLICT" });
			expect(m.deleteBranch).not.toHaveBeenCalled();
			expect(m.pushCreateOnly).not.toHaveBeenCalled();
			expect(m.open).not.toHaveBeenCalled();
			expect(
				m.state.transitions.some(
					(t) => t.event === "push_unknown" && t.to === "BLOCKED",
				),
			).toBe(true);
		},
	);

	it("with no push issued and the ref present, REMOTE_REF_CONFLICT before any build", async () => {
		m.state.remote.set(BRANCH, FOREIGN);
		expect(await open()).toEqual({ kind: "blocked" });
		expect(failure()).toMatchObject({
			code: "REMOTE_REF_CONFLICT",
			phase: "recover",
		});
		expect(m.cloneTreeless).not.toHaveBeenCalled();
	});

	it("a create-only refusal at our SHA is a conflict: nothing deleted, no create", async () => {
		m.pushCreateOnly.mockImplementation(async (i: { branch: string }) => {
			m.state.remote.set(i.branch, HEAD); // someone else won the race
			return { kind: "exists" };
		});
		expect(await open()).toEqual({ kind: "blocked" });
		expect(recordsOf()[0]).toMatchObject({ outcome: "conflict" });
		expect(recordsOf()[0]?.pushAckedAt).toBeUndefined();
		expect(failure()).toMatchObject({
			code: "REMOTE_REF_CONFLICT",
			phase: "push",
		});
		expect(m.deleteBranch).not.toHaveBeenCalled();
		expect(m.open).not.toHaveBeenCalled();
	});

	it("never deletes or creates on a matching SHA without an acknowledgment", async () => {
		seed({
			pullRequestState: "BLOCKED",
			pullRequestAttempt: 1,
			pullRequestFailure: {
				phase: "push",
				code: "GIT_FAILED",
				retryable: true,
				at: NOW.toISOString(),
				params: {},
			},
			pullRequestHeadSha: HEAD,
			pullRequestRef: BRANCH,
			pullRequestAttempts: [
				{
					attempt: 1,
					ref: BRANCH,
					sha: HEAD,
					pushIssuedAt: iso(-HOUR),
					confirmations: 0,
				},
			],
		});
		m.state.remote.set(BRANCH, HEAD);
		await open();
		await recover();
		expect(m.deleteBranch).not.toHaveBeenCalled();
		expect(m.open).not.toHaveBeenCalled();
		expect(m.state.remote.get(BRANCH)).toBe(HEAD);
	});

	it("a definitive push refusal returns the record to not issued and blocks BRANCH_WRITE_REFUSED", async () => {
		m.pushCreateOnly.mockResolvedValue({ kind: "refused" });
		expect(await open()).toEqual({ kind: "blocked" });
		expect(recordsOf()[0]?.pushIssuedAt).toBeUndefined();
		expect(failure()).toMatchObject({
			code: "BRANCH_WRITE_REFUSED",
			retryable: true,
		});
	});
});

describe("openInstructionProposalPullRequest: the create", () => {
	it.each([
		["an ambiguous answer", "CREATE_OUTCOME_UNKNOWN", true],
		["a definitive refusal", "PR_CREATION_REFUSED", false],
	])("keeps the marker after %s", async (_label, code, retryable) => {
		m.open.mockRejectedValue(
			new InstructionPullRequestError({
				code: code as "CREATE_OUTCOME_UNKNOWN",
				retryable,
				cause: retryable ? "transient" : "permission",
			}),
		);
		expect(await open()).toEqual({ kind: "blocked" });
		expect(recordsOf()[0]?.createIssuedAt).toBeDefined();
		expect(failure()).toMatchObject({ code, phase: "create", retryable });
		expect(m.open).toHaveBeenCalledTimes(1);
	});

	it("a duplicate refusal looks the pull request up and adopts it", async () => {
		const existing = pr();
		m.state.prs.push(existing);
		m.open.mockRejectedValue(
			new InstructionPullRequestError({
				code: "PR_CREATION_REFUSED",
				retryable: false,
				cause: "conflict",
				duplicate: true,
			}),
		);
		// The ordinary recovery lookup must not see it, or no create happens.
		m.findOperation.mockResolvedValueOnce({ kind: "ABSENT" });
		expect(await open()).toEqual({ kind: "open" });
		expect(row().pullRequestExternalId).toBe(existing.externalId);
		expect(recordsOf()[0]?.createIssuedAt).toBeUndefined();
		expect(m.state.audits[0]?.metadata).toMatchObject({ adopted: true });
	});

	it("a receipt landing on CLOSE_REQUESTED is recorded unfenced and hands close the row", async () => {
		m.open.mockImplementation(async (i: { sourceRef: string }) => {
			row().pullRequestState = "CLOSE_REQUESTED";
			row().pullRequestAttempt = 2;
			const created = pr({ sourceRef: i.sourceRef });
			m.state.prs.push(created);
			return clone(created);
		});
		expect(await open()).toEqual({ kind: "close_requested" });
		expect(row().pullRequestState).toBe("CLOSE_REQUESTED");
		expect(row().pullRequestExternalId).toBe("100");
		expect(recordsOf()[0]?.createIssuedAt).toBeUndefined();
		expect(actions()).toEqual(["project.instructions.pull_request_opened"]);
	});
});

// ---------------------------------------------------------------------------
// Recovery (spec §6.1 steps 2 and 3)
// ---------------------------------------------------------------------------

describe("recoverInstructionProposalPullRequest", () => {
	const marked = (over: Record<string, unknown> = {}) =>
		seed({
			pullRequestState: "BLOCKED",
			pullRequestAttempt: 1,
			pullRequestHeadSha: HEAD,
			pullRequestRef: BRANCH,
			pullRequestFailure: {
				phase: "create",
				code: "CREATE_OUTCOME_UNKNOWN",
				retryable: true,
				at: NOW.toISOString(),
				params: { recoveries: 0 },
			},
			pullRequestAttempts: [ack({ createIssuedAt: iso(-HOUR) })],
			...over,
		});

	it("adopts a late provider commit", async () => {
		marked();
		m.state.prs.push(pr());
		expect(await recover()).toEqual({ kind: "adopted" });
		expect(row().pullRequestState).toBe("OPEN");
		expect(recordsOf()[0]?.createIssuedAt).toBeUndefined();
		expect(recordsOf()[0]?.outcome).toBe("opened");
		expect(actions()).toEqual(["project.instructions.pull_request_opened"]);
		expect(m.open).not.toHaveBeenCalled();
	});

	it("adopts after CREATE was revoked: creation checks run only after recovery", async () => {
		marked();
		m.canCreate.mockResolvedValue(false);
		m.canRead.mockResolvedValue(false);
		m.state.prs.push(pr({ state: "MERGED", mergedAt: NOW.toISOString() }));
		expect(await recover()).toEqual({ kind: "adopted" });
		expect(row().pullRequestState).toBe("MERGED");
		expect(row().mergeSyncRequestedAt).toEqual(NOW);
		expect(actions()).toEqual([
			"project.instructions.pull_request_opened",
			"project.instructions.pull_request_reconciled",
		]);
		expect(m.canCreate).not.toHaveBeenCalled();
	});

	it("flags a merge into another target and requests no merge sync", async () => {
		marked();
		m.state.prs.push(
			pr({
				state: "MERGED",
				targetRef: "release",
				mergedAt: NOW.toISOString(),
			}),
		);
		await recover();
		expect(row().pullRequestObservation).toMatchObject({
			targetMismatch: true,
		});
		expect(row().mergeSyncRequestedAt).toBeNull();
	});

	it("with the marker and nothing found, records CREATE_OUTCOME_UNKNOWN with backoff and never creates", async () => {
		marked();
		expect(await recover()).toEqual({ kind: "failed" });
		expect(row().pullRequestState).toBe("BLOCKED");
		expect(failure()).toMatchObject({
			code: "CREATE_OUTCOME_UNKNOWN",
			retryable: true,
			params: { recoveries: 1 },
		});
		expect(row().pullRequestNextAttemptAt).toEqual(
			new Date(NOW.getTime() + 60_000),
		);
		await recover();
		expect(failure()?.params).toEqual({ recoveries: 2 });
		expect(row().pullRequestNextAttemptAt).toEqual(
			new Date(NOW.getTime() + 5 * 60_000),
		);
		expect(m.open).not.toHaveBeenCalled();
		expect(m.pushCreateOnly).not.toHaveBeenCalled();
	});

	it("turns CREATE_OUTCOME_UNKNOWN non-retryable 24 h after the marker, and keeps looking hourly", async () => {
		marked({
			pullRequestAttempts: [ack({ createIssuedAt: iso(-25 * HOUR) })],
		});
		await recover();
		expect(row().pullRequestState).toBe("BLOCKED");
		expect(failure()).toMatchObject({
			code: "CREATE_OUTCOME_UNKNOWN",
			retryable: false,
		});
		expect(
			m.state.transitions.some(
				(t) => t.event === "create_unknown_expired",
			),
		).toBe(true);
		expect(row().pullRequestNextAttemptAt).toEqual(
			new Date(NOW.getTime() + HOUR),
		);
	});

	it("hands an acknowledged, unopened operation to Restart", async () => {
		seed({
			pullRequestState: "BLOCKED",
			pullRequestAttempt: 1,
			pullRequestHeadSha: HEAD,
			pullRequestRef: BRANCH,
			pullRequestFailure: {
				phase: "create",
				code: "UNEXPECTED",
				retryable: true,
				at: NOW.toISOString(),
				params: { phase: "create" },
			},
			pullRequestAttempts: [ack()],
		});
		m.state.remote.set(BRANCH, HEAD);
		expect(await recover()).toEqual({ kind: "absent_handoff" });
		expect(m.open).not.toHaveBeenCalled();
		expect(m.pushCreateOnly).not.toHaveBeenCalled();
	});

	it("records push_unknown_absent for an unacknowledged push whose ref is absent, without re-pointing the branch", async () => {
		seed({
			pullRequestState: "BLOCKED",
			pullRequestAttempt: 1,
			pullRequestHeadSha: HEAD,
			pullRequestRef: BRANCH,
			pullRequestFailure: {
				phase: "push",
				code: "GIT_FAILED",
				retryable: true,
				at: NOW.toISOString(),
				params: {},
			},
			pullRequestAttempts: [
				{
					attempt: 1,
					ref: BRANCH,
					sha: HEAD,
					pushIssuedAt: iso(-HOUR),
					confirmations: 0,
				},
			],
		});
		expect(await recover()).toEqual({ kind: "absent_handoff" });
		expect(recordsOf()).toHaveLength(1);
		expect(recordsOf()[0]?.outcome).toBe("push_unknown_absent");
		expect(row().pullRequestRef).toBe(BRANCH);
		// The next open re-points to `<branch>-<claimed attempt>`.
		expect(await open()).toEqual({ kind: "open" });
		expect(row().pullRequestRef).toBe(`${BRANCH}-2`);
	});

	it("hands CLOSE_REQUESTED to close and leaves a row that moved since selection alone", async () => {
		seed({ pullRequestState: "CLOSE_REQUESTED", pullRequestAttempt: 3 });
		expect(await recover()).toEqual({ kind: "close_requested" });
		seed({ pullRequestState: "BLOCKED", pullRequestAttempt: 3 });
		expect(await recover({ expectedAttempt: 2 })).toEqual({
			kind: "unchanged",
		});
		expect(remoteIo()).toBe(0);
	});

	it("reports the integration a provider rate-limited", async () => {
		marked();
		m.findOperation.mockResolvedValue({
			kind: "INCONCLUSIVE",
			cause: "rate_limit",
			retryAfterSeconds: 120,
		});
		expect(await recover()).toEqual({
			kind: "failed",
			rateLimitedIntegrationId: "int_1",
		});
		expect(failure()).toMatchObject({ code: "PROVIDER_RATE_LIMITED" });
		expect(row().pullRequestNextAttemptAt).toEqual(
			new Date(NOW.getTime() + 120_000),
		);
	});

	it("re-exchanges a dead credential once, then flags the integration and records AUTHENTICATION_FAILED", async () => {
		marked();
		m.findOperation.mockResolvedValue({
			kind: "INCONCLUSIVE",
			cause: "auth",
		});
		m.forceReExchangeRepoCredentials.mockResolvedValue({ refreshed: true });
		expect(await recover()).toEqual({ kind: "failed" });
		expect(m.forceReExchangeRepoCredentials).toHaveBeenCalledTimes(1);
		expect(m.findOperation).toHaveBeenCalledTimes(2);
		expect(m.markRepoReauthRequired).toHaveBeenCalledTimes(1);
		expect(failure()).toMatchObject({
			code: "AUTHENTICATION_FAILED",
			phase: "recover",
			retryable: true,
		});
	});
});

// ---------------------------------------------------------------------------
// Settlement, close and retry (spec §14)
// ---------------------------------------------------------------------------

describe("closeInstructionProposalPullRequest: settlement", () => {
	const cancelled = (
		over: Record<string, unknown> = {},
		provider: Provider = "GITHUB",
	) =>
		seed(
			{
				pullRequestState: "CLOSE_REQUESTED",
				pullRequestAttempt: 2,
				pullRequestHeadSha: HEAD,
				pullRequestRef: BRANCH,
				pullRequestAttempts: [ack({ outcome: "opened" })],
				...over,
			},
			provider,
		);

	it.each([["GITHUB"], ["GITLAB"], ["AZURE_DEVOPS"]] as const)(
		"on %s closes the open pull request, deletes the owned branch and ends CLOSED",
		async (provider) => {
			const open = pr();
			m.state.prs.push(open);
			cancelled({ pullRequestExternalId: open.externalId }, provider);
			m.state.remote.set(BRANCH, HEAD);
			expect(await close()).toEqual({ kind: "closed" });
			expect(row().pullRequestState).toBe("CLOSED");
			expect(row().pullRequestAttempt).toBe(3);
			expect(m.state.prs[0]?.state).toBe("CLOSED");
			expect(m.state.remote.has(BRANCH)).toBe(false);
			expect(m.deleteBranch).toHaveBeenCalledWith(
				expect.objectContaining({ branch: BRANCH, sha: HEAD }),
			);
			expect(recordsOf()[0]).toMatchObject({
				settledAt: NOW.toISOString(),
				confirmations: 0,
				outcome: "settled",
			});
			expect(actions()).toEqual([
				"project.instructions.pull_request_reconciled",
			]);
			expect(m.state.audits[0]?.metadata).toMatchObject({
				outcome: "closed",
			});
		},
	);

	it("on Azure DevOps closes the active pull request its deletion was refused for, then deletes", async () => {
		cancelled({}, "AZURE_DEVOPS");
		m.state.remote.set(BRANCH, HEAD);
		let refusals = 0;
		m.deleteBranch.mockImplementation(async (i: { branch: string }) => {
			if (
				m.state.prs.some(
					(p) => p.sourceRef === i.branch && p.state === "OPEN",
				)
			) {
				refusals++;
				return { kind: "refused", activePullRequest: true };
			}
			m.state.remote.delete(i.branch);
			return { kind: "deleted" };
		});
		// Created between the first lookup and the deletion.
		m.findOperation
			.mockResolvedValueOnce({ kind: "ABSENT" })
			.mockImplementation(async (i: { sourceRef: string }) => {
				const found = m.state.prs.filter(
					(p) => p.sourceRef === i.sourceRef,
				);
				return found.length === 1
					? { kind: "FOUND", value: clone(found[0]) }
					: { kind: "ABSENT" };
			});
		m.state.prs.push(pr());
		expect(await close()).toEqual({ kind: "closed" });
		expect(refusals).toBe(1);
		expect(m.state.remote.has(BRANCH)).toBe(false);
	});

	it("closes a create that landed between the lookup and the deletion (step 3)", async () => {
		cancelled();
		m.state.remote.set(BRANCH, HEAD);
		let lookups = 0;
		m.findOperation.mockImplementation(async () => {
			lookups++;
			if (lookups === 1) {
				return { kind: "ABSENT" };
			}
			// The create lands after the first lookup, before step 3's.
			if (m.state.prs.length === 0) {
				m.state.prs.push(pr());
			}
			return { kind: "FOUND", value: clone(m.state.prs[0] as Pr) };
		});
		expect(await close()).toEqual({ kind: "closed" });
		expect(m.state.prs[0]?.state).toBe("CLOSED");
	});

	it("ends CANCELED when no pull request ever existed", async () => {
		cancelled({ pullRequestAttempts: [ack()] });
		m.state.remote.set(BRANCH, HEAD);
		expect(await close()).toEqual({ kind: "canceled" });
		expect(row().pullRequestState).toBe("CANCELED");
		expect(row().proposalStatus).toBe("REJECTED");
	});

	it("a stale tip deletes nothing and keeps CLOSE_REQUESTED; once the branch is gone a pull request that appeared is closed and the close completes", async () => {
		cancelled({ pullRequestAttempts: [ack()] });
		m.state.remote.set(BRANCH, FOREIGN);
		expect(await close()).toEqual({ kind: "pending" });
		expect(row().pullRequestState).toBe("CLOSE_REQUESTED");
		expect(m.state.remote.get(BRANCH)).toBe(FOREIGN);
		expect(recordsOf()[0]?.outcome).toBe("conflict");
		expect(failure()).toMatchObject({
			code: "REMOTE_REF_CONFLICT",
			phase: "close",
		});
		expect(row().pullRequestNextAttemptAt).toEqual(
			new Date(NOW.getTime() + 6 * HOUR),
		);
		expect(m.deleteBranch).not.toHaveBeenCalled();

		// A human removed the branch; a pull request appeared meanwhile.
		m.state.remote.delete(BRANCH);
		m.state.prs.push(pr());
		expect(await close()).toEqual({ kind: "closed" });
		expect(m.state.prs[0]?.state).toBe("CLOSED");
	});

	it("an unowned ref (push issued, never acknowledged) is never deleted, and its pull request is still closed", async () => {
		cancelled({
			pullRequestAttempts: [
				{
					attempt: 1,
					ref: BRANCH,
					sha: HEAD,
					pushIssuedAt: iso(-HOUR),
					confirmations: 0,
				},
			],
		});
		m.state.remote.set(BRANCH, HEAD);
		m.state.prs.push(pr());
		expect(await close()).toEqual({ kind: "pending" });
		expect(m.deleteBranch).not.toHaveBeenCalled();
		expect(m.state.prs[0]?.state).toBe("CLOSED");
		expect(row().pullRequestState).toBe("CLOSE_REQUESTED");
	});

	it("cancel racing a merge ends MERGED, with no deletion", async () => {
		const merged = pr({ state: "MERGED", mergedAt: NOW.toISOString() });
		m.state.prs.push(merged);
		cancelled({ pullRequestExternalId: merged.externalId });
		m.state.remote.set(BRANCH, HEAD);
		expect(await close()).toEqual({ kind: "merged" });
		expect(row().pullRequestState).toBe("MERGED");
		expect(row().mergeSyncRequestedAt).toEqual(NOW);
		expect(m.deleteBranch).not.toHaveBeenCalled();
		expect(m.state.remote.get(BRANCH)).toBe(HEAD);
	});

	it("closes after the requester lost access", async () => {
		const open = pr();
		m.state.prs.push(open);
		cancelled({ pullRequestExternalId: open.externalId });
		m.canCreate.mockResolvedValue(false);
		m.canRead.mockResolvedValue(false);
		m.state.sync = null;
		expect(await close()).toEqual({ kind: "closed" });
		expect(m.canCreate).not.toHaveBeenCalled();
	});

	it("with no credential records CLOSE_CREDENTIALS_UNAVAILABLE and keeps CLOSE_REQUESTED", async () => {
		cancelled();
		m.resolveFreshRepoToken.mockResolvedValue({
			token: null,
			authMethod: null,
			provider: null,
		});
		expect(await close()).toEqual({ kind: "pending" });
		expect(row().pullRequestState).toBe("CLOSE_REQUESTED");
		expect(failure()).toMatchObject({
			code: "CLOSE_CREDENTIALS_UNAVAILABLE",
			phase: "close",
			retryable: true,
		});
	});

	it("claims with the attempt the sweeper observed, so a stale observation does nothing", async () => {
		cancelled({ pullRequestAttempt: 4 });
		expect(await close({ expectedAttempt: 3 })).toEqual({
			kind: "pending",
		});
		expect(row().pullRequestAttempt).toBe(4);
		expect(remoteIo()).toBe(0);
	});
});

describe("settlement confirmations", () => {
	it("confirming A closes a late pull request on A and leaves B's markers alone", async () => {
		const refA = BRANCH;
		const refB = `${BRANCH}-2`;
		const adopted = pr({ sourceRef: refB });
		m.state.prs.push(adopted);
		seed({
			pullRequestState: "OPEN",
			pullRequestAttempt: 2,
			pullRequestExternalId: adopted.externalId,
			pullRequestRef: refB,
			pullRequestAttempts: [
				ack({
					ref: refA,
					createIssuedAt: iso(-30 * HOUR),
					settledAt: iso(-25 * HOUR),
					confirmations: 1,
					outcome: "settled",
				}),
				ack({ attempt: 2, ref: refB, createIssuedAt: iso(-HOUR) }),
			],
		});
		const late = pr({ sourceRef: refA });
		m.state.prs.push(late);
		await close();
		expect(
			m.state.prs.find((p) => p.externalId === late.externalId)?.state,
		).toBe("CLOSED");
		expect(
			m.state.prs.find((p) => p.externalId === adopted.externalId)?.state,
		).toBe("OPEN");
		const [a, b] = recordsOf();
		expect(a).toMatchObject({ confirmations: 2 });
		expect(a?.createIssuedAt).toBeUndefined();
		expect(b?.createIssuedAt).toBe(iso(-HOUR));
		expect(row().pullRequestState).toBe("OPEN");
	});

	it("a cancelled row becomes CLOSED when its confirmation closes a late pull request", async () => {
		seed({
			pullRequestState: "CANCELED",
			proposalStatus: "REJECTED",
			pullRequestAttempt: 3,
			pullRequestAttempts: [
				ack({
					settledAt: iso(-2 * HOUR),
					outcome: "settled",
					createIssuedAt: iso(-3 * HOUR),
				}),
			],
		});
		m.state.prs.push(pr());
		expect(await close()).toEqual({ kind: "closed" });
		expect(row().pullRequestState).toBe("CLOSED");
		expect(recordsOf()[0]?.confirmations).toBe(1);
		expect(recordsOf()[0]?.createIssuedAt).toBe(iso(-3 * HOUR));
		expect(actions()).toEqual([
			"project.instructions.pull_request_reconciled",
		]);
	});

	it("a merged pull request on a cancelled row makes it MERGED", async () => {
		seed({
			pullRequestState: "CANCELED",
			proposalStatus: "REJECTED",
			pullRequestAttempt: 3,
			pullRequestAttempts: [
				ack({ settledAt: iso(-2 * HOUR), outcome: "settled" }),
			],
		});
		m.state.prs.push(pr({ state: "MERGED", mergedAt: NOW.toISOString() }));
		expect(await close()).toEqual({ kind: "merged" });
		expect(row().pullRequestState).toBe("MERGED");
	});

	it("is not due before 1 h, and a failed lookup leaves the record due", async () => {
		seed({
			pullRequestState: "CANCELED",
			pullRequestAttempts: [
				ack({ settledAt: iso(-30 * 60_000), outcome: "settled" }),
			],
		});
		await close();
		expect(m.findOperation).not.toHaveBeenCalled();
		m.state.clock = new Date(NOW.getTime() + HOUR);
		m.findOperation.mockResolvedValue({
			kind: "INCONCLUSIVE",
			cause: "transient",
		});
		await close();
		expect(recordsOf()[0]?.confirmations).toBe(0);
	});
});

describe("openInstructionProposalPullRequest with retryCreate: retry settlement", () => {
	const blocked = (over: Record<string, unknown> = {}) =>
		seed({
			pullRequestState: "BLOCKED",
			pullRequestAttempt: 1,
			pullRequestHeadSha: HEAD,
			pullRequestRef: BRANCH,
			pullRequestFailure: {
				phase: "recover",
				code: "CREATE_OUTCOME_UNKNOWN",
				retryable: false,
				at: NOW.toISOString(),
				params: { recoveries: 9 },
			},
			pullRequestAttempts: [ack({ createIssuedAt: iso(-30 * HOUR) })],
			...over,
		});
	const retry = () => open({ retryCreate: { expectedAttempt: 1 } });

	it.each([
		["open", "OPEN", "open"],
		["closed", "CLOSED", "terminal"],
		["merged", "MERGED", "terminal"],
	] as const)(
		"adopts a pull request found %s and never creates",
		async (_label, state, kind) => {
			blocked();
			m.state.remote.set(BRANCH, HEAD);
			m.state.prs.push(pr({ state }));
			expect(await retry()).toEqual({ kind });
			expect(row().pullRequestState).toBe(state);
			expect(m.open).not.toHaveBeenCalled();
			expect(m.deleteBranch).not.toHaveBeenCalled();
		},
	);

	it("finding none deletes the old branch, appends one record and creates exactly one pull request on <branch>-<n>", async () => {
		blocked();
		m.state.remote.set(BRANCH, HEAD);
		expect(await retry()).toEqual({ kind: "open" });
		expect(m.state.remote.has(BRANCH)).toBe(false);
		expect(m.state.remote.get(`${BRANCH}-2`)).toBe(HEAD);
		expect(m.open).toHaveBeenCalledTimes(1);
		expect(m.open.mock.calls[0]?.[0]).toMatchObject({
			sourceRef: `${BRANCH}-2`,
		});
		const records = recordsOf();
		expect(records).toHaveLength(2);
		expect(records[0]).toMatchObject({
			ref: BRANCH,
			outcome: "settled",
			settledAt: NOW.toISOString(),
			createIssuedAt: iso(-30 * HOUR),
		});
		expect(records[1]).toMatchObject({
			attempt: 2,
			ref: `${BRANCH}-2`,
			outcome: "opened",
		});
		expect(row().pullRequestRef).toBe(`${BRANCH}-2`);
		expect(row().pullRequestState).toBe("OPEN");
	});

	it("a branch it cannot prove it owns blocks the retry with REMOTE_REF_CONFLICT, deleting nothing", async () => {
		blocked();
		m.state.remote.set(BRANCH, FOREIGN);
		expect(await retry()).toEqual({ kind: "blocked" });
		expect(row().pullRequestState).toBe("BLOCKED");
		expect(failure()).toMatchObject({
			code: "REMOTE_REF_CONFLICT",
			retryable: false,
		});
		expect(recordsOf()[0]?.createIssuedAt).toBeDefined();
		expect(m.deleteBranch).not.toHaveBeenCalled();
		expect(m.open).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// The boundary (spec §6)
// ---------------------------------------------------------------------------

describe("the activity boundary", () => {
	it("maps an unclassified error to UNEXPECTED with params { phase } and logs only the class name", async () => {
		m.getSync.mockRejectedValue(new Error("secret text"));
		expect(await open()).toEqual({ kind: "blocked" });
		expect(row().pullRequestState).toBe("BLOCKED");
		expect(failure()).toMatchObject({
			code: "UNEXPECTED",
			phase: "prepare",
			retryable: true,
			params: { phase: "prepare" },
		});
		const logged = JSON.stringify([
			m.log.warn.mock.calls,
			m.log.info.mock.calls,
			m.log.debug.mock.calls,
			m.log.error.mock.calls,
		]);
		expect(logged).toContain('"errorClass":"Error"');
		expect(logged).not.toContain("secret text");
		expect(JSON.stringify(row())).not.toContain("secret text");
	});

	it("records UNEXPECTED failure-only outside the open claim", async () => {
		seed({ pullRequestState: "CLOSE_REQUESTED", pullRequestAttempt: 2 });
		m.resolveFreshRepoToken.mockRejectedValue(new TypeError("secret text"));
		expect(await close()).toEqual({ kind: "failed" });
		expect(row().pullRequestState).toBe("CLOSE_REQUESTED");
		expect(failure()).toMatchObject({ code: "UNEXPECTED", phase: "close" });
		expect(JSON.stringify(m.log.warn.mock.calls)).toContain(
			'"errorClass":"TypeError"',
		);
	});

	it("rethrows a CancelledFailure and records nothing", async () => {
		m.getSync.mockRejectedValue(new m.CancelledFailure());
		await expect(open()).rejects.toBeInstanceOf(m.CancelledFailure);
		expect(row().pullRequestFailure).toBeNull();
		expect(row().pullRequestState).toBe("OPENING");
	});

	it("cancellation aborts the adapter's signal and the git calls' signal, and leaves the marker for recovery", async () => {
		const controller = new AbortController();
		m.state.activity = { cancellationSignal: controller.signal };
		m.open.mockImplementation(async (i: { signal: AbortSignal }) => {
			controller.abort(new m.CancelledFailure("activity cancelled"));
			expect(i.signal.aborted).toBe(true);
			throw i.signal.reason;
		});
		await expect(open()).rejects.toBeInstanceOf(m.CancelledFailure);
		const gitSignal = (
			m.cloneTreeless.mock.calls[0]?.[0] as { signal: AbortSignal }
		).signal;
		const pushSignal = (
			m.pushCreateOnly.mock.calls[0]?.[0] as { signal: AbortSignal }
		).signal;
		// The attempt's signal: Temporal's cancellation combined with the
		// attempt's deadline, so the cancellation reaches every call.
		expect(gitSignal.aborted).toBe(true);
		expect(gitSignal.reason).toBeInstanceOf(m.CancelledFailure);
		expect(pushSignal.aborted).toBe(true);
		expect(recordsOf()[0]?.createIssuedAt).toBeDefined();
		expect(row().pullRequestState).toBe("OPENING");
		expect(row().pullRequestFailure).toBeNull();
	});

	it("a git failure after cancellation is rethrown, not recorded as GIT_FAILED", async () => {
		const controller = new AbortController();
		m.state.activity = { cancellationSignal: controller.signal };
		m.cloneTreeless.mockImplementation(async () => {
			controller.abort(new m.CancelledFailure("activity cancelled"));
			throw new GitCommandError("cancelled", null, "", "clone");
		});
		await expect(open()).rejects.toBeInstanceOf(m.CancelledFailure);
		expect(row().pullRequestFailure).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// The cooperative deadline and heartbeat (spec §6)
// ---------------------------------------------------------------------------

describe("the cooperative deadline and heartbeat", () => {
	/** One remote call as the fake remote saw it, in ms after the test began. */
	type Call = {
		name: string;
		start: number;
		end?: number;
		aborted?: boolean;
	};
	let calls: Call[] = [];
	let t0 = 0;

	afterEach(() => {
		vi.useRealTimers();
	});

	/**
	 * Wraps a fake remote call so that it takes `ms` of fake time and honours
	 * its signal the way the real one does: an abort ends it at once, a
	 * provider call with the signal's reason (`rethrowIfCancelled`), a git
	 * call with a `cancelled` GitCommandError (the process group killed).
	 */
	function slow(
		mock: ReturnType<typeof vi.fn>,
		name: string,
		ms: number,
		git = false,
	): void {
		const impl = mock.getMockImplementation() as (i: unknown) => unknown;
		mock.mockImplementation(
			(i: { signal: AbortSignal }) =>
				new Promise((resolve, reject) => {
					const call: Call = { name, start: Date.now() - t0 };
					calls.push(call);
					const stop = () => {
						call.end = Date.now() - t0;
						call.aborted = true;
						reject(
							git
								? new GitCommandError(
										"cancelled",
										null,
										"",
										name,
									)
								: i.signal.reason,
						);
					};
					if (i.signal.aborted) {
						stop();
						return;
					}
					const timer = setTimeout(() => {
						i.signal.removeEventListener("abort", onAbort);
						call.end = Date.now() - t0;
						Promise.resolve()
							.then(() => impl(i))
							.then(resolve, reject);
					}, ms);
					const onAbort = () => {
						clearTimeout(timer);
						stop();
					};
					i.signal.addEventListener("abort", onAbort, { once: true });
				}),
		);
	}

	/** Per-call ceilings: provider 20 s, ls-remote 30 s, delete 30 s. */
	function slowRemote(): void {
		slow(m.get, "get", 20_000);
		slow(m.findOperation, "findOperation", 20_000);
		slow(m.close, "close", 20_000);
		slow(m.lsRemoteRef, "ls-remote", 30_000, true);
		slow(m.deleteBranch, "delete", 30_000, true);
	}

	/** Runs inside a Temporal activity with these timeouts (ms). */
	function inActivity(
		info: Partial<{
			startToCloseTimeoutMs: number;
			scheduleToCloseTimeoutMs: number;
			scheduledTimestampMs: number;
			currentAttemptScheduledTimestampMs: number;
			heartbeatTimeoutMs: number;
		}> = {},
	): void {
		m.state.activity = {
			cancellationSignal: new AbortController().signal,
			info: {
				startToCloseTimeoutMs: 0,
				scheduleToCloseTimeoutMs: 0,
				scheduledTimestampMs: Date.now(),
				currentAttemptScheduledTimestampMs: Date.now(),
				heartbeatTimeoutMs: 60_000,
				...info,
			},
		};
	}

	function cancelledWithOpenPullRequest(): void {
		const opened = pr();
		m.state.prs.push(opened);
		seed({
			pullRequestState: "CLOSE_REQUESTED",
			pullRequestAttempt: 2,
			pullRequestHeadSha: HEAD,
			pullRequestRef: BRANCH,
			pullRequestAttempts: [ack({ outcome: "opened" })],
			pullRequestExternalId: opened.externalId,
		});
		m.state.remote.set(BRANCH, HEAD);
	}

	/** Settles a promise into a value, so a rejection is never unhandled. */
	const settle = <T>(p: Promise<T>) =>
		p.then(
			(value) => ({ value, error: undefined as unknown }),
			(error: unknown) => ({ value: undefined, error }),
		);

	beforeEach(() => {
		vi.useFakeTimers({
			now: NOW,
			toFake: [
				"setTimeout",
				"clearTimeout",
				"setInterval",
				"clearInterval",
				"Date",
			],
		});
		t0 = Date.now();
		calls = [];
		slowRemote();
	});

	it("settlement runs past the old 60 s bound under its 10-minute attempt, heartbeating throughout, and ends CLOSED", async () => {
		cancelledWithOpenPullRequest();
		inActivity({ startToCloseTimeoutMs: 10 * 60_000 });
		const run = settle(close());
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		const { value, error } = await run;
		expect(error).toBeUndefined();
		expect(value).toEqual({ kind: "closed" });
		expect(row().pullRequestState).toBe("CLOSED");
		expect(m.state.remote.has(BRANCH)).toBe(false);
		const last = Math.max(...calls.map((c) => c.end ?? 0));
		expect(last).toBeGreaterThan(60_000);
		expect(calls.some((c) => c.aborted)).toBe(false);
		// Once at the start, then every 10 s until settlement ended.
		expect(m.heartbeat.mock.calls.length).toBeGreaterThanOrEqual(
			1 + Math.floor(last / 10_000),
		);
	});

	it.each([
		["its start-to-close", { startToCloseTimeoutMs: 75_000 }, {}],
		[
			"its schedule-to-close",
			{
				scheduledTimestampMs: NOW.getTime() - 30_000,
				scheduleToCloseTimeoutMs: 105_000,
			},
			{},
		],
		[
			"the sweeper's deadlineAt",
			{ startToCloseTimeoutMs: 10 * 60_000 },
			{ deadlineAt: iso(75_000) },
		],
	])(
		"stops 10 s before %s: the call in flight is aborted, none starts after, nothing is recorded",
		async (_bound, info, over) => {
			cancelledWithOpenPullRequest();
			inActivity(info);
			const run = settle(close(over));
			await vi.advanceTimersByTimeAsync(10 * 60_000);
			const { error } = await run;
			expect(error).toBeInstanceOf(ProposalDeadlineExceeded);
			// get 0-20 s, findOperation 20-40 s, close 40-60 s, then the
			// ls-remote started at 60 s is aborted at the 65 s deadline.
			expect(calls).toEqual([
				{ name: "get", start: 0, end: 20_000 },
				{ name: "findOperation", start: 20_000, end: 40_000 },
				{ name: "close", start: 40_000, end: 60_000 },
				{
					name: "ls-remote",
					start: 60_000,
					end: 65_000,
					aborted: true,
				},
			]);
			expect(m.deleteBranch).not.toHaveBeenCalled();
			expect(row().pullRequestFailure).toBeNull();
			expect(row().pullRequestState).toBe("CLOSE_REQUESTED");
			expect(recordsOf()[0]?.settledAt).toBeUndefined();
		},
	);

	it("measures start-to-close from the attempt's scheduled time, not from entry: a late start gets no extra time", async () => {
		cancelledWithOpenPullRequest();
		// Scheduled 20 s before the function ran: Temporal's start-to-close
		// fires 65 s after entry, so the attempt stops 55 s after entry.
		inActivity({
			startToCloseTimeoutMs: 85_000,
			currentAttemptScheduledTimestampMs: NOW.getTime() - 20_000,
		});
		const run = settle(close());
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		const { error } = await run;
		expect(error).toBeInstanceOf(ProposalDeadlineExceeded);
		expect(calls).toEqual([
			{ name: "get", start: 0, end: 20_000 },
			{ name: "findOperation", start: 20_000, end: 40_000 },
			{ name: "close", start: 40_000, end: 55_000, aborted: true },
		]);
		expect(row().pullRequestFailure).toBeNull();
	});

	it.each([
		["close", "CLOSE_REQUESTED", () => close()],
		["open", "QUEUED", () => open()],
	] as const)(
		"%s: a token lookup that returns no token after the deadline is the stop, never a deferred confirmation, and nothing is claimed",
		async (_name, state, act) => {
			// A confirmation is due, so due confirmations resolve a token
			// first; the lookup (no signal) answers "no token" at 70 s,
			// past the 65 s deadline.
			seed({
				pullRequestState: state,
				pullRequestAttempt: 2,
				pullRequestAttempts: [
					ack({
						settledAt: iso(-2 * HOUR),
						confirmations: 0,
						outcome: "settled",
					}),
				],
			});
			inActivity({ startToCloseTimeoutMs: 75_000 });
			m.resolveFreshRepoToken.mockImplementation(
				() =>
					new Promise((resolve) =>
						setTimeout(
							() =>
								resolve({
									token: null,
									authMethod: null,
									provider: null,
								}),
							70_000,
						),
					),
			);
			const run = settle<unknown>(act());
			await vi.advanceTimersByTimeAsync(10 * 60_000);
			const { value, error } = await run;
			expect(value).toBeUndefined();
			expect(error).toBeInstanceOf(ProposalDeadlineExceeded);
			expect(m.state.transitions).toEqual([]);
			expect(vi.mocked(claimPullRequestOpen)).not.toHaveBeenCalled();
			expect(remoteIo()).toBe(0);
			expect(row().pullRequestFailure).toBeNull();
			expect(JSON.stringify(m.log.info.mock.calls)).not.toContain(
				"confirmation_deferred",
			);
		},
	);

	it.each([
		["close", "CLOSE_REQUESTED", () => close()],
		["open", "QUEUED", () => open()],
		["recover", "OPENING", () => recover()],
	] as const)(
		"%s: an initial row read that crosses the deadline with no confirmation due is followed by no claim",
		async (_name, state, act) => {
			seed({ pullRequestState: state, pullRequestAttempt: 2 });
			inActivity({ startToCloseTimeoutMs: 75_000 });
			const read = vi
				.mocked(getProposalOperation)
				.getMockImplementation();
			vi.mocked(getProposalOperation).mockImplementationOnce(
				(i) =>
					new Promise((resolve) =>
						setTimeout(() => resolve(read?.(i) as never), 70_000),
					),
			);
			const run = settle<unknown>(act());
			await vi.advanceTimersByTimeAsync(10 * 60_000);
			const { value, error } = await run;
			expect(value).toBeUndefined();
			expect(error).toBeInstanceOf(ProposalDeadlineExceeded);
			expect(vi.mocked(claimPullRequestOpen)).not.toHaveBeenCalled();
			expect(vi.mocked(getProjectRepoIntegration)).not.toHaveBeenCalled();
			expect(m.state.transitions).toEqual([]);
			expect(row().pullRequestAttempt).toBe(2);
			expect(row().pullRequestFailure).toBeNull();
		},
	);

	it("a confirmation lookup that answers inconclusive after the deadline is the stop, never logged as a deferred confirmation", async () => {
		seed({
			pullRequestState: "CLOSE_REQUESTED",
			pullRequestAttempt: 2,
			pullRequestAttempts: [
				ack({
					settledAt: iso(-2 * HOUR),
					confirmations: 0,
					outcome: "settled",
				}),
			],
		});
		inActivity({ startToCloseTimeoutMs: 75_000 });
		// An answer that takes no notice of the signal, arriving at 70 s.
		m.findOperation.mockImplementation(
			() =>
				new Promise((resolve) =>
					setTimeout(
						() =>
							resolve({ kind: "INCONCLUSIVE", cause: "unknown" }),
						70_000,
					),
				),
		);
		const run = settle(close());
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		const { error } = await run;
		expect(error).toBeInstanceOf(ProposalDeadlineExceeded);
		expect(JSON.stringify(m.log.info.mock.calls)).not.toContain(
			"confirmation_deferred",
		);
		expect(m.state.transitions).toEqual([]);
		expect(row().pullRequestFailure).toBeNull();
	});

	it("a confirmation whose write lands after the deadline is followed by no claim", async () => {
		seed({
			pullRequestState: "CLOSE_REQUESTED",
			pullRequestAttempt: 2,
			pullRequestAttempts: [
				ack({
					settledAt: iso(-2 * HOUR),
					confirmations: 0,
					outcome: "settled",
				}),
			],
		});
		inActivity({ startToCloseTimeoutMs: 75_000 });
		const write = vi.mocked(applyPullRequestChange).getMockImplementation();
		vi.mocked(applyPullRequestChange).mockImplementationOnce(
			(i) =>
				new Promise((resolve) =>
					setTimeout(() => resolve(write?.(i) as never), 70_000),
				),
		);
		const run = settle(close());
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		const { error } = await run;
		expect(error).toBeInstanceOf(ProposalDeadlineExceeded);
		expect(recordsOf()[0]?.confirmations).toBe(1);
		expect(m.state.transitions.map((t) => t.event)).not.toContain("claim");
		expect(row().pullRequestFailure).toBeNull();
	});

	it("token resolution runs under the attempt's signal and is itself aborted at the 65 s deadline", async () => {
		cancelledWithOpenPullRequest();
		inActivity({ startToCloseTimeoutMs: 75_000 });
		slow(m.resolveFreshRepoToken, "resolve", 70_000);
		const run = settle(close());
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		const { error } = await run;
		expect(error).toBeInstanceOf(ProposalDeadlineExceeded);
		expect(m.resolveFreshRepoToken).toHaveBeenCalledWith(
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(calls).toEqual([
			{ name: "resolve", start: 0, end: 65_000, aborted: true },
		]);
		expect(remoteIo()).toBe(0);
		expect(row().pullRequestFailure).toBeNull();
	});

	/** The first pass's first call, `get`, answers that the token is dead at 20 s. */
	function firstPassUnauthenticated(): void {
		m.get.mockImplementation(async () => {
			throw new InstructionPullRequestError({
				code: "AUTHENTICATION_FAILED",
				retryable: true,
				cause: "auth",
			});
		});
		slow(m.get, "get", 20_000);
	}

	it("the re-exchange runs under the attempt's signal and is itself aborted at the deadline: no second pass, no reauth marking", async () => {
		cancelledWithOpenPullRequest();
		inActivity({ startToCloseTimeoutMs: 75_000 });
		firstPassUnauthenticated();
		slow(m.forceReExchangeRepoCredentials, "re-exchange", 70_000);
		const run = settle(close());
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		const { error } = await run;
		expect(error).toBeInstanceOf(ProposalDeadlineExceeded);
		expect(m.forceReExchangeRepoCredentials).toHaveBeenCalledWith(
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(calls).toEqual([
			{ name: "get", start: 0, end: 20_000 },
			{ name: "re-exchange", start: 20_000, end: 65_000, aborted: true },
		]);
		expect(m.resolveFreshRepoToken).toHaveBeenCalledTimes(1);
		expect(m.markRepoReauthRequired).not.toHaveBeenCalled();
		expect(row().pullRequestFailure).toBeNull();
	});

	it("reauth marking runs under the attempt's signal and is itself aborted at the deadline: nothing is recorded", async () => {
		cancelledWithOpenPullRequest();
		inActivity({ startToCloseTimeoutMs: 75_000 });
		firstPassUnauthenticated();
		slow(m.markRepoReauthRequired, "mark-reauth", 70_000);
		const run = settle(close());
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		const { error } = await run;
		expect(error).toBeInstanceOf(ProposalDeadlineExceeded);
		expect(m.markRepoReauthRequired).toHaveBeenCalledWith(
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(calls).toEqual([
			{ name: "get", start: 0, end: 20_000 },
			{ name: "mark-reauth", start: 20_000, end: 65_000, aborted: true },
		]);
		expect(row().pullRequestFailure).toBeNull();
	});

	it("a cheap credential lookup (no exchange) with 20 s left succeeds", async () => {
		cancelledWithOpenPullRequest();
		// The attempt must stop 20 s from now: under the 30 s an exchange
		// needs, but a still-fresh token or a PAT sends nothing, so the
		// lookup succeeds and the close goes on to its first provider call
		// (which the deadline then ends, as any call would).
		inActivity({ startToCloseTimeoutMs: 10 * 60_000 });
		const run = settle(close({ deadlineAt: iso(30_000) }));
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		await run;
		expect(m.resolveFreshRepoToken).toHaveBeenCalledTimes(1);
		expect(m.resolveFreshRepoToken).toHaveBeenCalledWith(
			expect.objectContaining({ beforeExchange: expect.any(Function) }),
		);
		expect(calls[0]).toEqual({
			name: "get",
			start: 0,
			end: 20_000,
			aborted: true,
		});
	});

	/**
	 * A token helper that spends `ms` on its row read, admission and lock
	 * wait, then consults the caller's gate immediately before the exchange,
	 * as the real ones do under the provider lock.
	 */
	function exchangingAfter<R>(
		mock: ReturnType<typeof vi.fn>,
		name: string,
		ms: number,
		result: R,
	): void {
		mock.mockImplementation(
			(i: { beforeExchange?: () => void }) =>
				new Promise((resolve, reject) => {
					setTimeout(() => {
						try {
							i.beforeExchange?.();
						} catch (error) {
							reject(error);
							return;
						}
						calls.push({ name, start: Date.now() - t0 });
						resolve(result);
					}, ms);
				}),
		);
	}

	it.each([
		[15_000, false],
		[5_000, true],
	])(
		"an exchange starts only with 30 s left after the row read and lock wait (%i ms spent: exchanged %s)",
		async (spent, exchanged) => {
			cancelledWithOpenPullRequest();
			// The attempt must stop 40 s from now.
			inActivity({ startToCloseTimeoutMs: 10 * 60_000 });
			exchangingAfter(m.resolveFreshRepoToken, "exchange", spent, {
				token: TOKEN,
				authMethod: "OAUTH",
				provider: "GITHUB",
			});
			const run = settle(close({ deadlineAt: iso(50_000) }));
			await vi.advanceTimersByTimeAsync(10 * 60_000);
			const { error } = await run;
			if (exchanged) {
				// The exchange starts, and the close goes on with its token.
				expect(calls.slice(0, 2)).toEqual([
					{ name: "exchange", start: spent },
					{ name: "get", start: spent, end: spent + 20_000 },
				]);
			} else {
				expect(error).toBeInstanceOf(ProposalDeadlineExceeded);
				expect(calls).toEqual([]);
				expect(remoteIo()).toBe(0);
				expect(row().pullRequestFailure).toBeNull();
			}
		},
	);

	it("a re-exchange starts only with 30 s left after its own row read and lock wait: no second pass, no reauth marking", async () => {
		cancelledWithOpenPullRequest();
		// The attempt must stop 50 s from now; the dead token is found at
		// 20 s and the re-exchange's lock wait takes 5 s more.
		inActivity({ startToCloseTimeoutMs: 10 * 60_000 });
		firstPassUnauthenticated();
		exchangingAfter(
			m.forceReExchangeRepoCredentials,
			"re-exchange",
			5_000,
			{
				refreshed: true,
			},
		);
		const run = settle(close({ deadlineAt: iso(60_000) }));
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		const { error } = await run;
		expect(error).toBeInstanceOf(ProposalDeadlineExceeded);
		expect(calls).toEqual([{ name: "get", start: 0, end: 20_000 }]);
		expect(m.resolveFreshRepoToken).toHaveBeenCalledTimes(1);
		expect(m.markRepoReauthRequired).not.toHaveBeenCalled();
		expect(row().pullRequestFailure).toBeNull();
	});

	it.each([
		[15_000, false],
		[25_000, true],
	])(
		"reauth marking starts only with its write and notification bounds (20 s) left (%i ms left: marked %s)",
		async (left, marked) => {
			cancelledWithOpenPullRequest();
			inActivity({ startToCloseTimeoutMs: 10 * 60_000 });
			firstPassUnauthenticated();
			// The dead token is found at 20 s; the attempt must stop `left`
			// after that, against the 10 s write plus 10 s notification.
			const run = settle(
				close({ deadlineAt: iso(20_000 + left + 10_000) }),
			);
			await vi.advanceTimersByTimeAsync(10 * 60_000);
			const { error } = await run;
			expect(m.forceReExchangeRepoCredentials).toHaveBeenCalledTimes(1);
			if (marked) {
				expect(m.markRepoReauthRequired).toHaveBeenCalledTimes(1);
				expect(error).not.toBeInstanceOf(ProposalDeadlineExceeded);
			} else {
				expect(m.markRepoReauthRequired).not.toHaveBeenCalled();
				expect(error).toBeInstanceOf(ProposalDeadlineExceeded);
				expect(row().pullRequestFailure).toBeNull();
			}
		},
	);

	it("checks before a token refresh (itself an effect): a database step outlasting the deadline is followed by no refresh and no call", async () => {
		cancelledWithOpenPullRequest();
		inActivity({ startToCloseTimeoutMs: 75_000 });
		const claim = vi.mocked(transitionPullRequest).getMockImplementation();
		vi.mocked(transitionPullRequest).mockImplementationOnce(
			(i) =>
				new Promise((resolve) =>
					setTimeout(() => resolve(claim?.(i) as never), 70_000),
				),
		);
		const run = settle(close());
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		const { error } = await run;
		expect(error).toBeInstanceOf(ProposalDeadlineExceeded);
		expect(m.resolveFreshRepoToken).not.toHaveBeenCalled();
		expect(calls).toEqual([]);
		expect(row().pullRequestFailure).toBeNull();
	});

	it("a retry begins only after every call of the stopped attempt ended, and completes the settlement", async () => {
		cancelledWithOpenPullRequest();
		inActivity({ startToCloseTimeoutMs: 75_000 });
		const first = await (async () => {
			const run = settle(close());
			await vi.advanceTimersByTimeAsync(75_000);
			return run;
		})();
		expect(first.error).toBeInstanceOf(ProposalDeadlineExceeded);
		const firstCalls = calls.length;
		const firstEnded = Math.max(
			...calls.map((c) => c.end ?? Number.POSITIVE_INFINITY),
		);
		expect(firstEnded).toBe(65_000);

		// Temporal's retry: 10 s after the stopped attempt failed, which is
		// also no earlier than its own start-to-close would have fired.
		inActivity({ startToCloseTimeoutMs: 10 * 60_000 });
		const run = settle(close());
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		const retry = await run;
		expect(retry.value).toEqual({ kind: "closed" });
		expect(row().pullRequestState).toBe("CLOSED");
		expect(m.state.remote.has(BRANCH)).toBe(false);

		const retryCalls = calls.slice(firstCalls);
		expect(retryCalls.length).toBeGreaterThan(0);
		for (const call of retryCalls) {
			expect(call.start).toBeGreaterThanOrEqual(75_000);
		}
		// Never two remote calls at once, across both attempts.
		for (const [i, call] of calls.entries()) {
			const previous = calls[i - 1];
			if (previous) {
				expect(call.start).toBeGreaterThanOrEqual(
					previous.end ?? Number.POSITIVE_INFINITY,
				);
			}
		}
	});

	it.each([
		["close", () => close({ deadlineAt: iso(-1_000) })],
		["recover", () => recover({ deadlineAt: iso(-1_000) })],
		[
			"reconcile",
			() =>
				reconcileInstructionProposalPullRequest({
					...ids,
					deadlineAt: iso(-1_000),
				}),
		],
		[
			"the merge-sync dispatch",
			() =>
				dispatchInstructionProposalMergeSync({
					...ids,
					deadlineAt: iso(-1_000),
				}),
		],
		[
			"the restart dispatch",
			() =>
				dispatchInstructionProposalPullRequest({
					...ids,
					attempt: 0,
					deadlineAt: iso(-1_000),
				}),
		],
	])("%s issues nothing once its deadline has passed", async (_name, act) => {
		cancelledWithOpenPullRequest();
		seed({
			pullRequestState: "MERGED",
			mergeSyncRequestedAt: new Date(NOW.getTime() - 60_000),
		});
		inActivity({ startToCloseTimeoutMs: 60_000 });
		const { error } = await settle<unknown>(act());
		expect(error).toBeInstanceOf(ProposalDeadlineExceeded);
		expect(remoteIo()).toBe(0);
		expect(m.state.transitions).toEqual([]);
		expect(m.describe).not.toHaveBeenCalled();
		expect(m.start).not.toHaveBeenCalled();
		expect(m.startSync).not.toHaveBeenCalled();
		expect(m.defer).not.toHaveBeenCalled();
		expect(row().pullRequestFailure).toBeNull();
	});

	it("the restart dispatch's Temporal calls run under the attempt's signal: a start in flight at the deadline is cancelled and nothing is deferred", async () => {
		inActivity({
			startToCloseTimeoutMs: 60_000,
			heartbeatTimeoutMs: 30_000,
		});
		m.start.mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					const signal = m.state.clientSignals.at(-1) as AbortSignal;
					signal.addEventListener("abort", () =>
						reject(
							Object.assign(new Error("call cancelled"), {
								name: "ServiceError",
							}),
						),
					);
				}),
		);
		const run = settle(
			dispatchInstructionProposalPullRequest({ ...ids, attempt: 2 }),
		);
		await vi.advanceTimersByTimeAsync(60_000);
		const { error } = await run;
		expect(error).toBeInstanceOf(ProposalDeadlineExceeded);
		expect(m.state.clientSignals).toHaveLength(2); // describe, start
		expect(m.state.clientSignals.every((signal) => signal.aborted)).toBe(
			true,
		);
		expect(m.defer).not.toHaveBeenCalled();
		// Declared a 30 s heartbeat: once at the start, then every 10 s.
		expect(m.heartbeat.mock.calls.length).toBeGreaterThanOrEqual(5);
	});

	describe("a failed branch release's deferral never swallows a stop", () => {
		const revoked = {
			phase: "create",
			code: "PERMISSION_REVOKED",
			retryable: false,
			at: NOW.toISOString(),
		};
		const deferFailures = () =>
			m.log.warn.mock.calls.filter(
				([fields]) =>
					(fields as { event?: string }).event ===
					"instruction_proposal.branch_release_defer_failed",
			);

		beforeEach(() => {
			seed({
				pullRequestState: "BLOCKED",
				pullRequestAttempt: 1,
				pullRequestHeadSha: HEAD,
				pullRequestRef: BRANCH,
				pullRequestFailure: revoked,
				pullRequestAttempts: [ack()],
			});
			m.state.remote.set(BRANCH, HEAD);
			// The release fails at once with a typed failure, so Close defers.
			m.findOperation.mockResolvedValue({
				kind: "INCONCLUSIVE",
				cause: "transient",
			});
			inActivity({ startToCloseTimeoutMs: 10 * 60_000 });
		});

		it("a cancellation thrown by the deferral write propagates", async () => {
			m.defer.mockRejectedValue(
				new m.CancelledFailure("activity cancelled"),
			);
			const run = settle(close({ expectedAttempt: 1 }));
			await vi.advanceTimersByTimeAsync(60_000);
			const { error } = await run;
			expect(error).toBeInstanceOf(m.CancelledFailure);
			expect(deferFailures()).toEqual([]);
			expect(row().pullRequestFailure).toEqual(revoked);
		});

		it("a deadline that fires during the deferral propagates, and nothing is logged as a deferral failure", async () => {
			// The attempt must stop 20 s in; the deferral write takes 60 s and
			// succeeds.
			m.defer.mockImplementation(
				() =>
					new Promise((resolve) => {
						setTimeout(() => resolve(true), 60_000);
					}),
			);
			const run = settle(
				close({ expectedAttempt: 1, deadlineAt: iso(30_000) }),
			);
			await vi.advanceTimersByTimeAsync(2 * 60_000);
			const { error } = await run;
			expect(error).toBeInstanceOf(ProposalDeadlineExceeded);
			expect(m.defer).toHaveBeenCalledTimes(1);
			expect(deferFailures()).toEqual([]);
			expect(row().pullRequestFailure).toEqual(revoked);
		});

		it("a deadline already passed when the release fails writes no deferral", async () => {
			m.findOperation.mockImplementation(
				() =>
					new Promise((resolve) => {
						setTimeout(
							() =>
								resolve({
									kind: "INCONCLUSIVE",
									cause: "transient",
								}),
							25_000,
						);
					}),
			);
			const run = settle(
				close({ expectedAttempt: 1, deadlineAt: iso(30_000) }),
			);
			await vi.advanceTimersByTimeAsync(2 * 60_000);
			const { error } = await run;
			expect(error).toBeInstanceOf(ProposalDeadlineExceeded);
			expect(m.defer).not.toHaveBeenCalled();
			expect(row().pullRequestFailure).toEqual(revoked);
		});
	});
});

// ---------------------------------------------------------------------------
// Reconcile, merge sync, selection and dispatch (spec §9, §9.1)
// ---------------------------------------------------------------------------

describe("reconcileInstructionProposalPullRequest", () => {
	const opened = (state: Pr["state"], over: Partial<Pr> = {}) => {
		const found = pr({ state, ...over });
		m.state.prs.push(found);
		seed({
			pullRequestState: "OPEN",
			pullRequestAttempt: 1,
			pullRequestExternalId: found.externalId,
			pullRequestUrl: found.url,
			pullRequestRef: BRANCH,
			pullRequestAttempts: [ack({ outcome: "opened" })],
		});
		return found;
	};
	const reconcile = (over: Record<string, unknown> = {}) =>
		reconcileInstructionProposalPullRequest({ ...ids, ...over });

	it("stamps pullRequestLastCheckedAt on a pull request still open", async () => {
		opened("OPEN");
		expect(await reconcile()).toEqual({ kind: "open" });
		expect(row().pullRequestState).toBe("OPEN");
		expect(row().pullRequestLastCheckedAt).toEqual(NOW);
		expect(m.state.audits).toEqual([]);
	});

	it("moves a merged pull request to MERGED and requests the merge sync", async () => {
		opened("MERGED", { mergedAt: NOW.toISOString(), mergeCommitSha: HEAD });
		expect(await reconcile()).toEqual({ kind: "merged" });
		expect(row().pullRequestState).toBe("MERGED");
		expect(row().proposalStatus).toBe("MERGED");
		expect(row().mergeSyncRequestedAt).toEqual(NOW);
		expect(row().pullRequestObservation).toMatchObject({
			mergeCommitSha: HEAD,
			targetMismatch: false,
		});
		expect(actions()).toEqual([
			"project.instructions.pull_request_reconciled",
		]);
		expect(m.state.audits[0]?.metadata).toMatchObject({
			outcome: "merged",
		});
	});

	it("moves a closed pull request to CLOSED", async () => {
		opened("CLOSED", { closedAt: NOW.toISOString() });
		expect(await reconcile()).toEqual({ kind: "closed" });
		expect(row().pullRequestState).toBe("CLOSED");
		expect(row().mergeSyncRequestedAt).toBeNull();
	});

	it("a merge into another target sets targetMismatch and requests no merge sync", async () => {
		opened("MERGED", { targetRef: "release", mergedAt: NOW.toISOString() });
		expect(await reconcile()).toEqual({ kind: "merged" });
		expect(row().pullRequestObservation).toMatchObject({
			targetMismatch: true,
		});
		expect(row().mergeSyncRequestedAt).toBeNull();
	});

	it("keeps the state on an error and backs the row off", async () => {
		opened("OPEN");
		m.get.mockRejectedValue(
			new InstructionPullRequestError({
				code: "PROVIDER_TEMPORARY",
				retryable: true,
				cause: "transient",
			}),
		);
		expect(await reconcile()).toEqual({ kind: "failed" });
		expect(row().pullRequestState).toBe("OPEN");
		expect(failure()).toMatchObject({
			code: "PROVIDER_TEMPORARY",
			phase: "reconcile",
		});
		expect(row().pullRequestNextAttemptAt).toEqual(
			new Date(NOW.getTime() + 15 * 60_000),
		);
	});

	it("leaves a row that moved since selection alone", async () => {
		opened("MERGED");
		expect(await reconcile({ expectedAttempt: 0 })).toEqual({
			kind: "unchanged",
		});
		expect(m.get).not.toHaveBeenCalled();
	});
});

describe("dispatchInstructionProposalMergeSync (spec §9.1)", () => {
	const REQUESTED = new Date(NOW.getTime() - 10 * 60_000);
	const TUPLE = { syncId: "sync_1", generation: 3 };
	const merged = (over: Record<string, unknown> = {}) =>
		seed({
			pullRequestState: "MERGED",
			proposalStatus: "MERGED",
			pullRequestAttempt: 1,
			pullRequestExternalId: "100",
			mergeSyncRequestedAt: REQUESTED,
			...over,
		});
	const dispatched = (over: Record<string, unknown> = {}) =>
		merged({
			mergeSyncDispatchedAt: REQUESTED,
			mergeSyncExpected: TUPLE,
			mergeSyncRunId: "run_1",
			...over,
		});
	const receipt = (over: Record<string, unknown> = {}) => {
		const r = {
			id: "sync_1:run_1",
			projectId: "proj_1",
			syncId: "sync_1",
			generation: 3,
			trigger: "PULL_REQUEST_MERGED",
			startedAt: new Date(REQUESTED.getTime() + 60_000),
			status: "SUCCEEDED" as string | null,
			error: null as string | null,
			...over,
		};
		m.state.receipts.push(r);
		return r;
	};
	const dispatch = () => dispatchInstructionProposalMergeSync(ids);

	it("dispatches a first request with the current tuple as expected and records the Temporal run id", async () => {
		merged();
		expect(await dispatch()).toEqual({ kind: "dispatched" });
		expect(m.startSync).toHaveBeenCalledWith({
			projectId: "proj_1",
			organizationId: "org_1",
			trigger: "PULL_REQUEST_MERGED",
			expected: TUPLE,
		});
		expect(row()).toMatchObject({
			mergeSyncExpected: TUPLE,
			mergeSyncRunId: "run_new",
			mergeSyncDispatchedAt: NOW,
		});
		// 10 minutes after the request: the second step of 5, 15, 60.
		expect(row().pullRequestNextAttemptAt).toEqual(
			new Date(NOW.getTime() + 15 * 60_000),
		);
	});

	it("acknowledges a consuming receipt found by run id, with one audit row", async () => {
		dispatched();
		receipt();
		expect(await dispatch()).toEqual({ kind: "acknowledged" });
		expect(row()).toMatchObject({
			pullRequestState: "MERGED",
			mergeSyncRequestedAt: null,
			mergeSyncDispatchedAt: null,
			mergeSyncRunId: "run_1",
		});
		expect(actions()).toEqual([
			"project.instructions.pull_request_merge_sync_requested",
		]);
		expect(m.state.audits[0]?.metadata).toEqual({
			operationId: OP,
			syncRunKey: "sync_1:run_1",
		});
		expect(m.startSync).not.toHaveBeenCalled();
	});

	it("finds the receipt by Temporal run id even when begin keyed it by another sync row, and retains it", async () => {
		dispatched();
		receipt({ id: "sync_9:run_1", syncId: "sync_9" });
		expect(await dispatch()).toEqual({ kind: "dispatched" });
		// Found by run id, so no describe was needed to decide it.
		expect(m.describe).not.toHaveBeenCalled();
		expect(m.startSync).toHaveBeenCalledTimes(1);
	});

	it("waits on a run in flight", async () => {
		dispatched();
		receipt({ status: null });
		expect(await dispatch()).toEqual({ kind: "waiting" });
		expect(m.startSync).not.toHaveBeenCalled();
	});

	it.each([
		["a POLL receipt", { trigger: "POLL" }],
		[
			"an older already_running run",
			{ startedAt: new Date(REQUESTED.getTime() - 60_000) },
		],
		["a successful receipt for another generation", { generation: 2 }],
		["a paused (SKIPPED) run", { status: "SKIPPED" }],
		[
			"a run that failed CLONE_FAILED",
			{ status: "FAILED", error: "CLONE_FAILED" },
		],
	])("retains %s and re-dispatches", async (_label, over) => {
		dispatched();
		receipt(over);
		expect(await dispatch()).toEqual({ kind: "dispatched" });
		expect(m.startSync).toHaveBeenCalledTimes(1);
		expect(row().mergeSyncRequestedAt).toEqual(REQUESTED);
	});

	it("adopts a run after a dispatch crash, never starting a second", async () => {
		dispatched({ mergeSyncRunId: null });
		receipt({ id: "sync_1:run_lost", status: null });
		expect(await dispatch()).toEqual({ kind: "waiting" });
		expect(m.startSync).not.toHaveBeenCalled();
	});

	it("treats a run id with no receipt as in flight only while Temporal says it is running", async () => {
		dispatched();
		m.describe.mockResolvedValueOnce({ status: { name: "RUNNING" } });
		expect(await dispatch()).toEqual({ kind: "waiting" });
		expect(m.describe).toHaveBeenCalledWith(
			"project-instruction-repository-sync-proj_1",
			"run_1",
		);
		m.describe.mockResolvedValueOnce({ status: { name: "COMPLETED" } });
		expect(await dispatch()).toEqual({ kind: "dispatched" });
	});

	it("does not clear when mergeSyncExpected changed under it", async () => {
		dispatched();
		receipt();
		// Another dispatcher re-dispatched between this one's read and its clear.
		m.getSync.mockImplementationOnce(async () => {
			rowOf().mergeSyncExpected = { syncId: "sync_1", generation: 4 };
			return clone(m.state.sync);
		});
		expect(await dispatch()).toEqual({ kind: "moved" });
		expect(row().mergeSyncRequestedAt).toEqual(REQUESTED);
		expect(m.state.audits).toEqual([]);
	});

	it.each([
		["the target ref", { ref: "release" }],
		["the root path", { rootPath: "docs" }],
		["the integration", { repositoryIntegrationId: "int_2" }],
	])(
		"gives up with CONFIGURATION_CHANGED when %s changed, leaving MERGED",
		async (_label, change) => {
			dispatched();
			m.state.sync = { ...m.state.sync, ...change };
			expect(await dispatch()).toEqual({ kind: "gave_up" });
			expect(row().pullRequestState).toBe("MERGED");
			expect(row().mergeSyncRequestedAt).toBeNull();
			expect(failure()).toMatchObject({
				code: "CONFIGURATION_CHANGED",
				phase: "merge_sync",
				retryable: false,
			});
		},
	);

	it("gives up when the project left repository mode", async () => {
		dispatched();
		m.settings.mockResolvedValue({
			ignoreGlobs: null,
			sourceOfTruth: "UPLOAD",
		});
		expect(await dispatch()).toEqual({ kind: "gave_up" });
	});

	it("gives up with MERGE_SYNC_FAILED 24 h after the request", async () => {
		dispatched({
			mergeSyncRequestedAt: new Date(NOW.getTime() - 24 * HOUR),
		});
		expect(await dispatch()).toEqual({ kind: "gave_up" });
		expect(failure()).toMatchObject({
			code: "MERGE_SYNC_FAILED",
			retryable: false,
		});
		expect(row().pullRequestState).toBe("MERGED");
		expect(m.startSync).not.toHaveBeenCalled();
	});

	it("records SYNC_START_FAILED on a starter error and keeps the dispatch mark for adoption", async () => {
		merged();
		m.startSync.mockRejectedValue(new Error("unavailable"));
		expect(await dispatch()).toEqual({ kind: "failed" });
		expect(failure()).toMatchObject({
			code: "SYNC_START_FAILED",
			retryable: true,
		});
		expect(row().mergeSyncDispatchedAt).toEqual(NOW);
		expect(row().mergeSyncExpected).toEqual(TUPLE);
	});

	it.each([
		[1, 5],
		[10, 15],
		[30, 60],
		[300, 60],
	])(
		"backs off after a dispatch %i minutes after the request by %i minutes",
		async (since, wait) => {
			merged({
				mergeSyncRequestedAt: new Date(NOW.getTime() - since * 60_000),
			});
			await dispatch();
			expect(row().pullRequestNextAttemptAt).toEqual(
				new Date(NOW.getTime() + wait * 60_000),
			);
		},
	);
});

describe("selectDueInstructionProposalOperations", () => {
	it("adds whether each operation workflow is running; only a clear not-found is not running", async () => {
		const item = (operationId: string) => ({
			snapshotId: `snap_${operationId}`,
			projectId: "proj_1",
			organizationId: "org_1",
			operationId,
			attempt: 2,
			integrationId: "int_1",
		});
		m.selectDue.mockResolvedValue({
			close: [item("a")],
			recover: [{ ...item("b"), recoverClause: 2 }],
			mergeSync: [],
			observe: [item("c")],
			restart: [],
		});
		m.describe.mockImplementation(async (workflowId: string) => {
			if (workflowId.endsWith("-a")) {
				return { status: { name: "RUNNING" } };
			}
			if (workflowId.endsWith("-b")) {
				throw new Error("unavailable");
			}
			throw Object.assign(new Error("gone"), {
				name: "WorkflowNotFoundError",
			});
		});
		const due = await selectDueInstructionProposalOperations({
			close: 10,
			recover: 10,
			mergeSync: 10,
			observe: 20,
			restart: 10,
		});
		expect(due.close[0]).toMatchObject({ operationId: "a", running: true });
		expect(due.recover[0]).toMatchObject({
			operationId: "b",
			recoverClause: 2,
			running: true,
		});
		expect(due.observe[0]).toMatchObject({
			operationId: "c",
			running: false,
		});
		expect(m.describe).toHaveBeenCalledWith(
			"project-instruction-proposal-pull-request-a",
			undefined,
		);
	});
});

describe("dispatchInstructionProposalPullRequest", () => {
	const input = { ...ids, attempt: 2 };

	it("starts the operation workflow on the instructions queue with no memo", async () => {
		expect(await dispatchInstructionProposalPullRequest(input)).toEqual({
			kind: "started",
		});
		expect(m.start).toHaveBeenCalledWith(
			"projectInstructionProposalPullRequestWorkflow",
			{
				taskQueue: "project-instructions",
				workflowId: `project-instruction-proposal-pull-request-${OP}`,
				workflowIdConflictPolicy: "FAIL",
				args: [ids],
			},
		);
		expect(m.defer).not.toHaveBeenCalled();
	});

	it("defers a row whose workflow is running by 30 minutes at the attempt read at selection", async () => {
		m.describe.mockResolvedValue({ status: { name: "RUNNING" } });
		expect(await dispatchInstructionProposalPullRequest(input)).toEqual({
			kind: "deferred",
		});
		expect(m.defer).toHaveBeenCalledWith({
			snapshotId: "snap_1",
			organizationId: "org_1",
			attempt: 2,
			minutes: 30,
		});
		expect(m.start).not.toHaveBeenCalled();
	});

	it("answers already_running when a start loses the race, and defers", async () => {
		const { WorkflowExecutionAlreadyStartedError } = await import(
			"@temporalio/client"
		);
		m.start.mockRejectedValue(
			new WorkflowExecutionAlreadyStartedError(
				"started",
				`project-instruction-proposal-pull-request-${OP}`,
				"projectInstructionProposalPullRequestWorkflow",
			),
		);
		expect(await dispatchInstructionProposalPullRequest(input)).toEqual({
			kind: "already_running",
		});
		expect(m.defer).toHaveBeenCalledTimes(1);
	});
});

describe("creation checks read the project's mode", () => {
	it("a project switched to upload mode gives CONFIGURATION_CHANGED before any build", async () => {
		m.settings.mockResolvedValue({
			ignoreGlobs: null,
			sourceOfTruth: "UPLOAD",
		});
		expect(await open()).toEqual({ kind: "blocked" });
		expect(failure()).toMatchObject({
			code: "CONFIGURATION_CHANGED",
			phase: "prepare",
		});
		expect(m.cloneTreeless).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Security pins (spec §13, plan Task 19)
// ---------------------------------------------------------------------------

describe("security pins (spec §13)", () => {
	it("an activity refuses a row whose integration belongs to another project", async () => {
		// The recorded integration id now names another project's
		// integration. The lookup is scoped to the row's project, as the
		// real query is, so it finds nothing: no token is resolved and
		// nothing reaches the repository.
		const other: Record<string, unknown> = {
			...m.state.integration,
			projectId: "proj_other",
		};
		const scoped = vi.mocked(getProjectRepoIntegration);
		const unscoped = scoped.getMockImplementation();
		scoped.mockImplementation(
			async (integrationId: string, projectId: string) =>
				(other.id === integrationId && other.projectId === projectId
					? other
					: null) as never,
		);
		onTestFinished(() => {
			scoped.mockImplementation(unscoped as never);
		});
		expect(await open()).toEqual({ kind: "blocked" });
		expect(failure()).toMatchObject({ code: "AUTHENTICATION_FAILED" });

		m.state.prs.push(pr());
		seed({
			pullRequestState: "CLOSE_REQUESTED",
			pullRequestAttempt: 2,
			pullRequestHeadSha: HEAD,
			pullRequestRef: BRANCH,
			pullRequestAttempts: [ack({ outcome: "opened" })],
			pullRequestExternalId: "100",
		});
		expect(await close()).toEqual({ kind: "pending" });
		expect(row().pullRequestState).toBe("CLOSE_REQUESTED");
		expect(failure()).toMatchObject({
			code: "CLOSE_CREDENTIALS_UNAVAILABLE",
		});

		for (const call of vi.mocked(getProjectRepoIntegration).mock.calls) {
			expect(call).toEqual(["int_1", "proj_1"]);
		}
		expect(m.resolveFreshRepoToken).not.toHaveBeenCalled();
		expect(remoteIo()).toBe(0);
		expect(m.open).not.toHaveBeenCalled();
		expect(m.close).not.toHaveBeenCalled();
	});

	it("still adopts and closes after revocation", async () => {
		// The proposer lost both create and read. Recovery adopts the pull
		// request its earlier attempt opened, and a close request still
		// settles it: neither acts for the proposer, so neither asks.
		m.canCreate.mockResolvedValue(false);
		m.canRead.mockResolvedValue(false);
		seed({
			pullRequestState: "BLOCKED",
			pullRequestAttempt: 1,
			pullRequestHeadSha: HEAD,
			pullRequestRef: BRANCH,
			pullRequestFailure: {
				phase: "create",
				code: "CREATE_OUTCOME_UNKNOWN",
				retryable: true,
				at: NOW.toISOString(),
				params: { recoveries: 0 },
			},
			pullRequestAttempts: [ack({ createIssuedAt: iso(-HOUR) })],
		});
		m.state.prs.push(pr());
		m.state.remote.set(BRANCH, HEAD);
		expect(await recover()).toEqual({ kind: "adopted" });
		expect(row().pullRequestState).toBe("OPEN");

		m.state.row = { ...row(), pullRequestState: "CLOSE_REQUESTED" };
		expect(await close()).toEqual({ kind: "closed" });
		expect(row().pullRequestState).toBe("CLOSED");
		expect(m.state.remote.has(BRANCH)).toBe(false);
		expect(m.canCreate).not.toHaveBeenCalled();
		expect(m.canRead).not.toHaveBeenCalled();
	});

	it("refuses a reader once allowReaderProposals is turned off before the push", async () => {
		// A reader may propose only under the opt-in; it is read again at
		// every creation check, so switching it off after the build stops
		// the push itself.
		m.canCreate.mockResolvedValue(false);
		m.state.sync = { ...m.state.sync, allowReaderProposals: true };
		m.getSync
			.mockImplementationOnce(async () => clone(m.state.sync))
			.mockImplementation(async () => ({
				...clone(m.state.sync),
				allowReaderProposals: false,
			}));
		expect(await open()).toEqual({ kind: "blocked" });
		expect(m.buildProposalCommit).toHaveBeenCalledTimes(1);
		expect(m.pushCreateOnly).not.toHaveBeenCalled();
		expect(m.open).not.toHaveBeenCalled();
		expect(failure()).toMatchObject({
			code: "PERMISSION_REVOKED",
			phase: "push",
			retryable: false,
		});
	});

	it("no token in activity results, failures or audit metadata", async () => {
		const encoded = Buffer.from(`:${TOKEN}`).toString("base64");
		const seen: unknown[] = [];
		const reset = () => {
			m.state.remote = new Map();
			m.state.prs = [];
			seed();
		};

		// git refuses the token, echoing it the way a credential URL would.
		m.pushCreateOnly.mockRejectedValueOnce(
			new GitCommandError(
				"exit",
				128,
				`fatal: Authentication failed for 'https://x:${TOKEN}@example.com/'`,
				"push",
			),
		);
		seen.push(await open(), row().pullRequestFailure);
		expect(failure()).not.toBeNull();

		// A provider call throws an unclassified error carrying it.
		reset();
		m.open.mockRejectedValueOnce(new Error(`request failed: ${TOKEN}`));
		seen.push(await open(), row().pullRequestFailure);
		expect(failure()).not.toBeNull();

		// And a clean open, with its audit row.
		reset();
		seen.push(await open(), row().pullRequestAttempts);
		expect(actions()).toContain("project.instructions.pull_request_opened");

		const text = JSON.stringify([
			seen,
			m.state.audits,
			m.log.warn.mock.calls,
			m.log.info.mock.calls,
			m.log.error.mock.calls,
		]);
		expect(text).not.toContain(TOKEN);
		expect(text).not.toContain(encoded);
	});

	it("pull-request audit metadata carries no URL", async () => {
		// Opened on the first attempt...
		expect(await open()).toEqual({ kind: "open" });
		// ...then an unknown create outcome recovered as a merged pull
		// request: an adoption and a reconciliation.
		m.state.prs = [];
		m.state.remote = new Map();
		seed({
			pullRequestState: "BLOCKED",
			pullRequestAttempt: 1,
			pullRequestHeadSha: HEAD,
			pullRequestRef: BRANCH,
			pullRequestFailure: {
				phase: "create",
				code: "CREATE_OUTCOME_UNKNOWN",
				retryable: true,
				at: NOW.toISOString(),
				params: { recoveries: 0 },
			},
			pullRequestAttempts: [ack({ createIssuedAt: iso(-HOUR) })],
		});
		const merged = pr({ state: "MERGED", mergedAt: NOW.toISOString() });
		m.state.prs.push(merged);
		expect(await recover()).toEqual({ kind: "adopted" });

		expect(actions()).toEqual([
			"project.instructions.pull_request_opened",
			"project.instructions.pull_request_opened",
			"project.instructions.pull_request_reconciled",
		]);
		for (const audit of m.state.audits) {
			const text = JSON.stringify(audit);
			expect(text).not.toMatch(/[a-z][a-z0-9+.-]*:\/\//i);
			expect(text).not.toContain(merged.url);
			expect(text).not.toContain("example-repo");
		}
	});
});
