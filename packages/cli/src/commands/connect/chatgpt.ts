/**
 * fabric connect chatgpt
 *
 * Connects your own ChatGPT plan to Fabric, so your own AI work in
 * organizations that allow it runs on your plan. No API key and no earlier
 * `fabric auth login` is needed:
 *
 *   1. Fabric opens in the browser; your existing web session approves the
 *      connection and the organizations to use it in.
 *   2. You sign in to ChatGPT on this machine.
 *   3. The sign-in goes to Fabric with the one-time ticket from step 1. Fabric
 *      stores it encrypted and refreshes it itself; nothing but this machine's
 *      registration is kept here.
 *
 *   fabric connect chatgpt                      connect to the deployment you use
 *   fabric connect chatgpt --base-url <url>     connect to another deployment
 *   fabric connect chatgpt --new-registration   register this machine with OpenAI again
 *   fabric connect chatgpt --org <slug> --shared
 *                                               connect a ChatGPT account the
 *                                               organization shares (admins)
 *
 * A shared account is signed in with its own one-time registration, never
 * this machine's saved one: that belongs to your own plan, and the shared
 * account is a different ChatGPT account.
 *
 * Disconnecting, and the per-organization choices, live in Fabric settings.
 */

import { randomUUID } from "node:crypto";
import { Command } from "commander";
import {
	buildApprovalUrl,
	buildAuthorizeUrl,
	buildUploadPayload,
	CHATGPT_CALLBACK_PATH,
	CHATGPT_CALLBACK_PORT,
	type ChatGptPlanSharedUploadResult,
	type ChatGptPlanUploadResult,
	type ChatGptRegistration,
	checkIdToken,
	DYNAMIC_CLIENT_ID,
	exchangeCode,
	FABRIC_APPROVAL_CALLBACK_PATH,
	issuedClientId,
	loadRegistration,
	randomToken,
	saveRegistration,
	uploadChatGptPlan,
} from "../../lib/chatgpt-plan/flow.js";
import { getBaseUrl } from "../../lib/config.js";
import { openBrowser } from "../../lib/oauth/browser.js";
import { startLoopbackListener } from "../../lib/oauth/loopback.js";
import {
	codeChallengeS256,
	createCodeVerifier,
	createState,
} from "../../lib/oauth/pkce.js";
import {
	BAD_BASE_URL_LINE,
	DEFAULT_ORIGIN,
	normalizeOrigin,
} from "../../lib/origin.js";
import { printError, printSuccess } from "../../lib/output.js";

const CHATGPT_PLAN_NOT_ENABLED =
	"ChatGPT plan isn't enabled for any of your organizations. Ask your Fabric admin to enable it.";
const CHATGPT_PLAN_SHARED_NOT_ALLOWED =
	"You can connect a shared ChatGPT plan account only to an organization you administer, with ChatGPT plan pooling enabled.";

export interface ConnectOptions {
	baseUrl?: string;
	newRegistration?: boolean;
	org?: string;
	shared?: boolean;
}

/** Why these options cannot run together, or null when they can. */
export function connectOptionsError(opts: ConnectOptions): string | null {
	if (opts.shared && !opts.org) {
		return "--shared needs --org <slug>: the organization the account is shared with.";
	}
	if (opts.org && !opts.shared) {
		return "--org is used only with --shared, to connect an account the organization shares.";
	}
	return null;
}

function open(url: string, what: string): void {
	process.stdout.write(
		`Opening your browser to ${what}. If it does not open, visit:\n${url}\n`,
	);
	try {
		openBrowser(url);
	} catch {}
}

/** Step 1: the person approves in Fabric; the ticket comes back to this machine. */
async function approveInFabric(
	origin: string,
	sharedOrganizationSlug?: string,
): Promise<string> {
	const state = createState();
	const listener = await startLoopbackListener({
		state,
		callbackPath: FABRIC_APPROVAL_CALLBACK_PATH,
		codeParam: "ticket",
	});
	const port = Number(new URL(listener.redirectUri).port);
	open(
		buildApprovalUrl(origin, { port, state, sharedOrganizationSlug }),
		"approve the connection in Fabric",
	);
	try {
		return (await listener.result).code;
	} catch (err: unknown) {
		// The page refuses when no organization of yours allows a plan.
		if ((err as Error).message.includes("chatgpt_plan_not_enabled")) {
			throw new Error(CHATGPT_PLAN_NOT_ENABLED);
		}
		if (
			(err as Error).message.includes("chatgpt_plan_shared_not_allowed")
		) {
			throw new Error(CHATGPT_PLAN_SHARED_NOT_ALLOWED);
		}
		throw err;
	} finally {
		listener.close();
	}
}

