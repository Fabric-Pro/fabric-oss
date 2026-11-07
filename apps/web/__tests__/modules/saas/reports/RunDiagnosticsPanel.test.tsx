import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationSlug: () => "example-org",
}));

import { RunDiagnosticsPanel } from "../../../../modules/saas/reports/components/RunDiagnosticsPanel";

describe("RunDiagnosticsPanel", () => {
	it("shows Reconnect only for recoverable outcomes and routes to org MCP settings", () => {
		render(
			<RunDiagnosticsPanel
				diagnostics={[
					{
						providerType: "github",
						displayLabel: "GitHub issues",
						status: "auth_failed",
						reasonCode: "AUTH_REQUIRED",
						toolCount: 0,
						readOnlyToolCount: 0,
					},
					{
						providerType: "other",
						displayLabel: "Team notes",
						status: "no_read_only_tools",
						reasonCode: "NO_SAFE_TOOLS",
						toolCount: 3,
						readOnlyToolCount: 0,
					},
				]}
			/>,
		);
		const reconnect = screen.getByLabelText("Reconnect GitHub issues");
		expect(reconnect).toHaveAttribute(
			"href",
			"/app/example-org/settings/mcp",
		);
		expect(screen.queryByLabelText("Reconnect Team notes")).toBeNull();
		expect(screen.getByText("0/3 read-only tools")).toBeInTheDocument();
	});

	it("renders nothing when diagnostics are empty", () => {
		const { container } = render(<RunDiagnosticsPanel diagnostics={[]} />);
		expect(container).toBeEmptyDOMElement();
	});
});

it("labels unavailable or bounded diagnostics without fabricated zero counts", () => {
	render(
		<RunDiagnosticsPanel
			diagnostics={[
				{
					providerType: "other",
					displayLabel: "Team notes",
					status: "unavailable",
					reasonCode: "DIAGNOSTICS_TRUNCATED",
					toolCount: null,
					readOnlyToolCount: null,
				},
			]}
		/>,
	);
	expect(
		screen.getByText("Additional source details omitted"),
	).toBeInTheDocument();
	expect(screen.getByText("Tool counts unavailable")).toBeInTheDocument();
	expect(screen.queryByText("0/0 read-only tools")).not.toBeInTheDocument();
});

it("gives two MCP failures distinct report-source labels and reconnect accessible names", () => {
	render(
		<RunDiagnosticsPanel
			diagnostics={[
				{
					providerType: "other",
					displayLabel: "Delivery board",
					status: "auth_failed",
					reasonCode: "AUTH_REQUIRED",
					toolCount: 0,
					readOnlyToolCount: 0,
				},
				{
					providerType: "other",
					displayLabel: "Team documentation",
					status: "unreachable",
					reasonCode: "NETWORK_UNAVAILABLE",
					toolCount: 0,
					readOnlyToolCount: 0,
				},
			]}
		/>,
	);
	expect(
		screen.getByRole("link", { name: "Reconnect Delivery board" }),
	).toHaveAttribute("href", "/app/example-org/settings/mcp");
	expect(
		screen.getByRole("link", { name: "Reconnect Team documentation" }),
	).toHaveAttribute("href", "/app/example-org/settings/mcp");
});
