/**
 * Guard: no `text-secondary` anywhere under `modules/`.
 *
 * `--secondary` was the emerald success colour until the design system made it a
 * light neutral surface (`#f1f3f6` light, `#222c34` dark). Every component that
 * still painted text with it went near-invisible: added diff lines, "Passed"
 * results, "Ready" states and "Connected" chips were grey on white. Text on a
 * surface token can never be readable, so the class is banned outright.
 *
 * Use `text-success` for a positive state (passed, ready, connected, added,
 * complete) or `text-muted-foreground` for de-emphasised text.
 * `text-secondary-foreground` is the ink paired with the surface and stays
 * allowed. Tests are out of scope.
 */

import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const webRoot = resolve(__dirname, "..");
const SEARCH_ROOT = resolve(webRoot, "modules");

const SECONDARY_TEXT = /(?<![\w-])text-secondary(?![\w-])/;

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = resolve(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "__tests__") {
				continue;
			}
			walk(full, out);
			continue;
		}
		if (
			!/\.tsx?$/.test(entry.name) ||
			/\.(test|spec|stories)\./.test(entry.name)
		) {
			continue;
		}
		out.push(full);
	}
	return out;
}

function findSecondaryText(source: string): number[] {
	const lines: number[] = [];
	source.split("\n").forEach((line, index) => {
		if (SECONDARY_TEXT.test(line)) {
			lines.push(index + 1);
		}
	});
	return lines;
}

describe("no text-secondary colour", () => {
	it("recognises the class it is meant to catch", () => {
		// Guards the guard: a pattern that matched nothing would pass forever.
		expect(findSecondaryText('className="size-4 text-secondary"')).toEqual([
			1,
		]);
		expect(findSecondaryText('"hover:text-secondary/80"')).toEqual([1]);
		expect(findSecondaryText('"dark:text-secondary"')).toEqual([1]);
		expect(
			findSecondaryText('"bg-secondary text-secondary-foreground"'),
		).toEqual([]);
		expect(findSecondaryText("  --text-secondary: #57534e;")).toEqual([]);
		expect(
			findSecondaryText('"text-success text-muted-foreground"'),
		).toEqual([]);
	});

	it("finds no text-secondary under modules/", () => {
		const offenders: string[] = [];
		for (const file of walk(SEARCH_ROOT)) {
			const path = relative(webRoot, file).split(sep).join("/");
			for (const line of findSecondaryText(readFileSync(file, "utf8"))) {
				offenders.push(`${path}:${line}`);
			}
		}
		expect(
			offenders,
			"text-secondary is a grey surface colour and unreadable as text — use text-success for a positive state or text-muted-foreground for de-emphasised text",
		).toEqual([]);
	});
});
