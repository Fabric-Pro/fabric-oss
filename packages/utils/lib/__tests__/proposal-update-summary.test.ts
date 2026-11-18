import { describe, expect, it } from "vitest";
import {
	buildLineHunks,
	changedLineHunks,
	describeLineCounts,
	mergeAcceptedHunks,
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

describe("buildLineHunks / mergeAcceptedHunks", () => {
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

	it("rebuilds the proposed text when every region is accepted", () => {
		expect(mergeAcceptedHunks(from, to, new Set())).toBe(to);
	});

	it("rebuilds the original text when every region is rejected", () => {
		expect(mergeAcceptedHunks(from, to, new Set([0, 1, 2]))).toBe(from);
	});

	it("keeps a rejected removal and drops a rejected addition", () => {
		expect(mergeAcceptedHunks(from, to, new Set([1, 2]))).toBe(
			"Intro\nNew step\nShared\nRemove me\nTail",
		);
	});

	it("keeps a rejected replacement's original lines", () => {
		expect(mergeAcceptedHunks(from, to, new Set([0]))).toBe(
			"Intro\nOld step\nShared\nTail\nAdded at end",
		);
	});

	it("keeps a final newline exactly as each side has it", () => {
		expect(mergeAcceptedHunks("a\nb\n", "a\nc", new Set())).toBe("a\nc");
		expect(mergeAcceptedHunks("a\nb\n", "a\nc", new Set([0]))).toBe(
			"a\nb\n",
		);
	});

	it("treats an empty side as no lines to share", () => {
		expect(buildLineHunks("", "")).toEqual([]);
		expect(mergeAcceptedHunks("", "x\ny", new Set())).toBe("x\ny");
		expect(mergeAcceptedHunks("", "x\ny", new Set([0]))).toBe("");
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
