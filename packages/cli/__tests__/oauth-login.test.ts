import { createHash } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	authorizationServerMetadataUrl,
	discoverAuthorizationServer,
	OAuthDiscoveryError,
} from "../src/lib/oauth/discovery.js";
import { loginWithBrowser, REQUESTED_SCOPES } from "../src/lib/oauth/flow.js";
import { LOGIN_TIMEOUT_MS } from "../src/lib/oauth/loopback.js";

/**
 * A stand-in authorization server that enforces what the real one does for
 * this client: the registration must be a public native client, the code is
 * bound to the PKCE challenge it was issued against, and the token request
 * must repeat the same redirect URI.
 */
interface FakeServer {
	origin: string;
	registrations: Array<Record<string, unknown>>;
	tokenRequests: Array<Record<string, string>>;
	authorizations: Array<URLSearchParams>;
	codes: Map<string, { challenge: string; redirectUri: string }>;
	/** Client ids the server knows; registration adds to it. */
	knownClients: Set<string>;
	/** Client ids the authorization endpoint was asked about by a JSON probe. */
	probes: string[];
	issuerOverride?: string;
	tokenEndpointOverride?: string;
	close: () => Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => resolve(body));
	});
}

function json(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "Content-Type": "application/json" });
	response.end(JSON.stringify(body));
}

async function startFakeServer(): Promise<FakeServer> {
	const registrations: Array<Record<string, unknown>> = [];
	const tokenRequests: Array<Record<string, string>> = [];
	const authorizations: Array<URLSearchParams> = [];
	const codes: FakeServer["codes"] = new Map();
	const knownClients = new Set<string>();
	const probes: string[] = [];
	let origin = "";
	const fake: FakeServer = {
		origin,
		registrations,
		tokenRequests,
		authorizations,
		codes,
		knownClients,
		probes,
		close: async () => {},
	};

	const server: Server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", origin);

		if (
			url.pathname ===
			"/.well-known/oauth-protected-resource/api/mcp-gateway"
		) {
			return json(response, 200, {
				resource: `${origin}/api/mcp-gateway`,
				authorization_servers: [`${origin}/api/auth`],
			});
		}
		if (
			url.pathname === "/.well-known/oauth-authorization-server/api/auth"
		) {
			return json(response, 200, {
				issuer: fake.issuerOverride ?? `${origin}/api/auth`,
				authorization_endpoint: `${origin}/api/auth/oauth2/authorize`,
				token_endpoint:
					fake.tokenEndpointOverride ??
					`${origin}/api/auth/oauth2/token`,
				registration_endpoint: `${origin}/api/auth/oauth2/register`,
				revocation_endpoint: `${origin}/api/auth/oauth2/revoke`,
			});
		}
		if (url.pathname === "/api/auth/oauth2/register") {
			const body = JSON.parse(await readBody(request));
			registrations.push(body);
			knownClients.add("client-example");
			return json(response, 201, { client_id: "client-example" });
		}
		if (url.pathname === "/api/auth/oauth2/authorize") {
			// The real server answers a JSON client with where it would send
			// the browser: the error page for a client it does not know, the
			// login page otherwise.
			const clientId = url.searchParams.get("client_id") ?? "";
			probes.push(clientId);
			return json(response, 200, {
				redirect: true,
				url: knownClients.has(clientId)
					? `${origin}/auth/login?client_id=${clientId}`
					: `${origin}/api/auth/error?error=invalid_client`,
			});
		}
		if (url.pathname === "/api/auth/oauth2/token") {
			const form = Object.fromEntries(
				new URLSearchParams(await readBody(request)),
			);
			tokenRequests.push(form);
			const issued = codes.get(form.code ?? "");
			const verified =
				issued !== undefined &&
				createHash("sha256")
					.update(form.code_verifier ?? "")
					.digest("base64url") === issued.challenge &&
				form.redirect_uri === issued.redirectUri;
			if (!verified) {
				return json(response, 400, {
					error: "invalid_grant",
					error_description: "code verification failed",
				});
			}
			return json(response, 200, {
				access_token: "fat_access",
				refresh_token: "frt_refresh",
				token_type: "Bearer",
				expires_in: 3600,
			});
		}
		response.writeHead(404).end();
	});

	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", () => resolve()),
	);
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	fake.origin = origin;
	fake.close = () =>
		new Promise<void>((resolve) => {
			server.closeAllConnections();
			server.close(() => resolve());
		});
	return fake;
}

let fake: FakeServer;

beforeEach(async () => {
	fake = await startFakeServer();
});

afterEach(async () => {
	await fake.close();
});

/**
 * The "browser": reads the authorization request the CLI announced and answers
 * it the way the real server's redirect would.
 */
