import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	list: vi.fn(),
	get: vi.fn(),
	start: vi.fn(),
	cancel: vi.fn(),
	schedule: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { agentDeployments: { runs: api } },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AgentRunResult } from "../AgentRunResult";
import { AgentRunsPanel } from "../AgentRunsPanel";

const props = {
	instanceId: "example-agent",
	organizationId: "example-org",
	editHref: "/app/example-org/agents/example-agent/edit",
};
const row = {
	id: "example-execution",
	status: "COMPLETED",
	queuedAt: "2026-01-01T09:00:00Z",
	createdAt: "2026-01-01T09:00:00Z",
	completedAt: "2026-01-01T09:00:03Z",
	duration: 3000,
	error: null,
	triggerType: "MANUAL",
};
const detail = {
	executionId: row.id,
	status: "COMPLETED",
	output: {
		response: "# Delivery report\nThe example project is ready for review.",
	},
	executionStateSource: "temporal",
	nativeStateAvailable: true,
	nativeReadStatus: "AVAILABLE",
	lastRecordedStatus: "RUNNING",
	durationMs: 3000,
	queuedAt: row.queuedAt,
	startedAt: row.queuedAt,
	completedAt: row.completedAt,
	artifacts: [],
};
const clients: QueryClient[] = [];
function mount() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	clients.push(client);
	return render(
		<QueryClientProvider client={client}>
			<AgentRunsPanel {...props} />
		</QueryClientProvider>,
	);
}
beforeEach(() => {
	Object.values(api).forEach((fn) => fn.mockReset());
	api.list.mockResolvedValue({
		deployment: null,
		executions: [],
		schedule: null,
	});
	api.get.mockResolvedValue(detail);
	api.start.mockResolvedValue({ executionId: row.id });
	api.cancel.mockResolvedValue({
		requested: true,
		executionId: row.id,
		status: "RUNNING",
	});
	api.schedule.mockResolvedValue({ schedulingState: "ACTIVE" });
});
afterEach(() => {
	cleanup();
	clients.splice(0).forEach((client) => client.clear());
});

