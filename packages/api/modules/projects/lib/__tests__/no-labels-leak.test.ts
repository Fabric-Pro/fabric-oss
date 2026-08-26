/**
 * Source-scan guard: every procedure that hands a UserStory to a client must
 * route it through `stripInternalStoryFields`.
 *
 * `UserStory.labels` stays in the database as system-owned sync state, so the
 * Prisma helpers return it on every read and every write. That makes the leak
 * the DEFAULT: a new procedure that does `return { story }` ships labels to the
 * client unless its author remembers this rule. Two review passes each found
 * boundaries the previous one missed — the first left 8 of 10 leaking, the
 * second still missed `epics/create-feature.ts` because it lives outside
 * `procedures/stories/`. A per-file grep does not scale; this does.
 *
 * If this test fails on a procedure you just wrote: wrap the story in
 * `stripInternalStoryFields(...)` before returning it. Do NOT narrow the Prisma
 * query instead — see the comment on `getStoryById`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PROCEDURES_ROOT = join(__dirname, "..", "..", "procedures");

/**
 * A story handed back WHOLE: `story: someVariable` / `feature: someVariable`.
 *
 * Deliberately does NOT match an inline projection like
 * `stories: rows.map((s) => ({ id: s.id, title: s.title }))` — those name the
 * fields they expose, so they cannot leak a field they never mention. Matching
 * them would make this guard cry wolf, and a guard that cries wolf gets deleted.
 */
const RETURNS_WHOLE_STORY = /\b(story|feature):\s*([A-Za-z_$][\w$]*)\s*[,\n}]/;

/** Same, but already wrapped — the shape we want. */
const WRAPPED = /\b(story|feature):\s*stripInternalStoryFields\(/;

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			if (entry === "__tests__" || entry === "node_modules") {
				continue;
			}
			out.push(...walk(full));
			continue;
		}
		if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
			out.push(full);
		}
	}
	return out;
}

/**
 * Local variables built FROM the helper — e.g.
 * `const resolvedStory = { ...stripInternalStoryFields(row), sourceMeeting }`.
 * Returning one of these is already safe, so `story: resolvedStory` is fine.
 */
function preStrippedVars(src: string): Set<string> {
	const names = new Set<string>();
	const decl =
		/const\s+([A-Za-z_$][\w$]*)\s*=\s*\{?[^;]*?stripInternalStoryFields\(/gs;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard exec loop
	while ((m = decl.exec(src)) !== null) {
		names.add(m[1]);
	}
	return names;
}

/** Lines that hand back a whole story without it having passed through the helper. */
function unwrappedBindings(src: string): string[] {
	const safe = preStrippedVars(src);
	return src
		.split("\n")
		.filter((line) => {
			const trimmed = line.trimStart();
			if (trimmed.startsWith("//") || trimmed.startsWith("*")) {
				return false;
			}
			if (WRAPPED.test(line)) {
				return false;
			}
			const m = RETURNS_WHOLE_STORY.exec(line);
			if (!m) {
				return false;
			}
			// `story: null` and friends are not a story.
			if (["null", "undefined"].includes(m[2])) {
				return false;
			}
			return !safe.has(m[2]);
		})
		.map((line) => line.trim());
}

describe("no procedure leaks UserStory.labels to a client", () => {
	const procedures = walk(PROCEDURES_ROOT).filter((file) =>
		readFileSync(file, "utf8").includes(".handler("),
	);

	it("finds procedures to scan (a broken walk would pass everything vacuously)", () => {
		expect(procedures.length).toBeGreaterThan(20);
	});

	it("finds the known-good wrapped boundaries (a broken regex would pass everything)", () => {
		// If WRAPPED stops matching, every file looks clean and the guard dies
		// silently. Pin that we can still see the strip we know is there.
		const wrapped = procedures.filter((f) =>
			WRAPPED.test(readFileSync(f, "utf8")),
		);
		expect(wrapped.length).toBeGreaterThan(5);
	});

	const offenders = procedures
		.map((file) => ({
			file: file.slice(PROCEDURES_ROOT.length + 1),
			bindings: unwrappedBindings(readFileSync(file, "utf8")),
		}))
		.filter((r) => r.bindings.length > 0);

	it("no procedure returns a story without stripping internal fields", () => {
		expect(
			offenders.map((o) => `${o.file}: ${o.bindings.join(" | ")}`),
		).toEqual([]);
	});
});
