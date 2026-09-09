/**
 * TopicItemPage — the Publishing Suite Topic Item Page shell (Fizzy #1851,
 * Phase 2A-1).
 *
 * Mocks `@tanstack/react-query` and `@shared/lib/orpc-query-utils` wholesale,
 * mirroring `publishing-suite-list.test.tsx` in this directory: `useQuery`
 * resolves against a hoisted `state` fixture keyed off the oRPC procedure path
 * baked into the mocked `queryOptions` queryKey.
 *
 * Scope note: 2A-1 shipped the SHELL and these tests pin its contract — default
 * tab, the topic header, and that the four generation tabs are present but NOT
 * operable (FR50). 2A-2 filled in Planning & Analysis (FR39); the panel's own
 * states live in `publishing-planning-analysis-tab.test.tsx`, and what is
 * pinned HERE is the wiring: that the page fetches the analysis once and the
 * worksheet and the questions panel read the SAME `latestAttempt` row for
 * their failure signal, even though (2A-3) the questions themselves come from
 * a separate decisions query — `TopicQuestionsPanel`'s own states live in
 * `publishing-topic-questions.test.tsx`.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	state,
	refetchTopic,
	setReadStateMutate,
	updatePostTypesMutate,
	updateStatusMutate,
	updateContributorsMutate,
	toastError,
} = vi.hoisted(() => ({
	state: {
		topic: null as Record<string, unknown> | null,
		// 2A-2: the planning analysis the page now fetches alongside the
		// topic. Two rows, because a failed regeneration must not blank a
		// good analysis — see PlanningAnalysisTab's own test file.
		latestAttempt: null as Record<string, unknown> | null,
		// Tasks 8/11 (Fizzy #1851): the resolver's one answer to "what is this
		// topic's analysis right now" — AI text, or the author's own override.
		// Independent of `latestAttempt` above on purpose: a real override can
		// disagree with the raw AI row, and that disagreement is exactly what
		// the media-tab gate test below exercises. The newest READY row itself
		// is no longer part of the response — Task 11 removed it so no caller
		// can render the un-overridden AI text by accident.
		effective: null as {
			prose: string;
			data: unknown;
			overridden: boolean;
		} | null,
		aiVersion: null as number | null,
		revisionVersion: null as number | null,
		sourceAnalysisVersion: null as number | null,
		// 2A-3: the decision-thread rows `TopicQuestionsPanel` renders. The
		// source of truth for the Summary & Questions tab's questions moved
		// here from the analysis blob above — see the FR39 block below.
		decisionThreads: [] as Record<string, unknown>[],
		// 2B-1: the generation tab strip's own read. Fixture state, a
		// default response AND an error response, because the component
		// mounts this query unconditionally — a missing entry is not a
		// failing assertion but `undefined.queryOptions`, which fails
		// every case in this file at once.
		drafts: [] as Record<string, unknown>[],
		workingDrafts: [] as Record<string, unknown>[],
		draftsError: false,
		// Task 6: the project's members, for the contributors picker.
		members: [] as Array<Record<string, unknown>>,
		// Task 7: the members.list query's own readiness — a topic's
		// contributors editor must not treat a not-yet-loaded or failed
		// members list as "nobody" (`?? []`).
		membersPending: false,
		membersError: false,
		// Task 6: the signed-in user's id, mirrored by the mocked useSession.
		viewerUserId: "viewer-1" as string | null,
		pending: false,
		error: false,
		// Drive the read-marker write to reject, so the failure path is
		// exercised rather than assumed.
		readStateRejects: false,
		// Same, for the post-type override write: a failed save must keep
		// the dialog (and the user's checkboxes) rather than close over it.
		postTypesRejects: false,
	},
	refetchTopic: vi.fn(),
	setReadStateMutate: vi.fn(),
	updatePostTypesMutate: vi.fn(),
	updateStatusMutate: vi.fn(),
	updateContributorsMutate: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: toastError } }));

// Task 6: TopicItemPage now reads the viewer's own id (for the contributors
// picker's "(You)" label) via this hook, mirroring ProjectMembersSettings'
// existing use of it.
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		user: state.viewerUserId ? { id: state.viewerUserId } : null,
		session: { id: "test-session" },
		loaded: true,
		reloadSession: vi.fn(),
	}),
}));

vi.mock("@tanstack/react-query", () => ({
	useQuery: (opts: { queryKey?: unknown[] }) => {
		const procedure = Array.isArray(opts?.queryKey)
			? opts.queryKey[0]
			: undefined;
		if (procedure === "projects.publishingSuite.getTopic") {
			return {
				data:
					state.error || !state.topic
						? undefined
						: { topic: state.topic },
				isPending: state.pending,
				isLoading: state.pending,
				isError: state.error,
				refetch: refetchTopic,
			};
		}
		if (procedure === "projects.publishingSuite.getPlanningAnalysis") {
			return {
				data: {
					latestAttempt: state.latestAttempt,
					effective: state.effective,
					aiVersion: state.aiVersion,
					revisionVersion: state.revisionVersion,
					sourceAnalysisVersion: state.sourceAnalysisVersion,
					author: null,
					revisionCreatedAt: null,
				},
				isPending: false,
				isLoading: false,
				isError: false,
				refetch: vi.fn(),
			};
		}
		if (procedure === "projects.publishingSuite.listTopicDrafts") {
			return {
				data: state.draftsError
					? undefined
					: {
							drafts: state.drafts,
							workingDrafts: state.workingDrafts,
						},
				isPending: false,
				isLoading: false,
				isError: state.draftsError,
			};
		}
		if (procedure === "projects.publishingSuite.listTopicDecisions") {
			return {
				data: { threads: state.decisionThreads },
				isPending: false,
				isLoading: false,
				isError: false,
				refetch: vi.fn(),
			};
		}
		// Task 6: the contributors picker's member list. Constructed
		// unconditionally by the component, same obligation as every other
		// entry above.
		if (procedure === "projects.members.list") {
			return {
				data: state.membersError
					? undefined
					: { members: state.members },
				isPending: state.membersPending,
				isLoading: state.membersPending,
				isError: state.membersError,
				refetch: vi.fn(),
			};
		}
		return {
			data: undefined,
			isPending: false,
			isLoading: false,
			isError: false,
			refetch: vi.fn(),
		};
	},
	// The analysis version-history drawer inside this tree reads its list as
	// a paged query. Nothing in THIS file asserts on that list, so an empty
	// first page is the right stand-in — but the export has to exist, because
	// a missing one is a module-load error that takes down cases about tabs
	// and headings, which is how it surfaced.
	useInfiniteQuery: () => ({
		data: { pages: [{ revisions: [], nextCursor: null }] },
		isLoading: false,
		hasNextPage: false,
		isFetchingNextPage: false,
		fetchNextPage: vi.fn(),
	}),
	useMutation: (opts: {
		mutationKey?: unknown[];
		onSuccess?: (...args: unknown[]) => unknown;
		onError?: (...args: unknown[]) => unknown;
	}) => {
		const procedure = Array.isArray(opts?.mutationKey)
			? opts.mutationKey[0]
			: undefined;
		if (procedure === "projects.publishingSuite.setTopicReadState") {
			// Drive the real lifecycle so the component's own onSuccess /
			// onError callbacks fire — asserting on a bare spy would prove
			// nothing about the error handling under test.
			const run = (vars: unknown) => {
				setReadStateMutate(vars);
				if (state.readStateRejects) {
					opts.onError?.(new Error("network"), vars, undefined);
					return;
				}
				opts.onSuccess?.(undefined, vars, undefined);
			};
			return { mutate: run, mutateAsync: vi.fn(), isPending: false };
		}
		// The two metadata writes the page's edit affordances make. Both drive
		// the real lifecycle (mirroring `publishing-suite-list.test.tsx`) so
		// the component's own onSuccess — which closes the dialog only after
		// the write lands — actually runs.
		if (procedure === "projects.publishingSuite.updateTopicPostTypes") {
			const run = async (vars: unknown) => {
				updatePostTypesMutate(vars);
				if (state.postTypesRejects) {
					const err = new Error("rejected");
					await opts.onError?.(err, vars, undefined);
					throw err;
				}
				await opts.onSuccess?.(undefined, vars, undefined);
				return undefined;
			};
			return {
				mutate: (vars: unknown) => {
					void run(vars).catch(() => {});
				},
				mutateAsync: run,
				isPending: false,
			};
		}
		if (procedure === "projects.publishingSuite.updateTopicStatus") {
			const run = async (vars: unknown) => {
				updateStatusMutate(vars);
				await opts.onSuccess?.(undefined, vars, undefined);
				return undefined;
			};
			return {
				mutate: (vars: unknown) => {
					void run(vars).catch(() => {});
				},
				mutateAsync: run,
				isPending: false,
			};
		}
		if (procedure === "projects.publishingSuite.updateTopicContributors") {
			const run = async (vars: unknown) => {
				updateContributorsMutate(vars);
				await opts.onSuccess?.(undefined, vars, undefined);
				return undefined;
			};
			return {
				mutate: (vars: unknown) => {
					void run(vars).catch(() => {});
				},
				mutateAsync: run,
				isPending: false,
			};
		}
		return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
	},
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@shared/lib/orpc-query-utils", () => {
	// Every read shape oRPC exposes, not just the two this page happened to
	// use when the helper was written. It stands in for EVERY procedure in
	// the tree below, so a component switching one of them to a paged read —
	// `infiniteOptions` to register, the partial `key` to invalidate, since
	// the exact `queryKey` carries `type: "query"` and misses an infinite
	// entry — must not take this file down with it. It did: adding paging to
	// the analysis history reddened two cases here that have nothing to do
	// with paging.
	const q = (procedure: string) => ({
		queryOptions: ({ input }: { input?: unknown }) => ({
			queryKey: [procedure, input],
			queryFn: async () => undefined,
		}),
		infiniteOptions: ({ input }: { input?: unknown }) => ({
			queryKey: [procedure, input],
			queryFn: async () => undefined,
		}),
		queryKey: ({ input }: { input?: unknown }) => [procedure, input],
		key: ({ input }: { input?: unknown } = {}) => [procedure, input],
	});
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
					getTopic: q("projects.publishingSuite.getTopic"),
					// The component's read-marker onSuccess invalidates the
					// LIST query. The obligation is on the component tree, not
					// on this file's subject matter — and a missing entry is
					// not a failing assertion but `undefined.queryKey`, which
					// fails every case in the file at once.
					listTopics: q("projects.publishingSuite.listTopics"),
					setTopicReadState: m(
						"projects.publishingSuite.setTopicReadState",
					),
					getPlanningAnalysis: q(
						"projects.publishingSuite.getPlanningAnalysis",
					),
					generatePlanningAnalysis: m(
						"projects.publishingSuite.generatePlanningAnalysis",
					),
					// Task 11: the Planning & Analysis tab now mounts the
					// version-history drawer, which reads this list and writes a
					// restore through the same save path. Same obligation as every
					// entry here — a missing one is `undefined.queryOptions`, which
					// fails every case in this file at once rather than one
					// assertion.
					listAnalysisRevisions: q(
						"projects.publishingSuite.listAnalysisRevisions",
					),
					saveAnalysisRevision: m(
						"projects.publishingSuite.saveAnalysisRevision",
					),
					listTopicDrafts: q(
						"projects.publishingSuite.listTopicDrafts",
					),
					// 2B-2's short post panel owns both of these. Same
					// obligation the comment above describes: a missing entry
					// is `undefined.mutationOptions`, which fails every case in
					// the file at once rather than one assertion.
					generateShortPost: m(
						"projects.publishingSuite.generateShortPost",
					),
					selectShortPostOption: m(
						"projects.publishingSuite.selectShortPostOption",
					),
					// The LinkedIn panel owns these two (Fizzy #1851). Present
					// BEFORE the panel is mounted, deliberately: the comment
					// above records this file being taken down three times by a
					// tab that started rendering a real panel against a mock
					// that did not list its procedures, and the mount is a
					// follow-up change in a file this slice could not touch.
					// An entry for a panel that is not yet rendered costs
					// nothing; a missing one costs every case in the file.
					generateLinkedInPost: m(
						"projects.publishingSuite.generateLinkedInPost",
					),
					selectLinkedInPostOption: m(
						"projects.publishingSuite.selectLinkedInPostOption",
					),
					// 2B-3's blog panel owns these three, and the warning above
					// is not hypothetical: omitting them crashed every case in
					// this file the moment the Blog Post tab stopped rendering
					// a placeholder and started mounting a real panel.
					generateBlogPost: m(
						"projects.publishingSuite.generateBlogPost",
					),
					adoptBlogPostDraft: m(
						"projects.publishingSuite.adoptBlogPostDraft",
					),
					saveBlogPostBody: m(
						"projects.publishingSuite.saveBlogPostBody",
					),
					// 2C-1's case study panel owns these three, and it made the
					// warning above concrete for a third time: the tab test
					// crashed the moment Case Study started mounting a panel.
					generateCaseStudy: m(
						"projects.publishingSuite.generateCaseStudy",
					),
					adoptCaseStudyDraft: m(
						"projects.publishingSuite.adoptCaseStudyDraft",
					),
					saveCaseStudyBody: m(
						"projects.publishingSuite.saveCaseStudyBody",
					),
					// 2C-2's stakeholder email panel owns these three, and it
					// made the warning above concrete for a FOURTH time: the tab
					// test crashed with `undefined.mutationOptions` the moment
					// Stakeholder Email stopped being a placeholder.
					generateStakeholderEmail: m(
						"projects.publishingSuite.generateStakeholderEmail",
					),
					adoptStakeholderEmailDraft: m(
						"projects.publishingSuite.adoptStakeholderEmailDraft",
					),
					saveStakeholderEmailBody: m(
						"projects.publishingSuite.saveStakeholderEmailBody",
					),
					listTopicDecisions: q(
						"projects.publishingSuite.listTopicDecisions",
					),
					answerTopicQuestion: m(
						"projects.publishingSuite.answerTopicQuestion",
					),
					// The amend write the Summary & Questions tab owns
					// alongside answering — a settled question is correctable,
					// through a SEPARATE procedure so the answer path can keep
					// refusing an already-settled root.
					amendTopicQuestion: m(
						"projects.publishingSuite.amendTopicQuestion",
					),
					updateTopicPostTypes: m(
						"projects.publishingSuite.updateTopicPostTypes",
					),
					updateTopicStatus: m(
						"projects.publishingSuite.updateTopicStatus",
					),
					// Task 6: the contributors override write.
					updateTopicContributors: m(
						"projects.publishingSuite.updateTopicContributors",
					),
					// A8: the assignee write, constructed UNCONDITIONALLY by
					// this page. Same obligation as every entry above.
					updateTopicAssignees: m(
						"projects.publishingSuite.updateTopicAssignees",
					),
				},
				// Task 6: the contributors picker's member list. Same
				// obligation as every entry above — a missing one is
				// `undefined.queryOptions`, not a failing assertion.
				members: {
					list: q("projects.members.list"),
				},
			},
		},
	};
});

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useBasePath: () => "/app",
}));

import { TopicItemPage } from "@saas/projects/components/publishing-suite/TopicItemPage";

/** A topic as `publishingSuite.getTopic` returns it. */
function topic(overrides: Record<string, unknown> = {}) {
	return {
		id: "topic-1",
		title: "Shipped the retry budget",
		pitch: "We cut duplicate deliveries by bounding the retry window.",
		status: "SUGGESTION",
		origin: "AI",
		declineReason: null,
		publishedUrl: null,
		createdById: null,
		createdAt: new Date("2026-08-01T00:00:00Z"),
		updatedAt: new Date("2026-08-02T00:00:00Z"),
		snoozedUntil: null,
		snoozeReason: null,
		isSnoozed: false,
		isRead: false,
		suggestedPostTypes: [],
		relevantFunctionTags: [],
		postTypeRecommendations: [],
		contributors: [],
		rankReason: null,
		authorRecommendation: null,
		angle: null,
		subject: null,
		whySuggested: null,
		userPostTypes: null,
		userContributorUserIds: null,
		// A8: assignees are always present on the wire — the query layer
		// resolves them from the same lookup as contributors, so a fixture
		// omitting them is a topic shape the API never returns.
		assigneeUserIds: [] as string[],
		assignees: [] as Array<{
			id: string;
			name: string;
			image: string | null;
			username: string | null;
		}>,
		meetingSpeakers: null,
		...overrides,
	};
}

