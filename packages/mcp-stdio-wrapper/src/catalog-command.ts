/** Launch policy for the pinned STDIO commands in the curated database seeds. */
interface CatalogServer {
	versions: readonly string[];
	fixedFlags?: readonly string[];
	acceptsAzureDevOpsArgs?: boolean;
	credentialNames?: readonly string[];
}

const CATALOG = new Map<string, CatalogServer>([
	["@modelcontextprotocol/server-memory", { versions: ["1.0.0"] }],
	[
		"@modelcontextprotocol/server-gdrive",
		{
			versions: ["2025.1.14"],
			credentialNames: [
				"__GDRIVE_OAUTH_KEYS_JSON",
				"__GDRIVE_CREDENTIALS_JSON",
			],
		},
	],
	[
		"@brave/brave-search-mcp-server",
		{ versions: ["2.1.4"], credentialNames: ["BRAVE_API_KEY"] },
	],
	[
		"@stripe/mcp",
		{ versions: ["0.3.3"], credentialNames: ["STRIPE_SECRET_KEY"] },
	],
	[
		"@sentry/mcp-server",
		{ versions: ["0.42.0"], credentialNames: ["SENTRY_ACCESS_TOKEN"] },
	],
	[
		"@twilio-alpha/mcp",
		{
			versions: ["0.7.0"],
			credentialNames: [
				"TWILIO_ACCOUNT_SID",
				"TWILIO_API_KEY",
				"TWILIO_API_SECRET",
			],
		},
	],
	[
		"airtable-mcp-server",
		{ versions: ["1.14.0"], credentialNames: ["AIRTABLE_API_KEY"] },
	],
	[
		"@doist/todoist-mcp",
		{ versions: ["13.6.0"], credentialNames: ["TODOIST_API_KEY"] },
	],
	[
		"@modelcontextprotocol/server-sequential-thinking",
		{ versions: ["1.0.0"] },
	],
	["@modelcontextprotocol/server-everything", { versions: ["1.0.0"] }],
	[
		"@azure-devops/mcp",
		{
			versions: ["2.8.0"],
			acceptsAzureDevOpsArgs: true,
			credentialNames: ["ADO_MCP_AUTH_TOKEN"],
		},
	],
	[
		"figma-developer-mcp",
		{
			versions: ["0.13.2"],
			fixedFlags: ["--stdio"],
			credentialNames: ["FIGMA_API_KEY"],
		},
	],
	[
		"@playwright/mcp",
		{
			versions: ["0.0.76"],
			fixedFlags: [
				"--browser",
				"chromium",
				"--headless",
				"--no-sandbox",
				"--isolated",
			],
		},
	],
]);

export interface CatalogLaunchRequest {
	command: string;
	args: readonly string[];
	credentials?: Readonly<Record<string, string>>;
}

export class CatalogLaunchError extends Error {}

export function validateCatalogLaunch({
	command,
	args,
	credentials,
}: CatalogLaunchRequest) {
	const commandParts = command.split(" ");
	const [runner, option] = commandParts;
	const specIndex = option === "-y" || option === "--yes" ? 2 : 1;
	const spec = commandParts[specIndex] ?? "";
	const separator = spec.lastIndexOf("@");
	const packageName = separator > 0 ? spec.slice(0, separator) : spec;
	const version = separator > 0 ? spec.slice(separator + 1) : "";
	const entry = CATALOG.get(packageName);
	const fixedCommand = [
		...commandParts.slice(0, specIndex + 1),
		...(entry?.fixedFlags ?? []),
	].join(" ");
	if (
		runner !== "npx" ||
		!entry ||
		!entry.versions.includes(version) ||
		command !== fixedCommand
	) {
		// Only display known catalog names, since command text is request input.
		throw new CatalogLaunchError(
			`MCP server${entry ? ` ${packageName}` : ""} is not available.`,
		);
	}

	const requestArgs = [...args];
	if (entry.acceptsAzureDevOpsArgs) {
		const [organization = "", authFlag, authMode] = requestArgs;
		if (
			organization.length === 0 ||
			organization.length > 50 ||
			/[^a-zA-Z0-9-]/.test(organization) ||
			organization.startsWith("-") ||
			organization.endsWith("-") ||
			(requestArgs.length !== 1 &&
				!(
					requestArgs.length === 3 &&
					authFlag === "--authentication" &&
					authMode === "envvar"
				))
		) {
			throw new CatalogLaunchError(
				"Invalid Azure DevOps command arguments.",
			);
		}
	} else if (requestArgs.length !== 0) {
		throw new CatalogLaunchError(
			`MCP server ${packageName} does not accept command arguments.`,
		);
	}

	const credentialEntries = Object.entries(credentials ?? {});
	if (
		credentialEntries.some(
			([name]) => !entry.credentialNames?.includes(name),
		)
	) {
		throw new CatalogLaunchError(
			`Invalid credential name for MCP server ${packageName}.`,
		);
	}

	if (credentialEntries.some(([, value]) => value.includes("\0"))) {
		throw new CatalogLaunchError(
			`Invalid credential value for MCP server ${packageName}.`,
		);
	}

	return {
		packageName,
		commandParts,
		requestArgs,
		credentials: Object.fromEntries(credentialEntries),
	};
}

// The wrapper image sets NODE_ENV, HOME and NPM_CONFIG_CACHE. HOME also
// determines the default Chromium cache used by its Playwright install.
const BASE_ENV_NAMES = [
	"PATH",
	"HOME",
	"TMPDIR",
	"TMP",
	"TEMP",
	"LANG",
	"LANGUAGE",
	"LC_ALL",
	"LC_CTYPE",
	"NODE_ENV",
	"NPM_CONFIG_CACHE",
] as const;

export function createBaseChildEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const name of BASE_ENV_NAMES) {
		const value = process.env[name];
		if (value !== undefined) {
			env[name] = value;
		}
	}
	return env;
}
