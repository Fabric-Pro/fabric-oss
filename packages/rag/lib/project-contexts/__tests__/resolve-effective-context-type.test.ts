import { describe, expect, it } from "vitest";
import { resolveEffectiveContextType } from "../retrieval";

describe("resolveEffectiveContextType", () => {
	it("labels a Confluence INTEGRATION context as CONFLUENCE_DOCUMENT", () => {
		expect(
			resolveEffectiveContextType("INTEGRATION", {
				provider: "confluence",
			}),
		).toBe("CONFLUENCE_DOCUMENT");
	});

	it("matches the lowercase provider exactly (no uppercasing)", () => {
		expect(
			resolveEffectiveContextType("INTEGRATION", {
				provider: "CONFLUENCE",
			}),
		).toBe("INTEGRATION");
	});

	it("preserves the existing provider labels", () => {
		expect(
			resolveEffectiveContextType("INTEGRATION", { provider: "notion" }),
		).toBe("NOTION_DOCUMENT");
		expect(
			resolveEffectiveContextType("INTEGRATION", {
				provider: "MICROSOFT_TEAMS",
			}),
		).toBe("TEAMS_CHAT");
		expect(
			resolveEffectiveContextType("INTEGRATION", { provider: "SLACK" }),
		).toBe("SLACK_CHANNEL");
		expect(
			resolveEffectiveContextType("TEXT", { provider: "CODE_ANALYSIS" }),
		).toBe("CODE_ANALYSIS");
	});

	it("falls back to the raw type for unknown providers or missing metadata", () => {
		expect(
			resolveEffectiveContextType("INTEGRATION", { provider: "jira" }),
		).toBe("INTEGRATION");
		expect(resolveEffectiveContextType("FILE", null)).toBe("FILE");
		expect(resolveEffectiveContextType("TEXT", undefined)).toBe("TEXT");
	});
});
