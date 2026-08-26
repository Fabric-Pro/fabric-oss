/**
 * Tests for the pure Markdown serializer + stub detector that back the
 * Feature Export / Download feature.
 *
 * Snapshot tests use a fixed `generatedAt` so the rendered Markdown is
 * deterministic. The `isStoryStub` truth table follows spec §8.1 verbatim.
 */

import { describe, expect, it } from "vitest";
import { isStoryStub, serializeStoryToMarkdown } from "../story-to-markdown";
import type { UserStory } from "../types";

const FIXED_GENERATED_AT = "2026-05-05T12:00:00.000Z";
const PROJECT = { name: "Acme Web" };

function makeStory(overrides: Partial<UserStory> & { id: string }): UserStory {
	return {
		id: overrides.id,
		identifier: overrides.identifier ?? `F-${overrides.id}`,
		title: overrides.title ?? "Test story",
		description: overrides.description ?? null,
		acceptanceCriteria: overrides.acceptanceCriteria ?? null,
		statusId: overrides.statusId ?? "status-1",
		kind: overrides.kind ?? "FEATURE",
		priority: overrides.priority ?? "P1_HIGH",
		size: overrides.size === undefined ? "M" : overrides.size,
		storyPoints: overrides.storyPoints ?? null,
		order: overrides.order ?? 1,
		roadmapOrder: overrides.roadmapOrder ?? 1,
		tasks: overrides.tasks ?? [],
		assigneeId: null,
		createdById: "user-1",
		createdAt: new Date("2026-05-01T00:00:00.000Z"),
		updatedAt: new Date("2026-05-01T00:00:00.000Z"),
		externalId: null,
		externalUrl: null,
		source: "manual",
		version: 1,
		draftingStage: overrides.draftingStage ?? "DRAFT",
		draftingStageUpdatedAt: null,
	};
}

describe("serializeStoryToMarkdown", () => {
	it("renders a full feature with description, AC, and tasks", () => {
		const story = makeStory({
			id: "1166",
			identifier: "F-1166",
			title: "As a user, I want to authenticate with passkeys",
			description: "Allow customers to sign in with WebAuthn passkeys.",
			acceptanceCriteria:
				"- Browser supports WebAuthn.\n- Fallback to password works.",
			tasks: [
				{
					id: "t1",
					identifier: "T-001",
					title: "Wire up WebAuthn ceremony",
					isCompleted: true,
					order: 1,
				},
				{
					id: "t2",
					identifier: "T-002",
					title: "Add fallback for unsupported browsers",
					isCompleted: false,
					order: 2,
				},
			],
		});
		const md = serializeStoryToMarkdown(story, PROJECT, {
			generatedAt: FIXED_GENERATED_AT,
		});
		const expected = [
			"# F-1166 — As a user, I want to authenticate with passkeys",
			"",
			"**Priority:** P1 - High · **Size:** M",
			"",
			"## Description",
			"",
			"Allow customers to sign in with WebAuthn passkeys.",
			"",
			"## Acceptance Criteria",
			"",
			"- Browser supports WebAuthn.",
			"- Fallback to password works.",
			"",
			"## Tasks",
			"",
			"- [x] T-001 Wire up WebAuthn ceremony",
			"- [ ] T-002 Add fallback for unsupported browsers",
			"",
			"---",
			"",
			"*Generated on 2026-05-05T12:00:00.000Z · Acme Web*",
			"",
		].join("\n");
		expect(md).toBe(expected);
	});

	it("omits Acceptance Criteria + Tasks sections when only description is present", () => {
		const story = makeStory({
			id: "10",
			identifier: "F-10",
			title: "Description only",
			description: "Just a description.",
		});
		const md = serializeStoryToMarkdown(story, PROJECT, {
			generatedAt: FIXED_GENERATED_AT,
		});
		expect(md).toContain("## Description");
		expect(md).not.toContain("## Acceptance Criteria");
		expect(md).not.toContain("## Tasks");
		expect(md).toContain("*Generated on");
	});

	it("omits Description + Tasks sections when only acceptance criteria is present", () => {
		const story = makeStory({
			id: "11",
			identifier: "F-11",
			title: "AC only",
			acceptanceCriteria: "- Has AC.",
		});
		const md = serializeStoryToMarkdown(story, PROJECT, {
			generatedAt: FIXED_GENERATED_AT,
		});
		expect(md).not.toContain("## Description");
		expect(md).toContain("## Acceptance Criteria");
		expect(md).not.toContain("## Tasks");
	});

	it("omits Description + AC sections when only tasks are present", () => {
		const story = makeStory({
			id: "12",
			identifier: "F-12",
			title: "Tasks only",
			tasks: [
				{
					id: "t1",
					identifier: "T-001",
					title: "Do thing",
					isCompleted: false,
					order: 1,
				},
			],
		});
		const md = serializeStoryToMarkdown(story, PROJECT, {
			generatedAt: FIXED_GENERATED_AT,
		});
		expect(md).not.toContain("## Description");
		expect(md).not.toContain("## Acceptance Criteria");
		expect(md).toContain("## Tasks");
		expect(md).toContain("- [ ] T-001 Do thing");
	});

	it("renders mixed completed/incomplete tasks correctly", () => {
		const story = makeStory({
			id: "13",
			identifier: "F-13",
			title: "Mixed",
			description: "Mixed task states.",
			tasks: [
				{
					id: "t1",
					identifier: "T-001",
					title: "Done thing",
					isCompleted: true,
					order: 1,
				},
				{
					id: "t2",
					identifier: "T-002",
					title: "Open thing",
					isCompleted: false,
					order: 2,
				},
				{
					id: "t3",
					identifier: "T-003",
					title: "Another done",
					isCompleted: true,
					order: 3,
				},
			],
		});
		const md = serializeStoryToMarkdown(story, PROJECT, {
			generatedAt: FIXED_GENERATED_AT,
		});
		expect(md).toContain("- [x] T-001 Done thing");
		expect(md).toContain("- [ ] T-002 Open thing");
		expect(md).toContain("- [x] T-003 Another done");
	});

	it("omits the Size chip when size is null but keeps the Priority chip", () => {
		const story = makeStory({
			id: "14",
			identifier: "F-14",
			title: "No size, no story points",
			description: "Has description.",
			size: null,
			storyPoints: null,
		});
		const md = serializeStoryToMarkdown(story, PROJECT, {
			generatedAt: FIXED_GENERATED_AT,
		});
		expect(md).toContain("**Priority:** P1 - High");
		expect(md).not.toContain("**Size:**");
	});
});

