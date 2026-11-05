import { agentPreviewDraftSchema } from "@repo/temporal/agent-preview-contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	start: vi.fn(),
	get: vi.fn(),
	cancel: vi.fn(),
	createTest: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		agents: { previews: h, tests: { cases: { create: h.createTest } } },
	},
}));

import { AgentBuilderPreview } from "../AgentBuilderPreview";

const draft = agentPreviewDraftSchema.parse({
	name: "Example agent",
	instructions: "Cite selected documents",
	workspaceIds: ["example-workspace"],
	workspaceDocumentFilters: [
		{ workspaceId: "example-workspace", documentIds: ["example-document"] },
	],
	skillIds: ["example-skill"],
});
const props = { organizationId: "example-org", userId: "example-user", draft };
const receipt = {
	workflowId: "agent-preview-example",
	runId: "example-run",
	draftHash: "a".repeat(64),
};
const result = {
	...receipt,
	state: {
		status: "COMPLETED",
		phase: "Preview completed",
		response: "Example output",
		draftHash: receipt.draftHash,
		toolCalls: [
			{
				id: "example-call",
				name: "preview_read_workspace_document",
				status: "success",
				durationMs: 20,
			},
		],
		sources: [
			{
				id: "example-document",
				title: "Example delivery notes",
				kind: "workspace_document",
			},
		],
	},
};
function wrapper({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: {
						queries: { retry: false },
						mutations: { retry: false },
					},
				})
			}
		>
			{children}
		</QueryClientProvider>
	);
}
function submit(v: ReturnType<typeof render>, message = "Try this") {
	fireEvent.change(v.getByRole("textbox"), { target: { value: message } });
	fireEvent.click(
		v.getByRole("button", { name: /Run preview|Send follow-up/ }),
	);
}
beforeEach(() => {
	vi.clearAllMocks();
	sessionStorage.clear();
	h.start.mockResolvedValue({
		...receipt,
		state: { ...result.state, status: "RUNNING" },
	});
	h.get.mockResolvedValue(result);
	h.cancel.mockResolvedValue({
		...receipt,
		state: { ...result.state, status: "CANCELLED" },
	});
});
it("runs only on explicit request, sends the complete supported draft, and displays real sources", async () => {
	const v = render(<AgentBuilderPreview {...props} />, { wrapper });
	expect(h.start).not.toHaveBeenCalled();
	expect(h.get).not.toHaveBeenCalled();
	submit(v);
	await v.findByText("Example output");
	expect(h.start).toHaveBeenCalledExactlyOnceWith({
		organizationId: props.organizationId,
		draft,
		userMessage: "Try this",
		history: [],
		idempotencyKey: expect.any(String),
	});
	expect(h.get).toHaveBeenCalledWith({
		organizationId: props.organizationId,
		workflowId: receipt.workflowId,
		runId: receipt.runId,
	});
	expect(v.getByText("Example delivery notes")).toBeInTheDocument();
	expect(v.getByText(/Activity · 1 reads/)).toBeInTheDocument();
	const stored = JSON.parse(
		sessionStorage.getItem(
			"fabric-agent-preview:example-org:example-user:new",
		)!,
	);
	expect(stored).toEqual(receipt);
	expect(JSON.stringify(stored)).not.toContain("Try this");
});
it.each([
	{ executionMode: "goal_oriented" as const, goal: "Example goal" },
	{ mcpConfigIds: ["example-mcp"] },
	{ integrationIds: ["example-connection"] },
	{ capabilityIds: ["web-search"] },
])("identifies unsupported settings before executing: %j", (patch) => {
	const v = render(
		<AgentBuilderPreview {...props} draft={{ ...draft, ...patch }} />,
		{ wrapper },
	);
	fireEvent.change(v.getByRole("textbox"), { target: { value: "Try" } });
	expect(v.getByRole("button", { name: "Run preview" })).toBeDisabled();
	expect(
		v.getByText("Some settings need a saved-agent run"),
	).toBeInTheDocument();
	expect(h.start).not.toHaveBeenCalled();
});
it("starts a new durable turn with prior conversation only while the draft is unchanged", async () => {
	const v = render(<AgentBuilderPreview {...props} />, { wrapper });
	submit(v);
	await v.findByText("Example output");
	submit(v, "Clarify this");
	await waitFor(() => expect(h.start).toHaveBeenCalledTimes(2));
	expect(h.start.mock.calls[1][0].history).toEqual([
		{ role: "user", content: "Try this" },
		{ role: "assistant", content: "Example output" },
	]);
	await waitFor(() =>
		expect(v.queryByText("Starting preview…")).not.toBeInTheDocument(),
	);
	v.rerender(
		<AgentBuilderPreview
			{...props}
			draft={{ ...draft, instructions: "A different draft" }}
		/>,
	);
	expect(v.getByText(/Your draft changed/)).toBeInTheDocument();
	submit(v, "Start over");
	await waitFor(() => expect(h.start).toHaveBeenCalledTimes(3));
	expect(h.start.mock.calls[2][0].history).toEqual([]);
	expect(h.start.mock.calls[2][0].draft.instructions).toBe(
		"A different draft",
	);
});
it("keeps an uncertain admission retry on the same idempotency key and hides provider internals", async () => {
	h.start.mockRejectedValueOnce(new Error("private provider details"));
	const v = render(<AgentBuilderPreview {...props} />, { wrapper });
	submit(v);
	await v.findByText("Preview could not complete");
	expect(v.queryByText("private provider details")).not.toBeInTheDocument();
	submit(v);
	await v.findByText("Example output");
	expect(h.start.mock.calls[0][0].idempotencyKey).toBe(
		h.start.mock.calls[1][0].idempotencyKey,
	);
});
it("restores only the current user's opaque receipt and checks access before showing results", async () => {
	sessionStorage.setItem(
		"fabric-agent-preview:example-org:example-user:new",
		JSON.stringify(receipt),
	);
	h.get.mockRejectedValue(new Error("Access denied"));
	const v = render(<AgentBuilderPreview {...props} />, { wrapper });
	await v.findByText("Preview could not complete");
	expect(v.queryByText("Example output")).not.toBeInTheDocument();
	expect(h.start).not.toHaveBeenCalled();
	v.rerender(<AgentBuilderPreview {...props} userId="example-other-user" />);
	await waitFor(() =>
		expect(
			v.queryByRole("button", { name: "Refresh preview" }),
		).not.toBeInTheDocument(),
	);
});
it("withholds retained results after access is revoked on refresh", async () => {
	const v = render(<AgentBuilderPreview {...props} />, { wrapper });
	submit(v);
	await v.findByText("Example output");
	h.get.mockRejectedValue(new Error("Access denied"));
	fireEvent.click(v.getByRole("button", { name: "Refresh preview" }));
	await v.findByText("Preview could not complete");
	expect(v.queryByText("Example output")).not.toBeInTheDocument();
	expect(v.queryByText("Example delivery notes")).not.toBeInTheDocument();
});
it("stops a running preview explicitly and refreshes the resulting state", async () => {
	h.get.mockResolvedValue({
		...result,
		state: {
			...result.state,
			status: "RUNNING",
			phase: "Reading selected document",
			response: undefined,
		},
	});
	const v = render(<AgentBuilderPreview {...props} />, { wrapper });
	submit(v);
	const stop = await v.findByRole("button", { name: "Stop preview" });
	expect(h.cancel).not.toHaveBeenCalled();
	h.get.mockResolvedValue({
		...result,
		state: {
			...result.state,
			status: "CANCELLED",
			phase: "Preview stopped",
			response: undefined,
		},
	});
	fireEvent.click(stop);
	await v.findByText("Preview stopped");
	expect(h.cancel).toHaveBeenCalledExactlyOnceWith({
		organizationId: props.organizationId,
		workflowId: receipt.workflowId,
		runId: receipt.runId,
	});
});
it("clears receipts and conversation only through New preview", async () => {
	const v = render(<AgentBuilderPreview {...props} />, { wrapper });
	submit(v);
	await v.findByText("Example output");
	fireEvent.click(v.getByRole("button", { name: "New preview" }));
	expect(v.queryByText("Example output")).not.toBeInTheDocument();
	expect(
		sessionStorage.getItem(
			"fabric-agent-preview:example-org:example-user:new",
		),
	).toBeNull();
	expect(h.cancel).not.toHaveBeenCalled();
});
it("links full saved runs separately without executing or saving them", () => {
	const v = render(
		<AgentBuilderPreview
			{...props}
			savedAgentHref="/app/example-org/agents?agentId=example-agent&agentView=new"
		/>,
		{ wrapper },
	);
	expect(
		v.getByRole("link", { name: /Run the saved agent/ }),
	).toHaveAttribute("target", "_blank");
	expect(h.start).not.toHaveBeenCalled();
});

