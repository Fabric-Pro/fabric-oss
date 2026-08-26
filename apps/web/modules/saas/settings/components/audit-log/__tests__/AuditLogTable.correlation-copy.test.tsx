/**
 * Tests for the correlation-cell copy affordance added in UI/UX pass 2.
 *
 *  - Truncated text now ends with U+2026 so the truncation is obviously
 *    truncated.
 *  - A clipboard button next to the prefix copies the FULL id to the
 *    clipboard and surfaces an `aria-live` "Copied" announcement.
 *  - When `navigator.clipboard` is unavailable (jsdom by default) the
 *    component must still degrade gracefully — no thrown error, the
 *    aria-live region still announces.
 *
 * This file overrides the global next-intl mock with one that
 * interpolates `{id}` placeholders so the aria-label / announcement
 * assertions can match against the full correlation ID and the literal
 * "Copied" word (per the a11y spec).
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

// Capture toast calls so we can assert without rendering a Toaster.
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
	toast: { success: (msg: string) => toastSuccess(msg) },
}));

// Override the global next-intl mock with one that resolves the strings
// we care about for the a11y assertions in this file.
vi.mock("next-intl", () => {
	const dictionary: Record<string, string> = {
		"settings.auditLog.aria.copyCorrelationCell":
			"Copy correlation ID {id} to clipboard",
		"settings.auditLog.aria.copiedCorrelation": "Copied {id}",
		"settings.auditLog.aria.correlationCell":
			"Correlation ID, click to filter",
		"settings.auditLog.aria.copyCorrelationHover": "Copy full ID",
	};
	const interpolate = (
		template: string,
		params?: Record<string, unknown>,
	) => {
		if (!params) {
			return template;
		}
		return template.replace(/\{(\w+)\}/g, (_m, k: string) =>
			params[k] !== undefined ? String(params[k]) : `{${k}}`,
		);
	};
	return {
		useTranslations:
			() => (key: string, params?: Record<string, unknown>) => {
				const template = dictionary[key];
				if (template) {
					return interpolate(template, params);
				}
				return interpolate(key, params);
			},
		useLocale: () => "en",
		useFormatter: () => ({
			dateTime: (d: Date) => d.toISOString(),
			number: (n: number) => String(n),
			relativeTime: (d: Date) => d.toISOString(),
		}),
		useMessages: () => ({}),
		NextIntlClientProvider: ({ children }: { children: React.ReactNode }) =>
			children,
	};
});

import { AuditLogTable } from "../AuditLogTable";
import { EMPTY_FILTERS_STATE } from "../types";

const FULL_CORRELATION = "req_mp9kabcdef0123456789xyz_long_tail";

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
		metadata: { correlationId: FULL_CORRELATION },
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
	toastSuccess.mockReset();
});

describe("AuditLogTable correlation copy affordance", () => {
	it("displays the prefix with a trailing ellipsis", async () => {
		listMock.mockResolvedValue({
			items: [row()],
			nextCursor: null,
			totalCount: 1,
		});
		renderTable();
		await waitFor(() => {
			// Prefix = first 8 chars + U+2026
			expect(
				screen.getByText(`${FULL_CORRELATION.slice(0, 8)}…`),
			).toBeInTheDocument();
		});
	});

	it("renders a dedicated copy button with the full id in its aria-label", async () => {
		listMock.mockResolvedValue({
			items: [row()],
			nextCursor: null,
			totalCount: 1,
		});
		renderTable();
		await waitFor(() =>
			expect(
				screen.getByText(`${FULL_CORRELATION.slice(0, 8)}…`),
			).toBeInTheDocument(),
		);
		const copyBtn = screen.getByTestId("audit-correlation-copy");
		expect(copyBtn).toBeInTheDocument();
		const ariaLabel = copyBtn.getAttribute("aria-label") ?? "";
		// aria-label must include the FULL id (a11y requirement)
		expect(ariaLabel).toContain(FULL_CORRELATION);
	});

	it("writes the full correlation ID to navigator.clipboard when the copy button is clicked", async () => {
		listMock.mockResolvedValue({
			items: [row()],
			nextCursor: null,
			totalCount: 1,
		});
		const writeText = vi.fn().mockResolvedValue(undefined);
		// Define a clipboard polyfill for the duration of this test.
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
			writable: true,
		});
		renderTable();
		await waitFor(() =>
			expect(
				screen.getByText(`${FULL_CORRELATION.slice(0, 8)}…`),
			).toBeInTheDocument(),
		);
		fireEvent.click(screen.getByTestId("audit-correlation-copy"));
		await waitFor(() => {
			expect(writeText).toHaveBeenCalledWith(FULL_CORRELATION);
		});
	});

	it("announces 'Copied' via aria-live after the copy resolves", async () => {
		listMock.mockResolvedValue({
			items: [row()],
			nextCursor: null,
			totalCount: 1,
		});
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
			writable: true,
		});
		const { container } = renderTable();
		await waitFor(() =>
			expect(
				screen.getByText(`${FULL_CORRELATION.slice(0, 8)}…`),
			).toBeInTheDocument(),
		);
		fireEvent.click(screen.getByTestId("audit-correlation-copy"));
		await waitFor(() => {
			const liveRegion = container.querySelector(
				'[role="status"][aria-live="polite"]',
			);
			expect(liveRegion).not.toBeNull();
			expect(liveRegion?.textContent ?? "").toContain("Copied");
		});
	});

	it("does not throw when navigator.clipboard is undefined", async () => {
		listMock.mockResolvedValue({
			items: [row()],
			nextCursor: null,
			totalCount: 1,
		});
		// Replace clipboard with undefined for this test.
		Object.defineProperty(navigator, "clipboard", {
			value: undefined,
			configurable: true,
			writable: true,
		});
		renderTable();
		await waitFor(() =>
			expect(
				screen.getByText(`${FULL_CORRELATION.slice(0, 8)}…`),
			).toBeInTheDocument(),
		);
		// Must not throw — the catch branch sets the announcement only.
		expect(() =>
			fireEvent.click(screen.getByTestId("audit-correlation-copy")),
		).not.toThrow();
	});
});
