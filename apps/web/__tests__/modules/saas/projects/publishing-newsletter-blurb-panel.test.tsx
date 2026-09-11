import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Newsletter Blurb generation panel (Fizzy #1988, Phase 2D-2).
 *
 * Assertions are on ROLES and TEXT, never on classes. What this panel owes a
 * reader is the same as its Case Study, Stakeholder Email and Webinar Script
 * siblings — a saved draft that is editable, an unadopted version offered
 * rather than applied, absent controls for a viewer — plus what is new on this
 * content type: a SEVEN-value release-status map, a six-value audience map and
 * a three-value call-to-action map, each rendered in the draft's own words;
 * whether the organization's own prompt was actually used; and which suggested
 * asset Fabric moved out of the confirmed list and why. None of that is
 * provable from a class name.
 *
 * There is deliberately no scaffold assertion in either direction. This content
 * type has no `isScaffold` (spec §5.2/§5.5), so nothing in the component can
 * render one — and an assertion whose failing state cannot be constructed is
 * the vacuous negative this slice has already shipped sixteen of.
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
	renderPdf: vi.fn(),
	renderDocx: vi.fn(),
	triggerDownload: vi.fn(),
	writeText: vi.fn(),
}));

/** Captures each mutation's options so `onSuccess`/`onError` can be driven directly. */
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
			generateNewsletterBlurb: mutate.generate,
			adoptNewsletterBlurbDraft: mutate.adopt,
			saveNewsletterBlurbBody: mutate.saveBody,
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
					generateNewsletterBlurb: m("generateNewsletterBlurb"),
					adoptNewsletterBlurbDraft: m("adoptNewsletterBlurbDraft"),
					saveNewsletterBlurbBody: m("saveNewsletterBlurbBody"),
				},
			},
		},
	};
});

/**
 * The renderers are stubbed, not exercised — same reasoning as the three
 * sibling suites: jspdf and docx are dynamically imported and produce binary,
 * and what this suite needs to know is the exact STRING handed to them, since
 * that string is the artefact the release, audience, call-to-action and clamp
 * lines have to survive into.
 */
vi.mock("@saas/projects/lib/markdown-to-document", () => ({
	renderMarkdownToPdf: mutate.renderPdf,
	renderMarkdownToDocx: mutate.renderDocx,
	triggerBlobDownload: mutate.triggerDownload,
	toSlug: (input: string) =>
		input
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "document",
}));

/**
 * Radix's dropdown needs a real pointer environment to open. Flattening it to
 * plain buttons keeps the assertions on the role and the visible name of each
 * format.
 */
vi.mock("@ui/components/dropdown-menu", () => {
	const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
	const Item = ({
		children,
		onClick,
	}: {
		children?: ReactNode;
		onClick?: () => void;
	}) => (
		<button type="button" onClick={() => onClick?.()}>
			{children}
		</button>
	);
	return {
		DropdownMenu: Pass,
		DropdownMenuTrigger: Pass,
		DropdownMenuContent: Pass,
		DropdownMenuItem: Item,
	};
});

import { ASSET_RESTRICTING_KINDS } from "@repo/utils/publishing-asset-clamp";
import {
	AUDIENCE_LABELS,
	CTA_STATE_LABELS,
	composeNewsletterBlurbWorkingDraftBody,
	NEWSLETTER_BLURB_BODY_MAX,
	RELEASE_STATUS_LABELS,
} from "@repo/utils/publishing-newsletter-blurb-body";
import { NewsletterBlurbPanel } from "@saas/projects/components/publishing-suite/NewsletterBlurbPanel";

/** A finished blurb: a confirmed release, a real CTA, nothing outstanding. */
const DOCUMENT = {
	headline: "A bounded retry budget, now shipped",
	blurb: "Duplicate deliveries used to page on-call every week. The retry budget landed this month and cut them roughly in half.",
	ctaState: "PRESENT",
	suggestedCta: "Reply to this note to book a walkthrough.",
	audience: "CUSTOMER",
	releaseStatus: "SHIPPED",
	suggestedAssets: {
		confirmed: ["Retry budget dashboard screenshot"],
		needsConfirmation: [],
	},
	inputsNeeded: [],
	safetyNote: null,
	generation: {
		promptSource: "BOUND",
		clamped: {},
	},
};

/** Nothing in the source material said whether this shipped. */
const UNCONFIRMED_DOCUMENT = {
	...DOCUMENT,
	releaseStatus: "UNCONFIRMED",
	safetyNote: "Left the release date out, since nothing confirmed one.",
	inputsNeeded: ["Confirm whether the retry budget is live for everyone."],
};

/** Written when no organization prompt was bound for this content type. */
const UNBOUND_DOCUMENT = {
	...DOCUMENT,
	generation: { promptSource: "DEFAULT_UNBOUND", clamped: {} },
};

/** Written when the bound prompt's own template failed to render. */
const RENDER_FAILED_DOCUMENT = {
	...DOCUMENT,
	generation: { promptSource: "DEFAULT_RENDER_FAILED", clamped: {} },
};

/**
 * One suggested asset the activity moved out of `confirmed`, because an open
 * internal-UI review thread names it — `assetKinds` records WHICH kind, and
 * this is the fixture that proves the panel actually reads `assetKinds` to
 * render the clamp attribution, not just `assets`.
 */
const CLAMPED_DOCUMENT = {
	...DOCUMENT,
	suggestedAssets: {
		confirmed: [],
		needsConfirmation: [
			"Admin panel screen capture",
			"Rollout timeline chart",
		],
	},
	generation: {
		promptSource: "BOUND",
		clamped: {
			assets: ["Admin panel screen capture"],
			assetKinds: { "Admin panel screen capture": "INTERNAL_UI" },
		},
	},
};

/** A shape this panel does not recognize — missing every required field. */
const UNREADABLE_CONTENT = {
	subject: "This is a stakeholder email, not a newsletter blurb",
	body: "Wrong shape entirely.",
};

const BODY = composeNewsletterBlurbWorkingDraftBody(DOCUMENT as never);
const SAVED_AT = new Date("2026-09-01T12:00:00Z");

