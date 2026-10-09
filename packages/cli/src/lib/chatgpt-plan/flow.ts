/**
 * "Sign in with ChatGPT" on this machine (OpenAI's open-source / locally
 * hosted flow), for `fabric connect chatgpt`.
 *
 * The browser sign-in, the PKCE exchange and the nonce check all happen here;
 * the tokens then go to Fabric with the one-time ticket the person approved
 * in the browser, and are never written to this machine. What is kept on disk
 * is the host id and, per ChatGPT account, the client id OpenAI issued to it.
 * A registration is made inside one ChatGPT workspace and refused in another,
 * so a saved one is reused only for the account it was made for, when asked.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getConfigPath } from "../config.js";
import type { FetchLike } from "../oauth/flow.js";
import { CallbackError, startLoopbackListener } from "../oauth/loopback.js";
import {
	codeChallengeS256,
	createCodeVerifier,
	createState,
} from "../oauth/pkce.js";

const CHATGPT_ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = `${CHATGPT_ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${CHATGPT_ISSUER}/api/accounts/oauth/token`;
const RESOURCE = "https://api.openai.com/v1";
const CHATGPT_PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = `openid profile email offline_access resource.invoke ${CHATGPT_PLAN_SCOPE}`;
/** The client id a first sign-in starts with; OpenAI issues the real one. */
export const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
const CHATGPT_CALLBACK_PATH = "/auth/callback";
/** The port OpenAI documents for local apps; another is used when taken. */
const CHATGPT_CALLBACK_PORT = 1455;
const AGENT_NAME = "Fabric";

export interface ChatGptRegistration {
	hostId: string;
	clientId?: string;
	subject?: string;
}

function registrationPath(): string {
	return join(dirname(getConfigPath()), "chatgpt-plan-host.json");
}

/** One ChatGPT account's registration with OpenAI on this machine. */
export interface ChatGptAccountRegistration {
	clientId: string;
	email?: string;
}

export interface ChatGptRegistrationStore {
	hostId: string;
	/** Keyed by the account's ID token subject. */
	accounts: Record<string, ChatGptAccountRegistration>;
}

/**
 * The single registration earlier versions kept. Its client id is carried
 * over only with the subject it was confirmed for; without one it may have
 * been saved before a sign-in that never completed.
 */
interface LegacyRegistration {
	hostId?: string;
	clientId?: string;
	subject?: string;
}

export async function loadRegistrationStore(
	path = registrationPath(),
): Promise<ChatGptRegistrationStore> {
	let stored: Partial<ChatGptRegistrationStore> & LegacyRegistration;
	try {
		stored = JSON.parse(await readFile(path, "utf8"));
	} catch {
		stored = {};
	}
	const hostId = stored.hostId ?? `urn:uuid:${randomUUID()}`;
	if (stored.accounts && typeof stored.accounts === "object") {
		return { hostId, accounts: stored.accounts };
	}
	return {
		hostId,
		accounts:
			stored.subject && stored.clientId
				? { [stored.subject]: { clientId: stored.clientId } }
				: {},
	};
}

/** Records one account's registration, keeping every other account's. */
export async function saveAccountRegistration(
	account: { hostId: string; subject: string } & ChatGptAccountRegistration,
	path = registrationPath(),
): Promise<void> {
	const store = await loadRegistrationStore(path);
	const { hostId, subject, ...registration } = account;
	const next: ChatGptRegistrationStore = {
		hostId,
		accounts: { ...store.accounts, [subject]: registration },
	};
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, JSON.stringify(next), { mode: 0o600 });
}

/**
 * The registration a sign-in starts with: the saved one of the account named
 * with `--account` (its subject, or its email), otherwise a fresh one.
 */
export function selectRegistration(
	store: ChatGptRegistrationStore,
	account?: string,
): ChatGptRegistration {
	if (account === undefined) {
		return { hostId: store.hostId };
	}
	const email = account.toLowerCase();
	const match = Object.entries(store.accounts).find(
		([subject, saved]) =>
			subject === account || saved.email?.toLowerCase() === email,
	);
	if (!match) {
		throw new Error(
			`No ChatGPT account ${account} is saved on this machine; run without --account to sign in with a new registration`,
		);
	}
	const [subject, saved] = match;
	return { hostId: store.hostId, clientId: saved.clientId, subject };
}

function randomToken(): string {
	return randomBytes(24).toString("base64url");
}

export function buildAuthorizeUrl(params: {
	clientId: string;
	hostId: string;
	redirectUri: string;
	state: string;
	nonce: string;
	codeChallenge: string;
}): string {
	const query = new URLSearchParams({
		client_id: params.clientId,
		ext_agent_host_id: params.hostId,
		response_type: "code",
		redirect_uri: params.redirectUri,
		scope: SCOPES,
		resource: RESOURCE,
		state: params.state,
		nonce: params.nonce,
		code_challenge: params.codeChallenge,
		code_challenge_method: "S256",
	});
	if (params.clientId === DYNAMIC_CLIENT_ID) {
		query.set("agent_name_hint", AGENT_NAME);
	}
	return `${AUTHORIZE_URL}?${query.toString()}`;
}

