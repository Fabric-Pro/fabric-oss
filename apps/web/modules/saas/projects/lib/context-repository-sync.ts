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
	| "INTERRUPTED";

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

export type ContextSyncIntegration = {
	id: string;
	provider: string;
	repositoryOwner: string;
	repositoryName: string;
	defaultBranch: string;
	status: string;
};

export type ContextSyncConfiguration = {
	syncId: string;
	repositoryIntegrationId: string;
	ref: string;
	paths: string[];
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
	managedCount: number;
	awaitingIndexCount: number;
	cleanupPending: number;
	availableIntegrations: ContextSyncIntegration[];
};

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

/** "Sync now" / the settings menu: a configurer with a configuration. */
export function offersSyncNow(
	state: Pick<ContextSyncState, "canConfigure" | "configured">,
): boolean {
	return state.canConfigure && state.configured !== null;
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

// ── Polling (§7.1) ──────────────────────────────────────────────────────────

export const CONTEXT_SYNC_RUNNING_POLL_MS = 3_000;
export const CONTEXT_SYNC_INDEXING_POLL_MS = 15_000;
export const CONTEXT_SYNC_INDEXING_POLL_BUDGET_MS = 10 * 60 * 1000;

/**
 * `refetchInterval` for `repositorySync.get`: every 3 s while a run is open;
 * otherwise every 15 s while files still await indexing, for up to 10
 * minutes of that state (`indexingElapsedMs`, tracked by the caller from the
 * moment `awaitingIndexCount` first became positive); otherwise no poll.
 */
export function contextSyncPollInterval(
	state:
		| Pick<ContextSyncState, "running" | "awaitingIndexCount">
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
	return false;
}

/** A run closed on this poll: whatever it produced is readable now. */
export function contextSyncRunEnded(
	wasRunning: boolean,
	running: boolean,
): boolean {
	return wasRunning && !running;
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

// ── Paths editor: client-side validation mirroring the server's
// `packages/api/modules/projects/procedures/contexts/repository-sync/paths.ts`
// (design §2, §5.1). A twin, not a re-export: the server stays authoritative,
// this only catches the common mistakes before a round trip. ───────────────

export const CONTEXT_SYNC_MAX_PATHS = 50;

/**
 * `path` has a `.fabric` segment, at any depth and in any case: the CLI's
 * own state, which `paths.ts` refuses whatever the path names (Fizzy #2704).
 */
function isInContextSyncFabricDirectory(path: string): boolean {
	return path
		.split("/")
		.some((segment) => segment.toLowerCase() === ".fabric");
}

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

/**
 * The default exclusions' FILE patterns only (`paths.ts` — a directly
 * selected file's basename against these; a folder selection is not
 * excluded by name). Keep in sync with the server's twin and the CLI's.
 */
const EXCLUDED_CONTEXT_SYNC_BASENAMES: ReadonlySet<string> = new Set([
	"claude.md",
	"agents.md",
	"gemini.md",
	".contextignore",
]);

function contextSyncPathBasename(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? path : path.slice(slash + 1);
}

/**
 * A lighter canonical check than the server's `normalizeContextSourcePath`
 * (no Unicode-normalization comparison): no surrounding whitespace, no
 * backslash, no trailing slash, no leading slash, no empty/`.`/`..` segment,
 * no control character. Good enough to catch typing mistakes client-side;
 * the server re-validates authoritatively either way.
 */
function isCanonicalContextSyncPath(path: string): boolean {
	if (path === "") {
		return true;
	}
	if (path.trim() !== path) {
		return false;
	}
	if (path.includes("\\") || path.endsWith("/") || path.startsWith("/")) {
		return false;
	}
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the class deliberately REJECTS control characters in a selected path.
	if (/[\x00-\x1f]/.test(path)) {
		return false;
	}
	return path
		.split("/")
		.every(
			(segment) => segment !== "" && segment !== "." && segment !== "..",
		);
}

/** `a` is `b`'s ancestor (or equal), by whole path segments. */
function isContextSyncPathSegmentPrefix(a: string, b: string): boolean {
	return a === "" || b === a || b.startsWith(`${a}/`);
}

export type ContextSyncPathValidationError =
	| { code: "INVALID_PATH"; path: string }
	| { code: "EXCLUDED_PATH"; path: string }
	| { code: "TOO_MANY_PATHS" }
	| { code: "PATH_PREFIX_OVERLAP"; path: string; withPath: string }
	| { code: "DUPLICATE_PATH"; path: string };

/**
 * Validate one candidate against the paths already in the chip list —
 * called when a chip is about to be added, so the list stays internally
 * consistent (no need to re-check the whole list on submit). `""` (the
 * whole repository) is only valid alone: adding it with others already
 * present, or adding another path once it is present, both overlap.
 */
export function validateContextSyncPathAddition(
	raw: string,
	existing: readonly string[],
):
	| { ok: true; path: string }
	| { ok: false; error: ContextSyncPathValidationError } {
	const path = raw;
	if (!isCanonicalContextSyncPath(path)) {
		return { ok: false, error: { code: "INVALID_PATH", path } };
	}
	if (isInContextSyncFabricDirectory(path)) {
		return { ok: false, error: { code: "EXCLUDED_PATH", path } };
	}
	if (
		path !== "" &&
		EXCLUDED_CONTEXT_SYNC_BASENAMES.has(
			contextSyncPathBasename(path).toLowerCase(),
		)
	) {
		return { ok: false, error: { code: "EXCLUDED_PATH", path } };
	}
	if (existing.includes(path)) {
		return { ok: false, error: { code: "DUPLICATE_PATH", path } };
	}
	if (existing.length >= CONTEXT_SYNC_MAX_PATHS) {
		return { ok: false, error: { code: "TOO_MANY_PATHS" } };
	}
	for (const other of existing) {
		if (
			isContextSyncPathSegmentPrefix(other, path) ||
			isContextSyncPathSegmentPrefix(path, other)
		) {
			return {
				ok: false,
				error: { code: "PATH_PREFIX_OVERLAP", path, withPath: other },
			};
		}
	}
	return { ok: true, path };
}

/** The paths editor's inline error, by translation key. */
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
			return {
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
