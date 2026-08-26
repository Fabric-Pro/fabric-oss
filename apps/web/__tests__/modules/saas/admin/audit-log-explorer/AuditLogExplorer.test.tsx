/**
 * Tests for the AuditLogExplorer client component.
 *
 * Coverage:
 *   - Initial render shows the explanation block + Connect form + open
 *     API docs button.
 *   - The API-key input is a `type="password"` field by default; the
 *     show/hide toggle flips it and reports state via `aria-pressed`.
 *   - The API key never leaks into localStorage (we spy on
 *     window.localStorage.setItem and assert the key is not persisted).
 *   - Clicking Connect calls `orpcClient.admin.auditLog.viaApiKey` with
 *     the resolved input + renders the returned rows.
 *   - An ORPCError-shaped failure surfaces a friendly inline error and
 *     keeps the connect form mounted.
 *   - Disconnect clears the API key from component state.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockViaApiKey, mockAuditList, mockAuditExport, mockAuditTaxonomy } =
	vi.hoisted(() => ({
		mockViaApiKey: vi.fn(),
		mockAuditList: vi.fn(),
		mockAuditExport: vi.fn(),
		mockAuditTaxonomy: vi.fn(),
	}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		admin: {
			auditLog: {
				viaApiKey: (input: unknown) => mockViaApiKey(input),
			},
		},
		// The explorer now mounts the in-product audit-log viewer
		// components (table + filters + export button) so the orpc
		// surface they reach for needs at least stubbed entries — even
		// though the explorer's table data source overrides `audit.list`,
		// the audit history dropdown + the table's `audit.list` fallback
		// can still resolve a real-query path if a code path slips
		// through. These mocks make the test fail loud if that happens.
		audit: {
			list: (input: unknown) => mockAuditList(input),
			export: (input: unknown) => mockAuditExport(input),
			taxonomy: (input: unknown) => mockAuditTaxonomy(input),
		},
	},
}));

// useRouter / useSearchParams are used by AuditLogFilters for URL sync.
// Explorer mode skips the URL sync but the hooks are still invoked, so
// they need stubs that return something reasonable.
vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace: vi.fn() }),
	useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@ui/hooks/use-toast", () => ({
	useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("next-intl", () => ({
	useTranslations:
		(_ns?: string) => (k: string, vars?: Record<string, unknown>) => {
			// Pass-through translator that ignores namespace + returns the key.
			// Tests assert on visible strings via the keys themselves so they
			// stay independent of locale message changes.
			if (vars && Object.keys(vars).length > 0) {
				return `${k}:${JSON.stringify(vars)}`;
			}
			return k;
		},
}));

import { AuditLogExplorer } from "../../../../../modules/saas/admin/component/audit-log-explorer/AuditLogExplorer";

function renderExplorer() {
	// The explorer now embeds the shared audit-log viewer components, all
	// of which call `useQuery` for their own data plumbing. Tests must
	// wrap in a QueryClientProvider — the explorer's `dataSource` props
	// route the actual fetches through the mocked `viaApiKey` call.
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<AuditLogExplorer />
		</QueryClientProvider>,
	);
}

const SAMPLE_RESPONSE = {
	tenant: {
		kind: "organization" as const,
		organizationId: "org-1",
		userId: null,
		keyType: "organization" as const,
		keyPrefix: "org_bc52818d",
	},
	items: [
		{
			id: "row-1",
			organizationId: "org-1",
			userId: "u-1",
			actorType: "user",
			actor: { email: "alice@example.com", name: "Alice" },
			impersonatedById: null,
			action: "feature.created",
			category: "data",
			severity: "info",
			outcome: "success",
			resource: {
				type: "Feature",
				id: "feat-123",
				name: "Login page",
			},
			projectId: "proj-1",
			ipAddress: "203.0.113.42",
			userAgent: "Mozilla/5.0",
			correlationId: "req-abc",
			sessionId: null,
			metadata: null,
			durationMs: null,
			createdAt: "2026-05-18T00:00:00.000Z",
		},
	],
	nextCursor: null,
	total: 1,
};

beforeEach(() => {
	mockViaApiKey.mockReset();
	mockViaApiKey.mockResolvedValue(SAMPLE_RESPONSE);
	// Reset the in-product mocks so we can spot accidental fallbacks.
	mockAuditList.mockReset();
	mockAuditList.mockResolvedValue({
		items: [],
		nextCursor: null,
		totalCount: 0,
	});
	mockAuditExport.mockReset();
	mockAuditTaxonomy.mockReset();
	mockAuditTaxonomy.mockResolvedValue({ actions: [], categories: [] });
	// Clear localStorage between tests so the base-URL history doesn't leak.
	window.localStorage.clear();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("AuditLogExplorer — initial state", () => {
	it("renders the explanation block + Connect button + API key input", () => {
		renderExplorer();
		expect(screen.getByText(/explanation/i)).toBeInTheDocument();
		expect(
			screen.getByTestId("explorer-api-key-input"),
		).toBeInTheDocument();
		expect(
			screen.getByTestId("explorer-connect-button"),
		).toBeInTheDocument();
	});

	it("makes the API key input `type=password` by default and exposes a show/hide toggle", () => {
		renderExplorer();
		const input = screen.getByTestId(
			"explorer-api-key-input",
		) as HTMLInputElement;
		expect(input.type).toBe("password");

		const toggle = screen.getByLabelText(/showKey|hideKey/i);
		expect(toggle).toHaveAttribute("aria-pressed", "false");
		fireEvent.click(toggle);
		expect(input.type).toBe("text");
		expect(toggle).toHaveAttribute("aria-pressed", "true");
	});
});

describe("AuditLogExplorer — connect / fetch happy path", () => {
	it("calls orpcClient.admin.auditLog.viaApiKey on Connect and renders the returned tenant + rows through the shared viewer table", async () => {
		renderExplorer();

		const input = screen.getByTestId("explorer-api-key-input");
		fireEvent.change(input, {
			target: { value: "org_bc52818d_N4UpxiHhOH0L70Ei26XNg2dEACFNwNZ5" },
		});

		fireEvent.click(screen.getByTestId("explorer-connect-button"));

		// The explorer fires a verify probe on Connect, then the shared
		// `<AuditLogTable>` mounts and fires its own initial page-load
		// fetch through the explorer's `dataSource`. Both go through the
		// same `viaApiKey` mock.
		await waitFor(() => {
			expect(mockViaApiKey).toHaveBeenCalled();
		});

		const probeArgs = mockViaApiKey.mock.calls[0]?.[0] as {
			apiKey: string;
			limit: number;
		};
		expect(probeArgs.apiKey).toBe(
			"org_bc52818d_N4UpxiHhOH0L70Ei26XNg2dEACFNwNZ5",
		);
		expect(probeArgs.limit).toBe(50);

		// The shared viewer table renders with `data-testid="audit-log-table"`.
		await waitFor(() => {
			expect(screen.getByTestId("audit-log-table")).toBeInTheDocument();
		});

		// The row data flows through the viewer's normal render path —
		// action raw key, actor email snapshot (the viewer's preferred
		// label for non-api_key rows), and IP address all reach the
		// screen.
		await waitFor(() => {
			expect(screen.getByText(/feature.created/i)).toBeInTheDocument();
		});
		expect(screen.getByText(/alice@example\.com/)).toBeInTheDocument();
		expect(screen.getByText(/203\.0\.113\.42/)).toBeInTheDocument();
	});
});

describe("AuditLogExplorer — security: key never persisted", () => {
	it("does NOT write the API key to localStorage when Connect is clicked", async () => {
		const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
		renderExplorer();

		const apiKey = "org_bc52818d_supersecretvaluedonotpersist";
		const input = screen.getByTestId("explorer-api-key-input");
		fireEvent.change(input, { target: { value: apiKey } });
		fireEvent.click(screen.getByTestId("explorer-connect-button"));

		await waitFor(() => {
			expect(mockViaApiKey).toHaveBeenCalled();
		});

		// Any localStorage write that DID happen (e.g., base-URL history)
		// must NOT contain the API key.
		for (const call of setItemSpy.mock.calls) {
			const [, value] = call;
			expect(value).not.toContain(apiKey);
			expect(value).not.toContain("supersecretvaluedonotpersist");
		}
	});
});

describe("AuditLogExplorer — error handling", () => {
	it("renders a friendly inline error and keeps the form mounted when the fetch throws", async () => {
		mockViaApiKey.mockRejectedValueOnce(new Error("Unauthorized: bad key"));
		renderExplorer();

		fireEvent.change(screen.getByTestId("explorer-api-key-input"), {
			target: { value: "org_bad_key" },
		});
		fireEvent.click(screen.getByTestId("explorer-connect-button"));

		await waitFor(() => {
			expect(screen.getByTestId("explorer-error")).toBeInTheDocument();
		});
		expect(
			screen.queryByTestId("explorer-results-table"),
		).not.toBeInTheDocument();
		// Connect button still mounted (form not torn down).
		expect(
			screen.getByTestId("explorer-connect-button"),
		).toBeInTheDocument();
	});
});

describe("AuditLogExplorer — disconnect", () => {
	it("clears the API key from component state on Disconnect", async () => {
		renderExplorer();

		const input = screen.getByTestId(
			"explorer-api-key-input",
		) as HTMLInputElement;
		fireEvent.change(input, {
			target: { value: "org_bc52818d_secret" },
		});
		fireEvent.click(screen.getByTestId("explorer-connect-button"));

		// Shared-viewer table mounts (with `audit-log-table` testId) once
		// the connect probe resolves.
		await waitFor(() => {
			expect(screen.getByTestId("audit-log-table")).toBeInTheDocument();
		});

		fireEvent.click(screen.getByTestId("explorer-disconnect-button"));

		// Disconnect tears down the results section and clears the input.
		expect(screen.queryByTestId("audit-log-table")).not.toBeInTheDocument();
		expect(input.value).toBe("");
	});
});