/**
 * The client id the sign-in ran under: the one issued in this callback on a
 * first sign-in, the saved one afterwards. A callback that names a different
 * client than the saved one is refused.
 */
export function issuedClientId(
	params: URLSearchParams,
	registration: ChatGptRegistration,
): string {
	const issued = params.get("client_id") ?? registration.clientId;
	if (!issued || issued === DYNAMIC_CLIENT_ID) {
		throw new Error(
			"OpenAI did not issue a client id for this machine; run the command again",
		);
	}
	if (registration.clientId && issued !== registration.clientId) {
		throw new Error(
			"The sign-in came back for a different client than this machine's; run again with --new-registration",
		);
	}
	return issued;
}

export interface ChatGptTokens {
	access_token: string;
	refresh_token?: string;
	id_token?: string;
	token_type: string;
	expires_in: number;
	scope?: string;
	earliest_refresh_at?: number | string;
}

async function exchangeCode(
	params: {
		clientId: string;
		code: string;
		codeVerifier: string;
		redirectUri: string;
	},
	fetchImpl: FetchLike = fetch,
): Promise<ChatGptTokens> {
	const response = await fetchImpl(TOKEN_URL, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			accept: "application/json",
		},
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: params.clientId,
			code: params.code,
			code_verifier: params.codeVerifier,
			redirect_uri: params.redirectUri,
			resource: RESOURCE,
		}).toString(),
		signal: AbortSignal.timeout(15_000),
	});
	const text = await response.text();
	if (!response.ok) {
		let code = `HTTP ${response.status}`;
		try {
			const parsed = JSON.parse(text) as { error?: unknown };
			if (typeof parsed.error === "string") {
				code = parsed.error;
			}
		} catch {}
		throw new Error(`OpenAI refused the sign-in code (${code})`);
	}
	return JSON.parse(text) as ChatGptTokens;
}

/**
 * The ID token's claims, after checking it was minted for this sign-in. The
 * signature, issuer and audience are verified by Fabric when the tokens are
 * uploaded; only this machine knows the nonce, so that check is made here.
 */
export function checkIdToken(
	idToken: string,
	expected: { nonce: string; subject?: string },
): { sub: string; email?: string } {
	const payload = idToken.split(".")[1];
	if (!payload) {
		throw new Error("OpenAI returned a malformed ID token");
	}
	const claims = JSON.parse(
		Buffer.from(payload, "base64url").toString("utf8"),
	) as { sub?: string; email?: string; nonce?: string };
	if (claims.nonce !== expected.nonce) {
		throw new Error("The ID token does not belong to this sign-in");
	}
	if (!claims.sub) {
		throw new Error("The ID token names no account");
	}
	if (expected.subject && claims.sub !== expected.subject) {
		throw new Error(
			"Signed in as a different ChatGPT account than this machine's; run again with --new-registration to switch",
		);
	}
	return { sub: claims.sub, email: claims.email };
}

const WORKSPACE_DENIED_ERROR = "3p_login_workspace_scope_denied";

/**
 * OpenAI refused the sign-in for its workspace, as it does a registration
 * made in another one. A plain `access_denied` is the person cancelling, and
 * is never retried.
 */
function isWorkspaceDenied(err: unknown): boolean {
	if (err instanceof CallbackError) {
		return (
			err.error === WORKSPACE_DENIED_ERROR ||
			/workspace/i.test(err.description ?? "")
		);
	}
	return err instanceof Error && err.message.includes(WORKSPACE_DENIED_ERROR);
}

function explainDenial(err: unknown): unknown {
	if (!isWorkspaceDenied(err)) {
		return err;
	}
	const description =
		err instanceof CallbackError && err.description
			? ` ${err.description}`
			: "";
	return new Error(
		`${(err as Error).message}${description} ChatGPT refused it for that workspace: run \`fabric connect chatgpt\` again without --account (the same as --new-registration) and choose your personal Plus or Pro workspace when ChatGPT asks which one to sign in to.`,
	);
}

export interface ChatGptSignInOptions {
	registration: ChatGptRegistration;
	open: (url: string) => void;
	fetchImpl?: FetchLike;
	preferredPort?: number;
	/** Keeps the registration once OpenAI confirmed it; omitted for a shared account. */
	save?: (
		account: {
			hostId: string;
			subject: string;
		} & ChatGptAccountRegistration,
	) => Promise<void>;
	/** Told when the saved registration was refused and a fresh one is tried. */
	onRetry?: () => void;
}

export interface ChatGptSignIn {
	tokens: ChatGptTokens;
	clientId: string;
	subject: string;
	email?: string;
}

