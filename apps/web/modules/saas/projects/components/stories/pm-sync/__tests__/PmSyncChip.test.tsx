/**
 * Component tests for `<PmSyncChip />` — the single editor PM-sync chip.
 *
 * ONE chip per state (Synced / Not synced / Paused / PM sync failed / Conflict)
 * with an auto-sync tooltip; clicking it opens a dropdown with everything behind
 * it (open card, push/force, pull, pause/resume, review problem). These tests
 * assert the wiring; `orpcClient` is mocked like the other pm-sync suites.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const syncFn = vi.fn();
const updateFn = vi.fn();
const retryPmSyncFn = vi.fn();
const linkPmItemFn = vi.fn();
const checkPmSyncConflictsFn = vi.fn();
const invalidatePmSyncState = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock("../../../../../../shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				sync: (...a: unknown[]) => syncFn(...a),
				update: (...a: unknown[]) => updateFn(...a),
				retryPmSync: (...a: unknown[]) => retryPmSyncFn(...a),
				linkPmItem: (...a: unknown[]) => linkPmItemFn(...a),
				checkPmSyncConflicts: (...a: unknown[]) =>
					checkPmSyncConflictsFn(...a),
				resolveConflict: vi.fn().mockResolvedValue({ cleared: true }),
				dismissPmSyncConflict: vi.fn().mockResolvedValue({}),
				proposeAiMerge: vi.fn().mockResolvedValue({
					mergedTitle: "",
					mergedDescription: "",
					truncated: false,
				}),
			},
			pmStateChanges: {
				resolveContentDrift: vi.fn().mockResolvedValue({}),
			},
		},
	},
}));

// The chip's post-action cache refresh is the shared PM-sync invalidation
// helper (stories.list / stories.get / reviewCenter.items / reviewCenter.count
// together); the spy pins that every success path calls it.
vi.mock("../use-invalidate-pm-sync-state", () => ({
	useInvalidatePmSyncState: () => invalidatePmSyncState,
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		organizationSlug: null,
		basePath: "/app",
		isOrgContext: false,
		isPersonalContext: true,
		loaded: true,
		organization: null,
	}),
}));

vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), {
		success: (...a: unknown[]) => toastSuccess(...a),
		error: (...a: unknown[]) => toastError(...a),
		info: vi.fn(),
		warning: vi.fn(),
		loading: vi.fn(),
	}),
}));

// JSDOM gaps for Radix DropdownMenu / Dialog (portal + floating-ui measurement).
class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
	ResizeObserverStub;
if (!Element.prototype.scrollIntoView) {
	Element.prototype.scrollIntoView = () => {};
}
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};

import type { PmSyncChipProps } from "../PmSyncChip";
import { PmSyncChip } from "../PmSyncChip";

function buildProps(o: Partial<PmSyncChipProps> = {}): PmSyncChipProps {
	return {
		storyId: "story-1",
		projectId: "proj-1",
		organizationId: null,
		itemType: "story",
		identifier: "F-1",
		fabricTitle: "Build the thing",
		fabricDescription: "Some description",
		fabricUpdatedAt: new Date("2026-05-01T10:00:00Z"),
		fabricAuthor: "Jane Dev",
		fabricSource: "MANUAL",
		pmAutoSyncEnabled: true,
		externalId: "EXT-1",
		externalUrl: "https://acme.atlassian.net/browse/PROJ-1",
		lastPmSyncStatus: null,
		lastPmSyncError: null,
		lastPmSyncAttemptAt: null,
		hasPmIntegration: true,
		pmToolName: "Jira",
		...o,
	};
}

function renderChip(o: Partial<PmSyncChipProps> = {}) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<PmSyncChip {...buildProps(o)} />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	for (const fn of [
		syncFn,
		updateFn,
		retryPmSyncFn,
		linkPmItemFn,
		checkPmSyncConflictsFn,
	]) {
		fn.mockReset();
	}
	syncFn.mockResolvedValue({ ok: true });
	updateFn.mockResolvedValue({ ok: true });
	retryPmSyncFn.mockResolvedValue({ enqueued: true });
	checkPmSyncConflictsFn.mockResolvedValue({ results: [] });
	invalidatePmSyncState.mockClear();
	toastError.mockClear();
	toastSuccess.mockClear();
});

describe("PmSyncChip — gating + status", () => {
	it("renders nothing while the integration query is in flight", () => {
		const { container } = renderChip({ hasPmIntegration: undefined });
		expect(
			container.querySelector('[data-testid="pm-sync-chip"]'),
		).toBeNull();
	});

	it("ONE chip: Synced (linked + on)", () => {
		renderChip({ pmAutoSyncEnabled: true, externalId: "EXT-1" });
		const chip = screen.getByRole("button");
		expect(chip).toHaveTextContent(/Synced/);
		expect(chip).toHaveAttribute("data-status", "synced");
		// The advisory copy moved from a native `title` into a `<Tooltip>`
		// (see fabric/standards/frontend/tooltips.md). The chip must no longer
		// carry a `title`, and — because its visible text already names it — no
		// `aria-label` either, so the accessible name stays the visible label
		// (WCAG 2.5.3 Label in Name).
		expect(chip).not.toHaveAttribute("title");
		expect(chip).not.toHaveAttribute("aria-label");
		// Assert the copy still has a home. Dropping `title` without this leaves
		// the test passing on absence alone, which would stay green if the
		// tooltip were removed entirely.
		expect(chip).toHaveAttribute("data-slot", "tooltip-trigger");
	});

	it("Not synced (armed but unlinked) — no 'Syncing…'", () => {
		const chip = renderChip({
			pmAutoSyncEnabled: true,
			externalId: null,
			externalUrl: null,
		}).container.querySelector("button");
		expect(chip).toHaveAttribute("data-status", "notsynced");
		expect(chip?.textContent).toMatch(/Not synced/);
		expect(chip?.textContent).not.toMatch(/Syncing/);
	});

	it("Paused (auto-sync off)", () => {
		renderChip({ pmAutoSyncEnabled: false });
		expect(screen.getByRole("button")).toHaveAttribute(
			"data-status",
			"paused",
		);
	});

	it("PM sync failed (FAILED)", () => {
		renderChip({ lastPmSyncStatus: "FAILED", lastPmSyncError: "boom" });
		const chip = screen.getByRole("button");
		expect(chip).toHaveAttribute("data-status", "failed");
		expect(chip).toHaveTextContent(/PM sync failed/);
	});

	it("Conflict (CONFLICT)", () => {
		renderChip({ lastPmSyncStatus: "CONFLICT" });
		expect(screen.getByRole("button")).toHaveAttribute(
			"data-status",
			"conflict",
		);
	});
});

describe("PmSyncChip — dropdown actions", () => {
	it("synced: dropdown has Open card, Push (overwrite), Pull, Pause", async () => {
		const user = userEvent.setup();
		renderChip({ pmAutoSyncEnabled: true, externalId: "EXT-1" });
		await user.click(screen.getByRole("button"));
		expect(
			await screen.findByRole("menuitem", { name: /open jira card/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("menuitem", { name: /push to jira/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("menuitem", { name: /pull from jira/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("menuitem", { name: /pause auto-sync/i }),
		).toBeInTheDocument();
	});

	it("not synced: dropdown offers 'Start syncing' (no Pull, no Open card)", async () => {
		const user = userEvent.setup();
		renderChip({ externalId: null, externalUrl: null });
		await user.click(screen.getByRole("button"));
		expect(
			await screen.findByRole("menuitem", { name: /start syncing/i }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("menuitem", { name: /pull from/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("menuitem", { name: /open .* card/i }),
		).not.toBeInTheDocument();
	});

	it("paused: dropdown offers Resume auto-sync", async () => {
		const user = userEvent.setup();
		renderChip({ pmAutoSyncEnabled: false });
		await user.click(screen.getByRole("button"));
		expect(
			await screen.findByRole("menuitem", { name: /resume auto-sync/i }),
		).toBeInTheDocument();
	});

	it("Pause calls update with pmAutoSyncEnabled:false", async () => {
		const user = userEvent.setup();
		renderChip({ pmAutoSyncEnabled: true, externalId: "EXT-1" });
		await user.click(screen.getByRole("button"));
		await user.click(
			await screen.findByRole("menuitem", { name: /pause auto-sync/i }),
		);
		await waitFor(() => expect(updateFn).toHaveBeenCalledTimes(1));
		expect(updateFn).toHaveBeenCalledWith(
			expect.objectContaining({ pmAutoSyncEnabled: false }),
		);
	});

	it("Start syncing (unlinked push) calls sync push directly — no confirm", async () => {
		const user = userEvent.setup();
		renderChip({ externalId: null, externalUrl: null });
		await user.click(screen.getByRole("button"));
		await user.click(
			await screen.findByRole("menuitem", { name: /start syncing/i }),
		);
		await waitFor(() => expect(syncFn).toHaveBeenCalledTimes(1));
		expect(syncFn).toHaveBeenCalledWith(
			expect.objectContaining({ direction: "push" }),
		);
	});

	it("Push on a linked item asks to confirm overwrite, then pushes", async () => {
		const user = userEvent.setup();
		renderChip({ externalId: "EXT-1" });
		await user.click(screen.getByRole("button"));
		await user.click(
			await screen.findByRole("menuitem", { name: /push to jira/i }),
		);
		// confirm dialog (overwrite) — sync NOT called yet
		expect(syncFn).not.toHaveBeenCalled();
		await user.click(
			await screen.findByRole("button", { name: /push & overwrite/i }),
		);
		await waitFor(() => expect(syncFn).toHaveBeenCalledTimes(1));
		expect(syncFn).toHaveBeenCalledWith(
			expect.objectContaining({ direction: "push" }),
		);
	});

	it("Pull asks to confirm overwrite-local, then pulls", async () => {
		const user = userEvent.setup();
		renderChip({ externalId: "EXT-1" });
		await user.click(screen.getByRole("button"));
		await user.click(
			await screen.findByRole("menuitem", { name: /pull from jira/i }),
		);
		await user.click(
			await screen.findByRole("button", { name: /pull & overwrite/i }),
		);
		await waitFor(() => expect(syncFn).toHaveBeenCalledTimes(1));
		expect(syncFn).toHaveBeenCalledWith(
			expect.objectContaining({ direction: "pull" }),
		);
	});

	it("failed: 'Review problem & Retry' opens the failure panel; Retry re-queues", async () => {
		const user = userEvent.setup();
		renderChip({
			lastPmSyncStatus: "FAILED",
			lastPmSyncError: "Connection refused",
		});
		await user.click(screen.getByRole("button"));
		await user.click(
			await screen.findByRole("menuitem", { name: /review problem/i }),
		);
		expect(
			await screen.findByRole("dialog", { name: "Sync failed" }),
		).toBeInTheDocument();
		await user.click(
			await screen.findByRole("button", { name: /retry sync/i }),
		);
		await waitFor(() => expect(retryPmSyncFn).toHaveBeenCalledTimes(1));
	});

	it("failed with a tool mismatch: 'Review problem' → 'Push & relink' pushes with overrideMismatch:true", async () => {
		const user = userEvent.setup();
		renderChip({
			lastPmSyncStatus: "FAILED",
			lastPmSyncError:
				"This item is synced to a different PM tool. Switch back to the original tool, or unlink.",
		});
		await user.click(screen.getByRole("button"));
		await user.click(
			await screen.findByRole("menuitem", { name: /review problem/i }),
		);
		// The panel's primary action is "Push & relink" (a plain retry can't clear
		// a mismatch), not "Retry sync".
		await user.click(
			await screen.findByRole("button", { name: /push & relink/i }),
		);
		await waitFor(() => expect(syncFn).toHaveBeenCalledTimes(1));
		expect(syncFn).toHaveBeenCalledWith(
			expect.objectContaining({
				direction: "push",
				overrideMismatch: true,
			}),
		);
	});

	const UNCONFIRMED =
		"The create request to Jira got no definite answer (timed out), so a Jira item may already exist for this item. Check Jira; if there is none, use Unlink & re-create.";

	it("failed with an unconfirmed create on an unlinked story: 'Link to existing item' links the named item", async () => {
		linkPmItemFn.mockResolvedValue({
			linked: true,
			externalId: "PROJ-12",
			externalUrl: null,
		});
		const user = userEvent.setup();
		renderChip({
			externalId: null,
			externalUrl: null,
			lastPmSyncStatus: "FAILED",
			lastPmSyncError: UNCONFIRMED,
		});
		await user.click(screen.getByRole("button"));
		await user.click(
			await screen.findByRole("menuitem", { name: /review problem/i }),
		);
		await user.click(
			await screen.findByRole("button", {
				name: /link to existing item/i,
			}),
		);
		await user.type(
			await screen.findByLabelText("Jira item ID or key"),
			"PROJ-12",
		);
		await user.click(screen.getByRole("button", { name: "Link item" }));

		await waitFor(() =>
			expect(linkPmItemFn).toHaveBeenCalledWith({
				projectId: "proj-1",
				storyId: "story-1",
				externalId: "PROJ-12",
				organizationId: null,
			}),
		);
		await waitFor(() => expect(invalidatePmSyncState).toHaveBeenCalled());
		expect(retryPmSyncFn).not.toHaveBeenCalled();
		expect(syncFn).not.toHaveBeenCalled();
	});

	it("refreshes the PM-sync state when the link is refused", async () => {
		linkPmItemFn.mockRejectedValue(new Error("This item was linked"));
		const user = userEvent.setup();
		renderChip({
			externalId: null,
			externalUrl: null,
			lastPmSyncStatus: "FAILED",
			lastPmSyncError: UNCONFIRMED,
		});
		await user.click(screen.getByRole("button"));
		await user.click(
			await screen.findByRole("menuitem", { name: /review problem/i }),
		);
		await user.click(
			await screen.findByRole("button", {
				name: /link to existing item/i,
			}),
		);
		await user.type(
			await screen.findByLabelText("Jira item ID or key"),
			"PROJ-12",
		);
		await user.click(screen.getByRole("button", { name: "Link item" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"This item was linked",
		);
		await waitFor(() => expect(invalidatePmSyncState).toHaveBeenCalled());
	});

	it("does not offer 'Link to existing item' on a linked story", async () => {
		const user = userEvent.setup();
		renderChip({
			externalId: "EXT-1",
			lastPmSyncStatus: "FAILED",
			lastPmSyncError: UNCONFIRMED,
		});
		await user.click(screen.getByRole("button"));
		await user.click(
			await screen.findByRole("menuitem", { name: /review problem/i }),
		);

		expect(
			await screen.findByRole("button", { name: /unlink & re-create/i }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /link to existing item/i }),
		).not.toBeInTheDocument();
	});

	it("conflict: 'Review & resolve' opens the resolve dialog", async () => {
		const user = userEvent.setup();
		checkPmSyncConflictsFn.mockResolvedValue({
			results: [
				{
					hasConflict: false,
					pmTool: "jira",
					pmUrl: "https://acme.atlassian.net/browse/PROJ-1",
				},
			],
		});
		renderChip({ lastPmSyncStatus: "CONFLICT" });
		await user.click(screen.getByRole("button"));
		await user.click(
			await screen.findByRole("menuitem", { name: /review & resolve/i }),
		);
		expect(
			await screen.findByRole("dialog", { name: /build the thing/i }),
		).toBeInTheDocument();
	});
});

describe("PmSyncChip — shared PM-sync invalidation", () => {
	it("fires the shared invalidation after a successful conflict resolve", async () => {
		const user = userEvent.setup();
		// A real conflicting PM side so "Use Fabric" is actionable once the
		// dialog's self-fetched preview lands.
		checkPmSyncConflictsFn.mockResolvedValue({
			results: [
				{
					hasConflict: true,
					pmCurrent: {
						title: "PM-side edited title",
						description: "PM-side edited description.",
						lastChangedBy: "Jamie Rivera",
						lastChangedAt: "2026-05-20T10:30:00Z",
					},
					pmTool: "jira",
					pmUrl: "https://acme.atlassian.net/browse/PROJ-1",
				},
			],
		});
		renderChip({ lastPmSyncStatus: "CONFLICT" });

		await user.click(screen.getByRole("button"));
		await user.click(
			await screen.findByRole("menuitem", { name: /review & resolve/i }),
		);
		const useFabric = await screen.findByRole("button", {
			name: "Use Fabric",
		});
		await waitFor(() => expect(useFabric).toBeEnabled());
		await user.click(useFabric);

		// resolveConflict resolves { cleared: true } → onResolved → helper.
		await waitFor(() =>
			expect(invalidatePmSyncState).toHaveBeenCalledTimes(1),
		);
	});

	it("fires the shared invalidation after a push the server refused, so a stamped FAILED shows", async () => {
		// A legacy link to another PM tool: Sync now answers BAD_REQUEST and
		// has stamped the row FAILED. The chip must refetch, or the failure
		// panel (and its Unlink & re-create) stays out of reach.
		syncFn.mockRejectedValue(
			Object.assign(
				new Error(
					"This item is linked to a ticket in a different PM tool, so Fabric did not create a new one in Jira. To make a new ticket in Jira, use Unlink & re-create (the old ticket is not deleted).",
				),
				{ data: { errorCode: "PM_TOOL_MISMATCH_LEGACY" } },
			),
		);
		const user = userEvent.setup();
		renderChip({ externalId: "EXT-1" });
		await user.click(screen.getByRole("button"));
		await user.click(
			await screen.findByRole("menuitem", { name: /push to jira/i }),
		);
		await user.click(
			await screen.findByRole("button", { name: /push & overwrite/i }),
		);

		await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
		expect(invalidatePmSyncState).toHaveBeenCalledTimes(1);
	});

	it("fires the shared invalidation after a retry success", async () => {
		const user = userEvent.setup();
		renderChip({
			lastPmSyncStatus: "FAILED",
			lastPmSyncError: "Connection refused",
		});

		await user.click(screen.getByRole("button"));
		await user.click(
			await screen.findByRole("menuitem", { name: /review problem/i }),
		);
		await user.click(
			await screen.findByRole("button", { name: /retry sync/i }),
		);

		await waitFor(() => expect(retryPmSyncFn).toHaveBeenCalledTimes(1));
		await waitFor(() =>
			expect(invalidatePmSyncState).toHaveBeenCalledTimes(1),
		);
	});
});
