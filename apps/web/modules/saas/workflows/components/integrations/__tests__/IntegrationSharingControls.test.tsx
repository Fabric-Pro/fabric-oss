import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { list, update } = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn() }));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		workflows: {
			integrations: { listSharing: list, setUsageScope: update },
		},
	},
}));

import { IntegrationSharingControls } from "../IntegrationSharingControls";

function show() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	render(
		<QueryClientProvider client={client}>
			<IntegrationSharingControls
				organizationId="org-example"
				provider="GMAIL"
			/>
		</QueryClientProvider>,
	);
}
beforeEach(() => {
	vi.clearAllMocks();
	update.mockResolvedValue({ success: true });
});
describe("connection sharing controls", () => {
	it("requires an explicit consent action before sharing the exact connection", async () => {
		list.mockResolvedValue({
			connections: [
				{
					id: "connection-example",
					name: "Gmail Example",
					usageScope: "OWNER_ONLY",
					ownedByCaller: true,
					canShare: true,
					canRevoke: true,
				},
			],
		});
		show();
		fireEvent.click(
			await screen.findByRole("button", {
				name: "Share Gmail Example with organization",
			}),
		);
		expect(update).not.toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", { name: "Share connection" }),
		);
		await waitFor(() =>
			expect(update).toHaveBeenCalledWith({
				organizationId: "org-example",
				integrationId: "connection-example",
				usageScope: "ORGANIZATION_SHARED",
			}),
		);
	});
	it("does not offer an unauthorized share action", async () => {
		list.mockResolvedValue({
			connections: [
				{
					id: "connection-example",
					name: "Gmail Example",
					usageScope: "OWNER_ONLY",
					ownedByCaller: true,
					canShare: false,
					canRevoke: true,
				},
			],
		});
		show();
		expect(await screen.findByText("Only you")).toBeVisible();
		expect(screen.queryByRole("button", { name: /Share/ })).toBeNull();
	});
	it("says a personal-only connection cannot be shared, without the admin hint", async () => {
		list.mockResolvedValue({
			connections: [
				{
					id: "gitlab-example",
					name: "GitLab",
					usageScope: "OWNER_ONLY",
					ownedByCaller: true,
					canShare: false,
					canRevoke: true,
					personalOnly: true,
				},
			],
		});
		show();
		expect(
			await screen.findByText(
				"Only you — this connection is personal and cannot be shared",
			),
		).toBeVisible();
		expect(screen.queryByRole("button", { name: /Share/ })).toBeNull();
		expect(
			screen.queryByText(/An organization owner or admin can share/),
		).toBeNull();
	});
	it("labels a personal-only connection marked shared before as personal, and still offers to stop sharing it", async () => {
		list.mockResolvedValue({
			connections: [
				{
					id: "gitlab-legacy-shared",
					name: "GitLab",
					usageScope: "ORGANIZATION_SHARED",
					ownedByCaller: true,
					canShare: false,
					canRevoke: true,
					personalOnly: true,
				},
			],
		});
		show();
		expect(
			await screen.findByText(
				"Only you — this connection is personal and cannot be shared",
			),
		).toBeVisible();
		expect(screen.queryByText("Shared with organization")).toBeNull();
		expect(
			screen.getByRole("button", { name: "Stop sharing GitLab" }),
		).toBeVisible();
	});
	it("lets authorized users revoke sharing without disconnecting the connection", async () => {
		list.mockResolvedValue({
			connections: [
				{
					id: "shared-example",
					name: "Shared Gmail",
					usageScope: "ORGANIZATION_SHARED",
					ownedByCaller: false,
					canShare: false,
					canRevoke: true,
				},
			],
		});
		show();
		fireEvent.click(
			await screen.findByRole("button", {
				name: "Stop sharing Shared Gmail",
			}),
		);
		await waitFor(() =>
			expect(update).toHaveBeenCalledWith({
				organizationId: "org-example",
				integrationId: "shared-example",
				usageScope: "OWNER_ONLY",
			}),
		);
	});
});
