import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The LinkedIn Post generation panel (Fizzy #1851).
 *
 * Assertions are on ROLES and TEXT, never on classes: what this panel owes a
 * reader is that the three drafts are distinguishable, that the saved one is
 * marked, that the fold is stated in WORDS and not only in a tint, and that the
 * controls a viewer must not have are absent — none of which a class name can
 * prove.
 *
 * The fold cases are the ones that matter most here and are not a copy of the
 * short post's. On X the fold is a footnote; on LinkedIn it is the platform's
 * defining behaviour, so this panel states it in both directions — where a long
 * draft folds, AND that a short one does not. The second is the case a reader
 * cannot infer from silence, and it has no counterpart in the short post's
 * suite.
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
				key === "generateLinkedInPost"
					? mutate.generate
					: mutate.select,
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
					generateLinkedInPost: m("generateLinkedInPost"),
					selectLinkedInPostOption: m("selectLinkedInPostOption"),
				},
			},
		},
	};
});

import { LinkedInPostPanel } from "@saas/projects/components/publishing-suite/LinkedInPostPanel";

/**
 * Three candidates, every one of them SHORT ON PURPOSE.
 *
 * A post past `FEED_FOLD_ESTIMATE` renders as two spans so the folded tail can
 * be dimmed, and the default `getByText` matcher reads only an element's direct
 * text nodes — so `getByText(o.text)` finds nothing for a post over the fold.
 * Lengthen one of these past 200 characters and that assertion fails for a
 * reason that has nothing to do with what it is testing. The folded case has its
 * own block at the end of the file, which matches on `textContent`.
 */
const OPTIONS = [
	{
		label: "Result first",
		text: "CI dropped from 14 minutes to 4.",
		estimatedCharacters: 32,
	},
	{
		label: "Problem-led",
		text: "Our builds were the bottleneck.",
		estimatedCharacters: 31,
	},
	{
		label: "Lesson-led",
		text: "What a slow pipeline really costs.",
		estimatedCharacters: 34,
	},
];

function readyDraft(content: unknown = { options: OPTIONS }) {
	const row = {
		id: "d1",
		postType: "LINKEDIN_POST" as const,
		version: 1,
		status: "READY",
		error: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		content,
	};
	return {
		postType: "LINKEDIN_POST" as const,
		latestAttempt: row,
		latestReady: row,
	};
}

