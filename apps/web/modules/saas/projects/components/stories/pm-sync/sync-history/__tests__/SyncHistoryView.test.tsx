import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listPmSyncLog = vi.fn();

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		basePath: "/app",
	}),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			pmSyncLog: {
				list: (...args: unknown[]) => listPmSyncLog(...args),
			},
		},
	},
}));

if (!(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver) {
	(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
}
if (!Element.prototype.hasPointerCapture) {
	Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.scrollIntoView) {
	Element.prototype.scrollIntoView = () => {};
}

import { SyncHistoryView } from "../SyncHistoryView";

function makeRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "log_1",
		createdAt: new Date("2026-05-20T10:30:00Z"),
		direction: "push",
		entityType: "STORY",
		entityId: "story_abc",
		title: "Checkout flow refactor",
		pmTool: "azure-devops",
		status: "SUCCESS",
		statusDetail: null,
		batchId: null,
		actorUserId: null,
		correlationId: null,
		durationMs: 1200,
		externalId: "AB#123",
		externalUrl: "https://dev.azure.com/org/_workitems/edit/123",
		...overrides,
	};
}

function renderView() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<SyncHistoryView projectId="project_1" active />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	listPmSyncLog.mockReset();
});

afterEach(() => cleanup());

describe("SyncHistoryView (8.2)", () => {
	it("renders the editorial 'No sync activity yet' empty state when there are no rows", async () => {
		listPmSyncLog.mockResolvedValue({ rows: [], total: 0 });
		renderView();

		expect(
			await screen.findByText("No sync activity yet"),
		).toBeInTheDocument();
		expect(screen.queryByRole("table")).not.toBeInTheDocument();
	});

	it("renders log rows newest-first as supplied by the query", async () => {
		listPmSyncLog.mockResolvedValue({
			rows: [makeRow()],
			total: 1,
		});
		renderView();

		expect(
			await screen.findByText("Checkout flow refactor"),
		).toBeInTheDocument();
		expect(screen.getByText("Success")).toBeInTheDocument();
		// External deep-link rendered for the row.
		expect(
			screen.getByRole("link", { name: /Open Checkout flow refactor/ }),
		).toBeInTheDocument();
	});

	it("wires the status filter into the list query (composing AND) and resets to page 0", async () => {
		listPmSyncLog.mockResolvedValue({ rows: [makeRow()], total: 1 });
		renderView();

		await screen.findByText("Checkout flow refactor");
		listPmSyncLog.mockClear();

		// The Select trigger for Status is labelled by the editorial label.
		fireEvent.click(screen.getByRole("combobox", { name: /Status/ }));
		fireEvent.click(await screen.findByRole("option", { name: "Failure" }));

		await waitFor(() => {
			expect(listPmSyncLog).toHaveBeenCalled();
		});
		const lastCall = listPmSyncLog.mock.calls.at(-1)?.[0];
		expect(lastCall).toMatchObject({
			projectId: "project_1",
			status: "FAILURE",
			limit: 50,
			offset: 0,
		});
	});

	it("wires the item (entity) filter into the list query", async () => {
		listPmSyncLog.mockResolvedValue({ rows: [makeRow()], total: 1 });
		renderView();

		await screen.findByText("Checkout flow refactor");
		listPmSyncLog.mockClear();

		fireEvent.change(screen.getByLabelText("Item"), {
			target: { value: "story_abc" },
		});

		await waitFor(() => {
			const lastCall = listPmSyncLog.mock.calls.at(-1)?.[0];
			expect(lastCall).toMatchObject({ entityId: "story_abc" });
		});
	});

	it("passes the 'To' date as end-of-day so the inclusive lte filter matches same-day rows", async () => {
		listPmSyncLog.mockResolvedValue({ rows: [makeRow()], total: 1 });
		renderView();

		await screen.findByText("Checkout flow refactor");
		listPmSyncLog.mockClear();

		fireEvent.change(screen.getByLabelText("To"), {
			target: { value: "2026-05-20" },
		});

		await waitFor(() => {
			const lastCall = listPmSyncLog.mock.calls.at(-1)?.[0];
			expect(lastCall?.dateTo).toBeInstanceOf(Date);
		});
		const dateTo = listPmSyncLog.mock.calls.at(-1)?.[0]?.dateTo as Date;
		expect(dateTo.getHours()).toBe(23);
		expect(dateTo.getMinutes()).toBe(59);
		expect(dateTo.getSeconds()).toBe(59);
	});

	it("paginates with page size 50 — Next advances the offset, Previous goes back", async () => {
		listPmSyncLog.mockResolvedValue({
			rows: Array.from({ length: 50 }, (_, i) =>
				makeRow({ id: `log_${i}`, title: `Item ${i}` }),
			),
			total: 120,
		});
		renderView();

		await screen.findByText("Item 0");
		expect(screen.getByText(/1–50 of 120/)).toBeInTheDocument();

		const next = screen.getByRole("button", { name: "Next page" });
		const prev = screen.getByRole("button", { name: "Previous page" });
		expect(prev).toBeDisabled();
		expect(screen.getByText(/Page 1 of 3/)).toBeInTheDocument();

		listPmSyncLog.mockClear();
		fireEvent.click(next);

		await waitFor(() => {
			const lastCall = listPmSyncLog.mock.calls.at(-1)?.[0];
			expect(lastCall).toMatchObject({ limit: 50, offset: 50 });
		});
		expect(screen.getByText(/Page 2 of 3/)).toBeInTheDocument();
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Previous page" }),
			).toBeEnabled(),
		);

		// Going back to page 0 — the result is served from cache, so the page
		// indicator updates without necessarily re-issuing the request.
		fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
		await waitFor(() => {
			expect(screen.getByText(/Page 1 of 3/)).toBeInTheDocument();
		});
		expect(
			screen.getByRole("button", { name: "Previous page" }),
		).toBeDisabled();
	});

	it("disables Next on the last page", async () => {
		listPmSyncLog.mockResolvedValue({
			rows: [makeRow()],
			total: 1,
		});
		renderView();

		await screen.findByText("Checkout flow refactor");
		expect(
			screen.getByRole("button", { name: "Next page" }),
		).toBeDisabled();
	});
});
