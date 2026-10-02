/**
 * The Context tab's Living Memory repository-sync policy (design
 * 2026-09-23 §7, Fizzy #2657): what `projects.contexts.repositorySync.get`
 * returns means for the entry point, the status line, the attention list,
 * the configure dialog's client-side path validation, and the poll. Pure —
 * `ContextRepositorySyncStatus`, `ConfigureContextRepositorySyncDialog` and
 * `ProjectContextsList` share one answer, and this file is what their tests
 * exercise directly. Mirrors the coding-instructions sibling's
 * `instructions-repository-sync.ts` (table-driven tests, same shape of
 * derivation functions), adapted for a run ledger with counts instead of a
 * snapshot version.
 */

import { formatByteSize, formatByteSizeOver } from "@repo/instructions";
import {
	contextSyncPathSpellingProblem,
	defaultRuleForDirectlySelectedFile,
	isInContextSyncFabricDirectory,
} from "@repo/instructions/context-sync-rules";

// Not exported: only used to shape `ContextSyncRunView.status`/`.error`
// below; nothing outside this file matches on the enum itself.
type ContextSyncRunStatus = "SUCCEEDED" | "PARTIAL" | "UNCHANGED" | "FAILED";

type ContextSyncErrorCode =
	| "NOT_CONFIGURED"
	| "INTEGRATION_UNAVAILABLE"
	| "PERMISSION_DENIED"
	| "RUN_IN_PROGRESS"
	| "REF_MISSING"
	| "PATHS_MISSING"
	| "LIMITS_EXCEEDED"
	| "CLONE_FAILED"
	| "STORE_FAILED"
	| "CONFIGURATION_CHANGED"
	| "SUPERSEDED"
	| "INTERRUPTED"
	| "IGNORE_RULE_REJECTED";

/** §7.3: the reasons an attention item (apply, plan or prune) can carry. */
export type ContextSyncAttentionReason =
	| "path-in-use"
	| "too-large"
	| "binary"
	| "empty"
	| "invalid-path"
	| "conflict"
	| "prune-conflict"
	| "path-missing"
	| "ignore-policy-unreadable";

export type ContextSyncRunView = {
	id: string;
	trigger: string;
	startedAt: string | Date;
	finishedAt: string | Date | null;
	status: ContextSyncRunStatus | null;
	error: ContextSyncErrorCode | null;
	commitSha: string | null;
	userName: string | null;
	counts: {
		created: number;
		updated: number;
		adopted: number;
		unchanged: number;
		conflict: number;
		pathInUse: number;
		removed: number;
		pruneConflicts: number;
	};
	plan: {
		keptCount: number;
		excludedCount: number;
		attentionCount: number;
		attention: Array<{ key: string; reason: string }>;
		missingPaths: string[];
		protectedPrefixes: string[];
	} | null;
	applyAttention: Array<{ key: string; reason: "conflict" | "path-in-use" }>;
	pruneConflicts: { keys: string[]; overflow: number };
};

/**
 * Which limit a LIMITS_EXCEEDED run hit: numbers only. `actual` is absent
 * when the check stopped before the true value was known. The shape the
 * coding-instructions sync stores, and the one its status line words.
 */
type ContextSyncLimitView = {
	kind:
		| "fileCount"
		| "fileSize"
		| "totalSize"
		| "inventory"
		| "repositorySize"
		| "doubleStarGroups";
	max: number;
	actual?: number;
	/** `actual` is a lower bound: the check could not learn the size. */
	atLeast?: true;
	/** 1-based line of the `.contextignore` rule a `doubleStarGroups` names. */
	line?: number;
};

/**
 * The newest finished run when it is newer than the last applied one: what
 * the status line reports when a run failed before it reached a plan and so
 * left the applied line untouched.
 */
export type ContextSyncFinishedRunView = {
	id: string;
	trigger: string;
	startedAt: string | Date;
	finishedAt: string | Date;
	status: ContextSyncRunStatus | null;
	error: ContextSyncErrorCode | null;
	limitDetail: ContextSyncLimitView | null;
	commitSha: string | null;
};

