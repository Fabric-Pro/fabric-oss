import { access, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthCredentials } from "../src/lib/config.js";
import {
	createOAuthFetch,
	LOCK_STALE_MS,
	OAuthRefreshBusyError,
	OAuthSessionExpiredError,
	REFRESH_WINDOW_MS,
	refreshAccessToken,
	revokeOAuthSession,
	withRefreshLock,
} from "../src/lib/oauth/session.js";

/**
 * The profile is an in-memory stand-in here: what is under test is the refresh
 * protocol — one process spends a rotating refresh token, everyone else reads
 * the result — not the file the real config writes.
 */
const { profile } = vi.hoisted(() => ({
	profile: { oauth: undefined as OAuthCredentials | undefined, path: "" },
}));

vi.mock("../src/lib/config.js", () => ({
	getOAuth: () => profile.oauth,
	saveOAuth: (oauth: OAuthCredentials) => {
		profile.oauth = oauth;
	},
	getConfigPath: () => profile.path,
}));

const NOW = 1_000_000_000;

function credentials(
	overrides: Partial<OAuthCredentials> = {},
): OAuthCredentials {
	return {
		clientId: "client-example",
		redirectUri: "http://127.0.0.1:49152/callback",
		tokenEndpoint: "https://deployment.example/api/auth/oauth2/token",
		revocationEndpoint: "https://deployment.example/api/auth/oauth2/revoke",
		accessToken: "fat_old",
		refreshToken: "frt_1",
		expiresAt: NOW + 10 * 60 * 1000,
		...overrides,
	};
}

/**
 * A token endpoint with the real server's rotation rule: a refresh token works
 * once, and presenting a spent one is a refusal that ends the family.
 */
function rotatingTokenEndpoint() {
	const spent = new Set<string>();
	let issued = 1;
	let familyRevoked = false;
	const calls: string[] = [];

	const fetchImpl = vi.fn(async (_url: string, init?: { body?: string }) => {
		const form = new URLSearchParams(init?.body ?? "");
		const presented = form.get("refresh_token") ?? "";
		calls.push(presented);
		await new Promise((resolve) => setTimeout(resolve, 20));

		if (
			familyRevoked ||
			spent.has(presented) ||
			presented !== `frt_${issued}`
		) {
			familyRevoked = true;
			return new Response(JSON.stringify({ error: "invalid_grant" }), {
				status: 400,
			});
		}
		spent.add(presented);
		issued += 1;
		return new Response(
			JSON.stringify({
				access_token: `fat_${issued}`,
				refresh_token: `frt_${issued}`,
				token_type: "Bearer",
				expires_in: 3600,
			}),
			{ status: 200 },
		);
	});

	return { fetchImpl, calls, isRevoked: () => familyRevoked };
}

let lockPath: string;

