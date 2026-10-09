/**
 * A short trace of what the session hook did (Fizzy #2878): the last 50
 * results, one JSON object per line, in `<config dir>/traces/instructions-hook.jsonl`
 * (readable by its owner only). It exists so "the hook did nothing" can be
 * answered afterwards; it holds a time, the project id, the result and its
 * reason (both from closed sets), how long the run took and where that time
 * went, by phase — never a path, a
 * URL, a commit name or a word git said.
 *
 * Best effort: a trace that cannot be written is dropped, and the hook never
 * notices.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const TRACE_LIMIT = 50;

export interface TraceEntry {
	/** ISO 8601, UTC. */
	at: string;
	projectId: string;
	outcome: string;
	reason: string | null;
	ms: number;
	/** Milliseconds since the process started, Node's start-up included. */
	totalMs?: number;
	/** Milliseconds in each named phase (a closed set of names this CLI chose). */
	phases?: Record<string, number>;
}

export function traceFile(configDir: string): string {
	return path.join(configDir, "traces", "instructions-hook.jsonl");
}

/** The last `TRACE_LIMIT - 1` lines that parse as entries, then this one. */
export async function appendTrace(
	file: string,
	entry: TraceEntry,
): Promise<void> {
	try {
		const previous = await readFile(file, "utf8").catch(() => "");
		const kept = previous
			.split("\n")
			.filter((line) => {
				try {
					return typeof JSON.parse(line)?.outcome === "string";
				} catch {
					return false;
				}
			})
			.slice(-(TRACE_LIMIT - 1));
		kept.push(JSON.stringify(entry));
		await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		const temporary = `${file}.${process.pid}.tmp`;
		await writeFile(temporary, `${kept.join("\n")}\n`, { mode: 0o600 });
		await rename(temporary, file);
	} catch {
		// Dropped: a trace is never worth failing a session start.
	}
}
