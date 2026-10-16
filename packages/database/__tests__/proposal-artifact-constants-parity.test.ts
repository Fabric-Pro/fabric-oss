/**
 * Proposal artifact (Fizzy #2946) — the stored finding vocabulary and the
 * answer limit agree with the browser-safe copy in `@repo/utils`.
 *
 * The analysis tab groups findings by `PROPOSAL_FINDING_SEVERITIES` and
 * labels them by `PROPOSAL_FINDING_TYPES` from `@repo/utils`, and its answer
 * field stops at `FINDING_ANSWER_MAX_LENGTH`; the browser bundle must not
 * import this package. These assertions fail the moment either side changes
 * a value, its order, or the limit without the other.
 */

import {
	FINDING_ANSWER_MAX_LENGTH,
	FINDING_RESPONSE_KINDS,
	PROPOSAL_FINDING_SEVERITIES as SHARED_SEVERITIES,
	PROPOSAL_FINDING_TYPES as SHARED_TYPES,
} from "@repo/utils/proposal-artifact/finding-state";
import { describe, expect, it } from "vitest";
import {
	PROPOSAL_FINDING_RESPONSE_KINDS,
	PROPOSAL_FINDING_RESPONSE_TEXT_MAX_LENGTH,
	PROPOSAL_FINDING_SEVERITIES,
	PROPOSAL_FINDING_TYPES,
} from "../prisma/queries/projects/proposal-artifact-shared";

describe("proposal finding vocabulary parity with @repo/utils", () => {
	it("stores the same severities, worst first", () => {
		expect([...PROPOSAL_FINDING_SEVERITIES]).toEqual([
			...SHARED_SEVERITIES,
		]);
	});

	it("stores the same finding types, in the same order", () => {
		expect([...PROPOSAL_FINDING_TYPES]).toEqual([...SHARED_TYPES]);
	});

	it("stores the same answer kinds", () => {
		expect([...PROPOSAL_FINDING_RESPONSE_KINDS]).toEqual([
			...FINDING_RESPONSE_KINDS,
		]);
	});

	it("refuses answers at the same length the answer field stops at", () => {
		expect(PROPOSAL_FINDING_RESPONSE_TEXT_MAX_LENGTH).toBe(
			FINDING_ANSWER_MAX_LENGTH,
		);
	});
});
