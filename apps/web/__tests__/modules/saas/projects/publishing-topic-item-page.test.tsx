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

import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	state,
	refetchTopic,
	setReadStateMutate,
	updatePostTypesMutate,
	updateStatusMutate,
	updateContributorsMutate,
	updateSummaryMutate,
	setNotesMutate,
	toastError,
	invalidateQueries,
} = vi.hoisted(() => ({
	invalidateQueries: vi.fn(),
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
		/** When the AI analysis was written — the clock the staleness notice
		 *  compares live answers against. */
		aiCreatedAt: null as Date | null,
		// 2A-3: the decision-thread rows `TopicQuestionsPanel` renders. The
		// source of truth for the Summary & Questions tab's questions moved
		// here from the analysis blob above — see the FR39 block below.
		decisionThreads: [] as Record<string, unknown>[],
		// Whether the decision list is being refetched: a `#q-<id>` link opens
		// the group of the list that arrives, not of a cached one.
		decisionsFetching: false,
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
		// And for the summary write, for the same reason: a failed save must
		// leave the editor open on the text the person typed.
		summaryRejects: false,
		// Fizzy #2646: the status write can fail, and can be HELD open so a
		// case can look at the page while it is in flight.
		updateStatusRejects: false,
		updateStatusGate: null as Promise<void> | null,
		// `getTopic`'s `dataUpdatedAt`. The default is "the confirming refetch
		// is instant" — the world every pre-existing case assumes; the status
		// overlay releases a settled write at READ time when this is already
		// newer, so none of them gains a busy tail. A case that HOLDS the
		// confirming refetch sets 0 and later bumps it.
		topicUpdatedAt: Number.MAX_SAFE_INTEGER as number,
	},
	refetchTopic: vi.fn(),
	setReadStateMutate: vi.fn(),
	updatePostTypesMutate: vi.fn(),
	updateStatusMutate: vi.fn(),
	updateContributorsMutate: vi.fn(),
	updateSummaryMutate: vi.fn(),
	setNotesMutate: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: toastError } }));

/**
 * The AI assistant rail (Fizzy #1851, #15) is stubbed out, for the reason
 * `StoryWorkspacePage.*.test.tsx` stubs `StoryWorkspace`: the module
 * side-effect imports CopilotKit's stylesheet, which drags in a transitive
 * katex `.css` that jsdom cannot load ("Unknown file extension .css").
 *
 * The page reaches it through `next/dynamic`, so the failure is not a suite
 * that cannot import — it is an unhandled rejection from the lazy chunk when a
 * case renders the page, which is worse: intermittent, and attributed to
 * whichever test happened to be running. Stub it and the question never
 * arises.
 *
 * Nothing here is testing the assistant. What this page owes it is one prop
 * hand-off, and `assistantProposal` — the only thing that flows BACK — is
 * pinned where it does its work, in `publishing-planning-analysis-tab.test.tsx`.
 * The stub now records that hand-off's `context` prop (Fizzy #1988), so the
 * "what is still open" describe block below can assert on it directly.
 */
const assistantCapture = vi.hoisted(() => ({
	// `status` too (Fizzy #2646): the assistant must be told the SAVED status,
	// not the header's pending one.
	context: null as { openQuestions: string[]; status: string } | null,
	// The rewrite hand-off, captured so a test can fire it the way the
	// assistant's accept card does. Force-mounting the analysis tab changed
	// WHY `handleApplyRewrite` switches tabs — it used to be the only way the
	// proposal could reach a mounted component — so the journey needs pinning
	// rather than assuming.
	onApplyRewrite: null as ((markdown: string) => void) | null,
}));

