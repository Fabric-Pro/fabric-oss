// Key by npm package: the variable belongs to the package, not the catalog row;
// tenant-owned servers can reuse a catalog key with a different command.
const STDIO_CREDENTIAL_ENV_BY_PACKAGE: Readonly<Record<string, string>> = {
	"@stripe/mcp": "STRIPE_SECRET_KEY",
	"@sentry/mcp-server": "SENTRY_ACCESS_TOKEN",
	"@brave/brave-search-mcp-server": "BRAVE_API_KEY",
	"airtable-mcp-server": "AIRTABLE_API_KEY",
	"@doist/todoist-mcp": "TODOIST_API_KEY",
	"@azure-devops/mcp": "ADO_MCP_AUTH_TOKEN",
	"figma-developer-mcp": "FIGMA_API_KEY",
};

// Flag and version handling mirror mcp-stdio-wrapper's preinstalled-command.ts.
// Tokens are split on whitespace, not shell-quoted as the wrapper does, so a
// quoted package spec finds no mapping and falls back to API_KEY.
const NPX_PASSTHROUGH_FLAGS = new Set(["-y", "--yes"]);

export function stdioPackageName(command: string): string | null {
	const parts = command.trim().split(/\s+/);
	if (parts[0] !== "npx") {
		return null;
	}
	let index = 1;
	while (NPX_PASSTHROUGH_FLAGS.has(parts[index] ?? "")) {
		index++;
	}
	const spec = parts[index];
	if (!spec || spec.startsWith("-")) {
		return null;
	}
	const at = spec.lastIndexOf("@");
	return at > 0 ? spec.slice(0, at) : spec;
}

export function stdioCredentialEnvVar(command: string): string | undefined {
	const name = stdioPackageName(command);
	return name && Object.hasOwn(STDIO_CREDENTIAL_ENV_BY_PACKAGE, name)
		? STDIO_CREDENTIAL_ENV_BY_PACKAGE[name]
		: undefined;
}
