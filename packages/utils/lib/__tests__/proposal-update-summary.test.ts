import { describe, expect, it } from "vitest";
import {
	buildLineHunks,
	changedLineHunks,
	describeLineCounts,
	listDepthLines,
	proposalUpdateAppliedNoteLines,
	proposalUpdateRejectedNoteLines,
	summarizeProposalUpdate,
} from "../proposal-update-summary";

describe("summarizeProposalUpdate", () => {
	it("lists only the fields whose value moves, in a fixed order", () => {
		const lines = summarizeProposalUpdate({
			size: { from: "S", to: "M" },
			title: { from: "Export report", to: "Export report as CSV" },
			priority: { from: "P2_MEDIUM", to: "P2_MEDIUM" },
			description: { from: "Same body", to: "Same body" },
		});

		expect(lines.map((line) => line.field)).toEqual(["title", "size"]);
		expect(lines[0]?.explanation).toBe(
			"Renamed “Export report” → “Export report as CSV”",
		);
		expect(lines[1]?.explanation).toBe("S → M");
	});

	it("counts criteria added and removed, quoting the first added", () => {
		const [line] = summarizeProposalUpdate({
			acceptanceCriteria: {
				from: "- [ ] Users can export\n- [ ] Old criterion",
				to: "- [ ] Users can export\n- [ ] Export includes headers\n- [ ] Export is UTF-8",
			},
		});

		expect(line).toEqual({
			field: "acceptanceCriteria",
			label: "Acceptance criteria",
			explanation: "Adds “Export includes headers”",
			added: 2,
			removed: 1,
		});
	});

	it("counts one multi-line Given / When / Then criterion as one", () => {
		const [line] = summarizeProposalUpdate({
			acceptanceCriteria: {
				from: "",
				to: "Given a signed-in user\nWhen they export the report\nThen a CSV file downloads\nAnd it has a header row",
			},
		});

		expect(line?.added).toBe(1);
		expect(describeLineCounts("acceptanceCriteria", 1, 0)).toBe(
			"1 criterion added",
		);
	});

	it("counts each numbered criterion with its steps as one", () => {
		const [line] = summarizeProposalUpdate({
			acceptanceCriteria: {
				from: "",
				to: "1. GIVEN a draft\n   WHEN it is saved\n   THEN it is listed\n2) Given a saved draft\n   When it is deleted\n   Then it is gone",
			},
		});

		expect(line?.added).toBe(2);
	});

	it("counts plain criteria lines one each", () => {
		const [line] = summarizeProposalUpdate({
			acceptanceCriteria: {
				from: "Export works",
				to: "Export works\nExport is UTF-8\nExport has headers",
			},
		});

		expect(line?.added).toBe(2);
		expect(line?.removed).toBe(0);
	});

	it("quotes the first removed line when nothing was added", () => {
		const [line] = summarizeProposalUpdate({
			description: {
				from: "Intro\n\n## Notes\nDrop this line",
				to: "Intro\n\n## Notes",
			},
		});

		expect(line?.explanation).toBe("Removes “Drop this line”");
		expect(line?.added).toBe(0);
		expect(line?.removed).toBe(1);
	});

	it("cuts a long changed line to a short quote", () => {
		const long = "word ".repeat(60).trim();
		const [line] = summarizeProposalUpdate({
			description: { from: "", to: long },
		});

		expect(line?.explanation.length).toBeLessThanOrEqual(
			"Adds “”".length + 120,
		);
		expect(line?.explanation.endsWith("…”")).toBe(true);
	});

	it("quotes a changed line as plain text", () => {
		const [line] = summarizeProposalUpdate({
			description: { from: "", to: "## **Retry** the `sync` job" },
		});

		expect(line?.explanation).toBe("Adds “Retry the sync job”");
	});

	it("reads a whitespace-only body edit as formatting", () => {
		const [line] = summarizeProposalUpdate({
			description: { from: "A\nB", to: "A\n\nB" },
		});

		expect(line?.explanation).toBe("Formatting changes only");
		expect(line?.added).toBe(0);
	});

	it("does not count lines the editor only re-indented", () => {
		const from = [
			"- Q: Which notifications?",
			"    - Why it matters: Defines the choices.",
			"    - Owner: Product",
			"Old closing line.",
		].join("\n");
		const to = [
			"- Q: Which notifications?",
			"  - Why it matters: Defines the choices.",
			"  - Owner: Product",
			"New closing line.",
		].join("\n");

		const [line] = summarizeProposalUpdate({ description: { from, to } });

		expect(line?.added).toBe(1);
		expect(line?.removed).toBe(1);
		expect(line?.explanation).toBe("Adds “New closing line.”");
	});

	it("reads an indentation-only body edit as formatting", () => {
		const [line] = summarizeProposalUpdate({
			description: { from: "- A\n    - B", to: "- A\n  - B" },
		});

		expect(line?.explanation).toBe("Formatting changes only");
		expect(line?.added).toBe(0);
		expect(line?.removed).toBe(0);
	});

	it.each([
		{
			name: "a nested bullet moved to the top level",
			from: "- A\n  - B",
			to: "- A\n- B",
			adds: "B",
		},
		{
			name: "indentation inside a fenced code block",
			from: "Steps:\n```\nif ok:\n    run()\n```",
			to: "Steps:\n```\nif ok:\nrun()\n```",
			adds: "run()",
		},
		{
			name: "an indented code paragraph made plain text",
			from: "Run:\n\n    pnpm build",
			to: "Run:\n\npnpm build",
			adds: "pnpm build",
		},
		{
			name: "code inside a list item made plain text",
			from: "- Run:\n\n      pnpm build",
			to: "- Run:\n\n  pnpm build",
			adds: "pnpm build",
		},
		{
			name: "a removed hard break",
			from: "First line  \nSecond line",
			to: "First line\nSecond line",
			adds: "First line",
		},
	])("counts $name as a change", ({ from, to, adds }) => {
		const [line] = summarizeProposalUpdate({ description: { from, to } });

		expect(line?.added).toBe(1);
		expect(line?.removed).toBe(1);
		expect(line?.explanation).toBe(`Adds “${adds}”`);
	});

	it("does not treat an empty title, priority or size as a change", () => {
		expect(
			summarizeProposalUpdate({
				title: { from: "Keep", to: "" },
				priority: { from: "P1_HIGH", to: null },
				size: null,
			}),
		).toEqual([]);
	});

	it("does not read a title without a previous value as a rename", () => {
		expect(summarizeProposalUpdate({ title: { to: "Kept" } })).toEqual([]);
	});

	it("describes a value set without a previous one", () => {
		const [line] = summarizeProposalUpdate({
			priority: { to: "P1_HIGH" },
		});

		expect(line?.explanation).toBe("Set to P1_HIGH");
	});
});

