import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommentsPanel } from "../CommentsPanel";

type MockComment = {
	id: string;
	content: string;
	authorType: "USER" | "AGENT";
	parentId?: string | null;
	createdAt: string;
	author: {
		name?: string | null;
		email?: string | null;
		image?: string | null;
	};
};

const {
	storyListInput,
	storyComments,
	storyCreate,
	taskCreate,
	groupMemberCounts,
} = vi.hoisted(() => ({
	storyListInput: vi.fn(),
	storyComments: { current: [] as MockComment[] },
	storyCreate: vi.fn(),
	taskCreate: vi.fn(),
	groupMemberCounts: vi.fn(),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ organizationId: "ambient-org" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			stories: {
				comments: {
					list: {
						queryOptions: (opts: { input: unknown }) => {
							storyListInput(opts.input);
							return {
								queryKey: ["story-comments", opts.input],
								queryFn: async () => ({
									comments: storyComments.current,
								}),
							};
						},
					},
					create: { call: storyCreate },
				},
				tasks: {
					comments: {
						list: {
							queryOptions: (opts: { input: unknown }) => ({
								queryKey: ["task-comments", opts.input],
								queryFn: async () => ({
									comments: storyComments.current,
								}),
							}),
						},
						create: { call: taskCreate },
					},
				},
			},
		},
		functionTags: {
			groupMemberCounts: { call: groupMemberCounts },
		},
	},
}));

const wrap = (ui: ReactNode) => (
	<QueryClientProvider
		client={
			new QueryClient({ defaultOptions: { queries: { retry: false } } })
		}
	>
		{ui}
	</QueryClientProvider>
);

const author = (name: string) => ({ name, email: `${name}@x.io`, image: null });
const mk = (
	id: string,
	parentId: string | null,
	name: string,
	type: "USER" | "AGENT" = "USER",
): MockComment => ({
	id,
	content: `${name} says hi`,
	authorType: type,
	parentId,
	createdAt: "2026-06-29T12:00:00.000Z",
	author: author(name),
});

beforeEach(() => {
	storyListInput.mockReset();
	storyComments.current = [];
	storyCreate.mockReset();
	storyCreate.mockResolvedValue({ fabricMentionQueued: false });
	taskCreate.mockReset();
	taskCreate.mockResolvedValue({ fabricMentionQueued: false });
	groupMemberCounts.mockReset();
	groupMemberCounts.mockResolvedValue({});
});

describe("CommentsPanel — org id resolution", () => {
	it("uses the explicit organizationId prop when provided (overrides ambient)", () => {
		render(
			wrap(
				<CommentsPanel
					projectId="p1"
					storyId="s1"
					organizationId="prop-org"
				/>,
			),
		);
		expect(storyListInput).toHaveBeenCalledWith({
			projectId: "p1",
			storyId: "s1",
			organizationId: "prop-org",
		});
	});

	it("uses an explicit null prop (personal context) over ambient org", () => {
		render(
			wrap(
				<CommentsPanel
					projectId="p1"
					storyId="s1"
					organizationId={null}
				/>,
			),
		);
		expect(storyListInput).toHaveBeenCalledWith({
			projectId: "p1",
			storyId: "s1",
			organizationId: null,
		});
	});

	it("falls back to ambient org when the prop is omitted (TaskModal back-compat)", () => {
		render(wrap(<CommentsPanel projectId="p1" storyId="s1" />));
		expect(storyListInput).toHaveBeenCalledWith({
			projectId: "p1",
			storyId: "s1",
			organizationId: "ambient-org",
		});
	});
});

describe("CommentsPanel — threaded rendering", () => {
	it("renders a reply nested under its root and gives each comment an anchor id", async () => {
		storyComments.current = [
			mk("root", null, "Alice"),
			mk("reply", "root", "Bob"),
		];
		const { container } = render(
			wrap(<CommentsPanel projectId="p1" storyId="s1" />),
		);

		expect(await screen.findByText("Bob says hi")).toBeTruthy();
		// anchor ids present for deep-links
		expect(container.querySelector("#comment-root")).toBeTruthy();
		expect(container.querySelector("#comment-reply")).toBeTruthy();
		// the reply lives inside the root's thread container, not at top level
		const rootEl = container.querySelector("#comment-root");
		const replyEl = container.querySelector("#comment-reply");
		expect(rootEl?.parentElement?.contains(replyEl as Node)).toBe(true);
	});

	it("renders agent (@fabric) replies flat as roots (sourceCommentId, not parentId)", async () => {
		storyComments.current = [
			mk("root", null, "Alice"),
			mk("agent", null, "Fabric", "AGENT"),
		];
		const { container } = render(
			wrap(<CommentsPanel projectId="p1" storyId="s1" />),
		);
		expect(await screen.findByText("Fabric Agent")).toBeTruthy();
		// agent comment is a top-level thread, not nested under root
		const rootThread = container
			.querySelector("#comment-root")
			?.closest("[data-thread]");
		const agentEl = container.querySelector("#comment-agent");
		expect(rootThread?.contains(agentEl as Node)).toBe(false);
	});
});