function browserThatApproves(
	server: FakeServer,
	{ code = "code-example", extraStateFirst = false } = {},
) {
	return async (authorizationUrl: string) => {
		const request = new URL(authorizationUrl);
		server.authorizations.push(request.searchParams);
		const redirectUri = request.searchParams.get("redirect_uri") as string;
		server.codes.set(code, {
			challenge: request.searchParams.get("code_challenge") as string,
			redirectUri,
		});

		if (extraStateFirst) {
			const stray = await fetch(
				`${redirectUri}?code=stolen&state=not-the-state`,
			);
			expect(stray.status).toBe(400);
		}
		await fetch(
			`${redirectUri}?code=${code}&state=${request.searchParams.get("state")}`,
		);
	};
}

describe("fabric auth login in the browser", () => {
	it("registers a public native client, binds the code to PKCE and returns the tokens", async () => {
		const announced: string[] = [];

		const credentials = await loginWithBrowser({
			baseUrl: fake.origin,
			announce: (url) => announced.push(url),
			openBrowser: browserThatApproves(fake),
			now: () => 1_000_000,
		});

		expect(fake.registrations).toHaveLength(1);
		expect(fake.registrations[0]).toMatchObject({
			client_name: "Fabric CLI",
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code", "refresh_token"],
			scope: REQUESTED_SCOPES.join(" "),
		});
		expect(fake.registrations[0]?.redirect_uris).toEqual([
			expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/),
		]);

		const authorization = fake.authorizations[0];
		expect(authorization?.get("code_challenge_method")).toBe("S256");
		expect(authorization?.get("resource")).toBe(`${fake.origin}/api/v1`);
		expect(announced).toHaveLength(1);

		expect(fake.tokenRequests[0]).toMatchObject({
			grant_type: "authorization_code",
			client_id: "client-example",
			resource: `${fake.origin}/api/v1`,
		});
		expect(credentials).toMatchObject({
			clientId: "client-example",
			accessToken: "fat_access",
			refreshToken: "frt_refresh",
			expiresAt: 1_000_000 + 3600 * 1000,
			tokenEndpoint: `${fake.origin}/api/auth/oauth2/token`,
		});
	});

	it("asks for the project's own resource, at the authorization and at the token, when it signs in for one project", async () => {
		await loginWithBrowser({
			baseUrl: fake.origin,
			project: "project-example-one",
			announce: () => {},
			openBrowser: browserThatApproves(fake),
		});

		const resource = `${fake.origin}/api/v1/projects/project-example-one`;
		expect(fake.authorizations[0]?.get("resource")).toBe(resource);
		expect(fake.tokenRequests[0]?.resource).toBe(resource);
	});

	it("probes a client it reuses with the same project resource it will ask for", async () => {
		fake.knownClients.add("client-reused");

		await loginWithBrowser({
			baseUrl: fake.origin,
			project: "project-example-one",
			previous: {
				clientId: "client-reused",
				redirectUri: "http://127.0.0.1:1/callback",
				tokenEndpoint: `${fake.origin}/api/auth/oauth2/token`,
			},
			announce: () => {},
			openBrowser: browserThatApproves(fake),
		});

		expect(fake.probes).toEqual(["client-reused"]);
		expect(fake.registrations).toHaveLength(0);
		expect(fake.authorizations[0]?.get("resource")).toBe(
			`${fake.origin}/api/v1/projects/project-example-one`,
		);
	});

	it("ignores a callback whose state is not the one it started and still completes", async () => {
		const credentials = await loginWithBrowser({
			baseUrl: fake.origin,
			announce: () => {},
			openBrowser: browserThatApproves(fake, { extraStateFirst: true }),
		});

		expect(credentials.accessToken).toBe("fat_access");
		expect(fake.tokenRequests).toHaveLength(1);
		expect(fake.tokenRequests[0]?.code).toBe("code-example");
	});

	it("reports a denial in the browser and exchanges nothing", async () => {
		await expect(
			loginWithBrowser({
				baseUrl: fake.origin,
				announce: () => {},
				openBrowser: async (authorizationUrl) => {
					const request = new URL(authorizationUrl);
					await fetch(
						`${request.searchParams.get("redirect_uri")}?error=access_denied&state=${request.searchParams.get("state")}`,
					);
				},
			}),
		).rejects.toThrow("denied");

		expect(fake.tokenRequests).toHaveLength(0);
	});

	it("gives up after the timeout when the browser never answers", async () => {
		await expect(
			loginWithBrowser({
				baseUrl: fake.origin,
				announce: () => {},
				openBrowser: () => {},
				timeoutMs: 50,
			}),
		).rejects.toThrow("Timed out");
	});

	it("gives up when the caller's signal aborts, however long the browser would have taken", async () => {
		const controller = new AbortController();

		const login = loginWithBrowser({
			baseUrl: fake.origin,
			announce: () => controller.abort(),
			openBrowser: () => {},
			timeoutMs: 60_000,
			signal: controller.signal,
		});

		await expect(login).rejects.toThrow("cancelled");
	});

	it("waits five minutes for the browser when nobody says otherwise, so a run nobody is watching ends", () => {
		expect(LOGIN_TIMEOUT_MS).toBe(5 * 60 * 1000);
	});

	it("falls back to the announced URL when the browser cannot be opened", async () => {
		const announced: string[] = [];

		await expect(
			loginWithBrowser({
				baseUrl: fake.origin,
				announce: (url) => announced.push(url),
				openBrowser: () => {
					throw new Error("no browser");
				},
				timeoutMs: 50,
			}),
		).rejects.toThrow("Timed out");

		expect(announced).toHaveLength(1);
		expect(new URL(announced[0] as string).origin).toBe(fake.origin);
	});

	it("reuses the client a previous login registered on this deployment, on a new port", async () => {
		fake.knownClients.add("client-previous");
		const previous = {
			clientId: "client-previous",
			redirectUri: "http://127.0.0.1:1/callback",
			tokenEndpoint: `${fake.origin}/api/auth/oauth2/token`,
		};

		const credentials = await loginWithBrowser({
			baseUrl: fake.origin,
			previous,
			announce: () => {},
			openBrowser: browserThatApproves(fake),
		});

		expect(fake.registrations).toHaveLength(0);
		expect(fake.probes).toEqual(["client-previous"]);
		expect(fake.authorizations[0]?.get("client_id")).toBe(
			"client-previous",
		);
		// The request names this login's own port; the registration keeps its.
		expect(fake.authorizations[0]?.get("redirect_uri")).not.toBe(
			previous.redirectUri,
		);
		expect(fake.tokenRequests[0]?.client_id).toBe("client-previous");
		expect(credentials).toMatchObject({
			clientId: "client-previous",
			redirectUri: previous.redirectUri,
		});
	});

	it("registers again when the server no longer knows the previous client", async () => {
		const credentials = await loginWithBrowser({
			baseUrl: fake.origin,
			previous: {
				clientId: "client-forgotten",
				redirectUri: "http://127.0.0.1:1/callback",
				tokenEndpoint: `${fake.origin}/api/auth/oauth2/token`,
			},
			announce: () => {},
			openBrowser: browserThatApproves(fake),
		});

		expect(fake.probes).toEqual(["client-forgotten"]);
		expect(fake.registrations).toHaveLength(1);
		expect(fake.authorizations[0]?.get("client_id")).toBe("client-example");
		expect(credentials.clientId).toBe("client-example");
		expect(credentials.redirectUri).toBe(
			fake.authorizations[0]?.get("redirect_uri"),
		);
	});

	it("never reuses a client registered with another deployment", async () => {
		const credentials = await loginWithBrowser({
			baseUrl: fake.origin,
			previous: {
				clientId: "client-previous",
				redirectUri: "http://127.0.0.1:1/callback",
				tokenEndpoint: "https://other.example/api/auth/oauth2/token",
			},
			announce: () => {},
			openBrowser: browserThatApproves(fake),
		});

		expect(fake.probes).toEqual([]);
		expect(fake.registrations).toHaveLength(1);
		expect(credentials.clientId).toBe("client-example");
	});

	it("surfaces the server's reason when the code exchange is refused", async () => {
		await expect(
			loginWithBrowser({
				baseUrl: fake.origin,
				announce: () => {},
				openBrowser: async (authorizationUrl) => {
					const request = new URL(authorizationUrl);
					const redirectUri = request.searchParams.get(
						"redirect_uri",
					) as string;
					// A code issued against a different challenge.
					fake.codes.set("code-example", {
						challenge: "another-challenge",
						redirectUri,
					});
					await fetch(
						`${redirectUri}?code=code-example&state=${request.searchParams.get("state")}`,
					);
				},
			}),
		).rejects.toThrow("code verification failed");
	});
});

describe("authorization server discovery", () => {
	it("inserts the well-known segment before the issuer path", () => {
		expect(
			authorizationServerMetadataUrl("https://example.com/api/auth"),
		).toBe(
			"https://example.com/.well-known/oauth-authorization-server/api/auth",
		);
		expect(authorizationServerMetadataUrl("https://example.com")).toBe(
			"https://example.com/.well-known/oauth-authorization-server",
		);
	});

	it("refuses metadata whose issuer is not the one the resource named", async () => {
		fake.issuerOverride = "https://elsewhere.example/api/auth";

		await expect(
			discoverAuthorizationServer(fake.origin),
		).rejects.toBeInstanceOf(OAuthDiscoveryError);
	});

	it("refuses an endpoint on another origin", async () => {
		fake.tokenEndpointOverride = "https://elsewhere.example/token";

		await expect(discoverAuthorizationServer(fake.origin)).rejects.toThrow(
			"another origin",
		);
	});
});
