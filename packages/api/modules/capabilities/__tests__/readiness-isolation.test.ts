/**
 * The capability gating module must never read the readiness checklist.
 *
 * This is a product requirement, not a style preference: gating asks "can this
 * capability run right now", readiness asks "has this project been set up".
 * A snoozed or not-applicable checklist item is a person saying "stop asking
 * me" — it is not the dependency appearing, and letting it reach a gate would
 * mean a project could unlock a capability by dismissing a reminder about it.
 *
 * Nothing else enforces that. The two modules are siblings under the same
 * package, an import between them would resolve cleanly, type-check would be
 * happy, and every behavioural test in this directory hands in a ready-made
 * evidence object — so none of them would notice the extra input. This test
 * reads the module's own source text instead, and fails with an explanation the
 * moment the boundary is crossed.
 *
 * It also covers `thresholds.ts` being import-free, for the separate reason
 * stated in that file: it is meant to stay readable from either side of the app
 * without dragging a server module into a browser bundle, and a bundler never
 * warns about a leaf file that quietly stops being one.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MODULE_ROOT = resolve(__dirname, "..");

/**
 * This file names the forbidden tokens in order to search for them, so it would
 * otherwise report itself. Excluding it by path rather than by some cleverness
 * with string concatenation keeps the search literal and the failure message
 * honest about what it found.
 */
const SELF = resolve(__filename);

/** Every `.ts` file in the module, tests included, except this one. */
function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			return sourceFiles(full);
		}
		if (!full.endsWith(".ts") || resolve(full) === SELF) {
			return [];
		}
		return [full];
	});
}

/** Strip comments so an explanatory mention in prose is not a false positive. */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function relative(file: string): string {
	return file.slice(MODULE_ROOT.length + 1);
}

describe("capabilities module — isolation from the readiness checklist", () => {
	it("imports nothing from the readiness module", () => {
		const offenders = sourceFiles(MODULE_ROOT).filter((file) =>
			/from\s+["'][^"']*readiness[^"']*["']|require\(\s*["'][^"']*readiness/.test(
				stripComments(readFileSync(file, "utf8")),
			),
		);

		expect(
			offenders.map(relative),
			"Capability gating must derive its own evidence. Importing from the " +
				"readiness module — even a type — is the first step toward a " +
				"checklist item deciding whether a capability may run, which the " +
				"requirements forbid outright. Redeclare the shape instead.",
		).toEqual([]);
	});

	it("never references a manual checklist item state", () => {
		const FORBIDDEN = ["SNOOZED", "NOT_APPLICABLE", "HELP_REQUESTED"];
		const offenders = sourceFiles(MODULE_ROOT)
			.map((file) => ({
				file,
				body: stripComments(readFileSync(file, "utf8")),
			}))
			.filter(({ body }) =>
				FORBIDDEN.some((token) => body.includes(token)),
			)
			.map(({ file }) => relative(file));

		expect(
			offenders,
			"A manual checklist state reached the gating module. Snoozing a " +
				"reminder is not the same as satisfying the dependency it names, " +
				"and a capability must never become available because somebody " +
				"dismissed a row.",
		).toEqual([]);
	});

	it("keeps thresholds.ts free of imports", () => {
		const source = readFileSync(join(MODULE_ROOT, "thresholds.ts"), "utf8");

		expect(
			/^\s*import\s|^\s*const\s+.*=\s*require\(/m.test(
				stripComments(source),
			),
			"thresholds.ts carries no import so it stays safe to read from the " +
				"browser side. Even a type-only import makes it a non-leaf, and " +
				"nothing in a normal build would flag that.",
		).toBe(false);
	});
});
