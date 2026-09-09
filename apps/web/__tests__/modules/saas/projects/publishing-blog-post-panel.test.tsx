import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Blog Post generation panel (Fizzy #1853, Phase 2B-3).
 *
 * Assertions are on ROLES and TEXT, never on classes: what this panel owes a
 * reader is that the saved draft is editable, that an unadopted version is
 * offered rather than applied, and that the controls a viewer must not have are
 * absent — none of which a class name can prove.
 */

const mutate = vi.hoisted(() => ({
	generate: vi.fn(),
	adopt: vi.fn(),
	saveBody: vi.fn(),
	invalidate: vi.fn(),
	toastInfo: vi.fn(),
	toastError: vi.fn(),
	toastSuccess: vi.fn(),
	confirm: vi.fn(() => true),
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
		const byKey: Record<string, ReturnType<typeof vi.fn>> = {
			generateBlogPost: mutate.generate,
			adoptBlogPostDraft: mutate.adopt,
			saveBlogPostBody: mutate.saveBody,
		};
		return { mutate: byKey[key], isPending: false };
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
					generateBlogPost: m("generateBlogPost"),
					adoptBlogPostDraft: m("adoptBlogPostDraft"),
					saveBlogPostBody: m("saveBlogPostBody"),
				},
			},
		},
	};
});

import { BlogPostPanel } from "@saas/projects/components/publishing-suite/BlogPostPanel";

const DOCUMENT = {
	title: "Faster incremental builds",
	subtitle: "How a warm cache changed the inner loop",
	body: "## Why this matters\n\nBuilds used to start cold.",
	categories: ["Toolchain"],
	keywords: ["ci-pipeline"],
	inputsNeeded: ["Adoption numbers for the rollout"],
	safetyNote: "Generalized the customer reference.",
};

const SAVED_AT = new Date("2026-09-01T12:00:00Z");

function readyDraft(content: unknown = DOCUMENT, id = "d1") {
	const row = {
		id,
		postType: "BLOG_POST" as const,
		version: 1,
		status: "READY",
		error: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		content,
	};
	return {
		postType: "BLOG_POST" as const,
		latestAttempt: row,
		latestReady: row,
	};
}

function working(over: Record<string, unknown> = {}) {
	return {
		postType: "BLOG_POST" as const,
		hasBody: true,
		body: "# Faster incremental builds\n\nBuilds used to start cold.",
		sourceDraftId: "d1",
		sourceOptionLabel: null,
		updatedAt: SAVED_AT,
		...over,
	};
}

function renderPanel(over: Record<string, unknown> = {}) {
	return render(
		<BlogPostPanel
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
	vi.stubGlobal("confirm", mutate.confirm);
	mutate.confirm.mockReturnValue(true);
});

describe("BlogPostPanel — the generate control", () => {
	it("offers Generate when nothing has been drafted", () => {
		renderPanel();

		expect(
			screen.getByRole("button", { name: /generate blog post/i }),
		).toBeEnabled();
	});

	it("switches to Regenerate once a draft exists", () => {
		renderPanel({ draft: readyDraft() });

		expect(
			screen.getByRole("button", { name: /regenerate draft/i }),
		).toBeEnabled();
	});

	it("stays enabled for a STRANDED run, which nothing else can free", () => {
		// The only code that reclaims a stranded row runs inside the NEXT
		// attempt, so disabling here would lock the tab permanently.
		const draft = readyDraft();
		renderPanel({
			draft: {
				...draft,
				latestAttempt: {
					...draft.latestAttempt,
					status: "GENERATING",
					isExpired: true,
				},
				latestReady: null,
			},
		});

		expect(
			screen.getByRole("button", { name: /generate blog post/i }),
		).toBeEnabled();
	});

	it("says a regeneration leaves saved work alone", () => {
		// FR35 is structural, but the reader has to be told, or the button
		// reads like it might overwrite an hour of editing.
		renderPanel({ draft: readyDraft(), working: working() });

		expect(
			screen.getByText(/blog post you have saved is not affected/i),
		).toBeInTheDocument();
	});

	it("reports an unavailable generator as information, not an error", () => {
		renderPanel();

		captured.generateBlogPost.onSuccess?.({
			started: false,
			reason: "unavailable",
		});

		expect(mutate.toastInfo).toHaveBeenCalled();
		expect(mutate.toastError).not.toHaveBeenCalled();
	});
});

