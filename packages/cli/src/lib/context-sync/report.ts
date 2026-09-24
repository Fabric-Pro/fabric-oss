/**
 * The words and the JSON a `fabric context push` prints.
 *
 * Grouped by outcome with a count on each group, one line per file for every
 * outcome except `unchanged`, which is only counted: a folder of two hundred
 * notes where one changed should read as one line and a count.
 *
 * A move reads `old -> new`. A move the server answered without renaming is
 * listed under `not moved`, saying what happened to each path (including a
 * server that does not support moves yet), and a `--prune` run adds `deleted`,
 * `already gone` and `deletion still running` (the server had not finished
 * when it answered; run again to confirm); its conflicts and failures join
 * the push's under `conflict` and `failed`, each line saying "not deleted",
 * and a path it set out to delete but never reached is listed under
 * `removed` with its server entry kept (Fizzy #2636).
 */
import type { SkippedContextFile } from "./classify.js";
import type { ContextPlan } from "./plan.js";
import { type ContextPushResult, DELETE_STATUSES } from "./push.js";

type ResultOf<S extends ContextPushResult["status"]> = Extract<
	ContextPushResult,
	{ status: S }
>;

export interface ContextPushCounts {
	created: number;
	updated: number;
	unchanged: number;
	duplicate: number;
	moved: number;
	/** Moves a server without move support could not apply. */
	moveUnsupported: number;
	conflict: number;
	changedDuringRun: number;
	failed: number;
	removed: number;
	skipped: number;
	/** `--prune` only; zero otherwise. */
	deleted: number;
	alreadyGone: number;
	/** Still running on the server when it answered: not deleted yet. */
	deleteInProgress: number;
	deleteConflict: number;
	deleteFailed: number;
}

/**
 * A `repository-managed` result, recast as a `SkippedContextFile` (Living
 * Memory design 2026-09-23 §6): it is decided after the send, not by the
 * planner, but it is reported through the same `skipped` group and count as
 * the reasons the planner decides before sending. The server's own sentence
 * is the line, carried as `detail` — see `skippedLine`.
 */
function managedSkips(
	results: readonly ContextPushResult[],
): SkippedContextFile[] {
	return results
		.filter(
			(
				r,
			): r is Extract<
				ContextPushResult,
				{ status: "repository-managed" }
			> => r.status === "repository-managed",
		)
		.map((r) => ({
			path: r.sourcePath,
			reason: "repository-managed" as const,
			detail: r.message,
		}));
}

function countOutcomes(
	plan: ContextPlan,
	results: readonly ContextPushResult[],
): ContextPushCounts {
	const count = (status: ContextPushResult["status"]) =>
		results.filter((r) => r.status === status).length;
	return {
		created: count("created"),
		updated: count("updated"),
		unchanged: count("unchanged") + plan.unchangedLocal.length,
		duplicate: count("duplicate"),
		moved: count("moved"),
		moveUnsupported: count("move-unsupported"),
		conflict: count("conflict"),
		changedDuringRun: count("changed-during-run"),
		failed: count("failed"),
		removed: plan.removed.length,
		skipped: plan.skipped.length + managedSkips(results).length,
		deleted: count("deleted"),
		alreadyGone: count("already-gone"),
		deleteInProgress: count("delete-in-progress"),
		deleteConflict: count("delete-conflict"),
		deleteFailed: count("delete-failed"),
	};
}

function who(current: { contentUpdatedBy: { name: string | null } | null }) {
	return current.contentUpdatedBy?.name ?? "someone";
}

function when(current: { contentUpdatedAt: string | null }) {
	return current.contentUpdatedAt ?? "an unknown time";
}

/** A conflict about a move's old path: that file changed on the server. */
function moveSourceConflictLine(
	result: ResultOf<"conflict">,
	from: string,
): string {
	const { current } = result;
	if (current === null) {
		return `${from}: deleted on the server since your last push; not moved to ${result.sourcePath}`;
	}
	let text = result.afterForce
		? `changed on the server again by ${who(current)} at ${when(current)} while --force was moving it`
		: `changed on the server by ${who(current)} at ${when(current)} since your last push`;
	if (current.contentHash === null) {
		text += "; that version has no content hash, so --force cannot move it";
	}
	return `${from}: ${text}; not moved to ${result.sourcePath}`;
}

function conflictLine(result: ResultOf<"conflict">): string {
	if (result.movedFrom !== undefined) {
		if (result.moveNotApplied === "source-changed") {
			return moveSourceConflictLine(result, result.movedFrom);
		}
		// The old row is gone: its lock entry is dropped, so the next run
		// sends the new path as an ordinary file rather than this move again.
		if (result.moveNotApplied === "source-missing") {
			return `${pushConflictLine(result)}; ${result.movedFrom} gone on the server`;
		}
		return `${pushConflictLine(result)}; ${result.movedFrom} not moved`;
	}
	return pushConflictLine(result);
}

