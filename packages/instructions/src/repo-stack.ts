/**
 * What a repository is built with and how it is laid out, for the import
 * (specs/2026-10-23-repository-import §3 steps 2–3). The evidence is the
 * repository itself: every dependency manifest, the Aspire AppHost's hosting
 * packages, infrastructure as code and container files, never the README.
 *
 * Pure and deterministic. The caller parses the manifests (`@repo/atlas`
 * `parseTechStack`) and reads the infrastructure files; this module folds the
 * packages into the technologies a person would name and says where each was
 * seen.
 */

export type StackCategory =
	| "language"
	| "framework"
	| "data"
	| "cloud"
	| "messaging"
	| "integration"
	| "testing"
	| "tooling"
	| "infrastructure";

export type StackTechnology = {
	name: string;
	category: StackCategory;
	/** Where it was seen: a manifest, an IaC file, a file kind. A few, not all. */
	evidence: string[];
};

export type StackPackage = {
	ecosystem: string;
	name: string;
	kind: string;
	dev: boolean;
	/** The manifest it came from. */
	source: string;
};

const MAX_EVIDENCE = 3;

/** Package names folded into a technology. First match wins, so specific before general. */
const PACKAGE_FAMILIES: [RegExp, string, StackCategory][] = [
	[/^aspire\.hosting\.azure\.cosmosdb/i, "Azure Cosmos DB", "data"],
	[/^aspire\.hosting\.azure\.storage/i, "Azure Storage", "cloud"],
	[
		/^aspire\.hosting\.azure\.appconfiguration/i,
		"Azure App Configuration",
		"cloud",
	],
	[
		/^aspire\.hosting\.azure\.applicationinsights/i,
		"Application Insights",
		"cloud",
	],
	[/^aspire\.hosting\.azure\.keyvault/i, "Azure Key Vault", "cloud"],
	[/^aspire\.hosting\.azure\.servicebus/i, "Azure Service Bus", "messaging"],
	[/^aspire\.hosting\.(azure\.)?redis/i, "Redis", "data"],
	[/^aspire\.hosting\.(azure\.)?postgres/i, "PostgreSQL", "data"],
	[/^aspire\.hosting\.(azure\.)?sql/i, "SQL Server", "data"],
	[/^aspire\.hosting\.orleans/i, "Orleans", "framework"],
	[/^aspire\.hosting/i, ".NET Aspire", "infrastructure"],
	[/^aspire\./i, ".NET Aspire", "infrastructure"],
	[/^microsoft\.aspnetcore/i, "ASP.NET Core", "framework"],
	[/^microsoft\.entityframeworkcore/i, "Entity Framework Core", "data"],
	[/^microsoft\.orleans/i, "Orleans", "framework"],
	[/^microsoft\.azure\.cosmos|^azure\.cosmos/i, "Azure Cosmos DB", "data"],
	[/^azure\.storage|^microsoft\.azure\.storage/i, "Azure Storage", "cloud"],
	[
		/^azure\.data\.appconfiguration|^microsoft\.extensions\.configuration\.azureappconfiguration|^microsoft\.azure\.appconfiguration/i,
		"Azure App Configuration",
		"cloud",
	],
	[
		/^microsoft\.applicationinsights|^azure\.monitor\.opentelemetry/i,
		"Application Insights",
		"cloud",
	],
	[/^azure\.security\.keyvault/i, "Azure Key Vault", "cloud"],
	[
		/^azure\.messaging\.servicebus|^microsoft\.azure\.servicebus/i,
		"Azure Service Bus",
		"messaging",
	],
	[/^azure\.identity/i, "Microsoft Entra ID", "cloud"],
	[/^microsoft\.identity|^microsoft\.graph/i, "Microsoft Entra ID", "cloud"],
	[/^opentelemetry/i, "OpenTelemetry", "tooling"],
	[
		/^telegram\.bot|^telegraf$|^node-telegram-bot-api$|^grammy$/i,
		"Telegram Bot API",
		"integration",
	],
	[/viber/i, "Viber", "integration"],
	[
		/^modelcontextprotocol|^@modelcontextprotocol\//i,
		"Model Context Protocol",
		"integration",
	],
	[/^stripe(\.net)?$/i, "Stripe", "integration"],
	[/^twilio/i, "Twilio", "integration"],
	[/^sendgrid|^@sendgrid\//i, "SendGrid", "integration"],
	[/^stackexchange\.redis$|^ioredis$|^redis$/i, "Redis", "data"],
	[/^npgsql|^pg$|^postgres$/i, "PostgreSQL", "data"],
	[/^mongodb|^mongoose$/i, "MongoDB", "data"],
	[/^microsoft\.data\.sqlclient|^mssql$/i, "SQL Server", "data"],
	[/^prisma$|^@prisma\/client$/i, "Prisma", "data"],
	[/^mediatr$/i, "MediatR", "framework"],
	[/^fluentvalidation/i, "FluentValidation", "framework"],
	[/^serilog/i, "Serilog", "tooling"],
	[/^polly/i, "Polly", "framework"],
	[/^swashbuckle|^nswag/i, "OpenAPI", "tooling"],
	[/^xunit/i, "xUnit", "testing"],
	[/^nunit/i, "NUnit", "testing"],
	[/^mstest/i, "MSTest", "testing"],
	[/^moq$|^nsubstitute$/i, "Mocking (.NET)", "testing"],
	[/^fluentassertions$|^shouldly$/i, "Assertions (.NET)", "testing"],
	[/^@playwright\/test$|^microsoft\.playwright/i, "Playwright", "testing"],
	[/^vitest$/i, "Vitest", "testing"],
	[/^jest$/i, "Jest", "testing"],
	[/^cypress$/i, "Cypress", "testing"],
	[/^pytest$/i, "pytest", "testing"],
	[/^react-dom$|^react$/i, "React", "framework"],
	[/^next$/i, "Next.js", "framework"],
	[/^vue$/i, "Vue", "framework"],
	[/^nuxt$/i, "Nuxt", "framework"],
	[/^svelte$|^@sveltejs\/kit$/i, "Svelte", "framework"],
	[/^@angular\/core$/i, "Angular", "framework"],
	[/^vite$/i, "Vite", "tooling"],
	[/^tailwindcss$/i, "Tailwind CSS", "framework"],
	[/^@tanstack\/react-query$/i, "TanStack Query", "framework"],
	[/^@tanstack\/react-router$/i, "TanStack Router", "framework"],
	[/^react-router(-dom)?$/i, "React Router", "framework"],
	[/^i18next$|^react-i18next$/i, "i18next", "framework"],
	[/^zustand$|^redux$|^@reduxjs\/toolkit$/i, "State management", "framework"],
	[/^typescript$/i, "TypeScript", "language"],
	[/^express$/i, "Express", "framework"],
	[/^fastify$/i, "Fastify", "framework"],
	[/^@nestjs\/core$/i, "NestJS", "framework"],
	[/^django$/i, "Django", "framework"],
	[/^fastapi$/i, "FastAPI", "framework"],
	[/^flask$/i, "Flask", "framework"],
	[/^spring-boot/i, "Spring Boot", "framework"],
	[/^rails$/i, "Ruby on Rails", "framework"],
	[/^laravel\//i, "Laravel", "framework"],
];

/** Azure resource types in Bicep/ARM and Terraform resource names, folded the same way. */
const RESOURCE_FAMILIES: [RegExp, string, StackCategory][] = [
	[/microsoft\.documentdb\/|azurerm_cosmosdb/i, "Azure Cosmos DB", "data"],
	[/microsoft\.storage\/|azurerm_storage_account/i, "Azure Storage", "cloud"],
	[
		/microsoft\.appconfiguration\/|azurerm_app_configuration/i,
		"Azure App Configuration",
		"cloud",
	],
	[
		/microsoft\.insights\/components|azurerm_application_insights/i,
		"Application Insights",
		"cloud",
	],
	[
		/microsoft\.operationalinsights\/|azurerm_log_analytics/i,
		"Log Analytics",
		"cloud",
	],
	[/microsoft\.keyvault\/|azurerm_key_vault/i, "Azure Key Vault", "cloud"],
	[
		/microsoft\.app\/|azurerm_container_app/i,
		"Azure Container Apps",
		"infrastructure",
	],
	[
		/microsoft\.containerregistry\/|azurerm_container_registry/i,
		"Azure Container Registry",
		"infrastructure",
	],
	[
		/microsoft\.web\/sites|azurerm_(linux_|windows_)?(web|function)_app/i,
		"Azure App Service",
		"infrastructure",
	],
	[/microsoft\.sql\/|azurerm_mssql/i, "Azure SQL", "data"],
	[/microsoft\.dbforpostgresql\/|azurerm_postgresql/i, "PostgreSQL", "data"],
	[/microsoft\.cache\/redis|azurerm_redis/i, "Redis", "data"],
	[
		/microsoft\.servicebus\/|azurerm_servicebus/i,
		"Azure Service Bus",
		"messaging",
	],
	[
		/microsoft\.signalrservice\/|azurerm_signalr/i,
		"Azure SignalR",
		"messaging",
	],
	[
		/microsoft\.managedidentity\/|azurerm_user_assigned_identity/i,
		"Managed identities",
		"cloud",
	],
	[/aws_/i, "AWS", "cloud"],
	[/google_/i, "Google Cloud", "cloud"],
];

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	cs: "C#",
	fs: "F#",
	vb: "Visual Basic",
	ts: "TypeScript",
	tsx: "TypeScript",
	js: "JavaScript",
	jsx: "JavaScript",
	mjs: "JavaScript",
	py: "Python",
	go: "Go",
	rs: "Rust",
	java: "Java",
	kt: "Kotlin",
	swift: "Swift",
	rb: "Ruby",
	php: "PHP",
	cpp: "C++",
	cc: "C++",
	c: "C",
	scala: "Scala",
	dart: "Dart",
	sql: "SQL",
	bicep: "Bicep",
	tf: "Terraform",
};

const DOC_EXTENSIONS = new Set(["md", "mdx", "markdown", "txt", "rst", "adoc"]);
const NEVER_COUNTED =
	/(^|\/)(node_modules|vendor|dist|build|out|\.git|coverage|bin|obj|\.next)\//i;

export type RepositoryKind = "code" | "docs" | "mixed" | "empty";

export type RepositoryProfile = {
	fileCount: number;
	documentCount: number;
	codeFileCount: number;
	/** Languages by file count, most first. */
	languages: { name: string; files: number }[];
	/** Top-level folders by file count, most first. */
	topFolders: { name: string; files: number }[];
	kind: RepositoryKind;
};

function extensionOf(path: string): string {
	const base = path.split("/").pop() ?? "";
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function ranked(counts: Map<string, number>, limit: number) {
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, limit)
		.map(([name, files]) => ({ name, files }));
}

/** The repository's shape from its file list alone. */
export function repositoryProfile(paths: readonly string[]): RepositoryProfile {
	const languages = new Map<string, number>();
	const folders = new Map<string, number>();
	let documentCount = 0;
	let codeFileCount = 0;
	let fileCount = 0;
	for (const path of paths) {
		if (NEVER_COUNTED.test(path)) {
			continue;
		}
		fileCount += 1;
		const ext = extensionOf(path);
		if (DOC_EXTENSIONS.has(ext)) {
			documentCount += 1;
		}
		const language = LANGUAGE_BY_EXTENSION[ext];
		if (language) {
			codeFileCount += 1;
			languages.set(language, (languages.get(language) ?? 0) + 1);
		}
		const parts = path.split("/");
		if (parts.length > 1 && parts[0]) {
			folders.set(parts[0], (folders.get(parts[0]) ?? 0) + 1);
		}
	}
	const kind: RepositoryKind =
		fileCount === 0
			? "empty"
			: codeFileCount === 0
				? "docs"
				: documentCount > codeFileCount
					? "mixed"
					: documentCount >= 10 && documentCount * 5 >= codeFileCount
						? "mixed"
						: "code";
	return {
		fileCount,
		documentCount,
		codeFileCount,
		languages: ranked(languages, 8),
		topFolders: ranked(folders, 12),
		kind,
	};
}

/** Package names a central `Directory.Packages.props` pins (it is not parsed as a manifest). */
export function centralPackageNames(content: string): string[] {
	return [...content.matchAll(/<PackageVersion\s+Include="([^"]+)"/gi)].map(
		(match) => match[1] ?? "",
	);
}

