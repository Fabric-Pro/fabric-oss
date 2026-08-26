import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodingRunTimeline } from "../CodingRunTimeline";

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		codingRuns: {
			get: vi.fn(async () => ({
				id: "run_1",
				status: "RUNNING",
				executionChannel: "WORKSPACE_AGENTS",
				provider: "VIBE_WORKSPACE",
				externalUrl:
					"http://127.0.0.1:4242/projects/proj_1/issues/issue_1/workspaces/ws_1",
				externalStatus: "workspace_linked_to_vibe_issue",
				providerSessionId: "session_1",
				pullRequestUrl: null,
				pullRequestNumber: null,
				pullRequestBranch: null,
				repositoryOwner: "acme",
				repositoryName: "fabric",
				targetBranch: "main",
				workingDirectory: "/repo/fabric",
				providerMetadata: {
					remoteProjectId: "proj_1",
					remoteIssueId: "issue_1",
					issueLinkingStatus: "linked_remote_issue",
				},
				storyTask: {
					id: "task_1",
					identifier: "TASK-004",
					title: "Ship task-first focus styling",
				},
				events: [],
			})),
		},
	},
}));

function renderWithQueryClient(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

describe("CodingRunTimeline", () => {
	it("emphasizes the primary task for task-scoped implementation sessions", async () => {
		renderWithQueryClient(
			<CodingRunTimeline codingRunId="run_1" organizationId="org_1" />,
		);

		expect(
			await screen.findByText("Primary task focus"),
		).toBeInTheDocument();
		expect(
			screen.getByText("TASK-004 · Ship task-first focus styling"),
		).toBeInTheDocument();
	});
});
