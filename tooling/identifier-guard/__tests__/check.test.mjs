import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const CHECK = fileURLToPath(new URL("../check.mjs", import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "identifier-guard-"));

// Deliberately synthetic. Real names must never appear in this repo —
// that is the whole point of the thing under test.
const TERMS = ["ZephyrCorp", "NorthWind Systems", "~Ambig"].join("\n");

/**
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 * @returns {{ code: number, stderr: string }}
 */
function run(args, env = { FABRIC_BLOCKED_TERMS: TERMS }) {
	// spawnSync, not execFileSync: a warn-only finding exits 0 but still writes
	// to stderr, and execFileSync only surfaces stderr on a non-zero exit.
	const res = spawnSync(process.execPath, [CHECK, ...args], {
		env: { ...process.env, FABRIC_BLOCKED_TERMS: "", ...env },
		encoding: "utf8",
	});
	return { code: res.status ?? 1, stderr: String(res.stderr ?? "") };
}

/** @param {string} content @returns {string} path */
function fixture(content) {
	const path = join(TMP, `f-${Math.abs(hash(content))}.txt`);
	writeFileSync(path, content);
	return path;
}

/** @param {string} s @returns {number} */
function hash(s) {
	let h = 0;
	for (let i = 0; i < s.length; i++) {
		h = (h * 31 + s.charCodeAt(i)) | 0;
	}
	return h;
}

describe("identifier-guard — blocks a term whatever shape it is written in", () => {
	const shapes = [
		"uses ZephyrCorp here",
		"uses zephyr-corp here",
		"uses zephyr_corp here",
		"uses zephyr corp here",
		"uses ZEPHYRCORP here",
		"see northwind-systems docs",
	];
	for (const content of shapes) {
		it(`blocks: ${content}`, () => {
			assert.equal(run(["--files", fixture(content)]).code, 1);
		});
	}
});

describe("identifier-guard — does not fire on unrelated text", () => {
	const clean = [
		"nothing to see here",
		"zephyrcorporation is a different word",
		"a northwind without the second word",
	];
	for (const content of clean) {
		it(`allows: ${content}`, () => {
			assert.equal(run(["--files", fixture(content)]).code, 0);
		});
	}
});