/** The target frameworks a `.csproj` names, as a runtime ("net10.0" → ".NET 10"). */
export function dotnetRuntimes(content: string): string[] {
	const value =
		/<TargetFrameworks?>([^<]+)<\/TargetFrameworks?>/i.exec(content)?.[1] ??
		"";
	return value
		.split(";")
		.map((tfm) => /^net(\d+)\.\d+/i.exec(tfm.trim())?.[1])
		.filter((major): major is string => !!major)
		.map((major) => `.NET ${major}`);
}

/** Resource types an infrastructure file declares (Bicep, ARM JSON, Terraform). */
export function infrastructureResourceTypes(content: string): string[] {
	return [
		...[...content.matchAll(/resource\s+\w+\s+'([^'@]+)@/g)].map(
			(m) => m[1] ?? "",
		),
		...[...content.matchAll(/"type"\s*:\s*"(Microsoft\.[^"]+)"/g)].map(
			(m) => m[1] ?? "",
		),
		...[...content.matchAll(/resource\s+"([a-z0-9_]+)"/g)].map(
			(m) => m[1] ?? "",
		),
	].filter(Boolean);
}

/** Infrastructure files worth reading for resource types. */
export function isInfrastructureFile(path: string): boolean {
	return (
		/\.(bicep|tf)$/i.test(path) || /(^|\/)azuredeploy\.json$/i.test(path)
	);
}

