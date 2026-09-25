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
	/**
	 * False for a run of a sync that was switched off (or switched off and
	 * set up again): its receipt outlives the configuration. History marks
	 * it; the status line leaves it out.
	 */
	fromCurrentConfiguration: boolean;
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
	/**
	 * The canonical `https://host/owner/name` clone URL (`get.ts` forwards
	 * `repositoryIntegration.repositoryUrl` unchanged; `parseRepoUrl`
	 * guarantees it carries no userinfo, query or fragment). What
	 * `localSetupRouteFor` below turns into the Connect dialog's
	 * `git clone` line for a repository-sourced project (Fizzy #2721).
	 */
	repositoryUrl: string;
	integrationStatus: string;
	ref: string;
	rootPath: string;
	automatic: boolean;
	automaticPausedReason: string | null;
	automaticPausedAt: string | Date | null;
	delegateName: string | null;
	/**
	 * Whether read-only members may propose changes as pull requests (Fizzy
	 * #2563 spec §12). Absent reads as off: the tab offers a reader nothing
	 * it has not been told it may do.
	 */
	allowReaderProposals?: boolean;
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
	/**
	 * Re-read everything a configuration change can move, resolving once
	 * those reads have settled. The settings section awaits it before it
	 * leaves its busy state (Decision 53).
	 */
	onChanged: () => Promise<void>;
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
/**
 * While automatic sync is on and not paused, the tab reads the sync state
 * once a minute even with no run open, so a run the scheduled check or a
 * push started, or a pause the check recorded, shows without a reload
 * (Decision 39).
 */
export const REPOSITORY_SYNC_IDLE_POLL_MS = 60_000;

/**
 * `refetchInterval` for `repositorySync.get`: every 3 s while a run is open,
 * every 60 s while automatic sync is on and not paused, and not at all
 * otherwise.
 */
export function repositorySyncPollInterval(
	state:
		| {
				running: boolean;
				configured?: {
					automatic: boolean;
					automaticPausedReason: string | null;
				} | null;
		  }
		| null
		| undefined,
): number | false {
	if (state?.running) {
		return REPOSITORY_SYNC_POLL_MS;
	}
	const configured = state?.configured;
	return configured?.automatic && !configured.automaticPausedReason
		? REPOSITORY_SYNC_IDLE_POLL_MS
		: false;
}

/**
 * The latest run changed between two reads: a run started and finished
 * without the tab seeing it open, or the scheduled check recorded a failure
 * receipt. `undefined` means not loaded yet, so the first read never counts;
 * `null` (no run yet) does, so a sync's first run is noticed.
 */
export function latestSyncRunChanged(
	seen: string | null | undefined,
	current: string | null | undefined,
): boolean {
	return seen !== undefined && current !== undefined && seen !== current;
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
 * them would send someone hunting in the wrong place. CLONE_FAILED promises
 * a retry only while one will actually happen: automatic sync on and not
 * paused, so the poll backs off and tries again (spec §7.3).
 */
export function syncErrorMessage(
	error: SyncErrorCode | null,
	configuration: {
		ref: string;
		rootPath: string;
		automatic?: boolean;
		automaticPausedReason?: string | null;
	} | null,
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
		case "CLONE_FAILED":
			return configuration?.automatic &&
				!configuration.automaticPausedReason
				? { key: "errors.CLONE_FAILED_RETRYING" }
				: { key: "errors.CLONE_FAILED" };
		default:
			return { key: `errors.${error}` };
	}
}

/**
 * The triggers this build has a label for (spec §6): "Sync now", the
 * scheduled check, a GitHub push, and a merged suggestion's pull request
 * (Fizzy #2563 spec §9).
 */
type SyncTrigger = "MANUAL" | "POLL" | "WEBHOOK" | "PULL_REQUEST_MERGED";

/**
 * History and the status line name what started each run (spec §7.3). The
 * switch is exhaustive over `SyncTrigger`: a trigger added there without a
 * case fails to compile at `unlabelledTrigger`. A value the server sends
 * that this build does not know, such as one a later migration adds to the
 * enum, renders the generic label instead of throwing (Decision 47).
 */
