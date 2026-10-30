vi.mock("@saas/projects/components/publishing-suite/CaseStudyPanel", () => ({
	CaseStudyAssets: () => null,
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";

const calls = vi.hoisted(() => ({
	generate: vi.fn().mockResolvedValue({ started: true }),
	select: vi.fn().mockResolvedValue({}),
	adopt: vi.fn().mockResolvedValue({}),
	answer: vi.fn().mockResolvedValue({ status: "answered" }),
	refine: vi.fn().mockResolvedValue({ started: true }),
	accept: vi.fn().mockResolvedValue({}),
	reject: vi.fn().mockResolvedValue({}),
}));
vi.mock("@shared/lib/orpc-query-utils", () => {
	const mutation = {
		mutationOptions: (options: object) => ({
			mutationFn: calls.generate,
			...options,
		}),
	};
	return {
		orpc: {
			projects: {
				publishingSuite: {
					...Object.fromEntries(
						[
							"BlogPost",
							"CaseStudy",
							"StakeholderEmail",
							"WebinarScript",
							"NewsletterBlurb",
						].map((type) => [
							`adopt${type}Draft`,
							{
								mutationOptions: (options: object) => ({
									mutationFn: calls.adopt,
									...options,
								}),
							},
						]),
					),
					generateShortPost: mutation,
					generateLinkedInPost: mutation,
					generateBlogPost: mutation,
					generateCaseStudy: mutation,
					generateStakeholderEmail: mutation,
					generateWebinarScript: mutation,
					generateNewsletterBlurb: mutation,
					selectShortPostOption: {
						mutationOptions: (options: object) => ({
							mutationFn: calls.select,
							...options,
						}),
					},
					selectLinkedInPostOption: {
						mutationOptions: (options: object) => ({
							mutationFn: calls.select,
							...options,
						}),
					},
					answerTopicQuestion: {
						mutationOptions: (options: object) => ({
							mutationFn: calls.answer,
							...options,
						}),
					},
					amendTopicQuestion: mutation,
					restoreQuestion: mutation,
					setQuestionAssignees: mutation,
					listTopicDecisions: { queryKey: () => ["decisions"] },
					refineDraft: {
						mutationOptions: (options: object) => ({
							mutationFn: calls.refine,
							...options,
						}),
					},
					acceptRefinement: {
						mutationOptions: (options: object) => ({
							mutationFn: calls.accept,
							...options,
						}),
					},
					rejectRefinement: {
						mutationOptions: (options: object) => ({
							mutationFn: calls.reject,
							...options,
						}),
					},
					listTopicDrafts: { queryKey: () => ["drafts"] },
				},
			},
		},
	};
});
vi.mock(
	"@saas/projects/components/publishing-suite/RefinedDraftReview",
	() => ({
		RefinedDraftReview: ({
			onConfirm,
			onReject,
		}: {
			onConfirm: (body: string) => void;
			onReject: () => void;
		}) => (
			<div>
				<button
					type="button"
					onClick={() => onConfirm("Refined example")}
				>
					Accept
				</button>
				<button type="button" onClick={onReject}>
					Reject
				</button>
			</div>
		),
	}),
);

import { SimpleTopicView } from "@saas/projects/components/publishing-suite/SimpleTopicView";

const props = {
	projectId: "example-project",
	topicId: "example-topic",
	organizationId: "example-org",
	canEdit: true,
	postTypes: ["LINKEDIN_POST", "BLOG_POST"] as const,
	selectedType: "LINKEDIN_POST" as const,
	onSelectType: vi.fn(),
	onAddType: vi.fn(),
	onAdvanced: vi.fn(),
	drafts: [],
	workingDrafts: [],
	threads: [],
	tabs: [],
	isLoading: false,
	hasBlockers: false,
	members: [],
};
function mount(
	overrides: Partial<React.ComponentProps<typeof SimpleTopicView>> = {},
) {
	return render(
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { mutations: { retry: false } },
				})
			}
		>
			<SimpleTopicView {...props} {...overrides} />
		</QueryClientProvider>,
	);
}
beforeEach(() => vi.clearAllMocks());
it("picking LinkedIn generates and seeds the working draft", async () => {
	mount();
	fireEvent.click(screen.getByRole("button", { name: "LinkedIn Post" }));
	await waitFor(() =>
		expect(calls.generate).toHaveBeenCalledWith(
			expect.objectContaining({ seedWorkingDraft: true }),
			expect.anything(),
		),
	);
});
it("picking Blog generates without the seed flag", async () => {
	mount({ selectedType: "BLOG_POST" });
	fireEvent.click(screen.getByRole("button", { name: "Blog Post" }));
	await waitFor(() => expect(calls.generate).toHaveBeenCalled());
	expect(calls.generate.mock.calls[0][0]).not.toHaveProperty(
		"seedWorkingDraft",
	);
});
it("mounting the view does not generate", () => {
	mount();
	expect(calls.generate).not.toHaveBeenCalled();
});
it("offers an optional blocker banner and skip", async () => {
	mount({ hasBlockers: true });
	fireEvent.click(screen.getByRole("button", { name: "LinkedIn Post" }));
	expect(calls.generate).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "Skip and generate" }));
	await waitFor(() => expect(calls.generate).toHaveBeenCalled());
});
it("readers have no generation or refinement controls", () => {
	mount({ canEdit: false });
	expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
	expect(screen.queryByRole("button", { name: "Refine" })).toBeNull();
});
it("keeps a saved draft and Copy visible after a failed generation", async () => {
	mount({
		workingDrafts: [
			{
				postType: "LINKEDIN_POST",
				hasBody: true,
				body: "Saved example post",
				sourceDraftId: null,
				sourceOptionLabel: null,
				sourceContent: null,
				updatedAt: "2026-01-01",
			},
		],
		drafts: [
			{
				postType: "LINKEDIN_POST",
				latestReady: null,
				versions: [],
				latestAttempt: {
					id: "example-draft",
					postType: "LINKEDIN_POST",
					version: 2,
					status: "FAILED",
					error: "Try again",
					createdAt: "2026-01-01",
					updatedAt: "2026-01-01",
				},
			},
		],
	});
	expect(screen.getByText("Saved example post")).toBeVisible();
	expect(screen.getByRole("button", { name: /Copy draft/ })).toBeVisible();
	expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
	fireEvent.click(screen.getByRole("button", { name: "Shorter" }));
	await waitFor(() =>
		expect(calls.refine).toHaveBeenCalledWith(
			expect.objectContaining({ instruction: "Shorter" }),
			expect.anything(),
		),
	);
});

