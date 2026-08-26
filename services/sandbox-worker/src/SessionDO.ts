/**
 * SessionDO - Durable Object for managing sandbox sessions
 *
 * Each session has its own isolated sandbox environment.
 * State is persisted in SQLite for durability.
 *
 * TENANT ISOLATION:
 * - Sessions store userId and organizationId at creation time
 * - All operations verify the caller matches the session owner
 * - Personal accounts (organizationId = null) are isolated from org accounts
 * - Different organizations are fully isolated
 */

import { DurableObject } from "cloudflare:workers";
import {
	type ExecEvent,
	getSandbox,
	parseSSEStream,
} from "@cloudflare/sandbox";
import type {
	CommitRequest,
	CommitResponse,
	CreateSessionRequest,
	CreateSessionResponse,
	DiffResponse,
	Env,
	ExecRequest,
	ExecResponse,
	PushRequest,
	PushResponse,
	ReadFileResponse,
	RunClaudeRequest,
	RunClaudeResponse,
	SessionState,
	WriteFileResponse,
} from "./types";
import { GIT_ADD_EXCLUSIONS } from "./utils";

const MAX_EXEC_OUTPUT_BYTES = 1024 * 1024;

function truncateUtf8(value: string, maxBytes: number): string {
	const encoded = new TextEncoder().encode(value);
	return encoded.byteLength <= maxBytes
		? value
		: new TextDecoder().decode(encoded.slice(0, maxBytes));
}

function appendBounded(
	current: string,
	value: string,
	maxBytes: number,
): string {
	return truncateUtf8(current + value, maxBytes);
}

function redactExecSecrets(
	value: string,
	env: Record<string, string> | undefined,
): string {
	let redacted = value;
	for (const secret of Object.values(env ?? {})) {
		if (secret.length >= 4) {
			redacted = redacted.replaceAll(secret, "[REDACTED]");
		}
	}
	return redacted;
}

// Schema for session storage
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    work_dir TEXT NOT NULL,
    repo_url TEXT,
    branch TEXT,
    user_id TEXT NOT NULL,
    organization_id TEXT,
    created_at TEXT NOT NULL,
    last_activity_at TEXT NOT NULL
  );
