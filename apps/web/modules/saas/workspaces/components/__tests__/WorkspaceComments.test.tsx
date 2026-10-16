/**
 * The comments on a Workspace page: read through the page's own comment tool,
 * oldest first, a page at a time, and added through its add tool below them. A
 * comment is what a person wrote, so it is drawn as text.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	callFabricTool: vi.fn(),
	toast: { error: vi.fn(), message: vi.fn(), success: vi.fn() },
}));

vi.mock("@saas/mcp/lib/fabric-tool-client", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@saas/mcp/lib/fabric-tool-client")
	>()),
	callFabricTool: mocks.callFabricTool,
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));

import { FabricToolError } from "@saas/mcp/lib/fabric-tool-client";
import { WorkspaceComments } from "../WorkspaceComments";

const FIRST = {
	id: "c1",
	text: "Looks right to me.",
	at: "2026-10-13T10:00:00.000Z",
	author: { id: "u2", name: "Sam Example" },
};
const SECOND = {
	id: "c2",
	text: "Can we add last week?",
	at: "2026-10-14T10:00:00.000Z",
	author: { id: "u1", name: "Alex Example" },
};

function renderComments() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return render(
		<WorkspaceComments frameId="frame-1" organizationId="org-1" />,
		{ wrapper },
	);
}

function answerList(answers: Array<unknown | Error>) {
	const queue = [...answers];
	mocks.callFabricTool.mockImplementation(async (name: string) => {
		if (name !== "fabric_page_comment_list") {
			return { ok: true };
		}
		const next = queue.length > 1 ? queue.shift() : queue[0];
		if (next instanceof Error) {
			throw next;
		}
		return next;
	});
}

const listCalls = () =>
	mocks.callFabricTool.mock.calls.filter(
		([name]) => name === "fabric_page_comment_list",
	);

beforeEach(() => {
	vi.clearAllMocks();
});

describe("reading the comments", () => {
	it("asks the page's comment tool for the first page, in the organization of the page", async () => {
		answerList([{ comments: [FIRST, SECOND] }]);

		renderComments();

		await screen.findByText("Looks right to me.");
		expect(listCalls()[0]).toEqual([
			"fabric_page_comment_list",
			{ frameId: "frame-1", limit: 50 },
			expect.objectContaining({ organizationId: "org-1" }),
		]);
	});

	it("shows each comment with who wrote it and when, in the order the tool gave", async () => {
		answerList([{ comments: [FIRST, SECOND] }]);

		renderComments();

		const items = await screen.findAllByRole("listitem");
		expect(items).toHaveLength(2);
		expect(items[0]).toHaveTextContent("Sam Example");
		expect(items[0]).toHaveTextContent("Looks right to me.");
		expect(items[1]).toHaveTextContent("Alex Example");
		expect(within(items[0]).getByText(/ago$/)).toHaveAttribute(
			"datetime",
			FIRST.at,
		);
	});

	it("shows a comment as the text it is, never as markup", async () => {
		answerList([
			{
				comments: [
					{ ...FIRST, text: "<img src=x onerror=alert(1)> **bold**" },
				],
			},
		]);

		const { container } = renderComments();

		await screen.findByText("<img src=x onerror=alert(1)> **bold**");
		expect(container.querySelector("img")).toBeNull();
		expect(container.querySelector("strong")).toBeNull();
	});

	it("says so when there are none", async () => {
		answerList([{ comments: [] }]);

		renderComments();

		expect(await screen.findByText(/No comments yet/)).toBeInTheDocument();
		expect(screen.queryByRole("list")).toBeNull();
	});

	it("shows a loading state while it waits", () => {
		mocks.callFabricTool.mockReturnValue(new Promise(() => {}));

		renderComments();

		expect(
			screen.getByRole("status", { name: "Loading comments" }),
		).toBeInTheDocument();
	});

	it("says it could not load them, and tries again on request", async () => {
		answerList([new Error("offline"), { comments: [FIRST] }]);

		renderComments();
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"The comments could not be loaded.",
		);
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));

		expect(
			await screen.findByText("Looks right to me."),
		).toBeInTheDocument();
		expect(listCalls()).toHaveLength(2);
	});

	it("keeps the comments it has when the next page fails, and tries that page again on request", async () => {
		let failNext = true;
		mocks.callFabricTool.mockImplementation(
			async (_name: string, args: { cursor?: string }) => {
				if (!args.cursor) {
					return { comments: [FIRST], nextCursor: "cursor-1" };
				}
				if (failNext) {
					failNext = false;
					throw new Error("offline");
				}
				return { comments: [SECOND] };
			},
		);
		renderComments();
		await screen.findByText("Looks right to me.");

		fireEvent.click(
			screen.getByRole("button", { name: "Show more comments" }),
		);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"More comments could not be loaded.",
		);
		expect(screen.getByText("Looks right to me.")).toBeInTheDocument();
		expect(
			screen.queryByText("The comments could not be loaded."),
		).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));

		expect(
			await screen.findByText("Can we add last week?"),
		).toBeInTheDocument();
		expect(screen.getByText("Looks right to me.")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("keeps the comments it has when a refresh fails, and refreshes again on request", async () => {
		let lists = 0;
		mocks.callFabricTool.mockImplementation(async (name: string) => {
			if (name === "fabric_page_comment_add") {
				return { comments: [] };
			}
			lists += 1;
			if (lists === 2) {
				throw new Error("offline");
			}
			return { comments: [FIRST] };
		});
		renderComments();
		await screen.findByText("Looks right to me.");

		fireEvent.change(screen.getByLabelText("Add a comment"), {
			target: { value: "Thanks" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Comment" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"The comments could not be refreshed.",
		);
		expect(screen.getByText("Looks right to me.")).toBeInTheDocument();
		expect(
			screen.queryByText("The comments could not be loaded."),
		).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));

		await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
		expect(screen.getByText("Looks right to me.")).toBeInTheDocument();
	});

	it("treats an answer it cannot read as a failure rather than drawing it", async () => {
		mocks.callFabricTool.mockImplementation(
			async (
				_name: string,
				_args: unknown,
				options: { schema: { parse: (value: unknown) => unknown } },
			) => options.schema.parse({ comments: [{ id: 1 }] }),
		);

		renderComments();

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"The comments could not be loaded.",
		);
	});

	it("offers the next comments when there are more, and adds them below the first", async () => {
		answerList([
			{ comments: [FIRST], nextCursor: "cursor-1" },
			{ comments: [SECOND], nextCursor: null },
		]);

		renderComments();
		await screen.findByText("Looks right to me.");
		fireEvent.click(
			screen.getByRole("button", { name: "Show more comments" }),
		);

		await screen.findByText("Can we add last week?");
		expect(listCalls()[1][1]).toEqual({
			frameId: "frame-1",
			limit: 50,
			cursor: "cursor-1",
		});
		const items = screen.getAllByRole("listitem");
		expect(items[0]).toHaveTextContent("Looks right to me.");
		expect(items[1]).toHaveTextContent("Can we add last week?");
		expect(
			screen.queryByRole("button", { name: "Show more comments" }),
		).toBeNull();
	});

	it("offers no more comments when the tool gave no cursor", async () => {
		answerList([{ comments: [FIRST] }]);

		renderComments();
		await screen.findByText("Looks right to me.");

		expect(
			screen.queryByRole("button", { name: "Show more comments" }),
		).toBeNull();
	});

	it("puts the box to add a comment below the comments", async () => {
		answerList([{ comments: [FIRST, SECOND] }]);

		renderComments();
		await screen.findByText("Looks right to me.");

		const list = screen.getByRole("list");
		const box = screen.getByLabelText("Add a comment");
		expect(
			list.compareDocumentPosition(box) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});
});

describe("adding a comment", () => {
	it("sends the trimmed text to the page's add tool, clears the box and reads the comments again", async () => {
		answerList([{ comments: [FIRST] }]);
		renderComments();
		await screen.findByText("Looks right to me.");

		fireEvent.change(screen.getByLabelText("Add a comment"), {
			target: { value: "  Thanks, shipping it.  " },
		});
		fireEvent.click(screen.getByRole("button", { name: "Comment" }));

		await waitFor(() =>
			expect(mocks.callFabricTool).toHaveBeenCalledWith(
				"fabric_page_comment_add",
				{ frameId: "frame-1", text: "Thanks, shipping it." },
				{ organizationId: "org-1" },
			),
		);
		await waitFor(() => expect(listCalls()).toHaveLength(2));
		expect(screen.getByLabelText("Add a comment")).toHaveValue("");
	});

	it("does not send an empty comment", async () => {
		answerList([{ comments: [] }]);
		renderComments();
		await screen.findByText(/No comments yet/);

		const button = screen.getByRole("button", { name: "Comment" });
		expect(button).toBeDisabled();
		fireEvent.change(screen.getByLabelText("Add a comment"), {
			target: { value: "   " },
		});

		expect(button).toBeDisabled();
		fireEvent.submit(button.closest("form") as HTMLFormElement);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(
			mocks.callFabricTool.mock.calls.filter(
				([name]) => name === "fabric_page_comment_add",
			),
		).toEqual([]);
	});

	async function failToAdd(error: Error) {
		mocks.callFabricTool.mockImplementation(async (name: string) => {
			if (name === "fabric_page_comment_add") {
				throw error;
			}
			return { comments: [] };
		});
		renderComments();
		await screen.findByText(/No comments yet/);
		fireEvent.change(screen.getByLabelText("Add a comment"), {
			target: { value: "Hello" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Comment" }));
	}

	it("keeps what was written and says it could not be added, without the tool's id or an HTTP status", async () => {
		await failToAdd(
			new FabricToolError(
				"fabric_page_comment_add failed with HTTP 503",
				"fabric_page_comment_add",
			),
		);

		await waitFor(() =>
			expect(mocks.toast.error).toHaveBeenCalledWith(
				"Could not add your comment",
				{ description: "Please try again." },
			),
		);
		expect(mocks.toast.message).not.toHaveBeenCalled();
		expect(screen.getByLabelText("Add a comment")).toHaveValue("Hello");
	});

	it.each([
		[
			"rate_limited",
			"Too many writes on this page. Try again in 20 seconds.",
		],
		["limit", "A page holds at most 2000 records."],
	])(
		"says what the tool said when it refused for %s",
		async (reason, message) => {
			await failToAdd(
				new FabricToolError(message, "fabric_page_comment_add", {
					reason,
				}),
			);

			await waitFor(() =>
				expect(mocks.toast.error).toHaveBeenCalledWith(
					"Could not add your comment",
					{ description: message },
				),
			);
		},
	);

	it("says a comment was added, and clears the box", async () => {
		answerList([{ comments: [FIRST] }]);
		renderComments();
		await screen.findByText("Looks right to me.");

		fireEvent.change(screen.getByLabelText("Add a comment"), {
			target: { value: "Thanks" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Comment" }));

		await waitFor(() =>
			expect(mocks.toast.success).toHaveBeenCalledWith("Comment added"),
		);
		expect(screen.getByLabelText("Add a comment")).toHaveValue("");
	});

	it("says to try again, rather than that it failed, when the page is busy, and keeps what was written", async () => {
		mocks.callFabricTool.mockImplementation(async (name: string) => {
			if (name === "fabric_page_comment_add") {
				throw new FabricToolError(
					"The page is busy. Try again in a moment.",
					"fabric_page_comment_add",
					{ reason: "busy", retryable: true },
				);
			}
			return { comments: [] };
		});
		renderComments();
		await screen.findByText(/No comments yet/);

		fireEvent.change(screen.getByLabelText("Add a comment"), {
			target: { value: "Hello" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Comment" }));

		await waitFor(() =>
			expect(mocks.toast.message).toHaveBeenCalledWith(
				"The page is busy",
				{ description: "Try again in a moment." },
			),
		);
		expect(mocks.toast.error).not.toHaveBeenCalled();
		expect(screen.getByLabelText("Add a comment")).toHaveValue("Hello");
	});

	it("reads on to the newest comment when the thread is longer than one page, so the new one shows", async () => {
		const pages = [
			{ comments: [FIRST], nextCursor: "cursor-1" },
			{ comments: [SECOND] },
		];
		mocks.callFabricTool.mockImplementation(
			async (name: string, args: { cursor?: string }) => {
				if (name === "fabric_page_comment_add") {
					return { comments: [] };
				}
				return args.cursor ? pages[1] : pages[0];
			},
		);
		renderComments();
		await screen.findByText("Looks right to me.");

		fireEvent.change(screen.getByLabelText("Add a comment"), {
			target: { value: "Thanks" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Comment" }));

		expect(
			await screen.findByText("Can we add last week?"),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Show more comments" }),
		).toBeNull();
	});

	it("limits a comment to 2,000 characters and counts only when the limit is near", async () => {
		answerList([{ comments: [] }]);
		renderComments();
		await screen.findByText(/No comments yet/);
		const box = screen.getByLabelText("Add a comment");

		expect(box).toHaveAttribute("maxlength", "2000");
		expect(screen.queryByText(/\/ 2000/)).toBeNull();
		fireEvent.change(box, { target: { value: "a".repeat(1700) } });

		expect(screen.getByText("1700 / 2000")).toBeInTheDocument();
	});
});
