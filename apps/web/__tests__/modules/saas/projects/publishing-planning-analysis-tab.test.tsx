/**
 * PlanningAnalysisTab — the topic's Planning & Analysis tab (Fizzy #1851).
 *
 * The states this panel has to get right are not "loading / loaded". They are
 * the ways an analysis, an ATTEMPT at one, and a person's edit of one can
 * disagree:
 *
 *   nothing yet · running · running over a previous one · failed over a
 *   previous one · stranded · never edited · edited · deliberately CLEARED ·
 *   edited from an analysis the AI has since moved past
 *
 * A panel that renders only "the newest attempt" would blank a perfectly good
 * analysis the moment a regeneration failed — which is exactly when its
 * reader wants it. A panel that cannot tell "cleared" from "never edited"
 * will re-seed a document from the AI text its author just removed.
 *
 * Task 11 composes the editor (Task 9) and the version-history drawer (Task
 * 10) into this tab. Both are STUBBED here, and the stubs are not
 * conveniences: the editor stub seeds its text on mount and never re-syncs,
 * which is precisely what the real component does (it has no re-sync effect),
 * so when the tab re-seeds it — and when it must NOT — is observable. Their
 * own behaviour is pinned in `planning-analysis-editor.test.tsx` and
 * `analysis-version-history.test.tsx`.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateMutate, saveMutate, invalidateQueries, state } = vi.hoisted(
	() => ({
		generateMutate: vi.fn(),
		saveMutate: vi.fn(),
		invalidateQueries: vi.fn(),
		state: { isPending: false },
	}),
);

vi.mock("@tanstack/react-query", () => ({
	useMutation: (opts: {
		mutationKey?: unknown[];
		onSuccess?: (...a: unknown[]) => unknown;
		onError?: (...a: unknown[]) => unknown;
	}) => {
		const procedure = Array.isArray(opts?.mutationKey)
			? opts.mutationKey[0]
			: undefined;
		if (procedure === "saveAnalysisRevision") {
			return {
				mutate: (vars: unknown) => {
					saveMutate(vars);
					opts.onSuccess?.(
						{ saved: true, version: 9 },
						vars,
						undefined,
					);
				},
				isPending: state.isPending,
			};
		}
		return {
			mutate: (vars: unknown) => {
				generateMutate(vars);
				opts.onSuccess?.({ started: true }, vars, undefined);
			},
			isPending: state.isPending,
		};
	},
	useQueryClient: () => ({ invalidateQueries }),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			publishingSuite: {
				generatePlanningAnalysis: {
					mutationOptions: (o: Record<string, unknown>) => ({
						mutationKey: ["generatePlanningAnalysis"],
						...o,
					}),
				},
				saveAnalysisRevision: {
					mutationOptions: (o: Record<string, unknown>) => ({
						mutationKey: ["saveAnalysisRevision"],
						...o,
					}),
				},
				getPlanningAnalysis: {
					queryOptions: ({ input }: { input?: unknown }) => ({
						queryKey: ["getPlanningAnalysis", input],
					}),
					queryKey: ({ input }: { input?: unknown }) => [
						"getPlanningAnalysis",
						input,
					],
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const { editorProps, historyProps, editorMounts } = vi.hoisted(() => ({
	editorProps: { current: null as Record<string, unknown> | null },
	historyProps: { current: null as Record<string, unknown> | null },
	editorMounts: { count: 0 },
}));

/** The version the stubbed Save reports back, as the server would. */
const SAVED_VERSION = 7;
const UNSAVED_KEYSTROKES = "…and a sentence typed after the save.";

/**
 * Mirrors the TWO properties of the real editor this tab has to work around:
 *
 *  1. `prose` seeds internal state on MOUNT and is never re-read, so a prop
 *     update shows the old text and only a remount shows the new one; and
 *  2. everything the author has typed since that mount — here `draft`, in the
 *     real component the TipTap buffer, its cursor and its undo stack — is
 *     destroyed with the instance.
 *
 * The second is what makes "remounted" distinguishable from "did not
 * remount": a test that only varies `prose` reads the same either way once the
 * seed happens to match. `editorMounts` counts instances for the same reason.
 */
vi.mock(
	"@saas/projects/components/publishing-suite/PlanningAnalysisEditor",
	() => ({
		PlanningAnalysisEditor: (props: {
			prose: string;
			canEdit: boolean;
			revisionVersion: number | null;
			sourceAnalysisVersion: number | null;
			onSaved?: (version: number) => void;
		}) => {
			editorProps.current = props;
			const [seeded] = useState(props.prose);
			const [draft, setDraft] = useState("");
			useEffect(() => {
				editorMounts.count += 1;
			}, []);
			return (
				<div>
					<p data-testid="editor-prose">{seeded}</p>
					<p data-testid="editor-draft">{draft}</p>
					<button
						type="button"
						onClick={() => setDraft(UNSAVED_KEYSTROKES)}
						disabled={!props.canEdit}
					>
						Type
					</button>
					<button
						type="button"
						onClick={() => props.onSaved?.(SAVED_VERSION)}
						disabled={!props.canEdit}
					>
						Save
					</button>
				</div>
			);
		},
	}),
);

