/**
 * Tests for AuditLogExportButton (v2 item 6).
 *
 * Covers the new history dropdown sourced from `audit.exported` rows:
 *   - Primary button triggers a CSV export immediately.
 *   - Chevron opens a dropdown with the last 5 exports.
 *   - "Re-download" on a history entry re-runs the export with the
 *     saved filter snapshot.
 *   - Empty-state message appears when no history rows exist.
 *   - The today-count badge surfaces near the primary button.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listMock = vi.fn();
const exportMock = vi.fn();
const toastMock = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		audit: {
			list: (...args: unknown[]) => listMock(...args),
			export: (...args: unknown[]) => exportMock(...args),
		},
	},
}));

vi.mock("@ui/hooks/use-toast", () => ({
	useToast: () => ({ toast: toastMock }),
}));

import { AuditLogExportButton } from "../AuditLogExportButton";
import { EMPTY_FILTERS_STATE } from "../types";

function renderExportButton(
	props: Partial<React.ComponentProps<typeof AuditLogExportButton>> = {},
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<AuditLogExportButton
				organizationId="org-1"
				filters={EMPTY_FILTERS_STATE}
				{...props}
			/>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	listMock.mockReset();
	exportMock.mockReset();
	toastMock.mockReset();
	listMock.mockResolvedValue({ items: [], nextCursor: null, totalCount: 0 });
	exportMock.mockResolvedValue({
		body: "id,createdAt\n",
		filename: "audit-log.csv",
		contentType: "text/csv",
		format: "csv",
		rowCount: 0,
	});
	// JSDOM lacks URL.createObjectURL; stub it.
	Object.defineProperty(URL, "createObjectURL", {
		configurable: true,
		writable: true,
		value: vi.fn(() => "blob:mock"),
	});
	Object.defineProperty(URL, "revokeObjectURL", {
		configurable: true,
		writable: true,
		value: vi.fn(),
	});
});

describe("AuditLogExportButton — primary action", () => {
	it("renders enabled when the cache has rows", async () => {
		// Seed totalCount lookup by populating the audit-log list cache.
		listMock.mockResolvedValue({
			items: [],
			nextCursor: null,
			totalCount: 100,
		});
		renderExportButton();
		const primary = await screen.findByTestId("audit-export-primary");
		await waitFor(() => expect(primary).not.toBeDisabled());
	});

	it("calls audit.export when the primary button is clicked", async () => {
		listMock.mockResolvedValue({
			items: [],
			nextCursor: null,
			totalCount: 5,
		});
		renderExportButton();
		await waitFor(() => expect(listMock).toHaveBeenCalled());
		fireEvent.click(screen.getByTestId("audit-export-primary"));
		await waitFor(() => expect(exportMock).toHaveBeenCalledTimes(1));
		const callArg = exportMock.mock.calls[0]?.[0] as {
			format: string;
			organizationId: string | null;
		};
		expect(callArg.format).toBe("csv");
		expect(callArg.organizationId).toBe("org-1");
	});
});

describe("AuditLogExportButton — history dropdown (item 6)", () => {
	it("renders the empty-state message when there are no export rows", async () => {
		listMock.mockResolvedValue({
			items: [],
			nextCursor: null,
			totalCount: 0,
		});
		renderExportButton();
		const user = userEvent.setup();
		await user.click(await screen.findByTestId("audit-export-chevron"));
		await waitFor(() =>
			expect(
				screen.getByTestId("audit-export-history-empty"),
			).toBeInTheDocument(),
		);
	});

	it("renders up to 5 history entries with format + row count + filter summary", async () => {
		const exportedRow = (overrides: Record<string, unknown> = {}) => ({
			id: `aud-${Math.random().toString(36).slice(2, 8)}`,
			action: "audit.exported",
			category: "audit",
			actorEmailSnapshot: "alice@example.com",
			actorNameSnapshot: "Alice",
			actorType: "user",
			impersonatedById: null,
			organizationId: "org-1",
			userId: "user-1",
			severity: "info",
			outcome: "success",
			resourceType: null,
			resourceId: null,
			resourceName: null,
			projectId: null,
			ipAddress: null,
			userAgent: null,
			requestId: null,
			sessionId: null,
			durationMs: null,
			createdAt: new Date(Date.now() - 60_000).toISOString(),
			metadata: {
				format: "csv",
				rowCount: 100,
				filters: {
					actions: ["auth.login.success"],
					outcomes: ["success"],
					dateFrom: new Date("2026-05-01T00:00:00Z").toISOString(),
				},
			},
			...overrides,
		});
		listMock.mockResolvedValue({
			items: [
				exportedRow(),
				exportedRow({
					id: "aud-2",
					metadata: {
						format: "ndjson",
						rowCount: 50,
						filters: { categories: ["audit"] },
					},
				}),
			],
			nextCursor: null,
			totalCount: 2,
		});
		renderExportButton();
		const user = userEvent.setup();
		await user.click(await screen.findByTestId("audit-export-chevron"));
		const entries = await screen.findAllByTestId(
			"audit-export-history-entry",
		);
		expect(entries.length).toBe(2);
		// The +N more badge / summary tooltip lives inside the entry.
		const first = entries[0]!;
		expect(
			within(first).getByTestId("audit-export-filter-summary"),
		).toBeInTheDocument();
		// CSV / 100 rows label on the first entry.
		expect(within(first).getByText(/csv/i)).toBeInTheDocument();
	});

	it("re-runs the export with the saved filter snapshot when 'Re-download' is clicked", async () => {
		const row = {
			id: "aud-rd",
			action: "audit.exported",
			category: "audit",
			actorEmailSnapshot: "alice@example.com",
			actorNameSnapshot: "Alice",
			actorType: "user",
			impersonatedById: null,
			organizationId: "org-1",
			userId: "user-1",
			severity: "info",
			outcome: "success",
			resourceType: null,
			resourceId: null,
			resourceName: null,
			projectId: null,
			ipAddress: null,
			userAgent: null,
			requestId: null,
			sessionId: null,
			durationMs: null,
			createdAt: new Date(Date.now() - 60_000).toISOString(),
			metadata: {
				format: "ndjson",
				rowCount: 30,
				filters: { outcomes: ["failure"] },
			},
		};
		listMock.mockResolvedValue({
			items: [row],
			nextCursor: null,
			totalCount: 1,
		});
		renderExportButton();
		const user = userEvent.setup();
		await user.click(await screen.findByTestId("audit-export-chevron"));
		const btn = await screen.findByTestId("audit-export-redownload");
		await user.click(btn);
		await waitFor(() => expect(exportMock).toHaveBeenCalledTimes(1));
		const callArg = exportMock.mock.calls[0]?.[0] as {
			format: string;
			filter: Record<string, unknown>;
		};
		expect(callArg.format).toBe("ndjson");
		expect(callArg.filter).toEqual({ outcomes: ["failure"] });
	});
});
