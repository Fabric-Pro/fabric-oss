/**
 * Settings ▸ Testing — per-repo QA branch.
 *
 * The behaviour worth pinning: a failed load must NOT render the "no
 * repositories are connected" empty state (that is a claim about the project,
 * and acting on it means reconnecting a repo that is already there), the row
 * reports the branch actually in effect, and Save sends the trimmed value —
 * blank meaning "follow the repo default" rather than an empty ref.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.fn();
const saveSpy = vi.fn();

vi.mock("@tanstack/react-query", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
	useMutation: () => ({ mutate: saveSpy, isPending: false }),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			pipelineResults: {
				sources: {
					queryOptions: (opts: unknown) => opts,
					key: () => ["sources"],
				},
				setBranch: { mutationOptions: (opts: unknown) => opts },
				syncStates: { key: () => ["syncStates"] },
			},
		},
	},
}));

import { QaPipelineSourcesSettings } from "../QaPipelineSourcesSettings";

const source = {
	integrationId: "int1",
	provider: "GITHUB",
	owner: "acme",
	repo: "app",
	defaultBranch: "main",
	qaBranch: null as string | null,
	effectiveBranch: "main",
};

const props = { projectId: "p1", canEdit: true };

/**
 * The endpoint returns `{ sources, noSourcesReason }` rather than a bare array:
 * the empty state has to distinguish "nothing connected" from "your PM tool
 * cannot return test runs", and that distinction depends on
 * server-side configuration the browser does not have.
 */
function loaded(
	sources: (typeof source)[],
	noSourcesReason: string | null = null,
) {
	return {
		data: { sources, noSourcesReason },
		isLoading: false,
		isError: false,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	useQueryMock.mockReturnValue(loaded([source]));
});

describe("QaPipelineSourcesSettings", () => {
	it("does not claim 'no repositories connected' when the load failed", () => {
		useQueryMock.mockReturnValue({
			data: undefined,
			isLoading: false,
			isError: true,
		});
		render(<QaPipelineSourcesSettings {...props} />);

		expect(screen.getByText(/couldn't load/i)).toBeInTheDocument();
		expect(
			screen.queryByText(/no repositories are connected/i),
		).not.toBeInTheDocument();
	});

	it("shows the repo default as the effective branch until an override exists", () => {
		render(<QaPipelineSourcesSettings {...props} />);
		expect(screen.getByText(/repository default/i)).toBeInTheDocument();
	});

	it("labels an override as such", () => {
		useQueryMock.mockReturnValue(
			loaded([
				{ ...source, qaBranch: "develop", effectiveBranch: "develop" },
			]),
		);
		render(<QaPipelineSourcesSettings {...props} />);
		expect(screen.getByText(/override/i)).toBeInTheDocument();
		expect(screen.getByText("develop")).toBeInTheDocument();
	});

	it("sends the trimmed branch for this repo only", async () => {
		render(<QaPipelineSourcesSettings {...props} />);
		const field = screen.getByLabelText("QA branch for acme/app");
		await userEvent.type(field, "  develop  ");
		await userEvent.click(screen.getByRole("button", { name: "Save" }));

		expect(saveSpy).toHaveBeenCalledWith({
			projectId: "p1",
			integrationId: "int1",
			qaBranch: "develop",
		});
	});

	it("keeps the controls read-only without edit rights", () => {
		render(<QaPipelineSourcesSettings {...props} canEdit={false} />);
		expect(screen.getByLabelText("QA branch for acme/app")).toBeDisabled();
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
	});

	it("falls back to the generic empty state when nothing is connected", () => {
		useQueryMock.mockReturnValue(loaded([]));
		render(<QaPipelineSourcesSettings {...props} />);

		expect(
			screen.getByText(/no repositories are connected/i),
		).toBeInTheDocument();
	});

	it("says the connected PM tool cannot return test runs, when it is the reason", () => {
		// Someone who connected Azure DevOps as their PM tool has
		// already done what they believe was asked; the generic sentence sends
		// them to check a connection that works perfectly well at its own job.
		useQueryMock.mockReturnValue(
			loaded(
				[],
				"Azure DevOps is connected as a project-management tool, which cannot return test runs — Fabric reads results from your CI pipeline. Connect the repository your tests run in under Settings ▸ Development.",
			),
		);
		render(<QaPipelineSourcesSettings {...props} />);

		expect(screen.getByText(/azure devops/i)).toBeInTheDocument();
		expect(
			screen.getByText(/cannot return test runs/i),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/no repositories are connected/i),
		).not.toBeInTheDocument();
	});
});
