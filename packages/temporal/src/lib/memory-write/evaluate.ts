/**
 * What admission says about one proposed Living Memory write (ADR-022).
 * Pure: it is handed a snapshot of the facts it judges, reads nothing and
 * writes nothing, so every refusal is testable without a database.
 *
 * Only STATIC checks live here: the project's mode, the sync's state, the
 * caller's rights, the target against the sync as configured now, each path and
 * its bytes, a secret scan, and the sync's headroom. Nothing here reads the
 * repository. What depends on the branch tip, whether a path is created or
 * replaced (`ifMatchOid`), the folder's `.contextignore` at the tip, and
 * per-path conflicts, is the write workflow's, because the tip can move after
 * admission anyway.
 *
 * The message is judged in the form the commit will carry (`MESSAGE_INVALID`):
 * a credential in it, or a line that spells one of Fabric's own commit
 * trailers, is refused, since the trailers are how a retry finds its commit.
 *
 * Every problem is reported, not the first: an agent fixes a whole request in
 * one round. A problem about the whole request carries no `path`. A secret hit
 * names the rule that fired and never the text that matched. A path with a
 * dot-prefixed segment below the target folder is `PATH_HIDDEN` and nothing
 * else (a `.contextignore` is `POLICY_FILE` alone): CI and tool configuration
 * must never be agent-writable, so there is nothing more to say about it.
 *
 * The digest is the request's identity: the same project, target version,
 * message and entries digest alike whatever order the entries came in, and
 * whether a file's bytes came inline or staged, so `submit` can recognise a
 * retry. It does not cover who asked.
 */
import { createHash } from "node:crypto";
import type { ContextWriteMode } from "@repo/database";
import {
	contextSyncPathSpellingProblem,
	isContextIgnorePolicyFile,
	MAX_CONTEXT_SYNC_PATH_LENGTH,
} from "@repo/instructions/context-sync-rules";
import {
	hasReservedTrailerLine,
	normaliseCommitMessage,
} from "@repo/instructions/pull-request-text";
import { scanTextForSecrets } from "@repo/instructions/secrets";
import { MAX_CONTEXT_SYNC_KEPT } from "../../activities/lib/context-sync-plan";
import {
	buildContextIgnoreRules,
	classifyContextBytes,
	contextStorageKey,
	hasTextExtension,
	isAtOrUnderLeftOutKey,
	matchContextEntry,
	relativeToSelectedFolder,
} from "../../activities/lib/context-sync-rules";
import {
	checkWriteTargetFolder,
	selectedPathContaining,
	type WriteTargetSelection,
} from "./target-rules";

export const MAX_MEMORY_WRITE_ENTRIES = 50;
export const MAX_MEMORY_WRITE_MESSAGE_LENGTH = 5_000;
const MAX_MEMORY_WRITE_SUBJECT_LENGTH = 300;

/** Git's mode for a regular file: the only entry a sync reads. */
const GIT_REGULAR_FILE_MODE = "100644";
/** SHA-1 and SHA-256 object ids. */
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Distinct secret rules reported for one file; the rest are only counted. */
const SECRET_RULES_REPORTED_PER_FILE = 5;

type MemoryWriteOp = "PUT" | "DELETE";

export type MemoryWriteEntryInput = {
	/** Repository-relative, canonical, strictly inside the target folder. */
	path: string;
	op: MemoryWriteOp;
	/** UTF-8 text; PUT only. */
	content?: string;
	/** The blob id the caller last saw at this path. */
	ifMatchOid?: string;
};

/**
 * The closed vocabulary of admission's problems. `evaluateMemoryWrite` reports
 * the static ones; the last group is about the bytes a write carries, which
 * only the caller that reads them can judge (`submit`): the file is both
 * inline and staged, the staged file is named wrongly or is not the file the
 * write described, or the request as a whole is too large.
 */
