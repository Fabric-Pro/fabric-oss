import { describe, expect, it } from "vitest";
import {
	readWorkspaceDocumentFilters,
	workspaceSearchGroups,
} from "../workspace-document-selection";

describe("saved workspace document selection", () => {
	it("retains a filtered workspace beside an independently unfiltered workspace", () => {
		expect(
			workspaceSearchGroups(
				["example-a", "example-b"],
				[
					{
						workspaceId: "example-a",
						documentIds: ["example-selected"],
					},
				],
			),
		).toEqual([
			{ workspaceIds: ["example-a"], documentIds: ["example-selected"] },
			{ workspaceIds: ["example-b"] },
		]);
	});
	it("preserves explicit empty-selection means all-documents semantics and omits inactive filters", () => {
		const filters = readWorkspaceDocumentFilters(
			[
				{ workspaceId: "example-a", documentIds: [] },
				{
					workspaceId: "example-inactive",
					documentIds: ["example-hidden"],
				},
			],
			["example-a"],
		);
		expect(workspaceSearchGroups(["example-a"], filters)).toEqual([
			{ workspaceIds: ["example-a"] },
		]);
	});
	it("never turns an empty intersection into an unrestricted search", () => {
		expect(
			workspaceSearchGroups(
				["example-a"],
				[
					{
						workspaceId: "example-a",
						documentIds: ["example-selected"],
					},
				],
				["example-other"],
			),
		).toEqual([]);
	});
	it("narrows an explicit retrieval filter without broadening a saved subset", () => {
		expect(
			workspaceSearchGroups(
				["example-a", "example-b"],
				[
					{
						workspaceId: "example-a",
						documentIds: ["example-selected", "example-second"],
					},
				],
				["example-selected", "example-third"],
			),
		).toEqual([
			{ workspaceIds: ["example-a"], documentIds: ["example-selected"] },
			{
				workspaceIds: ["example-b"],
				documentIds: ["example-selected", "example-third"],
			},
		]);
	});
	it.each([
		null,
		[{ workspaceId: "example-a", documentIds: "all" }],
		[
			{
				workspaceId: "example-a",
				documentIds: ["example-doc", "example-doc"],
			},
		],
		[{ workspaceId: "example-a" }, { workspaceId: "example-a" }],
	])("refuses invalid saved selectors %j", (raw) => {
		expect(() =>
			readWorkspaceDocumentFilters(raw, ["example-a"]),
		).toThrow();
	});
	it("keeps historical absent filters equivalent to all selected workspaces", () => {
		expect(
			workspaceSearchGroups(["example-a", "example-b"], undefined),
		).toEqual([{ workspaceIds: ["example-a", "example-b"] }]);
	});
});