it("shows a ready proposal and sends Accept through the accept procedure", async () => {
	mount({
		workingDrafts: [
			{
				postType: "LINKEDIN_POST",
				hasBody: true,
				body: "Saved example",
				sourceDraftId: null,
				sourceOptionLabel: null,
				sourceContent: null,
				updatedAt: "2026-01-01",
				refinement: {
					status: "READY",
					proposedBody: "Refined example",
					instruction: "Shorter",
					note: null,
					error: null,
					requestedById: null,
					isStale: false,
					isExpired: false,
					updatedAt: "2026-01-02",
				},
			},
		],
	});
	expect(screen.getByRole("button", { name: "Reject" })).toBeVisible();
	fireEvent.click(screen.getByRole("button", { name: "Accept" }));
	await waitFor(() =>
		expect(calls.accept).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "example-project",
				postType: "LINKEDIN_POST",
			}),
			expect.anything(),
		),
	);
});

const saved = {
	postType: "LINKEDIN_POST" as const,
	hasBody: true,
	body: "Saved example",
	sourceDraftId: null,
	sourceOptionLabel: null,
	sourceContent: null,
	updatedAt: "2026-01-01",
};
const takes = {
	postType: "LINKEDIN_POST" as const,
	versions: [],
	latestAttempt: null,
	latestReady: {
		id: "example-ready",
		postType: "LINKEDIN_POST" as const,
		version: 1,
		status: "READY" as const,
		createdAt: "2026-01-01",
		updatedAt: "2026-01-01",
		content: {
			options: [{ label: "Take A", text: "Example alternative" }],
		},
	},
};
it("confirms take replacement and honors cancellation", async () => {
	const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
	mount({ workingDrafts: [saved], drafts: [takes] });
	fireEvent.click(screen.getByRole("button", { name: "Take A" }));
	fireEvent.click(screen.getByRole("button", { name: "Use this take" }));
	expect(confirm).toHaveBeenCalledWith(
		"This replaces the LinkedIn post you saved earlier. Continue?",
	);
	expect(calls.select).not.toHaveBeenCalled();
	confirm.mockReturnValue(true);
	fireEvent.click(screen.getByRole("button", { name: "Use this take" }));
	await waitFor(() => expect(calls.select).toHaveBeenCalledTimes(1));
	confirm.mockRestore();
});
it("focus and arrows on a take do not write", async () => {
	mount({ workingDrafts: [saved], drafts: [takes] });
	const take = screen.getByText("Take A");
	fireEvent.focus(take);
	fireEvent.keyDown(take, { key: "ArrowRight" });
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(calls.select).not.toHaveBeenCalled();
	expect(screen.queryByRole("tablist", { name: "Takes" })).toBeNull();
});
it("budgets instructions for long and multiple answers through real question saves", async () => {
	const threads = [0, 1, 2].map((n) => ({
		root: {
			id: `example-question-${n}`,
			parentId: null,
			kind: "QUESTION" as const,
			status: "OPEN" as const,
			authorType: "AGENT" as const,
			authorUserId: null,
			questionId: `example-q-${n}`,
			decisionKind: "CUSTOMER_NAME" as const,
			subject: "example",
			summary: `Example question ${n}?`,
			content: null,
			recommendedResponse: "a".repeat(10000),
			whyItMatters: null,
			answerSource: null,
			analysisVersion: 1,
			createdAt: new Date("2026-01-01"),
			assignees: [],
		},
		replies: [],
	}));
	mount({ workingDrafts: [saved], threads });
	for (const button of screen.getAllByRole("button", {
		name: /use this answer/i,
	})) {
		fireEvent.click(button);
	}
	await waitFor(() => expect(calls.answer).toHaveBeenCalledTimes(3));
	fireEvent.click(
		await screen.findByRole("button", {
			name: "Update draft with my answers",
		}),
	);
	await waitFor(() => expect(calls.refine).toHaveBeenCalledTimes(1));
	const instruction = calls.refine.mock.calls[0][0].instruction;
	expect(instruction.length).toBeLessThanOrEqual(1900);
	expect(instruction).toContain("Example question 0?");
	expect(instruction).not.toContain("a".repeat(100));
	await waitFor(() =>
		expect(
			screen.queryByRole("button", {
				name: "Update draft with my answers",
			}),
		).toBeNull(),
	);
});

