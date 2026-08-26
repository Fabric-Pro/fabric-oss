import { tool as aiTool } from "ai";

// Wrapper to handle ai@6 strict overload resolution with union return types
const tool = aiTool as any;

import { z } from "zod";
import type { SandboxClient } from "../lib/sandbox-client.js";

/**
 * Create AI SDK v6 tools for read-only sandbox access.
 * These tools allow LLMs to iteratively explore the codebase.
 */
export function createReadOnlySandboxTools(sandbox: SandboxClient) {
	return {
		readFile: tool({
			description:
				"Read the contents of a file from the sandbox. Use this to inspect source code, configs, or documentation.",
			parameters: z.object({
				path: z
					.string()
					.describe("File path relative to the workspace root"),
			}),
			execute: async ({ path }: { path: string }) => {
				try {
					const content = await sandbox.readFile(path);
					const truncated =
						content.length > 8000
							? `${content.slice(0, 8000)}\n... [truncated, ${content.length} chars total]`
							: content;
					return { path, content: truncated };
				} catch (error) {
					return {
						path,
						error:
							error instanceof Error
								? error.message
								: "Failed to read file",
					};
				}
			},
		}),

		listFiles: tool({
			description:
				"List files and directories in the sandbox. Use recursive=true for a full tree view.",
			parameters: z.object({
				path: z
					.string()
					.default(".")
					.describe("Directory path relative to workspace root"),
				recursive: z
					.boolean()
					.default(false)
					.describe("List files recursively"),
			}),
			execute: async ({
				path,
				recursive,
			}: {
				path: string;
				recursive?: boolean;
			}) => {
				try {
					const files = await sandbox.listFiles(path, recursive);
					return {
						path,
						files: files.slice(0, 100),
						totalCount: files.length,
						truncated: files.length > 100,
					};
				} catch (error) {
					return {
						path,
						error:
							error instanceof Error
								? error.message
								: "Failed to list files",
					};
				}
			},
		}),

		searchCode: tool({
			description:
				"Search for a pattern in the codebase using grep. Returns matching file paths, line numbers, and content.",
			parameters: z.object({
				pattern: z
					.string()
					.describe("Search pattern (grep-compatible)"),
				path: z
					.string()
					.default(".")
					.describe("Directory to search in"),
			}),
			execute: async ({
				pattern,
				path,
			}: {
				pattern: string;
				path?: string;
			}) => {
				try {
					const matches = await sandbox.searchCode(pattern, path);
					return {
						pattern,
						matches: matches.slice(0, 30),
						totalMatches: matches.length,
						truncated: matches.length > 30,
					};
				} catch (error) {
					return {
						pattern,
						error:
							error instanceof Error
								? error.message
								: "Search failed",
					};
				}
			},
		}),

		execCommand: tool({
			description:
				"Execute a read-only shell command. Allowed commands: grep, find, cat, ls, head, tail, wc, pwd",
			parameters: z.object({
				command: z
					.string()
					.describe(
						"The command to run (grep, find, cat, ls, head, tail, wc, pwd)",
					),
				args: z
					.array(z.string())
					.default([])
					.describe("Command arguments"),
			}),
			execute: async ({
				command,
				args,
			}: {
				command: string;
				args?: string[];
			}) => {
				try {
					const result = await sandbox.execCommand(command, args);
					const stdout =
						result.stdout.length > 4000
							? `${result.stdout.slice(0, 4000)}\n... [truncated]`
							: result.stdout;
					return {
						command: `${command} ${args?.join(" ")}`,
						stdout,
						stderr: result.stderr,
						exitCode: result.exitCode,
					};
				} catch (error) {
					return {
						command: `${command} ${args?.join(" ")}`,
						error:
							error instanceof Error
								? error.message
								: "Command failed",
					};
				}
			},
		}),
	};
}
