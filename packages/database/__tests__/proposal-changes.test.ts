/**
 * Typed reading of a stored proposal's changes: the item fields every
 * inbox path reads, the stale-target check, and the proposal revision an
 * approval is compared against.
 */

import { describe, expect, it } from "vitest";
import {
	isNewWorkChange,
	primaryDraftChangeIndex,
	proposalRevision,
	readStoredProposalChange,
	readStoredProposalChanges,
	targetChangedSinceProposal,
} from "../prisma/queries/projects/proposal-changes";

describe("readStoredProposalChanges", () => {
	it("reads every entry in index order, whatever its shape", () => {
		const changes = readStoredProposalChanges({
			changes: [
				{
					action: "update",
					type: "feature",
					title: { from: "Old", to: "  Renamed  " },
					description: { from: "Before", to: "After" },
					acceptanceCriteria: { from: "Same", to: "Same" },
					existingId: "story-1",
					targetResolution: { resolvedIdentifier: "F-12" },
					reasoning: "Because",
				},
				{ title: "Legacy title", description: " Bare " },
				null,
			],
		});

		expect(changes).toHaveLength(3);
		expect(changes[0]).toMatchObject({
			index: 0,
			action: "update",
			type: "feature",
			title: "Renamed",
			description: "After",
			descriptionFrom: "Before",
			acceptanceCriteriaFrom: null,
			existingId: "story-1",
			identifier: "F-12",
			reasoning: "Because",
		});
		expect(changes[1]).toMatchObject({
			index: 1,
			action: "create",
			title: "Legacy title",
			description: "Bare",
		});
		expect(changes[2]).toMatchObject({ index: 2, raw: {}, title: "" });
	});

	it.each([null, undefined, "x", [], {}, { changes: "x" }])(
		"reads nothing from %j",
		(proposal) => {
			expect(readStoredProposalChanges(proposal)).toEqual([]);
		},
	);

	it("prefers the stored identifier over a resolved one", () => {
		const change = readStoredProposalChange(
			{
				changes: [
					{
						existingIdentifier: "F-1",
						targetResolution: { resolvedIdentifier: "F-2" },
					},
				],
			},
			0,
		);
		expect(change?.identifier).toBe("F-1");
		expect(readStoredProposalChange({ changes: [] }, 0)).toBeNull();
	});
});

describe("isNewWorkChange and primaryDraftChangeIndex", () => {
	it("takes a titled create, and drafts the first create that is not an epic", () => {
		const changes = readStoredProposalChanges({
			changes: [
				{ action: "update", title: { to: "Update" } },
				{ action: "create", type: "epic", title: { to: "Epic" } },
				{ action: "create", type: "feature", title: { to: "" } },
				{ action: "create", type: "bug", title: { to: "Bug" } },
			],
		});
		expect(changes.map(isNewWorkChange)).toEqual([
			false,
			true,
			false,
			true,
		]);
		expect(primaryDraftChangeIndex(changes)).toBe(2);
	});
});

describe("targetChangedSinceProposal", () => {
	const change = readStoredProposalChanges({
		changes: [
			{
				action: "update",
				description: { from: "Body\r\nline", to: "New body" },
				acceptanceCriteria: { from: "Criteria", to: "New criteria" },
			},
		],
	})[0];
	if (!change) {
		throw new Error("Missing fixture");
	}

	it("is false while the target still has the analysed body", () => {
		expect(
			targetChangedSinceProposal(change, {
				description: "Body\nline  ",
				acceptanceCriteria: "Criteria",
			}),
		).toBe(false);
	});

	it.each([
		[
			"description",
			{ description: "Edited", acceptanceCriteria: "Criteria" },
		],
		[
			"acceptance criteria",
			{ description: "Body\nline", acceptanceCriteria: null },
		],
	])("is true once the %s changed", (_label, current) => {
		expect(targetChangedSinceProposal(change, current)).toBe(true);
	});

	it("ignores a field the update does not change", () => {
		const titleOnly = readStoredProposalChanges({
			changes: [{ action: "update", title: { from: "A", to: "B" } }],
		})[0];
		expect(
			titleOnly &&
				targetChangedSinceProposal(titleOnly, {
					description: "Anything",
					acceptanceCriteria: "Anything",
				}),
		).toBe(false);
	});
});

describe("proposalRevision", () => {
	it("is the same for the same content in any key order", () => {
		expect(proposalRevision({ a: 1, b: { c: [1, 2], d: null } })).toBe(
			proposalRevision({ b: { d: null, c: [1, 2] }, a: 1 }),
		);
	});

	it("changes when an item changes", () => {
		const before = { changes: [{ description: { to: "Text" } }] };
		const after = {
			changes: [{ description: { to: "Text\n\nMerged entry" } }],
		};
		expect(proposalRevision(before)).not.toBe(proposalRevision(after));
	});
});
