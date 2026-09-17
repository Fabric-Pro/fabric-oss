import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Short Post / Tweet generation panel (Fizzy #1853, Phase 2B-2).
 *
 * Assertions are on ROLES and TEXT, never on classes: what this panel owes a
 * reader is that the three options are distinguishable, that the saved one is
 * marked, and that the controls a viewer must not have are absent — none of
 * which a class name can prove.
 */

const mutate = vi.hoisted(() => ({
	generate: vi.fn(),
	select: vi.fn(),
	saveBody: vi.fn(),
	refine: vi.fn(),
	confirm: vi.fn(() => true),
	acceptRefinement: vi.fn(),
	rejectRefinement: vi.fn(),
	invalidate: vi.fn(),
	toastInfo: vi.fn(),
	toastError: vi.fn(),
	toastSuccess: vi.fn(),
}));

/** Captures each mutation's options so `onSuccess` can be driven directly. */
const captured = vi.hoisted(
	() => ({}) as Record<string, Record<string, Function>>,
);

/**
 * Which mutations report themselves as in flight, keyed by procedure.
 *
 * The refine pending line is driven by the START mutation as well as by the
 * stored proposal — `refineDraft` writes no draft row, so between the press and
 * the read reporting the claim there is nothing else to show. A flag per key is
 * what lets a test stand in that gap.
 */
const pending = vi.hoisted(() => ({}) as Record<string, boolean>);

vi.mock("sonner", () => ({
	toast: {
		info: mutate.toastInfo,
		error: mutate.toastError,
		success: mutate.toastSuccess,
	},
}));

vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: mutate.invalidate }),
	useMutation: (
		opts: { mutationKey: string[] } & Record<string, Function>,
	) => {
		const key = opts.mutationKey[0];
		captured[key] = opts;
		// A spy per procedure, because these are different decisions: a hand
		// EDIT of the adopted body is neither a generation nor an option pick,
		// and a refinement is none of the three. Sharing one would let a
		// regression that wrote on the reader's behalf pass every assertion.
		const byKey: Record<string, ReturnType<typeof vi.fn>> = {
			generateShortPost: mutate.generate,
			saveShortPostBody: mutate.saveBody,
			refineDraft: mutate.refine,
			acceptRefinement: mutate.acceptRefinement,
			rejectRefinement: mutate.rejectRefinement,
		};
		return {
			mutate: byKey[key] ?? mutate.select,
			isPending: pending[key] ?? false,
		};
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => {
	const m = (procedure: string) => ({
		mutationOptions: (opts: Record<string, unknown>) => ({
			mutationKey: [procedure],
			...opts,
		}),
	});
	return {
		orpc: {
			projects: {
				publishingSuite: {
					claimDraftLock: {
						mutationOptions: (o: Record<string, unknown>) => ({
							mutationKey: ["claimDraftLock"],
							...o,
						}),
					},
					releaseDraftLock: {
						mutationOptions: (o: Record<string, unknown>) => ({
							mutationKey: ["releaseDraftLock"],
							...o,
						}),
					},
					listTopicDrafts: {
						queryKey: ({ input }: { input?: unknown }) => [
							"listTopicDrafts",
							input,
						],
					},
					generateShortPost: m("generateShortPost"),
					selectShortPostOption: m("selectShortPostOption"),
					saveShortPostBody: m("saveShortPostBody"),
					refineDraft: m("refineDraft"),
					acceptRefinement: m("acceptRefinement"),
					rejectRefinement: m("rejectRefinement"),
				},
			},
		},
	};
});

/**
 * The DIFF surface is stubbed; the state machine around it is not.
 *
 * `RefinedDraftReview` builds a TipTap diff, and its own contract is pinned in
 * `publishing-refined-draft-review.test.tsx`. What this suite owes is
 * everything between the proposal on the working draft and that component:
 * which of the five states renders the review at all, and what accept and
 * discard send. `DraftRefinement` — the hook and the state branching — runs for
 * real here, because that branching is the wiring under test.
 */
const { refinedReview } = vi.hoisted(() => ({
	refinedReview: { props: null as Record<string, unknown> | null },
}));
vi.mock(
	"@saas/projects/components/publishing-suite/RefinedDraftReview",
	() => ({
		RefinedDraftReview: (props: {
			onConfirm: (merged: string | null) => void;
			onReject: () => void;
		}) => {
			refinedReview.props = props as unknown as Record<string, unknown>;
			return (
				<div data-testid="refined-draft-review">
					<button
						type="button"
						onClick={() => props.onConfirm("Merged review text.")}
					>
						stub accept
					</button>
					<button type="button" onClick={() => props.onConfirm(null)}>
						stub accept unreadable
					</button>
					<button type="button" onClick={() => props.onReject()}>
						stub reject
					</button>
				</div>
			);
		},
	}),
);

import { ShortPostPanel } from "@saas/projects/components/publishing-suite/ShortPostPanel";

/**
 * Three candidates, every one of them SHORT ON PURPOSE.
 *
 * Since A6 a post past `FEED_FOLD_ESTIMATE` renders as two spans so the folded
 * tail can be dimmed, and the default `getByText` matcher reads only an
 * element's direct text nodes — so `getByText(o.text)` below finds nothing for
 * a post over the fold. Lengthen one of these past 200 characters and that
 * assertion fails for a reason that has nothing to do with what it is testing.
 * The folded case has its own coverage in the A6 block at the end of the file,
 * which matches on `textContent`.
 */
const OPTIONS = [
	{
		label: "Direct",
		text: "Builds are faster now.",
		estimatedCharacters: 22,
	},
	{
		label: "Question-led",
		text: "Tired of slow builds?",
		estimatedCharacters: 21,
	},
	{
		label: "Story-led",
		text: "We shaved minutes off CI.",
		estimatedCharacters: 25,
	},
];

