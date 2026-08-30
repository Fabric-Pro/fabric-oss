/**
 * PlanningAnalysisTab — the topic's planning worksheet (Fizzy #1851, 2A-2).
 *
 * The states this panel has to get right are not "loading / loaded". They are
 * the four ways an analysis and an ATTEMPT at one can disagree:
 *
 *   nothing yet · running · running over a previous one · failed over a
 *   previous one
 *
 * The last two are the whole reason the API returns two rows. A panel that
 * renders only "the newest attempt" would blank a perfectly good analysis the
 * moment a regeneration failed — which is exactly when its reader wants it.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { generateMutate, state } = vi.hoisted(() => ({
	generateMutate: vi.fn(),
	state: { isPending: false },
}));

vi.mock("@tanstack/react-query", () => ({
	useMutation: (opts: {
		onSuccess?: (...a: unknown[]) => unknown;
		onError?: (...a: unknown[]) => unknown;
	}) => ({
		mutate: (vars: unknown) => {
			generateMutate(vars);
			opts.onSuccess?.({ started: true }, vars, undefined);
		},
		isPending: state.isPending,
	}),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
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

import { PlanningAnalysisTab } from "@saas/projects/components/publishing-suite/PlanningAnalysisTab";

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
	risks: ["The metric is from a single deployment."],
	questions: [
		{
			questionId: "q1",
			decisionKind: "CUSTOMER_NAME",
			subject: "the named customer",
			question: "May we name the customer?",
			recommendedResponse: "Ask their marketing contact first.",
			whyItMatters: "A case study without the name is a different piece.",
			source: "MODEL",
		},
	],
};

const ready = (overrides: Record<string, unknown> = {}) => ({
	id: "pa-1",
	version: 1,
	status: "READY",
	content: READY_CONTENT,
	sourceRefs: {
		stories: ["s1"],
		documents: [],
		transcripts: [],
		repoPrs: [{ repoFullName: "example-org/example-repo", prNumber: 7 }],
		prBodiesFetched: 1,
		activeRepoCount: 1,
		unresolved: { storyIds: [], docIds: [], transcriptIds: [] },
		failures: {},
	},
	model: "test-model",
	promptSource: "BOUND",
	error: null,
	createdAt: new Date("2026-08-30T10:00:00Z"),
	updatedAt: new Date("2026-08-30T10:04:00Z"),
	...overrides,
});

function renderTab(props: Record<string, unknown> = {}) {
	return render(
		<PlanningAnalysisTab
			projectId="proj-1"
			topicId="topic-1"
			organizationId={null}
			canEdit={true}
			isLoading={false}
			latestAttempt={null}
			latestReady={null}
			{...props}
		/>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	state.isPending = false;
});

describe("PlanningAnalysisTab — the empty state", () => {
	it("offers to generate one when there is nothing yet", async () => {
		renderTab();

		expect(
			screen.getByText(/no planning analysis yet/i),
		).toBeInTheDocument();
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
			latestReady: ready(),
			latestAttempt: ready({
				id: "pa-2",
				version: 2,
				status: "GENERATING",
			}),
		});

		expect(
			screen.getByText(/an engineering reliability story/i),
		).toBeVisible();
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
		// both meanings, which is why the endpoint returns two.
		renderTab({
			latestReady: ready(),
			latestAttempt: ready({
				id: "pa-2",
				version: 2,
				status: "FAILED",
				content: null,
				error: "Rate limited.",
			}),
		});

		expect(screen.getByText(/rate limited/i)).toBeInTheDocument();
		expect(
			screen.getByText(/an engineering reliability story/i),
		).toBeVisible();
	});
});

describe("PlanningAnalysisTab — a ready analysis", () => {
	it("renders the sections the model filled in", () => {
		renderTab({ latestReady: ready(), latestAttempt: ready() });

		expect(
			screen.getByText(/an engineering reliability story/i),
		).toBeVisible();
		expect(screen.getByText(/retries were unbounded/i)).toBeVisible();
		expect(screen.getByText(/enough depth to teach/i)).toBeVisible();
		expect(screen.getByText(/single deployment/i)).toBeVisible();
	});

	it("omits a section the model left out rather than rendering a bare heading", () => {
		// Every section of the schema is optional. An empty heading reads as a
		// section the analysis failed to fill, which is a different claim from
		// "the evidence did not support one".
		renderTab({
			latestReady: ready({
				content: { topicAngle: "Just the angle." },
			}),
			latestAttempt: ready({
				content: { topicAngle: "Just the angle." },
			}),
		});

		expect(screen.queryByText(/^Risks$/)).not.toBeInTheDocument();
		expect(screen.queryByText(/^Key details$/)).not.toBeInTheDocument();
	});

	it("says which prompt produced it when it was not the bound one", () => {
		// An analysis built from the default body because the bound prompt would
		// not render reads exactly like one built from the bound prompt. It is the
		// one fact about a run a reader cannot recover from the output.
		renderTab({
			latestReady: ready({ promptSource: "DEFAULT_RENDER_FAILED" }),
			latestAttempt: ready({ promptSource: "DEFAULT_RENDER_FAILED" }),
		});

		expect(screen.getByText(/default prompt/i)).toBeInTheDocument();
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
		renderTab({ latestReady: ready(), latestAttempt: stranded });

		expect(
			screen.getByText(/an engineering reliability story/i),
		).toBeVisible();
	});

	it("keeps a live attempt disabled — the fix must not defeat the in-flight guard", () => {
		// NEGATIVE CONTROL. Re-enabling on `status === "GENERATING"` alone would
		// pass every assertion above while letting a double-click spend a second
		// model call on a run that is perfectly healthy.
		renderTab({ latestAttempt: { ...stranded, isExpired: false } });

		expect(screen.getByRole("button", { name: /generat/i })).toBeDisabled();
	});
});
