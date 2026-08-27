/**
 * Row-parity snapshot — pins the flag-off topic row's rendered DOM before the
 * row is extracted into its own files (Fizzy #2265, 1D-2).
 *
 * The 59 cases in `publishing-suite-list.test.tsx` assert behaviours, not
 * structure — they would stay green through a move that changed element
 * order, dropped a class, or lost the accessible name of a control nobody
 * wrote a case for. This file exercises EVERY optional field at once and
 * snapshots the rendered `<ul>` so a mechanical extraction has something
 * strict to prove itself against.
 *
 * Mock scaffolding below is DUPLICATED from `publishing-suite-list.test.tsx`
 * on purpose (controller ruling): no shared harness state between test
 * files, because `vi.hoisted` state is per-file by design and coupling this
 * file to the rollback-guard file would let one suite break the other.
 */

import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type CycleFixture = {
	id: string;
	status: string;
	startedAt: Date;
	completedAt: Date | null;
} | null;

const {
	state,
	updateStatusMutate,
	updatePostTypesMutate,
	createTopicMutate,
	toastError,
	refetchTopics,
	refetchCycle,
	pendingGate,
} = vi.hoisted(() => ({
	state: {
		topics: [] as Array<Record<string, unknown>>,
		cycle: null as CycleFixture,
		// C-Med3: query readiness the component must honor before deriving any
		// zero-topic business state.
		topicsPending: false,
		topicsError: false,
		cyclePending: false,
		cycleError: false,
		// C-Med2: drive the shared updateTopicStatus mutation to reject.
		updateStatusRejects: false,
		// Task 6 regression: when true, updateTopicStatus hangs (never settles)
		// until a test calls `pendingGate.resolve()`, giving the test a window
		// to assert on UI state while the mutation is still in flight for that
		// topic (mirrors how the component's own `pendingTopicIds` tracking
		// works — see `changeStatus` in PublishingSuiteList.tsx).
		updateStatusHangs: false,
	},
	updateStatusMutate: vi.fn(),
	updatePostTypesMutate: vi.fn(),
	createTopicMutate: vi.fn(),
	toastError: vi.fn(),
	refetchTopics: vi.fn(),
	refetchCycle: vi.fn(),
	pendingGate: { resolve: null as (() => void) | null },
}));

vi.mock("sonner", () => ({ toast: { error: toastError } }));

// Every assertion in this file predates the Inbox and describes flag-OFF
// behaviour, which section 7.6 of the design requires to stay unchanged. This
// mock is therefore the ROLLBACK REGRESSION GUARD, not a convenience: if a
// change to the Inbox leaks into the flag-off path, this snapshot is what
// catches it. Flag-ON behaviour lives in publishing-suite-inbox.test.tsx.
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));

