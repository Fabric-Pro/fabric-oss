/**
 * `fabric auth login` without a key: the OAuth 2.1 authorization code flow with
 * PKCE S256 against the deployment's own authorization server.
 *
 * The CLI registers a public client once (RFC 7591) and keeps its id in the
 * profile. A later login on the same deployment reuses it: the server accepts
 * any port on a registered `127.0.0.1` redirect (RFC 8252 section 7.3), so the
 * new ephemeral port does not need a new registration, and the person keeps one
 * "Fabric CLI" under Connected agents instead of one per login. Before the
 * browser opens, the authorization request is checked once; a client the
 * server no longer knows is replaced by a fresh registration rather than
 * sending the person to an error page.
 */

import type { OAuthCredentials } from "../config.js";
import {
	type AuthorizationServerMetadata,
	discoverAuthorizationServer,
} from "./discovery.js";
import { startLoopbackListener } from "./loopback.js";
import { codeChallengeS256, createCodeVerifier, createState } from "./pkce.js";
import { projectResource } from "./project-resource.js";

/** What a person is asked to approve. Matches the server's scope ceiling. */
export const REQUESTED_SCOPES = [
	"mcp:read",
	"instructions:read",
	"instructions:write",
	"offline_access",
] as const;

const CLIENT_NAME = "Fabric CLI";

export type FetchLike = (
	input: string,
	init?: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
		signal?: AbortSignal;
	},
) => Promise<Response>;

/** The registration a previous login left in the profile. */
type PreviousClient = Pick<
	OAuthCredentials,
	"clientId" | "redirectUri" | "tokenEndpoint"
>;

/**
 * Authorization errors that mean the client itself is unusable, as the server
 * reports them before it asks anyone to sign in.
 */
const UNUSABLE_CLIENT_ERRORS = new Set([
	"invalid_client",
	"client_disabled",
	"invalid_redirect",
	"unauthorized_client",
]);

export interface LoginOptions {
	baseUrl: string;
	/**
	 * Sign in for this one project: the authorization asks for the project's
	 * resource, and the tokens that come back reach that project and nothing
	 * organization-wide. Without it the sign-in is for an organization.
	 */
	project?: string;
	/** Reused when it was registered with this deployment. */
	previous?: PreviousClient;
	fetch?: FetchLike;
	/** Show the person where to go. Called once, before the browser opens. */
	announce: (authorizationUrl: string) => void;
	/** Open the URL. May throw or do nothing; the announced URL is the fallback. */
	openBrowser: (url: string) => void | Promise<void>;
	signal?: AbortSignal;
	timeoutMs?: number;
	now?: () => number;
}

class OAuthLoginError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OAuthLoginError";
	}
}

function trimBase(baseUrl: string): string {
	return new URL(baseUrl).origin;
}

/** What the sign-in asks the deployment to issue its tokens for. */
function apiResource(baseUrl: string, project: string | undefined): string {
	return project === undefined
		? `${trimBase(baseUrl)}/api/v1`
		: projectResource(trimBase(baseUrl), "api", project);
}

/** A field of a JSON body, when the body is an object and the field is one. */
function fieldOf(body: unknown, key: string): unknown {
	return typeof body === "object" && body !== null && key in body
		? Reflect.get(body, key)
		: undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

async function readError(response: Response): Promise<string> {
	const body: unknown = await response.json().catch(() => null);
	const description =
		nonEmptyString(fieldOf(body, "error_description")) ??
		nonEmptyString(fieldOf(body, "message")) ??
		nonEmptyString(fieldOf(body, "error"));
	if (description) {
		return forTerminal(description);
	}
	return `HTTP ${response.status}`;
}

/** Drop the control characters a server could embed to rewrite the terminal. */
function forTerminal(text: string): string {
	let printable = "";
	for (const character of text.slice(0, 200)) {
		const code = character.charCodeAt(0);
		printable += code < 0x20 || code === 0x7f ? " " : character;
	}
	return printable;
}

async function registerClient(
	fetchImpl: FetchLike,
	metadata: AuthorizationServerMetadata,
	redirectUri: string,
	signal: AbortSignal | undefined,
): Promise<string> {
	const response = await fetchImpl(metadata.registration_endpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({
			client_name: CLIENT_NAME,
			redirect_uris: [redirectUri],
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			scope: REQUESTED_SCOPES.join(" "),
			type: "native",
		}),
		signal,
	});
	if (!response.ok) {
		throw new OAuthLoginError(
			`Could not register this CLI with the deployment: ${await readError(response)}`,
		);
	}
	const body: unknown = await response.json().catch(() => null);
	const clientId = nonEmptyString(fieldOf(body, "client_id"));
	if (!clientId) {
		throw new OAuthLoginError("The deployment did not return a client id.");
	}
	return clientId;
}

/** Same loopback host and path; the port may differ (RFC 8252 section 7.3). */
function sameLoopbackRedirect(registered: string, current: string): boolean {
	try {
		const a = new URL(registered);
		const b = new URL(current);
		return (
			a.protocol === b.protocol &&
			a.hostname === b.hostname &&
			a.pathname === b.pathname &&
			a.search === b.search
		);
	} catch {
		return false;
	}
}