vi.mock("@saas/projects/components/publishing-suite/TopicAssistant", () => ({
	TopicAssistant: (props: {
		context: { openQuestions: string[]; status: string };
		onApplyRewrite: (markdown: string) => void;
	}) => {
		assistantCapture.context = props.context;
		assistantCapture.onApplyRewrite = props.onApplyRewrite;
		return null;
	},
}));

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
				dataUpdatedAt: state.topicUpdatedAt,
				errorUpdatedAt: 0,
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
					aiCreatedAt: state.aiCreatedAt,
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
				isFetching: state.decisionsFetching,
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
	// The analysis version-history drawer inside this tree reads TWO paged
	// queries — the unified timeline it displays (`entries`) and the revisions
	// it takes bodies from (`revisions`). Nothing in THIS file asserts on
	// either, so an empty first page is the right stand-in — but it carries
	// both keys, because one page object is served to both queries here and a
	// page missing the key its reader wants flat-maps to `[undefined]` rather
	// than to nothing. The export has to exist at all for the same reason it
	// always did: a missing one is a module-load error that takes down cases
	// about tabs and headings, which is how it surfaced.
	useInfiniteQuery: () => ({
		data: { pages: [{ revisions: [], entries: [], nextCursor: null }] },
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
				if (state.updateStatusGate) {
					await state.updateStatusGate;
				}
				if (state.updateStatusRejects) {
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
		// The summary edit and the notes save. Both drive the real lifecycle:
		// the summary editor closes on `onSuccess` and only then, and the notes
		// field reports its failure through the component's own `onError`.
		if (procedure === "projects.publishingSuite.updateTopicSummary") {
			const run = async (vars: unknown) => {
				updateSummaryMutate(vars);
				if (state.summaryRejects) {
					const err = new Error("rejected");
					await opts.onError?.(err, vars, undefined);
					throw err;
				}
				await opts.onSuccess?.({ saved: true }, vars, undefined);
				return { saved: true };
			};
			return {
				mutate: (vars: unknown) => {
					void run(vars).catch(() => {});
				},
				mutateAsync: run,
				isPending: false,
			};
		}
		if (procedure === "projects.publishingSuite.setTopicNotes") {
			const run = async (vars: unknown) => {
				setNotesMutate(vars);
				await opts.onSuccess?.({ saved: true }, vars, undefined);
				return { saved: true };
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
	useQueryClient: () => ({ invalidateQueries }),
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
					// The drawer's DISPLAY read — one dense sequence numbering
					// AI runs and saved revisions together. It sits ALONGSIDE
					// the revisions read rather than replacing it, because the
					// timeline carries no bodies and a diff needs prose. Same
					// obligation as the entry above it.
					listAnalysisTimeline: q(
						"projects.publishingSuite.listAnalysisTimeline",
					),
					saveAnalysisRevision: m(
						"projects.publishingSuite.saveAnalysisRevision",
					),
					// The advisory change digest the review card requests once
					// per review. Same obligation as every entry around it: a
					// missing one is `undefined.mutationOptions`, which takes
					// out every case in this file rather than one assertion.
					summarizeAnalysisChanges: m(
						"projects.publishingSuite.summarizeAnalysisChanges",
					),
					listTopicDrafts: q(
						"projects.publishingSuite.listTopicDrafts",
					),
					// The per-content-type read marker behind the "Changed"
					// badge. Same obligation as every entry around it: a
					// missing one is `undefined.mutationOptions`, which takes
					// out every case in the file rather than one assertion.
					markTopicDraftRead: m(
						"projects.publishingSuite.markTopicDraftRead",
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
					// The refinement procedures, owned by ALL SEVEN panels
					// rather than by one: a refinement does not vary by content
					// type, so one set serves every tab. Same obligation as the
					// entries around them — a missing one is
					// `undefined.mutationOptions` inside the shared hook, which
					// takes out every case in this file rather than one
					// assertion.
					refineDraft: m("projects.publishingSuite.refineDraft"),
					acceptRefinement: m(
						"projects.publishingSuite.acceptRefinement",
					),
					rejectRefinement: m(
						"projects.publishingSuite.rejectRefinement",
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
					// The webinar / demo script panel owns these three (Fizzy
					// #1988, Phase 2D-1). These entries were added BEFORE the
					// panel was mounted, deliberately — same sequencing the
					// comments above already record twice: a missing entry
					// costs every case in the file the moment a tab starts
					// rendering a real panel against a mock that does not list
					// its procedures. The panel has since been mounted.
					generateWebinarScript: m(
						"projects.publishingSuite.generateWebinarScript",
					),
					adoptWebinarScriptDraft: m(
						"projects.publishingSuite.adoptWebinarScriptDraft",
					),
					saveWebinarScriptBody: m(
						"projects.publishingSuite.saveWebinarScriptBody",
					),
					// The Newsletter Blurb panel owns these three (Fizzy #1988,
					// Phase 2D-2). Same obligation every comment above records: a
					// mock that does not name a procedure a newly-live tab calls
					// is `undefined.mutationOptions`, which costs every case in
					// this file rather than one assertion.
					//
					// MEASURED, so the next reader does not over-trust these: no
					// case in this file selects the Newsletter Blurb tab, and
					// `TabsContent` mounts only the selected one — so deleting
					// these three today reddens NOTHING. They are here because the
					// first case that does select that tab would otherwise take the
					// whole file down, which is how the entries above got written.
					generateNewsletterBlurb: m(
						"projects.publishingSuite.generateNewsletterBlurb",
					),
					adoptNewsletterBlurbDraft: m(
						"projects.publishingSuite.adoptNewsletterBlurbDraft",
					),
					saveNewsletterBlurbBody: m(
						"projects.publishingSuite.saveNewsletterBlurbBody",
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
					// Per-question assignment (#1851) — routing, never an
					// answer: it leaves the root OPEN.
					setQuestionAssignees: m(
						"projects.publishingSuite.setQuestionAssignees",
					),
					// Putting a soft-closed question back on the open list.
					restoreQuestion: m(
						"projects.publishingSuite.restoreQuestion",
					),
					// Hand edits to an adopted short-form draft — the two
					// panels that had no save path until now.
					saveShortPostBody: m(
						"projects.publishingSuite.saveShortPostBody",
					),
					saveLinkedInPostBody: m(
						"projects.publishingSuite.saveLinkedInPostBody",
					),
					// The advisory draft lock. Not asserted here — the panels
					// own it — but a missing entry is a crash, not a skip.
					claimDraftLock: m(
						"projects.publishingSuite.claimDraftLock",
					),
					releaseDraftLock: m(
						"projects.publishingSuite.releaseDraftLock",
					),
					updateTopicPostTypes: m(
						"projects.publishingSuite.updateTopicPostTypes",
					),
					updateTopicStatus: m(
						"projects.publishingSuite.updateTopicStatus",
					),
					// Task 6: the contributors override write.
					updateTopicSummary: m(
						"projects.publishingSuite.updateTopicSummary",
					),
					setTopicNotes: m("projects.publishingSuite.setTopicNotes"),
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
			organizations: {
				// Reached only once a REVIEW is open: accepting an assistant
				// rewrite mounts `DiffReviewBar`, whose outcome-recording hook
				// reads the document-assistant history flag through this
				// procedure. Missing, it is `undefined.documentAssistantHistory`
				// — a render-time throw rather than a failed assertion, which is
				// the same trap every note in the tree above describes.
				documentAssistantHistory: {
					get: q("organizations.documentAssistantHistory.get"),
				},
			},
		},
	};
});

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useBasePath: () => "/app",
	// Reached only once a REVIEW is open: accepting an assistant rewrite
	// mounts `DiffReviewBar`, which reads the document-assistant history
	// flag, which reads this. Absent, the destructure throws and takes the
	// whole render with it — the same class of failure every other entry in
	// this file's mocks exists to prevent.
	useOrganizationContext: () => ({
		organizationId: "org-1",
		isOrgContext: true,
		basePath: "/app",
	}),
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
		// The private notebook, always on the wire — it rides
		// `TOPIC_LIST_SELECT`, so a fixture omitting it is a shape the API
		// never returns.
		notes: null as string | null,
		pitchUpdatedAt: null as string | null,
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
	invalidateQueries.mockClear();
	assistantCapture.context = null;
	state.topic = topic();
	state.latestAttempt = null;
	state.effective = null;
	state.aiVersion = null;
	state.revisionVersion = null;
	state.sourceAnalysisVersion = null;
	state.aiCreatedAt = null;
	state.decisionThreads = [];
	state.decisionsFetching = false;
	state.members = [];
	state.membersPending = false;
	state.membersError = false;
	state.viewerUserId = "viewer-1";
	state.pending = false;
	state.error = false;
	state.readStateRejects = false;
	state.postTypesRejects = false;
	state.summaryRejects = false;
	state.updateStatusRejects = false;
	state.updateStatusGate = null;
	state.topicUpdatedAt = Number.MAX_SAFE_INTEGER;
	refetchTopic.mockReset();
	setReadStateMutate.mockReset();
	updatePostTypesMutate.mockReset();
	updateStatusMutate.mockReset();
	updateContributorsMutate.mockReset();
	updateSummaryMutate.mockReset();
	setNotesMutate.mockReset();
	toastError.mockReset();
});

afterEach(() => {
	window.location.hash = "";
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

describe("TopicItemPage — the metadata block sits above the tabs", () => {
	it("keeps the topic's own context on screen when you change tab", async () => {
		// It used to be the LAST child of Summary & Questions, under the
		// questions — and Radix unmounts an inactive tab, so opening Decision
		// Log or Planning & Analysis took the rank-reason line and the
		// contributor and assignee controls off the page entirely. Who a topic
		// belongs to is context for the whole page, not a field on one tab.
		const user = userEvent.setup();
		state.topic = topic({
			rankReason: { kind: "role", matchedTags: ["DEVELOPER"] },
		});
		renderPage();

		expect(screen.getByText(/matches your role/i)).toBeInTheDocument();

		await user.click(screen.getByRole("tab", { name: /decision log/i }));
		expect(screen.getByText(/matches your role/i)).toBeInTheDocument();

		await user.click(
			screen.getByRole("tab", { name: /planning & analysis/i }),
		);
		expect(screen.getByText(/matches your role/i)).toBeInTheDocument();
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

/**
 * How wide each review tab is allowed to be.
 *
 * `REVIEW_MEASURE_CLASS` is SHARED, which is what makes this worth pinning: a
 * reading measure that suits a question list with an assignee picker on every
 * row is a cap on an editor, and the Planning & Analysis tab is an editor over
 * the same kind of document as the Full Specification.
 * `PlanningAnalysisEditor` had already dropped its own cap for that parity —
 * the tab then put it back one level up, so the editor read half as wide as
 * FMv2's for no reason anyone could see in the editor's own file.
 */
describe("TopicItemPage — the review tabs' width", () => {
	it("does not cap the Planning & Analysis tab", async () => {
		const user = userEvent.setup();
		renderPage();
		await user.click(
			screen.getByRole("tab", { name: /planning & analysis/i }),
		);

		const panel = screen.getByRole("tabpanel");
		expect(panel).toHaveClass("w-full");
		expect(panel).not.toHaveClass("max-w-4xl");
	});

	it("keeps the measure on Summary & Questions", () => {
		// The picker on each question row is why this one is capped at all.
		renderPage();
		expect(screen.getByRole("tabpanel")).toHaveClass("max-w-4xl");
	});

	it("keeps the measure on the Decision Log", async () => {
		// Two columns; they lose their shape below 768px.
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByRole("tab", { name: /decision log/i }));

		expect(screen.getByRole("tabpanel")).toHaveClass("max-w-4xl");
	});

	it("keeps unsaved analysis edits across a tab round trip", async () => {
		// THE REPORTED LOSS. Radix unmounts an inactive `TabsContent`, so a
		// person who typed into the analysis and glanced at Decision Log came
		// back to an empty editor — the component had gone and taken their
		// words with it. The Planning & Analysis panel is force-mounted now,
		// so it is hidden rather than destroyed.
		//
		// Feature Maturation avoids this by autosaving on a debounce and
		// flushing on unmount. That route is closed here: #1929 bought the
		// rule that the author's own Save is the only writer, after an
		// autosave raced an in-flight agent and overwrote the server with
		// pre-answer text. So the fix has to preserve state without writing
		// anything, which is exactly what staying mounted does.
		//
		// Driven through RAW (markdown) mode because its `<Textarea>` is an
		// ordinary form control whose value jsdom reports faithfully. Typing
		// into ProseMirror's contenteditable would be testing jsdom's
		// contenteditable emulation, not this page. Raw mode is a real user
		// path, and it doubles as proof the component was never remounted:
		// `viewMode` is local state seeded to "rich", so still being in raw
		// mode on return is only possible if the component survived.
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
			prose: "### Risks\n\nThe retry window is unbounded.",
			data: {},
			overridden: false,
		};

		const user = userEvent.setup();
		renderPage();

		await user.click(
			screen.getByRole("tab", { name: /planning & analysis/i }),
		);
		await user.click(screen.getByRole("button", { name: /markdown/i }));

		const editor = screen.getByPlaceholderText(
			/planning analysis in markdown format/i,
		);
		await user.clear(editor);
		await user.type(editor, "A sentence nobody has saved yet.");
		expect(editor).toHaveValue("A sentence nobody has saved yet.");

		// Away, and back.
		await user.click(screen.getByRole("tab", { name: /decision log/i }));
		await user.click(
			screen.getByRole("tab", { name: /planning & analysis/i }),
		);

		// The words are still there — not restored from anywhere, never
		// having left. Same node, so nothing was re-created around them.
		const returned = screen.getByPlaceholderText(
			/planning analysis in markdown format/i,
		);
		expect(returned).toHaveValue("A sentence nobody has saved yet.");
		expect(returned).toBe(editor);
	});

	it("hides the force-mounted analysis panel instead of showing two at once", async () => {
		// `forceMount` on its own is not enough, and the failure is loud
		// rather than subtle: Radix hands a force-mounted panel
		// `data-state="inactive"` and NO `hidden` attribute, leaving the
		// hiding to the caller. Without the `hidden` prop both panels render
		// stacked, and `getByRole("tabpanel")` matching two elements is how
		// that surfaced here.
		renderPage();

		// One panel in the accessibility tree while Summary & Questions is
		// open, even though the analysis panel is mounted behind it.
		expect(screen.getByRole("tabpanel")).toHaveAttribute(
			"aria-labelledby",
			expect.stringContaining("summaryQuestions"),
		);
	});

	it("still shows the reader a rewrite accepted from another tab", async () => {
		// `handleApplyRewrite` switches to Planning & Analysis. That used to be
		// REQUIRED — Radix unmounted the inactive tab, so a proposal accepted
		// while Summary & Questions was open landed on a component that was not
		// in the tree. Force-mounting removes that constraint, and the switch
		// has to survive it anyway for the reason that outlived it: someone who
		// just asked for a rewrite should be shown the rewrite, not left on a
		// tab where it is invisible.
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
			prose: "### Risks\n\nThe retry window is unbounded.",
			data: {},
			overridden: false,
		};

		renderPage();

		// Start where the reader actually is: the default tab, not the one
		// the proposal is for.
		expect(
			screen.getByRole("tab", { name: /summary & questions/i }),
		).toHaveAttribute("aria-selected", "true");

		await act(async () => {
			assistantCapture.onApplyRewrite?.(
				"### Risks\n\nThe retry window is bounded at five attempts.",
			);
		});

		// Brought to the tab that holds it...
		expect(
			screen.getByRole("tab", { name: /planning & analysis/i }),
		).toHaveAttribute("aria-selected", "true");
		// ...and the proposal is on screen there, painted over the current
		// document as a review rather than saved.
		expect(screen.getByRole("tabpanel")).toHaveTextContent(
			/bounded at five attempts/,
		);
	});

	it("stops the full-width tab at the assistant rail, not under it", async () => {
		// The rail is `position: fixed`, so nothing in normal flow is pushed by
		// it — the PAGE container reserves its 28rem instead. An uncapped tab
		// is only safe while it stays inside that container.
		const wrapper = document.createElement("div");
		wrapper.className = "copilotKitSidebarContentWrapper sidebarExpanded";
		document.body.appendChild(wrapper);
		try {
			const user = userEvent.setup();
			const { container } = renderPage();
			await user.click(
				screen.getByRole("tab", { name: /planning & analysis/i }),
			);

			const shell = await waitFor(() => {
				const el = container.querySelector('[class*="pr-[28rem]"]');
				expect(el).not.toBeNull();
				return el as HTMLElement;
			});
			expect(shell.contains(screen.getByRole("tabpanel"))).toBe(true);
		} finally {
			wrapper.remove();
		}
	});

	it("reserves nothing when the assistant is closed", () => {
		// The other half of the same fact: the padding is conditional, so a
		// closed rail must not leave 28rem of dead space beside the editor.
		const { container } = renderPage();
		expect(container.querySelector('[class*="pr-[28rem]"]')).toBeNull();
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

	it("does not re-fire a failed write on an unrelated re-render", () => {
		// Releasing the guard on failure was not enough to mean what its
		// comment claimed. The effect also depends on the mutation's `mutate`
		// identity, so any extra render handing it a new function re-fired it
		// against the SAME topic with no refetch in between -- which is the
		// write loop the guard exists to prevent, reached the long way round.
		state.readStateRejects = true;
		const { rerender } = renderPage();
		expect(setReadStateMutate).toHaveBeenCalledTimes(1);

		// Same topic object: a re-render, not a refetch.
		rerender(
			<TopicItemPage
				projectId="proj-1"
				topicId="topic-1"
				organizationId={null}
				canEdit
			/>,
		);
		expect(setReadStateMutate).toHaveBeenCalledTimes(1);
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
			// Always an array, never absent: the procedure's output schema
			// defaults it, so omitting it here would exercise a payload the
			// server cannot send.
			assignees: [],
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
	/*
	 * The post-types tests that stood here are gone with the control they drove.
	 *
	 * `+ Add type` in the tab strip opens `ContentTypesChecklist` in a popover,
	 * and `PostTypesDialog` no longer mounts on this page at all — one affordance
	 * instead of a popover and a modal writing through the same handler. What
	 * those tests pinned is not lost: the reasoning on each choice, grouping by
	 * the analysis's verdict, choosing a deferred format, resetting to the AI
	 * suggestion and the reader-without-controls case are all covered against the
	 * component that now owns them, in
	 * `publishing-content-types-checklist.test.tsx`. The strip's own path is
	 * covered by "adding a content type from the tab strip" below.
	 *
	 * The dialog itself still ships for the Inbox row, which has no tab strip to
	 * host a `+`, and is exercised through that row.
	 */

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

		// Post types are deliberately NOT asserted here any more: the button is
		// gone from this page for every reader, so an absence assertion would
		// pass without proving anything about `canEdit`. The strip's `+ Add type`
		// carries that case, in "adding a content type from the tab strip".
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
/**
 * Avatars that fail to load.
 *
 * The rows rendered a bare `<img src={image}>` and reached the initials only
 * when `image` was FALSY, so a URL that was present but dead — expired,
 * blocked, 404 — had no fallback at all and the browser painted its
 * broken-image glyph beside the name. Radix's `AvatarFallback` renders on a
 * failed load as well as on a missing src, which is the whole reason to use
 * it here.
 *
 * jsdom never loads an image, so a present `src` exercises exactly the path
 * that used to break: a contributor WITH a URL must still show their letter.
 */
describe("TopicItemPage — avatars that do not load", () => {
	it("shows a contributor's initial when their image URL fails", () => {
		state.topic = topic({
			contributors: [
				{
					id: "u1",
					name: "Ada",
					image: "https://example.com/gone.png",
					username: "ada",
				},
			],
		});
		renderPage();

		const row = screen.getByLabelText("Contributor: Ada");
		expect(within(row).getByText("A")).toBeInTheDocument();
	});

	it("shows an assignee's initial when their image URL fails", () => {
		state.topic = topic({
			assigneeUserIds: ["u2"],
			assignees: [
				{
					id: "u2",
					name: "Grace",
					image: "https://example.com/gone.png",
					username: "grace",
				},
			],
		});
		renderPage();

		const row = screen.getByLabelText("Assignee: Grace");
		expect(within(row).getByText("G")).toBeInTheDocument();
	});

	it("still shows the initial when there is no image at all", () => {
		// The case that always worked. Pinned beside the one that did not, so a
		// future rewrite cannot fix one by breaking the other.
		state.topic = topic({
			contributors: [
				{ id: "u1", name: "Ada", image: null, username: "ada" },
			],
		});
		renderPage();

		const row = screen.getByLabelText("Contributor: Ada");
		expect(within(row).getByText("A")).toBeInTheDocument();
	});
});

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
	// `ContributorsPicker` and owns its own `members.list` query
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

		// Seven since Newsletter Blurb joined the enum (Fizzy #1988, Phase
		// 2D-2); six of them since Webinar / Demo Script did (Phase 2D-1). A
		// literal rather than a derived count on purpose: the number here is
		// the claim that EVERY type falls back, so deriving it from the same
		// list the page renders from would make the case agree with the page
		// by construction.
		expect(within(contentTabs()).getAllByRole("tab")).toHaveLength(7);
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
			decisionKind: "CUSTOMER_NAME",
			subject: null,
			summary: null,
			content: `Question ${id}?`,
			recommendedResponse: null,
			whyItMatters: null,
			answerSource: null,
			analysisVersion: 1,
			createdAt: new Date(),
			assignees: [],
		},
		replies: [],
	});

	it("counts closed decisions against the total", () => {
		state.decisionThreads = [
			question("a", "RESOLVED"),
			question("b", "OPEN"),
			question("c", "OPEN"),
		];
		renderPage();

		expect(screen.getByTestId("topic-readiness")).toHaveTextContent(
			"1 of 3 decisions closed",
		);
	});

	it("leaves a legacy CONTENT_TYPE row out of the ratio at any status (Fizzy #1988 1B)", () => {
		// CONTENT_TYPE is a setting now: the questions panel, the Summary &
		// Questions badge and the assistant all drop it, nothing restricts on
		// it, and a regeneration soft-closes a legacy row that nobody can then
		// answer or restore. Counting it would hold the topic "not ready"
		// forever.
		const legacy = question("legacy", "POSSIBLY_RESOLVED");
		state.decisionThreads = [
			{
				...legacy,
				root: { ...legacy.root, decisionKind: "CONTENT_TYPE" },
			},
			question("a", "RESOLVED"),
		];
		renderPage();

		expect(screen.getByTestId("topic-readiness")).toHaveTextContent(
			"All 1 decisions closed",
		);
	});

	it("leaves a legacy CONTENT_TYPE row nobody can answer out of the all-clear sentence too (Fizzy #1988 1B)", async () => {
		const legacy = question("legacy", "OPEN");
		state.decisionThreads = [
			{
				...legacy,
				root: { ...legacy.root, decisionKind: "CONTENT_TYPE" },
			},
			question("a", "RESOLVED"),
		];
		// The case exists to pin a row the count EXCLUDES while it is still
		// OPEN, not one the count would exclude anyway because it was already
		// closed. Without this, changing either field below leaves every
		// assertion after it passing while the case silently stops covering
		// that scenario.
		expect(state.decisionThreads[0].root.status).toBe("OPEN");
		expect(state.decisionThreads[0].root.decisionKind).toBe("CONTENT_TYPE");
		renderPage();

		expect(screen.getByTestId("topic-readiness")).toHaveTextContent(
			"All 1 decisions closed",
		);

		const text = await readinessTooltipText();
		expect(text).toBe(
			"No question counted here is still open. Closed counts the questions under Answered and Possibly resolved.",
		);
		expect(text).not.toMatch(CLAIMS_ABOUT_ANSWERS_OR_DRAFTS);
	});

	it("counts a soft-closed question as closed (Fizzy #1851)", () => {
		// REVERSED, deliberately. This used to expect "1 of 2": a
		// POSSIBLY_RESOLVED root is one nobody answered, so counting it read as
		// calling a topic ready beside a generation tab that says it is not.
		//
		// What that missed is that nothing can ever clear one. It is not in the
		// panel's open list — it sits collapsed under "Possibly resolved" — and
		// it returns to OPEN only if a later analysis raises the same question
		// again. So it sat in the denominator as permanently unanswerable, and a
		// topic carrying one could never reach 100%. Observed: a topic reading
		// "21 of 28" with every live decision answered, all seven strays left by
		// a since-fixed subject-drift bug.
		//
		// Feature Maturation, which this mirrors on the same DecisionStatus
		// enum, has always counted it this way.
		state.decisionThreads = [
			question("a", "POSSIBLY_RESOLVED"),
			question("b", "RESOLVED"),
		];
		renderPage();

		expect(screen.getByTestId("topic-readiness")).toHaveTextContent(
			"All 2 decisions closed",
		);
	});

	/**
	 * The tooltip's words, read the way a person gets them.
	 *
	 * Opened by focus: Radix opens a tooltip on focus with no delay, while a
	 * hover waits the provider's 500 ms, which this widget cannot shorten.
	 * Radix renders the content twice — once visibly, once in a visually hidden
	 * `role="tooltip"` element — so the copy is read from that one element.
	 */
	const readinessTooltipText = async () => {
		fireEvent.focus(screen.getByTestId("topic-readiness"));
		return (await screen.findByRole("tooltip")).textContent;
	};
	const CLAIMS_ABOUT_ANSWERS_OR_DRAFTS =
		/has an answer|has been answered|settled|assert/i;

	it("names the two groups it counts as closed when nothing is open", async () => {
		state.decisionThreads = [
			question("a", "RESOLVED"),
			question("b", "POSSIBLY_RESOLVED"),
		];
		renderPage();

		const text = await readinessTooltipText();
		expect(text).toBe(
			"No question counted here is still open. Closed counts the questions under Answered and Possibly resolved.",
		);
		expect(text).not.toMatch(CLAIMS_ABOUT_ANSWERS_OR_DRAFTS);
		// The group names are the panel's own headings, on the same page.
		for (const group of [
			"Answered questions",
			"Possibly resolved questions",
		]) {
			const heading = document.querySelector(
				`section[aria-label="${group}"] h3`,
			);
			expect(heading?.textContent).toBeTruthy();
			expect(text).toContain(heading?.textContent ?? "");
		}
	});

	it("says how many are still open, and nothing about answers or drafts", async () => {
		state.decisionThreads = [
			question("a", "OPEN"),
			question("b", "RESOLVED"),
		];
		renderPage();

		const text = await readinessTooltipText();
		expect(text).toBe("1 still open. 50% closed.");
		expect(text).not.toMatch(CLAIMS_ABOUT_ANSWERS_OR_DRAFTS);
	});

	it("says every question is closed while a blocker still holds the topic back", async () => {
		// `blockerThread` (file scope) is an OPEN MISSING_QUOTE blocker: no
		// question is open, so the all-clear is withheld only by the blocker.
		state.decisionThreads = [question("a", "RESOLVED"), blockerThread()];
		renderPage();

		const text = await readinessTooltipText();
		expect(text).toBe(
			"Every question is closed (100%). 1 blocking item still needed before this topic is ready.",
		);
		expect(text).not.toMatch(CLAIMS_ABOUT_ANSWERS_OR_DRAFTS);
	});

	it("ignores AI update rows, which nobody can answer", () => {
		const update = question("u", "OPEN");
		state.decisionThreads = [
			{ ...update, root: { ...update.root, kind: "AI_UPDATE" } },
			question("a", "RESOLVED"),
		];
		renderPage();

		expect(screen.getByTestId("topic-readiness")).toHaveTextContent(
			"All 1 decisions closed",
		);
	});

	it("shows nothing at all when the analysis raised no questions", () => {
		state.decisionThreads = [];
		renderPage();

		expect(screen.queryByTestId("topic-readiness")).not.toBeInTheDocument();
	});
});

/**
 * Questions are minted at the moment an analysis run completes —
 * `reconcileTopicQuestions` runs inside `completePlanningAnalysis`, in the same
 * transaction that makes the analysis READY. The decisions query has no
 * interval, so it was fetched once on mount, came back empty because the run
 * had not happened, and nothing ever asked again.
 *
 * The page then contradicted itself in one frame: format tabs reading
 * "Recommended" — off the analysis query, which polls — beside a panel saying
 * "No open questions yet. They arrive with the planning analysis." They had.
 */
describe("TopicItemPage — questions arriving with a finished analysis", () => {
	const generating = { id: "pa-1", version: 1, status: "GENERATING" };
	const ready = { id: "pa-1", version: 1, status: "READY" };
	const decisionsKey = [
		"projects.publishingSuite.listTopicDecisions",
		{ projectId: "proj-1", topicId: "topic-1", organizationId: null },
	];

	it("refetches the decisions when a run leaves GENERATING", () => {
		state.latestAttempt = generating;
		const { rerender } = renderPage();
		invalidateQueries.mockClear();

		state.latestAttempt = ready;
		rerender(
			<TopicItemPage
				projectId="proj-1"
				topicId="topic-1"
				organizationId={null}
				canEdit
			/>,
		);

		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: decisionsKey,
		});
	});

	it("refetches them when the run FAILED too", () => {
		// Reconciliation may still have soft-closed questions the previous run
		// raised, and the panel explains a failure differently from an empty
		// list — so a failed run must not leave a stale question set on screen.
		state.latestAttempt = generating;
		const { rerender } = renderPage();
		invalidateQueries.mockClear();

		state.latestAttempt = { ...ready, status: "FAILED" };
		rerender(
			<TopicItemPage
				projectId="proj-1"
				topicId="topic-1"
				organizationId={null}
				canEdit
			/>,
		);

		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: decisionsKey,
		});
	});

	it("does not invalidate on every refetch of an already-finished analysis", () => {
		// The guard is the TRANSITION, not the terminal status. Keyed on
		// `status === "READY"` this would re-fire on each refetch and
		// invalidate in a loop.
		state.latestAttempt = ready;
		const { rerender } = renderPage();
		invalidateQueries.mockClear();

		rerender(
			<TopicItemPage
				projectId="proj-1"
				topicId="topic-1"
				organizationId={null}
				canEdit
			/>,
		);

		expect(invalidateQueries).not.toHaveBeenCalledWith({
			queryKey: decisionsKey,
		});
	});
});

/**
 * "Your analysis is behind your answers", said where answering happens.
 *
 * The full banner with its Regenerate button lives on Planning & Analysis.
 * Radix unmounts an inactive `TabsContent` and the default tab is Summary &
 * Questions — so the banner could not fire for the person who had just caused
 * it. Nothing switches tabs on answer either: `answerTopicQuestion`'s
 * `onSuccess` only invalidates. The notice therefore has to be on this tab.
 */
describe("TopicItemPage — the analysis is behind the answers", () => {
	const answeredAt = (iso: string) => ({
		root: {
			id: "decision-q1",
			parentId: null,
			kind: "QUESTION",
			status: "RESOLVED",
			authorType: "AGENT",
			authorUserId: null,
			questionId: "q1",
			decisionKind: "CUSTOMER_NAME",
			subject: "the customer name",
			summary: "May we name the customer?",
			content: null,
			recommendedResponse: null,
			answerSource: "MANUAL",
			analysisVersion: 1,
			createdAt: new Date("2026-08-30T10:00:00Z"),
			assignees: [],
		},
		replies: [
			{
				id: "reply-q1",
				parentId: "decision-q1",
				kind: "QUESTION",
				status: "RESOLVED",
				authorType: "USER",
				authorUserId: "u1",
				questionId: "q1",
				decisionKind: "CUSTOMER_NAME",
				subject: null,
				summary: null,
				content: "Yes, they approved it.",
				recommendedResponse: null,
				answerSource: "MANUAL",
				analysisVersion: 1,
				createdAt: new Date(iso),
				assignees: [],
			},
		],
	});

	it("says so on the default tab, without being opened", () => {
		state.aiCreatedAt = new Date("2026-09-01T10:00:00Z");
		state.decisionThreads = [answeredAt("2026-09-02T10:00:00Z")];
		renderPage();

		// ABOVE the tabs, so it is on screen for the person who just made it
		// true by answering — the notice used to live inside the Planning &
		// Analysis tab, which Radix unmounts while Summary & Questions is open.
		const banner = screen.getByTestId("analysis-behind-decisions");
		expect(banner).toHaveTextContent(
			"1 answer was recorded after the analysis was written",
		);

		// And it carries the action, rather than a link to a control on
		// another tab. One button, because the tab's own header Regenerate
		// stands down while this is up (design-QA #5).
		expect(
			within(banner).getByRole("button", {
				name: /regenerate analysis/i,
			}),
		).toBeInTheDocument();
		expect(
			screen.queryAllByRole("button", {
				name: /regenerate (planning )?analysis/i,
			}),
		).toHaveLength(1);
	});

	it("counts a BLOCKER answered after the analysis, not just questions", () => {
		// The case that most needs the prompt: what a blocker answer records —
		// the quote, the approval — reaches the draft writers ONLY through a
		// regenerated analysis, and the banner used to skip it entirely.
		const answeredBlocker = answeredAt("2026-09-02T10:00:00Z");
		state.aiCreatedAt = new Date("2026-09-01T10:00:00Z");
		state.decisionThreads = [
			{
				root: {
					...answeredBlocker.root,
					kind: "BLOCKER",
					decisionKind: "MISSING_QUOTE",
					summary: "We have no approved customer quote.",
					status: "RESOLVED",
				},
				replies: answeredBlocker.replies.map((r) => ({
					...r,
					kind: "BLOCKER",
				})),
			},
		];
		renderPage();

		expect(
			screen.getByTestId("analysis-behind-decisions"),
		).toHaveTextContent(
			"1 answer was recorded after the analysis was written",
		);
	});

	it("does not treat an Ask note on an open question as an answer", () => {
		state.aiCreatedAt = new Date("2026-09-01T10:00:00Z");
		const asked = answeredAt("2026-09-02T10:00:00Z");
		state.decisionThreads = [
			{
				root: { ...asked.root, status: "OPEN" },
				replies: asked.replies.map((r) => ({
					...r,
					status: "OPEN",
					content: "@Sam Example can you confirm this?",
				})),
			},
		];
		const { unmount } = renderPage();

		expect(
			screen.queryByTestId("analysis-behind-decisions"),
		).not.toBeInTheDocument();

		// The control: the same question answered at the same time is counted.
		unmount();
		state.decisionThreads = [answeredAt("2026-09-02T10:00:00Z")];
		renderPage();
		expect(
			screen.getByTestId("analysis-behind-decisions"),
		).toHaveTextContent(
			"1 answer was recorded after the analysis was written",
		);
	});

	it("stays silent when every answer predates the analysis", () => {
		state.aiCreatedAt = new Date("2026-09-03T10:00:00Z");
		state.decisionThreads = [answeredAt("2026-09-02T10:00:00Z")];
		renderPage();

		expect(
			screen.queryByTestId("analysis-behind-decisions"),
		).not.toBeInTheDocument();
	});

	it("stays silent when no analysis has been written yet", () => {
		// Nothing to be behind.
		state.aiCreatedAt = null;
		state.decisionThreads = [answeredAt("2026-09-02T10:00:00Z")];
		renderPage();

		expect(
			screen.queryByTestId("analysis-behind-decisions"),
		).not.toBeInTheDocument();
	});
});

/**
 * Participants belong in the header.
 *
 * "that kind of stuff feels like it goes in the header somewhere" — it is
 * context for the whole topic rather than a field you go looking for. The same
 * component the metadata block uses, so the overflow rules cannot diverge, and
 * the metadata block stops rendering them so the page does not say it twice.
 *
 * Placement only. Ordering them by who ran the meeting is a different ask, and
 * a dropped one — the transcript row carries `speakerNames` and no organizer.
 */
describe("TopicItemPage — meeting participants", () => {
	const SPEAKERS = {
		members: [
			{ userId: "u1", name: "Ada Lovelace", username: null },
			{ userId: "u2", name: "Grace Hopper", username: null },
		],
		overflowCount: 0,
	};

	it("names them once, in the header", () => {
		state.topic = { ...state.topic, meetingSpeakers: SPEAKERS };
		renderPage();

		expect(screen.getAllByText(/Ada Lovelace/)).toHaveLength(1);
	});

	it("says nothing when the topic came from no meeting", () => {
		state.topic = { ...state.topic, meetingSpeakers: null };
		renderPage();

		expect(
			screen.queryByText(/Meeting participants/i),
		).not.toBeInTheDocument();
	});
});

/**
 * Adding a content type from the tab strip.
 *
 * "I would put that on the same bar that you see the different tabs ... it gets
 * hidden down there" — the row IS the set of things this topic is producing, so
 * "+" says you can add to it without needing a label.
 *
 * A POPOVER carrying the checklist that already exists, not a new modal: the
 * modal is what the checklist replaced, and reintroducing one here would walk
 * back "its simple setting, not question, it could be checkbox".
 */
describe("TopicItemPage — adding a content type from the tab strip", () => {
	it("offers Add type beside the generation tabs", () => {
		renderPage();

		expect(
			screen.getByRole("button", { name: /add type/i }),
		).toBeInTheDocument();
	});

	it("offers nothing to a reader who may not edit", () => {
		renderPage(false);

		expect(
			screen.queryByRole("button", { name: /add type/i }),
		).not.toBeInTheDocument();
	});

	it("opens the same checklist, not a second dialog", async () => {
		renderPage();

		await userEvent.click(
			screen.getByRole("button", { name: /add type/i }),
		);

		// The checklist's own reset control is the cheapest proof it is the
		// checklist rather than a lookalike.
		expect(await screen.findByRole("dialog")).toBeInTheDocument();
	});

	it("is the ONLY content-types control on the page", () => {
		// It used to render a second, always-open copy of the same checklist
		// above the questions, so opening the popover put the identical list
		// on screen twice — the owner's "this section duplicated; i think plus
		// near tabs is enough for this". Closed, nothing of the checklist
		// should be on the page at all.
		renderPage();

		// The second copy was the collapsible variant, whose header is a
		// button named "Content types <summary>". The popover's copy is
		// `alwaysOpen` and renders no such button — and is unmounted anyway
		// until `+ Add type` is clicked.
		expect(
			screen.queryByRole("button", { name: /^content types/i }),
		).not.toBeInTheDocument();
	});
});

/**
 * What the topic is MISSING, as its own class.
 *
 * "Recognize what maybe is missing, beyond the questions that we would ask."
 * A question is decided at your desk; a blocker takes somebody else and an
 * artifact that does not exist yet. They read identically until one of them
 * says so.
 */
/**
 * The summary, editable where it is read.
 *
 * `pitch` is the paragraph under the title AND the text every generation
 * prompt is handed, so a wrong one is wrong in seven drafts. It was
 * read-only: the only way to fix it was to decline the topic and let the
 * generator raise it again.
 */
describe("TopicItemPage — editing the summary", () => {
	it("shows a reader the summary with no way to change it", () => {
		renderPage(false);

		expect(
			screen.getByText(/we cut duplicate deliveries/i),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /edit summary/i }),
		).not.toBeInTheDocument();
	});

	it("opens an editor seeded with the summary on record", async () => {
		const user = userEvent.setup();
		renderPage();

		await user.click(screen.getByRole("button", { name: /edit summary/i }));

		expect(screen.getByLabelText("Topic summary")).toHaveValue(
			"We cut duplicate deliveries by bounding the retry window.",
		);
	});

	it("sends the edited text, and caps it where the server does", async () => {
		const user = userEvent.setup();
		renderPage();

		await user.click(screen.getByRole("button", { name: /edit summary/i }));
		const field = screen.getByLabelText("Topic summary");
		// 500, matching `z.string().max(500)` — a field that accepts more than
		// the route does turns a typo into a rejected save.
		expect(field).toHaveAttribute("maxlength", "500");

		await user.clear(field);
		await user.type(field, "A sharper summary.");
		await user.click(screen.getByRole("button", { name: /save summary/i }));

		expect(updateSummaryMutate).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				topicId: "topic-1",
				pitch: "A sharper summary.",
			}),
		);
		// Closed, and only after the write landed.
		expect(
			screen.queryByLabelText("Topic summary"),
		).not.toBeInTheDocument();
	});

	it("clears with null rather than an empty string", async () => {
		// `pitch` is NOT trimmed server-side, so a blank string would persist as
		// a summary made of spaces. `null` is the documented clear.
		const user = userEvent.setup();
		renderPage();

		await user.click(screen.getByRole("button", { name: /edit summary/i }));
		await user.clear(screen.getByLabelText("Topic summary"));
		await user.type(screen.getByLabelText("Topic summary"), "   ");
		await user.click(screen.getByRole("button", { name: /save summary/i }));

		expect(updateSummaryMutate).toHaveBeenCalledWith(
			expect.objectContaining({ pitch: null }),
		);
	});

	it("keeps the typed text on screen when the save fails", async () => {
		// The draft is the only copy of it. Closing the editor over a failed
		// write discards what the person wrote and says nothing about why.
		state.summaryRejects = true;
		const user = userEvent.setup();
		renderPage();

		await user.click(screen.getByRole("button", { name: /edit summary/i }));
		await user.clear(screen.getByLabelText("Topic summary"));
		await user.type(screen.getByLabelText("Topic summary"), "Not saved.");
		await user.click(screen.getByRole("button", { name: /save summary/i }));

		expect(screen.getByLabelText("Topic summary")).toHaveValue(
			"Not saved.",
		);
		expect(toastError).toHaveBeenCalled();
	});

	it("writes nothing on Cancel", async () => {
		const user = userEvent.setup();
		renderPage();

		await user.click(screen.getByRole("button", { name: /edit summary/i }));
		await user.type(
			screen.getByLabelText("Topic summary"),
			" and abandoned",
		);
		await user.click(screen.getByRole("button", { name: /^cancel$/i }));

		expect(updateSummaryMutate).not.toHaveBeenCalled();
		expect(
			screen.getByText(/we cut duplicate deliveries/i),
		).toBeInTheDocument();
	});

	it("offers to add one when the topic has no summary", async () => {
		state.topic = topic({ pitch: null });
		const user = userEvent.setup();
		renderPage();

		expect(screen.getByText(/no summary yet/i)).toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: /add a summary/i }),
		);
		expect(screen.getByLabelText("Topic summary")).toHaveValue("");
	});
});

