/**
 * Sandbox Temporal Activities
 *
 * Activities for interacting with the Cloudflare Sandbox Worker
 * from Temporal workflows.
 */

import type {
	ClaudeResult,
	CommitResult,
	CreateSessionOptions,
	DiffResult,
	ExecOptions,
	ExecResult,
	PushOptions,
	PushResult,
	RunClaudeOptions,
	SandboxSession,
} from "@repo/sandbox";
import { createSandboxClient, type SandboxClient } from "@repo/sandbox";

// Singleton client instance
let sandboxClient: SandboxClient | null = null;

function getClient(): SandboxClient {
	if (!sandboxClient) {
		sandboxClient = createSandboxClient();
	}
	return sandboxClient;
}

// Activity input types
export interface CreateSandboxSessionInput {
	userId: string;
	organizationId?: string;
	repoUrl?: string;
	branch?: string;
	workDir?: string;
	// If provided, inject GitHub token into repo URL for authentication
	githubToken?: string;
}

export interface SandboxSessionContext {
	sessionId: string;
	userId: string;
	organizationId?: string;
}

export interface RunClaudeInput extends SandboxSessionContext {
	task: string;
	context?: string;
	systemPrompt?: string;
	timeout?: number;
	anthropicApiKey: string;
}

export interface ExecInput extends SandboxSessionContext {
	command: string;
	cwd?: string;
	timeout?: number;
	env?: Record<string, string>;
}

export interface CommitInput extends SandboxSessionContext {
	message: string;
}

export interface PushInput extends SandboxSessionContext {
	remote?: string;
	branch?: string;
	force?: boolean;
}

export interface FileInput extends SandboxSessionContext {
	path: string;
}

export interface WriteFileInput extends FileInput {
	content: string;
}

/**
 * Create a new sandbox session
 */
export async function createSandboxSession(
	input: CreateSandboxSessionInput,
): Promise<SandboxSession> {
	const client = getClient();

	// Inject GitHub token into repo URL if provided
	let repoUrl = input.repoUrl;
	if (repoUrl && input.githubToken && repoUrl.startsWith("https://")) {
		repoUrl = repoUrl.replace("https://", `https://${input.githubToken}@`);
	}

	const options: CreateSessionOptions = {
		repoUrl,
		branch: input.branch,
		workDir: input.workDir,
	};

	return client.createSession(input.userId, input.organizationId, options);
}

/**
 * Run Claude Code in the sandbox to make code changes
 */
export async function runClaudeInSandbox(
	input: RunClaudeInput,
): Promise<ClaudeResult> {
	const client = getClient();

	const options: RunClaudeOptions = {
		task: input.task,
		context: input.context,
		systemPrompt: input.systemPrompt,
		timeout: input.timeout,
	};

	return client.runClaude(
		input.sessionId,
		input.userId,
		input.organizationId,
		options,
		input.anthropicApiKey,
	);
}

/**
 * Execute a shell command in the sandbox
 */
export async function execInSandbox(input: ExecInput): Promise<ExecResult> {
	const client = getClient();

	const options: ExecOptions = {
		command: input.command,
		cwd: input.cwd,
		timeout: input.timeout,
		env: input.env,
	};

	return client.exec(
		input.sessionId,
		input.userId,
		input.organizationId,
		options,
	);
}

/**
 * Get git diff of changes in the sandbox
 */
export async function getSandboxDiff(
	input: SandboxSessionContext & { staged?: boolean },
): Promise<DiffResult> {
	const client = getClient();
	return client.getDiff(
		input.sessionId,
		input.userId,
		input.organizationId,
		input.staged,
	);
}

/**
 * Commit changes in the sandbox
 */
export async function commitInSandbox(
	input: CommitInput,
): Promise<CommitResult> {
	const client = getClient();
	return client.commit(
		input.sessionId,
		input.userId,
		input.organizationId,
		input.message,
	);
}

/**
 * Push changes to remote repository
 */
export async function pushFromSandbox(input: PushInput): Promise<PushResult> {
	const client = getClient();

	const options: PushOptions = {
		remote: input.remote,
		branch: input.branch,
		force: input.force,
	};

	return client.push(
		input.sessionId,
		input.userId,
		input.organizationId,
		options,
	);
}

/**
 * Read a file from the sandbox
 */