beforeEach(async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "fabric-oauth-"));
	profile.path = path.join(directory, "config.json");
	lockPath = `${profile.path}.refresh.lock`;
	profile.oauth = credentials();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("refreshing a browser sign-in", () => {
	it("never spends one refresh token twice when two processes refresh together", async () => {
		profile.oauth = credentials({ expiresAt: NOW + 5_000 });
		const endpoint = rotatingTokenEndpoint();
		const deps = { fetch: endpoint.fetchImpl, now: () => NOW, lockPath };
		const stale = (current: OAuthCredentials) =>
			current.expiresAt - NOW <= REFRESH_WINDOW_MS;

		const [first, second] = await Promise.all([
			refreshAccessToken(stale, deps),
			refreshAccessToken(stale, deps),
		]);

		expect(endpoint.calls).toEqual(["frt_1"]);
		expect(endpoint.isRevoked()).toBe(false);
		expect(first).toBe("fat_2");
		expect(second).toBe("fat_2");
		expect(profile.oauth?.refreshToken).toBe("frt_2");
	});

	it("proves the protocol is what prevents the reuse: refreshing without the lock burns the family", async () => {
		profile.oauth = credentials({ expiresAt: NOW + 5_000 });
		const endpoint = rotatingTokenEndpoint();
		const snapshot = { ...profile.oauth };

		// Two processes that both read the profile before either refreshed.
		const bareRefresh = () =>
			endpoint.fetchImpl("https://deployment.example/token", {
				body: new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: snapshot.refreshToken ?? "",
				}).toString(),
			});
		const [a, b] = await Promise.all([bareRefresh(), bareRefresh()]);

		expect([a.status, b.status].sort()).toEqual([200, 400]);
		expect(endpoint.isRevoked()).toBe(true);
	});

	it("reports an expired sign-in when the server refuses the refresh token", async () => {
		profile.oauth = credentials({ expiresAt: NOW + 5_000 });
		const refused = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: "invalid_grant" }), {
					status: 400,
				}),
		);

		await expect(
			refreshAccessToken(() => true, {
				fetch: refused,
				now: () => NOW,
				lockPath,
			}),
		).rejects.toBeInstanceOf(OAuthSessionExpiredError);
	});

	it("removes a lock left behind by a process that died", async () => {
		await writeFile(lockPath, "99999");
		const old = new Date(Date.now() - LOCK_STALE_MS - 5_000);
		await utimes(lockPath, old, old);

		await expect(
			withRefreshLock(async () => "ran", { lockPath }),
		).resolves.toBe("ran");
	});

	it("releases the lock when the work throws", async () => {
		await expect(
			withRefreshLock(
				async () => {
					throw new Error("boom");
				},
				{ lockPath },
			),
		).rejects.toThrow("boom");

		await expect(
			withRefreshLock(async () => "again", { lockPath }),
		).resolves.toBe("again");
	});

	it("never refreshes without the lock: a waiter that cannot take it gives up", async () => {
		// A live holder: the lock file is fresh, so it is not stale.
		await writeFile(lockPath, "12345");
		const work = vi.fn(async () => "ran");

		await expect(
			withRefreshLock(work, { lockPath, waitMs: 250 }),
		).rejects.toBeInstanceOf(OAuthRefreshBusyError);
		expect(work).not.toHaveBeenCalled();
		// The holder's lock is left alone.
		await expect(access(lockPath)).resolves.toBeUndefined();
	});

	it("stops waiting for the lock when the caller's deadline passes", async () => {
		await writeFile(lockPath, "12345");
		const work = vi.fn(async () => "ran");

		await expect(
			withRefreshLock(work, {
				lockPath,
				signal: AbortSignal.timeout(150),
			}),
		).rejects.toMatchObject({ name: "TimeoutError" });
		expect(work).not.toHaveBeenCalled();
	});
});