describe("CommentsPanel — reply affordance", () => {
	it("does not render a Reply button on AGENT comments", async () => {
		storyComments.current = [mk("agent", null, "Fabric", "AGENT")];
		render(wrap(<CommentsPanel projectId="p1" storyId="s1" />));
		await screen.findByText("Fabric Agent");
		expect(screen.queryByRole("button", { name: /reply to/i })).toBeNull();
	});

	it("shows a 'Replying to {name}' banner when Reply is clicked", async () => {
		storyComments.current = [mk("root", null, "Alice")];
		render(wrap(<CommentsPanel projectId="p1" storyId="s1" />));
		fireEvent.click(
			await screen.findByRole("button", { name: /reply to alice/i }),
		);
		expect(screen.getByText(/replying to/i)).toBeTruthy();
	});

	it("posts a reply with parentId = the clicked comment id (story scope)", async () => {
		storyComments.current = [mk("root", null, "Alice")];
		render(wrap(<CommentsPanel projectId="p1" storyId="s1" />));
		fireEvent.click(
			await screen.findByRole("button", { name: /reply to alice/i }),
		);
		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "thanks" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^reply$/i }));
		await vi.waitFor(() =>
			expect(storyCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					content: "thanks",
					parentId: "root",
				}),
			),
		);
	});

	it("posts a reply with parentId in task scope too", async () => {
		storyComments.current = [mk("root", null, "Alice")];
		render(wrap(<CommentsPanel projectId="p1" storyId="s1" taskId="t1" />));
		fireEvent.click(
			await screen.findByRole("button", { name: /reply to alice/i }),
		);
		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "thanks" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^reply$/i }));
		await vi.waitFor(() =>
			expect(taskCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					taskId: "t1",
					content: "thanks",
					parentId: "root",
				}),
			),
		);
	});

	it("posts a root comment with no parentId when not replying", async () => {
		storyComments.current = [];
		render(wrap(<CommentsPanel projectId="p1" storyId="s1" />));
		fireEvent.change(await screen.findByRole("textbox"), {
			target: { value: "first post" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^comment$/i }));
		await vi.waitFor(() =>
			expect(storyCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					content: "first post",
					parentId: undefined,
				}),
			),
		);
	});

	it("clears reply mode on ✕ but keeps typed content", async () => {
		storyComments.current = [mk("root", null, "Alice")];
		render(wrap(<CommentsPanel projectId="p1" storyId="s1" />));
		fireEvent.click(
			await screen.findByRole("button", { name: /reply to alice/i }),
		);
		fireEvent.change(screen.getByRole("textbox"), {
			target: { value: "draft" },
		});
		fireEvent.click(screen.getByRole("button", { name: /cancel reply/i }));
		expect(screen.queryByText(/replying to/i)).toBeNull();
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
			"draft",
		);
	});

	it("moves focus to the composer when Reply is clicked (a11y)", async () => {
		storyComments.current = [mk("root", null, "Alice")];
		render(wrap(<CommentsPanel projectId="p1" storyId="s1" />));
		fireEvent.click(
			await screen.findByRole("button", { name: /reply to alice/i }),
		);
		expect(document.activeElement).toBe(screen.getByRole("textbox"));
	});
});

describe("CommentsPanel — large-group confirm gate (#1767 Stage 5)", () => {
	it("does not fetch group counts for a comment without an @@ token", async () => {
		render(wrap(<CommentsPanel projectId="p1" storyId="s1" />));
		fireEvent.change(await screen.findByRole("textbox"), {
			target: { value: "just a normal comment" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^comment$/i }));
		await vi.waitFor(() => expect(storyCreate).toHaveBeenCalledTimes(1));
		// No `@@` → the confirm gate must not issue any extra request.
		expect(groupMemberCounts).not.toHaveBeenCalled();
	});

	it("posts directly (no confirm) when the addressed group is at or below the threshold", async () => {
		groupMemberCounts.mockResolvedValue({ DEVELOPER: 3 });
		render(wrap(<CommentsPanel projectId="p1" storyId="s1" />));
		fireEvent.change(await screen.findByRole("textbox"), {
			target: { value: "ping @@developers" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^comment$/i }));
		await vi.waitFor(() => expect(storyCreate).toHaveBeenCalledTimes(1));
		expect(groupMemberCounts).toHaveBeenCalledWith({ projectId: "p1" });
		expect(screen.queryByText(/Notify .* people\?/)).toBeNull();
	});

	it("prompts a confirm for a large group and only posts after confirming", async () => {
		groupMemberCounts.mockResolvedValue({ DEVELOPER: 15 });
		render(wrap(<CommentsPanel projectId="p1" storyId="s1" />));
		fireEvent.change(await screen.findByRole("textbox"), {
			target: { value: "@@developers ship it" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^comment$/i }));

		// Confirm dialog appears; the comment is NOT posted yet.
		expect(
			await screen.findByText("Notify 15 people?"),
		).toBeInTheDocument();
		expect(storyCreate).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: /^notify$/i }));
		await vi.waitFor(() => expect(storyCreate).toHaveBeenCalledTimes(1));
	});

	it("fails open — posts the comment when the counts fetch throws", async () => {
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		groupMemberCounts.mockRejectedValue(new Error("counts down"));
		render(wrap(<CommentsPanel projectId="p1" storyId="s1" />));
		fireEvent.change(await screen.findByRole("textbox"), {
			target: { value: "@@developers heads up" },
		});
		fireEvent.click(screen.getByRole("button", { name: /^comment$/i }));
		await vi.waitFor(() => expect(storyCreate).toHaveBeenCalledTimes(1));
		expect(screen.queryByText(/Notify .* people\?/)).toBeNull();
		errorSpy.mockRestore();
	});
});
