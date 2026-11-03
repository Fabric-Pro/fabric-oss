import { ORPCError } from "@orpc/server";
import {
	gitHubProjectsCredentialMessage,
	readPmCredentialId,
	resolveGitHubProjectsCredential,
} from "@repo/integrations/github/projects-credential";
import {
	GITHUB_PROJECTS_SCOPE_MESSAGE,
	GitHubProjectsError,
	type GitHubProjectsSource,
	readGitHubProjectsRepository,
} from "@repo/integrations/github/projects-pm-adapter";

/**
 * The GitHub Projects source for a project's PM selection, acting through
 * the CALLER's own GitHub connection (exclusive tenant: the (user,
 * organization) workflow integration), never a teammate's — the same rule
 * the worker's `resolvePmSource` applies. Throws a user-actionable
 * `BAD_REQUEST` when GitHub is not connected or no board is selected.
 */
export async function requireGitHubProjectsSource(args: {
	userId: string;
	organizationId: string | null;
	project: {
		projectManagementContainerId: string | null;
		projectManagementAdditionalContext: unknown;
	};
}): Promise<GitHubProjectsSource> {
	const boardId = args.project.projectManagementContainerId;
	if (!boardId) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Select a GitHub project board in Project Settings first.",
		});
	}
	const credential = await resolveGitHubProjectsCredential(
		args.userId,
		args.organizationId,
		readPmCredentialId(args.project.projectManagementAdditionalContext),
	);
	if (!credential.ok) {
		throw new ORPCError("BAD_REQUEST", {
			message: gitHubProjectsCredentialMessage(credential.reason),
		});
	}
	return {
		token: credential.token,
		projectId: boardId,
		repository: readGitHubProjectsRepository(
			args.project.projectManagementAdditionalContext,
		),
	};
}

/**
 * Map a GitHub Projects adapter failure to a user-actionable ORPCError; any
 * other error is rethrown unchanged.
 */
export function rethrowGitHubProjectsError(error: unknown): never {
	if (error instanceof GitHubProjectsError) {
		switch (error.kind) {
			case "insufficient-scope":
				// The adapter's message names the scope GitHub asked for.
				throw new ORPCError("FORBIDDEN", {
					message: error.message || GITHUB_PROJECTS_SCOPE_MESSAGE,
				});
			case "auth":
				throw new ORPCError("UNAUTHORIZED", { message: error.message });
			case "not-found":
				throw new ORPCError("NOT_FOUND", { message: error.message });
			case "forbidden":
				throw new ORPCError("FORBIDDEN", { message: error.message });
			case "rate-limited":
				throw new ORPCError("TOO_MANY_REQUESTS", {
					message: error.message,
				});
			default:
				throw new ORPCError("BAD_GATEWAY", { message: error.message });
		}
	}
	throw error;
}