/** A project member row as `projects.members.list` returns it — the
 *  contributors picker's option shape (Task 6). */
function makeMember(overrides: Record<string, unknown> = {}) {
	return {
		userId: "u1",
		role: "EDITOR",
		user: {
			id: "u1",
			name: "Ada",
			email: "ada@example.com",
			image: null as string | null,
		},
		isOwner: false,
		isCreator: false,
		isGuest: false,
		invitedAt: null,
		acceptedAt: null,
		expiresAt: null,
		...overrides,
	};
}

function renderPage(canEdit = true) {
	return render(
		<TopicItemPage
			projectId="proj-1"
			topicId="topic-1"
			organizationId={null}
			canEdit={canEdit}
		/>,
	);
}

beforeEach(() => {
	state.topic = topic();
	state.latestAttempt = null;
	state.effective = null;
	state.aiVersion = null;
	state.revisionVersion = null;
	state.sourceAnalysisVersion = null;
	state.decisionThreads = [];
	state.members = [];
	state.membersPending = false;
	state.membersError = false;
	state.viewerUserId = "viewer-1";
	state.pending = false;
	state.error = false;
	state.readStateRejects = false;
	state.postTypesRejects = false;
	refetchTopic.mockReset();
	setReadStateMutate.mockReset();
	updatePostTypesMutate.mockReset();
	updateStatusMutate.mockReset();
	updateContributorsMutate.mockReset();
	toastError.mockReset();
});

