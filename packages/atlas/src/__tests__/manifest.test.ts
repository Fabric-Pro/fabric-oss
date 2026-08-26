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
