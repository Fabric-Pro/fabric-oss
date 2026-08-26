import { decideProposalAction } from "@repo/api/modules/projects/procedures/meeting-digest/generate-proposals";
import { describe, expect, it } from "vitest";

describe("decideProposalAction", () => {
	const t = (over: Record<string, unknown>) => ({
		contextId: "ctx1",
		analysisStatus: "NOT_SCANNED",
		analyzedProposalId: null,
		...over,
	});

	it("no transcript → no-transcript", () => {
		expect(decideProposalAction(t({ contextId: null }))).toEqual({
			kind: "no-transcript",
		});
	});
	it("NOT_SCANNED → start", () => {
		expect(decideProposalAction(t({}))).toEqual({
			kind: "start",
			resetFirst: false,
		});
	});
	it("FAILED → reset then start", () => {
		expect(decideProposalAction(t({ analysisStatus: "FAILED" }))).toEqual({
			kind: "start",
			resetFirst: true,
		});
	});
	it("IN_PROGRESS → in-progress", () => {
		expect(
			decideProposalAction(t({ analysisStatus: "IN_PROGRESS" })),
		).toEqual({ kind: "in-progress" });
	});
	it("SCANNED with proposal → already-analyzed", () => {
		expect(
			decideProposalAction(
				t({ analysisStatus: "SCANNED", analyzedProposalId: "prop1" }),
			),
		).toEqual({ kind: "already-analyzed", proposalId: "prop1" });
	});
	it("SCANNED without proposal → no-actionable-content", () => {
		expect(decideProposalAction(t({ analysisStatus: "SCANNED" }))).toEqual({
			kind: "no-actionable-content",
		});
	});
});
