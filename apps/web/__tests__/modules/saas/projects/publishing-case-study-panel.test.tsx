import { CASE_STUDY_CLAMP_REASON } from "@repo/utils/publishing-case-study-clamp";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Case Study generation panel (Fizzy #1854, Phase 2C-1).
 *
 * Assertions are on ROLES and TEXT, never on classes. What this panel owes a
 * reader is that the saved draft is editable, that an unadopted version is
 * offered rather than applied, that the controls a viewer must not have are
 * absent, and — the part no other panel has — that every approval-sensitive
 * fact about the draft is VISIBLE, on screen and in the file that leaves the
 * app. None of that is provable from a class name.
 */

const mutate = vi.hoisted(() => ({
	generate: vi.fn(),
	adopt: vi.fn(),
	saveBody: vi.fn(),
	refine: vi.fn(),
	acceptRefinement: vi.fn(),
	rejectRefinement: vi.fn(),
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

const noopMutate = vi.fn();

vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: mutate.invalidate }),
	useMutation: (
		opts: { mutationKey: string[] } & Record<string, Function>,
	) => {
		const key = opts.mutationKey[0];
		captured[key] = opts;
		const byKey: Record<string, ReturnType<typeof vi.fn>> = {
			generateCaseStudy: mutate.generate,
			adoptCaseStudyDraft: mutate.adopt,
			saveCaseStudyBody: mutate.saveBody,
			refineDraft: mutate.refine,
			acceptRefinement: mutate.acceptRefinement,
			rejectRefinement: mutate.rejectRefinement,
		};
		// The advisory draft lock fires two mutations this suite does not
		// assert on. A missing entry must be a no-op rather than `undefined`,
		// which the hook would then call.
		return {
			mutate: byKey[key] ?? noopMutate,
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
					generateCaseStudy: m("generateCaseStudy"),
					adoptCaseStudyDraft: m("adoptCaseStudyDraft"),
					saveCaseStudyBody: m("saveCaseStudyBody"),
					refineDraft: m("refineDraft"),
					acceptRefinement: m("acceptRefinement"),
					rejectRefinement: m("rejectRefinement"),
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

/**
 * The refinement review surface is STUBBED here on purpose.
 *
 * Its own behaviour — the diff it builds, the per-change accept/reject, the
 * null-on-serialization-failure contract — is pinned in
 * `publishing-refined-draft-review.test.tsx`. What this suite owes is the
 * WIRING around it: that a refined candidate opens a review at all, that
 * confirming writes the WORKING draft, and that rejecting writes nothing. A
 * stub also keeps the TipTap stack out of a panel suite with no use for it.
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

import { CaseStudyPanel } from "@saas/projects/components/publishing-suite/CaseStudyPanel";

/** A finished, fully-approved case study: nothing left to caveat. */
const DOCUMENT = {
	title: "Cutting release lead time at example-org",
	body: "## Executive summary\n\nRelease lead time fell from days to hours.",
	customerIdentity: "APPROVED",
	metricsBasis: "CONFIRMED",
	isScaffold: false,
	confirmedAssets: ["the deployment timeline chart"],
	assetsNeedingConfirmation: [],
	categories: ["Delivery"],
	keywords: ["lead-time"],
	inputsNeeded: [],
	safetyNote: null,
	generation: { clamped: {} },
};

/** The same story with every safety field in its cautious state. */
const SCAFFOLD_DOCUMENT = {
	...DOCUMENT,
	isScaffold: true,
	customerIdentity: "ANONYMIZED",
	metricsBasis: "QUALITATIVE",
	assetsNeedingConfirmation: ["the architecture diagram"],
	inputsNeeded: ["Adoption numbers for the rollout"],
	safetyNote: "Generalized the customer reference.",
};

/**
 * A draft whose claims the ACTIVITY lowered against unresolved approvals.
 *
 * Built FROM `CASE_STUDY_CLAMP_REASON` rather than by restating its values.
 * The panel decides whether to show the clamp note by comparing the stored
 * reason against that constant, and an unrecognised reason reads as "not
 * clamped" — so a fixture with its own copy of the strings would keep passing
 * after a rename that made the warning vanish in production. This is the only
 * place either side of the package boundary is exercised at all.
 */
const CLAMPED_DOCUMENT = {
	...DOCUMENT,
	customerIdentity: "APPROVAL_NEEDED",
	metricsBasis: "PLACEHOLDER",
	confirmedAssets: [],
	assetsNeedingConfirmation: ["the customer logo"],
	generation: {
		clamped: {
			customerIdentity: CASE_STUDY_CLAMP_REASON.customerIdentity,
			metricsBasis: CASE_STUDY_CLAMP_REASON.metricsBasis,
			assets: ["the customer logo"],
		},
	},
};

/**
 * Clean on every other axis, with ONE disputed asset still sitting in the
 * cleared list and nothing in the needs-confirmation list.
 *
 * Today's activity moves a clamped asset across as it records the clamp, so the
 * two are non-empty together — but that coupling lives in another package, and
 * an export whose "is this clean" test reads only the needs-confirmation list
 * would hand out a caveat-free file for this document.
 */
const CLAMPED_ASSET_ONLY_DOCUMENT = {
	...DOCUMENT,
	confirmedAssets: ["the customer logo"],
	assetsNeedingConfirmation: [],
	generation: { clamped: { assets: ["the customer logo"] } },
};

/** The sentence every safety surface carries when it describes other text. */
const OTHER_VERSION = /not the version this text was saved from/i;

const SAVED_AT = new Date("2026-09-01T12:00:00Z");
const BODY =
	"# Cutting release lead time at example-org\n\n## Executive summary\n\nRelease lead time fell from days to hours.";

function readyDraft(content: unknown = DOCUMENT, id = "d1") {
	const row = {
		id,
		postType: "CASE_STUDY" as const,
		version: 1,
		status: "READY",
		error: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		content,
	};
	return {
		postType: "CASE_STUDY" as const,
		latestAttempt: row,
		latestReady: row,
	};
}

function working(over: Record<string, unknown> = {}) {
	return {
		postType: "CASE_STUDY" as const,
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
		<CaseStudyPanel
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
 * behaviour. Every environment shape has to be reachable: present, absent, and
 * present-but-refusing.
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
	screen.getByRole("textbox", { name: /working case study/i });

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

describe("CaseStudyPanel — the generate control", () => {
	it("says who else is in the draft, and still lets you edit it", async () => {
		// `PublishingTopicWorkingDraft` is unique on (topicId, postType): one
		// draft per content type for the WHOLE topic, not one per author. Two
		// people editing was a real collision whose only signal was a CONFLICT
		// toast on save -- after the words were typed.
		//
		// ADVISORY. It reports the holder so the second person can decide; the
		// compare-and-set on save stays what actually protects the text, and
		// take-over is never destructive because every earlier body is in the
		// version list.
		const user = userEvent.setup();
		renderPanel({ draft: readyDraft(DOCUMENT), working: working() });

		// Claimed only once the draft actually goes dirty: opening a topic to
		// read it is not editing it.
		expect(mutate.invalidate).not.toHaveBeenCalledWith(
			expect.objectContaining({ claimed: true }),
		);

		await user.type(
			screen.getByRole("textbox", { name: /case study/i }),
			"!",
		);

		captured.claimDraftLock?.onSuccess?.({
			status: "held",
			expiresAt: new Date(),
			heldBy: { id: "u2", name: "Ana" },
		});

		expect(
			await screen.findByTestId("draft-edit-lock"),
		).toBeInTheDocument();
		expect(screen.getByText(/ana is editing this draft/i)).toBeVisible();
		// Still editable — the lock never refuses a write.
		expect(
			screen.getByRole("textbox", { name: /case study/i }),
		).toBeEnabled();
	});

	it("offers Generate when nothing has been drafted", () => {
		renderPanel();

		expect(
			screen.getByRole("button", { name: /generate case study/i }),
		).toBeEnabled();
	});

	it("sends the guidance the reader typed", async () => {
		const user = userEvent.setup();
		renderPanel();

		await user.type(
			screen.getByLabelText(/guidance/i),
			"Lead with the deploy frequency.",
		);
		await user.click(
			screen.getByRole("button", { name: /generate case study/i }),
		);

		expect(mutate.generate).toHaveBeenCalledWith(
			expect.objectContaining({
				topicId: "t1",
				guidance: "Lead with the deploy frequency.",
			}),
		);
	});

	it("switches to Regenerate once a draft exists", async () => {
		// The promise that a regeneration leaves saved work alone moved
		// INTO the popover with the field it qualifies: it is read at the
		// moment of deciding, not as a standing paragraph about an action
		// nobody has taken yet.
		const user = userEvent.setup();
		renderPanel({ draft: readyDraft() });

		const trigger = screen.getByRole("button", {
			name: /regenerate draft/i,
		});
		expect(trigger).toBeEnabled();

		await user.click(trigger);

		expect(
			within(await screen.findByRole("dialog")).getByText(
				/case study you have saved is not affected/i,
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
			screen.getByRole("button", { name: /generate case study/i }),
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
			screen.getByRole("button", { name: /generate case study/i }),
		).toBeDisabled();
		expect(screen.getByRole("status")).toHaveTextContent(/writing/i);
	});

	it("reports an unavailable generator as information, not an error", () => {
		renderPanel();

		captured.generateCaseStudy.onSuccess?.({
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

	it("collapses guidance behind the button once a draft exists", async () => {
		// The field is not merely moved, it is PUT AWAY. Above the draft it was
		// an input asking to be filled in before every regeneration; the common
		// case is regenerating with nothing more to say, and the field charged
		// that case a permanent box over the content it acts on.
		const user = userEvent.setup();
		renderPanel({ draft: readyDraft() });

		expect(screen.queryByLabelText(/guidance/i)).not.toBeInTheDocument();

		await user.click(
			screen.getByRole("button", { name: /regenerate draft/i }),
		);

		expect(
			within(await screen.findByRole("dialog")).getByLabelText(
				/guidance/i,
			),
		).toBeInTheDocument();
	});

	it("keeps the guidance field on the page before the first run", () => {
		// With no draft on screen there is nothing for the button to sit on,
		// and someone who has never run this tab should be shown what steers it
		// rather than have to find it behind a popover.
		renderPanel();

		expect(screen.getByLabelText(/guidance/i)).toBeInTheDocument();
	});
});

describe("CaseStudyPanel — the editor", () => {
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

		captured.saveCaseStudyBody.onError?.({ code: "CONFLICT" });

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

describe("CaseStudyPanel — adopting a later version (FR34/FR35)", () => {
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

describe("CaseStudyPanel — the approval-sensitive fields", () => {
	it("says so in WORDS when the draft is a scaffold", () => {
		// Not a tint. A reader who cannot see colour must still learn that this
		// is an outline, which is the most consequential fact about the draft.
		renderPanel({ draft: readyDraft(SCAFFOLD_DOCUMENT, "d2") });

		expect(screen.getByText(/scaffold draft/i)).toBeInTheDocument();
		expect(
			screen.getByText(/outline with placeholders/i),
		).toBeInTheDocument();
	});

	it("does not cry scaffold over a finished draft", () => {
		renderPanel({ draft: readyDraft(DOCUMENT, "d2") });

		expect(screen.queryByText(/scaffold draft/i)).not.toBeInTheDocument();
	});

	it("renders a CLAMPED status differently from one the draft claimed", () => {
		// THE case for this panel. The activity lowers an APPROVED identity or a
		// CONFIRMED metrics basis against an unresolved approval thread and
		// records which question did it. This is the ONLY reader of that record —
		// without it the clamp is write-only telemetry, and nobody can tell a
		// model that complied with the locked clause from one that ignored it.
		renderPanel({ draft: readyDraft(CLAMPED_DOCUMENT, "d2") });

		expect(
			screen.getByText(
				/approval needed before the customer can be named/i,
			),
		).toHaveTextContent(
			/set by Fabric from an unresolved approval thread/i,
		);
		expect(screen.getByText(/placeholder figures/i)).toHaveTextContent(
			/set by Fabric from an unresolved approval thread/i,
		);
	});

	it("does not claim Fabric set a status the draft chose for itself", () => {
		// The negative half. Without it the case above passes on a build that
		// prints the clamp note unconditionally.
		renderPanel({ draft: readyDraft(DOCUMENT, "d2") });

		expect(screen.getByText(/named with approval/i)).toBeInTheDocument();
		expect(
			screen.queryByText(
				/set by Fabric from an unresolved approval thread/i,
			),
		).not.toBeInTheDocument();
	});

	it("reads a garbled status as the cautious value, never as approved", () => {
		// `content` is a JSON column. A storage defect must not become a claim
		// that a customer approved being named.
		renderPanel({
			draft: readyDraft(
				{ ...DOCUMENT, customerIdentity: "YES", metricsBasis: 7 },
				"d2",
			),
		});

		expect(
			screen.getByText(
				/approval needed before the customer can be named/i,
			),
		).toBeInTheDocument();
		expect(screen.getByText(/placeholder figures/i)).toBeInTheDocument();
	});

	it("keeps the two asset lists apart, in words as well as in layout", () => {
		renderPanel({ draft: readyDraft(SCAFFOLD_DOCUMENT, "d2") });

		expect(screen.getByText(/assets cleared for use/i)).toBeInTheDocument();
		expect(
			screen.getByText(/assets awaiting confirmation/i),
		).toBeInTheDocument();
		expect(
			screen.getByText("the deployment timeline chart"),
		).toBeInTheDocument();
		expect(
			screen.getByText("the architecture diagram"),
		).toBeInTheDocument();
	});

	it("does not call a cleared asset safe to publish", () => {
		// The list is the MODEL's account of the source material — nothing
		// consulted an approval record to build it, and the two enum fields
		// beside it are at least clamped against unresolved threads while this is
		// not. A reader told "safe to publish" stops checking, which is the one
		// behaviour this list must not cause.
		renderPanel({ draft: readyDraft(SCAFFOLD_DOCUMENT, "d2") });

		expect(screen.getByText(/not an approval record/i)).toBeInTheDocument();
		expect(
			screen.queryByText(/safe to publish with the draft/i),
		).not.toBeInTheDocument();
	});

	it("names the assets Fabric took OFF the cleared list", () => {
		// Without this, an asset the model was merely unsure about and one an
		// unresolved approval thread contradicts are the same line — and only the
		// second says the draft claimed something it should not have.
		renderPanel({ draft: readyDraft(CLAMPED_DOCUMENT, "d2") });

		expect(
			screen.getByText(
				/moved out of the cleared list by Fabric, from an unresolved approval thread/i,
			),
		).toHaveTextContent("the customer logo");
	});

	it("does not say Fabric moved an asset the draft placed itself", () => {
		// The negative half: without it the case above passes on a build that
		// prints the note whenever the needs-confirmation list is non-empty.
		renderPanel({ draft: readyDraft(SCAFFOLD_DOCUMENT, "d2") });

		expect(
			screen.getByText("the architecture diagram"),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/moved out of the cleared list by Fabric/i),
		).not.toBeInTheDocument();
	});

	it("degrades to an empty state on a document shape it cannot read", () => {
		// A panel that throws takes the whole Topic Item Page with it.
		renderPanel({ draft: readyDraft({ options: [{ label: "Direct" }] }) });

		expect(
			screen.getByText(/no case study draft yet/i),
		).toBeInTheDocument();
	});
});

describe("CaseStudyPanel — when the notes describe a different version", () => {
	/**
	 * `doc` is the latest READY generation; the editor, the copy button and the
	 * download all hold the WORKING draft. A regeneration nobody adopted makes
	 * those two different documents, and every one of these cases is reachable
	 * without misuse — an unresolved customer-name question clamps v1's LABEL
	 * while v1's prose still names the customer, the question is answered "we
	 * are not naming them" and closed, and the unclamped v2 honestly reports
	 * APPROVED.
	 */
	it("qualifies the approval status when the editor holds other text", () => {
		renderPanel({
			draft: readyDraft(DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
		});

		// The status itself still reports v2 — it is not wrong, it is about
		// something else, and saying which is the whole fix.
		expect(screen.getByText(/named with approval/i)).toBeInTheDocument();
		expect(screen.getAllByText(OTHER_VERSION).length).toBeGreaterThan(0);
	});

	it("qualifies the scaffold banner and the inputs list, not only the status", () => {
		// Three surfaces, and the scaffold one matters most in the other
		// direction: when the newer version is NOT a scaffold the amber banner
		// disappears altogether while the text about to be shared still is one,
		// so the status qualifier is the only thing left saying so.
		renderPanel({
			draft: readyDraft(SCAFFOLD_DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
		});

		// THREE. It was four until the inputs-needed list left the panel;
		// the safety note, added in A6, keeps the count above the two this
		// test was originally written for. A count rather than a floor, so a
		// surface that silently loses its qualifier still fails here.
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
		renderPanel({ draft: readyDraft(SCAFFOLD_DOCUMENT, "d2") });

		expect(screen.queryByText(OTHER_VERSION)).not.toBeInTheDocument();
	});
});

describe("CaseStudyPanel — copying the draft", () => {
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
		// copy lands in a buffer whose owner is looking at the scaffold banner
		// and the approval status right now, and is usually pasted back into an
		// editor mid-sentence. Text the reader never saw appearing in their
		// clipboard is its own surprise, and it makes this button's contract —
		// "copies exactly what you are looking at" — false.
		const user = setupWithClipboard(workingClipboard());
		renderPanel({
			draft: readyDraft(SCAFFOLD_DOCUMENT, "d1"),
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

describe("CaseStudyPanel — downloading the draft", () => {
	it("carries the caveats a scaffold draft cannot show in its body", async () => {
		// The whole reason this panel composes its own export. The safety fields
		// live OUTSIDE the editable body, so a naive export hands someone a clean
		// PDF of a draft that is a scaffold, whose customer identity is still
		// awaiting approval, and that is missing three proof points — at exactly
		// the moment the draft becomes an email attachment.
		const user = userEvent.setup();
		renderPanel({
			draft: readyDraft(SCAFFOLD_DOCUMENT, "d1"),
			working: working(),
		});

		await user.click(screen.getByRole("button", { name: /pdf/i }));

		const exported = mutate.renderPdf.mock.calls[0][0] as string;
		expect(exported).toContain("Draft caveats");
		expect(exported).toContain("scaffold");
		expect(exported).toContain(
			"Anonymized — the draft does not name the customer.",
		);
		expect(exported).toContain(
			"Described qualitatively — the draft claims no figures.",
		);
		expect(exported).toContain("Generalized the customer reference.");
		expect(exported).toContain("the architecture diagram");
		expect(exported).toContain("Adoption numbers for the rollout");
		// And the draft itself is still in the file, below the caveats.
		expect(exported).toContain(BODY);
	});

	it("drops whitespace-only list entries rather than drawing empty bullets", () => {
		// The reader type-checked list items but did not trim them, so an entry
		// of spaces survived and drew a bullet with nothing in it — and, since
		// a non-empty `inputsNeeded` makes a draft count as unclean, printed a
		// caveat line naming no caveat. The schema now rejects such an entry at
		// write time; this covers the rows written before it did.
		renderPanel({
			draft: readyDraft(
				{
					...SCAFFOLD_DOCUMENT,
					assetsNeedingConfirmation: [
						"\t\n",
						"the architecture diagram",
					],
				},
				"d2",
			),
		});

		expect(
			screen.getByText(/the architecture diagram/i),
		).toBeInTheDocument();
		// The real entries survive untouched and the blanks are gone. Asserting
		// only the survivors would pass on a build that dropped nothing.
		for (const item of screen.getAllByRole("listitem")) {
			expect(item.textContent?.trim()).not.toBe("");
		}
	});

	it("names the question that lowered a claim, in the file too", async () => {
		const user = userEvent.setup();
		renderPanel({
			draft: readyDraft(CLAMPED_DOCUMENT, "d1"),
			working: working(),
		});

		await user.click(screen.getByRole("button", { name: /markdown/i }));

		const blob = mutate.triggerDownload.mock.calls[0][0] as Blob;
		await expect(blob.text()).resolves.toContain(
			"Set by Fabric from an unresolved approval thread",
		);
	});

	it("caveats a disputed asset still sitting in the cleared list", async () => {
		// Everything else about this document is clean and the
		// needs-confirmation list is EMPTY, so an export whose "is this clean"
		// test read only that list would hand out a caveat-free file with an
		// asset an unresolved approval thread contradicts presented as cleared.
		const user = userEvent.setup();
		renderPanel({
			draft: readyDraft(CLAMPED_ASSET_ONLY_DOCUMENT, "d1"),
			working: working({ sourceDraftId: "d1" }),
		});

		await user.click(screen.getByRole("button", { name: /pdf/i }));

		const exported = mutate.renderPdf.mock.calls[0][0] as string;
		expect(exported).toContain("Draft caveats");
		expect(exported).toContain(
			"Moved out of the cleared list by Fabric, from an unresolved approval thread",
		);
		expect(exported).toContain("the customer logo");
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

	it("says the notes describe a version this text did not come from", async () => {
		// Attaching the latest version's safety notes to text saved from an
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

		expect(mutate.renderDocx).toHaveBeenCalledWith(BODY, DOCUMENT.title);
		expect(mutate.triggerDownload).toHaveBeenCalledWith(
			expect.anything(),
			"cutting-release-lead-time-at-example-org.docx",
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

describe("CaseStudyPanel — what a viewer sees", () => {
	it("gives a viewer the draft and the approval status, and no controls", () => {
		// PR2. The status matters MORE to a reader than to an editor: they are
		// the one likeliest to forward it.
		renderPanel({
			draft: readyDraft(SCAFFOLD_DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
			canEdit: false,
		});

		expect(screen.getByText(/scaffold draft/i)).toBeInTheDocument();
		expect(
			screen.getByText(
				/anonymized — the draft does not name the customer/i,
			),
		).toBeInTheDocument();
		expect(
			screen.getAllByText(/Release lead time fell from days to hours/)
				.length,
		).toBeGreaterThan(0);

		expect(
			screen.queryByRole("textbox", { name: /working case study/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", {
				name: /generate|use this version|save changes|copy draft|download/i,
			}),
		).not.toBeInTheDocument();
	});
});

describe("CaseStudyPanel — refining the saved draft (Fizzy #1851, A7)", () => {
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
		renderPanel({ working: { ...working(), hasBody: false, body: "" } });

		expect(
			screen.queryByRole("button", { name: /refine with ai/i }),
		).not.toBeInTheDocument();
	});

	it("offers refine ALONGSIDE regenerate once a draft is saved", () => {
		// A second action, not a replacement: the two answer different
		// questions and both stay reachable.
		renderPanel({ draft: readyDraft(), working: working() });

		expect(
			screen.getByRole("button", { name: /refine with ai/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /regenerate draft/i }),
		).toBeEnabled();
	});

	it("keeps refine disabled until an instruction is written", async () => {
		const user = userEvent.setup();
		renderPanel({ working: working() });

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
		const user = userEvent.setup();
		renderPanel({ working: working() });

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
			postType: "CASE_STUDY",
			instruction: "Warmer tone.",
		});
		expect(mutate.generate).not.toHaveBeenCalled();
	});

	it("keeps the refine instruction OUT of a regeneration", async () => {
		// Two fields because they ask for different things. A shared one would
		// carry "make it shorter" into a run that has nothing to shorten.
		const user = userEvent.setup();
		renderPanel({ draft: readyDraft(), working: working() });

		const refine = await openRefine(user);
		await user.type(
			refine.getByRole("textbox", { name: /refine the saved draft/i }),
			"Warmer tone.",
		);
		await user.keyboard("{Escape}");

		await user.click(
			screen.getByRole("button", { name: /regenerate draft/i }),
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
		const user = userEvent.setup();
		renderPanel({ working: working() });

		const popover = await openRefine(user);

		expect(
			popover.getByText(
				/nothing you have saved changes until you accept it/i,
			),
		).toBeInTheDocument();
	});

	it("gives a viewer no refine control", () => {
		renderPanel({ working: working(), canEdit: false });

		expect(
			screen.queryByRole("button", { name: /refine with ai/i }),
		).not.toBeInTheDocument();
	});
});

describe("CaseStudyPanel — the saved draft beside the candidate (Fizzy #1851, A6)", () => {
	it("puts both texts on screen at once, each labelled for what it is", () => {
		renderPanel({
			draft: readyDraft(DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
		});

		expect(
			screen.getByRole("textbox", { name: /working case study/i }),
		).toHaveValue(BODY);
		// Scoped to the candidate's own region, and matched by regex: the
		// saved body contains the candidate's text verbatim, and the default
		// matcher normalizes the node's whitespace but not the string it is
		// compared against.
		const candidateHeading = screen.getByRole("heading", {
			name: /new candidate \(version 1\)/i,
		});
		const candidate = candidateHeading.closest("section") as HTMLElement;
		expect(
			within(candidate).getByText(/## Executive summary/),
		).toBeInTheDocument();
		expect(
			screen.getByText(/saved\. this is the case study the topic holds/i),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				/not saved\. adopting it replaces your saved draft/i,
			),
		).toBeInTheDocument();
	});

	it("keeps the export controls with the draft they actually send", () => {
		// The copy and download controls egress the WORKING body, never the
		// candidate. Putting the two texts side by side is only safe while
		// they stay in the saved column.
		renderPanel({
			draft: readyDraft(DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
		});

		const editor = screen.getByRole("textbox", {
			name: /working case study/i,
		});
		const savedColumn = editor.closest("section");

		expect(
			savedColumn?.contains(
				screen.getByRole("button", { name: /copy draft/i }),
			),
		).toBe(true);
		expect(
			savedColumn?.contains(
				screen.getByRole("button", { name: /use this version/i }),
			),
		).toBe(false);
	});
});

describe("CaseStudyPanel — whose draft the generalization note describes (A6)", () => {
	/**
	 * Scoped to the generalization section, because this panel's scaffold
	 * banner, approval-status table and inputs-needed list carry the SAME
	 * sentence when the condition holds — an unscoped query would pass on a
	 * build where the note itself was never qualified.
	 */
	const QUALIFIER = /these notes describe the most recent generated version/i;

	function generalizationSection() {
		const heading = screen.getByRole("heading", {
			name: /how this was generalized/i,
		});
		// `details`, not `section`: the note collapses now, and the disclosure
		// IS its container. It is rendered open in these cases on purpose —
		// a warning about the text on screen behind a disclosure is not a
		// warning.
		return heading.closest("details") as HTMLElement;
	}

	it("says so when a regeneration the reader has not adopted exists", () => {
		renderPanel({
			draft: readyDraft(SCAFFOLD_DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
		});

		expect(
			within(generalizationSection()).getByText(QUALIFIER),
		).toBeInTheDocument();
	});

	it("stays quiet when the saved draft came from the latest version", () => {
		renderPanel({
			draft: readyDraft(SCAFFOLD_DOCUMENT, "d1"),
			working: working({ sourceDraftId: "d1" }),
		});

		expect(
			within(generalizationSection()).queryByText(QUALIFIER),
		).not.toBeInTheDocument();
	});
});

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
describe("CaseStudyPanel — the assistant boundary", () => {
	it("says which AI edits this draft and which one does not", () => {
		renderPanel({ draft: readyDraft(), working: working() as never });

		expect(
			screen.getByText(
				/refine with ai is what edits this case study .* the ai assistant works on the planning analysis, not on drafts/i,
			),
		).toBeInTheDocument();
	});

	it("keeps it out of a viewer's panel", () => {
		// It names two editing affordances, and a reader has neither.
		renderPanel({
			draft: readyDraft(),
			working: working() as never,
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
describe("CaseStudyPanel — reviewing a refinement proposal", () => {
	const PROPOSED = "The team cut CI from 14 minutes to 4. It stuck.";
	const SAVED = new Date("2026-09-01T12:00:00Z");

	const saved = {
		postType: "CASE_STUDY" as const,
		hasBody: true,
		body: "The team cut CI from 14 minutes to 4.",
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
			postType: "CASE_STUDY",
			// The working draft's `updatedAt`, never the proposal's own — the
			// server compare-and-sets against the row it is replacing.
			expectedUpdatedAt: SAVED,
			// The REVIEWED text, which after per-change accepts and rejects is
			// usually neither the saved draft nor the whole proposal. The
			// server writes this in place of the proposal it stored.
			body: "Merged review text.",
		});
		expect(mutate.saveBody).not.toHaveBeenCalled();
		expect(mutate.adopt).not.toHaveBeenCalled();
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
			postType: "CASE_STUDY",
		});
		expect(mutate.acceptRefinement).not.toHaveBeenCalled();
		expect(mutate.saveBody).not.toHaveBeenCalled();
		expect(mutate.adopt).not.toHaveBeenCalled();
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
			screen.getByRole("textbox", { name: /working case study/i }),
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
describe("CaseStudyPanel — the refine pending state", () => {
	const saved = {
		postType: "CASE_STUDY" as const,
		hasBody: true,
		body: "The team cut CI from 14 minutes to 4.",
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
			/revising your saved case study/i,
		);
	});

	it("reports the press itself, before the read has caught up", () => {
		// Between the claim landing and the next read there is nothing on the
		// topic to show — which is exactly the window the complaint was about.
		pending.refineDraft = true;
		renderPanel({ working: saved });

		expect(screen.getByRole("status")).toHaveTextContent(
			/revising your saved case study/i,
		);
	});
});
