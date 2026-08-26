import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";
import {
	FEATURE_ONLY_STAGES,
	validateStageForKind,
} from "../validate-stage-for-kind";

// Spec: fabric/specs/2026-05-19-remove-passive-analysis/spec.md §12.2 test #1.
// Asserts the FEATURE_ONLY_STAGES set no longer contains PASSIVE_ANALYSIS
// (REQ-4) and that the cross-column validator still rejects feature-only
// stages on BUG stories.
describe("validate-stage-for-kind", () => {
	describe("FEATURE_ONLY_STAGES", () => {
		it("does NOT contain PASSIVE_ANALYSIS (post spec 2026-05-19)", () => {
			// PASSIVE_ANALYSIS soft-deprecated; the validator must NOT reject
			// it for BUG stories (because the value is no longer feature-only
			// — it's a historical-only value with no UI affordance to create).
			expect(FEATURE_ONLY_STAGES.has("PASSIVE_ANALYSIS")).toBe(false);
		});

		it("still contains ACTIVE_ANALYSIS", () => {
			expect(FEATURE_ONLY_STAGES.has("ACTIVE_ANALYSIS")).toBe(true);
		});

		it("still contains SANITY_CHECK", () => {
			expect(FEATURE_ONLY_STAGES.has("SANITY_CHECK")).toBe(true);
		});
	});

	describe("validateStageForKind", () => {
		it("does NOT throw for PLACEHOLDER + BUG (shared stage)", () => {
			expect(() =>
				validateStageForKind("PLACEHOLDER", "BUG"),
			).not.toThrow();
		});

		it("does NOT throw for PASSIVE_ANALYSIS + BUG (no longer feature-only)", () => {
			// Historical-row safety: if a BUG ever ended up at PASSIVE_ANALYSIS
			// (it shouldn't, but the value is still in the enum per OQ-1),
			// the validator must not reject it.
			expect(() =>
				validateStageForKind("PASSIVE_ANALYSIS", "BUG"),
			).not.toThrow();
		});

		it("throws BAD_REQUEST for ACTIVE_ANALYSIS + BUG (feature-only)", () => {
			expect(() =>
				validateStageForKind("ACTIVE_ANALYSIS", "BUG"),
			).toThrow(ORPCError);
		});

		it("throws BAD_REQUEST for SANITY_CHECK + BUG (feature-only)", () => {
			expect(() => validateStageForKind("SANITY_CHECK", "BUG")).toThrow(
				ORPCError,
			);
		});

		it("does NOT throw for any stage + FEATURE", () => {
			expect(() =>
				validateStageForKind("PLACEHOLDER", "FEATURE"),
			).not.toThrow();
			expect(() =>
				validateStageForKind("ACTIVE_ANALYSIS", "FEATURE"),
			).not.toThrow();
			expect(() =>
				validateStageForKind("SANITY_CHECK", "FEATURE"),
			).not.toThrow();
			expect(() =>
				validateStageForKind("DRAFT", "FEATURE"),
			).not.toThrow();
			expect(() =>
				validateStageForKind("PUBLISHED", "FEATURE"),
			).not.toThrow();
		});
	});
});
