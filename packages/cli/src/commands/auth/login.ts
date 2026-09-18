/**
 * fabric auth login
 *
 * Stores an API key for subsequent commands.
 *
 *   fabric auth login --key fab_...
 *   fabric auth login              (prompts interactively)
 */

import * as readline from "node:readline";
import { FabricAuthError, FabricClient, FabricError } from "@fabricorg/sdk";
import { Command } from "commander";
import { getBaseUrl, saveApiKey } from "../../lib/config.js";
import { printError, printSuccess } from "../../lib/output.js";

const DEFAULT_BASE_URL = "https://fabric.pro";

function displayBaseUrl(baseUrl: string): string {
	try {
		return new URL(baseUrl).origin;
	} catch {
		return "the configured Fabric deployment";
	}
}

async function promptApiKey(): Promise<string> {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	return new Promise((resolve) => {
		// Don't echo the key
		process.stdout.write("Fabric API Key: ");
		process.stdin.resume();
		process.stdin.setEncoding("utf8");

		let key = "";
		process.stdin.once("data", (chunk) => {
			key = String(chunk).trim();
			process.stdout.write("\n");
			rl.close();
			resolve(key);
		});
	});
}

export function buildLoginCommand(): Command {
	return new Command("login")
		.description("Authenticate with a Fabric API key")
		.option("-k, --key <api-key>", "API key (fab_... or org_...)")
		.option("--base-url <url>", "Override the Fabric base URL")
		.action(async (opts: { key?: string; baseUrl?: string }) => {
			let apiKey = opts.key?.trim();

			if (!apiKey) {
				apiKey = await promptApiKey();
			}

			if (!apiKey) {
				printError("API key is required", 2);
			}

			if (!apiKey.startsWith("fab_") && !apiKey.startsWith("org_")) {
				printError(
					"Invalid API key format. Keys must start with fab_ or org_",
					2,
				);
			}

			// Verify the key works before saving
			const baseUrl = opts.baseUrl ?? getBaseUrl();
			const effectiveBaseUrl = displayBaseUrl(
				baseUrl ?? DEFAULT_BASE_URL,
			);
			const client = new FabricClient({ apiKey, baseUrl });

			let name: string;
			let email: string;
			try {
				const me = await client.auth.whoami();
				name = me.user.name ?? me.user.email;
				email = me.user.email;
			} catch (error) {
				if (
					error instanceof FabricAuthError ||
					(error instanceof FabricError && error.status === 401)
				) {
					printError(
						"Authentication failed. Check that the key is valid and not expired.",
						3,
					);
				}

				if (error instanceof FabricError && error.status > 0) {
					printError(
						`Authentication request to ${effectiveBaseUrl} failed with HTTP ${error.status}.`,
						3,
					);
				}

				printError(
					`Could not connect to ${effectiveBaseUrl}. Check that the deployment URL is correct and reachable.`,
					3,
				);
			}

			// An environment override selects the verification target for this
			// invocation only. Persist a deployment only when the person supplied
			// `--base-url`, so FABRIC_BASE_URL remains an explicit override.
			saveApiKey(apiKey, {
				...(opts.baseUrl === undefined
					? {}
					: { baseUrl: opts.baseUrl }),
			});
			printSuccess(`Authenticated as ${name} (${email})`);
		});
}
