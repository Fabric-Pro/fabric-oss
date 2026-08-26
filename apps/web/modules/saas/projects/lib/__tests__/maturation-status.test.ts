import { describe, expect, it } from "vitest";
import type { FeatureDraftingStage } from "../stories/types";
import {
	buildMaturationStatusMutationPayload,
	coverageBlockedToastMessage,
	deriveMaturationStatus,
	getMaturationStatus,
	MATURATION_STATUS_META,
} from "../stories/types";

/**
 * The derive mapping is the client-side mirror of the backfill in the migration
 * `20260625120000_add_maturation_status`. If this table changes, the migration's
 * CASE must change too — a backfilled row and a derived-null row must never
 * disagree.
 */
const EXPECTED: Record<
	FeatureDraftingStage,
	ReturnType<typeof deriveMaturationStatus>
> = {
	PLACEHOLDER: "TO_DO",
	DECLINED: "TO_DO",
	ACTIVE_ANALYSIS: "DISCOVERY",
	SANITY_CHECK: "DISCOVERY",
	DRAFT: "DISCOVERY",
	PUBLISHED: "DONE",
	CLOSED: "DONE",
};

describe("MATURATION_STATUS_META", () => {
	it("provides correct label for DONE status", () => {
		expect(MATURATION_STATUS_META.DONE.label).toBe("Requirements Complete");
	});
});

describe("deriveMaturationStatus", () => {
	it("maps every drafting stage to its migration-backfill bucket", () => {
		for (const [stage, expected] of Object.entries(EXPECTED)) {
			expect(deriveMaturationStatus(stage as FeatureDraftingStage)).toBe(
				expected,
			);
		}
	});
});

describe("getMaturationStatus", () => {
	it("returns the explicit status when set", () => {
		expect(
			getMaturationStatus({
				maturationStatus: "DONE",
				draftingStage: "PLACEHOLDER",
			}),
		).toBe("DONE");
	});

	it("falls back to the derived label when status is null", () => {
		expect(
			getMaturationStatus({
				maturationStatus: null,
				draftingStage: "ACTIVE_ANALYSIS",
			}),
		).toBe("DISCOVERY");
	});

	it("falls back to the derived label when status is undefined", () => {
		expect(getMaturationStatus({ draftingStage: "PUBLISHED" })).toBe(
			"DONE",
		);
	});
});

describe("buildMaturationStatusMutationPayload", () => {
	it("omits maturationStatus when hiding", () => {
		const payload = buildMaturationStatusMutationPayload({
			mode: "hide",
		});

		expect(payload).toStrictEqual({
			draftingStage: "CLOSED",
		});
	});

	it("sets draftingStage to DRAFT when un-hiding a story", () => {
		const payload = buildMaturationStatusMutationPayload({
			mode: "set",
			targetMaturationStatus: "DONE",
			isCurrentlyClosed: true,
		});

		expect(payload).toEqual({
			maturationStatus: "DONE",
			draftingStage: "DRAFT",
		});
	});

	it("does not set draftingStage when changing status on an active story", () => {
		const payload = buildMaturationStatusMutationPayload({
			mode: "set",
			targetMaturationStatus: "DISCOVERY",
			isCurrentlyClosed: false,
		});

		expect(payload).toEqual({
			maturationStatus: "DISCOVERY",
		});
	});
});

describe("coverageBlockedToastMessage", () => {
	it("returns actionable guidance when error is COVERAGE_BELOW_TARGET", () => {
		const error = { data: { errorCode: "COVERAGE_BELOW_TARGET" } };
		expect(coverageBlockedToastMessage(error)).toBe(
			"Test coverage is below this project's target. Open the feature to record a reason and mark it Requirements Complete.",
		);
	});

	it("returns null for other error codes", () => {
		const error = { data: { errorCode: "FORBIDDEN" } };
		expect(coverageBlockedToastMessage(error)).toBeNull();
	});

	it("returns null for non-object or missing data errors", () => {
		expect(
			coverageBlockedToastMessage(new Error("Generic error")),
		).toBeNull();
		expect(coverageBlockedToastMessage(null)).toBeNull();
		expect(coverageBlockedToastMessage(undefined)).toBeNull();
	});
});
