/**
 * fabric auth logout
 * Revokes a browser sign-in at the server, then removes the stored credential.
 *
 *   fabric auth logout                  the deployment's own credential
 *   fabric auth logout --project <id>   one project's sign-in, and nothing else
 *   fabric auth logout --base-url <url> another deployment's, with or without --project
 *
 * A project's sign-in is a credential of its own, so signing out of the
 * deployment leaves it, and signing out of a project leaves the rest. A
 * credential belongs to one deployment, so `--base-url` picks whose: the same
 * profile `auth login --base-url` kept it under.
 */

import { Command } from "commander";
import {
	clearApiKey,
	clearProjectSignIn,
	getBaseUrl,
	getOAuth,
	hasStoredApiKey,
	listProjectSignIns,
} from "../../lib/config.js";
import { fabricCommand } from "../../lib/launcher.js";
import { isProjectId } from "../../lib/oauth/project-resource.js";
import { revokeOAuthSession } from "../../lib/oauth/session.js";
import {
	BAD_BASE_URL_LINE,
	DEFAULT_ORIGIN,
	normalizeOrigin,
} from "../../lib/origin.js";
import { printError, printSuccess, printWarning } from "../../lib/output.js";

const REVOKE_FAILED_LINE =
	"Could not reach the server to revoke the sign-in. It was removed from this machine; revoke it under Connected agents in your account settings.";

/** The line that signs out of one project, for a sign-in that is left. */
function projectLogoutCommand(projectId: string, origin: string): string {
	return fabricCommand(`auth logout --project ${projectId}`, origin);
}

/**
 * The deployment `--base-url` names, as its origin, or `undefined` when it was
 * not given, which leaves the choice to the active profile.
 */
function namedOrigin(baseUrl: string | undefined): string | undefined {
	if (baseUrl === undefined) {
		return undefined;
	}
	const origin = normalizeOrigin(baseUrl);
	if (origin === null) {
		printError(BAD_BASE_URL_LINE, 2);
	}
	return origin;
}

async function logoutOfProject(
	projectId: string,
	named: string | undefined,
): Promise<void> {
	if (!isProjectId(projectId)) {
		printError(
			"--project must be a project id: letters, digits, '_' and '-', at most 64.",
			2,
		);
	}
	const origin = named ?? normalizeOrigin(getBaseUrl() ?? DEFAULT_ORIGIN);
	if (origin === null) {
		printError(BAD_BASE_URL_LINE, 2);
	}

	const oauth = getOAuth(origin, projectId);
	if (!oauth) {
		printWarning(
			`No sign-in stored for project ${projectId} on ${origin}.`,
		);
		return;
	}
	const revoked = await revokeOAuthSession(oauth);
	clearProjectSignIn(projectId, origin);
	if (!revoked) {
		printWarning(REVOKE_FAILED_LINE);
	}
	printSuccess(
		`Signed out of project ${projectId}. Every other sign-in is untouched.`,
	);
}

/** What is left, said once, after the deployment's own credential is gone or was never there. */
function remainingProjects(origin: string): string | null {
	const remaining = listProjectSignIns(origin);
	if (remaining.length === 0) {
		return null;
	}
	return `Still signed in for ${remaining.length === 1 ? "project" : "projects"} ${remaining.map((entry) => entry.projectId).join(", ")}. Sign out of one with: ${projectLogoutCommand(remaining[0].projectId, origin)}`;
}

export function buildLogoutCommand(): Command {
	return new Command("logout")
		.description(
			"Sign out: revoke the browser sign-in or remove the stored API key, or with --project one project's sign-in",
		)
		.option(
			"--project <id>",
			"Sign out of this project only; every other sign-in stays",
		)
		.option(
			"--base-url <url>",
			"Deployment to sign out of, such as https://example.com (default: the one you are signed in to)",
		)
		.action(async (opts: { project?: string; baseUrl?: string }) => {
			const named = namedOrigin(opts.baseUrl);
			if (opts.project !== undefined) {
				await logoutOfProject(opts.project, named);
				return;
			}

			const origin =
				named ?? normalizeOrigin(getBaseUrl() ?? DEFAULT_ORIGIN);
			const left = origin === null ? null : remainingProjects(origin);
			const oauth = getOAuth(named);

			if (!oauth && !hasStoredApiKey(named)) {
				printWarning(
					left === null
						? named === undefined
							? "No credentials stored — already logged out."
							: `No credentials stored for ${named} — already logged out.`
						: `Nothing stored for the deployment itself. ${left}`,
				);
				return;
			}

			if (oauth) {
				const revoked = await revokeOAuthSession(oauth);
				clearApiKey(named);
				if (!revoked) {
					printWarning(REVOKE_FAILED_LINE);
				}
				printSuccess("Logged out. Sign-in removed.");
			} else {
				clearApiKey(named);
				printSuccess("Logged out. API key removed.");
			}
			if (left !== null) {
				printWarning(left);
			}
		});
}
