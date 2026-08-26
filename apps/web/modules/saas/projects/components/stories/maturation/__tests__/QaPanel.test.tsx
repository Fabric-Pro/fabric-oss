/**
 * QaPanel — the maturation editor's QA tab.
 *
 * Asserts the composition contract: real TestCase rows joined to parsed
 * acceptance criteria (matrix + unmapped bucket), analysis sections rendered
 * from the persisted payload, warnings surfaced before anyone relies on the
 * drafted cases, and generation strictly button-triggered (draft goes through
 * the existing `testCases.aiDraft` pipeline with THIS story only).
 *
 * next-intl is globally key-mocked in vitest.setup.ts (labels === keys).
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.fn();
const useInfiniteQueryMock = vi.fn();
const useMutationMock = vi.fn();
const draftMutateSpy = vi.fn();
const analysisMutateSpy = vi.fn();

vi.mock("@tanstack/react-query", () => ({
	useQuery: (...args: unknown[]) => useQueryMock(...args),
	useInfiniteQuery: (...args: unknown[]) => useInfiniteQueryMock(...args),
	useMutation: (...args: unknown[]) => useMutationMock(...args),
	useQueryClient: () => ({
		invalidateQueries: vi.fn(),
		setQueryData: vi.fn(),
	}),
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("next/navigation", () => ({
	usePathname: () => "/app/acme/projects/p1/stories/s1",
}));

// The watcher owns its own polling/toasts and is exercised in the test-cases
// suite; here it must simply mount without dragging its queries in.
vi.mock("../../../test-cases/TestCaseDraftJobWatcher", () => ({
	TestCaseDraftJobWatcher: () => null,
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			// Per-feature "Run tests" (mocks B5) renders the run-configuration
			// dialog, which queries these as soon as the panel mounts — so the
			// mock needs them even for tests that never press the button.
			agenticRuns: {
				dispatch: { mutationOptions: (o: unknown) => o },
				list: { key: () => ["agenticRuns"] },
				get: {
					queryOptions: (o: unknown) => ({
						...(o as object),
						__key: "agenticRunDetail",
					}),
					key: () => ["agenticRunDetail"],
				},
				cancel: { mutationOptions: (o: unknown) => o },
				configurations: {
					list: {
						queryOptions: (o: unknown) => ({
							...(o as object),
							__key: "runConfigurations",
						}),
						key: () => ["runConfigurations"],
					},
					create: { mutationOptions: (o: unknown) => o },
				},
			},
			environments: {
				list: {
					queryOptions: (o: unknown) => ({
						...(o as object),
						__key: "environments",
					}),
				},
			},
			testCases: {
				list: {
					// The cases fetch is offset-paginated (same recipe as
					// TestCasesList) — the component consumes infiniteOptions.
					infiniteOptions: (opts: unknown) => ({
						...(opts as object),
						__key: "cases",
					}),
					// Invalidated by the pipeline "Sync now" mutation.
					key: () => ["cases"],
				},
				// Cases whose feature text changed after they were drafted, and
				// the per-case coverage detail behind the richer matrix. Both
				// are read by child components
				// this panel renders, so an absent branch here takes down the
				// whole panel render, not just its own section.
				drift: {
					list: {
						queryOptions: (opts: unknown) => ({
							...(opts as object),
							__key: "drift",
						}),
						key: () => ["drift"],
					},
					propose: { mutationOptions: (o: unknown) => o as object },
					// Read by the "revise from the implementation" control on
					// every row of the case list, so omitting it takes the whole
					// panel down exactly as the note above warns.
					proposeFromImplementation: {
						mutationOptions: (o: unknown) => o as object,
					},
					accept: { mutationOptions: (o: unknown) => o as object },
					reject: { mutationOptions: (o: unknown) => o as object },
				},
				coverageIndex: {
					get: {
						queryOptions: (opts: unknown) => ({
							...(opts as object),
							__key: "coverageIndex",
						}),
						key: () => ["coverageIndex"],
					},
					setType: { mutationOptions: (o: unknown) => o as object },
				},
				draftJobs: {
					list: {
						queryOptions: (opts: unknown) => ({
							...(opts as object),
							__key: "jobs",
						}),
						queryKey: () => ["jobs"],
						key: () => ["jobs"],
					},
					// QA-tab per-feature run history (QaHistorySection): the panel
					// preview uses queryOptions, the "View all" dialog pages via
					// infiniteOptions.
					forFeature: {
						queryOptions: (opts: unknown) => ({
							...(opts as object),
							__key: "draftRuns",
						}),
						infiniteOptions: (opts: unknown) => ({
							...(opts as object),
							__key: "draftRunsAll",
						}),
					},
				},
				aiDraft: { mutationOptions: (opts: unknown) => opts },
				// Used by the coverage-gap triage list to turn an untracked
				// automated test into a real case.
				create: { mutationOptions: (opts: unknown) => opts },
			},
			stories: {
				maturation: {
					getEditorState: { queryKey: () => ["editor-state"] },
					generateQaAnalysis: {
						mutationOptions: (opts: unknown) => opts,
					},
					// QA-analysis version history (QaHistorySection).
					qaAnalysisVersions: {
						queryOptions: (opts: unknown) => ({
							...(opts as object),
							__key: "analysisVersions",
						}),
						infiniteOptions: (opts: unknown) => ({
							...(opts as object),
							__key: "analysisVersionsAll",
						}),
					},
				},
			},
			// Pipeline results surface (PipelineRunsSection) — always rendered now
			// that the dark-launch flag was dropped, so the panel's own queries
			// must be mockable here.
			pipelineResults: {
				listRuns: {
					queryOptions: (opts: unknown) => ({
						...(opts as object),
						__key: "pipelineRuns",
					}),
					key: () => ["pipelineRuns"],
				},
				// Full run history — only fetched when the "View all" dialog opens,
				// but the hook is still constructed on every render.
				listRunsPage: {
					infiniteOptions: (opts: unknown) => ({
						...(opts as object),
						__key: "pipelineRunsPage",
					}),
					key: () => ["pipelineRunsPage"],
				},
				runDetail: {
					queryOptions: (opts: unknown) => ({
						...(opts as object),
						__key: "pipelineRunDetail",
					}),
					key: () => ["pipelineRunDetail"],
				},
				// Coverage-gap triage list — queried on every panel render.
				unmatchedTests: {
					queryOptions: (opts: unknown) => ({
						...(opts as object),
						__key: "unmatchedTests",
					}),
					key: () => ["unmatchedTests"],
				},
				syncStates: {
					queryOptions: (opts: unknown) => ({
						...(opts as object),
						__key: "pipelineSyncStates",
					}),
					key: () => ["pipelineSyncStates"],
				},
				// Why an empty run list is empty — queried on every panel render
				// so the QA tab can explain an unsupported PM tool rather than
				// showing the same neutral box it shows for "nothing connected".
				sources: {
					queryOptions: (opts: unknown) => ({
						...(opts as object),
						__key: "pipelineSources",
					}),
					key: () => ["pipelineSources"],
				},
				sync: { mutationOptions: (opts: unknown) => opts },
				// "Run tests" — the trigger dialog is mounted (closed) with the
				// panel, so its query options are constructed on every render even
				// though the query itself only runs once the dialog opens.
				triggerable: {
					queryOptions: (opts: unknown) => ({
						...(opts as object),
						__key: "triggerablePipelines",
					}),
					key: () => ["triggerablePipelines"],
				},
				trigger: { mutationOptions: (opts: unknown) => opts },
				// Findings — the panel renders them below the runs list.
				findings: {
					queryOptions: (opts: unknown) => ({
						...(opts as object),
						__key: "qaFindings",
					}),
					key: () => ["qaFindings"],
				},
				promoteFinding: { mutationOptions: (opts: unknown) => opts },
				// "Analyse" on a finding row. Mounted with the
				// findings list, so its mutation options are constructed on
				// every render even when nobody clicks.
				analyseFinding: { mutationOptions: (opts: unknown) => opts },
				// Dismiss and merge are constructed on every render for the same
				// reason as Analyse above — the findings list mounts them whether
				// or not anyone selects a row.
				dismissFinding: { mutationOptions: (opts: unknown) => opts },
				mergeFindings: { mutationOptions: (opts: unknown) => opts },
			},
		},
	},
}));

import { QaPanel } from "../QaPanel";

type CaseRow = {
	id: string;
	identifier: string;
	title: string;
	state: string;
	currentResult: string;
	workItemLinks: {
		userStoryId: string;
		acceptanceCriterionRefs: string[];
	}[];
};

let casesData: { items: CaseRow[] } | undefined;
let jobsData: { jobs: { id: string; status: string }[] } | undefined;

function mkCase(
	id: string,
	identifier: string,
	ref: string | null,
	overrides: Partial<CaseRow> = {},
): CaseRow {
	return {
		id,
		identifier,
		title: `Case ${identifier}`,
		state: "DRAFT",
		currentResult: "NOT_RUN",
		workItemLinks: [
			{ userStoryId: "s1", acceptanceCriterionRefs: ref ? [ref] : [] },
		],
		...overrides,
	};
}

/** Untracked automated tests backing the coverage-gap triage list. */
let unmatchedData: {
	tests: {
		name: string;
		classname: string | null;
		occurrences: number;
		lastStatus: string;
		lastSeenAt: string | null;
		provider: string;
	}[];
	totalDistinct: number;
	scannedRuns: number;
} = { tests: [], totalDistinct: 0, scannedRuns: 0 };
/** Per-source sync rows backing the panel's last-synced / failure banner. */
let syncStatesData: {
	status: string;
	lastError: string | null;
	lastFetchedAt: string | null;
}[] = [];
let casesError = false;
let casesHasNextPage = false;
const fetchNextPageSpy = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	casesData = { items: [] };
	jobsData = { jobs: [] };
	casesError = false;
	casesHasNextPage = false;
	syncStatesData = [];
	unmatchedData = { tests: [], totalDistinct: 0, scannedRuns: 0 };
	// Infinite queries, discriminated by the __key the orpc mock stamps on the
	// input: the cases list, plus the two "View all" history dialogs (which are
	// `enabled` only while open, so an empty page is the right idle shape).
	useInfiniteQueryMock.mockImplementation((opts: { __key?: string }) => {
		if (opts?.__key === "draftRunsAll") {
			return {
				data: { pages: [{ runs: [], total: 0 }] },
				isLoading: false,
				isError: false,
				hasNextPage: false,
				isFetchingNextPage: false,
				fetchNextPage: vi.fn(),
			};
		}
		if (opts?.__key === "analysisVersionsAll") {
			return {
				data: { pages: [{ versions: [], total: 0 }] },
				isLoading: false,
				isError: false,
				hasNextPage: false,
				isFetchingNextPage: false,
				fetchNextPage: vi.fn(),
			};
		}
		if (opts?.__key === "pipelineRunsPage") {
			return {
				data: { pages: [{ runs: [], total: 0 }] },
				isLoading: false,
				isError: false,
				hasNextPage: false,
				isFetchingNextPage: false,
				fetchNextPage: vi.fn(),
			};
		}
		// The cases fetch: pages of { items, total }. Tests keep setting the
		// flat `casesData.items`; the harness wraps it as page 0.
		return {
			data:
				casesError || !casesData
					? undefined
					: {
							pages: [
								{
									items: casesData.items,
									total:
										casesData.items.length +
										(casesHasNextPage ? 1 : 0),
								},
							],
						},
			isLoading: false,
			isError: casesError,
			refetch: vi.fn(),
			hasNextPage: casesHasNextPage,
			isFetchingNextPage: false,
			fetchNextPage: fetchNextPageSpy,
		};
	});
	// The draft-jobs list + the two history queries go through plain useQuery,
	// discriminated by the __key the orpc mock stamps on the input.
	useQueryMock.mockImplementation((opts: { __key?: string }) => {
		if (opts?.__key === "draftRuns") {
			return {
				data: { runs: [], total: 0 },
				isLoading: false,
				isError: false,
			};
		}
		if (opts?.__key === "analysisVersions") {
			return {
				data: { versions: [], total: 0 },
				isLoading: false,
				isError: false,
			};
		}
		if (opts?.__key === "pipelineSyncStates") {
			return { data: syncStatesData, isLoading: false, isError: false };
		}
		if (opts?.__key === "unmatchedTests") {
			return { data: unmatchedData, isLoading: false, isError: false };
		}
		if (opts?.__key === "pipelineRuns") {
			// An array; empty = the "no runs yet" idle shape.
			return { data: [], isLoading: false, isError: false };
		}
		if (opts?.__key === "qaFindings") {
			// An array. Empty = the section renders nothing at all, which is the
			// right answer for "no failures" — good news is not an empty state.
			return { data: [], isLoading: false, isError: false };
		}
		if (
			opts?.__key === "runConfigurations" ||
			opts?.__key === "environments"
		) {
			// Both are ARRAYS. Without this they fall through to the jobs OBJECT
			// below and the run dialog's `.map` throws during render, taking the
			// whole panel down — the same trap the triggerablePipelines branch
			// below exists to avoid.
			return { data: [], isLoading: false, isError: false };
		}
		if (opts?.__key === "triggerablePipelines") {
			// Also an array. Without this branch it falls through to the
			// jobs OBJECT below and the trigger dialog's `sources.find` throws
			// during render, taking the whole panel down with it.
			return { data: [], isLoading: false, isError: false };
		}
		return { data: jobsData, isLoading: false };
	});
	useMutationMock.mockImplementation((opts: { mutationFn?: unknown }) => {
		// First useMutation call in the component is the draft, second the
		// analysis — discriminated by call order.
		const isDraft = useMutationMock.mock.calls.length === 1;
		return {
			mutate: isDraft ? draftMutateSpy : analysisMutateSpy,
			isPending: false,
		};
	});
});

