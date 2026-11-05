import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@ui/components/tooltip";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveContextIndicator } from "../ActiveContextIndicator";

vi.mock("@saas/organizations/hooks", () => ({
	useEffectiveOrganizationId: (id: string | null | undefined) => id ?? null,
}));

const projectGet = vi.hoisted(() =>
	vi.fn(async (input: { organizationId?: string | null }) => ({
		project: {
			name:
				input.organizationId === "example-org-b"
					? "Example B"
					: "Atlas",
		},
	})),
);
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			get: projectGet,
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

it("keeps project context visible and makes capability details keyboard accessible", async () => {
	const user = userEvent.setup();
	render(
		wrap(
			<ActiveContextIndicator
				projectId="example-project"
				organizationId="example-org"
				agentIds={["task_planner"]}
				fabricToolIds={["fabric_web_search"]}
			/>,
		),
	);
	expect(await screen.findByText("Atlas")).toBeVisible();
	expect(screen.queryByText("1 agent")).not.toBeInTheDocument();
	const details = screen.getByRole("button", { name: "details" });
	details.focus();
	await user.keyboard("{Enter}");
	expect(
		screen.getByRole("dialog", { name: "capabilitiesTitle" }),
	).toBeVisible();
	const agents = await screen.findByRole("button", { name: "1 agent" });
	expect(agents).toBeVisible();
	agents.focus();
	await user.keyboard("{Enter}");
	expect(await screen.findByText("Task Planner")).toBeVisible();
	expect(screen.getByRole("dialog", { name: "1 agent" })).toBeVisible();
});

it("does not reuse another organization's project label", async () => {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const ui = (organizationId: string) => (
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<ActiveContextIndicator
					projectId="example-project"
					organizationId={organizationId}
				/>
			</TooltipProvider>
		</QueryClientProvider>
	);
	const view = render(ui("example-org-a"));
	expect(await screen.findByText("Atlas")).toBeVisible();
	view.rerender(ui("example-org-b"));
	expect(await screen.findByText("Example B")).toBeVisible();
	expect(screen.queryByText("Atlas")).not.toBeInTheDocument();
});