function readyDraft(content: unknown = { options: OPTIONS }) {
	return {
		postType: "TWEET" as const,
		latestAttempt: {
			id: "d1",
			postType: "TWEET" as const,
			version: 1,
			status: "READY",
			error: null,
			createdAt: new Date(),
			updatedAt: new Date(),
			content,
		},
		latestReady: {
			id: "d1",
			postType: "TWEET" as const,
			version: 1,
			status: "READY",
			error: null,
			createdAt: new Date(),
			updatedAt: new Date(),
			content,
		},
	};
}

function renderPanel(over: Record<string, unknown> = {}) {
	return render(
		<ShortPostPanel
			projectId="p1"
			organizationId="org1"
			topicId="t1"
			draft={null}
			working={null}
			canEdit={true}
			{...(over as never)}
		/>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	for (const k of Object.keys(captured)) {
		delete captured[k];
	}
	for (const k of Object.keys(pending)) {
		delete pending[k];
	}
	refinedReview.props = null;
	// Accepting a refinement over unsaved typing asks first, so the answer has
	// to be stubbed — jsdom's own `confirm` throws "not implemented".
	vi.stubGlobal("confirm", mutate.confirm);
	mutate.confirm.mockReturnValue(true);
});

describe("ShortPostPanel — the generate control", () => {
	it("offers Generate when nothing has been drafted", () => {
		renderPanel();

		expect(
			screen.getByRole("button", { name: /generate short post/i }),
		).toBeEnabled();
	});

	it("says Regenerate once options exist", () => {
		// FR32. A button still reading "Generate" after three options are on
		// screen invites a reader to think the first click did not land.
		renderPanel({ draft: readyDraft() });

		expect(
			screen.getByRole("button", { name: /regenerate drafts/i }),
		).toBeEnabled();
	});

	it("passes the typed guidance to the mutation", async () => {
		const user = userEvent.setup();
		renderPanel();

		await user.type(
			screen.getByLabelText(/guidance/i),
			"Under 200 characters",
		);
		await user.click(
			screen.getByRole("button", { name: /generate short post/i }),
		);

		expect(mutate.generate).toHaveBeenCalledWith(
			expect.objectContaining({ guidance: "Under 200 characters" }),
		);
	});

	it("sends null rather than an empty string when guidance is untouched", async () => {
		const user = userEvent.setup();
		renderPanel();

		await user.click(
			screen.getByRole("button", { name: /generate short post/i }),
		);

		expect(mutate.generate).toHaveBeenCalledWith(
			expect.objectContaining({ guidance: null }),
		);
	});

	it("keeps the guidance field on the page before the first run", () => {
		// With no candidates on screen there is nothing for the button to sit
		// on, and someone who has never run this tab should be shown what
		// steers it rather than have to find it behind a popover.
		renderPanel();

		expect(screen.getByLabelText(/guidance/i)).toBeInTheDocument();
	});

	it("collapses guidance behind the button once drafts exist", async () => {
		// The field is not merely moved, it is PUT AWAY. Above the drafts it
		// was an input asking to be filled in before every regeneration; the
		// common case is regenerating with nothing more to say, and the field
		// charged that case a permanent box over the content it acts on.
		const user = userEvent.setup();
		renderPanel({ draft: readyDraft() });

		expect(screen.queryByLabelText(/guidance/i)).not.toBeInTheDocument();

		await user.click(
			screen.getByRole("button", { name: /regenerate drafts/i }),
		);

		expect(
			within(await screen.findByRole("dialog")).getByLabelText(
				/guidance/i,
			),
		).toBeInTheDocument();
	});

	it("DISABLES the button while a live run is in flight", () => {
		const draft = readyDraft();
		draft.latestAttempt = {
			...draft.latestAttempt,
			status: "GENERATING",
			isExpired: false,
		} as never;

		renderPanel({ draft });

		expect(
			screen.getByRole("button", { name: /regenerate/i }),
		).toBeDisabled();
	});

	it("KEEPS the button enabled for a STRANDED run", () => {
		// The only code that reclaims a stranded row runs inside the NEXT
		// attempt, so disabling on `status === GENERATING` alone would lock the
		// tab with no user action able to free it.
		const draft = readyDraft();
		draft.latestAttempt = {
			...draft.latestAttempt,
			status: "GENERATING",
			isExpired: true,
		} as never;

		renderPanel({ draft });

		expect(
			screen.getByRole("button", { name: /regenerate/i }),
		).toBeEnabled();
		expect(screen.getByRole("alert")).toHaveTextContent(/time limit/i);
	});

	it("reports a failed attempt with the reason the row carries", () => {
		const draft = readyDraft();
		draft.latestAttempt = {
			...draft.latestAttempt,
			status: "FAILED",
			error: "The model returned no output.",
		} as never;
		draft.latestReady = null as never;

		renderPanel({ draft });

		expect(screen.getByRole("alert")).toHaveTextContent(
			/model returned no output/i,
		);
	});
});