type MemoryWriteProblemCode =
	| "READ_ONLY_MODE"
	| "MESSAGE_INVALID"
	| "SYNC_NOT_INGESTING"
	| "SYNC_DELEGATE_LOST_PERMISSION"
	| "TARGET_NOT_FOUND"
	| "TARGET_STALE"
	| "INVALID_PATH"
	| "PATH_OUTSIDE_TARGET"
	| "DUPLICATE_PATH"
	| "POLICY_FILE"
	| "PATH_HIDDEN"
	| "PATH_EXCLUDED"
	| "UNSUPPORTED_EXTENSION"
	| "PATH_TOO_LONG"
	| "CONTENT_REQUIRED"
	| "CONTENT_EMPTY"
	| "CONTENT_TOO_LARGE"
	| "CONTENT_NOT_TEXT"
	| "DELETE_HAS_CONTENT"
	| "DELETE_REQUIRES_IF_MATCH"
	| "IF_MATCH_INVALID"
	| "SECRET_DETECTED"
	| "SYNC_LIMIT_EXCEEDED"
	| "CONTENT_AMBIGUOUS"
	| "STAGED_OBJECT_INVALID"
	| "STAGED_OBJECT_MISSING"
	| "STAGED_OBJECT_MISMATCH"
	| "REQUEST_TOO_LARGE";

export type MemoryWriteProblem = {
	path?: string;
	code: MemoryWriteProblemCode;
	/** A reason word, a rule id or a number. Never content. */
	detail?: string;
};

type MemoryWriteTargetView = {
	id: string;
	version: number;
	folder: string;
	mode: ContextWriteMode;
	ref: string;
};

/** The facts admission judges, read once by the caller. */
export type MemoryWriteSnapshot = {
	readOnlyMode: boolean;
	sync: {
		userId: string;
		ref: string;
		paths: readonly string[];
		excludedPaths: readonly string[];
		automatic: boolean;
		automaticPausedReason: string | null;
	} | null;
	/** Whether `sync.userId`, who automatic runs act as, can still create. */
	delegateHoldsContextCreate: boolean;
	/** The target, only if it belongs to the sync. */
	target: {
		id: string;
		version: number;
		folder: string;
		mode: ContextWriteMode;
	} | null;
	/** Roots of coding-instructions syncs on the sync's repository integration. */
	instructionRoots: readonly string[];
	/** Rows the sync manages now. */
	managedCount: number;
	/** The PUT paths' storage keys that already have a managed row. */
	managedKeys: ReadonlySet<string>;
};

export type MemoryWriteValidation = {
	ok: boolean;
	/** Null only when the target could not be resolved. */
	digest: string | null;
	target: MemoryWriteTargetView | null;
	problems: MemoryWriteProblem[];
};

export type MemoryWriteRequest = {
	projectId: string;
	targetId: string;
	message: string;
	entries: readonly MemoryWriteEntryInput[];
};

