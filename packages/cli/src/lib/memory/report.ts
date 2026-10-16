/**
 * The words `fabric memory` prints. Paths and counts only: never a file's
 * content, a commit message or anything a hook's output could smuggle into a
 * session.
 */

import type { OutboxRecord } from "./lock.js";
import type { KeepReason } from "./plan.js";
import type { PullResult } from "./pull.js";
import type { PushResult } from "./push.js";
import type { StatusResult } from "./status.js";

const KEEP_TEXT: Record<KeepReason, string> = {
	modified: "you changed it here and it changed on the server",
	"untracked-differs":
		"a different file is already here and the mirror did not put it there",
	"deleted-locally-changed-remotely":
		"you deleted it here and it changed on the server",
	"modified-and-removed":
		"you changed it here and it was removed on the server; it is now a new local file",
};

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function recordLines(record: OutboxRecord): string[] {
	const where = record.folder;
	switch (record.status) {
		case "PENDING":
			return [
				`  waiting: ${plural(record.paths.length, "file")} sent to ${where}`,
			];
		case "PULL_REQUEST":
			return [
				`  pull request open for ${plural(record.paths.length, "file")} in ${where}: ${record.url ?? "(no link)"} -- not in Living Memory until it is merged`,
			];
		case "CONFLICT": {
			const lines = [
				`  conflict in ${where}: nothing was written; these changed on the server since you last pulled:`,
			];
			for (const path of record.paths) {
				if (path.verdict !== undefined) {
					lines.push(
						`    ${path.path}: ${path.verdict.code}${path.verdict.currentOid ? ` (now ${path.verdict.currentOid.slice(0, 10)})` : ""}`,
					);
				}
			}
			lines.push(
				"    Your files are untouched. Run `fabric memory pull --accept-remote <path>` to take the server's version of one, or `fabric memory status --clear` to dismiss this.",
			);
			return lines;
		}
		case "REFUSED":
			return [
				`  refused in ${where}: ${record.detail ?? "see the server"}. Fix the files named below, then push again, or run \`fabric memory status --clear\` to dismiss.`,
				...record.paths
					.filter((path) => path.verdict !== undefined)
					.map((path) => `    ${path.path}: ${path.verdict?.code}`),
			];
		case "FAILED":
			return [
				`  failed in ${where}: ${record.detail ?? "unknown"}. Push again to retry.`,
			];
	}
}

function problemLines(records: readonly OutboxRecord[]): string[] {
	return records.flatMap(recordLines);
}

function keptLines(result: PullResult): string[] {
	return result.kept.map(
		(file) => `kept ${file.path}: ${KEEP_TEXT[file.reason]}`,
	);
}

export function pullLines(result: PullResult): string[] {
	if (result.noFolders) {
		return ["This project has no memory folders yet."];
	}
	const lines: string[] = [];
	if (result.written.length > 0) {
		lines.push(`Pulled ${plural(result.written.length, "file")}.`);
	}
	if (result.deleted.length > 0) {
		lines.push(
			`Removed ${plural(result.deleted.length, "file")} deleted on the server.`,
		);
	}
	lines.push(...keptLines(result));
	for (const path of result.trackedByGit) {
		lines.push(
			`skipped ${path}: your repository tracks it; use git for that file.`,
		);
	}
	for (const settled of result.settled) {
		lines.push(
			`write to ${settled.folder}: ${settled.status.toLowerCase().replace("_", " ")}${settled.url ? ` ${settled.url}` : ""}`,
		);
	}
	lines.push(
		...problemLines(result.problems),
		...problemLines(result.pullRequests),
	);
	if (lines.length === 0) {
		lines.push("Memory is up to date.");
	}
	return lines;
}

export function pushLines(result: PushResult): string[] {
	if (result.noFolders) {
		return [
			"This project has no memory folders yet, so there is nowhere to push.",
		];
	}
	const lines: string[] = [];
	for (const sent of result.sent) {
		lines.push(
			`Sent ${plural(sent.fileCount, "file")} to ${sent.folder} (${sent.mode === "DIRECT_PUSH" ? "committed to the synced branch once it lands" : "a pull request will be opened"}); write ${sent.writeId}${sent.deduplicated ? ", already sent" : ""}.`,
		);
	}
	for (const refused of result.refused) {
		lines.push(`refused for ${refused.folder}:`);
		lines.push(...refused.problems.map((problem) => `  ${problem}`));
	}
	for (const skipped of result.skipped) {
		lines.push(`skipped ${skipped.path}: ${skipped.reason}`);
	}
	if (result.busy) {
		lines.push(
			`Too many writes are pending; ${plural(result.remaining, "change")} will go on the next push.`,
		);
	} else if (result.remaining > 0) {
		lines.push(
			`${plural(result.remaining, "change")} left for the next push.`,
		);
	}
	if (lines.length === 0) {
		lines.push("Nothing to send.");
	}
	return lines;
}

export function statusLines(result: StatusResult): string[] {
	const lines: string[] = [];
	for (const settled of result.settled) {
		lines.push(
			`write to ${settled.folder}: ${settled.status.toLowerCase().replace("_", " ")}${settled.url ? ` ${settled.url}` : ""}`,
		);
	}
	if (result.pending > 0) {
		lines.push(`${plural(result.pending, "write")} still pending.`);
	}
	lines.push(
		...problemLines(result.pullRequests),
		...problemLines(result.problems),
	);
	if (result.changes.length > 0) {
		lines.push(
			`${plural(result.changes.length, "local change")} not sent yet: ${result.changes.map((change) => `${change.kind} ${change.path}`).join(", ")}`,
		);
	}
	for (const skipped of result.skipped) {
		if (skipped.reason !== "already-sent") {
			lines.push(`skipped ${skipped.path}: ${skipped.reason}`);
		}
	}
	if (result.cleared > 0) {
		lines.push(`Dismissed ${plural(result.cleared, "problem")}.`);
	}
	if (lines.length === 0) {
		lines.push("Memory is in step with the server.");
	}
	return lines;
}

/**
 * The one line a pull prints in hook mode, or `null` when nothing happened. A
 * session start carries stdout into the agent's context, so it says counts and
 * where to look, nothing more.
 */
export function pullHookLine(result: PullResult): string | null {
	const parts: string[] = [];
	if (result.written.length > 0) {
		parts.push(`${plural(result.written.length, "file")} pulled`);
	}
	if (result.kept.length > 0) {
		parts.push(`${plural(result.kept.length, "local edit")} kept`);
	}
	if (result.problems.length > 0) {
		parts.push(
			`${plural(result.problems.length, "write")} need attention (fabric memory status)`,
		);
	}
	if (result.pullRequests.length > 0) {
		parts.push(
			`${plural(result.pullRequests.length, "pull request")} open`,
		);
	}
	return parts.length === 0 ? null : `memory: ${parts.join(", ")}`;
}

/** The one line a push prints in hook mode: counts and the folder, `null` when nothing was sent. */
export function pushHookLine(result: PushResult): string | null {
	const parts = result.sent.map(
		(sent) =>
			`${plural(sent.fileCount, "file")} sent to ${sent.folder} (pending; ${sent.mode === "DIRECT_PUSH" ? "commit" : "pull request"})`,
	);
	if (result.refused.length > 0) {
		parts.push(
			`${plural(result.refused.length, "write")} refused (fabric memory status)`,
		);
	}
	return parts.length === 0 ? null : `memory: ${parts.join("; ")}`;
}