describe("identifier-guard — separated-only entries", () => {
	// Synthetic, like every term in this file — a real name must never appear
	// here, which is the whole point of the thing under test. The property being
	// pinned is structural: a two-word entry must stop matching the run-together
	// spelling of its parts, which is what collides with an ordinary word when
	// the parts happen to spell one.
	const SEPARATED = ["+Zephyr Corp"].join("\n");

	const realShapes = [
		"contract with Zephyr Corp here",
		"contract with zephyr-corp here",
		"contract with zephyr_corp here",
		"contract with ZEPHYR CORP here",
	];
	for (const content of realShapes) {
		it(`still blocks the separated spelling: ${content}`, () => {
			assert.equal(
				run(["--files", fixture(content)], {
					FABRIC_BLOCKED_TERMS: SEPARATED,
				}).code,
				1,
			);
		});
	}

	const runTogether = [
		'NEXT_PUBLIC_PRICE_ID_ZEPHYRCORP=""',
		"the zephyrcorp value is about two hours",
		"a per-document zephyrcorp, not a history",
	];
	for (const content of runTogether) {
		it(`allows the concatenation: ${content}`, () => {
			assert.equal(
				run(["--files", fixture(content)], {
					FABRIC_BLOCKED_TERMS: SEPARATED,
				}).code,
				0,
			);
		});
	}

	// The bug this fixes: the same content under a plain entry. Where the
	// run-together spelling is an ordinary word, this is the false positive.
	it("blocks the concatenation without the marker — the behaviour being fixed", () => {
		assert.equal(
			run(
				["--files", fixture("the zephyrcorp value is about two hours")],
				{
					FABRIC_BLOCKED_TERMS: "Zephyr Corp",
				},
			).code,
			1,
		);
	});

	it("accepts the two prefixes in either order", () => {
		for (const list of ["~+Zephyr Corp", "+~Zephyr Corp"]) {
			const res = run(["--files", fixture("Zephyr Corp here")], {
				FABRIC_BLOCKED_TERMS: list,
			});
			// warn-only, so it reports without blocking...
			assert.equal(res.code, 0, list);
			assert.match(res.stderr, /rule #1/, list);
		}
		// ...and separated-only still holds under the same combination.
		assert.equal(
			run(["--files", fixture("the zephyrcorp value")], {
				FABRIC_BLOCKED_TERMS: "~+Zephyr Corp",
			}).stderr,
			"",
		);
	});

	it("has no effect on a single-part term, which has no join to constrain", () => {
		assert.equal(
			run(["--files", fixture("uses Zephyr here")], {
				FABRIC_BLOCKED_TERMS: "+Zephyr",
			}).code,
			1,
		);
	});

	// Parts come from camel-case boundaries too, not only explicit separators,
	// so `+` on a camelCase term also stops matching the run-together form.
	// Surprising enough to pin: a list author reaching for `+` should write the
	// spelling they still want caught.
	it("treats a camel-case boundary as a join, so + drops the run-together form", () => {
		assert.equal(
			run(["--files", fixture("uses ZephyrCorp here")], {
				FABRIC_BLOCKED_TERMS: "+ZephyrCorp",
			}).code,
			0,
		);
		assert.equal(
			run(["--files", fixture("uses zephyr-corp here")], {
				FABRIC_BLOCKED_TERMS: "+ZephyrCorp",
			}).code,
			1,
		);
	});
});

describe("identifier-guard — warn-only entries", () => {
	it("reports but does not block a ~term", () => {
		const { code, stderr } = run(["--files", fixture("the ambig case")]);
		assert.equal(code, 0);
		assert.match(stderr, /WARNING/);
		assert.match(stderr, /\(warn\)/);
	});
});

describe("identifier-guard — never echoes the matched term", () => {
	it("reports a rule index and location instead", () => {
		const { code, stderr } = run([
			"--files",
			fixture("uses ZephyrCorp here"),
		]);
		assert.equal(code, 1);
		assert.doesNotMatch(stderr, /ZephyrCorp/i);
		assert.match(stderr, /rule #1/);
	});

	it("does not echo the term when scanning free text either", () => {
		const { stderr } = run([
			"--text",
			"branch",
			"fix/thing-for-zephyr-corp",
		]);
		assert.doesNotMatch(stderr, /zephyr/i);
		assert.match(stderr, /branch — matched rule #1/);
	});
});

describe("identifier-guard — inert without a term list", () => {
	it("exits 0 so fresh clones and fork PRs are unaffected", () => {
		const { code, stderr } = run(
			["--files", fixture("uses ZephyrCorp here")],
			{
				FABRIC_BLOCKED_TERMS: "",
			},
		);
		assert.equal(code, 0);
		assert.equal(stderr, "");
	});
});

describe("identifier-guard — list parsing", () => {
	it("ignores comments and blank lines", () => {
		const { code } = run(["--files", fixture("uses ZephyrCorp here")], {
			FABRIC_BLOCKED_TERMS: "# a comment\n\nZephyrCorp\n",
		});
		assert.equal(code, 1);
	});

	it("does not turn a comma inside a comment into a rule", () => {
		// Regression: splitting on newline and comma together split the comment
		// and kept everything after the comma as a term, so the words in a
		// comment silently became matchable rules.
		const { code, stderr } = run(
			["--files", fixture("never commit this")],
			{
				FABRIC_BLOCKED_TERMS:
					"# local only, never commit\nZephyrCorp\n",
			},
		);
		assert.equal(code, 0);
		assert.equal(stderr, "");
	});

	it("numbers rules from the first real term, ignoring comments", () => {
		const { stderr } = run(["--files", fixture("uses ZephyrCorp here")], {
			FABRIC_BLOCKED_TERMS: "# a, b, c\n# more, comments\nZephyrCorp\n",
		});
		assert.match(stderr, /rule #1 /);
	});

	it("still accepts a comma-separated list on one line", () => {
		const { code } = run(
			["--files", fixture("uses NorthWind Systems here")],
			{
				FABRIC_BLOCKED_TERMS: "ZephyrCorp, NorthWind Systems",
			},
		);
		assert.equal(code, 1);
	});

	it("scans free text for --text mode", () => {
		assert.equal(run(["--text", "pr-title", "fix for ZephyrCorp"]).code, 1);
		assert.equal(
			run(["--text", "pr-title", "fix for the crawler"]).code,
			0,
		);
	});
});
