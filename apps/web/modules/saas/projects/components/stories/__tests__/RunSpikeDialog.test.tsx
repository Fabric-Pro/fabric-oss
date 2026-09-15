import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunSpikeDialog } from "../RunSpikeDialog";

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

const getStatus = vi.fn();
const start = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		aiConfig: {
			resolution: {
				getStatus: (...args: unknown[]) => getStatus(...args),
			},
		},
		codingRuns: { start: (...args: unknown[]) => start(...args) },
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

const story = {
	id: "story_1",
	identifier: "F-001",
	title: "Can we render the schedule client-side?",
};

function renderDialog(
	props: Partial<React.ComponentProps<typeof RunSpikeDialog>> = {},
) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const onOpenChange = vi.fn();
	const onStarted = vi.fn();
	const utils = render(
		<QueryClientProvider client={client}>
			<RunSpikeDialog
				open
				onOpenChange={onOpenChange}
				projectId="project_1"
				story={story}
				repositoryOwner="acme"
				repositoryName="fabric"
				onStarted={onStarted}
				{...props}
			/>
		</QueryClientProvider>,
	);
	return { ...utils, onOpenChange, onStarted };
}

describe("RunSpikeDialog", () => {
	beforeEach(() => {
		getStatus.mockReset();
		start.mockReset();
	});

	it("prefills the question with the story title", async () => {
		getStatus.mockResolvedValue({ isConfigured: true });
		renderDialog();

		const textarea = await screen.findByLabelText(
			"What should the spike answer?",
		);
		expect(textarea).toHaveValue(story.title);
		expect(
			screen.getByRole("heading", { name: "Run a spike" }),
		).toBeInTheDocument();
	});

	it("disables submit and explains when no AI provider is configured", async () => {
		getStatus.mockResolvedValue({ isConfigured: false });
		renderDialog();

		expect(
			await screen.findByText("AI provider not configured"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Run spike" }),
		).toBeDisabled();
		expect(
			screen.getByRole("link", { name: /Open AI settings/ }),
		).toHaveAttribute("href", "/app/acme/settings/ai-providers");
		expect(start).not.toHaveBeenCalled();
	});

	it("disables submit without a repository", async () => {
		getStatus.mockResolvedValue({ isConfigured: true });
		renderDialog({ repositoryOwner: null, repositoryName: null });

		expect(
			await screen.findByText("Repository required"),
		).toBeInTheDocument();
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Run spike" }),
			).toBeDisabled(),
		);
	});

	it("hints that spikes run on Background Agents when the project defaults to local", async () => {
		getStatus.mockResolvedValue({ isConfigured: true });
		renderDialog({ implementationDefaultProvider: "KANBAN_LOCAL" });

		expect(
			await screen.findByText("Runs on Background Agents"),
		).toBeInTheDocument();
		expect(
			screen.getByText(/default provider is Local development/),
		).toBeInTheDocument();
	});

	it("submits a SPIKE run with the edited question", async () => {
		getStatus.mockResolvedValue({ isConfigured: true });
		start.mockResolvedValue({
			codingRunId: "run_1",
			workflowId: "wf_1",
			status: "QUEUED",
		});
		const user = userEvent.setup();
		const { onOpenChange, onStarted } = renderDialog();

		const textarea = await screen.findByLabelText(
			"What should the spike answer?",
		);
		await user.clear(textarea);
		await user.type(textarea, "Is client-side rendering fast enough?");

		const submit = screen.getByRole("button", { name: "Run spike" });
		await waitFor(() => expect(submit).toBeEnabled());
		await user.click(submit);

		await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
		expect(start).toHaveBeenCalledWith({
			projectId: "project_1",
			storyId: "story_1",
			organizationId: "org_1",
			kind: "SPIKE",
			spikeQuestion: "Is client-side rendering fast enough?",
		});
		await waitFor(() => expect(onStarted).toHaveBeenCalledWith("run_1"));
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("rejects a question shorter than the API minimum", async () => {
		getStatus.mockResolvedValue({ isConfigured: true });
		const user = userEvent.setup();
		renderDialog();

		const textarea = await screen.findByLabelText(
			"What should the spike answer?",
		);
		await user.clear(textarea);
		await user.type(textarea, "too short");

		expect(
			screen.getByText("The question needs at least 10 characters."),
		).toBeInTheDocument();
		expect(textarea).toHaveAttribute("aria-invalid", "true");
		expect(
			screen.getByRole("button", { name: "Run spike" }),
		).toBeDisabled();
		expect(start).not.toHaveBeenCalled();
	});

	it("does not submit an empty question", async () => {
		getStatus.mockResolvedValue({ isConfigured: true });
		const user = userEvent.setup();
		renderDialog();

		const textarea = await screen.findByLabelText(
			"What should the spike answer?",
		);
		await user.clear(textarea);
		expect(
			screen.getByRole("button", { name: "Run spike" }),
		).toBeDisabled();
		expect(start).not.toHaveBeenCalled();
	});
});
