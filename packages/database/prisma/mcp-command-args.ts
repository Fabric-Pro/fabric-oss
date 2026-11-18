type McpArgumentServer = {
	key?: string | null;
	isSystemProvided?: boolean | null;
};

type McpCommandArgsResult = { ok: true } | { ok: false; reason: string };

export function acceptsMcpCommandArgs(
	server: McpArgumentServer | null | undefined,
): boolean {
	return server?.isSystemProvided === true && server.key === "azure-devops";
}

export function validateMcpCommandArgs(
	server: McpArgumentServer | null | undefined,
	args: readonly string[],
): McpCommandArgsResult {
	if (!acceptsMcpCommandArgs(server)) {
		return args.length === 0
			? { ok: true }
			: {
					ok: false,
					reason: "This MCP server does not accept command arguments.",
				};
	}

	const [organization = ""] = args;
	if (
		args.length !== 1 ||
		organization.length < 1 ||
		organization.length > 50 ||
		/[^a-zA-Z0-9-]/.test(organization) ||
		organization.startsWith("-") ||
		organization.endsWith("-")
	) {
		return {
			ok: false,
			reason: "Provide exactly one Azure DevOps organization name of 1 to 50 ASCII letters, digits, or hyphens, starting and ending with a letter or digit.",
		};
	}

	return { ok: true };
}

export class McpConfigInputError extends Error {
	readonly code = "BAD_REQUEST";
}
