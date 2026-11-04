/**
 * Progress of `fabric context push` on stderr, so stdout stays the report (or
 * the one JSON object) a script reads.
 *
 * One line per request, `[n/total] <action> <path>`. On a terminal each line
 * replaces the previous one and the last is cleared when the run ends; in a
 * log, each request is its own line. A `--force` resend repeats the file's
 * number with `force`, so a run that resends many conflicts is visibly busy.
 */

/** What one request does. */
export type ContextPushProgressAction = "push" | "move" | "delete" | "force";

export interface ContextPushProgressEvent {
	/** 1-based: the request this file is. */
	index: number;
	total: number;
	action: ContextPushProgressAction;
	sourcePath: string;
}

export type ContextPushProgress = (event: ContextPushProgressEvent) => void;

function formatProgressLine(event: ContextPushProgressEvent): string {
	return `[${event.index}/${event.total}] ${event.action} ${event.sourcePath}`;
}

export interface ProgressReporter {
	report: ContextPushProgress;
	/** Clears a terminal's progress line. Safe to call more than once. */
	done(): void;
}

export function stderrProgress(
	stream: { isTTY?: boolean; write(chunk: string): unknown } = process.stderr,
): ProgressReporter {
	const live = stream.isTTY === true;
	let shown = false;
	return {
		report(event) {
			const line = formatProgressLine(event);
			if (live) {
				stream.write(`\r\u001b[2K${line}`);
				shown = true;
			} else {
				stream.write(`${line}\n`);
			}
		},
		done() {
			if (live && shown) {
				stream.write("\r\u001b[2K");
				shown = false;
			}
		},
	};
}