vi.mock(
	"@saas/projects/components/publishing-suite/AnalysisVersionHistory",
	() => ({
		AnalysisVersionHistory: (props: {
			open: boolean;
			currentVersion: number | null;
			onRestore?: (version: number) => void;
		}) => {
			historyProps.current = props;
			return props.open ? (
				<div>
					<p>Version history drawer</p>
					<button type="button" onClick={() => props.onRestore?.(4)}>
						Restore v4
					</button>
				</div>
			) : null;
		},
	}),
);

import { PlanningAnalysisTab } from "@saas/projects/components/publishing-suite/PlanningAnalysisTab";

/** The raw analysis row's content, as the model wrote it. */
const READY_CONTENT = {
	topicAngle: "An engineering reliability story.",
	whyWorthPublishing: "A concrete, measurable change customers felt.",
	keyDetails: {
		problem: "Retries were unbounded.",
		solution: "A per-execution budget.",
	},
	contentTypes: {
		recommended: [
			{ type: "Blog post", rationale: "Enough depth to teach." },
		],
		needsConfirmation: [
			{ type: "Case study", rationale: "Names a customer." },
		],
	},
	sourceSignals: ["Three merged pull requests in one repository."],
	risks: ["The metric is from a single deployment."],
};

const ready = (overrides: Record<string, unknown> = {}) => ({
	id: "pa-1",
	version: 1,
	status: "READY",
	content: READY_CONTENT,
	sourceRefs: {},
	model: "test-model",
	promptSource: "BOUND",
	error: null,
	createdAt: new Date("2026-08-30T10:00:00Z"),
	updatedAt: new Date("2026-08-30T10:04:00Z"),
	...overrides,
});

/** The resolver's answer for an unedited analysis. */
const AI_EFFECTIVE = {
	prose: "### Topic angle\n\nAn engineering reliability story.",
	data: {
		contentTypes: READY_CONTENT.contentTypes,
		sourceSignals: READY_CONTENT.sourceSignals,
	},
	overridden: false,
};

function props(overrides: Record<string, unknown> = {}) {
	return {
		projectId: "proj-1",
		topicId: "topic-1",
		organizationId: null,
		canEdit: true,
		isLoading: false,
		latestAttempt: null,
		effective: null,
		aiVersion: null,
		aiModel: null,
		aiPromptSource: null,
		revisionVersion: null,
		sourceAnalysisVersion: null,
		author: null,
		revisionCreatedAt: null,
		...overrides,
	};
}

function renderTab(overrides: Record<string, unknown> = {}) {
	return render(<PlanningAnalysisTab {...(props(overrides) as never)} />);
}

beforeEach(() => {
	vi.clearAllMocks();
	state.isPending = false;
	editorProps.current = null;
	historyProps.current = null;
	editorMounts.count = 0;
});

describe("PlanningAnalysisTab — the empty state", () => {
	it("offers to generate one when there is nothing yet", async () => {
		renderTab();

		expect(screen.getByText(/no analysis yet/i)).toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", { name: /generate planning analysis/i }),
		);
		expect(generateMutate).toHaveBeenCalledWith({
			projectId: "proj-1",
			topicId: "topic-1",
			organizationId: null,
		});
	});

	it("shows a reader no generate control at all", () => {
		// The server gates this on PUBLISHING_TOPIC_UPDATE. Rendering a button
		// that can only produce a 403 is worse than rendering none.
		renderTab({ canEdit: false });

		expect(
			screen.queryByRole("button", {
				name: /generate planning analysis/i,
			}),
		).not.toBeInTheDocument();
	});

	it("mounts no document and no footer when there is no analysis", () => {
		// Negative control for every "document" assertion below: the editor
		// and the History button must be absent here, or a test that finds
		// them elsewhere proves nothing about the analysis being present.
		renderTab();

		expect(screen.queryByTestId("editor-prose")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /history/i }),
		).not.toBeInTheDocument();
	});
});

describe("PlanningAnalysisTab — a run in flight", () => {
	it("says it is generating and refuses a second click", () => {
		renderTab({
			latestAttempt: ready({ status: "GENERATING", content: null }),
		});

		expect(screen.getByText(/generating/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /generat/i })).toBeDisabled();
	});

	it("keeps the previous analysis on screen while the next one runs", () => {
		// Hiding it would make a regeneration destructive from the reader's point
		// of view: the thing they were reading disappears for minutes, over an
		// action that was supposed to improve it.
		renderTab({
			effective: AI_EFFECTIVE,
			aiVersion: 1,
			sourceAnalysisVersion: 1,
			latestAttempt: ready({
				id: "pa-2",
				version: 2,
				status: "GENERATING",
			}),
		});

		expect(screen.getByTestId("editor-prose")).toHaveTextContent(
			/an engineering reliability story/i,
		);
		expect(screen.getByText(/previous analysis/i)).toBeInTheDocument();
	});
});

