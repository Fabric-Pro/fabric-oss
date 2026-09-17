/**
 * AnalysisVersionHistory — the version-history drawer for a topic's Planning
 * & Analysis prose (Fizzy #1851, Task 10).
 *
 * The behaviour that makes this component correct: restoring a revision
 * writes a NEW revision through the same save path, and that new revision
 * COPIES the restored row's `sourceAnalysisVersion` rather than adopting
 * `currentVersion`'s own source. The fixture below is built so this is not
 * an accident of the data: `CURRENT_REVISION` (the row matching the
 * `currentVersion` prop) is seeded from AI v2, while `RESTORABLE_REVISION`
 * (the one under test) is seeded from AI v1. If a restore wrongly copied the
 * CURRENT revision's `sourceAnalysisVersion` instead of the restored one's,
 * the assertions below would see `2`, not `1`, and fail — a fixture where
 * both rows carried the same `sourceAnalysisVersion` would let that bug
 * through silently.
 *
 * ── The drawer now reads TWO queries ────────────────────────────────────────
 *
 * What is DISPLAYED comes from `listAnalysisTimeline`: one dense sequence
 * numbering AI runs and hand-saved revisions together, because two independent
 * counters made a first manual save after six AI runs read as "Version 1 · AI
 * v6". That read carries no bodies, so `listAnalysisRevisions` stays as the
 * source of `body` and `authorUserId`, joined on the stored `revisionVersion`.
 *
 * Both are `useInfiniteQuery`, so the mock below discriminates them on the
 * `queryKey` their `infiniteOptions()` stamps. A mock that served one state to
 * both would make every list assertion here meaningless.
 *
 * ── Why the fixture's numbers are all different ─────────────────────────────
 *
 * `seq` IS DISPLAY ONLY — no write accepts it. The restorable entry therefore
 * carries FOUR distinct numbers on purpose: seq 5, revisionVersion 2,
 * sourceAnalysisVersion 1, against a `currentVersion` prop of 3. If any two of
 * those coincided, a restore that wrongly sent `seq` as `expectedVersion` or as
 * `sourceAnalysisVersion` would still satisfy the assertion and ship.
 *
 * `VersionDiffViewer` is mocked: it is an existing, separately-tested
 * component (`@saas/projects/components/VersionDiffViewer`) this task reuses
 * rather than rebuilds, and mounting its real TipTap/diff machinery in jsdom
 * is neither needed nor reliable for a test of THIS component's own
 * list/restore wiring. `Sheet`/`Dialog`/`Badge`/`ScrollArea`/`Button` are
 * plain UI atoms and are rendered for real, the same way
 * `CoverageOverrideDialog.test.tsx` renders a real `Dialog`.
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

const { diffViewerPropsRef } = vi.hoisted(() => ({
	diffViewerPropsRef: {
		current: null as Record<string, unknown> | null,
	},
}));
vi.mock("@saas/projects/components/VersionDiffViewer", () => ({
	VersionDiffViewer: (props: Record<string, unknown>) => {
		diffViewerPropsRef.current = props;
		return <div data-testid="version-diff-viewer-stub" />;
	},
}));

const { saveMutationMock, mutationState, capturedMutationOptionsRef } =
	vi.hoisted(() => ({
		saveMutationMock: vi.fn(),
		mutationState: { isPending: false },
		capturedMutationOptionsRef: {
			current: null as {
				onSuccess?: (result: unknown) => void;
				onError?: (error: unknown) => void;
			} | null,
		},
	}));

const {
	queryStateRef,
	timelineStateRef,
	invalidateQueriesMock,
	fetchNextPageMock,
	fetchNextTimelinePageMock,
} = vi.hoisted(() => ({
	queryStateRef: {
		current: {
			data: undefined as
				| {
						pages: {
							revisions: unknown[];
							nextCursor: number | null;
						}[];
				  }
				| undefined,
			isLoading: false,
			hasNextPage: false,
			isFetchingNextPage: false,
			fetchNextPage: () => {},
		},
	},
	timelineStateRef: {
		current: {
			data: undefined as
				| {
						pages: {
							entries: unknown[];
							nextCursor: number | null;
						}[];
				  }
				| undefined,
			isLoading: false,
			hasNextPage: false,
			isFetchingNextPage: false,
			fetchNextPage: () => {},
		},
	},
	invalidateQueriesMock: vi.fn(),
	fetchNextPageMock: vi.fn(),
	fetchNextTimelinePageMock: vi.fn(),
}));

/**
 * Wrap rows as the single first page of an infinite query.
 *
 * Helpers rather than literals at each site so a test that cares only about a
 * row does not have to restate the paging shape, and so the shape lives in one
 * place when it changes again.
 */