const baseProps = {
	projectId: "p1",
	storyId: "s1",
	organizationId: null as string | null,
	acceptanceCriteria: "- First criterion\n- Second criterion",
	qaAnalysis: null,
	qaAnalysisStale: false,
	qaStrategyLevel: "STANDARD" as const,
	// Schema defaults: generation on, standard ordering.
	generateManualTestCases: true,
	applyTddApproach: false,
};

const analysis = {
	warnings: [{ criterionRef: "AC 2", warning: "No error state defined." }],
	integrationNotes: "- integration bullet",
	e2eScenarios: "### E2E outline",
	depth: "STANDARD" as const,
	specHash: "abc",
	generatedAt: "2026-07-22T00:00:00.000Z",
};

describe("QaPanel — traceability matrix", () => {
	it("renders a row per criterion, joins cases by AC ref, and buckets unmapped", () => {
		casesData = {
			items: [
				mkCase("c1", "TC-001", "AC 1"),
				mkCase("c2", "TC-002", "AC 2"),
				mkCase("c3", "TC-003", null),
			],
		};
		render(<QaPanel {...baseProps} />);

		expect(screen.getByText("First criterion")).toBeInTheDocument();
		expect(screen.getByText("Second criterion")).toBeInTheDocument();
		// Chips appear in the matrix AND the cases list — assert presence, not count.
		expect(screen.getAllByText("TC-001").length).toBeGreaterThan(0);
		expect(screen.getAllByText("TC-002").length).toBeGreaterThan(0);
		// The ref-less case lands in the explicit unmapped bucket.
		expect(screen.getByText("unmappedHeading")).toBeInTheDocument();
		expect(screen.getAllByText("TC-003").length).toBeGreaterThan(0);
	});

	it("marks an uncovered criterion instead of hiding the row", () => {
		casesData = { items: [mkCase("c1", "TC-001", "AC 1")] };
		render(<QaPanel {...baseProps} />);
		expect(screen.getByText("uncovered")).toBeInTheDocument();
	});

	it("case chips deep-link into the project QA tab", () => {
		casesData = { items: [mkCase("c1", "TC-001", "AC 1")] };
		render(<QaPanel {...baseProps} />);
		const links = screen
			.getAllByRole("link")
			.map((a) => a.getAttribute("href"));
		expect(links).toContain("/app/acme/projects/p1?tab=test-cases&case=c1");
	});

	it("offers Load more and the truncation notice exactly when more pages exist", async () => {
		// Both key off hasNextPage — the notice can never point at a button
		// that isn't there.
		casesData = { items: [mkCase("c1", "TC-001", "AC 1")] };
		casesHasNextPage = true;
		render(<QaPanel {...baseProps} />);

		expect(screen.getByText("casesTruncated")).toBeInTheDocument();
		const button = screen.getByRole("button", {
			name: "actions.loadMore",
		});
		await userEvent.click(button);
		expect(fetchNextPageSpy).toHaveBeenCalled();
	});

	it("hides Load more and the notice once every page is loaded", () => {
		casesData = { items: [mkCase("c1", "TC-001", "AC 1")] };
		render(<QaPanel {...baseProps} />);

		expect(screen.queryByText("casesTruncated")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "actions.loadMore" }),
		).not.toBeInTheDocument();
	});

	it("never renders Load more beside the failed-load block", () => {
		// A failed fetch keeps hasNextPage true but must surface ONLY the
		// error block's Retry — two competing recovery actions would race.
		casesError = true;
		casesHasNextPage = true;
		render(<QaPanel {...baseProps} />);

		expect(screen.getAllByText("errors.listFailed").length).toBeGreaterThan(
			0,
		);
		expect(
			screen.queryByRole("button", { name: "actions.loadMore" }),
		).not.toBeInTheDocument();
	});
});