it("More types adds the selected type before navigating", async () => {
	mount();
	fireEvent.click(screen.getByRole("button", { name: "More types" }));
	fireEvent.click(screen.getByRole("button", { name: "Stakeholder Email" }));
	await waitFor(() =>
		expect(props.onAddType).toHaveBeenCalledWith([
			"LINKEDIN_POST",
			"BLOG_POST",
			"STAKEHOLDER_EMAIL",
		]),
	);
	expect(props.onSelectType).toHaveBeenCalledWith("STAKEHOLDER_EMAIL");
});
it("a saved working draft suppresses auto-generation and readers retain Copy", () => {
	mount({ workingDrafts: [saved], canEdit: false });
	fireEvent.click(screen.getByRole("button", { name: "LinkedIn Post" }));
	expect(calls.generate).not.toHaveBeenCalled();
	expect(screen.getByRole("button", { name: /Copy draft/ })).toBeVisible();
});
it("an editor picking an existing draft does not generate", () => {
	mount({ workingDrafts: [saved] });
	fireEvent.click(screen.getByRole("button", { name: "LinkedIn Post" }));
	expect(calls.generate).not.toHaveBeenCalled();
});
it("type remounts do not repeat a chip request", async () => {
	const client = new QueryClient();
	const view = (selectedType: "LINKEDIN_POST" | "BLOG_POST") => (
		<QueryClientProvider client={client}>
			<SimpleTopicView {...props} selectedType={selectedType} />
		</QueryClientProvider>
	);
	const page = render(view("LINKEDIN_POST"));
	fireEvent.click(screen.getByRole("button", { name: "LinkedIn Post" }));
	await waitFor(() => expect(calls.generate).toHaveBeenCalledTimes(1));
	page.rerender(view("BLOG_POST"));
	page.rerender(view("LINKEDIN_POST"));
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(calls.generate).toHaveBeenCalledTimes(1);
});
it("the banner Generate action starts generation", async () => {
	mount({ hasBlockers: true });
	fireEvent.click(screen.getByRole("button", { name: "Generate" }));
	await waitFor(() => expect(calls.generate).toHaveBeenCalledTimes(1));
});
it("shows progress for an active run", () => {
	mount({
		drafts: [
			{
				...takes,
				latestAttempt: { ...takes.latestReady, status: "GENERATING" },
			},
		],
	});
	expect(screen.getByRole("status")).toHaveTextContent(
		/Writing your linkedin post/,
	);
});
it("Retry starts another generation", async () => {
	mount({
		drafts: [
			{
				...takes,
				latestAttempt: {
					...takes.latestReady,
					status: "FAILED",
					error: "Example failure",
				},
			},
		],
	});
	fireEvent.click(screen.getByRole("button", { name: "Retry" }));
	await waitFor(() => expect(calls.generate).toHaveBeenCalledTimes(1));
});
it("Edit text and versions open Advanced for the current type", () => {
	mount({
		workingDrafts: [saved],
		drafts: [{ ...takes, versions: [takes.latestReady] }],
	});
	fireEvent.click(screen.getByRole("button", { name: "Edit text" }));
	fireEvent.click(screen.getByRole("button", { name: "1 version" }));
	expect(props.onAdvanced).toHaveBeenNthCalledWith(1, "LINKEDIN_POST");
	expect(props.onAdvanced).toHaveBeenNthCalledWith(2, "LINKEDIN_POST");
});
it("submits a free-text refinement", async () => {
	mount({ workingDrafts: [saved] });
	fireEvent.change(
		screen.getByRole("textbox", { name: "Describe a change" }),
		{ target: { value: "Example instruction" } },
	);
	fireEvent.click(screen.getByRole("button", { name: "Refine" }));
	await waitFor(() =>
		expect(calls.refine).toHaveBeenCalledWith(
			expect.objectContaining({ instruction: "Example instruction" }),
			expect.anything(),
		),
	);
});
it("short pills retain full accessible names", () => {
	mount();
	expect(
		screen.getByRole("button", { name: "LinkedIn Post" }),
	).toHaveTextContent("LinkedIn");
	expect(screen.getByRole("button", { name: "Blog Post" })).toHaveTextContent(
		"Blog",
	);
});
it("an in-progress response shows progress without an error", async () => {
	calls.generate.mockResolvedValueOnce({
		started: false,
		reason: "in-progress",
	});
	mount();
	fireEvent.click(screen.getByRole("button", { name: "LinkedIn Post" }));
	expect(await screen.findByText(/Writing your linkedin post/)).toBeVisible();
});

