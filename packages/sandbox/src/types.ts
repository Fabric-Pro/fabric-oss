/**
 * Type definitions for Fabric Sandbox Client
 */

import { z } from "zod";

// Session types
export interface SandboxSession {
	sessionId: string;
	workDir: string;
	branch?: string;
}

export interface SessionInfo extends SandboxSession {
	repoUrl?: string;
	userId: string;
	organizationId?: string;
	createdAt: string;
	lastActivityAt: string;
}

// Request/Response schemas
export const CreateSessionOptionsSchema = z.object({
	repoUrl: z.string().url().optional(),
	branch: z.string().optional(),
	workDir: z.string().optional(),
});
export type CreateSessionOptions = z.infer<typeof CreateSessionOptionsSchema>;

export const RunClaudeOptionsSchema = z.object({
	task: z.string().min(1),
	context: z.string().optional(),
	systemPrompt: z.string().optional(),
	timeout: z.number().min(30).max(600).optional(),
});
export type RunClaudeOptions = z.infer<typeof RunClaudeOptionsSchema>;

export interface ClaudeResult {
	success: boolean;
	output: string;
	filesModified: string[];
	exitCode: number;
}

export const ExecOptionsSchema = z.object({
	command: z.string().min(1),
	cwd: z.string().optional(),
	timeout: z.number().min(1).max(300).optional(),
	env: z
		.record(
			z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
			z.string().max(32_768),
		)
		.refine((value) => Object.keys(value).length <= 32, {
			message: "At most 32 environment variables may be supplied",
		})
		.refine(
			(value) =>
				Object.entries(value).reduce(
					(size, [key, item]) => size + key.length + item.length,
					0,
				) <= 65_536,
			{ message: "Environment variables exceed the 64 KiB limit" },
		)
		.optional(),
});
export type ExecOptions = z.infer<typeof ExecOptionsSchema>;

export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface DiffResult {
	diff: string;
	stats: {
		files: number;
		additions: number;
		deletions: number;
	};
}

export interface CommitResult {
	success: boolean;
	commitHash: string;
}

export const PushOptionsSchema = z.object({
	remote: z.string().optional(),
	branch: z.string().optional(),
	force: z.boolean().optional(),
});
export type PushOptions = z.infer<typeof PushOptionsSchema>;

export interface PushResult {
	success: boolean;
	ref: string;
}

// API response wrapper
export interface ApiResponse<T> {
	success: boolean;
	data?: T;
	error?: {
		code: string;
		message: string;
		details?: unknown;
	};
}

// Sandbox client configuration
export interface SandboxClientConfig {
	baseUrl: string;
	authSecret: string;
	timeout?: number; // Default request timeout in ms
}

// Tool definitions for MCP integration
export interface SandboxToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}