describe("ShortPostPanel — the three options", () => {
	it("renders each option with its prompt-governed label and estimate", () => {
		// FR17: labels come from the prompt, so the panel must render whatever it
		// is given rather than a fixed set of its own.
		renderPanel({ draft: readyDraft() });

		for (const o of OPTIONS) {
			expect(screen.getByText(o.label)).toBeInTheDocument();
			expect(screen.getByText(o.text)).toBeInTheDocument();
		}
		expect(screen.getByText(/~21 characters/)).toBeInTheDocument();
	});

	it("renders exactly the options it was given, not a padded three", () => {
		// The schema enforces three, so a two-option row can only come from an
		// older write. Padding it would present a shape that never existed.
		renderPanel({
			draft: readyDraft({ options: OPTIONS.slice(0, 2) }),
		});

		expect(
			screen.getAllByRole("button", { name: /use this draft/i }),
		).toHaveLength(2);
	});

	it("degrades to an empty state when the stored content has an old shape", () => {
		// `content` is `Json?`. A panel that throws here takes the whole Topic
		// Item Page with it.
		renderPanel({ draft: readyDraft({ sections: ["old shape"] }) });

		expect(
			screen.getByText(/no short post drafts yet/i),
		).toBeInTheDocument();
	});

	it("sends the LABEL, not the text, when an option is chosen", async () => {
		const user = userEvent.setup();
		renderPanel({ draft: readyDraft() });

		const chosen = screen
			.getAllByRole("listitem")
			.find((li) => within(li).queryByText("Question-led"));
		await user.click(
			within(chosen as HTMLElement).getByRole("button", {
				name: /use this draft/i,
			}),
		);

		// The server reads the text out of the stored draft. Sending it from here
		// would make "select an option" a way to write arbitrary text.
		expect(mutate.select).toHaveBeenCalledWith(
			expect.objectContaining({
				draftId: "d1",
				optionLabel: "Question-led",
			}),
		);
		expect(mutate.select.mock.calls[0][0]).not.toHaveProperty("body");
	});
});

describe("ShortPostPanel — the working draft", () => {
	const working = {
		postType: "TWEET" as const,
		hasBody: true,
		body: "Builds are faster now.",
		sourceDraftId: "d1",
		sourceOptionLabel: "Direct",
		updatedAt: new Date(),
	};

	it("gives the editor a viewport-relative height, not four rows", () => {
		// The one assertion in this file on a CLASS rather than a role or a
		// text, and deliberately: "big enough to work in" has no accessible
		// expression to assert against. `rows={4}` was the complaint, and the
		// fix is the clamp the Planning & Analysis editor sizes its region
		// with.
		renderPanel({ working });

		expect(
			screen.getByRole("textbox", { name: /working short post/i }),
		).toHaveClass("h-[clamp(24rem,60vh,44rem)]");
	});

	it("takes a candidate from an EARLIER version, not just the newest", async () => {
		// "Maybe I realised the previous proposals were better." A short-form
		// run produces three options, so restoring a version means picking one
		// of ITS options rather than swapping in a single body -- which is why
		// the generic Restore is deliberately absent here. The version list was
		// readable and not actionable; now the draft id is a parameter, so an
		// option from any run can be adopted.
		const user = userEvent.setup();
		renderPanel({
			draft: {
				...readyDraft({ options: OPTIONS }),
				versions: [
					{
						id: "d2",
						version: 2,
						createdAt: new Date(),
						content: { options: OPTIONS },
					},
					{
						id: "d1",
						version: 1,
						createdAt: new Date(),
						content: {
							options: [
								{
									label: "Earlier pick",
									text: "The one that was better.",
								},
							],
						},
					},
				],
			},
			working,
		});

		// A saved draft exists, so replacing it confirms first — the same
		// guard the candidate grid uses, reached from the version dialog.
		const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

		await user.click(screen.getByRole("button", { name: /2 versions/i }));
		await user.click(screen.getAllByRole("button", { name: "View" })[1]);
		await user.click(
			screen.getByRole("button", { name: /use this draft/i }),
		);
		confirmSpy.mockRestore();

		expect(mutate.select).toHaveBeenCalledWith(
			expect.objectContaining({
				draftId: "d1",
				optionLabel: "Earlier pick",
			}),
		);
	});

	it("lets the adopted draft be edited and saved", async () => {
		// The five long-form panels have had a textarea over the adopted body
		// since 2B-3. TWEET and LINKEDIN_POST were deferred there -- "nothing
		// edits a body until 2B-3" -- and never picked up, so the two drafts
		// most likely to need a word changed before posting were the two you
		// could not change. Same column, same compare-and-set.
		const user = userEvent.setup();
		renderPanel({ draft: readyDraft(), working });

		const editor = screen.getByRole("textbox", {
			name: /working short post/i,
		});
		await user.clear(editor);
		await user.type(editor, "Builds are much faster now.");
		await user.click(screen.getByRole("button", { name: /save changes/i }));

		expect(mutate.saveBody).toHaveBeenCalledWith(
			expect.objectContaining({ body: "Builds are much faster now." }),
		);
	});

	it("lets the adopted draft be copied and downloaded", () => {
		// Copy and Download mount against the EDITOR text on the long-form
		// panels, and short-form has no editor -- so the one panel whose output
		// is meant to be pasted straight into a feed had no way to get it out.
		// The saved body is the same string.
		renderPanel({
			draft: readyDraft(),
			working,
		});

		expect(
			screen.getByRole("button", { name: /copy/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /download/i }),
		).toBeInTheDocument();
	});

	it("shows the saved body and which option it came from", () => {
		renderPanel({ draft: readyDraft(), working });

		expect(
			screen.getByRole("heading", { name: /working short post/i }),
		).toBeInTheDocument();
		expect(screen.getByText(/from .Direct./i)).toBeInTheDocument();
	});

	it("marks the saved option and disables re-saving it", () => {
		renderPanel({ draft: readyDraft(), working });

		const saved = screen
			.getAllByRole("listitem")
			.find((li) => within(li).queryByText("Direct"));
		expect(
			within(saved as HTMLElement).getByRole("button", {
				name: /saved as working draft/i,
			}),
		).toBeDisabled();
	});

	it("CONFIRMS before replacing a saved draft with a different option", async () => {
		const user = userEvent.setup();
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		renderPanel({ draft: readyDraft(), working });

		const other = screen
			.getAllByRole("listitem")
			.find((li) => within(li).queryByText("Story-led"));
		await user.click(
			within(other as HTMLElement).getByRole("button", {
				name: /use this draft/i,
			}),
		);

		// FR33 is satisfied structurally for REGENERATION — generation only ever
		// writes the candidate table. Choosing a different option is a real
		// overwrite, so it asks rather than silently replacing.
		expect(confirm).toHaveBeenCalled();
		expect(mutate.select).not.toHaveBeenCalled();
		confirm.mockRestore();
	});

	it("proceeds when the replacement is confirmed", async () => {
		const user = userEvent.setup();
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
		renderPanel({ draft: readyDraft(), working });

		const other = screen
			.getAllByRole("listitem")
			.find((li) => within(li).queryByText("Story-led"));
		await user.click(
			within(other as HTMLElement).getByRole("button", {
				name: /use this draft/i,
			}),
		);

		expect(mutate.select).toHaveBeenCalledWith(
			expect.objectContaining({ optionLabel: "Story-led" }),
		);
		confirm.mockRestore();
	});

	it("does not mark a REGENERATED option saved just because the label repeats", async () => {
		// The prompt is asked for descriptive labels ("Direct", "Story-led"), so
		// a regeneration reusing one is the common case rather than the exotic
		// one. Keying "is this the saved option" on the LABEL alone means v2's
		// "Direct" — different text entirely — reads as already saved and its
		// button is disabled, so the option cannot be adopted at all.
		const v2 = readyDraft();
		v2.latestReady = { ...v2.latestReady, id: "d2", version: 2 } as never;

		renderPanel({
			draft: v2,
			working: {
				postType: "TWEET" as const,
				hasBody: true,
				body: "The OLD Direct text.",
				// Saved from a DIFFERENT draft that happened to use this label.
				sourceDraftId: "d1",
				sourceOptionLabel: "Direct",
				updatedAt: new Date(),
			},
		});

		const direct = screen
			.getAllByRole("listitem")
			.find((li) => within(li).queryByText("Direct"));
		expect(
			within(direct as HTMLElement).getByRole("button", {
				name: /use this draft/i,
			}),
		).toBeEnabled();
	});

	it("marks the saved option only when the SOURCE DRAFT matches too", async () => {
		const current = readyDraft();
		renderPanel({
			draft: current,
			working: {
				postType: "TWEET" as const,
				hasBody: true,
				body: "Builds are faster now.",
				sourceDraftId: "d1",
				sourceOptionLabel: "Direct",
				updatedAt: new Date(),
			},
		});

		const direct = screen
			.getAllByRole("listitem")
			.find((li) => within(li).queryByText("Direct"));
		expect(
			within(direct as HTMLElement).getByRole("button", {
				name: /saved as working draft/i,
			}),
		).toBeDisabled();
	});

	it("treats a working draft whose CANDIDATE was deleted as not-this-option", async () => {
		// The composite FK is `ON DELETE SET NULL ("sourceDraftId")`, so deleting
		// a candidate keeps the body and forgets its origin. Both sides being
		// null must not read as a match — `null === null` is the shape that would
		// make it one, which is why the predicate checks `readyId` first.
		renderPanel({
			draft: readyDraft(),
			working: {
				postType: "TWEET" as const,
				hasBody: true,
				body: "A body whose candidate is gone.",
				sourceDraftId: null,
				sourceOptionLabel: "Direct",
				updatedAt: new Date(),
			},
		});

		const direct = screen
			.getAllByRole("listitem")
			.find((li) => within(li).queryByText("Direct"));
		expect(
			within(direct as HTMLElement).getByRole("button", {
				name: /use this draft/i,
			}),
		).toBeEnabled();
	});

	it("CONFIRMS when a same-labelled option comes from a different draft", async () => {
		const user = userEvent.setup();
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		const v2 = readyDraft();
		v2.latestReady = { ...v2.latestReady, id: "d2", version: 2 } as never;

		renderPanel({
			draft: v2,
			working: {
				postType: "TWEET" as const,
				hasBody: true,
				body: "The OLD Direct text.",
				sourceDraftId: "d1",
				sourceOptionLabel: "Direct",
				updatedAt: new Date(),
			},
		});

		const direct = screen
			.getAllByRole("listitem")
			.find((li) => within(li).queryByText("Direct"));
		await user.click(
			within(direct as HTMLElement).getByRole("button", {
				name: /use this draft/i,
			}),
		);

		// Saved work is being replaced, so it must ask — the label matching is
		// exactly what made it look like it was not.
		expect(confirm).toHaveBeenCalled();
		confirm.mockRestore();
	});

	it("does NOT confirm when there is no saved draft yet", async () => {
		const user = userEvent.setup();
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
		renderPanel({ draft: readyDraft() });

		await user.click(
			screen.getAllByRole("button", { name: /use this draft/i })[0],
		);

		// Nothing is being replaced, so a prompt here would be a dialog that
		// teaches its reader to dismiss dialogs.
		expect(confirm).not.toHaveBeenCalled();
		expect(mutate.select).toHaveBeenCalled();
		confirm.mockRestore();
	});
});

