/**
 * One process that writes the CLI's configuration, for the tests of what two
 * processes writing it at once do to each other. Run by `config-lock.test.ts`
 * with `node --import tsx`, in a config folder the test names through
 * `XDG_CONFIG_HOME` and `APPDATA`.
 *
 *   rotate <count>        a renewal: reads the deployment's sign-in, waits as a
 *                         renewal does for the server, and saves it with a new
 *                         refresh token each time
 *   churn <tag> <count>   a login and a logout: saves a project's sign-in, then
 *                         removes the last one's, so only the last remains
 *   context <count>       `fabric ctx`: saves the default context
 */
import {
	clearProjectSignIn,
	getOAuth,
	type OAuthCredentials,
	saveDefaultContext,
	saveOAuth,
} from "../../src/lib/config.js";

const ORIGIN = "https://deploy.example.com";

function session(label: string): OAuthCredentials {
	return {
		issuer: ORIGIN,
		clientId: "client-example",
		redirectUri: "http://127.0.0.1:49152/callback",
		tokenEndpoint: `${ORIGIN}/api/auth/oauth2/token`,
		accessToken: `fat_${label}`,
		refreshToken: `frt_${label}`,
		expiresAt: 1_900_000_000_000,
	};
}

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(role: string, first: string, second: string) {
	if (role === "rotate") {
		const count = Number(first);
		for (let index = 1; index <= count; index++) {
			const current = getOAuth(ORIGIN);
			if (current === undefined) {
				throw new Error("the deployment's sign-in is gone");
			}
			// The server takes a moment, and anything may be written meanwhile.
			await pause(2);
			saveOAuth(
				{ ...current, refreshToken: `frt_rotated_${index}` },
				{ origin: ORIGIN },
			);
		}
	} else if (role === "churn") {
		const count = Number(second);
		for (let index = 1; index <= count; index++) {
			saveOAuth(session(`${first}-${index}`), {
				origin: ORIGIN,
				projectId: `${first}-${index}`,
			});
			if (index > 1) {
				clearProjectSignIn(`${first}-${index - 1}`, ORIGIN);
			}
		}
	} else if (role === "context") {
		const count = Number(first);
		for (let index = 1; index <= count; index++) {
			saveDefaultContext({ type: "org", slug: `org-${index}` }, ORIGIN);
		}
	} else {
		throw new Error(`unknown role ${role}`);
	}
}

const [role = "", first = "", second = ""] = process.argv.slice(2);
main(role, first, second).catch((error: unknown) => {
	process.stderr.write(`${String(error)}\n`);
	process.exit(1);
});
