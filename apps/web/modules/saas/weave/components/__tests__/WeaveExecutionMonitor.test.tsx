import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WeaveExecutionMonitor } from "../WeaveExecutionMonitor";

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: null }),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		weave: {
			executions: {
				get: vi.fn(),
				autoApproveAll: vi.fn(),
				cancel: vi.fn(),
			},
		},
	},
}));

vi.mock("../CheckpointReviewModal", () => ({
	CheckpointReviewModal: () => null,
}));

import { orpcClient } from "@shared/lib/orpc-client";

const mockGetExecution = orpcClient.weave.executions.get as ReturnType<
	typeof vi.fn
>;
const mockCancel = orpcClient.weave.executions.cancel as ReturnType<
	typeof vi.fn
>;

function renderMonitor() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});

	return render(
		<QueryClientProvider client={client}>
			<WeaveExecutionMonitor projectId="project_1" executionId="exec_1" />
		</QueryClientProvider>,
	);
}

describe("WeaveExecutionMonitor", () => {
	beforeEach(() => {
		class MockEventSource {
			addEventListener() {}
			close() {}
		}
		vi.stubGlobal("EventSource", MockEventSource);
		mockGetExecution.mockResolvedValue({
			id: "exec_1",
			workflowId: "workflow_1",
			runId: "run_1",
			status: "RUNNING",
			currentStep: 1,
			checkboxes: [],
			artifacts: null,
			error: null,
			sandboxSessionId: null,
			workflowStatus: null,
			checkpoint: null,
			plan: { checkboxes: [] },
			implementationSession: {
				id: "coding_run_1",
				status: "RUNNING",
				executionChannel: "WORKSPACE_AGENTS",
				provider: "VIBE_WORKSPACE",
				providerSessionId: "session_1",
				providerMetadata: {},
				externalUrl: "http://127.0.0.1:4242/workspaces/ws_1",
				externalStatus: "awaiting_review",
				workingDirectory: "/tmp/workspace/fabric",
				targetBranch: "main",
				pullRequestUrl: "https://github.com/acme/fabric/pull/12",
				repositoryOwner: "acme",
				repositoryName: "fabric",
				createdAt: new Date("2026-03-27T05:00:00.000Z"),
			},
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("shows implementation-session handoff metadata for Weave-triggered execution", async () => {
		renderMonitor();

		await waitFor(() => {
			expect(
				screen.getByText("Implementation Session Handoff"),
			).toBeInTheDocument();
		});

		expect(
			screen.getByText(/remote execution through Background Agents/i),
		).toBeInTheDocument();
		expect(
			screen.getByText(/Runtime: awaiting_review/i),
		).toBeInTheDocument();
		expect(
			screen.getByText(/Repo root: \/tmp\/workspace\/fabric/i),
		).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: /Open runtime/i }),
		).toHaveAttribute("href", "http://127.0.0.1:4242/workspaces/ws_1");
	});

	it("offers a Cancel run button for a running execution and cancels through the confirm dialog", async () => {
		mockCancel.mockResolvedValue({ success: true });
		renderMonitor();

		// The trigger button in the header.
		const trigger = await screen.findByRole("button", {
			name: /Cancel run/i,
		});
		fireEvent.click(trigger);

		// Confirm in the dialog (the destructive action, also labelled "Cancel run").
		const confirm = await screen.findByText("Cancel this run?");
		expect(confirm).toBeInTheDocument();
		const actions = screen.getAllByRole("button", { name: /Cancel run/i });
		// the dialog's confirm action is the last "Cancel run" button
		fireEvent.click(actions[actions.length - 1]);

		await waitFor(() =>
			expect(mockCancel).toHaveBeenCalledWith({
				executionId: "exec_1",
				organizationId: null,
			}),
		);
	});

	it("does not offer Cancel run for a terminal execution", async () => {
		mockGetExecution.mockResolvedValue({
			id: "exec_done",
			workflowId: "workflow_1",
			runId: "run_1",
			status: "COMPLETED",
			currentStep: 1,
			checkboxes: [],
			artifacts: null,
			error: null,
			sandboxSessionId: null,
			workflowStatus: null,
			checkpoint: null,
			plan: { checkboxes: [] },
		});
		renderMonitor();

		await waitFor(() =>
			expect(screen.getByText("COMPLETED")).toBeInTheDocument(),
		);
		expect(
			screen.queryByRole("button", { name: /Cancel run/i }),
		).not.toBeInTheDocument();
	});
});
