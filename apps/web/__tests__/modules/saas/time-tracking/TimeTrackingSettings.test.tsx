/**
 * The project and organization time-tracking settings save on change, and
 * each change sends only the field that changed. The organization's start/stop
 * requirement shows on the project switch, locked, with the reason as its
 * description.
 */

import type {
	OrganizationTimeSettings,
	ProjectTimeSettings,
} from "@saas/time-tracking/lib/time-settings-model";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockGetProject,
	mockUpdateProject,
	mockGetOrganization,
	mockUpdateOrganization,
	mockProjectReport,
	mockToastError,
	procedure,
} = vi.hoisted(() => ({
	mockGetProject: vi.fn(),
	mockUpdateProject: vi.fn(),
	mockGetOrganization: vi.fn(),
	mockUpdateOrganization: vi.fn(),
	mockProjectReport: vi.fn(),
	mockToastError: vi.fn(),
	/** A procedure's query utilities, keyed the way oRPC keys them. */
	procedure: (path: string, call: (input: unknown) => unknown) => {
		const queryKey = ({ input }: { input: unknown }) => [
			["timeTracking", path],
			{ input, type: "query" },
		];
		return {
			key: () => [["timeTracking", path]],
			queryKey,
			queryOptions: ({ input }: { input: unknown }) => ({
				queryKey: queryKey({ input }),
				queryFn: () => call(input),
			}),
			call,
		};
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		timeTracking: {
			getProjectSettings: procedure("getProjectSettings", mockGetProject),
			updateProjectSettings: procedure(
				"updateProjectSettings",
				mockUpdateProject,
			),
			getOrganizationSettings: procedure(
				"getOrganizationSettings",
				mockGetOrganization,
			),
			updateOrganizationSettings: procedure(
				"updateOrganizationSettings",
				mockUpdateOrganization,
			),
			listLoggableProjects: procedure("listLoggableProjects", vi.fn()),
			organizationReport: procedure("organizationReport", vi.fn()),
			projectReport: procedure("projectReport", mockProjectReport),
		},
	},
}));

vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), { success: vi.fn(), error: mockToastError }),
}));