describe("TopicItemPage — header", () => {
	it("renders the topic title as the page heading (FR3)", () => {
		renderPage();
		expect(
			screen.getByRole("heading", {
				name: /shipped the retry budget/i,
				level: 1,
			}),
		).toBeInTheDocument();
	});

	it("renders the topic status (FR4)", () => {
		state.topic = topic({ status: "IN_PROGRESS" });
		renderPage();
		expect(screen.getByText("In progress")).toBeInTheDocument();
	});

	it("renders a DECLINED topic with its decline reason (DV1)", () => {
		// DV1: the page loads for any valid topic REGARDLESS of status. A
		// declined topic is still reviewable — hiding it would strand the
		// record of why it was declined.
		state.topic = topic({
			status: "DECLINED",
			declineReason: "Customer has not approved the quote.",
		});
		renderPage();
		expect(
			screen.getByText(/customer has not approved the quote/i),
		).toBeInTheDocument();
	});

	it("renders a topic carrying no 1B metadata (DV4)", () => {
		// DV4: missing Phase 1B enrichment must not prevent the page loading.
		state.topic = topic({
			angle: null,
			contributors: [],
			postTypeRecommendations: [],
			relevantFunctionTags: [],
			suggestedPostTypes: [],
			whySuggested: null,
			meetingSpeakers: null,
			authorRecommendation: null,
		});
		renderPage();
		expect(
			screen.getByRole("heading", {
				name: /shipped the retry budget/i,
				level: 1,
			}),
		).toBeInTheDocument();
	});
});

