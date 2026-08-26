/**
 * Accessibility tests for `<CopilotHistoryDrawer>`.
 *
 * Covers:
 *   - `vitest-axe` scan returns zero violations on the open drawer with
 *     three seeded conversations + one selected in the viewer.
 *   - Every icon-only button carries an accessible name (`aria-label`).
 *   - The visibility chip in the viewer header is NOT focusable as a
 *     button (it's metadata; a focusable chip would mislead keyboard
 *     users into thinking it's interactive).
 *   - The tablist + tab + tabpanel ARIA attributes are wired and
 *     reciprocally referenced via `aria-controls` / `aria-labelledby`.
 *   - Conversation rows expose `role="option"` inside a
 *     `role="listbox"`, so screen readers announce them as a selectable
 *     list.
 *
 * Why the hooks are mocked
 * ------------------------
 * The drawer's data layer is `useDocumentAssistantHistoryList` (returns
 * an infinite query) and `useActiveDocumentAssistantConversation`
 * (returns a single-page query). We replace them with stubs so the test
 * is hermetic — no MSW, no real TanStack Query — and exercises only the
 * presentation layer.
 *
 * Why we override the global `next-intl` mock locally
 * ---------------------------------------------------
 * `next-intl` is already stubbed in `vitest.setup.ts` but other modules
 * up the import chain (e.g. shadcn primitives) don't need it. No
 * override is necessary here.
 */

import { act, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import * as axeMatchers from "vitest-axe/matchers";

expect.extend(axeMatchers);

// Stable hoisted handles so the mock factory and the test bodies share
// the same vi.fn instances.
const { mockListResult, mockActiveResult, mockByIdResult } = vi.hoisted(() => ({
	mockListResult: {
		current: null as unknown,
	},
	mockActiveResult: {
		current: null as unknown,
	},
	mockByIdResult: {
		current: { data: undefined, isLoading: false } as unknown,
	},
}));

vi.mock(
	"../../modules/saas/projects/hooks/useDocumentAssistantHistory",
	() => ({
		useDocumentAssistantHistoryList: () => mockListResult.current,
		useActiveDocumentAssistantConversation: () => mockActiveResult.current,
		// Group F.13: viewer pane reads the per-conversation byId payload
		// when a non-active conversation is selected.
		useDocumentAssistantConversationById: () => mockByIdResult.current,
		useRenameDocumentAssistantConversation: () => ({ mutate: vi.fn() }),
		useDeleteDocumentAssistantConversation: () => ({ mutate: vi.fn() }),
		useForkDocumentAssistantConversation: () => ({
			mutate: vi.fn(),
			isPending: false,
		}),
	}),
);

// Sonner toasts are irrelevant to a11y; stub so calls don't break.
vi.mock("sonner", () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
	},
}));

import { CopilotHistoryDrawer } from "../../modules/saas/projects/components/copilot/CopilotHistoryDrawer";

const SEED_AUTHOR = "user-self";

function makeRow(overrides: {
	id: string;
	conversationId: string;
	title: string | null;
	updatedAt: string;
}) {
	return {
		id: overrides.id,
		conversationId: overrides.conversationId,
		title: overrides.title,
		messageCount: 3,
		firstPromptPreview: "Make the intro shorter, drop the redundant intro.",
		authorId: SEED_AUTHOR,
		authorName: "Test Author",
		authorAvatarUrl: null,
		visibility: "SHARED" as const,
		visibilityLockedAt: "2026-05-19T12:00:00.000Z",
		archivedAt: null,
		createdAt: "2026-05-19T12:00:00.000Z",
		updatedAt: overrides.updatedAt,
		parentConversationId: null,
	};
}

function primeListWithThreeSeedRows() {
	const now = new Date();
	const today = now.toISOString();
	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	const sixDaysAgo = new Date(now);
	sixDaysAgo.setDate(sixDaysAgo.getDate() - 6);
	mockListResult.current = {
		data: {
			pages: [
				{
					items: [
						makeRow({
							id: "row-1",
							conversationId: "conv-1",
							title: "Tighten the overview",
							updatedAt: today,
						}),
						makeRow({
							id: "row-2",
							conversationId: "conv-2",
							title: "Add risks section",
							updatedAt: yesterday.toISOString(),
						}),
						makeRow({
							id: "row-3",
							conversationId: "conv-3",
							title: null,
							updatedAt: sixDaysAgo.toISOString(),
						}),
					],
					nextCursor: null,
				},
			],
			pageParams: [undefined],
		},
		isLoading: false,
		isFetchingNextPage: false,
		hasNextPage: false,
		fetchNextPage: vi.fn(),
	};
}