export type ContextSyncIntegration = {
	id: string;
	provider: string;
	repositoryOwner: string;
	repositoryName: string;
	defaultBranch: string;
	status: string;
};

/** Why the poll and the push webhook stopped starting runs (§11.1). */
export type ContextSyncPauseReason = "PERMISSION_REVOKED" | "REF_MISSING";

export type ContextSyncConfiguration = {
	syncId: string;
	repositoryIntegrationId: string;
	ref: string;
	paths: string[];
	/**
	 * What the member left out inside the selected folders (Fizzy #2750
	 * §5.3): canonical, sorted. `configure` keeps it when a call omits it.
	 */
	excludedPaths: string[];
	/** The shared poll and the GitHub push webhook start runs (§11.1). */
	automatic: boolean;
	automaticPausedReason: ContextSyncPauseReason | null;
	automaticPausedAt: string | Date | null;
	nextCheckAt: string | Date | null;
	failureCount: number;
	lastAppliedCommitSha: string | null;
	configuredByName: string | null;
	createdAt: string | Date;
	updatedAt: string | Date;
	integration: {
		provider: string;
		repositoryOwner: string;
		repositoryName: string;
		status: string;
	};
};

export type ContextSyncState = {
	canConfigure: boolean;
	running: boolean;
	configured: ContextSyncConfiguration | null;
	latestRun: ContextSyncRunView | null;
	lastAppliedRun: ContextSyncRunView | null;
	latestFinishedRun: ContextSyncFinishedRunView | null;
	managedCount: number;
	awaitingIndexCount: number;
	cleanupPending: number;
	availableIntegrations: ContextSyncIntegration[];
};

/** What Living Memory's sync is doing right now, as the status line words it. */
export type ContextSyncProgress =
	| { kind: "fetching" }
	| { kind: "applying"; done: number; total: number }
	| { kind: "pruning"; removed: number }
	| { kind: "indexing"; indexed: number; managed: number };

/**
 * Where an open run is, read from what it has already committed.
 *
 * Every file the plan keeps lands in exactly one outcome bucket once its batch
 * commits (`mergeContextRepositorySyncRunOutcomes` keeps a key's first
 * decision, and the batch's outcomes commit with its ledger write), so the
 * buckets' sum is the files fully processed and `plan.keptCount` is the files
 * to process: the line reads the ledger, never a guess. Before the plan exists
 * nothing has been decided and no total is known, so the line only names the
 * phase. Once every kept file is decided the run prunes, whose total is not
 * known up front, so it says "so far".
 *
 * After the run, while rows still await indexing, it is the index's count of
 * the rows this sync manages: `awaitingIndexCount` is live, so the number
 * moves as the vectors land.
 *
 * `null` when there is nothing to report, and the line keeps its plain wording.
 */
export function contextSyncProgress(
	state: Pick<
		ContextSyncState,
		"running" | "latestRun" | "managedCount" | "awaitingIndexCount"
	>,
): ContextSyncProgress | null {
	const run = state.latestRun;
	if (state.running) {
		if (!run || run.finishedAt !== null) {
			return null;
		}
		if (!run.plan) {
			return { kind: "fetching" };
		}
		const { counts } = run;
		const done =
			counts.created +
			counts.updated +
			counts.adopted +
			counts.unchanged +
			counts.conflict +
			counts.pathInUse;
		const total = run.plan.keptCount;
		return done < total
			? { kind: "applying", done, total }
			: { kind: "pruning", removed: counts.removed };
	}
	if (state.awaitingIndexCount > 0 && state.managedCount > 0) {
		return {
			kind: "indexing",
			indexed: Math.max(0, state.managedCount - state.awaitingIndexCount),
			managed: state.managedCount,
		};
	}
	return null;
}

/**
 * `get` returns every connected integration regardless of status (so a
 * stale one still shows in "Change branch or paths…" as a labelled choice);
 * only an ACTIVE one can be synced from, so every entry point and the
 * dialog's select filter to this first.
 */
