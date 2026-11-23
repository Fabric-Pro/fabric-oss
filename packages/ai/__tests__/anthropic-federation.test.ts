import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	anthropicBearerFetch,
	getAnthropicFederatedToken,
} from "../lib/anthropic-federation";

const { getToken } = vi.hoisted(() => ({
	getToken: vi.fn(async () => ({ token: "example-identity" })),
}));
vi.mock("@azure/identity", () => ({
	DefaultAzureCredential: class {
		getToken = getToken;
	},
}));

const org = "example-org";
const tokenResponse = () =>
	Response.json({
		access_token: "example-access-token",
		expires_in: 600,
		next_challenge: "",
		next_challenge_expires_in: 0,
		scope: "workspace:developer",
		token_type: "Bearer",
		workspace_id: "wrkspc_example",
	});

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(1_800_000_000_000);
	vi.stubEnv("ANTHROPIC_FEDERATION_RULE_ID", "fdrl_example");
	vi.stubEnv(
		"ANTHROPIC_ORGANIZATION_ID",
		"00000000-0000-0000-0000-000000000000",
	);
	vi.stubEnv("ANTHROPIC_FEDERATION_AUDIENCE", "example-audience");
	vi.stubEnv(
		"ANTHROPIC_FEDERATION_ALLOWED_ORGANIZATION_IDS",
		" example-org ",
	);
	vi.stubEnv("ANTHROPIC_WORKSPACE_ID", "wrkspc_example");
	vi.stubEnv("ANTHROPIC_SERVICE_ACCOUNT_ID", "svac_example");
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("Anthropic federation", () => {
	it("exchanges the assertion, shares concurrent requests, caches and refreshes early", async () => {
		const fetch = vi.fn(async () => tokenResponse());
		vi.stubGlobal("fetch", fetch);
		const [first, second] = await Promise.all([
			getAnthropicFederatedToken(org),
			getAnthropicFederatedToken(org),
		]);
		expect(second).toEqual(first);
		expect(first.expiresAt).toBe(Date.now() + 600_000);
		expect(getToken).toHaveBeenCalledWith(
			"api://example-audience/.default",
		);
		expect(fetch).toHaveBeenCalledExactlyOnceWith(
			"https://api.anthropic.com/v1/oauth/token",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
					assertion: "example-identity",
					federation_rule_id: "fdrl_example",
					organization_id: "00000000-0000-0000-0000-000000000000",
					service_account_id: "svac_example",
					workspace_id: "wrkspc_example",
				}),
			}),
		);
		await expect(getAnthropicFederatedToken(org)).resolves.toEqual(first);
		expect(fetch).toHaveBeenCalledTimes(1);
		vi.setSystemTime(first.expiresAt - 15_000);
		await expect(getAnthropicFederatedToken(org)).resolves.toMatchObject({
			expiresAt: Date.now() + 600_000,
		});
		expect(fetch).toHaveBeenCalledTimes(2);
		vi.stubEnv(
			"ANTHROPIC_FEDERATION_ALLOWED_ORGANIZATION_IDS",
			"other-org",
		);
		await expect(getAnthropicFederatedToken(org)).rejects.toThrow(
			"unavailable",
		);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it.each(["401", "network", "abort"])(
		"evicts a failed exchange (%s)",
		async (failure) => {
			vi.stubEnv(
				"ANTHROPIC_FEDERATION_RULE_ID",
				`fdrl_example_${failure}`,
			);
			const abort = new DOMException("Aborted", "AbortError");
			const fetch = vi
				.fn(async () => tokenResponse())
				.mockImplementationOnce(async () => {
					if (failure === "abort") {
						throw abort;
					}
					if (failure === "network")
						throw new Error("example-secret");
					return new Response("example-secret", { status: 401 });
				});
			vi.stubGlobal("fetch", fetch);
			const result = getAnthropicFederatedToken(org);
			if (failure === "abort") {
				await expect(result).rejects.toBe(abort);
			} else {
				await expect(result).rejects.toThrow(
					/^Anthropic identity token exchange failed\.$/,
				);
			}
			await expect(
				getAnthropicFederatedToken(org),
			).resolves.toMatchObject({ token: "example-access-token" });
			expect(fetch).toHaveBeenCalledTimes(2);
		},
	);

	it.each([
		"ANTHROPIC_FEDERATION_RULE_ID",
		"ANTHROPIC_ORGANIZATION_ID",
		"ANTHROPIC_FEDERATION_AUDIENCE",
		"ANTHROPIC_FEDERATION_ALLOWED_ORGANIZATION_IDS",
	])("requires %s", async (variable) => {
		vi.stubEnv(variable, "");
		await expect(getAnthropicFederatedToken(org)).rejects.toThrow(
			"unavailable",
		);
	});
});

