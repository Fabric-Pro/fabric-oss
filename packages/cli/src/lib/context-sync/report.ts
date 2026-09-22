/**
 * The words and the JSON a `fabric context push` prints.
 *
 * Grouped by outcome with a count on each group, one line per file for every
 * outcome except `unchanged`, which is only counted: a folder of two hundred
 * notes where one changed should read as one line and a count.
 */
import type { SkippedContextFile } from "./classify.js";
import type { ContextPlan } from "./plan.js";
import type { ContextPushResult } from "./push.js";

type ResultOf<S extends ContextPushResult["status"]> = Extract<
	ContextPushResult,
	{ status: S }
>;

export interface ContextPushCounts {
	created: number;
	updated: number;
	unchanged: number;
	duplicate: number;
	conflict: number;
	changedDuringRun: number;
	failed: number;
	removed: number;
	skipped: number;
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
		conflict: count("conflict"),
		changedDuringRun: count("changed-during-run"),
		failed: count("failed"),
		removed: plan.removed.length,
		skipped: plan.skipped.length,
	};
}

function who(current: { contentUpdatedBy: { name: string | null } | null }) {
	return current.contentUpdatedBy?.name ?? "someone";
}

function when(current: { contentUpdatedAt: string | null }) {
	return current.contentUpdatedAt ?? "an unknown time";
}

function conflictLine(result: ResultOf<"conflict">): string {
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

function storedLine(result: ResultOf<"created" | "updated" | "unchanged">) {
	if (result.overwrote) {
		return `${result.sourcePath}: replaced the version ${who(result.overwrote)} changed at ${when(result.overwrote)} (--force)`;
	}
	return result.sourcePath;
}

function skippedLine(skip: SkippedContextFile): string {
	if (skip.reason === "ignored") {
		return `${skip.path}: now excluded by the ignore rules; server entry kept`;
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
}): string[] {
	const { plan, results } = input;
	const of = <S extends ContextPushResult["status"]>(status: S) =>
		results.filter((r): r is ResultOf<S> => r.status === status);

	const lines = [
		`Context push from ${input.directory} to project ${input.projectId}:`,
	];
	group(lines, "created", of("created").map(storedLine));
	group(lines, "updated", of("updated").map(storedLine));
	group(
		lines,
		"duplicate",
		of("duplicate").map(
			(r) =>
				`${r.sourcePath}: duplicate of ${r.duplicateOfSourcePath ?? "another source in this project"}`,
		),
	);
	group(lines, "conflict", of("conflict").map(conflictLine));
	group(
		lines,
		"changed during the run",
		of("changed-during-run").map(
			(r) =>
				`${r.sourcePath}: changed-during-run; not sent, the next push sends the new content`,
		),
	);
	group(
		lines,
		"failed",
		of("failed").map((r) => `${r.sourcePath}: ${r.error}`),
	);
	group(
		lines,
		"removed",
		plan.removed.map((p) => `${p}: removed locally; server entry kept`),
	);
	group(lines, "skipped", plan.skipped.map(skippedLine));
	const unchanged = countOutcomes(plan, results).unchanged;
	if (unchanged > 0) {
		lines.push(`unchanged (${unchanged})`);
	}
	return lines;
}

/** The text report for `--dry-run`: what would be sent, and nothing else. */
export function formatDryRunReport(input: {
	projectId: string;
	directory: string;
	plan: ContextPlan;
}): string[] {
	const { plan } = input;
	const lines = [
		`Dry run of a context push from ${input.directory} to project ${input.projectId}: nothing was sent and the lock was not written.`,
	];
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
	group(
		lines,
		"removed",
		plan.removed.map(
			(p) => `${p}: removed locally; server entry would be kept`,
		),
	);
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
	plan: ContextPlan;
	results: readonly ContextPushResult[];
}) {
	return {
		projectId: input.projectId,
		directory: input.directory,
		dryRun: input.dryRun,
		force: input.force,
		lock: input.lockPath,
		lockWritten: input.lockWritten,
		plan: {
			push: input.plan.push.map((entry) => ({
				sourcePath: entry.sourcePath,
				sha256: entry.sha256,
				bytes: entry.bytes,
				expectedContentHash: entry.expectedContentHash ?? null,
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
