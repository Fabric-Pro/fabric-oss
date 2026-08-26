import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────
// Everything the mock factories reference must be hoisted (factories run before
// the module body). The dialog reads several TanStack queries/mutations + orpc,
// so we dispatch each by the `__leaf` tag its orpc stub stamps on.
const h = vi.hoisted(() => ({
	useQueryMock: vi.fn(),
	applyMutate: vi.fn(),
	readdMutate: vi.fn(),
	reattachMutate: vi.fn(),
	invalidateMock: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	toastInfo: vi.fn(),
}));

// The real Security view is a CLIENT-SIDE tab, so `usePathname()` returns the
// project ROOT (…/projects/<id>) — it does NOT end in `/security`. Mock that
// realistic URL so the ticket→story link assertions reflect production (the
// old `/app/proj-1/security` mock hid the bug where the href stayed at root).
vi.mock("next/navigation", () => ({
	usePathname: () => "/app/example-org/projects/proj-1",
}));

vi.mock("@tanstack/react-query", () => ({
	useQuery: (opts: { __leaf?: string }) => h.useQueryMock(opts),
	useMutation: (opts: {
		__leaf?: string;
		onSuccess?: (r: unknown) => void;
	}) => {
		const leaf = opts.__leaf;
		const spy =
			leaf === "apply"
				? h.applyMutate
				: leaf === "readd"
					? h.readdMutate
					: h.reattachMutate;
		return {
			mutate: (vars: unknown) => {
				spy(vars);
				if (leaf === "apply") {
					opts.onSuccess?.({
						createdCount: 1,
						updatedCount: 0,
						declinedCount: 0,
					});
				} else if (leaf === "readd") {
					opts.onSuccess?.({
						storyId: "story-readd",
						storyIdentifier: "F-200",
					});
				} else {
					opts.onSuccess?.({
						targetStoryId: "story-target",
						targetIdentifier: "F-77",
					});
				}
			},
			isPending: false,
			variables: undefined,
		};
	},
	useQueryClient: () => ({ invalidateQueries: h.invalidateMock }),
}));

vi.mock("sonner", () => ({
	toast: {
		success: (...a: unknown[]) => h.toastSuccess(...a),
		error: (...a: unknown[]) => h.toastError(...a),
		info: (...a: unknown[]) => h.toastInfo(...a),
	},
}));

// Tag each orpc leaf so the useQuery/useMutation mocks can dispatch on it.
vi.mock("@shared/lib/orpc-query-utils", () => {
	const makeLeaf = (name: string) => ({
		queryOptions: (o: Record<string, unknown>) => ({ ...o, __leaf: name }),
		mutationOptions: (o: Record<string, unknown>) => ({
			...o,
			__leaf: name,
		}),
		key: () => [name],
	});
	return {
		orpc: {
			projects: {
				stories: {
					list: makeLeaf("stories.list"),
					pmCapabilities: makeLeaf("stories.pmCapabilities"),
				},
				scan: {
					grouping: {
						apply: makeLeaf("apply"),
						readd: makeLeaf("readd"),
						reattach: makeLeaf("reattach"),
						latest: makeLeaf("latest"),
					},
				},
			},
		},
	};
});

import { GroupingResultsDialog } from "../GroupingResultsDialog";
import type {
	GroupingProposalCreate,
	GroupingProposalUpdate,
	GroupingRunResults,
	ScanFindingGrouping,
} from "../lib";

beforeAll(() => {
	HTMLElement.prototype.hasPointerCapture ??= () => false;
	HTMLElement.prototype.scrollIntoView ??= () => {};
});

/** Open work items returned as reattach targets by the `stories.list` query. */
const STORY_TARGETS = [
	{
		id: "story-target",
		identifier: "77",
		title: "Existing accessibility ticket",
		status: { isFinal: false },
	},
];

/** Point `stories.pmCapabilities` at a connected (or not) PM tool. */
function primePM(configured: boolean, detectedType: string | null = null) {
	h.useQueryMock.mockImplementation((opts: { __leaf?: string }) => {
		if (opts?.__leaf === "stories.pmCapabilities") {
			return { data: { configured, detectedType } };
		}
		// stories.list — reattach targets
		return { data: { stories: STORY_TARGETS } };
	});
}

