import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Stakeholder Email generation panel (Fizzy #1854, Phase 2C-2).
 *
 * Assertions are on ROLES and TEXT, never on classes. What this panel owes a
 * reader is that the saved draft is editable, that an unadopted version is
 * offered rather than applied, that the controls a viewer must not have are
 * absent, and — the part this content type turns on — that the release state
 * the draft asserts is VISIBLE, on screen and in the file that leaves the app,
 * and is never presented as something Fabric verified. None of that is provable
 * from a class name.
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
			generateStakeholderEmail: mutate.generate,
			adoptStakeholderEmailDraft: mutate.adopt,
			saveStakeholderEmailBody: mutate.saveBody,
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
					generateStakeholderEmail: m("generateStakeholderEmail"),
					adoptStakeholderEmailDraft: m("adoptStakeholderEmailDraft"),
					saveStakeholderEmailBody: m("saveStakeholderEmailBody"),
				},
			},
		},
	};
});

/**
 * The renderers are stubbed, not exercised. jspdf and docx are dynamically
 * imported and produce binary — what this suite needs to know is the exact
 * STRING handed to them, because that string is the artefact that leaves the
 * app and the caveat block is the whole point of it.
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
 * format, which is what a reader actually reaches for.
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

import { StakeholderEmailPanel } from "@saas/projects/components/publishing-suite/StakeholderEmailPanel";

/** A finished email: a confirmed release state, an audience, nothing outstanding. */
const DOCUMENT = {
	subject: "Release lead time is down by half",
	body: "Hi team,\n\nWe cut release lead time from days to hours.\n\nThanks,\nDelivery",
	audience: "Internal leadership",
	releaseStatus: "SHIPPED",
	inputsNeeded: [],
	safetyNote: null,
};

/** The same update with every safety field in its cautious state. */
const UNCONFIRMED_DOCUMENT = {
	...DOCUMENT,
	releaseStatus: "UNCONFIRMED",
	audience: null,
	inputsNeeded: ["Confirm whether the rollout has completed"],
	safetyNote: "Generalized the customer reference.",
};

/**
 * Hedged but complete: the release state is KNOWN to be in progress, and the
 * email says so in its own prose.
 *
 * The document that separates "the draft could not establish a release state"
 * from "the draft established a non-shipped one" — an export that caveated both
 * would put a warning on most drafts, and one that caveated neither would hand
 * out a clean-looking file whose release state nobody ever confirmed.
 */
const IN_PROGRESS_DOCUMENT = {
	...DOCUMENT,
	releaseStatus: "IN_PROGRESS",
	body: "Hi team,\n\nWe're working on cutting release lead time.\n\nThanks,\nDelivery",
};

/** The sentence every safety surface carries when it describes other text. */
const OTHER_VERSION = /not the version this text was saved from/i;

const SAVED_AT = new Date("2026-09-01T12:00:00Z");
const BODY =
	"## Subject\n\nRelease lead time is down by half\n\n## Email Draft\n\nHi team,\n\nWe cut release lead time from days to hours.\n\nThanks,\nDelivery";

function readyDraft(content: unknown = DOCUMENT, id = "d1") {
	const row = {
		id,
		postType: "STAKEHOLDER_EMAIL" as const,
		version: 1,
		status: "READY",
		error: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		content,
	};
	return {
		postType: "STAKEHOLDER_EMAIL" as const,
		latestAttempt: row,
		latestReady: row,
	};
}

function working(over: Record<string, unknown> = {}) {
	return {
		postType: "STAKEHOLDER_EMAIL" as const,
		hasBody: true,
		body: BODY,
		sourceDraftId: "d1",
		sourceOptionLabel: null,
		updatedAt: SAVED_AT,
		...over,
	};
}