describe("PlanningAnalysisTab — a failed run", () => {
	it("shows the error and offers a retry", () => {
		renderTab({
			latestAttempt: ready({
				status: "FAILED",
				content: null,
				error: "The model did not return a usable answer.",
			}),
		});

		expect(
			screen.getByText(/the model did not return a usable answer/i),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /try again/i }),
		).toBeEnabled();
	});

	it("does NOT blank a good analysis when a regeneration fails", () => {
		// The single most important assertion in this file. One row cannot carry
		// both meanings, which is why the endpoint returns the attempt AND the
		// resolved document.
		renderTab({
			effective: AI_EFFECTIVE,
			aiVersion: 1,
			sourceAnalysisVersion: 1,
			latestAttempt: ready({
				id: "pa-2",
				version: 2,
				status: "FAILED",
				content: null,
				error: "Rate limited.",
			}),
		});

		expect(screen.getByText(/rate limited/i)).toBeInTheDocument();
		expect(screen.getByTestId("editor-prose")).toHaveTextContent(
			/an engineering reliability story/i,
		);
	});
});

describe("PlanningAnalysisTab — a ready analysis", () => {
	const readyProps = {
		effective: AI_EFFECTIVE,
		aiVersion: 1,
		sourceAnalysisVersion: 1,
		latestAttempt: ready(),
	};

	it("renders the document and the data sections around it", () => {
		renderTab(readyProps);

		expect(screen.getByTestId("editor-prose")).toHaveTextContent(
			/an engineering reliability story/i,
		);
		expect(screen.getByText(/enough depth to teach/i)).toBeVisible();
		expect(screen.getByText(/three merged pull requests/i)).toBeVisible();
	});

	it("hands the editor the versions a save has to send", () => {
		renderTab({ ...readyProps, revisionVersion: 3, aiVersion: 4 });

		expect(editorProps.current).toMatchObject({
			revisionVersion: 3,
			sourceAnalysisVersion: 1,
			canEdit: true,
		});
	});

	it("says which prompt produced it when it was not the bound one", () => {
		// An analysis built from the default body because the bound prompt would
		// not render reads exactly like one built from the bound prompt. It is the
		// one fact about a run a reader cannot recover from the output.
		renderTab({
			...readyProps,
			aiPromptSource: "DEFAULT_RENDER_FAILED",
		});

		expect(screen.getByText(/default prompt/i)).toBeInTheDocument();
	});

	it("keeps the model and the prompt note after a regeneration FAILS", () => {
		// FAILED is terminal — the topic sits there until someone retries — so
		// provenance read off the newest ATTEMPT is not lost "for a few
		// minutes", it is lost permanently, on exactly the analysis a reader
		// has most reason to scrutinise. These two arrive as scalars off the
		// READY row precisely so a failure on top of it cannot take them.
		renderTab({
			...readyProps,
			aiVersion: 1,
			aiModel: "test-model",
			aiPromptSource: "DEFAULT_UNBOUND",
			latestAttempt: ready({
				id: "pa-2",
				version: 2,
				status: "FAILED",
				content: null,
				model: null,
				promptSource: null,
				error: "The model did not return a usable answer.",
			}),
		});

		expect(screen.getByText(/test-model/)).toBeInTheDocument();
		expect(screen.getByText(/default prompt/i)).toBeInTheDocument();
	});

	it("claims no provenance the response did not carry", () => {
		// Negative control for the two above: with no model and no prompt
		// source, the footer says neither — so a passing assertion up there is
		// the scalars arriving, not a note the footer always prints.
		renderTab({ ...readyProps, aiModel: null, aiPromptSource: null });

		expect(screen.queryByText(/test-model/)).not.toBeInTheDocument();
		expect(screen.queryByText(/default prompt/i)).not.toBeInTheDocument();
	});

	it("renders no data section when the analysis carries none", () => {
		// Negative control for the section assertions above: an empty bucket
		// list must not leave a bare heading behind.
		renderTab({
			...readyProps,
			effective: { prose: "Some prose.", data: {}, overridden: false },
		});

		expect(screen.queryByText(/^Content types$/)).not.toBeInTheDocument();
		expect(screen.queryByText(/^Source signals$/)).not.toBeInTheDocument();
	});
});

describe("PlanningAnalysisTab — version state sits with the button that changes it", () => {
	const readyProps = {
		effective: AI_EFFECTIVE,
		aiVersion: 1,
		sourceAnalysisVersion: 1,
		latestAttempt: ready(),
	};

	/** True when `first` precedes `second` in document order. */
	const precedes = (first: Element, second: Element) =>
		Boolean(
			first.compareDocumentPosition(second) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		);

	it("puts the provenance line and History above the document, not below it", () => {
		// They used to live in a footer BELOW the editor AND below the data
		// sections, while Generate/Regenerate was pinned at the top — so on a
		// real analysis the version the reader is looking at, and the control
		// that changes it, were a long scroll apart. Document order is the
		// assertion because jsdom has no layout to measure.
		renderTab(readyProps);

		const documentEl = screen.getByTestId("editor-prose");
		const provenance = screen.getByText(/not edited yet/i);
		const history = screen.getByRole("button", { name: /history/i });
		const generate = screen.getByRole("button", { name: /regenerate/i });

		expect(precedes(provenance, documentEl)).toBe(true);
		expect(precedes(history, documentEl)).toBe(true);
		expect(precedes(generate, documentEl)).toBe(true);
	});

	it("still opens the history drawer from its new home", async () => {
		// Moving the trigger must not leave it wired to nothing — and the
		// drawer itself stays mounted where it was.
		renderTab(readyProps);

		expect(screen.queryByText(/version history drawer/i)).toBeNull();

		await userEvent.click(screen.getByRole("button", { name: /history/i }));

		expect(screen.getByText(/version history drawer/i)).toBeInTheDocument();
	});
});

