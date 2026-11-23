import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BacklogChangeDetailDialog } from "../BacklogChangeDetailDialog";
import type { ChangeItem } from "../BacklogChangeProposal";

const trackEvent = vi.hoisted(() => vi.fn());

vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent }),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	useBasePath: () => "/app/example-org",
}));

const updateChange: ChangeItem = {
	type: "story",
	action: "update",
	existingId: "story-1",
	existingIdentifier: "S-101",
	title: {
		from: "Old title",
		to: "New title with significantly more detail",
	},
	description: {
		from: "Original short description.",
		to: "Updated description with multiple paragraphs.\n\nThis paragraph is intentionally long enough that the original list-view preview would have truncated it via line-clamp-2 — we want the detail dialog to show every word here so the PM can decide based on the full proposed text rather than a snippet.",
	},
	acceptanceCriteria: {
		from: "- Login works",
		to: "- Login works\n- 2FA enforced\n- Session refreshes silently before expiry",
	},
	priority: { from: "P3", to: "P1" },
	size: { from: "M", to: "L" },
	parentEpicIdentifier: "E-12",
	parentEpicTitle: "Auth refresh",
	reasoning:
		"PM raised the priority and added 2FA to the acceptance criteria during the Apr 27 DSU.",
	sourceContext: "meeting_transcript",
};

const createChange: ChangeItem = {
	type: "feature",
	action: "create",
	title: { to: "New feature: workspace search" },
	description: {
		to: "Lets users search across all workspaces from one input.",
	},
	parentEpicIdentifier: "E-7",
	parentEpicTitle: "Discoverability",
	reasoning: "Two customers asked for this in the last week.",
	sourceContext: "teams_messages",
};

function makeProps(
	overrides: Partial<
		React.ComponentProps<typeof BacklogChangeDetailDialog>
	> = {},
) {
	return {
		open: true,
		onOpenChange: vi.fn(),
		change: updateChange,
		index: 0,
		totalCount: 3,
		isSelected: true,
		canGoPrev: false,
		canGoNext: true,
		onApprove: vi.fn(),
		onReject: vi.fn(),
		onPrev: vi.fn(),
		onNext: vi.fn(),
		// Defaults: every field is accepted (no entries in the skip set).
		skippedFields: new Set<
			"title" | "description" | "acceptanceCriteria" | "priority" | "size"
		>(),
		onToggleField: vi.fn(),
		...overrides,
	};
}

/** The `<section>` a field's heading (by id) labels. */
function fieldSection(headingId: string): HTMLElement {
	const section = document.getElementById(headingId)?.closest("section");
	if (!section) {
		throw new Error(`no section for ${headingId}`);
	}
	return section;
}

