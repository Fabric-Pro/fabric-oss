import { fileTypingFor } from "./file-typing";
import {
	buildIgnoreMatcher,
	type IgnoreLayer,
	type resolveIgnoreGlobs,
} from "./ignore";
import { classifyPath, type InstructionFileKind } from "./kinds";
import { SNAPSHOT_LIMITS } from "./limits";
import {
	createTreeCollisionGuard,
	type PathRejectReason,
	type PortableNameValidation,
	validatePortableName,
	validateRelativePath,
} from "./paths";

/**
 * Which files a new snapshot keeps, decided from paths (and sizes, when they
 * are known) alone.
 *
 * Extracted from `begin-snapshot.ts` so a browser upload and a repository
 * sync (spec §5.3.2 step 7) judge a tree by ONE implementation: the same
 * path validation, the same ignore layers, the same case/Unicode collision
 * key and file-versus-folder rule (`createTreeCollisionGuard`), the same
 * portability rule and the same caps, in the same order. Two
 * copies of this loop would disagree about some tree eventually, and the
 * disagreement would surface as a version that uploads but does not sync.
 *
 * The order is load-bearing and unchanged from `begin`: a path is validated,
 * then matched against the ignore rules, and only a KEPT path is judged for
 * collisions, portability and size. A repository routinely carries names a
 * Windows checkout cannot write inside folders the rules exclude, and judging
 * those first would refuse the whole tree over files it was never going to
 * contain.
 *
 * Refusals are returned as data, not thrown, and carry no message: the oRPC
 * procedure words them for a person, the sync activity maps them to its
 * closed error enum.
 *
 * `size` is optional because a repository sync plans BEFORE any blob is
 * fetched (tree objects carry no sizes). The byte caps then apply later, from
 * `lstat`, in the activity.
 */

/** The `{ globs, layer }` pair every caller resolves before planning. */
export type ResolvedIgnoreGlobs = ReturnType<typeof resolveIgnoreGlobs>;

export type PlanFileInput = { path: string; size?: number };

export type PlannedFile<T extends PlanFileInput> = {
	/** The caller's own entry, untouched (declared hash, repository path, git mode, ...). */
	source: T;
	/** The validated, normalised path the file row stores. */
	path: string;
	kind: InstructionFileKind;
	mimeType: string;
	isText: boolean;
};

export type PlanExclusion = { path: string; rule: string; layer: IgnoreLayer };

export type PlanLimits = {
	maxFiles: number;
	maxFileBytes: number;
	maxTotalBytes: number;
};

export type PlanRefusal =
	| { code: "invalid_path"; path: string; reason: PathRejectReason }
	| { code: "duplicate_path"; path: string }
	| {
			/**
			 * One name is a FILE for one kept path and a FOLDER for another
			 * (`docs` beside `docs/a.md`, compared by `collisionKey`). No
			 * checkout can write both. `conflictsWith` is the earlier kept path.
			 */
			code: "file_directory_conflict";
			path: string;
			conflictsWith: string;
	  }
	| {
			code: "non_portable_name";
			path: string;
			refusal: Extract<PortableNameValidation, { ok: false }>;
	  }
	| { code: "file_too_large"; path: string; size: number }
	| { code: "nothing_kept" }
	| { code: "too_many_files"; count: number; max: number }
	| { code: "total_too_large"; totalBytes: number; max: number };

export type PlanResult<T extends PlanFileInput> =
	| {
			ok: true;
			kept: PlannedFile<T>[];
			excluded: PlanExclusion[];
			totalBytes: number;
	  }
	| { ok: false; refusal: PlanRefusal };

export function planSnapshotFiles<T extends PlanFileInput>(input: {
	files: readonly T[];
	ignore: ResolvedIgnoreGlobs;
	limits?: PlanLimits;
}): PlanResult<T> {
	const limits = input.limits ?? SNAPSHOT_LIMITS;
	const isIgnored = buildIgnoreMatcher(input.ignore);
	const kept: PlannedFile<T>[] = [];
	const excluded: PlanExclusion[] = [];
	const tree = createTreeCollisionGuard();
	let totalBytes = 0;

	for (const file of input.files) {
		const v = validateRelativePath(file.path);
		if (!v.ok) {
			return {
				ok: false,
				refusal: {
					code: "invalid_path",
					path: file.path,
					reason: v.reason,
				},
			};
		}
		const match = isIgnored(v.path);
		if (match) {
			excluded.push({
				path: v.path,
				rule: match.rule,
				layer: match.layer,
			});
			continue;
		}
		// `collisionKey`, not `toLowerCase`: two spellings that differ only in
		// Unicode normalisation are ONE file on macOS. The same guard refuses
		// a name used as both a file and a folder (`docs` beside `docs/a.md`),
		// which no checkout can write at all. It is the guard the browser
		// preview runs, so the upload dialog, `begin` and a repository sync
		// all refuse the same trees.
		const collision = tree.add(v.path);
		if (collision?.kind === "duplicate") {
			return {
				ok: false,
				refusal: { code: "duplicate_path", path: v.path },
			};
		}
		if (collision?.kind === "file-directory") {
			return {
				ok: false,
				refusal: {
					code: "file_directory_conflict",
					path: collision.path,
					conflictsWith: collision.conflictsWith,
				},
			};
		}
		const portable = validatePortableName(v.path);
		if (!portable.ok) {
			return {
				ok: false,
				refusal: {
					code: "non_portable_name",
					path: v.path,
					refusal: portable,
				},
			};
		}
		if (file.size !== undefined) {
			if (file.size > limits.maxFileBytes) {
				return {
					ok: false,
					refusal: {
						code: "file_too_large",
						path: v.path,
						size: file.size,
					},
				};
			}
			totalBytes += file.size;
		}
		kept.push({
			source: file,
			path: v.path,
			kind: classifyPath(v.path),
			...fileTypingFor(v.path),
		});
	}
	if (kept.length === 0) {
		return { ok: false, refusal: { code: "nothing_kept" } };
	}
	if (kept.length > limits.maxFiles) {
		return {
			ok: false,
			refusal: {
				code: "too_many_files",
				count: kept.length,
				max: limits.maxFiles,
			},
		};
	}
	if (totalBytes > limits.maxTotalBytes) {
		return {
			ok: false,
			refusal: {
				code: "total_too_large",
				totalBytes,
				max: limits.maxTotalBytes,
			},
		};
	}
	return { ok: true, kept, excluded, totalBytes };
}
