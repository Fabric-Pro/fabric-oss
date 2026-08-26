/**
 * Returns a configured FabricClient for CLI commands.
 * Exits with a clear error if no API key is available.
 */

import { FabricAuthError, FabricClient } from "@fabricorg/sdk";
import { getApiKey, getBaseUrl } from "./config.js";
import { printError } from "./output.js";

export function getClient(): FabricClient {
	const apiKey = getApiKey();

	if (!apiKey) {
		printError(
			"Not authenticated. Run:\n  fabric auth login --key <api-key>",
			3,
		);
	}

	try {
		return new FabricClient({ apiKey, baseUrl: getBaseUrl() });
	} catch (err: unknown) {
		if (err instanceof FabricAuthError) {
			printError(err.message, 3);
		}
		throw err;
	}
}
