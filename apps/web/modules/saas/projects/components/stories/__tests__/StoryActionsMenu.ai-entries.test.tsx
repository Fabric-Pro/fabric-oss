/**
 * StoryActionsMenu (the board-tile kebab) — per-item AI entry eligibility.
 *
 * Exists because the eligibility gate was once wired into every OTHER priority
 * menu but left dangling here (hook declared, never used) — and nothing failed,
 * since this menu had no tests. These pin the gate to the shared rule: hidden
 * (CLOSED), DECLINED and completed (final-status) items offer no AI entries.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
	ResizeObserverStub;

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			stories: {
				list: {
					queryKey: () => ["stories-list"],
					key: () => ["stories-list"],
				},
				get: { key: () => ["stories-get"] },
				priorityHistory: { key: () => ["priority-history"] },
				// Fizzy #2048: the menu follows the body redraft a type change
				// starts. Nothing here converts anything, so it stays idle.
				regenerationStatus: {
					queryOptions: (o: { input: unknown }) => ({
						queryKey: ["story-regeneration-status", o.input],
						queryFn: async () => ({ status: "idle" }),
					}),
				},
				statuses: {
					list: {
						queryOptions: (o: { input: unknown }) => ({
							queryKey: ["statuses", o.input],
							queryFn: async () => ({
								statuses: [
									{ id: "status-open", isFinal: false },
									{ id: "status-done", isFinal: true },
								],
							}),
						}),
					},
				},
			},
		},
	},
}));

vi.mock("../../../../../shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				update: vi.fn(),
				updateDraftingStage: vi.fn(),
				reprioritizeStory: vi.fn(),
				convertKind: vi.fn(),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), {
		success: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		loading: vi.fn(),
	}),
}));

import type { UserStory } from "../../../lib/stories/types";
import { StoryActionsMenu } from "../StoryActionsMenu";

function story(overrides: Partial<UserStory> = {}): UserStory {
	return {
		id: "s-1",
		identifier: "F-1",
		title: "Story",
		statusId: "status-open",
		kind: "FEATURE",
		priority: "P2_MEDIUM",
		draftingStage: "DRAFT",
		blocked: false,
		tags: [],
		tasks: [],
		...overrides,
	} as UserStory;
}

async function openPrioritySubmenu(target: UserStory) {
	const user = userEvent.setup();
	render(
		<StoryActionsMenu
			story={target}
			projectId="p-1"
			organizationId={null}
		/>,
		{
			wrapper: ({ children }: { children: ReactNode }) => (
				<QueryClientProvider
					client={
						new QueryClient({
							defaultOptions: { queries: { retry: false } },
						})
					}
				>
					{children}
				</QueryClientProvider>
			),
		},
	);
	await user.click(screen.getByRole("button"));
	await user.hover(await screen.findByText("Change priority"));
	return within(
		await screen.findByRole("menu", { name: /change priority/i }),
	);
}

describe("StoryActionsMenu — AI entry eligibility", () => {
	it("offers the single isolated AI entry on an active item (no list mode)", async () => {
		const submenu = await openPrioritySubmenu(story());
		expect(
			await submenu.findByText("Re-assess priority with AI"),
		).toBeInTheDocument();
		// The whole-list mode is not offered here — that lives on Re-prioritize.
		expect(
			submenu.queryByText("Weigh against the list"),
		).not.toBeInTheDocument();
	});

	it("withholds it on a DECLINED item", async () => {
		const submenu = await openPrioritySubmenu(
			story({ draftingStage: "DECLINED" }),
		);
		expect(submenu.getByText(/P0/)).toBeInTheDocument();
		expect(
			submenu.queryByText("Re-assess priority with AI"),
		).not.toBeInTheDocument();
	});

	it("withholds it on a completed (final-status) item", async () => {
		const submenu = await openPrioritySubmenu(
			story({ statusId: "status-done" }),
		);
		expect(submenu.getByText(/P0/)).toBeInTheDocument();
		expect(
			submenu.queryByText("Re-assess priority with AI"),
		).not.toBeInTheDocument();
	});
});
