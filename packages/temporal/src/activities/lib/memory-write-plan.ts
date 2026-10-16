/**
 * What a Living Memory write does to the branch's tip, decided as ONE batch
 * (ADR-022). Admission could only judge a write statically; the tip says what
 * is actually at each path, and the folder's `.contextignore` at the tip says
 * what the sync would read back.
 *
 * The batch is atomic. Every path is judged against the tip; if any path
 * cannot be applied nothing is written, and the write ends with a verdict for
 * each path that could not: `CONFLICT` when at least one path changed under
 * the caller (its blob is not the one the caller saw, it exists when the
 * caller meant to create it, it is gone when the caller meant to replace or
 * delete it), `REFUSED` when the paths are ruled out whatever the caller knew
 * (left out by the folder's `.contextignore` at the tip, or not a file the
 * sync could write). A conflict carries the blob now at the path, so the
 * caller can read it and send the write again with a fresh `ifMatchOid`.
 *
 * The paths are judged against the tip as the sync reads it:
 *
 * - a PUT without `ifMatchOid` creates: the path must be absent;
 * - a PUT with `ifMatchOid` replaces: the path must hold exactly that blob;
 * - a DELETE removes: the path must hold exactly the blob it names;
 * - a PUT whose bytes are already what the path holds, under a matching
 *   `ifMatchOid`, is already done and writes nothing; when every path is
 *   already done the write ends `NO_CHANGE`;
 * - a new file is written `100644`; a replaced file keeps its mode.
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */
import { findContextIgnoreProblem } from "@repo/instructions/context-sync-rules";
import {
	isConflictVerdict,
	type MemoryWriteOutcome,
	type MemoryWritePathVerdict,
} from "../../lib/memory-write/outcome";
import {
	contextIgnorePathFor,
	ignorePolicyFromBytes,
} from "./context-sync-plan";
import {
	buildContextIgnoreRules,
	isAtOrUnderLeftOutKey,
	MAX_CONTEXT_IGNORE_BYTES,
	matchContextEntry,
	relativeToSelectedFolder,
} from "./context-sync-rules";
import type { BranchWritePlanEntry } from "./instruction-proposal-commit";
import { type GitCallBase, readBlobCapped } from "./instruction-sync-git";
import {
	ancestorsOf,
	type PathEntry,
	readPathEntries,
} from "./memory-write-git";

/** Git's mode for a regular file: the only entry a sync reads. */
const GIT_REGULAR_FILE_MODE = "100644";

/** One path of a write, with the object id its bytes hash to in the workspace. */
export type HashedWriteEntry = {
	path: string;
	op: "PUT" | "DELETE";
	ifMatchOid: string | null;
	/** The blob the PUT's bytes were written as; null for a DELETE. */
	blobOid: string | null;
};

/** The verdict on one path, if it cannot be applied. One per path: the first that applies. */
function verdictFor(
	entry: HashedWriteEntry,
	tip: ReadonlyMap<string, PathEntry | null>,
	excluded: (path: string) => boolean,
): MemoryWritePathVerdict | null {
	const { path } = entry;
	const current = tip.get(path) ?? null;
	const blocked =
		ancestorsOf(path).some((ancestor) => {
			const found = tip.get(ancestor) ?? null;
			return found !== null && found.type !== "tree";
		}) ||
		(current !== null && current.type !== "blob");
	if (blocked) {
		return { path, code: "PATH_NOT_A_FILE" };
	}
	if (excluded(path)) {
		return { path, code: "PATH_EXCLUDED" };
	}
	const currentOid = current?.oid ?? null;
	if (entry.op === "PUT" && entry.ifMatchOid === null) {
		return current === null
			? null
			: { path, code: "PATH_EXISTS", currentOid };
	}
	if (current === null) {
		return { path, code: "PATH_MISSING", currentOid: null };
	}
	return current.oid === entry.ifMatchOid
		? null
		: { path, code: "IF_MATCH_MISMATCH", currentOid };
}

/** Every path that cannot be applied to this tip, in the write's order. */
export function pathVerdicts(
	entries: readonly HashedWriteEntry[],
	tip: ReadonlyMap<string, PathEntry | null>,
	excluded: (path: string) => boolean,
): MemoryWritePathVerdict[] {
	return entries.flatMap((entry) => {
		const verdict = verdictFor(entry, tip, excluded);
		return verdict === null ? [] : [verdict];
	});
}