function onePage(revisions: unknown[], nextCursor: number | null = null) {
	return { pages: [{ revisions, nextCursor }] };
}

function oneTimelinePage(entries: unknown[], nextCursor: number | null = null) {
	return { pages: [{ entries, nextCursor }] };
}

// Discriminated on the key the component's own `infiniteOptions()` stamps —
// the drawer runs two infinite queries and they must not see each other's
// state. The spread in `{...infiniteOptions({...}), enabled: open}` is what
// makes `queryKey` readable here.
vi.mock("@tanstack/react-query", () => ({
	useInfiniteQuery: (opts: { queryKey?: unknown[] }) =>
		Array.isArray(opts?.queryKey) &&
		opts.queryKey[0] === "listAnalysisTimeline"
			? timelineStateRef.current
			: queryStateRef.current,
	useMutation: (opts: {
		onSuccess?: (result: unknown) => void;
		onError?: (error: unknown) => void;
	}) => {
		capturedMutationOptionsRef.current = opts;
		return {
			mutate: (vars: unknown) => {
				saveMutationMock(vars);
			},
			isPending: mutationState.isPending,
		};
	},
	useQueryClient: () => ({ invalidateQueries: invalidateQueriesMock }),
}));

// Spies (not plain functions) so a test can read back what the drawer's own
// list query actually registered, instead of hand-typing a second literal to
// compare against — see the "invalidates the list by the same topic the list
// query read" test below. One set per query, so `.at(-1)` on either is
// unambiguous now that there are two.
const { orpcSpies, timelineSpies } = vi.hoisted(() => ({
	orpcSpies: {
		infiniteOptions: vi.fn((o: Record<string, unknown>) => ({
			queryKey: ["listAnalysisRevisions", o],
			queryFn: vi.fn(),
		})),
		key: vi.fn((o: Record<string, unknown>) => [
			"listAnalysisRevisions",
			o,
		]),
	},
	timelineSpies: {
		infiniteOptions: vi.fn((o: Record<string, unknown>) => ({
			queryKey: ["listAnalysisTimeline", o],
			queryFn: vi.fn(),
		})),
		key: vi.fn((o: Record<string, unknown>) => ["listAnalysisTimeline", o]),
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			publishingSuite: {
				listAnalysisRevisions: {
					infiniteOptions: orpcSpies.infiniteOptions,
					// `key`, not `queryKey`: the drawer must invalidate with
					// the PARTIAL form, because the exact form stamps
					// `type: "query"` and would miss an infinite entry. A
					// mock exposing `queryKey` here would let that regression
					// back in without a red test.
					key: orpcSpies.key,
				},
				listAnalysisTimeline: {
					infiniteOptions: timelineSpies.infiniteOptions,
					key: timelineSpies.key,
				},
				saveAnalysisRevision: {
					mutationOptions: (o: Record<string, unknown>) => ({
						mutationKey: ["saveAnalysisRevision"],
						...o,
					}),
				},
			},
		},
	},
}));

import { AnalysisVersionHistory } from "@saas/projects/components/publishing-suite/AnalysisVersionHistory";
import { toast } from "sonner";

const CURRENT_REVISION = {
	id: "rev-3",
	version: 3,
	body: "current body text",
	sourceAnalysisVersion: 2,
	changeSummary: null,
	authorUserId: "user-1",
	author: { id: "user-1", name: "Ada Lovelace" },
	createdAt: "2026-09-05T00:00:00.000Z",
};

