import { describe, expect, it } from "vitest";
import { deriveProposalHeadline } from "../pending-backlog-proposals";

describe("deriveProposalHeadline", () => {
	it("returns '' for non-object / empty proposals", () => {
		expect(deriveProposalHeadline(null)).toBe("");
		expect(deriveProposalHeadline(undefined)).toBe("");
		expect(deriveProposalHeadline("nope")).toBe("");
		expect(deriveProposalHeadline([])).toBe("");
		expect(deriveProposalHeadline({})).toBe("");
		expect(deriveProposalHeadline({ changes: [] })).toBe("");
	});

	it("uses the first change's diff-shaped { to } title", () => {
		expect(
			deriveProposalHeadline({
				summary: "",
				changes: [{ type: "bug", title: { to: "Fix the thing" } }],
			}),
		).toBe("Fix the thing");
	});

	it("tolerates a legacy plain-string title", () => {
		expect(
			deriveProposalHeadline({
				changes: [{ title: "Plain title" }],
			}),
		).toBe("Plain title");
	});

	it("prefers `to`, falls back to `from` when `to` is blank/absent", () => {
		expect(
			deriveProposalHeadline({
				changes: [{ title: { from: "Old title" } }],
			}),
		).toBe("Old title");
		expect(
			deriveProposalHeadline({
				changes: [{ title: { from: "Old", to: "   " } }],
			}),
		).toBe("Old");
	});

	it("skips a leading change that has no title and uses the first titled one", () => {
		expect(
			deriveProposalHeadline({
				changes: [
					{
						type: "bug",
						reasoning: "edits an existing item, no title",
					},
					{ type: "feature", title: { to: "Real feature title" } },
				],
			}),
		).toBe("Real feature title (+1 more)");
	});

	it("annotates additional changes", () => {
		expect(
			deriveProposalHeadline({
				changes: [
					{ title: { to: "First change" } },
					{ title: { to: "Second change" } },
					{ title: { to: "Third change" } },
				],
			}),
		).toBe("First change (+2 more)");
	});

	it("trims whitespace and returns '' when the first change has no usable title", () => {
		expect(
			deriveProposalHeadline({
				changes: [{ title: { to: "  Padded  " } }],
			}),
		).toBe("Padded");
		expect(
			deriveProposalHeadline({
				changes: [{ type: "bug", reasoning: "no title here" }],
			}),
		).toBe("");
	});
});
