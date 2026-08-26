/**
 * ProposalDiffField — shows the region that CHANGED, not the first 80
 * characters of each side.
 *
 * The regression this guards was invisible to every earlier test because the
 * fixtures used short bodies. On staging, a real structure-preserving
 * enrichment took a ticket from 10,585 to 15,605 characters by inserting detail
 * inside the body — and the field rendered a strikethrough line and a green
 * line that were byte-identical, because both truncated to the same opening
 * words. The reviewer was shown a diff that told them nothing.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { changedRegion, ProposalDiffField } from "../ProposalDiffField";

describe("changedRegion", () => {
	it("isolates an insertion made deep inside a long body", () => {
		const opening = "# Feature\n\n".padEnd(600, "context ");
		const closing = "\n\n## Acceptance\n".padEnd(400, "criteria ");
		const from = `${opening}${closing}`;
		const to = `${opening}NEW DETAIL FROM THE MEETING${closing}`;

		const region = changedRegion(from, to);

		expect(region.added).toBe("NEW DETAIL FROM THE MEETING");
		expect(region.removed).toBe("");
		expect(region.elidedBefore).toBe(true);
		expect(region.elidedAfter).toBe(true);
	});

	it("returns an empty region for identical strings", () => {
		expect(changedRegion("same", "same")).toEqual({
			removed: "",
			added: "",
			elidedBefore: false,
			elidedAfter: false,
		});
	});

	it("handles a pure append", () => {
		const region = changedRegion("Original body.", "Original body. Added.");
		expect(region.removed).toBe("");
		expect(region.added).toBe(" Added.");
		expect(region.elidedBefore).toBe(true);
		expect(region.elidedAfter).toBe(false);
	});

	it("handles a pure prepend", () => {
		const region = changedRegion("body", "new body");
		expect(region.removed).toBe("");
		expect(region.added).toBe("new ");
	});

	it("handles a wholesale rewrite with nothing in common", () => {
		const region = changedRegion("aaa", "bbb");
		expect(region.removed).toBe("aaa");
		expect(region.added).toBe("bbb");
		expect(region.elidedBefore).toBe(false);
		expect(region.elidedAfter).toBe(false);
	});

	it("does not let prefix and suffix overlap on repeating input", () => {
		// "aaaa" vs "aaaaaa": a naive suffix scan would double-count the shared
		// run and produce negative slice bounds.
		const region = changedRegion("aaaa", "aaaaaa");
		expect(region.removed).toBe("");
		expect(region.added).toBe("aa");
		expect(region.added.length).toBe(2);
	});
});

describe("ProposalDiffField", () => {
	it("shows the inserted text, not the shared opening words", () => {
		const opening =
			"As a project team member who uses Slack Huddles".padEnd(
				9000,
				" filler",
			);
		render(
			<ProposalDiffField
				label="Description"
				from={opening}
				to={`${opening}\n\nDecision: prioritise this for Teams parity.`}
			/>,
		);

		expect(
			screen.getByText(/Decision: prioritise this for Teams parity/),
		).toBeInTheDocument();
		// The old behaviour rendered this on BOTH sides; it must appear on
		// neither, because that opening is unchanged.
		expect(
			screen.queryByText(/^As a project team member who uses Slack/),
		).not.toBeInTheDocument();
	});

	it("renders only an added line when a long body is appended to", () => {
		const body = "Existing body. ".padEnd(400, "detail ");
		const { container } = render(
			<ProposalDiffField
				label="Description"
				from={body}
				to={`${body}APPENDED.`}
			/>,
		);

		// Nothing was removed, so there is no strikethrough line to render.
		expect(container.querySelectorAll(".line-through")).toHaveLength(0);
		expect(screen.getByText(/APPENDED\./)).toBeInTheDocument();
	});

	it("shows a short value whole rather than eliding its shared characters", () => {
		// Narrowing is for long bodies that would otherwise truncate to the same
		// opening words. On a short value it would render "…2_MEDIUM", which is
		// harder to read than the value.
		render(
			<ProposalDiffField
				label="Priority"
				from="P2_MEDIUM"
				to="P1_HIGH"
			/>,
		);

		expect(screen.getByText("P2_MEDIUM")).toBeInTheDocument();
		expect(screen.getByText("P1_HIGH")).toBeInTheDocument();
	});

	it("renders both sides for a genuine replacement", () => {
		const { container } = render(
			<ProposalDiffField
				label="Priority"
				from="P2_MEDIUM"
				to="P1_HIGH"
			/>,
		);

		expect(container.querySelectorAll(".line-through")).toHaveLength(1);
		expect(screen.getByText(/P2_MEDIUM/)).toBeInTheDocument();
		expect(screen.getByText(/P1_HIGH/)).toBeInTheDocument();
	});

	it("says so when the edit is invisible rather than showing two blank lines", () => {
		render(<ProposalDiffField label="Description" from="Body" to="Body" />);
		expect(
			screen.getByText(/Formatting only — no visible text change/),
		).toBeInTheDocument();
	});
});