/**
 * The tree entries a write changes, for entries every one of which can be
 * applied: a PUT already holding its bytes is left out. Empty when there is
 * nothing to change.
 */
export function writePlanFor(
	entries: readonly HashedWriteEntry[],
	tip: ReadonlyMap<string, PathEntry | null>,
): BranchWritePlanEntry[] {
	const plan: BranchWritePlanEntry[] = [];
	for (const entry of entries) {
		if (entry.op === "DELETE") {
			plan.push({ rawPath: entry.path, after: null });
			continue;
		}
		const current = tip.get(entry.path) ?? null;
		if (entry.blobOid === null || current?.oid === entry.blobOid) {
			continue;
		}
		plan.push({
			rawPath: entry.path,
			after: {
				type: "blob",
				mode: current?.mode ?? GIT_REGULAR_FILE_MODE,
				oid: entry.blobOid,
			},
		});
	}
	return plan;
}

/** The outcome of a batch that cannot be applied: a conflict if any path changed under the caller, else a refusal. */
export function outcomeForVerdicts(
	verdicts: readonly MemoryWritePathVerdict[],
): MemoryWriteOutcome {
	return verdicts.some((verdict) => isConflictVerdict(verdict.code))
		? { status: "CONFLICT", paths: [...verdicts] }
		: { status: "REFUSED", code: "PATH_REFUSED", paths: [...verdicts] };
}

export type TipPlan =
	| { kind: "plan"; entries: BranchWritePlanEntry[]; fileCount: number }
	| { kind: "outcome"; outcome: MemoryWriteOutcome };

/**
 * Plans a write against `tip`: reads what stands at each path (and at each of
 * its folders, and at the selected folder's `.contextignore`) in one
 * `ls-tree`, applies the folder's ignore policy as the sync would, and judges
 * every path. `selected` is the sync's selected path the write folder sits
 * in; `leftOut` its member-left-out paths as they stand now.
 */
export async function planMemoryWriteAgainstTip(
	input: GitCallBase & {
		dir: string;
		tip: string;
		selected: string;
		leftOut: readonly string[];
		entries: readonly HashedWriteEntry[];
	},
): Promise<TipPlan> {
	const git = { dir: input.dir, env: input.env, signal: input.signal };
	const ignorePath = contextIgnorePathFor(input.selected);
	const paths = [
		...new Set([
			...input.entries.flatMap((entry) => [
				entry.path,
				...ancestorsOf(entry.path),
			]),
			ignorePath,
		]),
	];
	const tip = await readPathEntries({ ...git, sha: input.tip, paths });

	const policyEntry = tip.get(ignorePath) ?? null;
	let contextIgnore: string | null = null;
	if (policyEntry !== null) {
		const bytes =
			policyEntry.type === "blob"
				? await readBlobCapped({
						...git,
						oid: policyEntry.oid,
						maxBytes: MAX_CONTEXT_IGNORE_BYTES,
					})
				: null;
		const policy = ignorePolicyFromBytes(bytes);
		// An ignore file the sync cannot evaluate protects its folder: it writes
		// nothing under it, so nothing written there would be read back.
		if (
			policy.kind !== "file" ||
			findContextIgnoreProblem(policy.text) !== null
		) {
			return {
				kind: "outcome",
				outcome: {
					status: "REFUSED",
					code: "IGNORE_POLICY_UNREADABLE",
				},
			};
		}
		contextIgnore = policy.text;
	}
	const rules = buildContextIgnoreRules({ contextIgnore });
	const excluded = (path: string): boolean => {
		const relative = relativeToSelectedFolder(input.selected, path);
		return (
			isAtOrUnderLeftOutKey(path, input.leftOut) ||
			(relative !== null &&
				matchContextEntry(rules, relative, GIT_REGULAR_FILE_MODE) !==
					"kept")
		);
	};

	const verdicts = pathVerdicts(input.entries, tip, excluded);
	if (verdicts.length > 0) {
		return { kind: "outcome", outcome: outcomeForVerdicts(verdicts) };
	}
	const entries = writePlanFor(input.entries, tip);
	if (entries.length === 0) {
		return {
			kind: "outcome",
			outcome: { status: "REFUSED", code: "NO_CHANGE" },
		};
	}
	return { kind: "plan", entries, fileCount: entries.length };
}
