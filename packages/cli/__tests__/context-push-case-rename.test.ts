/**
 * `fabric context push` planning on a case-insensitive filesystem (Fizzy
 * #2618): a file renamed only in case (`Docs/Guide.md` -> `docs/guide.md`).
 *
 * macOS and Windows resolve both spellings to the same file, so asking the
 * filesystem "is the old spelling still there?" answers yes, and the old lock
 * path was reported as "now excluded by the ignore rules" while the new
 * spelling was pushed beside it. Whether a lock path is still present has to
 * be answered from the names the walk actually listed, which carry the case
 * they have on disk.
 *
 * The suite runs on Linux too: `lstat` is replaced by one that falls back to
 * a case-insensitive lookup, as those filesystems behave, so the planner is
 * tested against the behaviour it has to survive rather than the host's.
 */
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
// The mocked module below (`vi.mock` is hoisted above these imports).
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { computeContextPlan } from "../src/lib/context-sync/plan.js";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();

	/** The on-disk spelling of `target`, matched segment by segment ignoring case. */
	async function foldedPath(target: string): Promise<string | null> {
		const { root } = path.parse(target);
		let current = root;
		for (const segment of target.slice(root.length).split(path.sep)) {
			if (segment === "") {
				continue;
			}
			let names: string[];
			try {
				names = await actual.readdir(current);
			} catch {
				return null;
			}
			const match =
				names.find((name) => name === segment) ??
				names.find(
					(name) => name.toLowerCase() === segment.toLowerCase(),
				);
			if (match === undefined) {
				return null;
			}
			current = path.join(current, match);
		}
		return current;
	}

	async function caseInsensitiveLstat(
		target: string,
		...rest: unknown[]
	): Promise<Stats> {
		try {
			return await (
				actual.lstat as (...args: unknown[]) => Promise<Stats>
			)(target, ...rest);
		} catch (error) {
			const folded = await foldedPath(String(target));
			if (folded === null) {
				throw error;
			}
			return (await actual.lstat(folded)) as Stats;
		}
	}

	return { ...actual, lstat: caseInsensitiveLstat };
});

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("a case-only rename on a case-insensitive filesystem", () => {
	it("reports the old spelling as removed and pushes the new one as a new path", async () => {
		const dir = await realpath(
			await mkdtemp(path.join(tmpdir(), "fabric-context-case-")),
		);
		await mkdir(path.join(dir, "docs"), { recursive: true });
		await writeFile(path.join(dir, "docs", "guide.md"), "# Guide\n");

		const plan = await computeContextPlan({
			root: dir,
			lock: {
				version: 1,
				projectId: "project-1",
				pushedAt: "2026-09-20T10:00:00.000Z",
				files: {
					"Docs/Guide.md": {
						sha256: sha256("# Guide\n"),
						contextId: "ctx-old",
					},
				},
			},
		});

		expect(plan.removed).toEqual(["Docs/Guide.md"]);
		expect(plan.skipped).toEqual([]);
		expect(plan.push).toEqual([
			{
				sourcePath: "docs/guide.md",
				diskPath: "docs/guide.md",
				sha256: sha256("# Guide\n"),
				bytes: 8,
			},
		]);
	});
});