export async function readSandboxFile(input: FileInput): Promise<string> {
	const client = getClient();
	return client.readFile(
		input.sessionId,
		input.userId,
		input.organizationId,
		input.path,
	);
}

/**
 * Write a file to the sandbox
 */
export async function writeSandboxFile(input: WriteFileInput): Promise<void> {
	const client = getClient();
	await client.writeFile(
		input.sessionId,
		input.userId,
		input.organizationId,
		input.path,
		input.content,
	);
}

/**
 * Destroy a sandbox session (cleanup)
 */
export async function destroySandboxSession(
	input: SandboxSessionContext,
): Promise<void> {
	const client = getClient();
	await client.destroySession(
		input.sessionId,
		input.userId,
		input.organizationId,
	);
}

/**
 * Check if a sandbox session exists and is valid
 * Returns session info if valid, throws if expired/invalid
 */
export async function getSandboxSession(
	input: SandboxSessionContext,
): Promise<{ valid: boolean; sessionId: string; createdAt?: string }> {
	const client = getClient();
	try {
		const info = await client.getSession(
			input.sessionId,
			input.userId,
			input.organizationId,
		);
		return {
			valid: true,
			sessionId: input.sessionId,
			createdAt: info.createdAt,
		};
	} catch (_error) {
		// Session doesn't exist or expired
		return {
			valid: false,
			sessionId: input.sessionId,
		};
	}
}

/**
 * Full code change workflow - convenience function that combines multiple operations
 */
export async function executeCodeChangeWorkflow(input: {
	userId: string;
	organizationId?: string;
	repoUrl: string;
	branch: string;
	featureBranch: string;
	task: string;
	commitMessage: string;
	anthropicApiKey: string;
	githubToken?: string;
}): Promise<{
	success: boolean;
	sessionId: string;
	diff: DiffResult;
	commitHash?: string;
	error?: string;
}> {
	let sessionId: string | null = null;

	try {
		// 1. Create session
		const session = await createSandboxSession({
			userId: input.userId,
			organizationId: input.organizationId,
			repoUrl: input.repoUrl,
			branch: input.branch,
			githubToken: input.githubToken,
		});
		sessionId = session.sessionId;

		// 2. Create feature branch
		await execInSandbox({
			sessionId,
			userId: input.userId,
			organizationId: input.organizationId,
			command: `git checkout -b ${input.featureBranch}`,
		});

		// 3. Run Claude to make changes
		const claudeResult = await runClaudeInSandbox({
			sessionId,
			userId: input.userId,
			organizationId: input.organizationId,
			task: input.task,
			anthropicApiKey: input.anthropicApiKey,
		});

		if (!claudeResult.success) {
			return {
				success: false,
				sessionId,
				diff: {
					diff: "",
					stats: { files: 0, additions: 0, deletions: 0 },
				},
				error: `Claude failed: ${claudeResult.output}`,
			};
		}

		// 4. Get diff
		const diff = await getSandboxDiff({
			sessionId,
			userId: input.userId,
			organizationId: input.organizationId,
		});

		// If no changes, return early
		if (diff.stats.files === 0) {
			return {
				success: true,
				sessionId,
				diff,
				error: "No changes detected",
			};
		}

		return {
			success: true,
			sessionId,
			diff,
		};
	} catch (error) {
		return {
			success: false,
			sessionId: sessionId || "",
			diff: { diff: "", stats: { files: 0, additions: 0, deletions: 0 } },
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}

/**
 * Finalize code changes after approval - commit and push
 */
export async function finalizeCodeChanges(input: {
	sessionId: string;
	userId: string;
	organizationId?: string;
	commitMessage: string;
	branch: string;
}): Promise<{
	success: boolean;
	commitHash?: string;
	pushRef?: string;
	error?: string;
}> {
	try {
		// Commit changes
		const commitResult = await commitInSandbox({
			sessionId: input.sessionId,
			userId: input.userId,
			organizationId: input.organizationId,
			message: input.commitMessage,
		});

		// Push to remote
		const pushResult = await pushFromSandbox({
			sessionId: input.sessionId,
			userId: input.userId,
			organizationId: input.organizationId,
			branch: input.branch,
		});

		return {
			success: true,
			commitHash: commitResult.commitHash,
			pushRef: pushResult.ref,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}
