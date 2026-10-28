import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodingRunTimeline } from "../CodingRunTimeline";

const { mockGetCodingRun, mockSendFollowUp } = vi.hoisted(() => ({
	mockSendFollowUp: vi.fn(),
	mockGetCodingRun: vi.fn(async () => ({
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
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		codingRuns: {
			get: mockGetCodingRun,
			sendFollowUp: mockSendFollowUp,
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

beforeEach(() => {
	mockSendFollowUp.mockReset();
	sessionStorage.clear();
});

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

	it("renders Open in Fabric Agents deep link and backend badge for BACKGROUND_AGENTS runs", async () => {
		mockGetCodingRun.mockResolvedValueOnce({
			id: "run_2",
			status: "RUNNING",
			executionChannel: "BACKGROUND_AGENTS",
			provider: "BACKGROUND_AGENTS",
			externalUrl:
				"fabricagents://workspace/example-desktop-workspace/allSessions/session/sess_99",
			externalStatus: "session_created",
			providerSessionId: "sess_99",
			pullRequestUrl: null,
			pullRequestNumber: null,
			pullRequestBranch: null,
			repositoryOwner: "acme",
			repositoryName: "fabric",
			targetBranch: "main",
			workingDirectory: "/tmp/worktree/sess_99",
			providerMetadata: {
				workspaceId: "ws_1",
				worktreePath: "/tmp/worktree/sess_99",
				branch: "feat/us-1",
				llmConnection: "claude-max",
			},
			storyTask: null,
			events: [],
		} as any);

		renderWithQueryClient(
			<CodingRunTimeline codingRunId="run_2" organizationId="org_1" />,
		);

		const openLink = await screen.findByRole("link", {
			name: /Open in Fabric Agents/i,
		});
		expect(openLink).toHaveAttribute(
			"href",
			"fabricagents://workspace/example-desktop-workspace/allSessions/session/sess_99",
		);
		expect(screen.getByText("Claude Max")).toBeInTheDocument();
		expect(screen.getByText("1. Worktree & session")).toBeInTheDocument();
		expect(screen.getByText("2. Implementing task")).toBeInTheDocument();
		expect(screen.getByText("/tmp/worktree/sess_99")).toBeInTheDocument();
	});

	it("surfaces execution failure details when a coding run fails", async () => {
		mockGetCodingRun.mockResolvedValueOnce({
			id: "run_3",
			status: "FAILED",
			executionChannel: "BACKGROUND_AGENTS",
			provider: "BACKGROUND_AGENTS",
			externalUrl:
				"fabric-agent://ws/my-workspace/allSessions/session/sess_100",
			externalStatus: "failed",
			providerSessionId: "sess_100",
			pullRequestUrl: null,
			pullRequestNumber: null,
			pullRequestBranch: null,
			repositoryOwner: "acme",
			repositoryName: "fabric",
			targetBranch: "main",
			workingDirectory: "/tmp/worktree/sess_100",
			providerMetadata: {
				workspaceId: "ws_1",
				worktreePath: "/tmp/worktree/sess_100",
				branch: "feat/us-2",
				llmConnection: "cursor-cli",
			},
			storyTask: null,
			events: [
				{
					id: "evt_1",
					eventType: "workflow_failed",
					payload: {
						error: "Base branch release/2026.10 was not found in repository acme/fabric",
					},
					createdAt: new Date().toISOString(),
				},
			],
		} as any);

		renderWithQueryClient(
			<CodingRunTimeline codingRunId="run_3" organizationId="org_1" />,
		);

		expect(
			await screen.findByText("Execution failure details"),
		).toBeInTheDocument();
		expect(
			screen.getAllByText(
				/Base branch release\/2026\.10 was not found in repository acme\/fabric/i,
			).length,
		).toBeGreaterThan(0);
		expect(screen.getByText("Cursor")).toBeInTheDocument();
	});
});

it("keeps the draft and request identity when a follow-up needs a retry", async () => {
	const base = await mockGetCodingRun();
	await mockGetCodingRun.withImplementation(
		async () => ({
			...base,
			provider: "BACKGROUND_AGENTS",
			status: "AWAITING_REVIEW",
		}),
		async () => {
			mockSendFollowUp
				.mockRejectedValueOnce(new Error("Connection interrupted"))
				.mockResolvedValueOnce({
					sent: true,
					messageId: "example-message",
				});
			renderWithQueryClient(
				<CodingRunTimeline
					codingRunId="example-retry-run"
					organizationId="example-org"
				/>,
			);
			const draft = await screen.findByPlaceholderText(
				"Reply to the agent…",
			);
			fireEvent.change(draft, {
				target: { value: "Continue the implementation" },
			});
			fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
			await waitFor(() =>
				expect(mockSendFollowUp).toHaveBeenCalledTimes(1),
			);
			await waitFor(() =>
				expect(
					screen.getByRole("button", { name: "Send reply" }),
				).not.toBeDisabled(),
			);
			expect(draft).toHaveValue("Continue the implementation");
			fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
			await waitFor(() =>
				expect(mockSendFollowUp).toHaveBeenCalledTimes(2),
			);
			expect(mockSendFollowUp.mock.calls[0][0].promptId).toBe(
				mockSendFollowUp.mock.calls[1][0].promptId,
			);
			await waitFor(() => expect(draft).toHaveValue(""));
		},
	);
});

it("does not guess a desktop or legacy HTTP link for a headless session", async () => {
	const base = await mockGetCodingRun();
	vi.stubEnv("NEXT_PUBLIC_BACKGROUND_AGENTS_URL", "https://example.com");
	try {
		await mockGetCodingRun.withImplementation(
			async () => ({
				...base,
				provider: "BACKGROUND_AGENTS",
				externalUrl: null,
			}),
			async () => {
				renderWithQueryClient(
					<CodingRunTimeline
						codingRunId="example-headless-run"
						organizationId="example-org"
					/>,
				);
				await screen.findByText("Primary task focus");
				expect(
					screen.queryByRole("link", {
						name: /Open in Fabric Agents/,
					}),
				).not.toBeInTheDocument();
			},
		);
	} finally {
		vi.unstubAllEnvs();
	}
});

it("retains the unresolved prompt identity after the dialog unmounts and reopens", async () => {
	const base = await mockGetCodingRun();
	await mockGetCodingRun.withImplementation(
		async () => ({
			...base,
			provider: "BACKGROUND_AGENTS",
			status: "AWAITING_REVIEW",
		}),
		async () => {
			mockSendFollowUp
				.mockRejectedValueOnce(new Error("Response lost"))
				.mockResolvedValueOnce({ sent: true });
			const first = renderWithQueryClient(
				<CodingRunTimeline
					codingRunId="example-remount-run"
					organizationId="example-org"
				/>,
			);
			fireEvent.change(
				await screen.findByPlaceholderText("Reply to the agent…"),
				{ target: { value: "Continue" } },
			);
			fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
			await waitFor(() =>
				expect(mockSendFollowUp).toHaveBeenCalledTimes(1),
			);
			await waitFor(() =>
				expect(
					screen.getByRole("button", { name: "Send reply" }),
				).not.toBeDisabled(),
			);
			const requestId = mockSendFollowUp.mock.calls[0][0].promptId;
			first.unmount();
			renderWithQueryClient(
				<CodingRunTimeline
					codingRunId="example-remount-run"
					organizationId="example-org"
				/>,
			);
			fireEvent.change(
				await screen.findByPlaceholderText("Reply to the agent…"),
				{ target: { value: "Continue" } },
			);
			fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
			await waitFor(() =>
				expect(mockSendFollowUp).toHaveBeenCalledTimes(2),
			);
			expect(mockSendFollowUp.mock.calls[1][0].promptId).toBe(requestId);
			await waitFor(() =>
				expect(
					sessionStorage.getItem("coding-prompt:example-remount-run"),
				).toBeNull(),
			);
		},
	);
});