`;

type SessionRow = {
	id: string;
	work_dir: string;
	repo_url: string | null;
	branch: string | null;
	user_id: string;
	organization_id: string | null;
	created_at: string;
	last_activity_at: string;
};

/**
 * How often to sweep for expired sessions. Hourly against a 24h expiry: often
 * enough that a leaked session is reclaimed the same day, rare enough that the
 * object is not woken for nothing.
 */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export class SessionDO extends DurableObject<Env> {
	private sql: SqlStorage;
	private initialized = false;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		// Arm the reaper if nothing has armed it yet. `cleanupExpiredSessions`
		// existed from the start and its own doc said it was "called periodically
		// via alarm or cron" — nothing called it, ever. The only thing reclaiming
		// a session was the agent remembering a prompt instruction to call
		// destroySession, so any run that errored or timed out leaked one.
		//
		// That is not merely a stale row: `wrangler.toml` caps the container at
		// max_instances 10 (dev) / 20 (production), and the row is also the only
		// handle by which a container could later be reclaimed — losing it leaks
		// both.
		//
		// `blockConcurrencyWhile` so the alarm is set before any request is
		// served, and getAlarm() first so a restart re-arms rather than
		// resetting a schedule that is already running.
		ctx.blockConcurrencyWhile(async () => {
			if ((await ctx.storage.getAlarm()) === null) {
				await ctx.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS);
			}
		});
	}

	/**
	 * Reap expired sessions, then re-arm.
	 *
	 * Re-arming inside the handler rather than on a schedule elsewhere: a
	 * Durable Object alarm fires once, so an alarm that does not set the next one
	 * runs exactly a single time and then stops silently — which is
	 * indistinguishable from the bug this replaces.
	 */
	override async alarm(): Promise<void> {
		try {
			await this.cleanupExpiredSessions();
		} finally {
			// In `finally` so a failed sweep still schedules the next one. A
			// reaper that stops reaping because one pass threw is worse than one
			// that occasionally does nothing.
			await this.ctx.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS);
		}
	}

	private initSchema() {
		if (this.initialized) {
			return;
		}
		this.sql.exec(SCHEMA);
		this.initialized = true;
	}

	/**
	 * Get sandbox instance for this session
	 */
	private getSandbox(sessionId: string): ReturnType<typeof getSandbox> {
		return getSandbox(this.env.SANDBOX, sessionId);
	}

	/**
	 * Get session state from database
	 */
	private getSession(sessionId: string): SessionState | null {
		this.initSchema();
		const result = this.sql.exec<SessionRow>(
			"SELECT * FROM sessions WHERE id = ?",
			sessionId,
		);
		const row = result.toArray()[0];
		if (!row) {
			return null;
		}

		return {
			sessionId: row.id,
			workDir: row.work_dir,
			repoUrl: row.repo_url ?? undefined,
			branch: row.branch ?? undefined,
			userId: row.user_id,
			organizationId: row.organization_id ?? undefined,
			createdAt: row.created_at,
			lastActivityAt: row.last_activity_at,
		};
	}

	/**
	 * Update last activity timestamp
	 */
	private updateActivity(sessionId: string) {
		this.sql.exec(
			"UPDATE sessions SET last_activity_at = ? WHERE id = ?",
			new Date().toISOString(),
			sessionId,
		);
	}

	/**
	 * Verify that the caller owns this session (tenant isolation).
	 * Returns the session if owned, throws if not.
	 *
	 * ISOLATION RULES:
	 * - If session has organizationId, caller must have same organizationId
	 * - If session has no organizationId (personal), caller must have same userId AND no organizationId
	 * - This prevents org users from accessing personal sessions and vice versa
	 */
	private verifyOwnership(
		session: SessionState,
		callerId: string,
		callerOrgId: string | undefined,
	): void {
		// Check organization context matches
		if (session.organizationId) {
			// Session belongs to an organization
			if (callerOrgId !== session.organizationId) {
				throw new Error(
					"ACCESS_DENIED: Session belongs to a different organization",
				);
			}
		} else {
			// Session is personal (no org)
			if (callerOrgId) {
				throw new Error(
					"ACCESS_DENIED: Cannot access personal session from organization context",
				);
			}
			if (session.userId !== callerId) {
				throw new Error(
					"ACCESS_DENIED: Session belongs to a different user",
				);
			}
		}
	}

	/**
	 * Get session and verify ownership. Throws if session not found or access denied.
	 */
	private getSessionWithAuth(
		sessionId: string,
		callerId: string,
		callerOrgId: string | undefined,
	): SessionState {
		const session = this.getSession(sessionId);
		if (!session) {
			throw new Error("NOT_FOUND: Session not found");
		}
		this.verifyOwnership(session, callerId, callerOrgId);
		return session;
	}

	/**
	 * Create a new sandbox session
	 */
	async createSession(
		sessionId: string,
		userId: string,
		organizationId: string | undefined,
		request: CreateSessionRequest,
	): Promise<CreateSessionResponse> {
		this.initSchema();

		const workDir = `/workspace/${request.workDir || "repo"}`;
		const branch = request.branch || "main";
		const now = new Date().toISOString();

		// Store session state
		this.sql.exec(
			`INSERT INTO sessions (id, work_dir, repo_url, branch, user_id, organization_id, created_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			sessionId,
			workDir,
			request.repoUrl || null,
			branch,
			userId,
			organizationId || null,
			now,
			now,
		);

		// Initialize sandbox
		const sandbox = this.getSandbox(sessionId);
		await sandbox.mkdir("/workspace", { recursive: true });

		if (request.repoUrl) {
			// Clone repository
			const cloneStream = await sandbox.execStream(
				`git clone --depth 1 --branch ${branch} ${request.repoUrl} ${workDir}`,
			);

			for await (const event of parseSSEStream<ExecEvent>(cloneStream)) {
				if (event.type === "complete") {
					if (event.exitCode !== 0) {
						throw new Error(
							`Git clone failed with exit code ${event.exitCode}`,
						);
					}
					break;
				}
				if (event.type === "error") {
					throw new Error(`Git clone error: ${event.error}`);
				}
			}

			// Configure git for this workspace
			const setupStream = await sandbox.execStream(
				`cd ${workDir} && git config user.email "fabric-sandbox@fabric.ai" && git config user.name "Fabric Sandbox"`,
			);
			for await (const event of parseSSEStream<ExecEvent>(setupStream)) {
				if (event.type === "complete") {
					break;
				}
			}
		} else {
			// Just create the directory
			await sandbox.mkdir(workDir, { recursive: true });
		}

		return {
			sessionId,
			workDir,
			branch,
		};
	}

	/**
	 * Run Claude Code in the sandbox
	 */
	async runClaude(
		sessionId: string,
		userId: string,
		organizationId: string | undefined,
		request: RunClaudeRequest,
		anthropicApiKey: string,
	): Promise<RunClaudeResponse> {
		// Verify ownership before proceeding
		const session = this.getSessionWithAuth(
			sessionId,
			userId,
			organizationId,
		);

		this.updateActivity(sessionId);
		const sandbox = this.getSandbox(sessionId);
		const timeout = request.timeout || 300;

		// Check Claude CLI availability first
		const checkStream = await sandbox.execStream(
			"command -v claude && echo 'claude-available' || echo 'claude-not-found'",
		);
		let claudeAvailable = false;
		for await (const event of parseSSEStream<ExecEvent>(checkStream)) {
			if (
				event.type === "stdout" &&
				event.data?.includes("claude-available")
			) {
				claudeAvailable = true;
			}
			if (event.type === "complete") {
				break;
			}
		}

		if (!claudeAvailable) {
			throw new Error(
				"Claude CLI is not installed in the sandbox container. " +
					"Ensure the Dockerfile includes: npm install -g @anthropic-ai/claude-code",
			);
		}

		// Build task instructions
		let taskContent = `# Task Instructions\n\n${request.task}`;
		if (request.context) {
			taskContent += `\n\n## Context\n\n${request.context}`;
		}
		taskContent += `\n\n## Working Directory\n${session.workDir}`;
		taskContent +=
			"\n\n## Guidelines\n- Make minimal, focused changes\n- Follow existing code style\n- Do NOT commit changes - the workflow will handle that";

		await sandbox.writeFile("/tmp/task.md", taskContent);

		const systemPrompt =
			request.systemPrompt ||
			"You are an automatic feature-implementer/bug-fixer. Apply all necessary changes to achieve the user request. Do NOT commit changes - the workflow will handle that.";

		const escapedSystemPrompt = systemPrompt.replace(/'/g, "'\\''");

		// Create the Claude execution script
		const claudeScript = `#!/bin/bash
cd ${session.workDir}
export ANTHROPIC_API_KEY="${anthropicApiKey}"
claude --append-system-prompt "${escapedSystemPrompt}" -p "$(cat /tmp/task.md)" --permission-mode acceptEdits > /tmp/claude-output.txt 2>&1
echo "---CLAUDE_EXIT_CODE:$?---" >> /tmp/claude-output.txt
`;

		await sandbox.writeFile("/tmp/run-claude.sh", claudeScript);

		// Run Claude Code
		const claudeProcess = await sandbox.startProcess(
			"bash /tmp/run-claude.sh",
		);

		// Poll for completion
		let complete = false;
		let attempts = 0;
		let output = "";
		let exitCode = 0;

		while (!complete && attempts < timeout) {
			await new Promise((resolve) => setTimeout(resolve, 1000));
			attempts++;

			try {
				const outputFile = await sandbox.readFile(
					"/tmp/claude-output.txt",
				);
				if (outputFile.content.includes("---CLAUDE_EXIT_CODE:")) {
					complete = true;
					output = outputFile.content;

					const exitCodeMatch = output.match(
						/---CLAUDE_EXIT_CODE:(\d+)---/,
					);
					exitCode = exitCodeMatch
						? Number.parseInt(exitCodeMatch[1], 10)
						: 1;
					output = output
						.replace(/---CLAUDE_EXIT_CODE:\d+---/, "")
						.trim();
				}
			} catch {
				// File doesn't exist yet
			}
		}

		// Kill process if still running
		try {
			await sandbox.killProcess(claudeProcess.id);
		} catch {
			// Process may have already exited
		}

		if (!complete) {
			throw new Error(`Claude Code timed out after ${timeout} seconds`);
		}

		// Get list of modified files
		const statusStream = await sandbox.execStream(
			`cd ${session.workDir} && git status --porcelain`,
		);
		let statusOutput = "";
		for await (const event of parseSSEStream<ExecEvent>(statusStream)) {
			if (event.type === "stdout") {
				statusOutput += event.data;
			}
			if (event.type === "complete") {
				break;
			}
		}

		const filesModified = statusOutput
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => line.slice(3).trim());

		return {
			success: exitCode === 0,
			output,
			filesModified,
			exitCode,
		};
	}

	/**
	 * Execute a shell command in the sandbox
	 */
	async exec(
		sessionId: string,
		userId: string,
		organizationId: string | undefined,
		request: ExecRequest,
	): Promise<ExecResponse> {
		// Verify ownership before proceeding
		const session = this.getSessionWithAuth(
			sessionId,
			userId,
			organizationId,
		);

		this.updateActivity(sessionId);
		const sandbox = this.getSandbox(sessionId);

		const cwd = request.cwd
			? request.cwd.startsWith("/")
				? request.cwd
				: `${session.workDir}/${request.cwd}`
			: session.workDir;

		const execStream = await sandbox.execStream(request.command, {
			cwd,
			env: request.env,
			timeout: (request.timeout ?? 180) * 1000,
		});

		let stdout = "";
		let stderr = "";
		let exitCode = 0;
		const redactionMargin = Math.max(
			0,
			...Object.values(request.env ?? {}).map(
				(secret) => new TextEncoder().encode(secret).byteLength,
			),
		);
		const collectionLimit = MAX_EXEC_OUTPUT_BYTES + redactionMargin;

		for await (const event of parseSSEStream<ExecEvent>(execStream)) {
			if (event.type === "stdout") {
				stdout = appendBounded(
					stdout,
					event.data || "",
					collectionLimit,
				);
			}
			if (event.type === "stderr") {
				stderr = appendBounded(
					stderr,
					event.data || "",
					collectionLimit,
				);
			}
			if (event.type === "complete") {
				exitCode = event.exitCode || 0;
				break;
			}
			if (event.type === "error") {
				throw new Error(
					`Exec error: ${redactExecSecrets(String(event.error), request.env)}`,
				);
			}
		}

		return {
			stdout: truncateUtf8(
				redactExecSecrets(stdout, request.env),
				MAX_EXEC_OUTPUT_BYTES,
			),
			stderr: truncateUtf8(
				redactExecSecrets(stderr, request.env),
				MAX_EXEC_OUTPUT_BYTES,
			),
			exitCode,
		};
	}

	/**
	 * Get git diff for current changes
	 */
	async getDiff(
		sessionId: string,
		userId: string,
		organizationId: string | undefined,
		staged = false,
	): Promise<DiffResponse> {
		// Verify ownership before proceeding
		const session = this.getSessionWithAuth(
			sessionId,
			userId,
			organizationId,
		);

		this.updateActivity(sessionId);
		const sandbox = this.getSandbox(sessionId);

		// Stage all changes first to capture everything
		if (!staged) {
			const addStream = await sandbox.execStream(
				`cd ${session.workDir} && git add -A -- . ${GIT_ADD_EXCLUSIONS}`,
			);
			for await (const event of parseSSEStream<ExecEvent>(addStream)) {
				if (event.type === "complete") {
					break;
				}
			}
		}

		// Get diff
		const diffCmd = staged
			? `cd ${session.workDir} && git diff --cached`
			: `cd ${session.workDir} && git diff HEAD`;

		const diffStream = await sandbox.execStream(diffCmd);
		let diff = "";
		for await (const event of parseSSEStream<ExecEvent>(diffStream)) {
			if (event.type === "stdout") {
				diff += event.data;
			}
			if (event.type === "complete") {
				break;
			}
		}

		// Calculate stats
		const files = (diff.match(/^diff --git/gm) || []).length;
		const additions = (diff.match(/^\+[^+]/gm) || []).length;
		const deletions = (diff.match(/^-[^-]/gm) || []).length;

		return {
			diff,
			stats: { files, additions, deletions },
		};
	}

	/**
	 * Commit staged changes
	 */
	async commit(
		sessionId: string,
		userId: string,
		organizationId: string | undefined,
		request: CommitRequest,
	): Promise<CommitResponse> {
		// Verify ownership before proceeding
		const session = this.getSessionWithAuth(
			sessionId,
			userId,
			organizationId,
		);

		this.updateActivity(sessionId);
		const sandbox = this.getSandbox(sessionId);

		// Stage all changes
		const addStream = await sandbox.execStream(
			`cd ${session.workDir} && git add -A -- . ${GIT_ADD_EXCLUSIONS}`,
		);
		for await (const event of parseSSEStream<ExecEvent>(addStream)) {
			if (event.type === "complete") {
				break;
			}
		}

		// Write commit message to file to avoid escaping issues
		await sandbox.writeFile("/tmp/commit-msg.txt", request.message);

		// Commit
		const commitStream = await sandbox.execStream(
			`cd ${session.workDir} && git commit -F /tmp/commit-msg.txt`,
		);

		let commitOutput = "";
		let exitCode = 0;
		for await (const event of parseSSEStream<ExecEvent>(commitStream)) {
			if (event.type === "stdout") {
				commitOutput += event.data;
			}
			if (event.type === "complete") {
				exitCode = event.exitCode || 0;
				break;
			}
		}

		if (exitCode !== 0) {
			throw new Error(`Commit failed: ${commitOutput}`);
		}

		// Get commit hash
		const hashStream = await sandbox.execStream(
			`cd ${session.workDir} && git rev-parse HEAD`,
		);
		let commitHash = "";
		for await (const event of parseSSEStream<ExecEvent>(hashStream)) {
			if (event.type === "stdout") {
				commitHash = event.data?.trim() || "";
			}
			if (event.type === "complete") {
				break;
			}
		}

		return {
			success: true,
			commitHash,
		};
	}

	/**
	 * Push changes to remote
	 */
	async push(
		sessionId: string,
		userId: string,
		organizationId: string | undefined,
		request: PushRequest,
	): Promise<PushResponse> {
		// Verify ownership before proceeding
		const session = this.getSessionWithAuth(
			sessionId,
			userId,
			organizationId,
		);

		this.updateActivity(sessionId);
		const sandbox = this.getSandbox(sessionId);

		const remote = request.remote || "origin";
		const branch = request.branch || session.branch || "main";
		const forceFlag = request.force ? " --force" : "";

		const pushStream = await sandbox.execStream(
			`cd ${session.workDir} && git push${forceFlag} ${remote} HEAD:${branch}`,
		);

		let pushOutput = "";
		let exitCode = 0;
		for await (const event of parseSSEStream<ExecEvent>(pushStream)) {
			if (event.type === "stdout" || event.type === "stderr") {
				pushOutput += event.data || "";
			}
			if (event.type === "complete") {
				exitCode = event.exitCode || 0;
				break;
			}
		}

		if (exitCode !== 0) {
			throw new Error(`Push failed: ${pushOutput}`);
		}

		return {
			success: true,
			ref: `${remote}/${branch}`,
		};
	}

	/**
	 * Read a file from the sandbox
	 */
	async readFile(
		sessionId: string,
		userId: string,
		organizationId: string | undefined,
		path: string,
	): Promise<ReadFileResponse> {
		// Verify ownership before proceeding
		const session = this.getSessionWithAuth(
			sessionId,
			userId,
			organizationId,
		);

		this.updateActivity(sessionId);
		const sandbox = this.getSandbox(sessionId);

		const fullPath = path.startsWith("/")
			? path
			: `${session.workDir}/${path}`;
		const file = await sandbox.readFile(fullPath);

		return { content: file.content };
	}

	/**
	 * Write a file to the sandbox
	 */
	async writeFile(
		sessionId: string,
		userId: string,
		organizationId: string | undefined,
		path: string,
		content: string,
	): Promise<WriteFileResponse> {
		// Verify ownership before proceeding
		const session = this.getSessionWithAuth(
			sessionId,
			userId,
			organizationId,
		);

		this.updateActivity(sessionId);
		const sandbox = this.getSandbox(sessionId);

		const fullPath = path.startsWith("/")
			? path
			: `${session.workDir}/${path}`;
		await sandbox.writeFile(fullPath, content);

		return {
			success: true,
			bytesWritten: content.length,
		};
	}

	/**
	 * Destroy the session and cleanup
	 */
	async destroySession(
		sessionId: string,
		userId: string,
		organizationId: string | undefined,
	): Promise<void> {
		const session = this.getSession(sessionId);
		if (!session) {
			return; // Already destroyed
		}

		// Verify ownership before deleting
		this.verifyOwnership(session, userId, organizationId);

		// Remove from database
		this.sql.exec("DELETE FROM sessions WHERE id = ?", sessionId);

		// Sandbox cleanup is handled automatically by Cloudflare
	}

	/**
	 * Get session info (verifies ownership)
	 */
	async getSessionInfo(
		sessionId: string,
		userId: string,
		organizationId: string | undefined,
	): Promise<SessionState | null> {
		const session = this.getSession(sessionId);
		if (!session) {
			return null;
		}
		// Verify ownership
		this.verifyOwnership(session, userId, organizationId);
		return session;
	}

	/**
	 * Cleanup expired sessions (called periodically via alarm or cron)
	 * Sessions older than maxAgeMs will be deleted.
	 */
	async cleanupExpiredSessions(
		maxAgeMs: number = 24 * 60 * 60 * 1000,
	): Promise<number> {
		this.initSchema();

		const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

		// Get expired sessions
		const expired = this.sql
			.exec<{ id: string }>(
				"SELECT id FROM sessions WHERE last_activity_at < ?",
				cutoff,
			)
			.toArray();

		// Delete each expired session
		for (const { id } of expired) {
			this.sql.exec("DELETE FROM sessions WHERE id = ?", id);
		}

		return expired.length;
	}

	/**
	 * Get all sessions for a user/org (for admin/debugging)
	 * Note: This is primarily for internal use.
	 */
	async listSessions(
		userId: string,
		organizationId: string | undefined,
	): Promise<SessionState[]> {
		this.initSchema();

		const result = organizationId
			? this.sql.exec<SessionRow>(
					"SELECT * FROM sessions WHERE organization_id = ? ORDER BY last_activity_at DESC",
					organizationId,
				)
			: this.sql.exec<SessionRow>(
					"SELECT * FROM sessions WHERE user_id = ? AND organization_id IS NULL ORDER BY last_activity_at DESC",
					userId,
				);

		return result.toArray().map((row) => ({
			sessionId: row.id,
			workDir: row.work_dir,
			repoUrl: row.repo_url ?? undefined,
			branch: row.branch ?? undefined,
			userId: row.user_id,
			organizationId: row.organization_id ?? undefined,
			createdAt: row.created_at,
			lastActivityAt: row.last_activity_at,
		}));
	}
}
