import { describe, expect, it } from "vitest";
import {
	isManifestPath,
	parsePublishedPackages,
	parseTechStack,
} from "../graph/manifest";

describe("isManifestPath", () => {
	it("recognises manifests incl. .csproj", () => {
		expect(isManifestPath("src/Healthie.Api/Healthie.Api.csproj")).toBe(
			true,
		);
		expect(isManifestPath("package.json")).toBe(true);
		expect(isManifestPath("go.mod")).toBe(true);
		expect(isManifestPath("src/Service.cs")).toBe(false);
	});
});

describe("parseTechStack", () => {
	it("parses a .csproj (PackageReference + TargetFramework)", () => {
		const csproj = `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Quartz" Version="3.8.0" />
    <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="8.0.1" />
  </ItemGroup>
</Project>`;
		const stack = parseTechStack([
			{ path: "a/Api.csproj", content: csproj },
		]);
		expect(stack).toContainEqual(
			expect.objectContaining({
				ecosystem: "nuget",
				name: "Quartz",
				version: "3.8.0",
			}),
		);
		expect(stack).toContainEqual(
			expect.objectContaining({
				name: ".NET",
				version: "net8.0",
				kind: "runtime",
			}),
		);
		// ASP.NET family classified as framework
		expect(
			stack.find((e) => e.name === "Microsoft.AspNetCore.OpenApi")?.kind,
		).toBe("framework");
	});

	it("parses package.json deps/devDeps/engines", () => {
		const pkg = JSON.stringify({
			dependencies: { react: "^19.0.0", lodash: "4.17.21" },
			devDependencies: { vitest: "^3.0.0" },
			engines: { node: ">=20" },
		});
		const stack = parseTechStack([{ path: "package.json", content: pkg }]);
		expect(stack.find((e) => e.name === "react")?.kind).toBe("framework");
		expect(stack.find((e) => e.name === "lodash")?.dev).toBe(false);
		expect(stack.find((e) => e.name === "vitest")?.dev).toBe(true);
		expect(stack.find((e) => e.name === "node")?.kind).toBe("runtime");
	});

	it("parses go.mod require + go version", () => {
		const gomod =
			"module example.com/app\n\ngo 1.21\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n\tgithub.com/lib/pq v1.10.9 // indirect\n)";
		const stack = parseTechStack([{ path: "go.mod", content: gomod }]);
		expect(stack.find((e) => e.name === "go")?.version).toBe("1.21");
		expect(
			stack.find((e) => e.name === "github.com/gin-gonic/gin")?.version,
		).toBe("v1.9.1");
		expect(stack.find((e) => e.name === "github.com/lib/pq")?.dev).toBe(
			true,
		);
	});

	it("de-dupes and returns runtime/framework first", () => {
		const stack = parseTechStack([
			{
				path: "package.json",
				content: JSON.stringify({
					dependencies: { next: "15", left: "1" },
				}),
			},
		]);
		expect(
			stack[0].kind === "runtime" || stack[0].kind === "framework",
		).toBe(true);
	});
});

describe("parsePublishedPackages", () => {
	it("captures every workspace package name in a monorepo", () => {
		const names = parsePublishedPackages([
			{ path: "package.json", content: JSON.stringify({ name: "root" }) },
			{
				path: "packages/api/package.json",
				content: JSON.stringify({ name: "@acme/api" }),
			},
			{
				path: "packages/ui/package.json",
				content: JSON.stringify({ name: "@acme/ui" }),
			},
		]);
		expect(names).toEqual(["@acme/api", "@acme/ui", "root"]);
	});

	it("reads identities across ecosystems and ignores malformed/anonymous manifests", () => {
		const names = parsePublishedPackages([
			{
				path: "go.mod",
				content: "module github.com/acme/svc\ngo 1.22\n",
			},
			{
				path: "src/Cli/Cli.csproj",
				content:
					"<Project><PropertyGroup><PackageId>Acme.Cli</PackageId></PropertyGroup></Project>",
			},
			{ path: "Cargo.toml", content: '[package]\nname = "acme-core"\n' },
			{ path: "package.json", content: "{ not json" },
			{ path: "packages/private/package.json", content: "{}" },
		]);
		expect(names).toEqual(["Acme.Cli", "acme-core", "github.com/acme/svc"]);
	});
});

it("handles hostile manifest delimiters in linear time", () => {
	const start = performance.now();
	for (const [path, content] of [
		["a.csproj", '<packagereference\tinclude="!"='.repeat(2000)],
		["go.mod", `require(${"require(a".repeat(6000)}`],
		["pom.xml", "<dependency>".repeat(4200)],
	] as const) {
		parseTechStack([{ path, content }]);
	}
	expect(performance.now() - start).toBeLessThan(100);
});

it("preserves Maven dependency names and optional versions", () => {
	expect(
		parseTechStack([
			{
				path: "pom.xml",
				content:
					"<dependency><artifactId>example-lib</artifactId><version>1.2.3</version></dependency><dependency><artifactId>other-lib</artifactId></dependency>",
			},
		]),
	).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ name: "example-lib", version: "1.2.3" }),
			expect.objectContaining({ name: "other-lib", version: null }),
		]),
	);
});

for (const tag of ["PackageId", "AssemblyName"]) {
	it(`bounds published ${tag} parsing`, () => {
		const start = performance.now();
		expect(
			parsePublishedPackages([
				{
					path: "example.csproj",
					content: `<${tag}>${" ".repeat(50000)}`,
				},
			]),
		).toEqual(["example"]);
		expect(
			parsePublishedPackages([
				{
					path: "example.csproj",
					content: `<${tag}>  Example.Library  </${tag}>`,
				},
			]),
		).toEqual(["Example.Library"]);
		expect(performance.now() - start).toBeLessThan(500);
	});
}
for (const [name, path] of [
	["go version", "go.mod"],
	["single require", "go.mod"],
	["gem", "Gemfile"],
	["module", "go.mod"],
] as const) {
	it(`bounds multiline ${name} scanning`, () => {
		// U+2028 is also a line end for `^` under the m flag.
		const text = `${"\n".repeat(50000)}${"\u2028".repeat(50000)}x`;
		const start = performance.now();
		if (name === "module") {
			expect(parsePublishedPackages([{ path, content: text }])).toEqual(
				[],
			);
		} else {
			expect(parseTechStack([{ path, content: text }])).toEqual([]);
		}
		expect(performance.now() - start).toBeLessThan(500);
	});
}

it("preserves indented Go and Ruby declarations", () => {
	expect(
		parsePublishedPackages([
			{ path: "go.mod", content: "\tmodule example.com/library\n" },
		]),
	).toEqual(["example.com/library"]);
	expect(
		parseTechStack([
			{
				path: "go.mod",
				content: "\tgo 1.22\n\trequire example.com/library v1.2.3\n",
			},
		]),
	).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ name: "go", version: "1.22" }),
			expect.objectContaining({
				name: "example.com/library",
				version: "v1.2.3",
			}),
		]),
	);
	expect(
		parseTechStack([
			{ path: "Gemfile", content: "\tgem 'example-lib', '1.2.3'\n" },
		]),
	).toEqual([
		expect.objectContaining({ name: "example-lib", version: "1.2.3" }),
	]);
});
