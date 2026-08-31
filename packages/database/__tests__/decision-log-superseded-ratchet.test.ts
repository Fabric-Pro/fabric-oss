/**
 * Ratchet: every reader that feeds the Decision Log to a MODEL must exclude
 * superseded turns.
 *
 * Amending an answer (#1910) appends a new turn carrying `supersedesId` and
 * leaves the turn it replaces in place, so the log stays an append-only
 * changelog. The superseded turn is RETRACTED: a person may read it as history,
 * but a model must never see it beside the answer that replaced it, or it gets
 * two equally authoritative decisions for one question and no way to tell which
 * one still stands.
 *
 * `listDecisionLogThreads` defends this with `excludeSuperseded` — but the
 * option DEFAULTS TO FALSE, so a new call site inherits the unsafe behaviour
 * silently. That is not hypothetical. `handleGetFeatureDecisions` (the MCP tool
 * `fabric_get_feature_decisions`) was added after #1910 was written, took the
 * default, and would have handed a model a retracted answer. It compiled, it
 * type-checked, and every other test passed.
 *
 * So this test inverts the default's blast radius: a call site is a FAILURE
 * unless it either passes the flag or is named below as a human-facing surface.
 * Adding an entry is a deliberate act that needs a reason in review.
 */

import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "../../..");

const SEARCH_ROOTS = [
	"packages/api/modules",
	"packages/temporal/src",
	"apps/web/modules",
];

const CALL = "listDecisionLogThreads(";

/**
 * Call sites that deliberately DO NOT exclude superseded turns, because their
 * whole job is to render the history to a person. Each one must be a surface a
 * model never reads.
 */
const HUMAN_SURFACES = new Set([
	// The Decisions tab. Showing what a decision used to say is the point of
	// the feature — this is the one place the superseded turn is visible.
	"packages/api/modules/projects/procedures/stories/maturation/list-decision-log.ts",
	// The maturation workspace editor state, read by the tab UI. Shares its
	// serializer with list-decision-log so the two never disagree.
	"packages/api/modules/projects/procedures/stories/maturation/get-editor-state.ts",
]);

function readDir(dir: string) {
	try {
		return readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readDir(dir)) {
		const full = resolve(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "generated") {
				continue;
			}
			walk(full, out);
			continue;
		}
		if (!/\.tsx?$/.test(entry.name)) {
			continue;
		}
		// Tests mock the query; they are not readers.
		if (full.split(sep).includes("__tests__")) {
			continue;
		}
		out.push(full);
	}
	return out;
}

/**
 * The argument text of each `listDecisionLogThreads(...)` call, found by
 * balancing parentheses from the call site. Matching the whole call rather than
 * grepping the file keeps a file honest when it calls the query twice — once
 * for a model and once for the UI.
 */
function callArguments(source: string): string[] {
	const calls: string[] = [];
	let from = 0;
	for (;;) {
		const at = source.indexOf(CALL, from);
		if (at === -1) {
			return calls;
		}
		let depth = 0;
		let index = at + CALL.length - 1;
		for (; index < source.length; index++) {
			const ch = source[index];
			if (ch === "(") {
				depth++;
			} else if (ch === ")") {
				depth--;
				if (depth === 0) {
					break;
				}
			}
		}
		calls.push(source.slice(at + CALL.length, index));
		from = index === -1 ? at + CALL.length : index;
	}
}

describe("Decision Log — superseded turns never reach a model", () => {
	it("every call site excludes superseded turns, or is a declared human surface", () => {
		const offenders: string[] = [];
		let callSites = 0;

		for (const root of SEARCH_ROOTS) {
			for (const file of walk(resolve(repoRoot, root))) {
				const source = readFileSync(file, "utf8");
				if (!source.includes(CALL)) {
					continue;
				}
				const rel = relative(repoRoot, file).split(sep).join("/");
				for (const args of callArguments(source)) {
					// An import or re-export names the symbol without calling it.
					if (!args.includes("{")) {
						continue;
					}
					callSites++;
					if (args.includes("excludeSuperseded")) {
						continue;
					}
					if (HUMAN_SURFACES.has(rel)) {
						continue;
					}
					offenders.push(rel);
				}
			}
		}

		// A refactor that renames or relocates the query would empty the sweep
		// and make this test vacuously green. Fail instead.
		expect(
			callSites,
			"found no listDecisionLogThreads call sites — the sweep is broken, not clean",
		).toBeGreaterThan(3);

		expect(
			[...new Set(offenders)].sort(),
			`These call sites read the Decision Log without excluding superseded turns.

A superseded turn is a RETRACTED answer. Passing it to a model alongside the
answer that replaced it gives two authoritative decisions for one question.

Pass \`excludeSuperseded: true\`, or — only if this surface is read by a person
and never by a model — add it to HUMAN_SURFACES in this test with a reason.`,
		).toEqual([]);
	});
});