const proposal = {
	status: "READY" as const,
	proposedBody: "Example proposal",
	instruction: "Shorter",
	note: null,
	error: null,
	requestedById: null,
	isStale: false,
	isExpired: false,
	updatedAt: "2026-01-02",
};
it("Reject discards the proposal", async () => {
	mount({ workingDrafts: [{ ...saved, refinement: proposal }] });
	fireEvent.click(screen.getByRole("button", { name: "Reject" }));
	await waitFor(() => expect(calls.reject).toHaveBeenCalledTimes(1));
});
it("a stale proposal explains why it cannot be accepted", () => {
	mount({
		workingDrafts: [
			{ ...saved, refinement: { ...proposal, isStale: true } },
		],
	});
	expect(
		screen.getByText(/changed after this refinement was computed/),
	).toBeVisible();
	expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
});
it("CONFLICT on accept displays the server explanation", async () => {
	calls.accept.mockRejectedValueOnce({
		code: "CONFLICT",
		message: "Example baseline changed",
	});
	mount({ workingDrafts: [{ ...saved, refinement: proposal }] });
	fireEvent.click(screen.getByRole("button", { name: "Accept" }));
	await waitFor(() =>
		expect(toast.error).toHaveBeenCalledWith("Example baseline changed"),
	);
});
it("shows type-specific cautions above the content panel", () => {
	mount({
		selectedType: "CASE_STUDY",
		postTypes: ["CASE_STUDY"],
		threads: [
			{
				root: {
					id: "example-caution",
					kind: "QUESTION",
					status: "OPEN",
					decisionKind: "CODEBASE_DETAIL",
					subject: "Example technical detail",
					assignees: [],
				},
				replies: [],
			},
		] as never,
	});
	expect(
		screen.getByText(
			"Unresolved approvals or questions constrain this draft:",
		),
	).toBeVisible();
	expect(screen.getByText("Example technical detail")).toBeVisible();
});