function pushConflictLine(result: ResultOf<"conflict">): string {
	const { current } = result;
	if (current === null) {
		return `${result.sourcePath}: deleted on the server since your last push`;
	}
	let text: string;
	if (result.afterForce) {
		text = `changed on the server again by ${who(current)} at ${when(current)} while --force was replacing it`;
	} else if (result.wasLocked) {
		text = `changed on the server by ${who(current)} at ${when(current)} since your last push`;
	} else {
		text = `already on the server with different content, last changed by ${who(current)} at ${when(current)}`;
	}
	if (current.contentHash === null) {
		text +=
			"; that version has no content hash, so --force cannot replace it";
	}
	return `${result.sourcePath}: ${text}`;
}

function deleteConflictLine(result: ResultOf<"delete-conflict">): string {
	const { current } = result;
	let text = result.afterForce
		? `changed on the server again by ${who(current)} at ${when(current)} while --force was deleting it`
		: `changed on the server by ${who(current)} at ${when(current)} since your last push`;
	if (current.contentHash === null) {
		text +=
			"; that version has no content hash, so --force cannot delete it";
	}
	return `${result.sourcePath}: ${text}; not deleted`;
}

function storedLine(result: ResultOf<"created" | "updated" | "unchanged">) {
	if (result.overwrote) {
		return `${result.sourcePath}: replaced the version ${who(result.overwrote)} changed at ${when(result.overwrote)} (--force)`;
	}
	return result.sourcePath;
}

type MoveFallback = ResultOf<"created" | "updated" | "unchanged" | "duplicate">;

/** A move's result that stored the new path without renaming the old one. */
function isMoveFallback(result: ContextPushResult): result is MoveFallback {
	return (
		(result.status === "created" ||
			result.status === "updated" ||
			result.status === "unchanged" ||
			result.status === "duplicate") &&
		result.movedFrom !== undefined
	);
}

/**
 * What a move the server did not apply did to each path. The old path is
 * `kept` — its row and its lock entry — unless the server had none, or
 * `--prune` is about to decide it below.
 */
function moveFallbackLine(result: MoveFallback, prune: boolean): string {
	const from = result.movedFrom ?? "";
	const to = result.sourcePath;
	let pushed: string;
	if (result.status === "duplicate") {
		pushed = `${to} pushed as a duplicate of ${result.duplicateOfSourcePath ?? "another source in this project"}`;
	} else if (result.overwrote) {
		pushed = `${to} replaced the version ${who(result.overwrote)} changed at ${when(result.overwrote)} (--force)`;
	} else {
		pushed = `${to} pushed as ${result.status}`;
	}
	const kept = prune ? "" : `; ${from} kept`;
	switch (result.moveNotApplied) {
		case "source-missing":
			return `${from}: gone on the server; ${pushed}`;
		case "target-exists":
			return `${from}: not moved, ${to} is already on the server; ${pushed}${kept}`;
		case "content-differs":
			return `${from}: not moved, the server's version of it differs from ${to}; ${pushed}${kept}`;
		default:
			return `${from}: not moved; ${pushed}${kept}`;
	}
}

function skippedLine(skip: SkippedContextFile): string {
	if (skip.reason === "ignored") {
		return `${skip.path}: now excluded by the ignore rules; server entry kept`;
	}
	if (skip.reason === "repository-managed") {
		// `detail` already carries the server's whole sentence, which names
		// the path itself — nothing to prefix.
		return skip.detail ?? `${skip.path}: repository-managed`;
	}
	return skip.detail
		? `${skip.path}: ${skip.reason} (${skip.detail})`
		: `${skip.path}: ${skip.reason}`;
}

function group(lines: string[], label: string, items: readonly string[]) {
	if (items.length === 0) {
		return;
	}
	lines.push(`${label} (${items.length})`);
	for (const item of items) {
		lines.push(`  ${item}`);
	}
}

