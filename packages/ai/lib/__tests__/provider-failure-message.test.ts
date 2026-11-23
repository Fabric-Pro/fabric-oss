import { describe, expect, it } from "vitest";
import {
	classifyProviderFailure,
	isModelRefusal,
	isProviderCallFailure,
	providerFailureMessage,
	providerFailureMessageFromText,
} from "../provider-failure-message";

/** An `@ai-sdk/provider` APICallError's shape, as the providers throw it. */
function apiCallError(statusCode: number, message: string) {
	return Object.assign(new Error(message), {
		url: "https://api.example.com/v1/chat/completions",
		requestBodyValues: {},
		statusCode,
	});
}

const LEAKY =
	"Incorrect API key provided: sk-proj-abc123****wxyz. You can find your API key at https://platform.example.com/account/api-keys.";

describe("providerFailureMessage", () => {
	it("names an authentication failure without the provider's text, URL or key", () => {
		const message = providerFailureMessage(apiCallError(401, LEAKY));

		expect(message).toBe(
			"The AI provider rejected the request (authentication). Check the provider settings.",
		);
		expect(message).not.toMatch(/sk-|https?:\/\/|\*\*\*\*/);
	});

	it("classifies an authentication failure from a wrapped cause", () => {
		const wrapped = new Error("No output generated.", {
			cause: apiCallError(401, LEAKY),
		});

		expect(classifyProviderFailure(wrapped)).toBe("authentication");
	});

	it("classifies a failure from its text when it carries no status", () => {
		expect(classifyProviderFailure(new Error(LEAKY))).toBe(
			"authentication",
		);
		expect(classifyProviderFailure(new Error("fetch failed"))).toBe(
			"unavailable",
		);
		expect(classifyProviderFailure("Too Many Requests")).toBe("rate_limit");
	});

	it.each([
		[429, "rate_limit"],
		[404, "model_not_found"],
		[400, "invalid_request"],
		[503, "unavailable"],
		[408, "unavailable"],
	] as const)("classifies status %d as %s", (status, cause) => {
		expect(classifyProviderFailure(apiCallError(status, "x"))).toBe(cause);
	});

	it("says something general for an error it cannot classify", () => {
		expect(providerFailureMessage(new Error("something odd"))).toBe(
			"The AI provider could not complete the request. Try again, or check the provider settings.",
		);
	});

	it("reads Anthropic's key rejection as authentication", () => {
		expect(classifyProviderFailure(new Error("invalid x-api-key"))).toBe(
			"authentication",
		);
	});

	it("never repeats the provider's text for any cause", () => {
		for (const status of [400, 401, 404, 429, 500]) {
			expect(
				providerFailureMessage(apiCallError(status, LEAKY)),
			).not.toContain("platform.example.com");
		}
	});
});

describe("isModelRefusal", () => {
	it("is true for a content-filter rejection, also when wrapped", () => {
		const filtered = apiCallError(
			400,
			"The response was filtered due to the prompt triggering content management policy.",
		);
		expect(isModelRefusal(filtered)).toBe(true);
		expect(
			isModelRefusal(
				new Error("No output generated.", { cause: filtered }),
			),
		).toBe(true);
	});

	it.each([
		"Invalid prompt: your prompt was flagged as potentially violating our usage policy.",
		"Your request was rejected as a result of our safety system.",
	])("is true for a content-policy 400: %s", (message) => {
		expect(isModelRefusal(apiCallError(400, message))).toBe(true);
	});

	it("is true for a 400 whose body carries a content-policy code", () => {
		const rejected = Object.assign(apiCallError(400, "Bad request"), {
			data: {
				error: { code: "content_policy_violation", message: "x" },
			},
		});

		expect(isModelRefusal(rejected)).toBe(true);
	});

	it("is true for a stream error whose body carries a usage-policy code", () => {
		const streamError = {
			statusCode: 400,
			type: "invalid_request",
			data: { error: { code: "cyber_policy", message: "x" } },
		};

		expect(isModelRefusal(streamError)).toBe(true);
	});

	it("is false for a 400 whose body code names no policy", () => {
		const invalid = Object.assign(apiCallError(400, "Bad request"), {
			data: { error: { code: "invalid_value", message: "x" } },
		});

		expect(isModelRefusal(invalid)).toBe(false);
	});

	it("is false for a provider failure", () => {
		expect(isModelRefusal(apiCallError(401, LEAKY))).toBe(false);
	});

	it("is false for an invalid request that names no content policy", () => {
		expect(
			isModelRefusal(
				apiCallError(
					400,
					"Invalid 'max_tokens': integer above maximum.",
				),
			),
		).toBe(false);
	});
});

describe("isProviderCallFailure", () => {
	it("is true for a provider's answer, also when wrapped", () => {
		expect(isProviderCallFailure(apiCallError(401, LEAKY))).toBe(true);
		expect(
			isProviderCallFailure(
				new Error("No output generated.", {
					cause: apiCallError(503, "x"),
				}),
			),
		).toBe(true);
	});

	it("is false for an error of Fabric's own code", () => {
		expect(isProviderCallFailure(new Error("secret-provider-error"))).toBe(
			false,
		);
	});
});

describe("providerFailureMessageFromText", () => {
	it("maps text that reads as a provider failure to the shared message", () => {
		expect(providerFailureMessageFromText(LEAKY)).toBe(
			"The AI provider rejected the request (authentication). Check the provider settings.",
		);
		expect(
			providerFailureMessageFromText(
				"Request to https://api.example.com/v1 failed",
			),
		).toBe(
			"The AI provider could not complete the request. Try again, or check the provider settings.",
		);
	});

	it("leaves an engine's own wording alone", () => {
		expect(providerFailureMessageFromText("The planner failed")).toBeNull();
	});
});
