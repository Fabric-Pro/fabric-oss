import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst, hasAccess } = vi.hoisted(() => ({
	findFirst: vi.fn(),
	hasAccess: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		db: { ...actual.db, projectMeetingTranscript: { findFirst } },
		hasProjectAccess: hasAccess,
	};
});

import {
	toActionItemPayload,
	toInsightsReady,
	toLinkedTicket,
	toTranscriptAvailability,
} from "@repo/api/modules/projects/procedures/meeting-digest/get-meeting";
import { computeActionItemKey } from "@repo/database";
import { MEETING_INSIGHTS_VERSION } from "@repo/temporal/activities";

describe("toActionItemPayload", () => {
	beforeEach(() => vi.clearAllMocks());

	it("prefers first-class rows, ordered by orderIndex", () => {
		expect(
			toActionItemPayload({
				rows: [
					{
						id: "a2",
						orderIndex: 1,
						text: "second",
						tentativeOwnerName: null,
						dueHint: null,
						completedAt: null,
					},
					{
						id: "a1",
						orderIndex: 0,
						text: "first",
						tentativeOwnerName: "Alice",
						dueHint: "Friday",
						completedAt: new Date("2026-07-06T00:00:00Z"),
					},
				],
				legacyJson: [{ text: "ignored" }],
			}),
		).toEqual([
			{
				id: "a1",
				text: "first",
				tentativeOwnerName: "Alice",
				dueHint: "Friday",
				completedAt: new Date("2026-07-06T00:00:00Z"),
				// #1902: the key the client joins linksByItemKey on.
				itemKey: computeActionItemKey("first"),
			},
			{
				id: "a2",
				text: "second",
				tentativeOwnerName: null,
				dueHint: null,
				completedAt: null,
				itemKey: computeActionItemKey("second"),
			},
		]);
	});

	it("falls back to legacy Json when no rows exist (pre-backfill)", () => {
		expect(
			toActionItemPayload({
				rows: [],
				legacyJson: [{ text: "legacy item", tentativeOwnerName: "Bo" }],
			}),
		).toEqual([
			{
				id: null,
				text: "legacy item",
				tentativeOwnerName: "Bo",
				dueHint: null,
				completedAt: null,
				sourceQuote: null,
				anchorLine: null,
				itemKey: computeActionItemKey("legacy item"),
			},
		]);
	});

	it("tolerates malformed legacy elements (a bare string and a null) alongside a well-formed one", () => {
		expect(
			toActionItemPayload({
				rows: [],
				legacyJson: ["just a string", null, { text: "well-formed" }],
			}),
		).toEqual([
			{
				id: null,
				text: JSON.stringify("just a string"),
				tentativeOwnerName: null,
				dueHint: null,
				completedAt: null,
				sourceQuote: null,
				anchorLine: null,
				itemKey: computeActionItemKey(JSON.stringify("just a string")),
			},
			{
				id: null,
				text: JSON.stringify(null),
				tentativeOwnerName: null,
				dueHint: null,
				completedAt: null,
				sourceQuote: null,
				anchorLine: null,
				itemKey: computeActionItemKey(JSON.stringify(null)),
			},
			{
				id: null,
				text: "well-formed",
				tentativeOwnerName: null,
				dueHint: null,
				completedAt: null,
				sourceQuote: null,
				anchorLine: null,
				itemKey: computeActionItemKey("well-formed"),
			},
		]);
	});
});

describe("toTranscriptAvailability", () => {
	it("reports availability + row-id ref when the transcript has stored content", () => {
		expect(
			toTranscriptAvailability({ id: "row1", contextId: "ctx1" }),
		).toEqual({
			hasTranscript: true,
			transcriptRef: "row1",
			transcriptContextId: "ctx1",
		});
	});

	it("reports unavailable when no context row exists", () => {
		expect(
			toTranscriptAvailability({ id: "row1", contextId: null }),
		).toEqual({
			hasTranscript: false,
			transcriptRef: "row1",
			transcriptContextId: null,
		});
	});
});

describe("toInsightsReady", () => {
	it("is ready when extracted at the current insights version", () => {
		expect(
			toInsightsReady({
				insightsExtractedAt: new Date("2026-07-03T00:00:00Z"),
				insightsVersion: MEETING_INSIGHTS_VERSION,
			}),
		).toBe(true);
	});

	it("is not ready when never extracted", () => {
		expect(
			toInsightsReady({
				insightsExtractedAt: null,
				insightsVersion: null,
			}),
		).toBe(false);
	});

	it("is not ready when the cached version is stale", () => {
		expect(
			toInsightsReady({
				insightsExtractedAt: new Date("2026-07-01T00:00:00Z"),
				insightsVersion: MEETING_INSIGHTS_VERSION - 1,
			}),
		).toBe(false);
	});
});

describe("toLinkedTicket", () => {
	it("maps a story with a final status to isDone=true", () => {
		expect(
			toLinkedTicket({
				id: "s1",
				identifier: "F-101",
				title: "Ship it",
				status: { name: "Done", isFinal: true },
			}),
		).toEqual({
			storyId: "s1",
			identifier: "F-101",
			title: "Ship it",
			statusName: "Done",
			isDone: true,
		});
	});

	it("maps a non-final status to isDone=false with the status name", () => {
		expect(
			toLinkedTicket({
				id: "s2",
				identifier: null,
				title: "WIP",
				status: { name: "In Progress", isFinal: false },
			}),
		).toEqual({
			storyId: "s2",
			identifier: null,
			title: "WIP",
			statusName: "In Progress",
			isDone: false,
		});
	});

	it("defensively maps a missing status to isDone=false, statusName null", () => {
		expect(
			toLinkedTicket({
				id: "s3",
				identifier: "F-1",
				title: "X",
				status: null,
			}),
		).toEqual({
			storyId: "s3",
			identifier: "F-1",
			title: "X",
			statusName: null,
			isDone: false,
		});
	});
});
