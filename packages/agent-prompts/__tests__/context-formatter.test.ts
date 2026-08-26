/**
 * Tests for formatContextAvailability in context-formatter.ts
 *
 * Verifies the prompt-level context availability formatting including
 * authoritative source guidance, synthesis instructions, and transparency.
 *
 * Run with: pnpm --filter @repo/agent-prompts test
 */

import { describe, expect, it } from "vitest";
import {
	type ContextAvailability,
	formatContextAvailability,
} from "../src/builders/context-formatter";

const allConnected: ContextAvailability = {
	hasCodebase: true,
	transcriptCount: 3,
	fileCount: 5,
	integrationCount: 4,
	teamsCount: 2,
	slackCount: 1,
};

const nothingConnected: ContextAvailability = {
	hasCodebase: false,
	transcriptCount: 0,
	fileCount: 0,
	integrationCount: 0,
	teamsCount: 0,
	slackCount: 0,
};

describe("formatContextAvailability", () => {
	describe("availability listing", () => {
		it("should list all available sources", () => {
			const text = formatContextAvailability(allConnected);
			expect(text).toContain("AVAILABLE:");
			expect(text).toContain("Codebase analysis");
			expect(text).toContain("Meeting transcripts (3 synced)");
			expect(text).toContain("Project files and documents (5)");
			expect(text).toContain("Teams chat conversations");
			expect(text).toContain("Slack channel conversations");
		});

		it("should list all unavailable sources", () => {
			const text = formatContextAvailability(nothingConnected);
			expect(text).toContain("NOT AVAILABLE:");
			expect(text).toContain("Codebase");
			expect(text).toContain("Meeting transcripts (none synced)");
			expect(text).toContain("Teams chat (not connected)");
			expect(text).toContain("Slack chat (not connected)");
		});
	});

	describe("authoritative source guidance", () => {
		it("should include codebase authority guidance when codebase available", () => {
			const text = formatContextAvailability(allConnected);
			expect(text).toContain("MOST AUTHORITATIVE source");
			expect(text).toContain("defer to the code");
		});

		it("should NOT include codebase authority guidance when codebase unavailable", () => {
			const text = formatContextAvailability(nothingConnected);
			expect(text).not.toContain("MOST AUTHORITATIVE");
		});
	});

	describe("synthesis guidance", () => {
		it("should include synthesis guidance when transcripts available", () => {
			const text = formatContextAvailability({
				...nothingConnected,
				transcriptCount: 2,
			});
			expect(text).toContain("synthesize");
			expect(text).toContain("coherent answer");
		});

		it("should NOT include synthesis guidance when no transcripts", () => {
			const text = formatContextAvailability({
				...nothingConnected,
				hasCodebase: true,
			});
			expect(text).not.toContain("synthesize");
		});
	});

	describe("document generation guidance", () => {
		it("should always include document generation guidance", () => {
			const text = formatContextAvailability(nothingConnected);
			expect(text).toContain("Document Generation");
			expect(text).toContain("conflict");
		});
	});

	describe("transparency guidance", () => {
		it("should always include transparency guidance", () => {
			const text = formatContextAvailability(nothingConnected);
			expect(text).toContain("Transparency");
			expect(text).toContain("Do NOT fabricate");
		});
	});

	describe("integration count math", () => {
		it("should correctly subtract Teams/Slack from total integrations", () => {
			const text = formatContextAvailability({
				...nothingConnected,
				integrationCount: 5,
				teamsCount: 2,
				slackCount: 1,
			});
			// 5 - 2 - 1 = 2 other
			expect(text).toContain("Other integrations (2 sources)");
		});

		it("should handle multiple Teams chats correctly", () => {
			const text = formatContextAvailability({
				...nothingConnected,
				integrationCount: 3,
				teamsCount: 3,
				slackCount: 0,
			});
			// 3 - 3 - 0 = 0 other → should not show
			expect(text).not.toContain("Other integrations");
		});

		it("should not show other integrations when count is zero", () => {
			const text = formatContextAvailability({
				...nothingConnected,
				integrationCount: 1,
				teamsCount: 1,
				slackCount: 0,
			});
			expect(text).not.toContain("Other integrations");
		});
	});
});
