import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Webinar / Demo Script generation panel (Fizzy #1988, Phase 2D-1).
 *
 * Assertions are on ROLES and TEXT, never on classes. What this panel owes a
 * reader is the same as its Case Study and Stakeholder Email siblings — a
 * saved draft that is editable, an unadopted version offered rather than
 * applied, absent controls for a viewer — plus what is new on this content
 * type: the six-value release-status map in the draft's own words, whether
 * the demo flow is a scaffold, whether the org's own prompt was actually used,
 * and which suggested asset Fabric moved out of the confirmed list and why.
 * None of that is provable from a class name.
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
			generateWebinarScript: mutate.generate,
			adoptWebinarScriptDraft: mutate.adopt,
			saveWebinarScriptBody: mutate.saveBody,
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
					generateWebinarScript: m("generateWebinarScript"),
					adoptWebinarScriptDraft: m("adoptWebinarScriptDraft"),
					saveWebinarScriptBody: m("saveWebinarScriptBody"),
				},
			},
		},
	};
});

/**
 * The renderers are stubbed, not exercised — same reasoning as the Case Study
 * and Stakeholder Email suites: jspdf and docx are dynamically imported and
 * produce binary, and what this suite needs to know is the exact STRING
 * handed to them, since that string is the artefact the clamp attribution and
 * the scaffold/release lines have to survive into.
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

import { composeWebinarScriptWorkingDraftBody } from "@repo/utils/publishing-webinar-script-body";
import { WebinarScriptPanel } from "@saas/projects/components/publishing-suite/WebinarScriptPanel";

/** A finished script: a confirmed release, one demo step, nothing outstanding. */
const DOCUMENT = {
	title: "From flaky retries to a bounded budget",
	sessionPurpose:
		"Show prospects how the retry budget update cuts duplicate deliveries.",
	recommendedAudience:
		"Platform engineering leads evaluating reliability tooling.",
	suggestedLength: "30 minutes",
	presenterNotes: null,
	openingTalkTrack:
		"Today I want to show you how we cut duplicate deliveries in half.",
	agenda: ["Why retries were flaky", "The bounded budget", "Live demo"],
	keyMessage:
		"A bounded retry budget turns duplicate deliveries into a solved problem.",
	demoFlow: [
		{
			name: "Trigger a retry",
			whatToShow: "The dashboard showing a retry in flight.",
			talkTrack: "Watch what happens when a delivery times out.",
			audienceTakeaway:
				"Retries now respect a budget instead of running forever.",
		},
	],
	supportingDetails: {
		problem: "Duplicate deliveries were paging on-call every week.",
		solution: "A bounded retry budget with jittered backoff.",
	},
	suggestedAssets: {
		confirmed: ["Retry budget dashboard screenshot"],
		needsConfirmation: [],
	},
	closingTalkTrack: "That's the retry budget — questions?",
	suggestedCta: "Book a follow-up to walk through your own retry policy.",
	releaseStatus: "SHIPPED",
	inputsNeeded: [],
	safetyNote: null,
	isScaffold: false,
	generation: {
		promptSource: "BOUND",
		clamped: {},
	},
};

/** No demo flow at all — the scaffold case, spec's own definition of one. */
const SCAFFOLD_DOCUMENT = {
	...DOCUMENT,
	demoFlow: [],
	isScaffold: true,
	inputsNeeded: ["A demo flow was not available from the topic context."],
};

/** Nothing in the source material said whether this shipped. */
const UNCONFIRMED_DOCUMENT = {
	...DOCUMENT,
	releaseStatus: "UNCONFIRMED",
	safetyNote: "Left the release date out, since nothing confirmed one.",
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
 * this is the fixture that proves `WebinarScriptPanel` actually reads
 * `assetKinds` to render the clamp attribution, not just `assets`.
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
	subject: "This is a stakeholder email, not a webinar script",
	body: "Wrong shape entirely.",
};

const BODY = composeWebinarScriptWorkingDraftBody(DOCUMENT as never);
const SAVED_AT = new Date("2026-09-01T12:00:00Z");