describe("BacklogChangeDetailDialog", () => {
	it("renders the full title + position counter in the header", () => {
		render(<BacklogChangeDetailDialog {...makeProps()} />);
		// Heading carries the full title — use the role query so we
		// don't collide with the "After" copy of the title in the diff
		// body below.
		expect(
			screen.getByRole("heading", {
				name: /New title with significantly more detail/,
			}),
		).toBeInTheDocument();
		// Position counter shows 1-based index of N items.
		expect(screen.getByText("1 of 3")).toBeInTheDocument();
	});

	it("renders the FULL description (no line-clamp / no slice truncation)", () => {
		// Regression for the original ~200-char preview: the Apr 27
		// complaint was that the list view truncates so PMs cannot
		// review what they are approving. The detail dialog must show
		// the entire proposed text — every paragraph, every line break.
		render(<BacklogChangeDetailDialog {...makeProps()} />);
		const fullText = updateChange.description!.to;
		// Sanity: the description is longer than the old 200-char cap.
		expect(fullText.length).toBeGreaterThan(200);
		// testing-library normalizes whitespace by default which
		// collapses the `\n\n` paragraph break in our fixture. Compare
		// against the normalized form, AND assert that meaningful chunks
		// from both halves are present so we know the full text was
		// rendered (not truncated mid-paragraph). Scoped to the field's
		// section: the change summary above quotes its first added line.
		const section = fieldSection("detail-description");
		expect(
			within(section).getByText(
				/Updated description with multiple paragraphs\./,
			),
		).toBeInTheDocument();
		expect(
			within(section).getByText(
				/the PM can decide based on the full proposed text rather than a snippet\./,
			),
		).toBeInTheDocument();
	});

	it("renders the FULL acceptance criteria (no slice(0, 80) truncation)", () => {
		// Regression for the DiffField's `from.length > 80 ? slice(0,80)+"…"` behavior.
		render(<BacklogChangeDetailDialog {...makeProps()} />);
		const section = fieldSection("detail-acceptance-criteria");
		expect(within(section).getByText(/2FA enforced/)).toBeInTheDocument();
		expect(
			within(section).getByText(
				/Session refreshes silently before expiry/,
			),
		).toBeInTheDocument();
	});

	it("renders before+after sections for changed long-form fields", () => {
		render(<BacklogChangeDetailDialog {...makeProps()} />);
		// Title is in the header, but the body diff shows the original
		// description's "Before" content.
		expect(
			screen.getByText("Original short description."),
		).toBeInTheDocument();
		// "Before" / "After" labels appear for diffed fields.
		expect(screen.getAllByText(/Before/i).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/After/i).length).toBeGreaterThan(0);
	});

	it("renders compact metadata fields with from→to for priority/size", () => {
		render(<BacklogChangeDetailDialog {...makeProps()} />);
		expect(screen.getByText("P3")).toBeInTheDocument();
		expect(screen.getByText("P1")).toBeInTheDocument();
		expect(screen.getByText("M")).toBeInTheDocument();
		expect(screen.getByText("L")).toBeInTheDocument();
	});

	it("shows 'Approved' badge and Exclude button when item is selected", () => {
		render(
			<BacklogChangeDetailDialog {...makeProps({ isSelected: true })} />,
		);
		expect(screen.getByText(/Approved/)).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Exclude this item/ }),
		).toBeInTheDocument();
	});

	it("shows 'Excluded' badge and Approve button when item is not selected", () => {
		render(
			<BacklogChangeDetailDialog {...makeProps({ isSelected: false })} />,
		);
		expect(screen.getByText(/Excluded/)).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Approve this item/ }),
		).toBeInTheDocument();
	});

	it("calls onApprove when the Approve button is clicked", async () => {
		const user = userEvent.setup();
		const onApprove = vi.fn();
		render(
			<BacklogChangeDetailDialog
				{...makeProps({ isSelected: false, onApprove })}
			/>,
		);
		await user.click(
			screen.getByRole("button", { name: /Approve this item/ }),
		);
		expect(onApprove).toHaveBeenCalledTimes(1);
	});

	it("calls onReject when the Exclude button is clicked", async () => {
		const user = userEvent.setup();
		const onReject = vi.fn();
		render(
			<BacklogChangeDetailDialog
				{...makeProps({ isSelected: true, onReject })}
			/>,
		);
		await user.click(
			screen.getByRole("button", { name: /Exclude this item/ }),
		);
		expect(onReject).toHaveBeenCalledTimes(1);
	});

	it("disables Previous when canGoPrev is false and Next when canGoNext is false", () => {
		render(
			<BacklogChangeDetailDialog
				{...makeProps({ canGoPrev: false, canGoNext: false })}
			/>,
		);
		expect(screen.getByRole("button", { name: /Previous/ })).toBeDisabled();
		expect(screen.getByRole("button", { name: /Next/ })).toBeDisabled();
	});

	it("invokes onPrev / onNext when navigation buttons are clicked", async () => {
		const user = userEvent.setup();
		const onPrev = vi.fn();
		const onNext = vi.fn();
		render(
			<BacklogChangeDetailDialog
				{...makeProps({
					canGoPrev: true,
					canGoNext: true,
					onPrev,
					onNext,
				})}
			/>,
		);
		await user.click(screen.getByRole("button", { name: /Previous/ }));
		expect(onPrev).toHaveBeenCalledTimes(1);
		await user.click(screen.getByRole("button", { name: /Next/ }));
		expect(onNext).toHaveBeenCalledTimes(1);
	});

	it("renders 'New: <title>' header for create-action changes", () => {
		render(
			<BacklogChangeDetailDialog
				{...makeProps({ change: createChange, isSelected: true })}
			/>,
		);
		// Header reads "New: New feature: workspace search"
		expect(
			screen.getByRole("heading", {
				name: /New:.*New feature: workspace search/,
			}),
		).toBeInTheDocument();
		// Source label is humanized.
		expect(screen.getByText(/Teams messages/)).toBeInTheDocument();
		// Reasoning is shown verbatim.
		expect(
			screen.getByText("Two customers asked for this in the last week."),
		).toBeInTheDocument();
	});

	it("does not render Title diff for create changes (no `from` to compare)", () => {
		// On create, the title is in the header only — there is no
		// before/after to show. This guards against accidentally
		// rendering an empty "Title" section that would confuse PMs.
		render(
			<BacklogChangeDetailDialog
				{...makeProps({ change: createChange, isSelected: true })}
			/>,
		);
		expect(
			screen.queryByRole("heading", { level: 3, name: /Title/i }),
		).not.toBeInTheDocument();
	});

	// ──────────────────────────────────────────────────────────────────
	// Position counter
	// ──────────────────────────────────────────────────────────────────

	it("renders the position counter as a sibling of the close button (not inside the title row)", () => {
		// UX regression: the counter used to live in a flex row with
		// the dialog title, so a long title would push the counter
		// around. It now lives at absolute right-12 top-4, pinned next
		// to Radix's close button. We can't easily verify CSS
		// positioning in jsdom, but we can verify the counter is NOT a
		// descendant of the heading — that's the behavioral guarantee.
		render(<BacklogChangeDetailDialog {...makeProps()} />);
		const counter = screen.getByTestId("backlog-change-detail-counter");
		expect(counter).toHaveTextContent("1 of 3");
		const heading = screen.getByRole("heading", {
			name: /New title with significantly more detail/,
		});
		expect(heading.contains(counter)).toBe(false);
	});

	// ──────────────────────────────────────────────────────────────────
	// Per-field accept/reject (acceptance criterion #2)
	// ──────────────────────────────────────────────────────────────────

	it("renders an Accepted toggle next to each diffed field on update changes", () => {
		render(<BacklogChangeDetailDialog {...makeProps()} />);
		// One Accepted toggle per diffed field: title, description,
		// acceptance criteria, priority, size = 5 fields. The buttons
		// have aria-label "Reject <Field> change" since the default
		// state is accepted.
		expect(
			screen.getByRole("button", { name: /Reject Title change/ }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Reject Description change/ }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: /Reject Acceptance criteria change/,
			}),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Reject Priority change/ }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Reject Size change/ }),
		).toBeInTheDocument();
	});

	it("calls onToggleField with the field key when the per-field toggle is clicked", async () => {
		const user = userEvent.setup();
		const onToggleField = vi.fn();
		render(<BacklogChangeDetailDialog {...makeProps({ onToggleField })} />);
		await user.click(
			screen.getByRole("button", { name: /Reject Description change/ }),
		);
		expect(onToggleField).toHaveBeenCalledWith("description");
	});

	it("shows a Rejected pill and 'kept as-is' hint when a field is in skippedFields", () => {
		render(
			<BacklogChangeDetailDialog
				{...makeProps({
					skippedFields: new Set(["description"]),
				})}
			/>,
		);
		// The toggle for description now reads "Rejected" and the
		// aria-label becomes the inverse action.
		expect(
			screen.getByRole("button", { name: /Restore Description change/ }),
		).toBeInTheDocument();
		// And the "kept as-is" hint is shown next to the description heading.
		expect(
			screen.getByText(/field will be kept as-is/i),
		).toBeInTheDocument();
	});

	it("does not render per-field toggles on create changes (nothing to revert to)", () => {
		// Create changes have no `from` value for any field, so per-field
		// rejection makes no sense — the user uses the item-level Exclude
		// button instead.
		render(
			<BacklogChangeDetailDialog
				{...makeProps({ change: createChange, isSelected: true })}
			/>,
		);
		expect(
			screen.queryByRole("button", { name: /Reject .* change/ }),
		).not.toBeInTheDocument();
	});

	it("shows a drafting banner while reformatting so the ~minute LLM wait is visible", () => {
		render(
			<BacklogChangeDetailDialog
				{...makeProps({ change: createChange, reformatting: true })}
			/>,
		);
		expect(screen.getByText(/drafting this proposal/i)).toBeInTheDocument();
	});

	it("claims a shared draft only for the server-persisted draft", () => {
		const { unmount } = render(
			<BacklogChangeDetailDialog
				{...makeProps({ change: createChange, reformatting: true })}
			/>,
		);
		expect(screen.queryByText(/shared with your team/i)).toBeNull();
		unmount();

		render(
			<BacklogChangeDetailDialog
				{...makeProps({
					change: createChange,
					reformatting: true,
					draftStatus: "RUNNING",
					draftStartedAt: new Date().toISOString(),
				})}
			/>,
		);
		expect(screen.getByText(/shared with your team/i)).toBeInTheDocument();
	});

	it("does not show the drafting banner when not reformatting", () => {
		render(
			<BacklogChangeDetailDialog
				{...makeProps({ change: createChange, reformatting: false })}
			/>,
		);
		expect(screen.queryByText(/drafting this proposal/i)).toBeNull();
	});

	it("shows the count-up elapsed counter while drafting (from the server startedAt)", () => {
		render(
			<BacklogChangeDetailDialog
				{...makeProps({
					change: createChange,
					reformatting: true,
					draftStatus: "RUNNING",
					draftStartedAt: new Date(Date.now() - 95_000).toISOString(),
				})}
			/>,
		);
		// ~95s elapsed → a M:SS counter; anchored so it matches only the
		// counter span (not the surrounding banner copy).
		expect(screen.getByText(/^\d{1,2}:\d{2}$/)).toBeInTheDocument();
	});

	it("Cancel fires onCancelDraft while a draft is RUNNING", () => {
		const onCancelDraft = vi.fn();
		render(
			<BacklogChangeDetailDialog
				{...makeProps({
					change: createChange,
					reformatting: true,
					draftStatus: "RUNNING",
					draftStartedAt: new Date().toISOString(),
					onCancelDraft,
				})}
			/>,
		);
		screen.getByRole("button", { name: /^Cancel$/ }).click();
		expect(onCancelDraft).toHaveBeenCalledOnce();
	});

	it("offers 'Draft with AI' for a create with no draft yet and fires onStartDraft", () => {
		const onStartDraft = vi.fn();
		render(
			<BacklogChangeDetailDialog
				{...makeProps({
					change: createChange,
					reformatting: false,
					draftStatus: undefined,
					onStartDraft,
				})}
			/>,
		);
		screen.getByRole("button", { name: /^Draft with AI$/ }).click();
		expect(onStartDraft).toHaveBeenCalledOnce();
	});

	it("labels the button 'Re-draft' once a draft is completed", () => {
		render(
			<BacklogChangeDetailDialog
				{...makeProps({
					change: createChange,
					reformatting: false,
					draftStatus: "COMPLETED",
					onStartDraft: vi.fn(),
				})}
			/>,
		);
		expect(
			screen.getByRole("button", { name: /re-draft/i }),
		).toBeInTheDocument();
	});

	it("explains via the (i) that the ticket is always created through the prompt", () => {
		render(
			<BacklogChangeDetailDialog
				{...makeProps({
					change: createChange,
					reformatting: false,
					onStartDraft: vi.fn(),
				})}
			/>,
		);
		expect(
			screen.getByRole("button", { name: /what does draft with ai do/i }),
		).toBeInTheDocument();
	});

	it("offers a re-draft after a cancelled draft and fires onStartDraft", () => {
		const onStartDraft = vi.fn();
		render(
			<BacklogChangeDetailDialog
				{...makeProps({
					change: createChange,
					reformatting: false,
					draftStatus: "CANCELLED",
					onStartDraft,
				})}
			/>,
		);
		screen.getByRole("button", { name: /^Draft with AI$/ }).click();
		expect(onStartDraft).toHaveBeenCalledOnce();
	});

	it("shows no draft control for an UPDATE change (drafting is create-only)", () => {
		render(
			<BacklogChangeDetailDialog
				{...makeProps({
					change: updateChange,
					reformatting: false,
					onStartDraft: vi.fn(),
				})}
			/>,
		);
		expect(
			screen.queryByRole("button", { name: /^Draft with AI$/ }),
		).toBeNull();
	});

	// Feature Proposal markdown rendering (bug: raw ** / ## shown as text).
	// NOTE: the dialog content is portaled to document.body by Radix, so these
	// tests query `screen` / `document.body`, never the render `container`.
	const markdownCreateChange: ChangeItem = {
		type: "bug",
		action: "create",
		title: { to: "AI Assistant fails to apply changes to entire document" },
		description: {
			to: "**Steps to Reproduce**\n\nOpen a document and request an update.\n\n## Expected Behavior\n\nChanges apply everywhere.",
		},
		acceptanceCriteria: {
			to: "- Given the doc is open\n- When an update runs\n- Then all sections update",
		},
		reasoning: "Reported in the Teams thread.",
		sourceContext: "teams_messages",
	};

	it("renders markdown in the description as formatted output, not raw syntax (AC1)", () => {
		render(
			<BacklogChangeDetailDialog
				{...makeProps({ change: markdownCreateChange })}
			/>,
		);
		// **bold** -> <strong>, ## heading -> heading element.
		const strong = Array.from(
			document.body.querySelectorAll("strong"),
		).find((el) => el.textContent === "Steps to Reproduce");
		expect(strong).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "Expected Behavior" }),
		).toBeInTheDocument();
	});

	it("does not leak raw ** / ## markdown characters into the body (AC3)", () => {
		render(
			<BacklogChangeDetailDialog
				{...makeProps({ change: markdownCreateChange })}
			/>,
		);
		// No literal emphasis / heading markers should survive rendering.
		const body = document.body.textContent ?? "";
		expect(body).not.toContain("**");
		expect(body).not.toContain("## Expected");
	});

	it("renders acceptance-criteria markdown list items (AC1)", () => {
		render(
			<BacklogChangeDetailDialog
				{...makeProps({ change: markdownCreateChange })}
			/>,
		);
		expect(screen.getByText("Given the doc is open")).toBeInTheDocument();
		expect(
			screen.getByText("Then all sections update"),
		).toBeInTheDocument();
	});

	it("renders the reasoning as markdown, consistent with description/AC (AC4)", () => {
		render(
			<BacklogChangeDetailDialog
				{...makeProps({
					change: {
						...markdownCreateChange,
						reasoning: "**Escalated** by the reporter",
					},
				})}
			/>,
		);
		const strong = Array.from(
			document.body.querySelectorAll("strong"),
		).find((el) => el.textContent === "Escalated");
		expect(strong).toBeInTheDocument();
	});

	it("keeps long-form diff signal on chrome — description body is not struck through (AC4)", () => {
		// Reject the description so the OLD code path would have applied
		// line-through to the whole body. The new markdown body must NOT be
		// struck — rejection is signalled by the section opacity + chrome.
		// (Compact scalar MetadataFields like priority keep their own
		// from→to strike; this test scopes to the long-form description.)
		render(
			<BacklogChangeDetailDialog
				{...makeProps({
					skippedFields: new Set(["description"] as const),
				})}
			/>,
		);
		const heading = document.getElementById("detail-description");
		const section = heading?.closest("section");
		expect(section).not.toBeNull();
		expect(section?.querySelector(".line-through")).toBeNull();
	});
});

