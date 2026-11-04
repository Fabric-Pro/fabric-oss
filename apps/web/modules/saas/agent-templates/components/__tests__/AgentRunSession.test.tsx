import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	search: vi.fn(),
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

import { AgentRunSession } from "../AgentRunSession";

const props = {
	organizationId: "example-org",
	instanceId: "example-agent",
	mode: "new" as const,
	editHref: "/app/example-org/agents/example-agent/edit",
	onStarted: vi.fn(),
	onBack: vi.fn(),
};
const detail = {
	executionId: "example-run",
	status: "COMPLETED",
	output: {
		response: "# Delivery report\nThe example project is ready for review.",
	},
	executionStateSource: "temporal",
	nativeStateAvailable: true,
	nativeReadStatus: "AVAILABLE",
	lastRecordedStatus: "RUNNING",
	durationMs: 3000,
	queuedAt: "2026-01-01T09:00:00Z",
	startedAt: "2026-01-01T09:00:00Z",
	completedAt: "2026-01-01T09:00:03Z",
	artifacts: [],
};
const clients: QueryClient[] = [];
function mount(overrides: Partial<Parameters<typeof AgentRunSession>[0]> = {}) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
			mutations: { retry: false },
		},
	});
	clients.push(client);
	return {
		...render(
			<QueryClientProvider client={client}>
				<AgentRunSession {...props} {...overrides} />
			</QueryClientProvider>,
		),
		client,
	};
}
beforeEach(() => {
	Object.values(api).forEach((fn) => {
		fn.mockReset();
	});
	props.onStarted.mockReset();
	props.onBack.mockReset();
	api.list.mockResolvedValue({
		executions: [],
		schedule: null,
		schedulingState: "ACTIVE",
		deployment: null,
	});
	api.get.mockResolvedValue(detail);
	api.start.mockResolvedValue({
		executionId: "example-run",
		status: "PENDING",
	});
	api.cancel.mockResolvedValue({ requested: true, status: "RUNNING" });
	api.schedule.mockResolvedValue({ schedulingState: "ACTIVE" });
});
afterEach(() => {
	cleanup();
	clients.splice(0).forEach((client) => {
		client.clear();
	});
});

