import { describe, expect, it } from "vitest";
import { compileGlob } from "../src/ignore";

const REGEXP_ESCAPE_CHARS = new Set([
	".",
	"+",
	"^",
	"$",
	"{",
	"}",
	"(",
	")",
	"|",
	"[",
	"]",
	"\\",
]);

/** The translation `compileGlob` replaced, kept here as the oracle. */
function oracleRegExp(glob: string): RegExp {
	let g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
	if (g.endsWith("/")) {
		g = `${g}**`;
	}
	let re = "";
	for (let i = 0; i < g.length; i++) {
		const c = g.charAt(i);
		if (c === "*") {
			if (g.charAt(i + 1) === "*") {
				const slashAfter = g.charAt(i + 2) === "/";
				re += slashAfter ? "(?:.*/)?" : ".*";
				i += slashAfter ? 2 : 1;
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else if (REGEXP_ESCAPE_CHARS.has(c)) {
			re += `\\${c}`;
		} else {
			re += c;
		}
	}
	return new RegExp(`^${re}$`, "i");
}

const GLOBS = [
	"",
	"*",
	"**",
	"**/",
	"a/",
	"./a/b",
	"a\\b\\*.md",
	"**/.git/**",
	".git",
	".fabric/**",
	"**/*.pem",
	"**/.env.*",
	"**/node_modules/**",
	"**/CLAUDE.local.md",
	"retro.md",
	"docs/**/*.md",
	"docs/**/guide?.md",
	"a/**/b/**/c",
	"***",
	"**a**",
	"*/*",
	"a?c",
	"??",
	"[x](y)+{z}|^$.",
	"ÄÖ*",
	"ǅ*",
	"ß*",
	"**/**/x",
	"x/**/",
	"*a*a*c",
	"?*?",
];

const PATHS = [
	"",
	"a",
	"a/",
	"a/b",
	"a/b/c",
	"a/x/b/y/c",
	"a/b/b/c",
	".git",
	".git/config",
	"pkg/.git/config",
	"pkg/.GIT/config",
	".fabric",
	".fabric/instructions.lock",
	"id.pem",
	"deep/er/ID.PEM",
	".env",
	".env.local",
	"apps/web/.env.production",
	"node_modules/x/index.js",
	"apps/web/node_modules/x",
	"CLAUDE.local.md",
	"pkg/claude.LOCAL.md",
	"retro.md",
	"docs/retro.md",
	"docs/guide1.md",
	"docs/a/b/guide1.md",
	"docs/a/b/guide12.md",
	"docs/intro.md",
	"abc",
	"a/c",
	"ab",
	"[x](y)+{z}|^$.",
	"äö",
	"ÄÖx",
	"ǆx",
	"ß",
	"SS",
	"x",
	"x/x",
	"a\nb",
	"a\nb/c",
	"a b",
	"aac",
	"aaxac",
	"xac",
	"a b.md",
];

describe("compileGlob", () => {
	it("agrees with the regular-expression translation it replaced", () => {
		const disagreements: string[] = [];
		for (const glob of GLOBS) {
			const oracle = oracleRegExp(glob);
			const matcher = compileGlob(glob);
			for (const path of PATHS) {
				if (oracle.test(path) !== matcher.test(path)) {
					disagreements.push(
						`${JSON.stringify(glob)} vs ${JSON.stringify(path)}`,
					);
				}
			}
		}

		expect(disagreements).toEqual([]);
	});

	it("agrees with the oracle over generated globs and paths", () => {
		const alphabet = ["a", "b", "/", "*", "?", ".", "A"];
		const words: string[] = [""];
		for (let length = 1; length <= 5; length++) {
			const previous = words.filter((w) => w.length === length - 1);
			for (const word of previous) {
				for (const c of alphabet) {
					words.push(word + c);
				}
			}
		}
		const globs = words.filter((_, i) => i % 7 === 0);
		const paths = words
			.filter((w) => !/[*?]/.test(w))
			.filter((_, i) => i % 3 === 0);
		let compared = 0;
		const disagreements: string[] = [];
		for (const glob of globs) {
			const oracle = oracleRegExp(glob);
			const matcher = compileGlob(glob);
			for (const path of paths) {
				compared++;
				if (oracle.test(path) !== matcher.test(path)) {
					disagreements.push(
						`${JSON.stringify(glob)} vs ${JSON.stringify(path)}`,
					);
				}
			}
		}

		expect(compared).toBeGreaterThan(100_000);
		expect(disagreements).toEqual([]);
	});

	it("matches an adversarial glob against a long name in linear time", () => {
		const matcher = compileGlob("*a*a*a*a*a*a*a*a*a*a*a*a*c");
		const name = "a".repeat(500);

		const start = performance.now();
		const matched = matcher.test(name);
		const elapsed = performance.now() - start;

		expect(matched).toBe(false);
		expect(elapsed).toBeLessThan(50);
	});

	it("matches a nested ** glob against a long path in linear time", () => {
		const matcher = compileGlob("**/a/**/a/**/a/**/a/**/a/**/c");
		const path = "a/".repeat(2000);

		const start = performance.now();
		const matched = matcher.test(path);
		const elapsed = performance.now() - start;

		expect(matched).toBe(false);
		expect(elapsed).toBeLessThan(250);
	});
});