export function activeContextSyncIntegrations(
	integrations: readonly ContextSyncIntegration[],
): ContextSyncIntegration[] {
	return integrations.filter(
		(integration) => integration.status === "ACTIVE",
	);
}

/** "Sync from repository": a configurer, nothing configured, a repo to pick. */
export function offersSyncFromRepository(
	state: Pick<
		ContextSyncState,
		"canConfigure" | "configured" | "availableIntegrations"
	>,
): boolean {
	return (
		state.canConfigure &&
		state.configured === null &&
		activeContextSyncIntegrations(state.availableIntegrations).length > 0
	);
}

/**
 * Whether the Context tab shows its Living Memory section: something is
 * synced, a sync is configured, a configurer can set one up, or the state
 * could not be read. The last case keeps the section up so the failure has a
 * place to say so: without it a failed read looks exactly like a project that
 * has nothing to configure.
 */
export function showsLivingMemorySection(input: {
	folderCount: number;
	state: ContextSyncState | undefined;
	readFailed: boolean;
}): boolean {
	return (
		input.folderCount > 0 ||
		input.readFailed ||
		Boolean(input.state?.configured) ||
		offersSyncFromRepository(
			input.state ?? {
				canConfigure: false,
				configured: null,
				availableIntegrations: [],
			},
		)
	);
}

/** "Sync now" / the settings menu: a configurer with a configuration. */
export function offersSyncNow(
	state: Pick<ContextSyncState, "canConfigure" | "configured">,
): boolean {
	return state.canConfigure && state.configured !== null;
}

// ── Automatic sync (§11.1, Fizzy #2673) ────────────────────────────────────

/**
 * The pause to show, or `null`. A pause left on a configuration whose
 * automatic sync is off is dormant — nothing is waiting to resume, so the
 * status says nothing about it (the coding-instructions sibling's rule,
 * `RepositorySyncStatus`).
 */
export function contextSyncPausedReason(
	configured: Pick<
		ContextSyncConfiguration,
		"automatic" | "automaticPausedReason"
	> | null,
): ContextSyncPauseReason | null {
	return configured?.automatic && configured.automaticPausedReason
		? configured.automaticPausedReason
		: null;
}

type ContextSyncTrigger = "MANUAL" | "POLL" | "WEBHOOK";

/**
 * `projects.contexts.livingMemory.repositorySync.triggers.<TRIGGER>`. The
 * switch is exhaustive over `ContextSyncTrigger`; a value the server adds
 * before this client knows it reads as the generic label.
 */
export function contextSyncTriggerLabelKey(
	trigger: string,
): "triggers.MANUAL" | "triggers.POLL" | "triggers.WEBHOOK" | "triggers.OTHER" {
	const known = trigger as ContextSyncTrigger;
	switch (known) {
		case "MANUAL":
			return "triggers.MANUAL";
		case "POLL":
			return "triggers.POLL";
		case "WEBHOOK":
			return "triggers.WEBHOOK";
		default:
			return unlabelledContextSyncTrigger(known);
	}
}

/** Compile-time exhaustiveness for `contextSyncTriggerLabelKey`. */
function unlabelledContextSyncTrigger(_trigger: never): "triggers.OTHER" {
	return "triggers.OTHER";
}

/**
 * The configure dialog's `automatic` field. A first configure always sends
 * the checkbox (the server would otherwise store off). Changing a
 * configuration sends it only once the member touched the checkbox: omitted,
 * the server keeps the stored value, so saving a branch or paths change
 * cannot undo a toggle made elsewhere since the dialog opened.
 */
export function contextSyncAutomaticInput({
	current,
	touched,
	automatic,
}: {
	current: ContextSyncConfiguration | null;
	touched: boolean;
	automatic: boolean;
}): { automatic?: boolean } {
	return current === null || touched ? { automatic } : {};
}

export function shortCommit(sha: string | null | undefined): string | null {
	return sha ? sha.slice(0, 7) : null;
}