describe("ShortPostPanel — a reader", () => {
	it("sees the options and NONE of the write controls", () => {
		// PR2. The controls are absent from the tree rather than disabled: an
		// unreachable write control is still write UI a reader can inspect.
		renderPanel({ draft: readyDraft(), canEdit: false });

		expect(screen.getByText("Direct")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /generate/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /use this draft/i }),
		).not.toBeInTheDocument();
		expect(screen.queryByLabelText(/guidance/i)).not.toBeInTheDocument();
	});
});

describe("ShortPostPanel — extra sections", () => {
	it("says how a draft was generalized when the run reported it", () => {
		// FR29. A generalized draft that does not say it was generalized reads as
		// a complete one.
		renderPanel({
			draft: readyDraft({
				options: OPTIONS,
				safetyNote: "The customer is unnamed pending approval.",
			}),
		});

		expect(
			screen.getByText(/customer is unnamed pending approval/i),
		).toBeInTheDocument();
	});

	it("lists hashtags only when present", () => {
		const { unmount } = renderPanel({ draft: readyDraft() });
		expect(
			screen.queryByText(/suggested hashtags/i),
		).not.toBeInTheDocument();
		unmount();

		renderPanel({
			draft: readyDraft({ options: OPTIONS, hashtags: ["#ci"] }),
		});
		expect(screen.getByText("#ci")).toBeInTheDocument();
	});

	it("no longer shows an inputs-needed list beside the draft", () => {
		// The model still emits the field and it still reaches the working
		// draft body, where it is editable and gets deleted before publishing.
		// What is gone is the panel block: nothing in the product could clear an
		// item, and it was largely the model echoing back the unresolved
		// approvals the locked clauses had just told it about.
		renderPanel({
			draft: readyDraft({
				options: OPTIONS,
				inputsNeeded: ["The release date"],
			}),
		});
		expect(screen.queryByText(/inputs needed/i)).not.toBeInTheDocument();
		expect(screen.queryByText("The release date")).not.toBeInTheDocument();
	});
});