function renderPanel(over: Record<string, unknown> = {}) {
	return render(
		<StakeholderEmailPanel
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

/**
 * jsdom ships no clipboard, and `userEvent.setup()` installs a stub of its own
 * over whatever is there — so this has to run AFTER setup in every case that
 * cares, or the assertion lands on user-event's stub instead of the panel's
 * behaviour.
 */
function setClipboard(value: unknown) {
	Object.defineProperty(globalThis.navigator, "clipboard", {
		value,
		configurable: true,
		writable: true,
	});
}

/**
 * `userEvent.setup()` plus a clipboard this suite controls.
 *
 * The parameter is REQUIRED and has no default: `undefined` is one of the three
 * shapes under test ("this browser has no clipboard"), and a default value would
 * silently rewrite that case into the opposite one.
 */
function setupWithClipboard(clipboard: unknown) {
	const user = userEvent.setup();
	setClipboard(clipboard);
	return user;
}

/** The ordinary case: a clipboard that works. */
const workingClipboard = () => ({ writeText: mutate.writeText });

const editor = () =>
	screen.getByRole("textbox", { name: /working stakeholder email/i });

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

describe("StakeholderEmailPanel — the generate control", () => {
	it("offers Generate when nothing has been drafted", () => {
		renderPanel();

		expect(
			screen.getByRole("button", { name: /generate stakeholder email/i }),
		).toBeEnabled();
	});

	it("sends the guidance the reader typed", async () => {
		const user = userEvent.setup();
		renderPanel();

		await user.type(
			screen.getByLabelText(/guidance/i),
			"Address it to the steering group.",
		);
		await user.click(
			screen.getByRole("button", { name: /generate stakeholder email/i }),
		);

		expect(mutate.generate).toHaveBeenCalledWith(
			expect.objectContaining({
				topicId: "t1",
				guidance: "Address it to the steering group.",
			}),
		);
	});

	it("switches to Regenerate once a draft exists", () => {
		renderPanel({ draft: readyDraft() });

		expect(
			screen.getByRole("button", { name: /regenerate draft/i }),
		).toBeEnabled();
		expect(
			screen.getByText(
				/stakeholder email you have saved is not affected/i,
			),
		).toBeInTheDocument();
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
			screen.getByRole("button", { name: /generate stakeholder email/i }),
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
			screen.getByRole("button", { name: /generate stakeholder email/i }),
		).toBeDisabled();
		expect(screen.getByRole("status")).toHaveTextContent(/writing/i);
	});

	it("reports an unavailable generator as information, not an error", () => {
		renderPanel();

		captured.generateStakeholderEmail.onSuccess?.({
			started: false,
			reason: "unavailable",
		});

		expect(mutate.toastInfo).toHaveBeenCalled();
		expect(mutate.toastError).not.toHaveBeenCalled();
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

describe("StakeholderEmailPanel — the editor", () => {
	it("shows the saved draft in an editable field", () => {
		renderPanel({ working: working() });

		expect(editor()).toHaveValue(BODY);
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

		await user.clear(editor());
		await user.type(editor(), "Rewritten.");

		captured.saveStakeholderEmailBody.onError?.({ code: "CONFLICT" });

		expect(editor()).toHaveValue("Rewritten.");
		expect(mutate.invalidate).not.toHaveBeenCalled();
		expect(mutate.toastError).toHaveBeenCalledWith(
			expect.stringMatching(/your text is still here/i),
		);
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

describe("StakeholderEmailPanel — adopting a later version (FR34/FR35)", () => {
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

describe("StakeholderEmailPanel — the release status", () => {
	it("says so in WORDS when the release state was never established", () => {
		// Not a tint. A reader who cannot see colour must still learn that
		// nobody confirmed whether this shipped, which is the most consequential
		// fact about the draft on this content type.
		renderPanel({ draft: readyDraft(UNCONFIRMED_DOCUMENT, "d2") });

		expect(
			screen.getByText(/release status not confirmed/i),
		).toBeInTheDocument();
		expect(
			screen.getByText(/didn't say whether this work has\s+shipped/i),
		).toBeInTheDocument();
	});

	it("does not cry unconfirmed over a draft that established one", () => {
		// The negative half. Without it the case above passes on a build that
		// shows the banner unconditionally — and a banner on every draft is one
		// nobody reads.
		renderPanel({ draft: readyDraft(DOCUMENT, "d2") });

		expect(
			screen.queryByText(/release status not confirmed/i),
		).not.toBeInTheDocument();
	});

	it("does not cry unconfirmed over a correctly hedged in-progress draft", () => {
		// IN_PROGRESS is a KNOWN state, not a missing one, and the email's own
		// prose carries it. Warning here would be the over-warning that trains a
		// reader past the UNCONFIRMED banner that matters.
		renderPanel({ draft: readyDraft(IN_PROGRESS_DOCUMENT, "d2") });

		expect(
			screen.queryByText(/release status not confirmed/i),
		).not.toBeInTheDocument();
		expect(
			screen.getByText(/the work is underway, not finished/i),
		).toBeInTheDocument();
	});

	it("renders each release state in its own words", () => {
		for (const [status, phrase] of [
			["SHIPPED", /delivered and in use/i],
			["IN_PROGRESS", /underway, not finished/i],
			["PLANNED", /agreed but not started/i],
			["UPCOMING", /a release is close/i],
		] as const) {
			const view = render(
				<StakeholderEmailPanel
					projectId="p1"
					organizationId="org1"
					topicId="t1"
					draft={
						readyDraft(
							{ ...DOCUMENT, releaseStatus: status },
							"d2",
						) as never
					}
					working={null}
					canEdit={true}
				/>,
			);
			expect(screen.getByText(phrase)).toBeInTheDocument();
			view.unmount();
		}
	});

	it("attributes every status to the DRAFT, never to Fabric", () => {
		// The difference from the Case Study panel, and it is load-bearing.
		// `customerIdentity` and `metricsBasis` are clamped server-side against
		// the topic's own open approval threads, so that panel can say "Set by
		// Fabric". Nothing checks a release claim — Fabric stores no record of
		// what has shipped — so a reader told this was verified stops verifying
		// it, on the one content type that gets sent to a sponsor.
		renderPanel({ draft: readyDraft(DOCUMENT, "d2") });

		expect(
			screen.getByText(
				/the draft says the work is delivered and in use/i,
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				/nothing here was checked against a release record/i,
			),
		).toBeInTheDocument();
		expect(screen.queryByText(/set by Fabric/i)).not.toBeInTheDocument();
	});

	it("reads a garbled status as unconfirmed, never as shipped", () => {
		// `content` is a JSON column. A storage defect must not become a claim
		// that work is live.
		renderPanel({
			draft: readyDraft({ ...DOCUMENT, releaseStatus: "YES" }, "d2"),
		});

		expect(
			screen.getByText(/release status not confirmed/i),
		).toBeInTheDocument();
	});

	it("names the audience the draft wrote for", () => {
		renderPanel({ draft: readyDraft(DOCUMENT, "d2") });

		expect(
			screen.getByText(/written for Internal leadership/i),
		).toBeInTheDocument();
	});

	it("says the draft named no audience rather than inventing one", () => {
		// The schema lets `audience` be null on purpose: "no particular reader"
		// is the honest answer for a thin topic. A panel that filled the gap
		// would be inventing the one label a reader uses to decide whether the
		// email is safe to forward.
		renderPanel({ draft: readyDraft(UNCONFIRMED_DOCUMENT, "d2") });

		expect(
			screen.getByText(/doesn't name an audience/i),
		).toBeInTheDocument();
	});

	it("treats a whitespace-only audience as no audience", () => {
		renderPanel({
			draft: readyDraft({ ...DOCUMENT, audience: "   " }, "d2"),
		});

		expect(
			screen.getByText(/doesn't name an audience/i),
		).toBeInTheDocument();
	});

	it("drops a whitespace-only entry rather than drawing an empty bullet", () => {
		// `audience` above has always been trimmed to null; the LISTS were not
		// brought along, so an entry of spaces survived the type check and drew
		// a bullet with nothing in it. Worse on the export path, where the same
		// entry makes the draft count as unclean and prints a caveat line that
		// names no caveat.
		renderPanel({
			draft: readyDraft(
				{
					...UNCONFIRMED_DOCUMENT,
					inputsNeeded: ["   ", "Confirm the rollout completed"],
				},
				"d2",
			),
		});

		expect(
			screen.getByText(/confirm the rollout completed/i),
		).toBeInTheDocument();
		// One item rendered, not two: the blank one is gone, and the real one
		// is untouched. Asserting only the second would pass on a build that
		// dropped nothing.
		expect(screen.getAllByRole("listitem")).toHaveLength(1);
	});

	it("treats a whitespace-only safety note as no safety note", () => {
		renderPanel({
			draft: readyDraft({ ...DOCUMENT, safetyNote: "   " }, "d2"),
		});

		// A note of spaces is not a note. Rendering it puts a heading over a
		// blank line and makes an otherwise clean draft export a caveat block.
		expect(screen.queryByText(/safety note/i)).not.toBeInTheDocument();
	});

	it("shows the safety note and the inputs still needed", () => {
		renderPanel({ draft: readyDraft(UNCONFIRMED_DOCUMENT, "d2") });

		expect(
			screen.getByText(/generalized the customer reference/i),
		).toBeInTheDocument();
		expect(
			screen.getByText(/confirm whether the rollout has completed/i),
		).toBeInTheDocument();
	});

	it("degrades to an empty state on a document shape it cannot read", () => {
		// A panel that throws takes the whole Topic Item Page with it. A case
		// study document is the realistic instance: same table, `title` where
		// this reader wants `subject`.
		renderPanel({
			draft: readyDraft({ title: "A case study", body: "text" }),
		});

		expect(
			screen.getByText(/no stakeholder email draft yet/i),
		).toBeInTheDocument();
	});
});

describe("StakeholderEmailPanel — when the notes describe a different version", () => {
	/**
	 * `doc` is the latest READY generation; the editor, the copy button and the
	 * download all hold the WORKING draft. A regeneration nobody adopted makes
	 * those two different documents, and it is reachable without misuse — v1 is
	 * written while nothing says the work is live, so it reports UNCONFIRMED and
	 * hedges throughout; the release lands; a regeneration produces a v2 that
	 * honestly reports SHIPPED. The panel would then read "delivered and in use"
	 * over an email that carefully says nothing of the kind, and the amber
	 * banner disappears at the same moment.
	 */
	it("qualifies the release status when the editor holds other text", () => {
		renderPanel({
			draft: readyDraft(DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
		});

		// The status itself still reports v2 — it is not wrong, it is about
		// something else, and saying which is the whole fix.
		expect(
			screen.getByText(
				/the draft says the work is delivered and in use/i,
			),
		).toBeInTheDocument();
		expect(screen.getAllByText(OTHER_VERSION).length).toBeGreaterThan(0);
	});

	it("qualifies the unconfirmed banner and the inputs list, not only the status", () => {
		// Three surfaces. The banner matters most in the other direction: when
		// the newer version is NOT unconfirmed the amber block disappears
		// altogether while the text about to be sent was written under an
		// unknown release state, so the status qualifier is the only thing left
		// saying so.
		renderPanel({
			draft: readyDraft(UNCONFIRMED_DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
		});

		expect(screen.getAllByText(OTHER_VERSION)).toHaveLength(3);
	});

	it("stays quiet when the editor holds that very version", () => {
		// A caveat that fires on every draft is a caveat nobody reads.
		renderPanel({
			draft: readyDraft(DOCUMENT, "d1"),
			working: working({ sourceDraftId: "d1" }),
		});

		expect(screen.queryByText(OTHER_VERSION)).not.toBeInTheDocument();
	});

	it("stays quiet when there is no saved text for it to be about", () => {
		// "The version this text was saved from" names nothing when no working
		// draft exists, so the sentence would be false rather than cautious.
		renderPanel({ draft: readyDraft(UNCONFIRMED_DOCUMENT, "d2") });

		expect(screen.queryByText(OTHER_VERSION)).not.toBeInTheDocument();
	});
});

describe("StakeholderEmailPanel — copying the draft", () => {
	it("copies exactly the text the reader is looking at", async () => {
		const user = setupWithClipboard(workingClipboard());
		renderPanel({ draft: readyDraft(DOCUMENT, "d1"), working: working() });

		await user.click(
			screen.getByRole("button", {
				name: /copy draft to the clipboard/i,
			}),
		);

		expect(mutate.writeText).toHaveBeenCalledWith(BODY);
		expect(mutate.toastSuccess).toHaveBeenCalled();
	});

	it("does NOT prepend the download's caveats — the asymmetry is deliberate", async () => {
		// The two controls sit next to each other and egress the same draft, so
		// this has to be a decision rather than an oversight, and pinned as one:
		// the download suite below asserts the caveat block on this very
		// document. A download becomes a file that travels on its own, where a
		// copy lands in a buffer whose owner is looking at the unconfirmed
		// banner right now, and is usually pasted straight into a mail client.
		// Four lines the reader never saw appearing in a message they are about
		// to send is its own surprise, and it makes this button's contract —
		// "copies exactly what you are looking at" — false.
		const user = setupWithClipboard(workingClipboard());
		renderPanel({
			draft: readyDraft(UNCONFIRMED_DOCUMENT, "d1"),
			working: working(),
		});

		await user.click(
			screen.getByRole("button", {
				name: /copy draft to the clipboard/i,
			}),
		);

		expect(mutate.writeText).toHaveBeenCalledWith(BODY);
	});

	it("copies the UNSAVED edit, not the last thing the server returned", async () => {
		const user = setupWithClipboard(workingClipboard());
		renderPanel({ draft: readyDraft(DOCUMENT, "d1"), working: working() });

		await user.type(editor(), " extra");
		await user.click(
			screen.getByRole("button", {
				name: /copy draft to the clipboard/i,
			}),
		);

		expect(mutate.writeText).toHaveBeenCalledWith(`${BODY} extra`);
	});

	it("TELLS the reader when the clipboard is unreachable", async () => {
		// jsdom, an insecure origin and a denied permission all land here. A
		// silent no-op leaves them pasting whatever was on the clipboard before
		// and never learning the copy failed.
		const user = setupWithClipboard(undefined);
		renderPanel({ draft: readyDraft(DOCUMENT, "d1"), working: working() });

		await user.click(
			screen.getByRole("button", {
				name: /copy draft to the clipboard/i,
			}),
		);

		expect(mutate.toastError).toHaveBeenCalledWith(
			expect.stringMatching(/clipboard/i),
		);
		expect(mutate.toastSuccess).not.toHaveBeenCalled();
	});

	it("TELLS the reader when the clipboard write is refused", async () => {
		mutate.writeText.mockRejectedValue(new Error("NotAllowedError"));
		const user = setupWithClipboard(workingClipboard());
		renderPanel({ draft: readyDraft(DOCUMENT, "d1"), working: working() });

		await user.click(
			screen.getByRole("button", {
				name: /copy draft to the clipboard/i,
			}),
		);

		expect(mutate.toastError).toHaveBeenCalled();
		expect(mutate.toastSuccess).not.toHaveBeenCalled();
	});
});

describe("StakeholderEmailPanel — downloading the draft", () => {
	it("carries the caveats an unconfirmed draft cannot show in its body", async () => {
		// The whole reason this panel composes its own export. The safety fields
		// live OUTSIDE the editable body, so a naive export hands someone a
		// clean DOCX of an email whose release state nobody confirmed and that
		// is missing a fact — at exactly the moment the draft becomes an
		// attachment that gets forwarded.
		const user = userEvent.setup();
		renderPanel({
			draft: readyDraft(UNCONFIRMED_DOCUMENT, "d1"),
			working: working(),
		});

		await user.click(screen.getByRole("button", { name: /pdf/i }));

		const exported = mutate.renderPdf.mock.calls[0][0] as string;
		expect(exported).toContain("Draft caveats");
		expect(exported).toContain("didn't say whether this has shipped");
		expect(exported).toContain("the draft doesn't name one");
		expect(exported).toContain("Generalized the customer reference.");
		expect(exported).toContain("Confirm whether the rollout has completed");
		// And the draft itself is still in the file, below the caveats.
		expect(exported).toContain(BODY);
	});

	it("exports a clean draft with NO caveat block", async () => {
		// A caveat that fires on every draft is a caveat nobody reads.
		const user = userEvent.setup();
		renderPanel({
			draft: readyDraft(DOCUMENT, "d1"),
			working: working({ sourceDraftId: "d1" }),
		});

		await user.click(screen.getByRole("button", { name: /pdf/i }));

		expect(mutate.renderPdf).toHaveBeenCalledWith(BODY);
	});

	it("exports a correctly hedged in-progress draft clean too", async () => {
		// THE line the export draws. Only UNCONFIRMED is uncaveated-unsafe: the
		// other four release states are carried by the email's own prose, so a
		// reader of the file learns them from the sentence in front of them.
		// Caveating all five would put a warning on almost every export and
		// train the reader past the one that matters.
		const user = userEvent.setup();
		renderPanel({
			draft: readyDraft(IN_PROGRESS_DOCUMENT, "d1"),
			working: working({ sourceDraftId: "d1" }),
		});

		await user.click(screen.getByRole("button", { name: /pdf/i }));

		expect(mutate.renderPdf).toHaveBeenCalledWith(BODY);
	});

	it("says the notes describe a version this text did not come from", async () => {
		// Attaching the latest version's release status to text saved from an
		// earlier one, silently, is the under-warning the block exists to stop.
		const user = userEvent.setup();
		renderPanel({
			draft: readyDraft(DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
		});

		await user.click(screen.getByRole("button", { name: /pdf/i }));

		expect(mutate.renderPdf.mock.calls[0][0]).toContain(
			"not the version this text was saved from",
		);
	});

	it("offers all three formats and names each one", async () => {
		const user = userEvent.setup();
		renderPanel({
			draft: readyDraft(DOCUMENT, "d1"),
			working: working({ sourceDraftId: "d1" }),
		});

		await user.click(screen.getByRole("button", { name: /word/i }));

		expect(mutate.renderDocx).toHaveBeenCalledWith(BODY, DOCUMENT.subject);
		expect(mutate.triggerDownload).toHaveBeenCalledWith(
			expect.anything(),
			"release-lead-time-is-down-by-half.docx",
		);
	});

	it("names the question that is still open, in the file too", async () => {
		const user = userEvent.setup();
		renderPanel({
			draft: readyDraft(UNCONFIRMED_DOCUMENT, "d1"),
			working: working(),
		});

		await user.click(screen.getByRole("button", { name: /markdown/i }));

		const blob = mutate.triggerDownload.mock.calls[0][0] as Blob;
		await expect(blob.text()).resolves.toContain(
			"Still needed before sending",
		);
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

describe("StakeholderEmailPanel — what a viewer sees", () => {
	it("gives a viewer the draft and the release status, and no controls", () => {
		// PR2. The release status matters MORE to a reader than to an editor:
		// they are the one likeliest to forward it.
		renderPanel({
			draft: readyDraft(UNCONFIRMED_DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
			canEdit: false,
		});

		expect(
			screen.getByText(/release status not confirmed/i),
		).toBeInTheDocument();
		expect(
			screen.getAllByText(/We cut release lead time from days to hours/)
				.length,
		).toBeGreaterThan(0);

		expect(
			screen.queryByRole("textbox", {
				name: /working stakeholder email/i,
			}),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", {
				name: /generate|use this version|save changes|copy draft|download/i,
			}),
		).not.toBeInTheDocument();
	});
});
