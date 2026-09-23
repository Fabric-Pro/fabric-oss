/**
 * The Stop hook that asks, once per session, whether a mistake should become
 * a team lesson (Fizzy lesson-capture).
 *
 * Claude Code runs this as a Stop hook and feeds it JSON on stdin. The
 * contract is the same one `fabric instructions check|sync --hook` already
 * keep, made stricter: this command must NEVER fail the stop. Any error —
 * malformed stdin, an unreadable transcript, a missing `--project`, a marker
 * directory that cannot be created — is silence and exit 0. It also makes no
 * network call and needs no API key, so nothing here can be slow, and nothing
 * here can hold up a session ending because Fabric is unreachable.
 *
 * `runLessonPrompt` is the one function that decides everything; the command
 * in `commands/instructions/index.ts` is just stdin in, its `output` on
 * stdout, and nothing else. Every other export here is a pure or
 * near-pure piece of it, kept separate so each can be tested without going
 * through a child process.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { describeError } from "../command-boundary.js";

/** The JSON Claude Code sends a Stop hook on stdin, the fields this cares about. */
export interface StopHookInput {
	sessionId: string;
	transcriptPath: string;
	stopHookActive: boolean;
	hookEventName: string;
}

/**
 * Parse and validate the hook's stdin payload. `null` on anything that is not
 * exactly the shape expected — malformed JSON, a non-object, or any of the
 * four fields missing or of the wrong type. Never throws: every caller in
 * this feature must keep running (silently) past a payload it cannot use.
 */
export function parseStopHookInput(text: string): StopHookInput | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed)
	) {
		return null;
	}
	const obj = parsed as Record<string, unknown>;
	const sessionId = obj.session_id;
	const transcriptPath = obj.transcript_path;
	const stopHookActive = obj.stop_hook_active;
	const hookEventName = obj.hook_event_name;
	if (
		typeof sessionId !== "string" ||
		sessionId.length === 0 ||
		typeof transcriptPath !== "string" ||
		transcriptPath.length === 0 ||
		typeof stopHookActive !== "boolean" ||
		typeof hookEventName !== "string"
	) {
		return null;
	}
	return { sessionId, transcriptPath, stopHookActive, hookEventName };
}

/**
 * The tool_use names that count as "the assistant edited files" for the
 * purpose of asking about a lesson. A constant, not an inline literal, so the
 * unit tests and the counter agree on exactly one list.
 */
export const EDITING_TOOL_NAMES: ReadonlySet<string> = new Set([
	"Edit",
	"Write",
	"MultiEdit",
	"NotebookEdit",
]);

/**
 * A transcript this will not read past, even a well-formed one. The
 * transcript is the developer's own session and ordinarily tiny; this exists
 * only so a corrupt or adversarial file cannot turn a Stop hook into an
 * unbounded read.
 */
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

/**
 * Count assistant `tool_use` entries in a JSONL transcript whose name is one
 * of `EDITING_TOOL_NAMES`.
 *
 * Read streaming and line by line, because a transcript can be large and
 * this only ever needs a running count. A line that is not valid JSON, or
 * whose shape is not `{ message: { content: [...] } }`, is skipped rather
 * than treated as a failure — a Stop hook runs against a transcript file
 * still being written by the very process that invoked it, so a torn final
 * line is normal, not corruption.
 *
 * The cap bounds the underlying file read itself (`createReadStream`'s
 * `end`), not a running byte count checked between lines: a single line
 * larger than the cap would otherwise be buffered in full by `readline`
 * before any check ran, so the advertised cap would not bound memory. Once
 * the stream stops at the byte offset, the final line it handed to
 * `readline` — whole or cut mid-line, and mid-character when the cut lands
 * inside a multi-byte UTF-8 sequence, since `end` is a byte offset — is
 * simply the last one read. A cut line almost always fails `JSON.parse` and
 * is skipped like any other torn line; on the rare byte count where a cut
 * happens to still parse, it is at worst one tool_use undercounted, which
 * this feature does not need to get exactly right.
 *
 * `maxBytes` defaults to {@link MAX_TRANSCRIPT_BYTES} and exists as a
 * parameter only so tests can exercise the cap without a multi-megabyte
 * fixture.
 *
 * Throws when the file itself cannot be opened or read (missing, permission
 * denied, …) — the caller decides what a transcript it cannot reach means.
 */