function renderPanel(over: Record<string, unknown> = {}) {
	return render(
		<LinkedInPostPanel
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

describe("LinkedInPostPanel — the generate control", () => {
	it("offers Generate when nothing has been drafted", () => {
		renderPanel();

		expect(
			screen.getByRole("button", { name: /generate linkedin post/i }),
		).toBeEnabled();
	});

	it("says Regenerate once drafts exist", () => {
		// A button still reading "Generate" with three drafts on screen invites
		// a reader to think the first click did not land.
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
			"Lead with the cut",
		);
		await user.click(
			screen.getByRole("button", { name: /generate linkedin post/i }),
		);

		expect(mutate.generate).toHaveBeenCalledWith(
			expect.objectContaining({ guidance: "Lead with the cut" }),
		);
	});

	it("sends null rather than an empty string when guidance is untouched", () => {
		// An empty string renders as a guidance section containing nothing,
		// which reads to the model as an instruction it failed to understand
		// rather than as no instruction at all.
		renderPanel();

		screen.getByRole("button", { name: /generate linkedin post/i }).click();

		expect(mutate.generate).toHaveBeenCalledWith(
			expect.objectContaining({ guidance: null }),
		);
	});

	it("does not send refineFromWorkingDraft on an ordinary generation", () => {
		// The flag is what makes the server read saved text into the prompt. A
		// plain generate that set it would silently turn every regeneration into
		// a revision of the draft the reader was trying to replace.
		renderPanel({ draft: readyDraft() });

		screen.getByRole("button", { name: /regenerate drafts/i }).click();

		expect(mutate.generate).toHaveBeenCalledWith(
			expect.not.objectContaining({ refineFromWorkingDraft: true }),
		);
	});
});

describe("LinkedInPostPanel — refining the saved draft", () => {
	const working = {
		postType: "LINKEDIN_POST" as const,
		hasBody: true,
		body: "CI dropped from 14 minutes to 4.",
		sourceDraftId: "d1",
		sourceOptionLabel: "Result first",
		updatedAt: new Date(),
	};

	it("offers no refine control until something is saved", () => {
		renderPanel({ draft: readyDraft() });

		expect(
			screen.queryByRole("button", { name: /refine draft/i }),
		).not.toBeInTheDocument();
	});

	it("keeps refine disabled until an instruction is typed", () => {
		// A refinement with no instruction is a rewrite of the draft for no
		// stated reason, which is the one thing this action cannot usefully do.
		renderPanel({ draft: readyDraft(), working });

		expect(
			screen.getByRole("button", { name: /refine draft/i }),
		).toBeDisabled();
	});

	it("sends the instruction as guidance with the refine flag set", async () => {
		const user = userEvent.setup();
		renderPanel({ draft: readyDraft(), working });

		await user.type(
			screen.getByLabelText(/refine the saved draft/i),
			"Stronger opening line",
		);
		await user.click(screen.getByRole("button", { name: /refine draft/i }));

		expect(mutate.generate).toHaveBeenCalledWith(
			expect.objectContaining({
				guidance: "Stronger opening line",
				refineFromWorkingDraft: true,
			}),
		);
	});

	it("keeps the refine instruction out of the plain generate call", async () => {
		// Two fields rather than one: a shared box would carry "make it
		// shorter" into a generation that has nothing to shorten.
		const user = userEvent.setup();
		renderPanel({ draft: readyDraft(), working });

		await user.type(
			screen.getByLabelText(/refine the saved draft/i),
			"Warmer tone",
		);
		await user.click(
			screen.getByRole("button", { name: /regenerate drafts/i }),
		);

		expect(mutate.generate).toHaveBeenCalledWith(
			expect.objectContaining({ guidance: null }),
		);
	});
});

describe("LinkedInPostPanel — the candidate drafts", () => {
	it("renders all three with their labels and text", () => {
		renderPanel({ draft: readyDraft() });

		for (const o of OPTIONS) {
			expect(screen.getByText(o.label)).toBeInTheDocument();
			expect(screen.getByText(o.text)).toBeInTheDocument();
		}
	});

	it("adopts a draft by LABEL, never by body", async () => {
		// The server reads the text out of the stored draft. Sending a body
		// would make this endpoint a way to write arbitrary text into the
		// project's publishing pipeline under the guise of choosing an option.
		const user = userEvent.setup();
		renderPanel({ draft: readyDraft() });

		const cards = screen.getAllByRole("listitem");
		await user.click(
			within(cards[1]).getByRole("button", { name: /use this draft/i }),
		);

		expect(mutate.select).toHaveBeenCalledWith(
			expect.objectContaining({
				draftId: "d1",
				optionLabel: "Problem-led",
			}),
		);
		expect(mutate.select).toHaveBeenCalledWith(
			expect.not.objectContaining({ body: expect.anything() }),
		);
	});

	it("marks the saved draft and disables only its own button", () => {
		renderPanel({
			draft: readyDraft(),
			working: {
				postType: "LINKEDIN_POST" as const,
				hasBody: true,
				body: OPTIONS[0].text,
				sourceDraftId: "d1",
				sourceOptionLabel: "Result first",
				updatedAt: new Date(),
			},
		});

		const cards = screen.getAllByRole("listitem");
		expect(
			within(cards[0]).getByRole("button", {
				name: /saved as working draft/i,
			}),
		).toBeDisabled();
		expect(
			within(cards[1]).getByRole("button", { name: /use this draft/i }),
		).toBeEnabled();
	});

	it("treats a same-labelled draft from a NEWER candidate as unsaved", () => {
		// The prompt is asked for descriptive labels, so "Result first"
		// recurring in the next regeneration with entirely different text is the
		// common case. Matching on the label alone would mark that new draft as
		// already saved and disable it, so it could never be adopted.
		renderPanel({
			draft: readyDraft(),
			working: {
				postType: "LINKEDIN_POST" as const,
				hasBody: true,
				body: "Something older.",
				sourceDraftId: "an-older-draft",
				sourceOptionLabel: "Result first",
				updatedAt: new Date(),
			},
		});

		const cards = screen.getAllByRole("listitem");
		expect(
			within(cards[0]).getByRole("button", { name: /use this draft/i }),
		).toBeEnabled();
	});

	it("degrades to an empty state on a document it cannot read", () => {
		// `content` is a JSON column. A panel that threw on an older shape would
		// take the whole Topic Item Page down with it.
		renderPanel({ draft: readyDraft({ nonsense: true }) });

		expect(
			screen.getByText(/no linkedin post drafts yet/i),
		).toBeInTheDocument();
	});
});

describe("LinkedInPostPanel — what a reader without edit rights sees", () => {
	it("shows the drafts and none of the controls", () => {
		renderPanel({ draft: readyDraft(), canEdit: false });

		expect(screen.getByText(OPTIONS[0].text)).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /generate linkedin post/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /use this draft/i }),
		).not.toBeInTheDocument();
	});
});

