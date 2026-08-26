import { describe, expect, it } from "vitest";
import { buildTechnicalGraph } from "../graph/build";
import { extractNamespace, resolveNamespaceImport } from "../graph/imports";

describe("extractNamespace", () => {
	it("extracts a C# namespace (file-scoped and block)", () => {
		expect(
			extractNamespace(
				"namespace Healthie.Abstractions;\nclass X {}",
				"C#",
			),
		).toBe("Healthie.Abstractions");
		expect(extractNamespace("namespace Healthie.Api { }", "C#")).toBe(
			"Healthie.Api",
		);
	});
	it("extracts a Java package", () => {
		expect(extractNamespace("package com.acme.svc;\n", "Java")).toBe(
			"com.acme.svc",
		);
	});
	it("normalises PHP backslashes to dots", () => {
		expect(extractNamespace("<?php\nnamespace App\\Models;\n", "PHP")).toBe(
			"App.Models",
		);
	});
	it("returns null for path-based languages", () => {
		expect(
			extractNamespace("import x from './y'", "TypeScript"),
		).toBeNull();
	});
});

describe("resolveNamespaceImport (longest-prefix)", () => {
	const map = new Map<string, Set<string>>([
		["Healthie.Abstractions", new Set(["src/Healthie.Abstractions"])],
		[
			"Healthie.Abstractions.Models",
			new Set(["src/Healthie.Abstractions/Models"]),
		],
	]);
	it("resolves an exact namespace (C# `using Ns`)", () => {
		expect([
			...(resolveNamespaceImport("Healthie.Abstractions", map) ?? []),
		]).toEqual(["src/Healthie.Abstractions"]);
	});
	it("resolves a class import via prefix (Java `import pkg.Class`)", () => {
		expect([
			...(resolveNamespaceImport(
				"Healthie.Abstractions.Models.Foo",
				map,
			) ?? []),
		]).toEqual(["src/Healthie.Abstractions/Models"]);
	});
	it("returns null for an unknown (external) namespace", () => {
		expect(resolveNamespaceImport("System.Text.Json", map)).toBeNull();
	});
});

describe("buildTechnicalGraph — namespace (C#) module dependencies", () => {
	const files = [
		{
			path: "src/Core/Service.cs",
			content:
				"namespace App.Core;\nusing App.Data;\npublic class Service {}",
		},
		{
			path: "src/Data/Repo.cs",
			content: "namespace App.Data;\npublic class Repo {}",
		},
	];
	it("creates a DEPENDS_ON edge from a `using` statement", async () => {
		const graph = await buildTechnicalGraph(files);
		const deps = graph.edges.filter((e) => e.kind === "DEPENDS_ON");
		expect(deps).toContainEqual(
			expect.objectContaining({
				source: "src/Core",
				target: "src/Data",
				kind: "DEPENDS_ON",
			}),
		);
	});
});