/**
 * Ask the authorization endpoint, as a JSON client, where it would send the
 * browser. An unusable client is refused before anyone is asked to sign in, and
 * the refusal names it in the redirect's `error`. Anything else — including a
 * request the probe cannot read — is left for the browser to show.
 */
async function clientIsUnusable(
	fetchImpl: FetchLike,
	authorizationUrl: string,
	signal: AbortSignal | undefined,
): Promise<boolean> {
	let response: Response;
	try {
		response = await fetchImpl(authorizationUrl, {
			headers: { Accept: "application/json" },
			signal,
		});
	} catch {
		return false;
	}
	const target = nonEmptyString(
		fieldOf(await response.json().catch(() => null), "url"),
	);
	if (!target) {
		return false;
	}
	try {
		const error = new URL(target, authorizationUrl).searchParams.get(
			"error",
		);
		return error !== null && UNUSABLE_CLIENT_ERRORS.has(error);
	} catch {
		return false;
	}
}

export interface TokenResponse {
	accessToken: string;
	refreshToken?: string;
	expiresAt: number;
}

export function parseTokenResponse(body: unknown, now: number): TokenResponse {
	const accessToken = nonEmptyString(fieldOf(body, "access_token"));
	const expiresIn = fieldOf(body, "expires_in");
	if (!accessToken || typeof expiresIn !== "number") {
		throw new OAuthLoginError(
			"The deployment returned an unreadable token.",
		);
	}
	return {
		accessToken,
		refreshToken: nonEmptyString(fieldOf(body, "refresh_token")),
		expiresAt: now + expiresIn * 1000,
	};
}

export async function postTokenRequest(
	fetchImpl: FetchLike,
	endpoint: string,
	form: Record<string, string>,
	signal?: AbortSignal,
): Promise<Response> {
	return fetchImpl(endpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: new URLSearchParams(form).toString(),
		signal,
	});
}

export async function loginWithBrowser(
	options: LoginOptions,
): Promise<OAuthCredentials> {
	const fetchImpl: FetchLike =
		options.fetch ?? ((input, init) => fetch(input, init));
	const now = options.now ?? Date.now;

	const metadata = await discoverAuthorizationServer(options.baseUrl, {
		fetch: fetchImpl,
		signal: options.signal,
	});

	const state = createState();
	const verifier = createCodeVerifier();
	const listener = await startLoopbackListener({
		state,
		timeoutMs: options.timeoutMs,
		signal: options.signal,
	});

	const authorizationUrl = (clientId: string): string => {
		const url = new URL(metadata.authorization_endpoint);
		url.search = new URLSearchParams({
			response_type: "code",
			client_id: clientId,
			redirect_uri: listener.redirectUri,
			scope: REQUESTED_SCOPES.join(" "),
			state,
			code_challenge: codeChallengeS256(verifier),
			code_challenge_method: "S256",
			resource: apiResource(options.baseUrl, options.project),
		}).toString();
		return url.toString();
	};

	try {
		const previous = options.previous;
		const reusable =
			previous !== undefined &&
			previous.tokenEndpoint === metadata.token_endpoint &&
			sameLoopbackRedirect(previous.redirectUri, listener.redirectUri);

		let clientId: string;
		let registeredRedirectUri: string;
		if (
			reusable &&
			!(await clientIsUnusable(
				fetchImpl,
				authorizationUrl(previous.clientId),
				options.signal,
			))
		) {
			clientId = previous.clientId;
			registeredRedirectUri = previous.redirectUri;
		} else {
			clientId = await registerClient(
				fetchImpl,
				metadata,
				listener.redirectUri,
				options.signal,
			);
			registeredRedirectUri = listener.redirectUri;
		}

		const authorization = authorizationUrl(clientId);
		options.announce(authorization);
		try {
			await options.openBrowser(authorization);
		} catch {
			// The announced URL is the fallback.
		}

		const { code } = await listener.result;

		const response = await postTokenRequest(
			fetchImpl,
			metadata.token_endpoint,
			{
				grant_type: "authorization_code",
				code,
				redirect_uri: listener.redirectUri,
				client_id: clientId,
				code_verifier: verifier,
				resource: apiResource(options.baseUrl, options.project),
			},
			options.signal,
		);
		if (!response.ok) {
			throw new OAuthLoginError(
				`The deployment refused the sign-in: ${await readError(response)}`,
			);
		}

		const tokens = parseTokenResponse(
			await response.json().catch(() => null),
			now(),
		);
		return {
			issuer: metadata.issuer,
			clientId,
			redirectUri: registeredRedirectUri,
			tokenEndpoint: metadata.token_endpoint,
			revocationEndpoint: metadata.revocation_endpoint,
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken,
			expiresAt: tokens.expiresAt,
		};
	} finally {
		listener.close();
	}
}
