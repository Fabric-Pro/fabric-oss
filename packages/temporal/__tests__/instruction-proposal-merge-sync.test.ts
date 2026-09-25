/**
 * The merge-sync receipt classifier and backoff (Fizzy #2563 spec §9.1):
 * pure, table-driven from the spec's receipt table.
 */
import { describe, expect, it } from "vitest";
import {
	classifyMergeSyncReceipt,
	mergeSyncBackoffMs,
	mergeSyncDispatchesBefore,
} from "../src/activities/lib/instruction-proposal-merge-sync";

const REQUESTED = new Date("2026-09-24T12:00:00.000Z");
const EXPECTED = {
	projectId: "proj_1",
	syncId: "sync_1",
	generation: 3,
	requestedAt: REQUESTED,
};
const run = (over: Record<string, unknown> = {}) => ({
	projectId: "proj_1",
	syncId: "sync_1",
	generation: 3,
	trigger: "PULL_REQUEST_MERGED",
	startedAt: new Date(REQUESTED.getTime() + 60_000),
	status: "SUCCEEDED" as string | null,
	error: null as string | null,
	...over,
});

describe("classifyMergeSyncReceipt", () => {
	it("waits on a run still in flight", () => {
		expect(classifyMergeSyncReceipt(run({ status: null }), EXPECTED)).toBe(
			"wait",
		);
	});

	it.each([
		["SUCCEEDED", null],
		["UNCHANGED", null],
		["REJECTED", null],
		["FAILED", "LIMITS_EXCEEDED"],
		["FAILED", "TREE_REFUSED"],
	])(
		"consumes %s %s: a re-dispatch cannot change the result",
		(status, error) => {
			expect(
				classifyMergeSyncReceipt(run({ status, error }), EXPECTED),
			).toBe("consuming");
		},
	);

	it.each([
		["SKIPPED", null],
		["NOT_PUBLISHED", null],
		["NOT_PUBLISHED", "STORAGE_FAILED"],
		["FAILED", "CONFIGURATION_CHANGED"],
		["FAILED", "NOT_CONFIGURED"],
		["FAILED", "INTEGRATION_UNAVAILABLE"],
		["FAILED", "PERMISSION_DENIED"],
		["FAILED", "REF_MISSING"],
		["FAILED", "ROOT_MISSING"],
		["FAILED", "CLONE_FAILED"],
		["FAILED", "STORAGE_FAILED"],
		["FAILED", "CHILD_ABORTED"],
		["FAILED", null],
	])("retains %s %s", (status, error) => {
		expect(classifyMergeSyncReceipt(run({ status, error }), EXPECTED)).toBe(
			"retaining",
		);
	});

	it.each([
		["a POLL run", { trigger: "POLL" }],
		["a manual run", { trigger: "MANUAL" }],
		[
			"a run started before the merge was seen",
			{ startedAt: new Date(REQUESTED.getTime() - 1) },
		],
		["another sync row", { syncId: "sync_2" }],
		["another generation", { generation: 4 }],
		["another project", { projectId: "proj_2" }],
	])("retains %s, whatever its outcome", (_label, over) => {
		expect(classifyMergeSyncReceipt(run(over), EXPECTED)).toBe("retaining");
	});

	it("counts a run started exactly at the request", () => {
		expect(
			classifyMergeSyncReceipt(run({ startedAt: REQUESTED }), EXPECTED),
		).toBe("consuming");
	});
});

describe("merge-sync backoff", () => {
	it("waits 5, 15, then 60 minutes between dispatches", () => {
		expect([0, 1, 2, 3, 9].map(mergeSyncBackoffMs)).toEqual(
			[5, 15, 60, 60, 60].map((m) => m * 60_000),
		);
	});

	it("counts dispatches from the time since the request, on the same schedule", () => {
		const at = (minutes: number) =>
			mergeSyncDispatchesBefore(minutes * 60_000);
		expect([0, 4, 5, 19, 20, 200].map(at)).toEqual([0, 0, 1, 1, 2, 2]);
	});
});