describe("ShortPostPanel — mutation outcomes", () => {
	it("reports a not-started run as information, not an error", () => {
		renderPanel();

		captured.generateShortPost.onSuccess({
			started: false,
			reason: "unavailable",
		});

		// Temporal being down is not the reader's fault, and an error toast would
		// send them looking for one.
		expect(mutate.toastInfo).toHaveBeenCalledWith(
			expect.stringMatching(/unavailable/i),
		);
		expect(mutate.toastError).not.toHaveBeenCalled();
	});

	it("distinguishes an already-running generation from an outage", () => {
		renderPanel();

		captured.generateShortPost.onSuccess({
			started: false,
			reason: "in-progress",
		});

		expect(mutate.toastInfo).toHaveBeenCalledWith(
			expect.stringMatching(/already being generated/i),
		);
	});

	it("says nothing on a started run, and refreshes the draft state", () => {
		renderPanel();

		captured.generateShortPost.onSuccess({ started: true, draftId: "d2" });

		expect(mutate.toastInfo).not.toHaveBeenCalled();
		expect(mutate.invalidate).toHaveBeenCalled();
	});
});

const REFINE_WORKING = {
	postType: "TWEET" as const,
	hasBody: true,
	body: "Builds are faster now.",
	sourceDraftId: "d1",
	sourceOptionLabel: "Direct",
	updatedAt: new Date("2026-09-01T12:00:00Z"),
};

describe("ShortPostPanel — refining the saved draft (Fizzy #1851, A7)", () => {
	/**
	 * Opens the refine popover and hands back a scope inside it.
	 *
	 * The instruction now lives behind "Refine with AI" in the draft's own
	 * action row, so every assertion about the FIELD has to open it first.
	 * Assertions about the control EXISTING query the trigger instead — behind
	 * a popover the field is absent either way, so querying for it would pass
	 * with the button sitting there offering a refinement of nothing.
	 */
	async function openRefine(user: ReturnType<typeof userEvent.setup>) {
		await user.click(
			screen.getByRole("button", { name: /refine with ai/i }),
		);
		return within(await screen.findByRole("dialog"));
	}

	it("does NOT offer refine before anything is saved", () => {
		// With no working draft the action has no input, and offering it would
		// be a regeneration wearing a label that promises otherwise.
		renderPanel({ draft: readyDraft() });

		expect(
			screen.queryByRole("button", { name: /refine with ai/i }),
		).not.toBeInTheDocument();
	});

	it("does NOT offer refine for a working draft with no text", () => {
		renderPanel({
			working: { ...REFINE_WORKING, hasBody: false, body: "" },
		});

		expect(
			screen.queryByRole("button", { name: /refine with ai/i }),
		).not.toBeInTheDocument();
	});

	it("offers refine ALONGSIDE regenerate once a draft is saved", () => {
		// A second action, not a replacement: the two answer different
		// questions and both stay reachable. They no longer sit in one column
		// of fields — refine is on the draft it revises, regenerate is on the
		// candidates it replaces — but reachable is reachable.
		renderPanel({ draft: readyDraft(), working: REFINE_WORKING });

		expect(
			screen.getByRole("button", { name: /refine with ai/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /regenerate drafts/i }),
		).toBeEnabled();
	});

	it("keeps refine disabled until an instruction is written", async () => {
		const user = userEvent.setup();
		renderPanel({ working: REFINE_WORKING });

		const popover = await openRefine(user);
		const button = popover.getByRole("button", { name: /refine draft/i });
		expect(button).toBeDisabled();

		await user.type(
			popover.getByRole("textbox", { name: /refine the saved draft/i }),
			"Make it shorter.",
		);
		expect(button).toBeEnabled();
	});

	it("starts a REFINEMENT, never a generation", async () => {
		// The panel names the intent; the server reads the text it revises.
		// The payload is what it always was — this move changed where the
		// field lives, not a byte of what it sends.
		const user = userEvent.setup();
		renderPanel({ working: REFINE_WORKING });

		const popover = await openRefine(user);
		await user.type(
			popover.getByRole("textbox", { name: /refine the saved draft/i }),
			"Warmer tone.",
		);
		await user.click(
			popover.getByRole("button", { name: /refine draft/i }),
		);

		expect(mutate.refine).toHaveBeenCalledWith({
			projectId: "p1",
			topicId: "t1",
			organizationId: "org1",
			postType: "TWEET",
			instruction: "Warmer tone.",
		});
		expect(mutate.generate).not.toHaveBeenCalled();
	});

	it("keeps the refine instruction OUT of a regeneration", async () => {
		// Two fields because they ask for different things. A shared one would
		// carry "make it shorter" into a run that has nothing to shorten.
		const user = userEvent.setup();
		renderPanel({ draft: readyDraft(), working: REFINE_WORKING });

		const refine = await openRefine(user);
		await user.type(
			refine.getByRole("textbox", { name: /refine the saved draft/i }),
			"Warmer tone.",
		);
		await user.keyboard("{Escape}");

		await user.click(
			screen.getByRole("button", { name: /regenerate drafts/i }),
		);
		await user.click(
			within(await screen.findByRole("dialog")).getByRole("button", {
				name: "Regenerate",
			}),
		);

		expect(mutate.generate).toHaveBeenCalledWith(
			expect.objectContaining({ guidance: null }),
		);
		expect(mutate.refine).not.toHaveBeenCalled();
	});

	it("says what a refinement actually produces", async () => {
		// The promise moved INTO the popover with the field it qualifies.
		// Under an always-visible field it was a standing paragraph about an
		// action nobody had taken yet.
		const user = userEvent.setup();
		renderPanel({ working: REFINE_WORKING });

		const popover = await openRefine(user);

		expect(
			popover.getByText(
				/nothing you have saved changes until you accept it/i,
			),
		).toBeInTheDocument();
	});

	it("gives a viewer no refine control", () => {
		renderPanel({ working: REFINE_WORKING, canEdit: false });

		expect(
			screen.queryByRole("button", { name: /refine with ai/i }),
		).not.toBeInTheDocument();
	});
});

