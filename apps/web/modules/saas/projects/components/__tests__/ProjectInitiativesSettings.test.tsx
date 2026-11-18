import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectInitiativesSettings } from "../ProjectInitiativesSettings";

const updateMock = vi.fn();
const getMock = vi.fn();

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
				queryOptions: (args: { input: unknown }) => ({
					queryKey: ["projects.get", args.input],
					queryFn: () => getMock(args.input),
				}),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

const baseProject = {
	id: "proj_1",
	organizationId: null as string | null,
	initiativesEnabled: false as boolean | null,
	initiativeCount: 0,
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
			<ProjectInitiativesSettings
				project={{ ...baseProject, ...props.project }}
				canEdit={props.canEdit}
			/>
		</QueryClientProvider>,
	);
	return { client, ...utils };
}

describe("ProjectInitiativesSettings", () => {
	beforeEach(() => {
		updateMock.mockReset();
		updateMock.mockResolvedValue({
			id: "proj_1",
			initiativesEnabled: true,
		});
		getMock.mockReset();
		getMock.mockResolvedValue({ project: { initiativeCount: 0 } });
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("turning on saves immediately without a confirmation dialog", async () => {
		const user = userEvent.setup();
		const { client } = renderCard({
			canEdit: true,
			project: { initiativesEnabled: false },
		});
		const invalidateSpy = vi.spyOn(client, "invalidateQueries");

		const toggle = screen.getByRole("switch", { name: "Initiatives" });
		await user.click(toggle);

		await waitFor(() => {
			expect(updateMock).toHaveBeenCalledWith(
				expect.objectContaining({
					id: "proj_1",
					initiativesEnabled: true,
				}),
			);
		});

		expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

		await waitFor(() => {
			expect(invalidateSpy).toHaveBeenCalledWith({
				queryKey: [
					"projects.get",
					{ id: "proj_1", organizationId: null },
				],
			});
		});
	});

	it("turning off with no initiatives saves immediately with no dialog", async () => {
		const user = userEvent.setup();
		getMock.mockResolvedValue({ project: { initiativeCount: 0 } });
		renderCard({
			canEdit: true,
			project: { initiativesEnabled: true, initiativeCount: 0 },
		});

		const toggle = screen.getByRole("switch", { name: "Initiatives" });
		await user.click(toggle);

		await waitFor(() => {
			expect(updateMock).toHaveBeenCalledWith(
				expect.objectContaining({
					id: "proj_1",
					initiativesEnabled: false,
				}),
			);
		});

		expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
	});

	it("turning off when the project has initiatives shows a warning and only saves on confirmation", async () => {
		const user = userEvent.setup();
		getMock.mockResolvedValue({ project: { initiativeCount: 5 } });
		renderCard({
			canEdit: true,
			project: { initiativesEnabled: true, initiativeCount: 5 },
		});

		const toggle = screen.getByRole("switch", { name: "Initiatives" });
		await user.click(toggle);

		// AlertDialog should open with the warning and count
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent("Turn off Initiatives?");
		expect(dialog).toHaveTextContent(
			"5 Initiatives will be hidden from this project. They aren't deleted, and they come back when you turn Initiatives on again.",
		);

		// Not saved yet
		expect(updateMock).not.toHaveBeenCalled();

		// Confirm
		const confirmBtn = screen.getByRole("button", { name: "Turn off" });
		await user.click(confirmBtn);

		await waitFor(() => {
			expect(updateMock).toHaveBeenCalledWith(
				expect.objectContaining({
					id: "proj_1",
					initiativesEnabled: false,
				}),
			);
		});
	});

	it("cancelling the warning dialog closes it without saving", async () => {
		const user = userEvent.setup();
		getMock.mockResolvedValue({ project: { initiativeCount: 3 } });
		renderCard({
			canEdit: true,
			project: { initiativesEnabled: true, initiativeCount: 3 },
		});

		const toggle = screen.getByRole("switch", { name: "Initiatives" });
		await user.click(toggle);

		await screen.findByRole("alertdialog");
		const cancelBtn = screen.getByRole("button", { name: "Cancel" });
		await user.click(cancelBtn);

		await waitFor(() => {
			expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
		});

		expect(updateMock).not.toHaveBeenCalled();
	});

	it("re-reads stale cached count: cached initiativeCount is 0 but fresh fetch returns 2, showing the warning", async () => {
		const user = userEvent.setup();
		getMock.mockResolvedValue({ project: { initiativeCount: 2 } });
		renderCard({
			canEdit: true,
			project: { initiativesEnabled: true, initiativeCount: 0 },
		});

		const toggle = screen.getByRole("switch", { name: "Initiatives" });
		await user.click(toggle);

		// Dialog still appears because fresh fetch returned 2
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent("Turn off Initiatives?");
		expect(dialog).toHaveTextContent(
			"2 Initiatives will be hidden from this project. They aren't deleted, and they come back when you turn Initiatives on again.",
		);
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("shows an error and saves nothing when the count can't be loaded", async () => {
		const user = userEvent.setup();
		getMock.mockRejectedValue(new Error("network"));
		renderCard({
			canEdit: true,
			project: { initiativesEnabled: true, initiativeCount: 0 },
		});

		await user.click(screen.getByRole("switch", { name: "Initiatives" }));

		const { toast } = await import("sonner");
		await waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith(
				"Couldn't check for Initiatives. Please try again.",
			);
		});
		expect(updateMock).not.toHaveBeenCalled();
		expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
	});

	it("formats singular '1 Initiative' in warning dialog", async () => {
		const user = userEvent.setup();
		getMock.mockResolvedValue({ project: { initiativeCount: 1 } });
		renderCard({
			canEdit: true,
			project: { initiativesEnabled: true, initiativeCount: 1 },
		});

		await user.click(screen.getByRole("switch", { name: "Initiatives" }));

		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent(
			"1 Initiative will be hidden from this project.",
		);
	});

	it("non-admin sees an aria-disabled switch and clicking it does not fire the mutation", async () => {
		const user = userEvent.setup();
		renderCard({ canEdit: false });

		const toggle = screen.getByRole("switch", { name: "Initiatives" });
		expect(toggle).toHaveAttribute("aria-disabled", "true");
		expect(toggle).toHaveAttribute(
			"aria-describedby",
			"project-initiatives-disabled-reason",
		);

		await user.click(toggle);
		expect(updateMock).not.toHaveBeenCalled();
		expect(
			screen.getByText(
				"Only project admins or owners can turn Initiatives on or off.",
			),
		).toBeInTheDocument();
	});
});
