/**
 * The payload-shaped half of a derived instruction snapshot.
 *
 * Extracted from `derive-snapshot.ts` when a second caller — the inline
 * change-set behind the v1 REST route, the CLI's `fabric instructions push`
 * and the MCP proposal tool — had to make exactly the same decisions about
 * exactly the same change list. Two copies of these rules would silently
 * disagree about which paths a snapshot's frozen ignore rules exclude, and
 * the disagreement would show up as a browser edit and a CLI push producing
 * different snapshots from the same bytes.
 *
 * What lives here is everything that needs `@repo/instructions` and, at
 * most, the paths the caller already read from the base: the organization
 * template's planner takes them as plain input to decide which files are
 * missing. The base-shaped refusals stay inside
 * `createDerivedInstructionSnapshot`'s transaction, because a read taken out
 * here would answer about a moment that has already passed.
 */
import { ORPCError } from "@orpc/client";
import type {
	DerivedInstructionChange,
	DerivedInstructionRefusal,
} from "@repo/database";
import {
	buildIgnoreMatcher,
	classifyPath,
	collisionKey,
	createTreeCollisionGuard,
	describePortableNameRefusal,
	FABRIC_IGNORE_FILE,
	fileTypingFor,
	isSecretFileName,
	readFrozenIgnoreGlobs,
	SNAPSHOT_LIMITS,
	stagingKey,
	validatePortableName,
	validateRelativePath,
} from "@repo/instructions";

/**
 * The most paths one derivation may touch.
 *
 * The tab sends one change per action, and the CLI push this primitive is
 * shared with sends a diff. A cap belongs here anyway: every `put` becomes a
 * signed PUT and every change becomes a row, and an unbounded change set is a
 * way to build a snapshot that is nothing like the base it claims to derive
 * from — at which point re-uploading the folder is the honest operation, and
 * the one that re-resolves the project's live ignore settings.
 */
export const MAX_CHANGES = 50;

/**
 * The oRPC code and message for each refusal the database query can return.
 *
 * `base_not_found` is a 404 rather than a 403: a caller probing snapshot ids
 * across tenants learns only that there is nothing there.
 */
export function derivedSnapshotRefusal(
	reason: DerivedInstructionRefusal,
	detail: string | undefined,
): ORPCError<string, unknown> {
	switch (reason) {
		case "base_not_found":
			return new ORPCError("NOT_FOUND", {
				message: "That version is not available to edit",
			});
		case "base_not_ready":
			return new ORPCError("CONFLICT", {
				message:
					"That version has not finished its checks, so it cannot be edited yet",
			});
		case "base_not_published":
			// The losing side of a race the callers' own pre-reads cannot
			// see: both check the published pointer first and answer with
			// their own wording, so reaching this arm means a publish landed
			// between that read and the create transaction. Same shape, same
			// `reason`, so every surface that already branches on
			// `BASE_NOT_PUBLISHED` — including the v1 route, which re-labels
			// it `PULL_FIRST` — handles it with no new vocabulary. The
			// wording is direction-neutral and names no particular way of
			// refreshing, because the browser tab and the CLI reach it alike.
			return new ORPCError("CONFLICT", {
				message:
					"The published version changed while this change was being prepared. Take a fresh copy of the published version and make the change again.",
				data: { reason: "BASE_NOT_PUBLISHED" },
			});
		case "base_key_unexpected":
			// Never reachable from a well-formed READY snapshot: promotion
			// rewrites every row into the snapshot's own prefix. Surfaced
			// rather than swallowed, because it means a file row points at
			// storage no activity in this feature ever wrote it to.
			return new ORPCError("CONFLICT", {
				message:
					"That version's stored files are not in a state this edit can build on",
			});
		case "delete_path_missing":
			return new ORPCError("CONFLICT", {
				message: `That file is not in this version any more: ${detail}`,
			});
		case "path_collision":
			return new ORPCError("BAD_REQUEST", {
				message: `Two files would have the same name: ${detail}`,
			});
		case "path_tree_collision":
			// Same wording as the folder-upload procedure's refusal of the
			// same pair, so the two entry points describe one rule alike.
			return new ORPCError("BAD_REQUEST", {
				message: `A name cannot be both a file and a folder: ${detail}`,
			});
		case "empty_result":
			return new ORPCError("BAD_REQUEST", {
				message: "That would leave no files at all",
			});
		case "too_many_files":
			return new ORPCError("BAD_REQUEST", {
				message: `Too many files (${detail} > ${SNAPSHOT_LIMITS.maxFiles})`,
			});
		case "too_large":
			return new ORPCError("BAD_REQUEST", {
				message: `Too large (${detail} bytes > ${SNAPSHOT_LIMITS.maxTotalBytes})`,
			});
		case "proposal_proposer_limit":
			return new ORPCError("CONFLICT", {
				message:
					"You already have five active coding-instructions proposals for this project. Cancel one or wait for a decision before submitting another.",
				data: { reason: "PROPOSAL_PROPOSER_LIMIT" },
			});
		case "proposal_project_limit":
			return new ORPCError("CONFLICT", {
				message:
					"This project already has 25 active coding-instructions proposals. Try again after one is decided or canceled.",
				data: { reason: "PROPOSAL_PROJECT_LIMIT" },
			});
		case "commit_proposer_limit":
			return new ORPCError("CONFLICT", {
				message:
					"You already have five commits waiting to be pushed for this project. Wait for them to finish before committing again.",
				data: { reason: "COMMIT_PROPOSER_LIMIT" },
			});
		case "commit_project_limit":
			return new ORPCError("CONFLICT", {
				message:
					"This project already has 25 commits waiting to be pushed. Try again after some have finished.",
				data: { reason: "COMMIT_PROJECT_LIMIT" },
			});
		case "supersede_unavailable":
			return new ORPCError("CONFLICT", {
				message:
					"That proposal was decided or canceled, or another rebase of it is still being checked, so nothing was changed.",
				data: { reason: "REBASE_UNAVAILABLE" },
			});
	}
}

