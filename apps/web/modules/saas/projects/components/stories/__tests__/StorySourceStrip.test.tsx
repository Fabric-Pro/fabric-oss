import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StorySourceStrip } from "../StorySourceStrip";

const SOURCE_URL =
	"https://teams.microsoft.com/l/message/19:example-chat@thread.v2/1726000000000";

const none = {
	reporterName: null,
	reporterSource: null,
	reporterSourceUrl: null,
};

describe("StorySourceStrip", () => {
	it("links a feature approved from a Teams proposal back to its conversation", () => {
		render(
			<StorySourceStrip
				story={{
					...none,
					kind: "FEATURE",
					reporterSource: "TEAMS",
					reporterSourceUrl: SOURCE_URL,
				}}
			/>,
		);

		expect(screen.getByText("Proposed via TEAMS")).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "View source conversation →" }),
		).toHaveAttribute("href", SOURCE_URL);
	});

	it("keeps a bug's reporter strip, with its source link and reporter", () => {
		render(
			<StorySourceStrip
				story={{
					kind: "BUG",
					reporterName: "Jane",
					reporterSource: "SLACK",
					reporterSourceUrl: SOURCE_URL,
				}}
			/>,
		);

		expect(screen.getByText("Reported via SLACK")).toBeInTheDocument();
		expect(screen.getByText("Jane")).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "View source conversation →" }),
		).toHaveAttribute("href", SOURCE_URL);
	});

	it("shows a bug's reporter source even without a link", () => {
		render(
			<StorySourceStrip
				story={{ ...none, kind: "BUG", reporterSource: "TEAMS" }}
			/>,
		);

		expect(screen.getByText("Reported via TEAMS")).toBeInTheDocument();
		expect(screen.queryByRole("link")).toBeNull();
	});

	it.each([
		[
			"a feature with no source link",
			{
				...none,
				kind: "FEATURE" as const,
				reporterSource: "TEAMS" as const,
			},
		],
		["a hand-entered feature", { ...none, kind: "FEATURE" as const }],
		[
			"a legacy bug with no reporter fields",
			{ ...none, kind: "BUG" as const },
		],
	])("renders nothing for %s", (_label, story) => {
		const { container } = render(<StorySourceStrip story={story} />);

		expect(container).toBeEmptyDOMElement();
	});
});