describe("TopicItemPage — tabs", () => {
	it("opens on Summary & Questions (FR6)", () => {
		renderPage();
		expect(
			screen.getByRole("tab", { name: /summary & questions/i }),
		).toHaveAttribute("aria-selected", "true");
	});

	it("shows the topic's AI-generated summary on the default tab (FR7)", () => {
		renderPage();
		expect(
			screen.getByText(/cut duplicate deliveries/i),
		).toBeInTheDocument();
	});

	it("offers Planning & Analysis and Decision Log tabs (FR14, FR43)", async () => {
		const user = userEvent.setup();
		renderPage();

		await user.click(
			screen.getByRole("tab", { name: /planning & analysis/i }),
		);
		expect(
			screen.getByRole("tab", { name: /planning & analysis/i }),
		).toHaveAttribute("aria-selected", "true");

		await user.click(screen.getByRole("tab", { name: /decision log/i }));
		expect(
			screen.getByRole("tab", { name: /decision log/i }),
		).toHaveAttribute("aria-selected", "true");
	});

	// SUPERSEDED, deliberately. Phase 2A's FR50 said a generation tab a user can
	// activate is a promise 2A cannot keep, and this case pinned that for all
	// four content types. Phase 2B's FR1/FR2 activated two of them, 2C-1
	// (#1854) activated Case Study and 2C-2 activates Stakeholder Email, so the
	// old assertion is no longer true for any of the four — FR50 is now
	// satisfied for every type rather than waived for one.
	//
	// This is the documented exception to the repository's standing rule that a
	// failing test caught a real regression: the contract changed on purpose,
	// the requirement that changed it is named, and the guarantee that replaces
	// it is asserted right below.
	it("activates every generation tab that has a panel (FR1, FR2)", async () => {
		// All four now. The tab is selectable exactly when the type has a panel
		// behind it, and after 2C-2 every type does.
		const user = userEvent.setup();
		renderPage();
		const tablist = screen.getByRole("tablist", {
			name: /content generation/i,
		});

		for (const label of [
			/short post \/ tweet/i,
			/blog post/i,
			/case study/i,
			/stakeholder email/i,
		]) {
			const tab = within(tablist).getByRole("tab", { name: label });
			expect(tab).toBeEnabled();
			await user.click(tab);
			expect(tab).toHaveAttribute("aria-selected", "true");
		}
	});

	it("leaves NO generation tab disabled or Coming Soon", () => {
		// What replaces the surviving half of the 2A assertion. It still guards
		// the same thing from the other side: a FIFTH post type added to the
		// Prisma enum without a panel would appear here disabled and
		// coming-soon, and this case is what says so out loud rather than
		// letting it ship as an empty tab.
		renderPage();
		const tablist = screen.getByRole("tablist", {
			name: /content generation/i,
		});

		expect(
			within(tablist).queryByRole("tab", { name: /coming soon/i }),
		).not.toBeInTheDocument();
		for (const tab of within(tablist).getAllByRole("tab")) {
			expect(tab).toBeEnabled();
		}
	});
});

describe("TopicItemPage — media-tab gate (Fizzy #1851, Task 8)", () => {
	it("keeps a generation tab's recommendation reading the resolved analysis, not the stale AI row", async () => {
		// The raw AI row came back with no structured recommendation at all —
		// as bare as a topic whose sources gave the model nothing to bucket —
		// while the resolver's `effective` view (what the author actually
		// edited) carries a substantial, prose-only risks section. A gate that
		// read the raw AI row directly would call this "no analysis" and
		// blank every tab's recommendation; the whole point of Task 8 is
		// that the gate reads `effective` instead.
		state.latestAttempt = {
			id: "pa-1",
			version: 1,
			status: "READY",
			content: {},
			sourceRefs: {},
			model: "test-model",
			promptSource: "BOUND",
			error: null,
			createdAt: new Date("2026-08-30T10:00:00Z"),
			updatedAt: new Date("2026-08-30T10:04:00Z"),
		};
		state.aiVersion = 1;
		state.sourceAnalysisVersion = 1;
		state.effective = {
			prose: "### Risks\n\nNames a customer the author flagged after editing.",
			data: {},
			overridden: true,
		};

		const user = userEvent.setup();
		renderPage();

		const tablist = screen.getByRole("tablist", {
			name: /content generation/i,
		});
		await user.click(
			within(tablist).getByRole("tab", { name: /short post \/ tweet/i }),
		);

		// hasAnalysis === true: the panel says the analysis is silent on this
		// type, NOT that there is no analysis to read yet.
		expect(
			screen.getByText(
				/the planning analysis doesn't say anything about/i,
			),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/no planning analysis yet/i),
		).not.toBeInTheDocument();
	});
});

describe("TopicItemPage — load states", () => {
	it("shows a loading state while the topic is in flight", () => {
		state.pending = true;
		state.topic = null;
		renderPage();
		expect(screen.getByRole("status")).toBeInTheDocument();
	});

	it("shows a not-found state when the topic does not resolve", () => {
		// UC1 alternate flow: a topic that does not exist — or belongs to
		// another project — gets a safe not-found state, never a crash.
		state.error = true;
		state.topic = null;
		renderPage();
		expect(screen.getByText(/not found/i)).toBeInTheDocument();
	});
});

