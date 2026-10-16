/**
 * The project's Artifacts tab: the pages Fabric Agent wrote for the project,
 * read through the same tools an agent calls (`fabric_list_frames`,
 * `fabric_get_frame`). The tool client, the viewer shell and the agent launcher
 * are replaced; what is under test is what the tab asks for and how it behaves
 * on each answer.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	useFabricToolQuery: vi.fn(),
	openLauncher: vi.fn(),
	shellProps: [] as Array<Record<string, unknown>>,
	isGuest: { value: false },
}));

vi.mock("@saas/mcp/lib/fabric-tool-client", () => ({
	useFabricToolQuery: mocks.useFabricToolQuery,
}));

vi.mock("@saas/organizations/hooks/use-is-guest-in-org", () => ({
	useIsGuestInOrg: () => mocks.isGuest.value,
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationId: () => "org-1",
	useOrganizationSlug: () => "context-org",
}));

vi.mock("@saas/agents/components/FabricAgentLauncher", () => ({
	useOptionalFabricAgentLauncher: () => ({
		openLauncher: mocks.openLauncher,
	}),
}));

vi.mock("@saas/get-started/components/PageTourButton", () => ({
	PageTourButton: ({ pageId }: { pageId: string }) => (
		<span data-testid="tour-button" data-page-id={pageId} />
	),
}));

vi.mock("@saas/frames/components/FrameVizShell", () => ({
	FrameVizShell: (props: Record<string, unknown>) => {
		mocks.shellProps.push(props);
		return <div data-testid="frame-shell">{String(props.title)}</div>;
	},
}));

import { ProjectArtifactsList } from "../ProjectArtifactsList";

const PROJECT = "project-1";

const frames = [
	{
		frameId: "frame-1",
		title: "Delivery status",
		description: "Open work by status, with a refresh button.",
		kind: "frame",
		surface: "artifact",
		projectId: PROJECT,
		updatedAt: "2026-10-14T09:00:00.000Z",
	},
	{
		frameId: "frame-2",
		title: "Release readiness",
		kind: "frame",
		updatedAt: "2026-10-13T09:00:00.000Z",
	},
];

type QueryState = {
	data?: unknown;
	isLoading?: boolean;
	isError?: boolean;
	refetch?: () => void;
};

function answerWith(
	byTool: Record<string, QueryState>,
	calls: Array<[string, unknown]> = [],
) {
	mocks.useFabricToolQuery.mockImplementation(
		(name: string, args: unknown) => {
			calls.push([name, args]);
			return {
				data: undefined,
				isLoading: false,
				isError: false,
				refetch: vi.fn(),
				...byTool[name],
			};
		},
	);
	return calls;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.shellProps.length = 0;
	mocks.isGuest.value = false;
});

function renderTab() {
	return render(
		<ProjectArtifactsList
			projectId={PROJECT}
			projectName="Example project"
			organizationSlug="example-org"
		/>,
	);
}

describe("the Artifacts tab", () => {
	it("asks for this project's artifacts and nothing else", () => {
		const calls = answerWith({ fabric_list_frames: { data: { frames } } });

		renderTab();

		expect(calls).toContainEqual([
			"fabric_list_frames",
			{ projectId: PROJECT, surface: "artifact" },
		]);
	});

	it("names the page, links its tour, and carries the tour's anchors", () => {
		answerWith({ fabric_list_frames: { data: { frames } } });
		const { container } = renderTab();

		expect(
			screen.getByRole("heading", { name: "Artifacts", level: 2 }),
		).toHaveAttribute("data-onboarding-target", "artifacts-header");
		expect(screen.getByTestId("tour-button")).toHaveAttribute(
			"data-page-id",
			"artifacts",
		);
		expect(
			screen.getByRole("button", { name: "Ask Fabric Agent" }),
		).toHaveAttribute("data-onboarding-target", "artifacts-ask");
		expect(
			container.querySelector(
				'[data-onboarding-target="artifacts-list"]',
			),
		).not.toBeNull();
	});

	it("shows a loading state while the list is read", () => {
		answerWith({ fabric_list_frames: { isLoading: true } });

		renderTab();

		expect(
			screen.getByRole("status", { name: "Loading artifacts" }),
		).toBeInTheDocument();
		expect(screen.queryByText("No artifacts yet")).toBeNull();
	});

	it("says so and offers a retry when the list cannot be read", () => {
		const refetch = vi.fn();
		answerWith({ fabric_list_frames: { isError: true, refetch } });

		renderTab();

		expect(screen.getByRole("alert")).toHaveTextContent(
			"The artifacts could not be loaded.",
		);
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(refetch).toHaveBeenCalledTimes(1);
	});

	it("tells the user to ask Fabric Agent when there is nothing yet", () => {
		answerWith({ fabric_list_frames: { data: { frames: [] } } });

		renderTab();

		expect(screen.getByText("No artifacts yet")).toBeInTheDocument();
		expect(
			screen.getByText(
				/Ask Fabric Agent to build a page for this project/,
			),
		).toBeInTheDocument();
		expect(screen.queryByRole("list")).toBeNull();
	});

	it("starts a conversation about an artifact from where the user is, with a draft to send", () => {
		answerWith({ fabric_list_frames: { data: { frames: [] } } });

		renderTab();
		const [headerAsk, emptyStateAsk] = screen.getAllByRole("button", {
			name: "Ask Fabric Agent",
		});
		fireEvent.click(emptyStateAsk);
		fireEvent.click(headerAsk);

		expect(mocks.openLauncher).toHaveBeenCalledTimes(2);
		expect(mocks.openLauncher).toHaveBeenCalledWith({
			projectId: PROJECT,
			projectName: "Example project",
			surface: "artifact",
			prompt: expect.stringContaining("Build a page for this project"),
		});
	});

	it("lists each artifact as a card with its title and what it shows", () => {
		answerWith({ fabric_list_frames: { data: { frames } } });

		renderTab();

		const cards = screen.getAllByRole("listitem");
		expect(cards).toHaveLength(2);
		expect(
			within(cards[0]).getByRole("button", { name: /Delivery status/ }),
		).toBeInTheDocument();
		expect(within(cards[0]).queryByRole("heading")).toBeNull();
		expect(
			within(cards[0]).getByText(
				"Open work by status, with a refresh button.",
			),
		).toBeInTheDocument();
		expect(
			within(cards[1]).getByText("No description yet."),
		).toBeInTheDocument();
	});
});

describe("the Artifacts tab for a guest of the project", () => {
	it("says the list is kept for members of the organization, instead of showing an error", () => {
		answerWith({ fabric_list_frames: { isError: true } });
		mocks.isGuest.value = true;

		renderTab();

		expect(screen.getByTestId("artifacts-guest-notice")).toHaveTextContent(
			/guest of this project.*members of the organization/,
		);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryByText("No artifacts yet")).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Ask Fabric Agent" }),
		).toBeNull();
	});

	it("does not ask for the list at all", () => {
		answerWith({});
		mocks.isGuest.value = true;

		renderTab();

		expect(mocks.useFabricToolQuery).toHaveBeenCalledWith(
			"fabric_list_frames",
			{ projectId: PROJECT, surface: "artifact" },
			expect.objectContaining({ enabled: false }),
		);
	});

	it("keeps the tab's name and tour", () => {
		answerWith({});
		mocks.isGuest.value = true;

		renderTab();

		expect(
			screen.getByRole("heading", { name: "Artifacts", level: 2 }),
		).toBeInTheDocument();
		expect(screen.getByTestId("tour-button")).toBeInTheDocument();
	});

	it("asks for the list, with the answer checked, for a member", () => {
		answerWith({ fabric_list_frames: { data: { frames } } });

		renderTab();

		expect(mocks.useFabricToolQuery).toHaveBeenCalledWith(
			"fabric_list_frames",
			{ projectId: PROJECT, surface: "artifact" },
			expect.objectContaining({
				enabled: true,
				schema: expect.anything(),
			}),
		);
	});
});

describe("opening an artifact", () => {
	function openFirst() {
		const calls = answerWith({
			fabric_list_frames: { data: { frames } },
			fabric_get_frame: {
				data: {
					frameId: "frame-1",
					title: "Delivery status",
					description: "Open work by status.",
					kind: "frame",
					surface: "artifact",
					projectId: PROJECT,
					blocks: [
						{ id: "page", type: "html", content: "<p>page</p>" },
					],
					runtimeTools: ["fabric_list_workflows"],
					shareUrl: undefined,
				},
			},
		});
		renderTab();
		fireEvent.click(
			screen.getByRole("button", { name: /Delivery status/ }),
		);
		return calls;
	}

	it("reads the artifact through the get tool and shows it in the viewer", () => {
		const calls = openFirst();

		expect(calls).toContainEqual([
			"fabric_get_frame",
			{ frameId: "frame-1" },
		]);
		expect(screen.getByTestId("frame-shell")).toHaveTextContent(
			"Delivery status",
		);
	});

	it("frames it inside the organization's own routes, with the tools the page declared", () => {
		openFirst();

		const props = mocks.shellProps.at(-1);
		expect(props).toMatchObject({
			surface: "artifact",
			frameId: "frame-1",
			embedUrl: "/app/example-org/frames/frame-1/embed",
			runtimeTools: ["fabric_list_workflows"],
			organizationId: "org-1",
			isProjectFrame: true,
			frameDocument: {
				kind: "frame",
				title: "Delivery status",
				blocks: [{ id: "page", type: "html" }],
			},
		});
	});

	it("opens Fabric Agent about this artifact when the page asks, or when the user does", () => {
		openFirst();
		const props = mocks.shellProps.at(-1) as {
			onOpenAgent: (prompt: string) => void;
		};

		props.onOpenAgent("Explain this");
		fireEvent.click(
			screen.getByRole("button", { name: "Change with Fabric Agent" }),
		);

		expect(mocks.openLauncher).toHaveBeenNthCalledWith(1, {
			projectId: PROJECT,
			projectName: "Example project",
			surface: "artifact",
			prompt: "Explain this",
		});
		expect(mocks.openLauncher).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				surface: "artifact",
				prompt: expect.stringContaining("frame id frame-1"),
			}),
		);
	});

	it("takes the organization's slug from the page when the tab is not given one", () => {
		answerWith({
			fabric_list_frames: { data: { frames } },
			fabric_get_frame: {
				data: {
					frameId: "frame-1",
					title: "Delivery status",
					kind: "frame",
					blocks: [],
					runtimeTools: [],
				},
			},
		});
		render(<ProjectArtifactsList projectId={PROJECT} />);

		fireEvent.click(
			screen.getByRole("button", { name: /Delivery status/ }),
		);

		expect(mocks.shellProps.at(-1)).toMatchObject({
			embedUrl: "/app/context-org/frames/frame-1/embed",
		});
	});

	it("goes back to the list", () => {
		openFirst();

		fireEvent.click(screen.getByRole("button", { name: "All artifacts" }));

		expect(screen.queryByTestId("frame-shell")).toBeNull();
		expect(screen.getAllByRole("listitem")).toHaveLength(2);
	});

	it("says so when the artifact is gone", () => {
		answerWith({
			fabric_list_frames: { data: { frames } },
			fabric_get_frame: { isError: true },
		});
		renderTab();

		fireEvent.click(
			screen.getByRole("button", { name: /Delivery status/ }),
		);

		expect(screen.getByRole("alert")).toHaveTextContent(
			"This artifact is no longer available.",
		);
		expect(screen.queryByTestId("frame-shell")).toBeNull();
	});

	it("shows a loading state while the artifact is read", () => {
		answerWith({
			fabric_list_frames: { data: { frames } },
			fabric_get_frame: { isLoading: true },
		});
		renderTab();

		fireEvent.click(
			screen.getByRole("button", { name: /Delivery status/ }),
		);

		expect(
			screen.getByRole("status", { name: "Loading artifact" }),
		).toBeInTheDocument();
	});
});
