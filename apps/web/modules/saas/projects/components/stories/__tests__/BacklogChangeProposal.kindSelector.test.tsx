/**
 * Tests for the inline Feature/Bug type selector in BacklogChangeProposal.
 *
 * Locks in the safety net for the F-171 classifier BUG-bias (DSU
 * 2026-05-20). The classifier sometimes mislabels a feature as a bug
 * (or vice-versa); the PM needs to correct it inline before the row is
 * created and synced to the connected PM tool.
 *
 * Scope:
 *   - Selector renders for CREATE rows
 *   - Bug 1429 / Codex P1: epic CREATE rows are normalized to FEATURE ONLY in
 *     the channel-monitor flow (`forbidEpics` prop). In the default/general AI
 *     Update flow the epic stays an epic (raw badge, no Feature/Bug selector).
 *   - Selector hidden for updates (kind is fixed)
 *   - Default selection comes from change.type (deriveDefaultKind)
 *   - Clicking the other option flips the selection
 *   - Default selections are NOT sent on approve (server noise)
 *   - Diverging selections ARE sent on approve as `change.kindOverride`
 *   - "Story" is NOT offered as an option (DSU 2026-05-23 retirement)
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { orpcClient } from "../../../../../shared/lib/orpc-client";
import {
	BacklogChangeProposal,
	type ChangeItem,
} from "../BacklogChangeProposal";

vi.mock("../../../../../shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				checkPmSyncConflicts: vi.fn(async () => ({ results: [] })),
				retryPmSyncBatch: vi.fn(),
				reformatProposalBody: vi.fn(),
			},
		},
	},
}));

const reformatMock = orpcClient.projects.stories
	.reformatProposalBody as unknown as ReturnType<typeof vi.fn>;

function makeCreateChange(overrides: Partial<ChangeItem> = {}): ChangeItem {
	return {
		type: "bug",
		action: "create",
		title: { to: "Add SSO login option" },
		description: { to: "PMs want SSO via their identity provider." },
		reasoning: "Test fixture",
		sourceContext: "teams_messages",
		...overrides,
	};
}

function makeUpdateChange(overrides: Partial<ChangeItem> = {}): ChangeItem {
	return {
		type: "bug",
		action: "update",
		existingId: "story-1",
		existingIdentifier: "B-001",
		title: { from: "Old title", to: "New title" },
		reasoning: "Test fixture",
		sourceContext: "teams_messages",
		...overrides,
	};
}

function renderProposal(props: {
	changes: ChangeItem[];
	onApprove?: ReturnType<typeof vi.fn>;
	forbidEpics?: boolean;
	projectId?: string;
}) {
	const onApprove = props.onApprove ?? vi.fn();
	render(
		<BacklogChangeProposal
			summary="Test summary"
			contextSummary="Test context"
			changes={props.changes}
			hasPMTool={false}
			forbidEpics={props.forbidEpics}
			projectId={props.projectId}
			onApprove={onApprove}
			onReject={vi.fn()}
		/>,
	);
	return { onApprove };
}

describe("BacklogChangeProposal — inline type selector", () => {
	it("renders the selector for a CREATE bug row with BUG pre-selected", () => {
		renderProposal({ changes: [makeCreateChange({ type: "bug" })] });

		const group = screen.getByRole("radiogroup", {
			name: /Work item type for "Add SSO login option"/,
		});
		const bugBtn = within(group).getByRole("radio", { name: "Bug" });
		const featureBtn = within(group).getByRole("radio", {
			name: "Feature",
		});
		expect(bugBtn).toHaveAttribute("aria-checked", "true");
		expect(featureBtn).toHaveAttribute("aria-checked", "false");
	});

	it("renders the selector for a CREATE feature row with FEATURE pre-selected", () => {
		renderProposal({
			changes: [
				makeCreateChange({
					type: "feature",
					title: { to: "User authentication" },
				}),
			],
		});
		const group = screen.getByRole("radiogroup", {
			name: /Work item type for "User authentication"/,
		});
		expect(
			within(group).getByRole("radio", { name: "Feature" }),
		).toHaveAttribute("aria-checked", "true");
	});

	it("legacy 'story'-typed rows default to FEATURE (Story retirement, DSU 2026-05-23)", () => {
		// Pending proposals stored before the prompt change may still have
		// type="story". The selector should not offer "Story" — it should
		// display the row with FEATURE pre-selected.
		renderProposal({
			changes: [
				makeCreateChange({
					type: "story",
					title: { to: "As a PM I want to filter the inbox" },
				}),
			],
		});

		const group = screen.getByRole("radiogroup", {
			name: /Work item type for "As a PM I want to filter the inbox"/,
		});
		expect(
			within(group).getByRole("radio", { name: "Feature" }),
		).toHaveAttribute("aria-checked", "true");
		// Most important assertion of this PR: the selector exposes only
		// Feature and Bug. No Story button. No third option.
		expect(
			within(group).queryByRole("radio", { name: /Story/i }),
		).toBeNull();
		expect(within(group).queryAllByRole("radio")).toHaveLength(2);
	});

	it("DEFAULT flow (no forbidEpics): an EPIC create row renders the raw Epic badge and NO Feature/Bug selector — general epic creation preserved (Codex P1)", () => {
		// The general AI Update flow keeps `epic` first-class. Without
		// `forbidEpics`, an epic CREATE row must NOT be normalized to a feature
		// and must NOT show the Feature/Bug selector (epics are containers, not
		// a kind) — the original pre-Bug-1429 behavior.
		renderProposal({
			changes: [
				makeCreateChange({
					type: "epic",
					title: { to: "Mobile launch initiative" },
				}),
			],
		});
		// No selector for an epic row.
		expect(
			screen.queryByRole("radiogroup", {
				name: /Work item type for "Mobile launch initiative"/,
			}),
		).toBeNull();
		// The raw "epic" type badge is shown instead.
		expect(screen.getByText("epic")).toBeInTheDocument();
	});

	it("forbidEpics flow: an EPIC create row normalizes to FEATURE and renders the Feature/Bug selector (Bug 1429 channel-monitor)", () => {
		// In the channel-monitor inbox (forbidEpics) the flow no longer supports
		// `epic`. A stored epic create proposal is normalized to a feature, so
		// it renders with the Feature/Bug selector (FEATURE pre-selected).
		renderProposal({
			forbidEpics: true,
			changes: [
				makeCreateChange({
					type: "epic",
					title: { to: "Mobile launch initiative" },
				}),
			],
		});
		const group = screen.getByRole("radiogroup", {
			name: /Work item type for "Mobile launch initiative"/,
		});
		expect(
			within(group).getByRole("radio", { name: "Feature" }),
		).toHaveAttribute("aria-checked", "true");
		// Only Feature and Bug — no Epic, no Story.
		expect(
			within(group).queryByRole("radio", { name: /Epic/i }),
		).toBeNull();
		expect(
			within(group).queryByRole("radio", { name: /Story/i }),
		).toBeNull();
		expect(within(group).queryAllByRole("radio")).toHaveLength(2);
	});

	it("does NOT render a selector for an UPDATE row (existing item keeps its kind)", () => {
		renderProposal({ changes: [makeUpdateChange()] });
		expect(screen.queryByRole("radiogroup")).toBeNull();
	});

	it("UPDATE rows surface kind as a readonly pill (Feature for feature-typed update)", () => {
		renderProposal({
			changes: [
				makeUpdateChange({
					type: "feature",
					title: { from: "Old", to: "Updated title" },
				}),
			],
		});
		// No interactive selector...
		expect(screen.queryByRole("radiogroup")).toBeNull();
		// ...but the readonly pill is present and labelled "locked".
		const pill = screen.getByRole("img", {
			name: /Updated title.*Feature \(locked/,
		});
		expect(pill).toBeInTheDocument();
		expect(pill).toHaveTextContent("Feature");
	});

	it("UPDATE rows show Bug pill for bug-typed updates", () => {
		renderProposal({
			changes: [
				makeUpdateChange({
					type: "bug",
					title: { from: "Old bug", to: "Updated bug title" },
				}),
			],
		});
		expect(screen.queryByRole("radiogroup")).toBeNull();
		const pill = screen.getByRole("img", {
			name: /Updated bug title.*Bug \(locked/,
		});
		expect(pill).toBeInTheDocument();
		expect(pill).toHaveTextContent("Bug");
	});

	it("UPDATE rows on legacy 'story' type also show Feature pill (no Story option)", () => {
		renderProposal({
			changes: [
				makeUpdateChange({
					type: "story",
					title: { from: "Old story", to: "Updated story title" },
				}),
			],
		});
		expect(screen.queryByRole("radiogroup")).toBeNull();
		expect(
			screen.getByRole("img", {
				name: /Updated story title.*Feature \(locked/,
			}),
		).toBeInTheDocument();
	});

	it("UPDATE rows never carry kindOverride on approve (locked at backend boundary)", async () => {
		const user = userEvent.setup();
		const onApprove = vi.fn();
		renderProposal({
			changes: [
				makeUpdateChange({
					type: "feature",
					title: { from: "Old", to: "Updated" },
				}),
			],
			onApprove,
		});

		await user.click(
			screen.getByRole("button", { name: /Apply Selected/ }),
		);

		const approvedChanges: ChangeItem[] = onApprove.mock.calls[0]?.[0];
		expect(approvedChanges).toHaveLength(1);
		expect(approvedChanges[0]?.action).toBe("update");
		expect(approvedChanges[0]?.kindOverride).toBeUndefined();
	});

	it("clicking the other option flips the selection", async () => {
		const user = userEvent.setup();
		renderProposal({ changes: [makeCreateChange({ type: "bug" })] });

		const group = screen.getByRole("radiogroup");
		const featureBtn = within(group).getByRole("radio", {
			name: "Feature",
		});
		await user.click(featureBtn);

		expect(featureBtn).toHaveAttribute("aria-checked", "true");
		expect(
			within(group).getByRole("radio", { name: "Bug" }),
		).toHaveAttribute("aria-checked", "false");
	});

	it("the default selection is NOT sent on approve (server-side noise reduction)", async () => {
		const user = userEvent.setup();
		const onApprove = vi.fn();
		renderProposal({
			changes: [makeCreateChange({ type: "bug" })],
			onApprove,
		});

		await user.click(
			screen.getByRole("button", { name: /Apply Selected/ }),
		);

		expect(onApprove).toHaveBeenCalledOnce();
		const approvedChanges: ChangeItem[] = onApprove.mock.calls[0]?.[0];
		expect(approvedChanges).toHaveLength(1);
		// The user never touched the selector → no override should be sent.
		expect(approvedChanges[0]?.kindOverride).toBeUndefined();
	});

	it("a diverging selection IS sent on approve as change.kindOverride", async () => {
		const user = userEvent.setup();
		const onApprove = vi.fn();
		renderProposal({
			changes: [makeCreateChange({ type: "bug" })],
			onApprove,
		});

		// Override bug → feature
		await user.click(screen.getByRole("radio", { name: "Feature" }));
		await user.click(
			screen.getByRole("button", { name: /Apply Selected/ }),
		);

		const approvedChanges: ChangeItem[] = onApprove.mock.calls[0]?.[0];
		expect(approvedChanges[0]?.kindOverride).toBe("FEATURE");
	});

	it("flipping a feature row to BUG sends kindOverride=BUG", async () => {
		const user = userEvent.setup();
		const onApprove = vi.fn();
		renderProposal({
			changes: [
				makeCreateChange({
					type: "feature",
					title: { to: "Misclassified bug" },
				}),
			],
			onApprove,
		});

		await user.click(screen.getByRole("radio", { name: "Bug" }));
		await user.click(
			screen.getByRole("button", { name: /Apply Selected/ }),
		);

		const approvedChanges: ChangeItem[] = onApprove.mock.calls[0]?.[0];
		expect(approvedChanges[0]?.kindOverride).toBe("BUG");
	});

	it("flipping back to the default kind strips the override (treated as no change)", async () => {
		const user = userEvent.setup();
		const onApprove = vi.fn();
		renderProposal({
			changes: [makeCreateChange({ type: "bug" })],
			onApprove,
		});

		// bug → feature → bug (back to default)
		await user.click(screen.getByRole("radio", { name: "Feature" }));
		await user.click(screen.getByRole("radio", { name: "Bug" }));
		await user.click(
			screen.getByRole("button", { name: /Apply Selected/ }),
		);

		const approvedChanges: ChangeItem[] = onApprove.mock.calls[0]?.[0];
		expect(approvedChanges[0]?.kindOverride).toBeUndefined();
	});

	it("the 'Type changed from AI suggestion' indicator shows ONLY when the kind diverges from the AI default — toggling back to default hides it (regression)", async () => {
		const user = userEvent.setup();
		renderProposal({ changes: [makeCreateChange({ type: "bug" })] });
		const group = screen.getByRole("radiogroup");

		// The indicator dot is decorative (`aria-hidden`) and its copy now lives
		// in a `<Tooltip>` plus an `sr-only` note rather than a native `title`
		// (see fabric/standards/frontend/tooltips.md). `useTranslations` is
		// globally mocked to echo the key, so the note renders as the key name.
		const marker = "typeOverridden";

		// Pre-selected at the AI default (bug) → no "changed" indicator.
		expect(screen.queryByText(marker)).toBeNull();

		// Diverge bug → feature → indicator appears.
		await user.click(within(group).getByRole("radio", { name: "Feature" }));
		expect(screen.getByText(marker)).toBeInTheDocument();

		// Toggle back to the AI default (bug) → indicator disappears, because the
		// effective kind once again matches the analyzer's suggestion.
		await user.click(within(group).getByRole("radio", { name: "Bug" }));
		expect(screen.queryByText(marker)).toBeNull();
	});

	it("only the active radio is in the tab order (roving tabindex)", () => {
		renderProposal({ changes: [makeCreateChange({ type: "bug" })] });
		const group = screen.getByRole("radiogroup");
		const featureBtn = within(group).getByRole("radio", {
			name: "Feature",
		});
		const bugBtn = within(group).getByRole("radio", { name: "Bug" });
		// "bug" type → BUG checked → only Bug has tabIndex=0.
		expect(bugBtn).toHaveAttribute("tabIndex", "0");
		expect(featureBtn).toHaveAttribute("tabIndex", "-1");
	});

	it("ArrowRight / ArrowDown move selection to the next option", async () => {
		const user = userEvent.setup();
		renderProposal({ changes: [makeCreateChange({ type: "bug" })] });
		const group = screen.getByRole("radiogroup");
		const bugBtn = within(group).getByRole("radio", { name: "Bug" });
		bugBtn.focus();

		await user.keyboard("{ArrowRight}");
		expect(
			within(group).getByRole("radio", { name: "Feature" }),
		).toHaveAttribute("aria-checked", "true");

		await user.keyboard("{ArrowDown}");
		// Wraps back to Bug.
		expect(
			within(group).getByRole("radio", { name: "Bug" }),
		).toHaveAttribute("aria-checked", "true");
	});

	it("ArrowLeft / ArrowUp move selection to the previous option", async () => {
		const user = userEvent.setup();
		renderProposal({ changes: [makeCreateChange({ type: "bug" })] });
		const group = screen.getByRole("radiogroup");
		const bugBtn = within(group).getByRole("radio", { name: "Bug" });
		bugBtn.focus();

		await user.keyboard("{ArrowLeft}");
		expect(
			within(group).getByRole("radio", { name: "Feature" }),
		).toHaveAttribute("aria-checked", "true");

		await user.keyboard("{ArrowUp}");
		expect(
			within(group).getByRole("radio", { name: "Bug" }),
		).toHaveAttribute("aria-checked", "true");
	});

	it("Home / End jump to first / last option", async () => {
		const user = userEvent.setup();
		renderProposal({ changes: [makeCreateChange({ type: "bug" })] });
		const group = screen.getByRole("radiogroup");
		const bugBtn = within(group).getByRole("radio", { name: "Bug" });
		bugBtn.focus();

		await user.keyboard("{Home}");
		expect(
			within(group).getByRole("radio", { name: "Feature" }),
		).toHaveAttribute("aria-checked", "true");

		await user.keyboard("{End}");
		expect(
			within(group).getByRole("radio", { name: "Bug" }),
		).toHaveAttribute("aria-checked", "true");
	});

	it("only the explicitly-overridden row carries kindOverride; siblings are untouched", async () => {
		const user = userEvent.setup();
		const onApprove = vi.fn();
		renderProposal({
			changes: [
				makeCreateChange({ type: "bug", title: { to: "First item" } }),
				makeCreateChange({ type: "bug", title: { to: "Second item" } }),
			],
			onApprove,
		});

		const firstGroup = screen.getByRole("radiogroup", {
			name: /Work item type for "First item"/,
		});
		await user.click(
			within(firstGroup).getByRole("radio", { name: "Feature" }),
		);
		await user.click(
			screen.getByRole("button", { name: /Apply Selected/ }),
		);

		const approvedChanges: ChangeItem[] = onApprove.mock.calls[0]?.[0];
		expect(approvedChanges[0]?.kindOverride).toBe("FEATURE");
		expect(approvedChanges[1]?.kindOverride).toBeUndefined();
	});
});

describe("BacklogChangeProposal — approve payload epic scoping (Codex P1)", () => {
	it("forbidEpics: approving an epic CREATE submits the change as type:'feature'", async () => {
		const user = userEvent.setup();
		const onApprove = vi.fn();
		renderProposal({
			forbidEpics: true,
			changes: [
				makeCreateChange({
					type: "epic",
					title: { to: "Mobile launch initiative" },
				}),
			],
			onApprove,
		});

		await user.click(
			screen.getByRole("button", { name: /Apply Selected/ }),
		);

		const approvedChanges: ChangeItem[] = onApprove.mock.calls[0]?.[0];
		expect(approvedChanges).toHaveLength(1);
		// Channel-monitor flow: epic was normalized to feature before submit.
		expect(approvedChanges[0]?.type).toBe("feature");
	});

	it("DEFAULT flow: approving an epic CREATE submits the change as type:'epic' — general epic creation is NOT broken (the P1 regression guard)", async () => {
		const user = userEvent.setup();
		const onApprove = vi.fn();
		renderProposal({
			// No forbidEpics → general AI Update flow.
			changes: [
				makeCreateChange({
					type: "epic",
					title: { to: "Mobile launch initiative" },
				}),
			],
			onApprove,
		});

		await user.click(
			screen.getByRole("button", { name: /Apply Selected/ }),
		);

		const approvedChanges: ChangeItem[] = onApprove.mock.calls[0]?.[0];
		expect(approvedChanges).toHaveLength(1);
		// General flow: the epic must remain an epic in the submitted payload.
		expect(approvedChanges[0]?.type).toBe("epic");
	});
});

describe("BacklogChangeProposal — lazy draft on open (proper draft right away)", () => {
	it("opening a CREATE proposal drafts its body through the kind prompt", async () => {
		const user = userEvent.setup();
		reformatMock.mockReset();
		reformatMock.mockResolvedValue({
			kind: "BUG",
			description: "## Steps to Reproduce\n1. drafted by project prompt",
			acceptanceCriteria: null,
			needsMoreInfo: true,
			aiDrafted: true,
		});
		renderProposal({
			changes: [
				makeCreateChange({
					type: "bug",
					title: { to: "Login crash" },
					description: { to: "raw analyzer body" },
				}),
			],
			projectId: "proj-1",
		});

		await user.click(
			screen.getByRole("button", { name: /Open full detail to review/ }),
		);

		// On open, the proposed body is drafted through the BUG prompt — right
		// away, not deferred to approve.
		await waitFor(() => expect(reformatMock).toHaveBeenCalled());
		expect(reformatMock).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				kind: "BUG",
				title: "Login crash",
			}),
		);
	});

	it("a pre-drafted CREATE sends predrafted + needsMoreInfo + the drafted body on approve", async () => {
		const user = userEvent.setup();
		const onApprove = vi.fn();
		reformatMock.mockReset();
		reformatMock.mockResolvedValue({
			kind: "BUG",
			description: "DRAFTED BUG BODY",
			acceptanceCriteria: null,
			needsMoreInfo: true,
			aiDrafted: true,
		});
		renderProposal({
			changes: [
				makeCreateChange({
					type: "bug",
					title: { to: "Login crash" },
					description: { to: "raw analyzer body" },
				}),
			],
			onApprove,
			projectId: "proj-1",
		});

		await user.click(
			screen.getByRole("button", { name: /Open full detail to review/ }),
		);
		await waitFor(() => expect(reformatMock).toHaveBeenCalled());
		// Close the detail dialog, then apply from the list.
		await user.keyboard("{Escape}");
		await user.click(
			screen.getByRole("button", { name: /Apply Selected/ }),
		);

		const approvedChanges: ChangeItem[] = onApprove.mock.calls[0]?.[0];
		expect(approvedChanges).toHaveLength(1);
		expect(approvedChanges[0]?.predrafted).toBe(true);
		expect(approvedChanges[0]?.needsMoreInfo).toBe(true);
		expect(approvedChanges[0]?.description?.to).toBe("DRAFTED BUG BODY");
	});

	it("an un-opened CREATE is NOT pre-drafted on approve (lazy — only what you review)", async () => {
		const user = userEvent.setup();
		const onApprove = vi.fn();
		reformatMock.mockReset();
		renderProposal({
			changes: [
				makeCreateChange({ type: "bug", title: { to: "Untouched" } }),
			],
			onApprove,
			projectId: "proj-1",
		});

		// Bulk-approve straight from the list, never opening the detail.
		await user.click(
			screen.getByRole("button", { name: /Apply Selected/ }),
		);

		expect(reformatMock).not.toHaveBeenCalled();
		const approvedChanges: ChangeItem[] = onApprove.mock.calls[0]?.[0];
		expect(approvedChanges[0]?.predrafted).toBeUndefined();
	});
});