export type ContextSyncLastAppliedSummary =
	| { kind: "not-synced" }
	| {
			kind: "applied";
			shortSha: string;
			startedAt: string | Date;
			fileCount: number;
	  }
	| { kind: "partial"; shortSha: string; keptOlderCount: number }
	| { kind: "failed"; shortSha: string };

/**
 * The status line's headline (§7.1): "Applied commit … · N files" /
 * "Partially applied … · N files kept an older version" / "Sync failed
 * part-way at commit … · previous content remains" / "Not synced yet". Reads
 * the LAST APPLIED run — `record` (§5.4) sets `lastAppliedRunId` on every
 * terminal outcome that reached a plan, whatever its status, so a run that
 * failed after pinning a commit still stamps this bucket; only a run that
 * never got that far leaves it unchanged and the previous line stands.
 */
export function contextSyncLastAppliedSummary(
	run: ContextSyncRunView | null,
): ContextSyncLastAppliedSummary {
	if (!run || !run.commitSha) {
		return { kind: "not-synced" };
	}
	const shortSha = shortCommit(run.commitSha) ?? run.commitSha;
	if (run.status === "PARTIAL") {
		return {
			kind: "partial",
			shortSha,
			keptOlderCount: run.counts.conflict + run.counts.pathInUse,
		};
	}
	if (run.status === "FAILED") {
		return { kind: "failed", shortSha };
	}
	// SUCCEEDED or UNCHANGED: the tree is current as of this commit.
	return {
		kind: "applied",
		shortSha,
		startedAt: run.startedAt,
		fileCount:
			run.counts.created +
			run.counts.updated +
			run.counts.adopted +
			run.counts.unchanged,
	};
}

/** A translation key + values under `projects.contexts.livingMemory.repositorySync`. */
export type ContextSyncMessage = {
	key: string;
	values?: Record<string, string | number>;
};

/** The last-applied summary rendered as one translation lookup. */
export function contextSyncLastAppliedMessage(
	summary: ContextSyncLastAppliedSummary,
): ContextSyncMessage {
	switch (summary.kind) {
		case "not-synced":
			return { key: "status.notSynced" };
		case "applied":
			return {
				key: "status.applied",
				values: { sha: summary.shortSha, count: summary.fileCount },
			};
		case "partial":
			return {
				key: "status.partial",
				values: {
					sha: summary.shortSha,
					count: summary.keptOlderCount,
				},
			};
		case "failed":
			return { key: "status.failed", values: { sha: summary.shortSha } };
	}
}

/** `projects.contexts.livingMemory.repositorySync.attention.<reason>`. */
export function contextSyncAttentionMessageKey(reason: string): string {
	return `attention.${reason}`;
}

// ── A failed run (Fizzy #2784) ─────────────────────────────────────────────

function limitMessage(limit: ContextSyncLimitView): ContextSyncMessage {
	const max = limit.max.toLocaleString("en-US");
	switch (limit.kind) {
		case "fileCount":
			return limit.actual === undefined
				? { key: "failure.limit.fileCountUnknown", values: { max } }
				: {
						key: "failure.limit.fileCount",
						values: {
							actual: limit.actual.toLocaleString("en-US"),
							max,
						},
					};
		case "fileSize":
		case "totalSize":
			return limit.actual === undefined
				? {
						key: `failure.limit.${limit.kind}Unknown`,
						values: { max: formatByteSize(limit.max) },
					}
				: {
						key: limit.atLeast
							? `failure.limit.${limit.kind}AtLeast`
							: `failure.limit.${limit.kind}`,
						values: {
							actual: formatByteSizeOver(limit.actual, limit.max),
							max: formatByteSize(limit.max),
						},
					};
		case "inventory":
			return { key: "failure.limit.inventory", values: { max } };
		case "repositorySize":
			return {
				key: "failure.limit.repositorySize",
				values: { max: formatByteSize(limit.max) },
			};
		case "doubleStarGroups":
			return limit.line === undefined || limit.actual === undefined
				? { key: "failure.IGNORE_RULE_REJECTED" }
				: {
						key: "failure.limit.doubleStarGroups",
						values: {
							line: limit.line,
							actual: limit.actual,
							max: limit.max,
						},
					};
		default: {
			const unreachable: never = limit.kind;
			return unreachable;
		}
	}
}

