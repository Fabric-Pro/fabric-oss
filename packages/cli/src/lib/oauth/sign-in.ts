/**
 * Signing in through the browser, as one step a command can run: discover the
 * deployment's authorization server, take the person through it, check the
 * tokens work, and keep them under the deployment they were issued by.
 *
 * It throws instead of exiting, so `fabric auth login` can turn a failure
 * into its own message and `fabric instructions init` can sign in inline, in
 * the middle of setting a checkout up. Nothing here ever runs under a session
 * hook: the loopback listener `loginWithBrowser` starts is a person's
 * business, and a hook must never open a port or a browser.
 */

import { FabricClient } from "@fabricorg/sdk";
import {
	getOAuth,
	getRegisteredClient,
	type OAuthCredentials,
	saveOAuth,
} from "../config.js";
import { openBrowser } from "./browser.js";
import { loginWithBrowser } from "./flow.js";
import { revokeOAuthSession } from "./session.js";

/**
 * A sign-in that was not kept: the deployment would not accept the tokens it
 * had just issued, or the tokens came from a sign-in server that is not part
 * of the deployment they were requested for. The sentence is fixed and names
 * only the deployment the person asked for.
 */
class SignInRefusedError extends Error {
	constructor(
		readonly origin: string,
		readonly reason: "rejected" | "issued-elsewhere",
	) {
		super(
			reason === "rejected"
				? `Signed in, but ${origin} did not accept the new credentials.`
				: `The sign-in for ${origin} was issued by another site, so nothing was kept.`,
		);
		this.name = "SignInRefusedError";
	}
}

/** Whether `issuer` is a sign-in server of the deployment at `origin`. */
function isIssuedBy(issuer: string, origin: string): boolean {
	try {
		return new URL(issuer).origin === origin;
	} catch {
		return false;
	}
}

export interface SignInResult {
	name: string;
	email: string;
}

export async function signInWithBrowser(input: {
	/** The deployment, as the person gave it. */
	baseUrl: string;
	/** Its origin: the profile the sign-in is kept under. */
	origin: string;
	/**
	 * Whether the deployment was explicitly chosen (`--base-url`), which keeps
	 * the spelling and makes it the one commands use from now on.
	 */
	explicit: boolean;
	/** Show the person where to go, once, before the browser opens. */
	announce: (authorizationUrl: string) => void;
	/** Ends the whole sign-in, whatever step it is on, when it aborts. */
	signal?: AbortSignal;
	/**
	 * Sign in for this one project, and keep the tokens as that project's. The
	 * deployment's own sign-in and every other project's are left as they are,
	 * and only this project's previous sign-in is revoked.
	 */
	project?: string;
	/** Explicit capability scopes for this interactive sign-in. */
	scopes?: readonly string[];
}): Promise<SignInResult> {
	const previous = getOAuth(input.origin, input.project);
	const credentials: OAuthCredentials = await loginWithBrowser({
		baseUrl: input.baseUrl,
		project: input.project,
		previous: getRegisteredClient(input.origin, input.project),
		openBrowser,
		announce: input.announce,
		signal: input.signal,
		...(input.scopes === undefined ? {} : { scopes: input.scopes }),
	});

	// Before the token is stored or used: it was requested for this
	// deployment, so the server that granted it must be this deployment's.
	if (!isIssuedBy(credentials.issuer, input.origin)) {
		throw new SignInRefusedError(input.origin, "issued-elsewhere");
	}

	// Verify with the tokens in hand before saving anything: a sign-in the
	// server then refuses should not replace a working profile.
	const client = new FabricClient({
		apiKey: credentials.accessToken,
		baseUrl: input.baseUrl,
	});
	let me: Awaited<ReturnType<typeof client.auth.whoami>>;
	let identity: SignInResult;
	try {
		me = await client.auth.whoami();
		identity = {
			name: me.user.name ?? me.user.email,
			email: me.user.email,
		};
	} catch {
		throw new SignInRefusedError(input.origin, "rejected");
	}
	// A project's sign-in is kept as that project's only if the deployment says
	// it reaches that project: anything else is not what was asked for. A server
	// that ignored the project and granted a sign-in that reaches every project
	// has still granted it, so it is ended before the person is told it was not
	// kept. Best effort, like every revocation here.
	if (input.project !== undefined && me.projectContext !== input.project) {
		await revokeOAuthSession(credentials);
		throw new SignInRefusedError(input.origin, "rejected");
	}
	if (input.scopes?.some((scope) => !me.scopes.includes(scope))) {
		await revokeOAuthSession(credentials);
		throw new SignInRefusedError(input.origin, "rejected");
	}

	saveOAuth(credentials, {
		...(input.explicit
			? { baseUrl: input.baseUrl }
			: { origin: input.origin }),
		...(input.project === undefined ? {} : { projectId: input.project }),
	});
	// The sign-in this replaced would otherwise stay valid at the server for
	// the rest of its refresh token's life, held by nobody. Best effort: the
	// new sign-in is already saved either way.
	if (previous && previous.refreshToken !== credentials.refreshToken) {
		await revokeOAuthSession(previous);
	}
	return identity;
}
