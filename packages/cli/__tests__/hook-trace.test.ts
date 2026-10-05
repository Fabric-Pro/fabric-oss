/**
 * The hook's trace ring (Fizzy #2878): the last 50 results, one JSON object per
 * line, readable by its owner only, and never a reason for a session to fail.
 */
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	appendTrace,
	TRACE_LIMIT,
	traceFile,
} from "../src/lib/instructions/hook-trace.js";

let file: string;

beforeEach(async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "fabric-trace-"));
	file = traceFile(dir);
});

const entry = (index: number) => ({
	at: `2026-10-03T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
	projectId: "project-1",
	outcome: "not-safe",
	reason: "dirty",
	ms: index,
});

async function read(): Promise<Array<{ ms: number }>> {
	return (await readFile(file, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}

describe("traceFile", () => {
	it("lives in a traces folder of the config folder", () => {
		expect(traceFile("/home/example/.config/fabricai")).toBe(
			path.join(
				"/home/example/.config/fabricai",
				"traces",
				"instructions-hook.jsonl",
			),
		);
	});
});

describe("appendTrace", () => {
	it("creates the folder and the file, one line per entry", async () => {
		await appendTrace(file, entry(1));
		await appendTrace(file, entry(2));

		expect((await read()).map((e) => e.ms)).toEqual([1, 2]);
	});

	it("keeps the last 50 and drops the oldest", async () => {
		for (let index = 0; index < TRACE_LIMIT + 5; index++) {
			await appendTrace(file, entry(index));
		}

		const kept = await read();
		expect(kept).toHaveLength(TRACE_LIMIT);
		expect(kept[0]?.ms).toBe(5);
		expect(kept.at(-1)?.ms).toBe(TRACE_LIMIT + 4);
	});

	it.skipIf(process.platform === "win32")(
		"is readable by its owner only",
		async () => {
			await appendTrace(file, entry(1));

			expect((await stat(file)).mode & 0o777).toBe(0o600);
		},
	);

	it("drops a line that is not an entry, keeps the rest, and still adds this one", async () => {
		await appendTrace(file, entry(1));
		const kept = await readFile(file, "utf8");
		await writeFile(file, `${kept}this is not json\n{"no":"outcome"}\n`);

		await appendTrace(file, entry(2));

		expect((await read()).map((e) => e.ms)).toEqual([1, 2]);
	});

	it("holds nothing but the entry's own fields", async () => {
		await appendTrace(file, entry(1));

		expect(Object.keys((await read())[0] ?? {}).sort()).toEqual([
			"at",
			"ms",
			"outcome",
			"projectId",
			"reason",
		]);
	});

	it("never throws, whatever it cannot write", async () => {
		const unwritable = path.join(file, "below", "a", "file");
		await appendTrace(file, entry(1));

		await expect(
			appendTrace(unwritable, entry(2)),
		).resolves.toBeUndefined();
	});
});