const RESTORABLE_REVISION = {
	id: "rev-2",
	version: 2,
	body: "version two text",
	sourceAnalysisVersion: 1,
	changeSummary: "Initial hand edit",
	authorUserId: null,
	author: null as { id: string; name: string } | null,
	createdAt: "2026-09-03T00:00:00.000Z",
};

const OLDEST_REVISION = {
	id: "rev-1",
	version: 1,
	body: "version one text",
	sourceAnalysisVersion: 1,
	changeSummary: "First draft",
	authorUserId: null,
	author: null as { id: string; name: string } | null,
	createdAt: "2026-08-02T00:00:00.000Z",
};

const ALL_REVISIONS = [CURRENT_REVISION, RESTORABLE_REVISION, OLDEST_REVISION];

/**
 * The unified sequence, newest first, exactly as the server returns it.
 *
 * Seven entries interleaving four AI runs with three saved revisions, so the
 * numbering can only be right if it comes from `seq` — the stored scales here
 * are 1..4 and 1..3, and neither reproduces 1..7.
 */
const CURRENT_ENTRY = {
	kind: "revision" as const,
	seq: 7,
	revisionId: "rev-3",
	revisionVersion: 3,
	sourceAnalysisVersion: 2,
	sourceSeq: 3,
	changeSummary: null,
	createdAt: "2026-09-05T00:00:00.000Z",
	author: { id: "user-1", name: "Ada Lovelace" },
};

const GENERATING_ENTRY = {
	kind: "ai_run" as const,
	seq: 6,
	analysisId: "an-4",
	analysisVersion: 4,
	status: "GENERATING",
	createdAt: "2026-09-04T00:00:00.000Z",
	requestedBy: { id: "user-1", name: "Ada Lovelace" },
};

const RESTORABLE_ENTRY = {
	kind: "revision" as const,
	seq: 5,
	revisionId: "rev-2",
	revisionVersion: 2,
	sourceAnalysisVersion: 1,
	sourceSeq: 1,
	changeSummary: "Initial hand edit",
	createdAt: "2026-09-03T00:00:00.000Z",
	author: null as { id: string; name: string } | null,
};

const FAILED_ENTRY = {
	kind: "ai_run" as const,
	seq: 4,
	analysisId: "an-3",
	analysisVersion: 3,
	status: "FAILED",
	createdAt: "2026-09-02T00:00:00.000Z",
	requestedBy: null as { id: string; name: string } | null,
};

const READY_ENTRY = {
	kind: "ai_run" as const,
	seq: 3,
	analysisId: "an-2",
	analysisVersion: 2,
	status: "READY",
	createdAt: "2026-09-01T00:00:00.000Z",
	requestedBy: { id: "user-1", name: "Ada Lovelace" },
};

const OLDEST_ENTRY = {
	kind: "revision" as const,
	seq: 2,
	revisionId: "rev-1",
	revisionVersion: 1,
	sourceAnalysisVersion: 1,
	sourceSeq: 1,
	changeSummary: "First draft",
	createdAt: "2026-08-02T00:00:00.000Z",
	author: null as { id: string; name: string } | null,
};

const FIRST_RUN_ENTRY = {
	kind: "ai_run" as const,
	seq: 1,
	analysisId: "an-1",
	analysisVersion: 1,
	status: "READY",
	createdAt: "2026-08-01T00:00:00.000Z",
	requestedBy: null as { id: string; name: string } | null,
};

const ALL_ENTRIES = [
	CURRENT_ENTRY,
	GENERATING_ENTRY,
	RESTORABLE_ENTRY,
	FAILED_ENTRY,
	READY_ENTRY,
	OLDEST_ENTRY,
	FIRST_RUN_ENTRY,
];

const baseProps = {
	open: true,
	onOpenChange: vi.fn(),
	projectId: "proj-1",
	topicId: "topic-1",
	organizationId: null as string | null,
	currentVersion: 3 as number | null,
};

