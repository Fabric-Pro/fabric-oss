/**
 * Unit test for the test-execution result PUSH activity.
 *
 * The live ADO Test Results POST is DEFERRED, so `pushTestCaseExecutionToPM`
 * builds the real payload and returns it marked `deferred` without POSTing.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test test-execution-sync
 */

import { describe, expect, it } from "vitest";
import { pushTestCaseExecutionToPM } from "../test-execution-sync";

describe("pushTestCaseExecutionToPM (deferred push)", () => {
	it("builds the ADO payload and returns it marked deferred (no live POST yet)", async () => {
		const result = await pushTestCaseExecutionToPM({
			testCaseId: "tc1",
			projectId: "p1",
			externalId: "4821",
			result: "FAILED",
			mcpConfigId: "cfg1",
			containerId: "board1",
			userId: "u1",
			detectedType: "azure-devops",
			comment: "regressed",
		});

		expect(result).toEqual({
			pushed: false,
			deferred: true,
			outcome: "Failed",
			payload: {
				testCaseId: "4821",
				outcome: "Failed",
				comment: "regressed",
				sourceResult: "FAILED",
			},
		});
	});
});