describe("PlanningAnalysisTab — never edited vs deliberately cleared", () => {
	it("distinguishes an emptied document from one that was never edited", () => {
		const { rerender } = render(
			<PlanningAnalysisTab
				{...(props({
					effective: { prose: "", data: {}, overridden: true },
					aiVersion: 2,
					revisionVersion: 5,
					sourceAnalysisVersion: 2,
				}) as never)}
			/>,
		);
		expect(screen.getByText(/cleared this analysis/i)).toBeInTheDocument();

		rerender(
			<PlanningAnalysisTab {...(props({ effective: null }) as never)} />,
		);
		expect(screen.getByText(/no analysis yet/i)).toBeInTheDocument();
		expect(
			screen.queryByText(/cleared this analysis/i),
		).not.toBeInTheDocument();
	});

	it("does not call an unedited empty analysis 'cleared'", () => {
		// NEGATIVE CONTROL for the case above. `overridden` is the ONLY thing
		// that separates the two, and both have an empty prose string — a
		// check written against `prose === ""` alone would pass the assertion
		// above and still be wrong here.
		renderTab({
			effective: { prose: "", data: {}, overridden: false },
			aiVersion: 1,
			sourceAnalysisVersion: 1,
			latestAttempt: ready({ content: {} }),
		});

		expect(
			screen.queryByText(/cleared this analysis/i),
		).not.toBeInTheDocument();
		expect(screen.getByText(/came back empty/i)).toBeInTheDocument();
	});

	it("says the document has never been edited in the footer", () => {
		renderTab({
			effective: AI_EFFECTIVE,
			aiVersion: 2,
			sourceAnalysisVersion: 2,
			revisionVersion: null,
			latestAttempt: ready({ version: 2 }),
		});

		expect(screen.getByText(/not edited yet/i)).toBeInTheDocument();
	});

	it("names the author and the version once one exists", () => {
		renderTab({
			effective: { ...AI_EFFECTIVE, overridden: true },
			aiVersion: 2,
			sourceAnalysisVersion: 2,
			revisionVersion: 6,
			author: { id: "u-1", name: "Alex Rivera" },
			revisionCreatedAt: new Date("2026-09-01T09:00:00Z"),
			latestAttempt: ready({ version: 2 }),
		});

		expect(screen.getByText(/version 6/i)).toBeInTheDocument();
		expect(screen.getByText(/alex rivera/i)).toBeInTheDocument();
		expect(screen.queryByText(/not edited yet/i)).not.toBeInTheDocument();
	});
});

describe("PlanningAnalysisTab — the stale-analysis banner", () => {
	const staleProps = {
		effective: {
			prose: "The author's own words.",
			data: {},
			overridden: true,
		},
		aiVersion: 2,
		revisionVersion: 3,
		sourceAnalysisVersion: 1,
		latestAttempt: ready({ version: 2 }),
	};

	it("shows the stale banner when the AI analysis moved past the edited body", () => {
		renderTab(staleProps);

		// The banner's own sentence, not the bare word "newer" — both of its
		// buttons carry that word too, so a looser matcher would pass on a
		// build that rendered the affordances with no explanation of why.
		expect(
			screen.getByText(/a newer planning analysis is available/i),
		).toBeInTheDocument();
	});

	it("does not show it when the body was seeded from the newest analysis", () => {
		renderTab({ ...staleProps, sourceAnalysisVersion: 2 });

		// Nothing about a newer analysis at all: not the sentence, not the
		// view button, not the replace button.
		expect(screen.queryAllByText(/newer/i)).toHaveLength(0);
	});

	it("does not show it before any analysis exists at all", () => {
		// NEGATIVE CONTROL. `null < 2` is `true` in JavaScript, so a condition
		// written without the explicit null checks would fire the banner on a
		// topic that has never been analysed.
		renderTab({
			...staleProps,
			effective: null,
			sourceAnalysisVersion: null,
			latestAttempt: null,
		});

		expect(screen.queryAllByText(/newer/i)).toHaveLength(0);
	});

	it("replaces through the save path, stamped with the newer analysis", async () => {
		renderTab(staleProps);

		await userEvent.click(
			screen.getByRole("button", {
				name: /replace with the newer analysis/i,
			}),
		);

		expect(saveMutate).toHaveBeenCalledWith({
			projectId: "proj-1",
			topicId: "topic-1",
			organizationId: null,
			// The newer AI row's prose, rendered the same way the resolver
			// renders it — not the author's text, and not the raw JSON.
			body: expect.stringContaining("An engineering reliability story."),
			// Compare-and-set on where the document is NOW…
			expectedVersion: 3,
			// …and stamped with the analysis it was actually seeded from,
			// which is the only thing that clears the banner.
			sourceAnalysisVersion: 2,
			changeSummary: "Replaced with analysis version 2",
		});
	});

	it("shows the newer analysis rather than making the author take it blind", async () => {
		renderTab(staleProps);

		await userEvent.click(
			screen.getByRole("button", { name: /view the newer analysis/i }),
		);

		expect(
			await screen.findByText(/an engineering reliability story/i),
		).toBeVisible();
	});

	it("offers a reader the view but never the replace", () => {
		renderTab({ ...staleProps, canEdit: false });

		expect(
			screen.getByRole("button", { name: /view the newer analysis/i }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", {
				name: /replace with the newer analysis/i,
			}),
		).not.toBeInTheDocument();
	});
});