it("confirms even the same source take when the saved body has been edited", () => {
	const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
	mount({
		workingDrafts: [
			{
				...saved,
				sourceDraftId: "example-ready",
				sourceOptionLabel: "Take A",
			},
		],
		drafts: [takes],
	});
	fireEvent.click(screen.getByRole("button", { name: "Take A" }));
	fireEvent.click(screen.getByRole("button", { name: "Use this take" }));
	expect(confirm).toHaveBeenCalled();
	expect(calls.select).not.toHaveBeenCalled();
	confirm.mockRestore();
});

it("a read-only chip pick with no draft cannot generate", () => {
	mount({ canEdit: false });
	fireEvent.click(screen.getByRole("button", { name: "LinkedIn Post" }));
	expect(calls.generate).not.toHaveBeenCalled();
});
it("a URL-selected empty type waits for Generate, which seeds once", async () => {
	mount();
	expect(calls.generate).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "Generate" }));
	await waitFor(() => expect(calls.generate).toHaveBeenCalledTimes(1));
	expect(calls.generate.mock.calls[0][0]).toMatchObject({
		seedWorkingDraft: true,
	});
});

it("polling new draft data does not repeat generation for the selected type", async () => {
	const client = new QueryClient();
	const view = (drafts: typeof props.drafts) => (
		<QueryClientProvider client={client}>
			<SimpleTopicView {...props} drafts={drafts} />
		</QueryClientProvider>
	);
	const page = render(view([]));
	fireEvent.click(screen.getByRole("button", { name: "LinkedIn Post" }));
	await waitFor(() => expect(calls.generate).toHaveBeenCalledTimes(1));
	page.rerender(view([]));
	expect(calls.generate).toHaveBeenCalledTimes(1);
});

it("explains an unavailable generation response", async () => {
	calls.generate.mockResolvedValueOnce({
		started: false,
		reason: "unavailable",
	});
	mount();
	fireEvent.click(screen.getByRole("button", { name: "Generate" }));
	await waitFor(() =>
		expect(toast.info).toHaveBeenCalledWith(
			"Generation is temporarily unavailable. Try again shortly.",
		),
	);
});

