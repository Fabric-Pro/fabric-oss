/**
 * The Coding Instructions tab's repository-sync policy (design 2026-09-23
 * §7): what the state `repositorySync.get` returns means for the buttons, the
 * status line, the History list and the poll. Pure, so the tab, the empty
 * state and their tests share one answer.
 *
 * The shapes are declared here rather than inferred from the procedures, the
 * same way `InstructionsSnapshot` is: the enum columns arrive as strings and
 * the components read them as the closed sets they are.
 */

import { SNAPSHOT_LIMITS } from "@repo/instructions";

type SyncRunStatus =
	| "SUCCEEDED"
	| "UNCHANGED"
	| "NOT_PUBLISHED"
	| "REJECTED"
	| "FAILED"
	| "SKIPPED";

type SyncErrorCode =
	| "NOT_CONFIGURED"
	| "INTEGRATION_UNAVAILABLE"
	| "PERMISSION_DENIED"
	| "REF_MISSING"
	| "ROOT_MISSING"
	| "LIMITS_EXCEEDED"
	| "CLONE_FAILED"
	| "STORAGE_FAILED"
	| "CHILD_ABORTED"
	| "CONFIGURATION_CHANGED"
	| "TREE_REFUSED";

export type SyncRunView = {
	id: string;
	trigger: string;
	startedAt: string | Date;
	finishedAt: string | Date | null;
	status: SyncRunStatus | null;
	error: SyncErrorCode | null;
	note: string | null;
	commitSha: string | null;
	snapshotId: string | null;
	snapshotVersion: number | null;
	userName: string | null;
};

export type RepositorySyncIntegration = {
	id: string;
	provider: string;
	repositoryOwner: string;
	repositoryName: string;
	defaultBranch: string;
};

export type RepositorySyncConfiguration = {
	syncId: string;
	repositoryIntegrationId: string;
	provider: string;
	repositoryOwner: string;
	repositoryName: string;
	integrationStatus: string;
	ref: string;
	rootPath: string;
	automatic: boolean;
	automaticPausedReason: string | null;
	automaticPausedAt: string | Date | null;
	delegateName: string | null;
};

export type RepositorySyncState = {
	sourceOfTruth: "UPLOAD" | "REPOSITORY";
	canConfigure: boolean;
	running: boolean;
	configured: RepositorySyncConfiguration | null;
	latestRun: SyncRunView | null;
	availableIntegrations: RepositorySyncIntegration[];
};

/** What the tab hands the published view and the empty state. */
export type RepositorySyncControls = {
	state: RepositorySyncState;
	onConfigure: () => void;
	onSyncNow: () => void;
	syncNowPending: boolean;
	/** Re-read everything a configuration change can move. */
	onChanged: () => void;
};

export type SyncNowResult =
	| { started: true }
	| {
			started: false;
			reason:
				| "already_running"
				| "not_configured"
				| "integration_unavailable";
	  };

/** A translation key under `projects.codingInstructions.repositorySync`. */
type SyncMessage = {
	key: string;
	values?: Record<string, string | number>;
};

export const REPOSITORY_SYNC_POLL_MS = 3_000;

/** `refetchInterval` for `repositorySync.get`: every 3 s while a run is open. */
export function repositorySyncPollInterval(
	state: { running: boolean } | null | undefined,
): number | false {
	return state?.running ? REPOSITORY_SYNC_POLL_MS : false;
}

/** The poll saw a run close: its outcome, whatever it was, is now readable. */
export function syncRunEnded(wasRunning: boolean, running: boolean): boolean {
	return wasRunning && !running;
}

export function offersSyncFromRepository(state: RepositorySyncState): boolean {
	return (
		state.canConfigure &&
		state.configured === null &&
		state.availableIntegrations.length > 0
	);
}

export function offersSyncNow(state: RepositorySyncState): boolean {
	return state.canConfigure && state.configured !== null;
}

export function shortCommit(sha: string | null | undefined): string | null {
	return sha ? sha.slice(0, 7) : null;
}

type SyncRunOutcome =
	| { kind: "running" }
	| { kind: "interrupted" }
	| { kind: "published"; version: number | null }
	| { kind: "unchanged" }
	| {
			kind: "not_published";
			reason: "configuration_changed" | "permission_revoked" | "older";
	  }
	| { kind: "rejected" }
	| { kind: "skipped" }
	| { kind: "failed"; error: SyncErrorCode | null };

