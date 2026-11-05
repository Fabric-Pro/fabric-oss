import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	probe: {} as Record<string, unknown>,
	refetch: vi.fn(),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		reports: {
			instances: {
				probeConnections: {
					queryOptions: () => ({ queryKey: ["probe"] }),
				},
			},
		},
	},
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({ refetch: m.refetch, ...m.probe }),
}));

import type { DataSourceDefinition } from "@saas/shared/components/DataSourceDefinitionBuilder";
import { CreateReportReadiness } from "../CreateReportReadiness";

const SOURCE: DataSourceDefinition = {
	id: "board",
	type: "mcp",
	provider: "github",
	operation: "list_issues",
};
const PASSED = {
	configId: "config-1",
	serverName: "Example server",
	outcome: "connected",
	toolCount: 3,
};

function show({
	bound = true,
	required = true,
}: {
	bound?: boolean;
	required?: boolean;
} = {}) {
	const onConnectionFailure = vi.fn();
	render(
		<CreateReportReadiness
			templateId="example-template"
			dataSources={[{ ...SOURCE, required }]}
			setup={{
				bindings: bound
					? {
							board: {
								mcpConfigId: "config-1",
								mcpConfigName: "Example server",
							},
						}
					: {},
				organizationId: "example-org",
				contextFields: [],
				contextValues: {},
			}}
			requiredParams={[]}
			outputFormat="MARKDOWN"
			onConnectionFailure={onConnectionFailure}
		/>,
	);
	return onConnectionFailure;
}

beforeEach(() => {
	vi.clearAllMocks();
	m.probe = {};
});

describe("CreateReportReadiness", () => {
	it("shows a neutral row, never a pass, while the test runs", () => {
		m.probe = { isFetching: true, data: { diagnostics: [PASSED] } };
		show();

		expect(screen.getByText("Testing")).toBeTruthy();
		expect(screen.queryByText("All checks passed")).toBeNull();
		expect(screen.getByRole("status")).toHaveTextContent(
			"Testing connections.",
		);
	});

	it("keeps Test again mounted while it runs, and ignores a click", () => {
		m.probe = { isFetching: true };
		show();

		const button = screen.getByRole("button", { name: "Test again" });
		expect(button).toHaveAttribute("aria-disabled", "true");

		fireEvent.click(button);

		expect(m.refetch).not.toHaveBeenCalled();
	});

	it("says Not tested after a failed test, even with an earlier pass in hand", () => {
		m.probe = { isError: true, data: { diagnostics: [PASSED] } };
		show();

		expect(screen.getByText("Not tested")).toBeTruthy();
		expect(screen.queryByText("All checks passed")).toBeNull();
		expect(screen.getByRole("status")).toHaveTextContent(
			"The connections could not be tested.",
		);
	});

	it("says Not tested when an optional source has nothing bound", () => {
		show({ bound: false, required: false });

		expect(screen.getByText("Not tested")).toBeTruthy();
		expect(screen.getByText(/No connection is chosen/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Test again" })).toBeNull();
	});

	it("passes the row only on a test that passed, and says so politely", () => {
		m.probe = { data: { diagnostics: [PASSED] } };
		show();

		expect(screen.getByText("All checks passed")).toBeTruthy();
		expect(screen.getByRole("status")).toHaveTextContent(
			"The connections passed the test.",
		);
		fireEvent.click(screen.getByRole("button", { name: "Test again" }));
		expect(m.refetch).toHaveBeenCalledTimes(1);
	});

	it("turns a failure with no message into a sentence, and reports it up", () => {
		m.probe = {
			data: {
				diagnostics: [
					{ ...PASSED, outcome: "no_read_only_tools", toolCount: 0 },
				],
			},
		};
		const onConnectionFailure = show();

		expect(screen.getByText(/It offers no read-only tools/)).toBeTruthy();
		expect(screen.queryByText(/no_read_only_tools/)).toBeNull();
		expect(onConnectionFailure).toHaveBeenCalledWith(
			"Example server did not pass the connection test.",
		);
	});
});