it("exposes the short post label and Recommended marker in its name", () => {
	mount({
		postTypes: ["TWEET"],
		selectedType: "TWEET",
		tabs: [{ postType: "TWEET", bucket: "recommended" }] as never,
	});
	expect(
		screen.getByRole("button", { name: /Short Post.*Recommended/i }),
	).toHaveTextContent("Short post");
});
it("caps free-text refinement at 2000 characters", () => {
	mount({ workingDrafts: [saved] });
	expect(
		screen.getByRole("textbox", { name: "Describe a change" }),
	).toHaveAttribute("maxlength", "2000");
});

function focusViewTest() {
	const client = new QueryClient();
	const view = (
		isActive: boolean,
		ready: boolean,
		updatedAt = proposal.updatedAt,
	) => (
		<QueryClientProvider client={client}>
			<SimpleTopicView
				{...props}
				isActive={isActive}
				workingDrafts={[
					{
						...saved,
						refinement: ready ? { ...proposal, updatedAt } : null,
					},
				]}
			/>
		</QueryClientProvider>
	);
	return { view, page: render(view(true, false)) };
}
it("does not focus an existing READY proposal on reactivation", () => {
	const { view, page } = focusViewTest();
	page.rerender(view(false, true));
	const field = screen.getByRole("textbox", { name: "Describe a change" });
	field.focus();
	page.rerender(view(true, true));
	expect(field).toHaveFocus();
});
it("a proposal arriving while typing does not steal focus", () => {
	const { view, page } = focusViewTest();
	const field = screen.getByRole("textbox", { name: "Describe a change" });
	field.focus();
	page.rerender(view(true, true));
	expect(field).toHaveFocus();
});
it("fresh proposals focus from Refine, including a new READY timestamp", () => {
	const { view, page } = focusViewTest();
	fireEvent.change(
		screen.getByRole("textbox", { name: "Describe a change" }),
		{ target: { value: "Example change" } },
	);
	const refine = screen.getByRole("button", { name: "Refine" });
	refine.focus();
	page.rerender(view(true, true));
	expect(
		screen.getByRole("button", { name: "Accept" }).parentElement
			?.parentElement,
	).toHaveFocus();
	refine.focus();
	page.rerender(view(true, true, "2026-01-03"));
	expect(
		screen.getByRole("button", { name: "Accept" }).parentElement
			?.parentElement,
	).toHaveFocus();
});
it.each([
	"BLOG_POST",
	"CASE_STUDY",
	"STAKEHOLDER_EMAIL",
	"WEBINAR_SCRIPT",
	"NEWSLETTER_BLURB",
] as const)(
	"offers READY %s text and explicit adoption with no working row",
	async (postType) => {
		const confirm = vi.spyOn(window, "confirm");
		mount({
			selectedType: postType,
			postTypes: [postType],
			drafts: [
				{
					...takes,
					postType,
					latestReady: {
						...takes.latestReady,
						postType,
						content: {
							title: "Example title",
							body: "Example ready body",
							subject: "Example subject",
							sessionPurpose: "Example ready body",
							headline: "Example title",
							blurb: "Example ready body with enough detail for a newsletter.",
						},
					},
				},
			],
		});
		expect(screen.getByText(/Example ready body/)).toBeVisible();
		expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Use this draft" }));
		await waitFor(() =>
			expect(calls.adopt).toHaveBeenCalledWith(
				expect.objectContaining({
					draftId: "example-ready",
					expectedUpdatedAt: null,
				}),
				expect.anything(),
			),
		);
		expect(confirm).not.toHaveBeenCalled();
		confirm.mockRestore();
	},
);
it("readers can read a READY long-form draft without adopting", () => {
	mount({
		canEdit: false,
		selectedType: "BLOG_POST",
		drafts: [
			{
				...takes,
				postType: "BLOG_POST",
				latestReady: {
					...takes.latestReady,
					postType: "BLOG_POST",
					content: {
						title: "Example title",
						body: "Example ready body",
					},
				},
			},
		],
	});
	expect(screen.getByText(/Example ready body/)).toBeVisible();
	expect(screen.queryByRole("button", { name: "Use this draft" })).toBeNull();
});
