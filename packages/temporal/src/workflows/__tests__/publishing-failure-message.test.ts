import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ApplicationFailure } from "@temporalio/common";
import { describe, expect, it } from "vitest";
import { publishingFailureDetail } from "../publishing-failure-message";

/**
 * What a failed publishing run is allowed to SAY, and to whom.
 *
 * The stored message reaches everyone who can see the tab; the detail reaches an
 * operator. The interesting property is the fail-closed one: a failure type this
 * table does not know must not get its own words, because the words might not be
 * ours.
 */

describe("publishingFailureDetail", () => {
	it("gives an authorization refusal its own words", () => {
		const detail = publishingFailureDetail(
			ApplicationFailure.nonRetryable(
				"The account that started this draft is no longer authorized to generate on this project",
				"PUBLISHING_ACTOR_INVALID",
			),
		);

		expect(detail.message).toBe(
			"The account that started this draft is no longer authorized to generate on this project",
		);
		expect(detail.errorClass).toBe("PUBLISHING_ACTOR_INVALID");
	});

	it("replaces a validation report rather than rendering it", () => {
		// The activity appends the validator's output, which quotes what the
		// model produced. Useful to an operator, not something to paste onto a
		// shared row.
		const detail = publishingFailureDetail(
			ApplicationFailure.nonRetryable(
				'Case study failed schema validation: [{"path":["body"],"received":"..."}]',
				"PUBLISHING_CASE_STUDY_SCHEMA_VALIDATION_FAILED",
			),
		);

		expect(detail.message).toBe(
			"The model returned a draft that did not match the expected shape. Generating again usually clears it.",
		);
		expect(detail.message).not.toContain("received");
		expect(detail.detail).toContain("received");
	});

	it("gives an unknown failure the neutral message, and keeps its text for the log", () => {
		// Fail-closed, and the direction that matters: a failure class nobody
		// thought about must not start rendering third-party text by being
		// forgotten.
		const detail = publishingFailureDetail(
			new Error("connect ECONNREFUSED 10.0.0.5:5432"),
		);

		expect(detail.message).toBe(
			"Generation failed. The reason is recorded in the run log for this project.",
		);
		expect(detail.message).not.toContain("ECONNREFUSED");
		expect(detail.detail).toContain("ECONNREFUSED");
		expect(detail.errorClass).toBe("Error");
	});

	it("gives a non-Error throw the neutral message too", () => {
		expect(publishingFailureDetail("a string").message).toBe(
			"Generation failed. The reason is recorded in the run log for this project.",
		);
		expect(publishingFailureDetail(null).message).toBe(
			"Generation failed. The reason is recorded in the run log for this project.",
		);
	});

	it("agrees, byte for byte, with the strings the activity actually raises", () => {
		// The two authorization messages are written in two files that run in two
		// different sandboxes: the activity raises them, this table re-states
		// them. Nothing at runtime would notice them drifting — the mapping would
		// simply stop matching and every refusal would quietly fall through to
		// the neutral message, which is the failure mode that looks like nothing
		// happening.
		const activitySource = readFileSync(
			join(
				__dirname,
				"..",
				"..",
				"activities",
				"publishing-shared",
				"assert-generation-actor.ts",
			),
			"utf8",
		);

		for (const [type, message] of [
			[
				"PUBLISHING_TENANT_MISMATCH",
				"This project moved to a different organization after the draft was started",
			],
			[
				"PUBLISHING_ACTOR_INVALID",
				"The account that started this draft is no longer authorized to generate on this project",
			],
		] as const) {
			expect(
				publishingFailureDetail(
					ApplicationFailure.nonRetryable(message, type),
				).message,
			).toBe(message);
			expect(activitySource).toContain(message);
		}
	});
});