beforeEach(() => {
	vi.clearAllMocks();
	mutationState.isPending = false;
	capturedMutationOptionsRef.current = null;
	diffViewerPropsRef.current = null;
	queryStateRef.current = {
		data: onePage(ALL_REVISIONS),
		isLoading: false,
		hasNextPage: false,
		isFetchingNextPage: false,
		fetchNextPage: fetchNextPageMock,
	};
	timelineStateRef.current = {
		data: oneTimelinePage(ALL_ENTRIES),
		isLoading: false,
		hasNextPage: false,
		isFetchingNextPage: false,
		fetchNextPage: fetchNextTimelinePageMock,
	};
});

describe("AnalysisVersionHistory — one sequence across both kinds of entry", () => {
	it("numbers AI runs and saved revisions together, newest first", () => {
		// The complaint this fixes: two counters, so a first manual save after
		// six AI runs displayed as "Version 1". Neither stored scale here
		// (1..4 AI, 1..3 revisions) can produce 7..1.
		//
		// The anchored `^v\d+$` matches only the row's own number. The
		// provenance badge beside it reads "From v1", so it stays out of this
		// list — if that badge ever renders a bare "v1" it would join the
		// sequence here silently, and this assertion is what would go red.
		render(<AnalysisVersionHistory {...baseProps} />);

		expect(
			screen.getAllByText(/^v\d+$/).map((el) => el.textContent),
		).toEqual(["v7", "v6", "v5", "v4", "v3", "v2", "v1"]);
	});

	it("shows an AI run's provenance on the same scale as the list", () => {
		// `sourceSeq`, not the stored `sourceAnalysisVersion` — the badge sits
		// beside a `seq`, so a raw stored number there is the original bug in
		// miniature.
		render(<AnalysisVersionHistory {...baseProps} />);

		expect(screen.getAllByText(/^From v1$/).length).toBeGreaterThan(0);
	});

	it("omits the provenance badge when the referenced run is not present", () => {
		// The server sends `sourceSeq: null` for exactly this case, because a
		// wrong number is worse than an absent one.
		timelineStateRef.current = {
			...timelineStateRef.current,
			data: oneTimelinePage([{ ...RESTORABLE_ENTRY, sourceSeq: null }]),
		};
		render(<AnalysisVersionHistory {...baseProps} />);

		expect(screen.queryByText(/^From v/)).toBeNull();
		// The row itself is still there — only the badge is withheld.
		expect(screen.getByText("v5")).toBeInTheDocument();
	});
});

describe("AnalysisVersionHistory — AI runs occupy a number but are not restorable", () => {
	it("reads a failed run as failed rather than as a version to go back to", () => {
		render(<AnalysisVersionHistory {...baseProps} />);

		expect(screen.getByText("v4")).toBeInTheDocument();
		// The badge, matched exactly — the sentence below it also says
		// "failed", and a loose regex here would pass on either alone.
		expect(screen.getByText("Failed")).toBeInTheDocument();
		expect(screen.getByText(/keeps its number/i)).toBeInTheDocument();
	});

	it("offers no restore on a failed run", () => {
		// A failed run has no prose in this drawer's tables at all, so a
		// Restore here could only fail — and offering it is what the reader
		// would reasonably click first.
		render(<AnalysisVersionHistory {...baseProps} />);

		// Exactly the two non-current REVISIONS, never the four AI runs.
		expect(
			screen.getAllByRole("button", { name: /^restore$/i }),
		).toHaveLength(2);
	});

	it("makes no AI run row a control, whatever its status", () => {
		// Not only the failed one: a READY run is just as unrestorable here,
		// because its prose lives in a table this drawer's diff and restore
		// paths never read.
		render(<AnalysisVersionHistory {...baseProps} />);

		for (const seq of [6, 4, 3, 1]) {
			expect(
				screen.queryByRole("button", {
					name: new RegExp(`compare version ${seq}\\b`, "i"),
				}),
			).toBeNull();
		}
		// …while the revisions beside them are.
		expect(
			screen.getByRole("button", { name: /compare version 5/i }),
		).toBeInTheDocument();
	});

	it("says a run is still generating rather than leaving the row blank", () => {
		render(<AnalysisVersionHistory {...baseProps} />);

		expect(screen.getByText(/still generating/i)).toBeInTheDocument();
	});

	it("does not open the compare view when an AI run row is clicked", async () => {
		render(<AnalysisVersionHistory {...baseProps} />);

		await userEvent.click(screen.getByText("v4"));

		expect(
			screen.queryByTestId("version-diff-viewer-stub"),
		).not.toBeInTheDocument();
	});
});

