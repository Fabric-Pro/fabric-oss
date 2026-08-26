/**
 * Unit tests for the pure test-execution serializer — the result PUSH mapping
 * (Fabric result → ADO outcome + Test Result payload).
 *
 * Pure module — no mocks.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test test-execution-serializer
 */

import { describe, expect, it } from "vitest";
import {
	buildAdoTestResultPayload,
	mapTestResultToAdoOutcome,
} from "../test-execution-serializer";

describe("mapTestResultToAdoOutcome (push)", () => {
	it("maps each Fabric result to the ADO outcome vocabulary", () => {
		expect(mapTestResultToAdoOutcome("PASSED")).toBe("Passed");
		expect(mapTestResultToAdoOutcome("FAILED")).toBe("Failed");
		expect(mapTestResultToAdoOutcome("BLOCKED")).toBe("Blocked");
		expect(mapTestResultToAdoOutcome("NOT_RUN")).toBe("NotExecuted");
	});
});

describe("buildAdoTestResultPayload (push)", () => {
	it("builds the payload with the mapped outcome + source result", () => {
		expect(
			buildAdoTestResultPayload({ externalId: "4821", result: "PASSED" }),
		).toEqual({
			testCaseId: "4821",
			outcome: "Passed",
			sourceResult: "PASSED",
		});
	});

	it("carries an optional comment only when provided", () => {
		expect(
			buildAdoTestResultPayload({
				externalId: "7",
				result: "FAILED",
				comment: "regressed on retry",
			}),
		).toEqual({
			testCaseId: "7",
			outcome: "Failed",
			comment: "regressed on retry",
			sourceResult: "FAILED",
		});
		expect(
			buildAdoTestResultPayload({ externalId: "7", result: "FAILED" }),
		).not.toHaveProperty("comment");
	});
});
