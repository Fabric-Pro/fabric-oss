/**
 * The pairs the Proposal Inbox's duplicate verifier decides: one stored
 * order for a pair of two inbox items, whichever side reads it; the lookup
 * key a stored verdict row gives; and each side as the verifier reads it.
 */

import { describe, expect, it } from "vitest";
import { detectionTextForStory } from "../prisma/queries/projects/duplicate-detection";
import {
	INBOX_VERIFY_BACKOFF_MS,
	INBOX_VERIFY_FAILURE_LIMIT,
	inboxItemSubject,
	inboxVerdictKey,
	inboxVerdictState,
	orderInboxPair,
	storedInboxVerdictKey,
	storySubject,
} from "../prisma/queries/projects/proposal-item-duplicate-pairs";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");

const first = { proposalId: "alpha", changeIndex: 2 };
const second = { proposalId: "beta", changeIndex: 0 };

describe("orderInboxPair", () => {
	it("stores a pair of two inbox items once, whichever side reads it", () => {
		const fromFirst = orderInboxPair(first, { kind: "item", ...second });
		const fromSecond = orderInboxPair(second, { kind: "item", ...first });

		expect(fromFirst).toEqual({
			item: first,
			counterpart: { kind: "item", ...second },
			swapped: false,
		});
		expect(fromSecond).toEqual({
			item: first,
			counterpart: { kind: "item", ...second },
			swapped: true,
		});
		expect(inboxVerdictKey(fromSecond.item, fromSecond.counterpart)).toBe(
			inboxVerdictKey(fromFirst.item, fromFirst.counterpart),
		);
	});

	it("keeps a ticket pair on the inbox item", () => {
		const counterpart = { kind: "story" as const, storyId: "story-1" };

		expect(orderInboxPair(second, counterpart)).toEqual({
			item: second,
			counterpart,
			swapped: false,
		});
	});
});

describe("verdict keys", () => {
	it("matches the key of the row a pair is stored in", () => {
		const ticket = { kind: "story" as const, storyId: "story-1" };

		expect(inboxVerdictKey(first, ticket)).toBe(
			storedInboxVerdictKey({
				proposalId: "alpha",
				changeIndex: 2,
				counterpartKey: "story:story-1",
			}),
		);
		expect(inboxVerdictKey(first, { kind: "item", ...second })).toBe(
			storedInboxVerdictKey({
				proposalId: "alpha",
				changeIndex: 2,
				counterpartKey: "item:beta:0",
			}),
		);
	});

	it("holds a verdict only on both texts it was given on", () => {
		const verdict = {
			contentHash: "a",
			counterpartHash: "b",
			flagged: true,
			failedAttempts: 0,
			lastFailedAt: null,
		};
		const state = (item: string, counterpart: string) =>
			inboxVerdictState(verdict, { item, counterpart }, NOW);

		expect(state("a", "b")).toBe("flagged");
		expect(state("a", "c")).toBe("unverified");
		expect(state("b", "a")).toBe("unverified");
		expect(
			inboxVerdictState(
				{ ...verdict, flagged: false },
				{ item: "a", counterpart: "b" },
				NOW,
			),
		).toBe("clear");
		expect(
			inboxVerdictState(null, { item: "a", counterpart: "b" }, NOW),
		).toBe("unverified");
	});

	describe("after failed verifications", () => {
		const hashes = { item: "a", counterpart: "b" };
		const failed = (failedAttempts: number, msAgo: number) => ({
			contentHash: "a",
			counterpartHash: "b",
			flagged: null,
			failedAttempts,
			lastFailedAt: new Date(NOW - msAgo),
		});

		it("verifies a pair again after one failure", () => {
			expect(inboxVerdictState(failed(1, 0), hashes, NOW)).toBe(
				"unverified",
			);
		});

		it("waits once the failures reach the limit, until the backoff passes", () => {
			const limit = INBOX_VERIFY_FAILURE_LIMIT;
			expect(inboxVerdictState(failed(limit, 60_000), hashes, NOW)).toBe(
				"backing_off",
			);
			expect(
				inboxVerdictState(
					failed(limit, INBOX_VERIFY_BACKOFF_MS),
					hashes,
					NOW,
				),
			).toBe("unverified");
		});

		it("does not show an earlier verdict while the texts it failed on wait", () => {
			const flaggedThenFailed = {
				...failed(INBOX_VERIFY_FAILURE_LIMIT, 0),
				flagged: true,
			};
			expect(inboxVerdictState(flaggedThenFailed, hashes, NOW)).toBe(
				"backing_off",
			);
		});

		it("verifies a pair again at once when a side's text changed", () => {
			expect(
				inboxVerdictState(
					failed(INBOX_VERIFY_FAILURE_LIMIT, 0),
					{ item: "a2", counterpart: "b" },
					NOW,
				),
			).toBe("unverified");
		});
	});
});

describe("verdict subjects", () => {
	const item = {
		proposalId: "alpha",
		changeIndex: 2,
		source: "TEAMS_CHANNEL" as const,
		proposalSummary: "Summary",
		createdAt: new Date("2026-11-02T09:00:00.000Z"),
		title: "Queue exports",
		description: "Exports need a queue.",
		acceptanceCriteria: "",
		focusTexts: null,
	};

	it("reads a bug item as a bug, and any other item as the feature it is applied as", () => {
		expect(inboxItemSubject(item)).toEqual({
			identifier: "Proposal Inbox item",
			text: detectionTextForStory(item),
			kind: "BUG",
			focusTexts: null,
		});
		const feature = inboxItemSubject({ ...item, focusTexts: {} });
		expect(feature.kind).toBe("FEATURE");
	});

	it("reads a ticket as the roadmap scan does", () => {
		const story = {
			identifier: "F-12",
			title: "Export queue",
			description: "## Scope\n### In Scope\n- Queue large exports",
			acceptanceCriteria: null,
			kind: "FEATURE" as const,
			tasks: [{ title: "Add a queue", description: null }],
		};

		expect(storySubject(story)).toEqual({
			identifier: "F-12",
			text: detectionTextForStory(story),
			kind: "FEATURE",
			focusTexts: expect.objectContaining({
				scope: expect.stringContaining("Queue large exports"),
			}),
		});
	});
});
