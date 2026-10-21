/**
 * Type definitions for Fabric Sandbox Worker
 */

import type { Sandbox } from "@cloudflare/sandbox";
import { z } from "zod";
import type { DynamicCodeLoader } from "../../../packages/sandbox/src/dynamic-worker";

// Environment bindings
export interface Env {
	SESSION_DO: DurableObjectNamespace;
	SANDBOX: DurableObjectNamespace<Sandbox>;
	/** Absent deployments refuse stateless code execution with HTTP 501. */
	LOADER?: DynamicCodeLoader;
	ENVIRONMENT: string;
	// Auth secret for JWT verification (set via wrangler secret)
	SANDBOX_AUTH_SECRET: string;
}

// Session state stored in Durable Object
export interface SessionState {
	sessionId: string;
	workDir: string;
	repoUrl?: string;
	branch?: string;
	createdAt: string;
	lastActivityAt: string;
	userId: string;
	organizationId?: string;
}

// API Request/Response types
export interface CreateSessionRequest {
	repoUrl?: string;
	branch?: string;
	workDir?: string;
}

export interface CreateSessionResponse {
	sessionId: string;
	workDir: string;
	branch?: string;
}

export interface RunClaudeRequest {
	task: string;
	context?: string;
	systemPrompt?: string;
	timeout?: number; // seconds, default 300
}

export interface RunClaudeResponse {
	success: boolean;
	output: string;
	filesModified: string[];
	exitCode: number;
}

export const ExecRequestSchema = z.object({
	command: z.string().min(1),
	cwd: z.string().optional(),
	timeout: z.number().min(1).max(300).optional(),
	env: z
		.record(
			z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
			z.string().max(32_768),
		)
		.refine((value) => Object.keys(value).length <= 32)
		.refine(
			(value) =>
				Object.entries(value).reduce(
					(size, [key, item]) => size + key.length + item.length,
					0,
				) <= 65_536,
		)
		.optional(),
});
export type ExecRequest = z.infer<typeof ExecRequestSchema>;

export interface ExecResponse {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface DiffResponse {
	diff: string;
	stats: {
		files: number;
		additions: number;
		deletions: number;
	};
}

export interface CommitRequest {
	message: string;
}

export interface CommitResponse {
	success: boolean;
	commitHash: string;
}

export interface PushRequest {
	remote?: string; // default "origin"
	branch?: string;
	force?: boolean;
}

export interface PushResponse {
	success: boolean;
	ref: string;
}

export interface ReadFileResponse {
	content: string;
}

export interface WriteFileResponse {
	success: boolean;
	bytesWritten: number;
}

// JWT payload from Fabric
export interface FabricJwtPayload {
	sub: string; // userId
	org?: string; // organizationId
	iat: number;
	exp: number;
}

// API error response
export interface ApiError {
	code: string;
	message: string;
	details?: unknown;
}

export interface ApiResponse<T = unknown> {
	success: boolean;
	data?: T;
	error?: ApiError;
}
