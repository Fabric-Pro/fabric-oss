import type { NewsletterContent } from "@repo/database";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ReleaseNotesListPublic } from "./ReleaseNotesListPublic";

const SENDS = [
	{
		id: "send-1",
		status: "SENT",
		createdAt: "2026-06-01T00:00:00.000Z",
		content: {
			headline: "First release",
			intro: "Intro copy",
		} as NewsletterContent,
	},
];

describe("ReleaseNotesListPublic", () => {
	it("renders no /release-notes/ link (the list is non-linking by construction)", () => {
		const { container } = render(
			<ReleaseNotesListPublic
				sends={SENDS}
				locale="en"
				emptyLabel="Nothing yet"
				fallbackHeadline="Release"
			/>,
		);

		expect(
			container.querySelector('a[href^="/release-notes/"]'),
		).toBeNull();
		// Content is still rendered, just without a per-row link.
		expect(container.textContent).toContain("First release");
		expect(container.textContent).toContain("Intro copy");
	});

	it("shows the empty label when there are no sends", () => {
		const { container } = render(
			<ReleaseNotesListPublic
				sends={[]}
				locale="en"
				emptyLabel="Nothing yet"
				fallbackHeadline="Release"
			/>,
		);

		expect(container.textContent).toContain("Nothing yet");
	});
});
