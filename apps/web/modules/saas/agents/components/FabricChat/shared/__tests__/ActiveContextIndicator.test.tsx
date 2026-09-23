import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@ui/components/tooltip";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveContextIndicator } from "../ActiveContextIndicator";

vi.mock("@saas/organizations/hooks", () => ({
	useEffectiveOrganizationId: (id: string | null | undefined) => id ?? null,
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			get: vi.fn(async () => ({ project: { name: "Atlas" } })),
		},
	},
}));

function wrap(children: ReactNode) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={queryClient}>
			<TooltipProvider>{children}</TooltipProvider>
		</QueryClientProvider>
	);
}

afterEach(() => {
	cleanup();
});

describe("ActiveContextIndicator — project pill (#2040)", () => {
	it("offers to remove the project when the surface can drop it", async () => {
		const onProjectRemove = vi.fn();
		render(
			wrap(
				<ActiveContextIndicator
					projectId="project_1"
					organizationId="org_1"
					onProjectRemove={onProjectRemove}
				/>,
			),
		);

		const remove = await screen.findByRole("button", {
			name: "Remove project Atlas",
		});
		fireEvent.click(remove);

		expect(onProjectRemove).toHaveBeenCalledTimes(1);
	});

	it("holds the remove control while a removal is in flight", async () => {
		render(
			wrap(
				<ActiveContextIndicator
					projectId="project_1"
					organizationId="org_1"
					onProjectRemove={vi.fn()}
					projectRemoveDisabled
				/>,
			),
		);

		expect(
			await screen.findByRole("button", { name: "Remove project Atlas" }),
		).toBeDisabled();
	});

	it("shows no remove control where the project cannot be dropped", async () => {
		render(
			wrap(
				<ActiveContextIndicator
					projectId="project_1"
					organizationId="org_1"
				/>,
			),
		);

		expect(await screen.findByText("Atlas")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Remove project/ }),
		).not.toBeInTheDocument();
	});
});