export async function countEditingToolUses(
	transcriptPath: string,
	{ maxBytes = MAX_TRANSCRIPT_BYTES }: { maxBytes?: number } = {},
): Promise<number> {
	const stream = createReadStream(transcriptPath, {
		encoding: "utf8",
		end: maxBytes - 1,
	});
	const rl = createInterface({
		input: stream,
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	let count = 0;
	try {
		for await (const line of rl) {
			count += countEditingToolUsesInLine(line);
		}
	} finally {
		rl.close();
		stream.destroy();
	}
	return count;
}

function countEditingToolUsesInLine(line: string): number {
	const trimmed = line.trim();
	if (trimmed.length === 0) {
		return 0;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return 0;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return 0;
	}
	const message = (parsed as Record<string, unknown>).message;
	if (typeof message !== "object" || message === null) {
		return 0;
	}
	const content = (message as Record<string, unknown>).content;
	if (!Array.isArray(content)) {
		return 0;
	}
	let count = 0;
	for (const item of content) {
		if (
			typeof item === "object" &&
			item !== null &&
			(item as Record<string, unknown>).type === "tool_use" &&
			typeof (item as Record<string, unknown>).name === "string" &&
			EDITING_TOOL_NAMES.has(
				(item as Record<string, unknown>).name as string,
			)
		) {
			count++;
		}
	}
	return count;
}

/**
 * The marker file name for one session and project: a hex SHA-256, never the
 * raw session id or project id, so the marker directory does not itself
 * become a place that leaks either.
 */
export function markerKey(sessionId: string, projectId: string): string {
	return createHash("sha256")
		.update(`${sessionId}:${projectId}`)
		.digest("hex");
}

/**
 * The `reason` text sent back to Claude Code when a lesson check fires.
 * Naming the project id and `fabric_add_instruction_lesson` explicitly, and
 * making the "only after an explicit yes" rule part of the instruction
 * itself rather than trusting a general system prompt to supply it.
 */
export function lessonPromptReason(projectId: string): string {
	return (
		`Fabric lesson check for project ${projectId}: before you finish, ask the developer once, in one short question: was there a mistake in this session the team should not repeat? ` +
		"If they name one, draft it as a lesson (a title, what happened, why it was a mistake, what to do instead, and the instruction files it relates to) and show them the draft. " +
		`Only after they confirm, call the MCP tool fabric_add_instruction_lesson with projectId "${projectId}", title, body and relatedPaths; it opens a proposal a person approves, so report it as a suggestion awaiting review. ` +
		"If they say no, or the tool is not available, say so in one line and stop. Never call the tool without an explicit yes."
	);
}

/** A marker older than this is pruned on the next run, best effort. */
const MARKER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Best-effort removal of marker files older than {@link MARKER_MAX_AGE_MS}.
 * Failure anywhere here — a listing that fails, a stat or unlink that races
 * with another process — is swallowed; pruning is housekeeping, never the
 * reason a session fails to end.
 */
async function pruneOldMarkers(markerDir: string, now: Date): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(markerDir);
	} catch {
		return;
	}
	const cutoff = now.getTime() - MARKER_MAX_AGE_MS;
	await Promise.all(
		entries.map(async (name) => {
			const entryPath = path.join(markerDir, name);
			try {
				const stats = await stat(entryPath);
				if (stats.mtimeMs < cutoff) {
					await unlink(entryPath);
				}
			} catch {
				// Best effort: a racing prune, a permission error, a file that
				// vanished between the listing and the stat — none of it is
				// this command's problem to solve.
			}
		}),
	);
}

async function markerExists(markerPath: string): Promise<boolean> {
	try {
		await stat(markerPath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return false;
		}
		throw error;
	}
}

/** Every reason `runLessonPrompt` can end without printing anything. */
type RunLessonPromptWhy =
	| "stop-hook-active"
	| "already-asked"
	| "no-edits"
	| "asked"
	| "invalid-input"
	| "marker-unavailable";

export interface RunLessonPromptResult {
	/** The single JSON line to print to stdout, or `null` to print nothing. */
	output: string | null;
	why: RunLessonPromptWhy;
}

