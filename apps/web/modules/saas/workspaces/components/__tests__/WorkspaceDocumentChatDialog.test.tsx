import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	fetch: vi.fn(),
	warning: vi.fn(),
	error: vi.fn(),
}));
vi.mock("@saas/agents/hooks/useRuntimeChatTransport", () => ({
	useRuntimeChatTransport: () => "legacy",
}));
vi.mock("sonner", () => ({
	toast: { warning: mocks.warning, error: mocks.error },
}));
vi.mock("../../../../../components/ai-elements/response", () => ({
	Response: ({ children }: { children: React.ReactNode }) => (
		<div>{children}</div>
	),
}));

import { WorkspaceDocumentChatDialog } from "../WorkspaceDocumentChatDialog";

const props = {
	open: true,
	onOpenChange: vi.fn(),
	workspaceId: "workspace-example",
	workspaceName: "Example documents",
	documentCount: 1,
};
const history = {
	messages: [
		{
			role: "user",
			content: "Saved question",
			timestamp: "2026-11-01T10:00:00Z",
		},
		{
			role: "assistant",
			content: "Saved answer",
			timestamp: "2026-11-01T10:00:01Z",
		},
	],
};
const json = (value: unknown) =>
	new Response(JSON.stringify(value), {
		headers: { "Content-Type": "application/json" },
	});
beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("fetch", mocks.fetch);
	mocks.fetch.mockResolvedValue(json({ messages: [] }));
});
describe("workspace document chat history", () => {
	it("restores the person's saved messages on open and fetches them again on reopen", async () => {
		mocks.fetch.mockImplementation(() => Promise.resolve(json(history)));
		const view = render(<WorkspaceDocumentChatDialog {...props} />);
		expect(await screen.findByText("Saved answer")).toBeInTheDocument();
		view.rerender(<WorkspaceDocumentChatDialog {...props} open={false} />);
		view.rerender(<WorkspaceDocumentChatDialog {...props} />);
		expect(await screen.findByText("Saved answer")).toBeInTheDocument();
		expect(mocks.fetch).toHaveBeenCalledTimes(2);
	});
	it("prevents sends until history has loaded", async () => {
		let resolve: (response: Response) => void = () => {};
		mocks.fetch.mockImplementation(
			() =>
				new Promise<Response>((r) => {
					resolve = r;
				}),
		);
		render(<WorkspaceDocumentChatDialog {...props} />);
		expect(
			screen.getByRole("button", { name: "Send message" }),
		).toBeDisabled();
		expect(
			screen.getByRole("textbox", {
				name: "Question about workspace documents",
			}),
		).toBeDisabled();
		await act(async () => resolve(json({ messages: [] })));
		expect(
			screen.getByRole("textbox", {
				name: "Question about workspace documents",
			}),
		).toBeEnabled();
	});
	it("keeps a generated answer visible when persistence fails and explains it was not saved", async () => {
		mocks.fetch.mockImplementation((_url: string, options?: RequestInit) =>
			Promise.resolve(
				options?.method === "POST"
					? json({
							response: "Available answer",
							historyPersisted: false,
						})
					: json({ messages: [] }),
			),
		);
		render(<WorkspaceDocumentChatDialog {...props} />);
		const input = screen.getByRole("textbox", {
			name: "Question about workspace documents",
		});
		await waitFor(() => expect(input).toBeEnabled());
		fireEvent.change(input, { target: { value: "Question" } });
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));
		expect(await screen.findByText("Available answer")).toBeInTheDocument();
		expect(mocks.warning).toHaveBeenCalledOnce();
		const post = mocks.fetch.mock.calls.find(
			(call) => call[1]?.method === "POST",
		);
		expect(JSON.parse(post?.[1].body)).not.toHaveProperty("history");
	});
	it("aborts a previous workspace's reply and never displays it in the next workspace", async () => {
		let resolve: (response: Response) => void = () => {};
		let signal: AbortSignal | undefined;
		mocks.fetch.mockImplementation(
			(_url: string, options?: RequestInit) => {
				if (options?.method === "POST") {
					signal = options.signal as AbortSignal;
					return new Promise<Response>((r) => {
						resolve = r;
					});
				}
				return Promise.resolve(json({ messages: [] }));
			},
		);
		const view = render(<WorkspaceDocumentChatDialog {...props} />);
		const input = screen.getByRole("textbox", {
			name: "Question about workspace documents",
		});
		await waitFor(() => expect(input).toBeEnabled());
		fireEvent.change(input, { target: { value: "Private question" } });
		fireEvent.click(screen.getByRole("button", { name: "Send message" }));
		view.rerender(
			<WorkspaceDocumentChatDialog
				{...props}
				workspaceId="other-workspace"
				workspaceName="Other documents"
			/>,
		);
		expect(signal?.aborted).toBe(true);
		await act(async () =>
			resolve(json({ response: "Old private answer" })),
		);
		expect(
			screen.queryByText("Old private answer"),
		).not.toBeInTheDocument();
		expect(screen.queryByText("Private question")).not.toBeInTheDocument();
	});
});