function primeActiveWithSelectedConversation() {
	mockActiveResult.current = {
		data: {
			conversation: {
				id: "row-1",
				conversationId: "conv-1",
				title: "Tighten the overview",
				visibility: "SHARED",
				visibilityLockedAt: "2026-05-19T12:00:00.000Z",
				messages: [
					{
						id: "m-1",
						role: "user",
						content:
							"Tighten the overview, drop the redundant intro.",
						timestamp: "2026-05-19T12:00:00.000Z",
					},
					{
						id: "m-2",
						role: "assistant",
						content: "Updated the overview — see the diff below.",
						timestamp: "2026-05-19T12:00:01.000Z",
						toolCalls: [
							{
								id: "tc-1",
								name: "write_document_local",
								args: {},
								status: "success",
								acceptedAt: "2026-05-19T12:01:00.000Z",
								rejectedAt: null,
							},
						],
					},
				],
				parentConversationId: null,
				agentId: "agent-1",
				createdAt: "2026-05-19T12:00:00.000Z",
				updatedAt: "2026-05-19T12:01:00.000Z",
			},
		},
		isLoading: false,
	};
}

function renderDrawer() {
	return render(
		<CopilotHistoryDrawer
			open={true}
			onOpenChange={vi.fn()}
			documentRefKind="PROJECT_DOCUMENT"
			documentRefId="doc-1"
			projectId="proj-1"
			organizationId="org-1"
			currentUserId={SEED_AUTHOR}
			activeConversationId="conv-1"
		/>,
	);
}