describe("saved agent run workspace", () => {
	it("puts the recorded answer before the new-task form and explains an empty task", async () => {
		api.list.mockResolvedValue({
			deployment: null,
			executions: [row],
			schedule: null,
		});
		mount();
		const answer = await screen.findByRole("heading", {
			name: "Delivery report",
		});
		const task = screen.getByRole("textbox", { name: "Task for this run" });
		expect(
			answer.compareDocumentPosition(task) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(task).toHaveAccessibleDescription(
			"Enter a task to enable Run agent. Your previous results stay available above.",
		);
		expect(task).toHaveValue("");
		expect(api.start).not.toHaveBeenCalled();
	});

	it("opening an empty agent creates no deployment or run and explains the next action", async () => {
		mount();
		await screen.findByText(
			"No runs yet. Start with a small task to check the result before scheduling this agent.",
		);
		expect(api.start).not.toHaveBeenCalled();
		expect(api.schedule).not.toHaveBeenCalled();
		expect(
			screen.getByRole("button", { name: "Run agent" }),
		).toBeDisabled();
		expect(
			screen.getByRole("link", { name: "Edit context & connections" }),
		).toHaveAttribute("href", props.editHref);
	});
	it("submits one explicit task with its organization and renders the authoritative result", async () => {
		mount();
		await screen.findByText(/No runs yet/);
		fireEvent.change(screen.getByLabelText("Task for this run"), {
			target: { value: "Write a delivery report" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Run agent" }));
		await screen.findByRole("heading", { name: "Delivery report" });
		expect(api.start).toHaveBeenCalledTimes(1);
		expect(api.start).toHaveBeenCalledWith(
			expect.objectContaining({
				instanceId: props.instanceId,
				organizationId: props.organizationId,
				input: { message: "Write a delivery report" },
				idempotencyKey: expect.any(String),
			}),
		);
		expect(screen.getByText(/Live execution/)).toBeInTheDocument();
	});
	it("keeps the request key after an ambiguous start error instead of automatically retrying", async () => {
		api.start
			.mockRejectedValueOnce(new Error("Response lost"))
			.mockResolvedValueOnce({ executionId: row.id });
		mount();
		await screen.findByText(/No runs yet/);
		fireEvent.change(screen.getByLabelText("Task for this run"), {
			target: { value: "Write a report" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Run agent" }));
		await screen.findByText("Could not confirm the run");
		expect(api.start).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: "Retry request" }));
		await screen.findByRole("heading", { name: "Delivery report" });
		expect(api.start.mock.calls[1][0]).toEqual(api.start.mock.calls[0][0]);
	});
	it("reports unavailable live status without falsely declaring the job stopped", async () => {
		api.list.mockResolvedValue({
			deployment: { id: "example-deployment", status: "ACTIVE" },
			executions: [{ ...row, status: "RUNNING" }],
			schedule: null,
		});
		api.get.mockResolvedValue({
			...detail,
			status: "UNKNOWN",
			nativeReadStatus: "UNAVAILABLE",
			executionStateSource: "database",
			output: null,
		});
		mount();
		await screen.findByText("Live status is unavailable");
		expect(
			screen.getByText(/This does not mean the run has stopped/),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Cancel run" }),
		).not.toBeInTheDocument();
	});
	it("confirms cancellation and keeps the real running status until the engine stops", async () => {
		api.list.mockResolvedValue({
			deployment: { id: "example-deployment", status: "ACTIVE" },
			executions: [{ ...row, status: "RUNNING" }],
			schedule: null,
		});
		api.get.mockResolvedValue({
			...detail,
			status: "RUNNING",
			output: null,
		});
		mount();
		fireEvent.click(
			await screen.findByRole("button", { name: "Cancel run" }),
		);
		expect(api.cancel).not.toHaveBeenCalled();
		fireEvent.click(
			screen.getByRole("button", { name: "Cancel run", hidden: false }),
		);
		await waitFor(() =>
			expect(api.cancel).toHaveBeenCalledWith({
				executionId: row.id,
				organizationId: props.organizationId,
			}),
		);
		expect(screen.queryByText("Cancelled")).not.toBeInTheDocument();
	});
	it("saves explicit schedule input, timezone and enabled state", async () => {
		mount();
		await screen.findByText(/No runs yet/);
		fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
		fireEvent.change(screen.getByLabelText("Scheduled task"), {
			target: { value: "Create the weekly report" },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Mondays at 9 AM" }),
		);
		fireEvent.change(screen.getByLabelText("Timezone"), {
			target: { value: "UTC" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
		await waitFor(() =>
			expect(api.schedule).toHaveBeenCalledWith({
				instanceId: props.instanceId,
				organizationId: props.organizationId,
				cronExpression: "0 9 * * 1",
				timezone: "UTC",
				input: { message: "Create the weekly report" },
				enabled: true,
			}),
		);
	});
	it("hides cached results after a permission failure", async () => {
		api.list.mockResolvedValue({
			deployment: null,
			executions: [row],
			schedule: null,
		});
		mount();
		await screen.findByRole("heading", { name: "Delivery report" });
		api.get.mockRejectedValue(new Error("Access revoked"));
		fireEvent.click(screen.getByRole("button", { name: "Refresh runs" }));
		await screen.findByText("Access revoked");
		expect(
			screen.queryByRole("heading", { name: "Delivery report" }),
		).not.toBeInTheDocument();
	});
});

describe("managed schedule controls", () => {
	it("preserves the stored task when pausing an existing schedule", async () => {
		api.list.mockResolvedValue({
			deployment: null,
			executions: [],
			schedulingState: "ACTIVE",
			schedule: {
				id: "example-schedule",
				enabled: true,
				cronExpression: "0 9 * * 1",
				timezone: "UTC",
				input: { message: "Keep this scheduled task" },
			},
		});
		mount();
		await screen.findByText("Scheduled");
		fireEvent.click(screen.getByRole("button", { name: "Edit schedule" }));
		fireEvent.click(
			screen.getByRole("switch", { name: "Schedule enabled" }),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Save paused schedule" }),
		);
		await waitFor(() =>
			expect(api.schedule).toHaveBeenCalledWith(
				expect.objectContaining({
					input: { message: "Keep this scheduled task" },
					enabled: false,
					timezone: "UTC",
					cronExpression: "0 9 * * 1",
				}),
			),
		);
	});
	it("labels an unconfirmed schedule and keeps the editor open if reconciliation fails", async () => {
		api.list.mockResolvedValue({
			deployment: null,
			executions: [],
			schedulingState: "UNKNOWN",
			schedule: {
				id: "example-schedule",
				enabled: true,
				cronExpression: "0 9 * * 1",
				timezone: "UTC",
				input: { message: "Example task" },
			},
		});
		api.schedule.mockRejectedValue(
			new Error(
				"Schedule configuration was saved, but its engine state is unconfirmed.",
			),
		);
		mount();
		await screen.findByText("Schedule state unconfirmed");
		fireEvent.click(screen.getByRole("button", { name: "Edit schedule" }));
		fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
		await screen.findByText(
			/Schedule configuration was saved, but its engine state is unconfirmed/,
		);
		expect(screen.getByLabelText("Agent schedule")).toBeInTheDocument();
	});
});

describe("execution output safety and clarity", () => {
	it("distinguishes a completed execution from an unmet goal in archived output", () => {
		render(
			<AgentRunResult
				status="COMPLETED"
				output={{
					goalAchieved: false,
					response: "Partial delivery report",
				}}
			/>,
		);
		expect(
			screen.getByText(
				"Goal not achieved. Review the result and recorded steps.",
			),
		).toBeInTheDocument();
		expect(screen.getByText("Partial delivery report")).toBeInTheDocument();
	});
	it("shows goal-loop tools and explicit inspection guidance without offering automatic reruns", () => {
		render(
			<AgentRunResult
				status="FAILED"
				output={{
					response: "Prior work retained",
					stepsExecuted: [
						{
							toolCalls: [
								{
									name: "example_tool",
									status: "error",
									result: { inspectionRequired: true },
								},
							],
						},
					],
				}}
			/>,
		);
		expect(
			screen.getByText("Check the external action before running again"),
		).toBeInTheDocument();
		expect(screen.getByText("example_tool")).toBeInTheDocument();
		expect(screen.getByText("Prior work retained")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /rerun/i }),
		).not.toBeInTheDocument();
	});
	it("does not turn unsafe artifact URLs or HTML into executable links", () => {
		render(
			<AgentRunResult
				status="COMPLETED"
				output={{ response: '<script>alert("example")</script>' }}
				artifacts={[
					{ name: "Example file", url: "javascript:alert(1)" },
				]}
			/>,
		);
		expect(
			screen.queryByRole("link", { name: "Example file" }),
		).not.toBeInTheDocument();
		expect(document.querySelector("script")).toBeNull();
	});
});

it("keeps completed envelope failures visible before opening saved goal-loop steps", () => {
	render(
		<AgentRunResult
			status="COMPLETED"
			output={{
				response: "Partial result",
				stepsExecuted: [
					{
						toolCalls: [
							{
								name: "example_read",
								status: "success",
								result: JSON.stringify({
									isError: true,
									content: [
										{
											type: "text",
											text: "Example access refused",
										},
									],
								}),
							},
						],
					},
				],
			}}
		/>,
	);
	expect(screen.getByText("toolFailuresTitle")).toBeVisible();
	expect(screen.getByText("toolFailed")).toBeVisible();
	expect(screen.getByText("Partial result")).toBeVisible();
});

it("distinguishes failed and unconfirmed live tool progress", () => {
	render(
		<AgentRunResult
			status="RUNNING"
			output={{}}
			progress={{
				completedToolCalls: [
					{ name: "example_failed", status: "error" },
					{ name: "example_pending", status: "pending" },
				],
			}}
		/>,
	);
	const progress = screen.getByRole("list", { name: "Tool progress" });
	expect(progress).toHaveTextContent("example_failed · toolFailed");
	expect(progress).toHaveTextContent(
		"example_pending · toolAwaitingConfirmation",
	);
	expect(progress).not.toHaveTextContent("toolCompleted");
});

it("uses the shared run answer renderer and preserves raw copied code", async () => {
	const writeText = vi.fn().mockResolvedValue(undefined);
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText },
	});
	const text =
		"### Example answer\n\n##### Next steps\n\n| Item | State |\n| --- | --- |\n| Example | Ready |\n\n```text\n• literal item\n1) literal instruction\n```";
	render(<AgentRunResult status="COMPLETED" output={{ response: text }} />);
	expect(
		screen.getByRole("heading", { name: "Example answer" }).tagName,
	).toBe("H2");
	expect(screen.getByRole("heading", { name: "Next steps" }).tagName).toBe(
		"H3",
	);
	expect(screen.getByRole("table")).toBeVisible();
	fireEvent.click(screen.getByRole("button", { name: "Copy result" }));
	await waitFor(() => expect(writeText).toHaveBeenCalledWith(text));
});

it.each([true, false])(
	"keeps explicit unconfirmed effects distinct from successful progress (nested=%s)",
	(nested) => {
		const tool = {
			name: "example_unconfirmed",
			status: "success",
			...(nested
				? { result: { inspectionRequired: true } }
				: { inspectionRequired: true }),
		};
		render(
			<AgentRunResult
				status="RUNNING"
				output={{}}
				progress={{ completedToolCalls: [tool] }}
			/>,
		);
		expect(
			screen.getByRole("list", { name: "Tool progress" }),
		).toHaveTextContent("toolNeedsInspection");
		expect(
			screen.getByText("Check the external action before running again"),
		).toBeVisible();
		expect(screen.queryByText("toolCompleted")).not.toBeInTheDocument();
	},
);

it.each([
	undefined,
	"recorded",
	"running",
	"failed",
	"cancelled",
	"skipped",
	"unknown",
])(
	"never guesses success from an absent or non-success tool outcome (%s)",
	(status) => {
		render(
			<AgentRunResult
				status="RUNNING"
				output={{}}
				progress={{
					completedToolCalls: [
						{
							name: "example_recorded",
							durationMs: 20,
							...(status ? { status } : {}),
						},
					],
				}}
			/>,
		);
		const progress = screen.getByRole("list", { name: "Tool progress" });
		expect(progress).not.toHaveTextContent("toolCompleted");
		expect(progress).toHaveTextContent(
			status === "running"
				? "toolRunning"
				: status === "failed"
					? "toolFailed"
					: status === "cancelled"
						? "toolCancelled"
						: status === "skipped"
							? "toolSkipped"
							: "toolRecorded",
		);
	},
);

it("shows a failed goal step with no tool calls before opening its raw details", () => {
	render(
		<AgentRunResult
			status="COMPLETED"
			output={{
				response: "Partial answer",
				stepsExecuted: [
					{
						id: "example-verification",
						type: "verification",
						description: "Verify the example release",
						status: "failed",
						error: "Example verification failed",
						toolCalls: [],
					},
				],
			}}
		/>,
	);
	expect(screen.getByText("toolFailuresTitle")).toBeVisible();
	expect(screen.getByText("Verify the example release")).toBeVisible();
	expect(screen.getByText("toolFailed")).toBeVisible();
});
