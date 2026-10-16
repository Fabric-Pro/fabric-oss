/**
 * Proposal artifact (Fizzy #2946) — the analysis prompt's finding vocabulary
 * stores as the browser-safe copy in `@repo/utils`.
 *
 * The prompt names severities and types in words (`Blocking`,
 * `Source Validation`); the worker stores them as the enum values the
 * analysis tab groups and labels by (`BLOCKING`, `SOURCE_VALIDATION`). The
 * tuples cannot be equal, so parity is asserted through the worker's own
 * mapping: each prompt name, stored, gives the utils value at the same
 * position, and both lists are the same length. A name added, removed,
 * renamed or reordered on either side fails here.
 */

import {
	PROPOSAL_FINDING_SEVERITIES as SHARED_SEVERITIES,
	PROPOSAL_FINDING_TYPES as SHARED_TYPES,
} from "@repo/utils/proposal-artifact/finding-state";
import { buildSectionMap } from "@repo/utils/proposal-artifact/section-hash";
import { describe, expect, it } from "vitest";
import {
	type FindingResolution,
	type ModelFinding,
	toStoredFindings,
} from "../findings";
import { PROPOSAL_FINDING_SEVERITIES, PROPOSAL_FINDING_TYPES } from "../types";

const RESOLUTION: FindingResolution = {
	sectionMap: buildSectionMap("# Example Proposal\n\nOpening text."),
	listedSections: [],
	citableSources: new Set(),
};

/** A model finding with its own subject, so no two of them fold together. */
function modelFinding(
	index: number,
	overrides: Partial<ModelFinding>,
): ModelFinding {
	return {
		severity: "Important",
		type: "Scope",
		title: `Finding ${index}`,
		subject: `subject ${index}`,
		detail: `Detail of finding ${index}.`,
		recommendation: null,
		sectionIndex: null,
		sectionHeading: null,
		sourceRefs: null,
		...overrides,
	};
}

describe("proposal finding vocabulary parity with @repo/utils", () => {
	it("stores the prompt's severities as the shared ones, in the same order", () => {
		const { findings } = toStoredFindings(
			PROPOSAL_FINDING_SEVERITIES.map((severity, index) =>
				modelFinding(index, { severity }),
			),
			RESOLUTION,
		);

		expect(PROPOSAL_FINDING_SEVERITIES).toHaveLength(
			SHARED_SEVERITIES.length,
		);
		expect(findings.map((finding) => finding.severity)).toEqual([
			...SHARED_SEVERITIES,
		]);
	});

	it("stores the prompt's finding types as the shared ones, in the same order", () => {
		const { findings } = toStoredFindings(
			PROPOSAL_FINDING_TYPES.map((type, index) =>
				modelFinding(index, { type }),
			),
			RESOLUTION,
		);

		expect(PROPOSAL_FINDING_TYPES).toHaveLength(SHARED_TYPES.length);
		expect(findings.map((finding) => finding.type)).toEqual([
			...SHARED_TYPES,
		]);
	});
});
