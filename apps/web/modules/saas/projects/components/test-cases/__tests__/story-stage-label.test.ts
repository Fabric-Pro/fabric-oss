import { describe, expect, it } from "vitest";
import { DRAFTING_STAGE_META } from "../../../lib/stories/types";
import { featureStageLabel } from "../story-stage-label";

describe("featureStageLabel", () => {
	it("resolves a stage through the roadmap's own vocabulary", () => {
		expect(featureStageLabel("PUBLISHED")).toBe(
			DRAFTING_STAGE_META.PUBLISHED.label,
		);
		expect(featureStageLabel("DRAFT")).toBe(
			DRAFTING_STAGE_META.DRAFT.label,
		);
	});

	it("returns null for PASSIVE_ANALYSIS — a DB-only stage the front-end union dropped", () => {
		// The coverage API returns the DATABASE enum, which still carries this
		// legacy value. A direct map lookup would yield undefined and crash the
		// row on `.label`; the caller renders no chip instead.
		expect(featureStageLabel("PASSIVE_ANALYSIS")).toBeNull();
	});

	it("returns null for a stage added to the schema but unknown here", () => {
		expect(featureStageLabel("SOME_FUTURE_STAGE")).toBeNull();
	});
});
