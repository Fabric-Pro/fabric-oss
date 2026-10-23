import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		class ResizeObserverPolyfill {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		}
		(
			globalThis as unknown as {
				ResizeObserver: typeof ResizeObserverPolyfill;
			}
		).ResizeObserver = ResizeObserverPolyfill;
	}
	if (!HTMLElement.prototype.hasPointerCapture) {
		HTMLElement.prototype.hasPointerCapture = (() => false) as never;
	}
	if (!HTMLElement.prototype.scrollIntoView) {
		HTMLElement.prototype.scrollIntoView = (() => undefined) as never;
	}
});

const {
	pagesMock,
	pageContentMock,
	contextCreateMock,
	toastSuccessMock,
	toastWarningMock,
	toastErrorMock,
} = vi.hoisted(() => ({
	pagesMock: vi.fn(),
	pageContentMock: vi.fn(),
	contextCreateMock: vi.fn(),
	toastSuccessMock: vi.fn(),
	toastWarningMock: vi.fn(),
	toastErrorMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		dataConnections: {
			notion: {
				pages: (args: unknown) => pagesMock(args),
				pageContent: (args: unknown) => pageContentMock(args),
			},
		},
		projects: {
			contexts: {
				create: (args: unknown) => contextCreateMock(args),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: {
		success: (msg: string) => toastSuccessMock(msg),
		warning: (msg: string) => toastWarningMock(msg),
		error: (msg: string, opts?: unknown) =>
			opts !== undefined
				? toastErrorMock(msg, opts)
				: toastErrorMock(msg),
	},
}));

import { NotionIntegrationPageBrowser } from "../NotionIntegrationPageBrowser";

describe("NotionIntegrationPageBrowser", () => {
	let queryClient: QueryClient;

	beforeEach(() => {
		vi.clearAllMocks();
		queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
			},
		});
	});

	function renderBrowser(
		props?: Partial<
			React.ComponentProps<typeof NotionIntegrationPageBrowser>
		>,
	) {
		return render(
			<QueryClientProvider client={queryClient}>
				<NotionIntegrationPageBrowser
					open={true}
					onOpenChange={vi.fn()}
					connectionId="conn-123"
					projectId="proj-456"
					organizationId="org-789"
					syncedPageIds={[]}
					reconnectUrl="/settings/integrations/providers/NOTION"
					{...props}
				/>
			</QueryClientProvider>,
		);
	}

	it("renders page list, marks synced pages with normalized IDs, and allows selecting un-synced pages", async () => {
		pagesMock.mockResolvedValueOnce({
			pages: [
				{
					id: "page-1111-2222",
					title: "Already Synced Page",
					url: "https://notion.so/page1",
					lastEdited: "2026-10-21T00:00:00.000Z",
					icon: "📄",
				},
				{
					id: "page-3333-4444",
					title: "Available Page",
					url: "https://notion.so/page2",
					lastEdited: "2026-10-21T00:00:00.000Z",
					icon: null,
				},
			],
			nextCursor: null,
		});

		// Pass syncedPageId without dashes to test ID normalization
		renderBrowser({
			syncedPageIds: ["page11112222"],
		});

		expect(
			await screen.findByText("Already Synced Page"),
		).toBeInTheDocument();
		expect(screen.getByText("Available Page")).toBeInTheDocument();
		expect(screen.getByText("Synced")).toBeInTheDocument();

		const checkboxes = screen.getAllByRole("checkbox");
		expect(checkboxes).toHaveLength(1); // Only for Available Page

		// Click to select
		await userEvent.click(checkboxes[0]);
		expect(screen.getByText("Add 1 Page")).toBeInTheDocument();
	});

	it("fetches page content and creates project context on confirm", async () => {
		const onResourcesAdded = vi.fn();
		const onOpenChange = vi.fn();

		pagesMock.mockResolvedValueOnce({
			pages: [
				{
					id: "page-3333-4444",
					title: "Available Page",
					url: "https://notion.so/page2",
					lastEdited: "2026-10-21T00:00:00.000Z",
					icon: null,
				},
			],
			nextCursor: null,
		});

		pageContentMock.mockResolvedValueOnce({
			content: "# Available Page Content",
		});

		contextCreateMock.mockResolvedValueOnce({ id: "ctx-1" });

		renderBrowser({
			onResourcesAdded,
			onOpenChange,
		});

		expect(await screen.findByText("Available Page")).toBeInTheDocument();
		const checkbox = screen.getByRole("checkbox");
		await userEvent.click(checkbox);

		const addButton = screen.getByRole("button", { name: "Add 1 Page" });
		await userEvent.click(addButton);

		await waitFor(() => {
			expect(pageContentMock).toHaveBeenCalledWith({
				id: "conn-123",
				pageId: "page-3333-4444",
				organizationId: "org-789",
			});
			expect(contextCreateMock).toHaveBeenCalledWith({
				projectId: "proj-456",
				organizationId: "org-789",
				type: "INTEGRATION",
				content: "# Available Page Content",
				metadata: {
					notionPageId: "page-3333-4444",
					notionType: "page",
					provider: "notion",
					dataConnectionId: "conn-123",
					sourceTitle: "Available Page",
					sourceUrl: "https://notion.so/page2",
				},
			});
			expect(toastSuccessMock).toHaveBeenCalledWith(
				"Added 1 page to project",
			);
			expect(onResourcesAdded).toHaveBeenCalled();
			expect(onOpenChange).toHaveBeenCalledWith(false);
		});
	});

	it("handles Load more pagination", async () => {
		pagesMock
			.mockResolvedValueOnce({
				pages: [
					{
						id: "p1",
						title: "Batch 1 Page",
						url: "https://notion.so/p1",
						lastEdited: "2026-10-21T00:00:00.000Z",
						icon: null,
					},
				],
				nextCursor: "cursor-batch-2",
			})
			.mockResolvedValueOnce({
				pages: [
					{
						id: "p2",
						title: "Batch 2 Page",
						url: "https://notion.so/p2",
						lastEdited: "2026-10-21T00:00:00.000Z",
						icon: null,
					},
				],
				nextCursor: null,
			});

		renderBrowser();

		expect(await screen.findByText("Batch 1 Page")).toBeInTheDocument();
		const loadMoreBtn = screen.getByRole("button", { name: "Load more" });
		await userEvent.click(loadMoreBtn);

		expect(await screen.findByText("Batch 2 Page")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Load more" }),
		).not.toBeInTheDocument();
	});

	it("displays unauthorized expiration message with reconnect link when 401 occurs", async () => {
		const unauthorizedError = new Error("Notion connection expired");
		(unauthorizedError as any).code = "UNAUTHORIZED";
		pagesMock.mockRejectedValueOnce(unauthorizedError);

		renderBrowser({
			reconnectUrl:
				"/app/example-org/settings/integrations/providers/NOTION",
		});

		expect(
			await screen.findByText("Notion connection expired"),
		).toBeInTheDocument();
		const reconnectLink = screen.getByRole("link", {
			name: "Reconnect Notion",
		});
		expect(reconnectLink).toHaveAttribute(
			"href",
			"/app/example-org/settings/integrations/providers/NOTION",
		);
	});

	it("handles partial failure: one page fails, the others are still added, and the list refreshes", async () => {
		const onResourcesAdded = vi.fn();
		const onOpenChange = vi.fn();

		pagesMock.mockResolvedValueOnce({
			pages: [
				{
					id: "p-success",
					title: "Successful Page",
					url: "https://notion.so/p-success",
					lastEdited: "2026-10-21T00:00:00.000Z",
					icon: null,
				},
				{
					id: "p-fail",
					title: "Failing Page",
					url: "https://notion.so/p-fail",
					lastEdited: "2026-10-21T00:00:00.000Z",
					icon: null,
				},
			],
			nextCursor: null,
		});

		pageContentMock.mockImplementation(
			async ({ pageId }: { pageId: string }) => {
				if (pageId === "p-fail") {
					throw new Error("Page not shared with Fabric");
				}
				return { content: "# Content" };
			},
		);

		contextCreateMock.mockResolvedValue({ id: "ctx-1" });

		renderBrowser({
			onResourcesAdded,
			onOpenChange,
		});

		expect(await screen.findByText("Successful Page")).toBeInTheDocument();
		expect(screen.getByText("Failing Page")).toBeInTheDocument();

		const checkboxes = screen.getAllByRole("checkbox");
		await userEvent.click(checkboxes[0]);
		await userEvent.click(checkboxes[1]);

		const addButton = screen.getByRole("button", { name: "Add 2 Pages" });
		await userEvent.click(addButton);

		await waitFor(() => {
			expect(contextCreateMock).toHaveBeenCalledTimes(1);
			expect(onResourcesAdded).toHaveBeenCalled();
			expect(toastWarningMock).toHaveBeenCalledWith(
				"Added 1 page, 1 failed",
			);
			// Dialog stays open so user can see what failed
			expect(onOpenChange).not.toHaveBeenCalled();
			// Failed page is still in selected count
			expect(screen.getByText("1 page selected")).toBeInTheDocument();
		});
	});

	it("preserves selection across searches and adds both pages", async () => {
		const onResourcesAdded = vi.fn();
		const onOpenChange = vi.fn();

		pagesMock.mockImplementation(async ({ query }: { query?: string }) => {
			if (query === "second") {
				return {
					pages: [
						{
							id: "p2",
							title: "Second Search Page",
							url: "https://notion.so/p2",
							lastEdited: "2026-10-21T00:00:00.000Z",
							icon: null,
						},
					],
					nextCursor: null,
				};
			}
			return {
				pages: [
					{
						id: "p1",
						title: "Initial Page",
						url: "https://notion.so/p1",
						lastEdited: "2026-10-21T00:00:00.000Z",
						icon: null,
					},
				],
				nextCursor: null,
			};
		});

		pageContentMock.mockResolvedValue({ content: "# Content" });
		contextCreateMock.mockResolvedValue({ id: "ctx-1" });

		renderBrowser({
			onResourcesAdded,
			onOpenChange,
		});

		// 1. Initial page loaded, select it
		expect(await screen.findByText("Initial Page")).toBeInTheDocument();
		const checkbox1 = screen.getByRole("checkbox");
		await userEvent.click(checkbox1);
		expect(screen.getByText("Add 1 Page")).toBeInTheDocument();

		// 2. Type "second" into search
		const searchInput = screen.getByPlaceholderText("Search pages...");
		await userEvent.type(searchInput, "second");

		// 3. Second page loaded, select it
		expect(
			await screen.findByText("Second Search Page"),
		).toBeInTheDocument();
		const checkbox2 = screen.getByRole("checkbox");
		await userEvent.click(checkbox2);

		// Both pages should be selected!
		expect(screen.getByText("Add 2 Pages")).toBeInTheDocument();

		const addButton = screen.getByRole("button", { name: "Add 2 Pages" });
		await userEvent.click(addButton);

		await waitFor(() => {
			expect(contextCreateMock).toHaveBeenCalledTimes(2);
			expect(onResourcesAdded).toHaveBeenCalled();
			expect(toastSuccessMock).toHaveBeenCalledWith(
				"Added 2 pages to project",
			);
			expect(onOpenChange).toHaveBeenCalledWith(false);
		});
	});

	it("disables selection and prevents dialog close while adding pages", async () => {
		const onOpenChange = vi.fn();

		pagesMock.mockResolvedValueOnce({
			pages: [
				{
					id: "p1",
					title: "Pending Page",
					url: "https://notion.so/p1",
					lastEdited: "2026-10-21T00:00:00.000Z",
					icon: null,
				},
			],
			nextCursor: null,
		});

		let resolveCreate: (val: unknown) => void = () => {};
		const createPromise = new Promise((resolve) => {
			resolveCreate = resolve;
		});

		pageContentMock.mockResolvedValueOnce({ content: "# Content" });
		contextCreateMock.mockReturnValueOnce(createPromise);

		renderBrowser({
			onOpenChange,
		});

		expect(await screen.findByText("Pending Page")).toBeInTheDocument();
		const checkbox = screen.getByRole("checkbox");
		await userEvent.click(checkbox);

		const addButton = screen.getByRole("button", { name: "Add 1 Page" });
		await userEvent.click(addButton);

		// In-flight: controls should be disabled
		expect(checkbox).toBeDisabled();
		const selectAllBtn = screen.getByRole("button", {
			name: "Deselect All",
		});
		expect(selectAllBtn).toBeDisabled();
		const cancelBtn = screen.getByRole("button", { name: "Cancel" });
		expect(cancelBtn).toBeDisabled();

		// User trying to click cancel should not trigger onOpenChange
		await userEvent.click(cancelBtn);
		expect(onOpenChange).not.toHaveBeenCalled();

		// Complete the in-flight creation
		resolveCreate({ id: "ctx-1" });

		await waitFor(() => {
			expect(onOpenChange).toHaveBeenCalledWith(false);
		});
	});

	it("shows reconnect hint when connection expires with UNAUTHORIZED during add", async () => {
		pagesMock.mockResolvedValueOnce({
			pages: [
				{
					id: "p1",
					title: "Expiring Page",
					url: "https://notion.so/p1",
					lastEdited: "2026-10-21T00:00:00.000Z",
					icon: null,
				},
			],
			nextCursor: null,
		});

		const unauthError = new Error("Notion connection expired");
		(unauthError as any).code = "UNAUTHORIZED";
		pageContentMock.mockRejectedValueOnce(unauthError);

		renderBrowser();

		expect(await screen.findByText("Expiring Page")).toBeInTheDocument();
		const checkbox = screen.getByRole("checkbox");
		await userEvent.click(checkbox);

		const addButton = screen.getByRole("button", { name: "Add 1 Page" });
		await userEvent.click(addButton);

		await waitFor(() => {
			expect(toastErrorMock).toHaveBeenCalledWith(
				"Notion connection expired. Reconnect Notion.",
			);
		});
	});

	it("retains pages when dialog is closed and reopened", async () => {
		pagesMock.mockResolvedValueOnce({
			pages: [
				{
					id: "p1",
					title: "Persistent Page",
					url: "https://notion.so/p1",
					lastEdited: "2026-10-21T00:00:00.000Z",
					icon: null,
				},
			],
			nextCursor: null,
		});

		const { rerender } = renderBrowser({ open: true });

		expect(await screen.findByText("Persistent Page")).toBeInTheDocument();

		// Close dialog
		rerender(
			<QueryClientProvider client={queryClient}>
				<NotionIntegrationPageBrowser
					open={false}
					onOpenChange={vi.fn()}
					connectionId="conn-123"
					projectId="proj-456"
					organizationId="org-789"
					syncedPageIds={[]}
					reconnectUrl="/settings/integrations/providers/NOTION"
				/>
			</QueryClientProvider>,
		);

		expect(screen.queryByText("Persistent Page")).not.toBeInTheDocument();

		// Reopen dialog without query refetch (query returns cached initialData)
		rerender(
			<QueryClientProvider client={queryClient}>
				<NotionIntegrationPageBrowser
					open={true}
					onOpenChange={vi.fn()}
					connectionId="conn-123"
					projectId="proj-456"
					organizationId="org-789"
					syncedPageIds={[]}
					reconnectUrl="/settings/integrations/providers/NOTION"
				/>
			</QueryClientProvider>,
		);

		expect(await screen.findByText("Persistent Page")).toBeInTheDocument();
	});
});
