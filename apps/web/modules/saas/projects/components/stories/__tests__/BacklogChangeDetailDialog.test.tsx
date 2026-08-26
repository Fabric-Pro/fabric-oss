import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BacklogChangeDetailDialog } from "../BacklogChangeDetailDialog";
import type { ChangeItem } from "../BacklogChangeProposal";

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
		// rendered (not truncated mid-paragraph).
		expect(
			screen.getByText(/Updated description with multiple paragraphs\./),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				/the PM can decide based on the full proposed text rather than a snippet\./,
			),
		).toBeInTheDocument();
	});

	it("renders the FULL acceptance criteria (no slice(0, 80) truncation)", () => {
		// Regression for the DiffField's `from.length > 80 ? slice(0,80)+"…"` behavior.
		render(<BacklogChangeDetailDialog {...makeProps()} />);
		expect(screen.getByText(/2FA enforced/)).toBeInTheDocument();
		expect(
			screen.getByText(/Session refreshes silently before expiry/),
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
