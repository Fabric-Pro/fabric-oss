import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GitLabLabelStatusMapEditor } from "../GitLabLabelStatusMapEditor";

describe("GitLabLabelStatusMapEditor — help copy (spec D1.8, Fizzy #2304)", () => {
	it("states the real matching rule instead of 'first match wins'", () => {
		render(
			<GitLabLabelStatusMapEditor
				value={{}}
				onChange={vi.fn()}
				statuses={[]}
			/>,
		);

		const help = screen.getByText(/Labels are matched case-sensitively\./);
		expect(help).toHaveTextContent(
			"One mapped label, or several labels mapped to the same status, sets the status",
		);
		expect(help).toHaveTextContent(
			"Labels mapped to different statuses change nothing",
		);
		expect(help).toHaveTextContent(
			"on import, on Pull, and on the hourly sync while “Keep status in sync with the PM tool” is on",
		);
		expect(help).toHaveTextContent(
			"editing it moves stories that are already linked",
		);
		expect(screen.queryByText(/first match wins/i)).toBeNull();
	});
});
