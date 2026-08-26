import { describe, expect, it } from "vitest";
import {
	backlogAnalysisWorkflowId,
	backlogApplyWorkflowId,
	isBacklogAnalysisWorkflowIdFor,
	isBacklogApplyWorkflowIdFor,
} from "../modules/projects/procedures/backlog/workflow-id";

const PROJECT = "proj-abc123";

/**
 * The progress reader's binding guard (security review of Fizzy #1234): the
 * caller-supplied workflowId must name the authorized project, or another
 * project's proposal is readable by guessing its id.
 */
describe("backlog-analysis workflow ids", () => {
	it("round-trips: every minted id passes its own project's guard", () => {
		const workflowId = backlogAnalysisWorkflowId(PROJECT);
		expect(isBacklogAnalysisWorkflowIdFor(workflowId, PROJECT)).toBe(true);
	});

	it("rejects another project's workflow id", () => {
		const other = backlogAnalysisWorkflowId("proj-other999");
		expect(isBacklogAnalysisWorkflowIdFor(other, PROJECT)).toBe(false);
	});

	it("rejects a longer project id that shares a prefix with this one", () => {
		// proj-abc123 vs proj-abc123x — the separator has to do real work.
		const longer = backlogAnalysisWorkflowId(`${PROJECT}x`);
		expect(isBacklogAnalysisWorkflowIdFor(longer, PROJECT)).toBe(false);
	});

	it("rejects malformed and foreign-shaped ids", () => {
		for (const id of [
			"",
			"backlog-analysis-proj-abc123",
			"backlog-analysis-proj-abc123-notatimestamp",
			"backlog-analysis--1700000000000",
			"context-embedding-x-1",
			`pm-sync-${PROJECT}`,
		]) {
			expect(isBacklogAnalysisWorkflowIdFor(id, PROJECT), id).toBe(false);
		}
	});

	it("rejects a non-numeric suffix even for the right project", () => {
		expect(
			isBacklogAnalysisWorkflowIdFor(
				`${"backlog-analysis-"}${PROJECT}-evil/../x`,
				PROJECT,
			),
		).toBe(false);
	});
});

/**
 * The apply-changes family has THREE minters (start, retry, retry-all) with
 * different id shapes; the progress reader must accept all three for its own
 * project and nothing else (security review of Fizzy #1234).
 */
describe("backlog-apply workflow ids", () => {
	it("round-trips the plain apply id", () => {
		const workflowId = backlogApplyWorkflowId(PROJECT);
		expect(isBacklogApplyWorkflowIdFor(workflowId, PROJECT)).toBe(true);
	});

	it("accepts both retry shapes when they name this project", () => {
		expect(
			isBacklogApplyWorkflowIdFor(
				`backlog-apply-retry-${PROJECT}-1700000000000`,
				PROJECT,
			),
		).toBe(true);
		expect(
			isBacklogApplyWorkflowIdFor(
				`backlog-apply-retry-all-${PROJECT}-row123-1700000000000`,
				PROJECT,
			),
		).toBe(true);
	});

	it("rejects another project's apply id in every shape", () => {
		for (const id of [
			backlogApplyWorkflowId("proj-other999"),
			"backlog-apply-retry-proj-other999-1700000000000",
			"backlog-apply-retry-all-proj-other999-row1-1700000000000",
		]) {
			expect(isBacklogApplyWorkflowIdFor(id, PROJECT), id).toBe(false);
		}
	});

	it("is not fooled by prefix overlap between the family shapes", () => {
		// `backlog-apply-` is a strict prefix of the retry prefixes: matching
		// order must not let a retry id be read as a plain apply id whose
		// project segment is "retry".
		expect(
			isBacklogApplyWorkflowIdFor(
				`backlog-apply-retry-${PROJECT}-1700000000000`,
				"retry",
			),
		).toBe(false);
	});

	it("rejects malformed ids and foreign families", () => {
		for (const id of [
			"",
			"backlog-analysis-x-1",
			`backlog-apply-${PROJECT}`,
			`backlog-apply-${PROJECT}-bad path`,
			`backlog-apply-${PROJECT}-ts extra/../segments`,
		]) {
			expect(isBacklogApplyWorkflowIdFor(id, PROJECT), id).toBe(false);
		}
	});
});
