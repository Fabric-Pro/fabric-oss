/**
 * `fabric instructions lesson-prompt --hook` (Stop-hook lesson capture).
 *
 * The contract under test is stricter than the SessionStart hooks': this
 * command must NEVER fail the stop, so most of these tests assert on the
 * `why` a silent run stayed silent, not just that it did.
 */
import { mkdir, mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	countEditingToolUses,
	EDITING_TOOL_NAMES,
	lessonPromptReason,
	markerKey,
	parseStopHookInput,
	runLessonPrompt,
} from "../src/lib/instructions/lesson-prompt.js";

async function makeTree(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), "fabric-lesson-"));
}

function transcriptLine(entry: unknown): string {
	return `${JSON.stringify(entry)}\n`;
}

function toolUseLine(names: string[]): string {
	return transcriptLine({
		type: "assistant",
		message: {
			content: names.map((name) => ({
				type: "tool_use",
				name,
				input: {},
			})),
		},
	});
}

async function writeTranscript(root: string, body: string): Promise<string> {
	const file = path.join(root, "transcript.jsonl");
	await writeFile(file, body, "utf8");
	return file;
}

function stdinFor(
	overrides: Partial<{
		session_id: string;
		transcript_path: string;
		stop_hook_active: boolean;
		hook_event_name: string;
	}> = {},
): string {
	return JSON.stringify({
		session_id: "session-1",
		transcript_path: "/nonexistent.jsonl",
		stop_hook_active: false,
		hook_event_name: "Stop",
		...overrides,
	});
}