/**
 * Why the newest finished run failed, in words that match its error code:
 * LIMITS_EXCEEDED names the limit it recorded and what it measured, so a
 * person can see whether the selection, the size or the repository is the
 * problem. `null` for a run that did not fail. The switch is exhaustive over
 * the error codes; a code this client does not know reads as a failed sync.
 */
export function contextSyncFailureMessage(
	run: Pick<ContextSyncFinishedRunView, "status" | "error" | "limitDetail">,
	configuration: { ref: string } | null,
): ContextSyncMessage | null {
	if (run.status !== "FAILED" || run.error === null) {
		return null;
	}
	switch (run.error) {
		case "LIMITS_EXCEEDED":
			return run.limitDetail
				? limitMessage(run.limitDetail)
				: { key: "failure.LIMITS_EXCEEDED" };
		case "IGNORE_RULE_REJECTED":
			return run.limitDetail
				? limitMessage(run.limitDetail)
				: { key: "failure.IGNORE_RULE_REJECTED" };
		case "REF_MISSING":
			return {
				key: "failure.REF_MISSING",
				values: { ref: configuration?.ref ?? "" },
			};
		case "NOT_CONFIGURED":
		case "INTEGRATION_UNAVAILABLE":
		case "PERMISSION_DENIED":
		case "RUN_IN_PROGRESS":
		case "PATHS_MISSING":
		case "CLONE_FAILED":
		case "STORE_FAILED":
		case "CONFIGURATION_CHANGED":
		case "SUPERSEDED":
		case "INTERRUPTED":
			return { key: `failure.${run.error}` };
		default:
			return unknownFailure(run.error);
	}
}

/** Compile-time exhaustiveness for `contextSyncFailureMessage`; at run time, the generic line. */
function unknownFailure(_error: never): ContextSyncMessage {
	return { key: "failure.unknown" };
}

// ── Polling (§7.1) ──────────────────────────────────────────────────────────

export const CONTEXT_SYNC_RUNNING_POLL_MS = 3_000;
export const CONTEXT_SYNC_INDEXING_POLL_MS = 15_000;
export const CONTEXT_SYNC_INDEXING_POLL_BUDGET_MS = 10 * 60 * 1000;
/**
 * While automatic sync is on and not paused, the tab reads the sync state
 * once a minute even with no run open, so a run the scheduled check or a
 * push started, or a pause the check recorded, shows without navigating
 * (Fizzy #2713): the coding-instructions tab's `REPOSITORY_SYNC_IDLE_POLL_MS`.
 */
export const CONTEXT_SYNC_IDLE_POLL_MS = 60_000;

/**
 * `refetchInterval` for `repositorySync.get`: every 3 s while a run is open;
 * otherwise every 15 s while files still await indexing, for up to 10
 * minutes of that state (`indexingElapsedMs`, tracked by the caller from the
 * moment `awaitingIndexCount` first became positive); otherwise every 60 s
 * while automatic sync is on and not paused; otherwise no poll.
 */
export function contextSyncPollInterval(
	state:
		| (Pick<ContextSyncState, "running" | "awaitingIndexCount"> & {
				configured?: Pick<
					ContextSyncConfiguration,
					"automatic" | "automaticPausedReason"
				> | null;
		  })
		| null
		| undefined,
	indexingElapsedMs: number,
): number | false {
	if (state?.running) {
		return CONTEXT_SYNC_RUNNING_POLL_MS;
	}
	if (
		(state?.awaitingIndexCount ?? 0) > 0 &&
		indexingElapsedMs < CONTEXT_SYNC_INDEXING_POLL_BUDGET_MS
	) {
		return CONTEXT_SYNC_INDEXING_POLL_MS;
	}
	const configured = state?.configured;
	return configured?.automatic && !configured.automaticPausedReason
		? CONTEXT_SYNC_IDLE_POLL_MS
		: false;
}

