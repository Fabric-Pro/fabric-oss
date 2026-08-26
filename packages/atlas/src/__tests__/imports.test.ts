import { describe, expect, it } from "vitest";
import { extractImports, resolveImport } from "../graph/imports";

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
	const fileKeys = new Set([
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
});