describe("QaPanel — pipeline sync banner", () => {
	const ok = {
		status: "OK",
		lastError: null,
		lastFetchedAt: "2026-07-25T10:00:00.000Z",
	};
	const failed = {
		status: "FAILED",
		lastError: "GitHub request failed (401)",
		lastFetchedAt: null,
	};

	it("reports a partial failure as synced-with-warning, not a failed sync", () => {
		// One broken source among several must not claim the whole sync failed —
		// the other sources ingested runs, and the panel said otherwise.
		syncStatesData = [ok, failed];
		render(<QaPanel {...baseProps} />);

		expect(screen.getByText("sourcePartialErrorTitle")).toBeInTheDocument();
		expect(screen.queryByText("sourceErrorTitle")).not.toBeInTheDocument();
	});

	it("reports a total failure as a failed sync", () => {
		syncStatesData = [failed];
		render(<QaPanel {...baseProps} />);

		expect(screen.getByText("sourceErrorTitle")).toBeInTheDocument();
		expect(
			screen.queryByText("sourcePartialErrorTitle"),
		).not.toBeInTheDocument();
	});

	it("reports plain last-synced when every source is healthy", () => {
		syncStatesData = [ok, ok];
		render(<QaPanel {...baseProps} />);

		expect(screen.getByText("lastSynced")).toBeInTheDocument();
		expect(
			screen.queryByText("sourcePartialErrorTitle"),
		).not.toBeInTheDocument();
	});
});

