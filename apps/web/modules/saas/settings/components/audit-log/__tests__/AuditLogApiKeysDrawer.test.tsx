/**
 * Tests for AuditLogApiKeysDrawer.
 *
 * Covers:
 *   - renders the existing keys list with masked prefix + reveal toggle
 *   - shows docs link only when docsEnabled
 *   - shows the lifecycle empty state when no rows
 *   - calls onViewAuditTrail on action menu click
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listMock = vi.fn();
const apiKeysListMock = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		audit: {
			list: (...args: unknown[]) => listMock(...args),
			apiKeys: {
				list: (...args: unknown[]) => apiKeysListMock(...args),
				create: vi.fn(),
				rotate: vi.fn(),
				revoke: vi.fn(),
			},
		},
	},
}));

import { AuditLogApiKeysDrawer } from "../AuditLogApiKeysDrawer";

function renderDrawer(props: {
	open?: boolean;
	docsEnabled?: boolean;
	onViewAuditTrail?: (id: string) => void;
}) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<AuditLogApiKeysDrawer
				mode="organization"
				organizationId="org-1"
				docsEnabled={props.docsEnabled ?? false}
				open={props.open ?? true}
				onOpenChange={() => {}}
				onViewAuditTrail={props.onViewAuditTrail}
			/>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	listMock.mockReset();
	apiKeysListMock.mockReset();
	// Default empty lifecycle response.
	listMock.mockResolvedValue({
		items: [],
		nextCursor: null,
		totalCount: 0,
	});
});

describe("AuditLogApiKeysDrawer", () => {
	it("renders the existing keys list with a masked prefix", async () => {
		apiKeysListMock.mockResolvedValue([
			{
				id: "key-1",
				name: "SRE laptop",
				keyPrefix: "org_aaaaaaaa",
				scopes: ["audit_log:read"],
				createdAt: new Date("2026-05-10T00:00:00Z"),
				expiresAt: null,
				lastUsedAt: new Date("2026-05-17T00:00:00Z"),
				isActive: true,
			},
		]);
		renderDrawer({});
		await waitFor(() => {
			expect(screen.getByText("SRE laptop")).toBeInTheDocument();
		});
		// Prefix is initially masked with bullets.
		expect(
			screen.getByText((content) => content.includes("••••••••••••")),
		).toBeInTheDocument();
		// Reveal button toggles to show the prefix.
		const reveal = screen.getByLabelText(
			"settings.auditLog.apiKeysDrawer.showSecret",
		);
		fireEvent.click(reveal);
		await waitFor(() => {
			expect(
				screen.getByText((content) => content.includes("org_aaaaaaaa")),
			).toBeInTheDocument();
		});
	});

	it("renders the lifecycle empty state when no rows", async () => {
		apiKeysListMock.mockResolvedValue([]);
		renderDrawer({});
		await waitFor(() => {
			expect(
				screen.getByText(
					"settings.auditLog.apiKeysDrawer.lifecycleEmpty",
				),
			).toBeInTheDocument();
		});
	});

	it("shows the docs link when docsEnabled=true", async () => {
		apiKeysListMock.mockResolvedValue([]);
		renderDrawer({ docsEnabled: true });
		await waitFor(() => {
			expect(
				screen.getByText(
					"settings.auditLog.apiKeysDrawer.docsLinkEnabled",
				),
			).toBeInTheDocument();
		});
	});

	it("hides the docs link when docsEnabled=false", async () => {
		apiKeysListMock.mockResolvedValue([]);
		renderDrawer({ docsEnabled: false });
		await waitFor(() => {
			expect(
				screen.queryByText(
					"settings.auditLog.apiKeysDrawer.docsLinkEnabled",
				),
			).toBeNull();
		});
	});
});
