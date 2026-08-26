/**
 * PublishingSuiteList — states, triage, manual create, decline (Plan 3 Task 3).
 *
 * `@tanstack/react-query` is mocked wholesale (mirroring
 * `newsletter-approval.test.tsx` in this same directory): every `useQuery`
 * resolves against a hoisted `state` fixture keyed off the oRPC procedure path
 * baked into the mocked `orpc.*.queryOptions` queryKey, and every `useMutation`
 * returns a hoisted spy keyed off the mutationKey so tests can assert the exact
 * `updateTopicStatus` payload without standing up a real QueryClient.
 *
 * The decline flow deliberately goes through a STYLED dialog (controller
 * decision) — these tests assert the dialog opens and its reason reaches
 * `updateTopicStatus`; `window.prompt` is never mocked, proving it is unused.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
					// obligation, same failure shape — 57 cases at once.
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

function cycle(status: string): CycleFixture {
	return {
		id: "c1",
		status,
		startedAt: new Date("2026-07-14T00:00:00Z"),
		completedAt:
			status === "GENERATING" ? null : new Date("2026-07-14T01:00:00Z"),
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

describe("PublishingSuiteList", () => {
	// (a)
	it("renders topic titles regardless of the latest cycle status", () => {
		state.topics = [
			makeTopic({ id: "t1", title: "Alpha topic" }),
			makeTopic({ id: "t2", title: "Beta topic", status: "PUBLISHED" }),
		];
		state.cycle = cycle("READY");
		renderList();
		expect(screen.getByText("Alpha topic")).toBeInTheDocument();
		expect(screen.getByText("Beta topic")).toBeInTheDocument();
	});

	// F5 invariant — topic presence is independent of cycle health.
	it("F5: keeps the list visible with a refreshing banner when the latest cycle is GENERATING", () => {
		state.topics = [makeTopic({ title: "Alpha topic" })];
		state.cycle = cycle("GENERATING");
		renderList();
		expect(screen.getByText("Alpha topic")).toBeInTheDocument();
		expect(screen.getByText("Refreshing suggestions…")).toBeInTheDocument();
		// Must NOT fall into the full generating state copy.
		expect(
			screen.queryByText("Finding topics worth writing about…"),
		).not.toBeInTheDocument();
	});

	// (b)
	it("shows the empty state when there are no topics and no cycle", () => {
		renderList();
		expect(
			screen.getByText(
				"No suggestions yet — they'll appear after the first run. Or add your own topic above.",
			),
		).toBeInTheDocument();
	});

	// (c)
	it("shows the FR-9 insufficient-context message when the latest cycle is INSUFFICIENT_CONTEXT and no topics", () => {
		state.cycle = cycle("INSUFFICIENT_CONTEXT");
		renderList();
		expect(
			screen.getByText(
				"Project context is currently insufficient for suggested content.",
			),
		).toBeInTheDocument();
	});

	// (d)
	it("shows the generating loading state when a cycle is GENERATING and there are no topics", () => {
		state.cycle = cycle("GENERATING");
		renderList();
		expect(
			screen.getByText("Finding topics worth writing about…"),
		).toBeInTheDocument();
	});

	// (e) — "Published" is no longer an instant-fire status (it now routes
	// through PublishTopicDialog, see the "publish flow" tests below), so this
	// exercises the fire-and-forget path via a different non-dialog status.
	it("calls updateTopicStatus when a non-declined, non-published status is chosen", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({ id: "t1", title: "Alpha topic", status: "SUGGESTION" }),
		];
		state.cycle = cycle("READY");
		renderList();

		await user.click(
			screen.getByRole("combobox", { name: "Status for Alpha topic" }),
		);
		await user.click(
			await screen.findByRole("option", { name: "Selected" }),
		);

		expect(updateStatusMutate).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: null,
			topicId: "t1",
			status: "SELECTED",
			declineReason: null,
			publishedUrl: null,
		});
	});

	// Decline flow through the STYLED dialog (no window.prompt).
	it("opens a styled decline dialog and forwards the reason to updateTopicStatus", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({ id: "t1", title: "Alpha topic", status: "SUGGESTION" }),
		];
		state.cycle = cycle("READY");
		renderList();

		await user.click(
			screen.getByRole("combobox", { name: "Status for Alpha topic" }),
		);
		await user.click(
			await screen.findByRole("option", { name: "Declined" }),
		);

		// A styled dialog opens — not a native prompt (window.prompt is never mocked).
		const dialog = await screen.findByRole("dialog");
		const reason = within(dialog).getByRole("textbox");
		await user.type(reason, "Off-topic for our audience");
		await user.click(
			within(dialog).getByRole("button", { name: "Decline topic" }),
		);

		expect(updateStatusMutate).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: null,
			topicId: "t1",
			status: "DECLINED",
			declineReason: "Off-topic for our audience",
			publishedUrl: null,
		});
	});

	// -----------------------------------------------------------------------
	// Publish flow through the STYLED PublishTopicDialog (FR14/FR15/DV5).
	// Two DISTINCT exits: the primary "Mark as published" button mutates
	// (with or without a typed URL — dismissing the URL field still
	// publishes, ticket line 139); Cancel/Escape/overlay-close abort with NO
	// mutation, leaving the topic in its prior status (ticket line 141).
	// -----------------------------------------------------------------------
	it("opens the publish dialog when a topic is set to Published", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({ id: "t1", title: "Alpha topic", status: "SELECTED" }),
		];
		state.cycle = cycle("READY");
		renderList();

		await user.click(
			screen.getByRole("combobox", { name: "Status for Alpha topic" }),
		);
		await user.click(
			await screen.findByRole("option", { name: "Published" }),
		);

		const dialog = await screen.findByRole("dialog");
		expect(
			within(dialog).getByRole("heading", { name: "Mark as published" }),
		).toBeInTheDocument();
		// No mutation yet — the dialog is only open, not confirmed.
		expect(updateStatusMutate).not.toHaveBeenCalled();
	});

	it("confirms Published with a URL, calling mutate with publishedUrl", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({ id: "t1", title: "Alpha topic", status: "SELECTED" }),
		];
		state.cycle = cycle("READY");
		renderList();

		await user.click(
			screen.getByRole("combobox", { name: "Status for Alpha topic" }),
		);
		await user.click(
			await screen.findByRole("option", { name: "Published" }),
		);

		const dialog = await screen.findByRole("dialog");
		await user.type(
			within(dialog).getByLabelText("Published URL (optional)"),
			"https://blog.example.com/post",
		);
		await user.click(
			within(dialog).getByRole("button", { name: "Mark as published" }),
		);

		expect(updateStatusMutate).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: null,
			topicId: "t1",
			status: "PUBLISHED",
			declineReason: null,
			publishedUrl: "https://blog.example.com/post",
		});
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
	});

	it("dismisses the URL prompt (empty field) and still marks Published (FR15, ticket line 139)", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({ id: "t1", title: "Alpha topic", status: "SELECTED" }),
		];
		state.cycle = cycle("READY");
		renderList();

		await user.click(
			screen.getByRole("combobox", { name: "Status for Alpha topic" }),
		);
		await user.click(
			await screen.findByRole("option", { name: "Published" }),
		);

		const dialog = await screen.findByRole("dialog");
		// Confirm with an empty URL field — this is the "dismiss" path, and it
		// still completes the Published transition (distinct from Cancel below).
		await user.click(
			within(dialog).getByRole("button", { name: "Mark as published" }),
		);

		expect(updateStatusMutate).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: null,
			topicId: "t1",
			status: "PUBLISHED",
			declineReason: null,
			publishedUrl: null,
		});
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
	});

	it("Cancel aborts — topic stays in its prior status, no mutation (ticket line 141)", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({ id: "t1", title: "Alpha topic", status: "SELECTED" }),
		];
		state.cycle = cycle("READY");
		renderList();

		await user.click(
			screen.getByRole("combobox", { name: "Status for Alpha topic" }),
		);
		await user.click(
			await screen.findByRole("option", { name: "Published" }),
		);

		const dialog = await screen.findByRole("dialog");
		await user.click(
			within(dialog).getByRole("button", { name: "Cancel" }),
		);

		// Distinct from the dismiss-URL path above: Cancel must NOT mutate.
		expect(updateStatusMutate).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		// The Select still reflects the prior status (SELECTED), not Published.
		const trigger = screen.getByRole("combobox", {
			name: "Status for Alpha topic",
		});
		expect(within(trigger).getByText("Selected")).toBeInTheDocument();
	});

	it("Escape/close on the publish dialog also aborts (no mutation)", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({ id: "t1", title: "Alpha topic", status: "SELECTED" }),
		];
		state.cycle = cycle("READY");
		renderList();

		await user.click(
			screen.getByRole("combobox", { name: "Status for Alpha topic" }),
		);
		await user.click(
			await screen.findByRole("option", { name: "Published" }),
		);

		await screen.findByRole("dialog");
		await user.keyboard("{Escape}");

		expect(updateStatusMutate).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		const trigger = screen.getByRole("combobox", {
			name: "Status for Alpha topic",
		});
		expect(within(trigger).getByText("Selected")).toBeInTheDocument();
	});

	it("renders the published URL as a link on a PUBLISHED topic", () => {
		state.topics = [
			makeTopic({
				id: "t1",
				title: "Alpha topic",
				status: "PUBLISHED",
				publishedUrl: "https://blog.example.com/post",
			}),
		];
		state.cycle = cycle("READY");
		renderList();

		const link = screen.getByRole("link", {
			name: "https://blog.example.com/post",
		});
		expect(link).toHaveAttribute("href", "https://blog.example.com/post");
		expect(link).toHaveAttribute("target", "_blank");
		expect(link).toHaveAttribute("rel", "noopener noreferrer");
	});

	// Security regression: a stored non-http(s) URL (e.g. `javascript:`) must
	// never be rendered as a navigable <a href>. React does not sanitize href,
	// so this is a stored-XSS vector when another project member clicks a
	// shared topic's link. Saving stays lenient (DV6) — only navigation is
	// gated. See PublishingSuiteList's `isSafeHttpUrl` helper.
	it("renders a stored javascript: URL as plain text, not a clickable link", () => {
		state.topics = [
			makeTopic({
				id: "t1",
				title: "Alpha topic",
				status: "PUBLISHED",
				publishedUrl: "javascript:alert(1)",
			}),
		];
		state.cycle = cycle("READY");
		renderList();

		expect(
			screen.queryByRole("link", { name: "javascript:alert(1)" }),
		).not.toBeInTheDocument();
		const text = screen.getByText("javascript:alert(1)");
		expect(text.tagName).not.toBe("A");
	});

	// -----------------------------------------------------------------------
	// Task 6: Edit/Add URL affordance on an already-PUBLISHED topic (Codex
	// MEDIUM follow-up — a published topic previously had no way to add a
	// skipped URL or edit an existing one).
	// -----------------------------------------------------------------------
	it("Task 6: edits an existing published URL via the Edit URL affordance", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({
				id: "t1",
				title: "Alpha topic",
				status: "PUBLISHED",
				publishedUrl: "https://blog.example.com/old",
			}),
		];
		state.cycle = cycle("READY");
		renderList();

		await user.click(screen.getByRole("button", { name: "Edit URL" }));

		const dialog = await screen.findByRole("dialog");
		expect(
			within(dialog).getByRole("heading", { name: "Edit published URL" }),
		).toBeInTheDocument();
		const input = within(dialog).getByLabelText("Published URL (optional)");
		expect(input).toHaveValue("https://blog.example.com/old");

		await user.clear(input);
		await user.type(input, "https://blog.example.com/new");
		await user.click(within(dialog).getByRole("button", { name: "Save" }));

		expect(updateStatusMutate).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: null,
			topicId: "t1",
			status: "PUBLISHED",
			declineReason: null,
			publishedUrl: "https://blog.example.com/new",
		});
	});

	it("Task 6: adds a URL to a PUBLISHED topic that skipped it, via the Add URL affordance", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({
				id: "t1",
				title: "Alpha topic",
				status: "PUBLISHED",
				publishedUrl: null,
			}),
		];
		state.cycle = cycle("READY");
		renderList();

		const addButton = screen.getByRole("button", { name: "Add URL" });
		expect(addButton).toBeInTheDocument();
		await user.click(addButton);

		const dialog = await screen.findByRole("dialog");
		expect(
			within(dialog).getByRole("heading", { name: "Edit published URL" }),
		).toBeInTheDocument();
		const input = within(dialog).getByLabelText("Published URL (optional)");
		expect(input).toHaveValue("");

		await user.type(input, "https://blog.example.com/added");
		await user.click(within(dialog).getByRole("button", { name: "Save" }));

		expect(updateStatusMutate).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: null,
			topicId: "t1",
			status: "PUBLISHED",
			declineReason: null,
			publishedUrl: "https://blog.example.com/added",
		});
	});

	it("Task 6: hides the Edit/Add URL affordance when canEdit is false", () => {
		state.topics = [
			makeTopic({
				id: "t1",
				title: "Alpha topic",
				status: "PUBLISHED",
				publishedUrl: "https://blog.example.com/post",
			}),
		];
		state.cycle = cycle("READY");
		renderList({ canEdit: false });

		expect(
			screen.queryByRole("button", { name: "Edit URL" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Add URL" }),
		).not.toBeInTheDocument();
	});

	// Codex HIGH follow-up: the Edit/Add URL button must respect the same
	// per-topic isPending guard as the status Select, or a user can fire a
	// second, racing mutation on the same topic while the first is in flight.
	it("Task 6: disables the Edit/Add URL button while a status mutation is in flight for that topic", async () => {
		const user = userEvent.setup();
		state.updateStatusHangs = true;
		state.topics = [
			makeTopic({
				id: "t1",
				title: "Alpha topic",
				status: "PUBLISHED",
				publishedUrl: "https://blog.example.com/old",
			}),
		];
		state.cycle = cycle("READY");
		renderList();

		await user.click(
			screen.getByRole("combobox", { name: "Status for Alpha topic" }),
		);
		await user.click(
			await screen.findByRole("option", { name: "Selected" }),
		);

		// The mutation for this topic is now in flight (hung) — both the
		// Select and the Edit URL button must be disabled so a second
		// mutation on the same topic can't be started.
		await waitFor(() =>
			expect(
				screen.getByRole("combobox", {
					name: "Status for Alpha topic",
				}),
			).toBeDisabled(),
		);
		expect(screen.getByRole("button", { name: "Edit URL" })).toBeDisabled();

		// Release the hung mutation so it doesn't leak into later tests.
		pendingGate.resolve?.();
		await waitFor(() => expect(updateStatusMutate).toHaveBeenCalled());
	});

	// (f) F8 filter chips.
	it("F8: filters by status chip, resets on All, and messages a non-matching chip", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({ id: "t1", title: "Alpha topic", status: "SUGGESTION" }),
			makeTopic({ id: "t2", title: "Beta topic", status: "PUBLISHED" }),
		];
		state.cycle = cycle("READY");
		renderList();

		// Both visible initially.
		expect(screen.getByText("Alpha topic")).toBeInTheDocument();
		expect(screen.getByText("Beta topic")).toBeInTheDocument();

		// Filter to Published — only Beta remains.
		await user.click(screen.getByRole("button", { name: "Published" }));
		expect(screen.queryByText("Alpha topic")).not.toBeInTheDocument();
		expect(screen.getByText("Beta topic")).toBeInTheDocument();

		// Reset to All — both return. Scoped to the TOPIC filter group: 1C-4a
		// added a second chip group for the refresh history, which has its own
		// "All", so a bare byRole lookup now matches two buttons. Naming the
		// group makes the click land where the assertion means it to, rather
		// than on whichever chip happens to come first in the DOM.
		await user.click(
			within(
				screen.getByRole("group", { name: "Filter topics by status" }),
			).getByRole("button", { name: "All" }),
		);
		expect(screen.getByText("Alpha topic")).toBeInTheDocument();
		expect(screen.getByText("Beta topic")).toBeInTheDocument();

		// A chip that matches nothing shows the empty-filter message.
		await user.click(screen.getByRole("button", { name: "Declined" }));
		expect(
			screen.getByText("No topics match this filter."),
		).toBeInTheDocument();
	});

	it("Snoozed chip shows only topics with isSnoozed: true", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({
				id: "t1",
				title: "Alpha topic",
				status: "SUGGESTION",
				isSnoozed: false,
			}),
			makeTopic({
				id: "t2",
				title: "Beta topic",
				status: "SELECTED",
				isSnoozed: true,
			}),
		];
		state.cycle = cycle("READY");
		renderList();

		await user.click(
			within(
				screen.getByRole("group", { name: "Filter topics by status" }),
			).getByRole("button", { name: "Snoozed" }),
		);

		expect(screen.queryByText("Alpha topic")).not.toBeInTheDocument();
		expect(screen.getByText("Beta topic")).toBeInTheDocument();
	});

	// The important one: the "In progress" chip filters on
	// `t.status === "IN_PROGRESS" && !t.isSnoozed`. Without the
	// `!t.isSnoozed` term, a snoozed IN_PROGRESS topic would appear under
	// BOTH "In progress" and "Snoozed" — two answers to one question about
	// where a topic currently lives. Deleting that term must break this test.
	it("a snoozed IN_PROGRESS topic appears under Snoozed only, not under In progress", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({
				id: "t1",
				title: "Snoozed in-progress topic",
				status: "IN_PROGRESS",
				isSnoozed: true,
			}),
		];
		state.cycle = cycle("READY");
		renderList();

		const group = within(
			screen.getByRole("group", { name: "Filter topics by status" }),
		);

		await user.click(group.getByRole("button", { name: "Snoozed" }));
		expect(
			screen.getByText("Snoozed in-progress topic"),
		).toBeInTheDocument();

		await user.click(group.getByRole("button", { name: "In progress" }));
		expect(
			screen.queryByText("Snoozed in-progress topic"),
		).not.toBeInTheDocument();
	});

	// -----------------------------------------------------------------------
	// C-Med2: status changes must not fail silently.
	// -----------------------------------------------------------------------
	it("C-Med2: surfaces an error (not silently) when a status change fails", async () => {
		const user = userEvent.setup();
		state.updateStatusRejects = true;
		state.topics = [
			makeTopic({ id: "t1", title: "Alpha topic", status: "SUGGESTION" }),
		];
		state.cycle = cycle("READY");
		renderList();

		await user.click(
			screen.getByRole("combobox", { name: "Status for Alpha topic" }),
		);
		await user.click(
			await screen.findByRole("option", { name: "Selected" }),
		);

		await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
	});

	it("C-Med2: keeps the decline dialog open, preserves the reason, and surfaces an error when the decline fails", async () => {
		const user = userEvent.setup();
		state.updateStatusRejects = true;
		state.topics = [
			makeTopic({ id: "t1", title: "Alpha topic", status: "SUGGESTION" }),
		];
		state.cycle = cycle("READY");
		renderList();

		await user.click(
			screen.getByRole("combobox", { name: "Status for Alpha topic" }),
		);
		await user.click(
			await screen.findByRole("option", { name: "Declined" }),
		);

		const dialog = await screen.findByRole("dialog");
		await user.type(
			within(dialog).getByRole("textbox"),
			"Off-topic for our audience",
		);
		await user.click(
			within(dialog).getByRole("button", { name: "Decline topic" }),
		);

		// The failure is surfaced…
		await waitFor(() => expect(toastError).toHaveBeenCalled());
		// …the dialog stays open with the typed reason intact (not discarded)…
		const stillOpen = screen.getByRole("dialog");
		expect(within(stillOpen).getByRole("textbox")).toHaveValue(
			"Off-topic for our audience",
		);
	});

	it("C-Med2: closes the decline dialog only after a successful decline", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({ id: "t1", title: "Alpha topic", status: "SUGGESTION" }),
		];
		state.cycle = cycle("READY");
		renderList();

		await user.click(
			screen.getByRole("combobox", { name: "Status for Alpha topic" }),
		);
		await user.click(
			await screen.findByRole("option", { name: "Declined" }),
		);

		const dialog = await screen.findByRole("dialog");
		await user.type(within(dialog).getByRole("textbox"), "Not a fit");
		await user.click(
			within(dialog).getByRole("button", { name: "Decline topic" }),
		);

		expect(updateStatusMutate).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: null,
			topicId: "t1",
			status: "DECLINED",
			declineReason: "Not a fit",
			publishedUrl: null,
		});
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		expect(toastError).not.toHaveBeenCalled();
	});

	// -----------------------------------------------------------------------
	// C-Med3: read failures must not masquerade as empty/business states.
	// -----------------------------------------------------------------------
	it("C-Med3: shows a loading state (not the empty state) while the topics query is pending", () => {
		state.topicsPending = true;
		renderList();

		expect(screen.getByText("Loading topics…")).toBeInTheDocument();
		expect(
			screen.queryByText(
				"No suggestions yet — they'll appear after the first run. Or add your own topic above.",
			),
		).not.toBeInTheDocument();
	});

	it("C-Med3: shows a retryable error state (not the empty state) when the topics read fails", async () => {
		const user = userEvent.setup();
		state.topicsError = true;
		renderList();

		// Not misrepresented as a business/empty state.
		expect(
			screen.queryByText(
				"No suggestions yet — they'll appear after the first run. Or add your own topic above.",
			),
		).not.toBeInTheDocument();

		// A retry affordance that refetches.
		const retry = screen.getByRole("button", { name: /try again/i });
		await user.click(retry);
		expect(refetchTopics).toHaveBeenCalled();
	});

	it("C-Med3: still shows the manual create header across the loading and error states", () => {
		state.topicsError = true;
		renderList();
		// The header (Add topic) stays available even when the read fails, so a
		// user is never stranded without the create affordance.
		expect(
			screen.getByRole("button", { name: /add topic/i }),
		).toBeInTheDocument();
	});

	// -----------------------------------------------------------------------
	// 1B Task 3: contributor row + post-type chip row on the topic card.
	// -----------------------------------------------------------------------
	it("renders contributor handles on a topic card", () => {
		state.topics = [
			makeTopic({
				id: "t1",
				title: "Alpha topic",
				contributors: [
					{ id: "u1", name: "Ada", image: null, username: "ada" },
				],
			}),
		];
		state.cycle = cycle("READY");
		renderList();
		expect(screen.getByLabelText("Contributor: Ada")).toBeInTheDocument();
	});

	it("renders post-type chips for an AI topic", () => {
		state.topics = [
			makeTopic({
				id: "t1",
				title: "Alpha topic",
				origin: "AI",
				suggestedPostTypes: ["BLOG_POST", "TWEET"],
			}),
		];
		state.cycle = cycle("READY");
		renderList();
		expect(screen.getByText("Blog Post")).toBeInTheDocument();
		expect(screen.getByText("Tweet")).toBeInTheDocument();
	});

	// 1B tail reconciliation: the row's visibility is no longer coupled to
	// topic origin — it renders whenever the effective set is non-empty OR the
	// viewer can edit (so an editor always gets the Edit affordance, even on a
	// manual topic with no AI suggestions). Pin `canEdit: false` here so this
	// keeps testing its original intent: a read-only viewer sees no row
	// clutter for an empty effective set.
	it("shows no post-type row for a manual topic (read-only viewer)", () => {
		state.topics = [
			makeTopic({
				id: "t1",
				title: "Alpha topic",
				origin: "MANUAL",
				suggestedPostTypes: [],
			}),
		];
		state.cycle = cycle("READY");
		renderList({ canEdit: false });
		expect(screen.queryByTestId("post-type-row")).not.toBeInTheDocument();
	});

	it("renders the theme next to a suggested post-type chip", () => {
		state.topics = [
			makeTopic({
				id: "t1",
				origin: "AI",
				suggestedPostTypes: ["BLOG_POST"],
				postTypeRecommendations: [
					{
						type: "BLOG_POST",
						theme: "engineering deep-dive",
						rationale:
							"Built on a large feature PR with real tradeoffs.",
					},
				],
			}),
		];
		state.cycle = cycle("READY");
		renderList();
		expect(screen.getByText("Blog Post")).toBeInTheDocument();
		expect(screen.getByText(/engineering deep-dive/)).toBeInTheDocument();
	});

	it("exposes the rationale as a real accessible name on a focusable control", () => {
		state.topics = [
			makeTopic({
				id: "t1",
				origin: "AI",
				suggestedPostTypes: ["BLOG_POST"],
				postTypeRecommendations: [
					{
						type: "BLOG_POST",
						theme: "engineering deep-dive",
						rationale:
							"Built on a large feature PR with real tradeoffs.",
					},
				],
			}),
		];
		state.cycle = cycle("READY");
		renderList();
		// `getByRole` computes the REAL accessible name (unlike `getByLabelText`,
		// which merely matches the raw `aria-label` attribute regardless of
		// whether the element's role permits naming from it) — this would FAIL
		// against the old inert `<span aria-label>` (role `generic` PROHIBITS
		// naming from aria-label, WAI-ARIA 1.2 §5.2.8.6) and PASSES against the
		// `<button>`, which is both focusable and nameable.
		expect(
			screen.getByRole("button", {
				name: /Why Blog Post.*real tradeoffs/i,
			}),
		).toBeInTheDocument();
	});

	// Copilot review: `normalizeTopicEnrichment` allows `theme` to be `""`, and
	// the aria-label must omit the `: ` / `.` punctuation for an empty theme
	// rather than interpolating it unconditionally (which would produce an
	// awkward accessible name like "Why Blog Post: . <rationale>").
	it("omits the empty theme (and its punctuation) from the accessible name", () => {
		state.topics = [
			makeTopic({
				id: "t1",
				origin: "AI",
				suggestedPostTypes: ["BLOG_POST"],
				postTypeRecommendations: [
					{
						type: "BLOG_POST",
						theme: "",
						rationale:
							"Built on a large feature PR with real tradeoffs.",
					},
				],
			}),
		];
		state.cycle = cycle("READY");
		renderList();
		const button = screen.getByRole("button", {
			name: /Why Blog Post\. .*real tradeoffs/i,
		});
		expect(button).toBeInTheDocument();
		expect(button.getAttribute("aria-label")).not.toContain(": .");
	});

	it("renders a plain chip (no theme) when a type has no recommendation", () => {
		state.topics = [
			makeTopic({
				id: "t1",
				origin: "AI",
				suggestedPostTypes: ["TWEET"],
				postTypeRecommendations: [], // e.g. legacy pre-enrichment topic
			}),
		];
		state.cycle = cycle("READY");
		renderList();
		expect(screen.getByText("Tweet")).toBeInTheDocument();
		// A chip with no rationale must stay a plain, non-interactive span — not
		// become an enriched button (Minor finding: the plain-chip path must not
		// regress into an accidental control).
		expect(
			screen.queryByRole("button", { name: /Why Tweet/i }),
		).not.toBeInTheDocument();
	});

	// -----------------------------------------------------------------------
	// FR14: "why ranked" micro-line.
	// -----------------------------------------------------------------------
	it("shows the contribution reason line for a tier-1 topic", () => {
		state.topics = [
			makeTopic({ id: "t1", rankReason: { kind: "contributed" } }),
		];
		state.cycle = cycle("READY");
		renderList();
		expect(
			screen.getByText("Based on your contribution"),
		).toBeInTheDocument();
	});

	it("shows the role-match reason with the matched role names", () => {
		state.topics = [
			makeTopic({
				id: "t1",
				rankReason: {
					kind: "role_match",
					matchedTags: ["DEVELOPER", "ARCHITECT"],
				},
			}),
		];
		state.cycle = cycle("READY");
		renderList();
		expect(
			screen.getByText("Matches your role: Developer, Architect"),
		).toBeInTheDocument();
	});

	it("renders no rank-reason line for a tier-3 topic (rankReason null)", () => {
		state.topics = [makeTopic({ id: "t1", rankReason: null })];
		state.cycle = cycle("READY");
		renderList();
		expect(
			screen.queryByText("Based on your contribution"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText(/^Matches your role:/),
		).not.toBeInTheDocument();
	});

	// -----------------------------------------------------------------------
	// FR4-8: author-recommendation micro-line.
	// -----------------------------------------------------------------------
	describe("author recommendation line (FR4-8)", () => {
		it("renders a single-author recommendation with visible handle + discipline AND an accessible name", () => {
			state.topics = [
				makeTopic({
					id: "t1",
					authorRecommendation: {
						model: "single",
						authors: [
							{
								id: "u1",
								name: "Alice",
								image: null,
								username: "alice",
								matchedTags: ["DEVELOPER"],
							},
						],
					},
				}),
			];
			state.cycle = cycle("READY");
			renderList();
			// The `<p>` has only text children, so getByText matches its full
			// textContent; the leading label is a stable anchor.
			const line = screen.getByText(/^Recommended author —/);
			expect(line).toHaveTextContent("@alice · Developer");
			// AC-AR8 accessible name: the aria-label IS the accessible name (it
			// wins over text content). Assert it explicitly so
			// removing/malforming it fails.
			expect(line).toHaveAttribute(
				"aria-label",
				"Recommended author: Alice, Developer",
			);
		});

		it("joins multiple matched tags for a single author with the correct separators", () => {
			state.topics = [
				makeTopic({
					id: "t1",
					authorRecommendation: {
						model: "single",
						authors: [
							{
								id: "u1",
								name: "Alice",
								image: null,
								username: "alice",
								matchedTags: ["DEVELOPER", "DESIGNER"],
							},
						],
					},
				}),
			];
			state.cycle = cycle("READY");
			renderList();
			const line = screen.getByText(/^Recommended author —/);
			// Visible text joins matched-tag labels with ", ".
			expect(line).toHaveTextContent("@alice · Developer, Designer");
			// Accessible name joins matched-tag labels with " and ".
			expect(line).toHaveAttribute(
				"aria-label",
				"Recommended author: Alice, Developer and Designer",
			);
		});

		it("renders a co-author recommendation listing every author with an accessible name", () => {
			state.topics = [
				makeTopic({
					id: "t1",
					authorRecommendation: {
						model: "co_author",
						authors: [
							{
								id: "u1",
								name: "Alice",
								image: null,
								username: "alice",
								matchedTags: ["DEVELOPER"],
							},
							{
								id: "u2",
								name: "Bob",
								image: null,
								username: "bob",
								matchedTags: ["DESIGNER"],
							},
						],
					},
				}),
			];
			state.cycle = cycle("READY");
			renderList();
			const line = screen.getByText(/^Recommended co-authors —/);
			expect(line).toHaveTextContent("@alice · Developer");
			expect(line).toHaveTextContent("@bob · Designer");
			// Authors are joined with "; " (not ", ") so co-author boundaries stay
			// unambiguous when an author has multiple matched tags (Copilot review).
			expect(line).toHaveTextContent(
				"@alice · Developer; @bob · Designer",
			);
			expect(line).toHaveAttribute(
				"aria-label",
				"Recommended co-authors: Alice, Developer; Bob, Designer",
			);
		});

		it("falls back to the display name when a recommended author has no username", () => {
			state.topics = [
				makeTopic({
					id: "t1",
					authorRecommendation: {
						model: "single",
						authors: [
							{
								id: "u1",
								name: "Alice",
								image: null,
								username: null,
								matchedTags: ["DEVELOPER"],
							},
						],
					},
				}),
			];
			state.cycle = cycle("READY");
			renderList();
			const line = screen.getByText(/^Recommended author —/);
			// No username → the visible text shows the display name, no "@".
			expect(line).toHaveTextContent("Alice · Developer");
			expect(line.textContent).not.toContain("@");
		});

		it("renders no recommendation line when authorRecommendation is null", () => {
			state.topics = [
				makeTopic({ id: "t1", authorRecommendation: null }),
			];
			state.cycle = cycle("READY");
			renderList();
			expect(
				screen.queryByText(/^Recommended (author|co-authors) —/),
			).toBeNull();
		});
	});

	it("renders the angle chip as visible text when present", () => {
		state.topics = [
			makeTopic({
				id: "t1",
				title: "New auth flow",
				angle: "Engineering deep-dive",
			}),
		];
		renderList();
		// Both the "Angle" label and the value are real visible text nodes, so
		// assistive tech reads them (no aria-label on a role-less span). Assert the
		// exposed text, not a raw attribute.
		expect(screen.getByText("Angle")).toBeInTheDocument();
		expect(screen.getByText("Engineering deep-dive")).toBeInTheDocument();
	});

	it("renders no angle chip when angle is null", () => {
		state.topics = [
			makeTopic({ id: "t1", title: "New auth flow", angle: null }),
		];
		renderList();
		expect(screen.queryByText("Angle")).toBeNull();
	});

	it("renders the why-suggested line: named sources, PR count, and overflow", async () => {
		state.topics = [
			makeTopic({
				id: "t-ws",
				whySuggested: {
					named: [
						{ type: "story", label: "Add SSO login" },
						{ type: "meeting", label: "Q3 retro" },
					],
					prCount: 4,
					overflowCount: 1,
				},
			}),
		];
		renderList();
		expect(
			await screen.findByText(
				'Based on "Add SSO login" · "Q3 retro" meeting · 4 PRs · +1 more',
			),
		).toBeInTheDocument();
	});

	it("renders a PR-only why-suggested line with singular pluralization", async () => {
		state.topics = [
			makeTopic({
				id: "t-pr",
				whySuggested: { named: [], prCount: 1, overflowCount: 0 },
			}),
		];
		renderList();
		expect(await screen.findByText("Based on 1 PR")).toBeInTheDocument();
	});

	it("renders bare Meeting for an empty meeting label and no PR segment when prCount is 0", async () => {
		state.topics = [
			makeTopic({
				id: "t-m",
				whySuggested: {
					named: [{ type: "meeting", label: "" }],
					prCount: 0,
					overflowCount: 0,
				},
			}),
		];
		renderList();
		expect(await screen.findByText("Based on Meeting")).toBeInTheDocument();
	});

	it("renders no why-suggested line when whySuggested is null", async () => {
		state.topics = [
			makeTopic({ id: "t-none", title: "NoWhy", whySuggested: null }),
		];
		renderList();
		expect(await screen.findByText("NoWhy")).toBeInTheDocument();
		expect(screen.queryByText(/^Based on /)).not.toBeInTheDocument();
	});

	it("renders the meeting-participants line with handles + overflow", async () => {
		state.topics = [
			makeTopic({
				id: "t-mp",
				meetingSpeakers: {
					members: [
						{ id: "u1", name: "Ada Lovelace", username: "ada" },
						{ id: "u2", name: "Grace Hopper", username: "grace" },
					],
					overflowCount: 2,
				},
			}),
		];
		renderList();
		const line = await screen.findByText(/^Meeting participants —/);
		expect(line).toHaveTextContent("@ada, @grace +2 more");
		expect(line).toHaveAttribute(
			"aria-label",
			"Meeting participants: Ada Lovelace, Grace Hopper, and 2 more",
		);
	});

	it("falls back to the name when a participant has no username", async () => {
		state.topics = [
			makeTopic({
				id: "t-mp2",
				meetingSpeakers: {
					members: [{ id: "u3", name: "Bob", username: null }],
					overflowCount: 0,
				},
			}),
		];
		renderList();
		expect(
			await screen.findByText("Meeting participants — Bob"),
		).toBeInTheDocument();
	});

	it("renders no meeting-participants line when null", () => {
		state.topics = [makeTopic({ id: "t-mp3", meetingSpeakers: null })];
		renderList();
		expect(
			screen.queryByText(/^Meeting participants —/),
		).not.toBeInTheDocument();
	});

	it("renders the Subject line when a topic carries a subject", async () => {
		state.topics = [makeTopic({ id: "t-sub", subject: "Shipped RLS" })];
		renderList();
		const line = await screen.findByText(/^Subject · /);
		expect(line).toHaveTextContent("Subject · Shipped RLS");
		expect(line).toHaveAttribute("aria-label", "Subject: Shipped RLS");
	});

	it("renders no Subject line when subject is null", async () => {
		state.topics = [makeTopic({ id: "t-nosub", subject: null })];
		renderList();
		await screen.findByText("Alpha topic"); // list rendered (title from makeTopic default)
		expect(screen.queryByText(/^Subject · /)).not.toBeInTheDocument();
	});

	// -----------------------------------------------------------------------
	// 1B tail: post-type adjust/confirm — override-only chip row + Edit dialog.
	// -----------------------------------------------------------------------
	it("renders the override set, not the AI suggestion, when userPostTypes is set", () => {
		state.topics = [
			makeTopic({
				title: "Override wins",
				suggestedPostTypes: ["TWEET"],
				userPostTypes: ["BLOG_POST"],
			}),
		];
		renderList({ canEdit: true });
		expect(screen.getByText("Blog Post")).toBeInTheDocument();
		expect(screen.queryByText("Tweet")).not.toBeInTheDocument();
	});

	it("renders an override type with no recommendation as a bare chip", () => {
		state.topics = [
			makeTopic({
				title: "Bare chip",
				suggestedPostTypes: ["TWEET"],
				postTypeRecommendations: [],
				userPostTypes: ["CASE_STUDY"],
			}),
		];
		renderList({ canEdit: true });
		expect(screen.getByText("Case Study")).toBeInTheDocument();
	});

	it("shows the Edit button but no chips for an editor when the effective set is empty", () => {
		state.topics = [
			makeTopic({
				title: "Empty editable",
				suggestedPostTypes: [],
				userPostTypes: [],
			}),
		];
		renderList({ canEdit: true });
		expect(
			screen.getByRole("button", { name: "Edit post types" }),
		).toBeInTheDocument();
	});

	it("hides the Edit button without canEdit", () => {
		state.topics = [
			makeTopic({ title: "No edit", suggestedPostTypes: ["TWEET"] }),
		];
		renderList({ canEdit: false });
		expect(
			screen.queryByRole("button", { name: "Edit post types" }),
		).not.toBeInTheDocument();
	});

	it("saves the checked set through updateTopicPostTypes", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({
				id: "tX",
				title: "Save set",
				suggestedPostTypes: ["TWEET"],
			}),
		];
		renderList({ canEdit: true });
		await user.click(
			screen.getByRole("button", { name: "Edit post types" }),
		);
		await user.click(screen.getByLabelText("Blog Post"));
		await user.click(screen.getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(updatePostTypesMutate).toHaveBeenCalledWith(
				expect.objectContaining({
					topicId: "tX",
					postTypes: ["TWEET", "BLOG_POST"],
				}),
			),
		);
	});

	it("hides Reset when the topic is not overridden", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({
				title: "No reset",
				suggestedPostTypes: ["TWEET"],
				userPostTypes: null,
			}),
		];
		renderList({ canEdit: true });
		await user.click(
			screen.getByRole("button", { name: "Edit post types" }),
		);
		expect(
			screen.queryByRole("button", { name: "Reset to AI suggestion" }),
		).not.toBeInTheDocument();
	});
});