/** One change as the caller states it, before any path has been normalised. */
export type RawInstructionChange =
	| { op: "put"; path: string; size: number; sha256: string }
	| { op: "delete"; path: string };

export type ValidatedChangeSet = {
	changes: DerivedInstructionChange[];
	putCount: number;
	deleteCount: number;
};

/**
 * Turn a caller's change list into the rows `createDerivedInstructionSnapshot`
 * takes, refusing everything that can be decided from the payload alone.
 *
 * `settingsFrozen` is the BASE's, never the project's live settings: the
 * inherited files were admitted under those rules, a derivation copies the
 * column verbatim, and the validation gate checks the stored `.fabricignore`
 * still parses to exactly them. Re-resolving here would let a new file in that
 * the snapshot's own frozen rules exclude.
 *
 * Storage keys are ALWAYS server-generated: each `put` gets the provisional
 * `stagingKey(projectId, "pending", <index>)` that the upload step rewrites to
 * the real key once the file id exists.
 */
export function validateInstructionChanges(input: {
	projectId: string;
	changes: readonly RawInstructionChange[];
	settingsFrozen: unknown;
}): ValidatedChangeSet {
	const frozen = readFrozenIgnoreGlobs(input.settingsFrozen);
	// An unreadable frozen shape drops the snapshot's own rules, never the
	// always layer: `buildIgnoreMatcher` puts `ALWAYS_IGNORE_GLOBS` first
	// whatever the configurable layer holds.
	const isIgnored = buildIgnoreMatcher(
		frozen ?? { globs: [], layer: "default" },
	);

	const seen = new Set<string>();
	const changes: DerivedInstructionChange[] = [];
	let putCount = 0;
	let deleteCount = 0;
	for (const change of input.changes) {
		const v = validateRelativePath(change.path);
		if (!v.ok) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Path rejected (${v.reason}): ${change.path}`,
			});
		}
		// `collisionKey`, not `toLowerCase`: two spellings that differ only in
		// Unicode normalisation are ONE file on macOS, so a change set
		// carrying both would stage two rows and land one file.
		const key = collisionKey(v.path);
		if (seen.has(key)) {
			throw new ORPCError("BAD_REQUEST", {
				message: `The same file is changed twice: ${v.path}`,
			});
		}
		seen.add(key);
		if (v.path === FABRIC_IGNORE_FILE) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"The .fabricignore file decides what this version excludes, so it can only be changed by uploading the folder again.",
			});
		}
		if (change.op === "delete") {
			deleteCount++;
			changes.push({ op: "delete", path: v.path });
			continue;
		}
		const secretRule = isSecretFileName(v.path);
		if (secretRule) {
			// The gate would reject this after the upload and throw the
			// whole version away. Refusing on the name alone costs the
			// user nothing and stores nothing.
			throw new ORPCError("BAD_REQUEST", {
				message: `Fabric never stores credential files: ${v.path}`,
			});
		}
		const excluded = isIgnored(v.path);
		if (excluded) {
			throw new ORPCError("BAD_REQUEST", {
				message: `This version's rules leave that path out (${excluded.rule}): ${v.path}`,
			});
		}
		// Only a PUT, and only here — after the delete branch returned
		// above. A path already in the published version was admitted before
		// these rules existed and is inherited untouched; the one operation
		// that must still work on it is DELETE, which is how such a file gets
		// repaired. Refusing a delete for the name it is being deleted FOR
		// would leave it stuck in every future version.
		const portable = validatePortableName(v.path);
		if (!portable.ok) {
			throw new ORPCError("BAD_REQUEST", {
				message: describePortableNameRefusal(v.path, portable),
			});
		}
		if (change.size > SNAPSHOT_LIMITS.maxFileBytes) {
			throw new ORPCError("BAD_REQUEST", {
				message: `File too large (${change.size} bytes): ${v.path}`,
			});
		}
		changes.push({
			op: "put",
			path: v.path,
			size: change.size,
			sha256: change.sha256,
			...fileTypingFor(v.path),
			kind: classifyPath(v.path),
			// Provisional, like `begin`: the real key needs the snapshot
			// and file ids, which do not exist yet. The upload step
			// rewrites it under a compare-and-set before it is written to.
			storageKey: stagingKey(
				input.projectId,
				"pending",
				String(putCount),
			),
		});
		putCount++;
	}
	return { changes, putCount, deleteCount };
}

