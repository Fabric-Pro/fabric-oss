import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Fizzy #2286: the Slack/Teams teaser links to `?releaseNote=<sendId>`; the
// Release Notes tab must open THAT note even when it is not on the first page.

const { mocks } = vi.hoisted(() => {
	const replace = vi.fn();
	return {
		mocks: {
			search: "",
			replace,
			router: { replace },
			memberGet: vi.fn(),
		},
	};
});

vi.mock("next/navigation", () => ({
	useRouter: () => mocks.router,
	usePathname: () => "/app/example-org/projects/p1",
	useSearchParams: () => new URLSearchParams(mocks.search),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		newsletter: {
			sends: {
				memberList: {
					queryOptions: (o: { input: unknown }) => ({
						queryKey: ["memberList", o.input],
						queryFn: async () => ({ sends: [], total: 0 }),
					}),
				},
				memberGet: {
					queryOptions: (o: {
						input: { sendId: string };
						enabled?: boolean;
						retry?: boolean;
					}) => ({
						queryKey: ["memberGet", o.input],
						queryFn: () => mocks.memberGet(o.input),
						enabled: o.enabled,
						retry: o.retry,
					}),
				},
			},
		},
	},
}));

vi.mock("@saas/get-started/components/PageTourButton", () => ({
	PageTourButton: () => null,
}));

vi.mock("../ReleaseNoteDetailModal", () => ({
	ReleaseNoteDetailModal: ({
		open,
		onOpenChange,
		content,
	}: {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		content: { headline: string } | null;
	}) =>
		open ? (
			<div role="dialog">
				{content?.headline}
				<button type="button" onClick={() => onOpenChange(false)}>
					Close
				</button>
			</div>
		) : null,
}));

import { ReleaseNotesList } from "../ReleaseNotesList";

function renderList() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<ReleaseNotesList project={{ id: "p1", organizationId: "org-1" }} />
		</QueryClientProvider>,
	);
	return client;
}

beforeEach(() => {
	mocks.search = "";
	mocks.replace.mockReset();
	mocks.memberGet.mockReset();
});

describe("ReleaseNotesList ?releaseNote deep link", () => {
	it("opens the linked note even though it is not in the listed page", async () => {
		mocks.search = "releaseNote=s-old";
		mocks.memberGet.mockResolvedValue({
			id: "s-old",
			status: "SENT",
			createdAt: "2026-01-01T00:00:00.000Z",
			content: { headline: "Linked release", highlights: [] },
		});
		renderList();
		expect(await screen.findByRole("dialog")).toHaveTextContent(
			"Linked release",
		);
		expect(mocks.memberGet).toHaveBeenCalledWith({
			projectId: "p1",
			organizationId: "org-1",
			sendId: "s-old",
		});
		// Consumed once, so closing the modal does not reopen it on a later render.
		expect(mocks.replace).toHaveBeenCalledWith(
			"/app/example-org/projects/p1",
			{ scroll: false },
		);
	});

	it("does not reopen a closed note when the linked query refetches", async () => {
		mocks.search = "releaseNote=s-old";
		// A fresh object per fetch, as a real refetch returns.
		mocks.memberGet.mockImplementation(async () => ({
			id: "s-old",
			status: "SENT",
			createdAt: "2026-01-01T00:00:00.000Z",
			content: { headline: "Linked release", highlights: [] },
		}));
		const client = renderList();
		await screen.findByRole("dialog");
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(screen.queryByRole("dialog")).toBeNull();

		await act(() => client.refetchQueries({ queryKey: ["memberGet"] }));
		expect(mocks.memberGet).toHaveBeenCalledTimes(2);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("does not fetch or open anything without the param", async () => {
		renderList();
		await screen.findByText("No release notes yet.");
		expect(mocks.memberGet).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("leaves the list in place when the linked note no longer resolves", async () => {
		mocks.search = "releaseNote=gone";
		mocks.memberGet.mockRejectedValue(new Error("NOT_FOUND"));
		renderList();
		await screen.findByText("No release notes yet.");
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});