describe("QaPanel — analysis sections", () => {
	it("renders warnings, integration and E2E sections from the stored payload", () => {
		render(<QaPanel {...baseProps} qaAnalysis={analysis} />);
		expect(screen.getByText("warningsHeading")).toBeInTheDocument();
		expect(screen.getByText("No error state defined.")).toBeInTheDocument();
		expect(screen.getByText("integrationHeading")).toBeInTheDocument();
		expect(screen.getByText("e2eHeading")).toBeInTheDocument();
	});

	it("omits integration/E2E sections when the stored payload has them empty (LIGHT)", () => {
		render(
			<QaPanel
				{...baseProps}
				qaAnalysis={{
					...analysis,
					integrationNotes: "",
					e2eScenarios: "",
					depth: "LIGHT",
				}}
			/>,
		);
		expect(
			screen.queryByText("integrationHeading"),
		).not.toBeInTheDocument();
		expect(screen.queryByText("e2eHeading")).not.toBeInTheDocument();
		expect(screen.getByText("lightDepthNote")).toBeInTheDocument();
	});

	it("shows the staleness notice when the spec changed since generation", () => {
		render(
			<QaPanel {...baseProps} qaAnalysis={analysis} qaAnalysisStale />,
		);
		expect(screen.getByText("staleNotice")).toBeInTheDocument();
	});

	it("shows the depth-aware empty state before any analysis exists", () => {
		render(<QaPanel {...baseProps} qaStrategyLevel="LIGHT" />);
		expect(screen.getByText("analysisEmptyLight")).toBeInTheDocument();
	});
});

