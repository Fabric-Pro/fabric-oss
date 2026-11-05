import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
	search: vi.fn(),
	identity: vi.fn(),
	list: vi.fn(),
	get: vi.fn(),
	start: vi.fn(),
	cancel: vi.fn(),
	schedule: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		agentDeployments: { runs: api },
		agentTemplates: { instances: { get: api.identity } },
	},
}));

import { AgentRunHistory } from "../AgentRunHistory";

const props = { organizationId: "example-org", onSelect: vi.fn() };
const row = (id: string, task: string) => ({
	id,
	instanceId: "example-agent",
	agentName: "Delivery reporter",
	task,
	status: "COMPLETED",
	lastRecordedStatus: "COMPLETED",
	triggerType: "MANUAL",
	queuedAt: "2026-01-01T09:00:00Z",
	createdAt: "2026-01-01T09:00:00Z",
	completedAt: "2026-01-01T09:00:03Z",
	duration: 3000,
});
const first = row("example-run-one", "First delivery report");
const second = row("example-run-two", "Second delivery report");
const clients: QueryClient[] = [];
function mount(overrides: Partial<Parameters<typeof AgentRunHistory>[0]> = {}) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
			mutations: { retry: false },
		},
	});
	clients.push(client);
	const view = render(
		<QueryClientProvider client={client}>
			<AgentRunHistory {...props} {...overrides} />
		</QueryClientProvider>,
	);
	return { ...view, client };
}
beforeEach(() => {
	Object.values(api).forEach((fn) => {
		fn.mockReset();
	});
	props.onSelect.mockReset();
	api.identity.mockResolvedValue({
		instance: { id: "example-agent", name: "Delivery reporter" },
	});
	api.search.mockResolvedValue({
		executions: [first],
		nextCursor: "opaque_next_cursor",
	});
});
afterEach(() => {
	cleanup();
	clients.splice(0).forEach((client) => {
		client.clear();
	});
});