describe("TopicItemPage — read marker", () => {
	it("marks the topic read on open (1D FR4: opening IS opening)", () => {
		// 1D made expanding a row mark it read. Opening the full page is the
		// strongest form of opening there is, so it must not be the only one
		// that does not count.
		renderPage();
		expect(setReadStateMutate).toHaveBeenCalledWith(
			expect.objectContaining({ topicId: "topic-1", read: true }),
		);
	});

	it("tells the user when the read-marker write fails", () => {
		// The sibling list toasts on exactly this mutation. Failing silently
		// here would leave the Inbox dot stale with nothing to explain why.
		state.readStateRejects = true;
		renderPage();
		expect(toastError).toHaveBeenCalled();
	});

	it("retries on a later load after a failed attempt", () => {
		// The ref guard exists to stop a write loop, not to make one failure
		// permanent for the life of the mount. A later refetch must be free to
		// try again.
		state.readStateRejects = true;
		const { rerender } = renderPage();
		expect(setReadStateMutate).toHaveBeenCalledTimes(1);

		state.readStateRejects = false;
		state.topic = topic(); // a fresh object, as a refetch would produce
		rerender(
			<TopicItemPage
				projectId="proj-1"
				topicId="topic-1"
				organizationId={null}
				canEdit
			/>,
		);
		expect(setReadStateMutate).toHaveBeenCalledTimes(2);
	});

	it("does not re-mark a topic that is already read", () => {
		state.topic = topic({ isRead: true });
		renderPage();
		expect(setReadStateMutate).not.toHaveBeenCalled();
	});
});

describe("TopicItemPage — open questions (FR39)", () => {
	const readyAnalysis = (questions: unknown[]) => ({
		id: "pa-1",
		version: 1,
		status: "READY",
		content: { topicAngle: "A reliability story.", questions },
		sourceRefs: {},
		model: "test-model",
		promptSource: "BOUND",
		error: null,
		createdAt: new Date("2026-08-30T10:00:00Z"),
		updatedAt: new Date("2026-08-30T10:04:00Z"),
	});

	const QUESTION = {
		questionId: "q1",
		decisionKind: "CUSTOMER_NAME",
		subject: "the named customer",
		question: "May we name the customer?",
		recommendedResponse: "Ask their marketing contact first.",
		whyItMatters: "A case study without the name is a different piece.",
		source: "MODEL",
	};

	// A single-thread `listTopicDecisions` root for QUESTION, OPEN by default —
	// the shape `TopicQuestionsPanel` renders from since 2A-3, replacing the
	// analysis-blob questions above for display (the blob stays the analysis's
	// own record of what it raised).
	const openThread = (
		q: typeof QUESTION,
		overrides: Record<string, unknown> = {},
	) => ({
		root: {
			id: `decision-${q.questionId}`,
			parentId: null,
			kind: "QUESTION",
			status: "OPEN",
			authorType: "AGENT",
			authorUserId: null,
			questionId: q.questionId,
			decisionKind: q.decisionKind,
			subject: q.subject,
			summary: q.question,
			content: null,
			recommendedResponse: q.recommendedResponse,
			answerSource: null,
			analysisVersion: 1,
			createdAt: new Date("2026-08-30T10:00:00Z"),
			...overrides,
		},
		replies: [],
	});

	it("shows the analysis's open questions on the default tab", () => {
		// FR39 lands in 2A-2 rather than 2A-3 because the buckets and the question
		// list are independent: an analysis can flag a decision as needing
		// confirmation while the question that decides it lives on another tab
		// nobody has opened.
		state.decisionThreads = [openThread(QUESTION)];

		renderPage();

		expect(screen.getByText(/may we name the customer/i)).toBeVisible();
		expect(
			screen.getByText(/ask their marketing contact first/i),
		).toBeVisible();
	});

	it("falls back to an empty state when no analysis has been run", () => {
		renderPage();
		expect(screen.getByText(/no open questions yet/i)).toBeInTheDocument();
	});

	it("keeps showing the questions when a regeneration fails", () => {
		// The rows are the source of truth, so a failed attempt cannot empty the
		// list — `failPlanningAnalysis` writes no question at all (proven in
		// `packages/database/__tests__/publishing-topic-decisions.test.ts`). This
		// test pins the page half: a FAILED latest attempt must not suppress the
		// standing questions.
		state.decisionThreads = [openThread(QUESTION)];
		state.latestAttempt = {
			...readyAnalysis([]),
			id: "pa-2",
			version: 2,
			status: "FAILED",
			content: null,
			error: "Rate limited.",
		};

		renderPage();

		expect(screen.getByText(/may we name the customer/i)).toBeVisible();
	});

	it("renders the analysis itself on the Planning & Analysis tab", async () => {
		state.latestAttempt = readyAnalysis([QUESTION]);
		state.aiVersion = 1;
		state.sourceAnalysisVersion = 1;
		// What the tab renders since Task 11 is the RESOLVER's document,
		// not the raw AI row — so the prose has to come from here.
		state.effective = {
			prose: "### Topic angle\n\nA reliability story.",
			data: {},
			overridden: false,
		};

		const user = userEvent.setup();
		renderPage();
		await user.click(
			screen.getByRole("tab", { name: /planning & analysis/i }),
		);

		expect(screen.getByText(/a reliability story/i)).toBeVisible();
	});

	it("offers a reader no generate control", () => {
		renderPage(false);
		expect(
			screen.queryByRole("button", {
				name: /generate planning analysis/i,
			}),
		).not.toBeInTheDocument();
	});
});

/**
 * The page mounts the SAME `TopicDetails` block the Inbox row does, and that
 * block renders two edit affordances — "Edit post types" (always, for an
 * editor) and "Edit/Add URL" (on a PUBLISHED topic). The page passed
 * `() => undefined` for both callbacks, so both buttons rendered enabled and
 * did nothing at all: no dialog, no write, no error. The Inbox row has wired
 * these to `PostTypesDialog` / `PublishTopicDialog` since Task 6; these cases
 * pin the same contract on the Item Page.
 */
