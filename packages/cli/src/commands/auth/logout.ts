/**
 * fabric auth logout
 * Removes the stored API key from config.
 */

import { Command } from "commander";
import { clearApiKey, getApiKey } from "../../lib/config.js";
import { printSuccess, printWarning } from "../../lib/output.js";

export function buildLogoutCommand(): Command {
	return new Command("logout")
		.description("Remove stored API key")
		.action(() => {
			if (!getApiKey()) {
				printWarning("No API key stored — already logged out.");
				return;
			}
			clearApiKey();
			printSuccess("Logged out. API key removed.");
		});
}
