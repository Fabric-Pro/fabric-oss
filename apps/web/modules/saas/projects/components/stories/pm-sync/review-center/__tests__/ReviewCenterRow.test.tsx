import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolveConflict = vi.fn();
const dismissPmSyncConflict = vi.fn();
const retryPmSync = vi.fn();
const dismissPmSyncFailure = vi.fn();
const reviewStateChange = vi.fn();
const checkPmSyncConflicts = vi.fn();
const resolveContentDrift = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				resolveConflict: (...args: unknown[]) =>
					resolveConflict(...args),
				dismissPmSyncConflict: (...args: unknown[]) =>
					dismissPmSyncConflict(...args),
				retryPmSync: (...args: unknown[]) => retryPmSync(...args),
				dismissPmSyncFailure: (...args: unknown[]) =>
					dismissPmSyncFailure(...args),
				checkPmSyncConflicts: (...args: unknown[]) =>
					checkPmSyncConflicts(...args),
			},
			pmStateChanges: {
				review: (...args: unknown[]) => reviewStateChange(...args),
				resolveContentDrift: (...args: unknown[]) =>
					resolveContentDrift(...args),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

// The global next-intl mock (vitest.setup.ts) returns a key-echoing function
// with no `.raw`. The FLAG_MISSING triad uses `<DestructiveTooltip>`, which
// reads `copy={t.raw(key)}` expecting a `{ label, warning }` object — so extend
// the mock here with a `.raw` that returns a valid destructive-copy shape, and
// have `t(key)` echo the key (interpolation args are ignored for assertions).
vi.mock("next-intl", () => {
	function makeT() {
		const t = (key: string) => key;
		(t as unknown as { raw: (k: string) => unknown }).raw = (
			k: string,
		) => ({
			label: `${k}.label`,
			warning: `Warning: ${k}.warning`,
		});
		return t;
	}
	return {
		useTranslations: () => makeT(),
		useLocale: () => "en",
		useFormatter: () => ({
			dateTime: (d: Date) => d.toISOString(),
			number: (n: number) => String(n),
			relativeTime: (d: Date) => d.toISOString(),
		}),
		useMessages: () => ({}),
		NextIntlClientProvider: ({ children }: { children: unknown }) =>
			children,
	};
});

if (!(globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver) {
	(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
}
if (!Element.prototype.hasPointerCapture) {
	Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.scrollIntoView) {
	Element.prototype.scrollIntoView = () => {};
}

import { type ReviewCenterItem, ReviewCenterRow } from "../ReviewCenterRow";

const baseItem: ReviewCenterItem = {
	id: "x1",
	type: "conflict",
	entityType: "FEATURE",
	entityId: "feature_1",
	identifier: "F-039",
	title: "Checkout flow refactor",
	pmTool: "azure-devops",
	// Null by default so the existing assertions (e.g. a single "Azure DevOps"
	// match) are unaffected; the "View in PM tool" tests set it explicitly.
	externalUrl: null,
	summary: "Local and remote versions diverged",
	fabricDescription: "Fabricsidedescriptiontext",
	fabricUpdatedAt: "2026-05-21T08:00:00.000Z",
	fabricAuthor: "Ada Lovelace",
	fabricSource: "MANUAL",
	proposedAction: null,
	itemType: "story",
};

/** Default PM-side preview the dialog fetches via `checkPmSyncConflicts`. */
function pmPreviewResult(itemId: string, itemType: string) {
	return {
		results: [
			{
				id: itemId,
				itemType,
				hasConflict: true,
				pmCurrent: {
					title: "PM title",
					description: "Pmsidedescriptiontext",
					lastChangedBy: null,
					lastChangedAt: null,
				},
				pmUrl: undefined,
				pmTool: "azure-devops",
			},
		],
	};
}

function renderRow(item: ReviewCenterItem, onActioned = vi.fn()) {
	render(
		<ul>
			<ReviewCenterRow
				item={item}
				projectId="project_1"
				organizationId={null}
				onActioned={onActioned}
			/>
		</ul>,
	);
	return onActioned;
}

beforeEach(() => {
	resolveConflict.mockReset();
	dismissPmSyncConflict.mockReset();
	retryPmSync.mockReset();
	dismissPmSyncFailure.mockReset();
	reviewStateChange.mockReset();
	checkPmSyncConflicts.mockReset();
	resolveContentDrift.mockReset();
});

afterEach(() => vi.clearAllMocks());

describe("ReviewCenterRow (7.3)", () => {
	it("opens the unified dialog for a FEATURE conflict with itemType 'feature', the row's entityId, and the sourced Fabric description", async () => {
		checkPmSyncConflicts.mockResolvedValue(
			pmPreviewResult("feature_1", "feature"),
		);
		const user = userEvent.setup();
		renderRow({ ...baseItem, entityType: "FEATURE" });

		await user.click(
			screen.getByRole("button", {
				name: /Resolve sync conflict for F-039/,
			}),
		);

		// The dialog drives the PM-side fetch with the derived itemType + entityId.
		await waitFor(() =>
			expect(checkPmSyncConflicts).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "project_1",
					items: [{ id: "feature_1", itemType: "feature" }],
				}),
			),
		);

		// The Fabric column renders the description sourced from the row.
		const fabricColumn = await screen.findByRole("region", {
			name: "FABRIC",
		});
		expect(fabricColumn).toHaveTextContent("Fabricsidedescriptiontext");
	});

	it("passes the row's fabricUpdatedAt so the FABRIC column shows a real timestamp (not the fallback)", async () => {
		checkPmSyncConflicts.mockResolvedValue(
			pmPreviewResult("feature_1", "feature"),
		);
		const user = userEvent.setup();
		renderRow(baseItem);

		await user.click(
			screen.getByRole("button", {
				name: /Resolve sync conflict for F-039/,
			}),
		);

		const fabricColumn = await screen.findByRole("region", {
			name: "FABRIC",
		});
		// "Updated …" from the row's timestamp, NOT the "date unavailable" fallback.
		expect(fabricColumn).toHaveTextContent(/Updated/);
		expect(fabricColumn).not.toHaveTextContent(/Updated date unavailable/);
	});

	it("passes the row's fabricAuthor + fabricSource so the FABRIC column shows them", async () => {
		checkPmSyncConflicts.mockResolvedValue(
			pmPreviewResult("feature_1", "feature"),
		);
		const user = userEvent.setup();
		renderRow(baseItem);

		await user.click(
			screen.getByRole("button", {
				name: /Resolve sync conflict for F-039/,
			}),
		);

		const fabricColumn = await screen.findByRole("region", {
			name: "FABRIC",
		});
		// Author folded into the timestamp line; source rendered as its own label.
		expect(fabricColumn).toHaveTextContent(/by Ada Lovelace/);
		expect(fabricColumn).toHaveTextContent(/Manual edit/);
		expect(fabricColumn).not.toHaveTextContent(/Author unavailable/);
		expect(fabricColumn).not.toHaveTextContent(/Source unavailable/);
	});

	it("derives itemType 'epic' for an EPIC conflict row", async () => {
		checkPmSyncConflicts.mockResolvedValue(
			pmPreviewResult("epic_9", "epic"),
		);
		const user = userEvent.setup();
		renderRow({
			...baseItem,
			entityType: "EPIC",
			entityId: "epic_9",
			identifier: "EPIC-009",
		});

		await user.click(
			screen.getByRole("button", {
				name: /Resolve sync conflict for EPIC-009/,
			}),
		);

		await waitFor(() =>
			expect(checkPmSyncConflicts).toHaveBeenCalledWith(
				expect.objectContaining({
					items: [{ id: "epic_9", itemType: "epic" }],
				}),
			),
		);
	});

	it("derives itemType 'story' for a STORY conflict row (covers bugs, which surface as STORY)", async () => {
		checkPmSyncConflicts.mockResolvedValue(
			pmPreviewResult("story_5", "story"),
		);
		const user = userEvent.setup();
		renderRow({
			...baseItem,
			entityType: "STORY",
			entityId: "story_5",
			identifier: "US-005",
		});

		await user.click(
			screen.getByRole("button", {
				name: /Resolve sync conflict for US-005/,
			}),
		);

		await waitFor(() =>
			expect(checkPmSyncConflicts).toHaveBeenCalledWith(
				expect.objectContaining({
					items: [{ id: "story_5", itemType: "story" }],
				}),
			),
		);
	});

	it("invalidates the review-center queries (via onActioned) after resolving the conflict", async () => {
		checkPmSyncConflicts.mockResolvedValue(
			pmPreviewResult("feature_1", "feature"),
		);
		resolveConflict.mockResolvedValue({ cleared: true });
		const user = userEvent.setup();
		const onActioned = renderRow(baseItem);

		await user.click(
			screen.getByRole("button", {
				name: /Resolve sync conflict for F-039/,
			}),
		);

		// Wait for the PM fetch to settle so the action row is interactive.
		await screen.findByRole("region", { name: "FABRIC" });

		await user.click(
			await screen.findByRole("button", { name: /Use Fabric/ }),
		);

		await waitFor(() =>
			expect(resolveConflict).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "project_1",
					itemId: "feature_1",
					itemType: "feature",
					resolution: "LOCAL",
				}),
			),
		);
		// The dialog owns the resolve call but NOT invalidation — the row's
		// onActioned is the invalidation seam.
		await waitFor(() => expect(onActioned).toHaveBeenCalledTimes(1));
	});

	it("does not pass organizationId to resolveConflict", async () => {
		checkPmSyncConflicts.mockResolvedValue(
			pmPreviewResult("feature_1", "feature"),
		);
		resolveConflict.mockResolvedValue({ cleared: true });
		const user = userEvent.setup();
		renderRow(baseItem);

		await user.click(
			screen.getByRole("button", {
				name: /Resolve sync conflict for F-039/,
			}),
		);
		await screen.findByRole("region", { name: "FABRIC" });
		await user.click(
			await screen.findByRole("button", { name: /Use Fabric/ }),
		);

		await waitFor(() => expect(resolveConflict).toHaveBeenCalledTimes(1));
		const resolveArgs = resolveConflict.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(resolveArgs).not.toHaveProperty("organizationId");
	});

	it("dismisses a conflict via dismissPmSyncConflict (a one-click terminal state when the Resolve dialog can't load a deleted PM card), then invalidates", async () => {
		dismissPmSyncConflict.mockResolvedValue({ dismissed: true });
		const user = userEvent.setup();
		const onActioned = renderRow({
			...baseItem,
			id: "feature_9",
			entityId: "feature_9",
			type: "conflict",
			identifier: "F-099",
			itemType: "story",
		});

		const dismiss = screen.getByRole("button", {
			name: /Dismiss sync conflict for F-099/,
		});
		await user.click(dismiss);

		await waitFor(() =>
			expect(dismissPmSyncConflict).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "project_1",
					storyId: "feature_9",
					itemType: "story",
					organizationId: null,
				}),
			),
		);
		await waitFor(() => expect(onActioned).toHaveBeenCalledTimes(1));
	});

	it("shows a Retry action for failures and invokes the reused retryPmSync mutation, then invalidates", async () => {
		retryPmSync.mockResolvedValue({ ok: true });
		const user = userEvent.setup();
		const onActioned = renderRow({
			...baseItem,
			id: "feature_2",
			entityId: "feature_2",
			type: "failure",
			identifier: "US-002",
			summary: "PM rejected update",
		});

		const retry = screen.getByRole("button", {
			name: /Retry sync for US-002/,
		});
		await user.click(retry);

		await waitFor(() =>
			expect(retryPmSync).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "project_1",
					storyId: "feature_2",
					pushAnyway: false,
					organizationId: null,
				}),
			),
		);
		await waitFor(() => expect(onActioned).toHaveBeenCalledTimes(1));
	});

	it("dismisses a failure via dismissPmSyncFailure (clearing it from the queue), then invalidates", async () => {
		dismissPmSyncFailure.mockResolvedValue({ dismissed: true });
		const user = userEvent.setup();
		const onActioned = renderRow({
			...baseItem,
			id: "feature_3",
			entityId: "feature_3",
			type: "failure",
			identifier: "US-003",
			summary: "PM ticket was deleted",
		});

		const dismiss = screen.getByRole("button", {
			name: /Dismiss failed sync for US-003/,
		});
		await user.click(dismiss);

		await waitFor(() =>
			expect(dismissPmSyncFailure).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "project_1",
					storyId: "feature_3",
					organizationId: null,
				}),
			),
		);
		await waitFor(() => expect(onActioned).toHaveBeenCalledTimes(1));
	});

	it("keeps Dismiss available on a Failures row even with no resolvable PM tool", () => {
		renderRow({
			...baseItem,
			id: "feature_97",
			entityId: "feature_97",
			type: "failure",
			identifier: "US-097",
			summary: "No tool, still dismissable",
			pmTool: null,
		});

		// Dismiss only clears the local failure flag, so it needs no PM tool.
		expect(
			screen.getByRole("button", {
				name: /Dismiss failed sync for US-097/,
			}),
		).toBeEnabled();
	});

	it("retries a BUG failure with itemType 'bug' (RETRY-c regression — a BUG must not default to 'story')", async () => {
		retryPmSync.mockResolvedValue({ ok: true });
		const user = userEvent.setup();
		renderRow({
			...baseItem,
			id: "bug_1",
			entityId: "bug_1",
			type: "failure",
			identifier: "US-BUG",
			summary: "PM rejected update",
			itemType: "bug",
		});

		await user.click(
			screen.getByRole("button", { name: /Retry sync for US-BUG/ }),
		);

		await waitFor(() =>
			expect(retryPmSync).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "project_1",
					storyId: "bug_1",
					itemType: "bug",
					pushAnyway: false,
					organizationId: null,
				}),
			),
		);
	});

	it("retries a FEATURE failure with itemType 'story'", async () => {
		retryPmSync.mockResolvedValue({ ok: true });
		const user = userEvent.setup();
		renderRow({
			...baseItem,
			id: "feat_1",
			entityId: "feat_1",
			type: "failure",
			identifier: "US-FEAT",
			summary: "PM rejected update",
			itemType: "story",
		});

		await user.click(
			screen.getByRole("button", { name: /Retry sync for US-FEAT/ }),
		);

		await waitFor(() =>
			expect(retryPmSync).toHaveBeenCalledWith(
				expect.objectContaining({
					storyId: "feat_1",
					itemType: "story",
				}),
			),
		);
	});

	it("shows Accept/Reject for pull-drift and invokes the reused review mutation with the pending-change id, then invalidates", async () => {
		reviewStateChange.mockResolvedValue({ ok: true });
		const user = userEvent.setup();
		const onActioned = renderRow({
			...baseItem,
			id: "pending_3",
			entityId: "story_3",
			type: "pull-drift",
			identifier: "US-003",
			summary: "Active → Closed",
			proposedAction: "HIDE",
		});

		expect(
			screen.getByRole("button", {
				name: /Hide US-003/,
			}),
		).toBeInTheDocument();

		await user.click(
			screen.getByRole("button", {
				name: /Keep US-003 visible/,
			}),
		);

		await waitFor(() =>
			expect(reviewStateChange).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "project_1",
					id: "pending_3",
					decision: "DISMISSED",
					organizationId: null,
				}),
			),
		);
		await waitFor(() => expect(onActioned).toHaveBeenCalledTimes(1));
	});

	it("renders a Resolve action for a CONTENT_DRIFT pull-drift row and opens the dialog in pull-drift mode", async () => {
		checkPmSyncConflicts.mockResolvedValue(
			pmPreviewResult("story_7", "story"),
		);
		const user = userEvent.setup();
		renderRow({
			...baseItem,
			id: "pending_7",
			entityType: "STORY",
			entityId: "story_7",
			type: "pull-drift",
			identifier: "US-007",
			summary: "Content changed in your PM tool",
			proposedAction: "CONTENT_DRIFT",
			fabricDescription: "Fabriccurrentbodytext",
		});

		// CONTENT_DRIFT rows do NOT show Accept/Reject — they show Resolve.
		expect(
			screen.queryByRole("button", { name: /Accept state change/ }),
		).not.toBeInTheDocument();

		await user.click(
			screen.getByRole("button", {
				name: /Resolve content drift for US-007/,
			}),
		);

		// The dialog opens in pull-drift mode, now aligned with the conflict
		// modal: Use PM / Use Fabric (the old Apply / Keep Fabric / Dismiss
		// labels are gone).
		expect(
			await screen.findByRole("button", { name: "Use PM" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Use Fabric" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Apply to Fabric/ }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Keep Fabric/ }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Dismiss/ }),
		).not.toBeInTheDocument();

		// The Fabric column renders the row's current Fabric description (the
		// entity's content), so the diff is meaningful — not an empty column.
		const fabricColumn = await screen.findByRole("region", {
			name: "FABRIC",
		});
		expect(fabricColumn).toHaveTextContent("Fabriccurrentbodytext");
	});

	it("resolves a CONTENT_DRIFT row via resolveContentDrift, then invalidates", async () => {
		checkPmSyncConflicts.mockResolvedValue(
			pmPreviewResult("story_7", "story"),
		);
		resolveContentDrift.mockResolvedValue({ change: {} });
		const user = userEvent.setup();
		const onActioned = renderRow({
			...baseItem,
			id: "pending_7",
			entityType: "STORY",
			entityId: "story_7",
			type: "pull-drift",
			identifier: "US-007",
			summary: "Content changed in your PM tool",
			proposedAction: "CONTENT_DRIFT",
		});

		await user.click(
			screen.getByRole("button", {
				name: /Resolve content drift for US-007/,
			}),
		);
		await screen.findByRole("region", { name: "FABRIC" });

		await user.click(await screen.findByRole("button", { name: "Use PM" }));

		await waitFor(() =>
			expect(resolveContentDrift).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "project_1",
					id: "pending_7",
					outcome: "APPLY_ADO",
				}),
			),
		);
		await waitFor(() => expect(onActioned).toHaveBeenCalledTimes(1));
	});

	it("renders identifier, title, summary, and PM tool label", () => {
		renderRow(baseItem);
		expect(screen.getByText(/F-039/)).toBeInTheDocument();
		expect(screen.getByText(/Checkout flow refactor/)).toBeInTheDocument();
		expect(
			screen.getByText("Local and remote versions diverged"),
		).toBeInTheDocument();
		expect(screen.getByText(/Azure DevOps/i)).toBeInTheDocument();
	});

	it("renders Unhide / Keep hidden aria labels and button text for an UNHIDE pull-drift row", () => {
		renderRow({
			...baseItem,
			id: "pending_9",
			entityType: "STORY",
			entityId: "story_9",
			type: "pull-drift",
			identifier: "US-009",
			summary: "Ticket was reopened",
			proposedAction: "UNHIDE",
		});

		// Accept button should say "Unhide" with aria-label "Unhide US-009"
		expect(
			screen.getByRole("button", { name: /Unhide US-009/ }),
		).toBeInTheDocument();

		// Reject button should say "Keep hidden" with aria-label "Keep US-009 hidden"
		expect(
			screen.getByRole("button", { name: /Keep US-009 hidden/ }),
		).toBeInTheDocument();
	});

	function flagMissingItem(
		overrides: Partial<ReviewCenterItem> = {},
	): ReviewCenterItem {
		return {
			...baseItem,
			id: "pending_10",
			entityType: "STORY",
			entityId: "story_10",
			type: "pull-drift",
			identifier: "US-010",
			summary: "Ticket was deleted upstream",
			proposedAction: "FLAG_MISSING",
			pmTool: "azure-devops",
			...overrides,
		};
	}

	it("renders the Unlink / Re-push / Dismiss triad for a FLAG_MISSING pull-drift row and NO 'Keep linked'", () => {
		renderRow(flagMissingItem());

		expect(
			screen.getByRole("button", { name: /Unlink US-010/ }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Re-push US-010/ }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Dismiss US-010/ }),
		).toBeInTheDocument();

		// "Keep linked" / "Keep Link" must be gone everywhere.
		expect(screen.queryByText(/Keep linked/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/Keep Link/i)).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Keep US-010 linked/i }),
		).not.toBeInTheDocument();
	});

	it("Unlink on a FLAG_MISSING row calls the APPROVED review path (applyPmUnlink), then invalidates", async () => {
		reviewStateChange.mockResolvedValue({ ok: true });
		const user = userEvent.setup();
		const onActioned = renderRow(flagMissingItem());

		await user.click(screen.getByRole("button", { name: /Unlink US-010/ }));

		await waitFor(() =>
			expect(reviewStateChange).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "project_1",
					id: "pending_10",
					decision: "APPROVED",
					organizationId: null,
				}),
			),
		);
		await waitFor(() => expect(onActioned).toHaveBeenCalledTimes(1));
	});

	it("Dismiss on a FLAG_MISSING row calls review({ decision: 'DISMISSED' }) with NO confirm dialog, then invalidates", async () => {
		reviewStateChange.mockResolvedValue({ ok: true });
		const user = userEvent.setup();
		const onActioned = renderRow(flagMissingItem());

		await user.click(
			screen.getByRole("button", { name: /Dismiss US-010/ }),
		);

		// No confirm dialog stands between the click and the call.
		await waitFor(() =>
			expect(reviewStateChange).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "project_1",
					id: "pending_10",
					decision: "DISMISSED",
					organizationId: null,
				}),
			),
		);
		await waitFor(() => expect(onActioned).toHaveBeenCalledTimes(1));
	});

	it("Re-push on a FLAG_MISSING row opens a confirm dialog and on confirm calls retryPmSync({ unlinkFirst: true, itemType }), then invalidates", async () => {
		retryPmSync.mockResolvedValue({ ok: true });
		const user = userEvent.setup();
		const onActioned = renderRow(
			flagMissingItem({ entityId: "bug_10", itemType: "bug" }),
		);

		await user.click(
			screen.getByRole("button", { name: /Re-push US-010/ }),
		);

		// A confirmation AlertDialog appears before any push happens.
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toBeInTheDocument();
		expect(retryPmSync).not.toHaveBeenCalled();

		await user.click(
			within(dialog).getByRole("button", { name: /^Re-push$/ }),
		);

		await waitFor(() =>
			expect(retryPmSync).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "project_1",
					storyId: "bug_10",
					itemType: "bug",
					unlinkFirst: true,
					organizationId: null,
				}),
			),
		);
		await waitFor(() => expect(onActioned).toHaveBeenCalledTimes(1));
	});

	it("disables Retry on a Failures row with no resolvable PM tool (pmTool null), keeping it reachable for screen readers", () => {
		renderRow({
			...baseItem,
			id: "feature_99",
			entityId: "feature_99",
			type: "failure",
			identifier: "US-099",
			summary: "GitLab not connected",
			pmTool: null,
		});

		const retry = screen.getByRole("button", {
			name: /Retry sync for US-099/,
		});
		expect(retry).toBeDisabled();
		// Dismiss is the always-available terminal state and needs no PM tool, so
		// it stays ENABLED even when Retry is disabled (the deleted-ticket / no-tool
		// failure must still be clearable from the queue).
		expect(
			screen.getByRole("button", {
				name: /Dismiss failed sync for US-099/,
			}),
		).toBeEnabled();
	});

	it("keeps Retry enabled on a Failures row that still has a resolvable PM tool (stale-tool rows retry against the configured tool)", () => {
		renderRow({
			...baseItem,
			id: "feature_98",
			entityId: "feature_98",
			type: "failure",
			identifier: "US-098",
			summary: "Sync failed",
			pmTool: "azure-devops",
		});

		expect(
			screen.getByRole("button", { name: /Retry sync for US-098/ }),
		).toBeEnabled();
	});

	it("renders a 'View in {tool}' external link when the row has a valid externalUrl", () => {
		renderRow({
			...baseItem,
			externalUrl: "https://app.fizzy.do/000000/cards/1075",
		});

		const link = screen.getByRole("link", { name: /View in Fizzy/i });
		expect(link).toHaveAttribute(
			"href",
			"https://app.fizzy.do/000000/cards/1075",
		);
		expect(link).toHaveAttribute("target", "_blank");
		expect(link).toHaveAttribute("rel", "noopener noreferrer");
	});

	it("renders no PM-tool link when the row is unlinked (externalUrl null)", () => {
		renderRow({ ...baseItem, externalUrl: null });
		expect(
			screen.queryByRole("link", { name: /View in/i }),
		).not.toBeInTheDocument();
	});

	it("renders no PM-tool link for a non-http(s) externalUrl (defends against bad/stale links)", () => {
		renderRow({
			...baseItem,
			externalUrl: "javascript:alert(1)",
		});
		expect(
			screen.queryByRole("link", { name: /View in/i }),
		).not.toBeInTheDocument();
	});
});