/**
 * The private notebook.
 *
 * The hint says the AI never reads or edits this, which makes it a CONTRACT
 * rather than a description of today — the last case below is what keeps it
 * one from this page's side.
 */
describe("TopicItemPage — private notes", () => {
	it("says whose notebook it is, and that the AI stays out", () => {
		renderPage();

		expect(
			screen.getByText(/your private notebook for this topic/i),
		).toBeInTheDocument();
		expect(
			screen.getByText(/the ai never reads or edits this/i),
		).toBeInTheDocument();
	});

	it("shows the notes on record", () => {
		state.topic = topic({ notes: "Ask Dana about the numbers." });
		renderPage();

		expect(screen.getByRole("textbox", { name: "Notes" })).toHaveValue(
			"Ask Dana about the numbers.",
		);
	});

	it("saves on blur, through setTopicNotes", async () => {
		const user = userEvent.setup();
		renderPage();

		await user.type(
			screen.getByRole("textbox", { name: "Notes" }),
			"Check the graph.",
		);
		await user.tab();

		expect(setNotesMutate).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				topicId: "topic-1",
				notes: "Check the graph.",
			}),
		);
	});

	it("sends the text UNTRIMMED, as the column stores it", async () => {
		// The procedure trims only to TEST emptiness. A client-side trim would
		// eat the trailing blank line every notebook grows.
		const user = userEvent.setup();
		renderPage();

		await user.type(
			screen.getByRole("textbox", { name: "Notes" }),
			"  padded  ",
		);
		await user.tab();

		expect(setNotesMutate).toHaveBeenCalledWith(
			expect.objectContaining({ notes: "  padded  " }),
		);
	});

	it("writes nothing when a blur changed nothing", async () => {
		state.topic = topic({ notes: "Unchanged." });
		const user = userEvent.setup();
		renderPage();

		await user.click(screen.getByRole("textbox", { name: "Notes" }));
		await user.tab();

		expect(setNotesMutate).not.toHaveBeenCalled();
	});

	it("gives a reader the notes without a field that would 403 on blur", () => {
		state.topic = topic({ notes: "Reader can see this." });
		renderPage(false);

		expect(screen.getByText("Reader can see this.")).toBeInTheDocument();
		expect(
			screen.queryByRole("textbox", { name: "Notes" }),
		).not.toBeInTheDocument();
	});

	it("never hands the notes to the assistant", async () => {
		// The hint is a promise. This page's only AI-facing consumer is the
		// assistant rail's `context` prop, and the notes must not be anywhere
		// in it — not under a key of their own, and not smuggled in by
		// spreading the topic.
		state.topic = topic({ notes: "SECRET-NOTEBOOK-TEXT" });
		renderPage();

		// WAIT for the hand-off first. The rail arrives through `next/dynamic`,
		// so a synchronous read here is `null` and the assertion below passes
		// against a context that was never captured — proving nothing.
		await waitFor(() => expect(assistantCapture.context).not.toBeNull());
		expect(JSON.stringify(assistantCapture.context)).not.toContain(
			"SECRET-NOTEBOOK-TEXT",
		);
	});
});

