/**
 * The organization's Workspaces page: the pages Fabric Agent wrote that the
 * people of the organization open from here. They are read through the same
 * tool an agent calls (`fabric_list_frames`), and a new one is started by
 * asking Fabric Agent, since nothing on a page is built by us.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	useFabricToolQuery: vi.fn(),
	openLauncher: vi.fn(),
	registerContext: vi.fn(),
}));

vi.mock("@saas/mcp/lib/fabric-tool-client", () => ({
	useFabricToolQuery: mocks.useFabricToolQuery,
}));

vi.mock("@saas/agents/components/FabricAgentLauncher", () => ({
	useOptionalFabricAgentLauncher: () => ({
		openLauncher: mocks.openLauncher,
	}),
	useRegisterFabricAgentContext: mocks.registerContext,
}));

vi.mock("@saas/get-started/components/PageTourButton", () => ({
	PageTourButton: ({ pageId }: { pageId: string }) => (
		<span data-testid="tour-button" data-page-id={pageId} />
	),
}));

import { WorkspacesList } from "../WorkspacesList";

const frames = [
	{
		frameId: "frame-1",
		title: "Delivery status",
		description: "Open work by status.",
		kind: "frame",
		surface: "workspace",
		shareScope: "WORKSPACE_AND_EMAILS",
		ownedByCaller: false,
		updatedAt: "2026-10-14T09:00:00.000Z",
	},
	{
		frameId: "frame-2",
		title: "Decisions board",
		kind: "frame",
		surface: "workspace",
		shareScope: "PRIVATE",
		ownedByCaller: true,
		updatedAt: "2026-10-13T09:00:00.000Z",
	},
];

type QueryState = {
	data?: unknown;
	isLoading?: boolean;
	isError?: boolean;
	refetch?: () => void;
};

function answerWith(state: QueryState) {
	const calls: Array<[string, unknown]> = [];
	mocks.useFabricToolQuery.mockImplementation(
		(name: string, args: unknown) => {
			calls.push([name, args]);
			return {
				data: undefined,
				isLoading: false,
				isError: false,
				refetch: vi.fn(),
				...state,
			};
		},
	);
	return calls;
}

beforeEach(() => {
	vi.clearAllMocks();
});

const renderPage = () =>
	render(<WorkspacesList organizationSlug="example-org" />);

describe("the Workspaces page", () => {
	it("asks for the organization's workspaces and tells Fabric Agent where the user is", () => {
		const calls = answerWith({ data: { frames } });

		renderPage();

		expect(calls).toContainEqual([
			"fabric_list_frames",
			{ surface: "workspace" },
		]);
		expect(mocks.registerContext).toHaveBeenCalledWith({
			surface: "workspace",
		});
	});

	it("names the page, links its tour and carries the tour's anchors", () => {
		answerWith({ data: { frames } });
		const { container } = renderPage();

		expect(
			screen.getByRole("heading", { name: "Workspaces", level: 1 }),
		).toBeInTheDocument();
		expect(screen.getByTestId("tour-button")).toHaveAttribute(
			"data-page-id",
			"workspaces",
		);
		expect(
			screen.getByRole("button", { name: "New workspace" }),
		).toHaveAttribute("data-onboarding-target", "workspaces-new");
		expect(
			container.querySelector(
				'[data-onboarding-target="workspaces-list"]',
			),
		).not.toBeNull();
	});

	it("lists each workspace as a link to its own page, with who it is shared with", () => {
		answerWith({ data: { frames } });

		renderPage();

		const cards = screen.getAllByRole("listitem");
		expect(cards).toHaveLength(2);
		const first = within(cards[0]).getByRole("link");
		expect(first).toHaveAttribute(
			"href",
			"/app/example-org/workspaces/frame-1",
		);
		expect(
			within(first).getByRole("heading", { name: "Delivery status" }),
		).toBeInTheDocument();
		expect(
			within(first).getByText("Open work by status."),
		).toBeInTheDocument();
		expect(within(first).getByText("Organization")).toBeInTheDocument();
		expect(within(cards[1]).getByText("Private")).toBeInTheDocument();
		expect(
			within(cards[1]).getByText("No description yet."),
		).toBeInTheDocument();
	});

	it("says a workspace is shared with the whole organization unless asked to stay private", () => {
		answerWith({ data: { frames } });
		const { unmount } = renderPage();
		expect(
			screen.getByText(
				/shared with everyone in it unless you ask for one to stay private/,
			),
		).toBeInTheDocument();
		unmount();

		answerWith({ data: { frames: [] } });
		renderPage();
		expect(
			screen.getByText(/shares it with your organization/),
		).toBeInTheDocument();
	});

	it("starts a new workspace by opening Fabric Agent with a draft to finish", () => {
		answerWith({ data: { frames } });

		renderPage();
		fireEvent.click(screen.getByRole("button", { name: "New workspace" }));

		expect(mocks.openLauncher).toHaveBeenCalledWith({
			surface: "workspace",
			prompt: expect.stringContaining("Create a new Workspace"),
		});
	});

	it("shows a loading state while the list is read", () => {
		answerWith({ isLoading: true });

		renderPage();

		expect(
			screen.getByRole("status", { name: "Loading workspaces" }),
		).toBeInTheDocument();
		expect(screen.queryByText("No workspaces yet")).toBeNull();
	});

	it("says so and offers a retry when the list cannot be read", () => {
		const refetch = vi.fn();
		answerWith({ isError: true, refetch });

		renderPage();

		expect(screen.getByRole("alert")).toHaveTextContent(
			"The workspaces could not be loaded.",
		);
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(refetch).toHaveBeenCalledTimes(1);
	});

	it("explains that the page is made by describing it when there is none yet", () => {
		answerWith({ data: { frames: [] } });

		renderPage();

		expect(screen.getByText("No workspaces yet")).toBeInTheDocument();
		expect(
			screen.getByText(/Describe the page you want/),
		).toBeInTheDocument();
		expect(screen.queryByRole("list")).toBeNull();
		const [heroButton, emptyStateButton] = screen.getAllByRole("button", {
			name: "New workspace",
		});
		fireEvent.click(emptyStateButton);
		fireEvent.click(heroButton);
		expect(mocks.openLauncher).toHaveBeenCalledTimes(2);
	});
});