describe("listDepthLines", () => {
	const depths = (text: string) =>
		listDepthLines(text).map((line) => line.depth);

	it("reads a list the editor re-indented at the same depths", () => {
		const nested = "- Q\n    - Why\n    - Owner\n- Next";

		expect(depths(nested)).toEqual([0, 1, 1, 0]);
		expect(depths(nested.replace(/^ {4}/gm, "  "))).toEqual([0, 1, 1, 0]);
	});

	it("reads a line moved up a level at its new depth", () => {
		expect(depths("- Q\n- Why\n    - Owner\n- Next")).toEqual([0, 0, 1, 0]);
	});

	it("reads a fence in a list item at the item's depth, as it is", () => {
		expect(listDepthLines("- Step\n  ```\n  code\n  ```\n- Next")).toEqual([
			{ depth: 0, text: "- Step" },
			{ depth: 1, text: "  ```" },
			{ depth: 1, text: "  code" },
			{ depth: 1, text: "  ```" },
			{ depth: 0, text: "- Next" },
		]);
	});

	it("keeps lines outside a list at depth 0, as they are", () => {
		const text = "Intro\n\n```\n    code\n```";

		expect(listDepthLines(text)).toEqual(
			text.split("\n").map((line) => ({ depth: 0, text: line })),
		);
	});
});

describe("buildLineHunks / changedLineHunks", () => {
	const from = "Intro\nOld step\nShared\nRemove me\nTail";
	const to = "Intro\nNew step\nShared\nTail\nAdded at end";

	it("numbers each changed region", () => {
		const hunks = changedLineHunks(from, to).map((hunk) => [
			hunk.id,
			hunk.removed,
			hunk.added,
		]);

		expect(hunks).toEqual([
			[0, ["Old step"], ["New step"]],
			[1, ["Remove me"], []],
			[2, [], ["Added at end"]],
		]);
	});

	it("treats an empty side as no lines to share", () => {
		expect(buildLineHunks("", "")).toEqual([]);
		expect(changedLineHunks("", "x\ny").map((hunk) => hunk.added)).toEqual([
			["x", "y"],
		]);
	});
});

describe("Decision Log note lines", () => {
	it("lists the applied changes, then why and what prompted them", () => {
		expect(
			proposalUpdateAppliedNoteLines(
				{
					title: { from: "Old", to: "New" },
					priority: { from: "P3_LOW", to: "P1_HIGH" },
				},
				{
					reasoning: "The team asked\nfor this in standup.",
					source: "SLACK_CHANNEL",
					proposalSummary:
						"Two backlog updates from the release thread",
				},
			),
		).toEqual([
			"Proposed update reviewed and applied.",
			"Title: Renamed “Old” → “New”",
			"Priority: P3_LOW → P1_HIGH",
			"Why: The team asked for this in standup.",
			"Prompted by a Slack channel: Two backlog updates from the release thread",
		]);
	});

	it("logs only the real change when the editor re-indented a nested list", () => {
		const [, line] = proposalUpdateAppliedNoteLines(
			{
				description: {
					from: "- Gap\n    - Impact: unclear\nStep one",
					to: "- Gap\n  - Impact: unclear\nStep one (changed)",
				},
			},
			{},
		);

		expect(line).toBe(
			"Description: 1 line added, 1 removed. Adds “Step one (changed)”",
		);
	});

	it("includes line counts for body changes", () => {
		const [, line] = proposalUpdateAppliedNoteLines(
			{ description: { from: "A", to: "A\nB\nC" } },
			{},
		);

		expect(line).toBe("Description: 2 lines added. Adds “B”");
	});

	it("counts acceptance criteria as the review summary does", () => {
		const [, line] = proposalUpdateAppliedNoteLines(
			{
				acceptanceCriteria: {
					from: "",
					to: "Given a user\nWhen they export\nThen a CSV downloads",
				},
			},
			{},
		);

		expect(line).toBe(
			"Acceptance criteria: 1 criterion added. Adds “Given a user”",
		);
	});

	it("writes nothing when no field moved", () => {
		expect(
			proposalUpdateAppliedNoteLines(
				{ title: { from: "Same", to: "Same" } },
				{ reasoning: "x" },
			),
		).toEqual([]);
	});

	it("writes the fully-rejected note with the item's reasoning", () => {
		expect(
			proposalUpdateRejectedNoteLines({ reasoning: "Customer asked" }),
		).toEqual([
			"Proposed update reviewed in the Proposal Inbox and fully rejected; no changes applied.",
			"Why: Customer asked",
		]);
	});
});