describe("TopicItemPage — blockers", () => {
	const blocker = (overrides: Record<string, unknown> = {}) => ({
		root: {
			id: "b1",
			parentId: null,
			kind: "BLOCKER",
			status: "OPEN",
			authorType: "AGENT",
			authorUserId: null,
			questionId: "blk-quote",
			decisionKind: "MISSING_QUOTE",
			subject: "a customer quote",
			summary: "We have no approved customer quote for this case study.",
			content: null,
			recommendedResponse: null,
			answerOptions: null,
			whyItMatters: "A case study without one is a different piece.",
			answerSource: null,
			analysisVersion: 1,
			createdAt: new Date("2026-09-01T10:00:00Z"),
			assignees: [],
			...overrides,
		},
		replies: [],
	});

	it("names what is missing, and why", () => {
		state.decisionThreads = [blocker()];
		renderPage();

		expect(
			screen.getByText(
				"We have no approved customer quote for this case study.",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText("A case study without one is a different piece."),
		).toBeInTheDocument();
	});

	it("offers both ways out — answer it, or say it is not needed", () => {
		state.decisionThreads = [blocker()];
		renderPage();

		// "Answer", not "Mark provided": the text it opens is a real answer the
		// regenerated analysis writes from, and bookkeeping wording taught
		// people the click alone was the whole act.
		const section = screen.getByLabelText("Before this can be published");
		expect(
			within(section).getByRole("button", { name: "Answer" }),
		).toBeInTheDocument();
		expect(
			within(section).getByRole("button", { name: /not needed/i }),
		).toBeInTheDocument();
	});

	it("drops a cleared blocker out of the section", () => {
		// Cleared is history, and history lives in the Decision Log. Leaving it
		// here would make the section permanent and teach a reader to skip it —
		// the exact failure the section exists to avoid.
		state.decisionThreads = [blocker({ status: "RESOLVED" })];
		renderPage();

		expect(
			screen.queryByLabelText("Before this can be published"),
		).not.toBeInTheDocument();
	});

	it("shows a reader no way to clear one", () => {
		state.decisionThreads = [blocker()];
		renderPage(false);

		expect(
			screen.queryByRole("button", { name: /not needed/i }),
		).not.toBeInTheDocument();
	});

	it("keeps blockers out of the questions list", () => {
		// Both live in one table. The questions panel filters by kind, and a
		// blocker leaking in would be asked as if a person could answer it —
		// so the text must appear exactly once, in the blockers section.
		state.decisionThreads = [blocker()];
		renderPage();

		const section = screen.getByLabelText("Before this can be published");
		const summary =
			"We have no approved customer quote for this case study.";
		expect(within(section).getByText(summary)).toBeInTheDocument();
		expect(screen.getAllByText(summary)).toHaveLength(1);
	});
});

/** A blocker root, as `listTopicDecisions` returns one. */
function blockerThread(overrides: Record<string, unknown> = {}) {
	return {
		root: {
			id: "b-count",
			parentId: null,
			kind: "BLOCKER",
			status: "OPEN",
			authorType: "AGENT",
			authorUserId: null,
			questionId: "blk-count",
			decisionKind: "MISSING_QUOTE",
			subject: "a customer quote",
			summary: "No approved quote yet.",
			content: null,
			recommendedResponse: null,
			answerOptions: null,
			whyItMatters: null,
			answerSource: null,
			analysisVersion: 1,
			createdAt: new Date("2026-09-01T10:00:00Z"),
			assignees: [],
			...overrides,
		},
		replies: [],
	};
}

/** An unanswered question root. */
function openQuestionThread(
	id: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		root: {
			id: `q-${id}`,
			parentId: null,
			kind: "QUESTION",
			status: "OPEN",
			authorType: "AGENT",
			authorUserId: null,
			questionId: id,
			decisionKind: "CUSTOMER_NAME",
			subject: "the customer name",
			summary: "May we name the customer?",
			content: null,
			recommendedResponse: null,
			answerOptions: null,
			whyItMatters: null,
			answerSource: null,
			analysisVersion: 1,
			createdAt: new Date("2026-09-01T10:00:00Z"),
			assignees: [],
			...overrides,
		},
		replies: [],
	};
}

