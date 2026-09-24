/**
 * Pipeline retirement — regression guard.
 *
 * The Pipeline tab was the last surface that turned a generated Features
 * document into Roadmap work: `pipeline.*` generated the documents,
 * `projects.stories.pushToKanban` parsed the Features document into stories,
 * and `projects.stories.clear` wiped what an earlier push had created (and, by
 * default, the Features document itself). Feature recommendations now live in
 * Roadmap, and the retirement is explicit that NO document-to-Roadmap push
 * comes back, not even as a replacement.
 *
 * Every oRPC procedure is also served over REST, so deleting the UI alone
 * would have left all three callable by API-key clients. This guard keeps them
 * gone at the router, where re-adding one would otherwise pass review as a
 * one-line key.
 *
 * It reads the router sources as text rather than importing them: the
 * projects router pulls in several hundred procedure modules and the whole
 * database graph, which is a lot of boot time to spend proving three keys are
 * absent. `router-diagrams.test.ts` uses the same approach.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(__dirname, "..");

function readSource(relativePath: string): string {
	return readFileSync(resolve(packageRoot, relativePath), "utf8");
}

/**
 * The keys declared directly inside `<name>: { ... }` at the router's top
 * level, ignoring keys of nested sub-routers (the stories router nests
 * `tasks`, `attachments` and others, and `prdSource.clear` is a different
 * procedure altogether).
 */
function topLevelKeysOf(source: string, blockName: string): string[] {
	const opener = `\t${blockName}: {`;
	const start = source.indexOf(opener);
	if (start === -1) {
		throw new Error(`Block "${blockName}" not found in the router source`);
	}
	const keys: string[] = [];
	let depth = 0;
	let lineStart = start + opener.length;
	for (let i = start + opener.length - 1; i < source.length; i++) {
		const char = source[i];
		if (char === "{") {
			depth++;
		} else if (char === "}") {
			depth--;
			if (depth === 0) {
				break;
			}
		} else if (char === "\n") {
			lineStart = i + 1;
		} else if (char === ":" && depth === 1) {
			const key = source.slice(lineStart, i).trim();
			if (/^[A-Za-z_$][\w$]*$/.test(key)) {
				keys.push(key);
			}
		}
	}
	return keys;
}

describe("Pipeline retirement guard", () => {
	it("mounts no pipeline router on the app router", () => {
		const appRouter = readSource("orpc/router.ts");
		expect(appRouter).not.toMatch(/modules\/pipeline\//);
		expect(appRouter).not.toMatch(/^\s*pipeline\s*:/m);
		expect(existsSync(resolve(packageRoot, "modules/pipeline"))).toBe(
			false,
		);
	});

	it("exposes neither pushToKanban nor clear on projects.stories", () => {
		const keys = topLevelKeysOf(
			readSource("modules/projects/router.ts"),
			"stories",
		);
		// Sanity: the scanner found the real block, not an empty match.
		expect(keys).toContain("list");
		expect(keys).toContain("create");
		expect(keys).not.toContain("pushToKanban");
		expect(keys).not.toContain("clear");
	});

	it("keeps the deleted procedure modules deleted", () => {
		for (const path of [
			"modules/projects/procedures/stories/push-to-kanban.ts",
			"modules/projects/procedures/stories/clear-stories.ts",
			"modules/projects/lib/clear-project-stories-with-attachments.ts",
		]) {
			expect(existsSync(resolve(packageRoot, path)), path).toBe(false);
		}
	});
});
