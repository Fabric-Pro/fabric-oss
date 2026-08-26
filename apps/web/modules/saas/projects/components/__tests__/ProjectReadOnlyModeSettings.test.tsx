/**
 * ProjectReadOnlyModeSettings — the project-level Read-only mode toggle.
 * Pins the review findings this component had to close:
 *
 *  - Success invalidates the EXACT `projects.get` key that feeds the `project`
 *    prop, not a flat `["projects", id]` key the prop never reads.
 *  - A non-admin (`canEdit={false}`) sees an aria-disabled switch whose change
 *    is a no-op — the server enforces too, but the client must not fire the
 *    mutation.
 *  - An admin toggle sends `readOnlyMode` through `projects.update`.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectReadOnlyModeSettings } from "../ProjectReadOnlyModeSettings";

const updateMock = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: { update: (...a: unknown[]) => updateMock(...a) },
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			get: {
				queryKey: (args: { input: unknown }) => [
					"projects.get",
					args.input,
				],
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

const baseProject = {
	id: "proj_1",
	organizationId: null as string | null,
	readOnlyMode: false as boolean | null,
};

function renderCard(props: {
	project?: Partial<typeof baseProject>;
	canEdit: boolean;
}) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const utils = render(
		<QueryClientProvider client={client}>
			<ProjectReadOnlyModeSettings
				project={{ ...baseProject, ...props.project }}
				canEdit={props.canEdit}
			/>
		</QueryClientProvider>,
	);
	return { client, ...utils };
}

describe("ProjectReadOnlyModeSettings", () => {
	beforeEach(() => {
		updateMock.mockReset();
		updateMock.mockResolvedValue({ id: "proj_1", readOnlyMode: true });
	});
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("admin toggle sends readOnlyMode and invalidates the projects.get key that feeds the prop", async () => {
		const user = userEvent.setup();
		const { client } = renderCard({ canEdit: true });
		const invalidateSpy = vi.spyOn(client, "invalidateQueries");

		const toggle = screen.getByRole("switch", { name: /read-only mode/i });
		await user.click(toggle);

		await waitFor(() => {
			expect(updateMock).toHaveBeenCalledWith(
				expect.objectContaining({
					id: "proj_1",
					readOnlyMode: true,
				}),
			);
		});

		await waitFor(() => {
			expect(invalidateSpy).toHaveBeenCalledWith({
				queryKey: [
					"projects.get",
					{ id: "proj_1", organizationId: null },
				],
			});
		});
		// Never the stale flat key that the prop never reads.
		expect(invalidateSpy).not.toHaveBeenCalledWith({
			queryKey: ["projects", "proj_1"],
		});
	});

	it("non-admin sees an aria-disabled switch and clicking it does NOT fire the mutation", async () => {
		const user = userEvent.setup();
		renderCard({ canEdit: false });

		const toggle = screen.getByRole("switch", { name: /read-only mode/i });
		expect(toggle).toHaveAttribute("aria-disabled", "true");
		// The reason is wired for assistive tech.
		expect(toggle).toHaveAttribute(
			"aria-describedby",
			"project-read-only-mode-disabled-reason",
		);

		await user.click(toggle);
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("shows the active banner only when read-only is on", () => {
		const { rerender, client } = (() => {
			const c = new QueryClient({
				defaultOptions: { queries: { retry: false } },
			});
			const r = render(
				<QueryClientProvider client={c}>
					<ProjectReadOnlyModeSettings
						project={{ ...baseProject, readOnlyMode: false }}
						canEdit
					/>
				</QueryClientProvider>,
			);
			return { rerender: r.rerender, client: c };
		})();

		expect(
			screen.queryByTestId("read-only-mode-active"),
		).not.toBeInTheDocument();

		rerender(
			<QueryClientProvider client={client}>
				<ProjectReadOnlyModeSettings
					project={{ ...baseProject, readOnlyMode: true }}
					canEdit
				/>
			</QueryClientProvider>,
		);
		expect(screen.getByTestId("read-only-mode-active")).toBeInTheDocument();
	});
});