/**
 * The two counts on the Summary & Questions tab.
 *
 * Different colours because they are different asks: red is a blocker somebody
 * has to go and get, amber is a question you can answer here and now.
 * Collapsing them into one number puts the errand and the decision behind the
 * same digit.
 */
describe("TopicItemPage — tab counts", () => {
	it("counts blockers and questions separately", () => {
		state.decisionThreads = [
			blockerThread(),
			openQuestionThread("q-one"),
			openQuestionThread("q-two"),
		];
		renderPage();

		expect(screen.getByLabelText("1 blocking item")).toBeInTheDocument();
		expect(screen.getByLabelText("2 open questions")).toBeInTheDocument();
	});

	it("shows no badge at all at zero", () => {
		// A zero badge is a permanent mark, and a permanent mark stops being read.
		state.decisionThreads = [];
		renderPage();

		expect(
			screen.queryByLabelText(/blocking item/),
		).not.toBeInTheDocument();
		expect(
			screen.queryByLabelText(/open question/),
		).not.toBeInTheDocument();
	});

	it("does not count a legacy content-type row as a question", () => {
		// The checklist replaced those, and the panel refuses to render them —
		// a badge counting one would point at a question that is not there.
		state.decisionThreads = [
			openQuestionThread("q-legacy", { decisionKind: "CONTENT_TYPE" }),
		];
		renderPage();

		expect(
			screen.queryByLabelText(/open question/),
		).not.toBeInTheDocument();
	});

	it("counts OPEN questions only, whatever their kind (Fizzy #1851)", () => {
		// REVERSED, deliberately. This used to expect 3 — every question that
		// was not RESOLVED, soft-closed ones included. But a POSSIBLY_RESOLVED
		// root is not in the panel's open list, so the badge was promising work
		// the tab does not offer, and nothing the reader could do made it go
		// down. A topic whose every live decision was answered still badged 7.
		//
		// The drafting side is deliberately NOT changed with it:
		// `isUnresolvedDecisionStatus` still admits POSSIBLY_RESOLVED for the
		// generation-tab warnings and the prompt restrictions, because an
		// unapproved customer name is unapproved whether or not the newest
		// analysis still asks about it.
		state.decisionThreads = [
			openQuestionThread("audience", {
				decisionKind: "AUDIENCE_SCOPE",
				subject: "who this is written for",
			}),
			openQuestionThread("other", {
				decisionKind: "OTHER",
				status: "POSSIBLY_RESOLVED",
				subject: "launch timing",
			}),
			openQuestionThread("name-soft", { status: "POSSIBLY_RESOLVED" }),
			openQuestionThread("name-done", { status: "RESOLVED" }),
		];
		renderPage();

		expect(screen.getByLabelText("1 open question")).toBeInTheDocument();
	});

	it("still badges a generation tab for a soft-closed safety question (Fizzy #1851)", () => {
		// The pair that proves the two halves were separated rather than both
		// flipped: the Summary & Questions badge is gone, the drafting caution
		// is not.
		state.decisionThreads = [
			openQuestionThread("name-soft", {
				decisionKind: "CUSTOMER_NAME",
				status: "POSSIBLY_RESOLVED",
			}),
		];
		renderPage();

		// Anchored: the Summary & Questions badge's label is the whole string,
		// so nothing else on the page can satisfy or break this absence check —
		// the generation tab's caution below counts the same question as
		// unresolved, and that is the half this test asserts is still there.
		expect(
			screen.queryByLabelText(/^\d+ open questions?$/),
		).not.toBeInTheDocument();
		expect(
			screen.getAllByText(
				/1 unresolved question before this can be drafted cleanly/i,
			).length,
		).toBeGreaterThan(0);
	});
});