// ---------------------------------------------------------------------------
// parseStopHookInput
// ---------------------------------------------------------------------------
describe("parseStopHookInput", () => {
	it("parses a well-formed payload", () => {
		expect(
			parseStopHookInput(
				JSON.stringify({
					session_id: "sess-1",
					transcript_path: "/tmp/whatever.jsonl",
					stop_hook_active: false,
					hook_event_name: "Stop",
				}),
			),
		).toEqual({
			sessionId: "sess-1",
			transcriptPath: "/tmp/whatever.jsonl",
			stopHookActive: false,
			hookEventName: "Stop",
		});
	});

	it("returns null for invalid JSON", () => {
		expect(parseStopHookInput("{ not json")).toBeNull();
	});

	it("returns null for a JSON array", () => {
		expect(parseStopHookInput("[1, 2, 3]")).toBeNull();
	});

	it("returns null for a bare JSON scalar", () => {
		expect(parseStopHookInput("null")).toBeNull();
		expect(parseStopHookInput('"session-1"')).toBeNull();
	});

	it("returns null when a required field is missing", () => {
		expect(
			parseStopHookInput(JSON.stringify({ session_id: "s" })),
		).toBeNull();
	});

	it("returns null when a field has the wrong type", () => {
		expect(
			parseStopHookInput(
				JSON.stringify({
					session_id: "s",
					transcript_path: "/t",
					stop_hook_active: "false",
					hook_event_name: "Stop",
				}),
			),
		).toBeNull();
	});

	it("returns null for an empty session id", () => {
		expect(
			parseStopHookInput(
				JSON.stringify({
					session_id: "",
					transcript_path: "/t",
					stop_hook_active: false,
					hook_event_name: "Stop",
				}),
			),
		).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// countEditingToolUses
// ---------------------------------------------------------------------------
describe("countEditingToolUses", () => {
	it("counts only the editing tool names", async () => {
		const root = await makeTree();
		const file = await writeTranscript(
			root,
			[
				toolUseLine(["Edit"]),
				toolUseLine(["Read", "Bash"]),
				toolUseLine(["Write", "MultiEdit", "NotebookEdit"]),
			].join(""),
		);

		await expect(countEditingToolUses(file)).resolves.toBe(4);
	});

	it("ignores non-editing tool uses entirely", async () => {
		const root = await makeTree();
		const file = await writeTranscript(
			root,
			toolUseLine(["Read", "Bash", "Grep"]),
		);

		await expect(countEditingToolUses(file)).resolves.toBe(0);
	});

	it("tolerates malformed and unrelated lines", async () => {
		const root = await makeTree();
		const file = await writeTranscript(
			root,
			[
				"{ this is not valid json\n",
				toolUseLine(["Edit"]),
				"\n",
				"not an object either\n",
				`${JSON.stringify({ message: {} })}\n`,
				`${JSON.stringify({ message: { content: "not an array" } })}\n`,
				`${JSON.stringify({ no: "message field" })}\n`,
			].join(""),
		);

		await expect(countEditingToolUses(file)).resolves.toBe(1);
	});

	it("rejects when the transcript cannot be opened", async () => {
		const root = await makeTree();
		await expect(
			countEditingToolUses(path.join(root, "missing.jsonl")),
		).rejects.toThrow();
	});

	it("bounds memory at the cap: an oversized first line is cut and dropped, and nothing past the cap is read", async () => {
		const root = await makeTree();
		// A first line whose padding alone is well past the 4096-byte test cap,
		// so the cap must cut it before readline can buffer the whole thing.
		const oversizedLine = transcriptLine({
			type: "assistant",
			message: {
				content: [{ type: "tool_use", name: "Edit", input: {} }],
				padding: "x".repeat(10 * 1024),
			},
		});
		const file = await writeTranscript(
			root,
			oversizedLine + toolUseLine(["Edit"]),
		);

		await expect(
			countEditingToolUses(file, { maxBytes: 4096 }),
		).resolves.toBe(0);
	});

	it("counts every line of a transcript well under the cap", async () => {
		const root = await makeTree();
		const file = await writeTranscript(
			root,
			[
				toolUseLine(["Edit"]),
				toolUseLine(["Write"]),
				toolUseLine(["MultiEdit"]),
			].join(""),
		);

		await expect(
			countEditingToolUses(file, { maxBytes: 4096 }),
		).resolves.toBe(3);
	});

	it("counts lines that fit within the cap and drops the one straddling it", async () => {
		const root = await makeTree();
		const first = toolUseLine(["Edit"]);
		const second = toolUseLine(["Write"]);
		// Sized so the cap lands inside this third line: it starts before the
		// cap and ends after it.
		const straddling = transcriptLine({
			type: "assistant",
			message: {
				content: [{ type: "tool_use", name: "MultiEdit", input: {} }],
				padding: "x".repeat(4096),
			},
		});
		const maxBytes = first.length + second.length + 40;
		const file = await writeTranscript(root, first + second + straddling);

		await expect(countEditingToolUses(file, { maxBytes })).resolves.toBe(2);
	});

	it("names exactly the editing tools this feature counts", () => {
		expect([...EDITING_TOOL_NAMES].sort()).toEqual(
			["Edit", "MultiEdit", "NotebookEdit", "Write"].sort(),
		);
	});
});

// ---------------------------------------------------------------------------
// markerKey / lessonPromptReason
// ---------------------------------------------------------------------------
describe("markerKey", () => {
	it("is a hex digest that depends on both the session and the project", () => {
		const a = markerKey("session-1", "project-1");
		const b = markerKey("session-1", "project-1");
		const c = markerKey("session-1", "project-2");
		const d = markerKey("session-2", "project-1");

		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a).not.toBe(d);
	});
});

describe("lessonPromptReason", () => {
	it("names the project id and the MCP tool, and requires an explicit yes", () => {
		const reason = lessonPromptReason("project-1");
		expect(reason).toContain("project-1");
		expect(reason).toContain("fabric_add_instruction_lesson");
		expect(reason).toContain("explicit yes");
	});
});

// ---------------------------------------------------------------------------
// runLessonPrompt
// ---------------------------------------------------------------------------
describe("runLessonPrompt", () => {
	it("stays silent when stop_hook_active is true", async () => {
		const root = await makeTree();

		const result = await runLessonPrompt({
			stdinText: stdinFor({ stop_hook_active: true }),
			markerDir: path.join(root, "markers"),
			now: new Date(),
			projectId: "project-1",
		});

		expect(result).toEqual({ output: null, why: "stop-hook-active" });
	});

	it("stays silent on unparseable stdin", async () => {
		const root = await makeTree();

		const result = await runLessonPrompt({
			stdinText: "not json at all",
			markerDir: path.join(root, "markers"),
			now: new Date(),
			projectId: "project-1",
		});

		expect(result).toEqual({ output: null, why: "invalid-input" });
	});

	it("stays silent with no --project", async () => {
		const root = await makeTree();

		const result = await runLessonPrompt({
			stdinText: stdinFor(),
			markerDir: path.join(root, "markers"),
			now: new Date(),
			projectId: undefined,
		});

		expect(result).toEqual({ output: null, why: "invalid-input" });
	});

	it("stays silent when the transcript cannot be read", async () => {
		const root = await makeTree();

		const result = await runLessonPrompt({
			stdinText: stdinFor({
				transcript_path: path.join(root, "missing.jsonl"),
			}),
			markerDir: path.join(root, "markers"),
			now: new Date(),
			projectId: "project-1",
		});

		expect(result).toEqual({ output: null, why: "invalid-input" });
	});

	it("stays silent when nothing edited any files", async () => {
		const root = await makeTree();
		const transcript = await writeTranscript(root, toolUseLine(["Read"]));

		const result = await runLessonPrompt({
			stdinText: stdinFor({ transcript_path: transcript }),
			markerDir: path.join(root, "markers"),
			now: new Date(),
			projectId: "project-1",
		});

		expect(result).toEqual({ output: null, why: "no-edits" });
	});

	it("asks once when files were edited, with a valid block decision", async () => {
		const root = await makeTree();
		const transcript = await writeTranscript(root, toolUseLine(["Edit"]));
		const markerDir = path.join(root, "markers");

		const result = await runLessonPrompt({
			stdinText: stdinFor({ transcript_path: transcript }),
			markerDir,
			now: new Date(),
			projectId: "project-1",
		});

		expect(result.why).toBe("asked");
		const parsed = JSON.parse(result.output as string);
		expect(parsed).toEqual({
			decision: "block",
			reason: expect.stringContaining("project-1"),
		});
		expect(parsed.reason).toContain("fabric_add_instruction_lesson");

		const markers = await readdir(markerDir);
		expect(markers).toHaveLength(1);
	});

	it("asks at most once per session", async () => {
		const root = await makeTree();
		const transcript = await writeTranscript(root, toolUseLine(["Edit"]));
		const markerDir = path.join(root, "markers");
		const stdinText = stdinFor({ transcript_path: transcript });

		const first = await runLessonPrompt({
			stdinText,
			markerDir,
			now: new Date(),
			projectId: "project-1",
		});
		expect(first.why).toBe("asked");

		const second = await runLessonPrompt({
			stdinText,
			markerDir,
			now: new Date(),
			projectId: "project-1",
		});
		expect(second).toEqual({ output: null, why: "already-asked" });
	});

	it("asks again for a different project even in the same session", async () => {
		const root = await makeTree();
		const transcript = await writeTranscript(root, toolUseLine(["Edit"]));
		const markerDir = path.join(root, "markers");
		const stdinText = stdinFor({ transcript_path: transcript });

		await runLessonPrompt({
			stdinText,
			markerDir,
			now: new Date(),
			projectId: "project-1",
		});
		const second = await runLessonPrompt({
			stdinText,
			markerDir,
			now: new Date(),
			projectId: "project-2",
		});

		expect(second.why).toBe("asked");
	});

	it("prunes marker files older than 7 days but keeps recent ones", async () => {
		const root = await makeTree();
		const markerDir = path.join(root, "markers");
		await mkdir(markerDir, { recursive: true });

		const stalePath = path.join(markerDir, "stale-marker");
		await writeFile(stalePath, "");
		const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		await utimes(stalePath, eightDaysAgo, eightDaysAgo);

		const freshPath = path.join(markerDir, "fresh-marker");
		await writeFile(freshPath, "");

		const transcript = await writeTranscript(root, toolUseLine(["Edit"]));
		await runLessonPrompt({
			stdinText: stdinFor({
				session_id: "a-new-session",
				transcript_path: transcript,
			}),
			markerDir,
			now: new Date(),
			projectId: "project-1",
		});

		const remaining = await readdir(markerDir);
		expect(remaining).not.toContain("stale-marker");
		expect(remaining).toContain("fresh-marker");
	});
});
