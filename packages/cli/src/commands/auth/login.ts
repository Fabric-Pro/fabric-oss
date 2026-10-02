/**
 * fabric auth login
 *
 * Signs in. With no key it opens the browser, the person approves the CLI for
 * one organization, and the CLI keeps the resulting tokens in its profile and
 * refreshes them itself. With a key it stores the key, for CI and machines with
 * no browser.
 *
 *   fabric auth login                          (browser sign-in)
 *   fabric auth login --base-url <url>         (browser sign-in, other deployment)
 *   fabric auth login --key fab_...            (API key)
 */

import { FabricAuthError, FabricClient, FabricError } from "@fabricorg/sdk";
import { Command } from "commander";
import {
	getBaseUrl,
	getOAuth,
	type OAuthCredentials,
	saveApiKey,
	saveOAuth,
} from "../../lib/config.js";
import { openBrowser } from "../../lib/oauth/browser.js";
import { loginWithBrowser } from "../../lib/oauth/flow.js";
import { revokeOAuthSession } from "../../lib/oauth/session.js";
import { printError, printSuccess } from "../../lib/output.js";

const DEFAULT_BASE_URL = "https://fabric.pro";

function displayBaseUrl(baseUrl: string): string {
	try {
		return new URL(baseUrl).origin;
	} catch {
		return "the configured Fabric deployment";
	}
}

async function loginWithKey(
	apiKey: string,
	opts: { baseUrl?: string },
): Promise<void> {
	if (!apiKey.startsWith("fab_") && !apiKey.startsWith("org_")) {
		printError(
			"Invalid API key format. Keys must start with fab_ or org_",
			2,
		);
	}

	// Verify the key works before saving
	const baseUrl = opts.baseUrl ?? getBaseUrl();
	const effectiveBaseUrl = displayBaseUrl(baseUrl ?? DEFAULT_BASE_URL);
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
	const replacedSignIn = getOAuth();
	saveApiKey(apiKey, {
		...(opts.baseUrl === undefined ? {} : { baseUrl: opts.baseUrl }),
	});
	// A key replaces a browser sign-in in the profile; end that sign-in at the
	// server too rather than leave its refresh token valid and unheld.
	if (replacedSignIn) {
		await revokeOAuthSession(replacedSignIn);
	}
	printSuccess(`Authenticated as ${name} (${email})`);
}

async function loginInBrowser(opts: { baseUrl?: string }): Promise<void> {
	const baseUrl = opts.baseUrl ?? getBaseUrl() ?? DEFAULT_BASE_URL;
	const effectiveBaseUrl = displayBaseUrl(baseUrl);
	const previous = getOAuth();

	let credentials: OAuthCredentials;
	try {
		credentials = await loginWithBrowser({
			baseUrl,
			previous,
			openBrowser,
			announce: (url) => {
				process.stdout.write(
					`Opening your browser to sign in to ${effectiveBaseUrl}.\nIf it does not open, visit:\n\n  ${url}\n\n`,
				);
			},
		});
	} catch (error) {
		// Discovery, registration, the browser step and the code exchange all
		// fail with a message written for this terminal.
		if (error instanceof Error) {
			printError(error.message, 3);
		}
		throw error;
	}

	// Verify with the tokens in hand before saving anything: a sign-in the
	// server then refuses should not replace a working profile.
	const client = new FabricClient({
		apiKey: credentials.accessToken,
		baseUrl,
	});

	let name: string;
	let email: string;
	try {
		const me = await client.auth.whoami();
		name = me.user.name ?? me.user.email;
		email = me.user.email;
	} catch {
		printError(
			`Signed in, but ${effectiveBaseUrl} did not accept the new credentials.`,
			3,
		);
	}

	saveOAuth(credentials, {
		...(opts.baseUrl === undefined ? {} : { baseUrl: opts.baseUrl }),
	});
	// The sign-in this replaced would otherwise stay valid at the server for
	// the rest of its refresh token's life, held by nobody. Best effort: the
	// new sign-in is already saved either way.
	if (previous && previous.refreshToken !== credentials.refreshToken) {
		await revokeOAuthSession(previous);
	}
	printSuccess(`Authenticated as ${name} (${email})`);
}

export function buildLoginCommand(): Command {
	return new Command("login")
		.description(
			"Sign in through your browser, or store an API key with --key",
		)
		.option(
			"-k, --key <api-key>",
			"API key (fab_... or org_...) for CI and headless use",
		)
		.option("--base-url <url>", "Override the Fabric base URL")
		.action(async (opts: { key?: string; baseUrl?: string }) => {
			const apiKey = opts.key?.trim();
			if (apiKey) {
				await loginWithKey(apiKey, opts);
				return;
			}
			if (opts.key !== undefined) {
				printError("API key is required", 2);
			}
			await loginInBrowser(opts);
		});
}
