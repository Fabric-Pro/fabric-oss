/**
 * The log-source control under the recurring-error toggle on Settings ▸
 * Testing: it shows the project's current binding, saves a workspace through
 * `projects.update`, clears it, and is read-only for non-admins.
 *
 * `next-intl` is mocked globally to echo the key within its namespace, so copy
 * is asserted by that key.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

const updateMock = vi.fn(async () => ({ project: { id: "proj-1" } }));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: { update: (...a: unknown[]) => updateMock(...a) },
	},
}));

import { ProjectRecurringErrorSettings } from "../ProjectRecurringErrorSettings";

function renderWith(
	props: React.ComponentProps<typeof ProjectRecurringErrorSettings>,
) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<ProjectRecurringErrorSettings {...props} />
		</QueryClientProvider>,
	);
}

const WORKSPACE_ID = "0b6f3c1e-2d4a-4e8b-9c7d-5a1f2e3d4c5b";
const OTHER_WORKSPACE_ID = "7d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6";
const baseProject = { id: "proj-1", organizationId: "org-1" };
const boundProject = {
	...baseProject,
	logSourceProvider: "azure-monitor",
	logSourceConfig: { workspaceId: WORKSPACE_ID },
};

function workspaceInput() {
	return screen.getByLabelText("workspaceIdLabel");
}

beforeEach(() => {
	updateMock.mockClear();
});

describe("ProjectRecurringErrorSettings — log source", () => {
	it("shows the current binding", () => {
		renderWith({ project: boundProject, canEdit: true });

		expect(screen.getByText("current")).toBeInTheDocument();
		expect(screen.getByText(WORKSPACE_ID)).toBeInTheDocument();
		expect(workspaceInput()).toHaveValue(WORKSPACE_ID);
		// Nothing changed yet, so there is nothing to save.
		expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
	});

	it("says when no log source is set", () => {
		renderWith({ project: baseProject, canEdit: true });

		expect(screen.getByText("none")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "clear" })).toBeDisabled();
	});

	it("saves a workspace through projects.update", async () => {
		renderWith({ project: baseProject, canEdit: true });

		fireEvent.change(workspaceInput(), {
			target: { value: ` ${OTHER_WORKSPACE_ID} ` },
		});
		fireEvent.click(screen.getByRole("button", { name: "save" }));

		await waitFor(() =>
			expect(updateMock).toHaveBeenCalledWith({
				id: "proj-1",
				organizationId: "org-1",
				logSource: {
					provider: "azure-monitor",
					workspaceId: OTHER_WORKSPACE_ID,
				},
			}),
		);
	});

	it("does not save a workspace id that is not a GUID", () => {
		renderWith({ project: baseProject, canEdit: true });

		fireEvent.change(workspaceInput(), {
			target: { value: "my-workspace" },
		});

		expect(screen.getByText("workspaceIdInvalid")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
	});

	it("clears the binding through projects.update", async () => {
		renderWith({ project: boundProject, canEdit: true });

		fireEvent.click(screen.getByRole("button", { name: "clear" }));

		await waitFor(() =>
			expect(updateMock).toHaveBeenCalledWith(
				expect.objectContaining({ id: "proj-1", logSource: null }),
			),
		);
	});

	it("is read-only for non-admins, like the toggle", () => {
		renderWith({ project: boundProject, canEdit: false });

		expect(workspaceInput()).toBeDisabled();
		expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "clear" })).toBeDisabled();
		expect(
			screen.getByRole("switch", { name: "toggleLabel" }),
		).toBeDisabled();
		expect(screen.getByText("adminOnly")).toBeInTheDocument();
		expect(screen.getByLabelText("similarityLabel")).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "saveThresholds" }),
		).toBeDisabled();
	});
});

describe("ProjectRecurringErrorSettings — detection thresholds", () => {
	const tunedProject = {
		...baseProject,
		recurringErrorThreshold: 5,
		recurringErrorWindowHours: 24,
		recurringErrorSimilarityThreshold: 0.7,
	};

	it("shows the project's thresholds, with nothing to save yet", () => {
		renderWith({ project: tunedProject, canEdit: true });

		expect(screen.getByLabelText("thresholdLabel")).toHaveValue(5);
		expect(screen.getByLabelText("windowLabel")).toHaveValue(24);
		expect(screen.getByLabelText("similarityLabel")).toHaveValue(0.7);
		expect(
			screen.getByRole("button", { name: "saveThresholds" }),
		).toBeDisabled();
	});

	it("saves all three through projects.update", async () => {
		renderWith({ project: tunedProject, canEdit: true });

		fireEvent.change(screen.getByLabelText("thresholdLabel"), {
			target: { value: "3" },
		});
		fireEvent.change(screen.getByLabelText("similarityLabel"), {
			target: { value: "0.9" },
		});
		fireEvent.click(screen.getByRole("button", { name: "saveThresholds" }));

		await waitFor(() =>
			expect(updateMock).toHaveBeenCalledWith({
				id: "proj-1",
				organizationId: "org-1",
				recurringErrorThreshold: 3,
				recurringErrorWindowHours: 24,
				recurringErrorSimilarityThreshold: 0.9,
			}),
		);
	});

	it("does not save a similarity threshold outside 0.5–1", () => {
		renderWith({ project: tunedProject, canEdit: true });

		fireEvent.change(screen.getByLabelText("similarityLabel"), {
			target: { value: "1.5" },
		});

		expect(screen.getByText("invalid")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "saveThresholds" }),
		).toBeDisabled();
	});
});