/** What to tell the person about where the plan is now used. */
export function describeOrganizations(
	result: Pick<ChatGptPlanUploadResult, "organizations">,
): string {
	const enabled = result.organizations.filter((org) => org.enabled);
	if (enabled.length === 0) {
		return "Choose where to use it in Fabric settings → Account → AI providers.";
	}
	return `Your own AI work in ${enabled.map((org) => org.name).join(", ")} now uses your ChatGPT plan.`;
}

/** What to tell the admin after connecting a shared account. */
export function describeSharedAccount(
	result: Pick<ChatGptPlanSharedUploadResult, "email" | "shared">,
): string {
	const account = result.email ? ` (${result.email})` : "";
	const { organization, created } = result.shared;
	return `${created ? "Connected" : "Reconnected"} the ChatGPT account${account} as a shared account of ${organization.name}. Choose which work it serves in ${organization.name}'s settings → AI providers.`;
}

async function connect(opts: ConnectOptions): Promise<void> {
	const optionsError = connectOptionsError(opts);
	if (optionsError) {
		printError(optionsError, 2);
	}
	const origin = normalizeOrigin(
		opts.baseUrl ?? getBaseUrl() ?? DEFAULT_ORIGIN,
	);
	if (origin === null) {
		printError(BAD_BASE_URL_LINE, 2);
	}
	const sharedOrganizationSlug = opts.shared ? opts.org : undefined;

	let ticket: string;
	try {
		ticket = await approveInFabric(origin, sharedOrganizationSlug);
	} catch (err: unknown) {
		printError((err as Error).message, 1);
	}

	const stored = await loadRegistration();
	let registration: ChatGptRegistration = stored;
	if (sharedOrganizationSlug) {
		registration = { hostId: `urn:uuid:${randomUUID()}` };
	} else if (opts.newRegistration) {
		registration = { hostId: stored.hostId };
	}
	const verifier = createCodeVerifier();
	const state = createState();
	const nonce = randomToken();
	const listener = await startLoopbackListener({
		state,
		callbackPath: CHATGPT_CALLBACK_PATH,
		preferredPort: CHATGPT_CALLBACK_PORT,
	});
	open(
		buildAuthorizeUrl({
			clientId: registration.clientId ?? DYNAMIC_CLIENT_ID,
			hostId: registration.hostId,
			redirectUri: listener.redirectUri,
			state,
			nonce,
			codeChallenge: codeChallengeS256(verifier),
		}),
		"sign in with ChatGPT",
	);

	let result: ChatGptPlanUploadResult | ChatGptPlanSharedUploadResult;
	let clientId: string;
	let subject: string;
	try {
		const { code, params } = await listener.result;
		clientId = issuedClientId(params, registration);
		// Saved before the exchange, so a failed exchange does not register
		// this machine a second time next run.
		if (!sharedOrganizationSlug) {
			await saveRegistration({ ...registration, clientId });
		}
		const tokens = await exchangeCode({
			clientId,
			code,
			codeVerifier: verifier,
			redirectUri: listener.redirectUri,
		});
		subject = checkIdToken(tokens.id_token ?? "", {
			nonce,
			subject: registration.subject,
		}).sub;
		result = await uploadChatGptPlan({
			origin,
			ticket,
			payload: buildUploadPayload(tokens, {
				clientId,
				hostId: registration.hostId,
			}),
		});
	} catch (err: unknown) {
		printError((err as Error).message, 1);
	} finally {
		listener.close();
	}

	if ("shared" in result) {
		printSuccess(describeSharedAccount(result));
		return;
	}
	await saveRegistration({ hostId: registration.hostId, clientId, subject });
	printSuccess(
		`Connected your ChatGPT plan${result.email ? ` (${result.email})` : ""} to Fabric.`,
	);
	process.stdout.write(`${describeOrganizations(result)}\n`);
}

export function buildConnectCommand(): Command {
	const connectCommand = new Command("connect").description(
		"Connect a personal AI subscription to Fabric",
	);
	connectCommand.addCommand(
		new Command("chatgpt")
			.description(
				"Approve in Fabric, sign in with ChatGPT and run your own Fabric AI work on your plan",
			)
			.option(
				"--new-registration",
				"Register this machine with OpenAI again, for example to switch accounts",
			)
			.option(
				"--base-url <url>",
				"Deployment to connect, such as https://example.com",
			)
			.option(
				"--org <slug>",
				"With --shared: the organization to share the account with",
			)
			.option(
				"--shared",
				"Connect a ChatGPT account the organization shares, instead of your own plan (organization admins)",
			)
			.action(connect),
	);
	return connectCommand;
}
