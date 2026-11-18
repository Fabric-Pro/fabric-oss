export const GOOGLE_DRIVE_STDIO = {
	packageName: "@modelcontextprotocol/server-gdrive",
	credentialNames: {
		oauthKeys: "__GDRIVE_OAUTH_KEYS_JSON",
		credentials: "__GDRIVE_CREDENTIALS_JSON",
	},
} as const;

export const TWILIO_STDIO = {
	packageName: "@twilio-alpha/mcp",
	credentialNames: {
		accountSid: "TWILIO_ACCOUNT_SID",
		apiKey: "TWILIO_API_KEY",
		apiSecret: "TWILIO_API_SECRET",
	},
} as const;

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

// This extracts the package for credential mapping. The wrapper validates
// the catalog command's spelling, pin, and fixed flags before launch.
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