describe("ShortPostPanel — the candidate previews (Fizzy #1851, A6)", () => {
	/**
	 * Comfortably past the fold, with a tail on the far side of it.
	 *
	 * Built by repetition rather than written out, so the assertion below is
	 * comparing against the same string the panel was handed — a hand-typed
	 * 250-character fixture invites a transcription slip that would look like
	 * the split dropping a character.
	 */
	const LONG_TEXT = `${"A steady stream of small build wins. ".repeat(6)}And the closing line nobody sees.`;

	function longOption(estimatedCharacters = LONG_TEXT.length) {
		return {
			options: [{ label: "Long", text: LONG_TEXT, estimatedCharacters }],
		};
	}

	it("says where a feed folds a long post, in words rather than in colour", () => {
		// The dimmed tail is the visual half. A reader who cannot see the tint
		// still has to learn that the opening line is what carries the post.
		renderPanel({ draft: readyDraft(longOption()) });

		expect(
			screen.getByText(
				/most feeds fold a post after roughly 200 characters/i,
			),
		).toBeInTheDocument();
	});

	it("keeps every character of a folded post on screen", () => {
		// The fold is a presentation split across two spans. Consuming the
		// boundary to make it look tidier would drop a character out of text
		// the reader is about to publish.
		//
		// Matched on `textContent` rather than by string: the default matcher
		// reads only an element's DIRECT text nodes, so a preview split in two
		// is invisible to it — which is exactly the state this asserts about.
		renderPanel({ draft: readyDraft(longOption()) });

		expect(
			screen.getByText(
				(_content, element) => element?.textContent === LONG_TEXT,
			),
		).toBeInTheDocument();
	});

	it("marks no fold on a post that fits inside one", () => {
		renderPanel({ draft: readyDraft() });

		expect(
			screen.queryByText(/most feeds fold a post/i),
		).not.toBeInTheDocument();
	});

	it("decides the fold from the text, not from the model's own estimate", () => {
		// `estimatedCharacters` is what the model claimed, with a length
		// fallback for older rows. Trusting it would hide the indicator on
		// exactly the post that needs it.
		renderPanel({ draft: readyDraft(longOption(42)) });

		expect(screen.getByText(/~42 characters/)).toBeInTheDocument();
		expect(
			screen.getByText(
				/most feeds fold a post after roughly 200 characters/i,
			),
		).toBeInTheDocument();
	});

	it("still lets a reader adopt a folded candidate", () => {
		// The fold is a preview of a feed, not a limit this panel imposes.
		renderPanel({ draft: readyDraft(longOption()) });

		expect(
			screen.getByRole("button", { name: /use this draft/i }),
		).toBeEnabled();
	});
});

/**
 * Defect §2 — the generalization note read off the wrong version.
 *
 * Fixed on Blog, Case Study and Stakeholder Email; the two short-form panels
 * were missed and kept reading `latestReady`. Same failure as the blog panel
 * documents: after a regeneration nobody adopted, the newest candidate and the
 * saved body are different documents, and when v2 needs no generalizing the
 * whole section DISAPPEARS while the saved text is still v1's generalized one.
 * Nothing is on screen to qualify, so no wording change could reach it — and
 * copy/download then export text whose stated generalizations describe a
 * document nobody adopted.
 */
describe("ShortPostPanel — the note belongs to the version on screen", () => {
	const GENERALIZED = {
		options: OPTIONS,
		safetyNote: "Generalized the customer reference.",
	};
	const CLEAN = { options: OPTIONS, safetyNote: null };

	/** `readyDraft` pins id `d1`; these cases need the newest to be `d2`. */
	function v2(content: unknown) {
		const draft = readyDraft(content);
		return {
			...draft,
			latestAttempt: { ...draft.latestAttempt, id: "d2", version: 2 },
			latestReady: { ...draft.latestReady, id: "d2", version: 2 },
		};
	}

	const savedFromV1 = (sourceContent: unknown) => ({
		postType: "TWEET" as const,
		hasBody: true,
		body: "Builds are faster now.",
		sourceDraftId: "d1",
		sourceOptionLabel: "Direct",
		sourceContent,
		updatedAt: new Date(),
	});

	it("keeps the note when a later version needs no generalizing", () => {
		// The vanishing case, and the reason a qualifier could never fix it.
		renderPanel({ draft: v2(CLEAN), working: savedFromV1(GENERALIZED) });

		expect(
			screen.getByText("Generalized the customer reference."),
		).toBeInTheDocument();
	});

	it("shows the adopted version's note, not the newest one", () => {
		renderPanel({
			draft: v2({ options: OPTIONS, safetyNote: "v2's own note." }),
			working: savedFromV1(GENERALIZED),
		});

		expect(
			screen.getByText("Generalized the customer reference."),
		).toBeInTheDocument();
		expect(screen.queryByText("v2's own note.")).not.toBeInTheDocument();
	});

	it("drops the qualifier once the note really is this version's", () => {
		renderPanel({
			draft: v2({ options: OPTIONS, safetyNote: "v2's own note." }),
			working: savedFromV1(GENERALIZED),
		});

		expect(
			screen.queryByText(/describe(s)? another version/i),
		).not.toBeInTheDocument();
	});

	it("still qualifies when the adopted version is gone", () => {
		// A superseded row can fall out of retention. The newest note is then
		// all there is, and saying so is the honest answer.
		renderPanel({
			draft: v2({ options: OPTIONS, safetyNote: "v2's own note." }),
			working: savedFromV1(null),
		});

		expect(screen.getByText("v2's own note.")).toBeInTheDocument();
	});
});