it("keeps a follow-up typed while admission is pending", async () => {
	let accept!: (value: typeof result) => void;
	h.start.mockReturnValueOnce(
		new Promise((resolve) => {
			accept = resolve;
		}),
	);
	const v = render(<AgentBuilderPreview {...props} />, { wrapper });
	submit(v);
	await waitFor(() => expect(h.start).toHaveBeenCalledTimes(1));
	fireEvent.change(v.getByRole("textbox"), {
		target: { value: "An unsent follow-up" },
	});
	accept(result);
	await v.findByText("Example output");
	expect(v.getByRole("textbox")).toHaveValue("An unsent follow-up");
});
it("requires instructions before submitting a sample task", () => {
	const v = render(
		<AgentBuilderPreview
			{...props}
			draft={{ ...draft, instructions: "" }}
		/>,
		{ wrapper },
	);
	fireEvent.change(v.getByRole("textbox"), {
		target: { value: "Example task" },
	});
	expect(v.getByRole("button", { name: "Run preview" })).toBeDisabled();
	expect(v.getByText(/Add instructions to your draft/)).toBeInTheDocument();
	expect(h.start).not.toHaveBeenCalled();
});

it("shows safe admission guidance for unsupported attached-file skills", async () => {
	h.start.mockRejectedValue(
		Object.assign(
			new Error("Skills with attached files need a saved-agent run."),
			{ code: "BAD_REQUEST" },
		),
	);
	const v = render(<AgentBuilderPreview {...props} />, { wrapper });
	submit(v);
	await v.findByText("Skills with attached files need a saved-agent run.");
});

