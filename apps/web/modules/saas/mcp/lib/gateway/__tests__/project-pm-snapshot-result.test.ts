import { Buffer } from "node:buffer";
import type { AzureDevOpsStorySnapshot } from "@repo/connectors";
import { describe, expect, it } from "vitest";
import { jsonResult } from "../tool-results";
import {
	boundedProjectPmSnapshots,
	PROJECT_PM_SNAPSHOT_MAX_BYTES,
} from "@repo/temporal/project-pm-snapshot-result";

const asOf = "2026-01-01T12:00:00.0001234Z";
const connection = {
	status: "ready",
	provider: "azure-devops",
	target: {
		organization: "example-org",
		projectId: "project-1",
		projectName: "Example Project",
	},
} as const;

function snapshot(id: number, text = "Full comment"): AzureDevOpsStorySnapshot {
	return {
		id,
		rev: 7,
		workItemType: "User Story",
		title: `Item ${id}`,
		state: "Active",
		assignedTo: null,
		changedDate: asOf,
		requirements: { "Custom.BusinessRules": "Full requirement" },
		requirementsAsOf: asOf,
		sourceUrl: `https://dev.azure.com/example-org/project-1/_workitems/edit/${id}`,
		comments: {
			comments: [
				{
					id: 1,
					version: 2,
					modifiedDate: asOf,
					isDeleted: false,
					fullText: text,
					format: "markdown",
				},
			],
			complete: true,
			incompleteReason: null,
			captureStartedAt: asOf,
			capturedAt: asOf,
			consistency: "two_matching_reads",
			atomicAsOf: false,
		},
		complete: true,
	};
}

describe("bounded project PM snapshots", () => {
	it("preserves safe links, full fields and separate versioned comment provenance", () => {
		const snapshots = [snapshot(1)];
		expect(
			boundedProjectPmSnapshots(
				{
					snapshots,
					unreadIds: [],
					requirementsAsOf: asOf,
					complete: true,
					incompleteReason: null,
				},
				[1],
				connection,
			),
		).toEqual({
			...connection,
			snapshots,
			unreadIds: [],
			requirementsAsOf: asOf,
			complete: true,
			incompleteReason: null,
			resultTruncated: false,
		});
	});

	it("bounds UTF-8 serialized bytes by omitting whole items without mutating the capture", () => {
		const snapshots = [snapshot(1), snapshot(2, "😀".repeat(40_000))];
		const result = boundedProjectPmSnapshots(
			{
				snapshots,
				unreadIds: [],
				requirementsAsOf: asOf,
				complete: true,
				incompleteReason: null,
			},
			[1, 2],
			connection,
		);
		expect(result).toMatchObject({
			snapshots: [snapshots[0]],
			unreadIds: [2],
			complete: false,
			incompleteReason: "response_limit",
			resultTruncated: true,
		});
		expect(
			Buffer.byteLength(JSON.stringify(jsonResult(result)), "utf8"),
		).toBeLessThanOrEqual(PROJECT_PM_SNAPSHOT_MAX_BYTES);
		expect(snapshots).toHaveLength(2);
		expect(result.snapshots[0]).toBe(snapshots[0]);
	});

	it("preserves an existing incomplete reason and all unread IDs on overflow", () => {
		const result = boundedProjectPmSnapshots(
			{
				snapshots: [
					snapshot(1, "x".repeat(PROJECT_PM_SNAPSHOT_MAX_BYTES)),
				],
				unreadIds: [2],
				requirementsAsOf: asOf,
				complete: false,
				incompleteReason: "concurrent_changes",
			},
			[1, 2],
			connection,
		);
		expect(result).toMatchObject({
			snapshots: [],
			unreadIds: [1, 2],
			complete: false,
			incompleteReason: "concurrent_changes",
			resultTruncated: true,
		});
	});

	it("includes MCP text wrapping and JSON escaping in the byte limit", () => {
		const result = boundedProjectPmSnapshots(
			{
				snapshots: [snapshot(1, '"'.repeat(60_000))],
				unreadIds: [],
				requirementsAsOf: asOf,
				complete: true,
				incompleteReason: null,
			},
			[1],
			connection,
		);
		expect(result).toMatchObject({
			snapshots: [],
			unreadIds: [1],
			complete: false,
			resultTruncated: true,
		});
		expect(
			Buffer.byteLength(JSON.stringify(jsonResult(result)), "utf8"),
		).toBeLessThanOrEqual(PROJECT_PM_SNAPSHOT_MAX_BYTES);
	});
});