const ASSISTANT_BOUNDARY_WORKING = {
	postType: "TWEET" as const,
	hasBody: true,
	body: "Builds are faster now.",
	sourceDraftId: "d1",
	sourceOptionLabel: "Direct",
	updatedAt: new Date("2026-09-01T12:00:00Z"),
};

/**
 * Which AI does what.
 *
 * The AI Assistant rail stays docked on this tab and greets a reader with an
 * offer to rewrite "the planning analysis" — which is what it does, and which
 * on a draft tab reads as an offer to rewrite the draft. It has no such reach:
 * its readable context carries the topic and the analysis and no draft, and the
 * one thing it writes is the analysis editor. The panel says so rather than the
 * page hiding a tool that still answers questions about the topic.
 */
describe("ShortPostPanel — the assistant boundary", () => {
	it("says which AI edits this draft and which one does not", () => {
		renderPanel({
			draft: readyDraft(),
			working: ASSISTANT_BOUNDARY_WORKING as never,
		});

		expect(
			screen.getByText(
				/refine with ai is what edits this short post .* the ai assistant works on the planning analysis, not on drafts/i,
			),
		).toBeInTheDocument();
	});

	it("keeps it out of a viewer's panel", () => {
		// It names two editing affordances, and a reader has neither.
		renderPanel({
			draft: readyDraft(),
			working: ASSISTANT_BOUNDARY_WORKING as never,
			canEdit: false,
		});

		expect(
			screen.queryByText(/refine with ai is what edits/i),
		).not.toBeInTheDocument();
	});
});

/**
 * A refinement is a PROPOSAL about the working copy, and the panel reads it off
 * the working draft rather than off a candidate row.
 *
 * The discriminator is the STORED proposal, never this tab's memory of having
 * pressed the button: a refinement takes minutes, and a reload in between must
 * bring the review back rather than lose it.
 */
