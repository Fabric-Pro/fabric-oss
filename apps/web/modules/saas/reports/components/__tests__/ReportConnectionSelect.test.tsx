import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReportConnectionSelect } from "../ReportConnectionSelect";

const NOTHING_CONNECTED = {
	category: null,
	recommended: [],
	related: [],
	others: [],
};

function show(
	connections: "loading" | "failed" | "answered",
	onRetryConnections = vi.fn(),
) {
	render(
		<ReportConnectionSelect
			groups={NOTHING_CONNECTED}
			value=""
			onValueChange={vi.fn()}
			placeholder="Select..."
			connectHref="/app/mcp-servers"
			connections={connections}
			onRetryConnections={onRetryConnections}
		/>,
	);
	return onRetryConnections;
}

describe("ReportConnectionSelect", () => {
	it("says nothing is connected only once the list has answered", () => {
		show("answered");

		expect(screen.getByText("No tools are connected yet.")).toBeTruthy();
		expect(
			screen.getByRole("link", { name: /Connect a tool/ }),
		).toBeTruthy();
	});

	it("shows loading, not an empty list, until then", () => {
		show("loading");

		expect(screen.getByText(/Loading your connected tools/)).toBeTruthy();
		expect(screen.queryByText("No tools are connected yet.")).toBeNull();
		expect(screen.queryByRole("link")).toBeNull();
	});

	it("shows a failed list as a failure, with a retry", () => {
		const retry = show("failed");

		expect(screen.getByRole("alert")).toHaveTextContent(
			"Your connected tools could not be loaded.",
		);
		expect(screen.queryByText("No tools are connected yet.")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: /Try again/ }));

		expect(retry).toHaveBeenCalledTimes(1);
	});
});
