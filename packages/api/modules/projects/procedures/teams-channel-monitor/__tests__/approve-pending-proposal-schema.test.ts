/**
 * Smoke tests for the Teams approve-pending-proposal input schema — covers
 * the kindOverride safety-net field added by the AI Update type-selector PR.
 *
 * Parses through the shared `changeItemSchema` the procedure imports, so the
 * test exercises the real schema without the dependency on
 * `tenantProtectedProcedure` infrastructure.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { changeItemSchema } from "../../backlog/change-item-schema";

const baseCreate = {
	type: "bug" as const,
	action: "create" as const,
	title: { to: "Add SSO" },
	reasoning: "Test fixture",
	sourceContext: "teams_messages" as const,
};

describe("Teams approve-pending-proposal changeItemSchema — kindOverride", () => {
	it("accepts kindOverride omitted (no-override case keeps legacy behavior)", () => {
		expect(() => changeItemSchema.parse(baseCreate)).not.toThrow();
		expect(changeItemSchema.parse(baseCreate).kindOverride).toBeUndefined();
	});

	it("accepts kindOverride='BUG'", () => {
		const parsed = changeItemSchema.parse({
			...baseCreate,
			kindOverride: "BUG",
		});
		expect(parsed.kindOverride).toBe("BUG");
	});

	it("accepts kindOverride='FEATURE'", () => {
		const parsed = changeItemSchema.parse({
			...baseCreate,
			kindOverride: "FEATURE",
		});
		expect(parsed.kindOverride).toBe("FEATURE");
	});

	it("accepts kindOverride=null (treated as no override server-side)", () => {
		const parsed = changeItemSchema.parse({
			...baseCreate,
			kindOverride: null,
		});
		expect(parsed.kindOverride).toBeNull();
	});

	it("rejects kindOverride='USER_STORY' (Story type was retired)", () => {
		// DSU 2026-05-23 retirement of Story — the override picker must never
		// offer USER_STORY. Server-side rejection is the second line of defense.
		expect(() =>
			changeItemSchema.parse({
				...baseCreate,
				kindOverride: "USER_STORY",
			}),
		).toThrow(z.ZodError);
	});

	it("rejects kindOverride='Bug' (case-sensitive — must be upper)", () => {
		expect(() =>
			changeItemSchema.parse({
				...baseCreate,
				kindOverride: "Bug",
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

	it("legacy 'story' type still parses (backward compat for in-flight proposals)", () => {
		// Pre-DSU-2026-05-23 proposals stored as JSON may carry type:'story'.
		// We keep the inbound schema permissive so they can still be approved
		// and applied — only the analyzer prompt is locked down.
		expect(() =>
			changeItemSchema.parse({
				...baseCreate,
				type: "story",
			}),
		).not.toThrow();
	});
});
