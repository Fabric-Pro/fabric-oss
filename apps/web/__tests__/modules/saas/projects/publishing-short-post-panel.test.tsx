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
	invalidate: vi.fn(),
	toastInfo: vi.fn(),
	toastError: vi.fn(),
	toastSuccess: vi.fn(),
}));

/** Captures each mutation's options so `onSuccess` can be driven directly. */
const captured = vi.hoisted(
	() => ({}) as Record<string, Record<string, Function>>,
);

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
		return {
			mutate:
				key === "generateShortPost" ? mutate.generate : mutate.select,
			isPending: false,
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
					listTopicDrafts: {
						queryKey: ({ input }: { input?: unknown }) => [
							"listTopicDrafts",
							input,
						],
					},
					generateShortPost: m("generateShortPost"),
					selectShortPostOption: m("selectShortPostOption"),
				},
			},
		},
	};
});

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

	it("lists inputs needed and hashtags only when present", () => {
		const { unmount } = renderPanel({ draft: readyDraft() });
		expect(screen.queryByText(/inputs needed/i)).not.toBeInTheDocument();
		expect(
			screen.queryByText(/suggested hashtags/i),
		).not.toBeInTheDocument();
		unmount();

		renderPanel({
			draft: readyDraft({
				options: OPTIONS,
				inputsNeeded: ["The release date"],
				hashtags: ["#ci"],
			}),
		});
		expect(screen.getByText("The release date")).toBeInTheDocument();
		expect(screen.getByText("#ci")).toBeInTheDocument();
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
	it("does NOT offer refine before anything is saved", () => {
		// With no working draft the action has no input, and offering it would
		// be a regeneration wearing a label that promises otherwise.
		renderPanel({ draft: readyDraft() });

		expect(
			screen.queryByRole("button", { name: /refine draft/i }),
		).not.toBeInTheDocument();
	});

	it("does NOT offer refine for a working draft with no text", () => {
		renderPanel({
			working: { ...REFINE_WORKING, hasBody: false, body: "" },
		});

		expect(
			screen.queryByRole("button", { name: /refine draft/i }),
		).not.toBeInTheDocument();
	});

	it("offers refine ALONGSIDE regenerate once a draft is saved", () => {
		// A second action, not a replacement: the two answer different
		// questions and both stay reachable.
		renderPanel({ draft: readyDraft(), working: REFINE_WORKING });

		expect(
			screen.getByRole("button", { name: /refine draft/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /regenerate drafts/i }),
		).toBeEnabled();
	});

	it("keeps refine disabled until an instruction is written", async () => {
		const user = userEvent.setup();
		renderPanel({ working: REFINE_WORKING });

		const button = screen.getByRole("button", { name: /refine draft/i });
		expect(button).toBeDisabled();

		await user.type(
			screen.getByRole("textbox", { name: /refine the saved draft/i }),
			"Make it shorter.",
		);
		expect(button).toBeEnabled();
	});

	it("sends the instruction with the refine flag, and no body", async () => {
		// The panel names the intent; the server reads the text it revises.
		const user = userEvent.setup();
		renderPanel({ working: REFINE_WORKING });

		await user.type(
			screen.getByRole("textbox", { name: /refine the saved draft/i }),
			"Warmer tone.",
		);
		await user.click(screen.getByRole("button", { name: /refine draft/i }));

		expect(mutate.generate).toHaveBeenCalledWith({
			projectId: "p1",
			topicId: "t1",
			organizationId: "org1",
			guidance: "Warmer tone.",
			refineFromWorkingDraft: true,
		});
	});

	it("keeps the refine instruction OUT of a regeneration", async () => {
		// Two fields because they ask for different things. A shared one would
		// carry "make it shorter" into a run that has nothing to shorten.
		const user = userEvent.setup();
		renderPanel({ draft: readyDraft(), working: REFINE_WORKING });

		await user.type(
			screen.getByRole("textbox", { name: /refine the saved draft/i }),
			"Warmer tone.",
		);
		await user.click(
			screen.getByRole("button", { name: /regenerate drafts/i }),
		);

		expect(mutate.generate).toHaveBeenCalledWith(
			expect.objectContaining({ guidance: null }),
		);
		expect(mutate.generate).not.toHaveBeenCalledWith(
			expect.objectContaining({ refineFromWorkingDraft: true }),
		);
	});

	it("says the saved draft is safe until the result is adopted", () => {
		renderPanel({ working: REFINE_WORKING });

		expect(
			screen.getByText(/nothing you have saved changes until you adopt/i),
		).toBeInTheDocument();
	});

	it("gives a viewer no refine control", () => {
		renderPanel({ working: REFINE_WORKING, canEdit: false });

		expect(
			screen.queryByRole("button", { name: /refine draft/i }),
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