describe("BlogPostPanel — refining the saved draft (Fizzy #1851, A7)", () => {
	it("does NOT offer refine before anything is saved", () => {
		// With no working draft the action has no input, and offering it would
		// be a regeneration wearing a label that promises otherwise.
		renderPanel({ draft: readyDraft() });

		expect(
			screen.queryByRole("button", { name: /refine draft/i }),
		).not.toBeInTheDocument();
	});

	it("does NOT offer refine for a working draft with no text", () => {
		renderPanel({ working: working({ hasBody: false, body: "" }) });

		expect(
			screen.queryByRole("button", { name: /refine draft/i }),
		).not.toBeInTheDocument();
	});

	it("offers refine ALONGSIDE regenerate once a draft is saved", () => {
		// A second action, not a replacement: the two answer different
		// questions and both stay reachable.
		renderPanel({ draft: readyDraft(), working: working() });

		expect(
			screen.getByRole("button", { name: /refine draft/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /regenerate draft/i }),
		).toBeEnabled();
	});

	it("keeps refine disabled until an instruction is written", async () => {
		const user = userEvent.setup();
		renderPanel({ working: working() });

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
		renderPanel({ working: working() });

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
		renderPanel({ draft: readyDraft(), working: working() });

		await user.type(
			screen.getByRole("textbox", { name: /refine the saved draft/i }),
			"Warmer tone.",
		);
		await user.click(
			screen.getByRole("button", { name: /regenerate draft/i }),
		);

		expect(mutate.generate).toHaveBeenCalledWith(
			expect.objectContaining({ guidance: null }),
		);
		expect(mutate.generate).not.toHaveBeenCalledWith(
			expect.objectContaining({ refineFromWorkingDraft: true }),
		);
	});

	it("says the saved draft is safe until the result is adopted", () => {
		renderPanel({ working: working() });

		expect(
			screen.getByText(/nothing you have saved changes until you adopt/i),
		).toBeInTheDocument();
	});

	it("gives a viewer no refine control", () => {
		renderPanel({ working: working(), canEdit: false });

		expect(
			screen.queryByRole("button", { name: /refine draft/i }),
		).not.toBeInTheDocument();
	});
});

describe("BlogPostPanel — the editor (FR21)", () => {
	it("shows the saved draft in an editable field", () => {
		renderPanel({ working: working() });

		const box = screen.getByRole("textbox", {
			name: /working blog post/i,
		});
		expect(box).toHaveValue(
			"# Faster incremental builds\n\nBuilds used to start cold.",
		);
	});

	it("keeps Save disabled until something actually changes", () => {
		renderPanel({ working: working() });

		expect(
			screen.getByRole("button", { name: /save changes/i }),
		).toBeDisabled();
	});

	it("sends the edited text with the version it was edited from", async () => {
		const user = userEvent.setup();
		renderPanel({ working: working() });

		const box = screen.getByRole("textbox", {
			name: /working blog post/i,
		});
		await user.clear(box);
		await user.type(box, "Rewritten.");
		await user.click(screen.getByRole("button", { name: /save changes/i }));

		expect(mutate.saveBody).toHaveBeenCalledWith(
			expect.objectContaining({
				body: "Rewritten.",
				expectedUpdatedAt: SAVED_AT,
			}),
		);
	});

	it("KEEPS the reader's text when the save loses a race", async () => {
		// Discarding it would lose work that no refresh brings back. The
		// message tells them to copy it first.
		const user = userEvent.setup();
		renderPanel({ working: working() });

		const box = screen.getByRole("textbox", {
			name: /working blog post/i,
		});
		await user.clear(box);
		await user.type(box, "Rewritten.");

		captured.saveBlogPostBody.onError?.({ code: "CONFLICT" });

		expect(box).toHaveValue("Rewritten.");
		expect(mutate.invalidate).not.toHaveBeenCalled();
	});

	it("offers a way back after an edit the reader does not want", async () => {
		const user = userEvent.setup();
		renderPanel({ working: working() });

		const box = screen.getByRole("textbox", {
			name: /working blog post/i,
		});
		await user.type(box, " extra");
		await user.click(
			screen.getByRole("button", { name: /discard changes/i }),
		);

		expect(box).toHaveValue(
			"# Faster incremental builds\n\nBuilds used to start cold.",
		);
	});

	it("marks unsaved work so a reader does not navigate away over it", async () => {
		const user = userEvent.setup();
		renderPanel({ working: working() });

		await user.type(
			screen.getByRole("textbox", { name: /working blog post/i }),
			" extra",
		);

		expect(screen.getByText(/unsaved changes/i)).toBeInTheDocument();
	});
});