vi.mock("@tanstack/react-query", () => ({
	useQuery: (opts: { queryKey?: unknown[] }) => {
		const procedure = Array.isArray(opts?.queryKey)
			? opts.queryKey[0]
			: undefined;
		if (procedure === "projects.publishingSuite.listTopics") {
			return {
				data: state.topicsError ? undefined : { items: state.topics },
				isPending: state.topicsPending,
				isLoading: state.topicsPending,
				isError: state.topicsError,
				refetch: refetchTopics,
			};
		}
		if (procedure === "projects.publishingSuite.latestCycle") {
			return {
				data: state.cycleError ? undefined : { cycle: state.cycle },
				isPending: state.cyclePending,
				isLoading: state.cyclePending,
				isError: state.cycleError,
				refetch: refetchCycle,
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
		if (procedure === "projects.publishingSuite.updateTopicStatus") {
			// Drive the mutation lifecycle so the component's onSuccess/onError
			// callbacks (invalidate / toast) actually fire, mirroring TanStack's
			// per-call semantics for a shared mutation.
			const run = async (vars: unknown) => {
				updateStatusMutate(vars);
				if (state.updateStatusHangs) {
					// Never settles until the test releases it.
					await new Promise<void>((resolve) => {
						pendingGate.resolve = resolve;
					});
				}
				if (state.updateStatusRejects) {
					const err = Object.assign(new Error("rejected"), {
						code: "INTERNAL_SERVER_ERROR",
					});
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
		if (procedure === "projects.publishingSuite.updateTopicPostTypes") {
			const run = async (vars: unknown) => {
				updatePostTypesMutate(vars);
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
		if (procedure === "projects.publishingSuite.createTopic") {
			return {
				mutate: createTopicMutate,
				mutateAsync: vi.fn(),
				isPending: false,
				error: null,
				reset: vi.fn(),
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
					listTopics: q("projects.publishingSuite.listTopics"),
					latestCycle: q("projects.publishingSuite.latestCycle"),
					// 1C-4a: PublishingSuiteList now renders
					// PublishingCycleHistory, which reads this procedure. The
					// obligation is on the COMPONENT TREE, not on this file's
					// subject matter — a missing entry is not a failing
					// assertion but `undefined.queryOptions`, which fails every
					// case in the file at once.
					listCycles: q("projects.publishingSuite.listCycles"),
					// 1C-4b: and its Channels disclosure reads this one. Same
					// obligation, same failure shape.
					cycleChatDeliveries: q(
						"projects.publishingSuite.cycleChatDeliveries",
					),
					createTopic: m("projects.publishingSuite.createTopic"),
					updateTopicStatus: m(
						"projects.publishingSuite.updateTopicStatus",
					),
					updateTopicPostTypes: m(
						"projects.publishingSuite.updateTopicPostTypes",
					),
					// Task 4 (Fizzy #2265, 1D-2): PublishingSuiteList now
					// unconditionally constructs the read-state mutation
					// (mirrors updateTopicStatus/updateTopicPostTypes above),
					// regardless of the flag value mocked in this file. Same
					// obligation as listCycles/cycleChatDeliveries above: a
					// missing entry is not a failing assertion, it's
					// `undefined.mutationOptions` failing every case at once.
					setTopicReadState: m(
						"projects.publishingSuite.setTopicReadState",
					),
					// Task 5 (Fizzy #2265, 1D-2): PublishingSuiteList now also
					// unconditionally constructs the snooze mutation, regardless of
					// the flag value mocked in this file. Same obligation as
					// setTopicReadState above: a missing entry is not a failing
					// assertion, it is `undefined.mutationOptions` failing every case
					// in the file at once.
					setTopicSnooze: m(
						"projects.publishingSuite.setTopicSnooze",
					),
				},
			},
		},
	};
});

vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: {} }));

import type { FunctionTag } from "@repo/database/prisma/generated/client";
import { PublishingSuiteList } from "@saas/projects/components/publishing-suite";

function makeTopic(overrides: Record<string, unknown> = {}) {
	return {
		id: "t1",
		title: "Alpha topic",
		pitch: "Alpha pitch",
		status: "SUGGESTION",
		origin: "AI",
		declineReason: null,
		publishedUrl: null,
		createdById: null,
		createdAt: new Date("2026-07-14T00:00:00Z"),
		contributors: [] as Array<{
			id: string;
			name: string;
			image: string | null;
			username: string | null;
		}>,
		suggestedPostTypes: [] as string[],
		postTypeRecommendations: [] as Array<{
			type: string;
			theme: string;
			rationale: string;
		}>,
		rankReason: null as
			| { kind: "contributed" }
			| { kind: "role_match"; matchedTags: FunctionTag[] }
			| null,
		authorRecommendation: null as {
			model: "single" | "co_author";
			authors: Array<{
				id: string;
				name: string;
				image: string | null;
				username: string | null;
				matchedTags: FunctionTag[];
			}>;
		} | null,
		angle: null as string | null,
		subject: null as string | null,
		userPostTypes: null as string[] | null,
		whySuggested: null as {
			named: Array<{
				type: "story" | "document" | "meeting";
				label: string;
			}>;
			prCount: number;
			overflowCount: number;
		} | null,
		meetingSpeakers: null as {
			members: Array<{
				id: string;
				name: string | null;
				username: string | null;
			}>;
			overflowCount: number;
		} | null,
		isSnoozed: false,
		isRead: false,
		...overrides,
	};
}

function renderList(
	props: Partial<{
		projectId: string;
		organizationId: string | null;
		canEdit: boolean;
	}> = {},
) {
	return render(
		<PublishingSuiteList
			projectId="proj-1"
			organizationId={null}
			canEdit
			{...props}
		/>,
	);
}

beforeEach(() => {
	state.topics = [];
	state.cycle = null;
	state.topicsPending = false;
	state.topicsError = false;
	state.cyclePending = false;
	state.cycleError = false;
	state.updateStatusRejects = false;
	state.updateStatusHangs = false;
	pendingGate.resolve = null;
	updateStatusMutate.mockReset();
	updatePostTypesMutate.mockReset();
	createTopicMutate.mockReset();
	toastError.mockReset();
	refetchTopics.mockReset();
	refetchCycle.mockReset();
});

describe("PublishingSuiteList row parity", () => {
	it("renders the flag-off row exactly as it did before the extraction", () => {
		// EVERY optional field populated at once. The point is coverage of
		// combinations no behavioural test happens to exercise — a field that
		// only renders alongside another is exactly what a move drops silently.
		state.topics = [
			makeTopic({
				id: "t1",
				title: "Alpha topic",
				angle: "Customer story",
				pitch: "Alpha pitch",
				subject: "Checkout rewrite",
				status: "PUBLISHED",
				publishedUrl: "https://example.com/post",
				declineReason: "not used when published",
				suggestedPostTypes: ["TWEET", "BLOG_POST"],
				postTypeRecommendations: [
					{
						type: "TWEET",
						theme: "launch",
						rationale: "short and shareable",
					},
				],
				contributors: [
					{
						id: "u1",
						name: "Example Person",
						image: null,
						username: "example",
					},
				],
				rankReason: { kind: "contributed" },
				whySuggested: {
					named: [{ type: "meeting", label: "Weekly sync" }],
					prCount: 2,
					overflowCount: 1,
				},
				meetingSpeakers: {
					members: [
						{
							id: "u1",
							name: "Example Person",
							username: "example",
						},
					],
					overflowCount: 0,
				},
			}),
		];
		const { container } = renderList();
		expect(container.querySelector("ul")).toMatchSnapshot();
	});
});
