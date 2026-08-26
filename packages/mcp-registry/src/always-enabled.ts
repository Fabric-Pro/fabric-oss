/**
 * Always-Enabled MCP Definitions
 *
 * MCPs that are always available without user configuration.
 * Currently includes: Sandbox (code execution environment)
 */

import type { AccountDefinition, MCPDefinition } from "./types";
import { SANDBOX_WORKFLOW_GUIDANCE } from "./workflow-guidance";

/**
 * Sandbox MCP - Always enabled for code execution
 */
export const SANDBOX_ACCOUNT: AccountDefinition = {
	id: "sandbox",
	name: "Code Sandbox",
	credentialType: "none",
	authType: "none",
	icon: "terminal",
	alwaysEnabled: true,
	envBindingKeys: ["SANDBOX_WORKER_URL", "SANDBOX_AUTH_SECRET"],
	additionalCredentialKeys: ["githubToken", "anthropicApiKey"],
	mcps: [
		{
			id: "sandbox",
			name: "Sandbox",
			serverName: "Sandbox",
			description:
				"Execute code in isolated Cloudflare sandbox environment",
			icon: "terminal",
			available: true,
			workflowGuidance: SANDBOX_WORKFLOW_GUIDANCE,
			capabilities: [
				"createSession",
				"getSession",
				"destroySession",
				"listSessions",
				"exec",
				"runClaude",
				"readFile",
				"writeFile",
				"listFiles",
				"getDiff",
				"commit",
				"push",
			],
			tools: [
				{
					name: "createSession",
					description:
						"Create a new isolated sandbox session. Optionally clone a git repository.",
					inputSchema: {
						type: "object",
						properties: {
							repoUrl: {
								type: "string",
								description: "Git repository URL to clone",
							},
							branch: {
								type: "string",
								description:
									"Branch to checkout (default: main)",
							},
							workDir: {
								type: "string",
								description: "Working directory name",
							},
						},
					},
				},
				{
					name: "runClaude",
					description:
						"Run Claude Code AI to make code changes in the sandbox",
					inputSchema: {
						type: "object",
						properties: {
							sessionId: {
								type: "string",
								description: "Session ID from createSession",
							},
							task: {
								type: "string",
								description:
									"Description of what changes to make",
							},
							context: {
								type: "string",
								description: "Additional context",
							},
							timeout: {
								type: "number",
								description:
									"Timeout in seconds (default: 300)",
							},
						},
						required: ["sessionId", "task"],
					},
				},
				{
					name: "exec",
					description: "Execute a shell command in the sandbox",
					inputSchema: {
						type: "object",
						properties: {
							sessionId: {
								type: "string",
								description: "Session ID",
							},
							command: {
								type: "string",
								description: "Command to execute",
							},
							timeout: {
								type: "number",
								description:
									"Timeout in seconds (default: 180)",
							},
						},
						required: ["sessionId", "command"],
					},
				},
				{
					name: "getDiff",
					description:
						"Get git diff of current changes. ALWAYS call this before requesting approval for code changes.",
					inputSchema: {
						type: "object",
						properties: {
							sessionId: {
								type: "string",
								description: "Session ID",
							},
							staged: {
								type: "boolean",
								description: "Get staged changes only",
							},
						},
						required: ["sessionId"],
					},
				},
				{
					name: "commit",
					description: "Commit staged changes",
					inputSchema: {
						type: "object",
						properties: {
							sessionId: {
								type: "string",
								description: "Session ID",
							},
							message: {
								type: "string",
								description: "Commit message",
							},
						},
						required: ["sessionId", "message"],
					},
					approvalRequiredFields: ["message"],
				},
				{
					name: "push",
					description: "Push commits to remote repository",
					inputSchema: {
						type: "object",
						properties: {
							sessionId: {
								type: "string",
								description: "Session ID",
							},
							branch: {
								type: "string",
								description: "Branch to push",
							},
							force: {
								type: "boolean",
								description: "Force push",
							},
						},
						required: ["sessionId", "branch"],
					},
					approvalRequiredFields: ["branch"],
				},
				{
					name: "destroySession",
					description:
						"Destroy a sandbox session and clean up resources. ALWAYS call when done.",
					inputSchema: {
						type: "object",
						properties: {
							sessionId: {
								type: "string",
								description: "Session ID to destroy",
							},
						},
						required: ["sessionId"],
					},
				},
				{
					name: "readFile",
					description: "Read contents of a file",
					inputSchema: {
						type: "object",
						properties: {
							sessionId: {
								type: "string",
								description: "Session ID",
							},
							path: {
								type: "string",
								description:
									"File path relative to work directory",
							},
						},
						required: ["sessionId", "path"],
					},
				},
				{
					name: "writeFile",
					description: "Write content to a file",
					inputSchema: {
						type: "object",
						properties: {
							sessionId: {
								type: "string",
								description: "Session ID",
							},
							path: { type: "string", description: "File path" },
							content: {
								type: "string",
								description: "File content",
							},
						},
						required: ["sessionId", "path", "content"],
					},
				},
				{
					name: "listFiles",
					description: "List files in a directory",
					inputSchema: {
						type: "object",
						properties: {
							sessionId: {
								type: "string",
								description: "Session ID",
							},
							path: {
								type: "string",
								description: "Directory path (default: .)",
							},
						},
						required: ["sessionId"],
					},
				},
				{
					name: "getSession",
					description:
						"Check if a sandbox session is still valid. Use this after long waits (like approval) to verify the session hasn't expired before executing commit/push.",
					inputSchema: {
						type: "object",
						properties: {
							sessionId: {
								type: "string",
								description: "Session ID to check",
							},
						},
						required: ["sessionId"],
					},
				},
			],
		},
	],
};

/**
 * All always-enabled accounts
 * Note: Only includes accounts that require NO authentication.
 * GitHub requires OAuth and is handled separately via conditional availability.
 */
export const ALWAYS_ENABLED_ACCOUNTS: AccountDefinition[] = [SANDBOX_ACCOUNT];

/**
 * Get all always-enabled MCPs with their parent account
 */
export function getAlwaysEnabledMcps(): {
	account: AccountDefinition;
	mcp: MCPDefinition;
}[] {
	const result: { account: AccountDefinition; mcp: MCPDefinition }[] = [];

	for (const account of ALWAYS_ENABLED_ACCOUNTS) {
		for (const mcp of account.mcps) {
			if (mcp.available !== false && !mcp.comingSoon) {
				result.push({ account, mcp });
			}
		}
	}

	return result;
}

/**
 * Get always-enabled accounts
 */
export function getAlwaysEnabledAccounts(): AccountDefinition[] {
	return ALWAYS_ENABLED_ACCOUNTS;
}

/**
 * Get workflow guidance for all always-enabled MCPs
 */
export function getAlwaysEnabledWorkflowGuidance(): string {
	const guidances: string[] = [];

	for (const account of ALWAYS_ENABLED_ACCOUNTS) {
		for (const mcp of account.mcps) {
			if (mcp.workflowGuidance && mcp.available !== false) {
				guidances.push(mcp.workflowGuidance);
			}
		}
	}

	return guidances.join("\n\n");
}