describe("Anthropic Bearer dispatch", () => {
	it("chooses Bearer, strips x-api-key and resolves again for a reused client", async () => {
		const dispatch = vi.fn(async () => Response.json({}));
		vi.stubGlobal("fetch", dispatch);
		const source = vi
			.fn(async () => ({
				kind: "bearer" as const,
				token: "example-second-token",
				expiresAt: Date.now() + 1,
			}))
			.mockResolvedValueOnce({
				kind: "bearer",
				token: "example-first-token",
				expiresAt: Date.now() + 1,
			});
		const send = anthropicBearerFetch(source);
		const url = "https://api.anthropic.com/v1/messages";
		await send(url, { headers: { "x-api-key": "example-key" } });
		vi.setSystemTime(Date.now() + 2);
		await send(url);
		const requests = dispatch.mock.calls as unknown as [Request][];
		expect(
			requests.map(([request]) => request.headers.get("authorization")),
		).toEqual([
			"Bearer example-first-token",
			"Bearer example-second-token",
		]);
		expect(
			requests.map(([request]) => request.headers.has("x-api-key")),
		).toEqual([false, false]);
	});

	it("refuses expired tokens and a different destination before dispatch", async () => {
		const dispatch = vi.fn();
		vi.stubGlobal("fetch", dispatch);
		const source = vi.fn(async () => ({
			kind: "bearer" as const,
			token: "example-expired-token",
			expiresAt: Date.now(),
		}));
		const send = anthropicBearerFetch(source);
		await expect(send("https://example.com/v1/messages")).rejects.toThrow(
			"Anthropic API endpoint",
		);
		expect(source).not.toHaveBeenCalled();
		await expect(
			send("https://api.anthropic.com/v1/messages"),
		).rejects.toThrow("expired");
		expect(dispatch).not.toHaveBeenCalled();
	});
});

it.each([
	{ access_token: "" },
	{ access_token: 123 },
	{ token_type: "Basic" },
	{ expires_in: "600" },
	{ expires_in: 0 },
])("rejects invalid token responses %o", async (overrides) => {
	vi.stubEnv("ANTHROPIC_FEDERATION_RULE_ID", "fdrl_invalid_response");
	const fixture = await tokenResponse().json();
	const fetch = vi.fn(async () =>
		Response.json({ ...fixture, ...overrides }),
	);
	vi.stubGlobal("fetch", fetch);
	await expect(getAnthropicFederatedToken(org)).rejects.toThrow(
		"exchange failed",
	);
});

it.each([400, 429])(
	"returns the upstream %i Anthropic response with its body and headers",
	async (status) => {
		const upstream = Response.json(
			{ error: { message: "prompt is too long" } },
			{
				status,
				headers: {
					"retry-after": "12",
					"request-id": "req_example",
					"x-should-retry": "false",
				},
			},
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => upstream),
		);
		const response = await anthropicBearerFetch(async () => ({
			kind: "bearer",
			token: "example-access",
			expiresAt: Date.now() + 1000,
		}))("https://api.anthropic.com/v1/messages");
		expect(response).toBe(upstream);
		expect(response.headers.get("retry-after")).toBe("12");
		expect(response.headers.get("request-id")).toBe("req_example");
		expect(response.headers.get("x-should-retry")).toBe("false");
		await expect(response.json()).resolves.toEqual({
			error: { message: "prompt is too long" },
		});
	},
);
