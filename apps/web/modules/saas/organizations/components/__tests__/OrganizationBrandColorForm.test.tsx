import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { OrganizationBrandColorForm } from "../OrganizationBrandColorForm";

const f = vi.hoisted(() => ({ color: null as string | null }));
vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({
		activeOrganization: { id: "example-org" },
		refetchActiveOrganization: vi.fn(),
	}),
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		organizations: {
			brandColor: {
				get: { call: async () => ({ brandColor: f.color }) },
				update: { call: vi.fn() },
			},
		},
	},
}));
it.each([null, "red"])(
	"shows the stored brand choice without inventing a red default: %s",
	async (color) => {
		f.color = color;
		render(
			<QueryClientProvider client={new QueryClient()}>
				<OrganizationBrandColorForm />
			</QueryClientProvider>,
		);
		const red = await screen.findByRole("button", { name: "Red" });
		const { waitFor } = await import("@testing-library/react");
		await waitFor(() =>
			expect(red).toHaveAttribute(
				"aria-pressed",
				String(color === "red"),
			),
		);
		if (color === null) {
			for (const swatch of screen.getAllByRole("button")) {
				expect(swatch).toHaveAttribute("aria-pressed", "false");
			}
		}
	},
);
