/**
 * Type definitions for Fabric Sandbox Worker
 */

import type { Sandbox } from "@cloudflare/sandbox";
import { z } from "zod";

// Environment bindings
export interface Env {
	SESSION_DO: DurableObjectNamespace;
	SANDBOX: DurableObjectNamespace<Sandbox>;
	/**
	 * Dynamic Worker Loader, for `/execute`.
	 *
	 * OPTIONAL because the binding is a closed Cloudflare beta this account is not
	 * allowlisted for: declaring it made every `wrangler deploy` fail with
	 * "binding LOADER has an unknown type dynamic_worker_loader [code: 10021]",
	 * which is why the live worker sat on a January build for six months while
	 * fixes — including a fail-closed CORS change and Chromium in the image —
	 * stayed undeployed.
	 *
	 * The binding is out of `wrangler.toml` so the rest can ship. `/execute`
	 * checks for it and refuses cleanly rather than throwing.
	 *
	 * Restoring the binding does NOT by itself make the capability usable, which
	 * an earlier version of this comment claimed. `/execute` has no caller —
	 * `SandboxClient` has no method that posts to it — so the route stays
	 * unreachable until someone adds one. The 501 is therefore dormant rather
	 * than user-facing: no Fabric code path can reach it to be refused.
	 */
	LOADER?: {
		load: (config: Record<string, unknown>) => {
			getEntrypoint(): {
				run(env?: Record<string, unknown>): Promise<unknown>;
			};
		};
	};
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

export interface ExecuteCodeRequest {
	code: string;
	language: "javascript" | "typescript";
	timeout?: number; // milliseconds
}

export interface ExecuteCodeResponse {
	code: string;
	logs: Array<{
		type: "stdout" | "stderr";
		text: string;
	}>;
	results?: Array<
		{ type: "text"; text: string } | { type: "json"; json: unknown }
	>;
	error?: string;
	executionCount: number;
	executionTime: number;
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