describe("AnalysisVersionHistory — restore keeps the restored body's own source version", () => {
	it("restores by writing a new revision that keeps the old source version", async () => {
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		await userEvent.click(
			screen.getAllByRole("button", { name: /^restore$/i })[0],
		);
		await userEvent.click(screen.getByRole("button", { name: /confirm/i }));

		expect(saveMutationMock).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				topicId: "topic-1",
				organizationId: null,
				// The `currentVersion` PROP, on the stored revision scale.
				expectedVersion: 3,
				// The restored entry's STORED source, not its `sourceSeq` twin
				// (1 here too by construction of the data, but read from the
				// field the server documents as the write token) and not the
				// current revision's own source, which is 2.
				sourceAnalysisVersion: 1,
				// Merged off the revisions read — the timeline carries no body.
				body: "version two text",
			}),
		);
	});

	it("sends no write token that is the display sequence", async () => {
		// The one assertion that proves `seq` stayed display-only. The
		// restorable entry is seq 5 while its stored numbers are 2 and 1 and
		// the current version is 3, so a payload containing 5 anywhere means a
		// projection leaked into a write.
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		await userEvent.click(
			screen.getAllByRole("button", { name: /^restore$/i })[0],
		);
		await userEvent.click(screen.getByRole("button", { name: /confirm/i }));

		const payload = saveMutationMock.mock.calls.at(-1)?.[0] as Record<
			string,
			unknown
		>;
		for (const [field, value] of Object.entries(payload)) {
			// `changeSummary` is prose, not a reference — it is the one place
			// the unified number is allowed to reach the database, and it is
			// asserted positively in the test below.
			if (field === "changeSummary") {
				continue;
			}
			expect(value).not.toBe(RESTORABLE_ENTRY.seq);
		}
	});

	it("writes the summary with the number the reader actually saw", async () => {
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		await userEvent.click(
			screen.getAllByRole("button", { name: /^restore$/i })[0],
		);
		await userEvent.click(screen.getByRole("button", { name: /confirm/i }));

		expect(saveMutationMock).toHaveBeenCalledWith(
			expect.objectContaining({
				changeSummary: "Restored from version 5",
			}),
		);
	});

	it("names the version on the unified scale in the confirmation", async () => {
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		await userEvent.click(
			screen.getAllByRole("button", { name: /^restore$/i })[0],
		);

		expect(
			screen.getByRole("heading", { name: /restore version 5\?/i }),
		).toBeInTheDocument();
	});
});

describe("AnalysisVersionHistory — current revision", () => {
	it("does not offer Restore for the current revision, only for older ones", () => {
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		// Matched on the STORED `revisionVersion`, which is what the prop
		// carries — an `ai_run` entry has no such field, and comparing without
		// a `kind` guard would read `undefined` on every AI row.
		expect(screen.getByText("Current")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /compare version 7/i }),
		).toBeInTheDocument();
	});
});

describe("AnalysisVersionHistory — a row whose body has not arrived", () => {
	it("still holds its number, but offers neither Compare nor Restore", () => {
		// The two reads page independently. A revision entry the bodies page
		// has not reached yet must not be a control that would read
		// `undefined.body`.
		queryStateRef.current = {
			...queryStateRef.current,
			data: onePage([CURRENT_REVISION]),
		};
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		expect(screen.getByText("v5")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /compare version 5/i }),
		).toBeNull();
		expect(
			screen.queryAllByRole("button", { name: /^restore$/i }),
		).toHaveLength(0);
	});
});

describe("AnalysisVersionHistory — author fallback", () => {
	it("renders 'Unknown author' for a revision with no resolved author, without hiding the row", () => {
		render(<AnalysisVersionHistory {...baseProps} />);

		// The row itself (its version number and change summary) is still
		// there — only the author name is substituted.
		expect(screen.getByText("v5")).toBeInTheDocument();
		expect(screen.getByText("Initial hand edit")).toBeInTheDocument();
		expect(screen.getAllByText("Unknown author").length).toBeGreaterThan(0);
	});
});

