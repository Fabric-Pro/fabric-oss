/**
 * Measures what the Daily Brief collector caps actually prevent (Fizzy #1997).
 *
 * The unit tests assert the caps EXIST; this asserts they MATTER — that the
 * uncapped shape genuinely exceeded the frame and the capped shape fits.
 */
import { describe, expect, it } from "vitest";
import {
	measureSerializedBytes,
	PAYLOAD_HARD_LIMIT_BYTES,
} from "../payload-size-guard";

const prItem = (i: number) => ({
	kind: "pr_merged",
	title: `Some reasonably titled pull request number ${i}`,
	body: "x".repeat(500), // matches PR_BODY_CHAR_CAP
	url: `https://github.com/org/repo/pull/${i}`,
	author: "someone",
	repoFullName: "org/repo-name",
	baseRef: "main",
	occurredAt: new Date().toISOString(),
});

const storyItem = (i: number) => ({
	id: `story-${i}`,
	identifier: `F-${i}`,
	title: `A story title of ordinary length ${i}`,
	status: "In Progress",
	changedBy: "someone",
	occurredAt: new Date().toISOString(),
});

describe("daily-brief collector caps actually bound the payload", () => {
	it("an uncapped busy project exceeds the frame; the capped one fits", () => {
		// 50 connected repos at the 100/repo cap, plus a large uncapped
		// story/document backlog — the shape the caps exist to bound.
		const before = {
			github: Array.from({ length: 50 * 100 }, (_, i) => prItem(i)),
			storyChanges: Array.from({ length: 5000 }, (_, i) => storyItem(i)),
		};
		// After: MAX_PRS_TOTAL = 300, MAX_STORY_ROWS = 200.
		const after = {
			github: before.github.slice(0, 300),
			storyChanges: before.storyChanges.slice(0, 200),
		};

		const beforeBytes = measureSerializedBytes(before);
		const afterBytes = measureSerializedBytes(after);

		console.log(
			`frame budget ${PAYLOAD_HARD_LIMIT_BYTES} | before ${beforeBytes} | after ${afterBytes}`,
		);

		expect(beforeBytes).toBeGreaterThan(PAYLOAD_HARD_LIMIT_BYTES);
		expect(afterBytes).toBeLessThan(PAYLOAD_HARD_LIMIT_BYTES);
	});
});
