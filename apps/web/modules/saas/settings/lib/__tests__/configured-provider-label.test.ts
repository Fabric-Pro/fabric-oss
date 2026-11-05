import { describe, expect, it } from "vitest";
import { getConfiguredProviderLabel } from "../ai-providers";

describe("configured provider identity", () => {
	it("retains the vendor identity when a saved connection has an unrelated custom name", () => {
		expect(
			getConfiguredProviderLabel(
				"OPENAI_DIRECT",
				"Example development connection",
			),
		).toBe("OpenAI · Example development connection");
	});
	it("does not repeat a canonical name", () => {
		expect(getConfiguredProviderLabel("OPENAI_DIRECT", " OpenAI ")).toBe(
			"OpenAI",
		);
	});
	it("handles unnamed and newly introduced providers without hiding their identity", () => {
		expect(getConfiguredProviderLabel("OPENAI_DIRECT", null)).toBe(
			"OpenAI",
		);
		expect(
			getConfiguredProviderLabel(
				"EXAMPLE_PROVIDER",
				"Example connection",
			),
		).toBe("EXAMPLE PROVIDER · Example connection");
	});
});