/** A run closed on this poll: whatever it produced is readable now. */
export function contextSyncRunEnded(
	wasRunning: boolean,
	running: boolean,
): boolean {
	return wasRunning && !running;
}

/**
 * The newest run as the tab compares it between two reads: its receipt id
 * and whether it has finished. A receipt finishing is a change on its own:
 * `running` reads false whenever Temporal could not be asked, so the tab can
 * see the newest receipt open with nothing running and then finished, and
 * neither the id nor a running → idle transition would move. Finished is
 * final, so the finish time itself is not part of it. `null` when there is
 * no run yet.
 */
export function contextSyncLatestRunFingerprint(
	run: Pick<ContextSyncRunView, "id" | "finishedAt"> | null,
): string | null {
	if (!run) {
		return null;
	}
	return `${run.id}:${run.finishedAt === null ? "open" : "finished"}`;
}

/**
 * The newest run changed between two reads (compare
 * `contextSyncLatestRunFingerprint`s): a run the scheduled check or a push
 * started or finished without the tab seeing it open, or a failure the
 * check recorded (the coding-instructions tab's `latestSyncRunChanged`).
 * `undefined` means not loaded yet, so the first read never counts; `null`
 * (no run yet) does, so a sync's first run is noticed.
 */
export function contextSyncLatestRunChanged(
	seen: string | null | undefined,
	current: string | null | undefined,
): boolean {
	return seen !== undefined && current !== undefined && seen !== current;
}

// ── Configure dialog: server error → inline / toast (§5.1, §7.2) ───────────

function orpcErrorData(error: unknown): Record<string, unknown> | undefined {
	if (error && typeof error === "object" && "data" in error) {
		const data = (error as { data?: unknown }).data;
		return data && typeof data === "object"
			? (data as Record<string, unknown>)
			: undefined;
	}
	return undefined;
}

const PATHS_FIELD_CODES = new Set([
	"INVALID_PATH",
	"EXCLUDED_PATH",
	"PATH_PREFIX_OVERLAP",
	"TOO_MANY_PATHS",
	// What the member left out (Fizzy #2750 §5.2, §5.3).
	"EXCLUDED_PATH_POLICY_FILE",
	"TOO_MANY_EXCLUDED_PATHS",
	"EXCLUDED_PATH_OUTSIDE_SELECTION",
	"EXCLUDED_PATH_OVERLAP",
	"EXCLUDED_PATHS_STALE",
]);
const BRANCH_FIELD_CODES = new Set(["BRANCH_NOT_FOUND"]);
/** Inline, but not attached to either field — a repository-level refusal. */
const INLINE_GENERAL_CODES = new Set([
	"REPOSITORY_NOT_FOUND",
	"REPOSITORY_UNAVAILABLE",
	"REPOSITORY_CREDENTIALS_EXPIRED",
	"REPOSITORY_CHANGE_REQUIRES_DISCONNECT",
]);

export type ContextSyncConfigureErrorField = "branch" | "paths" | null;

/**
 * `configure`'s typed `data.code` → a message, inline when the fix is in the
 * form (beside the field it is about, or as a general banner for a
 * repository-level refusal) and a toast otherwise (`REPOSITORY_UNREACHABLE`,
 * a transient platform fault, and anything unrecognized).
 */
export function contextSyncConfigureErrorMessage(error: unknown): {
	key: string;
	inline: boolean;
	field: ContextSyncConfigureErrorField;
	values: Record<string, string | number>;
} {
	const data = orpcErrorData(error);
	const code = typeof data?.code === "string" ? data.code : undefined;
	const values: Record<string, string | number> = {
		path: typeof data?.path === "string" ? data.path : "",
		withPath: typeof data?.withPath === "string" ? data.withPath : "",
		managedCount:
			typeof data?.managedCount === "number" ? data.managedCount : 0,
	};
	if (code && PATHS_FIELD_CODES.has(code)) {
		return {
			key: `configureDialog.errors.${excludedPathCopy(code, values.path)}`,
			inline: true,
			field: "paths",
			values,
		};
	}
	if (code && BRANCH_FIELD_CODES.has(code)) {
		return {
			key: `configureDialog.errors.${code}`,
			inline: true,
			field: "branch",
			values,
		};
	}
	if (code && INLINE_GENERAL_CODES.has(code)) {
		return {
			key: `configureDialog.errors.${code}`,
			inline: true,
			field: null,
			values,
		};
	}
	return {
		key: "configureDialog.errors.generic",
		inline: false,
		field: null,
		values,
	};
}

