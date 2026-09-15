/**
 * ProjectMetricsPanel (plan Slice 8) — the webhook secret is shown once.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createMock, listMock, rotateMock, recordMock } = vi.hoisted(() => ({
	createMock: vi.fn(),
	listMock: vi.fn(),
	rotateMock: vi.fn(),
	recordMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			metrics: {
				create: createMock,
				rotateWebhookSecret: rotateMock,
				recordObservation: recordMock,
				delete: vi.fn(),
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			metrics: {
				list: {
					queryOptions: (opts: { input: unknown }) => ({
						queryKey: ["projects", "metrics", "list", opts.input],
						queryFn: () => listMock(opts.input),
					}),
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

import { ProjectMetricsPanel } from "../ProjectMetricsPanel";

const webhookMetric = {
	id: "metric-1",
	projectId: "proj-1",
	name: "Activation rate",
	description: null,
	direction: "UP" as const,
	target: 50,
	sourceKind: "WEBHOOK" as const,
	hasWebhookSecret: true,
	lastValue: 41,
	previousValue: 38,
	lastObservedAt: new Date("2026-09-01T00:00:00Z"),
	createdAt: new Date("2026-08-01T00:00:00Z"),
	updatedAt: new Date("2026-09-01T00:00:00Z"),
};

function renderPanel(
	props: Partial<React.ComponentProps<typeof ProjectMetricsPanel>> = {},
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<ProjectMetricsPanel
				projectId="proj-1"
				organizationId="org-1"
				canEdit
				canRotate
				{...props}
			/>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	createMock.mockReset();
	listMock.mockReset();
	rotateMock.mockReset();
	recordMock.mockReset();
	listMock.mockResolvedValue({ metrics: [] });
});

describe("ProjectMetricsPanel", () => {
	it("shows a webhook secret once after creating a WEBHOOK metric, then never again", async () => {
		createMock.mockResolvedValue({
			metric: webhookMetric,
			webhookSecret: {
				value: "s3cret-value-shown-once",
				shownOnce: true,
			},
		});
		renderPanel();

		fireEvent.click(screen.getByRole("button", { name: "add" }));
		fireEvent.change(screen.getByLabelText("name"), {
			target: { value: "Activation rate" },
		});
		fireEvent.change(screen.getByLabelText("source"), {
			target: { value: "WEBHOOK" },
		});
		fireEvent.click(screen.getByRole("button", { name: "save" }));

		await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
		expect(createMock.mock.calls[0]?.[0]).toMatchObject({
			projectId: "proj-1",
			organizationId: "org-1",
			name: "Activation rate",
			sourceKind: "WEBHOOK",
		});

		const secret = await screen.findByTestId("metric-webhook-secret");
		expect(secret).toHaveTextContent("s3cret-value-shown-once");
		expect(screen.getByText("secretShownOnce")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "secretDone" }));
		await waitFor(() =>
			expect(
				screen.queryByTestId("metric-webhook-secret"),
			).not.toBeInTheDocument(),
		);
		expect(
			screen.queryByText("s3cret-value-shown-once"),
		).not.toBeInTheDocument();
	});

	it("does not open the secret dialog for MANUAL metrics", async () => {
		createMock.mockResolvedValue({
			metric: {
				...webhookMetric,
				sourceKind: "MANUAL",
				hasWebhookSecret: false,
			},
			webhookSecret: undefined,
		});
		renderPanel();
		fireEvent.click(screen.getByRole("button", { name: "add" }));
		fireEvent.change(screen.getByLabelText("name"), {
			target: { value: "NPS" },
		});
		fireEvent.click(screen.getByRole("button", { name: "save" }));
		await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
		expect(
			screen.queryByTestId("metric-webhook-secret"),
		).not.toBeInTheDocument();
	});

	it("lists metrics and only offers rotation to governance holders", async () => {
		listMock.mockResolvedValue({ metrics: [webhookMetric] });
		const { unmount } = renderPanel({ canRotate: false });
		expect(await screen.findByText("Activation rate")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /rotateSecret/ }),
		).not.toBeInTheDocument();
		unmount();

		rotateMock.mockResolvedValue({
			metric: webhookMetric,
			webhookSecret: { value: "rotated-secret", shownOnce: true },
		});
		renderPanel({ canRotate: true });
		fireEvent.click(
			await screen.findByRole("button", { name: /rotateSecret/ }),
		);
		expect(
			await screen.findByTestId("metric-webhook-secret"),
		).toHaveTextContent("rotated-secret");
	});

	it("hides editing controls for read-only members", async () => {
		listMock.mockResolvedValue({ metrics: [webhookMetric] });
		renderPanel({ canEdit: false, canRotate: false });
		expect(await screen.findByText("Activation rate")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "add" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "recordValue" }),
		).not.toBeInTheDocument();
	});
});
