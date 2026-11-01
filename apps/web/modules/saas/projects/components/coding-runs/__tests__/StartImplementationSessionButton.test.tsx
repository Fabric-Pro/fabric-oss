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
				list: { queryKey: () => ["example-list"] },
				get: { queryKey: () => ["example-story"] },
			},
		},
	},
}));
it("submits the selected task repository through the real parent mutation when the project has no repository", async () => {
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
				repositoryUrl: "https://github.com/example-org/example-repo",
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
	expect(
		screen.getByRole("button", { name: "Start implementation session" }),
	).toBeDisabled();
	fireEvent.change(screen.getByRole("combobox", { name: "title" }), {
		target: { value: "example-team" },
	});
	fireEvent.click(
		screen.getByRole("button", { name: "Start implementation session" }),
	);
	await waitFor(() =>
		expect(f.start).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "example-project",
				storyId: "example-story",
				taskId: "example-task",
				organizationId: "example-org",
				serverId: "example-team",
			}),
		),
	);
	await waitFor(() => expect(onStarted).toHaveBeenCalledWith("example-run"));
});