describe("QaPanel — generation is button-triggered only", () => {
	it("drafts through the existing pipeline scoped to THIS story", async () => {
		const user = userEvent.setup();
		render(<QaPanel {...baseProps} />);

		await user.click(screen.getByRole("button", { name: /draftCases/ }));
		expect(draftMutateSpy).toHaveBeenCalledWith({
			projectId: "p1",
			storyIds: ["s1"],
			organizationId: null,
		});
	});

	it("requests the analysis for this story on click", async () => {
		const user = userEvent.setup();
		render(<QaPanel {...baseProps} />);

		await user.click(
			screen.getByRole("button", { name: /generateAnalysis/ }),
		);
		expect(analysisMutateSpy).toHaveBeenCalledWith({
			projectId: "p1",
			storyId: "s1",
			organizationId: null,
		});
	});

	it("never fires either mutation on mount", () => {
		render(<QaPanel {...baseProps} />);
		expect(draftMutateSpy).not.toHaveBeenCalled();
		expect(analysisMutateSpy).not.toHaveBeenCalled();
	});

	it("disables drafting while a run is already in flight", () => {
		jobsData = { jobs: [{ id: "j1", status: "RUNNING" }] };
		render(<QaPanel {...baseProps} />);
		expect(screen.getByRole("button", { name: /drafting/ })).toBeDisabled();
	});

	it("renders the failed-load state (with retry), never a false 'no coverage' claim", () => {
		casesError = true;
		render(<QaPanel {...baseProps} />);
		// The shared error block renders in both the matrix and cases cards.
		expect(screen.getAllByText("errors.listFailed").length).toBe(2);
		expect(screen.getAllByText("errors.retry").length).toBe(2);
		expect(screen.queryByText("casesEmpty")).not.toBeInTheDocument();
		expect(screen.queryByText("uncovered")).not.toBeInTheDocument();
	});

	it("shows a loading spinner, not the no-criteria banner, while editor state hydrates", () => {
		render(<QaPanel {...baseProps} loading acceptanceCriteria={null} />);
		expect(screen.queryByText("noCriteria")).not.toBeInTheDocument();
		expect(screen.getByLabelText("loadingPanel")).toBeInTheDocument();
	});

	it("disables both generators when there are no acceptance criteria", () => {
		render(<QaPanel {...baseProps} acceptanceCriteria={null} />);
		expect(
			screen.getByRole("button", { name: /draftCases/ }),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: /generateAnalysis/ }),
		).toBeDisabled();
		expect(screen.getAllByText("noCriteria").length).toBeGreaterThan(0);
	});
});

