/**
 * The server and the CLI must rebase a file the same way.
 *
 * `@fabricorg/cli` is published to npm and cannot import this private
 * package, so it carries its own copy of the merge. A tab rebase and a
 * `push --rebase` of the same three versions must produce the same text, or
 * the two would leave different conflict markers for one change.
 *
 * Two checks: the copies are the same code below their header comments, and
 * they produce the same results on a spread of cases. The CLI module is
 * imported by relative path, as the other agreement tests do.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	threeWayMerge as cliMerge,
	mergeInstructionPath as cliMergePath,
} from "../../cli/src/lib/instructions/three-way-merge";
import { mergeInstructionPath, threeWayMerge } from "../src/three-way-merge";

const labels = { ours: "local", theirs: "published v3" };

function bodyOf(relative: string): string {
	const text = readFileSync(
		fileURLToPath(new URL(relative, import.meta.url)),
		"utf8",
	).replace(/\r\n/g, "\n");
	const end = text.indexOf("*/\n");
	return text.slice(end + 3);
}

const CASES: Array<[string, string, string]> = [
	["a\nb\nc\n", "a\nB\nc\n", "a\nb\nC\n"],
	["a\nb\nc\nd\ne\n", "a\nB\nc\nd\ne\n", "a\nb\nc\nD\ne\n"],
	["a\nb\n", "a\nours\n", "a\ntheirs\n"],
	["m\n", "top\nm\n", "m\nbottom\n"],
	["", "x\n", "y\n"],
	["a\r\nb\r\n", "a\r\nours\r\n", "a\r\ntheirs\r\n"],
	["a\nb", "a\nours", "a\ntheirs"],
];

describe("three-way merge: server and CLI", () => {
	it("are the same code", () => {
		expect(
			bodyOf("../../cli/src/lib/instructions/three-way-merge.ts"),
		).toBe(bodyOf("../src/three-way-merge.ts"));
	});

	it.each(CASES)("merge the same way (%#)", (base, ours, theirs) => {
		expect(cliMerge(base, ours, theirs, labels)).toEqual(
			threeWayMerge(base, ours, theirs, labels),
		);
		const sides = {
			base: { hash: `b:${base}`, text: base },
			ours: { hash: `o:${ours}`, text: ours },
			theirs: { hash: `t:${theirs}`, text: theirs },
			labels,
		};
		expect(cliMergePath(sides)).toEqual(mergeInstructionPath(sides));
	});
});
