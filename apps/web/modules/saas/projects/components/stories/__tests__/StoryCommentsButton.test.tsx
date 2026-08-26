import {
	focusManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserStory } from "../../../lib/stories/types";
import { StoryCommentsButton } from "../StoryCommentsButton";

const { commentsList } = vi.hoisted(() => ({ commentsList: vi.fn() }));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			stories: {
				comments: {
					list: {
						queryOptions: (args: { input: unknown }) => ({
							queryKey: ["story-comments", args.input],
							queryFn: () => commentsList(),
						}),
					},
				},
			},
		},
	},
}));

// Record the props CommentsPanel receives. This test guards the BUTTON's job
// (Sheet + story scope + explicit org + the count badge), not CommentsPanel
// internals — those are covered by CommentsPanel.test.tsx.
vi.mock("../CommentsPanel", () => ({
	CommentsPanel: (props: {
		projectId: string;
		storyId: string;
		taskId?: string;
		organizationId?: string | null;
	}) => (
		<div
			data-testid="comments-panel"
			data-project={props.projectId}
			data-story={props.storyId}
			data-task={String(props.taskId)}
			data-org={String(props.organizationId)}
		/>
	),
}));

const wrap = (ui: ReactNode) => (
	<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
);
const story = { id: "s1", identifier: "F-1" } as unknown as UserStory;
const props = {
	story,
	projectId: "p1",
	organizationId: "org-1" as string | null,
};

beforeEach(() => {
	commentsList.mockReset().mockResolvedValue({ comments: [] });
});

beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		globalThis.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as typeof ResizeObserver;
	}
	// Radix Dialog (Sheet) touches these in jsdom.
	for (const m of [
		"hasPointerCapture",
		"setPointerCapture",
		"releasePointerCapture",
		"scrollIntoView",
	] as const) {
		if (!(m in Element.prototype)) {
			// @ts-expect-error augment jsdom Element
			Element.prototype[m] = () => false;
		}
	}
});

describe("StoryCommentsButton", () => {
	it("renders the comments button unconditionally (no flag gating)", () => {
		render(wrap(<StoryCommentsButton {...props} />));
		expect(
			screen.getByRole("button", { name: /comments/i }),
		).toBeInTheDocument();
	});

	it("does not mount CommentsPanel until the sheet opens", () => {
		render(wrap(<StoryCommentsButton {...props} />));
		expect(screen.queryByTestId("comments-panel")).not.toBeInTheDocument();
	});

	it("opens the sheet and mounts CommentsPanel in story scope (no taskId) with the explicit org id", async () => {
		render(wrap(<StoryCommentsButton {...props} />));
		fireEvent.click(screen.getByRole("button", { name: /comments/i }));
		const panel = await screen.findByTestId("comments-panel");
		expect(panel).toHaveAttribute("data-project", "p1");
		expect(panel).toHaveAttribute("data-story", "s1");
		expect(panel).toHaveAttribute("data-org", "org-1");
		expect(panel).toHaveAttribute("data-task", "undefined"); // no taskId → story scope
	});

	it("shows no badge and a muted icon when there are no comments (AC-3)", async () => {
		commentsList.mockResolvedValue({ comments: [] });
		render(wrap(<StoryCommentsButton {...props} />));
		const btn = screen.getByRole("button", { name: /comments/i });
		await new Promise((r) => setTimeout(r, 0)); // settle the query
		expect(btn.className).toContain("text-muted-foreground");
		expect(screen.queryByText("0")).not.toBeInTheDocument();
	});

	it("shows the numeric comment count when comments exist (AC-1/AC-2, supersedes #1778 AC-10)", async () => {
		commentsList.mockResolvedValue({
			comments: [{ id: "c1" }, { id: "c2" }],
		});
		render(wrap(<StoryCommentsButton {...props} />));
		expect(await screen.findByText("2")).toBeInTheDocument();
	});

	it("keeps the icon muted regardless of count (parity with attachments, DEC-3)", async () => {
		commentsList.mockResolvedValue({ comments: [{ id: "c1" }] });
		render(wrap(<StoryCommentsButton {...props} />));
		await screen.findByText("1");
		expect(
			screen.getByRole("button", { name: /comments/i }).className,
		).toContain("text-muted-foreground");
	});

	it("still opens the sidebar when clicked with a badge present (AC-6)", async () => {
		commentsList.mockResolvedValue({
			comments: [{ id: "c1" }, { id: "c2" }],
		});
		render(wrap(<StoryCommentsButton {...props} />));
		await screen.findByText("2");
		fireEvent.click(screen.getByRole("button", { name: /comments/i }));
		expect(await screen.findByTestId("comments-panel")).toBeInTheDocument();
	});

	it("refreshes the badge when a pending @fabric reply lands (button's own poll, sidebar closed)", async () => {
		// Model a focused tab so React Query's interval actually refetches
		// (v5 gates interval refetches on focusManager.isFocused()). Real timers:
		// fake timers fire the interval but don't flush React's committed render.
		focusManager.setFocused(true);
		try {
			let landed = false;
			// Recent createdAt so the mention is inside the poll window.
			const createdAt = new Date().toISOString();
			commentsList.mockImplementation(() =>
				Promise.resolve({
					comments: landed
						? [
								{
									id: "c1",
									authorType: "USER",
									workflowId: "wf1",
									createdAt,
								},
								{
									id: "a1",
									authorType: "AGENT",
									sourceCommentId: "c1",
								},
							]
						: [
								{
									id: "c1",
									authorType: "USER",
									workflowId: "wf1",
									createdAt,
								},
							],
				}),
			);
			render(wrap(<StoryCommentsButton {...props} />));
			// Initial fetch → one comment (the pending @fabric mention).
			expect(await screen.findByText("1")).toBeInTheDocument();
			// The agent reply is persisted server-side; the button's 3s poll picks it up.
			landed = true;
			await waitFor(
				() => expect(screen.getByText("2")).toBeInTheDocument(),
				{ timeout: 5000 },
			);
		} finally {
			focusManager.setFocused(undefined);
		}
	}, 10000);
});