describe("agent run history", () => {
	it("requests only a bounded metadata page and leaves execution/results/schedule controls lazy", async () => {
		mount();
		await screen.findByRole("button", { name: first.task });
		expect(api.search).toHaveBeenCalledOnce();
		expect(api.search).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: props.organizationId,
				instanceId: undefined,
				limit: 25,
				cursor: undefined,
			}),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		for (const name of [
			"get",
			"list",
			"start",
			"cancel",
			"schedule",
		] as const) {
			expect(api[name]).not.toHaveBeenCalled();
		}
		expect(
			screen.getByRole("columnheader", { name: "Agent" }),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: first.task }));
		expect(props.onSelect).toHaveBeenCalledWith(first);
		expect(api.get).not.toHaveBeenCalled();
	});
	it("keeps compact history scoped, limits it to five rows and links to full history", async () => {
		mount({
			instanceId: "example-agent",
			compact: true,
			historyHref: "/app/example-org/agents?tab=tasks",
		});
		await screen.findByRole("button", { name: first.task });
		expect(api.search).toHaveBeenCalledWith(
			expect.objectContaining({ instanceId: "example-agent", limit: 5 }),
			expect.any(Object),
		);
		expect(
			screen.queryByRole("columnheader", { name: "Agent" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("form", { name: "Filter run history" }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "View full history" }),
		).toHaveAttribute("href", "/app/example-org/agents?tab=tasks");
		expect(
			screen.queryByRole("button", { name: "Next" }),
		).not.toBeInTheDocument();
	});
	it("shows loading then a helpful empty state without requesting result bodies", async () => {
		let resolve!: (value: unknown) => void;
		api.search.mockImplementationOnce(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		mount();
		expect(
			screen.getByRole("status", { name: "Loading runs" }),
		).toBeInTheDocument();
		await act(async () => resolve({ executions: [], nextCursor: null }));
		await screen.findByText(/No runs match these filters/);
		expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
		expect(api.get).not.toHaveBeenCalled();
	});
	it("uses opaque cursors for next/previous and prevents selecting a placeholder row during pagination", async () => {
		let resolve!: (value: unknown) => void;
		api.search.mockImplementation((input: { cursor?: string }) =>
			input.cursor
				? new Promise((r) => {
						resolve = r;
					})
				: Promise.resolve({
						executions: [first],
						nextCursor: "opaque_next_cursor",
					}),
		);
		mount();
		await screen.findByRole("button", { name: first.task });
		expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Next" }));
		await waitFor(() => expect(api.search).toHaveBeenCalledTimes(2));
		expect(api.search.mock.calls[1][0].cursor).toBe("opaque_next_cursor");
		expect(screen.getByRole("button", { name: first.task })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: first.task }));
		expect(props.onSelect).not.toHaveBeenCalled();
		await act(async () =>
			resolve({ executions: [second], nextCursor: null }),
		);
		await screen.findByRole("button", { name: second.task });
		expect(
			screen.queryByRole("button", { name: first.task }),
		).not.toBeInTheDocument();
		expect(screen.getByText("Page 2")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Previous" }));
		await screen.findByRole("button", { name: first.task });
		expect(screen.getByText(/Page 1/)).toBeInTheDocument();
	});
	it("applies draft filters explicitly, resets pagination and clears all filters", async () => {
		const filtered = row(
			"example-filtered-run",
			"Filtered scheduled failure",
		);
		api.search.mockImplementation(
			(input: { cursor?: string; query?: string }) =>
				Promise.resolve({
					executions: [
						input.query ? filtered : input.cursor ? second : first,
					],
					nextCursor: input.cursor ? null : "opaque_next_cursor",
				}),
		);
		const user = userEvent.setup();
		mount();
		await screen.findByRole("button", { name: first.task });
		fireEvent.click(screen.getByRole("button", { name: "Next" }));
		await screen.findByRole("button", { name: second.task });
		fireEvent.change(screen.getByLabelText("Search runs"), {
			target: { value: "  Report risk  " },
		});
		await user.click(screen.getByRole("combobox", { name: "Status" }));
		await user.click(
			screen.getByRole("option", { name: "Failed", exact: true }),
		);
		await user.click(screen.getByRole("combobox", { name: "Started by" }));
		await user.click(
			screen.getByRole("option", { name: "Schedule", exact: true }),
		);
		fireEvent.change(screen.getByLabelText("From date"), {
			target: { value: "2026-01-01" },
		});
		fireEvent.change(screen.getByLabelText("To date"), {
			target: { value: "2026-01-02" },
		});
		expect(api.search).toHaveBeenCalledTimes(2);
		fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
		await waitFor(() => expect(api.search).toHaveBeenCalledTimes(3));
		expect(api.search.mock.calls[2][0]).toEqual(
			expect.objectContaining({
				query: "Report risk",
				status: "FAILED",
				triggerType: "SCHEDULE",
				cursor: undefined,
				from: new Date("2026-01-01T00:00:00").toISOString(),
				to: new Date("2026-01-02T23:59:59.999").toISOString(),
			}),
		);
		expect(screen.getByText(/Page 1/)).toBeInTheDocument();
		await screen.findByRole("button", { name: filtered.task });
		fireEvent.click(screen.getByRole("button", { name: "Clear" }));
		await screen.findByRole("button", { name: first.task });
		expect(
			screen.queryByRole("button", { name: filtered.task }),
		).not.toBeInTheDocument();
		await waitFor(() =>
			expect(screen.getByLabelText("Search runs")).toHaveValue(""),
		);
		expect(screen.getByLabelText("From date")).toHaveValue("");
		expect(
			screen.getByRole("combobox", { name: "Status" }),
		).toHaveTextContent("All statuses");
		const keys = clients[0]
			.getQueryCache()
			.findAll({ queryKey: ["saved-agent-history"] })
			.filter((query) => query.getObserversCount() > 0)
			.map((query) => query.queryKey[1]);
		expect(keys).toContainEqual(
			expect.objectContaining({
				query: undefined,
				status: undefined,
				triggerType: undefined,
				cursor: undefined,
			}),
		);
	});
	it("hides cached row data and disables continuation after a permission failure", async () => {
		mount();
		await screen.findByRole("button", { name: first.task });
		api.search.mockRejectedValue(new Error("Access revoked"));
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await screen.findByText("Access revoked");
		expect(screen.getByText("Could not load runs")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: first.task }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("table", { name: "Agent runs" }),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
	});
	it("starts an active-only view without loading results", async () => {
		mount({ initialStatus: "ACTIVE" });
		await screen.findByRole("button", { name: first.task });
		expect(api.search.mock.calls[0][0].status).toBe("ACTIVE");
		expect(
			screen.getByRole("combobox", { name: "Status" }),
		).toHaveTextContent("In progress");
		expect(api.get).not.toHaveBeenCalled();
	});
});

describe("visible agent scope", () => {
	it("names a scoped full history and retains its Agent column", async () => {
		const onAgentChange = vi.fn();
		mount({ instanceId: "example-agent", onAgentChange });
		await screen.findByRole("heading", { name: "Delivery reporter runs" });
		expect(
			screen.getByRole("columnheader", { name: "Agent", exact: true }),
		).toBeInTheDocument();
		fireEvent.click(
			screen.getByRole("button", { name: "All agents", exact: true }),
		);
		expect(onAgentChange).toHaveBeenCalledWith(undefined);
	});
	it("names the selected agent even when it has no matching runs", async () => {
		api.search.mockResolvedValue({ executions: [], nextCursor: null });
		mount({ instanceId: "example-agent", onAgentChange: vi.fn() });
		await screen.findByRole("heading", { name: "Delivery reporter runs" });
		expect(api.identity).toHaveBeenCalledWith({
			organizationId: props.organizationId,
			id: "example-agent",
		});
		expect(
			screen.getByRole("button", { name: "All agents", exact: true }),
		).toBeVisible();
	});
	it("lets users narrow all-agent history by selecting an agent name", async () => {
		const onAgentChange = vi.fn();
		mount({ onAgentChange });
		await screen.findByRole("heading", { name: "All agent runs" });
		fireEvent.click(
			await screen.findByRole("button", {
				name: "Show runs for Delivery reporter",
				exact: true,
			}),
		);
		expect(onAgentChange).toHaveBeenCalledWith("example-agent");
		expect(api.get).not.toHaveBeenCalled();
	});
});
