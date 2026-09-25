import { describe, expect, it } from "vitest";
import { extractImports, indexFileKeys, resolveImport } from "../graph/imports";

describe("extractImports", () => {
	it("extracts TypeScript/JS import forms", () => {
		const content = [
			`import { a } from "./a";`,
			`import b from '../b';`,
			`export { c } from "./c";`,
			`const d = require("./d");`,
			`const e = await import("./e");`,
			`import "./side-effect";`,
		].join("\n");
		const specs = extractImports(content, "TypeScript");
		expect(specs).toEqual(
			expect.arrayContaining([
				"./a",
				"../b",
				"./c",
				"./d",
				"./e",
				"./side-effect",
			]),
		);
	});

	it("extracts Python imports", () => {
		const content = [
			"from app.models import User",
			"import app.utils",
		].join("\n");
		const specs = extractImports(content, "Python");
		expect(specs).toEqual(
			expect.arrayContaining(["app.models", "app.utils"]),
		);
	});

	it("extracts Go grouped imports", () => {
		const content = ['import (\n\t"fmt"\n\t"app/internal/db"\n)'].join(
			"\n",
		);
		const specs = extractImports(content, "Go");
		expect(specs).toEqual(
			expect.arrayContaining(["fmt", "app/internal/db"]),
		);
	});

	it("returns nothing for unknown languages", () => {
		expect(extractImports("anything", null)).toEqual([]);
	});
});

describe("resolveImport", () => {
	const fileKeys = indexFileKeys([
		"src/a/foo.ts",
		"src/b/bar.ts",
		"src/b/index.ts",
		"packages/web/modules/saas/projects/Thing.tsx",
	]);

	it("resolves a relative import with an implied extension", () => {
		expect(resolveImport("../b/bar", "src/a/foo.ts", fileKeys)).toBe(
			"src/b/bar.ts",
		);
	});

	it("resolves a relative directory import to index", () => {
		expect(resolveImport("../b", "src/a/foo.ts", fileKeys)).toBe(
			"src/b/index.ts",
		);
	});

	it("resolves an aliased import via suffix match", () => {
		expect(
			resolveImport("@saas/projects/Thing", "src/a/foo.ts", fileKeys),
		).toBe("packages/web/modules/saas/projects/Thing.tsx");
	});

	it("returns null for external packages", () => {
		expect(resolveImport("react", "src/a/foo.ts", fileKeys)).toBeNull();
		expect(
			resolveImport("@types/node", "src/a/foo.ts", fileKeys),
		).toBeNull();
	});

	it("resolves bare specifiers exactly as scanning every key did", () => {
		const keys = [
			"apps/web/lib/util.ts",
			"packages/api/lib/util.ts",
			"packages/api/lib/util/index.ts",
			"lib/util.ts",
			"svc/pkg/__init__.py",
			"cmd/server/main.go",
			"src/main/java/com/example/App.java",
			"ui/Button.vue",
			"/rooted/abs.ts",
			"trailing/",
			"double//slash.ts",
			"dotted.name/file.rs",
			"lib/util",
		];
		const index = indexFileKeys(keys);
		for (const spec of [
			"@x/lib/util",
			"lib/util",
			"@repo/api/lib/util",
			"~/util",
			"react",
			"svc.pkg",
			"server/main",
			"com.example.App",
			"@ui/Button",
			"rooted/abs",
			"/slash",
			"dotted/name/file",
			"trailing",
		]) {
			expect(resolveImport(spec, "src/a/foo.ts", index)).toBe(
				scanResolve(spec, keys),
			);
		}
	});

	it("never scans the file set to resolve an import", () => {
		const keys = Array.from(
			{ length: 500 },
			(_, i) => `packages/p${i}/src/f${i}.ts`,
		);
		const built = indexFileKeys(keys);
		let scans = 0;
		class CountingSet extends Set<string> {
			override [Symbol.iterator]() {
				scans++;
				return super[Symbol.iterator]();
			}
			override values() {
				scans++;
				return super.values();
			}
			override forEach(
				cb: (value: string, key: string, set: Set<string>) => void,
			) {
				scans++;
				super.forEach(cb);
			}
		}
		const index = { keys: new CountingSet(keys), bySuffix: built.bySuffix };
		scans = 0;
		for (let i = 0; i < 200; i++) {
			// External packages match nothing: the case that scanned every key.
			expect(
				resolveImport(
					`@scope/pkg-${i}/deep/path`,
					"src/a/foo.ts",
					index,
				),
			).toBeNull();
			expect(
				resolveImport(`p${i}/src/f${i}`, "src/a/foo.ts", index),
			).toBe(`packages/p${i}/src/f${i}.ts`);
		}
		expect(scans).toBe(0);
	});

	it("keeps the index linear in file count for deeply nested paths", () => {
		const dirs = Array.from({ length: 5000 }, (_, i) => `d${i}`).join("/");
		const deep = `${dirs}/leaf.ts`;
		const index = indexFileKeys([deep, "src/a.ts"]);
		expect(index.bySuffix.size).toBeLessThanOrEqual(2 * 32);
		expect(resolveImport("leaf", "src/a.ts", index)).toBe(deep);
		// Beyond the index depth an exact key still resolves.
		expect(resolveImport(`@${dirs}/leaf`, "src/a.ts", index)).toBe(deep);
	});

	describe("at the 32-segment index depth", () => {
		/** `count` directory segments, then `leaf.ts`. */
		const pathOf = (prefix: string, count: number): string =>
			`${Array.from({ length: count }, (_, i) => `${prefix}${i}`).join("/")}/leaf.ts`;
		// `@` + a path without its extension: the candidate `<path>.ts` then has
		// exactly the path's segment count.
		const specFor = (key: string): string => `@${key.replace(/\.ts$/, "")}`;

		it("keeps first-key precedence for a 32-segment candidate", () => {
			const exact = pathOf("s", 31); // 32 segments
			const earlier = `x/${exact}`;
			const index = indexFileKeys([earlier, exact]);
			expect(resolveImport(specFor(exact), "src/a.ts", index)).toBe(
				earlier,
			);
		});

		it("resolves a 33-segment candidate by exact key", () => {
			const exact = pathOf("s", 32); // 33 segments
			const index = indexFileKeys(["src/a.ts", exact]);
			expect(resolveImport(specFor(exact), "src/a.ts", index)).toBe(
				exact,
			);
		});

		it("still tries the alias-root-dropped candidate after a 33-segment miss", () => {
			const spec = pathOf("s", 32); // 33 segments, not a key
			const withoutRoot = spec.split("/").slice(1).join("/"); // 32 segments
			const other = `other/${withoutRoot}`;
			const index = indexFileKeys(["src/a.ts", other]);
			expect(resolveImport(specFor(spec), "src/a.ts", index)).toBe(other);
		});

		it("returns null for a 33-segment candidate that matches nothing", () => {
			const spec = pathOf("s", 32);
			const index = indexFileKeys(["src/a.ts", pathOf("t", 32)]);
			expect(resolveImport(specFor(spec), "src/a.ts", index)).toBeNull();
		});
	});
});