/**
 * What the assistant is told is still open (Fizzy #1988).
 *
 * `assistantContext.openQuestions` used to select with `subject ?? content`,
 * which fails twice: `??` lets a whitespace-only subject win, and `content`
 * is null on every question root — the question's text is in `summary`.
 */
describe("TopicItemPage — what the assistant is told is still open (Fizzy #1988)", () => {
	it("names a blank-subject question by its text instead of forwarding a blank", async () => {
		// `??` selects on null, not on emptiness, so a subject of spaces won
		// and reached the assistant as "   ". The question's text lives in
		// `summary` — the only field `reconcileTopicQuestions` writes it to —
		// so that is what the assistant should be told instead.
		state.decisionThreads = [
			openQuestionThread("blank", { subject: "   " }),
		];
		renderPage();
		await waitFor(() =>
			expect(assistantCapture.context?.openQuestions).toEqual([
				"May we name the customer?",
			]),
		);
	});

	it("folds a multiline question subject", async () => {
		state.decisionThreads = [
			openQuestionThread("multiline", { subject: "first\nsecond" }),
		];
		renderPage();
		await waitFor(() =>
			expect(assistantCapture.context?.openQuestions).toEqual([
				"first second",
			]),
		);
	});

	it("names a question with no subject by its summary", async () => {
		// Without `summary` in the chain a subject-less open question fell
		// through to `content`, which is null on every question root, and the
		// assistant was never told about it.
		state.decisionThreads = [
			openQuestionThread("no-subject", { subject: null }),
		];
		renderPage();
		await waitFor(() =>
			expect(assistantCapture.context?.openQuestions).toEqual([
				"May we name the customer?",
			]),
		);
	});

	it("tells the assistant about every unresolved question, soft-closed and non-safety kinds included (1B)", async () => {
		state.decisionThreads = [
			openQuestionThread("audience", {
				decisionKind: "AUDIENCE_SCOPE",
				subject: "who this is written for",
			}),
			openQuestionThread("other", {
				decisionKind: "OTHER",
				status: "POSSIBLY_RESOLVED",
				subject: "launch timing",
			}),
			openQuestionThread("name-soft", { status: "POSSIBLY_RESOLVED" }),
			openQuestionThread("name-done", { status: "RESOLVED" }),
		];
		renderPage();
		await waitFor(() =>
			expect(assistantCapture.context?.openQuestions).toEqual([
				"who this is written for",
				"launch timing",
				"the customer name",
			]),
		);
	});
});