describe("QaPanel — generation settings", () => {
	it("shows the standard-ordering note by default", () => {
		render(<QaPanel {...baseProps} />);
		expect(screen.getByText("flowStandard")).toBeInTheDocument();
		expect(screen.queryByText("flowTdd")).not.toBeInTheDocument();
	});

	it("shows the TDD-ordering note when the project applies TDD", () => {
		render(<QaPanel {...baseProps} applyTddApproach />);
		expect(screen.getByText("flowTdd")).toBeInTheDocument();
		expect(screen.queryByText("flowStandard")).not.toBeInTheDocument();
	});

	it("disables drafting and shows the off-notice when generation is turned off", () => {
		// The project switch is authoritative — the button is disabled (the
		// server would reject anyway) and the panel says why. The flow note is
		// replaced by the off-notice since ordering is moot while generation is off.
		render(<QaPanel {...baseProps} generateManualTestCases={false} />);
		expect(
			screen.getByRole("button", { name: /draftCases/ }),
		).toBeDisabled();
		expect(screen.getByText("generationOffNotice")).toBeInTheDocument();
		expect(screen.queryByText("flowStandard")).not.toBeInTheDocument();
		expect(screen.queryByText("flowTdd")).not.toBeInTheDocument();
	});

	it("still lets the QA analysis run while generation is off (only drafting is gated)", () => {
		// Turning off manual test-case generation must not disable the separate
		// analysis pass — they are independent billable actions.
		render(<QaPanel {...baseProps} generateManualTestCases={false} />);
		expect(
			screen.getByRole("button", { name: /generateAnalysis/ }),
		).not.toBeDisabled();
	});
});