function readyDraft(content: unknown = DOCUMENT, id = "d1") {
	const row = {
		id,
		postType: "NEWSLETTER_BLURB" as const,
		version: 1,
		status: "READY",
		error: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		content,
	};
	return {
		postType: "NEWSLETTER_BLURB" as const,
		latestAttempt: row,
		latestReady: row,
	};
}

function working(over: Record<string, unknown> = {}) {
	return {
		postType: "NEWSLETTER_BLURB" as const,
		hasBody: true,
		body: BODY,
		sourceDraftId: "d1",
		sourceOptionLabel: null,
		updatedAt: SAVED_AT,
		...over,
	};
}

/**
 * The element, separate from the render, so a test can hand the SAME tree new
 * props via `rerender` — which is the only way to simulate the poll this
 * panel's `editedBody` sentinel exists to survive.
 */
function panel(over: Record<string, unknown> = {}) {
	return (
		<NewsletterBlurbPanel
			projectId="p1"
			organizationId="org1"
			topicId="t1"
			draft={null}
			working={null}
			canEdit={true}
			{...(over as never)}
		/>
	);
}

function renderPanel(over: Record<string, unknown> = {}) {
	return render(panel(over));
}

/**
 * The whole `listTopicDrafts` key, as a literal. Declared once and shared by
 * all four invalidation assertions, because the failure this guards against is
 * a key that is missing an identifier: such a key still looks like a refresh
 * and still invalidates SOMETHING — just not the entry this panel reads from.
 * A bare `toHaveBeenCalled()` cannot see that, and three of the four call sites
 * used to be bare or absent.
 */
const DRAFTS_KEY = {
	queryKey: [
		"listTopicDrafts",
		{ projectId: "p1", topicId: "t1", organizationId: "org1" },
	],
};

/**
 * jsdom ships no clipboard, and `userEvent.setup()` installs a stub of its own
 * over whatever is there — so this has to run AFTER setup in every case that
 * cares, or the assertion lands on user-event's stub.
 */
function setClipboard(value: unknown) {
	Object.defineProperty(globalThis.navigator, "clipboard", {
		value,
		configurable: true,
		writable: true,
	});
}

function setupWithClipboard(clipboard: unknown) {
	const user = userEvent.setup();
	setClipboard(clipboard);
	return user;
}

const workingClipboard = () => ({ writeText: mutate.writeText });

const editor = () =>
	screen.getByRole("textbox", { name: /working newsletter blurb/i });

beforeEach(() => {
	vi.clearAllMocks();
	for (const k of Object.keys(captured)) {
		delete captured[k];
	}
	vi.stubGlobal("confirm", mutate.confirm);
	mutate.confirm.mockReturnValue(true);
	mutate.renderPdf.mockResolvedValue(new Blob(["pdf"]));
	mutate.renderDocx.mockResolvedValue(new Blob(["docx"]));
	mutate.writeText.mockResolvedValue(undefined);
	setClipboard({ writeText: mutate.writeText });
});