describe("agent run session", () => {
	it("opens a new-task form without loading history, results or schedule or starting work", () => {
		mount();
		expect(
			screen.getByRole("button", { name: "Run agent" }),
		).toBeDisabled();
		expect(screen.getByLabelText("Task for this run")).toHaveValue("");
		for (const fn of Object.values(api)) {
			expect(fn).not.toHaveBeenCalled();
		}
		fireEvent.click(screen.getByRole("button", { name: "Back to runs" }));
		expect(props.onBack).toHaveBeenCalledOnce();
	});
	it("prefills a saved goal without executing it automatically", () => {
		mount({ goal: "Summarize delivery risks" });
		expect(screen.getByLabelText("Task for this run")).toHaveValue(
			"Summarize delivery risks",
		);
		expect(screen.getByRole("button", { name: "Run agent" })).toBeEnabled();
		expect(api.start).not.toHaveBeenCalled();
	});
	it("requires an explicit nonblank task and sends trimmed text with the correct owner context", async () => {
		mount();
		const field = screen.getByLabelText("Task for this run");
		fireEvent.change(field, { target: { value: "   " } });
		fireEvent.submit(screen.getByRole("form", { name: "Start agent run" }));
		expect(api.start).not.toHaveBeenCalled();
		fireEvent.change(field, {
			target: { value: "  Write a delivery report  " },
		});
		fireEvent.click(screen.getByRole("button", { name: "Run agent" }));
		await waitFor(() =>
			expect(props.onStarted).toHaveBeenCalledWith("example-run"),
		);
		expect(api.start).toHaveBeenCalledOnce();
		expect(api.start).toHaveBeenCalledWith({
			organizationId: props.organizationId,
			instanceId: props.instanceId,
			input: { message: "Write a delivery report" },
			idempotencyKey: expect.any(String),
		});
		expect(api.list).not.toHaveBeenCalled();
		expect(api.get).not.toHaveBeenCalled();
	});
	it("disables submission and task edits during an in-flight explicit start", async () => {
		let resolve!: (value: unknown) => void;
		api.start.mockImplementationOnce(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		mount();
		fireEvent.change(screen.getByLabelText("Task for this run"), {
			target: { value: "Write a report" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Run agent" }));
		await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
		expect(screen.getByLabelText("Task for this run")).toBeDisabled();
		expect(
			screen.getByRole("button", { name: /Run agent/ }),
		).toBeDisabled();
		fireEvent.submit(screen.getByRole("form", { name: "Start agent run" }));
		expect(api.start).toHaveBeenCalledOnce();
		await act(async () =>
			resolve({ executionId: "example-run", status: "PENDING" }),
		);
		await waitFor(() =>
			expect(props.onStarted).toHaveBeenCalledWith("example-run"),
		);
	});
	it("retains the idempotency key after a lost acknowledgement and retries only on explicit request", async () => {
		api.start
			.mockRejectedValueOnce(new Error("Response lost"))
			.mockResolvedValueOnce({
				executionId: "example-run",
				status: "PENDING",
			});
		mount();
		fireEvent.change(screen.getByLabelText("Task for this run"), {
			target: { value: "Write a report" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Run agent" }));
		await screen.findByText("Could not confirm the run");
		expect(api.start).toHaveBeenCalledOnce();
		expect(props.onStarted).not.toHaveBeenCalled();
		fireEvent.change(screen.getByLabelText("Task for this run"), {
			target: { value: "  Write a report  " },
		});
		fireEvent.click(screen.getByRole("button", { name: "Retry request" }));
		await waitFor(() =>
			expect(props.onStarted).toHaveBeenCalledWith("example-run"),
		);
		expect(api.start).toHaveBeenCalledTimes(2);
		expect(api.start.mock.calls[1][0]).toEqual(api.start.mock.calls[0][0]);
	});
	it("uses a new request identity for a deliberately changed task after failure", async () => {
		api.start
			.mockRejectedValueOnce(new Error("Response lost"))
			.mockResolvedValueOnce({
				executionId: "example-run",
				status: "PENDING",
			});
		mount();
		fireEvent.change(screen.getByLabelText("Task for this run"), {
			target: { value: "Write a report" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Run agent" }));
		await screen.findByText("Could not confirm the run");
		fireEvent.change(screen.getByLabelText("Task for this run"), {
			target: { value: "Summarize risks instead" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Run agent" }));
		await waitFor(() => expect(props.onStarted).toHaveBeenCalled());
		expect(api.start.mock.calls[1][0].idempotencyKey).not.toBe(
			api.start.mock.calls[0][0].idempotencyKey,
		);
		expect(api.start.mock.calls[1][0].input.message).toBe(
			"Summarize risks instead",
		);
	});
	it("fetches only the selected execution in result mode", async () => {
		mount({ mode: "result", executionId: "example-run" });
		await screen.findByRole("heading", { name: "Delivery report" });
		expect(api.get).toHaveBeenCalledWith({
			organizationId: props.organizationId,
			executionId: "example-run",
		});
		expect(api.list).not.toHaveBeenCalled();
		expect(api.search).not.toHaveBeenCalled();
		expect(api.start).not.toHaveBeenCalled();
		expect(
			screen.queryByRole("form", { name: "Start agent run" }),
		).not.toBeInTheDocument();
	});
	it("does not request an unspecified execution", () => {
		mount({ mode: "result" });
		expect(
			screen.getByText("Your results will appear here"),
		).toBeInTheDocument();
		expect(api.get).not.toHaveBeenCalled();
		expect(api.list).not.toHaveBeenCalled();
	});
	it("hides a cached result after its current permission is revoked", async () => {
		const { client } = mount({
			mode: "result",
			executionId: "example-run",
		});
		await screen.findByRole("heading", { name: "Delivery report" });
		api.get.mockRejectedValue(new Error("Run access revoked"));
		await act(async () => {
			await client.refetchQueries({
				queryKey: [
					"saved-agent-run",
					props.organizationId,
					"example-run",
				],
			});
		});
		await screen.findByText("Run access revoked");
		expect(
			screen.queryByRole("heading", { name: "Delivery report" }),
		).not.toBeInTheDocument();
		expect(screen.getByText("Could not read this run")).toBeInTheDocument();
	});
	it("loads schedule data only when schedule mode is selected", async () => {
		mount({ mode: "schedule", goal: "Create a weekly report" });
		await screen.findByRole("form", { name: "Agent schedule" });
		expect(api.list).toHaveBeenCalledWith({
			organizationId: props.organizationId,
			instanceId: props.instanceId,
			limit: 1,
		});
		expect(api.get).not.toHaveBeenCalled();
		expect(api.search).not.toHaveBeenCalled();
		expect(api.start).not.toHaveBeenCalled();
		expect(api.schedule).not.toHaveBeenCalled();
		expect(screen.getByLabelText("Scheduled task")).toHaveValue(
			"Create a weekly report",
		);
	});
	it("shows schedule errors and retries the read without starting or saving any work", async () => {
		api.list
			.mockRejectedValueOnce(new Error("Schedule unavailable"))
			.mockResolvedValueOnce({
				executions: [],
				schedule: null,
				schedulingState: "ACTIVE",
			});
		mount({ mode: "schedule" });
		await screen.findByText("Schedule unavailable");
		expect(
			screen.queryByRole("form", { name: "Agent schedule" }),
		).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		await screen.findByRole("form", { name: "Agent schedule" });
		expect(api.list).toHaveBeenCalledTimes(2);
		expect(api.start).not.toHaveBeenCalled();
		expect(api.schedule).not.toHaveBeenCalled();
	});
	it("does not leave cached schedule contents visible after access revocation", async () => {
		const { client } = mount({
			mode: "schedule",
			goal: "Create a weekly report",
		});
		await screen.findByLabelText("Scheduled task");
		api.list.mockRejectedValue(new Error("Schedule access revoked"));
		await act(async () => {
			await client.refetchQueries({
				queryKey: [
					"saved-agent-schedule",
					props.organizationId,
					props.instanceId,
				],
			});
		});
		await screen.findByText("Schedule access revoked");
		expect(
			screen.queryByLabelText("Scheduled task"),
		).not.toBeInTheDocument();
		expect(api.schedule).not.toHaveBeenCalled();
	});
});

it("does not reopen a closed panel when a pending start acknowledgement arrives", async () => {
	let acknowledge: ((value: unknown) => void) | undefined;
	api.start.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				acknowledge = resolve;
			}),
	);
	const view = mount();
	fireEvent.change(screen.getByLabelText("Task for this run"), {
		target: { value: "Write a report" },
	});
	fireEvent.click(screen.getByRole("button", { name: "Run agent" }));
	await waitFor(() => expect(api.start).toHaveBeenCalledOnce());
	view.unmount();
	await act(async () => {
		acknowledge?.({ executionId: "example-run", status: "PENDING" });
	});
	expect(props.onStarted).not.toHaveBeenCalled();
	expect(api.cancel).not.toHaveBeenCalled();
	expect(api.start).toHaveBeenCalledOnce();
});