describe("isStoryStub (truth table)", () => {
	it.each<{
		name: string;
		draftingStage: UserStory["draftingStage"];
		description: string | null;
		acceptanceCriteria: string | null;
		tasksCount: number;
		expected: boolean;
	}>([
		{
			name: "PLACEHOLDER stage with content + tasks → not a stub (stage is irrelevant)",
			draftingStage: "PLACEHOLDER",
			description: "x",
			acceptanceCriteria: "x",
			tasksCount: 3,
			expected: false,
		},
		{
			name: "PLACEHOLDER stage with empty content and 0 tasks → stub",
			draftingStage: "PLACEHOLDER",
			description: "",
			acceptanceCriteria: null,
			tasksCount: 0,
			expected: true,
		},
		{
			name: "DRAFT with empty content but 3 tasks → not a stub",
			draftingStage: "DRAFT",
			description: "",
			acceptanceCriteria: null,
			tasksCount: 3,
			expected: false,
		},
		{
			name: "DRAFT with empty content and 0 tasks → stub",
			draftingStage: "DRAFT",
			description: "",
			acceptanceCriteria: null,
			tasksCount: 0,
			expected: true,
		},
		{
			name: "DRAFT with description, null AC, 0 tasks → not a stub",
			draftingStage: "DRAFT",
			description: "x",
			acceptanceCriteria: null,
			tasksCount: 0,
			expected: false,
		},
		{
			name: "DRAFT with null description, has AC, 0 tasks → not a stub",
			draftingStage: "DRAFT",
			description: null,
			acceptanceCriteria: "x",
			tasksCount: 0,
			expected: false,
		},
		{
			name: "CLOSED with full content → not a stub",
			draftingStage: "CLOSED",
			description: "x",
			acceptanceCriteria: "x",
			tasksCount: 5,
			expected: false,
		},
	])(
		"$name",
		({
			draftingStage,
			description,
			acceptanceCriteria,
			tasksCount,
			expected,
		}) => {
			const story = makeStory({
				id: "stub",
				draftingStage,
				description,
				acceptanceCriteria,
				tasks: Array.from({ length: tasksCount }, (_, idx) => ({
					id: `t${idx}`,
					identifier: `T-${idx}`,
					title: `Task ${idx}`,
					isCompleted: false,
					order: idx + 1,
				})),
			});
			expect(isStoryStub(story)).toBe(expected);
		},
	);

	it("treats HTML whitespace-only descriptions as empty", () => {
		const story = makeStory({
			id: "html",
			draftingStage: "DRAFT",
			description: "<p></p>",
			acceptanceCriteria: "<p>   </p>",
			tasks: [],
		});
		expect(isStoryStub(story)).toBe(true);
	});

	it("treats markdown whitespace-only descriptions as empty", () => {
		const story = makeStory({
			id: "ws",
			draftingStage: "DRAFT",
			description: "   ",
			acceptanceCriteria: "\n\n",
			tasks: [],
		});
		expect(isStoryStub(story)).toBe(true);
	});
});