it("explains the instruction preview limit before admission", () => {
	const v = render(
		<AgentBuilderPreview
			{...props}
			draft={{ ...draft, instructions: "x".repeat(40_001) }}
		/>,
		{ wrapper },
	);
	fireEvent.change(v.getByRole("textbox"), {
		target: { value: "Example task" },
	});
	expect(v.getByRole("button", { name: "Run preview" })).toBeDisabled();
	expect(v.getByText(/Preview supports up to 40,000/)).toBeInTheDocument();
	expect(h.start).not.toHaveBeenCalled();
});

it("saves a standalone reusable task from a completed saved-agent preview with its provenance", async () => {
	const v = render(
		<AgentBuilderPreview
			{...props}
			draft={{ ...draft, instanceId: "example-agent" }}
		/>,
		{ wrapper },
	);
	submit(v, "Original task");
	await v.findByText("Example output");
	fireEvent.click(v.getByRole("button", { name: "Save as test" }));
	fireEvent.change(v.getByLabelText("Test name"), {
		target: { value: "Cites evidence" },
	});
	fireEvent.change(v.getByLabelText("Task for a new run"), {
		target: { value: "Standalone task" },
	});
	fireEvent.change(v.getByLabelText("Must include"), {
		target: { value: "Evidence" },
	});
	fireEvent.click(v.getByRole("button", { name: "Save test" }));
	await waitFor(() =>
		expect(h.createTest).toHaveBeenCalledWith({
			organizationId: props.organizationId,
			instanceId: "example-agent",
			sourcePreview: {
				workflowId: receipt.workflowId,
				runId: receipt.runId,
			},
			name: "Cites evidence",
			input: "Standalone task",
			checks: { requiredPhrases: ["Evidence"], forbiddenPhrases: [] },
		}),
	);
});
it("asks new-agent users to save before keeping reusable tests", async () => {
	const v = render(<AgentBuilderPreview {...props} />, { wrapper });
	submit(v);
	await v.findByText("Example output");
	expect(v.getByRole("button", { name: "Save as test" })).toBeDisabled();
	expect(
		v.getByText(/Save your agent first to keep reusable tests/),
	).toBeInTheDocument();
});

it("renders a preview answer with the shared outline without rewriting code", async () => {
	h.get.mockResolvedValue({
		...result,
		state: {
			...result.state,
			response:
				"### Example answer\n\n##### Next steps\n\n```text\n• literal item\n1) literal instruction\n```",
		},
	});
	const view = render(<AgentBuilderPreview {...props} />, { wrapper });
	submit(view);
	expect(
		(await view.findByRole("heading", { name: "Example answer" })).tagName,
	).toBe("H2");
	expect(view.getByRole("heading", { name: "Next steps" }).tagName).toBe(
		"H3",
	);
	expect(
		view.getByText(
			(_text, node) =>
				node?.tagName === "CODE" &&
				node.textContent?.includes("• literal item") === true,
		),
	).toHaveTextContent("1) literal instruction");
});