describe("BacklogChangeDetailDialog — merge target link", () => {
	const LINK_NAME =
		"Open merge target S-101 for New title with significantly more detail in a new tab";

	it("links the target of a resolved update in a new tab", async () => {
		const user = userEvent.setup();
		trackEvent.mockClear();
		render(
			<BacklogChangeDetailDialog
				{...makeProps({
					projectId: "project_1",
					panel: "feature-proposals",
				})}
			/>,
		);
		const link = screen.getByRole("link", { name: LINK_NAME });
		expect(link).toHaveAttribute(
			"href",
			"/app/example-org/projects/project_1/stories/story-1",
		);
		expect(link).toHaveAttribute("target", "_blank");
		expect(link).toHaveAttribute("rel", "noopener noreferrer");

		link.addEventListener("click", (event) => event.preventDefault());
		await user.click(link);
		expect(trackEvent).toHaveBeenCalledWith(
			"backlog.proposal.openExistingTicket",
			{ panel: "feature-proposals" },
		);
	});

	it("offers no link for an update whose target was not found", () => {
		render(
			<BacklogChangeDetailDialog
				{...makeProps({
					projectId: "project_1",
					change: {
						...updateChange,
						targetResolution: {
							status: "unresolved",
							demotedFromUpdate: true,
						},
					},
				})}
			/>,
		);
		expect(screen.queryByRole("link", { name: LINK_NAME })).toBeNull();
	});

	it("offers no link for a target the board no longer lists", () => {
		const linkableTarget = vi.fn(() => false);
		render(
			<BacklogChangeDetailDialog
				{...makeProps({ projectId: "project_1", linkableTarget })}
			/>,
		);
		expect(screen.queryByRole("link", { name: LINK_NAME })).toBeNull();
		expect(linkableTarget).toHaveBeenCalledWith("story-1");
	});
});