describe("PlanningAnalysisTab — keeping the client's version tokens fresh", () => {
	const editedProps = {
		effective: {
			prose: "The author's own words.",
			data: {},
			overridden: true,
		},
		aiVersion: 2,
		revisionVersion: 3,
		sourceAnalysisVersion: 2,
		latestAttempt: ready({ version: 2 }),
	};

	it("re-fetches the analysis after a save", async () => {
		// Load-bearing, not a nicety: the editor's version props are
		// controlled and it updates no state of its own on success, so a
		// second Save before this parent re-renders would resend a stale
		// `expectedVersion` and earn a spurious CONFLICT.
		renderTab(editedProps);
		invalidateQueries.mockClear();

		await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: [
				"getPlanningAnalysis",
				{
					projectId: "proj-1",
					topicId: "topic-1",
					organizationId: null,
				},
			],
		});
	});

	it("re-fetches the analysis after a restore", async () => {
		renderTab(editedProps);
		await userEvent.click(screen.getByRole("button", { name: /history/i }));
		invalidateQueries.mockClear();

		await userEvent.click(
			screen.getByRole("button", { name: /restore v4/i }),
		);

		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: [
				"getPlanningAnalysis",
				{
					projectId: "proj-1",
					topicId: "topic-1",
					organizationId: null,
				},
			],
		});
	});

	it("re-fetches the analysis after a replace", async () => {
		renderTab({ ...editedProps, sourceAnalysisVersion: 1 });
		invalidateQueries.mockClear();

		await userEvent.click(
			screen.getByRole("button", {
				name: /replace with the newer analysis/i,
			}),
		);

		expect(invalidateQueries).toHaveBeenCalled();
	});

	it("hands the history drawer the version a restore compares against", async () => {
		renderTab(editedProps);

		await userEvent.click(screen.getByRole("button", { name: /history/i }));

		expect(historyProps.current).toMatchObject({
			open: true,
			currentVersion: 3,
		});
	});
});