/** The text report for a push that was sent. */
export function formatPushReport(input: {
	projectId: string;
	directory: string;
	plan: ContextPlan;
	results: readonly ContextPushResult[];
	/** `--prune` was given: removed paths are reported by what it did. */
	prune?: boolean;
	/**
	 * With `--prune`, every path it set out to delete (`ContextPushRun`), so
	 * one a stopped run never reached, including the kept old path of a move
	 * the server declined, is still listed.
	 */
	pruneTargets?: readonly string[];
}): string[] {
	const { plan, results } = input;
	const prune = Boolean(input.prune);
	// A move the server did not apply is listed once, under `not moved`.
	const of = <S extends ContextPushResult["status"]>(status: S) =>
		results.filter(
			(r): r is ResultOf<S> => r.status === status && !isMoveFallback(r),
		);

	const lines = [
		`Context push from ${input.directory} to project ${input.projectId}:`,
	];
	group(lines, "created", of("created").map(storedLine));
	group(lines, "updated", of("updated").map(storedLine));
	group(
		lines,
		"moved",
		of("moved").map((r) => `${r.movedFrom} -> ${r.sourcePath}`),
	);
	group(lines, "not moved", [
		...results
			.filter(isMoveFallback)
			.map((r) => moveFallbackLine(r, prune)),
		...of("move-unsupported").map(
			(r) =>
				`${r.movedFrom} -> ${r.sourcePath}: the server does not support moves yet; ${r.movedFrom} kept, ${r.sourcePath} not pushed`,
		),
	]);
	group(
		lines,
		"duplicate",
		of("duplicate").map(
			(r) =>
				`${r.sourcePath}: duplicate of ${r.duplicateOfSourcePath ?? "another source in this project"}`,
		),
	);
	group(lines, "conflict", [
		...of("conflict").map(conflictLine),
		...of("delete-conflict").map(deleteConflictLine),
	]);
	group(
		lines,
		"changed during the run",
		of("changed-during-run").map(
			(r) =>
				`${r.sourcePath}: changed-during-run; not sent, the next push sends the new content`,
		),
	);
	group(lines, "failed", [
		...of("failed").map((r) => `${r.sourcePath}: ${r.error}`),
		...of("delete-failed").map(
			(r) => `${r.sourcePath}: ${r.error}; not deleted`,
		),
	]);
	group(
		lines,
		"deleted",
		of("deleted").map((r) =>
			r.overwrote
				? `${r.sourcePath}: deleted the version ${who(r.overwrote)} changed at ${when(r.overwrote)} (--force)`
				: r.sourcePath,
		),
	);
	group(
		lines,
		"already gone",
		of("already-gone").map(
			(r) => `${r.sourcePath}: already gone on the server`,
		),
	);
	group(
		lines,
		"deletion still running",
		of("delete-in-progress").map(
			(r) =>
				`${r.sourcePath}: deletion still running on the server; run again to confirm`,
		),
	);
	// Removed paths `--prune` did not reach (a run stopped early) keep their
	// server entries, as every removed path does without it; so does the old
	// path of a declined move it set out to delete and never reached. A
	// `--prune` target a repository sync refused is settled too — it is
	// reported under `skipped`, not here, so it must not also read as kept.
	const pruned = new Set(
		results
			.filter(
				(r) =>
					DELETE_STATUSES.has(r.status) ||
					r.status === "repository-managed",
			)
			.map((r) => r.sourcePath),
	);
	const kept = [
		...plan.removed,
		...(input.pruneTargets ?? []).filter((p) => !plan.removed.includes(p)),
	];
	group(
		lines,
		"removed",
		kept
			.filter((p) => !pruned.has(p))
			.map((p) => `${p}: removed locally; server entry kept`),
	);
	group(
		lines,
		"skipped",
		[...plan.skipped, ...managedSkips(results)].map(skippedLine),
	);
	const unchanged = countOutcomes(plan, results).unchanged;
	if (unchanged > 0) {
		lines.push(`unchanged (${unchanged})`);
	}
	return lines;
}

/**
 * The text report for `--dry-run`: what would be sent, and nothing else.
 * With `--prune`, the removed paths are what it would delete; the old path of
 * a move the server declines is only known once it answers.
 */
export function formatDryRunReport(input: {
	projectId: string;
	directory: string;
	plan: ContextPlan;
	prune?: boolean;
}): string[] {
	const { plan } = input;
	const lines = [
		`Dry run of a context push from ${input.directory} to project ${input.projectId}: nothing was sent and the lock was not written.`,
	];
	group(
		lines,
		"moved",
		plan.moves.map((move) => `${move.from} -> ${move.to}`),
	);
	group(
		lines,
		"new",
		plan.push
			.filter((entry) => entry.expectedContentHash === undefined)
			.map((entry) => entry.sourcePath),
	);
	group(
		lines,
		"changed",
		plan.push
			.filter((entry) => entry.expectedContentHash !== undefined)
			.map((entry) => entry.sourcePath),
	);
	if (input.prune) {
		group(lines, "would delete", plan.removed);
	} else {
		group(
			lines,
			"removed",
			plan.removed.map(
				(p) => `${p}: removed locally; server entry would be kept`,
			),
		);
	}
	group(lines, "skipped", plan.skipped.map(skippedLine));
	if (plan.unchangedLocal.length > 0) {
		lines.push(`unchanged (${plan.unchangedLocal.length})`);
	}
	return lines;
}

/** The `--format json` object: the whole plan and every result, never file content. */
export function contextPushJson(input: {
	projectId: string;
	directory: string;
	lockPath: string;
	lockWritten: boolean;
	dryRun: boolean;
	force: boolean;
	prune: boolean;
	plan: ContextPlan;
	results: readonly ContextPushResult[];
}) {
	return {
		projectId: input.projectId,
		directory: input.directory,
		dryRun: input.dryRun,
		force: input.force,
		prune: input.prune,
		lock: input.lockPath,
		lockWritten: input.lockWritten,
		plan: {
			push: input.plan.push.map((entry) => ({
				sourcePath: entry.sourcePath,
				sha256: entry.sha256,
				bytes: entry.bytes,
				expectedContentHash: entry.expectedContentHash ?? null,
			})),
			moves: input.plan.moves.map((move) => ({
				from: move.from,
				to: move.to,
				sha256: move.sha256,
				contextId: move.contextId,
			})),
			unchangedLocal: input.plan.unchangedLocal,
			removed: input.plan.removed,
			forgotten: input.plan.forgotten,
			skipped: input.plan.skipped,
		},
		results: input.results,
		counts: countOutcomes(input.plan, input.results),
	};
}
