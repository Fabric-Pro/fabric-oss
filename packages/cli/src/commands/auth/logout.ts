/**
 * fabric auth logout
 * Revokes a browser sign-in at the server, then removes the stored credential.
 */

import { Command } from "commander";
import { clearApiKey, getOAuth, hasStoredApiKey } from "../../lib/config.js";
import { revokeOAuthSession } from "../../lib/oauth/session.js";
import { printSuccess, printWarning } from "../../lib/output.js";

export function buildLogoutCommand(): Command {
	return new Command("logout")
		.description(
			"Sign out: revoke the browser sign-in or remove the stored API key",
		)
		.action(async () => {
			const oauth = getOAuth();

			if (!oauth && !hasStoredApiKey()) {
				printWarning("No credentials stored — already logged out.");
				return;
			}

			if (oauth) {
				const revoked = await revokeOAuthSession(oauth);
				clearApiKey();
				if (!revoked) {
					printWarning(
						"Could not reach the server to revoke the sign-in. It was removed from this machine; revoke it under Connected agents in your account settings.",
					);
				}
				printSuccess("Logged out. Sign-in removed.");
				return;
			}

			clearApiKey();
			printSuccess("Logged out. API key removed.");
		});
}
