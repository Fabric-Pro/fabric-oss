/**
 * `findLayerViolations` — the architecture lens's second rule set.
 *
 * Tested to the same standard as the cycle detector, and for the same reason: the
 * lens claims its findings cannot be confidently wrong, and that claim is only as
 * good as these functions. A rule that fires on a legitimate import is worse than
 * no rule, because it costs somebody an afternoon proving the tool wrong.
 */

import { describe, expect, it } from "vitest";

import { findImportCycles } from "../lib/import-cycles";
import { findLayerViolations, owningPackage } from "../lib/layer-rules";

const declared = (entries: Array<[string, string[]]>) =>
	new Map(entries.map(([pkg, deps]) => [pkg, new Set(deps)]));

const DECLARED = declared([
	["packages/api", ["packages/database", "packages/utils"]],
	["packages/database", ["packages/utils"]],
	["packages/utils", []],
	["apps/web", ["packages/api", "packages/utils"]],
]);

const find = (edges: Array<{ from: string; to: string }>) =>
	findLayerViolations({ edges, declaredDependencies: DECLARED });

describe("owningPackage", () => {
	it.each([
		["packages/api/modules/x.ts", "packages/api"],
		["apps/web/app/page.tsx", "apps/web"],
	])("maps %s to %s", (path, expected) => {
		expect(owningPackage(path)).toBe(expected);
	});

	it("returns null outside packages/ and apps/", () => {
		// Root tooling and config belong to no package and are governed by neither
		// rule; claiming otherwise would fire on every config edit.
		expect(owningPackage("tooling/docs-screenshots/render.mjs")).toBeNull();
		expect(owningPackage("turbo.json")).toBeNull();
	});
});

describe("findLayerViolations", () => {
	it("allows a declared dependency", () => {
		expect(
			find([
				{
					from: "packages/api/modules/x.ts",
					to: "packages/database/prisma/y.ts",
				},
			]),
		).toEqual([]);
	});

	it("allows an app importing a package it declares", () => {
		expect(
			find([{ from: "apps/web/app/p.tsx", to: "packages/api/index.ts" }]),
		).toEqual([]);
	});

	it("ignores an edge inside one package", () => {
		// How a package arranges itself is its own business; the cycle check covers
		// the shape of that.
		expect(
			find([{ from: "packages/api/a.ts", to: "packages/api/b.ts" }]),
		).toEqual([]);
	});

	it("ignores an edge outside the workspace", () => {
		expect(
			find([{ from: "turbo.json", to: "packages/api/index.ts" }]),
		).toEqual([]);
	});

	it("flags an undeclared workspace dependency", () => {
		const [violation] = find([
			{ from: "packages/database/q.ts", to: "packages/api/index.ts" },
		]);

		expect(violation.rule).toBe("undeclared-dependency");
		// The detail has to say why it matters, not just that it happened: it
		// resolves TODAY and breaks when the tree shifts, which is the part a
		// reader needs to hear.
		expect(violation.detail).toMatch(/pnpm hoisted it/);
	});

	it("flags a library importing an application", () => {
		const [violation] = find([
			{ from: "packages/utils/lib/x.ts", to: "apps/web/modules/y.ts" },
		]);

		expect(violation.rule).toBe("library-imports-app");
		expect(violation.detail).toMatch(/unusable in any other app/);
	});

	it("prefers library-imports-app over undeclared for the same edge", () => {
		// packages/utils declares nothing, so this edge breaks both rules. The
		// direction is the more useful thing to be told.
		const found = find([
			{ from: "packages/utils/lib/x.ts", to: "apps/web/modules/y.ts" },
		]);

		expect(found).toHaveLength(1);
		expect(found[0].rule).toBe("library-imports-app");
	});

	it("reports one finding per package pair, not per file", () => {
		// Twenty files in one package importing the same offending package is ONE
		// architectural fact; twenty rows would bury everything else in the review.
		const found = find(
			Array.from({ length: 20 }, (_, i) => ({
				from: `packages/database/q${i}.ts`,
				to: "packages/api/index.ts",
			})),
		);

		expect(found).toHaveLength(1);
	});

	it("is stable across edge ordering", () => {
		const edges = [
			{ from: "packages/utils/a.ts", to: "apps/web/b.ts" },
			{ from: "packages/database/c.ts", to: "packages/api/d.ts" },
		];

		expect(find([...edges].reverse())).toEqual(find(edges));
	});

	it("treats a package with no declaration entry as declaring nothing", () => {
		// A package missing from the map must not silently pass — absent is not
		// permissive, or a lookup miss would disable the rule.
		const found = findLayerViolations({
			edges: [{ from: "packages/unknown/a.ts", to: "packages/api/b.ts" }],
			declaredDependencies: DECLARED,
		});

		expect(found).toHaveLength(1);
		expect(found[0].rule).toBe("undeclared-dependency");
	});
});

describe("the two rule sets are independent", () => {
	it("a cycle is not reported as a layer violation, or vice versa", () => {
		// A legitimate two-way dependency between packages that BOTH declare each
		// other is a cycle but not a layer violation; the lens must say the right
		// one, because the remedies differ.
		const edges = [
			{ from: "packages/api/a.ts", to: "packages/utils/b.ts" },
			{ from: "packages/utils/b.ts", to: "packages/api/a.ts" },
		];
		const mutual = declared([
			["packages/api", ["packages/utils"]],
			["packages/utils", ["packages/api"]],
		]);

		expect(
			findLayerViolations({ edges, declaredDependencies: mutual }),
		).toEqual([]);
		expect(findImportCycles(edges)).toHaveLength(1);
	});
});