describe("BacklogChangeDetailDialog — committing one item (inbox)", () => {
	function decision(
		overrides: Partial<{ approveBlockedReason: string | null }> = {},
	) {
		return {
			onApprove: vi.fn(),
			onMoveToRejected: vi.fn(),
			approveBlockedReason: null,
			busy: false,
			...overrides,
		};
	}

	it("commits Approve and Move to Rejected instead of toggling the selection", async () => {
		const user = userEvent.setup();
		const itemDecision = decision();
		const props = makeProps({ change: createChange, itemDecision });
		render(<BacklogChangeDetailDialog {...props} />);

		expect(
			screen.queryByRole("button", { name: /Approve this item/ }),
		).toBeNull();
		await user.click(
			screen.getByRole("button", {
				name: "Approve New feature: workspace search",
			}),
		);
		await user.click(
			screen.getByRole("button", {
				name: "Move New feature: workspace search to Rejected",
			}),
		);
		expect(itemDecision.onApprove).toHaveBeenCalledOnce();
		expect(itemDecision.onMoveToRejected).toHaveBeenCalledOnce();
		expect(props.onApprove).not.toHaveBeenCalled();
		expect(props.onReject).not.toHaveBeenCalled();
	});

	it("blocks Approve with the reason while the item's routing is unfinished", () => {
		const reason = "Choose a ticket to enrich before approving this item.";
		render(
			<BacklogChangeDetailDialog
				{...makeProps({
					change: createChange,
					itemDecision: decision({ approveBlockedReason: reason }),
				})}
			/>,
		);
		const approve = screen.getByRole("button", {
			name: "Approve New feature: workspace search",
		});
		expect(approve).toBeDisabled();
		expect(approve).toHaveAccessibleDescription(reason);
		expect(
			screen.getByRole("button", {
				name: "Move New feature: workspace search to Rejected",
			}),
		).toBeEnabled();
	});

	it("shows a resolved item's outcome with no decision to make", () => {
		render(
			<BacklogChangeDetailDialog
				{...makeProps({
					change: createChange,
					projectId: "project_1",
					resolution: {
						label: "Applied",
						rejected: false,
						storyId: "story-9",
					},
				})}
			/>,
		);
		expect(screen.getByText("Applied")).toBeInTheDocument();
		expect(
			screen.getByRole("link", {
				name: "Open the ticket for New feature: workspace search in a new tab",
			}),
		).toHaveAttribute(
			"href",
			"/app/example-org/projects/project_1/stories/story-9",
		);
		expect(
			screen.queryByRole("button", { name: /Approve|Exclude/ }),
		).toBeNull();
	});
});