/**
 * A run row as the tab reads it. An unfinished row is "running" only while a
 * workflow is open; otherwise the worker that owned it is gone and it was
 * interrupted (plan Decision 24).
 */
export function syncRunOutcome(
	run: SyncRunView,
	running: boolean,
): SyncRunOutcome {
	if (run.finishedAt === null || run.status === null) {
		return running ? { kind: "running" } : { kind: "interrupted" };
	}
	switch (run.status) {
		case "SUCCEEDED":
			return { kind: "published", version: run.snapshotVersion };
		case "UNCHANGED":
			return { kind: "unchanged" };
		case "NOT_PUBLISHED":
			return {
				kind: "not_published",
				reason:
					run.error === "CONFIGURATION_CHANGED"
						? "configuration_changed"
						: run.error === "PERMISSION_DENIED"
							? "permission_revoked"
							: "older",
			};
		case "REJECTED":
			return { kind: "rejected" };
		case "SKIPPED":
			return { kind: "skipped" };
		case "FAILED":
			return { kind: "failed", error: run.error };
	}
}

export function syncOutcomeMessage(outcome: SyncRunOutcome): SyncMessage {
	switch (outcome.kind) {
		case "published":
			return outcome.version === null
				? { key: "outcomes.publishedNoVersion" }
				: {
						key: "outcomes.published",
						values: { version: outcome.version },
					};
		case "not_published":
			return { key: `outcomes.notPublished.${outcome.reason}` };
		default:
			return { key: `outcomes.${outcome.kind}` };
	}
}

/**
 * The line under a failed run. LIMITS_EXCEEDED states all three limits
 * (files, size per file, total size): the run row has no count columns
 * (§4.1a) and does not record which limit was hit, so naming only some of
 * them would send someone hunting in the wrong place.
 */
export function syncErrorMessage(
	error: SyncErrorCode | null,
	configuration: { ref: string; rootPath: string } | null,
): SyncMessage | null {
	if (error === null) {
		return null;
	}
	const ref = configuration?.ref ?? "";
	switch (error) {
		case "REF_MISSING":
			return { key: "errors.REF_MISSING", values: { ref } };
		case "ROOT_MISSING":
			return {
				key: "errors.ROOT_MISSING",
				values: { ref, rootPath: configuration?.rootPath ?? "" },
			};
		case "LIMITS_EXCEEDED":
			return {
				key: "errors.LIMITS_EXCEEDED",
				values: {
					maxFiles: SNAPSHOT_LIMITS.maxFiles.toLocaleString("en-US"),
					maxFileMb: Math.round(
						SNAPSHOT_LIMITS.maxFileBytes / 1_048_576,
					),
					maxTotalMb: Math.round(
						SNAPSHOT_LIMITS.maxTotalBytes / 1_048_576,
					),
				},
			};
		default:
			return { key: `errors.${error}` };
	}
}

function orpcErrorCode(error: unknown): string | undefined {
	if (error && typeof error === "object" && "data" in error) {
		return (error as { data?: { code?: string } }).data?.code;
	}
	return undefined;
}

const INLINE_CONFIGURE_CODES = new Set([
	"BRANCH_NOT_FOUND",
	"REPOSITORY_CREDENTIALS_EXPIRED",
	"REPOSITORY_UNAVAILABLE",
	"REPOSITORY_NOT_FOUND",
	"INVALID_ROOT_PATH",
]);

/** `configure`'s typed `data.code` → a message, inline when the fix is in the form. */
export function configureErrorMessage(error: unknown): {
	key: string;
	inline: boolean;
} {
	const code = orpcErrorCode(error);
	if (code && INLINE_CONFIGURE_CODES.has(code)) {
		return { key: `configureDialog.errors.${code}`, inline: true };
	}
	if (code === "REPOSITORY_UNREACHABLE") {
		return {
			key: "configureDialog.errors.REPOSITORY_UNREACHABLE",
			inline: false,
		};
	}
	return { key: "configureDialog.errors.generic", inline: false };
}

export function syncNowResultMessage(result: SyncNowResult): {
	key: string;
	tone: "success" | "info" | "error";
} {
	if (result.started) {
		return { key: "syncNowResult.started", tone: "success" };
	}
	return {
		key: `syncNowResult.${result.reason}`,
		tone: result.reason === "already_running" ? "info" : "error",
	};
}
