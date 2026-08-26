import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every model resolution must carry the project scope it has.
 *
 * `getAIModelWithMetadata` stamps `projectId` onto the usage row (via the
 * interceptor that wraps the resolved model) and hands it to the usage-limit
 * chokepoint. It is the ONLY thing that does: `logModelUsageAsync` has been an
 * explicit no-op since the interceptor landed, so a caller that passes
 * `projectId` to the old logger and not to the resolver loses the attribution
 * entirely — the spend bills the workspace while the project's Usage tab stays
 * flat and the work reads as free.
 *
 * That is exactly how four call sites regressed at once. A per-caller unit test
 * would not have caught the fifth, so the rule is enforced over the source:
 * a call that builds its context INLINE must name `projectId`. Passing a
 * pre-built context variable is allowed — that object is assembled elsewhere
 * and reviewed on its own terms.
 */
const AI_LIB = join(__dirname, "..", "lib");

function tsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!/node_modules|__tests__/.test(entry.name)) {
				out.push(...tsFiles(full));
			}
		} else if (entry.name.endsWith(".ts")) {
			out.push(full);
		}
	}
	return out;
}

/**
 * Comments do not count as passing the field. The first version of this guard
 * checked the raw argument text, so the explanatory comment beside each call —
 * which necessarily names `projectId` — satisfied it. Deleting the actual
 * property left the guard green.
 */
function withoutComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** The full `(...)` of the call starting at `from`, paren-balanced. */
function callArguments(source: string, from: number): string {
	const open = source.indexOf("(", from);
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		if (source[i] === "(") {
			depth++;
		} else if (source[i] === ")") {
			depth--;
			if (depth === 0) {
				return source.slice(open, i + 1);
			}
		}
	}
	return "";
}

describe("AI model resolution carries project scope", () => {
	it("no call builds an inline context that omits projectId", () => {
		const offenders: string[] = [];
		let callSites = 0;

		for (const file of tsFiles(AI_LIB)) {
			// The resolver defines and documents the parameter; it is not a caller.
			if (file.includes("dynamic-model-selector")) {
				continue;
			}
			const source = readFileSync(file, "utf8");
			const pattern = /getAIModelWithMetadata\(/g;
			let match: RegExpExecArray | null = pattern.exec(source);
			while (match !== null) {
				callSites++;
				const args = withoutComments(
					callArguments(source, match.index),
				);
				// Second argument: everything after the options object.
				const contextArg = args.slice(args.indexOf("},") + 2).trim();
				const buildsInlineContext = contextArg.startsWith("{");
				if (buildsInlineContext && !contextArg.includes("projectId")) {
					offenders.push(
						`${file}: ${contextArg.replace(/\s+/g, " ")}`,
					);
				}
				match = pattern.exec(source);
			}
		}

		// Guards the guard: a refactor that renames the function would silently
		// empty this test rather than failing it.
		expect(callSites).toBeGreaterThan(3);
		expect(offenders).toEqual([]);
	});
});
