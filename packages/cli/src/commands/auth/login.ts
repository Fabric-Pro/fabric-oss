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
 *   fabric auth login --project <id>           (browser sign-in for one project)
 *   fabric auth login --key fab_...            (API key)
 */

import { FabricAuthError, FabricClient, FabricError } from "@fabricorg/sdk";
import { Command } from "commander";
import { getBaseUrl, getOAuth, saveApiKey } from "../../lib/config.js";
import { isProjectId } from "../../lib/oauth/project-resource.js";
import { revokeOAuthSession } from "../../lib/oauth/session.js";
import {
	type SignInResult,
	signInWithBrowser,
} from "../../lib/oauth/sign-in.js";
import {
	BAD_BASE_URL_LINE,
	bakedOrigin,
	normalizeOrigin,
} from "../../lib/origin.js";
import { printError, printSuccess } from "../../lib/output.js";

const DEFAULT_BASE_URL = "https://fabric.pro";

/**
 * The deployment a login keeps its credentials under: the one `--base-url`
 * named, else the one this build was packed for, unless the environment
 * overrides it for this run. `undefined` leaves the active profile alone.
 */
function chosenBaseUrl(opts: { baseUrl?: string }): string | undefined {
	if (opts.baseUrl !== undefined) {
		return opts.baseUrl;
	}
	return process.env.FABRIC_BASE_URL ? undefined : bakedOrigin();
}

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
	// `--base-url` or this build is packed for one, so FABRIC_BASE_URL remains
	// an explicit override.
	const replacedSignIn = getOAuth();
	const chosen = chosenBaseUrl(opts);
	saveApiKey(apiKey, chosen === undefined ? {} : { baseUrl: chosen });
	// A key replaces a browser sign-in in the profile; end that sign-in at the
	// server too rather than leave its refresh token valid and unheld.
	if (replacedSignIn) {
		await revokeOAuthSession(replacedSignIn);
	}
	printSuccess(`Authenticated as ${name} (${email})`);
}

async function loginInBrowser(opts: {
	baseUrl?: string;
	project?: string;
}): Promise<void> {
	const baseUrl = opts.baseUrl ?? getBaseUrl() ?? DEFAULT_BASE_URL;
	const effectiveBaseUrl = displayBaseUrl(baseUrl);
	const origin = normalizeOrigin(baseUrl);
	if (origin === null) {
		printError(BAD_BASE_URL_LINE, 2);
	}
	const forProject =
		opts.project === undefined ? "" : ` for project ${opts.project}`;

	let identity: SignInResult;
	try {
		identity = await signInWithBrowser({
			baseUrl,
			origin,
			explicit: chosenBaseUrl(opts) !== undefined,
			project: opts.project,
			announce: (url) => {
				process.stdout.write(
					`Opening your browser to sign in to ${effectiveBaseUrl}${forProject}.\nIf it does not open, visit:\n\n  ${url}\n\n`,
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
	printSuccess(
		`Authenticated as ${identity.name} (${identity.email})${forProject}`,
	);
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
		.option(
			"--project <id>",
			"Sign in for this one project only: the sign-in reaches that project and nothing else (browser sign-in only)",
		)
		.action(
			async (opts: {
				key?: string;
				baseUrl?: string;
				project?: string;
			}) => {
				if (opts.project !== undefined) {
					if (!isProjectId(opts.project)) {
						printError(
							"--project must be a project id: letters, digits, '_' and '-', at most 64.",
							2,
						);
					}
					if (opts.key !== undefined) {
						printError(
							"--project signs in through the browser: an API key is not limited to one project, so it cannot be combined with --key.",
							2,
						);
					}
				}
				const apiKey = opts.key?.trim();
				if (apiKey) {
					await loginWithKey(apiKey, opts);
					return;
				}
				if (opts.key !== undefined) {
					printError("API key is required", 2);
				}
				await loginInBrowser(opts);
			},
		);
}