export type ContextSyncAction = "syncNow" | "disable";

/**
 * The message for a failed sync action: the typed code's own words where
 * `contextSyncConfigureErrorMessage` has them, else a translated generic line
 * naming the action. The server's `error.message` is never shown: it is not
 * translated, and it can carry a provider's or a proxy's text.
 */
export function contextSyncActionErrorMessage(
	error: unknown,
	action: ContextSyncAction,
): ContextSyncMessage {
	const mapped = contextSyncConfigureErrorMessage(error);
	return mapped.key === "configureDialog.errors.generic"
		? { key: `actionErrors.${action}` }
		: { key: mapped.key, values: mapped.values };
}

/**
 * The `listTree` refusals whose `configure` copy reads the same for a
 * listing: the fix (another branch, a reconnect) is the one `configure`
 * would ask for. `REPOSITORY_UNREACHABLE` is left out on purpose: its
 * `configure` copy is about saving, so it takes the tree's own fallback.
 */
const TREE_CONFIGURE_COPY_CODES = new Set([
	"BRANCH_NOT_FOUND",
	"REPOSITORY_NOT_FOUND",
	"REPOSITORY_UNAVAILABLE",
	"REPOSITORY_CREDENTIALS_EXPIRED",
]);

/**
 * `listTree`'s failure → the tree area's inline message (Fizzy #2674),
 * reusing `configure`'s copy for the codes both throw and a generic
 * fallback for the rest. `ref` fills the branch name the
 * `BRANCH_NOT_FOUND` copy names, which the error's data does not carry.
 */
export function contextSyncTreeErrorMessage(
	error: unknown,
	ref: string,
): ContextSyncMessage {
	const data = orpcErrorData(error);
	const code = typeof data?.code === "string" ? data.code : undefined;
	if (code && TREE_CONFIGURE_COPY_CODES.has(code)) {
		const mapped = contextSyncConfigureErrorMessage(error);
		return {
			key: mapped.key,
			values:
				code === "BRANCH_NOT_FOUND"
					? { ...mapped.values, path: ref }
					: mapped.values,
		};
	}
	return { key: "tree.error" };
}

export type ContextSyncNowResult =
	| { started: true }
	| {
			started: false;
			reason:
				| "already_running"
				| "not_configured"
				| "integration_unavailable";
	  };

export function contextSyncNowResultMessage(
	result: ContextSyncNowResult,
): ContextSyncMessage & { tone: "success" | "info" | "error" } {
	if (result.started) {
		return { key: "syncNowResult.started", tone: "success" };
	}
	return {
		key: `syncNowResult.${result.reason}`,
		tone: result.reason === "already_running" ? "info" : "error",
	};
}

// ── Typed paths: client-side validation mirroring the server's
// `packages/api/modules/projects/procedures/contexts/repository-sync/paths.ts`
// (design §2, §5.1). Every per-path rule (the spelling and length rule,
// `.fabric`, the coding-instructions basenames) is the canonical module's,
// which the server imports too, so the dialog refuses exactly what
// `configure` would; the server stays authoritative either way. ──────────

export const CONTEXT_SYNC_MAX_PATHS = 50;

/**
 * An `EXCLUDED_PATH` refusal's copy: `.fabric` has its own, since it is not
 * a coding-instructions file; the error's shape is the same either way.
 */
function excludedPathCopy(
	code: string,
	path: string | number | undefined,
): string {
	return code === "EXCLUDED_PATH" &&
		typeof path === "string" &&
		isInContextSyncFabricDirectory(path)
		? "EXCLUDED_FABRIC_PATH"
		: code;
}

