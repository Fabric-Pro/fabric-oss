import {
	act,
	fireEvent,
	render,
	renderHook,
	screen,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	pending: false,
	mutate: vi.fn(),
	execute: vi.fn(),
	push: vi.fn(),
	setup: {
		bindings: {},
		allConfigured: false,
		connectionsState: "answered",
		contextFields: [],
		offerContext: vi.fn(),
		buildConnections: () => ({}),
	},
}));

vi.mock("@saas/organizations/hooks", () => ({
	useEffectiveOrganizationId: () => "example-org",
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: m.push }) }));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => true,
}));
vi.mock("@saas/reports/hooks/use-instance-data-source-setup", () => ({
	useInstanceDataSourceSetup: () => m.setup,
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { reports: { instances: { execute: m.execute } } },
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		documentWorkspaces: {
			list: { queryOptions: () => ({ queryKey: ["workspaces"] }) },
		},
		reports: {
			instances: {
				create: { mutationOptions: (value: unknown) => value },
			},
		},
	},
}));
vi.mock("@tanstack/react-query", () => ({
	useQuery: () => ({ data: undefined }),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
	useMutation: () => ({ mutate: m.mutate, isPending: m.pending }),
}));
vi.mock("../CreateReportReadiness", () => ({
	CreateReportReadiness: () => null,
}));
vi.mock("../InstanceDataSourceFields", () => ({
	InstanceContextFields: () => null,
	InstanceDataSourcePicker: () => null,
}));
vi.mock("../RefinePromptButton", () => ({ RefinePromptButton: () => null }));
vi.mock("../ReportEvidenceSettings", () => ({
	ReportEvidenceSettings: () => null,
}));
vi.mock("../ReportParameterFields", () => ({
	ReportParameterFields: () => null,
}));
vi.mock("../ReportTemplatePreview", () => ({
	ReportTemplatePreview: () => null,
}));
vi.mock("../TemplatePromptPreview", () => ({
	TemplatePromptPreview: () => null,
}));

import { useReportSuiteCreation } from "@saas/reports/hooks/use-report-suite-creation";
import { CreateInstanceDialog } from "../CreateInstanceDialog";

const template = {
	id: "example-template",
	name: "Example status",
	description: null,
	templateType: "CUSTOM",
	outputFormat: "MARKDOWN",
	definition: {
		dataSources: [
			{
				id: "source",
				type: "mcp",
				provider: "github",
				operation: "list_issues",
				config: {},
			},
		],
	},
};

function show() {
	const onClose = vi.fn();
	render(
		<CreateInstanceDialog
			template={template}
			organizationId="example-org"
			projectId="example-project"
			onClose={onClose}
		/>,
	);
	return onClose;
}

beforeEach(() => {
	vi.clearAllMocks();
	m.pending = false;
	m.setup.allConfigured = false;
	m.setup.bindings = {};
	m.setup.connectionsState = "answered";
});

describe("CreateInstanceDialog while a report is being generated", () => {
	it("disables Cancel, and ignores Escape and the X", () => {
		m.pending = true;
		m.setup.allConfigured = true;
		m.setup.bindings = { source: { mcpConfigId: "config-1" } };
		const onClose = show();

		expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
		fireEvent.keyDown(document, { key: "Escape" });
		fireEvent.click(screen.getByRole("button", { name: "Close" }));

		expect(onClose).not.toHaveBeenCalled();
	});

	it("closes on Escape and the X otherwise", () => {
		const onClose = show();

		fireEvent.keyDown(document, { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalledTimes(2);
	});
});

describe("CreateInstanceDialog before its connections have answered", () => {
	it.each([
		["loading", "Checking your connected tools..."],
		["failed", "Your connected tools could not be loaded."],
	])("says nothing is missing while they are %s", (state, message) => {
		m.setup.connectionsState = state;
		show();

		expect(screen.getByText(message)).not.toHaveClass("text-destructive");
		expect(screen.queryByText(/to generate this report/)).toBeNull();
		expect(screen.queryByText("Abandon setup")).toBeNull();
		expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
	});

	it("asks for the missing source once they have answered", () => {
		show();

		expect(screen.getByText(/to generate this report/)).toHaveClass(
			"text-destructive",
		);
		expect(
			screen.getByRole("button", { name: "Abandon setup" }),
		).toBeTruthy();
	});
});

describe("CreateInstanceDialog's Generate", () => {
	it("stays focusable when off, and says why", () => {
		show();

		const generate = screen.getByRole("button", {
			name: "Generate report",
		});
		expect(generate).not.toBeDisabled();
		expect(generate).toHaveAttribute("aria-disabled", "true");
		expect(generate).toHaveAccessibleDescription(/to generate this report/);

		fireEvent.click(generate);

		expect(m.mutate).not.toHaveBeenCalled();
	});

	it("describes nothing once nothing is wrong", () => {
		m.setup.allConfigured = true;
		m.setup.bindings = { source: { mcpConfigId: "config-1" } };
		show();

		const generate = screen.getByRole("button", {
			name: "Generate report",
		});
		expect(generate).not.toHaveAttribute("aria-disabled");
		expect(generate).not.toHaveAttribute("aria-describedby");
	});
});

describe("useReportSuiteCreation", () => {
	function hook() {
		return renderHook(() =>
			useReportSuiteCreation({
				suite: true,
				dataSources: [],
				bindings: {},
				organizationId: "example-org",
				basePath: "/app/example-org/report-templates",
			}),
		);
	}

	it("stays starting after a run started, until the route changes", async () => {
		m.execute.mockResolvedValue({ startConfirmed: true });
		const { result } = hook();

		await act(() => result.current.startGeneration("report-1"));

		expect(m.push).toHaveBeenCalledWith(
			"/app/example-org/report-templates/instances/report-1?tab=history",
		);
		expect(result.current.isStarting).toBe(true);
	});

	it("stays starting after a refused run, until the route changes", async () => {
		m.execute.mockRejectedValue(new Error("Example refusal"));
		const { result } = hook();

		await act(() => result.current.startGeneration("report-1"));

		expect(m.push).toHaveBeenCalledWith(
			"/app/example-org/report-templates/instances/report-1",
		);
		expect(result.current.isStarting).toBe(true);
	});
});