describe("QaPanel — runs are scoped to THIS feature", () => {
	/** The input the pipeline-runs query was actually constructed with. */
	function runsQueryInput() {
		const call = useQueryMock.mock.calls.find(
			(c) => (c[0] as { __key?: string })?.__key === "pipelineRuns",
		);
		return (call?.[0] as { input?: Record<string, unknown> })?.input;
	}

	it("asks only for the runs that touched this feature", () => {
		// UC1 is "open a feature → see ITS results". Without the storyId the tab
		// listed every run in the project, so a feature with no automated
		// coverage looked identically busy to one with full coverage.
		render(<QaPanel {...baseProps} />);

		expect(runsQueryInput()).toMatchObject({
			projectId: "p1",
			storyId: "s1",
		});
	});

	it("scopes the failure list to this feature too", () => {
		// Scoping the runs but not the findings is worse than scoping neither:
		// the list says nothing tested this feature and a dozen unrelated red
		// rows sit directly underneath it.
		render(<QaPanel {...baseProps} />);

		const call = useQueryMock.mock.calls.find(
			(c) => (c[0] as { __key?: string })?.__key === "qaFindings",
		);
		expect(
			(call?.[0] as { input?: Record<string, unknown> })?.input,
		).toMatchObject({ projectId: "p1", storyId: "s1" });
	});

	it("does not query untracked project tests at all on a feature tab", () => {
		// A test Fabric tracks no case for has no feature to belong to, so there
		// is nothing to scope. Omitted rather than shown project-wide: a
		// project's untriaged tests listed under one feature reads as that
		// feature's problem.
		render(<QaPanel {...baseProps} />);

		expect(
			useQueryMock.mock.calls.some(
				(c) => (c[0] as { __key?: string })?.__key === "unmatchedTests",
			),
		).toBe(false);
	});

	it("says nothing tests this feature yet — not 'no runs in the project'", () => {
		// The mocked query returns [], and the two empty states are NOT
		// interchangeable: one is a project that has never synced CI, the other
		// is a feature nobody has covered. Conflating them is the bug.
		render(<QaPanel {...baseProps} />);

		expect(screen.getByText("emptyForFeature")).toBeInTheDocument();
		expect(screen.queryByText("empty")).not.toBeInTheDocument();
	});
});