export function triggerLabelKey(
	trigger: string,
):
	| "triggers.MANUAL"
	| "triggers.POLL"
	| "triggers.WEBHOOK"
	| "triggers.PULL_REQUEST_MERGED"
	| "triggers.OTHER" {
	const known = trigger as SyncTrigger;
	switch (known) {
		case "MANUAL":
			return "triggers.MANUAL";
		case "POLL":
			return "triggers.POLL";
		case "WEBHOOK":
			return "triggers.WEBHOOK";
		case "PULL_REQUEST_MERGED":
			return "triggers.PULL_REQUEST_MERGED";
		default:
			return unlabelledTrigger(known);
	}
}

/** Compile-time exhaustiveness for `triggerLabelKey`; at run time, the generic label. */
function unlabelledTrigger(_trigger: never): "triggers.OTHER" {
	return "triggers.OTHER";
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

/* -------------------------------------------------------------------------- */
/* The Connect dialog's local-checkout route (Fizzy #2721)                    */
/*                                                                             */
/* `ConnectCliDialog`'s "keep the files in your checkout" block used to be a  */
/* single boolean: Fabric authors the files, or the CLI refuses the project   */
/* outright. A repository-sourced project now has a real command too — a      */
/* checkout of the repository the sync follows — so the gate is a discriminated */
/* route instead. Declared here, not in the dialog itself, so the tab and the */
/* empty state compute the SAME answer from the SAME state (mirrors why      */
/* `RepositorySyncState` and the outcome/message helpers above live here).   */
/* -------------------------------------------------------------------------- */

/** Which local-checkout route the Connect dialog offers, if any. */
export type LocalSetupRoute =
	| { kind: "upload" }
	| {
			kind: "repository";
			cloneUrl: string;
			/** The directory `git clone <cloneUrl>` creates. */
			directory: string;
			ref: string;
			/** The sync's root folder, normalised; `null` for "the checkout root". */
			rootPath: string | null;
	  };

/**
 * The last path segment of a clone URL, with a trailing `.git` removed —
 * the directory `git clone <cloneUrl>` creates. `null` when the URL has no
 * usable segment (empty, or a bare scheme/host with nothing after it), so the
 * caller falls back to the repository's own name.
 *
 * Reads the URL's `pathname` rather than splitting the raw string on `/`: the
 * scheme's own `//` (as in `https://`) is not a path separator, and a naive
 * split would misread a bare `https://host/` as ending in the segment `host`.
 * `repositoryUrl` is always `https://host/owner/name` in practice
 * (`parseRepoUrl` guarantees the shape on write), so `URL` never throws here;
 * the fallback below is defensive only.
 */
export function cloneDirectoryName(cloneUrl: string): string | null {
	const trimmed = cloneUrl.trim();
	if (!trimmed) {
		return null;
	}
	let pathname = trimmed;
	try {
		pathname = new URL(trimmed).pathname;
	} catch {
		// Not a URL the platform parser accepts — read the raw string as-is.
	}
	const withoutTrailingSlashes = pathname.replace(/\/+$/, "");
	const lastSlash = withoutTrailingSlashes.lastIndexOf("/");
	const segment =
		lastSlash === -1
			? withoutTrailingSlashes
			: withoutTrailingSlashes.slice(lastSlash + 1);
	const withoutGit = segment.replace(/\.git$/i, "").trim();
	return withoutGit.length > 0 ? withoutGit : null;
}

/** The last non-empty `/`-separated segment of `value`, or `value` itself. */
function lastPathSegment(value: string): string {
	const trimmed = value.trim().replace(/\/+$/, "");
	const lastSlash = trimmed.lastIndexOf("/");
	return lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
}

/**
 * `rootPath` as the sync configuration stores it, normalised for the
 * Connect dialog's `cd` line: `null` for "no subfolder" (empty, `"."`, or
 * `"/"`), otherwise stripped of leading/trailing slashes.
 */
function normalizeRootPath(rootPath: string): string | null {
	const trimmed = rootPath.trim().replace(/^\/+|\/+$/g, "");
	return trimmed === "" || trimmed === "." ? null : trimmed;
}

/**
 * Shell metacharacters that make an argument unsafe to paste unquoted into
 * the commands the Connect dialog prints: whitespace and
 * `` $ ` " ' ; & | < > ( ) * ? [ ] { } \ ! # ~ ``.
 */
const SHELL_METACHARACTERS = /[\s$`"';&|<>()*?[\]{}\\!#~]/;

/**
 * Wraps `value` in single quotes (with embedded single quotes escaped as
 * `'\''`) when it contains whitespace or a shell metacharacter; returns it
 * unchanged otherwise. The clone directory and the sync's root folder are the
 * only arguments in the repository setup commands this repo does not fully
 * control, since both come from data a repository owner chose.
 */
export function quoteShellArgIfNeeded(value: string): string {
	return SHELL_METACHARACTERS.test(value)
		? `'${value.replace(/'/g, "'\\''")}'`
		: value;
}

