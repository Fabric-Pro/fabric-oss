import { describe, expect, it } from "vitest";
import { AI_FEATURE_KEYS, featureKeyForAgentId } from "../lib/feature-keys";

describe("draft feature keys", () => {
	it("maps prompt enhancement usage including suffixed calls", () => {
		expect(AI_FEATURE_KEYS).toContain("prompt-enhancement");
		expect(featureKeyForAgentId("prompt_enhancer")).toBe(
			"prompt-enhancement",
		);
		expect(featureKeyForAgentId("prompt_enhancer:retry")).toBe(
			"prompt-enhancement",
		);
	});
	it("keeps the document agent mapping and leaves dynamic agents unmapped", () => {
		expect(featureKeyForAgentId("project_document_generator")).toBe(
			"document-generation",
		);
		expect(AI_FEATURE_KEYS).toContain("agent-document-generation");
		expect(featureKeyForAgentId("document_generator")).toBeUndefined();
		expect(featureKeyForAgentId("example-agent")).toBeUndefined();
	});
});