describe("TopicItemPage — editing topic metadata", () => {
	it("opens the post-types editor rather than doing nothing", async () => {
		const user = userEvent.setup();
		state.topic = topic({ suggestedPostTypes: ["TWEET"] });
		renderPage();

		await user.click(
			screen.getByRole("button", { name: "Edit post types" }),
		);

		expect(await screen.findByRole("dialog")).toBeVisible();
		expect(screen.getByLabelText("Blog Post")).toBeInTheDocument();
	});

	it("saves the checked set through updateTopicPostTypes", async () => {
		const user = userEvent.setup();
		state.topic = topic({ suggestedPostTypes: ["TWEET"] });
		renderPage();

		await user.click(
			screen.getByRole("button", { name: "Edit post types" }),
		);
		await user.click(screen.getByLabelText("Blog Post"));
		await user.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(updatePostTypesMutate).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "proj-1",
					topicId: "topic-1",
					postTypes: ["TWEET", "BLOG_POST"],
				}),
			),
		);
	});

	it("resets an override back to the AI suggestion", async () => {
		const user = userEvent.setup();
		state.topic = topic({
			suggestedPostTypes: ["TWEET"],
			userPostTypes: ["CASE_STUDY"],
		});
		renderPage();

		await user.click(
			screen.getByRole("button", { name: "Edit post types" }),
		);
		await user.click(
			screen.getByRole("button", { name: "Reset to AI suggestion" }),
		);

		await waitFor(() =>
			expect(updatePostTypesMutate).toHaveBeenCalledWith(
				expect.objectContaining({ postTypes: null }),
			),
		);
	});

	it("keeps the dialog open when the save fails, so the choices survive", async () => {
		// Mirrors the Inbox row's contract: close only AFTER success.
		const user = userEvent.setup();
		state.topic = topic({ suggestedPostTypes: ["TWEET"] });
		state.postTypesRejects = true;
		renderPage();

		await user.click(
			screen.getByRole("button", { name: "Edit post types" }),
		);
		await user.click(screen.getByLabelText("Blog Post"));
		await user.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => expect(toastError).toHaveBeenCalled());
		expect(screen.getByRole("dialog")).toBeVisible();
	});

	it("edits a published topic's URL rather than doing nothing", async () => {
		const user = userEvent.setup();
		state.topic = topic({
			status: "PUBLISHED",
			publishedUrl: "https://example.com/old",
		});
		renderPage();

		await user.click(screen.getByRole("button", { name: "Edit URL" }));
		const dialog = await screen.findByRole("dialog");
		expect(dialog).toBeVisible();

		const field = within(dialog).getByDisplayValue(
			"https://example.com/old",
		);
		await user.clear(field);
		await user.type(field, "https://example.com/new");
		await user.click(within(dialog).getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(updateStatusMutate).toHaveBeenCalledWith(
				expect.objectContaining({
					topicId: "topic-1",
					status: "PUBLISHED",
					publishedUrl: "https://example.com/new",
				}),
			),
		);
	});

	it("offers a read-only viewer neither control (PR2)", () => {
		state.topic = topic({
			status: "PUBLISHED",
			publishedUrl: "https://example.com/old",
			suggestedPostTypes: ["TWEET"],
		});
		renderPage(false);

		expect(
			screen.queryByRole("button", { name: "Edit post types" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Edit URL" }),
		).not.toBeInTheDocument();
	});
});

/**
 * Task 6: the contributors editor, wired on the Item Page independently of
 * `PublishingSuiteList` — this page owns its own `members.list` query and its
 * own `updateTopicContributors` mutation rather than going through the list's
 * parent. Test 7 of the task brief's seven: "the same edit works from the
 * item page, not only the list row" — proven here by actually clicking the
 * button and asserting the mutation fires, not merely that the button exists
 * (the failure this page already shipped once for post types/URL, see the
 * block comment above the "editing topic metadata" describe).
 */