describe("CopilotHistoryDrawer — accessibility", () => {
	it("has zero axe violations with three seeded conversations + one selected", async () => {
		primeListWithThreeSeedRows();
		primeActiveWithSelectedConversation();
		const { container } = renderDrawer();
		// Wait for the auto-select effect to settle so the viewer is rendered.
		await screen.findByText("Tighten the overview", { selector: "h3" });
		expect(await axe(container)).toHaveNoViolations();
	});

	it("renders the tablist with both tabs cross-referenced to their panels", async () => {
		primeListWithThreeSeedRows();
		primeActiveWithSelectedConversation();
		renderDrawer();
		const tablist = await screen.findByRole("tablist", {
			name: /conversation panes/i,
		});
		const tabs = within(tablist).getAllByRole("tab", { hidden: true });
		expect(tabs.length).toBeGreaterThanOrEqual(2);
		const listTab = tabs.find(
			(t) =>
				t.getAttribute("aria-controls") ===
				"copilot-history-list-panel",
		);
		const viewerTab = tabs.find(
			(t) =>
				t.getAttribute("aria-controls") ===
				"copilot-history-viewer-panel",
		);
		expect(listTab).toBeTruthy();
		expect(viewerTab).toBeTruthy();
		// The list panel should reference the list tab via aria-labelledby.
		const listPanel = document.getElementById("copilot-history-list-panel");
		expect(listPanel).not.toBeNull();
		expect(listPanel?.getAttribute("aria-labelledby")).toBe(
			"copilot-history-list-tab",
		);
		const viewerPanel = document.getElementById(
			"copilot-history-viewer-panel",
		);
		expect(viewerPanel?.getAttribute("aria-labelledby")).toBe(
			"copilot-history-viewer-tab",
		);
	});

	it("renders conversation rows as listbox options with selection state", async () => {
		primeListWithThreeSeedRows();
		primeActiveWithSelectedConversation();
		renderDrawer();
		const listbox = await screen.findByRole("listbox", {
			name: /conversations/i,
		});
		const options = within(listbox).getAllByRole("option");
		expect(options.length).toBe(3);
		// The auto-selected row should advertise aria-selected="true".
		const selectedOption = options.find(
			(o) => o.getAttribute("aria-selected") === "true",
		);
		expect(selectedOption).toBeTruthy();
		expect(selectedOption?.textContent).toContain("Tighten the overview");
	});

	it("gives every icon-only control an accessible name", async () => {
		primeListWithThreeSeedRows();
		primeActiveWithSelectedConversation();
		renderDrawer();
		// Wait for viewer render so the kebab is in the DOM.
		await screen.findByText("Tighten the overview", { selector: "h3" });
		// The kebab "Conversation actions" trigger.
		expect(
			screen.getByRole("button", { name: /conversation actions/i }),
		).toBeInTheDocument();
		// Radix Sheet's auto-injected close button uses "Close" via sr-only.
		expect(screen.getAllByText(/^close$/i).length).toBeGreaterThan(0);
	});

	it("renders every visibility chip as non-focusable metadata (not a button)", async () => {
		primeListWithThreeSeedRows();
		primeActiveWithSelectedConversation();
		renderDrawer();
		// Wait for the viewer to settle so both list chips AND viewer
		// header chip are in the DOM. Multiple "Shared" labels expected
		// (one per row + one in the viewer header).
		await screen.findByText("Tighten the overview", { selector: "h3" });
		const sharedTexts = screen.getAllByText(/^shared$/i);
		expect(sharedTexts.length).toBeGreaterThan(0);
		for (const node of sharedTexts) {
			// Walk to the closest element with a role; verify none of them
			// is a button (FR-17/§6.6: visibility shows as metadata in the
			// drawer — only the live-chat header chip is interactive).
			let cursor: HTMLElement | null = node as HTMLElement;
			for (let i = 0; i < 4 && cursor; i++) {
				expect(cursor.getAttribute("role")).not.toBe("button");
				expect(cursor.tagName.toLowerCase()).not.toBe("button");
				expect(cursor.getAttribute("tabindex")).not.toBe("0");
				cursor = cursor.parentElement;
			}
		}
	});

	it("renders read-only viewer messages for a non-active prior selection (F.13)", async () => {
		// Seed the list with a row that is NOT the active thread, plus a
		// distinct active thread. Then seed the byId mock with a fake
		// conversation that should render in the viewer.
		const now = new Date();
		mockListResult.current = {
			data: {
				pages: [
					{
						items: [
							makeRow({
								id: "row-active",
								conversationId: "conv-active",
								title: "Active thread",
								updatedAt: now.toISOString(),
							}),
							makeRow({
								id: "row-prior",
								conversationId: "conv-prior",
								title: "Prior thread",
								updatedAt: new Date(
									now.getTime() - 60_000,
								).toISOString(),
							}),
						],
						nextCursor: null,
					},
				],
				pageParams: [undefined],
			},
			isLoading: false,
			isFetchingNextPage: false,
			hasNextPage: false,
			fetchNextPage: vi.fn(),
		};
		mockActiveResult.current = {
			data: { conversation: null },
			isLoading: false,
		};
		mockByIdResult.current = {
			data: {
				conversation: {
					id: "row-prior",
					conversationId: "conv-prior",
					title: "Prior thread",
					visibility: "SHARED",
					visibilityLockedAt: null,
					archivedAt: null,
					messages: [
						{
							id: "msg-1",
							role: "user",
							content: "Why was the intro rewritten?",
						},
						{
							id: "msg-2",
							role: "assistant",
							content: "Because the kickoff agenda changed.",
						},
					],
					parentConversationId: null,
					agentId: "agent-1",
					createdAt: now.toISOString(),
					updatedAt: now.toISOString(),
				},
			},
			isLoading: false,
		};

		// Render the drawer with no `activeConversationId`, so the auto-
		// select effect doesn't pre-pick anything. Then simulate the user
		// clicking the prior row by selecting its listbox option.
		const { container } = render(
			<CopilotHistoryDrawer
				open={true}
				onOpenChange={vi.fn()}
				documentRefKind="PROJECT_DOCUMENT"
				documentRefId="doc-1"
				projectId="proj-1"
				organizationId="org-1"
				currentUserId={SEED_AUTHOR}
				activeConversationId={null}
			/>,
		);
		const listbox = await screen.findByRole("listbox", {
			name: /conversations/i,
		});
		const priorOption = within(listbox).getByText("Prior thread");
		await act(async () => {
			(
				priorOption.closest('[data-history-row="true"]') as HTMLElement
			).click();
		});

		// The viewer should render both messages from `byIdQuery.data`.
		expect(
			await screen.findByText("Why was the intro rewritten?"),
		).toBeInTheDocument();
		expect(
			await screen.findByText("Because the kickoff agenda changed."),
		).toBeInTheDocument();
		// Sanity: no axe violations with the prior viewer open.
		expect(await axe(container)).toHaveNoViolations();
	});

	it("renders 'Conversation not found' when byId returns null (F.13)", async () => {
		const now = new Date();
		mockListResult.current = {
			data: {
				pages: [
					{
						items: [
							makeRow({
								id: "row-x",
								conversationId: "conv-x",
								title: "Cannot fetch",
								updatedAt: now.toISOString(),
							}),
						],
						nextCursor: null,
					},
				],
				pageParams: [undefined],
			},
			isLoading: false,
			isFetchingNextPage: false,
			hasNextPage: false,
			fetchNextPage: vi.fn(),
		};
		mockActiveResult.current = {
			data: { conversation: null },
			isLoading: false,
		};
		mockByIdResult.current = {
			data: { conversation: null },
			isLoading: false,
		};

		render(
			<CopilotHistoryDrawer
				open={true}
				onOpenChange={vi.fn()}
				documentRefKind="PROJECT_DOCUMENT"
				documentRefId="doc-1"
				projectId="proj-1"
				organizationId="org-1"
				currentUserId={SEED_AUTHOR}
				activeConversationId={null}
			/>,
		);
		const listbox = await screen.findByRole("listbox", {
			name: /conversations/i,
		});
		const opt = within(listbox).getByText("Cannot fetch");
		await act(async () => {
			(opt.closest('[data-history-row="true"]') as HTMLElement).click();
		});

		expect(
			await screen.findByText(/conversation not found/i),
		).toBeInTheDocument();
	});

	it("renders the empty-state copy verbatim when no conversations exist", async () => {
		mockListResult.current = {
			data: {
				pages: [{ items: [], nextCursor: null }],
				pageParams: [undefined],
			},
			isLoading: false,
			isFetchingNextPage: false,
			hasNextPage: false,
			fetchNextPage: vi.fn(),
		};
		mockActiveResult.current = {
			data: { conversation: null },
			isLoading: false,
		};
		renderDrawer();
		expect(
			await screen.findByText(/No conversations yet\./),
		).toBeInTheDocument();
	});
});
