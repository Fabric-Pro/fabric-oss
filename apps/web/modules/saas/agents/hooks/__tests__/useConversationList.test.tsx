import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConversationList } from "../useConversationList";

const conversations = vi.hoisted(() => ({
	list: vi.fn(),
	update: vi.fn(),
	archive: vi.fn(),
	togglePin: vi.fn(),
	delete: vi.fn(),
	setVisibility: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { agents: { conversations } },
}));

const item = (id: string, overrides: Record<string, unknown> = {}) => ({
	id,
	agentId: "fabric-workspace-assistant",
	title: `Session ${id}`,
	messageCount: 2,
	pinned: false,
	status: "ACTIVE",
	createdAt: "2026-10-14T09:00:00.000Z",
	updatedAt: "2026-10-14T10:00:00.000Z",
	lastMessage: "hello",
	metadata: { mode: "direct" },
	visibility: "PRIVATE",
	isOwn: true,
	owner: { id: "u1", name: "Alex Example" },
	...overrides,
});

function setup(
	options: Partial<Parameters<typeof useConversationList>[0]> = {},
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const invalidate = vi.spyOn(client, "invalidateQueries");
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	const view = renderHook(
		() =>
			useConversationList({
				organizationId: "org-1",
				agentId: "fabric-workspace-assistant",
				view: "mine",
				search: "",
				...options,
			}),
		{ wrapper },
	);
	return { ...view, invalidate };
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("reading the list", () => {
	it("asks for the viewer's active sessions of the agent, first page, with no search", async () => {
		conversations.list.mockResolvedValue({ conversations: [item("c1")] });

		const { result } = setup();

		await waitFor(() => expect(result.current.items).toHaveLength(1));
		expect(conversations.list).toHaveBeenCalledWith({
			organizationId: "org-1",
			agentId: "fabric-workspace-assistant",
			status: "ACTIVE",
			scope: "mine",
			limit: 30,
		});
	});

	it("asks for what the view and the search say", async () => {
		conversations.list.mockResolvedValue({ conversations: [] });

		setup({ view: "shared", search: "  plan " });
		await waitFor(() => expect(conversations.list).toHaveBeenCalled());
		const archived = setup({ view: "archived" });
		await waitFor(() =>
			expect(conversations.list).toHaveBeenCalledTimes(2),
		);

		expect(conversations.list.mock.calls[0][0]).toMatchObject({
			scope: "shared",
			status: "ACTIVE",
			search: "plan",
		});
		expect(conversations.list.mock.calls[1][0]).toMatchObject({
			scope: "mine",
			status: "ARCHIVED",
		});
		expect(conversations.list.mock.calls[1][0]).not.toHaveProperty(
			"search",
		);
		archived.unmount();
	});

	it("loads the next page from the cursor and appends it", async () => {
		conversations.list
			.mockResolvedValueOnce({
				conversations: [item("c1")],
				nextCursor: "cursor-1",
			})
			.mockResolvedValueOnce({ conversations: [item("c2")] });

		const { result } = setup();
		await waitFor(() => expect(result.current.hasMore).toBe(true));
		await act(() => result.current.loadMore());

		await waitFor(() => expect(result.current.items).toHaveLength(2));
		expect(conversations.list.mock.calls[1][0]).toMatchObject({
			cursor: "cursor-1",
		});
		expect(result.current.items.map((entry) => entry.id)).toEqual([
			"c1",
			"c2",
		]);
		expect(result.current.hasMore).toBe(false);
	});

	it("reports a list it cannot read as an error rather than an empty list", async () => {
		conversations.list.mockResolvedValue({ items: [] });

		const { result } = setup();

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.items).toEqual([]);
	});

	it("asks nothing while it is not enabled", () => {
		setup({ enabled: false });

		expect(conversations.list).not.toHaveBeenCalled();
	});
});

describe("changing a session", () => {
	async function ready() {
		conversations.list.mockResolvedValue({ conversations: [item("c1")] });
		const view = setup();
		await waitFor(() => expect(view.result.current.items).toHaveLength(1));
		view.invalidate.mockClear();
		return view;
	}

	it("renames it with the new title and refreshes every list of conversations", async () => {
		conversations.update.mockResolvedValue({ id: "c1" });
		const { result, invalidate } = await ready();

		await act(() => result.current.rename("c1", "New name"));

		expect(conversations.update).toHaveBeenCalledWith({
			id: "c1",
			organizationId: "org-1",
			title: "New name",
		});
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: ["agents", "conversations"],
		});
	});

	it("archives it, and restores it by making it active again", async () => {
		conversations.archive.mockResolvedValue({ id: "c1" });
		conversations.update.mockResolvedValue({ id: "c1" });
		const { result, invalidate } = await ready();

		await act(() => result.current.archive("c1"));
		await act(() => result.current.restore("c1"));

		expect(conversations.archive).toHaveBeenCalledWith({
			id: "c1",
			organizationId: "org-1",
		});
		expect(conversations.update).toHaveBeenCalledWith({
			id: "c1",
			organizationId: "org-1",
			status: "ACTIVE",
		});
		expect(invalidate).toHaveBeenCalledTimes(2);
	});

	it("pins and deletes it", async () => {
		conversations.togglePin.mockResolvedValue({ id: "c1" });
		conversations.delete.mockResolvedValue({ id: "c1" });
		const { result } = await ready();

		await act(() => result.current.togglePin("c1"));
		await act(() => result.current.remove("c1"));

		expect(conversations.togglePin).toHaveBeenCalledWith({
			id: "c1",
			organizationId: "org-1",
		});
		expect(conversations.delete).toHaveBeenCalledWith({
			id: "c1",
			organizationId: "org-1",
		});
	});

	it("sets who can read it, in the organization of the list, and refreshes every list", async () => {
		conversations.setVisibility.mockResolvedValue({ id: "c1" });
		const { result, invalidate } = await ready();

		await act(() => result.current.setVisibility("c1", "ORGANIZATION"));

		expect(conversations.setVisibility).toHaveBeenCalledWith({
			id: "c1",
			visibility: "ORGANIZATION",
			organizationId: "org-1",
		});
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: ["agents", "conversations"],
		});
	});

	it("leaves the lists as they are when the change fails", async () => {
		conversations.archive.mockRejectedValue(new Error("not yours"));
		const { result, invalidate } = await ready();

		await act(async () => {
			await expect(result.current.archive("c1")).rejects.toThrow(
				"not yours",
			);
		});

		expect(invalidate).not.toHaveBeenCalled();
	});
});

it("omits a missing organization on list mutations instead of sending null", async () => {
	conversations.list.mockResolvedValue({ conversations: [] });
	conversations.update.mockResolvedValue({ id: "example-conversation" });
	conversations.archive.mockResolvedValue({ id: "example-conversation" });
	conversations.togglePin.mockResolvedValue({ id: "example-conversation" });
	conversations.delete.mockResolvedValue({ id: "example-conversation" });
	const { result } = setup({ organizationId: null });
	await act(async () => {
		await result.current.rename("example-conversation", "Example");
		await result.current.archive("example-conversation");
		await result.current.restore("example-conversation");
		await result.current.togglePin("example-conversation");
		await result.current.remove("example-conversation");
	});
	for (const mutation of [
		conversations.update,
		conversations.archive,
		conversations.togglePin,
		conversations.delete,
	]) {
		expect(mutation).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: undefined }),
		);
	}
});