/**
 * The header block, after the density pass.
 *
 * Two separate complaints, both about a reader not being able to place what
 * they were looking at: the rank reason took a full-width band of its own for
 * four words, and a lone avatar with a bare username beside it said nothing
 * about what that name claimed.
 */
describe("TopicItemPage — the header says what it is, once", () => {
	it("puts the rank reason on the title row and nowhere else", () => {
		// `TopicDetails` renders it too unless told not to, and the page used
		// to let it: hoisting without `showRankReason={false}` would put the
		// same sentence on screen twice.
		state.topic = topic({
			rankReason: { kind: "contributed" },
		});
		renderPage();

		expect(screen.getAllByText(/based on your contribution/i)).toHaveLength(
			1,
		);
	});

	it("labels the contributor list, as the assignee list already was", () => {
		state.topic = topic({
			contributors: [
				{ id: "u1", name: "Ada", image: null, username: "ada" },
			],
		});
		renderPage();

		const list = screen.getByRole("list", { name: "Contributors" });
		expect(within(list).getByText("Contributors")).toBeInTheDocument();
		expect(within(list).getByText("ada")).toBeInTheDocument();
	});
});

/**
 * An analysis goes stale two ways, and the second one arrived with the
 * editable summary: the analysis is derived from that text, so an edit leaves
 * it describing a topic that no longer says what it said.
 */
describe("TopicItemPage — a summary edit makes the analysis stale too", () => {
	it("raises the notice when the summary changed after the analysis was written", () => {
		state.topic = topic({
			pitchUpdatedAt: "2026-02-02T00:00:00.000Z",
		});
		state.aiCreatedAt = new Date("2026-01-01T00:00:00.000Z");
		renderPage();

		expect(
			screen.getByTestId("analysis-behind-decisions"),
		).toHaveTextContent(/the summary changed after the analysis/i);
	});

	it("stays quiet when the summary was edited BEFORE the analysis ran", () => {
		// The negative control: the column is stamped on every summary write,
		// including ones the analysis has already folded in.
		state.topic = topic({
			pitchUpdatedAt: "2026-01-01T00:00:00.000Z",
		});
		state.aiCreatedAt = new Date("2026-02-02T00:00:00.000Z");
		renderPage();

		expect(
			screen.queryByTestId("analysis-behind-decisions"),
		).not.toBeInTheDocument();
	});
});

describe("TopicItemPage — a question link", () => {
	const linkedQuestion = (status: "OPEN" | "RESOLVED") => ({
		root: {
			id: "decision-linked",
			parentId: null,
			kind: "QUESTION",
			status,
			authorType: "AGENT",
			authorUserId: null,
			questionId: "q-linked",
			decisionKind: "CUSTOMER_NAME",
			subject: "the customer name",
			summary: "May we name the customer?",
			content: null,
			recommendedResponse: null,
			answerSource: null,
			analysisVersion: 1,
			createdAt: new Date("2026-08-30T10:00:00Z"),
			assignees: [],
		},
		replies: [],
	});

	it("opens the group of the list that arrives after a refetch, not of the cached one", () => {
		window.location.hash = "#q-decision-linked";
		state.decisionsFetching = true;
		state.decisionThreads = [linkedQuestion("OPEN")];
		const { rerender } = renderPage();

		state.decisionsFetching = false;
		state.decisionThreads = [linkedQuestion("RESOLVED")];
		rerender(
			<TopicItemPage
				projectId="proj-1"
				topicId="topic-1"
				organizationId={null}
				canEdit
			/>,
		);

		const answered = screen.getByRole("region", {
			name: "Answered questions",
		});
		expect(
			within(answered).getByRole("button", { name: /^answered/i }),
		).toHaveAttribute("aria-expanded", "true");
	});
});