describe("PlanningAnalysisTab — when the editor is re-seeded, and when it is not", () => {
	const base = {
		effective: {
			prose: "The text before the restore.",
			data: {},
			overridden: true,
		},
		aiVersion: 2,
		revisionVersion: 3,
		sourceAnalysisVersion: 2,
		latestAttempt: ready({ version: 2 }),
	};

	it("re-seeds the editor when the revision version changes", () => {
		const { rerender } = render(
			<PlanningAnalysisTab {...(props(base) as never)} />,
		);
		expect(screen.getByTestId("editor-prose")).toHaveTextContent(
			"The text before the restore.",
		);

		rerender(
			<PlanningAnalysisTab
				{...(props({
					...base,
					revisionVersion: 4,
					effective: {
						...base.effective,
						prose: "The restored text.",
					},
				}) as never)}
			/>,
		);

		expect(screen.getByTestId("editor-prose")).toHaveTextContent(
			"The restored text.",
		);
	});

	it("does NOT remount while the revision version is unchanged", () => {
		// NEGATIVE CONTROL, and the one that makes the case above mean
		// something: a stub that simply rendered its `prose` prop would pass
		// that test whether or not the editor was keyed. This proves the seed
		// really is mount-only, so the re-seed above can only have come from a
		// remount.
		const { rerender } = render(
			<PlanningAnalysisTab {...(props(base) as never)} />,
		);

		rerender(
			<PlanningAnalysisTab
				{...(props({
					...base,
					effective: {
						...base.effective,
						prose: "A prop update nobody asked for.",
					},
				}) as never)}
			/>,
		);

		expect(screen.getByTestId("editor-prose")).toHaveTextContent(
			"The text before the restore.",
		);
	});

	it("re-seeds an unedited document when a newer analysis lands", () => {
		// A topic nobody has edited holds `revisionVersion === null` forever,
		// so a key derived from it alone never changes and the editor keeps
		// rendering the analysis it first mounted with. Nothing warns the
		// reader either: with no revision, the source version IS the newest
		// analysis version, so the stale banner is false by construction — the
		// document simply disagrees with the footer directly beneath it.
		const unedited = {
			effective: {
				prose: "What version one found.",
				data: {},
				overridden: false,
			},
			aiVersion: 1,
			revisionVersion: null,
			sourceAnalysisVersion: 1,
			latestAttempt: ready({ version: 1 }),
		};
		const { rerender } = render(
			<PlanningAnalysisTab {...(props(unedited) as never)} />,
		);
		expect(screen.getByTestId("editor-prose")).toHaveTextContent(
			"What version one found.",
		);

		rerender(
			<PlanningAnalysisTab
				{...(props({
					...unedited,
					aiVersion: 2,
					sourceAnalysisVersion: 2,
					effective: {
						...unedited.effective,
						prose: "What version two found.",
					},
					latestAttempt: ready({ id: "pa-2", version: 2 }),
				}) as never)}
			/>,
		);

		expect(screen.getByTestId("editor-prose")).toHaveTextContent(
			"What version two found.",
		);
		// The half that makes it a contradiction rather than a delay: the
		// footer beside the document has already moved on.
		expect(
			screen.getByText(/showing analysis version 2/i),
		).toBeInTheDocument();
	});

	it("does NOT remount the editor after an ordinary save", async () => {
		// There is no autosave here, so "save and keep typing" is how the
		// component is meant to be used. A remount on the refetch that follows
		// a save resets the cursor, drops the undo stack, and throws away
		// everything typed between save-success and the refetch landing.
		const { rerender } = render(
			<PlanningAnalysisTab {...(props(base) as never)} />,
		);
		await userEvent.click(screen.getByRole("button", { name: /^type$/i }));
		await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

		// The refetch lands: the server now holds the version the save
		// produced, and hands back the text the editor already has.
		rerender(
			<PlanningAnalysisTab
				{...(props({
					...base,
					revisionVersion: SAVED_VERSION,
				}) as never)}
			/>,
		);

		// Varying `revisionVersion` alone would read the same either way — the
		// seeded prose is unchanged by a save. These two are the difference.
		expect(screen.getByTestId("editor-draft")).toHaveTextContent(
			UNSAVED_KEYSTROKES,
		);
		expect(editorMounts.count).toBe(1);
	});

	it("re-seeds when the page swings to another topic on the same numbers", () => {
		// The page reuses one mounted tab across topics, so "same revision
		// number" is not "same document" — two topics edited the same number
		// of times line up exactly. Nothing else in the seed can tell them
		// apart, so the previous topic's analysis would sit there under the
		// new topic's heading.
		const { rerender } = render(
			<PlanningAnalysisTab {...(props(base) as never)} />,
		);

		rerender(
			<PlanningAnalysisTab
				{...(props({
					...base,
					topicId: "topic-2",
					effective: {
						...base.effective,
						prose: "A different topic's analysis.",
					},
				}) as never)}
			/>,
		);

		expect(screen.getByTestId("editor-prose")).toHaveTextContent(
			"A different topic's analysis.",
		);
	});

	it("re-seeds on a topic swing that follows a save", async () => {
		// And the own-save exemption is scoped to the topic that save was on:
		// a version number this editor produced HERE says nothing about the
		// document under the same number over THERE.
		const { rerender } = render(
			<PlanningAnalysisTab {...(props(base) as never)} />,
		);
		await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

		rerender(
			<PlanningAnalysisTab
				{...(props({
					...base,
					topicId: "topic-2",
					revisionVersion: SAVED_VERSION,
					effective: {
						...base.effective,
						prose: "A different topic's analysis.",
					},
				}) as never)}
			/>,
		);

		expect(screen.getByTestId("editor-prose")).toHaveTextContent(
			"A different topic's analysis.",
		);
	});

	it("does not exempt ANOTHER topic's revision as this editor's own save", async () => {
		// The swing above is not the dangerous moment — the arrival AFTER it
		// is. The exemption remembers a version NUMBER, and every topic's
		// first revision is version 1, so a number produced on topic-1 lines
		// up with the first revision anybody writes on topic-2 as a matter of
		// course, not as an edge case.
		//
		// Scoped against the SEED rather than against the topic the save was
		// made on, the check reads true here: the swing one render earlier has
		// already moved the seed onto topic-2. The colleague's revision is
		// then exempted, the editor keeps showing topic-2's un-edited AI
		// prose, and — because `revisionVersion` says a revision exists — the
		// next Save sends an `expectedVersion` the server accepts. The
		// colleague's work is superseded with neither person seeing it.
		const { rerender } = render(
			<PlanningAnalysisTab {...(props(base) as never)} />,
		);
		await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

		// The save's own refetch, on the topic it was made on: exempt.
		rerender(
			<PlanningAnalysisTab
				{...(props({
					...base,
					revisionVersion: SAVED_VERSION,
				}) as never)}
			/>,
		);
		expect(editorMounts.count).toBe(1);

		// The page swings to a topic nobody has edited yet.
		rerender(
			<PlanningAnalysisTab
				{...(props({
					...base,
					topicId: "topic-2",
					revisionVersion: null,
					sourceAnalysisVersion: 2,
					effective: {
						prose: "Topic two's un-edited analysis.",
						data: {},
						overridden: false,
					},
				}) as never)}
			/>,
		);
		expect(screen.getByTestId("editor-prose")).toHaveTextContent(
			"Topic two's un-edited analysis.",
		);

		// A colleague's revision lands on topic-2, carrying the same version
		// number this editor's save produced back on topic-1.
		rerender(
			<PlanningAnalysisTab
				{...(props({
					...base,
					topicId: "topic-2",
					revisionVersion: SAVED_VERSION,
					sourceAnalysisVersion: 2,
					effective: {
						prose: "A colleague's revision of topic two.",
						data: {},
						overridden: true,
					},
				}) as never)}
			/>,
		);

		expect(screen.getByTestId("editor-prose")).toHaveTextContent(
			"A colleague's revision of topic two.",
		);
		// Named as well as read: the prose assertion only means "remounted"
		// because the stub seeds on mount alone, which the negative control
		// above proves. Three mounts — the first render, the swing, and this.
		expect(editorMounts.count).toBe(3);
	});

	it("re-seeds when the page swings BACK to the topic the save was made on", async () => {
		// The other half of the same trap, and the one a topic-only exemption
		// walks straight into. Nothing ever clears `ownSave`, so a save on
		// topic-1 still matches topic-1 after the page has been somewhere
		// else — but by then the MOUNTED editor is holding topic-2's document.
		// Exempting the arrival leaves that document on screen while
		// `topicId`, `revisionVersion`, `sourceAnalysisVersion` and the footer
		// are all topic-1's, and the next Save writes topic-2's prose into
		// topic-1's revision chain at an `expectedVersion` the server accepts.
		// One actor, no CONFLICT, nothing on screen to notice.
		const { rerender } = render(
			<PlanningAnalysisTab {...(props(base) as never)} />,
		);
		await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

		// The save's own refetch, on the topic it was made on: exempt.
		rerender(
			<PlanningAnalysisTab
				{...(props({
					...base,
					revisionVersion: SAVED_VERSION,
				}) as never)}
			/>,
		);
		expect(editorMounts.count).toBe(1);

		// Away to another topic: this one does re-seed.
		rerender(
			<PlanningAnalysisTab
				{...(props({
					...base,
					topicId: "topic-2",
					revisionVersion: 4,
					effective: {
						prose: "Topic two's own document.",
						data: {},
						overridden: true,
					},
				}) as never)}
			/>,
		);
		expect(screen.getByTestId("editor-prose")).toHaveTextContent(
			"Topic two's own document.",
		);

		// And back to topic-1, whose revision is still the version the save
		// produced. The exemption matches on topic AND version — and must not
		// fire, because the editor is not on this topic any more.
		rerender(
			<PlanningAnalysisTab
				{...(props({
					...base,
					revisionVersion: SAVED_VERSION,
					effective: {
						...base.effective,
						prose: "The document the author saved on topic one.",
					},
				}) as never)}
			/>,
		);

		expect(screen.getByTestId("editor-prose")).toHaveTextContent(
			"The document the author saved on topic one.",
		);
		// Asserted as a mount count too: a stub that re-read `prose` as a prop
		// would show the right text without ever remounting, and the real
		// editor does not re-read it. Three mounts — the first render, the
		// swing away, and the swing back.
		expect(editorMounts.count).toBe(3);
	});

	it("still re-seeds after a restore that follows a save", async () => {
		// The exemption is for the one version this editor's own save
		// produced — not a blanket "stop remounting once somebody has saved".
		// Without this, "fixing" the case above by never re-seeding after a
		// save would look correct.
		const { rerender } = render(
			<PlanningAnalysisTab {...(props(base) as never)} />,
		);
		await userEvent.click(screen.getByRole("button", { name: /^type$/i }));
		await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
		rerender(
			<PlanningAnalysisTab
				{...(props({
					...base,
					revisionVersion: SAVED_VERSION,
				}) as never)}
			/>,
		);

		rerender(
			<PlanningAnalysisTab
				{...(props({
					...base,
					revisionVersion: SAVED_VERSION + 1,
					effective: {
						...base.effective,
						prose: "The restored text.",
					},
				}) as never)}
			/>,
		);

		expect(screen.getByTestId("editor-prose")).toHaveTextContent(
			"The restored text.",
		);
		expect(screen.getByTestId("editor-draft")).toBeEmptyDOMElement();
		expect(editorMounts.count).toBe(2);
	});
});

