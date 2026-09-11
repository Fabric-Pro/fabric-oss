/**
 * `thresholds.ts` is deliberately IMPORT-FREE — its own file comment says so
 * (Fizzy #2457): a client component
 * (`ProjectReadinessPanel.tsx`) reads `CLI_ITEM_KEY` from it via a deep
 * import specifically BECAUSE the file carries no import of its own. An
 * added "convenience" import there — even a type-only one — would quietly
 * drag a server module into the browser bundle, and nothing in a normal
 * build would flag it: bundlers do not warn about a leaf file that stops
 * being a leaf.
 *
 * Nothing else enforces that property — no lint rule targets this file, and
 * every other test in this directory exercises behaviour rather than shape.
 * This test reads the module's own source text and fails, with an
 * explanation, the moment an `import` or `require` appears in it.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const THRESHOLDS_PATH = resolve(__dirname, "../thresholds.ts");

describe("thresholds.ts — import-free", () => {
	it("declares no import or require statement", () => {
		const source = readFileSync(THRESHOLDS_PATH, "utf8");

		const importMatches = source.match(/^\s*import\b[^\n]*/gm) ?? [];
		const requireMatches = source.match(/\brequire\s*\(/g) ?? [];

		expect(
			importMatches,
			"thresholds.ts picked up an `import`. This file is deliberately " +
				"import-free so that ProjectReadinessPanel.tsx — a CLIENT " +
				"component — can read CLI_ITEM_KEY from it via a deep import " +
				"without pulling a server module into the browser bundle. " +
				"Adding an import here, even a type-only 'convenience' one, " +
				"breaks that guarantee silently: no bundler warning tells you a " +
				"server dependency just reached the client. Move whatever you " +
				"needed the import for somewhere else, or re-export it through a " +
				"module the client does not read.",
		).toEqual([]);
		expect(
			requireMatches,
			"thresholds.ts picked up a `require(...)` call — the same problem " +
				"as an `import` (see that assertion above): a client component " +
				"reads this file specifically because it carries no module-graph " +
				"dependencies of its own.",
		).toEqual([]);
	});
});