describe("#2646 — status is editable on the topic page", () => {
	const statusControl = () =>
		screen.getByRole("combobox", { name: /^Status for / });
	// While a Radix modal Dialog is open, everything outside it is
	// aria-hidden and `getByRole` skips it (executed by panel C). Matched on
	// the `aria-label` ATTRIBUTE, not the computed name: `aria-hidden`'s
	// `hideOthers` keeps every `[aria-live]` region reachable, so the save
	// indicator's sibling — the combobox itself — is marked aria-hidden
	// directly, and a node that is itself aria-hidden computes an EMPTY
	// accessible name (testing-library does not pass `hidden` through to
	// the name computation). `name:` would then never match.
	const statusControlBehindModal = () => {
		const matches = screen
			.getAllByRole("combobox", { hidden: true })
			.filter((el) =>
				el.getAttribute("aria-label")?.startsWith("Status for "),
			);
		expect(matches).toHaveLength(1);
		return matches[0];
	};

	it("offers all five statuses to an editor, with the current one shown", async () => {
		const user = userEvent.setup();
		state.topic = topic({ status: "SUGGESTION" });
		renderPage();

		expect(statusControl()).toHaveTextContent("Suggestion");
		await user.click(statusControl());
		for (const label of [
			"Suggestion",
			"Selected",
			"In progress",
			"Published",
			"Declined",
		]) {
			expect(
				await screen.findByRole("option", { name: label }),
			).toBeInTheDocument();
		}
	});

	it("shows Selected at once, says Saving… then Saved, and refreshes the planning analysis", async () => {
		const user = userEvent.setup();
		let release!: () => void;
		state.updateStatusGate = new Promise<void>((r) => {
			release = r;
		});
		state.topic = topic({ status: "SUGGESTION" });
		renderPage();

		const getTopicInvalidations = () =>
			invalidateQueries.mock.calls.filter((c) =>
				JSON.stringify(c[0]).includes("getTopic"),
			).length;
		const before = getTopicInvalidations();
		await user.click(statusControl());
		await user.click(
			await screen.findByRole("option", { name: "Selected" }),
		);

		await waitFor(() =>
			expect(statusControl()).toHaveTextContent("Selected"),
		);
		expect(
			screen.getByTestId("topic-status-save-indicator"),
		).toHaveTextContent("Saving…");
		// No re-read while the write is out (spec §4.1).
		expect(getTopicInvalidations()).toBe(before);
		release();

		await waitFor(() =>
			expect(updateStatusMutate).toHaveBeenCalledWith(
				expect.objectContaining({
					topicId: "topic-1",
					status: "SELECTED",
				}),
			),
		);
		await waitFor(() =>
			expect(
				screen.getByTestId("topic-status-save-indicator"),
			).toHaveTextContent("Saved"),
		);
		const keys = invalidateQueries.mock.calls.map((c) =>
			JSON.stringify(c[0]),
		);
		expect(keys.some((k) => k.includes("getPlanningAnalysis"))).toBe(true);
		expect(keys.some((k) => k.includes("getTopic"))).toBe(true);
		expect(keys.some((k) => k.includes("listTopics"))).toBe(true);
	});

	it("does not refresh the planning analysis for a status other than Selected", async () => {
		const user = userEvent.setup();
		state.topic = topic({ status: "SUGGESTION" });
		renderPage();

		await user.click(statusControl());
		await user.click(
			await screen.findByRole("option", { name: "In progress" }),
		);
		await waitFor(() => expect(updateStatusMutate).toHaveBeenCalled());
		// The refresh has run — only then is the absence meaningful.
		await waitFor(() =>
			expect(
				invalidateQueries.mock.calls.some((c) =>
					JSON.stringify(c[0]).includes("getTopic"),
				),
			).toBe(true),
		);
		const keys = invalidateQueries.mock.calls.map((c) =>
			JSON.stringify(c[0]),
		);
		expect(keys.some((k) => k.includes("getPlanningAnalysis"))).toBe(false);
	});

	it("routes Declined through the reason dialog", async () => {
		const user = userEvent.setup();
		state.topic = topic({ status: "SUGGESTION" });
		renderPage();

		await user.click(statusControl());
		await user.click(
			await screen.findByRole("option", { name: "Declined" }),
		);
		const dialog = await screen.findByRole("dialog");
		await user.type(within(dialog).getByRole("textbox"), "Out of scope");
		await user.click(
			within(dialog).getByRole("button", { name: /^decline/i }),
		);

		await waitFor(() =>
			expect(updateStatusMutate).toHaveBeenCalledWith(
				expect.objectContaining({
					status: "DECLINED",
					declineReason: "Out of scope",
				}),
			),
		);
	});

	it("routes Published through the URL dialog", async () => {
		const user = userEvent.setup();
		state.topic = topic({ status: "IN_PROGRESS" });
		renderPage();

		await user.click(statusControl());
		await user.click(
			await screen.findByRole("option", { name: "Published" }),
		);
		const dialog = await screen.findByRole("dialog");
		await user.type(
			within(dialog).getByRole("textbox"),
			"https://blog.example.com/post",
		);
		await user.click(
			within(dialog).getByRole("button", { name: "Mark as published" }),
		);

		await waitFor(() =>
			expect(updateStatusMutate).toHaveBeenCalledWith(
				expect.objectContaining({
					status: "PUBLISHED",
					publishedUrl: "https://blog.example.com/post",
				}),
			),
		);
	});

	it("keeps the typed reason and the old status, and toasts, when a decline fails", async () => {
		const user = userEvent.setup();
		state.updateStatusRejects = true;
		state.topic = topic({ status: "SUGGESTION" });
		renderPage();

		await user.click(statusControl());
		await user.click(
			await screen.findByRole("option", { name: "Declined" }),
		);
		const dialog = await screen.findByRole("dialog");
		await user.type(within(dialog).getByRole("textbox"), "Keep this text");
		await user.click(
			within(dialog).getByRole("button", { name: /^decline/i }),
		);

		await waitFor(() => expect(toastError).toHaveBeenCalled());
		expect(
			within(screen.getByRole("dialog")).getByRole("textbox"),
		).toHaveValue("Keep this text");
		expect(statusControlBehindModal()).toHaveTextContent("Suggestion");
		expect(statusControlBehindModal()).toBeEnabled();
		expect(
			screen.getByTestId("topic-status-save-indicator"),
		).toHaveTextContent("Not saved");
		// A request can fail after the server committed: the page re-reads the
		// topic rather than trust the failure (spec §4.1, panel A #2).
		const keys = invalidateQueries.mock.calls.map((c) =>
			JSON.stringify(c[0]),
		);
		expect(keys.some((k) => k.includes("getTopic"))).toBe(true);
	});

	it("keeps the typed URL when a header publish fails", async () => {
		const user = userEvent.setup();
		state.updateStatusRejects = true;
		state.topic = topic({ status: "IN_PROGRESS" });
		renderPage();

		await user.click(statusControl());
		await user.click(
			await screen.findByRole("option", { name: "Published" }),
		);
		const dialog = await screen.findByRole("dialog");
		await user.type(
			within(dialog).getByRole("textbox"),
			"https://blog.example.com/typed",
		);
		await user.click(
			within(dialog).getByRole("button", { name: "Mark as published" }),
		);

		await waitFor(() => expect(toastError).toHaveBeenCalled());
		expect(
			within(screen.getByRole("dialog")).getByRole("textbox"),
		).toHaveValue("https://blog.example.com/typed");
		expect(statusControlBehindModal()).toHaveTextContent("In progress");
	});

	it("while a header write to another status is held, the control is locked and Edit URL is gone", async () => {
		const user = userEvent.setup();
		state.updateStatusGate = new Promise<void>(() => {});
		state.topic = topic({
			status: "PUBLISHED",
			publishedUrl: "https://blog.example.com/post",
		});
		renderPage();
		expect(
			screen.getByRole("button", { name: "Edit URL" }),
		).toBeInTheDocument();

		await user.click(statusControl());
		await user.click(
			await screen.findByRole("option", { name: "In progress" }),
		);

		await waitFor(() => expect(statusControl()).toBeDisabled());
		// The page shows the pending status, and an In-progress topic has no
		// URL control: a racing second write is closed by absence.
		expect(
			screen.queryByRole("button", { name: "Edit URL" }),
		).not.toBeInTheDocument();
	});

	it("while an Edit URL write is held, the header status control is locked", async () => {
		const user = userEvent.setup();
		state.updateStatusGate = new Promise<void>(() => {});
		state.topic = topic({
			status: "PUBLISHED",
			publishedUrl: "https://blog.example.com/post",
		});
		renderPage();

		await user.click(screen.getByRole("button", { name: "Edit URL" }));
		const dialog = await screen.findByRole("dialog");
		const field = within(dialog).getByRole("textbox");
		expect(field).toHaveValue("https://blog.example.com/post");
		await user.clear(field);
		await user.type(field, "https://blog.example.com/new");
		await user.click(within(dialog).getByRole("button", { name: "Save" }));

		await waitFor(() => expect(updateStatusMutate).toHaveBeenCalled());
		// The only evidence of the shared lock here: the dialog's own Save is
		// disabled by its pending state and the @ui Button's auto-loading
		// whether or not the lock exists, so it is not asserted.
		expect(statusControlBehindModal()).toBeDisabled();
	});

	it("while a header Publish is held, the status control is locked", async () => {
		const user = userEvent.setup();
		state.updateStatusGate = new Promise<void>(() => {});
		state.topic = topic({ status: "IN_PROGRESS" });
		renderPage();

		await user.click(statusControl());
		await user.click(
			await screen.findByRole("option", { name: "Published" }),
		);
		const dialog = await screen.findByRole("dialog");
		await user.click(
			within(dialog).getByRole("button", { name: "Mark as published" }),
		);

		await waitFor(() => expect(updateStatusMutate).toHaveBeenCalled());
		// Not the confirm button: its own pending state disables it regardless.
		expect(statusControlBehindModal()).toBeDisabled();
	});

	// The second window the design creates (panel C #6): the write has
	// SUCCEEDED and its dialog has closed, but the page has not re-read the
	// topic yet. A second write must still be impossible until it has.
	it("after a successful Edit URL, keeps Edit URL and the status control locked until the topic is re-read", async () => {
		const user = userEvent.setup();
		state.topicUpdatedAt = 0; // the confirming refetch has not landed
		state.topic = topic({
			status: "PUBLISHED",
			publishedUrl: "https://blog.example.com/post",
		});
		const { rerender } = renderPage();

		await user.click(screen.getByRole("button", { name: "Edit URL" }));
		const dialog = await screen.findByRole("dialog");
		const field = within(dialog).getByRole("textbox");
		await user.clear(field);
		await user.type(field, "https://blog.example.com/new");
		await user.click(within(dialog).getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		expect(screen.getByRole("button", { name: "Edit URL" })).toBeDisabled();
		expect(statusControl()).toBeDisabled();
		expect(
			screen.getByTestId("topic-status-save-indicator"),
		).toHaveTextContent("Saved");

		state.topic = topic({
			status: "PUBLISHED",
			publishedUrl: "https://blog.example.com/new",
		});
		state.topicUpdatedAt = Date.now() + 60_000;
		rerender(
			<TopicItemPage
				projectId="proj-1"
				topicId="topic-1"
				organizationId={null}
				canEdit
			/>,
		);
		expect(screen.getByRole("button", { name: "Edit URL" })).toBeEnabled();
		expect(statusControl()).toBeEnabled();
	});

	it("after a successful header change, keeps the control locked on the new value, saying Saved, until the topic is re-read", async () => {
		const user = userEvent.setup();
		state.topicUpdatedAt = 0;
		state.topic = topic({ status: "SUGGESTION" });
		const { rerender } = renderPage();

		await user.click(statusControl());
		await user.click(
			await screen.findByRole("option", { name: "Selected" }),
		);
		await waitFor(() => expect(updateStatusMutate).toHaveBeenCalled());
		await waitFor(() =>
			expect(
				screen.getByTestId("topic-status-save-indicator"),
			).toHaveTextContent("Saved"),
		);
		expect(statusControl()).toHaveTextContent("Selected");
		expect(statusControl()).toBeDisabled();

		state.topic = topic({ status: "SELECTED" });
		state.topicUpdatedAt = Date.now() + 60_000;
		rerender(
			<TopicItemPage
				projectId="proj-1"
				topicId="topic-1"
				organizationId={null}
				canEdit
			/>,
		);
		expect(statusControl()).toBeEnabled();
		expect(statusControl()).toHaveTextContent("Selected");
	});

	it("keeps telling the assistant the SAVED status while a change is still being saved", async () => {
		const user = userEvent.setup();
		state.updateStatusGate = new Promise<void>(() => {});
		state.topic = topic({ status: "SUGGESTION" });
		renderPage();

		await user.click(statusControl());
		await user.click(
			await screen.findByRole("option", { name: "Selected" }),
		);
		await waitFor(() =>
			expect(statusControl()).toHaveTextContent("Selected"),
		);

		expect(assistantCapture.context?.status).toBe("SUGGESTION");
	});

	// Viewer evidence (panels B #3, C #1): the pre-existing "renders the topic
	// status (FR4)" case renders as an EDITOR, so after this task it covers
	// the editor's Select, not the pill.
	it("keeps the read-only pill for a viewer", () => {
		state.topic = topic({ status: "SELECTED" });
		renderPage(false);

		expect(screen.getByTestId("topic-status")).toHaveTextContent(
			"Selected",
		);
		expect(
			screen.queryByRole("combobox", { name: /^Status for / }),
		).not.toBeInTheDocument();
	});
});