describe("PlanningAnalysisTab — a run that never reported back", () => {
	// Codex adversarial review, confirmed: the ONLY code that reclaims a stranded
	// GENERATING row lives inside `startPlanningAnalysisAttempt`, and this panel
	// disabled its generate button whenever an attempt read GENERATING. A run
	// whose worker never started — or whose failure marker exhausted its retries,
	// or whose workflow hit its execution timeout, which terminates without
	// running the workflow's own catch — therefore locked the topic with no user
	// action able to reach the reclaim. The server now says when an attempt is
	// past its deadline; this is the panel honouring it.
	const stranded = {
		id: "pa-1",
		version: 1,
		status: "GENERATING",
		isExpired: true,
		content: null,
		sourceRefs: {},
		model: null,
		promptSource: null,
		error: null,
		createdAt: new Date("2026-08-30T10:00:00Z"),
		updatedAt: new Date("2026-08-30T10:00:00Z"),
	};

	it("re-enables the retry so the reclaim can actually be reached", async () => {
		renderTab({ latestAttempt: stranded });

		const button = screen.getByRole("button", { name: /try again/i });
		expect(button).toBeEnabled();

		await userEvent.click(button);
		expect(generateMutate).toHaveBeenCalledWith({
			projectId: "proj-1",
			topicId: "topic-1",
			organizationId: null,
		});
	});

	it("says the run did not report back rather than claiming it is still running", () => {
		// "Generating…" on a run that died twenty minutes ago is a lie the user
		// has no way to see through.
		renderTab({ latestAttempt: stranded });

		expect(screen.getByText(/did not report back/i)).toBeInTheDocument();
		expect(screen.queryByText(/this usually takes a minute/i)).toBeNull();
	});

	it("still shows a previous analysis underneath", () => {
		renderTab({
			effective: AI_EFFECTIVE,
			aiVersion: 1,
			sourceAnalysisVersion: 1,
			latestAttempt: stranded,
		});

		expect(screen.getByTestId("editor-prose")).toHaveTextContent(
			/an engineering reliability story/i,
		);
	});

	it("keeps a live attempt disabled — the fix must not defeat the in-flight guard", () => {
		// NEGATIVE CONTROL. Re-enabling on `status === "GENERATING"` alone would
		// pass every assertion above while letting a double-click spend a second
		// model call on a run that is perfectly healthy.
		renderTab({ latestAttempt: { ...stranded, isExpired: false } });

		expect(screen.getByRole("button", { name: /generat/i })).toBeDisabled();
	});
});