beforeEach(() => {
	h.useQueryMock.mockReset();
	h.applyMutate.mockReset();
	h.readdMutate.mockReset();
	h.reattachMutate.mockReset();
	h.invalidateMock.mockReset();
	h.toastSuccess.mockReset();
	h.toastError.mockReset();
	h.toastInfo.mockReset();
	primePM(false); // default: no PM tool connected
});

// ── Test-data builders (typed against the server-inferred contract) ──────────
function createProposal(
	themeKey: string,
	title: string,
	extra: Partial<GroupingProposalCreate> = {},
): GroupingProposalCreate {
	return {
		category: "SECURITY",
		ruleSource: "OWASP Top 10 — A03:2021 Injection",
		themeKey,
		findingCount: 3,
		severity: "HIGH",
		title,
		body: "Proposed ticket body.",
		priority: "P1_HIGH",
		fingerprints: [],
		...extra,
	};
}

function updateProposal(
	themeKey: string,
	storyId: string,
	storyIdentifier: string,
	extra: Partial<GroupingProposalUpdate> = {},
): GroupingProposalUpdate {
	return {
		category: "ACCESSIBILITY",
		ruleSource: "WCAG 2.1 AA — 1.4.3 Contrast (Minimum)",
		themeKey,
		findingCount: 5,
		storyId,
		storyIdentifier,
		newFindingCount: 2,
		commentBody: "Two new findings since the last run.",
		newFingerprints: [],
		cumulativeFingerprints: [],
		...extra,
	};
}

function buildGrouping(
	results: GroupingRunResults,
	overrides?: Partial<ScanFindingGrouping>,
): ScanFindingGrouping {
	return {
		id: "grp-1",
		status: "COMPLETED",
		results,
		...overrides,
	} as unknown as ScanFindingGrouping;
}

/** Render the dialog in REVIEW mode (status AWAITING_REVIEW). */
function renderReview(results: GroupingRunResults) {
	const onClose = vi.fn();
	render(
		<GroupingResultsDialog
			grouping={buildGrouping(results, { status: "AWAITING_REVIEW" })}
			isOpen
			onClose={onClose}
			projectId="proj-1"
			organizationId={null}
		/>,
	);
	return { onClose };
}

/** Render the dialog in RESULTS mode (status COMPLETED). */
function renderResults(results: GroupingRunResults, projectId?: string) {
	const onClose = vi.fn();
	render(
		<GroupingResultsDialog
			grouping={buildGrouping(results)}
			isOpen
			onClose={onClose}
			projectId={projectId}
			organizationId={projectId ? null : undefined}
		/>,
	);
	return { onClose };
}