/** Why a file of the organization template was not added to a project. */
export type TemplateSkipReason =
	/** The project already has a file with that name: the project's own file wins. */
	| "exists"
	/** The name is a file on one side and a folder on the other. */
	| "tree_conflict"
	/** The project's ignore rules leave the path out. */
	| "excluded"
	/** The template's `.fabricignore`: the project's own rules decide what it excludes. */
	| "ignore_file"
	| "secret_name"
	| "invalid_path"
	| "non_portable"
	| "too_large";

type TemplateSkip = {
	path: string;
	reason: TemplateSkipReason;
	/** The ignore rule that matched, for `excluded` only. */
	rule?: string;
};

type TemplatePut = Extract<DerivedInstructionChange, { op: "put" }>;

/**
 * Which files of the organization template can be added to a project, as the
 * `put` rows a new version takes, and why each of the others was left out.
 *
 * The same payload checks `validateInstructionChanges` makes, with one
 * difference: a file that fails one is SKIPPED with its reason instead of
 * refusing the whole change. The template is a set of files offered to the
 * project, not a change the caller wrote, so one file the project's rules
 * leave out must not keep the rest from being added.
 *
 * The project wins every clash: a template path that is already one of
 * `existingPaths`, or that would be a file where the project has a folder (or
 * the reverse), is skipped. Existing paths are recorded in the tree guard
 * before any template file and their own collisions are ignored, because a
 * version admitted before these rules existed may hold such a pair and it is
 * not the template's to repair. The tree check runs last, so a file skipped
 * for another reason never reserves its name.
 *
 * `ignore` is the rule set the new version is admitted under: the base's
 * frozen rules when it derives from the published version, the project's live
 * rules when it is the project's first.
 */
export function planTemplateAdditions<
	T extends { path: string; size: number; sha256: string },
>(input: {
	projectId: string;
	files: readonly T[];
	existingPaths: readonly string[];
	ignore: { globs: string[]; layer: "fabricignore" | "project" | "default" };
}): {
	additions: Array<{ change: TemplatePut; source: T }>;
	skipped: TemplateSkip[];
} {
	const isIgnored = buildIgnoreMatcher(input.ignore);
	const tree = createTreeCollisionGuard();
	for (const path of input.existingPaths) {
		tree.add(path);
	}
	const additions: Array<{ change: TemplatePut; source: T }> = [];
	const skipped: TemplateSkip[] = [];
	for (const file of input.files) {
		const v = validateRelativePath(file.path);
		if (!v.ok) {
			skipped.push({ path: file.path, reason: "invalid_path" });
			continue;
		}
		if (v.path === FABRIC_IGNORE_FILE) {
			skipped.push({ path: v.path, reason: "ignore_file" });
			continue;
		}
		if (isSecretFileName(v.path)) {
			skipped.push({ path: v.path, reason: "secret_name" });
			continue;
		}
		const excluded = isIgnored(v.path);
		if (excluded) {
			skipped.push({
				path: v.path,
				reason: "excluded",
				rule: excluded.rule,
			});
			continue;
		}
		if (!validatePortableName(v.path).ok) {
			skipped.push({ path: v.path, reason: "non_portable" });
			continue;
		}
		if (file.size > SNAPSHOT_LIMITS.maxFileBytes) {
			skipped.push({ path: v.path, reason: "too_large" });
			continue;
		}
		const collision = tree.add(v.path);
		if (collision) {
			skipped.push({
				path: v.path,
				reason:
					collision.kind === "duplicate" ? "exists" : "tree_conflict",
			});
			continue;
		}
		additions.push({
			change: {
				op: "put",
				path: v.path,
				size: file.size,
				sha256: file.sha256,
				...fileTypingFor(v.path),
				kind: classifyPath(v.path),
				// Provisional, as in `validateInstructionChanges`.
				storageKey: stagingKey(
					input.projectId,
					"pending",
					String(additions.length),
				),
			},
			source: file,
		});
	}
	return { additions, skipped };
}
