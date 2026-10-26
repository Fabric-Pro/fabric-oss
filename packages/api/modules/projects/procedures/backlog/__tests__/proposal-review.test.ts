import { describe, expect, it } from "vitest";
import type { ChangeItem } from "../change-item-schema";
import {
	buildProposalReviewEntries,
	buildSidebarReviewEntries,
	resolveApprovedChangeIndexes,
} from "../proposal-review";

const changes: ChangeItem[] = [0, 1, 2].map((i) => ({
	action: "create",
	type: "feature",
	title: { to: `Offered ${i}` },
}));
describe("proposal review identity", () => {
	it("uses positions for edited titles and create to update overrides", () => {
		const edited = [
			{
				...changes[2]!,
				action: "update" as const,
				title: { to: "Edited", from: null },
			},
		];
		expect(resolveApprovedChangeIndexes(changes, edited, [2])).toEqual([2]);
	});
	it.each([[3], [-1], [0.5], [0, 0], []].map((indexes) => ({ indexes })))(
		"rejects invalid indexes %j",
		({ indexes }) => {
			expect(() =>
				resolveApprovedChangeIndexes(
					changes,
					indexes.length === 2
						? [changes[0]!, changes[1]!]
						: [changes[0]!],
					indexes,
				),
			).toThrow();
		},
	);
	it("supports old clients and consumes duplicate content positions", () => {
		expect(
			resolveApprovedChangeIndexes(
				[changes[0]!, changes[0]!],
				[changes[0]!, changes[0]!],
			),
		).toEqual([0, 1]);
	});
	it("records deselection and submitted edits even when an index was already applied", () => {
		const edited = { ...changes[2]!, title: { to: "Edited" } };
		const entries = buildProposalReviewEntries(
			changes,
			[edited, changes[0]!],
			[2, 0],
			{ 0: { skip: true } },
		);
		expect(entries).toEqual([
			{
				offeredIndex: 0,
				changeIndex: 0,
				selected: true,
				change: changes[0],
				pmSyncOverride: undefined,
			},
			{ offeredIndex: 1, changeIndex: 1, selected: false },
			{
				offeredIndex: 2,
				changeIndex: 2,
				selected: true,
				change: edited,
				pmSyncOverride: { skip: true },
			},
		]);
	});
	it("records eight offered and five selected while assigning approved-only row indexes", () => {
		const offered = Array.from({ length: 8 }, (_, i) => ({
			action: "create" as const,
			type: "feature" as const,
			title: `Offered ${i}`,
		}));
		const indexes = [0, 2, 3, 5, 7];
		const selected = indexes.map((i) => ({
			...changes[0]!,
			title: { to: offered[i]!.title },
		}));
		const entries = buildSidebarReviewEntries(selected, indexes, offered);
		expect(entries).toHaveLength(8);
		expect(
			entries.filter((e) => e.selected).map((e) => e.changeIndex),
		).toEqual([0, 1, 2, 3, 4]);
		expect(
			entries.filter((e) => !e.selected).map((e) => e.changeIndex),
		).toEqual([null, null, null]);
	});
	it.each([[0, 0], [-1], []].map((indexes) => ({ indexes })))(
		"rejects invalid old sidebar identity %j",
		({ indexes }) => {
			expect(() => buildSidebarReviewEntries(changes, indexes)).toThrow();
		},
	);
	it("records selected entries only for old sidebar clients", () => {
		expect(buildSidebarReviewEntries(changes)).toHaveLength(3);
	});
	it("rejects offered metadata without selection identity", () => {
		expect(() =>
			buildSidebarReviewEntries(changes, undefined, [
				{ action: "create", type: "feature", title: "Example" },
			]),
		).toThrow();
	});
});

it("rejects int32-overflow positions for an old sidebar client without offeredChanges", () => {
	expect(() =>
		buildSidebarReviewEntries([changes[0]!], [2 ** 31 + 1]),
	).toThrowError(expect.objectContaining({ code: "BAD_REQUEST" }));
});