// ── REVIEW mode ──────────────────────────────────────────────────────────────
describe("GroupingResultsDialog — review mode", () => {
	it("an empty review still offers Finish review (so the run can be completed, not stuck)", () => {
		renderReview({
			proposedCreate: [],
			proposedUpdate: [],
			declinedThemes: [],
		});
		expect(
			screen.getByText(/no open findings to group/i),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /finish review/i }),
		).toBeInTheDocument();
	});

	it("renders proposed create, update, and declined rows", () => {
		renderReview({
			proposedCreate: [createProposal("tc1", "[Security] SQL injection")],
			proposedUpdate: [updateProposal("tu1", "story-9", "F-9")],
			declinedThemes: [
				createProposal("td1", "[Security] Verbose errors", {
					findingCount: 1,
				}),
			],
		});

		// Create proposal — accepted (checked) by default.
		expect(
			screen.getByText("[Security] SQL injection"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("checkbox", {
				name: /create ticket: \[security\] sql injection/i,
			}),
		).toBeChecked();

		// Update proposal — "Add comment" on an existing linked ticket.
		expect(screen.getByText("Add comment")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: /F-9/i })).toHaveAttribute(
			"href",
			"/app/example-org/projects/proj-1/stories/story-9",
		);

		// Declined proposal — offered a Re-add.
		expect(
			screen.getByText("[Security] Verbose errors"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /re-?add/i }),
		).toBeInTheDocument();
	});

	it("drops a row from the apply payload when its accept checkbox is unchecked", async () => {
		const user = userEvent.setup();
		renderReview({
			proposedCreate: [
				createProposal("tc1", "First ticket"),
				createProposal("tc2", "Second ticket"),
			],
		});

		await user.click(
			screen.getByRole("checkbox", {
				name: /create ticket: second ticket/i,
			}),
		);
		await user.click(
			screen.getByRole("button", { name: /create 1 ticket/i }),
		);

		expect(h.applyMutate).toHaveBeenCalledTimes(1);
		expect(h.applyMutate.mock.calls[0][0]).toEqual({
			projectId: "proj-1",
			organizationId: null,
			groupingId: "grp-1",
			accepted: [{ themeKey: "tc1", syncToPM: false }],
			declinedThemeKeys: [],
		});
	});

	it("reveals the proposal body when Preview is toggled", async () => {
		const user = userEvent.setup();
		renderReview({
			proposedCreate: [
				createProposal("tc1", "Preview me", {
					body: "DETAILED-REMEDIATION-STEPS",
				}),
			],
		});

		expect(
			screen.queryByText("DETAILED-REMEDIATION-STEPS"),
		).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /preview/i }));
		expect(
			screen.getByText("DETAILED-REMEDIATION-STEPS"),
		).toBeInTheDocument();
	});

	it("declining a proposal marks the row declined and sends it as declinedThemeKeys", async () => {
		const user = userEvent.setup();
		renderReview({
			proposedCreate: [createProposal("tc1", "Decline me")],
		});

		await user.click(screen.getByRole("button", { name: /^decline$/i }));

		// The row is now visibly declined…
		expect(screen.getByText("Declined")).toBeInTheDocument();

		// …and applying sends it under declinedThemeKeys, with nothing accepted.
		await user.click(screen.getByRole("button", { name: /^apply$/i }));
		expect(h.applyMutate.mock.calls[0][0]).toMatchObject({
			accepted: [],
			declinedThemeKeys: ["tc1"],
		});
	});

	it("Select all clears and restores every acceptance", async () => {
		const user = userEvent.setup();
		renderReview({
			proposedCreate: [
				createProposal("tc1", "Alpha"),
				createProposal("tc2", "Beta"),
			],
		});

		expect(
			screen.getByRole("button", { name: /create 2 tickets/i }),
		).toBeInTheDocument();

		const selectAll = screen.getByRole("checkbox", {
			name: /select all tickets/i,
		});
		expect(selectAll).toBeChecked();

		await user.click(selectAll); // clear
		expect(
			screen.getByRole("button", { name: /finish review/i }),
		).toBeInTheDocument();

		await user.click(selectAll); // restore
		expect(
			screen.getByRole("button", { name: /create 2 tickets/i }),
		).toBeInTheDocument();
	});

	it("Create N tickets applies every accepted create and update", async () => {
		const user = userEvent.setup();
		renderReview({
			proposedCreate: [
				createProposal("tc1", "Alpha"),
				createProposal("tc2", "Beta"),
			],
			proposedUpdate: [updateProposal("tu1", "story-9", "F-9")],
		});

		await user.click(
			screen.getByRole("button", { name: /create 3 tickets/i }),
		);

		expect(h.applyMutate.mock.calls[0][0]).toEqual({
			projectId: "proj-1",
			organizationId: null,
			groupingId: "grp-1",
			accepted: [
				{ themeKey: "tc1", syncToPM: false },
				{ themeKey: "tc2", syncToPM: false },
				{ themeKey: "tu1", syncToPM: false },
			],
			declinedThemeKeys: [],
		});
	});

	it("with a PM tool configured, per-ticket sync is on by default and a toggle flows into apply", async () => {
		primePM(true, "Jira");
		const user = userEvent.setup();
		renderReview({
			proposedCreate: [
				createProposal("tc1", "Alpha ticket"),
				createProposal("tc2", "Beta ticket"),
			],
		});

		// Header "Sync all to Jira" appears for a connected PM tool.
		expect(
			screen.getByRole("checkbox", { name: /sync all to jira/i }),
		).toBeInTheDocument();

		// Turn OFF sync for the first ticket only.
		await user.click(
			screen.getByRole("checkbox", {
				name: /sync alpha ticket to jira/i,
			}),
		);
		await user.click(
			screen.getByRole("button", { name: /create 2 tickets/i }),
		);

		expect(h.applyMutate.mock.calls[0][0]).toMatchObject({
			accepted: [
				{ themeKey: "tc1", syncToPM: false },
				{ themeKey: "tc2", syncToPM: true },
			],
			declinedThemeKeys: [],
		});
	});

	it("hides all sync controls when no PM tool is configured", () => {
		primePM(false);
		renderReview({
			proposedCreate: [createProposal("tc1", "Alpha ticket")],
		});

		expect(
			screen.queryByRole("checkbox", { name: /sync all/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("checkbox", { name: /sync .* to/i }),
		).not.toBeInTheDocument();
		// The accept + select-all checkboxes still render (not PM-gated).
		expect(
			screen.getByRole("checkbox", { name: /select all tickets/i }),
		).toBeInTheDocument();
	});
});

