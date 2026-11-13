import { DatabricksOAuthError } from "@repo/ai/lib/databricks-oauth";
import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "vitest";
import {
	imageCredentialErrorMessage,
	imageGenerationErrorMessage,
} from "../image-generation-error";

describe("image generation error classification", () => {
	it.each([
		null,
		undefined,
		"401 sk-example-not-a-real-key",
		401,
		{ statusCode: "401", message: "429" },
		{ message: "content_policy_violation" },
	])(
		"uses fixed generic copy for malformed or unclassified errors: %j",
		(error) => {
			expect(imageGenerationErrorMessage(error, "openai")).toBe(
				"OpenAI image generation failed. Try again.",
			);
		},
	);

	it.each([
		["gateway", "Vercel AI Gateway"],
		["openai", "OpenAI"],
		["fal", "FAL"],
		["gemini", "Gemini"],
		["local", "Local image server"],
	] as const)("names %s from the call path", (provider, name) => {
		expect(
			imageGenerationErrorMessage(
				{ statusCode: 401, provider: "sk-example-not-a-real-key" },
				provider,
			),
		).toBe(
			`${name} rejected the organization's credentials. Check Settings → AI Providers.`,
		);
	});

	it("unwraps a retry's lastError instead of using an earlier status or wrapper text", () => {
		const lastError = new APICallError({
			message: "sk-example-not-a-real-key",
			url: "https://example.com",
			requestBodyValues: {},
			statusCode: 429,
		});
		const retry = new RetryError({
			message: "401 sk-example-not-a-real-key",
			reason: "maxRetriesExceeded",
			errors: [{ statusCode: 401 }, lastError],
		});
		expect(
			imageGenerationErrorMessage(
				new Error("private wrapper", { cause: retry }),
				"gateway",
			),
		).toBe(
			"Vercel AI Gateway rate limit or quota reached. Try again later.",
		);
	});

	it("reads the Google GenAI structured status", () => {
		expect(
			imageGenerationErrorMessage(
				{ status: 403, message: "private request" },
				"gemini",
			),
		).toBe(
			"Gemini rejected the organization's credentials. Check Settings → AI Providers.",
		);
	});

	it("stops at a repeated cause without reading it again", () => {
		let reads = 0;
		const error = {
			get cause(): unknown {
				if (++reads > 1) {
					throw new Error("cycle was traversed again");
				}
				return error;
			},
		};
		expect(imageGenerationErrorMessage(error, "local")).toBe(
			"Local image server image generation failed. Try again.",
		);
	});
});

describe("image credential error classification", () => {
	it("preserves the safe typed Databricks token-exchange message", () => {
		expect(
			imageCredentialErrorMessage(
				new DatabricksOAuthError(
					"Databricks service-principal token exchange failed (status 401).",
					{ status: 401 },
				),
			),
		).toBe(
			"Databricks service-principal token exchange failed (status 401).",
		);
	});
	it.each([
		null,
		undefined,
		"sk-example-not-a-real-key",
		new Error("sk-example-not-a-real-key"),
		{
			name: "DatabricksOAuthError",
			status: 401,
			message: "sk-example-not-a-real-key",
		},
	])("rejects untrusted credential error copy: %j", (error) => {
		expect(imageCredentialErrorMessage(error)).toBe(
			"Couldn't load the organization's AI provider credentials. Check Settings → AI Providers.",
		);
	});
});