/**
 * Providers the CLI actually compares a checkout against. `init` classifies
 * Azure DevOps as an "unsupported provider" and refuses outright
 * (`docs/guides/coding-instructions-cli.md`, "Repository-sourced projects"),
 * so offering the repository route for it would be a "Recommended" command
 * that cannot succeed. `RepositoryProvider` in `schema.prisma` also has
 * `AZURE_DEVOPS`; an unrecognised future value is refused the same way,
 * matching the CLI's own closed set.
 */
const SUPPORTED_REPOSITORY_PROVIDERS = new Set(["GITHUB", "GITLAB"]);

/**
 * `false` for a checkout directory or root-folder segment that would break or
 * mislead the printed commands: empty, `.` (the shell would `cd` to nowhere
 * new) or `..` (a path escape). A leading `-` is deliberately NOT rejected
 * here — `buildRepositorySetupCommands`'s `--` terminators are what make that
 * safe, not this check.
 */
function isUsableCheckoutSegment(segment: string): boolean {
	return segment !== "" && segment !== "." && segment !== "..";
}

/** Whether any `/`-separated segment of `path` is literally `..`. */
function hasParentSegment(path: string): boolean {
	return path.split("/").some((segment) => segment === "..");
}

/**
 * Maps the tab's repository-sync state to the local-checkout route the
 * Connect dialog offers:
 *
 * - settings not yet confirmed (`repositoryBacked` while `!repositoryConfirmed`,
 *   which fails closed while they load or after they fail) → `null`;
 * - an upload project → `{ kind: "upload" }`;
 * - a repository project with a configured sync naming a repository on a
 *   provider the CLI compares against → the `git clone` route;
 * - a repository project with no configured sync, no clone URL, an
 *   unsupported provider, or a derived checkout directory/root folder the
 *   printed commands could not use safely → `null`. The CLI would refuse
 *   `init` in a checkout, or the block would be unsafe to paste, so offering
 *   it would send the reader to a refusal (or worse).
 */
export function localSetupRouteFor(args: {
	repositoryBacked: boolean;
	repositoryConfirmed: boolean;
	configured: RepositorySyncConfiguration | null;
}): LocalSetupRoute | null {
	const { repositoryBacked, repositoryConfirmed, configured } = args;
	if (repositoryBacked && !repositoryConfirmed) {
		return null;
	}
	if (!repositoryBacked) {
		return { kind: "upload" };
	}
	if (!configured || !configured.repositoryUrl) {
		return null;
	}
	if (!SUPPORTED_REPOSITORY_PROVIDERS.has(configured.provider)) {
		return null;
	}
	const directory =
		cloneDirectoryName(configured.repositoryUrl) ??
		lastPathSegment(configured.repositoryName);
	if (!isUsableCheckoutSegment(directory)) {
		return null;
	}
	const rootPath = normalizeRootPath(configured.rootPath);
	if (rootPath !== null && hasParentSegment(rootPath)) {
		return null;
	}
	return {
		kind: "repository",
		cloneUrl: configured.repositoryUrl,
		directory,
		ref: configured.ref,
		rootPath,
	};
}
