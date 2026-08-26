/**
 * Sandbox tool formatting for weave agents
 *
 * Creates tool definitions for Vercel AI SDK based on agent requirements
 */

import type { SandboxContext } from "../types/index.js";

interface SandboxToolSet {
	readFile: ReturnType<typeof createReadFileTool>;
	listFiles: ReturnType<typeof createListFilesTool>;
	searchCode: ReturnType<typeof createSearchCodeTool>;
	execCommand: ReturnType<typeof createExecCommandTool>;
}

function createReadFileTool(_context: SandboxContext) {
	return {
		description: "Read a file from the sandbox",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "File path relative to workDir",
				},
			},
			required: ["path"],
		},
		execute: async (_args: { path: string }) => {
			// Implementation in agent services
			throw new Error("Not implemented - tool stub");
		},
	};
}

function createListFilesTool(_context: SandboxContext) {
	return {
		description: "List files in a directory",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Directory path relative to workDir",
				},
				recursive: { type: "boolean", description: "List recursively" },
			},
			required: ["path"],
		},
		execute: async (_args: { path: string; recursive?: boolean }) => {
			throw new Error("Not implemented - tool stub");
		},
	};
}

function createSearchCodeTool(_context: SandboxContext) {
	return {
		description: "Search code using grep",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "Search pattern" },
				path: {
					type: "string",
					description: "Search path relative to workDir",
				},
			},
			required: ["pattern"],
		},
		execute: async (_args: { pattern: string; path?: string }) => {
			throw new Error("Not implemented - tool stub");
		},
	};
}

function createExecCommandTool(
	_context: SandboxContext,
	options: { allowedCommands: string[]; readOnly: boolean },
) {
	return {
		description: options.readOnly
			? "Execute read-only commands in the sandbox"
			: "Execute commands in the sandbox (use writeFile tool for writes)",
		parameters: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description: `Command to execute. Allowed: ${options.allowedCommands.join(", ")}`,
				},
				args: {
					type: "array",
					items: { type: "string" },
					description: "Command arguments",
				},
			},
			required: ["command"],
		},
		execute: async ({
			command,
			args,
		}: {
			command: string;
			args?: string[];
		}) => {
			// Validate command is allowed
			if (!options.allowedCommands.includes(command)) {
				throw new Error(`Command '${command}' is not allowed`);
			}

			// Security: Prevent shell injection via arguments
			if (
				args?.some(
					(arg) =>
						arg.includes("&&") ||
						arg.includes("||") ||
						arg.includes(";"),
				)
			) {
				throw new Error("Invalid characters in command arguments");
			}

			throw new Error("Not implemented - tool stub");
		},
	};
}

/**
 * Format sandbox tools for Vercel AI SDK
 */
export function formatSandboxTools(
	tools: SandboxToolSet,
): Record<string, unknown> {
	return {
		readFile: tools.readFile,
		listFiles: tools.listFiles,
		searchCode: tools.searchCode,
		execCommand: tools.execCommand,
	};
}
