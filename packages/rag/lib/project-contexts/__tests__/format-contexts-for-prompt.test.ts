import { describe, expect, it } from "vitest";
import {
	contextMetaHeader,
	formatContextsForPrompt,
	type RetrievedContext,
} from "../retrieval";

describe("contextMetaHeader", () => {
	it("returns empty string when no metadata, sourceType, or aiInstructions are present", () => {
		expect(contextMetaHeader({})).toBe("");
		expect(
			contextMetaHeader({
				sourceType: null,
				aiInstructions: null,
				metadata: { roleTag: null },
			}),
		).toBe("");
	});

	it("renders [Repository role: <tag>] when roleTag is present in metadata", () => {
		expect(
			contextMetaHeader({
				metadata: { roleTag: "Legacy" },
			}),
		).toBe("[Repository role: Legacy]\n");
		expect(
			contextMetaHeader({
				metadata: { roleTag: "Primary Auth" },
			}),
		).toBe("[Repository role: Primary Auth]\n");
	});

	it("returns empty string when roleTag is empty string or whitespace", () => {
		expect(contextMetaHeader({ metadata: { roleTag: "" } })).toBe("");
		expect(contextMetaHeader({ metadata: { roleTag: "   " } })).toBe("");
	});

	it("renders composition in stable order: identity/role -> type -> guidance", () => {
		const result = contextMetaHeader({
			metadata: { roleTag: "Legacy Monolith" },
			sourceType: "Architecture Spec",
			aiInstructions: "Use this to understand deprecated endpoints",
		});

		expect(result).toBe(
			"[Repository role: Legacy Monolith]\n[Source type: Architecture Spec]\n[Source guidance: Use this to understand deprecated endpoints]\n",
		);
	});
});

describe("formatContextsForPrompt", () => {
	it("returns empty string when context array is empty", () => {
		expect(formatContextsForPrompt([])).toBe("");
	});

	it("formats context without roleTag prefix when roleTag is absent", () => {
		const contexts: RetrievedContext[] = [
			{
				id: "ctx-1",
				type: "CODE_ANALYSIS",
				content: "function hello() {}",
				score: 0.95,
				filename: "main.ts",
			},
		];

		const result = formatContextsForPrompt(contexts);

		expect(result).toContain(
			"--- main.ts (CODE_ANALYSIS, relevance: 95.0%) ---",
		);
		expect(result).toContain("function hello() {}");
		expect(result).not.toContain("Legacy:");
		expect(result).not.toContain("New:");
	});

	it("injects roleTag prefix (e.g., 'Legacy: ') when roleTag is present in metadata", () => {
		const contexts: RetrievedContext[] = [
			{
				id: "ctx-legacy",
				type: "CODE_ANALYSIS",
				content: "function oldCalc() {}",
				score: 0.92,
				filename: "example-org/app-v1/billing.ts",
				metadata: { roleTag: "Legacy" },
			},
			{
				id: "ctx-new",
				type: "CODE_ANALYSIS",
				content: "function newCalc() {}",
				score: 0.88,
				filename: "example-org/app-v2/billing.ts",
				metadata: { roleTag: "New" },
			},
		];

		const result = formatContextsForPrompt(contexts);

		expect(result).toContain(
			"--- Legacy: example-org/app-v1/billing.ts (CODE_ANALYSIS, relevance: 92.0%) ---",
		);
		expect(result).toContain(
			"--- New: example-org/app-v2/billing.ts (CODE_ANALYSIS, relevance: 88.0%) ---",
		);
		expect(result).toContain("function oldCalc() {}");
		expect(result).toContain("function newCalc() {}");
	});

	it("handles multiple contexts with custom multi-word roleTag values", () => {
		const contexts: RetrievedContext[] = [
			{
				id: "ctx-ref-1",
				type: "CODE_ANALYSIS",
				content: "const REF_V1 = 1;",
				score: 0.9,
				filename: "v1-config.ts",
				metadata: { roleTag: "V1 Reference" },
			},
			{
				id: "ctx-ref-2",
				type: "CODE_ANALYSIS",
				content: "const REF_V2 = 2;",
				score: 0.85,
				filename: "v2-config.ts",
				metadata: { roleTag: "Experimental Sandbox" },
			},
		];

		const result = formatContextsForPrompt(contexts);

		expect(result).toContain(
			"--- V1 Reference: v1-config.ts (CODE_ANALYSIS, relevance: 90.0%) ---",
		);
		expect(result).toContain(
			"--- Experimental Sandbox: v2-config.ts (CODE_ANALYSIS, relevance: 85.0%) ---",
		);
	});
});
