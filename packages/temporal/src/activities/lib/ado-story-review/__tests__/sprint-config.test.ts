import { describe, expect, it } from "vitest";
import {
	adoSprintContextSchema,
	adoStoryReviewConfigSchema,
	adoStoryReviewStrictAssigneeSchema,
} from "../../../../lib/ado-story-review-config";

const selection = {
	iterationPaths: [" Example\\Sprint 2 ", "Example\\Sprint 1"],
	assignmentFields: ["System.AssignedTo", "Custom.Engineer"],
	assignedItemTypes: ["Task", "Bug", "Task"],
	parentSourceTypes: ["Task", "Bug"],
	relationKinds: ["related", "child"],
};

describe("sprint context config", () => {
	it("normalizes, deduplicates and sorts exact selections with no implicit sprint rollover", () => {
		expect(adoSprintContextSchema.parse(selection)).toEqual({
			iterationPaths: ["Example\\Sprint 1", "Example\\Sprint 2"],
			assignmentFields: ["Custom.Engineer", "System.AssignedTo"],
			assignedItemTypes: ["Bug", "Task"],
			parentSourceTypes: ["Bug", "Task"],
			relationKinds: ["child", "related"],
			excludedAssignedStates: [],
		});
	});

	it.each(["Custom.BEEngineer", "Microsoft.VSTS.Common.ActivatedBy"])(
		"accepts any field the process assigns through, such as %s",
		(field) => {
			expect(
				adoSprintContextSchema.parse({
					...selection,
					assignmentFields: [field],
				}).assignmentFields,
			).toEqual([field]);
		},
	);

	it.each([
		{ iterationPaths: [] },
		{ iterationPaths: ["A", "B", "C"] },
		{ iterationPaths: ["Example\\\\Sprint"] },
		{ iterationPaths: ["Example\\ "] },
		{ iterationPaths: ["\nExample\\Sprint"] },
		{ iterationPaths: ["x".repeat(513)] },
		{ assignmentFields: [] },
		{ assignmentFields: ["Custom.Bad Field]"] },
		{ assignmentFields: ["NoDot"] },
		{ assignmentFields: ["System.AssignedTo] = @Me OR [System.Id"] },
		{ assignedItemTypes: [] },
		{
			assignedItemTypes: Array.from(
				{ length: 21 },
				(_, index) => `Type ${index}`,
			),
		},
		{ assignedItemTypes: ["\tTask"] },
		{ assignedItemTypes: ["'mixed\"quotes"] },
		{ parentSourceTypes: ["Not selected"] },
		{ parentSourceTypes: ["Task\n"] },
		{ relationKinds: ["parent"] },
		{ relationKinds: ["child", "related", "child"] },
		{ excludedAssignedStates: ["Removed\r"] },
		{ excludedAssignedStates: Array.from({ length: 21 }, () => "Removed") },
		{ wiql: "SELECT * FROM WorkItems" },
	])("rejects unsafe or unsupported filters before trimming: %j", (patch) => {
		expect(
			adoSprintContextSchema.safeParse({ ...selection, ...patch })
				.success,
		).toBe(false);
	});

	it("keeps direct config serialization unchanged and omits sprintContext", () => {
		const config = adoStoryReviewConfigSchema.parse({
			assignee: { mode: "current" },
			rubric: "Review.",
		});
		expect(config).toEqual({
			assignee: { mode: "current" },
			rubric: "Review.",
			maxStories: 20,
			skills: [],
			workItemTypes: ["User Story"],
			requirementFields: [
				"Microsoft.VSTS.Common.AcceptanceCriteria",
				"System.Description",
				"System.Title",
			],
		});
		expect(JSON.stringify(config)).not.toContain("sprintContext");
	});

	it("allows no parent expansion or context relations when explicitly selected", () => {
		expect(
			adoSprintContextSchema.safeParse({
				...selection,
				parentSourceTypes: [],
				relationKinds: [],
			}).success,
		).toBe(true);
	});

	it.each([
		"\nmember@example.com",
		"member@example.com\r",
		"\tmember@example.com",
		"member@example.com\u007f",
	])(
		"rejects raw selected-identity controls before trimming: %j",
		(uniqueName) => {
			expect(
				adoStoryReviewConfigSchema.safeParse({
					assignee: { mode: "selected", uniqueName },
					rubric: "Review.",
					sprintContext: selection,
				}).success,
			).toBe(false);
		},
	);

	it("preserves valid selected-identity normalization in direct mode", () => {
		const config = adoStoryReviewConfigSchema.parse({
			assignee: { mode: "selected", uniqueName: " member@example.com " },
			rubric: "Review.",
		});
		expect(config.assignee).toEqual({
			mode: "selected",
			uniqueName: "member@example.com",
		});
		expect(config).not.toHaveProperty("sprintContext");
	});

	it("rejects raw target-type controls before trimming", () => {
		expect(
			adoStoryReviewConfigSchema.safeParse({
				assignee: { mode: "current" },
				rubric: "Review.",
				sprintContext: selection,
				workItemTypes: ["\nUser Story"],
			}).success,
		).toBe(false);
	});
});

describe("strict managed-read assignee", () => {
	it("reuses canonical modes and selected-name normalization", () => {
		expect(
			adoStoryReviewStrictAssigneeSchema.parse({ mode: "current" }),
		).toEqual({ mode: "current" });
		expect(
			adoStoryReviewStrictAssigneeSchema.parse({
				mode: "selected",
				uniqueName: " member@example.com ",
			}),
		).toEqual({ mode: "selected", uniqueName: "member@example.com" });
	});

	it.each([
		{ mode: "current", uniqueName: "member@example.com" },
		{ mode: "selected", uniqueName: "member@example.com", query: "WIQL" },
		{ mode: "selected", uniqueName: "\nmember@example.com" },
	])("refuses unknown keys and unsafe raw names: %j", (assignee) => {
		expect(
			adoStoryReviewStrictAssigneeSchema.safeParse(assignee).success,
		).toBe(false);
	});

	it("keeps existing workflow assignee parsing unchanged", () => {
		const config = adoStoryReviewConfigSchema.parse({
			assignee: { mode: "current", legacy: true },
			rubric: "Review.",
		});
		expect(config.assignee).toEqual({ mode: "current" });
	});
});