describe("ShortPostPanel — reviewing a refinement proposal", () => {
	const PROPOSED = "Builds start warm now.";
	const SAVED = new Date("2026-09-01T12:00:00Z");

	const saved = {
		postType: "TWEET" as const,
		hasBody: true,
		body: "Builds are faster now.",
		sourceDraftId: "d1",
		sourceOptionLabel: null,
		sourceContent: null,
		updatedAt: SAVED,
	};

	/** READY by default — the one state with something to review. */
	function proposal(over: Record<string, unknown> = {}) {
		return {
			status: "READY" as const,
			proposedBody: PROPOSED,
			instruction: "Make it shorter.",
			note: null,
			error: null,
			requestedById: "u1",
			isStale: false,
			isExpired: false,
			updatedAt: new Date("2026-09-01T12:05:00Z"),
			...over,
		};
	}

	function withProposal(over: Record<string, unknown> = {}) {
		return { ...saved, refinement: proposal(over) };
	}

	it("opens the review against the draft the proposal revises", () => {
		renderPanel({ working: withProposal() });

		expect(screen.getByTestId("refined-draft-review")).toBeInTheDocument();
		expect(refinedReview.props).toMatchObject({
			baseline: saved.body,
			proposed: PROPOSED,
			instruction: "Make it shorter.",
		});
	});

	it("carries the revision's own safety note into the review", () => {
		// The author gave an explicit instruction. Where an unresolved approval
		// forced the model to write around it, this note is the only place the
		// revision says so — without it a declined instruction is
		// indistinguishable from an ignored one.
		renderPanel({
			working: withProposal({
				note: "Left the customer unnamed — that approval is still open.",
			}),
		});

		expect(refinedReview.props).toMatchObject({
			note: "Left the customer unnamed — that approval is still open.",
		});
	});

	it("shows no review when there is no proposal", () => {
		renderPanel({ working: saved });

		expect(
			screen.queryByTestId("refined-draft-review"),
		).not.toBeInTheDocument();
	});

	it("accepts the proposal server-side, with the BODY's concurrency token", async () => {
		renderPanel({ working: withProposal() });

		await userEvent.click(
			screen.getByRole("button", { name: /^stub accept$/i }),
		);

		expect(mutate.acceptRefinement).toHaveBeenCalledWith({
			projectId: "p1",
			topicId: "t1",
			organizationId: "org1",
			postType: "TWEET",
			// The working draft's `updatedAt`, never the proposal's own — the
			// server compare-and-sets against the row it is replacing.
			expectedUpdatedAt: SAVED,
			// The REVIEWED text, which after per-change accepts and rejects is
			// usually neither the saved draft nor the whole proposal. The
			// server writes this in place of the proposal it stored.
			body: "Merged review text.",
		});
		expect(mutate.saveBody).not.toHaveBeenCalled();
		expect(mutate.select).not.toHaveBeenCalled();
	});

	it("refuses to send a review the editor could not serialize", async () => {
		// Fizzy #1987: `null` is a failed READ, not an empty document. Sent as a
		// body it would be written, and the draft it was meant to save is gone.
		renderPanel({ working: withProposal() });

		await userEvent.click(
			screen.getByRole("button", { name: /stub accept unreadable/i }),
		);

		expect(mutate.acceptRefinement).not.toHaveBeenCalled();
	});

	it("discards the proposal on the server, writing nothing else", async () => {
		renderPanel({ working: withProposal() });

		await userEvent.click(
			screen.getByRole("button", { name: /stub reject/i }),
		);

		expect(mutate.rejectRefinement).toHaveBeenCalledWith({
			projectId: "p1",
			topicId: "t1",
			organizationId: "org1",
			postType: "TWEET",
		});
		expect(mutate.acceptRefinement).not.toHaveBeenCalled();
		expect(mutate.saveBody).not.toHaveBeenCalled();
		expect(mutate.select).not.toHaveBeenCalled();
	});

	it("gives a viewer no review at all", () => {
		// Every decision it offers is a write.
		renderPanel({ working: withProposal(), canEdit: false });

		expect(
			screen.queryByTestId("refined-draft-review"),
		).not.toBeInTheDocument();
	});

	it("reports a failure in the run's own words, and offers a way out", async () => {
		renderPanel({
			working: withProposal({
				status: "FAILED",
				proposedBody: null,
				error: "The model returned nothing usable.",
			}),
		});

		expect(
			screen.getByText(/the model returned nothing usable/i),
		).toBeInTheDocument();
		expect(
			screen.queryByTestId("refined-draft-review"),
		).not.toBeInTheDocument();

		await userEvent.click(
			screen.getByRole("button", { name: /discard refinement/i }),
		);
		expect(mutate.rejectRefinement).toHaveBeenCalled();
	});

	it("reports a STRANDED run rather than showing a spinner forever", async () => {
		// `isExpired` is fail-open on purpose: a proposal whose deadline is
		// unrecorded reads as stranded rather than as perpetually in flight,
		// because the alternative is a state no user action can clear.
		renderPanel({
			working: withProposal({
				status: "GENERATING",
				proposedBody: null,
				isExpired: true,
			}),
		});

		expect(
			screen.getByText(/didn't report back within its time limit/i),
		).toBeInTheDocument();
		expect(screen.queryByRole("status")).not.toBeInTheDocument();

		await userEvent.click(
			screen.getByRole("button", { name: /discard refinement/i }),
		);
		expect(mutate.rejectRefinement).toHaveBeenCalled();
	});

	it("leaves Refine startable after a stranded run", () => {
		// The only code that reclaims an abandoned proposal runs inside the
		// NEXT refine, so a disabled button here locks the panel for good.
		renderPanel({
			working: withProposal({
				status: "GENERATING",
				proposedBody: null,
				isExpired: true,
			}),
		});

		expect(
			screen.getByRole("button", { name: /refine with ai/i }),
		).toBeEnabled();
	});

	it("refuses to offer Accept for a proposal whose baseline moved", async () => {
		// `acceptRefinement` answers `baseline_changed` here, so offering the
		// button would be offering an action guaranteed to fail.
		renderPanel({ working: withProposal({ isStale: true }) });

		expect(
			screen.queryByTestId("refined-draft-review"),
		).not.toBeInTheDocument();
		expect(
			screen.getByText(/changed after this refinement was computed/i),
		).toBeInTheDocument();

		await userEvent.click(
			screen.getByRole("button", { name: /discard refinement/i }),
		);
		expect(mutate.rejectRefinement).toHaveBeenCalled();
	});

	it("asks before an accept discards unsaved typing", async () => {
		// Accepting REPLACES the saved body, and unsaved editor text is the one
		// thing here no refresh brings back.
		mutate.confirm.mockReturnValue(false);
		const user = userEvent.setup();
		renderPanel({ working: withProposal() });

		await user.type(
			screen.getByRole("textbox", { name: /working short post/i }),
			" Still typing.",
		);
		await user.click(
			screen.getByRole("button", { name: /^stub accept$/i }),
		);

		expect(mutate.confirm).toHaveBeenCalled();
		expect(mutate.acceptRefinement).not.toHaveBeenCalled();
	});

	it("does not ask at all when there is nothing unsaved to lose", async () => {
		renderPanel({ working: withProposal() });

		await userEvent.click(
			screen.getByRole("button", { name: /^stub accept$/i }),
		);

		expect(mutate.confirm).not.toHaveBeenCalled();
		expect(mutate.acceptRefinement).toHaveBeenCalled();
	});
});

/**
 * Where the pending state lives.
 *
 * Reported from staging: pressing Refine "reads as nothing happening". A
 * refinement writes no draft row, so it has to be reported from the proposal
 * itself and from the start mutation — the two together are what make the row
 * the reader clicked in say something.
 */
describe("ShortPostPanel — the refine pending state", () => {
	const saved = {
		postType: "TWEET" as const,
		hasBody: true,
		body: "Builds are faster now.",
		sourceDraftId: "d1",
		sourceOptionLabel: null,
		sourceContent: null,
		updatedAt: new Date("2026-09-01T12:00:00Z"),
	};

	const running = {
		...saved,
		refinement: {
			status: "GENERATING" as const,
			proposedBody: null,
			instruction: "Make it shorter.",
			note: null,
			error: null,
			requestedById: "u1",
			isStale: false,
			isExpired: false,
			updatedAt: new Date("2026-09-01T12:05:00Z"),
		},
	};

	it("says nothing when no refinement is running", () => {
		renderPanel({ working: saved });

		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("reports a run in flight beside the control that started it", () => {
		// Read off the STORED proposal, so a reload while it runs still shows
		// it. The old flag lived in this tab's memory and a refresh lost it.
		renderPanel({ working: running });

		expect(screen.getByRole("status")).toHaveTextContent(
			/revising your saved short post/i,
		);
	});

	it("reports the press itself, before the read has caught up", () => {
		// Between the claim landing and the next read there is nothing on the
		// topic to show — which is exactly the window the complaint was about.
		pending.refineDraft = true;
		renderPanel({ working: saved });

		expect(screen.getByRole("status")).toHaveTextContent(
			/revising your saved short post/i,
		);
	});
});