describe("TopicItemPage — editing contributors (Task 6)", () => {
	it("opens the contributors editor listing members with the current contributors checked", async () => {
		const user = userEvent.setup();
		state.members = [
			makeMember({
				userId: "u1",
				user: {
					id: "u1",
					name: "Ada",
					email: "ada@example.com",
					image: null,
				},
			}),
			makeMember({
				userId: "u2",
				user: {
					id: "u2",
					name: "Bob",
					email: "bob@example.com",
					image: null,
				},
			}),
		];
		state.topic = topic({
			contributors: [
				{ id: "u1", name: "Ada", image: null, username: "ada" },
			],
		});
		renderPage();

		await user.click(
			screen.getByRole("button", { name: "Edit contributors" }),
		);

		const dialog = within(await screen.findByRole("dialog"));
		expect(dialog.getByRole("checkbox", { name: /^Ada$/ })).toBeChecked();
		expect(
			dialog.getByRole("checkbox", { name: /^Bob$/ }),
		).not.toBeChecked();
	});

	it("saves the checked set through updateTopicContributors", async () => {
		const user = userEvent.setup();
		state.members = [
			makeMember({
				userId: "u1",
				user: {
					id: "u1",
					name: "Ada",
					email: "ada@example.com",
					image: null,
				},
			}),
			makeMember({
				userId: "u2",
				user: {
					id: "u2",
					name: "Bob",
					email: "bob@example.com",
					image: null,
				},
			}),
		];
		state.topic = topic({
			contributors: [
				{ id: "u1", name: "Ada", image: null, username: "ada" },
			],
		});
		renderPage();

		await user.click(
			screen.getByRole("button", { name: "Edit contributors" }),
		);
		const dialog = within(await screen.findByRole("dialog"));
		await user.click(dialog.getByRole("checkbox", { name: /^Bob$/ }));
		await user.click(dialog.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(updateContributorsMutate).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "proj-1",
					topicId: "topic-1",
					contributorUserIds: ["u1", "u2"],
				}),
			),
		);
	});

	it("resets an override back to the AI-resolved set", async () => {
		const user = userEvent.setup();
		state.members = [
			makeMember({
				userId: "u1",
				user: {
					id: "u1",
					name: "Ada",
					email: "ada@example.com",
					image: null,
				},
			}),
		];
		state.topic = topic({
			contributors: [
				{ id: "u1", name: "Ada", image: null, username: "ada" },
			],
			userContributorUserIds: ["u1"],
		});
		renderPage();

		await user.click(
			screen.getByRole("button", { name: "Edit contributors" }),
		);
		const dialog = within(await screen.findByRole("dialog"));
		await user.click(
			dialog.getByRole("button", { name: "Reset to AI suggestion" }),
		);

		await waitFor(() =>
			expect(updateContributorsMutate).toHaveBeenCalledWith(
				expect.objectContaining({ contributorUserIds: null }),
			),
		);
	});

	// Whole-branch review, residual finding 2: unlike `TopicRow`, this page
	// previously memoized `contributorIds` on `[topic]` alone rather than the
	// two contributor fields themselves. TanStack's structural sharing keeps
	// `topic` referentially stable across a NO-OP refetch, but ANY field
	// changing (a read marker, a status edit, `updatedAt`) mints a NEW `topic`
	// object — which re-ran the `[topic]` memo and re-seeded the dialog's
	// selection, discarding an in-progress checkbox pick. Fails against the
	// `[topic]` version.
	it("Regression: a parent re-render that mints a new topic object (same contributor data) does not discard an in-progress selection", async () => {
		const user = userEvent.setup();
		state.members = [
			makeMember({
				userId: "u1",
				user: {
					id: "u1",
					name: "Ada",
					email: "ada@example.com",
					image: null,
				},
			}),
			makeMember({
				userId: "u2",
				user: {
					id: "u2",
					name: "Bob",
					email: "bob@example.com",
					image: null,
				},
			}),
		];
		// The SAME array reference is reused below — mirroring what TanStack
		// Query's structural sharing actually does: an unchanged nested field
		// keeps its old reference even when the wrapping object is replaced.
		// A test that instead built a new, merely-equal array each time would
		// pass even against the unfixed `[topic]` memo, proving nothing.
		const contributors = [
			{ id: "u1", name: "Ada", image: null, username: "ada" },
		];
		state.topic = topic({ contributors });
		const { rerender } = renderPage();

		await user.click(
			screen.getByRole("button", { name: "Edit contributors" }),
		);
		const dialog = within(await screen.findByRole("dialog"));
		await user.click(dialog.getByRole("checkbox", { name: /^Bob$/ }));
		expect(dialog.getByRole("checkbox", { name: /^Bob$/ })).toBeChecked();

		// A NEW topic object — as a refetch would produce — but carrying the
		// SAME contributor data (same array reference); only an unrelated
		// field (`isRead`) changed.
		state.topic = topic({ contributors, isRead: true });
		rerender(
			<TopicItemPage
				projectId="proj-1"
				topicId="topic-1"
				organizationId={null}
				canEdit
			/>,
		);

		expect(dialog.getByRole("checkbox", { name: /^Bob$/ })).toBeChecked();
	});

	it("offers a read-only viewer no contributors edit control", () => {
		state.topic = topic({
			contributors: [
				{ id: "u1", name: "Ada", image: null, username: "ada" },
			],
		});
		renderPage(false);

		expect(
			screen.queryByRole("button", { name: "Edit contributors" }),
		).not.toBeInTheDocument();
	});

	// Whole-branch review, IMPORTANT 2: this page is the OTHER mount of
	// `ContributorsDialog` and owns its own `members.list` query
	// independently of `PublishingSuiteList` — it must thread the same
	// non-member-contributor rendering and Save-guard, not only the list row.
	it("renders a non-member contributor (a PR author who is not a project member) as its own labelled, checked row", async () => {
		const user = userEvent.setup();
		state.members = [
			makeMember({
				userId: "u1",
				user: {
					id: "u1",
					name: "Ada",
					email: "ada@example.com",
					image: null,
				},
			}),
		];
		state.topic = topic({
			contributors: [
				{ id: "u1", name: "Ada", image: null, username: "ada" },
				{ id: "u9", name: "Charlie", image: null, username: "charlie" },
			],
		});
		renderPage();

		await user.click(
			screen.getByRole("button", { name: "Edit contributors" }),
		);
		const dialog = within(await screen.findByRole("dialog"));

		expect(dialog.getByText("Not a project member")).toBeInTheDocument();
		expect(dialog.getByRole("checkbox", { name: /Charlie/ })).toBeChecked();
	});

	it("disables Save and surfaces the failure when the members query errors, instead of silently emptying the override", async () => {
		const user = userEvent.setup();
		state.membersError = true;
		state.topic = topic({
			contributors: [
				{ id: "u1", name: "Ada", image: null, username: "ada" },
			],
		});
		renderPage();

		await user.click(
			screen.getByRole("button", { name: "Edit contributors" }),
		);
		const dialog = within(await screen.findByRole("dialog"));

		expect(dialog.getByRole("alert")).toHaveTextContent(
			/couldn't load this project's members/i,
		);
		expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
		expect(updateContributorsMutate).not.toHaveBeenCalled();
	});
});

/**
 * The 2A rework's tab structure (Fizzy #1851).
 *
 * The PO asked for two ROWS of tabs — `Summary & Questions | Decisions |
 * Planning and Analysis` above `Short Post | Blog | Case Study…` — rather than
 * the generation strip sitting in a page footer below everything, where it
 * rendered under all three review tabs at once.
 *
 * What these pin is that the two rows drive ONE selection. A content type is a
 * peer of a review tab, not a tab inside a tab, so picking one deselects the
 * other. Row 1's order is pinned too, because matching the Feature Item Page's
 * sequence is the point of the change rather than a side effect of it.
 */
describe("TopicItemPage — two-row tab strip", () => {
	const reviewTabs = () =>
		screen.getByRole("tablist", { name: /topic review/i });
	const contentTabs = () =>
		screen.getByRole("tablist", { name: /content generation/i });

	it("orders row 1 to match the Feature Item Page: Summary, Decisions, then the document", () => {
		renderPage();

		const names = within(reviewTabs())
			.getAllByRole("tab")
			.map((t) => t.textContent);
		expect(names).toEqual([
			"Summary & Questions",
			"Decision Log",
			"Planning & Analysis",
		]);
	});

	it("still opens on Summary & Questions (FR6), which is no longer row 1's only job", () => {
		renderPage();

		expect(
			within(reviewTabs()).getByRole("tab", {
				name: /summary & questions/i,
			}),
		).toHaveAttribute("aria-selected", "true");
	});

	it("narrows row 2 to the content types the topic selected", () => {
		state.topic = topic({ suggestedPostTypes: ["TWEET", "BLOG_POST"] });
		renderPage();

		const names = within(contentTabs())
			.getAllByRole("tab")
			.map((t) => t.textContent);
		expect(names).toHaveLength(2);
		expect(names[0]).toMatch(/short post \/ tweet/i);
		expect(names[1]).toMatch(/blog post/i);
	});

	it("prefers the user's override over the AI suggestion for row 2", () => {
		state.topic = topic({
			suggestedPostTypes: ["TWEET"],
			userPostTypes: ["CASE_STUDY"],
		});
		renderPage();

		const names = within(contentTabs())
			.getAllByRole("tab")
			.map((t) => t.textContent);
		expect(names).toHaveLength(1);
		expect(names[0]).toMatch(/case study/i);
	});

	it("falls back to every content type when the topic selected none (#1853 FR1/FR2)", () => {
		// Topics created before 1B started writing `suggestedPostTypes`, and
		// every manually-created topic, have no selection. Hiding generation
		// from them would strand the feature behind a dialog nobody has a
		// reason to open — and FR1/FR2 say the tabs are activated, not
		// conditional.
		state.topic = topic({ suggestedPostTypes: [], userPostTypes: null });
		renderPage();

		// Five since LinkedIn joined the enum (Fizzy #1851). A literal rather
		// than a derived count on purpose: the number here is the claim that
		// EVERY type falls back, so deriving it from the same list the page
		// renders from would make the case agree with the page by construction.
		expect(within(contentTabs()).getAllByRole("tab")).toHaveLength(5);
	});

	it("treats a content type as a peer of a review tab, not a tab inside a tab", async () => {
		state.topic = topic({ suggestedPostTypes: ["TWEET"] });
		const user = userEvent.setup();
		renderPage();

		await user.click(
			within(contentTabs()).getByRole("tab", {
				name: /short post \/ tweet/i,
			}),
		);

		// One selection across both rows: picking a content type deselects the
		// review tab rather than opening beneath it.
		expect(
			within(reviewTabs()).getByRole("tab", {
				name: /summary & questions/i,
			}),
		).toHaveAttribute("aria-selected", "false");
	});

	it("says so when the draft read failed, without blanking the strip", () => {
		// The banner moved here from `GenerationTabs` when the strip split into
		// triggers and panels; the page owns the query, so the page says so.
		state.draftsError = true;
		renderPage();

		expect(
			screen.getByTestId("generation-tabs-degraded"),
		).toBeInTheDocument();
		expect(
			within(contentTabs()).getByRole("tab", { name: /blog post/i }),
		).toBeEnabled();
	});
});

