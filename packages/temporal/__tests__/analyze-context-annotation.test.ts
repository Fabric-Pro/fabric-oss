import { describe, expect, it } from "vitest";
import { annotateProposalResolutions } from "../src/activities/backlog-context/analyze-context";

const stories = [
	{
		id: "ckaaaaaaaaaaaaaaaaaaaaaaa",
		identifier: "F-1",
		title: "Login page",
		externalId: null,
	},
];

describe("annotateProposalResolutions", () => {
	it("normalizes a resolved update to the canonical identifier + title", () => {
		const changes = [
			{
				type: "feature",
				action: "update",
				existingIdentifier: "F-1",
				title: { from: "Login page", to: "Login page v2" },
				reasoning: "r",
				sourceContext: "teams_messages",
			},
		];
		const out = annotateProposalResolutions(changes as never, stories);
		expect(out[0].action).toBe("update");
		expect(out[0].existingId).toBe("ckaaaaaaaaaaaaaaaaaaaaaaa");
		expect(out[0].targetResolution).toMatchObject({
			status: "resolved",
			resolvedBy: "identifier",
			resolvedIdentifier: "F-1",
			resolvedTitle: "Login page",
		});
	});

	it("demotes a phantom update to a labeled create", () => {
		const changes = [
			{
				type: "feature",
				action: "update",
				existingId: "FEAT-023",
				existingIdentifier: "FEAT-023",
				title: { to: "Feature Maturation Workflow Redesign" },
				reasoning: "r",
				sourceContext: "meeting_transcript",
			},
		];
		const out = annotateProposalResolutions(changes as never, stories);
		expect(out[0].action).toBe("create");
		expect(out[0].existingId).toBeNull();
		expect(out[0].existingIdentifier).toBeNull();
		expect(out[0].targetResolution).toMatchObject({
			status: "unresolved",
			demotedFromUpdate: true,
		});
	});

	it("leaves create actions untouched", () => {
		const changes = [
			{
				type: "bug",
				action: "create",
				title: { to: "New bug" },
				reasoning: "r",
				sourceContext: "slack_messages",
			},
		];
		const out = annotateProposalResolutions(changes as never, stories);
		expect(out[0].action).toBe("create");
		expect(out[0].targetResolution).toBeUndefined();
	});

	it("resolves an update by externalId", () => {
		const storiesWithExt = [
			{
				id: "ckccccccccccccccccccccccc",
				identifier: "F-9",
				title: "Sync engine",
				externalId: "JIRA-42",
			},
		];
		const changes = [
			{
				type: "feature",
				action: "update",
				existingExternalId: "JIRA-42",
				title: { to: "Sync engine v2" },
				reasoning: "r",
				sourceContext: "teams_messages",
			},
		];
		const out = annotateProposalResolutions(
			changes as never,
			storiesWithExt,
		);
		expect(out[0].action).toBe("update");
		expect(out[0].existingId).toBe("ckccccccccccccccccccccccc");
		expect(out[0].targetResolution).toMatchObject({
			status: "resolved",
			resolvedBy: "externalId",
		});
	});

	it("annotates a mixed array element-wise", () => {
		const changes = [
			{
				type: "feature",
				action: "update",
				existingIdentifier: "F-1",
				title: { to: "Login page v2" },
				reasoning: "r",
				sourceContext: "teams_messages",
			},
			{
				type: "bug",
				action: "update",
				existingId: "FEAT-999",
				title: { to: "Phantom" },
				reasoning: "r",
				sourceContext: "meeting_transcript",
			},
			{
				type: "bug",
				action: "create",
				title: { to: "Brand new" },
				reasoning: "r",
				sourceContext: "slack_messages",
			},
		];
		const out = annotateProposalResolutions(changes as never, stories);
		expect(out[0].targetResolution).toMatchObject({ status: "resolved" });
		expect(out[1].action).toBe("create");
		expect(out[1].targetResolution).toMatchObject({
			status: "unresolved",
			demotedFromUpdate: true,
		});
		expect(out[2].action).toBe("create");
		expect(out[2].targetResolution).toBeUndefined();
	});
});
