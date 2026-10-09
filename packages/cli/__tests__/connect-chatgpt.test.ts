/**
 * `fabric connect chatgpt` (Fizzy #2939): the loopback accepts only the
 * callback that carries this sign-in's state, the ID token must carry this
 * sign-in's nonce, the upload carries exactly what Fabric stores, and the
 * organization choice never picks one for a person with several.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	type ChatGptRegistration,
	checkIdToken,
	DYNAMIC_CLIENT_ID,
	issuedClientId,
	loadRegistrationStore,
	saveAccountRegistration,
	selectRegistration,
	signInWithChatGpt,
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

// A registration made in one ChatGPT workspace is refused in another, so a
// saved one is kept per account, only once OpenAI confirmed it, and reused
// only when the person names that account.
describe("registration per ChatGPT account", () => {
	type Reply = Record<string, string>;

	/** Plays ChatGPT in the browser: each sign-in gets the next reply. */
	function browser(...replies: Reply[]) {
		const opened: URL[] = [];
		const open = (url: string) => {
			const authorize = new URL(url);
			opened.push(authorize);
			const reply = replies[opened.length - 1] ?? replies.at(-1) ?? {};
			const query = new URLSearchParams({
				state: authorize.searchParams.get("state") ?? "",
				...reply,
			});
			void fetch(
				`${authorize.searchParams.get("redirect_uri")}?${query}`,
			).catch(() => {});
		};
		return { open, opened };
	}

	function tokenEndpoint(
		opened: URL[],
		claims: { sub: string; email?: string; nonce?: string } = {
			sub: "subject-1",
			email: "person@example.com",
		},
	) {
		return vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						...TOKENS,
						id_token: idToken({
							nonce: opened.at(-1)?.searchParams.get("nonce"),
							...claims,
						}),
					}),
					{ status: 200 },
				),
		);
	}

	const SIGNED_IN = { code: "code-1", client_id: "oaiapp_new" };
	const WORKSPACE_DENIED = {
		error: "3p_login_workspace_scope_denied",
		error_description:
			"This app is only available to members of its workspace",
	};
	const FRESH: ChatGptRegistration = { hostId: "urn:uuid:host" };
	const SAVED: ChatGptRegistration = {
		hostId: "urn:uuid:host",
		clientId: "oaiapp_saved",
		subject: "subject-1",
	};

	it("starts a first sign-in with a new registration and keeps it per subject once confirmed", async () => {
		const { open, opened } = browser(SIGNED_IN);
		const save = vi.fn(async () => {});
		const signIn = await signInWithChatGpt({
			registration: FRESH,
			open,
			fetchImpl: tokenEndpoint(opened),
			preferredPort: 0,
			save,
		});
		expect(opened[0]?.searchParams.get("client_id")).toBe(
			DYNAMIC_CLIENT_ID,
		);
		expect(signIn.subject).toBe("subject-1");
		expect(save).toHaveBeenCalledWith({
			hostId: "urn:uuid:host",
			subject: "subject-1",
			clientId: "oaiapp_new",
			email: "person@example.com",
		});
	});

	it("keeps nothing when OpenAI refuses the code", async () => {
		const { open } = browser(SIGNED_IN);
		const save = vi.fn(async () => {});
		await expect(
			signInWithChatGpt({
				registration: FRESH,
				open,
				fetchImpl: vi.fn(
					async () =>
						new Response(
							JSON.stringify({ error: "invalid_grant" }),
							{
								status: 400,
							},
						),
				),
				preferredPort: 0,
				save,
			}),
		).rejects.toThrow(/invalid_grant/);
		expect(save).not.toHaveBeenCalled();
	});

	it("keeps nothing when the ID token was not minted for this sign-in", async () => {
		const { open, opened } = browser(SIGNED_IN);
		const save = vi.fn(async () => {});
		await expect(
			signInWithChatGpt({
				registration: FRESH,
				open,
				fetchImpl: tokenEndpoint(opened, {
					sub: "subject-1",
					nonce: "other",
				}),
				preferredPort: 0,
				save,
			}),
		).rejects.toThrow(/does not belong/);
		expect(save).not.toHaveBeenCalled();
	});

	it("reuses the saved registration of the account named with --account", async () => {
		const { open, opened } = browser({ code: "code-1" });
		const save = vi.fn(async () => {});
		const signIn = await signInWithChatGpt({
			registration: SAVED,
			open,
			fetchImpl: tokenEndpoint(opened),
			preferredPort: 0,
			save,
		});
		expect(opened).toHaveLength(1);
		expect(opened[0]?.searchParams.get("client_id")).toBe("oaiapp_saved");
		expect(signIn.clientId).toBe("oaiapp_saved");
	});

	it("signs in once more with a new registration when the saved one is refused for the workspace", async () => {
		const { open, opened } = browser(WORKSPACE_DENIED, SIGNED_IN);
		const save = vi.fn(async () => {});
		const onRetry = vi.fn();
		const signIn = await signInWithChatGpt({
			registration: SAVED,
			open,
			fetchImpl: tokenEndpoint(opened),
			preferredPort: 0,
			save,
			onRetry,
		});
		expect(opened.map((url) => url.searchParams.get("client_id"))).toEqual([
			"oaiapp_saved",
			DYNAMIC_CLIENT_ID,
		]);
		expect(onRetry).toHaveBeenCalledTimes(1);
		expect(signIn.clientId).toBe("oaiapp_new");
		expect(save).toHaveBeenCalledTimes(1);
		expect(save).toHaveBeenCalledWith(
			expect.objectContaining({ clientId: "oaiapp_new" }),
		);
	});

	it("retries only once, then says to run without --account and choose the personal workspace", async () => {
		const { open, opened } = browser(WORKSPACE_DENIED);
		const save = vi.fn(async () => {});
		const failure = signInWithChatGpt({
			registration: SAVED,
			open,
			fetchImpl: tokenEndpoint(opened),
			preferredPort: 0,
			save,
		});
		await expect(failure).rejects.toThrow(/without --account/);
		await expect(failure).rejects.toThrow(/personal Plus or Pro workspace/);
		expect(opened).toHaveLength(2);
		expect(save).not.toHaveBeenCalled();
	});

	it("does not retry a new registration that is refused", async () => {
		const { open, opened } = browser(WORKSPACE_DENIED);
		await expect(
			signInWithChatGpt({
				registration: FRESH,
				open,
				fetchImpl: tokenEndpoint(opened),
				preferredPort: 0,
			}),
		).rejects.toThrow(/members of its workspace.*without --account/);
		expect(opened).toHaveLength(1);
	});

	it("does not retry when the person cancels the sign-in", async () => {
		const { open, opened } = browser({ error: "access_denied" });
		const save = vi.fn(async () => {});
		await expect(
			signInWithChatGpt({
				registration: SAVED,
				open,
				fetchImpl: tokenEndpoint(opened),
				preferredPort: 0,
				save,
			}),
		).rejects.toThrow(/denied in the browser/);
		expect(opened).toHaveLength(1);
		expect(save).not.toHaveBeenCalled();
	});

	it("does not retry a saved registration for an unrelated failure", async () => {
		const { open, opened } = browser({ error: "server_error" });
		await expect(
			signInWithChatGpt({
				registration: SAVED,
				open,
				fetchImpl: tokenEndpoint(opened),
				preferredPort: 0,
			}),
		).rejects.toThrow(/server_error/);
		expect(opened).toHaveLength(1);
	});

	it("keeps every account's registration in the store", async () => {
		const path = join(
			await mkdtemp(join(tmpdir(), "fabric-chatgpt-")),
			"host.json",
		);
		await saveAccountRegistration(
			{
				hostId: "urn:uuid:host",
				subject: "subject-1",
				clientId: "oaiapp_1",
			},
			path,
		);
		await saveAccountRegistration(
			{
				hostId: "urn:uuid:host",
				subject: "subject-2",
				clientId: "oaiapp_2",
				email: "second@example.com",
			},
			path,
		);
		expect(await loadRegistrationStore(path)).toEqual({
			hostId: "urn:uuid:host",
			accounts: {
				"subject-1": { clientId: "oaiapp_1" },
				"subject-2": {
					clientId: "oaiapp_2",
					email: "second@example.com",
				},
			},
		});
	});

	it("starts an unnamed account with a new registration, and finds a named one by subject or email", async () => {
		const store = {
			hostId: "urn:uuid:host",
			accounts: {
				"subject-2": {
					clientId: "oaiapp_2",
					email: "second@example.com",
				},
			},
		};
		expect(selectRegistration(store)).toEqual({ hostId: "urn:uuid:host" });
		const named = {
			hostId: "urn:uuid:host",
			clientId: "oaiapp_2",
			subject: "subject-2",
		};
		expect(selectRegistration(store, "subject-2")).toEqual(named);
		expect(selectRegistration(store, "Second@Example.com")).toEqual(named);
		expect(() => selectRegistration(store, "other@example.com")).toThrow(
			/No ChatGPT account/,
		);
	});

	it("reads the earlier single registration without reusing an unconfirmed client id", async () => {
		const dir = await mkdtemp(join(tmpdir(), "fabric-chatgpt-"));
		const unconfirmed = join(dir, "unconfirmed.json");
		await writeFile(
			unconfirmed,
			JSON.stringify({ hostId: "urn:uuid:host", clientId: "oaiapp_old" }),
		);
		const store = await loadRegistrationStore(unconfirmed);
		expect(store).toEqual({ hostId: "urn:uuid:host", accounts: {} });
		expect(selectRegistration(store)).toEqual({ hostId: "urn:uuid:host" });

		const confirmed = join(dir, "confirmed.json");
		await writeFile(
			confirmed,
			JSON.stringify({
				hostId: "urn:uuid:host",
				clientId: "oaiapp_old",
				subject: "subject-1",
			}),
		);
		expect(await loadRegistrationStore(confirmed)).toEqual({
			hostId: "urn:uuid:host",
			accounts: { "subject-1": { clientId: "oaiapp_old" } },
		});
		await saveAccountRegistration(
			{
				hostId: "urn:uuid:host",
				subject: "subject-2",
				clientId: "oaiapp_2",
			},
			confirmed,
		);
		expect(JSON.parse(await readFile(confirmed, "utf8"))).toEqual({
			hostId: "urn:uuid:host",
			accounts: {
				"subject-1": { clientId: "oaiapp_old" },
				"subject-2": { clientId: "oaiapp_2" },
			},
		});
	});

	it("refuses --account with --new-registration or --shared", () => {
		expect(
			connectOptionsError({
				account: "subject-1",
				newRegistration: true,
			}),
		).toMatch(/--new-registration/);
		expect(
			connectOptionsError({
				account: "subject-1",
				org: "example-org",
				shared: true,
			}),
		).toMatch(/shared account/);
		expect(connectOptionsError({ account: "subject-1" })).toBeNull();
	});
});
