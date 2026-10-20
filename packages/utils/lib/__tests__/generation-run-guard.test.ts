import { describe, expect, it } from "vitest";
import {
	isGenerationOwnedStatus,
	isRunGuardedDocumentType,
} from "../generation-run-guard";

describe("isRunGuardedDocumentType", () => {
	it("guards a Proposal, with no rollout gate to consult", () => {
		expect(isRunGuardedDocumentType("PROPOSAL")).toBe(true);
	});

	it.each(["PRD", "SRS", "BUSINESS_CASE", "INTEGRATION_CONTRACT", ""])(
		"leaves %s unguarded",
		(type) => {
			expect(isRunGuardedDocumentType(type)).toBe(false);
		},
	);
});

describe("isGenerationOwnedStatus", () => {
	it.each(["QUEUED", "GENERATING"])(
		"reserves %s for generation runs",
		(status) => {
			expect(isGenerationOwnedStatus(status)).toBe(true);
		},
	);

	it.each(["DRAFT", "COMPLETE", "FAILED", undefined, null])(
		"lets a caller send %s",
		(status) => {
			expect(isGenerationOwnedStatus(status)).toBe(false);
		},
	);
});