describe("BacklogChangeDetailDialog — update summary and line review", () => {
	const TITLE = "New title with significantly more detail";

	function lineDecision(
		overrides: Partial<{ approveBlockedReason: string | null }> = {},
	) {
		return {
			onApprove: vi.fn(),
			onMoveToRejected: vi.fn(),
			approveBlockedReason: null,
			busy: false,
			onReviewOnTicket: vi.fn(),
			...overrides,
		};
	}

	it("summarizes an update's changes at the top, with its reasoning", () => {
		render(<BacklogChangeDetailDialog {...makeProps()} />);
		const summary = screen.getByTestId("proposal-update-summary");

		expect(
			within(summary).getByText(/Renamed “Old title” → “New title/),
		).toBeInTheDocument();
		expect(within(summary).getByText(/P3 → P1/)).toBeInTheDocument();
		expect(
			within(summary).getByText(/PM raised the priority/),
		).toBeInTheDocument();
	});

	it("shows no change summary on a create", () => {
		render(
			<BacklogChangeDetailDialog
				{...makeProps({ change: createChange })}
			/>,
		);
		expect(screen.queryByTestId("proposal-update-summary")).toBeNull();
	});

	it("takes the update to its ticket for a line-by-line review", async () => {
		const user = userEvent.setup();
		const itemDecision = lineDecision();
		render(<BacklogChangeDetailDialog {...makeProps({ itemDecision })} />);

		const review = screen.getByRole("button", {
			name: "Review line by line",
		});
		expect(review).toHaveAccessibleDescription(
			/Opens the ticket with each change marked/,
		);
		await user.click(review);

		expect(itemDecision.onReviewOnTicket).toHaveBeenCalledOnce();
		expect(itemDecision.onApprove).not.toHaveBeenCalled();
	});

	it("holds line review back with Approve while the item is blocked", () => {
		render(
			<BacklogChangeDetailDialog
				{...makeProps({
					itemDecision: lineDecision({
						approveBlockedReason:
							"Choose a ticket to enrich before approving this item.",
					}),
				})}
			/>,
		);

		expect(
			screen.getByRole("button", { name: "Review line by line" }),
		).toBeDisabled();
	});

	it("applies every change at once with Apply all changes", async () => {
		const user = userEvent.setup();
		const itemDecision = lineDecision();
		render(<BacklogChangeDetailDialog {...makeProps({ itemDecision })} />);

		await user.click(
			screen.getByRole("button", {
				name: `Apply all changes to ${TITLE}`,
			}),
		);

		expect(itemDecision.onApprove).toHaveBeenCalledOnce();
		expect(itemDecision.onReviewOnTicket).not.toHaveBeenCalled();
	});

	it("reads Apply accepted changes once a proposed field is rejected", () => {
		render(
			<BacklogChangeDetailDialog
				{...makeProps({
					itemDecision: lineDecision(),
					skippedFields: new Set(["priority"] as const),
				})}
			/>,
		);

		expect(
			screen.getByRole("button", {
				name: `Apply accepted changes to ${TITLE}`,
			}),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Apply all changes/ }),
		).toBeNull();
	});

	it("reads Approve on a create routed to enrich an existing ticket", () => {
		render(
			<BacklogChangeDetailDialog
				{...makeProps({
					change: {
						...updateChange,
						routing: {
							decision: "enrich",
							confidence: 0.9,
							matchedStoryId: "story-1",
							matchedIdentifier: "S-101",
							matchedTitle: "Old title",
							reasoning: "Same work as an existing ticket.",
							proposedTitle: TITLE,
							proposedDescription: "Captured text.",
							alternatives: [],
						},
					},
					itemDecision: lineDecision(),
				})}
			/>,
		);

		expect(
			screen.getByRole("button", { name: `Approve ${TITLE}` }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /Apply all changes/ }),
		).toBeNull();
	});

	it("offers no line review on a create", () => {
		render(
			<BacklogChangeDetailDialog
				{...makeProps({
					change: createChange,
					itemDecision: lineDecision(),
				})}
			/>,
		);

		expect(
			screen.queryByRole("button", { name: "Review line by line" }),
		).toBeNull();
	});
});