vi.mock("next/link", () => ({
	default: ({ children, href }: { children: ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));

import { OrganizationTimeTrackingSettings } from "@saas/time-tracking/components/OrganizationTimeTrackingSettings";
import { ProjectTimeTrackingSettings } from "@saas/time-tracking/components/ProjectTimeTrackingSettings";

const projectSettings: ProjectTimeSettings = {
	projectId: "project-a",
	billingModel: "FIXED_BID",
	timeRequireStartStop: false,
	timeDefaultBillable: null,
	organization: { timeRequireStartStop: false, timeDefaultBillable: null },
	effective: { startStopRequired: false, defaultBillable: true },
};

const organizationSettings: OrganizationTimeSettings = {
	organizationId: "org-1",
	timeRequireStartStop: false,
	timeDefaultBillable: null,
	effective: { startStopRequired: false, defaultBillable: true },
};

function renderWithClient(ui: ReactNode) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
	);
}

function renderProject(canEdit = true) {
	return renderWithClient(
		<ProjectTimeTrackingSettings
			projectId="project-a"
			canEdit={canEdit}
			reportHref="/app/example-org/projects/project-a/time-report"
		/>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mockProjectReport.mockResolvedValue({
		rows: [],
		projects: [],
		totals: {
			billableMinutes: 0,
			nonBillableMinutes: 0,
			totalMinutes: 0,
			peopleCount: 0,
		},
	});
});

describe("ProjectTimeTrackingSettings", () => {
	it("saves the start/stop switch with only that field", async () => {
		mockGetProject.mockResolvedValue(projectSettings);
		mockUpdateProject.mockResolvedValue({
			...projectSettings,
			timeRequireStartStop: true,
		});
		renderProject();

		const toggle = await screen.findByRole("switch", {
			name: "requireStartStop",
		});
		await waitFor(() => expect(toggle).toBeEnabled());
		await userEvent.click(toggle);

		await waitFor(() =>
			expect(mockUpdateProject).toHaveBeenCalledWith({
				projectId: "project-a",
				timeRequireStartStop: true,
			}),
		);
		expect(toggle).toBeChecked();
	});

	it("saves the project type with only that field", async () => {
		mockGetProject.mockResolvedValue(projectSettings);
		mockUpdateProject.mockResolvedValue({
			...projectSettings,
			billingModel: "TIME_AND_MATERIALS",
		});
		renderProject();

		await userEvent.click(
			await screen.findByRole("radio", { name: "Time and materials" }),
		);

		await waitFor(() =>
			expect(mockUpdateProject).toHaveBeenCalledWith({
				projectId: "project-a",
				billingModel: "TIME_AND_MATERIALS",
			}),
		);
	});

	it("puts the setting back and says so when the save fails", async () => {
		mockGetProject.mockResolvedValue(projectSettings);
		mockUpdateProject.mockRejectedValue(new Error("refused"));
		renderProject();

		const toggle = await screen.findByRole("switch", {
			name: "requireStartStop",
		});
		await waitFor(() => expect(toggle).toBeEnabled());
		await userEvent.click(toggle);

		await waitFor(() =>
			expect(mockToastError).toHaveBeenCalledWith("saveFailed"),
		);
		expect(toggle).not.toBeChecked();
	});

	it("shows the switch on and locked while the organization requires times", async () => {
		mockGetProject.mockResolvedValue({
			...projectSettings,
			organization: {
				timeRequireStartStop: true,
				timeDefaultBillable: null,
			},
			effective: { startStopRequired: true, defaultBillable: true },
		});
		renderProject();

		const toggle = await screen.findByRole("switch", {
			name: "requireStartStop",
		});
		await waitFor(() => expect(toggle).toBeChecked());
		expect(toggle).toBeDisabled();
		expect(toggle).toHaveAccessibleDescription("setByOrganization");
	});

	it("leaves every control read-only for a member who cannot edit", async () => {
		mockGetProject.mockResolvedValue(projectSettings);
		renderProject(false);

		const toggle = await screen.findByRole("switch", {
			name: "requireStartStop",
		});
		await waitFor(() =>
			expect(
				screen.getByRole("radio", { name: "Fixed bid" }),
			).toBeChecked(),
		);
		expect(toggle).toBeDisabled();
		expect(screen.getByRole("radio", { name: "Fixed bid" })).toBeDisabled();
		expect(screen.getByText("readOnly")).toBeInTheDocument();
	});

	it("links the report only once the server lets the caller read it", async () => {
		mockGetProject.mockResolvedValue(projectSettings);
		renderProject();

		expect(
			await screen.findByRole("link", { name: /viewReport/ }),
		).toHaveAttribute(
			"href",
			"/app/example-org/projects/project-a/time-report",
		);
	});
});

describe("OrganizationTimeTrackingSettings", () => {
	it("saves the start/stop switch with only that field", async () => {
		mockGetOrganization.mockResolvedValue(organizationSettings);
		mockUpdateOrganization.mockResolvedValue({
			...organizationSettings,
			timeRequireStartStop: true,
		});
		renderWithClient(
			<OrganizationTimeTrackingSettings organizationId="org-1" canEdit />,
		);

		const toggle = await screen.findByRole("switch", {
			name: "requireStartStop",
		});
		await waitFor(() => expect(toggle).toBeEnabled());
		await userEvent.click(toggle);

		await waitFor(() =>
			expect(mockUpdateOrganization).toHaveBeenCalledWith({
				organizationId: "org-1",
				timeRequireStartStop: true,
			}),
		);
	});

	it("is read-only for a member who cannot update the organization", async () => {
		mockGetOrganization.mockResolvedValue(organizationSettings);
		renderWithClient(
			<OrganizationTimeTrackingSettings
				organizationId="org-1"
				canEdit={false}
			/>,
		);

		const toggle = await screen.findByRole("switch", {
			name: "requireStartStop",
		});
		await waitFor(() => expect(mockGetOrganization).toHaveBeenCalled());
		expect(toggle).toBeDisabled();
		expect(mockUpdateOrganization).not.toHaveBeenCalled();
	});
});
