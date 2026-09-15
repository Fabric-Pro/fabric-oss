import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DeliveryTrack, UserStory } from "../../../lib/stories/types";
import { StartWorkButton } from "../StartWorkButton";

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

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: { stories: { queueForKanban: vi.fn(), readiness: vi.fn() } },
	},
}));

vi.mock("@saas/weave/components", () => ({
	ExecuteWithWeaveButton: () => null,
}));

vi.mock("../../coding-runs/StartImplementationSessionButton", () => ({
	StartImplementationSessionButton: () => null,
}));

vi.mock("../RunSpikeDialog", () => ({
	RunSpikeDialog: ({ open }: { open: boolean }) =>
		open ? <div data-testid="run-spike-dialog">dialog</div> : null,
}));

// Readiness is intentionally "not ready" so the test proves the spike item is
// not gated by the readiness rule that disables the implementation items.
vi.mock("../useStoryReadiness", () => ({
	useStoryReadiness: () => ({
		data: {
			effectiveTrack: null,
			draftingStage: "DRAFT",
			missing: ["ACCEPTANCE_CRITERIA_MISSING"],
			advisory: [],
			ready: false,
		},
		isPending: false,
	}),
	invalidateStoryReadiness: vi.fn(),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org_1",
		organizationSlug: "acme",
		basePath: "/app/acme",
	}),
}));

function makeStory(deliveryTrack: DeliveryTrack): UserStory {
	return {
		id: "story_1",
		identifier: "F-001",
		title: "Client-side amortisation",
		description: "Explore rendering the schedule locally",
		acceptanceCriteria: "",
		deliveryTrack,
		version: 3,
		tasks: [],
	} as unknown as UserStory;
}

function renderButton(story: UserStory) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>
			<StartWorkButton
				projectId="project_1"
				storyId={story.id}
				story={story}
				repositoryOwner="acme"
				repositoryName="fabric"
			/>
		</QueryClientProvider>,
	);
}

describe("StartWorkButton — Run a spike", () => {
	it("offers 'Run a spike' for SPIKE items even when not ready, and opens the dialog", async () => {
		const user = userEvent.setup();
		renderButton(makeStory("SPIKE"));

		await user.click(screen.getByRole("button", { name: /Start work/i }));

		const item = screen.getByTestId("start-work-run-spike");
		expect(item).toHaveTextContent("Run a spike");
		expect(item).not.toHaveAttribute("aria-disabled", "true");

		// Implementation items stay readiness-gated.
		expect(screen.getByText(/^Background Agents$/)).toBeInTheDocument();

		await user.click(item);
		expect(
			await screen.findByTestId("run-spike-dialog"),
		).toBeInTheDocument();
	});

	it("does not offer 'Run a spike' for SPECIFY items", async () => {
		const user = userEvent.setup();
		renderButton(makeStory("SPECIFY"));

		await user.click(screen.getByRole("button", { name: /Start work/i }));

		expect(screen.getByText(/Plan with Weave/)).toBeInTheDocument();
		expect(screen.queryByTestId("start-work-run-spike")).toBeNull();
		expect(screen.queryByText("Run a spike")).toBeNull();
	});

	it("does not offer anything for DEFER items (menu hidden)", () => {
		renderButton(makeStory("DEFER"));

		expect(
			screen.queryByRole("button", { name: /Start work/i }),
		).toBeNull();
		expect(screen.queryByTestId("start-work-run-spike")).toBeNull();
		expect(screen.queryByTestId("run-spike-dialog")).toBeNull();
	});
});