function readyDraft(content: unknown = DOCUMENT, id = "d1") {
	const row = {
		id,
		postType: "WEBINAR_SCRIPT" as const,
		version: 1,
		status: "READY",
		error: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		content,
	};
	return {
		postType: "WEBINAR_SCRIPT" as const,
		latestAttempt: row,
		latestReady: row,
	};
}

function working(over: Record<string, unknown> = {}) {
	return {
		postType: "WEBINAR_SCRIPT" as const,
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
		<WebinarScriptPanel
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
 * jsdom ships no clipboard, and `userEvent.setup()` installs a stub of its
 * own over whatever is there — so this has to run AFTER setup in every case
 * that cares, or the assertion lands on user-event's stub.
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
	screen.getByRole("textbox", { name: /working webinar script/i });

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

describe("WebinarScriptPanel — the generate control", () => {
	it("offers Generate when nothing has been drafted", () => {
		renderPanel();

		expect(
			screen.getByRole("button", { name: /generate webinar script/i }),
		).toBeEnabled();
	});

	it("sends the guidance the reader typed", async () => {
		const user = userEvent.setup();
		renderPanel();

		await user.type(
			screen.getByLabelText(/guidance/i),
			"Keep the demo under ten minutes.",
		);
		await user.click(
			screen.getByRole("button", { name: /generate webinar script/i }),
		);

		expect(mutate.generate).toHaveBeenCalledWith(
			expect.objectContaining({
				topicId: "t1",
				guidance: "Keep the demo under ten minutes.",
			}),
		);
	});

	it("switches to Regenerate once a draft exists", () => {
		renderPanel({ draft: readyDraft() });

		expect(
			screen.getByRole("button", { name: /regenerate draft/i }),
		).toBeEnabled();
		expect(
			screen.getByText(/webinar script you have saved is not affected/i),
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
			screen.getByRole("button", { name: /generate webinar script/i }),
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
			screen.getByRole("button", { name: /generate webinar script/i }),
		).toBeDisabled();
		expect(screen.getByRole("status")).toHaveTextContent(/writing/i);
	});

	it("reports an unavailable generator as information, not an error", () => {
		renderPanel();

		captured.generateWebinarScript.onSuccess?.({
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

describe("WebinarScriptPanel — the editor", () => {
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
		const user = userEvent.setup();
		renderPanel({ working: working() });

		await user.clear(editor());
		await user.type(editor(), "Rewritten.");

		captured.saveWebinarScriptBody.onError?.({ code: "CONFLICT" });

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

describe("WebinarScriptPanel — adopting a later version (FR34/FR35)", () => {
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

	it("refreshes and warns, rather than keeping stale text, when adopting loses a race", () => {
		// Unlike save's CONFLICT (which keeps the reader's unsaved edits
		// standing so they can be copied), adopt's CONFLICT invalidates —
		// there is no local edit of the CANDIDATE to preserve, only a stale
		// read of what is already saved.
		renderPanel({
			draft: readyDraft(DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
		});

		captured.adoptWebinarScriptDraft.onError?.({ code: "CONFLICT" });

		expect(mutate.invalidate).toHaveBeenCalled();
		expect(mutate.toastError).toHaveBeenCalledWith(
			expect.stringMatching(/changed while you were reading/i),
		);
	});
});

describe("WebinarScriptPanel — the release status (six values)", () => {
	it("renders each of the six release states in its own words", () => {
		for (const [status, phrase] of [
			["SHIPPED", /delivered and in use/i],
			["IN_PROGRESS", /underway, not finished/i],
			["PLANNED", /agreed but not started/i],
			["PREVIEW", /limited preview/i],
			["CONCEPT", /a concept, with nothing built/i],
			["UNCONFIRMED", /didn't say whether this has shipped/i],
		] as const) {
			const view = render(
				<WebinarScriptPanel
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

	it("reads a garbled status as unconfirmed, never as shipped", () => {
		renderPanel({
			draft: readyDraft({ ...DOCUMENT, releaseStatus: "LIVE" }, "d2"),
		});

		expect(
			screen.getByText(/didn't say whether this has shipped/i),
		).toBeInTheDocument();
	});

	it("attributes the claim to the draft, and says nothing was checked", () => {
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
	});
});

describe("WebinarScriptPanel — the scaffold banner", () => {
	it("says so in WORDS when the demo flow is empty", () => {
		renderPanel({ draft: readyDraft(SCAFFOLD_DOCUMENT, "d2") });

		expect(screen.getByText(/scaffold draft/i)).toBeInTheDocument();
		expect(
			screen.getByText(
				/wasn't enough confirmed material to write a demo flow/i,
			),
		).toBeInTheDocument();
	});

	it("does not cry scaffold over a full draft", () => {
		renderPanel({ draft: readyDraft(DOCUMENT, "d2") });

		expect(screen.queryByText(/scaffold draft/i)).not.toBeInTheDocument();
	});
});

describe("WebinarScriptPanel — the prompt-source notice", () => {
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

describe("WebinarScriptPanel — the asset clamp attribution (Task 8)", () => {
	it("names the asset AND the kind of review that moved it", () => {
		renderPanel({ draft: readyDraft(CLAMPED_DOCUMENT, "d2") });

		const clampedLine = screen.getByText(
			/admin panel screen capture.*moved out of the confirmed list by fabric.*internal-ui/i,
		);
		expect(clampedLine).toBeInTheDocument();
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
});

describe("WebinarScriptPanel — a document shape the panel cannot read", () => {
	it("degrades to an empty state rather than throwing", () => {
		// A panel that throws takes the whole Topic Item Page with it.
		renderPanel({ draft: readyDraft(UNREADABLE_CONTENT) });

		expect(
			screen.getByText(/no webinar script draft yet/i),
		).toBeInTheDocument();
	});
});

describe("WebinarScriptPanel — copying and downloading the draft", () => {
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

	it("carries the scaffold, release and clamp lines the working body cannot show", async () => {
		const user = userEvent.setup();
		renderPanel({
			draft: readyDraft(CLAMPED_DOCUMENT, "d1"),
			working: working({ sourceDraftId: "d1" }),
		});

		await user.click(screen.getByRole("button", { name: /pdf/i }));

		const exported = mutate.renderPdf.mock.calls[0][0] as string;
		expect(exported).toContain("Scaffold:");
		expect(exported).toContain("Release status:");
		// The kind attribution the download now carries (Fizzy #1988 Task 11
		// review, Finding 2) — the SAME per-asset, kind-specific line the panel
		// renders on screen, not the generic joined list
		// `composeWebinarScriptExport` used to send.
		expect(exported).toContain(
			"Admin panel screen capture — Moved out of the confirmed list by Fabric, from an open internal-UI review thread naming it.",
		);
	});

	it("keeps the confirmed-assets list in the download even when the draft is otherwise clean", async () => {
		// DOCUMENT is a SHIPPED, non-scaffold, nothing-outstanding draft — the
		// only caveat-shaped thing about it is a confirmed asset. Task 11's
		// re-review found that `isClean` returning early on exactly this shape
		// silently dropped the confirmed list from the download, even though
		// `suggestedAssets` is excluded from the body by design and the
		// on-screen render always shows it. A clean draft still exports the
		// asset — it must not also earn the "not ready to present" heading,
		// since nothing about this draft is uncertain.
		const user = userEvent.setup();
		renderPanel({
			draft: readyDraft(DOCUMENT, "d1"),
			working: working({ sourceDraftId: "d1" }),
		});

		await user.click(screen.getByRole("button", { name: /pdf/i }));

		const exported = mutate.renderPdf.mock.calls[0][0] as string;
		expect(exported).toContain("Retry budget dashboard screenshot");
		expect(exported).not.toContain("not ready to present");
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
		// The reader's text, not `latestReady`'s candidate body — the bug
		// Finding 1/2 of the Task 11 review found: the download and the
		// caption above it must agree on which document they send.
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

describe("WebinarScriptPanel — refining the saved draft", () => {
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
			"Cut the demo to five minutes.",
		);
		await user.click(screen.getByRole("button", { name: /refine draft/i }));

		expect(mutate.generate).toHaveBeenCalledWith({
			projectId: "p1",
			topicId: "t1",
			organizationId: "org1",
			guidance: "Cut the demo to five minutes.",
			refineFromWorkingDraft: true,
		});
	});
});

describe("WebinarScriptPanel — inputs needed and the safety note", () => {
	it("shows the safety note and the inputs still needed", () => {
		renderPanel({ draft: readyDraft(SCAFFOLD_DOCUMENT, "d2") });

		expect(
			screen.getByText(
				/a demo flow was not available from the topic context/i,
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
 * The qualifier alone reached only half of it. When v1 was generalized and v2
 * needs none, the newest note is null, the section does not render at all, and
 * there is nothing on screen left to qualify — the reader simply loses the
 * explanation of the document they are holding. The download is the worse half
 * of that: the file leaves Fabric stating generalizations that belong to a
 * draft nobody adopted, or omitting the ones that do apply, and nothing
 * downstream of an attachment can catch either.
 *
 * The qualifier survives for the one case it can still describe: a source row
 * past retention, where the newest note is all there is.
 */
describe("WebinarScriptPanel — the note belongs to the version in the editor", () => {
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
	 * Every occurrence of `OTHER_VERSION_NOTE` on screen, counted rather than
	 * queried for absence: the release-status section renders one of its own
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

		// One — the release-status section's. The safety note is this text's
		// own now, and saying otherwise beside it would be false.
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
		// The release-status section's, plus the one beside the note.
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
		// scaffold state and release status are the candidate's, and that is
		// unchanged by which note the file carries.
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

		const exported = mutate.renderPdf.mock.calls[0][0] as string;
		expect(exported).toContain(
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
	 * `doc` is read off `latestReady.content`; `readyId` is read off the ROW.
	 * A candidate written by a newer deploy — carrying a field this client's
	 * schema rejects — leaves the row readable and its content not, so
	 * `readyId` is non-null and `doc` is null at the same time, and
	 * `notesDescribeAnotherVersion` is true with no candidate document behind
	 * it. The adopted version still parses, so a KNOWN note applies to the
	 * text in the editor.
	 *
	 * The download is not gated on `doc` — it sits beside Save and Copy in the
	 * working-draft editor — so the reader can export in exactly this state.
	 *
	 * This suite already covered an unreadable candidate with NO working
	 * draft, which is the empty state and says nothing about this one.
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
		// Scaffold state, release status, assets and inputs have no value at
		// all here, so they get no line rather than a placeholder one.
		expect(exported).not.toMatch(/- Scaffold:/);
		expect(exported).not.toMatch(/- Release status:/);
		// And NOT the other-version qualifier, which the file carries whenever
		// the caveat block holds the candidate's metadata. Here it holds none:
		// the note is the adopted version's, which is the version this text
		// was saved from, so the sentence would be false. The screen agrees —
		// `noteDescribesAnotherVersion` is false in this same state.
		expect(exported).not.toMatch(/most recent generated version/i);
	});

	it("exports the bare body when neither version carries a note", async () => {
		// The floor this must not raise: with no readable candidate AND no
		// readable source there is nothing honest to say, so the body alone
		// with no caveat block — today's behaviour — is the right answer.
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

describe("WebinarScriptPanel — what a viewer sees", () => {
	it("gives a viewer the draft, the release status and the asset list, and no controls", () => {
		renderPanel({
			draft: readyDraft(CLAMPED_DOCUMENT, "d2"),
			working: working({ sourceDraftId: "d1" }),
			canEdit: false,
		});

		// The saved draft, read-only.
		expect(
			screen.getAllByText(
				/today i want to show you how we cut duplicate/i,
			).length,
		).toBeGreaterThan(0);
		// The release status matters MORE to a reader than to an editor — they
		// are the one likeliest to present from it.
		expect(
			screen.getByText(
				/the draft says the work is delivered and in use/i,
			),
		).toBeInTheDocument();
		// The asset a viewer must not treat as cleared for use.
		expect(screen.getByText("Rollout timeline chart")).toBeInTheDocument();

		expect(
			screen.queryByRole("textbox", { name: /working webinar script/i }),
		).not.toBeInTheDocument();
		// Per-name queries, not one alternation: `queryByRole` THROWS on
		// multiple matches rather than returning them, so a regression that
		// added a second matching button would surface as a
		// `TestingLibraryElementError` instead of this assertion's own
		// message.
		for (const name of [
			/generate/i,
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
});
