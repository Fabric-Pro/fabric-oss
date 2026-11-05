/**
 * DECISION_CANDIDATES_READY is written by
 * `createDecisionCandidatesReadyNotifications` in `@repo/database`, from the
 * Living Memory extraction activity, which cannot use this validator. This
 * keeps its `DecisionCandidatesReadyPayload` and the schema registered here in
 * step.
 */
import {
	type DecisionCandidatesReadyPayload,
	NotificationType,
} from "@repo/database";
import { describe, expect, it } from "vitest";
import { validatePayload } from "../payloads";

const PAYLOAD: DecisionCandidatesReadyPayload = {
	projectId: "proj-1",
	candidateCount: 2,
	fileCount: 1,
};

describe("decision candidates ready payload schema", () => {
	it("accepts the shape the writer emits", () => {
		expect(
			validatePayload(
				NotificationType.DECISION_CANDIDATES_READY,
				PAYLOAD,
			),
		).toEqual(PAYLOAD);
	});

	it("rejects a payload that announces no candidate", () => {
		expect(() =>
			validatePayload(NotificationType.DECISION_CANDIDATES_READY, {
				...PAYLOAD,
				candidateCount: 0,
			}),
		).toThrow();
	});
});