// ── RESULTS mode ─────────────────────────────────────────────────────────────
describe("GroupingResultsDialog — results mode", () => {
	it("renders a Created row with its ticket link, ruleSource, and finding count", () => {
		renderResults({
			createdThemes: [
				{
					category: "SECURITY",
					ruleSource: "OWASP Top 10 — A03:2021 Injection",
					themeKey: "theme-created-1",
					findingCount: 3,
					storyId: "story-1",
					storyIdentifier: "F-101",
				},
			],
		});

		expect(screen.getByText("Created")).toBeInTheDocument();
		expect(
			screen.getByText("OWASP Top 10 — A03:2021 Injection"),
		).toBeInTheDocument();
		expect(screen.getByText(/3 findings/i)).toBeInTheDocument();
		expect(screen.getByRole("link", { name: /F-101/i })).toHaveAttribute(
			"href",
			"/app/example-org/projects/proj-1/stories/story-1",
		);
	});

	it("renders an Updated row with its new-finding count", () => {
		renderResults({
			updatedThemes: [
				{
					category: "ACCESSIBILITY",
					ruleSource: "WCAG 2.1 AA — 1.4.3 Contrast (Minimum)",
					themeKey: "theme-updated-1",
					findingCount: 5,
					newFindingCount: 2,
					storyId: "story-2",
					storyIdentifier: "F-102",
				},
			],
		});

		expect(screen.getByText("Updated")).toBeInTheDocument();
		expect(screen.getByText(/5 findings/i)).toBeInTheDocument();
		expect(screen.getByText(/2 new/i)).toBeInTheDocument();
	});

	it("renders a Failed row with its reason and no ticket link", () => {
		renderResults({
			failedThemes: [
				{
					category: "SECURITY",
					ruleSource: "Semgrep: sql-injection",
					themeKey: "theme-failed-1",
					findingCount: 1,
					reason: "theme_limit_exceeded",
				},
			],
		});

		expect(screen.getByText("Failed")).toBeInTheDocument();
		expect(screen.getByText("theme_limit_exceeded")).toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: /^F-/i }),
		).not.toBeInTheDocument();
	});

	it("re-adds a declined theme from the results view", async () => {
		const user = userEvent.setup();
		renderResults(
			{
				declinedThemes: [
					createProposal("theme-declined-x", "[Security] Declined", {
						findingCount: 1,
					}),
				],
			},
			"proj-1",
		);

		await user.click(screen.getByRole("button", { name: /re-?add/i }));

		expect(h.readdMutate).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: null,
			groupingId: "grp-1",
			themeKey: "theme-declined-x",
		});
	});

	it("reattaches a created theme to a chosen target ticket", async () => {
		const user = userEvent.setup();
		renderResults(
			{
				createdThemes: [
					{
						category: "ACCESSIBILITY",
						ruleSource: "WCAG 2.1 AA — 1.4.3 Contrast (Minimum)",
						themeKey: "theme-created-reattach",
						findingCount: 4,
						storyId: "story-created",
						storyIdentifier: "F-9",
					},
				],
			},
			"proj-1",
		);

		// Open the inline picker for the row.
		await user.click(screen.getByRole("button", { name: /reattach/i }));
		// Pick the target ticket (the mocked open story) and confirm.
		await user.selectOptions(
			screen.getByRole("combobox", { name: /target ticket/i }),
			"story-target",
		);
		const [, confirm] = screen.getAllByRole("button", {
			name: /reattach/i,
		});
		await user.click(confirm);

		expect(h.reattachMutate).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: null,
			themeKey: "theme-created-reattach",
			targetStoryId: "story-target",
		});
	});

	it("shows a single Close action and an empty message, with no apply/create", async () => {
		const user = userEvent.setup();
		const { onClose } = renderResults({});

		expect(
			screen.getByText(/no open findings to group this run/i),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /apply/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /create/i }),
		).not.toBeInTheDocument();

		// The footer Close + Radix's corner "X" (sr-only "Close") share the name;
		// the footer one renders first in the DOM and calls onClose.
		const closeButtons = screen.getAllByRole("button", { name: /close/i });
		expect(closeButtons).toHaveLength(2);
		await user.click(closeButtons[0]);
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
