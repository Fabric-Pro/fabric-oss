/**
 * Sandbox Activities
 *
 * Activities for sandbox lifecycle management.
 * Uses the Background Agents Provider (same infrastructure as "Send to Background Agent")
 * to create and manage coding execution sessions.
 */

import { getBackgroundAgentsProvider } from "./get-background-provider";

export interface CreateSandboxInput {
	userId: string;
	organizationId: string | null;
	repoUrl: string;
	branch: string;
}

export interface SandboxInfo {
	sessionId: string;
	workDir: string;
}

/**
 * Parse a GitHub repository URL into owner and name.
 * Handles both HTTPS and SSH formats:
 *   https://github.com/owner/repo.git
 *   git@github.com:owner/repo.git
 */
// A well-formed GitHub URL is far shorter than this; reject anything longer
// up front so the unanchored [^/]+ groups below can't backtrack over an
// attacker-supplied string with no '/' in it. Bounded span: js/polynomial-redos
const MAX_REPO_URL_LENGTH = 2048;

function parseRepoUrl(repoUrl: string): {
	repoOwner: string;
	repoName: string;
} {
	if (repoUrl.length > MAX_REPO_URL_LENGTH) {
		throw new Error(
			`Cannot parse repository URL: URL exceeds maximum length of ${MAX_REPO_URL_LENGTH} characters. Expected GitHub HTTPS or SSH format.`,
		);
	}

	// Try HTTPS format: https://github.com/owner/repo(.git)
	const httpsMatch = repoUrl.match(
		/(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/.]+)/,
	);
	if (httpsMatch) {
		return { repoOwner: httpsMatch[1], repoName: httpsMatch[2] };
	}

	// Try SSH format: git@github.com:owner/repo.git
	const sshMatch = repoUrl.match(/git@github\.com:([^/]+)\/([^/.]+)/);
	if (sshMatch) {
		return { repoOwner: sshMatch[1], repoName: sshMatch[2] };
	}

	throw new Error(
		`Cannot parse repository URL: ${repoUrl}. Expected GitHub HTTPS or SSH format.`,
	);
}

function getProvider() {
	return getBackgroundAgentsProvider();
}

export async function createSandboxActivity(
	input: CreateSandboxInput,
): Promise<SandboxInfo> {
	if (!input.userId) {
		throw new Error("userId is required to create a sandbox session");
	}

	if (!input.repoUrl) {
		throw new Error(
			"repoUrl is required — configure a repository URL in project settings",
		);
	}

	const { repoOwner, repoName } = parseRepoUrl(input.repoUrl);
	const provider = getProvider();

	const { sessionId } = await provider.createSession({
		repoOwner,
		repoName,
		title: "Weave execution session",
		branch: input.branch,
		userId: input.userId,
	});

	return { sessionId, workDir: "" };
}

export interface DestroySandboxInput {
	sessionId: string;
	userId: string;
	organizationId?: string | null;
}

export async function destroySandboxActivity(
	input: DestroySandboxInput,
): Promise<void> {
	if (!input.userId || !input.sessionId) {
		throw new Error(
			"userId and sessionId are required to destroy a sandbox",
		);
	}

	try {
		const provider = getProvider();
		await provider.cancelSession(input.sessionId);
	} catch (error) {
		// Session may already be completed/stopped — log but don't fail
		console.warn(
			`Failed to cancel background agent session ${input.sessionId}:`,
			error instanceof Error ? error.message : error,
		);
	}
}