function debugLog(message: string): void {
	// No debug flag has existed in this CLI before now; `FABRIC_DEBUG` follows
	// the same naming as `FABRIC_API_KEY` / `FABRIC_ORG` / `FABRIC_FORMAT`.
	if (process.env.FABRIC_DEBUG) {
		process.stderr.write(`fabric: lesson-prompt: ${message}\n`);
	}
}

/**
 * Decide whether this Stop hook should ask about a lesson, and build the
 * single JSON line to print if so. Pure with respect to its inputs — reads
 * the transcript and the marker directory, and nothing else — so a test can
 * point it at a temp directory and a fixture file without touching stdin,
 * stdout or the real CLI config path.
 *
 * `projectId` is not part of the hook's stdin payload; it comes from the
 * command's own `--project` flag (the exact value `buildLessonPromptCommand`
 * wrote into the hook). It is threaded through explicitly here, alongside
 * `stdinText`, rather than folded into it, because a missing `--project` is
 * itself one of the silent-exit cases and has nothing to do with whether the
 * stdin JSON parsed.
 *
 * The whole body runs inside one try/catch: every failure mode this
 * contract has to tolerate — a transcript that cannot be opened, a marker
 * directory that cannot be listed, anything unanticipated — collapses to the
 * same `{ output: null, why: "invalid-input" }` a bad stdin payload gets,
 * which is the never-fail promise made explicit rather than assembled from
 * several narrower try/catches that would each have to get it right.
 */
export async function runLessonPrompt(input: {
	stdinText: string;
	markerDir: string;
	now: Date;
	projectId: string | undefined;
}): Promise<RunLessonPromptResult> {
	try {
		return await runLessonPromptInner(input);
	} catch (error) {
		debugLog(`unexpected error, staying silent: ${describeError(error)}`);
		return { output: null, why: "invalid-input" };
	}
}

async function runLessonPromptInner(input: {
	stdinText: string;
	markerDir: string;
	now: Date;
	projectId: string | undefined;
}): Promise<RunLessonPromptResult> {
	const projectId = input.projectId?.trim();
	if (!projectId) {
		debugLog("no --project supplied");
		return { output: null, why: "invalid-input" };
	}

	const parsedInput = parseStopHookInput(input.stdinText);
	if (parsedInput === null) {
		debugLog("could not parse stop-hook stdin");
		return { output: null, why: "invalid-input" };
	}

	// The hook is already re-running because an earlier Stop hook blocked —
	// asking again here would either loop or pile a second question onto the
	// first. `stop_hook_active` is Claude Code's own signal for exactly this.
	if (parsedInput.stopHookActive) {
		return { output: null, why: "stop-hook-active" };
	}

	try {
		await mkdir(input.markerDir, { recursive: true });
	} catch (error) {
		debugLog(`marker directory unavailable: ${describeError(error)}`);
		return { output: null, why: "marker-unavailable" };
	}

	await pruneOldMarkers(input.markerDir, input.now).catch((error) => {
		debugLog(`marker prune failed: ${describeError(error)}`);
	});

	const key = markerKey(parsedInput.sessionId, projectId);
	const markerPath = path.join(input.markerDir, key);

	if (await markerExists(markerPath)) {
		return { output: null, why: "already-asked" };
	}

	let editCount: number;
	try {
		editCount = await countEditingToolUses(parsedInput.transcriptPath);
	} catch (error) {
		debugLog(`could not read transcript: ${describeError(error)}`);
		return { output: null, why: "invalid-input" };
	}

	if (editCount === 0) {
		return { output: null, why: "no-edits" };
	}

	// Written FIRST: a crash between here and the `stdout` write below must
	// not leave this session able to ask again.
	try {
		await writeFile(markerPath, "", { flag: "wx" });
	} catch (error) {
		debugLog(`could not write marker: ${describeError(error)}`);
		return { output: null, why: "marker-unavailable" };
	}

	const output = JSON.stringify({
		decision: "block",
		reason: lessonPromptReason(projectId),
	});
	return { output, why: "asked" };
}

/** Read a readable stream to completion and return it as one UTF-8 string. */
export async function readAllStdin(
	stream: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of stream) {
		chunks.push(
			Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
		);
	}
	return Buffer.concat(chunks).toString("utf8");
}