describe("AnalysisVersionHistory — empty state", () => {
	it("shows an empty state instead of a blank drawer when there is no history yet", () => {
		queryStateRef.current = {
			...queryStateRef.current,
			data: onePage([]),
		};
		timelineStateRef.current = {
			...timelineStateRef.current,
			data: oneTimelinePage([]),
		};
		render(<AnalysisVersionHistory {...baseProps} currentVersion={null} />);

		expect(screen.getByText(/no version history yet/i)).toBeInTheDocument();
	});
});

describe("AnalysisVersionHistory — paging", () => {
	it("offers to load older versions only while the server says there are more", () => {
		timelineStateRef.current = {
			...timelineStateRef.current,
			data: oneTimelinePage([CURRENT_ENTRY], 7),
			hasNextPage: true,
		};
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		expect(
			screen.getByRole("button", { name: /load older versions/i }),
		).toBeInTheDocument();
	});

	it("hides the control on the last page, so a full final page does not invite an empty fetch", () => {
		// `hasNextPage` comes from the server's `nextCursor`, never from the
		// row count: a last page that happens to be exactly full looks
		// identical to a middle one from here.
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		expect(
			screen.queryByRole("button", { name: /load older versions/i }),
		).not.toBeInTheDocument();
	});

	it("takes 'is there more' from the TIMELINE, which is the superset", () => {
		// The revisions query can be exhausted while the timeline still has AI
		// runs to show. Reading `hasNextPage` off the bodies query would hide
		// the rest of the history.
		queryStateRef.current = {
			...queryStateRef.current,
			hasNextPage: false,
		};
		timelineStateRef.current = {
			...timelineStateRef.current,
			hasNextPage: true,
		};
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		expect(
			screen.getByRole("button", { name: /load older versions/i }),
		).toBeInTheDocument();
	});

	it("renders every page as one list, so a restored version from page two is reachable", () => {
		timelineStateRef.current = {
			...timelineStateRef.current,
			data: {
				pages: [
					{ entries: [CURRENT_ENTRY], nextCursor: 7 },
					{ entries: [RESTORABLE_ENTRY], nextCursor: null },
				],
			},
		};
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		expect(screen.getByText("v7")).toBeInTheDocument();
		expect(screen.getByText("v5")).toBeInTheDocument();
	});

	it("advances BOTH queries, so the newly revealed rows arrive with their bodies", async () => {
		timelineStateRef.current = {
			...timelineStateRef.current,
			hasNextPage: true,
		};
		queryStateRef.current = { ...queryStateRef.current, hasNextPage: true };
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		await userEvent.click(
			screen.getByRole("button", { name: /load older versions/i }),
		);

		expect(fetchNextTimelinePageMock).toHaveBeenCalled();
		expect(fetchNextPageMock).toHaveBeenCalled();
	});

	it("does not ask an exhausted bodies query for another page", async () => {
		// The right no-op when everything left in the timeline is an AI run.
		timelineStateRef.current = {
			...timelineStateRef.current,
			hasNextPage: true,
		};
		queryStateRef.current = {
			...queryStateRef.current,
			hasNextPage: false,
		};
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		await userEvent.click(
			screen.getByRole("button", { name: /load older versions/i }),
		);

		expect(fetchNextTimelinePageMock).toHaveBeenCalled();
		expect(fetchNextPageMock).not.toHaveBeenCalled();
	});
});

