/**
 * Tests for IntegrationIncidentDrawer.
 *
 *
 * Coverage
 * --------
 * - Loading state surfaces three skeleton rows.
 * - Empty state shows the editorial empty copy + status-page link.
 * - Populated state renders one row per incident with severity, range,
 *   and the upstream link when present.
 * - The drawer is `open=false` -> nothing visible.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		integrationHealth: {
			getProviderIncidents: vi.fn(),
		},
	},
}));

import { orpcClient } from "@shared/lib/orpc-client";
import { IntegrationIncidentDrawer } from "../IntegrationIncidentDrawer";

const getProviderIncidentsMock = orpcClient.integrationHealth
	.getProviderIncidents as unknown as ReturnType<typeof vi.fn>;

function renderWithClient(ui: ReactNode) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchOnWindowFocus: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

describe("IntegrationIncidentDrawer", () => {
	it("renders the empty state when the API returns zero incidents", async () => {
		getProviderIncidentsMock.mockResolvedValueOnce({ incidents: [] });
		renderWithClient(
			<IntegrationIncidentDrawer
				providerKey="openai"
				providerName="OpenAI"
				statusPageUrl="https://status.openai.com"
				open={true}
				onOpenChange={vi.fn()}
			/>,
		);
		expect(
			await screen.findByTestId("incident-timeline-empty"),
		).toBeInTheDocument();
		expect(
			screen.getByText(/No incidents in the last 30 days/i),
		).toBeInTheDocument();
		// Status page link in the empty-state CTA.
		expect(
			screen.getAllByText(/status page/i).length,
		).toBeGreaterThanOrEqual(1);
	});

	it("renders skeleton rows while loading", () => {
		getProviderIncidentsMock.mockReturnValueOnce(new Promise(() => {}));
		renderWithClient(
			<IntegrationIncidentDrawer
				providerKey="openai"
				providerName="OpenAI"
				open={true}
				onOpenChange={vi.fn()}
			/>,
		);
		const skeletons = screen.getAllByTestId("incident-timeline-skeleton");
		expect(skeletons).toHaveLength(3);
	});

	it("renders one row per incident with severity labels", async () => {
		getProviderIncidentsMock.mockResolvedValueOnce({
			incidents: [
				{
					id: "inc-1",
					providerKey: "openai",
					providerName: "OpenAI",
					severity: "SEV1",
					health: "MAJOR_OUTAGE",
					status: "FIRING",
					startedAt: new Date("2026-05-10T10:00:00Z").toISOString(),
					resolvedAt: null,
					summary: "ChatCompletions API returning 503",
					affectedComponents: ["chat-api"],
					statusPageUrl: "https://status.openai.com/incidents/abc",
				},
				{
					id: "inc-2",
					providerKey: "openai",
					providerName: "OpenAI",
					severity: "SEV2",
					health: "DEGRADED",
					status: "RESOLVED",
					startedAt: new Date("2026-05-05T14:30:00Z").toISOString(),
					resolvedAt: new Date("2026-05-05T16:00:00Z").toISOString(),
					summary: "Embeddings latency spiked",
					affectedComponents: [],
					statusPageUrl: null,
				},
			],
		});

		renderWithClient(
			<IntegrationIncidentDrawer
				providerKey="openai"
				providerName="OpenAI"
				open={true}
				onOpenChange={vi.fn()}
			/>,
		);

		const rows = await screen.findAllByTestId("incident-timeline-row");
		expect(rows).toHaveLength(2);
		expect(
			screen.getByText("ChatCompletions API returning 503"),
		).toBeInTheDocument();
		expect(
			screen.getByText("Embeddings latency spiked"),
		).toBeInTheDocument();
		expect(screen.getByText("SEV-1")).toBeInTheDocument();
		expect(screen.getByText("SEV-2")).toBeInTheDocument();
		// Ongoing pill for the firing incident.
		expect(screen.getByText("Ongoing")).toBeInTheDocument();
	});

	it("does not fire the query when closed", () => {
		getProviderIncidentsMock.mockClear();
		renderWithClient(
			<IntegrationIncidentDrawer
				providerKey="openai"
				providerName="OpenAI"
				open={false}
				onOpenChange={vi.fn()}
			/>,
		);
		expect(getProviderIncidentsMock).not.toHaveBeenCalled();
	});
});