/**
 * The test-first ordering, made visible.
 *
 * Both of these were real behaviours with no on-screen evidence: the review
 * read the drafted cases, and some warnings existed BECAUSE writing those cases
 * exposed them. With test-first on and off the panel rendered identically, so
 * QA marked both steps unverified — correctly, because there was nothing to
 * observe.
 */
describe("QaPanel — test-first evidence", () => {
	it("says how many test cases the review read", () => {
		render(
			<QaPanel
				{...baseProps}
				applyTddApproach
				qaAnalysis={{ ...analysis, reviewedAgainstCaseCount: 3 }}
			/>,
		);
		expect(screen.getByText(/reviewedAgainstCases/)).toBeInTheDocument();
	});

	it("says nothing about cases read when the analysis did not record a count", () => {
		// The standard flow reads none by design — an absent count must not
		// render as "reviewed against 0 test cases", which reads as a failure.
		render(<QaPanel {...baseProps} qaAnalysis={analysis} />);
		expect(
			screen.queryByText(/reviewedAgainstCases/),
		).not.toBeInTheDocument();
	});

	it("marks a warning that writing the cases exposed", () => {
		render(
			<QaPanel
				{...baseProps}
				applyTddApproach
				qaAnalysis={{
					...analysis,
					warnings: [
						{
							criterionRef: "AC 2",
							warning: "No error state defined.",
							fromDraftedCases: true,
						},
					],
				}}
			/>,
		);
		expect(screen.getByText("draftingRevealed")).toBeInTheDocument();
	});

	it("leaves an ordinary warning unmarked", () => {
		render(<QaPanel {...baseProps} qaAnalysis={analysis} />);
		expect(screen.getByText("No error state defined.")).toBeInTheDocument();
		expect(screen.queryByText("draftingRevealed")).not.toBeInTheDocument();
	});
});

/**
 * The analysis button spends a second AI generation on standard ordering,
 * because completing the review is what drafts the cases. Its tooltip said
 * "uses one AI generation" and nothing else, which is the kind of surprise that
 * makes people stop trusting a button.
 */
describe("QaPanel — analysis button discloses the drafting cost", () => {
	/** Radix renders tooltip content only while open, so hover it first. */
	async function hoverAnalysis() {
		const user = userEvent.setup();
		await user.hover(
			screen.getByRole("button", { name: /generateAnalysis/ }),
		);
	}

	it("says the review also drafts, on a standard-ordering project", async () => {
		render(<QaPanel {...baseProps} />);
		await hoverAnalysis();
		// Radix mirrors tooltip content into an accessible copy, so this
		// legitimately matches more than once.
		expect(
			(await screen.findAllByText("info.analysisAlsoDrafts")).length,
		).toBeGreaterThan(0);
	});

	it("says nothing extra under test-first, where the cases already exist", async () => {
		render(<QaPanel {...baseProps} applyTddApproach />);
		await hoverAnalysis();
		// The base tooltip still opens; only the extra sentence is absent.
		expect(
			(await screen.findAllByText(/info\.analysis$/)).length,
		).toBeGreaterThan(0);
		expect(
			screen.queryByText("info.analysisAlsoDrafts"),
		).not.toBeInTheDocument();
	});

	it("says nothing extra when generation is switched off", async () => {
		// No drafting can follow, so the disclosure would be a lie.
		render(<QaPanel {...baseProps} generateManualTestCases={false} />);
		await hoverAnalysis();
		expect(
			screen.queryByText("info.analysisAlsoDrafts"),
		).not.toBeInTheDocument();
	});
});
