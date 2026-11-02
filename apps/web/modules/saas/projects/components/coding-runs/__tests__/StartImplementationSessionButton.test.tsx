import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { UserStory } from "../../../lib/stories/types";
import { StartImplementationSessionButton } from "../StartImplementationSessionButton";

const f = vi.hoisted(() => ({
	start: vi.fn().mockResolvedValue({ codingRunId: "example-run" }),
	list: vi.fn().mockResolvedValue({
		enabled: true,
		canShare: false,
		servers: [
			{
				id: "example-private",
				name: "My server",
				scope: "PRIVATE",
				url: "https://private.example.com",
				ownedByCaller: true,
			},
			{
				id: "example-team",
				name: "Team server",
				scope: "TEAM",
				url: "https://team.example.com",
				ownedByCaller: false,
			},
		],
	}),
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: "example-org" }),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		codingRuns: { start: f.start, remoteServers: { list: f.list } },
	},
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			stories: {
				board: { queryKey: () => ["example-list"] },
				get: { queryKey: () => ["example-story"] },
			},
		},
	},
}));
it.each([false, true])(
	"starts with a registered server or configured deployment default: %s",
	async (hasDefaultServer) => {
		f.start.mockClear();
		f.list.mockResolvedValueOnce({ ...(await f.list()), hasDefaultServer });
		const story = {
			id: "example-story",
			identifier: "EXAMPLE-1",
			title: "Example feature",
			description: "Synthetic feature",
			tasks: [
				{
					id: "example-task",
					identifier: "EXAMPLE-2",
					title: "Example task",
					isCompleted: false,
					order: 0,
					repositoryOwner: "example-org",
					repositoryName: "example-repo",
					repositoryUrl:
						"https://github.com/example-org/example-repo",
					targetBranch: "main",
					latestCodingRun: null,
				},
			],
		} as unknown as UserStory;
		const onStarted = vi.fn();
		const client = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		});
		render(
			<QueryClientProvider client={client}>
				<StartImplementationSessionButton
					projectId="example-project"
					story={story}
					open
					hideTrigger
					focusedTaskId="example-task"
					initialExecutionProvider="BACKGROUND_AGENTS"
					onStarted={onStarted}
				/>
			</QueryClientProvider>,
		);
		await screen.findByRole("option", { name: "Team server" });
		if (!hasDefaultServer) {
			expect(
				screen.getByRole("button", {
					name: "Start implementation session",
				}),
			).toBeDisabled();
			fireEvent.change(screen.getByRole("combobox", { name: "title" }), {
				target: { value: "example-team" },
			});
			expect(
				screen.getByRole("link", { name: "openServer" }),
			).toHaveAttribute("href", "https://team.example.com");
			expect(
				screen.getByRole("link", { name: "openServer" }),
			).toHaveAttribute("rel", "noopener noreferrer");
		} else {
			expect(
				screen.getByRole("option", { name: "Deployment server" }),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", {
					name: "Start implementation session",
				}),
			).toBeEnabled();
		}
		fireEvent.click(
			screen.getByRole("button", {
				name: "Start implementation session",
			}),
		);
		await waitFor(() =>
			expect(f.start).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "example-project",
					storyId: "example-story",
					taskId: "example-task",
					organizationId: "example-org",
					...(hasDefaultServer ? {} : { serverId: "example-team" }),
				}),
			),
		);
		if (hasDefaultServer) {
			expect(f.start.mock.calls[0][0]).not.toHaveProperty("serverId");
		}
		await waitFor(() =>
			expect(onStarted).toHaveBeenCalledWith("example-run"),
		);
	},
);

it("loads saved Codex and model preferences before opening Start and sends them to the API", async () => {
	const {
		saveProjectDelegationPreferences,
		DEFAULT_PROJECT_DELEGATION_PREFERENCES,
	} = await import("../../../lib/implementation-session-labels");
	saveProjectDelegationPreferences("example-project", {
		...DEFAULT_PROJECT_DELEGATION_PREFERENCES,
		defaultConnection: "codex",
		defaultModel: "gpt-6-sol",
		fallbackPolicy: "org_paid_api",
		preferredServerScope: "TEAM",
	});
	f.start.mockClear();
	f.list.mockResolvedValueOnce({
		...(await f.list()),
		hasDefaultServer: true,
	});
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<StartImplementationSessionButton
				projectId="example-project"
				story={
					{
						id: "example-story",
						identifier: "EXAMPLE-1",
						title: "Example",
						tasks: [],
					} as unknown as UserStory
				}
				repositoryOwner="example-org"
				repositoryName="example-repo"
				initialExecutionProvider="BACKGROUND_AGENTS"
			/>
		</QueryClientProvider>,
	);
	fireEvent.click(
		screen.getByRole("button", { name: "Start Implementation Session" }),
	);
	expect(await screen.findByLabelText("Agent backend")).toHaveValue("codex");
	expect(screen.getByLabelText("Agent model")).toHaveValue("gpt-6-sol");
	expect(screen.getByDisplayValue("org_paid_api")).toBeChecked();
	await waitFor(() =>
		expect(
			screen.getByRole("button", {
				name: "Start implementation session",
			}),
		).toBeEnabled(),
	);
	fireEvent.click(
		screen.getByRole("button", { name: "Start implementation session" }),
	);
	await waitFor(() =>
		expect(f.start).toHaveBeenCalledWith(
			expect.objectContaining({
				llmConnection: "codex",
				model: "gpt-6-sol",
			}),
		),
	);
	localStorage.clear();
});
