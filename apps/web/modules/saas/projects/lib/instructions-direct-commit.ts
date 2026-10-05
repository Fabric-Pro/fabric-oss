/**
 * What "Commit to <branch>" needs on the page, as pure functions (Fizzy #2878
 * §10): the commit messages a file action starts from, what a polled snapshot
 * says became of the commit, and the words for each way it can end.
 *
 * The server answers `commitChange` at once with a snapshot id; the commit
 * itself happens after the secret scan, in a workflow. What the page learns,
 * it learns from that snapshot: `status` for the scan (REJECTED means nothing
 * was pushed) and `commitOutcome` for the push. Nothing here reads server
 * `message` text: every sentence is chosen by a code, so a provider's or a
 * proxy's wording never reaches the screen.
 */

import {
	DIRECT_COMMIT_MESSAGE_MAX_CHARS,
	DIRECT_COMMIT_SUBJECT_MAX_CHARS,
	directCommitOutcomeSchema,
} from "@repo/instructions";

/**
 * An address a provider reported, only when it is an https URL: the value came
 * from a provider's response, and a link must never run script.
 */
export function safeHttpsUrl(url: string | null | undefined): string | null {
	return url && /^https:\/\//i.test(url) ? url : null;
}

/** One change of a commit, as `instructions.commitChange` takes it. */
export type CommitChange =
	| {
			op: "put";
			path: string;
			content: string;
			encoding?: "utf8" | "base64";
	  }
	| { op: "delete"; path: string };

/** The last path segment: what a commit message names a file by. */
export function pathBasename(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/**
 * The message a commit starts from, as git users write them: `Update
 * <basename>` for an edit, `Add <path>`, `Delete <path>`, `Rename <old> to
 * <new>`. A starting point the person can change, never a value sent unseen.
 */
export function defaultCommitMessage(
	action:
		| { kind: "update" | "add" | "delete"; path: string }
		| { kind: "rename"; from: string; to: string },
): string {
	switch (action.kind) {
		case "update":
			return `Update ${pathBasename(action.path)}`;
		case "add":
			// Before a path is typed there is nothing to name yet.
			return action.path === "" ? "Add a file" : `Add ${action.path}`;
		case "delete":
			return `Delete ${action.path}`;
		case "rename":
			return `Rename ${action.from} to ${action.to}`;
		default: {
			const unreachable: never = action;
			return unreachable;
		}
	}
}

/**
 * The most file content one commit may carry, decoded: the server's own limit
 * for a change set sent inline (`MAX_INLINE_CHANGE_BYTES`). A bigger file is
 * refused here, with the way on, rather than as a rejected request.
 */
export const COMMIT_MAX_INLINE_BYTES = 2 * 1024 * 1024;

/** A file's bytes as base64, which is how a commit carries a file that may not be text. */
export async function fileToBase64(file: Blob): Promise<string> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	let binary = "";
	const chunk = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunk) {
		binary += String.fromCharCode(
			...bytes.subarray(offset, offset + chunk),
		);
	}
	return btoa(binary);
}

