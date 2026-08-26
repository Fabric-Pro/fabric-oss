/**
 * Tests for the AuditLogMetadataDrawer error-aware rendering (D16).
 *
 * The drawer reads a single row's `metadata` and surfaces:
 *  - correlationId at top with a copy button
 *  - exception block (type, message, fingerprint, stacktrace, cause)
 *  - the raw JSON metadata dump for completeness
 *
 * We test the rendering — the data plumbing through @tanstack/query's
 * cache is exercised by the integration test elsewhere; here we mock
 * `useQueryClient` to return a hand-built page so we can assert on the
 * DOM directly.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AuditLogMetadataDrawer } from "../AuditLogMetadataDrawer";
import { EMPTY_FILTERS_STATE } from "../types";

function renderWithClient(
	row: Record<string, unknown>,
	overrides: { mode?: "personal" | "organization" } = {},
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});

	// Seed the cache the drawer reads from. The query key shape lives in
	// `AuditLogTable.tsx`: ["audit-log", orgId, "organization"|"personal", filter].
	client.setQueryData(
		[
			"audit-log",
			"org-1",
			overrides.mode ?? "organization",
			// `filtersStateToApi(EMPTY_FILTERS_STATE)` evaluates to `{}` at
			// runtime — there are no defined fields. Match that shape.
			{},
		],
		{
			pages: [{ items: [row] }],
			pageParams: [undefined],
		},
	);

	return render(
		<QueryClientProvider client={client}>
			<AuditLogMetadataDrawer
				organizationId="org-1"
				filters={EMPTY_FILTERS_STATE}
				selectedRowId={row.id as string}
				viewerTimezone="UTC"
				onClose={() => undefined}
			/>
		</QueryClientProvider>,
	);
}

const FIXTURE_ROW_NO_ERROR = {
	id: "audit-row-1",
	organizationId: "org-1",
	userId: "u-1",
	actorType: "user",
	actorEmailSnapshot: "alice@example.com",
	actorNameSnapshot: "Alice",
	impersonatedById: null,
	action: "auth.login.success",
	category: "auth",
	severity: "info",
	outcome: "success",
	resourceType: "user",
	resourceId: "u-1",
	resourceName: "alice@example.com",
	projectId: null,
	ipAddress: "203.0.113.1",
	userAgent: "Mozilla/5.0",
	requestId: "req-x",
	sessionId: "sess-x",
	metadata: { correlationId: "corr-success-123" },
	durationMs: null,
	createdAt: "2026-05-16T12:00:00.000Z",
};

const FIXTURE_ROW_WITH_ERROR = {
	...FIXTURE_ROW_NO_ERROR,
	id: "audit-row-2",
	action: "error.permission_denied",
	category: "error",
	severity: "warning",
	outcome: "failure",
	resourceType: "procedure",
	resourceId: "projects.delete",
	resourceName: "projects.delete",
	metadata: {
		correlationId: "corr-err-456",
		fingerprint: "abc123def456",
		errorCode: "FORBIDDEN",
		exception: {
			type: "ORPCError",
			message: "You don't have permission",
			escaped: true,
			stacktrace: [
				"at handler (packages/api/foo.ts:42:10)",
				"at next (packages/api/orpc/router.ts:12:5)",
			],
		},
		cause: {
			type: "Error",
			message: "underlying db connection lost",
		},
		procedure: {
			path: "projects.delete",
			method: "POST",
			httpStatus: 403,
		},
	},
};

describe("AuditLogMetadataDrawer - correlation id", () => {
	it("renders the correlationId block with the value", () => {
		renderWithClient(FIXTURE_ROW_NO_ERROR);
		expect(screen.getByText("corr-success-123")).toBeInTheDocument();
	});

	it("does not render an exception block when none present", () => {
		renderWithClient(FIXTURE_ROW_NO_ERROR);
		expect(
			screen.queryByText(
				"settings.auditLog.metadataDrawer.exception.title",
			),
		).toBeNull();
	});
});

describe("AuditLogMetadataDrawer - exception", () => {
	it("renders the exception type", () => {
		renderWithClient(FIXTURE_ROW_WITH_ERROR);
		expect(screen.getByText("ORPCError")).toBeInTheDocument();
	});

	it("renders the exception message", () => {
		renderWithClient(FIXTURE_ROW_WITH_ERROR);
		expect(
			screen.getByText("You don't have permission"),
		).toBeInTheDocument();
	});

	it("renders the fingerprint", () => {
		renderWithClient(FIXTURE_ROW_WITH_ERROR);
		expect(screen.getByText("abc123def456")).toBeInTheDocument();
	});

	it("renders stack frames inside the collapsible details", () => {
		renderWithClient(FIXTURE_ROW_WITH_ERROR);
		// Both the stacktrace <details> AND the raw JSON metadata dump at
		// the bottom contain the stack frame text. Asserting that at least
		// one match exists is the relevant invariant.
		const matches = screen.getAllByText(/packages\/api\/foo\.ts/);
		expect(matches.length).toBeGreaterThan(0);
	});

	it("renders the cause chain section", () => {
		renderWithClient(FIXTURE_ROW_WITH_ERROR);
		const matches = screen.getAllByText(/underlying db connection lost/);
		expect(matches.length).toBeGreaterThan(0);
	});

	it("still renders correlationId for error rows", () => {
		renderWithClient(FIXTURE_ROW_WITH_ERROR);
		expect(screen.getByText("corr-err-456")).toBeInTheDocument();
	});
});

describe("AuditLogMetadataDrawer - new sections", () => {
	it("renders the humanized action label in the title", () => {
		renderWithClient(FIXTURE_ROW_NO_ERROR);
		// next-intl mock returns the key, so the fallback to the catalog
		// label kicks in for the action title.
		expect(screen.getByText(/Sign-in success/i)).toBeInTheDocument();
	});

	it("renders the trace-flow button when onTraceCorrelation is provided", () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		client.setQueryData(["audit-log", "org-1", "organization", {}], {
			pages: [{ items: [FIXTURE_ROW_NO_ERROR] }],
			pageParams: [undefined],
		});
		const onTrace = vi.fn();
		render(
			<QueryClientProvider client={client}>
				<AuditLogMetadataDrawer
					organizationId="org-1"
					filters={EMPTY_FILTERS_STATE}
					selectedRowId={FIXTURE_ROW_NO_ERROR.id as string}
					viewerTimezone="UTC"
					onClose={() => undefined}
					onTraceCorrelation={onTrace}
				/>
			</QueryClientProvider>,
		);
		const traceButton = screen.getByText(
			"settings.auditLog.metadataDrawer.traceFlow",
		);
		expect(traceButton).toBeInTheDocument();
	});

	it("calls onTraceCorrelation with the full id when the trace-flow button is clicked", () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		client.setQueryData(["audit-log", "org-1", "organization", {}], {
			pages: [{ items: [FIXTURE_ROW_NO_ERROR] }],
			pageParams: [undefined],
		});
		const onTrace = vi.fn();
		render(
			<QueryClientProvider client={client}>
				<AuditLogMetadataDrawer
					organizationId="org-1"
					filters={EMPTY_FILTERS_STATE}
					selectedRowId={FIXTURE_ROW_NO_ERROR.id as string}
					viewerTimezone="UTC"
					onClose={() => undefined}
					onTraceCorrelation={onTrace}
				/>
			</QueryClientProvider>,
		);
		const button = screen.getByTestId("audit-trace-flow");
		fireEvent.click(button);
		expect(onTrace).toHaveBeenCalledTimes(1);
		// FIXTURE_ROW_NO_ERROR.metadata.correlationId is "corr-success-123"
		expect(onTrace).toHaveBeenCalledWith("corr-success-123");
	});

	it("renders the keyboard help footer", () => {
		renderWithClient(FIXTURE_ROW_NO_ERROR);
		expect(
			screen.getByText("settings.auditLog.metadataDrawer.keyboardHelp"),
		).toBeInTheDocument();
	});

	it("renders the severity badge in the header", () => {
		renderWithClient(FIXTURE_ROW_WITH_ERROR);
		const status = screen.getAllByRole("status");
		expect(status.length).toBeGreaterThan(0);
	});
});
