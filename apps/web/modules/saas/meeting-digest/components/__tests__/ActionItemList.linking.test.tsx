import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	setActionItemCompleted,
	proposeActionItem,
	addActionItemLink,
	removeActionItemLink,
	listStories,
} = vi.hoisted(() => ({
	setActionItemCompleted: vi.fn().mockResolvedValue({ success: true }),
	proposeActionItem: vi.fn(),
	addActionItemLink: vi.fn(),
	removeActionItemLink: vi.fn(),
	listStories: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			meetingDigest: {
				setActionItemCompleted,
				proposeActionItem,
				addActionItemLink,
				removeActionItemLink,
			},
			stories: { list: listStories },
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ basePath: "/app/acme" }),
}));

import { ActionItemList } from "../ActionItemList";

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

const ITEM_KEY = "key-a";

const item = {
	id: "a1",
	text: "Ship the digest download",
	tentativeOwnerName: null,
	dueHint: null,
	completedAt: null,
	itemKey: ITEM_KEY,
};

const existingLink = {
	id: "l1",
	itemKey: ITEM_KEY,
	storyId: "s1",
	origin: "AUTO" as const,
	confidence: 0.9,
	similarity: 0.8,
	reasoning: null,
	identifier: "F-1",
	title: "Digest download",
	statusName: null,
	isDone: false,
};

function renderList(
	overrides: Partial<Parameters<typeof ActionItemList>[0]> = {},
) {
	const onLinksChanged = vi.fn();
	render(
		<ActionItemList
			projectId="p1"
			organizationId="org1"
			items={[item]}
			onToggled={vi.fn()}
			linksByItemKey={{}}
			onLinksChanged={onLinksChanged}
			{...overrides}
		/>,
		{ wrapper },
	);
	return { onLinksChanged };
}

beforeEach(() => {
	vi.clearAllMocks();
	listStories.mockResolvedValue({
		statuses: [],
		stories: [
			{ id: "s1", identifier: "F-1", title: "Digest download" },
			{ id: "s2", identifier: "F-2", title: "Agenda generation" },
		],
	});
	addActionItemLink.mockResolvedValue({ linkId: "new-link" });
	removeActionItemLink.mockResolvedValue({ removed: true });
});

describe("manual linking (FR4/AC7)", () => {
	it("offers a link control on an item that has no links at all", () => {
		renderList();
		expect(
			screen.getByRole("button", { name: "Link work item" }),
		).toBeInTheDocument();
	});

	it("does not offer link controls when the caller renders no links (AgendaView)", () => {
		renderList({ linksByItemKey: undefined });
		expect(
			screen.queryByRole("button", { name: "Link work item" }),
		).toBeNull();
	});

	it("saves the picked work item against the action item", async () => {
		const { onLinksChanged } = renderList();

		fireEvent.click(screen.getByRole("button", { name: "Link work item" }));
		fireEvent.click(await screen.findByRole("button", { name: /F-2/ }));

		await waitFor(() =>
			expect(addActionItemLink).toHaveBeenCalledWith({
				projectId: "p1",
				organizationId: "org1",
				actionItemId: "a1",
				storyId: "s2",
			}),
		);
		// The digest must refetch, or the new chip would not appear until reload.
		await waitFor(() => expect(onLinksChanged).toHaveBeenCalled());
	});

	it("does not offer a work item that is already linked to this item", async () => {
		renderList({ linksByItemKey: { [ITEM_KEY]: [existingLink] } });

		fireEvent.click(screen.getByRole("button", { name: "Link work item" }));

		expect(
			await screen.findByRole("button", { name: /F-2/ }),
		).toBeInTheDocument();
		// F-1 is already linked — re-picking it would be a no-op upsert.
		expect(
			screen.queryByRole("button", { name: /F-1 Digest download/ }),
		).toBeNull();
	});

	it("filters the list by the search term", async () => {
		renderList();
		fireEvent.click(screen.getByRole("button", { name: "Link work item" }));

		fireEvent.change(await screen.findByLabelText("Search work items"), {
			target: { value: "agenda" },
		});

		expect(
			await screen.findByRole("button", { name: /F-2/ }),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /F-1/ })).toBeNull();
	});

	it("keeps the dialog open and explains when the save fails", async () => {
		addActionItemLink.mockRejectedValue(new Error("nope"));
		const { onLinksChanged } = renderList();

		fireEvent.click(screen.getByRole("button", { name: "Link work item" }));
		fireEvent.click(await screen.findByRole("button", { name: /F-2/ }));

		expect(
			await screen.findByText("Could not add that link — try again."),
		).toBeInTheDocument();
		expect(onLinksChanged).not.toHaveBeenCalled();
	});
});

describe("removing a link (FR3)", () => {
	it("tombstones the link and refetches", async () => {
		const { onLinksChanged } = renderList({
			linksByItemKey: { [ITEM_KEY]: [existingLink] },
		});

		fireEvent.click(
			screen.getByRole("button", {
				name: "Remove link to F-1 Digest download",
			}),
		);

		await waitFor(() =>
			expect(removeActionItemLink).toHaveBeenCalledWith({
				projectId: "p1",
				organizationId: "org1",
				linkId: "l1",
			}),
		);
		await waitFor(() => expect(onLinksChanged).toHaveBeenCalled());
	});

	it("explains a failed removal instead of reading as a dead click", async () => {
		removeActionItemLink.mockRejectedValue(new Error("nope"));
		renderList({ linksByItemKey: { [ITEM_KEY]: [existingLink] } });

		fireEvent.click(
			screen.getByRole("button", {
				name: "Remove link to F-1 Digest download",
			}),
		);

		expect(
			await screen.findByText("Could not remove that link — try again."),
		).toBeInTheDocument();
	});
});
