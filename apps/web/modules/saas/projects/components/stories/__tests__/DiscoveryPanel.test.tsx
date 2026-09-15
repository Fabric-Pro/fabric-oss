import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		runsList: vi.fn(),
		commentsList: vi.fn(),
		projectGet: vi.fn(),
		markContractComplete: vi.fn(),
		cancel: vi.fn(),
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		basePath: "/app/acme",
	}),
}));

vi.mock("../../../../../shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			discovery: {
				markContractComplete: mocks.markContractComplete,
				cancel: mocks.cancel,
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			discovery: {
				list: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["runs", input],
						queryFn: mocks.runsList,
					}),
					queryKey: ({ input }: { input: unknown }) => [
						"runs",
						input,
					],
				},
			},
			stories: {
				comments: {
					list: {
						queryOptions: ({ input }: { input: unknown }) => ({
							queryKey: ["comments", input],
							queryFn: mocks.commentsList,
						}),
					},
				},
			},
			documents: {
				list: {
					queryKey: ({ input }: { input: unknown }) => [
						"docs",
						input,
					],
				},
			},
			get: {
				queryOptions: ({ input }: { input: unknown }) => ({
					queryKey: ["project", input],
					queryFn: mocks.projectGet,
				}),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { DiscoveryPanel, selectDiscoveryQuestions } from "../DiscoveryPanel";

const contractReadyRun = {
	id: "run-1",
	status: "CONTRACT_READY",
	documentId: "doc-1",
	error: null,
	createdAt: new Date().toISOString(),
	document: {
		id: "doc-1",
		title: "Integration contract — F-007",
		status: "REVIEW",
		isActive: true,
	},
};

const comments = [
	{
		id: "c-1",
		content:
			"**Open question (discovery):** Which scopes are granted to service accounts? (blocking)\n\nWhy it matters: Background sync needs users:read.",
		metadata: { discoveryRunId: "run-1", index: 0, blocking: true },
		createdAt: new Date().toISOString(),
	},
	{
		id: "c-2",
		content:
			"**Open question (discovery):** Is the refresh token lifetime configurable?\n\nWhy it matters: Affects session length.",
		metadata: { discoveryRunId: "run-1", index: 1, blocking: false },
		createdAt: new Date().toISOString(),
	},
	{
		id: "c-3",
		content: "A human comment that must not appear in the list",
		metadata: null,
		createdAt: new Date().toISOString(),
	},
];

function renderPanel(
	props: Partial<React.ComponentProps<typeof DiscoveryPanel>> = {},
) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>
			<DiscoveryPanel
				projectId="project_1"
				storyId="story_1"
				organizationId="org-1"
				deliveryTrack="DISCOVERY"
				{...props}
			/>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.runsList.mockResolvedValue({ runs: [contractReadyRun] });
	mocks.commentsList.mockResolvedValue({ comments });
	mocks.projectGet.mockResolvedValue({ id: "project_1", userRole: "viewer" });
	mocks.markContractComplete.mockResolvedValue({
		documentId: "doc-1",
		storyId: "story_1",
		status: "COMPLETE",
		completedRunIds: ["run-1"],
	});
});

describe("selectDiscoveryQuestions", () => {
	it("keeps only comments posted by the given run", () => {
		const selected = selectDiscoveryQuestions(comments, "run-1");
		expect(selected.map((c) => c.id)).toEqual(["c-1", "c-2"]);
		expect(selected[0].blocking).toBe(true);
		expect(selected[1].blocking).toBe(false);
		expect(selectDiscoveryQuestions(comments, "run-other")).toEqual([]);
	});
});

describe("DiscoveryPanel", () => {
	it("renders nothing for non-DISCOVERY tracks", () => {
		const { container } = renderPanel({ deliveryTrack: "SPECIFY" });
		expect(container).toBeEmptyDOMElement();
		expect(mocks.runsList).not.toHaveBeenCalled();
	});

	it("shows the run status, the contract link and the open questions", async () => {
		renderPanel({ canEdit: false });
		await waitFor(() => {
			expect(
				screen.getByText("status.CONTRACT_READY"),
			).toBeInTheDocument();
		});
		const link = screen.getByRole("link", {
			name: /Integration contract — F-007/,
		});
		expect(link).toHaveAttribute(
			"href",
			"/app/acme/projects/project_1/documents/doc-1",
		);

		await waitFor(() => {
			expect(screen.getByText("panel.openQuestions")).toBeInTheDocument();
		});
		expect(
			screen.getByText("Which scopes are granted to service accounts?"),
		).toBeInTheDocument();
		expect(
			screen.getByText("Is the refresh token lifetime configurable?"),
		).toBeInTheDocument();
		expect(screen.queryByText(/human comment/)).not.toBeInTheDocument();
		expect(screen.getByText("panel.blocking")).toBeInTheDocument();
	});

	it("hides the sign-off button from viewers and shows it to editors", async () => {
		renderPanel({ canEdit: false });
		await waitFor(() => {
			expect(
				screen.getByText("status.CONTRACT_READY"),
			).toBeInTheDocument();
		});
		expect(
			screen.queryByRole("button", { name: /panel\.markComplete/ }),
		).not.toBeInTheDocument();

		const user = userEvent.setup();
		renderPanel({ canEdit: true });
		const button = await screen.findByRole("button", {
			name: /panel\.markComplete/,
		});
		await user.click(button);
		await waitFor(() => {
			expect(mocks.markContractComplete).toHaveBeenCalledWith({
				projectId: "project_1",
				documentId: "doc-1",
				organizationId: "org-1",
			});
		});
	});

	it("derives edit rights from the project role when canEdit is omitted", async () => {
		mocks.projectGet.mockResolvedValue({
			id: "project_1",
			userRole: "editor",
		});
		renderPanel();
		expect(
			await screen.findByRole("button", { name: /panel\.markComplete/ }),
		).toBeInTheDocument();
	});

	it("does not offer sign-off once the contract is complete", async () => {
		mocks.runsList.mockResolvedValue({
			runs: [
				{
					...contractReadyRun,
					status: "COMPLETED",
					document: {
						...contractReadyRun.document,
						status: "COMPLETE",
					},
				},
			],
		});
		renderPanel({ canEdit: true });
		await waitFor(() => {
			expect(screen.getByText("status.COMPLETED")).toBeInTheDocument();
		});
		expect(
			screen.queryByRole("button", { name: /panel\.markComplete/ }),
		).not.toBeInTheDocument();
	});
});