function sha256Hex(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The request's identity (file comment). Entries are sorted by path and carry
 * the content's hash, never the content, as `gitIntentDigest` does for
 * coding-instruction changes.
 */
export function memoryWriteDigest(input: {
	projectId: string;
	targetId: string;
	targetVersion: number;
	message: string;
	entries: readonly MemoryWriteEntryInput[];
}): string {
	const entries = [...input.entries]
		.sort((left, right) =>
			left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
		)
		.map((entry) => ({
			path: entry.path,
			op: entry.op,
			sha256:
				entry.op === "PUT" && entry.content !== undefined
					? sha256Hex(new TextEncoder().encode(entry.content))
					: null,
			ifMatchOid: entry.ifMatchOid ?? null,
		}));
	return sha256Hex(
		JSON.stringify({
			projectId: input.projectId,
			targetId: input.targetId,
			targetVersion: input.targetVersion,
			message: input.message,
			entries,
		}),
	);
}

function messageProblem(message: string): MemoryWriteProblem | null {
	if (message.trim().length === 0) {
		return { code: "MESSAGE_INVALID", detail: "empty" };
	}
	if (message.length > MAX_MEMORY_WRITE_MESSAGE_LENGTH) {
		return { code: "MESSAGE_INVALID", detail: "too-long" };
	}
	const subject = message.split(/\r?\n/, 1)[0] ?? "";
	if (subject.length > MAX_MEMORY_WRITE_SUBJECT_LENGTH) {
		return { code: "MESSAGE_INVALID", detail: "subject-too-long" };
	}
	// What the commit will carry: judged in that form, so nothing hides in what
	// normalising removes.
	const carried = normaliseCommitMessage(message);
	if (hasReservedTrailerLine(carried)) {
		return { code: "MESSAGE_INVALID", detail: "reserved-trailer" };
	}
	if (scanTextForSecrets(carried).length > 0) {
		return { code: "MESSAGE_INVALID", detail: "secret" };
	}
	return null;
}

/** How a path is spelled: usable, too long to be a storage key, or not canonical. */
function pathSpelling(path: string): "ok" | "too-long" | "invalid" {
	if (path.length > MAX_CONTEXT_SYNC_PATH_LENGTH) {
		return "too-long";
	}
	const key = contextStorageKey(path);
	if (!key.ok) {
		return key.detail === "too-long" ? "too-long" : "invalid";
	}
	return contextSyncPathSpellingProblem(path) === null &&
		key.storageKey === path
		? "ok"
		: "invalid";
}

function contentProblems(entry: MemoryWriteEntryInput): MemoryWriteProblem[] {
	const { path } = entry;
	if (entry.op === "DELETE") {
		return entry.content === undefined
			? []
			: [{ path, code: "DELETE_HAS_CONTENT" }];
	}
	if (entry.content === undefined) {
		return [{ path, code: "CONTENT_REQUIRED" }];
	}
	const classified = classifyContextBytes(
		new TextEncoder().encode(entry.content),
	);
	if (!classified.ok) {
		return [{ path, code: contentRefusalCode(classified.reason) }];
	}
	const { hits } = scanTextForSecrets(classified.content, {
		limit: SECRET_RULES_REPORTED_PER_FILE * 4,
	});
	return [...new Set(hits.map((hit) => hit.rule))]
		.slice(0, SECRET_RULES_REPORTED_PER_FILE)
		.map((rule) => ({ path, code: "SECRET_DETECTED", detail: rule }));
}

function contentRefusalCode(
	reason: "binary" | "empty" | "too-large",
): MemoryWriteProblemCode {
	switch (reason) {
		case "binary":
			return "CONTENT_NOT_TEXT";
		case "empty":
			return "CONTENT_EMPTY";
		case "too-large":
			return "CONTENT_TOO_LARGE";
	}
}

function pathProblems(
	path: string,
	spelling: ReturnType<typeof pathSpelling>,
	folder: string,
	selection: WriteTargetSelection,
	rules: ReturnType<typeof buildContextIgnoreRules>,
): MemoryWriteProblem[] {
	if (spelling === "too-long") {
		return [{ path, code: "PATH_TOO_LONG" }];
	}
	if (spelling === "invalid") {
		return [{ path, code: "INVALID_PATH" }];
	}
	const belowFolder = relativeToSelectedFolder(folder, path);
	if (belowFolder === null) {
		return [{ path, code: "PATH_OUTSIDE_TARGET" }];
	}
	// A folder's `.contextignore` is reported as the policy file it is, not
	// also as hidden. Any other dot-prefixed segment below the folder is CI or
	// tool configuration (or a hidden file), which agents never write; nothing
	// else about such a path is worth reporting.
	if (isContextIgnorePolicyFile(path)) {
		return [{ path, code: "POLICY_FILE" }];
	}
	if (belowFolder.split("/").some((segment) => segment.startsWith("."))) {
		return [{ path, code: "PATH_HIDDEN" }];
	}

	const problems: MemoryWriteProblem[] = [];
	if (!hasTextExtension(path)) {
		problems.push({ path, code: "UNSUPPORTED_EXTENSION" });
	}
	const selected = selectedPathContaining(selection, path);
	const relative =
		selected === null ? null : relativeToSelectedFolder(selected, path);
	if (
		isAtOrUnderLeftOutKey(path, selection.excludedPaths) ||
		(relative !== null &&
			matchContextEntry(rules, relative, GIT_REGULAR_FILE_MODE) !==
				"kept")
	) {
		problems.push({ path, code: "PATH_EXCLUDED" });
	}
	return problems;
}

function conditionProblems(entry: MemoryWriteEntryInput): MemoryWriteProblem[] {
	const { path, ifMatchOid } = entry;
	if (ifMatchOid !== undefined && !OBJECT_ID.test(ifMatchOid)) {
		return [{ path, code: "IF_MATCH_INVALID" }];
	}
	if (entry.op === "DELETE" && ifMatchOid === undefined) {
		return [{ path, code: "DELETE_REQUIRES_IF_MATCH" }];
	}
	return [];
}

/** Every static problem with this request, in the order a person fixes them. */
export function evaluateMemoryWrite(
	snapshot: MemoryWriteSnapshot,
	request: MemoryWriteRequest,
): MemoryWriteValidation {
	const problems: MemoryWriteProblem[] = [];

	if (snapshot.readOnlyMode) {
		problems.push({ code: "READ_ONLY_MODE" });
	}
	const message = messageProblem(request.message);
	if (message) {
		problems.push(message);
	}

	const { sync, target } = snapshot;
	if (sync === null) {
		problems.push({ code: "SYNC_NOT_INGESTING", detail: "not-configured" });
	} else {
		if (!sync.automatic) {
			problems.push({
				code: "SYNC_NOT_INGESTING",
				detail: "automatic-off",
			});
		} else if (sync.automaticPausedReason !== null) {
			problems.push({
				code: "SYNC_NOT_INGESTING",
				detail: sync.automaticPausedReason,
			});
		}
		if (!snapshot.delegateHoldsContextCreate) {
			problems.push({ code: "SYNC_DELEGATE_LOST_PERMISSION" });
		}
	}

	if (sync === null || target === null) {
		if (sync !== null) {
			problems.push({ code: "TARGET_NOT_FOUND" });
		}
		return { ok: false, digest: null, target: null, problems };
	}

	const selection: WriteTargetSelection = {
		paths: sync.paths,
		excludedPaths: sync.excludedPaths,
	};
	const stale = checkWriteTargetFolder({
		folder: target.folder,
		selection,
		instructionRoots: snapshot.instructionRoots,
	});
	if (stale) {
		problems.push({ code: "TARGET_STALE", detail: stale.code });
	}

	const rules = buildContextIgnoreRules();
	const seen = new Set<string>();
	const duplicated = new Set<string>();
	for (const entry of request.entries) {
		if (seen.has(entry.path)) {
			duplicated.add(entry.path);
		}
		seen.add(entry.path);
	}
	for (const path of duplicated) {
		problems.push({ path, code: "DUPLICATE_PATH" });
	}

	const newKeys = new Set<string>();
	for (const entry of request.entries) {
		const spelling = pathSpelling(entry.path);
		problems.push(
			...pathProblems(
				entry.path,
				spelling,
				target.folder,
				selection,
				rules,
			),
			...conditionProblems(entry),
			...contentProblems(entry),
		);
		if (
			entry.op === "PUT" &&
			spelling === "ok" &&
			!snapshot.managedKeys.has(entry.path)
		) {
			newKeys.add(entry.path);
		}
	}

	// The sync keeps at most this many files (`MAX_CONTEXT_SYNC_KEPT`); a run
	// that finds more fails. The run also bounds the bytes it reads (50 MiB), and
	// it enforces that bound itself: the stored size of what is managed is not
	// cheap to total here, so admission checks the count only.
	if (snapshot.managedCount + newKeys.size > MAX_CONTEXT_SYNC_KEPT) {
		problems.push({
			code: "SYNC_LIMIT_EXCEEDED",
			detail: String(MAX_CONTEXT_SYNC_KEPT),
		});
	}

	return {
		ok: problems.length === 0,
		digest: memoryWriteDigest({
			projectId: request.projectId,
			targetId: target.id,
			targetVersion: target.version,
			message: request.message,
			entries: request.entries,
		}),
		target: {
			id: target.id,
			version: target.version,
			folder: target.folder,
			mode: target.mode,
			ref: sync.ref,
		},
		problems,
	};
}
