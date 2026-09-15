import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AcceptSpikeDialog } from "../AcceptSpikeDialog";

vi.mock("next-intl", async () =>
	(await import("./spike-intl-mock")).intlMock(),
);

// Radix primitives under jsdom.
class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
	ResizeObserverStub;

vi.mock("@shared/lib/orpc-query-utils", async () =>
	(await import("./spike-orpc-query-mock")).orpcQueryMock(),
);

const acceptSpike = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		codingRuns: {
			acceptSpike: (...args: unknown[]) => acceptSpike(...args),
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org_1",
		organizationSlug: "acme",
		basePath: "/app/acme",
	}),
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

function renderDialog() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const onOpenChange = vi.fn();
	const onAccepted = vi.fn();
	render(
		<QueryClientProvider client={client}>
			<AcceptSpikeDialog
				open
				onOpenChange={onOpenChange}
				codingRunId="run_1"
				projectId="project_1"
				storyId="story_1"
				question="Can we render the schedule client-side?"
				onAccepted={onAccepted}
			/>
		</QueryClientProvider>,
	);
	return { onOpenChange, onAccepted };
}

describe("AcceptSpikeDialog", () => {
	beforeEach(() => {
		acceptSpike.mockReset();
	});

	it("shows the question and requires at least 20 characters of play notes", async () => {
		const user = userEvent.setup();
		renderDialog();

		expect(
			screen.getByText("Can we render the schedule client-side?"),
		).toBeInTheDocument();

		const submit = screen.getByRole("button", { name: "Accept findings" });
		expect(submit).toBeDisabled();

		const notes = screen.getByLabelText("Play notes");
		await user.type(notes, "too short");
		await user.tab();

		expect(
			await screen.findByText("Play notes need at least 20 characters."),
		).toBeInTheDocument();
		expect(submit).toBeDisabled();
		expect(acceptSpike).not.toHaveBeenCalled();
	});

	it("submits play notes and the chosen next track", async () => {
		acceptSpike.mockResolvedValue({ ok: true });
		const user = userEvent.setup();
		const { onOpenChange, onAccepted } = renderDialog();

		const notes = screen.getByLabelText("Play notes");
		await user.type(
			notes,
			"Priya tried the demo on the staging data set; it rendered in 120 ms. Go with it.",
		);
		await user.click(screen.getByLabelText("Specify"));

		const submit = screen.getByRole("button", { name: "Accept findings" });
		await waitFor(() => expect(submit).toBeEnabled());
		await user.click(submit);

		await waitFor(() => expect(acceptSpike).toHaveBeenCalledTimes(1));
		expect(acceptSpike).toHaveBeenCalledWith({
			codingRunId: "run_1",
			projectId: "project_1",
			organizationId: "org_1",
			playNotes:
				"Priya tried the demo on the staging data set; it rendered in 120 ms. Go with it.",
			nextTrack: "SPECIFY",
		});
		await waitFor(() => expect(onAccepted).toHaveBeenCalled());
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("omits nextTrack when the track is left unchanged", async () => {
		acceptSpike.mockResolvedValue({ ok: true });
		const user = userEvent.setup();
		renderDialog();

		await user.type(
			screen.getByLabelText("Play notes"),
			"Tried it twice, the numbers match the spreadsheet.",
		);
		await user.click(
			screen.getByRole("button", { name: "Accept findings" }),
		);

		await waitFor(() => expect(acceptSpike).toHaveBeenCalledTimes(1));
		expect(acceptSpike.mock.calls[0][0]).toMatchObject({
			codingRunId: "run_1",
			nextTrack: undefined,
		});
	});
});