describe("PlanningAnalysisTab — read-only", () => {
	const readerProps = {
		canEdit: false,
		effective: AI_EFFECTIVE,
		aiVersion: 1,
		revisionVersion: 2,
		sourceAnalysisVersion: 1,
		author: { id: "u-1", name: "Alex Rivera" },
		latestAttempt: ready(),
	};

	it("shows the document and its history but no way to change it", () => {
		renderTab(readerProps);

		expect(screen.getByTestId("editor-prose")).toHaveTextContent(
			/an engineering reliability story/i,
		);
		// Reading history is gated on PUBLISHING_TOPIC_READ, so it stays.
		expect(
			screen.getByRole("button", { name: /history/i }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /regenerate/i }),
		).not.toBeInTheDocument();
		expect(editorProps.current).toMatchObject({ canEdit: false });
	});
});

/**
 * The analysis says when it is behind the decisions it asked for (A4).
 *
 * Feature Maturation shows "N new decisions recorded — not yet in the Full
 * Specification" with an Update action. Publishing had the data and said
 * nothing: a question stores the analysis version it was RAISED against, so a
 * RESOLVED question still carrying the CURRENT version was answered after the
 * document was written, and the document does not know.
 *
 * The action is the Regenerate button already in this header, so the banner
 * points at it rather than adding a second control that does the same thing.
 */
describe("PlanningAnalysisTab — answers the analysis predates", () => {
	const answered = (analysisVersion: number) => ({
		root: {
			id: `d-${analysisVersion}-${Math.random()}`,
			parentId: null,
			kind: "QUESTION" as const,
			status: "RESOLVED",
			authorType: "AGENT" as const,
			authorUserId: null,
			questionId: "q1",
			decisionKind: "CONTENT_TYPE",
			subject: null,
			summary: "Should we produce a Blog Post for this topic?",
			content: null,
			recommendedResponse: null,
			whyItMatters: null,
			answerSource: "MANUAL",
			analysisVersion,
			createdAt: new Date(),
		},
		replies: [],
	});

	it("says so when an answer landed after the current analysis", () => {
		renderTab({ aiVersion: 2, decisionThreads: [answered(2)] });

		expect(
			screen.getByTestId("analysis-behind-decisions"),
		).toHaveTextContent(/1 answer was recorded after this analysis/i);
	});

	it("stays quiet once the analysis has been regenerated past them", () => {
		// The question was raised against version 1 and answered; version 2 was
		// written afterwards, so it already knows.
		renderTab({ aiVersion: 2, decisionThreads: [answered(1)] });

		expect(
			screen.queryByTestId("analysis-behind-decisions"),
		).not.toBeInTheDocument();
	});

	it("does not count a question nobody has answered", () => {
		const open = answered(2);
		renderTab({
			aiVersion: 2,
			decisionThreads: [
				{ ...open, root: { ...open.root, status: "OPEN" } },
			],
		});

		expect(
			screen.queryByTestId("analysis-behind-decisions"),
		).not.toBeInTheDocument();
	});
});