describe("LinkedInPostPanel — the fold", () => {
	/** Comfortably past the fold, with a tail on the far side of it. */
	const LONG = `${"We cut the build from fourteen minutes to four. ".repeat(6)}And here is the part behind the fold.`;

	const longDraft = () =>
		readyDraft({
			options: [
				{ label: "Long", text: LONG, estimatedCharacters: LONG.length },
			],
		});

	it("says where the feed folds a long post, in words rather than in colour", () => {
		// WCAG: the dimming is reinforcement. A reader who cannot see the tint
		// still has to learn that the tail is hidden.
		renderPanel({ draft: longDraft() });

		expect(
			screen.getByText(/the dimmed text sits behind/i),
		).toBeInTheDocument();
	});

	it("keeps every character of a folded post on screen", () => {
		// The fold is a presentation split across two spans. Consuming the
		// boundary space to make it look tidier would silently drop a character
		// out of text the reader is about to publish.
		renderPanel({ draft: longDraft() });

		const card = screen.getAllByRole("listitem")[0];
		expect(card.textContent).toContain(LONG);
	});

	it("says explicitly that a short post is NOT folded", () => {
		// The affirmative half, and the reason this differs from the short
		// post's panel: on LinkedIn "nothing is hidden" is the best outcome the
		// preview can report, and reporting it by saying nothing is
		// indistinguishable from the check not having run.
		renderPanel({ draft: readyDraft() });

		expect(
			screen.getAllByText(/short enough to show in full/i).length,
		).toBe(OPTIONS.length);
		expect(
			screen.queryByText(/the dimmed text sits behind/i),
		).not.toBeInTheDocument();
	});

	it("decides the fold from the text, not from the model's own estimate", () => {
		// `estimatedCharacters` is the model's own count. Keying the fold on it
		// would hide the indicator on a post that visibly runs past the fold —
		// the one case the indicator exists for.
		renderPanel({
			draft: readyDraft({
				options: [
					{ label: "Long", text: LONG, estimatedCharacters: 12 },
				],
			}),
		});

		expect(
			screen.getByText(/the dimmed text sits behind/i),
		).toBeInTheDocument();
	});

	it("still lets a reader adopt a folded draft", () => {
		// The fold is a preview of a feed, not a limit this panel imposes.
		renderPanel({ draft: longDraft() });

		expect(
			screen.getByRole("button", { name: /use this draft/i }),
		).toBeEnabled();
	});
});