/** The first line of a commit message: what History and the header show of it. */
export function commitSubject(message: string): string {
	return message.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

/**
 * Why a message cannot be committed, previewed before anything is sent. The
 * server decides (and also refuses a message that looks like a credential,
 * which only it can say); these two it would refuse for certain.
 */
export function commitMessageProblem(
	message: string,
): "empty" | "tooLong" | null {
	const trimmed = message.trim();
	if (commitSubject(trimmed) === "") {
		return "empty";
	}
	if (
		trimmed.length > DIRECT_COMMIT_MESSAGE_MAX_CHARS ||
		commitSubject(trimmed).length > DIRECT_COMMIT_SUBJECT_MAX_CHARS
	) {
		return "tooLong";
	}
	return null;
}

/** The longest first line `commitMessageProblem` accepts, for the input's own limit. */
export const COMMIT_SUBJECT_MAX_CHARS = DIRECT_COMMIT_SUBJECT_MAX_CHARS;

/**
 * What became of a direct commit, from the snapshot the page polls. `rejected`
 * is the secret scan refusing the change before any push; the rest are the
 * server's recorded outcome (`directCommitOutcomeSchema`).
 */
export type SettledCommit =
	| { kind: "committed"; sha: string; ref: string }
	| { kind: "unchanged"; sha: string }
	| { kind: "pull-request"; reason: "protected" | "busy" }
	| { kind: "branch-moved" }
	| { kind: "failed"; code: string; retryable: boolean }
	| { kind: "rejected" };

/** The fields of a polled snapshot that decide whether its commit is over. */
export type CommitSnapshotRow = {
	status: string;
	commitOutcome?: unknown;
};

/**
 * The commit's result, or null while it is still pending: the scan running,
 * the push not yet made. An outcome this page does not know (a newer server)
 * reads as pending rather than as a guess; the poll's own bound ends the wait.
 */
export function settledCommit(row: CommitSnapshotRow): SettledCommit | null {
	if (row.status === "REJECTED") {
		return { kind: "rejected" };
	}
	if (row.status === "FAILED") {
		return { kind: "failed", code: "VALIDATION_FAILED", retryable: true };
	}
	const parsed = directCommitOutcomeSchema.safeParse(row.commitOutcome);
	if (!parsed.success) {
		return null;
	}
	const outcome = parsed.data;
	switch (outcome.outcome) {
		case "committed":
			return { kind: "committed", sha: outcome.sha, ref: outcome.ref };
		case "unchanged":
			return { kind: "unchanged", sha: outcome.sha };
		case "pull-request":
			return { kind: "pull-request", reason: outcome.reason };
		case "branch-moved":
			return { kind: "branch-moved" };
		case "failed":
			return {
				kind: "failed",
				code: outcome.code,
				retryable: outcome.retryable,
			};
		default: {
			const unreachable: never = outcome;
			return unreachable;
		}
	}
}

/** How often a pending commit is re-read, and for how long before the page stops waiting. */
export const COMMIT_POLL_MS = 2_000;
export const COMMIT_SLOW_POLL_MS = 10_000;
const COMMIT_FAST_WINDOW_MS = 60_000;
/**
 * The server records `VALIDATION_TIMEOUT` itself once its own deadline passes;
 * this is the page's, a little later, so a commit whose workflow never reports
 * does not leave a spinner on screen for ever.
 */
export const COMMIT_GIVE_UP_MS = 15 * 60_000;

/** The interval after `elapsedMs` of waiting, or false once the page stops waiting. */
export function commitPollInterval(elapsedMs: number): number | false {
	if (elapsedMs >= COMMIT_GIVE_UP_MS) {
		return false;
	}
	return elapsedMs < COMMIT_FAST_WINDOW_MS
		? COMMIT_POLL_MS
		: COMMIT_SLOW_POLL_MS;
}

/** The sentence for a commit that ended as `failed`, under `projects.codingInstructions.commit.failures`. */
export type CommitFailureKey =
	| "authentication"
	| "permission"
	| "configuration"
	| "branchMissing"
	| "tooLarge"
	| "timeout"
	| "validation"
	| "settle"
	| "stale"
	| "generic";

const FAILURE_KEY_BY_CODE: ReadonlyMap<string, CommitFailureKey> = new Map<
	string,
	CommitFailureKey
>([
	["AUTHENTICATION_FAILED", "authentication"],
	["PERMISSION_REVOKED", "permission"],
	["CONFIGURATION_CHANGED", "configuration"],
	["REPOSITORY_CHANGED", "configuration"],
	["TARGET_BRANCH_MISSING", "branchMissing"],
	["LIMITS_EXCEEDED", "tooLarge"],
	["VALIDATION_TIMEOUT", "timeout"],
	["VALIDATION_FAILED", "validation"],
	["SETTLE_FAILED", "settle"],
	["STALE", "stale"],
]);

export function commitFailureKey(code: string): CommitFailureKey {
	return FAILURE_KEY_BY_CODE.get(code) ?? "generic";
}

/**
 * Why `commitChange` itself was refused, before any commit existed. A code
 * from `data.reason` (never the server's text) mapped to a sentence under
 * `projects.codingInstructions.commit.refusals`, plus the field the person
 * should look at when the refusal is about one.
 */
export type CommitRefusal = {
	key:
		| "messageEmpty"
		| "messageTooLong"
		| "messageRejected"
		| "attribution"
		| "stale"
		| "notRepository"
		| "unavailable"
		| "proposerLimit"
		| "projectLimit";
	field: "message" | null;
};

const REFUSAL_BY_REASON: ReadonlyMap<string, CommitRefusal> = new Map<
	string,
	CommitRefusal
>([
	["MESSAGE_EMPTY", { key: "messageEmpty", field: "message" }],
	["MESSAGE_TOO_LONG", { key: "messageTooLong", field: "message" }],
	["MESSAGE_REJECTED", { key: "messageRejected", field: "message" }],
	["ATTRIBUTION_REJECTED", { key: "attribution", field: null }],
	["BASE_NOT_PUBLISHED", { key: "stale", field: null }],
	["NOTHING_PUBLISHED", { key: "stale", field: null }],
	["NOT_REPOSITORY_SOURCED", { key: "notRepository", field: null }],
	["REPOSITORY_UNAVAILABLE", { key: "unavailable", field: null }],
	["REPOSITORY_BASE_UNAVAILABLE", { key: "stale", field: null }],
	["REPOSITORY_SOURCE_OF_TRUTH", { key: "notRepository", field: null }],
	["COMMIT_PROPOSER_LIMIT", { key: "proposerLimit", field: null }],
	["COMMIT_PROJECT_LIMIT", { key: "projectLimit", field: null }],
]);

/** The refusal an error carries, or null when it is not one this knows (the shared error map then speaks). */
export function commitRefusal(error: unknown): CommitRefusal | null {
	if (!error || typeof error !== "object" || !("data" in error)) {
		return null;
	}
	const data = (error as { data?: unknown }).data;
	if (!data || typeof data !== "object" || !("reason" in data)) {
		return null;
	}
	const reason = (data as { reason?: unknown }).reason;
	return typeof reason === "string"
		? (REFUSAL_BY_REASON.get(reason) ?? null)
		: null;
}
