import { describe, expect, it } from "vitest";
import {
	centralPackageNames,
	detectRepositoryStack,
	dotnetRuntimes,
	infrastructureResourceTypes,
	repositoryProfile,
} from "../src/repo-stack";

const pkg = (name: string, source = "src/Api/Api.csproj") => ({
	ecosystem: "nuget",
	name,
	kind: "library",
	dev: false,
	source,
});

describe("repository stack", () => {
	it("names the technologies behind the packages, with where they were seen", () => {
		const stack = detectRepositoryStack({
			paths: ["src/Api/Program.cs", "infra/main.bicep", "azure.yaml"],
			packages: [
				pkg("Microsoft.Azure.Cosmos"),
				pkg("Microsoft.Orleans.Server"),
				pkg(
					"Aspire.Hosting.Azure.Storage",
					"src/AppHost/AppHost.csproj",
				),
				pkg("Telegram.Bot"),
				pkg("xunit", "tests/Api.Tests/Api.Tests.csproj"),
			],
			runtimes: [{ name: ".NET 10", source: "src/Api/Api.csproj" }],
			resources: [
				{
					type: "Microsoft.AppConfiguration/configurationStores",
					source: "infra/main.bicep",
				},
			],
		});
		const names = stack.map((t) => t.name);
		expect(names).toEqual(
			expect.arrayContaining([
				"C#",
				".NET 10",
				"Azure Cosmos DB",
				"Orleans",
				"Azure Storage",
				"Azure App Configuration",
				"Telegram Bot API",
				"xUnit",
				"Bicep",
				"Azure Developer CLI",
			]),
		);
		expect(stack.find((t) => t.name === "Azure Cosmos DB")).toMatchObject({
			category: "data",
			evidence: ["src/Api/Api.csproj"],
		});
		expect(stack[0]?.category).toBe("language");
	});

	it("reads central package versions, target frameworks and resource types", () => {
		expect(
			centralPackageNames(
				'<Project><ItemGroup><PackageVersion Include="Microsoft.Azure.Cosmos" Version="3.4" /></ItemGroup></Project>',
			),
		).toEqual(["Microsoft.Azure.Cosmos"]);
		expect(
			dotnetRuntimes(
				"<TargetFrameworks>net10.0;net9.0</TargetFrameworks>",
			),
		).toEqual([".NET 10", ".NET 9"]);
		expect(
			infrastructureResourceTypes(
				'resource cosmos \'Microsoft.DocumentDB/databaseAccounts@2024-05-15\' = {}\nresource "azurerm_storage_account" "s" {}',
			),
		).toEqual([
			"Microsoft.DocumentDB/databaseAccounts",
			"azurerm_storage_account",
		]);
	});

	it("tells code, docs and mixed repositories apart", () => {
		expect(repositoryProfile(["a.cs", "b.cs", "README.md"]).kind).toBe(
			"code",
		);
		expect(repositoryProfile(["guide.md", "faq.md"]).kind).toBe("docs");
		expect(
			repositoryProfile([
				...Array.from({ length: 30 }, (_, i) => `docs/${i}.md`),
				...Array.from({ length: 60 }, (_, i) => `src/${i}.cs`),
			]).kind,
		).toBe("mixed");
		expect(repositoryProfile(["node_modules/x/a.js"]).kind).toBe("empty");
	});
});