async function attemptSignIn(
	registration: ChatGptRegistration,
	options: ChatGptSignInOptions,
): Promise<ChatGptSignIn> {
	const verifier = createCodeVerifier();
	const state = createState();
	const nonce = randomToken();
	const listener = await startLoopbackListener({
		state,
		callbackPath: CHATGPT_CALLBACK_PATH,
		preferredPort: options.preferredPort ?? CHATGPT_CALLBACK_PORT,
	});
	try {
		options.open(
			buildAuthorizeUrl({
				clientId: registration.clientId ?? DYNAMIC_CLIENT_ID,
				hostId: registration.hostId,
				redirectUri: listener.redirectUri,
				state,
				nonce,
				codeChallenge: codeChallengeS256(verifier),
			}),
		);
		const { code, params } = await listener.result;
		const clientId = issuedClientId(params, registration);
		const tokens = await exchangeCode(
			{
				clientId,
				code,
				codeVerifier: verifier,
				redirectUri: listener.redirectUri,
			},
			options.fetchImpl,
		);
		const { sub, email } = checkIdToken(tokens.id_token ?? "", {
			nonce,
			subject: registration.subject,
		});
		await options.save?.({
			hostId: registration.hostId,
			subject: sub,
			clientId,
			...(email !== undefined && { email }),
		});
		return { tokens, clientId, subject: sub, email };
	} finally {
		listener.close();
	}
}

/**
 * Signs in with ChatGPT. A saved registration OpenAI refuses is replaced by a
 * fresh one, once.
 */
export async function signInWithChatGpt(
	options: ChatGptSignInOptions,
): Promise<ChatGptSignIn> {
	const { registration } = options;
	try {
		return await attemptSignIn(registration, options);
	} catch (err: unknown) {
		if (!registration.clientId || !isWorkspaceDenied(err)) {
			throw explainDenial(err);
		}
	}
	options.onRetry?.();
	try {
		return await attemptSignIn({ hostId: registration.hostId }, options);
	} catch (err: unknown) {
		throw explainDenial(err);
	}
}

/** What Fabric's upload route stores; field names are its contract. */
export interface ChatGptPlanUpload {
	accessToken: string;
	refreshToken: string;
	idToken: string;
	tokenType: string;
	expiresIn: number;
	scopes: string[];
	clientId: string;
	hostId: string;
	earliestRefreshAt?: number | string;
}

export function buildUploadPayload(
	tokens: ChatGptTokens,
	registration: { clientId: string; hostId: string },
): ChatGptPlanUpload {
	if (!tokens.refresh_token || !tokens.id_token) {
		throw new Error("OpenAI's reply is missing the refresh or ID token");
	}
	const scopes = (tokens.scope ?? "").split(" ").filter(Boolean);
	if (!scopes.includes(CHATGPT_PLAN_SCOPE)) {
		throw new Error(
			"ChatGPT plan usage was not allowed at sign-in; nothing was sent to Fabric",
		);
	}
	return {
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		idToken: tokens.id_token,
		tokenType: tokens.token_type,
		expiresIn: tokens.expires_in,
		scopes,
		clientId: registration.clientId,
		hostId: registration.hostId,
		...(tokens.earliest_refresh_at !== undefined && {
			earliestRefreshAt: tokens.earliest_refresh_at,
		}),
	};
}

/** Where the person approves the connection with their Fabric web session. */
export const FABRIC_APPROVAL_CALLBACK_PATH = "/fabric/callback";

export function buildApprovalUrl(
	origin: string,
	params: {
		port: number;
		state: string;
		/** `--org <slug> --shared`: a shared account for that organization. */
		sharedOrganizationSlug?: string;
	},
): string {
	const query = new URLSearchParams({
		port: String(params.port),
		state: params.state,
		...(params.sharedOrganizationSlug !== undefined && {
			shared: "1",
			org: params.sharedOrganizationSlug,
		}),
	});
	return `${origin}/connect/chatgpt?${query.toString()}`;
}

export interface ChatGptPlanUploadResult {
	connected: true;
	email: string | null;
	organizations: Array<{
		slug: string | null;
		name: string;
		enabled: boolean;
	}>;
}

/** What Fabric answers for `--shared`: the organization the account now serves. */
export interface ChatGptPlanSharedUploadResult {
	connected: true;
	email: string | null;
	shared: {
		organization: { slug: string | null; name: string };
		/** False when the organization already had this account. */
		created: boolean;
	};
}

/**
 * Sends the sign-in to Fabric with the approval ticket. The ticket works
 * once and for ten minutes, so a refusal tells the person to start again.
 */
export async function uploadChatGptPlan(
	params: { origin: string; ticket: string; payload: ChatGptPlanUpload },
	fetchImpl: FetchLike = fetch,
): Promise<ChatGptPlanUploadResult | ChatGptPlanSharedUploadResult> {
	const response = await fetchImpl(
		`${params.origin}/api/connect/chatgpt/credentials`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${params.ticket}`,
			},
			body: JSON.stringify(params.payload),
			signal: AbortSignal.timeout(30_000),
		},
	);
	const body = (await response.json().catch(() => ({}))) as {
		error?: string;
	} & Partial<ChatGptPlanUploadResult & ChatGptPlanSharedUploadResult>;
	if (!response.ok) {
		throw new Error(
			body.error ??
				`Fabric refused the ChatGPT plan sign-in (HTTP ${response.status})`,
		);
	}
	return body as ChatGptPlanUploadResult | ChatGptPlanSharedUploadResult;
}
