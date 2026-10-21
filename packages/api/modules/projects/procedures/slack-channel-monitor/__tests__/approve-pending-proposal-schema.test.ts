/**
 * Smoke tests for the Slack approve-pending-proposal input schema — covers
 * the kindOverride safety-net field added by the AI Update type-selector PR.
 *
 * Parses through the shared `changeItemSchema` the procedure imports, so a
 * change to that schema (e.g., dropping `slack_messages` from sourceContext)
 * fails here. The procedure-level parse is covered in
 * `approve-pending-proposal-pm-sync.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { changeItemSchema } from "../../backlog/change-item-schema";

const baseCreate = {
	type: "bug" as const,
	action: "create" as const,
	title: { to: "Login crashes on Safari 17" },
	reasoning: "Test fixture",
	sourceContext: "slack_messages" as const,
};

describe("Slack approve-pending-proposal changeItemSchema — kindOverride", () => {
	it("accepts the slack_messages source context (Slack-specific)", () => {
		expect(() => changeItemSchema.parse(baseCreate)).not.toThrow();
	});

	it("accepts kindOverride omitted (no-override case keeps legacy behavior)", () => {
		const parsed = changeItemSchema.parse(baseCreate);
		expect(parsed.kindOverride).toBeUndefined();
	});

	it("accepts kindOverride='FEATURE' (bug → feature correction)", () => {
		const parsed = changeItemSchema.parse({
			...baseCreate,
			kindOverride: "FEATURE",
		});
		expect(parsed.kindOverride).toBe("FEATURE");
	});

	it("accepts kindOverride='BUG' (feature → bug correction)", () => {
		const parsed = changeItemSchema.parse({
			...baseCreate,
			type: "feature",
			kindOverride: "BUG",
		});
		expect(parsed.kindOverride).toBe("BUG");
	});

	it("rejects kindOverride='USER_STORY' (Story retirement DSU 2026-05-23)", () => {
		expect(() =>
			changeItemSchema.parse({
				...baseCreate,
				kindOverride: "USER_STORY",
			}),
		).toThrow(z.ZodError);
	});

	it("rejects an arbitrary string kindOverride", () => {
		expect(() =>
			changeItemSchema.parse({
				...baseCreate,
				kindOverride: "TASK",
			}),
		).toThrow(z.ZodError);
	});

	it("legacy 'story' type parses (backward compat for in-flight proposals)", () => {
		expect(() =>
			changeItemSchema.parse({
				...baseCreate,
				type: "story",
			}),
		).not.toThrow();
	});
});
