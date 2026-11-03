/**
 * The GitHub credential GitHub Projects calls run with.
 *
 * A project can bind one credential from the credential manager (ADR-026),
 * chosen in its project-management settings: then exactly that one is used,
 * as the caller, and a credential the caller may not use is refused rather
 * than swapped for another. Without a binding, the caller's GitHub
 * connection (`WorkflowIntegration`) is used as before.
 */

import { isFeatureEnabled } from "@repo/database";
import { resolveCredential } from "../credential-manager";
import { getGitHubWorkflowCredential } from "./index";

/** Kinds a GitHub Projects call can run with. */
export const GITHUB_PROJECTS_CREDENTIAL_KINDS = [
	"PAT",
	"GITHUB_APP_USER",
	"OAUTH",
] as const;

export type GitHubProjectsCredential =
	| { ok: true; token: string; source: "credential" | "connection" }
	| {
			ok: false;
			reason:
				| "no-connection"
				| "credential-manager-off"
				| "credential-unusable";
	  };

/** The key a project's PM context stores its chosen credential under. */
export const PM_CREDENTIAL_CONTEXT_KEY = "credentialId";

/** The credential a project's PM context binds, if any. */
export function readPmCredentialId(additionalContext: unknown): string | null {
	if (!additionalContext || typeof additionalContext !== "object") {
		return null;
	}
	const value = (additionalContext as Record<string, unknown>)[
		PM_CREDENTIAL_CONTEXT_KEY
	];
	return typeof value === "string" && value.length > 0 ? value : null;
}

export async function resolveGitHubProjectsCredential(
	userId: string,
	organizationId: string | null | undefined,
	credentialId?: string | null,
): Promise<GitHubProjectsCredential> {
	if (credentialId) {
		if (
			!organizationId ||
			!(await isFeatureEnabled(
				"CREDENTIAL_MANAGER",
				organizationId,
			).catch(() => false))
		) {
			return { ok: false, reason: "credential-manager-off" };
		}
		const resolved = await resolveCredential({
			credentialId,
			actor: {
				type: "user",
				userId,
				organizationId,
				canManageOrganizationIntegrations: false,
			},
			requirement: {
				provider: "GITHUB",
				kinds: GITHUB_PROJECTS_CREDENTIAL_KINDS,
			},
		}).catch(() => null);
		return resolved?.ok
			? { ok: true, token: resolved.value.token, source: "credential" }
			: { ok: false, reason: "credential-unusable" };
	}
	const connection = await getGitHubWorkflowCredential(
		userId,
		organizationId ?? undefined,
	);
	return connection
		? { ok: true, token: connection.token, source: "connection" }
		: { ok: false, reason: "no-connection" };
}

/** What a person is told when no GitHub credential could be used. */
export function gitHubProjectsCredentialMessage(
	reason: Extract<GitHubProjectsCredential, { ok: false }>["reason"],
): string {
	switch (reason) {
		case "credential-unusable":
			return "The GitHub credential chosen for this project cannot be used: it was deleted, revoked or is not shared with you. Choose another one in the project-management settings.";
		case "credential-manager-off":
			return "This project uses a saved GitHub credential, but the credential manager is off for this organization.";
		default:
			return "GitHub not connected. Connect your GitHub account in Settings → Integrations, or choose a saved GitHub credential in the project-management settings.";
	}
}