describe("NewsletterBlurbPanel — the generate control", () => {
	/**
	 * Spec §11's named case. Its tab-level twin — clicking the Newsletter Blurb
	 * tab in `publishing-generation-tabs.test.tsx` and finding this control —
	 * cannot exist until Task 10 puts the type in `GENERATION_ACTIVE_POST_TYPES`
	 * and mounts the arm, so this is the half that is constructible today.
	 */
	it("DOES offer a generate control on the Newsletter Blurb tab", () => {
		renderPanel();

		expect(
			screen.getByRole("button", { name: /generate newsletter blurb/i }),
		).toBeEnabled();
	});

	it("sends the guidance the reader typed", async () => {
		const user = userEvent.setup();
		renderPanel();

		await user.type(
			screen.getByLabelText(/guidance/i),
			"Two sentences, for the customer digest.",
		);
		await user.click(
			screen.getByRole("button", { name: /generate newsletter blurb/i }),
		);

		// The WHOLE input, as a literal. `objectContaining` cannot tell a
		// dropped optional field from a field that was never there, which is
		// how an omitted key stays legal TypeScript all the way to production.
		expect(mutate.generate).toHaveBeenCalledWith({
			projectId: "p1",
			topicId: "t1",
			organizationId: "org1",
			guidance: "Two sentences, for the customer digest.",
		});
	});

	it("sends null rather than an empty string when nothing was typed", async () => {
		const user = userEvent.setup();
		renderPanel();

		await user.click(
			screen.getByRole("button", { name: /generate newsletter blurb/i }),
		);

		expect(mutate.generate).toHaveBeenCalledWith({
			projectId: "p1",
			topicId: "t1",
			organizationId: "org1",
			guidance: null,
		});
	});

	it("switches to Regenerate once a draft exists", () => {
		renderPanel({ draft: readyDraft() });

		expect(
			screen.getByRole("button", { name: /regenerate draft/i }),
		).toBeEnabled();
		expect(
			screen.getByText(
				/newsletter blurb you have saved is not affected/i,
			),
		).toBeInTheDocument();
	});

	it("stays enabled for a STRANDED run, which nothing else can free", () => {
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
			screen.getByRole("button", { name: /generate newsletter blurb/i }),
		).toBeEnabled();
		expect(screen.getByRole("alert")).toHaveTextContent(
			/didn't report back/i,
		);
	});

	it("disables the button only while a run is genuinely in flight", () => {
		const draft = readyDraft();
		renderPanel({
			draft: {
				...draft,
				latestAttempt: {
					...draft.latestAttempt,
					status: "GENERATING",
					isExpired: false,
				},
				latestReady: null,
			},
		});

		expect(
			screen.getByRole("button", { name: /generate newsletter blurb/i }),
		).toBeDisabled();
		expect(screen.getByRole("status")).toHaveTextContent(/writing/i);
	});

	it("reports an unavailable generator as information, not an error", () => {
		renderPanel();

		captured.generateNewsletterBlurb.onSuccess?.({
			started: false,
			reason: "unavailable",
		});

		// The MESSAGE, not merely that some toast happened. The panel picks
		// between two sentences on `reason`, and a bare `toHaveBeenCalled()`
		// accepts either one — so the ternary could be inverted and nothing
		// would redden.
		expect(mutate.toastInfo).toHaveBeenCalledWith(
			"Generation is unavailable right now. Try again in a few minutes.",
		);
		expect(mutate.toastError).not.toHaveBeenCalled();
	});

	it("says a run is already under way, rather than that the generator is down", () => {
		// The other half of the ternary, never exercised before. The
		// consequence of confusing the two is operational: an operator told a
		// run is already in progress, when in fact the generator is down, waits
		// for a run that does not exist.
		renderPanel();

		captured.generateNewsletterBlurb.onSuccess?.({
			started: false,
			reason: "in-progress",
		});

		expect(mutate.toastInfo).toHaveBeenCalledWith(
			"A newsletter blurb is already being generated for this topic.",
		);
		expect(mutate.toastError).not.toHaveBeenCalled();
	});

	it("refreshes THIS topic's drafts, keyed on all three identifiers", () => {
		// The whole key as a literal. A key missing `organizationId` still
		// looks like a refresh and still invalidates something — just not the
		// entry this panel reads from.
		renderPanel();

		captured.generateNewsletterBlurb.onSuccess?.({ started: true });

		expect(mutate.invalidate).toHaveBeenCalledWith(DRAFTS_KEY);
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

describe("NewsletterBlurbPanel — the editor", () => {
	it("shows the saved draft in an editable field", () => {
		renderPanel({ working: working() });

		expect(editor()).toHaveValue(BODY);
	});

	it("bounds the editor at THIS type's cap, not the webinar script's", () => {
		// 24,000, not 40,000 — the API refuses a longer body, so a field that
		// accepted one would trade a clear client-side stop for a server
		// rejection of text the reader can no longer see all of.
		renderPanel({ working: working() });

		expect(editor()).toHaveAttribute(
			"maxlength",
			String(NEWSLETTER_BLURB_BODY_MAX),
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

		await user.clear(editor());
		await user.type(editor(), "Rewritten.");
		await user.click(screen.getByRole("button", { name: /save changes/i }));

		expect(mutate.saveBody).toHaveBeenCalledWith({
			projectId: "p1",
			topicId: "t1",
			organizationId: "org1",
			body: "Rewritten.",
			expectedUpdatedAt: SAVED_AT,
		});
	});

	it("KEEPS the reader's text when the save loses a race", async () => {
		const user = userEvent.setup();
		renderPanel({ working: working() });

		await user.clear(editor());
		await user.type(editor(), "Rewritten.");

		captured.saveNewsletterBlurbBody.onError?.({ code: "CONFLICT" });

		expect(editor()).toHaveValue("Rewritten.");
		expect(mutate.invalidate).not.toHaveBeenCalled();
		expect(mutate.toastError).toHaveBeenCalledWith(
			expect.stringMatching(/your text is still here/i),
		);
	});

	it("hands the editor back to the server and refreshes the list once a save lands", async () => {
		// The success half, which nothing drove before — and the more serious
		// of the two. `setEditedBody(null)` is what stops the pre-save text
		// being painted back over the new body; without it the NEXT save
		// re-sends that stale text with a freshly-read `expectedUpdatedAt`, and
		// a compare-and-set handed a current timestamp cannot refuse anything.
		const user = userEvent.setup();
		renderPanel({ working: working() });

		await user.clear(editor());
		await user.type(editor(), "Rewritten.");
		expect(editor()).toHaveValue("Rewritten.");

		act(() => {
			captured.saveNewsletterBlurbBody.onSuccess?.();
		});

		expect(editor()).toHaveValue(BODY);
		// The whole key, not a bare `toHaveBeenCalled()`: a refresh of the
		// wrong entry leaves the list showing what it showed before.
		expect(mutate.invalidate).toHaveBeenCalledWith(DRAFTS_KEY);
	});

	it("shows a poll's newer body to a reader who has not typed", () => {
		// The sole reason `editedBody` is `string | null` rather than a copy of
		// the body. Seed it from `working.body` instead and the `useState`
		// initializer runs once, so every refetched body is ignored for the
		// life of the mount — the reader goes on editing and saving text the
		// server already replaced.
		const view = renderPanel({ working: working() });

		view.rerender(
			panel({ working: working({ body: "Server rewrote it." }) }),
		);

		expect(editor()).toHaveValue("Server rewrote it.");
	});

	it("does NOT clobber what the reader typed when a poll lands", async () => {
		// The other half, and the reason the sentinel cannot simply be "always
		// take the server's copy". Both directions are needed: the null exists
		// precisely to tell these two cases apart.
		const user = userEvent.setup();
		const view = renderPanel({ working: working() });

		await user.clear(editor());
		await user.type(editor(), "Half a sentence still being written");

		view.rerender(
			panel({ working: working({ body: "Server rewrote it." }) }),
		);

		expect(editor()).toHaveValue("Half a sentence still being written");
	});

	it("marks unsaved work so a reader does not navigate away over it", async () => {
		const user = userEvent.setup();
		renderPanel({ working: working() });

		await user.type(editor(), " extra");

		expect(screen.getByRole("status")).toHaveTextContent(
			/unsaved changes/i,
		);
	});

	it("offers a way back after an edit the reader does not want", async () => {
		const user = userEvent.setup();
		renderPanel({ working: working() });

		await user.type(editor(), " extra");
		await user.click(
			screen.getByRole("button", { name: /discard changes/i }),
		);

		expect(editor()).toHaveValue(BODY);
	});
});

describe("NewsletterBlurbPanel — adopting a later version (FR34/FR35)", () => {
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

		await user.type(editor(), " extra");
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

		expect(mutate.adopt).toHaveBeenCalledWith({
			projectId: "p1",
			topicId: "t1",
			organizationId: "org1",
			draftId: "d2",
			expectedUpdatedAt: SAVED_AT,
		});
	});

	it("sends an updatedAt for a row whose body is blank, not null", async () => {
		const user = userEvent.setup();
		renderPanel({
			draft: readyDraft(DOCUMENT, "d2"),
			working: working({ hasBody: false, body: "", sourceDraftId: null }),
		});

		await user.click(
			screen.getByRole("button", { name: /save as working draft/i }),
		);

		expect(mutate.adopt).toHaveBeenCalledWith({
			projectId: "p1",
			topicId: "t1",
			organizationId: "org1",
			draftId: "d2",
			expectedUpdatedAt: SAVED_AT,
		});
	});

	it("refreshes and warns, rather than keeping stale text, when adopting loses a race", () => {
		// Unlike save's CONFLICT (which keeps the reader's unsaved edits
		// standing so they can be copied), adopt's CONFLICT invalidates —
		// there is no local edit of the CANDIDATE to preserve, only a stale
		// read of what is already saved.
		renderPanel({
			draft: readyDraft(DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
		});

		captured.adoptNewsletterBlurbDraft.onError?.({ code: "CONFLICT" });

		expect(mutate.invalidate).toHaveBeenCalledWith(DRAFTS_KEY);
		expect(mutate.toastError).toHaveBeenCalledWith(
			expect.stringMatching(/changed while you were reading/i),
		);
	});

	it("clears the editor and refreshes the list once an adopt lands", async () => {
		// Adopt's success half, the twin of save's. Without the refresh the
		// panel goes on offering "Use this version" for the version it has just
		// adopted; without the clear, the reader's pre-adopt text is painted
		// back over the body they adopted.
		const user = userEvent.setup();
		renderPanel({
			draft: readyDraft(DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
		});

		await user.type(editor(), " extra");
		expect(editor()).toHaveValue(`${BODY} extra`);

		act(() => {
			captured.adoptNewsletterBlurbDraft.onSuccess?.();
		});

		expect(editor()).toHaveValue(BODY);
		expect(mutate.invalidate).toHaveBeenCalledWith(DRAFTS_KEY);
	});
});

/**
 * Spec §9.1: each map is exercised for EVERY value in the panel suite. That is
 * the only thing that catches a map widened to `Record<string, string>` and
 * then missing a member, or a panel that reached for the sibling module's map
 * of the same bare name — `RELEASE_STATUS_LABELS` is exported under that name
 * by the Webinar Script module too, and that one has no `PILOT` or `UPCOMING`.
 *
 * The loops read the map itself rather than a hand-copied list of phrases, so
 * a value added to the enum cannot be exercised by six of seven cases. The key
 * sets are pinned separately, by IDENTITY and not by count: a count agrees with
 * a map that swapped one member for another.
 */
describe("NewsletterBlurbPanel — what the draft claims", () => {
	it("carries one label per release status, and exactly these seven", () => {
		expect(Object.keys(RELEASE_STATUS_LABELS).sort()).toEqual(
			[
				"IN_PROGRESS",
				"PILOT",
				"PLANNED",
				"PREVIEW",
				"SHIPPED",
				"UNCONFIRMED",
				"UPCOMING",
			].sort(),
		);
	});

	it("renders each of the seven release states in its own words", () => {
		for (const [releaseStatus, phrase] of Object.entries(
			RELEASE_STATUS_LABELS,
		)) {
			const view = renderPanel({
				draft: readyDraft({ ...DOCUMENT, releaseStatus }, "d2"),
			});

			expect(screen.getByText(phrase)).toBeInTheDocument();
			view.unmount();
		}
	});

	it("carries one label per audience, and exactly these six", () => {
		expect(Object.keys(AUDIENCE_LABELS).sort()).toEqual(
			[
				"COMMUNITY",
				"CUSTOMER",
				"EXTERNAL",
				"INTERNAL",
				"PARTNER",
				"UNSPECIFIED",
			].sort(),
		);
	});

	it("renders each of the six audiences in its own words", () => {
		for (const [audience, phrase] of Object.entries(AUDIENCE_LABELS)) {
			const view = renderPanel({
				draft: readyDraft({ ...DOCUMENT, audience }, "d2"),
			});

			expect(screen.getByText(phrase)).toBeInTheDocument();
			view.unmount();
		}
	});

	it("carries one label per call-to-action state, and exactly these three", () => {
		expect(Object.keys(CTA_STATE_LABELS).sort()).toEqual(
			["OMITTED", "PRESENT", "UNKNOWN"].sort(),
		);
	});

	it("renders each of the three call-to-action states in its own words", () => {
		// The CTA the fixture carries is set per state rather than left
		// constant: `PRESENT` is only reachable WITH one and the other two are
		// only reachable WITHOUT one, so a single shared fixture would
		// demonstrate one branch while satisfying another.
		for (const [ctaState, phrase] of Object.entries(CTA_STATE_LABELS)) {
			const view = renderPanel({
				draft: readyDraft(
					{
						...DOCUMENT,
						ctaState,
						suggestedCta:
							ctaState === "PRESENT"
								? DOCUMENT.suggestedCta
								: null,
					},
					"d2",
				),
			});

			expect(screen.getByText(phrase)).toBeInTheDocument();
			view.unmount();
		}
	});

	it("reads a garbled release status as unconfirmed, never as shipped", () => {
		renderPanel({
			draft: readyDraft({ ...DOCUMENT, releaseStatus: "LIVE" }, "d2"),
		});

		expect(
			screen.getByText(RELEASE_STATUS_LABELS.UNCONFIRMED),
		).toBeInTheDocument();
	});

	it("reads a garbled audience as unspecified, never as a named readership", () => {
		renderPanel({
			draft: readyDraft({ ...DOCUMENT, audience: "EVERYONE" }, "d2"),
		});

		expect(
			screen.getByText(AUDIENCE_LABELS.UNSPECIFIED),
		).toBeInTheDocument();
	});

	it("will not claim a call to action the draft does not carry", () => {
		// `PRESENT` with nothing to present is a claim with no payload. The
		// schema's own transform reconciles that at write time; a row written
		// before it did, or by a different shape, reaches this reader intact.
		renderPanel({
			draft: readyDraft(
				{ ...DOCUMENT, ctaState: "PRESENT", suggestedCta: "   " },
				"d2",
			),
		});

		expect(screen.getByText(CTA_STATE_LABELS.UNKNOWN)).toBeInTheDocument();
	});

	it("keeps an OMITTED call to action a decision rather than a gap", () => {
		// The mirror of the case above, and the one combination the reader
		// must NOT rewrite: the state and the payload agree.
		renderPanel({
			draft: readyDraft(
				{ ...DOCUMENT, ctaState: "OMITTED", suggestedCta: null },
				"d2",
			),
		});

		expect(screen.getByText(CTA_STATE_LABELS.OMITTED)).toBeInTheDocument();
	});

	it("attributes the claims to the draft, and says nothing was checked", () => {
		renderPanel({ draft: readyDraft(DOCUMENT, "d2") });

		expect(
			screen.getByText(
				/nothing here was checked against a release record/i,
			),
		).toBeInTheDocument();
	});
});

describe("NewsletterBlurbPanel — the prompt-source notice (spec §9.3)", () => {
	it("says so when no organization prompt is bound", () => {
		renderPanel({ draft: readyDraft(UNBOUND_DOCUMENT, "d2") });

		expect(
			screen.getByText(/no organization prompt is bound/i),
		).toBeInTheDocument();
	});

	it("says so when the bound prompt's template failed to render", () => {
		renderPanel({ draft: readyDraft(RENDER_FAILED_DOCUMENT, "d2") });

		expect(
			screen.getByText(/bound prompt could not be rendered/i),
		).toBeInTheDocument();
	});

	it("stays quiet when the draft was written from the bound prompt", () => {
		renderPanel({ draft: readyDraft(DOCUMENT, "d2") });

		expect(
			screen.queryByText(/organization prompt is bound/i),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText(/bound prompt could not be rendered/i),
		).not.toBeInTheDocument();
	});

	it("fails toward showing the notice when the generation block is missing", () => {
		// An older row, or a storage defect. The signal exists to warn a reader
		// the org's own prompt was not used; treating an absent field as "it
		// was used" is the under-warning direction this repo's own standing
		// rule says is the worse one.
		const { generation: _generation, ...rest } = DOCUMENT;
		renderPanel({ draft: readyDraft(rest, "d2") });

		expect(
			screen.getByText(/no organization prompt is bound/i),
		).toBeInTheDocument();
	});
});

describe("NewsletterBlurbPanel — the asset clamp attribution", () => {
	/**
	 * The panel's kind→phrase map is the file's ONE widened map — declared
	 * `Record<string, string>` because its source, `ASSET_RESTRICTING_KINDS`, is
	 * a `ReadonlySet<string>` rather than an enum. Nothing in the type system
	 * links the two, so a kind added there gets no compile error for the
	 * missing phrase; it silently degrades to the generic fallback.
	 *
	 * This table is that link, made at test time: its key set is pinned against
	 * the real set by IDENTITY below, and the loop under it renders every
	 * member. A phrase swapped between two members fails the loop; a member
	 * added to the set without a phrase fails the key-set test.
	 */
	const CLAMP_KIND_PHRASES: Record<string, string> = {
		ASSET_APPROVAL: "an open asset-approval thread",
		INTERNAL_UI: "an open internal-UI review thread",
		VIDEO_WALKTHROUGH: "an open video-walkthrough review thread",
	};

	/** The same document, re-clamped onto one asset of a given kind. */
	const clampedAs = (kind: string) => ({
		...CLAMPED_DOCUMENT,
		generation: {
			promptSource: "BOUND",
			clamped: {
				assets: ["Admin panel screen capture"],
				assetKinds: { "Admin panel screen capture": kind },
			},
		},
	});

	it("carries one phrase per restricting kind, and exactly these three", () => {
		expect(Object.keys(CLAMP_KIND_PHRASES).sort()).toEqual(
			[...ASSET_RESTRICTING_KINDS].sort(),
		);
	});

	it("names the review kind that moved the asset, for every kind there is", () => {
		for (const [kind, phrase] of Object.entries(CLAMP_KIND_PHRASES)) {
			const view = renderPanel({
				draft: readyDraft(clampedAs(kind), "d2"),
			});

			expect(
				screen.getByText(
					new RegExp(
						`admin panel screen capture — moved out of the confirmed list by fabric, from ${phrase} naming it\\.`,
						"i",
					),
				),
			).toBeInTheDocument();
			view.unmount();
		}
	});

	it("degrades to a generic phrase for a kind this client does not know", () => {
		// A newer deploy can clamp on a kind added after this bundle shipped.
		// The fallback is still TRUE — an approval thread of some sort named it
		// — which is why this is the safe direction to degrade in, and why it
		// needs a test rather than a type.
		renderPanel({ draft: readyDraft(clampedAs("SOMETHING_NEWER"), "d2") });

		expect(
			screen.getByText(
				/admin panel screen capture — moved out of the confirmed list by fabric, from an open approval thread naming it\./i,
			),
		).toBeInTheDocument();
	});

	it("names the asset AND the kind of review that moved it", () => {
		renderPanel({ draft: readyDraft(CLAMPED_DOCUMENT, "d2") });

		expect(
			screen.getByText(
				/admin panel screen capture.*moved out of the confirmed list by fabric.*internal-ui/i,
			),
		).toBeInTheDocument();
	});

	it("does not attribute a plain needs-confirmation entry to Fabric", () => {
		// The negative control: "Rollout timeline chart" is in the SAME list
		// but was never clamped — the model was simply unsure about it, and a
		// reader must be able to tell the two apart.
		renderPanel({ draft: readyDraft(CLAMPED_DOCUMENT, "d2") });

		expect(
			screen.queryByText(/rollout timeline chart.*moved out/i),
		).not.toBeInTheDocument();
		expect(screen.getByText("Rollout timeline chart")).toBeInTheDocument();
	});

	it("lists a confirmed asset without attributing it to anyone", () => {
		renderPanel({ draft: readyDraft(DOCUMENT, "d2") });

		expect(
			screen.getByText("Retry budget dashboard screenshot"),
		).toBeInTheDocument();
	});
});

describe("NewsletterBlurbPanel — a document shape the panel cannot read", () => {
	it("degrades to an empty state rather than throwing", () => {
		// A panel that throws takes the whole Topic Item Page with it.
		renderPanel({ draft: readyDraft(UNREADABLE_CONTENT) });

		expect(
			screen.getByText(/no newsletter blurb draft yet/i),
		).toBeInTheDocument();
	});
});

describe("NewsletterBlurbPanel — copying and downloading the draft", () => {
	it("copies exactly the text the reader is looking at", async () => {
		// The reader EDITS first, and that is the whole point. On an untouched
		// fixture the saved body and the text on screen are the same string, so
		// this assertion would hold whether the panel copies what is DISPLAYED
		// or what was last SAVED — "the text the reader is looking at" is only
		// distinguishable from "the saved text" once the two differ.
		const user = setupWithClipboard(workingClipboard());
		renderPanel({ draft: readyDraft(DOCUMENT, "d1"), working: working() });

		await user.clear(editor());
		await user.type(editor(), "The reader's own unsaved edit.");
		expect(editor()).toHaveValue("The reader's own unsaved edit.");

		await user.click(
			screen.getByRole("button", {
				name: /copy draft to the clipboard/i,
			}),
		);

		expect(mutate.writeText).toHaveBeenCalledWith(
			"The reader's own unsaved edit.",
		);
		expect(mutate.toastSuccess).toHaveBeenCalled();

		// The third surface, in this test rather than its own, because what is
		// being pinned is that the editor, the clipboard and the FILE all agree
		// on which document the reader is sending.
		await user.click(screen.getByRole("button", { name: /pdf/i }));

		const exported = mutate.renderPdf.mock.calls[0][0] as string;
		expect(exported).toContain("The reader's own unsaved edit.");
		expect(exported).not.toContain(
			"Duplicate deliveries used to page on-call",
		);
	});

	it("carries the release, audience, call-to-action and clamp lines the working body cannot show", async () => {
		const user = userEvent.setup();
		renderPanel({
			draft: readyDraft(CLAMPED_DOCUMENT, "d1"),
			working: working({ sourceDraftId: "d1" }),
		});

		await user.click(screen.getByRole("button", { name: /pdf/i }));

		const exported = mutate.renderPdf.mock.calls[0][0] as string;
		expect(exported).toContain("# Draft caveats — not ready to send");
		expect(exported).toContain(
			`- Release status: ${RELEASE_STATUS_LABELS.SHIPPED}`,
		);
		expect(exported).toContain(`- Audience: ${AUDIENCE_LABELS.CUSTOMER}`);
		expect(exported).toContain(
			`- Call to action: ${CTA_STATE_LABELS.PRESENT}`,
		);
		// The kind attribution, per asset — the same line the panel renders on
		// screen, so the file and the page say the same thing.
		expect(exported).toContain(
			"Admin panel screen capture — Moved out of the confirmed list by Fabric, from an open internal-UI review thread naming it.",
		);
		// The success path hands the file to the browser, named from the
		// draft's own headline. Asserted here because without it the "did not
		// download" assertion in the renderer-failure case below has no state
		// in this suite where it could ever have gone red.
		expect(mutate.triggerDownload).toHaveBeenCalledWith(
			expect.any(Blob),
			"a-bounded-retry-budget-now-shipped.pdf",
		);
	});

	it("keeps the confirmed-assets list in the download even when the draft is otherwise clean", async () => {
		// DOCUMENT is SHIPPED, has a real CTA and nothing outstanding — the
		// only caveat-shaped thing about it is a confirmed asset. A clean draft
		// still exports the asset, and must NOT also earn a "not ready to send"
		// heading, since nothing about it is uncertain.
		const user = userEvent.setup();
		renderPanel({
			draft: readyDraft(DOCUMENT, "d1"),
			working: working({ sourceDraftId: "d1" }),
		});

		await user.click(screen.getByRole("button", { name: /pdf/i }));

		const exported = mutate.renderPdf.mock.calls[0][0] as string;
		expect(exported).toContain("Retry budget dashboard screenshot");
		expect(exported).not.toContain("not ready to send");
	});

	it("caveats a draft whose call to action was never named", async () => {
		// `UNKNOWN` is the one gap this content type reports structurally
		// rather than as a bracketed placeholder inside the prose, so the
		// export is one of only two places it is ever stated.
		const user = userEvent.setup();
		renderPanel({
			draft: readyDraft(
				{ ...DOCUMENT, ctaState: "UNKNOWN", suggestedCta: null },
				"d1",
			),
			working: working({ sourceDraftId: "d1" }),
		});

		await user.click(screen.getByRole("button", { name: /pdf/i }));

		const exported = mutate.renderPdf.mock.calls[0][0] as string;
		expect(exported).toContain("# Draft caveats — not ready to send");
		expect(exported).toContain(
			`- Call to action: ${CTA_STATE_LABELS.UNKNOWN}`,
		);
	});

	it("downloads the reader's own unsaved text, plus the other-version note, when the saved draft predates the latest generation", async () => {
		const user = userEvent.setup();
		renderPanel({
			draft: readyDraft(DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
		});

		await user.clear(editor());
		await user.type(editor(), "The reader's own unsaved edit.");
		await user.click(screen.getByRole("button", { name: /pdf/i }));

		const exported = mutate.renderPdf.mock.calls[0][0] as string;
		// The reader's text, not `latestReady`'s candidate body — the download
		// and the caption above it must agree on which document they send.
		expect(exported).toContain("The reader's own unsaved edit.");
		expect(exported).toMatch(/most recent generated version/i);
	});

	it("says so rather than going silent when a renderer fails", async () => {
		const user = userEvent.setup();
		mutate.renderPdf.mockRejectedValue(new Error("jspdf unavailable"));
		renderPanel({
			draft: readyDraft(DOCUMENT, "d1"),
			working: working({ sourceDraftId: "d1" }),
		});

		await user.click(screen.getByRole("button", { name: /pdf/i }));

		expect(mutate.toastError).toHaveBeenCalledWith(
			expect.stringMatching(/jspdf unavailable/i),
		);
		expect(mutate.triggerDownload).not.toHaveBeenCalled();
	});
});

describe("NewsletterBlurbPanel — refining the saved draft", () => {
	it("does NOT offer refine before anything is saved", () => {
		renderPanel({ draft: readyDraft() });

		expect(
			screen.queryByRole("button", { name: /refine draft/i }),
		).not.toBeInTheDocument();
	});

	it("offers refine ALONGSIDE regenerate once a draft is saved", () => {
		renderPanel({ draft: readyDraft(), working: working() });

		expect(
			screen.getByRole("button", { name: /refine draft/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /regenerate draft/i }),
		).toBeEnabled();
	});

	it("sends the instruction with the refine flag, and no body", async () => {
		const user = userEvent.setup();
		renderPanel({ working: working() });

		await user.type(
			screen.getByRole("textbox", { name: /refine the saved draft/i }),
			"Make it one sentence.",
		);
		await user.click(screen.getByRole("button", { name: /refine draft/i }));

		expect(mutate.generate).toHaveBeenCalledWith({
			projectId: "p1",
			topicId: "t1",
			organizationId: "org1",
			guidance: "Make it one sentence.",
			refineFromWorkingDraft: true,
		});
	});
});

describe("NewsletterBlurbPanel — inputs needed and the safety note", () => {
	it("shows the inputs still needed", () => {
		renderPanel({ draft: readyDraft(UNCONFIRMED_DOCUMENT, "d2") });

		expect(
			screen.getByText(
				/confirm whether the retry budget is live for everyone/i,
			),
		).toBeInTheDocument();
	});

	it("shows the note the draft wrote around", () => {
		renderPanel({ draft: readyDraft(UNCONFIRMED_DOCUMENT, "d2") });

		expect(
			screen.getByText(/left the release date out/i),
		).toBeInTheDocument();
	});
});

/**
 * The safety note has to describe the document in the EDITOR, and `latestReady`
 * stops being that document the moment a regeneration nobody adopted lands on
 * top of it.
 *
 * The qualifier alone reaches only half of it. When v1 was generalized and v2
 * needs none, the newest note is null, the section does not render at all, and
 * there is nothing on screen left to qualify. The download is the worse half:
 * the file leaves Fabric stating generalizations that belong to a draft nobody
 * adopted, or omitting the ones that do apply.
 */
describe("NewsletterBlurbPanel — the note belongs to the version in the editor", () => {
	/** v1 — the version the saved body was adopted from. */
	const GENERALIZED = {
		...DOCUMENT,
		safetyNote: "Generalized the customer reference.",
	};
	/** v2 — a later candidate nobody adopted, carrying a note of its own. */
	const NEWEST_WITH_NOTE = {
		...DOCUMENT,
		safetyNote: "Left the rollout date out of the newest draft.",
	};

	/**
	 * Every occurrence of the other-version qualifier on screen, COUNTED rather
	 * than queried for absence: the claims section renders one of its own
	 * whenever the body came from another version — that metadata genuinely IS
	 * the candidate's — so "no qualifier beside the safety note" is a count of
	 * one, not a count of zero.
	 */
	const versionQualifiers = () =>
		screen.getAllByText(/most recent generated version/i);

	it("keeps the note on screen when the newest version needs no generalizing", () => {
		renderPanel({
			draft: readyDraft(DOCUMENT, "d2"),
			working: working({
				sourceDraftId: "d1",
				sourceContent: GENERALIZED,
			}),
		});

		expect(
			screen.getByText(/generalized the customer reference/i),
		).toBeInTheDocument();
	});

	it("shows the adopted version's note, not the newest one", () => {
		renderPanel({
			draft: readyDraft(NEWEST_WITH_NOTE, "d2"),
			working: working({
				sourceDraftId: "d1",
				sourceContent: GENERALIZED,
			}),
		});

		expect(
			screen.getByText(/generalized the customer reference/i),
		).toBeInTheDocument();
		expect(
			screen.queryByText(
				/left the rollout date out of the newest draft/i,
			),
		).not.toBeInTheDocument();
	});

	it("drops the qualifier once the note really is this text's", () => {
		renderPanel({
			draft: readyDraft(NEWEST_WITH_NOTE, "d2"),
			working: working({
				sourceDraftId: "d1",
				sourceContent: GENERALIZED,
			}),
		});

		// One — the claims section's. The safety note is this text's own now,
		// and saying otherwise beside it would be false.
		expect(versionQualifiers()).toHaveLength(1);
	});

	it("still qualifies on screen when the adopted version is gone", () => {
		// A superseded row can fall out of retention. The newest note is then
		// all there is, and saying so is the honest answer.
		renderPanel({
			draft: readyDraft(NEWEST_WITH_NOTE, "d2"),
			working: working({ sourceDraftId: "d1", sourceContent: null }),
		});

		expect(
			screen.getByText(/left the rollout date out of the newest draft/i),
		).toBeInTheDocument();
		// The claims section's, plus the one beside the note.
		expect(versionQualifiers()).toHaveLength(2);
	});

	it("exports the adopted version's note, not the newest one", async () => {
		const user = userEvent.setup();
		renderPanel({
			draft: readyDraft(NEWEST_WITH_NOTE, "d2"),
			working: working({
				sourceDraftId: "d1",
				sourceContent: GENERALIZED,
			}),
		});

		await user.click(screen.getByRole("button", { name: /pdf/i }));

		const exported = mutate.renderPdf.mock.calls[0][0] as string;
		expect(exported).toContain(
			"- Safety note: Generalized the customer reference.",
		);
		expect(exported).not.toContain(
			"Left the rollout date out of the newest draft.",
		);
		// The caveat still says the metadata above it is another version's —
		// release status, audience and call-to-action state are the
		// candidate's, and that is unchanged by which note the file carries.
		expect(exported).toMatch(/most recent generated version/i);
	});

	it("keeps the note in the download when the newest version needs none", async () => {
		// The vanishing case, in the artefact that leaves the product: v2 is
		// clean, so there is no newest note to export and no surface left to
		// qualify — the file would go out silently missing the generalization
		// that actually applies to its own text.
		const user = userEvent.setup();
		renderPanel({
			draft: readyDraft(DOCUMENT, "d2"),
			working: working({
				sourceDraftId: "d1",
				sourceContent: GENERALIZED,
			}),
		});

		await user.click(screen.getByRole("button", { name: /pdf/i }));

		expect(mutate.renderPdf.mock.calls[0][0] as string).toContain(
			"- Safety note: Generalized the customer reference.",
		);
	});

	it("exports the newest note when the adopted version is gone", async () => {
		const user = userEvent.setup();
		renderPanel({
			draft: readyDraft(NEWEST_WITH_NOTE, "d2"),
			working: working({ sourceDraftId: "d1", sourceContent: null }),
		});

		await user.click(screen.getByRole("button", { name: /pdf/i }));

		const exported = mutate.renderPdf.mock.calls[0][0] as string;
		expect(exported).toContain(
			"- Safety note: Left the rollout date out of the newest draft.",
		);
		expect(exported).toMatch(/most recent generated version/i);
	});

	/**
	 * `doc` is read off `latestReady.content`; `readyId` is read off the ROW. A
	 * candidate written by a newer deploy — carrying a field this client's
	 * reader rejects — leaves the row readable and its content not, so `readyId`
	 * is non-null and `doc` is null at the same time. The adopted version still
	 * parses, so a KNOWN note applies to the text in the editor.
	 *
	 * The download is not gated on `doc` — it sits beside Save and Copy in the
	 * working-draft editor — so the reader can export in exactly this state.
	 */
	it("keeps the adopted note on screen when the newest candidate cannot be read", () => {
		renderPanel({
			draft: readyDraft(UNREADABLE_CONTENT, "d2"),
			working: working({
				sourceDraftId: "d1",
				sourceContent: GENERALIZED,
			}),
		});

		expect(
			screen.getByText(/generalized the customer reference/i),
		).toBeInTheDocument();
		// Unqualified, and no other surface qualifies either: every block that
		// carries the candidate's metadata is gated on `doc` and renders
		// nothing here, so there is no other version's text on screen to warn
		// about — only a note that is this text's own.
		expect(
			screen.queryByText(/most recent generated version/i),
		).not.toBeInTheDocument();
	});

	it("exports the adopted note when the newest candidate cannot be read", async () => {
		const user = userEvent.setup();
		renderPanel({
			draft: readyDraft(UNREADABLE_CONTENT, "d2"),
			working: working({
				sourceDraftId: "d1",
				sourceContent: GENERALIZED,
			}),
		});

		await user.click(screen.getByRole("button", { name: /pdf/i }));

		const exported = mutate.renderPdf.mock.calls[0][0] as string;
		expect(exported).toContain(
			"- Safety note: Generalized the customer reference.",
		);
		// Nothing the unreadable candidate would have supplied is invented.
		// Release status, audience, call-to-action state, assets and inputs
		// have no value at all here, so they get no line rather than a
		// placeholder one.
		expect(exported).not.toMatch(/- Release status:/);
		expect(exported).not.toMatch(/- Audience:/);
		expect(exported).not.toMatch(/- Call to action:/);
		// And NOT the other-version qualifier, which the file carries whenever
		// the caveat block holds the candidate's metadata. Here it holds none.
		expect(exported).not.toMatch(/most recent generated version/i);
	});

	it("exports the bare body when neither version carries a note", async () => {
		// The floor this must not raise: with no readable candidate AND no
		// readable source there is nothing honest to say, so the body alone
		// with no caveat block is the right answer.
		const user = userEvent.setup();
		renderPanel({
			draft: readyDraft(UNREADABLE_CONTENT, "d2"),
			working: working({ sourceDraftId: "d1", sourceContent: null }),
		});

		await user.click(screen.getByRole("button", { name: /pdf/i }));

		expect(mutate.renderPdf.mock.calls[0][0]).toBe(BODY);
		expect(
			screen.queryByText(/what the draft wrote around/i),
		).not.toBeInTheDocument();
	});
});

describe("NewsletterBlurbPanel — what a viewer sees", () => {
	it("gives a viewer the draft, the claims and the asset list, and no controls", () => {
		renderPanel({
			draft: readyDraft(CLAMPED_DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
			canEdit: false,
		});

		// The saved draft, read-only. TWO, pinned rather than merely non-zero:
		// the read-only pane and the candidate pane are composed from the same
		// document and render the same paragraph, so `> 0` is satisfied by the
		// candidate alone — the whole read-only branch could be deleted and it
		// would stay green. The number was measured, not counted by hand.
		expect(
			screen.getAllByText(/duplicate deliveries used to page on-call/i),
		).toHaveLength(2);
		// The claims matter MORE to a reader than to an editor — they are the
		// one likeliest to paste this into a template addressed to a list.
		expect(
			screen.getByText(RELEASE_STATUS_LABELS.SHIPPED),
		).toBeInTheDocument();
		expect(screen.getByText(AUDIENCE_LABELS.CUSTOMER)).toBeInTheDocument();
		// The asset a viewer must not treat as cleared for use.
		expect(screen.getByText("Rollout timeline chart")).toBeInTheDocument();

		expect(
			screen.queryByRole("textbox", {
				name: /working newsletter blurb/i,
			}),
		).not.toBeInTheDocument();
		// The refine section's field, which the query above cannot reach: its
		// label is "Refine the saved draft", a different accessible name, and
		// the fixture's `hasBody: true` satisfies the second half of that
		// section's guard — so `canEdit` alone is holding it back.
		expect(
			screen.queryByRole("textbox", {
				name: /refine the saved draft/i,
			}),
		).not.toBeInTheDocument();
		// Per-name queries, not one alternation: `queryByRole` THROWS on
		// multiple matches rather than returning them, so a regression that
		// added a second matching button would surface as a
		// `TestingLibraryElementError` instead of this assertion's own message.
		//
		// `/refine draft/i` is its own entry and NOT covered by `/generate/i`:
		// the refine control's accessible name is "Refine draft", it fires a
		// real `generate.mutate({ refineFromWorkingDraft: true })`, and without
		// this line dropping `canEdit &&` from its section would hand a viewer
		// a working mutation control with the suite still green.
		for (const name of [
			/generate/i,
			/refine draft/i,
			/use this version/i,
			/save changes/i,
			/copy draft/i,
			/download/i,
		]) {
			expect(
				screen.queryByRole("button", { name }),
			).not.toBeInTheDocument();
		}
	});

	it("shows a viewer the SAVED text, not merely a copy of the candidate", () => {
		// The identity the count above cannot supply. With the default fixture
		// the saved body and the candidate body are the same string; giving the
		// saved draft its own sentence makes the read-only pane the only thing
		// on the page that can produce this match, so `getByText` — which
		// throws on more than one — pins it.
		renderPanel({
			draft: readyDraft(CLAMPED_DOCUMENT, "d2"),
			working: working({
				sourceDraftId: "d1",
				body: "The blurb as the team actually saved it.",
			}),
			canEdit: false,
		});

		expect(
			screen.getByText("The blurb as the team actually saved it."),
		).toBeInTheDocument();
	});
});
