/**
 * Unit tests for `DeliveryTrackSelector`.
 *
 * Verifies that the selector:
 *   - Renders the four assignable tracks (SPIKE, DISCOVERY, SPECIFY, DEFER)
 *     and never offers UNCLASSIFIED as a choice.
 *   - Shows the rationale beneath and an AI / Human indicator.
 *   - Calls `orpcClient.projects.stories.setDeliveryTrack` on change.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Radix primitives under jsdom.
class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
	ResizeObserverStub;
if (!Element.prototype.hasPointerCapture) {
	Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.scrollIntoView) {
	Element.prototype.scrollIntoView = () => {};
}

// ---- Mocks ----------------------------------------------------------------

const setDeliveryTrack = vi.fn();

vi.mock("../../../../../shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				setDeliveryTrack: (...args: unknown[]) =>
					setDeliveryTrack(...args),
			},
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		basePath: "/app/acme",
	}),
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));

vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), {
		success: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
	}),
}));

// Import AFTER mocks.
import { DeliveryTrackSelector } from "../DeliveryTrackSelector";

function renderSelector(
	props: Partial<React.ComponentProps<typeof DeliveryTrackSelector>> = {},
) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<DeliveryTrackSelector
				projectId="proj-1"
				storyId="story-1"
				track="UNCLASSIFIED"
				{...props}
			/>
		</QueryClientProvider>,
	);
}

describe("DeliveryTrackSelector", () => {
	beforeEach(() => {
		setDeliveryTrack.mockReset();
		setDeliveryTrack.mockResolvedValue({ story: { id: "story-1" } });
	});

	it("offers exactly the four assignable tracks", async () => {
		const user = userEvent.setup();
		renderSelector();

		await user.click(screen.getByRole("combobox", { name: "label" }));

		const options = await screen.findAllByRole("option");
		expect(options.map((o) => o.textContent?.trim())).toEqual([
			"Spike",
			"Discovery",
			"Specify",
			"Deferred",
		]);
		expect(
			screen.queryByRole("option", { name: /unclassified/i }),
		).toBeNull();
	});

	it("shows the current track, its rationale and the AI indicator", () => {
		renderSelector({
			track: "DISCOVERY",
			rationale: "Touches the corporate IdP.",
			setBy: "AI",
		});

		expect(
			screen.getByRole("combobox", { name: "label" }),
		).toHaveTextContent("Discovery");
		expect(
			screen.getByTestId("delivery-track-rationale"),
		).toHaveTextContent("Touches the corporate IdP.");
		expect(screen.getByTestId("delivery-track-set-by")).toHaveTextContent(
			"setBy.ai",
		);
	});

	it("shows the Human indicator when a person set the track", () => {
		renderSelector({ track: "SPECIFY", setBy: "HUMAN" });
		expect(screen.getByTestId("delivery-track-set-by")).toHaveTextContent(
			"setBy.human",
		);
	});

	it("falls back to the track description when there is no rationale", () => {
		renderSelector({ track: "SPIKE", rationale: null });
		expect(
			screen.getByTestId("delivery-track-rationale"),
		).toHaveTextContent(/feasibility or desirability/i);
	});

	it("calls setDeliveryTrack with the chosen track and reports the change", async () => {
		const user = userEvent.setup();
		const onChanged = vi.fn();
		renderSelector({ track: "UNCLASSIFIED", onChanged });

		await user.click(screen.getByRole("combobox", { name: "label" }));
		await user.click(await screen.findByRole("option", { name: "Spike" }));

		await waitFor(() => expect(setDeliveryTrack).toHaveBeenCalledTimes(1));
		expect(setDeliveryTrack).toHaveBeenCalledWith({
			projectId: "proj-1",
			storyId: "story-1",
			organizationId: "org-1",
			track: "SPIKE",
		});
		await waitFor(() => expect(onChanged).toHaveBeenCalledWith("SPIKE"));
	});
});
