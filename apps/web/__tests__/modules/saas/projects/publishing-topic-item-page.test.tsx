/**
 * TopicItemPage — the Publishing Suite Topic Item Page shell (Fizzy #1851,
 * Phase 2A-1).
 *
 * Mocks `@tanstack/react-query` and `@shared/lib/orpc-query-utils` wholesale,
 * mirroring `publishing-suite-list.test.tsx` in this directory: `useQuery`
 * resolves against a hoisted `state` fixture keyed off the oRPC procedure path
 * baked into the mocked `queryOptions` queryKey.
 *
 * Scope note: this slice ships the SHELL. The three real tabs render their
 * content (Summary) or an empty state (Planning & Analysis, Decision Log);
 * questions and planning analysis arrive in 2A-2 / 2A-3. What these tests pin
 * is the shell's contract — default tab, the topic header, and that the four
 * generation tabs are present but NOT operable (FR50).
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { state, refetchTopic, setReadStateMutate, toastError } = vi.hoisted(
	() => ({
		state: {
			topic: null as Record<string, unknown> | null,
			pending: false,
			error: false,
			// Drive the read-marker write to reject, so the failure path is
			// exercised rather than assumed.
			readStateRejects: false,
		},
		refetchTopic: vi.fn(),
		setReadStateMutate: vi.fn(),
		toastError: vi.fn(),
	}),
);

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
	state.pending = false;
	state.error = false;
	state.readStateRejects = false;
	refetchTopic.mockReset();
	setReadStateMutate.mockReset();
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
