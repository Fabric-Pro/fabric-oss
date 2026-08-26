/**
 * Tests for the shared document-version authorship resolver.
 *
 * Run with:
 *   pnpm --filter @repo/utils test lib/document-version-author.test.ts
 */

import { describe, expect, it } from "vitest";
import {
	AI_REFRESH_AUTHOR_ID,
	AI_REFRESH_AUTHOR_NAME,
	isAiRefreshAuthor,
	resolveDocumentVersionAuthor,
	UNKNOWN_AUTHOR_NAME,
} from "./document-version-author";

describe("AI_REFRESH_AUTHOR_ID", () => {
	it("is namespaced so it can never collide with a cuid user id", () => {
		// The whole design rests on this: `changedBy` has no FK, so a sentinel
		// and a real user id share one column and must stay distinguishable.
		expect(AI_REFRESH_AUTHOR_ID).toBe("agent:living-docs-refresh");
		expect(AI_REFRESH_AUTHOR_ID).toContain(":");
	});

	it("has a named identity, not a generic system label (R13)", () => {
		expect(AI_REFRESH_AUTHOR_NAME).toBe("Fabric Refresh Agent");
		expect(AI_REFRESH_AUTHOR_NAME.toLowerCase()).not.toBe("system");
	});
});

describe("isAiRefreshAuthor", () => {
	it("recognizes the sentinel", () => {
		expect(isAiRefreshAuthor(AI_REFRESH_AUTHOR_ID)).toBe(true);
	});

	it("rejects a real user id, null, and undefined", () => {
		expect(isAiRefreshAuthor("clx123abc456")).toBe(false);
		expect(isAiRefreshAuthor(null)).toBe(false);
		expect(isAiRefreshAuthor(undefined)).toBe(false);
	});

	it("does not match on a near-miss string", () => {
		expect(isAiRefreshAuthor("agent:living-docs-refresh ")).toBe(false);
		expect(isAiRefreshAuthor("agent:some-other-agent")).toBe(false);
	});
});

describe("resolveDocumentVersionAuthor", () => {
	it("resolves a real user id to that user's name, flagged HUMAN", () => {
		expect(
			resolveDocumentVersionAuthor("user-1", {
				name: "Ada Lovelace",
				email: "ada@example.test",
			}),
		).toEqual({ kind: "HUMAN", name: "Ada Lovelace" });
	});

	it("resolves the sentinel to the refresh agent, flagged AI_AGENT", () => {
		expect(resolveDocumentVersionAuthor(AI_REFRESH_AUTHOR_ID)).toEqual({
			kind: "AI_AGENT",
			name: AI_REFRESH_AUTHOR_NAME,
		});
	});

	it("ignores a user row passed alongside the sentinel", () => {
		// Defensive: the agent has no user row, so a match here would mean a
		// human's id collided with the sentinel. Kind must still be AI_AGENT.
		expect(
			resolveDocumentVersionAuthor(AI_REFRESH_AUTHOR_ID, {
				name: "Impostor",
			}),
		).toEqual({ kind: "AI_AGENT", name: AI_REFRESH_AUTHOR_NAME });
	});

	it("returns null for a legacy row with no recorded author", () => {
		expect(resolveDocumentVersionAuthor(null)).toBeNull();
		expect(resolveDocumentVersionAuthor(undefined)).toBeNull();
		expect(resolveDocumentVersionAuthor("")).toBeNull();
	});

	it("falls back to a neutral name for a deleted user — never the raw id", () => {
		const rawId = "clxdeleted000000000";

		const author = resolveDocumentVersionAuthor(rawId, null);

		expect(author).toEqual({ kind: "HUMAN", name: UNKNOWN_AUTHOR_NAME });
		expect(author?.name).not.toContain(rawId);
	});

	it("falls back to email when the user's name is blank", () => {
		expect(
			resolveDocumentVersionAuthor("user-1", {
				name: "   ",
				email: "ada@example.test",
			}),
		).toEqual({ kind: "HUMAN", name: "ada@example.test" });
	});

	it("falls back to the neutral name when both name and email are unusable", () => {
		expect(
			resolveDocumentVersionAuthor("user-1", { name: "", email: null }),
		).toEqual({ kind: "HUMAN", name: UNKNOWN_AUTHOR_NAME });
	});

	it("trims surrounding whitespace from a display name", () => {
		expect(
			resolveDocumentVersionAuthor("user-1", {
				name: "  Grace Hopper  ",
			}),
		).toEqual({ kind: "HUMAN", name: "Grace Hopper" });
	});
});
