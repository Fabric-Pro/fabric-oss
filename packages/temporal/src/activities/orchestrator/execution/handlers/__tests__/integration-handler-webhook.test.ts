import { createSafeOutboundLookup } from "@repo/utils/url-security";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationHandler } from "../integration-handler";
import { buildContext, buildInput } from "./integration-handler-fixtures";

const { fetchMock, credentials } = vi.hoisted(() => ({
	fetchMock: vi.fn<typeof fetch>(),
	credentials: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	fetchCredentialsByIdAndProviderInTenant: credentials,
	fetchCredentialsByProvider: credentials,
}));
vi.mock("../../authority-gate", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	checkIntegrationAuthority: vi.fn(async () => ({ authorized: true })),
}));
vi.mock("../../../../shared/read-only-gate", () => ({
	guardToolWriteForReadOnly: vi.fn(async () => null),
}));
vi.mock("../../../../shared/oauth-tool-executors", () => ({
	executeMicrosoftTeamsTool: vi.fn(),
}));

const storedUrl = "https://example.com/webhook";
const secret = "example-secret";
function matchedFailure(error: string) {
	return {
		handled: false,
		shouldFallback: false,
		error: `CUSTOM_WEBHOOK integration failed: ${error}. Please check your integration configuration.`,
	};
}

const blockedFailure = matchedFailure(
	"Request blocked: destination is not allowed.",
);

function callWebhook(inputs: Record<string, unknown> = {}) {
	return new IntegrationHandler().execute(
		buildContext(
			buildInput("CUSTOM_WEBHOOK", {
				inputs: { operation: "call_webhook", ...inputs },
			}),
		),
	);
}

beforeEach(() => {
	credentials.mockResolvedValue({
		WEBHOOK_URL: storedUrl,
		WEBHOOK_SECRET: secret,
	});
	fetchMock.mockReset();
	fetchMock.mockImplementation(async () => Response.json({ received: true }));
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("custom webhook outbound requests", () => {
	it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "[::1]"])(
		"refuses destination %s before fetching",
		async (host) => {
			const result = await callWebhook({ url: `http://${host}/webhook` });
			expect(result).toEqual(blockedFailure);
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("returns a fixed message for a DNS lookup refusal", async () => {
		const lookup = createSafeOutboundLookup((_host, _options, callback) => {
			callback(null, [{ address: "10.0.0.1", family: 4 }]);
		});
		fetchMock.mockImplementation(async (url, init) => {
			if (!init || !("dispatcher" in init)) {
				return Response.json({ received: true });
			}
			return new Promise<Response>((_resolve, reject) => {
				lookup(new URL(String(url)).hostname, {}, (cause) => {
					reject(new TypeError("fetch failed", { cause }));
				});
			});
		});

		const result = await callWebhook();
		expect(result).toEqual(blockedFailure);
	});

	it("refuses a redirect without following it", async () => {
		fetchMock.mockImplementation(async (_url, init) => {
			return init?.redirect === "manual"
				? new Response(null, {
						status: 302,
						headers: { Location: "https://example.org/webhook" },
					})
				: Response.json({ received: true });
		});
		const result = await callWebhook();

		expect(result).toEqual(
			matchedFailure(
				"Request failed: the server responded with a redirect, and redirects are not followed.",
			),
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledWith(
			storedUrl,
			expect.objectContaining({ redirect: "manual" }),
		);
	});

	it.each([
		{ url: undefined, expectedSecret: secret },
		{ url: "https://EXAMPLE.com:443/another-path", expectedSecret: secret },
		{ url: "https://example.org/webhook", expectedSecret: null },
		{ url: "http://example.com/webhook", expectedSecret: null },
		{ url: "https://example.com:8443/webhook", expectedSecret: null },
	])(
		"guards $url and sends secret $expectedSecret",
		async ({ url, expectedSecret }) => {
			const result = await callWebhook({
				url,
				headers: { "x-webhook-secret": "example-input-secret" },
				body: { message: "example" },
			});
			expect(result).toMatchObject({
				handled: true,
				output: { outputs: { integration_result: { received: true } } },
			});
			expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
				url ?? storedUrl,
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({ message: "example" }),
				}),
			);
			const init = fetchMock.mock.calls[0][1];
			expect(new Headers(init?.headers).get("X-Webhook-Secret")).toBe(
				expectedSecret,
			);
			expect(init).toHaveProperty("dispatcher");
		},
	);
});