/** What a repository is built with, from its packages, infrastructure files and file list. */
export function detectRepositoryStack(input: {
	paths: readonly string[];
	packages: readonly StackPackage[];
	/** Runtimes found in project files (".NET 10"), with the file. */
	runtimes?: readonly { name: string; source: string }[];
	/** Resource types read from infrastructure files, with the file. */
	resources?: readonly { type: string; source: string }[];
}): StackTechnology[] {
	const found = new Map<string, StackTechnology>();
	const add = (name: string, category: StackCategory, evidence: string) => {
		const current = found.get(name);
		if (!current) {
			found.set(name, { name, category, evidence: [evidence] });
		} else if (
			current.evidence.length < MAX_EVIDENCE &&
			!current.evidence.includes(evidence)
		) {
			current.evidence.push(evidence);
		}
	};

	for (const { name, files } of repositoryProfile(input.paths).languages) {
		if (name !== "Bicep" && name !== "Terraform" && name !== "SQL") {
			add(name, "language", `${files} files`);
		}
	}
	for (const runtime of input.runtimes ?? []) {
		add(runtime.name, "framework", runtime.source);
	}
	for (const pkg of input.packages) {
		const clean = pkg.name.replace(/[​-‍﻿]/g, "").trim();
		const family = PACKAGE_FAMILIES.find(([pattern]) =>
			pattern.test(clean),
		);
		if (family) {
			add(family[1], family[2], pkg.source);
		} else if (
			!pkg.dev &&
			(pkg.kind === "framework" || pkg.kind === "runtime")
		) {
			add(clean, "framework", pkg.source);
		}
	}
	for (const resource of input.resources ?? []) {
		const family = RESOURCE_FAMILIES.find(([pattern]) =>
			pattern.test(resource.type),
		);
		if (family) {
			add(family[1], family[2], resource.source);
		}
	}

	const has = (re: RegExp) => input.paths.find((path) => re.test(path));
	const fileSignals: [RegExp, string, StackCategory][] = [
		[/(^|\/)dockerfile$/i, "Docker", "infrastructure"],
		[
			/(^|\/)(docker-)?compose\.ya?ml$/i,
			"Docker Compose",
			"infrastructure",
		],
		[/(^|\/)azure\.yaml$/i, "Azure Developer CLI", "infrastructure"],
		[/\.bicep$/i, "Bicep", "infrastructure"],
		[/\.tf$/i, "Terraform", "infrastructure"],
		[/(^|\/)(chart|helm)\/|(^|\/)Chart\.yaml$/i, "Helm", "infrastructure"],
		[/^\.github\/workflows\/.+\.ya?ml$/i, "GitHub Actions", "tooling"],
		[/(^|\/)azure-pipelines\.ya?ml$/i, "Azure Pipelines", "tooling"],
		[/^\.gitlab-ci\.yml$/i, "GitLab CI", "tooling"],
		[/\.http$/i, "HTTP request collections", "tooling"],
		[
			/(^|\/)openapi\.(json|ya?ml)$|(^|\/)swagger\.(json|ya?ml)$/i,
			"OpenAPI",
			"tooling",
		],
	];
	for (const [pattern, name, category] of fileSignals) {
		const path = has(pattern);
		if (path) {
			add(name, category, path);
		}
	}

	const order: StackCategory[] = [
		"language",
		"framework",
		"data",
		"cloud",
		"messaging",
		"integration",
		"infrastructure",
		"testing",
		"tooling",
	];
	// A versioned runtime (".NET 10") says more than the bare one (".NET").
	for (const name of [...found.keys()]) {
		if (
			[...found.keys()].some(
				(other) =>
					other !== name &&
					other.startsWith(`${name} `) &&
					/\d/.test(other),
			)
		) {
			found.delete(name);
		}
	}
	return [...found.values()].sort(
		(a, b) => order.indexOf(a.category) - order.indexOf(b.category),
	);
}
