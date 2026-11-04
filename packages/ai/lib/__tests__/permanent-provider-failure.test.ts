import { describe, expect, it } from "vitest";
import { DatabricksOAuthError } from "../databricks-oauth";
import { isPermanentProviderFailure } from "../usage-logging-middleware";

// Gateway 4.0.113 assigns these own fields and preserves the APICallError
// as cause. AI SDK 7.0.140 RetryError exposes lastError and errors.
const gatewayError = Object.assign(new Error("Authentication failed"), {
	name: "GatewayAuthenticationError",
	statusCode: 401,
	isRetryable: false,
	cause: {
		name: "AI_APICallError",
		statusCode: 401,
		url: "https://example.com",
	},
});

describe("permanent provider failures", () => {
	it.each([
		["gateway", gatewayError],
		["401 alone", { statusCode: 401 }],
		["403 alone", { statusCode: 403 }],
		[
			"name alone after SDK wrapping",
			{ name: "GatewayAuthenticationError" },
		],
		[
			"retry lastError",
			{
				name: "AI_RetryError",
				lastError: gatewayError,
				errors: [gatewayError],
			},
		],
		["cause", new Error("wrapped", { cause: gatewayError })],
		["errors", { errors: [{ statusCode: 403 }] }],
	])("recognizes %s", (_label, error) => {
		expect(isPermanentProviderFailure(error)).toBe(true);
	});

	it.each([
		["429", { statusCode: 429, isRetryable: false }],
		["408", { statusCode: 408 }],
		["409", { statusCode: 409 }],
		["500", { statusCode: 500 }],
		["network", new TypeError("fetch failed")],
		["plain Error", new Error("401 Unauthorized")],
		["null", null],
		["string status", { statusCode: "401" }],
	])("does not classify %s as permanent", (_label, error) => {
		expect(isPermanentProviderFailure(error)).toBe(false);
	});

	it("bounds cyclic and deep cause chains", () => {
		const cyclic: { cause?: unknown } = {};
		cyclic.cause = cyclic;
		expect(isPermanentProviderFailure(cyclic)).toBe(false);
		let deep: unknown = gatewayError;
		for (let i = 0; i < 12; i++) {
			deep = { cause: deep };
		}
		expect(isPermanentProviderFailure(deep)).toBe(false);
	});
});

it.each([401, 403])(
	"classifies DatabricksOAuthError HTTP %i as permanent",
	(status) => {
		const error = new DatabricksOAuthError("Token exchange failed", {
			status,
		});
		expect(Object.hasOwn(error, "name")).toBe(true);
		expect(error.cause).toBeUndefined();
		expect(isPermanentProviderFailure(error)).toBe(true);
	},
);

it.each([
	new DatabricksOAuthError("Token exchange failed", { status: 500 }),
	new DatabricksOAuthError("Token exchange failed", { status: 429 }),
	Object.assign(new Error("Other provider failed"), {
		name: "OtherProviderError",
		status: 401,
	}),
	{ name: "DatabricksOAuthError", status: "401" },
	Object.assign(Object.create({ name: "DatabricksOAuthError" }), {
		status: 401,
	}),
])("rejects non-permanent or non-Databricks status shapes %#", (error) => {
	expect(isPermanentProviderFailure(error)).toBe(false);
});
