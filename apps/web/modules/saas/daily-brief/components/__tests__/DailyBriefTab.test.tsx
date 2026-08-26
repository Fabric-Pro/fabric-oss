import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * DailyBriefTab — cache-invalidation wiring (Task 11 / Step 3b).
 *
 * `onRegenerated` is the single callback DailyBriefPage fires after a
 * successful regenerate, hide, or unhide (see DailyBriefPage's
 * handleRegenerate/handleHide/handleUnhide — all three persist via oRPC then
 * call `onRegenerated?.()`). DailyBriefPage's own rendering/wiring of hide
 * and unhide is covered by ReleaseNotesPanel.test.tsx (onHide/onUnhide
 * callback plumbing) — this file isolates DailyBriefTab's *own* contract:
 * whatever triggers `onRegenerated`, both the `dailyBrief.get` and
 * `dailyBrief.exclusions.list` TanStack Query caches must be invalidated so
 * the tab's brief content and Manage-hidden list stay in sync. DailyBriefPage
 * is mocked out so this test exercises exactly that contract, decoupled from
 * the page's internal render tree.
 */

const { getBrief } = vi.hoisted(() => ({
	getBrief: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		dailyBrief: {
			get: (...args: unknown[]) => getBrief(...args),
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		dailyBrief: {
			exclusions: {
				list: {
					queryOptions: ({
						input,
					}: {
						input: {
							projectId: string;
							organizationId: string | null;
						};
					}) => ({
						queryKey: [
							"dailyBrief.exclusions.list",
							input.projectId,
							input.organizationId,
						],
						queryFn: () => Promise.resolve([]),
					}),
				},
			},
		},
	},
}));

vi.mock("../DailyBriefPage", () => ({
	DailyBriefPage: ({ onRegenerated }: { onRegenerated?: () => void }) => (
		<button type="button" onClick={onRegenerated}>
			trigger-regenerated
		</button>
	),
}));

import { DailyBriefTab } from "../DailyBriefTab";

function renderTab(
	projectId: string,
	organizationId: string | null,
	queryClient: QueryClient,
) {
	return render(
		<QueryClientProvider client={queryClient}>
			<DailyBriefTab
				projectId={projectId}
				organizationId={organizationId}
				project={{ canEditSettings: true }}
			/>
		</QueryClientProvider>,
	);
}

describe("DailyBriefTab — onRegenerated invalidates both caches", () => {
	it("invalidates dailyBrief.get and dailyBrief.exclusions.list when onRegenerated fires", async () => {
		getBrief.mockResolvedValue({
			brief: {
				id: "brief-1",
				status: "READY",
				content: {
					schemaVersion: 2,
					executiveSummary: "",
					priorityActions: [],
					sections: {},
				},
				generatedAt: new Date("2026-07-10T00:00:00Z"),
				errorMessage: null,
			},
			cursor: null,
			progress: null,
		});

		const queryClient = new QueryClient();
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

		renderTab("proj-1", null, queryClient);

		const trigger = await screen.findByRole("button", {
			name: "trigger-regenerated",
		});
		fireEvent.click(trigger);

		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: ["dailyBrief.get", "proj-1", null, "LAST_7D"],
		});
		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: ["dailyBrief.exclusions.list", "proj-1", null],
		});
	});

	it("derives the exclusions key from the org-scoped input when in an org context", async () => {
		getBrief.mockResolvedValue({
			brief: {
				id: "brief-2",
				status: "READY",
				content: {
					schemaVersion: 2,
					executiveSummary: "",
					priorityActions: [],
					sections: {},
				},
				generatedAt: new Date("2026-07-10T00:00:00Z"),
				errorMessage: null,
			},
			cursor: null,
			progress: null,
		});

		const queryClient = new QueryClient();
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

		renderTab("proj-2", "org-1", queryClient);

		const trigger = await screen.findByRole("button", {
			name: "trigger-regenerated",
		});
		fireEvent.click(trigger);

		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: ["dailyBrief.get", "proj-2", "org-1", "LAST_7D"],
		});
		expect(invalidateSpy).toHaveBeenCalledWith({
			queryKey: ["dailyBrief.exclusions.list", "proj-2", "org-1"],
		});
	});
});