/** `b` is strictly inside `a`, by whole path segments. */
function isStrictlyInsideContextSyncPath(a: string, b: string): boolean {
	return a === "" ? b !== "" : b.startsWith(`${a}/`);
}

export type ContextSyncPathValidationError =
	| { code: "INVALID_PATH"; path: string }
	| { code: "EXCLUDED_PATH"; path: string }
	| { code: "TOO_MANY_PATHS" }
	| { code: "PATH_PREFIX_OVERLAP"; path: string; withPath: string }
	| { code: "DUPLICATE_PATH"; path: string };

/**
 * Validate one typed path against the selected paths before the selection
 * reducer adds it (`applyContextAction`'s `include`, Fizzy #2750 §5.7), so a
 * typed path and a tree tick are the same transition: its canonical
 * spelling, the per-path rules `configure` applies (a `.fabric` segment, a
 * coding-instructions basename), not already selected, and not inside a
 * selected path. A path that HOLDS selected paths is not an error: adding
 * it absorbs them, as ticking a partial folder does, and the 50-path cap is
 * checked after that absorption by the reducer. `""` (the whole repository)
 * absorbs everything the same way.
 */
export function validateContextSyncPathAddition(
	raw: string,
	existing: readonly string[],
):
	| { ok: true; path: string }
	| { ok: false; error: ContextSyncPathValidationError } {
	const path = raw;
	if (contextSyncPathSpellingProblem(path) !== null) {
		return { ok: false, error: { code: "INVALID_PATH", path } };
	}
	if (
		path !== "" &&
		(isInContextSyncFabricDirectory(path) ||
			defaultRuleForDirectlySelectedFile(path) !== null)
	) {
		return { ok: false, error: { code: "EXCLUDED_PATH", path } };
	}
	if (existing.includes(path)) {
		return { ok: false, error: { code: "DUPLICATE_PATH", path } };
	}
	for (const other of existing) {
		if (isStrictlyInsideContextSyncPath(other, path)) {
			return {
				ok: false,
				error: { code: "PATH_PREFIX_OVERLAP", path, withPath: other },
			};
		}
	}
	return { ok: true, path };
}

/** A typed path's inline error, by translation key. */
export function contextSyncPathValidationMessage(
	error: ContextSyncPathValidationError,
): ContextSyncMessage {
	switch (error.code) {
		case "INVALID_PATH":
			return {
				key: "pathErrors.INVALID_PATH",
				values: { path: error.path },
			};
		case "EXCLUDED_PATH":
			return {
				key: `pathErrors.${excludedPathCopy(error.code, error.path)}`,
				values: { path: error.path },
			};
		case "TOO_MANY_PATHS":
			return {
				key: "pathErrors.TOO_MANY_PATHS",
				values: { max: CONTEXT_SYNC_MAX_PATHS },
			};
		case "PATH_PREFIX_OVERLAP":
			// Inside `""` is inside the whole repository, which has no name.
			return error.withPath === ""
				? {
						key: "pathErrors.INSIDE_WHOLE_REPOSITORY",
						values: { path: error.path },
					}
				: {
						key: "pathErrors.PATH_PREFIX_OVERLAP",
						values: { path: error.path, withPath: error.withPath },
					};
		case "DUPLICATE_PATH":
			return {
				key: "pathErrors.DUPLICATE_PATH",
				values: { path: error.path },
			};
	}
}

// ── Remove duplicates: final answers, not a toast storm (§6, §7.3) ─────────

export type ContextDeleteOutcome = "deleted" | "skipped" | "failed";

/** Tally a batch of per-copy outcomes into the counts the toast reports. */
export function tallyContextDeleteOutcomes(
	outcomes: readonly ContextDeleteOutcome[],
): { deleted: number; skipped: number; failed: number } {
	let deleted = 0;
	let skipped = 0;
	let failed = 0;
	for (const outcome of outcomes) {
		if (outcome === "deleted") {
			deleted++;
		} else if (outcome === "skipped") {
			skipped++;
		} else {
			failed++;
		}
	}
	return { deleted, skipped, failed };
}