describe("AnalysisVersionHistory — compare view", () => {
	it("opens the diff viewer with the clicked revision's content against the current body", async () => {
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		await userEvent.click(screen.getByText("v5"));

		await waitFor(() => {
			expect(
				screen.getByTestId("version-diff-viewer-stub"),
			).toBeInTheDocument();
		});

		expect(diffViewerPropsRef.current).toMatchObject({
			currentContent: "current body text",
			// The current revision's place in the unified sequence, so the
			// pane agrees with the list it was opened from.
			currentVersion: 7,
			selectedVersion: expect.objectContaining({
				version: 5,
				content: "version two text",
				author: null,
			}),
		});
	});

	it("labels the current pane with the version whose body it shows, never v0", async () => {
		// The tab's own `getPlanningAnalysis` can sit a request behind this
		// drawer's list: another client saves a revision, so the list has rows
		// while `currentVersion` is still null. The pane then falls back to the
		// newest row's BODY, and its label has to name that same row — calling
		// real text "v0" claims a version that never existed. `expectedVersion`
		// is untouched by this: it stays the null the caller passed, so the
		// compare-and-set still refuses the save.
		render(<AnalysisVersionHistory {...baseProps} currentVersion={null} />);

		await userEvent.click(screen.getByText("v5"));

		await waitFor(() => {
			expect(
				screen.getByTestId("version-diff-viewer-stub"),
			).toBeInTheDocument();
		});

		expect(diffViewerPropsRef.current).toMatchObject({
			currentContent: "current body text",
			currentVersion: 7,
		});
	});

	it("resolves a known author into a HUMAN-kind author for the diff viewer", async () => {
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		await userEvent.click(screen.getByText("v7"));

		await waitFor(() => {
			expect(
				screen.getByTestId("version-diff-viewer-stub"),
			).toBeInTheDocument();
		});

		expect(
			(diffViewerPropsRef.current?.selectedVersion as { author: unknown })
				.author,
		).toEqual({ kind: "HUMAN", name: "Ada Lovelace" });
	});

	it("clicking Restore does not also open the compare view", async () => {
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		await userEvent.click(
			screen.getAllByRole("button", { name: /^restore$/i })[0],
		);

		expect(
			screen.queryByTestId("version-diff-viewer-stub"),
		).not.toBeInTheDocument();
	});
});

describe("AnalysisVersionHistory — restore failures are recoverable, not crashes", () => {
	it("surfaces a lost-race CONFLICT with a refresh-and-retry message", async () => {
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		await userEvent.click(
			screen.getAllByRole("button", { name: /^restore$/i })[0],
		);
		await userEvent.click(screen.getByRole("button", { name: /confirm/i }));
		expect(saveMutationMock).toHaveBeenCalled();

		await act(async () => {
			capturedMutationOptionsRef.current?.onError?.({ code: "CONFLICT" });
		});

		expect(toast.error).toHaveBeenCalledWith(
			expect.stringMatching(/changed while you were editing/i),
		);
	});

	it("surfaces a stale sourceAnalysisVersion BAD_REQUEST with its own message, not the CONFLICT one", async () => {
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		await userEvent.click(
			screen.getAllByRole("button", { name: /^restore$/i })[0],
		);
		await userEvent.click(screen.getByRole("button", { name: /confirm/i }));

		await act(async () => {
			capturedMutationOptionsRef.current?.onError?.({
				code: "BAD_REQUEST",
			});
		});

		expect(toast.error).toHaveBeenCalledWith(
			expect.stringMatching(/no longer available/i),
		);
		expect(toast.error).not.toHaveBeenCalledWith(
			expect.stringMatching(/changed while you were editing/i),
		);
	});
});

