/**
 * `fabric connect chatgpt` (Fizzy #2939): the loopback accepts only the
 * callback that carries this sign-in's state, the ID token must carry this
 * sign-in's nonce, the upload carries exactly what Fabric stores, and the
 * organization choice never picks one for a person with several.
 */
import { describe, expect, it, vi } from "vitest";
import {
	buildConnectCommand,
	connectOptionsError,
	describeOrganizations,
	describeSharedAccount,
} from "../src/commands/connect/chatgpt.js";
import {
	buildApprovalUrl,
	buildAuthorizeUrl,
	buildUploadPayload,
	checkIdToken,
	DYNAMIC_CLIENT_ID,
	issuedClientId,
	uploadChatGptPlan,
} from "../src/lib/chatgpt-plan/flow.js";
import { startLoopbackListener } from "../src/lib/oauth/loopback.js";

vi.mock("../src/lib/config.js", () => ({
	getConfigPath: () => "/tmp/fabric-cli-example/config.json",
}));

function idToken(claims: Record<string, unknown>): string {
	const encode = (value: object) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "RS256" })}.${encode(claims)}.signature`;
}

const TOKENS = {
	access_token: "access",
	refresh_token: "refresh",
	id_token: idToken({ sub: "subject-1", nonce: "n" }),
	token_type: "Bearer",
	expires_in: 3600,
	scope: "openid offline_access chatgpt.tokens.use.direct",
	earliest_refresh_at: 1_790_000_000,
};

describe("loopback callback", () => {
	it("ignores a callback with another state and accepts the real one", async () => {
		const listener = await startLoopbackListener({
			state: "expected-state",
			callbackPath: "/auth/callback",
			preferredPort: 0,
			timeoutMs: 5_000,
		});
		expect(listener.redirectUri).toMatch(
			/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/,
		);

		const stray = await fetch(
			`${listener.redirectUri}?state=other&code=evil&client_id=oaiapp_evil`,
		);
		expect(stray.status).toBe(400);

		await fetch(
			`${listener.redirectUri}?state=expected-state&code=good&client_id=oaiapp_1`,
		);
		const { code, params } = await listener.result;
		expect(code).toBe("good");
		expect(params.get("client_id")).toBe("oaiapp_1");
	});
});

describe("authorize URL", () => {
	it("sends the agent name only on a first sign-in", () => {
		const base = {
			hostId: "urn:uuid:1",
			redirectUri: "http://127.0.0.1:1455/auth/callback",
			state: "s",
			nonce: "n",
			codeChallenge: "c",
		};
		const first = new URL(
			buildAuthorizeUrl({ ...base, clientId: DYNAMIC_CLIENT_ID }),
		);
		expect(first.searchParams.get("agent_name_hint")).toBe("Fabric");
		expect(first.searchParams.get("ext_agent_host_id")).toBe("urn:uuid:1");
		expect(first.searchParams.get("code_challenge_method")).toBe("S256");
		const again = new URL(
			buildAuthorizeUrl({ ...base, clientId: "oaiapp_1" }),
		);
		expect(again.searchParams.has("agent_name_hint")).toBe(false);
	});
});

describe("issued client id", () => {
	it("takes the client id issued on a first sign-in", () => {
		expect(
			issuedClientId(new URLSearchParams("client_id=oaiapp_1"), {
				hostId: "h",
			}),
		).toBe("oaiapp_1");
	});

	it("refuses a callback for a different client than the saved one", () => {
		expect(() =>
			issuedClientId(new URLSearchParams("client_id=oaiapp_2"), {
				hostId: "h",
				clientId: "oaiapp_1",
			}),
		).toThrow(/different client/);
	});
});

describe("ID token check", () => {
	it("accepts the token minted for this sign-in", () => {
		expect(checkIdToken(TOKENS.id_token, { nonce: "n" })).toEqual({
			sub: "subject-1",
			email: undefined,
		});
	});

	it("refuses a token with another nonce", () => {
		expect(() => checkIdToken(TOKENS.id_token, { nonce: "other" })).toThrow(
			/does not belong/,
		);
	});

	it("refuses a different account than this machine's", () => {
		expect(() =>
			checkIdToken(TOKENS.id_token, { nonce: "n", subject: "subject-2" }),
		).toThrow(/different ChatGPT account/);
	});
});

describe("upload payload", () => {
	it("carries the tokens, scopes and this machine's registration", () => {
		expect(
			buildUploadPayload(TOKENS, {
				clientId: "oaiapp_1",
				hostId: "urn:uuid:1",
			}),
		).toEqual({
			accessToken: "access",
			refreshToken: "refresh",
			idToken: TOKENS.id_token,
			tokenType: "Bearer",
			expiresIn: 3600,
			scopes: ["openid", "offline_access", "chatgpt.tokens.use.direct"],
			clientId: "oaiapp_1",
			hostId: "urn:uuid:1",
			earliestRefreshAt: 1_790_000_000,
		});
	});

	it("sends nothing when plan usage was not granted", () => {
		expect(() =>
			buildUploadPayload(
				{ ...TOKENS, scope: "openid offline_access" },
				{ clientId: "oaiapp_1", hostId: "urn:uuid:1" },
			),
		).toThrow(/not allowed/);
	});
});

describe("approval in Fabric", () => {
	it("sends the person to the deployment's connect page with this run's port and state", () => {
		const url = new URL(
			buildApprovalUrl("https://fabric.example.com", {
				port: 54321,
				state: "state-example",
			}),
		);
		expect(url.origin).toBe("https://fabric.example.com");
		expect(url.pathname).toBe("/connect/chatgpt");
		expect(url.searchParams.get("port")).toBe("54321");
		expect(url.searchParams.get("state")).toBe("state-example");
	});

	it("takes the ticket from the approval callback and ignores another state", async () => {
		const listener = await startLoopbackListener({
			state: "expected-state",
			callbackPath: "/fabric/callback",
			codeParam: "ticket",
			timeoutMs: 5_000,
		});
		expect(
			(await fetch(`${listener.redirectUri}?state=other&ticket=evil`))
				.status,
		).toBe(400);
		await fetch(
			`${listener.redirectUri}?state=expected-state&ticket=ticket-1`,
		);
		expect((await listener.result).code).toBe("ticket-1");
	});
});

describe("upload with the ticket", () => {
	const payload = buildUploadPayload(TOKENS, {
		clientId: "oaiapp_1",
		hostId: "urn:uuid:1",
	});

	it("posts the sign-in with the ticket and no other credential", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						connected: true,
						email: null,
						organizations: [],
					}),
					{ status: 200 },
				),
		);
		await uploadChatGptPlan(
			{
				origin: "https://fabric.example.com",
				ticket: "ticket-1",
				payload,
			},
			fetchImpl,
		);
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [
			string,
			RequestInit & { headers: Record<string, string> },
		];
		expect(url).toBe(
			"https://fabric.example.com/api/connect/chatgpt/credentials",
		);
		expect(init.headers.authorization).toBe("Bearer ticket-1");
		expect(JSON.parse(String(init.body))).toEqual(payload);
	});

	it("surfaces Fabric's refusal of a spent ticket", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						error: "This connection link has expired",
					}),
					{
						status: 401,
					},
				),
		);
		await expect(
			uploadChatGptPlan(
				{
					origin: "https://fabric.example.com",
					ticket: "ticket-1",
					payload,
				},
				fetchImpl,
			),
		).rejects.toThrow(/expired/);
	});
});

describe("organization summary", () => {
	const org = (name: string, enabled: boolean) => ({
		slug: name,
		name,
		enabled,
	});

	it("names the organizations where the plan is now on", () => {
		expect(
			describeOrganizations({
				organizations: [
					org("example-org", true),
					org("example-two", false),
				],
			}),
		).toContain("example-org");
	});

	it("points to settings when none was chosen", () => {
		expect(
			describeOrganizations({
				organizations: [org("example-org", false)],
			}),
		).toContain("settings");
	});
});

// Fizzy #2770: `--org <slug> --shared` connects an account the organization
// shares, through the same approval page in its shared mode.
describe("shared account", () => {
	it("asks the approval page for the organization's shared mode", () => {
		const url = new URL(
			buildApprovalUrl("https://fabric.example.com", {
				port: 54321,
				state: "state-example",
				sharedOrganizationSlug: "example-org",
			}),
		);
		expect(url.searchParams.get("shared")).toBe("1");
		expect(url.searchParams.get("org")).toBe("example-org");
	});

	it("leaves the personal approval link without shared mode", () => {
		const url = new URL(
			buildApprovalUrl("https://fabric.example.com", {
				port: 54321,
				state: "state-example",
			}),
		);
		expect(url.searchParams.has("shared")).toBe(false);
		expect(url.searchParams.has("org")).toBe(false);
	});

	it("refuses --shared without --org, and --org without --shared", () => {
		expect(connectOptionsError({ shared: true })).toMatch(/--org/);
		expect(connectOptionsError({ org: "example-org" })).toMatch(/--shared/);
		expect(
			connectOptionsError({ org: "example-org", shared: true }),
		).toBeNull();
		expect(connectOptionsError({})).toBeNull();
	});

	it("exits with status 2 for --shared without --org, before opening anything", async () => {
		const exit = vi
			.spyOn(process, "exit")
			.mockImplementation((code?: string | number | null) => {
				throw new Error(`exit ${code}`);
			});
		const stderr = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			await expect(
				buildConnectCommand().parseAsync(
					["node", "fabric", "chatgpt", "--shared"],
					{ from: "node" },
				),
			).rejects.toThrow("exit 2");
		} finally {
			exit.mockRestore();
			stderr.mockRestore();
		}
	});

	it("names the organization the account now serves", () => {
		expect(
			describeSharedAccount({
				email: "shared@example.com",
				shared: {
					organization: { slug: "example-org", name: "Example Org" },
					created: true,
				},
			}),
		).toMatch(
			/^Connected the ChatGPT account \(shared@example.com\) as a shared account of Example Org/,
		);
	});
});
