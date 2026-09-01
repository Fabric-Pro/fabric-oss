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
	toastError,
} = vi.hoisted(() => ({
	state: {
		topic: null as Record<string, unknown> | null,
		// 2A-2: the planning analysis the page now fetches alongside the
		// topic. Two rows, because a failed regeneration must not blank a
		// good analysis — see PlanningAnalysisTab's own test file.
		latestAttempt: null as Record<string, unknown> | null,
		latestReady: null as Record<string, unknown> | null,
		// 2A-3: the decision-thread rows `TopicQuestionsPanel` renders. The
		// source of truth for the Summary & Questions tab's questions moved
		// here from the analysis blob above — see the FR39 block below.
		decisionThreads: [] as Record<string, unknown>[],
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
	toastError: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: toastError } }));

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
					latestReady: state.latestReady,
				},
				isPending: false,
				isLoading: false,
				isError: false,
				refetch: vi.fn(),
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
		return {
			data: undefined,
			isPending: false,
			isLoading: false,
			isError: false,
			refetch: vi.fn(),
		};
	},
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
		return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
	},
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@shared/lib/orpc-query-utils", () => {
	const q = (procedure: string) => ({
		queryOptions: ({ input }: { input?: unknown }) => ({
			queryKey: [procedure, input],
			queryFn: async () => undefined,
		}),
		queryKey: ({ input }: { input?: unknown }) => [procedure, input],
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
					listTopicDecisions: q(
						"projects.publishingSuite.listTopicDecisions",
					),
					answerTopicQuestion: m(
						"projects.publishingSuite.answerTopicQuestion",
					),
					updateTopicPostTypes: m(
						"projects.publishingSuite.updateTopicPostTypes",
					),
					updateTopicStatus: m(
						"projects.publishingSuite.updateTopicStatus",
					),
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
		meetingSpeakers: null,
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
	state.latestReady = null;
	state.decisionThreads = [];
	state.pending = false;
	state.error = false;
	state.readStateRejects = false;
	state.postTypesRejects = false;
	refetchTopic.mockReset();
	setReadStateMutate.mockReset();
	updatePostTypesMutate.mockReset();
	updateStatusMutate.mockReset();
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

	it("shows all four generation tabs as disabled Coming Soon (FR48-FR50)", () => {
		// FR50: the shell must NOT expose functional generation UI. Presence
		// alone is not the requirement — a tab a user can activate would be a
		// promise Phase 2A cannot keep, so `disabled` is the assertion that
		// matters.
		renderPage();
		const tablist = screen.getByRole("tablist", {
			name: /content generation/i,
		});
		for (const label of [
			"Tweet",
			"Blog Post",
			"Case Study",
			"Stakeholder Email",
		]) {
			const tab = within(tablist).getByRole("tab", {
				name: new RegExp(`${label}.*coming soon`, "i"),
			});
			expect(tab).toBeDisabled();
		}
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
		state.latestReady = readyAnalysis([QUESTION]);
		state.latestAttempt = state.latestReady;

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
