/**
 * Tests for AuditLogTable's new visual columns and click-to-filter
 * affordance for the correlation ID prefix.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listMock = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		audit: {
			list: (...args: unknown[]) => listMock(...args),
		},
	},
}));

import { AuditLogTable } from "../AuditLogTable";
import { EMPTY_FILTERS_STATE } from "../types";

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "audit-1",
		organizationId: "org-1",
		userId: "user-1",
		actorType: "user",
		actorEmailSnapshot: "alice@example.com",
		actorNameSnapshot: "Alice",
		impersonatedById: null,
		action: "auth.login.success",
		category: "auth",
		severity: "info",
		outcome: "success",
		resourceType: "user",
		resourceId: "user-1",
		resourceName: "alice@example.com",
		projectId: null,
		ipAddress: "10.0.0.1",
		userAgent: "Mozilla/5.0",
		requestId: "req-1",
		sessionId: "sess-1",
		metadata: { correlationId: "abcd1234-rest-of-id-here" },
		durationMs: null,
		createdAt: new Date(Date.now() - 60_000).toISOString(),
		...over,
	};
}

function renderTable(
	props: Partial<React.ComponentProps<typeof AuditLogTable>> = {},
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<AuditLogTable
				mode="organization"
				organizationId="org-1"
				filters={EMPTY_FILTERS_STATE}
				viewerTimezone="UTC"
				onRowSelect={() => undefined}
				{...props}
			/>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	listMock.mockReset();
});

describe("AuditLogTable - new columns", () => {
	it("renders the short correlation ID in its own clickable cell", async () => {
		listMock.mockResolvedValue({
			items: [row()],
			nextCursor: null,
			totalCount: 1,
		});
		renderTable();
		await waitFor(() => {
			expect(screen.getByText("abcd1234…")).toBeInTheDocument();
		});
		// the affordance is a button so it's keyboard focusable
		const trigger = screen.getByText("abcd1234…").closest("button");
		expect(trigger).not.toBeNull();
	});

	it("fires onCorrelationClick with the full id when the prefix is clicked", async () => {
		listMock.mockResolvedValue({
			items: [row()],
			nextCursor: null,
			totalCount: 1,
		});
		const onClick = vi.fn();
		renderTable({ onCorrelationClick: onClick });
		await waitFor(() =>
			expect(screen.getByText("abcd1234…")).toBeInTheDocument(),
		);
		fireEvent.click(screen.getByText("abcd1234…"));
		expect(onClick).toHaveBeenCalledWith("abcd1234-rest-of-id-here");
	});

	it("renders the success outcome as an icon-only cell (item 17)", async () => {
		listMock.mockResolvedValue({
			items: [row()],
			nextCursor: null,
			totalCount: 1,
		});
		renderTable();
		await waitFor(() =>
			expect(
				screen.getByTestId("audit-outcome-success"),
			).toBeInTheDocument(),
		);
	});

	it("renders the failure outcome distinctly (icon only)", async () => {
		listMock.mockResolvedValue({
			items: [row({ outcome: "failure", action: "auth.login.failure" })],
			nextCursor: null,
			totalCount: 1,
		});
		renderTable();
		await waitFor(() =>
			expect(
				screen.getByTestId("audit-outcome-failure"),
			).toBeInTheDocument(),
		);
	});

	it("shows a severity badge as a status element", async () => {
		listMock.mockResolvedValue({
			items: [row({ severity: "warning" })],
			nextCursor: null,
			totalCount: 1,
		});
		renderTable();
		await waitFor(() => {
			const badges = screen.getAllByRole("status");
			expect(badges.length).toBeGreaterThan(0);
		});
	});

	it("renders the virgin empty state when items is [] and no filters", async () => {
		listMock.mockResolvedValue({
			items: [],
			nextCursor: null,
			totalCount: 0,
		});
		renderTable();
		await waitFor(() =>
			expect(
				screen.getByText("settings.auditLog.empty.virginTitle"),
			).toBeInTheDocument(),
		);
	});

	it("renders the filtered-no-match empty state when filters are active", async () => {
		listMock.mockResolvedValue({
			items: [],
			nextCursor: null,
			totalCount: 0,
		});
		renderTable({
			filters: {
				...EMPTY_FILTERS_STATE,
				correlationId: "non-matching-id",
			},
		});
		await waitFor(() =>
			expect(
				screen.getByText("settings.auditLog.empty.title"),
			).toBeInTheDocument(),
		);
	});

	it("renders the latency column when at least one row has durationMs (item 20)", async () => {
		listMock.mockResolvedValue({
			items: [row({ durationMs: 12 })],
			nextCursor: null,
			totalCount: 1,
		});
		renderTable();
		await waitFor(() => {
			expect(screen.getByTestId("audit-latency")).toBeInTheDocument();
		});
		expect(screen.getByText("12ms")).toBeInTheDocument();
		expect(
			screen.getByText("settings.auditLog.columns.latency"),
		).toBeInTheDocument();
	});

	it("hides the latency column when no row has durationMs (item 20)", async () => {
		listMock.mockResolvedValue({
			items: [row()],
			nextCursor: null,
			totalCount: 1,
		});
		renderTable();
		await waitFor(() => {
			expect(screen.getByText("Sign-in success")).toBeInTheDocument();
		});
		expect(
			screen.queryByText("settings.auditLog.columns.latency"),
		).toBeNull();
	});

	it("renders the timestamp UTC label (item 5)", async () => {
		listMock.mockResolvedValue({
			items: [row()],
			nextCursor: null,
			totalCount: 1,
		});
		renderTable();
		await waitFor(() =>
			expect(
				screen.getByText("settings.auditLog.columns.timestampWithZone"),
			).toBeInTheDocument(),
		);
	});

	it("renders the pagination footer with the page-size selector", async () => {
		listMock.mockResolvedValue({
			items: [row()],
			nextCursor: null,
			totalCount: 1,
		});
		renderTable();
		await waitFor(() => {
			expect(screen.getByTestId("audit-pagination")).toBeInTheDocument();
		});
		expect(
			screen.getByText("settings.auditLog.pagination.label:"),
		).toBeInTheDocument();
	});

	it("uses the api-key actorNameSnapshot when available (item 16)", async () => {
		listMock.mockResolvedValue({
			items: [
				row({
					actorType: "api_key",
					actorEmailSnapshot: null,
					actorNameSnapshot: "SRE laptop",
					metadata: {
						correlationId: "abcd1234-rest-of-id-here",
						keyPrefix: "org_aaaaaaaa",
					},
				}),
			],
			nextCursor: null,
			totalCount: 1,
		});
		renderTable();
		await waitFor(() =>
			expect(screen.getByText("SRE laptop")).toBeInTheDocument(),
		);
	});

	it("renders the action's static catalog label when next-intl is mocked", async () => {
		listMock.mockResolvedValue({
			items: [row()],
			nextCursor: null,
			totalCount: 1,
		});
		renderTable();
		// next-intl mock returns the key, the component falls back to the
		// catalog's static label for known actions
		await waitFor(() =>
			expect(screen.getByText("Sign-in success")).toBeInTheDocument(),
		);
	});

	it("renders the project column header in org mode", async () => {
		listMock.mockResolvedValue({
			items: [row()],
			nextCursor: null,
			totalCount: 1,
		});
		renderTable({ mode: "organization" });
		await waitFor(() =>
			expect(
				screen.getByText("settings.auditLog.columns.project"),
			).toBeInTheDocument(),
		);
	});

	it("does NOT render the project column header in personal mode", async () => {
		listMock.mockResolvedValue({
			items: [row()],
			nextCursor: null,
			totalCount: 1,
		});
		renderTable({ mode: "personal" });
		// Wait for the table body to populate; we use the action label
		// (which renders once per row) instead of alice@example.com
		// (which appears in both the actor cell and the resource cell).
		await waitFor(() =>
			expect(screen.getByText("Sign-in success")).toBeInTheDocument(),
		);
		expect(
			screen.queryByText("settings.auditLog.columns.project"),
		).toBeNull();
	});

	it("renders project cell with id when projectId is set (org mode)", async () => {
		listMock.mockResolvedValue({
			items: [row({ projectId: "proj-xyz" })],
			nextCursor: null,
			totalCount: 1,
		});
		renderTable({ mode: "organization" });
		await waitFor(() =>
			expect(screen.getByText("proj-xyz")).toBeInTheDocument(),
		);
	});

	it("hovering the severity column header reveals an icon-led tooltip (item 2)", async () => {
		listMock.mockResolvedValue({
			items: [row()],
			nextCursor: null,
			totalCount: 1,
		});
		renderTable({ mode: "personal" });
		await waitFor(() =>
			expect(screen.getByText("Sign-in success")).toBeInTheDocument(),
		);
		// Radix Tooltip lazily mounts the content portal when the trigger
		// is focused or pointer-entered. Hover the severity header so the
		// content appears, then assert the icon-led legend rows render.
		const severityHeader = screen.getByText(
			"settings.auditLog.columns.severity",
		);
		fireEvent.pointerEnter(severityHeader);
		fireEvent.focus(severityHeader);
		await waitFor(() => {
			expect(
				screen.getByTestId("audit-tooltip-column-severity"),
			).toBeInTheDocument();
		});
		const tooltipBody = screen.getByTestId("audit-tooltip-column-severity");
		// next-intl's test mock returns the i18n key as the rendered text,
		// so assert against the severity keys (info/warning/error/critical).
		// In production these surface as the translated label next to an icon.
		const body = tooltipBody.textContent ?? "";
		expect(body).toContain("severities.info");
		expect(body).toContain("severities.warning");
		expect(body).toContain("severities.error");
		expect(body).toContain("severities.critical");
	});

	it("hovering the outcome column header reveals an icon-led tooltip (item 2)", async () => {
		listMock.mockResolvedValue({
			items: [row()],
			nextCursor: null,
			totalCount: 1,
		});
		renderTable({ mode: "personal" });
		await waitFor(() =>
			expect(screen.getByText("Sign-in success")).toBeInTheDocument(),
		);
		const outcomeHeader = screen.getByText(
			"settings.auditLog.columns.outcome",
		);
		fireEvent.pointerEnter(outcomeHeader);
		fireEvent.focus(outcomeHeader);
		await waitFor(() => {
			expect(
				screen.getByTestId("audit-tooltip-column-outcome"),
			).toBeInTheDocument();
		});
		const tooltipBody = screen.getByTestId("audit-tooltip-column-outcome");
		const body = tooltipBody.textContent ?? "";
		expect(body).toContain("outcomes.success");
		expect(body).toContain("outcomes.failure");
	});
});