describe("the signed fetch", () => {
	function stubApi(statuses: number[]) {
		const seen: string[] = [];
		const api = vi.fn(async (_input: unknown, init?: RequestInit) => {
			seen.push(new Headers(init?.headers).get("Authorization") ?? "");
			return new Response("{}", { status: statuses.shift() ?? 200 });
		});
		vi.stubGlobal("fetch", api);
		return { api, seen };
	}

	it("sends the stored token without refreshing while it has time left", async () => {
		const { seen } = stubApi([200]);
		const endpoint = rotatingTokenEndpoint();

		const response = await createOAuthFetch({
			fetch: endpoint.fetchImpl,
			now: () => NOW,
			lockPath,
		})("https://deployment.example/api/v1/auth/whoami", { method: "GET" });

		expect(response.status).toBe(200);
		expect(seen).toEqual(["Bearer fat_old"]);
		expect(endpoint.calls).toEqual([]);
	});

	it("refreshes first when the token expires within the window", async () => {
		profile.oauth = credentials({ expiresAt: NOW + REFRESH_WINDOW_MS - 1 });
		const { seen } = stubApi([200]);
		const endpoint = rotatingTokenEndpoint();

		await createOAuthFetch({
			fetch: endpoint.fetchImpl,
			now: () => NOW,
			lockPath,
		})("https://deployment.example/api/v1/auth/whoami");

		expect(endpoint.calls).toEqual(["frt_1"]);
		expect(seen).toEqual(["Bearer fat_2"]);
	});

	it("refreshes once and retries when the server answers 401", async () => {
		const { seen } = stubApi([401, 200]);
		const endpoint = rotatingTokenEndpoint();

		const response = await createOAuthFetch({
			fetch: endpoint.fetchImpl,
			now: () => NOW,
			lockPath,
		})("https://deployment.example/api/v1/auth/whoami", {
			method: "POST",
			body: JSON.stringify({ a: 1 }),
		});

		expect(response.status).toBe(200);
		expect(seen).toEqual(["Bearer fat_old", "Bearer fat_2"]);
		expect(endpoint.calls).toEqual(["frt_1"]);
	});

	it("hands back the 401 when the sign-in cannot be renewed", async () => {
		stubApi([401]);
		const refused = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: "invalid_grant" }), {
					status: 400,
				}),
		);

		const response = await createOAuthFetch({
			fetch: refused,
			now: () => NOW,
			lockPath,
		})("https://deployment.example/api/v1/auth/whoami");

		expect(response.status).toBe(401);
	});

	it("does not replay a request whose body cannot be sent twice", async () => {
		const { api } = stubApi([401]);
		const endpoint = rotatingTokenEndpoint();

		const response = await createOAuthFetch({
			fetch: endpoint.fetchImpl,
			now: () => NOW,
			lockPath,
		})("https://deployment.example/api/v1/upload", {
			method: "POST",
			body: new Uint8Array([1, 2, 3]),
		});

		expect(response.status).toBe(401);
		expect(api).toHaveBeenCalledTimes(1);
		expect(endpoint.calls).toEqual([]);
	});
});

describe("signing out", () => {
	/**
	 * The real server deletes the access tokens issued under a refresh token
	 * when it revokes that refresh token, and then answers 400 for the access
	 * token (observed against the dev server). Naming both made every logout
	 * report a failure it had not had.
	 */
	function revocationServer() {
		const live = new Set(["frt_1", "fat_old"]);
		const requests: URLSearchParams[] = [];
		const fetchImpl = vi.fn(
			async (_url: string, init?: { body?: string }) => {
				const form = new URLSearchParams(init?.body ?? "");
				requests.push(form);
				const token = form.get("token") ?? "";
				if (!live.has(token)) {
					return new Response(
						JSON.stringify({ error: "invalid_request" }),
						{ status: 400 },
					);
				}
				live.delete(token);
				if (token === "frt_1") {
					live.delete("fat_old");
				}
				return new Response(null, { status: 200 });
			},
		);
		return { fetchImpl, requests, live };
	}

	it("revokes the refresh token, which ends the access token with it, and reports success", async () => {
		const server = revocationServer();

		const revoked = await revokeOAuthSession(
			credentials(),
			server.fetchImpl,
		);

		expect(revoked).toBe(true);
		expect(server.requests.map((form) => form.get("token"))).toEqual([
			"frt_1",
		]);
		expect(server.live.size).toBe(0);
	});

	it("revokes the access token when there is no refresh token", async () => {
		const server = revocationServer();

		const revoked = await revokeOAuthSession(
			credentials({ refreshToken: undefined }),
			server.fetchImpl,
		);

		expect(revoked).toBe(true);
		expect(
			server.requests.map((form) => form.get("token_type_hint")),
		).toEqual(["access_token"]);
	});

	it("reports failure when the server cannot be reached", async () => {
		const offline = vi.fn(async () => {
			throw new Error("offline");
		});

		await expect(revokeOAuthSession(credentials(), offline)).resolves.toBe(
			false,
		);
	});
});