describe("AnalysisVersionHistory — restore success", () => {
	it("confirms the restore without naming a number the list cannot show yet", async () => {
		// `result.version` is the STORED revision version; the seq the new
		// entry will occupy is not known until the timeline refetches. Naming
		// the stored one here would contradict every number behind the toast.
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		await userEvent.click(
			screen.getAllByRole("button", { name: /^restore$/i })[0],
		);
		await userEvent.click(screen.getByRole("button", { name: /confirm/i }));

		await act(async () => {
			capturedMutationOptionsRef.current?.onSuccess?.({ version: 4 });
		});

		expect(toast.success).toHaveBeenCalledWith(
			expect.stringMatching(/restored/i),
		);
		expect(toast.success).not.toHaveBeenCalledWith(
			expect.stringMatching(/version 4/i),
		);
	});

	it("invalidates BOTH lists by the same topic they read, through the partial key form", async () => {
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		// The input the drawer's OWN list query registered, read back off its
		// real `infiniteOptions()` call and never re-typed here. `input` is a
		// function of the cursor, so the first page is what it returns for
		// "no cursor yet".
		const registeredInput = (
			orpcSpies.infiniteOptions.mock.calls.at(-1)?.[0] as {
				input: (cursor: number | undefined) => Record<string, unknown>;
			}
		).input(undefined);

		await userEvent.click(
			screen.getAllByRole("button", { name: /^restore$/i })[0],
		);
		await userEvent.click(screen.getByRole("button", { name: /confirm/i }));

		await act(async () => {
			capturedMutationOptionsRef.current?.onSuccess?.({ version: 4 });
		});

		// Same topic as the read, and NO cursor: a key carrying one would
		// match a single page and leave the rest of the list stale. The exact
		// `queryKey()` form is not merely unused here, it is absent from the
		// mock — it stamps `type: "query"` and would silently match nothing
		// now that the list is an infinite query.
		const expectedInput = {
			input: {
				projectId: registeredInput.projectId,
				topicId: registeredInput.topicId,
				organizationId: registeredInput.organizationId,
			},
		};
		expect(orpcSpies.key).toHaveBeenCalledWith(expectedInput);
		// The timeline is a separate cache entry on a separate scale. A restore
		// writes a row that belongs in each, so invalidating one alone leaves
		// the drawer showing history without the version it just wrote.
		expect(timelineSpies.key).toHaveBeenCalledWith(expectedInput);
		expect(invalidateQueriesMock).toHaveBeenCalledWith({
			queryKey: orpcSpies.key.mock.results.at(-1)?.value,
		});
		expect(invalidateQueriesMock).toHaveBeenCalledWith({
			queryKey: timelineSpies.key.mock.results.at(-1)?.value,
		});
	});

	it("closes the confirm dialog and the diff viewer after a successful restore", async () => {
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		await userEvent.click(screen.getByText("v5"));
		await waitFor(() => {
			expect(
				screen.getByTestId("version-diff-viewer-stub"),
			).toBeInTheDocument();
		});

		await userEvent.click(
			screen.getAllByRole("button", { name: /^restore$/i })[0],
		);
		expect(
			screen.getByRole("button", { name: /confirm/i }),
		).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: /confirm/i }));

		await act(async () => {
			capturedMutationOptionsRef.current?.onSuccess?.({ version: 4 });
		});

		expect(
			screen.queryByRole("button", { name: /confirm/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByTestId("version-diff-viewer-stub"),
		).not.toBeInTheDocument();
	});

	it("calls onRestore with the STORED version, which the caller holds as a token", async () => {
		const onRestore = vi.fn();
		render(
			<AnalysisVersionHistory
				{...baseProps}
				currentVersion={3}
				onRestore={onRestore}
			/>,
		);

		await userEvent.click(
			screen.getAllByRole("button", { name: /^restore$/i })[0],
		);
		await userEvent.click(screen.getByRole("button", { name: /confirm/i }));

		await act(async () => {
			capturedMutationOptionsRef.current?.onSuccess?.({ version: 7 });
		});

		// The server's own number, passed through untouched — never re-mapped
		// onto the display scale, because `PlanningAnalysisTab` compares it
		// against `revisionVersion`.
		expect(onRestore).toHaveBeenCalledWith(7);
	});

	it("does not throw when onRestore is not supplied", async () => {
		render(<AnalysisVersionHistory {...baseProps} currentVersion={3} />);

		await userEvent.click(
			screen.getAllByRole("button", { name: /^restore$/i })[0],
		);
		await userEvent.click(screen.getByRole("button", { name: /confirm/i }));

		// The assertion is reaching this line at all: with no `onRestore`
		// prop, a call to it inside `onSuccess` that isn't optionally
		// chained throws synchronously inside `act`, and the `await` below
		// would reject before the `expect` ever runs.
		await act(async () => {
			capturedMutationOptionsRef.current?.onSuccess?.({ version: 9 });
		});

		expect(toast.success).toHaveBeenCalled();
	});
});
