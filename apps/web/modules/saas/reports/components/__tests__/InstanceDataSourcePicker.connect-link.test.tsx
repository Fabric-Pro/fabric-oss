import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useContextPath: (path: string) => `/app/example-org/${path}`,
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		mcp: {
			registry: {
				list: { queryOptions: () => ({ queryKey: ["registry"] }) },
			},
		},
	},
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({ data: undefined }),
}));
vi.mock("../ReportConnectionSelect", () => ({
	ReportConnectionSelect: ({ connectHref }: { connectHref: string }) => (
		<a href={connectHref}>Connect a tool</a>
	),
}));

import { InstanceDataSourcePicker } from "../InstanceDataSourceFields";

function connectHrefFor(source: Record<string, unknown>) {
	render(
		<InstanceDataSourcePicker
			setup={
				{
					userMcpConfigs: [],
					bindings: {},
					selectMcpConfig: vi.fn(),
					clearMcpConfig: vi.fn(),
					suggestDefaults: true,
					connectionsState: "loading",
				} as never
			}
			dataSources={[{ id: "source", type: "mcp", ...source } as never]}
		/>,
	);
	return screen.getByRole("link", { name: "Connect a tool" });
}

describe("InstanceDataSourcePicker's connect link", () => {
	it("stays in the organization on screen, naming the tool", () => {
		expect(connectHrefFor({ provider: "fizzy" })).toHaveAttribute(
			"href",
			"/app/example-org/mcp-servers?connect=fizzy",
		);
	});

	it("opens the organization's connections for a source of any tool", () => {
		expect(
			connectHrefFor({ dataType: "project-management" }),
		).toHaveAttribute("href", "/app/example-org/mcp-servers");
	});
});