/**
 * The content-type recommendation, at the point the choice is made (A2).
 *
 * The PO's words: "one thing that I don't see in the current build is how the
 * system really recommends content types and how the user interacts with that
 * — say to disable a recommendation or to enable something that wasn't
 * recommended", and later "it might also be good to show the user an explainer
 * on why certain content types were recommended."
 *
 * Both already existed. `Edit post types` has always overridden the AI list,
 * and the analysis has always carried a per-type rationale in its Recommended /
 * Needs confirmation / Deferred buckets. What was missing is that none of it
 * was visible on the screen where the choice happens — the dialog was a blank
 * form rather than an override of something.
 */
describe("TopicItemPage — the recommendation is visible where you choose", () => {
	const openPostTypes = async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(
			screen.getByRole("button", { name: /edit post types/i }),
		);
		return within(screen.getByRole("dialog"));
	};

	it("labels each option with the analysis's verdict", async () => {
		state.effective = {
			prose: "",
			data: {
				contentTypes: {
					recommended: [
						{ type: "Blog Post", rationale: "Enough substance." },
					],
					needsConfirmation: [
						{
							type: "Tweet",
							rationale: "Needs the metric approved first.",
						},
					],
				},
			},
			overridden: false,
		};

		const dialog = await openPostTypes();

		expect(dialog.getByText(/^Recommended$/i)).toBeInTheDocument();
		expect(dialog.getByText(/^Needs confirmation$/i)).toBeInTheDocument();
	});

	it("explains WHY, rather than only that", async () => {
		state.effective = {
			prose: "",
			data: {
				contentTypes: {
					needsConfirmation: [
						{
							type: "Tweet",
							rationale: "Needs the metric approved first.",
						},
					],
				},
			},
			overridden: false,
		};

		const dialog = await openPostTypes();

		expect(
			dialog.getByText(/needs the metric approved first/i),
		).toBeInTheDocument();
	});

	it("shows no verdict for a type the analysis never mentioned", async () => {
		// A type with no entry is not "not recommended" — the analysis simply
		// did not speak to it, and inventing a verdict it never gave would be
		// worse than showing none.
		state.effective = {
			prose: "",
			data: {
				contentTypes: {
					recommended: [
						{ type: "Blog Post", rationale: "Enough substance." },
					],
				},
			},
			overridden: false,
		};

		const dialog = await openPostTypes();

		expect(dialog.queryAllByText(/^Recommended$/i)).toHaveLength(1);
	});
});

/**
 * Readiness, and putting the work above the reference (A4).
 *
 * Two of the PO's asks. "Open questions should be on top" — the questions ARE
 * the work on this tab, and the metadata block below them is reference. And
 * "in fmv2 we have readiness bar, can we mirror it here?" — mirrored in intent
 * rather than in component, because a feature moves through a fixed stage
 * pipeline and a publishing topic does not. What a topic has is decisions, each
 * answered or not, so the honest signal is the proportion answered.
 */
describe("TopicItemPage — readiness", () => {
	const question = (id: string, status: string) => ({
		root: {
			id,
			parentId: null,
			kind: "QUESTION" as const,
			status,
			authorType: "AGENT" as const,
			authorUserId: null,
			questionId: id,
			decisionKind: "CONTENT_TYPE",
			subject: null,
			summary: null,
			content: `Question ${id}?`,
			recommendedResponse: null,
			whyItMatters: null,
			answerSource: null,
			analysisVersion: 1,
			createdAt: new Date(),
		},
		replies: [],
	});

	it("counts answered decisions against the total", () => {
		state.decisionThreads = [
			question("a", "RESOLVED"),
			question("b", "OPEN"),
			question("c", "OPEN"),
		];
		renderPage();

		expect(screen.getByTestId("topic-readiness")).toHaveTextContent(
			"1 of 3 decisions answered",
		);
	});

	it("counts a soft-closed question as answered, not as reopened", () => {
		// POSSIBLY_RESOLVED means the newest analysis stopped raising something
		// somebody had already answered. Treating it as open would make a topic
		// look less ready every time it regenerated.
		state.decisionThreads = [
			question("a", "POSSIBLY_RESOLVED"),
			question("b", "RESOLVED"),
		];
		renderPage();

		expect(screen.getByTestId("topic-readiness")).toHaveTextContent(
			"All 2 decisions answered",
		);
	});

	it("ignores AI update rows, which nobody can answer", () => {
		const update = question("u", "OPEN");
		state.decisionThreads = [
			{ ...update, root: { ...update.root, kind: "AI_UPDATE" } },
			question("a", "RESOLVED"),
		];
		renderPage();

		expect(screen.getByTestId("topic-readiness")).toHaveTextContent(
			"All 1 decisions answered",
		);
	});

	it("shows nothing at all when the analysis raised no questions", () => {
		state.decisionThreads = [];
		renderPage();

		expect(screen.queryByTestId("topic-readiness")).not.toBeInTheDocument();
	});
});
