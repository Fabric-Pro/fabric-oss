import { describe, expect, it } from "vitest";
import {
	cleanSpecAgentForKind,
	resolveStoryKind,
	storyKindWord,
} from "../src/lib/clean-spec-agent-for-kind";

describe("clean-spec-agent-for-kind", () => {
	it("resolves INITIATIVE kind, agent, and word correctly", () => {
		expect(resolveStoryKind("INITIATIVE")).toBe("INITIATIVE");
		expect(cleanSpecAgentForKind("INITIATIVE")).toBe(
			"initiative_clean_spec_generator",
		);
		expect(storyKindWord("INITIATIVE")).toBe("initiative");
	});

	it("resolves BUG kind, agent, and word correctly", () => {
		expect(resolveStoryKind("BUG")).toBe("BUG");
		expect(cleanSpecAgentForKind("BUG")).toBe("bug_clean_spec_generator");
		expect(storyKindWord("BUG")).toBe("bug");
	});

	it("resolves FEATURE kind, agent, and word correctly", () => {
		expect(resolveStoryKind("FEATURE")).toBe("FEATURE");
		expect(cleanSpecAgentForKind("FEATURE")).toBe(
			"feature_clean_spec_generator",
		);
		expect(storyKindWord("FEATURE")).toBe("feature");
	});

	it("falls back to FEATURE for null or undefined", () => {
		expect(resolveStoryKind(null)).toBe("FEATURE");
		expect(resolveStoryKind(undefined)).toBe("FEATURE");
		expect(cleanSpecAgentForKind(null)).toBe(
			"feature_clean_spec_generator",
		);
		expect(cleanSpecAgentForKind(undefined)).toBe(
			"feature_clean_spec_generator",
		);
		expect(storyKindWord(null)).toBe("feature");
		expect(storyKindWord(undefined)).toBe("feature");
	});
});
