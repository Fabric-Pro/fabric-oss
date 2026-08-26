import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationSlug: () => "acme",
}));

import { RunDiagnosticsPanel } from "../../../../modules/saas/reports/components/RunDiagnosticsPanel";

describe("RunDiagnosticsPanel", () => {
	it("shows Reconnect only for recoverable outcomes and routes to org MCP settings", () => {
		render(
			<RunDiagnosticsPanel
				diagnostics={[
					{
						configId: "a",
						serverName: "GitHub",
						outcome: "auth_failed",
						toolCount: 0,
						readOnlyToolCount: 0,
					},
					{
						configId: "b",
						serverName: "Jira",
						outcome: "no_read_only_tools",
						toolCount: 3,
						readOnlyToolCount: 0,
					},
				]}
			/>,
		);
		const reconnect = screen.getByLabelText("Reconnect GitHub");
		expect(reconnect).toHaveAttribute("href", "/app/acme/settings/mcp");
		expect(screen.queryByLabelText("Reconnect Jira")).toBeNull();
		expect(screen.getByText("0/3 read-only tools")).toBeInTheDocument();
	});

	it("renders nothing when diagnostics are empty", () => {
		const { container } = render(<RunDiagnosticsPanel diagnostics={[]} />);
		expect(container).toBeEmptyDOMElement();
	});
});