describe("BlogPostPanel — adopting a later version (FR34/FR35)", () => {
	it("offers the generated version when it is not the saved one", () => {
		renderPanel({
			draft: readyDraft(DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
		});

		expect(
			screen.getByRole("button", { name: /use this version/i }),
		).toBeEnabled();
	});

	it("does NOT offer it when the saved draft already came from it", () => {
		// Otherwise every reader is invited to re-adopt what they already have.
		renderPanel({
			draft: readyDraft(DOCUMENT, "d1"),
			working: working({ sourceDraftId: "d1" }),
		});

		expect(
			screen.queryByRole("button", { name: /use this version/i }),
		).not.toBeInTheDocument();
	});

	it("warns about unsaved edits, which adopting destroys", async () => {
		const user = userEvent.setup();
		renderPanel({
			draft: readyDraft(DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
		});

		await user.type(
			screen.getByRole("textbox", { name: /working blog post/i }),
			" extra",
		);
		await user.click(
			screen.getByRole("button", { name: /use this version/i }),
		);

		expect(mutate.confirm).toHaveBeenCalledWith(
			expect.stringMatching(/unsaved edits/i),
		);
	});

	it("does not adopt when the reader declines the confirmation", async () => {
		const user = userEvent.setup();
		mutate.confirm.mockReturnValue(false);
		renderPanel({
			draft: readyDraft(DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
		});

		await user.click(
			screen.getByRole("button", { name: /use this version/i }),
		);

		expect(mutate.adopt).not.toHaveBeenCalled();
	});

	it("sends the version the tab last saw, so a lost race is detected", async () => {
		const user = userEvent.setup();
		renderPanel({
			draft: readyDraft(DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
		});

		await user.click(
			screen.getByRole("button", { name: /use this version/i }),
		);

		expect(mutate.adopt).toHaveBeenCalledWith(
			expect.objectContaining({
				draftId: "d2",
				expectedUpdatedAt: SAVED_AT,
			}),
		);
	});

	it("sends an updatedAt for a row whose body is blank, not null", async () => {
		// The row exists and has an `updatedAt` the server compares against.
		// Sending null would report every such save as stale.
		const user = userEvent.setup();
		renderPanel({
			draft: readyDraft(DOCUMENT, "d2"),
			working: working({ hasBody: false, body: "", sourceDraftId: null }),
		});

		await user.click(
			screen.getByRole("button", { name: /save as working draft/i }),
		);

		expect(mutate.adopt).toHaveBeenCalledWith(
			expect.objectContaining({ expectedUpdatedAt: SAVED_AT }),
		);
	});
});

describe("BlogPostPanel — what a viewer sees", () => {
	it("gives a viewer the text but no editor and no controls", () => {
		// PR2.
		renderPanel({
			draft: readyDraft(DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
			canEdit: false,
		});

		// Twice over: once as the read-only saved draft, once in the generated
		// version below it. `getAllBy` rather than `getBy` because both are
		// correct — a viewer is entitled to read either.
		expect(
			screen.getAllByText(/Builds used to start cold/).length,
		).toBeGreaterThan(0);
		expect(
			screen.queryByRole("textbox", { name: /working blog post/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", {
				name: /generate|use this version/i,
			}),
		).not.toBeInTheDocument();
	});
});

describe("BlogPostPanel — the generated document", () => {
	it("shows the publishing suggestions beside the post, not inside it", () => {
		// The whole reason the prompt returns them as fields.
		renderPanel({
			draft: readyDraft(DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
		});

		expect(screen.getByText(/suggested categories/i)).toBeInTheDocument();
		expect(screen.getByText("Toolchain")).toBeInTheDocument();
		expect(screen.getByText(/suggested keywords/i)).toBeInTheDocument();

		const box = screen.getByRole("textbox", {
			name: /working blog post/i,
		});
		expect(box).not.toHaveValue(expect.stringContaining("Toolchain"));
	});

	it("surfaces what the draft still needs (FR29)", () => {
		renderPanel({ draft: readyDraft(DOCUMENT, "d2") });

		expect(
			screen.getByText("Adoption numbers for the rollout"),
		).toBeInTheDocument();
	});

	it("says when the draft was generalized rather than asserted", () => {
		renderPanel({ draft: readyDraft(DOCUMENT, "d2") });

		expect(
			screen.getByText("Generalized the customer reference."),
		).toBeInTheDocument();
	});

	it("degrades to an empty state on a document shape it cannot read", () => {
		// `content` is a JSON column. A panel that throws takes the whole Topic
		// Item Page down with it.
		renderPanel({ draft: readyDraft({ options: [{ label: "Direct" }] }) });

		expect(screen.getByText(/no blog post draft yet/i)).toBeInTheDocument();
	});

	it("shows the failure reason rather than an empty tab", () => {
		const draft = readyDraft();
		renderPanel({
			draft: {
				...draft,
				latestAttempt: {
					...draft.latestAttempt,
					status: "FAILED",
					error: "The provider timed out.",
				},
				latestReady: null,
			},
		});

		expect(screen.getByRole("alert")).toHaveTextContent(
			"The provider timed out.",
		);
	});
});

describe("BlogPostPanel — the saved draft beside the candidate (Fizzy #1851, A6)", () => {
	it("puts both texts on screen at once, each labelled for what it is", () => {
		// The panel already promised the comparison in prose — "regenerating
		// writes a new version to compare against" — while stacking the two
		// texts several sections apart, so comparing them meant scrolling.
		renderPanel({
			draft: readyDraft(DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
		});

		expect(
			screen.getByRole("textbox", { name: /working blog post/i }),
		).toHaveValue(
			"# Faster incremental builds\n\nBuilds used to start cold.",
		);
		// A regex, not `DOCUMENT.body`: the default matcher normalizes the
		// node's whitespace but not the string it is compared against, so a
		// body containing a blank line never matches itself.
		expect(screen.getByText(/## Why this matters/)).toBeInTheDocument();

		// And which is which, without the reader having to work it out.
		expect(
			screen.getByRole("heading", {
				name: /new candidate \(version 1\)/i,
			}),
		).toBeInTheDocument();
		expect(
			screen.getByText(/saved\. this is the blog post the topic holds/i),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				/not saved\. adopting it replaces your saved draft/i,
			),
		).toBeInTheDocument();
	});

	it("does not claim a replacement when there is no saved draft to replace", () => {
		renderPanel({ draft: readyDraft(DOCUMENT, "d2") });

		expect(
			screen.queryByText(
				/saved\. this is the blog post the topic holds/i,
			),
		).not.toBeInTheDocument();
		expect(
			screen.getByText(/adopting it makes this the topic's draft/i),
		).toBeInTheDocument();
	});

	it("keeps the adopt control reachable rather than below the candidate's text", () => {
		// The candidate's prose scrolls inside its own frame; the control that
		// adopts it must not scroll away with a long draft.
		renderPanel({
			draft: readyDraft(DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
		});

		const adopt = screen.getByRole("button", { name: /use this version/i });
		const candidateBody = screen.getByText(/## Why this matters/);

		expect(adopt).toBeEnabled();
		// The block that scrolls is the body's own container. The control must
		// sit outside it, or a four-thousand-word draft buries it.
		expect(candidateBody.parentElement?.contains(adopt)).toBe(false);
	});
});

describe("BlogPostPanel — how the draft was generalized (Fizzy #1851, A6)", () => {
	const THREE_APPROVALS =
		"Generalized the customer reference, which is not approved for naming. Described the rollout result qualitatively rather than quoting the figure. Left the screenshot out until the capture is cleared for use.";

	it("breaks the note into one entry per thing the draft wrote around", () => {
		renderPanel({
			draft: readyDraft({ ...DOCUMENT, safetyNote: THREE_APPROVALS }),
		});

		expect(
			screen.getByText(
				"Generalized the customer reference, which is not approved for naming.",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"Described the rollout result qualitatively rather than quoting the figure.",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"Left the screenshot out until the capture is cleared for use.",
			),
		).toBeInTheDocument();
		// Three entries, not one paragraph carrying all three.
		expect(screen.queryByText(THREE_APPROVALS)).not.toBeInTheDocument();
	});

	it("leaves a one-sentence note as a paragraph, not a single bullet", () => {
		// `DOCUMENT.safetyNote` is one sentence. A one-item list promises a
		// breakdown that did not happen.
		renderPanel({ draft: readyDraft() });

		expect(
			screen.getByText("Generalized the customer reference."),
		).toBeInTheDocument();
		// The only list left on the panel is `inputsNeeded`.
		expect(screen.getAllByRole("listitem")).toHaveLength(1);
	});

	it("does not split on a decimal or an abbreviation", () => {
		// Splitting "12.4%" or "e.g." apart would turn a formatting change
		// into an editing one, on the block a reader checks the draft's
		// honesty against.
		renderPanel({
			draft: readyDraft({
				...DOCUMENT,
				safetyNote:
					"Reported the 12.4% uplift as unconfirmed rather than as a measured result. Named no customer, e.g. Contoso, until the approval lands.",
			}),
		});

		expect(
			screen.getByText(
				"Reported the 12.4% uplift as unconfirmed rather than as a measured result.",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"Named no customer, e.g. Contoso, until the approval lands.",
			),
		).toBeInTheDocument();
	});
});

describe("BlogPostPanel — whose draft the generalization note describes (A6)", () => {
	/**
	 * The note is read off the LATEST READY generation; the editor beside it
	 * holds the WORKING draft. Once a regeneration nobody adopted exists, the
	 * two are different documents and the note is about the one the reader is
	 * NOT editing — which the side-by-side makes easy to misattribute, because
	 * the sentence now sits equally close to both columns.
	 *
	 * This panel had no qualifier of any kind before A6.
	 */
	const QUALIFIER = /these notes describe the most recent generated version/i;

	it("says so when a regeneration the reader has not adopted exists", () => {
		renderPanel({
			draft: readyDraft(DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
		});

		expect(screen.getByText(QUALIFIER)).toBeInTheDocument();
	});

	it("stays quiet when the saved draft came from the latest version", () => {
		// The note describes the text in the editor, so qualifying it would be
		// a warning about nothing — and a warning on every draft is one nobody
		// reads.
		renderPanel({
			draft: readyDraft(DOCUMENT, "d1"),
			working: working({ sourceDraftId: "d1" }),
		});

		expect(screen.queryByText(QUALIFIER)).not.toBeInTheDocument();
	});

	it("stays quiet when there is no saved draft to disagree with it", () => {
		// With no working body there is no "version this text was saved from",
		// so the sentence would be false rather than merely unnecessary.
		renderPanel({ draft: readyDraft(DOCUMENT, "d2") });

		expect(screen.queryByText(QUALIFIER)).not.toBeInTheDocument();
	});
});

/**
 * Defect §2 — the generalization note read off the wrong version.
 *
 * All the panels read `safetyNote` from `latestReady` while the editor beside
 * them holds the working draft. After a regeneration nobody adopted, those are
 * different documents. Slice A6 added a qualifier — but a qualifier only covers
 * the case where a note IS rendered.
 *
 * The uncovered half is the mirror: v1 was generalized, v2 needs none, so
 * `latestReady.safetyNote` is null and the whole section DISAPPEARS while the
 * saved text is still the generalized one. The reader loses the explanation of
 * the draft they are holding and there is nothing on screen to qualify — so no
 * wording change could ever reach it.
 */
describe("BlogPostPanel — the note belongs to the version on screen", () => {
	const GENERALIZED = {
		...DOCUMENT,
		safetyNote: "Generalized the customer reference.",
	};
	const CLEAN = { ...DOCUMENT, safetyNote: null };

	it("keeps the note when a later version needs no generalizing", () => {
		// The vanishing case. v2 is clean, the body is still v1's.
		renderPanel({
			draft: readyDraft(CLEAN, "d2"),
			working: working({
				sourceDraftId: "d1",
				sourceContent: GENERALIZED,
			}),
		});

		expect(
			screen.getByText("Generalized the customer reference."),
		).toBeInTheDocument();
	});

	it("shows the adopted version's note, not the newest one", () => {
		renderPanel({
			draft: readyDraft(
				{ ...DOCUMENT, safetyNote: "v2's own note." },
				"d2",
			),
			working: working({
				sourceDraftId: "d1",
				sourceContent: GENERALIZED,
			}),
		});

		expect(
			screen.getByText("Generalized the customer reference."),
		).toBeInTheDocument();
		expect(screen.queryByText("v2's own note.")).not.toBeInTheDocument();
	});

	it("drops the qualifier once the note really is this version's", () => {
		// "These notes describe another version" was the best A6 could do
		// without the source. With it in hand the sentence is false.
		renderPanel({
			draft: readyDraft(
				{ ...DOCUMENT, safetyNote: "v2's own note." },
				"d2",
			),
			working: working({
				sourceDraftId: "d1",
				sourceContent: GENERALIZED,
			}),
		});

		expect(
			screen.queryByText(/describe(s)? another version/i),
		).not.toBeInTheDocument();
	});

	it("still qualifies when the adopted version is gone", () => {
		// A superseded row can fall out of retention. The newest note is then
		// all there is, and saying so is the honest answer.
		renderPanel({
			draft: readyDraft(
				{ ...DOCUMENT, safetyNote: "v2's own note." },
				"d2",
			),
			working: working({ sourceDraftId: "d1", sourceContent: null }),
		});

		expect(screen.getByText("v2's own note.")).toBeInTheDocument();
	});
});