/** The pre-index resolution for a bare specifier: scan every key per
 * candidate. Kept as the oracle the index must agree with. */
function scanResolve(spec: string, keys: string[]): string | null {
	const cleaned = spec
		.replace(/^[@~]/, "")
		.replace(/\\/g, "/")
		.replace(/\./g, "/")
		.replace(/^\/+/, "");
	if (!cleaned || cleaned.length < 3) {
		return null;
	}
	const suffixes = [cleaned, cleaned.split("/").slice(1).join("/")].filter(
		(s) => s.length >= 3,
	);
	// The resolver's CODE_EXTENSIONS, in order.
	const exts = [
		"ts",
		"tsx",
		"mts",
		"cts",
		"js",
		"jsx",
		"mjs",
		"cjs",
		"py",
		"go",
		"rs",
		"java",
		"kt",
		"rb",
		"php",
		"cs",
		"c",
		"h",
		"cpp",
		"cc",
		"hpp",
		"swift",
		"scala",
		"vue",
		"svelte",
	];
	for (const suffix of suffixes) {
		const candidates = [suffix];
		for (const ext of exts) {
			candidates.push(
				`${suffix}.${ext}`,
				`${suffix}/index.${ext}`,
				`${suffix}/__init__.${ext}`,
			);
		}
		for (const cand of candidates) {
			for (const key of keys) {
				if (key === cand || key.endsWith(`/${cand}`)) {
					return key;
				}
			}
		}
	}
	return null;
}
