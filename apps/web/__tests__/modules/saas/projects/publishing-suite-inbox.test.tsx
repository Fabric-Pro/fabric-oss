/**
 * PublishingSuiteList with PUBLISHING_INBOX ON (Fizzy #2265, 1D-2).
 *
 * Deliberately a SEPARATE file from publishing-suite-list.test.tsx rather than
 * a describe block inside it. That file's 59 tests are the rollback regression
 * guard and mock the flag OFF for the whole module; a per-test flag flip would
 * turn the guard into something that only holds when someone remembers to set
 * it. One file, one flag value, no way to get it wrong.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	state,
	updateStatusMutate,
	setReadStateMutate,
	setSnoozeMutate,
	updateAssigneesMutate,
	toastError,
	invalidateQueriesMock,
} = vi.hoisted(() => ({
	state: {
		topics: [] as Array<Record<string, unknown>>,
		cycle: {
			id: "c1",
			status: "COMPLETED",
			startedAt: new Date("2026-08-01T00:00:00Z"),
			completedAt: new Date("2026-08-01T01:00:00Z"),
		} as Record<string, unknown> | null,
		setReadStateRejects: false,
		setSnoozeRejects: false,
		// Task 5 requirement (A) negative control: lets a test hold the
		// updateTopicStatus mutation open so `isPending` is GENUINELY true
		// when the disclosure is clicked, rather than relying on timing.
		statusMutationGate: null as Promise<void> | null,
		// Fix 1 (external review): lets a test hold the setTopicReadState
		// mutation open independently of the status gate above, so both writes
		// for the SAME topic can be made pending at once and released in a
		// chosen order.
		readStateMutationGate: null as Promise<void> | null,
		// Task 6: the project's members, for the contributors picker. This
		// file does not exercise the contributors dialog itself (that lives
		// in publishing-suite-list.test.tsx) — this exists only so the
		// component's now-unconditional `members.list` query has something to
		// resolve rather than crashing every case in the file.
		members: [] as Array<Record<string, unknown>>,
		// Fizzy #2646: `dataUpdatedAt` of the topics query. The default — later
		// than any write can settle — is the "refetch is instant" world every
		// pre-existing case assumes; the hook retires a settled write at READ
		// time when this is already newer, so no existing case gains a busy
		// tail. Cases that HOLD the confirming refetch set it to 0 and bump it.
		topicsUpdatedAt: Number.MAX_SAFE_INTEGER as number,
		// Fizzy #2646: the status write has never been able to fail here.
		updateStatusRejects: false,
		// Fizzy #2646 (Task 5): hold the assignee write open.
		assigneesMutationGate: null as Promise<void> | null,
	},
	updateStatusMutate: vi.fn(),
	setReadStateMutate: vi.fn(),
	setSnoozeMutate: vi.fn(),
	updateAssigneesMutate: vi.fn(),
	toastError: vi.fn(),
	// Fix 1: a stable spy (unlike a fresh `vi.fn()` per `useQueryClient()`
	// call) so a test can `waitFor` the exact moment a mutation's `onSuccess`
	// ran — the only reliable signal that its promise chain, including the
	// `finally` that clears `pendingTopicIds`, has fully settled.
	invalidateQueriesMock: vi.fn(),
}));

/**
 * The global `next/navigation` mock hands out a fresh `push` on every call, so
 * nothing can assert on it. This mirrors that mock exactly and pins the one
 * function these tests need — the whole-card click has no other observable
 * effect.
 */
const { routerPush } = vi.hoisted(() => ({ routerPush: vi.fn() }));
vi.mock("next/navigation", () => ({
	useRouter: () => ({
		push: routerPush,
		replace: vi.fn(),
		prefetch: vi.fn(),
		back: vi.fn(),
		pathname: "/",
		query: {},
	}),
	usePathname: () => "/",
	useSearchParams: () => new URLSearchParams(),
	useParams: () => ({}),
}));

vi.mock("sonner", () => ({ toast: { error: toastError } }));

// Task 6: PublishingSuiteList now reads the viewer's own id via this hook.
// This exists only so it does not throw outside a SessionProvider — no test
// in this file exercises the contributors dialog.
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		user: { id: "viewer-1" },
		session: { id: "test-session" },
		loaded: true,
		reloadSession: vi.fn(),
	}),
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => true,
}));

vi.mock("@tanstack/react-query", () => ({
	useQuery: (opts: { queryKey?: unknown[] }) => {
		const procedure = Array.isArray(opts?.queryKey)
			? opts.queryKey[0]
			: undefined;
		if (procedure === "projects.publishingSuite.listTopics") {
			return {
				data: { items: state.topics },
				isPending: false,
				isLoading: false,
				isError: false,
				dataUpdatedAt: state.topicsUpdatedAt,
				errorUpdatedAt: 0,
				refetch: vi.fn(),
			};
		}
		if (procedure === "projects.publishingSuite.latestCycle") {
			return {
				data: { cycle: state.cycle },
				isPending: false,
				isLoading: false,
				isError: false,
				refetch: vi.fn(),
			};
		}
		if (procedure === "projects.members.list") {
			return {
				data: { members: state.members },
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
		onSuccess?: (...a: unknown[]) => unknown;
		onError?: (...a: unknown[]) => unknown;
	}) => {
		const procedure = Array.isArray(opts?.mutationKey)
			? opts.mutationKey[0]
			: undefined;
		const spy =
			procedure === "projects.publishingSuite.setTopicReadState"
				? setReadStateMutate
				: procedure === "projects.publishingSuite.setTopicSnooze"
					? setSnoozeMutate
					: procedure ===
							"projects.publishingSuite.updateTopicAssignees"
						? updateAssigneesMutate
						: updateStatusMutate;
		const rejects =
			(procedure === "projects.publishingSuite.setTopicReadState" &&
				state.setReadStateRejects) ||
			(procedure === "projects.publishingSuite.setTopicSnooze" &&
				state.setSnoozeRejects) ||
			(procedure === "projects.publishingSuite.updateTopicStatus" &&
				state.updateStatusRejects);
		const run = async (vars: unknown) => {
			spy(vars);
			if (
				procedure === "projects.publishingSuite.updateTopicStatus" &&
				state.statusMutationGate
			) {
				// Held open by the test until it has observed isPending as
				// true and asserted against it.
				await state.statusMutationGate;
			}
			if (
				procedure === "projects.publishingSuite.setTopicReadState" &&
				state.readStateMutationGate
			) {
				// Mirrors the status gate above, for the read-state write.
				await state.readStateMutationGate;
			}
			if (
				procedure === "projects.publishingSuite.updateTopicAssignees" &&
				state.assigneesMutationGate
			) {
				await state.assigneesMutationGate;
			}
			if (rejects) {
				const err = new Error("write failed");
				await opts.onError?.(err);
				throw err;
			}
			await opts.onSuccess?.();
			return {};
		};
		return {
			mutate: (v: unknown) => {
				void run(v).catch(() => {});
			},
			mutateAsync: run,
			isPending: false,
		};
	},
	useQueryClient: () => ({
		invalidateQueries: invalidateQueriesMock,
		cancelQueries: () => Promise.resolve(),
	}),
}));

vi.mock("@shared/lib/orpc-query-utils", () => {
	const proc = (path: string) => ({
		queryOptions: (o: Record<string, unknown>) => ({
			...o,
			queryKey: [path, o.input],
		}),
		mutationOptions: (o: Record<string, unknown>) => ({
			...o,
			mutationKey: [path],
		}),
		queryKey: (o: Record<string, unknown>) => [path, o.input],
	});
	return {
		orpc: {
			projects: {
				publishingSuite: {
					listTopics: proc("projects.publishingSuite.listTopics"),
					// Fizzy #2646: the Inbox's status refresh marks the topic
					// page's own read of the topic stale.
					getTopic: proc("projects.publishingSuite.getTopic"),
					// …and, for a topic just Selected, the topic page's read
					// of its planning analysis, which the server auto-starts.
					getPlanningAnalysis: proc(
						"projects.publishingSuite.getPlanningAnalysis",
					),
					latestCycle: proc("projects.publishingSuite.latestCycle"),
					updateTopicStatus: proc(
						"projects.publishingSuite.updateTopicStatus",
					),
					updateTopicPostTypes: proc(
						"projects.publishingSuite.updateTopicPostTypes",
					),
					createTopic: proc("projects.publishingSuite.createTopic"),
					setTopicSnooze: proc(
						"projects.publishingSuite.setTopicSnooze",
					),
					setTopicReadState: proc(
						"projects.publishingSuite.setTopicReadState",
					),
					// The reader's own sort and layout. Read by the list's
					// header controls — same obligation as the entries below:
					// a missing one is `undefined.queryOptions`, which takes
					// out every case in the file rather than one assertion.
					getListPreference: proc(
						"projects.publishingSuite.getListPreference",
					),
					setListPreference: proc(
						"projects.publishingSuite.setListPreference",
					),
					// These two are read by PublishingCycleHistory and its
					// Channels disclosure, which render inside this component.
					// The obligation is on the COMPONENT TREE, not on this
					// file's subject: a missing entry is not one failing
					// assertion, it is `undefined.queryOptions` taking out
					// every case in the file at once.
					listCycles: proc("projects.publishingSuite.listCycles"),
					cycleChatDeliveries: proc(
						"projects.publishingSuite.cycleChatDeliveries",
					),
					// Task 6: the contributors override write. Constructed
					// unconditionally by the component, same obligation as
					// every entry above.
					updateTopicContributors: proc(
						"projects.publishingSuite.updateTopicContributors",
					),
					// A8: the assignee write, constructed UNCONDITIONALLY by
					// the component. Same obligation as every entry above.
					updateTopicAssignees: proc(
						"projects.publishingSuite.updateTopicAssignees",
					),
				},
				// Task 6: the contributors picker's member list. Same
				// obligation as listCycles/cycleChatDeliveries above.
				members: {
					list: proc("projects.members.list"),
				},
			},
		},
	};
});

vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: {} }));

// The threshold itself, not a copy of its current value: tuning it (it is an
// explicit first guess) must not turn these cases red for a reason that has
// nothing to do with what they assert.
import {
	AGING_AFTER_DAYS,
	STALE_AFTER_DAYS,
} from "@repo/database/src/publishing-inbox";
// Imported AFTER the mocks, matching the existing suite: the component is
// pulled from the module barrel, not a deep path.
import { PublishingSuiteList } from "@saas/projects/components/publishing-suite";

function makeTopic(overrides: Record<string, unknown> = {}) {
	return {
		id: "t1",
		title: "Alpha topic",
		pitch: "Alpha pitch",
		angle: null,
		status: "SUGGESTION",
		origin: "AI",
		declineReason: null,
		publishedUrl: null,
		createdById: null,
		// RELATIVE, for the reason `daysAgo` below is documented at length —
		// and this default is where that rule had not yet been applied. A
		// literal date drifts past the staleness threshold as real time
		// passes, and while stale only meant "sunk and muted" the drift was
		// survivable: the row still rendered, so the tests still found it.
		// Archiving REMOVES the row, so the same literal silently emptied the
		// Suggested section and took 23 unrelated cases with it. Two days is
		// unambiguously inside every threshold.
		createdAt: daysAgo(3),
		updatedAt: daysAgo(2),
		snoozedUntil: null,
		snoozeReason: null,
		isSnoozed: false,
		isRead: false,
		contributors: [],
		suggestedPostTypes: [],
		postTypeRecommendations: [],
		rankReason: null,
		authorRecommendation: null,
		subject: null,
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
		whySuggested: null,
		meetingSpeakers: null,
		...overrides,
	};
}

/**
 * A timestamp `n` days before the moment the test runs.
 *
 * Every age- and staleness-sensitive fixture in this file is built from this
 * rather than from a literal date. A literal is a time bomb: the staleness
 * threshold is measured against the real clock, so a fixed date that reads as
 * fresh today reads as stale a month from now, and the test that depended on
 * it fails for a reason that has nothing to do with the code.
 */
function daysAgo(n: number): Date {
	return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function renderList({ canEdit = true }: { canEdit?: boolean } = {}) {
	return render(
		<PublishingSuiteList
			projectId="proj-1"
			organizationId={null}
			canEdit={canEdit}
		/>,
	);
}

beforeEach(() => {
	state.topics = [];
	state.setReadStateRejects = false;
	state.setSnoozeRejects = false;
	state.statusMutationGate = null;
	state.readStateMutationGate = null;
	state.topicsUpdatedAt = Number.MAX_SAFE_INTEGER;
	state.updateStatusRejects = false;
	state.assigneesMutationGate = null;
	updateStatusMutate.mockReset();
	setReadStateMutate.mockReset();
	setSnoozeMutate.mockReset();
	updateAssigneesMutate.mockReset();
	toastError.mockReset();
	invalidateQueriesMock.mockReset();
});

describe("read state", () => {
	it("marks a topic read when it is expanded", async () => {
		const user = userEvent.setup();
		state.topics = [makeTopic({ isRead: false })];
		renderList();
		await user.click(screen.getByTestId("topic-disclosure"));
		expect(setReadStateMutate).toHaveBeenCalledTimes(1);
		expect(setReadStateMutate).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: null,
			topicId: "t1",
			read: true,
		});
	});

	// NEGATIVE CONTROL. Without the `!isRead` guard this fires a write on
	// every expand — invisible in the UI, one wasted round trip per open, and a
	// readAt that keeps moving for a topic nobody actually re-read.
	it("fires NO mutation when an already-read topic is expanded", async () => {
		const user = userEvent.setup();
		state.topics = [makeTopic({ isRead: true })];
		renderList();
		await user.click(screen.getByTestId("topic-disclosure"));
		expect(setReadStateMutate).not.toHaveBeenCalled();
	});

	// NEGATIVE CONTROL for the optimistic read overlay, and the one case the
	// obvious implementation gets wrong. `state.topics` is deliberately NOT
	// updated between clicks — that models the real window in which the write
	// has succeeded but the invalidation refetch has not landed, so the prop
	// still says isRead: false. Without the latch the third click sends a
	// second read=true and the upsert moves readAt again.
	it("fires one write across expand → collapse → expand before the refetch", async () => {
		const user = userEvent.setup();
		state.topics = [makeTopic({ isRead: false })];
		renderList();
		const disclosure = screen.getByTestId("topic-disclosure");
		await user.click(disclosure);
		await user.click(disclosure);
		await user.click(disclosure);
		expect(setReadStateMutate).toHaveBeenCalledTimes(1);
	});

	it("re-marks read after the user has manually marked it unread", async () => {
		const user = userEvent.setup();
		state.topics = [makeTopic({ isRead: false })];
		renderList();
		const disclosure = screen.getByTestId("topic-disclosure");
		await user.click(disclosure); // expand → marks read
		// The PROP is still isRead: false, because nothing refetched. The
		// button must nonetheless now offer "Mark as unread" — that it does is
		// the visible proof the row is reading its own optimistic state rather
		// than the stale cache, and getByRole failing here is the whole point.
		await user.click(
			screen.getByRole("button", { name: /mark as unread/i }),
		);
		expect(setReadStateMutate).toHaveBeenLastCalledWith(
			expect.objectContaining({ read: false }),
		);
		await user.click(disclosure); // collapse
		await user.click(disclosure); // expand → allowed to mark read again
		expect(setReadStateMutate).toHaveBeenCalledTimes(3);
		expect(setReadStateMutate).toHaveBeenLastCalledWith(
			expect.objectContaining({ read: true }),
		);
	});

	it("toggles read state manually in both directions", async () => {
		const user = userEvent.setup();
		state.topics = [makeTopic({ isRead: false })];
		const { rerender } = renderList();
		await user.click(screen.getByRole("button", { name: /mark as read/i }));
		expect(setReadStateMutate).toHaveBeenLastCalledWith(
			expect.objectContaining({ topicId: "t1", read: true }),
		);

		state.topics = [makeTopic({ isRead: true })];
		rerender(
			<PublishingSuiteList
				projectId="proj-1"
				organizationId={null}
				canEdit
			/>,
		);
		await user.click(
			screen.getByRole("button", { name: /mark as unread/i }),
		);
		expect(setReadStateMutate).toHaveBeenLastCalledWith(
			expect.objectContaining({ topicId: "t1", read: false }),
		);
	});

	it("signals unread with more than colour", () => {
		state.topics = [makeTopic({ isRead: false })];
		renderList();
		expect(
			screen.getByRole("button", { name: /Alpha topic, unread/i }),
		).toBeInTheDocument();
	});

	it("surfaces a failed read-state write instead of failing silently", async () => {
		const user = userEvent.setup();
		state.setReadStateRejects = true;
		state.topics = [makeTopic({ isRead: false })];
		renderList();
		await user.click(screen.getByTestId("topic-disclosure"));
		await waitFor(() => expect(toastError).toHaveBeenCalled());
	});

	it("hides the detail fields until the row is expanded", async () => {
		const user = userEvent.setup();
		state.topics = [makeTopic({ subject: "Checkout rewrite" })];
		renderList();
		// The pitch is part of the collapsed summary; the subject is not.
		expect(screen.getByText("Alpha pitch")).toBeInTheDocument();
		expect(screen.queryByText(/Checkout rewrite/)).not.toBeInTheDocument();
		await user.click(screen.getByTestId("topic-disclosure"));
		expect(screen.getByText(/Checkout rewrite/)).toBeInTheDocument();
	});

	// Task 5 review requirement (A). The disclosure button's `aria-controls`
	// and the expanded region's `id` are correct today but completely
	// unpinned — deleting either attribute leaves every other test green.
	it("pairs the disclosure button's aria-controls with the expanded region's id", async () => {
		const user = userEvent.setup();
		state.topics = [makeTopic()];
		renderList();
		const disclosure = screen.getByTestId("topic-disclosure");
		const controlsId = disclosure.getAttribute("aria-controls");
		expect(controlsId).toBeTruthy();
		// Before expansion the region the button claims to control does not
		// exist yet — proves the id belongs to the collapsible region, not
		// some unrelated element that happens to share it.
		expect(document.getElementById(controlsId as string)).toBeNull();
		await user.click(disclosure);
		expect(document.getElementById(controlsId as string)).not.toBeNull();
	});

	// NEGATIVE CONTROL for the removal of the `!isPending` term from the
	// expand guard (Task 4 review, requirement A). FR4 says expanding IS
	// opening; a status write in flight for the SAME topic must not silently
	// swallow the read=true this expand would otherwise send. The gate below
	// holds the status mutation open so isPending is genuinely true — not
	// just briefly true before the mock's promise settles on its own — when
	// the disclosure is clicked.
	it("still marks a topic read when a status mutation is in flight for it", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({ id: "t1", title: "Alpha topic", isRead: false }),
		];
		let releaseStatusMutation: () => void = () => {};
		state.statusMutationGate = new Promise<void>((resolve) => {
			releaseStatusMutation = resolve;
		});
		renderList();

		try {
			await user.click(
				screen.getByRole("combobox", {
					name: "Status for Alpha topic",
				}),
			);
			await user.click(
				await screen.findByRole("option", { name: "Selected" }),
			);
			// The status mutation is now awaiting the gate — isPending is true.
			await user.click(screen.getByTestId("topic-disclosure"));

			expect(setReadStateMutate).toHaveBeenCalledTimes(1);
			expect(setReadStateMutate).toHaveBeenCalledWith({
				projectId: "proj-1",
				organizationId: null,
				topicId: "t1",
				read: true,
			});
		} finally {
			// Task 5 review requirement (C): release the gate even if an
			// assertion above throws. Otherwise the pending `mutateAsync`
			// leaks into the next test as unhandled-rejection noise that
			// obscures the real failure.
			releaseStatusMutation();
		}
	});

	// Fix 1 (external review): `pendingTopicIds` must be a per-topic COUNT,
	// not a presence flag. A status write and a read write can be in flight
	// for the SAME topic at once (expanding a row while its status write is
	// still pending is explicitly allowed — see the test above). A presence
	// Set loses that overlap: whichever write settles first deletes the id
	// and re-enables the row's controls, even though the OTHER write for that
	// same topic is still outstanding. This holds both mutations open, lets
	// the status write settle first, and asserts the row stays disabled
	// because the read write has not.
	it("keeps the row's controls disabled while a read write outlasts a status write for the same topic", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({ id: "t1", title: "Alpha topic", isRead: false }),
		];
		let releaseStatusMutation: () => void = () => {};
		state.statusMutationGate = new Promise<void>((resolve) => {
			releaseStatusMutation = resolve;
		});
		let releaseReadMutation: () => void = () => {};
		state.readStateMutationGate = new Promise<void>((resolve) => {
			releaseReadMutation = resolve;
		});
		renderList();

		try {
			await user.click(
				screen.getByRole("combobox", {
					name: "Status for Alpha topic",
				}),
			);
			await user.click(
				await screen.findByRole("option", { name: "Selected" }),
			);
			// The status write is now awaiting its gate — isPending is true.

			await user.click(screen.getByTestId("topic-disclosure"));
			// Expanding fires a read=true write, held open by its OWN gate —
			// both writes are now in flight for topic t1 at once.
			expect(setReadStateMutate).toHaveBeenCalledTimes(1);

			// Settle the STATUS write only. `waitFor` on `invalidateQueriesMock`
			// (called from the status write's refresh, which runs after the
			// write settles) is the reliable
			// signal that changeStatus's whole promise chain — including its
			// `finally` — has run, not just that the gate promise resolved.
			releaseStatusMutation();
			await waitFor(() =>
				expect(invalidateQueriesMock).toHaveBeenCalledWith({
					queryKey: [
						"projects.publishingSuite.listTopics",
						{ projectId: "proj-1", organizationId: null },
					],
				}),
			);

			// The read write is still outstanding: the row's controls must
			// still read as pending. With a presence Set this fails — the
			// status write's `finally` deletes the topic id outright and
			// re-enables the row even though the read write never settled.
			expect(
				screen.getByRole("combobox", {
					name: "Status for Alpha topic",
				}),
			).toBeDisabled();
			expect(
				screen.getByRole("button", { name: /mark as unread/i }),
			).toBeDisabled();

			// #2646 positive control: once the read write settles too, the row
			// must come back. A status overlay that left a busy tail (for
			// example, one that only retires on a CHANGE of the topics
			// timestamp, which this harness holds constant) would keep it
			// disabled — and the assertions above would be passing for the
			// wrong reason.
			releaseReadMutation();
			await waitFor(() =>
				expect(
					screen.getByRole("combobox", {
						name: "Status for Alpha topic",
					}),
				).toBeEnabled(),
			);
		} finally {
			releaseReadMutation();
			releaseStatusMutation();
		}
	});
});

describe("decline rationale", () => {
	it("renders a stored rationale in the expanded region", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({
				status: "DECLINED",
				declineReason: "Off-topic for our audience",
			}),
		];
		renderList();
		// DECLINED belongs to neither Inbox section — reach it via its chip
		// (Task 6, Fizzy #2265).
		await user.click(screen.getByRole("button", { name: "Declined" }));
		await user.click(screen.getByTestId("topic-disclosure"));
		expect(
			screen.getByText("Off-topic for our audience"),
		).toBeInTheDocument();
	});

	// NEGATIVE CONTROL for FR10. Drop the trim and a whitespace-only reason
	// renders a labelled block with nothing in it — "there is a reason, and it
	// is blank", which is worse than showing nothing at all.
	it("renders nothing for a whitespace-only rationale", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({ status: "DECLINED", declineReason: "   \t  " }),
		];
		renderList();
		// DECLINED belongs to neither Inbox section — reach it via its chip
		// (Task 6, Fizzy #2265).
		await user.click(screen.getByRole("button", { name: "Declined" }));
		await user.click(screen.getByTestId("topic-disclosure"));
		expect(
			screen.queryByText(/why this was declined/i),
		).not.toBeInTheDocument();
	});

	it("renders nothing for a topic that is not declined", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({ status: "SUGGESTION", declineReason: "stale text" }),
		];
		renderList();
		await user.click(screen.getByTestId("topic-disclosure"));
		expect(screen.queryByText("stale text")).not.toBeInTheDocument();
	});
});

describe("snooze", () => {
	it("sends the chosen preset and no timestamp", async () => {
		const user = userEvent.setup();
		state.topics = [makeTopic()];
		renderList();
		await user.click(screen.getByRole("button", { name: "Snooze" }));
		await user.click(screen.getByRole("radio", { name: "3 months" }));
		await user.click(screen.getByRole("button", { name: /snooze topic/i }));
		expect(setSnoozeMutate).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: null,
			topicId: "t1",
			preset: "THREE_MONTHS",
			reason: null,
		});
		// NEGATIVE CONTROL for FR6: the wire payload carries a preset NAME. If
		// resolution ever moves to the client, this key appears and this dies.
		expect(setSnoozeMutate.mock.calls[0][0]).not.toHaveProperty(
			"snoozedUntil",
		);
	});

	it("shows the wake date on a snoozed row without expanding it", async () => {
		const user = userEvent.setup();
		const until = new Date("2026-09-30T00:00:00Z");
		state.topics = [makeTopic({ isSnoozed: true, snoozedUntil: until })];
		renderList();
		// Snoozed topics belong to neither Inbox section — reach it via its
		// chip (Task 6, Fizzy #2265).
		await user.click(screen.getByRole("button", { name: "Snoozed" }));
		expect(
			screen.getByText(
				`Snoozed until ${until.toLocaleDateString(undefined, {
					year: "numeric",
					month: "short",
					day: "numeric",
				})}`,
			),
		).toBeInTheDocument();
	});

	it("clears the snooze with a null preset", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({
				isSnoozed: true,
				snoozedUntil: new Date("2026-09-30T00:00:00Z"),
			}),
		];
		renderList();
		// Snoozed topics belong to neither Inbox section — reach it via its
		// chip (Task 6, Fizzy #2265).
		await user.click(screen.getByRole("button", { name: "Snoozed" }));
		await user.click(screen.getByRole("button", { name: "Unsnooze" }));
		expect(setSnoozeMutate).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: null,
			topicId: "t1",
			preset: null,
			reason: null,
		});
	});

	// NEGATIVE CONTROL for the optimistic snooze overlay — same defect class
	// as the read-state one above. `state.topics` is deliberately NOT updated
	// after the click: that models the real window in which `changeSnooze`
	// has succeeded and cleared the pending set, but the invalidation refetch
	// has not landed, so the prop still says isSnoozed: true. Without the
	// override the button re-renders "Unsnooze" from the stale cache instead
	// of reflecting the user's own action.
	it("flips the control's label to Snooze right after Unsnooze, before any refetch", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({
				isSnoozed: true,
				snoozedUntil: new Date("2026-09-30T00:00:00Z"),
			}),
		];
		renderList();
		// Snoozed topics belong to neither Inbox section — reach it via its
		// chip (Task 6, Fizzy #2265).
		await user.click(screen.getByRole("button", { name: "Snoozed" }));
		await user.click(screen.getByRole("button", { name: "Unsnooze" }));
		expect(
			screen.getByRole("button", { name: "Snooze" }),
		).toBeInTheDocument();
	});

	it("keeps the dialog open and the text when the write fails", async () => {
		const user = userEvent.setup();
		state.setSnoozeRejects = true;
		state.topics = [makeTopic()];
		renderList();
		await user.click(screen.getByRole("button", { name: "Snooze" }));
		await user.type(
			screen.getByLabelText(/reason \(optional\)/i),
			"waiting on the release",
		);
		await user.click(screen.getByRole("button", { name: /snooze topic/i }));
		await waitFor(() => expect(toastError).toHaveBeenCalled());
		expect(screen.getByLabelText(/reason \(optional\)/i)).toHaveValue(
			"waiting on the release",
		);
	});
});

// Task 5 review requirement (B). The snooze note is guarded by the same
// `isSnoozed && snoozeReason?.trim()` pattern as the decline rationale, and
// had no test at all.
describe("snooze note", () => {
	it("renders a snooze note when one was recorded", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({
				isSnoozed: true,
				snoozedUntil: new Date("2026-09-30T00:00:00Z"),
				snoozeReason: "waiting on the release",
			}),
		];
		renderList();
		// Snoozed topics belong to neither Inbox section — reach it via its
		// chip (Task 6, Fizzy #2265).
		await user.click(screen.getByRole("button", { name: "Snoozed" }));
		await user.click(screen.getByTestId("topic-disclosure"));
		expect(
			screen.getByText(/Snooze note — waiting on the release/),
		).toBeInTheDocument();
	});

	// NEGATIVE CONTROL, mirrors the decline-rationale trim guard. Drop the
	// trim and a whitespace-only note renders a line with nothing in it.
	it("renders nothing for a whitespace-only snooze note", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({
				isSnoozed: true,
				snoozedUntil: new Date("2026-09-30T00:00:00Z"),
				snoozeReason: "   \t  ",
			}),
		];
		renderList();
		await user.click(screen.getByRole("button", { name: "Snoozed" }));
		await user.click(screen.getByTestId("topic-disclosure"));
		expect(screen.queryByText(/Snooze note/)).not.toBeInTheDocument();
	});
});

describe("inbox sections", () => {
	it("splits topics into Recently Modified and Suggested", () => {
		state.topics = [
			makeTopic({
				id: "s1",
				title: "A suggestion",
				status: "SUGGESTION",
			}),
			makeTopic({ id: "p1", title: "In flight", status: "IN_PROGRESS" }),
			makeTopic({ id: "p2", title: "Picked up", status: "SELECTED" }),
			makeTopic({ id: "d1", title: "Old news", status: "PUBLISHED" }),
		];
		renderList();
		const recent = screen.getByRole("region", {
			name: /recently modified/i,
		});
		expect(within(recent).getByText("In flight")).toBeInTheDocument();
		expect(within(recent).getByText("Picked up")).toBeInTheDocument();

		const suggested = screen.getByRole("region", { name: /suggested/i });
		expect(within(suggested).getByText("A suggestion")).toBeInTheDocument();
		// PUBLISHED belongs to neither section — reachable only via its chip.
		expect(screen.queryByText("Old news")).not.toBeInTheDocument();
	});

	it("orders Recently Modified by updatedAt, newest first", () => {
		state.topics = [
			makeTopic({
				id: "a",
				title: "Older",
				status: "IN_PROGRESS",
				updatedAt: new Date("2026-08-01T00:00:00Z"),
			}),
			makeTopic({
				id: "b",
				title: "Newer",
				status: "IN_PROGRESS",
				updatedAt: new Date("2026-08-20T00:00:00Z"),
			}),
		];
		renderList();
		const recent = screen.getByRole("region", {
			name: /recently modified/i,
		});
		const titles = within(recent)
			// #1851: the title is now a <Link> beside the disclosure chevron,
			// not the disclosure's own text. The ORDER asserted below is
			// unchanged — only where the title is read from.
			.getAllByRole("link")
			.map((a) => a.textContent);
		expect(titles[0]).toMatch(/Newer/);
		expect(titles[1]).toMatch(/Older/);
	});

	it("caps Recently Modified at three and offers the rest", async () => {
		const user = userEvent.setup();
		state.topics = [1, 2, 3, 4].map((n) =>
			makeTopic({
				id: `t${n}`,
				title: `Live topic ${n}`,
				status: "IN_PROGRESS",
				updatedAt: new Date(`2026-08-0${n}T00:00:00Z`),
			}),
		);
		renderList();
		const recent = screen.getByRole("region", {
			name: /recently modified/i,
		});
		expect(within(recent).getAllByTestId("topic-disclosure")).toHaveLength(
			3,
		);
		expect(screen.getByText(/showing 3 of 4/i)).toBeInTheDocument();
		expect(screen.queryByText("Live topic 1")).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /show all/i }));
		expect(screen.getByText("Live topic 1")).toBeInTheDocument();
	});

	it("shows no overflow control at or below the cap", () => {
		state.topics = [1, 2].map((n) =>
			makeTopic({
				id: `t${n}`,
				title: `Live topic ${n}`,
				status: "IN_PROGRESS",
			}),
		);
		renderList();
		expect(screen.queryByText(/showing \d+ of/i)).not.toBeInTheDocument();
	});

	// NEGATIVE CONTROL. The fixture is built so 1B's tier order, pure createdAt
	// order AND pure updatedAt order all DISAGREE with the expected incoming
	// order: the contributed topic is both the older-created and the
	// less-recently-updated one. Without the updatedAt disagreement, both
	// fixtures inherited the same default `updatedAt` from `makeTopic`, so a
	// hypothetical re-sort by `updatedAt` would be a stable no-op that left the
	// incoming order untouched and slipped past this control — it only caught
	// a `createdAt` sort. A fixture where any of the three agree passes under
	// more implementations and proves less.
	//
	// The four dates are RELATIVE where they used to be fixed strings. Stale
	// suggestions now sink to the bottom of Suggested (PO-approved), and ANY
	// fixed date eventually drifts past the staleness threshold as real time
	// passes — which would sink `tier1` and quietly turn this control into a
	// test of the sink instead of a test of tier order. Both topics are
	// deliberately days rather than months old so both stay FRESH, and the
	// three-way disagreement the paragraph above depends on is preserved:
	// `tier1` is still both the older-created and the less-recently-updated.
	//
	// `tier1`'s update is 8 days back rather than the 10 it was written with:
	// graduated staleness added an earlier threshold, and 10 is now exactly
	// ON it (the boundary is inclusive), which would badge this fixture aging
	// and falsify the paragraph above. Aging does not sink, so the assertion
	// would still have passed — for the wrong reason, on a row the comment
	// claims is fresh.
	it("preserves the incoming tier order in Suggested", () => {
		state.topics = [
			makeTopic({
				id: "tier1",
				title: "Contributed but old",
				status: "SUGGESTION",
				createdAt: daysAgo(20),
				updatedAt: daysAgo(8),
				rankReason: { kind: "contributed" },
			}),
			makeTopic({
				id: "tier3",
				title: "Newer but unranked",
				status: "SUGGESTION",
				createdAt: daysAgo(5),
				updatedAt: daysAgo(2),
			}),
		];
		renderList();
		const suggested = screen.getByRole("region", { name: /suggested/i });
		const titles = within(suggested)
			// #1851: the title is now a <Link> beside the disclosure chevron,
			// not the disclosure's own text. The ORDER asserted below is
			// unchanged — only where the title is read from.
			.getAllByRole("link")
			.map((a) => a.textContent);
		expect(titles[0]).toMatch(/Contributed but old/);
		expect(titles[1]).toMatch(/Newer but unranked/);
	});

	// The fixtures elsewhere in this file all build `updatedAt` with
	// `new Date(...)`, which is NOT what necessarily arrives from the wire —
	// PublishingCycleHistory in this same directory types its date fields
	// `Date | string` and guards accordingly. Without the normalization in
	// PublishingSuiteList this case throws "updatedAt.getTime is not a
	// function" and takes the whole tab down; with `Date`-only fixtures it is
	// invisible. This is the test that makes the ordering tests mean something.
	it("orders correctly when updatedAt arrives as an ISO string", () => {
		state.topics = [
			makeTopic({
				id: "a",
				title: "Older",
				status: "IN_PROGRESS",
				updatedAt: "2026-08-01T00:00:00.000Z",
			}),
			makeTopic({
				id: "b",
				title: "Newer",
				status: "IN_PROGRESS",
				updatedAt: "2026-08-20T00:00:00.000Z",
			}),
		];
		renderList();
		const recent = screen.getByRole("region", {
			name: /recently modified/i,
		});
		const titles = within(recent)
			// #1851: the title is now a <Link> beside the disclosure chevron,
			// not the disclosure's own text. The ORDER asserted below is
			// unchanged — only where the title is read from.
			.getAllByRole("link")
			.map((a) => a.textContent);
		expect(titles[0]).toMatch(/Newer/);
		expect(titles[1]).toMatch(/Older/);
	});

	it("keeps snoozed topics out of both sections", () => {
		state.topics = [
			makeTopic({
				id: "z",
				title: "Sleeping",
				status: "SUGGESTION",
				isSnoozed: true,
				snoozedUntil: new Date("2026-09-30T00:00:00Z"),
			}),
		];
		renderList();
		expect(screen.queryByText("Sleeping")).not.toBeInTheDocument();
	});

	it("falls back to the flat list when a chip is selected", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({ id: "p1", title: "In flight", status: "IN_PROGRESS" }),
		];
		renderList();
		expect(
			screen.getByRole("region", { name: /recently modified/i }),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "In progress" }));
		expect(
			screen.queryByRole("region", { name: /recently modified/i }),
		).not.toBeInTheDocument();
		expect(screen.getByText("In flight")).toBeInTheDocument();
	});

	it("renders a muted line, not an error, for an empty section", () => {
		state.topics = [
			makeTopic({
				id: "s1",
				title: "A suggestion",
				status: "SUGGESTION",
			}),
		];
		renderList();
		const recent = screen.getByRole("region", {
			name: /recently modified/i,
		});
		expect(
			within(recent).getByText(/nothing in progress/i),
		).toBeInTheDocument();
		expect(within(recent).queryByRole("alert")).not.toBeInTheDocument();
	});

	// Mirrors the Recently Modified empty-state test above, but for Suggested
	// — only the other section's empty case was pinned before this.
	it("renders a muted line, not an error, for an empty Suggested section", () => {
		state.topics = [
			makeTopic({
				id: "p1",
				title: "In flight",
				status: "IN_PROGRESS",
			}),
		];
		renderList();
		const suggested = screen.getByRole("region", { name: /suggested/i });
		expect(
			within(suggested).getByText(/no new suggestions/i),
		).toBeInTheDocument();
		expect(within(suggested).queryByRole("alert")).not.toBeInTheDocument();
	});
});

describe("optimistic overlay reconciliation", () => {
	// An overlay exists to cover one gap: the write has succeeded but the
	// invalidation refetch has not landed, so the cache still holds the old
	// value. Once the server has answered, the overlay has done its job. If it
	// outlives that moment it stops being optimism and becomes a permanent mask
	// over every later server truth for as long as the row stays mounted.
	//
	// Snooze is largely self-limiting here, because a snoozed topic belongs to
	// neither Inbox section: the server value changing unmounts the row and
	// takes the overlay with it. Read state has no such mitigation — it does
	// not affect section membership, so the row stays mounted indefinitely.
	it("follows the server again once a later refetch contradicts a confirmed read", async () => {
		const user = userEvent.setup();
		state.topics = [makeTopic({ isRead: false })];
		const { rerender } = renderList();

		await user.click(screen.getByRole("button", { name: /mark as read/i }));
		await waitFor(() => expect(invalidateQueriesMock).toHaveBeenCalled());

		// The invalidation refetch confirms the write. From here the overlay
		// is redundant: the cache says exactly what the overlay says.
		state.topics = [makeTopic({ isRead: true })];
		rerender(
			<PublishingSuiteList
				projectId="proj-1"
				organizationId={null}
				canEdit
			/>,
		);
		expect(
			screen.getByRole("button", { name: /mark as unread/i }),
		).toBeInTheDocument();

		// Now the same user marks it unread in another tab, or a teammate
		// does. The next refetch carries that truth and the row must show it.
		state.topics = [makeTopic({ isRead: false })];
		rerender(
			<PublishingSuiteList
				projectId="proj-1"
				organizationId={null}
				canEdit
			/>,
		);
		expect(
			screen.getByRole("button", { name: /mark as read/i }),
		).toBeInTheDocument();
	});

	// The overlay must still win before confirmation, or it is not doing the
	// job it was added for. Without this, "reconcile on confirmation" could be
	// satisfied by deleting the overlay entirely.
	it("still overrides the stale cache before the refetch lands", async () => {
		const user = userEvent.setup();
		state.topics = [makeTopic({ isRead: false })];
		renderList();

		await user.click(screen.getByRole("button", { name: /mark as read/i }));

		// The cache has NOT been updated yet — `state.topics` still says
		// unread — but the row must already read as read.
		expect(
			screen.getByRole("button", { name: /mark as unread/i }),
		).toBeInTheDocument();
	});
});

// ---------------------------------------------------------------------------
// #1851 slice B: age, staleness, the collapsed rank reason, and search.
// ---------------------------------------------------------------------------

describe("topic age", () => {
	it("shows how long ago the row was last touched, without expanding it", () => {
		state.topics = [makeTopic({ updatedAt: daysAgo(3) })];
		renderList();
		expect(screen.getByText("3 days ago")).toBeInTheDocument();
	});

	// The relative text is the readable half; `dateTime` is the exact instant,
	// and it is what a machine (or an assistive technology reading the value)
	// gets. Without it the precise timestamp would be hover-only.
	it("carries the exact timestamp in the time element", () => {
		const updatedAt = daysAgo(3);
		state.topics = [makeTopic({ updatedAt })];
		const { container } = renderList();
		expect(container.querySelector("time")).toHaveAttribute(
			"dateTime",
			updatedAt.toISOString(),
		);
	});

	// The `updatedAt ?? createdAt` fallback, which is a real path rather than
	// ceremony: a row can reach this component with no usable `updatedAt`, and
	// when it does, when the topic was created is still the honest answer to
	// "how old is this".
	it("falls back to the creation date when there is no update timestamp", () => {
		const createdAt = daysAgo(6);
		state.topics = [makeTopic({ createdAt, updatedAt: undefined })];
		const { container } = renderList();
		expect(container.querySelector("time")).toHaveAttribute(
			"dateTime",
			createdAt.toISOString(),
		);
		expect(screen.getByText("6 days ago")).toBeInTheDocument();
	});

	// NEGATIVE CONTROL, and the case that took every row down before the guard
	// existed: the age markup is built EAGERLY, so an unusable timestamp threw
	// out of `toISOString()` during render — not one missing line, the whole
	// tab. With no usable timestamp at all the row must still render, minus
	// its age.
	it("renders the row without an age when no timestamp is usable", () => {
		state.topics = [
			makeTopic({
				title: "No timestamp",
				createdAt: undefined,
				updatedAt: undefined,
			}),
		];
		const { container } = renderList();
		expect(screen.getByText("No timestamp")).toBeInTheDocument();
		expect(container.querySelector("time")).toBeNull();
	});
});

describe("neglected suggestions", () => {
	/**
	 * The neglect badge, found by its word and read back whole.
	 *
	 * The day count and the word are separate elements — the number is the
	 * message and carries its own weight — and `getByText` only ever sees an
	 * element's DIRECT text nodes, so no single query matches the phrase.
	 * Finding the word and reading its badge back asserts both halves AND
	 * that they belong to the same badge, which two independent queries
	 * would not.
	 */
	const badgeFor = (word: "quiet" | "stale") =>
		screen.getByText(new RegExp(`days ${word}$`)).parentElement;

	/** Switch to the Archived filter chip, where archived topics live. */
	const showArchived = async () =>
		await userEvent.click(screen.getByRole("button", { name: "Archived" }));

	// Reached through the chip, because a stale topic is no longer IN
	// Suggested — it has been archived out of it. The badge is what explains
	// why it is here rather than there.
	it("badges a suggestion nobody has touched since the stale threshold", async () => {
		const age = STALE_AFTER_DAYS + 15;
		state.topics = [
			makeTopic({ status: "SUGGESTION", updatedAt: daysAgo(age) }),
		];
		renderList();
		await showArchived();
		expect(badgeFor("stale")).toHaveTextContent(`${age} days stale`);
	});

	// The earlier tier, and the assertion that makes staleness GRADUATED
	// rather than binary: this row used to carry nothing at all. The two tiers
	// are told apart in WORDS, so stripping every colour from the page still
	// distinguishes them (WCAG 2.1 AA) — which is also why this asserts on the
	// text rather than on the tint.
	it("badges a suggestion past the aging threshold as quiet, not stale", () => {
		const age = STALE_AFTER_DAYS - 5;
		state.topics = [
			makeTopic({ status: "SUGGESTION", updatedAt: daysAgo(age) }),
		];
		renderList();
		expect(badgeFor("quiet")).toHaveTextContent(`${age} days quiet`);
		expect(screen.queryByText(/days stale$/)).not.toBeInTheDocument();
	});

	// NEGATIVE CONTROL. A badge every suggestion carries says nothing; this is
	// what makes the two cases above mean "past a threshold" rather than "is a
	// suggestion".
	it("leaves a suggestion inside the aging threshold unbadged", () => {
		state.topics = [
			makeTopic({
				status: "SUGGESTION",
				updatedAt: daysAgo(AGING_AFTER_DAYS - 1),
			}),
		];
		renderList();
		expect(
			screen.queryByText(/days (quiet|stale)$/),
		).not.toBeInTheDocument();
	});

	// Stale LEAVES, aging SINKS. The fixture interleaves both between the fresh
	// rows so the assertion pins two rules at once: the aging pair drops below
	// every live topic, and the two fresh ones keep their incoming order
	// relative to each other — which is 1B's per-viewer ranking surviving.
	//
	// This replaces an assertion that an aging row stays exactly where it was.
	// The card owner asked for the opposite ("if for 10+ days we can start
	// lowering it in the list"), and that call supersedes the earlier one.
	it("archives the stale and sinks the aging, oldest last", () => {
		const stale = daysAgo(STALE_AFTER_DAYS + 10);
		const agingOlder = daysAgo(STALE_AFTER_DAYS - 1);
		const agingNewer = daysAgo(AGING_AFTER_DAYS + 2);
		const fresh = daysAgo(2);
		state.topics = [
			makeTopic({ id: "f1", title: "Fresh first", updatedAt: fresh }),
			makeTopic({ id: "s1", title: "Stale first", updatedAt: stale }),
			makeTopic({
				id: "a1",
				title: "Aging older",
				updatedAt: agingOlder,
			}),
			makeTopic({ id: "f2", title: "Fresh second", updatedAt: fresh }),
			makeTopic({
				id: "a2",
				title: "Aging newer",
				updatedAt: agingNewer,
			}),
			makeTopic({ id: "s2", title: "Stale second", updatedAt: stale }),
		];
		renderList();
		const suggested = screen.getByRole("region", { name: /suggested/i });
		const titles = within(suggested)
			.getAllByRole("link")
			.map((a) => a.textContent);
		expect(titles).toEqual([
			"Fresh first",
			"Fresh second",
			"Aging newer",
			"Aging older",
		]);
	});

	// The list must SAY what it removed. A queue that quietly shrinks is the
	// one nobody trusts — and the count has to be the number of topics that
	// actually left, not a plausible-looking one.
	it("accounts for what it archived, in a count that matches", () => {
		const stale = daysAgo(STALE_AFTER_DAYS + 10);
		state.topics = [
			makeTopic({ id: "f1", title: "Fresh", updatedAt: daysAgo(2) }),
			makeTopic({ id: "s1", title: "Gone one", updatedAt: stale }),
			makeTopic({ id: "s2", title: "Gone two", updatedAt: stale }),
		];
		renderList();
		expect(
			screen.getByText(
				`2 topics archived after ${STALE_AFTER_DAYS} days without activity`,
			),
		).toBeInTheDocument();
	});

	// NEGATIVE CONTROL for that notice: a list with nothing archived must not
	// announce an archive at all.
	it("says nothing about archiving when nothing was archived", () => {
		state.topics = [makeTopic({ updatedAt: daysAgo(2) })];
		renderList();
		expect(screen.queryByText(/archived after/)).not.toBeInTheDocument();
	});

	// De-cluttered, NEVER deleted. This is the whole reversibility claim: the
	// topic left Suggested but is one click away, with its status untouched.
	it("keeps every archived topic reachable through the Archived chip", async () => {
		state.topics = [
			makeTopic({
				id: "s1",
				title: "Long forgotten",
				updatedAt: daysAgo(STALE_AFTER_DAYS + 60),
			}),
		];
		renderList();
		expect(screen.queryByText("Long forgotten")).not.toBeInTheDocument();

		await showArchived();
		expect(screen.getByText("Long forgotten")).toBeInTheDocument();
	});

	// The footer's own button, rather than the chip: it is the affordance a
	// reader actually meets, right where the topics went missing.
	it("reveals the archived topics from the notice itself", async () => {
		state.topics = [
			makeTopic({
				id: "s1",
				title: "Long forgotten",
				updatedAt: daysAgo(STALE_AFTER_DAYS + 60),
			}),
		];
		renderList();
		await userEvent.click(
			screen.getByRole("button", { name: "Show archived" }),
		);
		expect(screen.getByText("Long forgotten")).toBeInTheDocument();
	});

	// FR8/UC5. A snoozed topic is parked deliberately, and the archive must
	// never take one — its `updatedAt` here is far past the threshold, and the
	// only thing keeping it safe is that a snooze counts as activity.
	it("never archives a snoozed topic, however old its last edit", async () => {
		state.topics = [
			makeTopic({
				id: "z1",
				title: "Parked on purpose",
				isSnoozed: true,
				updatedAt: daysAgo(STALE_AFTER_DAYS + 60),
				snoozedUntil: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
			}),
		];
		renderList();
		expect(screen.queryByText(/archived after/)).not.toBeInTheDocument();

		await showArchived();
		expect(screen.queryByText("Parked on purpose")).not.toBeInTheDocument();
	});

	// The wire hands `snoozedUntil` over as a STRING, and the list normalizes
	// it alongside `updatedAt`. Worth its own case because dropping that
	// normalization fails silently rather than throwing: an unparsed string
	// loses every comparison, so the snooze stops counting as activity and
	// this topic — parked deliberately, ancient by `updatedAt` — is archived
	// away. Exactly the FR8 breach the property exists to prevent, arriving
	// through a type rather than through logic.
	it("honours a snooze that arrives from the wire as a string", async () => {
		const until = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
		state.topics = [
			makeTopic({
				id: "z2",
				title: "Parked, from the wire",
				isSnoozed: true,
				updatedAt: daysAgo(STALE_AFTER_DAYS + 60),
				snoozedUntil: until.toISOString() as unknown as Date,
			}),
		];
		renderList();
		expect(screen.queryByText(/archived after/)).not.toBeInTheDocument();

		await showArchived();
		expect(
			screen.queryByText("Parked, from the wire"),
		).not.toBeInTheDocument();
	});

	// The other half of FR8, and the case a threshold on `updatedAt` alone
	// gets exactly wrong: three months is the longest snooze preset, so a
	// topic coming back is routinely older than the archive threshold. It has
	// to return VISIBLE — "no topic is permanently lost due to snoozing".
	it("shows a topic returning from snooze, however far past the threshold it is", () => {
		state.topics = [
			makeTopic({
				id: "r1",
				title: "Back from a long snooze",
				isSnoozed: false,
				createdAt: daysAgo(200),
				updatedAt: daysAgo(95),
				snoozedUntil: daysAgo(1),
			}),
		];
		renderList();
		const suggested = screen.getByRole("region", { name: /suggested/i });
		expect(
			within(suggested).getByText("Back from a long snooze"),
		).toBeInTheDocument();
		expect(screen.queryByText(/archived after/)).not.toBeInTheDocument();
		expect(
			screen.queryByText(/days (quiet|stale)$/),
		).not.toBeInTheDocument();
	});

	// NEGATIVE CONTROL for the OTHER section. Neglect is about a suggestion
	// nobody acted on; a topic someone picked up and then left is a different
	// thing, and Recently Modified is explicitly out of scope for this change.
	it("never badges or reorders a topic outside Suggested", () => {
		state.topics = [
			makeTopic({
				id: "p1",
				title: "Picked up, then quiet",
				status: "IN_PROGRESS",
				updatedAt: daysAgo(STALE_AFTER_DAYS + 40),
			}),
		];
		renderList();
		const recent = screen.getByRole("region", {
			name: /recently modified/i,
		});
		expect(
			within(recent).getByText("Picked up, then quiet"),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/days (quiet|stale)$/),
		).not.toBeInTheDocument();
	});
});

describe("rank reason on the collapsed row", () => {
	it("says why a topic ranked here before anyone expands it", () => {
		state.topics = [makeTopic({ rankReason: { kind: "contributed" } })];
		renderList();
		expect(
			screen.getByText("Based on your contribution"),
		).toBeInTheDocument();
	});

	it("renders the role-match reason with every matched tag", () => {
		state.topics = [
			makeTopic({
				rankReason: {
					kind: "role",
					matchedTags: ["DEVELOPER", "ARCHITECT"],
				},
			}),
		];
		renderList();
		expect(
			screen.getByText("Matches your role: Developer, Architect"),
		).toBeInTheDocument();
	});

	// NEGATIVE CONTROL for the lift. The line moved OUT of the expanded region
	// into the summary column; leaving it in both is the obvious way to get
	// this wrong, and it renders the same sentence twice the moment a row is
	// opened — invisible in a test that only asserts it is present.
	it("renders the reason exactly once when the row is expanded", async () => {
		const user = userEvent.setup();
		state.topics = [makeTopic({ rankReason: { kind: "contributed" } })];
		renderList();
		await user.click(screen.getByTestId("topic-disclosure"));
		expect(screen.getAllByText("Based on your contribution")).toHaveLength(
			1,
		);
	});

	it("renders no reason line for an unranked topic", () => {
		state.topics = [makeTopic({ rankReason: null })];
		renderList();
		expect(
			screen.queryByText(
				/^(Based on your contribution|Matches your role)/,
			),
		).not.toBeInTheDocument();
	});
});

describe("search", () => {
	const searchBox = () =>
		screen.getByRole("searchbox", { name: /search topics/i });

	it("filters the list to matching titles", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({ id: "a", title: "Shipping the new inbox" }),
			makeTopic({ id: "b", title: "Migrating the database" }),
		];
		renderList();
		await user.type(searchBox(), "inbox");
		expect(screen.getByText("Shipping the new inbox")).toBeInTheDocument();
		expect(
			screen.queryByText("Migrating the database"),
		).not.toBeInTheDocument();
	});

	it("matches the pitch and the angle too, ignoring case", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({
				id: "a",
				title: "Untitled",
				pitch: "How we cut latency in half",
			}),
			makeTopic({
				id: "b",
				title: "Nameless",
				pitch: null,
				angle: "Developer experience",
			}),
			makeTopic({ id: "c", title: "Unrelated", pitch: null }),
		];
		renderList();

		await user.type(searchBox(), "LATENCY");
		expect(screen.getByText("Untitled")).toBeInTheDocument();
		expect(screen.queryByText("Unrelated")).not.toBeInTheDocument();

		await user.clear(searchBox());
		await user.type(searchBox(), "developer experience");
		expect(screen.getByText("Nameless")).toBeInTheDocument();
		expect(screen.queryByText("Unrelated")).not.toBeInTheDocument();
	});

	// A search is a question that overrides "what should I look at next", so
	// it answers with one flat list — the same thing picking a status chip
	// does — rather than scattering hits across two sections.
	it("replaces the Inbox sections with a flat list of hits", async () => {
		const user = userEvent.setup();
		state.topics = [makeTopic({ id: "a", title: "Shipping the inbox" })];
		renderList();
		expect(
			screen.getByRole("region", { name: /suggested/i }),
		).toBeInTheDocument();

		await user.type(searchBox(), "inbox");
		expect(
			screen.queryByRole("region", { name: /suggested/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("region", { name: /recently modified/i }),
		).not.toBeInTheDocument();
		expect(screen.getByText("Shipping the inbox")).toBeInTheDocument();
	});

	// The get-started spotlight targets `publishing-suite-inbox`. That anchor
	// used to sit on the sectioned branch, so searching — or picking a status
	// chip — took it out of the DOM and a "Show me" fired mid-search
	// highlighted nothing. It now rides an always-rendered wrapper, the same
	// place `publishing-suite-list` sits for the same reason.
	it("keeps the get-started anchor mounted while a search narrows the list", async () => {
		const user = userEvent.setup();
		state.topics = [makeTopic({ id: "a", title: "Shipping the inbox" })];
		const { container } = renderList();
		expect(
			container.querySelector(
				'[data-onboarding-target="publishing-suite-inbox"]',
			),
		).not.toBeNull();

		await user.type(searchBox(), "inbox");
		expect(
			container.querySelector(
				'[data-onboarding-target="publishing-suite-inbox"]',
			),
		).not.toBeNull();

		// And when the search matches nothing at all, which is the state a
		// spotlight is most likely to land in.
		await user.clear(searchBox());
		await user.type(searchBox(), "zzzz-no-such-topic");
		expect(
			container.querySelector(
				'[data-onboarding-target="publishing-suite-inbox"]',
			),
		).not.toBeNull();
	});

	// Search deliberately spans EVERY status, including the two the Inbox
	// sections exclude. A topic you declined last month and half remember is
	// exactly what search is reached for, and it is otherwise only findable by
	// knowing which chip to press.
	it("finds a topic neither Inbox section shows", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({
				id: "d",
				title: "Declined last month",
				status: "DECLINED",
			}),
		];
		renderList();
		expect(
			screen.queryByText("Declined last month"),
		).not.toBeInTheDocument();

		await user.type(searchBox(), "declined last");
		expect(screen.getByText("Declined last month")).toBeInTheDocument();
	});

	it("names the term that found nothing", async () => {
		const user = userEvent.setup();
		state.topics = [makeTopic({ id: "a", title: "Shipping the inbox" })];
		renderList();
		await user.type(searchBox(), "kubernetes");
		expect(
			screen.getByText(/No topics match .*kubernetes/),
		).toBeInTheDocument();
	});
});

/**
 * FR2 made the title a real anchor so middle-click and "open in new tab" work,
 * and the chevron beside it a separate disclosure button. What nobody could do
 * was click the CARD — the owner reported exactly that. The row now navigates
 * from anywhere that is not itself a control.
 */
describe("clicking the row", () => {
	beforeEach(() => {
		routerPush.mockClear();
	});

	it("opens the topic from anywhere on the card", async () => {
		const user = userEvent.setup();
		state.topics = [makeTopic({ id: "a", title: "Clickable topic" })];
		renderList();

		await user.click(
			screen.getByText("Clickable topic").closest("li") as HTMLElement,
		);

		expect(routerPush).toHaveBeenCalledTimes(1);
		expect(routerPush.mock.calls[0][0]).toContain("/publishing/a");
	});

	it("leaves the controls inside it alone", async () => {
		// The status select, the disclosure chevron, mute and snooze all live
		// inside the card. If the row swallowed their clicks, opening the
		// status dropdown would navigate away instead of opening.
		const user = userEvent.setup();
		state.topics = [makeTopic({ id: "a", title: "Clickable topic" })];
		renderList();

		await user.click(screen.getByTestId("topic-disclosure"));

		expect(routerPush).not.toHaveBeenCalled();
	});

	it("leaves a modified click to the anchor", async () => {
		// Cmd/Ctrl-click means "open somewhere else" and belongs to the title
		// link, which is a real anchor. Handling it here would open the topic
		// in the current tab and quietly break that gesture.
		const user = userEvent.setup();
		state.topics = [makeTopic({ id: "a", title: "Clickable topic" })];
		renderList();

		const row = screen
			.getByText("Clickable topic")
			.closest("li") as HTMLElement;
		await user.keyboard("{Meta>}");
		await user.click(row);
		await user.keyboard("{/Meta}");

		expect(routerPush).not.toHaveBeenCalled();
	});
});

/**
 * "Worth a look" — the hot-topic section (#2).
 *
 * A forced ranking rather than a score, measured before it was built: across
 * 202 staging topics 68% cite two or more sources, so an absolute bar would
 * have marked most of the queue. The model ranks its own batch, capped at two
 * per cycle, and the reason it gives rides the row — a tint with no explanation
 * is the badge people learn to ignore.
 */
describe("worth a look", () => {
	it("gives a highlighted topic its own section, above the rest", () => {
		state.topics = [
			makeTopic({ id: "plain", title: "An ordinary topic" }),
			makeTopic({
				id: "hot",
				title: "The standout",
				highlightReason: "Came up in three separate meetings",
			}),
		];
		renderList();

		const section = screen.getByRole("region", { name: /worth a look/i });
		expect(within(section).getByText("The standout")).toBeInTheDocument();
		expect(
			within(section).queryByText("An ordinary topic"),
		).not.toBeInTheDocument();
	});

	it("says WHY, not just that it stands out", () => {
		state.topics = [
			makeTopic({
				id: "hot",
				title: "The standout",
				highlightReason: "Came up in three separate meetings",
			}),
		];
		renderList();

		expect(
			screen.getByText("Came up in three separate meetings"),
		).toBeInTheDocument();
	});

	it("renders no empty section on a quiet week", () => {
		// The other two sections answer "what should I look at next", and an
		// empty one is itself an answer. This one claims something stands out —
		// an empty heading every quiet week teaches a reader to stop believing
		// it.
		state.topics = [makeTopic({ id: "plain", title: "An ordinary topic" })];
		renderList();

		expect(
			screen.queryByRole("region", { name: /worth a look/i }),
		).not.toBeInTheDocument();
	});

	it("lets the highlight expire instead of pinning a topic there", () => {
		state.topics = [
			makeTopic({
				id: "old",
				title: "Was worth a look last week",
				createdAt: daysAgo(9),
				updatedAt: daysAgo(9),
				highlightReason: "Stale claim",
			}),
		];
		renderList();

		expect(
			screen.queryByRole("region", { name: /worth a look/i }),
		).not.toBeInTheDocument();
		expect(screen.queryByText("Stale claim")).not.toBeInTheDocument();
	});
});

/**
 * The sort and layout controls — "lets have option to change sorting and
 * remember user's preference so when he revisits its the same for him", and
 * "maybe lets have an option to change view".
 *
 * The preference is stored per user per project, so this only pins what the
 * component does with it; the storage is covered in the API and query suites.
 */
describe("sort and layout controls", () => {
	it("offers them while the sections are on screen", () => {
		state.topics = [makeTopic({ id: "a", title: "A topic" })];
		renderList();

		expect(
			screen.getByRole("combobox", { name: /sort topics/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("group", { name: /inbox layout/i }),
		).toBeInTheDocument();
	});

	it("hides them during a search", async () => {
		// A search replaces the sections with one flat list this control does
		// not order. Leaving it on screen would be a lie about what it does.
		const user = userEvent.setup();
		state.topics = [makeTopic({ id: "a", title: "A topic" })];
		renderList();

		await user.type(
			screen.getByRole("searchbox", { name: /search topics/i }),
			"topic",
		);

		expect(
			screen.queryByRole("combobox", { name: /sort topics/i }),
		).not.toBeInTheDocument();
	});

	it("shows which layout is active", () => {
		state.topics = [makeTopic({ id: "a", title: "A topic" })];
		renderList();

		const group = screen.getByRole("group", { name: /inbox layout/i });
		expect(
			within(group).getByRole("button", { name: /^list$/i }),
		).toHaveAttribute("aria-pressed", "true");
		expect(
			within(group).getByRole("button", { name: /two columns/i }),
		).toHaveAttribute("aria-pressed", "false");
	});
});

/**
 * Refresh history moved off the page and behind a button (#8).
 *
 * It was the last block on the list, under every state, and the card owner
 * could not tell what it was: "i wouldnt even know its here with such long
 * list, but still dont understand what is that". A table of runs is reference
 * material — worth reaching for when the list is thinner than expected, and
 * noise the rest of the time.
 */
describe("refresh history", () => {
	it("is behind a button rather than under the list", () => {
		state.topics = [makeTopic({ id: "a", title: "A topic" })];
		renderList();

		expect(
			screen.getByRole("button", { name: /refresh history/i }),
		).toBeInTheDocument();
	});

	it("keeps the tour anchor, on the control that opens it", () => {
		// The anchor MOVED rather than being deleted. A spotlight cannot point
		// at something that is not on screen until you click, so it belongs on
		// the button — and the tour copy moved with it, which is what keeps the
		// drift test green.
		state.topics = [makeTopic({ id: "a", title: "A topic" })];
		const { container } = renderList();

		const anchored = container.querySelector(
			'[data-onboarding-target="publishing-history"]',
		);
		expect(anchored?.tagName).toBe("BUTTON");
	});

	it("marks the button when the most recent refresh failed", () => {
		// Only a FAILURE earns a mark. A run that found nothing is ordinary and
		// the list says so itself; a failed one is WHY the list is short.
		state.cycle = { status: "FAILED" };
		state.topics = [makeTopic({ id: "a", title: "A topic" })];
		renderList();

		expect(
			screen.getByLabelText(/most recent refresh failed/i),
		).toBeInTheDocument();
	});

	it("leaves the button unmarked for an ordinary refresh", () => {
		state.cycle = { status: "READY" };
		state.topics = [makeTopic({ id: "a", title: "A topic" })];
		renderList();

		expect(
			screen.queryByLabelText(/most recent refresh failed/i),
		).not.toBeInTheDocument();
	});
});

/**
 * Who owns a topic, without expanding it.
 *
 * "if we have someone who already owns it/works on it, maybe it makes sense to
 * show that" was closed against a list that renders inside `TopicDetails` —
 * which the row mounts only behind the disclosure chevron. So it shipped behind
 * exactly the extra click the role pill had just been lifted out of.
 */
describe("Inbox row — assignees are visible without expanding", () => {
	const ASSIGNEES = [
		{ id: "u1", name: "Ada Lovelace", image: null, username: null },
		{ id: "u2", name: "Grace Hopper", image: null, username: null },
	];

	it("names every assignee on the collapsed row", () => {
		state.topics = [
			makeTopic({
				assigneeUserIds: ASSIGNEES.map((a) => a.id),
				assignees: ASSIGNEES,
			}),
		];
		renderList();

		// The accessible name carries the names; the row itself carries
		// initials, because at a glance the question is "is anyone on this".
		expect(
			screen.getByLabelText("Assigned to Ada Lovelace, Grace Hopper"),
		).toBeInTheDocument();
	});

	it("an editor's unassigned row has no 'Assigned to' list (it offers Assign instead)", () => {
		state.topics = [makeTopic()];
		renderList();

		expect(screen.queryByLabelText(/^Assigned to/)).not.toBeInTheDocument();
	});
});

/**
 * Two views over the list, not two statuses.
 *
 * "When I land here, I don't immediately know what to do" — Unread and
 * Assigned to me answer that, and neither is a state a topic can be set to.
 * Both are questions about the READER, which is why they need their own arms
 * rather than falling through to the status comparison.
 */
describe("Inbox — the Unread and Assigned-to-me views", () => {
	it("counts unread topics on the chip", () => {
		state.topics = [
			makeTopic({ id: "t1", isRead: false }),
			makeTopic({ id: "t2", isRead: true }),
			makeTopic({ id: "t3", isRead: false }),
		];
		renderList();

		expect(
			screen.getByRole("button", { name: /^Unread\s*2$/ }),
		).toBeInTheDocument();
	});

	it("narrows the list to unread when the view is picked", async () => {
		state.topics = [
			makeTopic({ id: "t1", title: "Unread one", isRead: false }),
			makeTopic({ id: "t2", title: "Already read", isRead: true }),
		];
		renderList();

		// Exact: the chip's accessible name carries its count, and a prefix
		// match also catches the same chip in its other states.
		await userEvent.click(screen.getByRole("button", { name: "Unread 1" }));

		expect(screen.getByText("Unread one")).toBeInTheDocument();
		expect(screen.queryByText("Already read")).not.toBeInTheDocument();
	});

	it("shows no count on a view that is empty", () => {
		// A zero beside a chip is a permanent mark that says nothing.
		state.topics = [makeTopic({ isRead: true })];
		renderList();

		expect(
			screen.getByRole("button", { name: /^Unread$/ }),
		).toBeInTheDocument();
	});
});

// ---------------------------------------------------------------------------
// Fizzy #2646: a status change must LOOK saved the moment it is made.
// ---------------------------------------------------------------------------

const LIST_TOPICS_KEY = {
	queryKey: [
		"projects.publishingSuite.listTopics",
		{ projectId: "proj-1", organizationId: null },
	],
};

/**
 * The row's status Select while a modal dialog is open.
 *
 * Radix hides the rest of the page from the accessibility tree, but the
 * `aria-hidden` library it uses exempts `[aria-live]` elements. The row's
 * always-mounted save indicator is one, so its ancestors stay exposed and its
 * SIBLINGS — the status control among them — are marked `aria-hidden`
 * individually. Testing Library computes no accessible name for an element
 * that is itself `aria-hidden`, so `getByRole({ name, hidden: true })` cannot
 * find it; the `aria-label` attribute still identifies it.
 */
const statusSelectBehindModal = (title: string) => {
	const matches = screen
		.getAllByRole("combobox", { hidden: true })
		.filter(
			(el) => el.getAttribute("aria-label") === `Status for ${title}`,
		);
	expect(matches).toHaveLength(1);
	return matches[0];
};

describe("#2646 — status save feedback on the Inbox row", () => {
	it("shows the new status with Saving… while the write is in flight, then Saved", async () => {
		const user = userEvent.setup();
		let release: () => void = () => {};
		state.statusMutationGate = new Promise<void>((r) => {
			release = r;
		});
		state.topics = [makeTopic({ id: "t1", title: "Alpha topic" })];
		renderList();

		try {
			await user.click(
				screen.getByRole("combobox", {
					name: "Status for Alpha topic",
				}),
			);
			await user.click(
				await screen.findByRole("option", { name: "Selected" }),
			);

			// Before #2646 the control kept the CACHED value (Suggestion) here.
			await waitFor(() =>
				expect(
					screen.getByRole("combobox", {
						name: "Status for Alpha topic",
					}),
				).toHaveTextContent("Selected"),
			);
			expect(
				screen.getByTestId("topic-status-save-indicator"),
			).toHaveTextContent("Saving…");
			// Not before the write has settled: a refetch started before the
			// server commits could land after the settle time with the OLD
			// value (spec §4.1).
			expect(invalidateQueriesMock).not.toHaveBeenCalledWith(
				LIST_TOPICS_KEY,
			);
		} finally {
			release();
		}
		await waitFor(() =>
			expect(
				screen.getByTestId("topic-status-save-indicator"),
			).toHaveTextContent("Saved"),
		);
	});

	it("holds the new value, disabled, until the confirming refetch — and keeps 'Saved' when that refetch moves the row", async () => {
		const user = userEvent.setup();
		state.topicsUpdatedAt = 0; // the confirming refetch has not landed
		state.topics = [
			makeTopic({ id: "t1", title: "Alpha topic", status: "SUGGESTION" }),
		];
		const { rerender } = renderList();

		await user.click(
			screen.getByRole("combobox", { name: "Status for Alpha topic" }),
		);
		await user.click(
			await screen.findByRole("option", { name: "Selected" }),
		);
		await waitFor(() =>
			expect(invalidateQueriesMock).toHaveBeenCalledWith(LIST_TOPICS_KEY),
		);
		// …and marks the topic page's own read of it stale (spec §4.3).
		expect(invalidateQueriesMock).toHaveBeenCalledWith({
			queryKey: [
				"projects.publishingSuite.getTopic",
				{ projectId: "proj-1", topicId: "t1", organizationId: null },
			],
		});
		// Selecting auto-starts the planning analysis on the server: the topic
		// page's cached "no analysis yet" read is stale too.
		expect(invalidateQueriesMock).toHaveBeenCalledWith({
			queryKey: [
				"projects.publishingSuite.getPlanningAnalysis",
				{ projectId: "proj-1", topicId: "t1", organizationId: null },
			],
		});

		const held = screen.getByRole("combobox", {
			name: "Status for Alpha topic",
		});
		expect(held).toHaveTextContent("Selected");
		expect(held).toBeDisabled();
		expect(
			screen.getByTestId("topic-status-save-indicator"),
		).toHaveTextContent("Saved");

		// The refetch lands: SELECTED moves the topic out of Suggested and
		// into Recently Modified — a different <ul>, so a NEW row instance.
		state.topics = [
			makeTopic({ id: "t1", title: "Alpha topic", status: "SELECTED" }),
		];
		state.topicsUpdatedAt = Date.now() + 60_000;
		rerender(
			<PublishingSuiteList
				projectId="proj-1"
				organizationId={null}
				canEdit
			/>,
		);

		const control = screen.getByRole("combobox", {
			name: "Status for Alpha topic",
		});
		expect(control).toBeEnabled();
		expect(control).toHaveTextContent("Selected");
		expect(
			screen.getByRole("region", { name: /recently modified/i }),
		).toContainElement(control);
		const row = control.closest("li") as HTMLElement;
		expect(
			within(row).getByTestId("topic-status-save-indicator"),
		).toHaveTextContent("Saved");
	});

	it("puts the server's status back, says Not saved, and still refreshes when the write fails", async () => {
		const user = userEvent.setup();
		state.updateStatusRejects = true;
		state.topics = [
			makeTopic({ id: "t1", title: "Alpha topic", status: "SUGGESTION" }),
		];
		renderList();

		await user.click(
			screen.getByRole("combobox", { name: "Status for Alpha topic" }),
		);
		await user.click(
			await screen.findByRole("option", { name: "Selected" }),
		);

		await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
		const control = screen.getByRole("combobox", {
			name: "Status for Alpha topic",
		});
		expect(control).toHaveTextContent("Suggestion");
		expect(control).toBeEnabled();
		expect(
			screen.getByTestId("topic-status-save-indicator"),
		).toHaveTextContent("Not saved");
		// A request can fail AFTER the server committed — the list must catch
		// up rather than trust the failure (spec §4.1, panel A #2).
		expect(invalidateQueriesMock).toHaveBeenCalledWith(LIST_TOPICS_KEY);
	});

	it("does not refresh the planning analysis for a status other than Selected", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({ id: "t1", title: "Alpha topic", status: "SUGGESTION" }),
		];
		renderList();

		await user.click(
			screen.getByRole("combobox", { name: "Status for Alpha topic" }),
		);
		await user.click(
			await screen.findByRole("option", { name: "In progress" }),
		);
		// The refresh has run — only then is the absence meaningful.
		await waitFor(() =>
			expect(invalidateQueriesMock).toHaveBeenCalledWith(LIST_TOPICS_KEY),
		);
		expect(
			invalidateQueriesMock.mock.calls.some((c) =>
				JSON.stringify(c[0]).includes("getPlanningAnalysis"),
			),
		).toBe(false);
	});

	it("keeps the typed URL when publishing fails", async () => {
		const user = userEvent.setup();
		state.updateStatusRejects = true;
		state.topics = [
			makeTopic({ id: "t1", title: "Alpha topic", status: "SUGGESTION" }),
		];
		renderList();

		await user.click(
			screen.getByRole("combobox", { name: "Status for Alpha topic" }),
		);
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
		// A LIVE `initialUrl` (the overlay's URL while the write was out, then
		// the cached empty one when the failure removed the overlay) would
		// have re-seeded the field and wiped what was typed.
		expect(
			within(screen.getByRole("dialog")).getByRole("textbox"),
		).toHaveValue("https://blog.example.com/typed");
		// The dialog is modal and still open: the row's control is hidden
		// from the accessibility tree (see `statusSelectBehindModal`).
		expect(statusSelectBehindModal("Alpha topic")).toHaveTextContent(
			"Suggestion",
		);
	});

	it("keeps Edit URL and the status control disabled after a URL edit saves, until the refetch confirms it", async () => {
		const user = userEvent.setup();
		state.topicsUpdatedAt = 0;
		state.topics = [
			makeTopic({
				id: "t1",
				title: "Alpha topic",
				status: "PUBLISHED",
				publishedUrl: "https://blog.example.com/old",
				isRead: true,
			}),
		];
		const { rerender } = renderList();

		// PUBLISHED belongs to neither Inbox section — reach it via its chip.
		await user.click(screen.getByRole("button", { name: "Published" }));
		await user.click(screen.getByTestId("topic-disclosure"));
		await user.click(screen.getByRole("button", { name: "Edit URL" }));
		const dialog = await screen.findByRole("dialog");
		const field = within(dialog).getByRole("textbox");
		expect(field).toHaveValue("https://blog.example.com/old");
		await user.clear(field);
		await user.type(field, "https://blog.example.com/new");
		await user.click(within(dialog).getByRole("button", { name: "Save" }));

		// The write succeeded and the dialog closed — but the list has not
		// re-read the topic, so a second write must still be impossible.
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		expect(screen.getByRole("button", { name: "Edit URL" })).toBeDisabled();
		expect(
			screen.getByRole("combobox", { name: "Status for Alpha topic" }),
		).toBeDisabled();
		expect(
			screen.getByText("https://blog.example.com/new"),
		).toBeInTheDocument();

		state.topics = [
			makeTopic({
				id: "t1",
				title: "Alpha topic",
				status: "PUBLISHED",
				publishedUrl: "https://blog.example.com/new",
				isRead: true,
			}),
		];
		state.topicsUpdatedAt = Date.now() + 60_000;
		rerender(
			<PublishingSuiteList
				projectId="proj-1"
				organizationId={null}
				canEdit
			/>,
		);
		expect(screen.getByRole("button", { name: "Edit URL" })).toBeEnabled();
	});

	it("shows the NEW decline reason in the expanded row before the refetch lands", async () => {
		const user = userEvent.setup();
		state.topicsUpdatedAt = 0;
		state.topics = [
			makeTopic({ id: "t1", title: "Alpha topic", isRead: true }),
		];
		renderList();

		await user.click(
			screen.getByRole("combobox", { name: "Status for Alpha topic" }),
		);
		await user.click(
			await screen.findByRole("option", { name: "Declined" }),
		);
		const dialog = await screen.findByRole("dialog");
		await user.type(within(dialog).getByRole("textbox"), "Too niche");
		await user.click(
			within(dialog).getByRole("button", { name: "Decline topic" }),
		);
		await waitFor(() => expect(updateStatusMutate).toHaveBeenCalled());
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);

		// The cache still says SUGGESTION with no reason (refetch held), so the
		// row is still in Suggested — expanded, it must show what was sent.
		await user.click(screen.getByTestId("topic-disclosure"));
		expect(screen.getByText("Why this was declined")).toBeInTheDocument();
		expect(screen.getByText("Too niche")).toBeInTheDocument();
	});
});

// ---------------------------------------------------------------------------
// Fizzy #2646 follow-up: "Saving… / Saved" appearing BEFORE the status control
// pushed it sideways under the pointer the user had just used. jsdom has no
// layout, so these pin the structure that keeps it still: the note comes after
// the control, and an editor's row gives it a fixed-width slot from sm up.
// ---------------------------------------------------------------------------

describe("#2646 — the Inbox status control does not move while the save note shows", () => {
	// Two rows, and every query scoped to one of them: with the fixture's
	// second row in the DOM, a page-wide query could pair one row's control
	// with the OTHER row's note and pass on document order alone.
	const twoTopics = () => [
		makeTopic({ id: "t1", title: "Alpha topic" }),
		makeTopic({ id: "t2", title: "Beta topic", pitch: "Beta pitch" }),
	];
	const rowParts = (title: string) => {
		const row = screen.getByText(title).closest("li") as HTMLElement;
		return {
			control: within(row).getByRole("combobox", {
				name: `Status for ${title}`,
			}),
			note: within(row).getByTestId("topic-status-save-indicator"),
		};
	};

	it("editor row: the note comes after the status control", () => {
		state.topics = twoTopics();
		renderList();

		const { control, note } = rowParts("Alpha topic");
		// In the control's own cluster — beside it, not merely later in the row.
		expect(control.parentElement).toContainElement(note);
		expect(
			control.compareDocumentPosition(note) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
	});

	it("editor row: the note holds a fixed-width slot from sm up", () => {
		state.topics = twoTopics();
		renderList();

		const { note } = rowParts("Alpha topic");
		expect(note).toHaveClass("sm:w-20");
		// From sm up ONLY: below it the control is full-width, and a fixed
		// slot would squeeze it too narrow for "In progress".
		expect(note).not.toHaveClass("w-20");
	});

	it("viewer row: the note is still there, after the control, with no reserved slot", () => {
		state.topics = twoTopics();
		renderList({ canEdit: false });

		// Still rendered: permission can be withdrawn while a save this row
		// started is settling, and its outcome must still be said.
		const { control, note } = rowParts("Alpha topic");
		expect(control.parentElement).toContainElement(note);
		expect(
			control.compareDocumentPosition(note) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
		// A viewer's control is disabled, so a reserved slot is dead space.
		expect(note).not.toHaveClass("sm:w-20");
	});
});

// ---------------------------------------------------------------------------
// Fizzy #2646: the people on a collapsed row ARE the control that changes
// them — an editor assigns and unassigns without expanding or leaving the list.
// ---------------------------------------------------------------------------

describe("#2646 — assign people from the collapsed Inbox row", () => {
	const ADA = { id: "u1", name: "Ada Lovelace", image: null, username: null };
	const GRACE = {
		id: "u2",
		name: "Grace Hopper",
		image: null,
		username: null,
	};
	const member = (u: typeof ADA) => ({
		userId: u.id,
		role: "EDITOR",
		user: {
			id: u.id,
			name: u.name,
			email: `${u.id}@example.com`,
			image: null,
		},
		isOwner: false,
		isCreator: false,
		isGuest: false,
		invitedAt: null,
		acceptedAt: null,
		expiresAt: null,
	});
	const rowOf = (title: string) =>
		screen.getByText(title).closest("li") as HTMLElement;

	beforeEach(() => {
		state.members = [member(ADA), member(GRACE)];
		// The file-level `beforeEach` does not reset this spy, so without the
		// clear a navigation from an earlier case would be read as this one's.
		routerPush.mockClear();
	});
	afterEach(() => {
		state.members = [];
	});

	it("opens the picker from the assignee avatars without leaving the list", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({
				assigneeUserIds: [ADA.id, GRACE.id],
				assignees: [ADA, GRACE],
			}),
		];
		renderList();

		const trigger = screen.getByRole("button", {
			name: "Assigned to Ada Lovelace, Grace Hopper",
		});
		expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
		// The same string as the name: a title that differs becomes the
		// accessible description, and the names are read out twice.
		expect(trigger).toHaveAttribute(
			"title",
			"Assigned to Ada Lovelace, Grace Hopper",
		);
		await user.click(trigger);

		expect(await screen.findByText("Assignees")).toBeInTheDocument();
		expect(routerPush).not.toHaveBeenCalled();
	});

	it("unassigns by unchecking and saving", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({
				assigneeUserIds: [ADA.id, GRACE.id],
				assignees: [ADA, GRACE],
			}),
		];
		renderList();

		await user.click(
			screen.getByRole("button", {
				name: "Assigned to Ada Lovelace, Grace Hopper",
			}),
		);
		await user.click(
			await screen.findByRole("checkbox", { name: /Grace Hopper/ }),
		);
		await user.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(updateAssigneesMutate).toHaveBeenCalledWith(
				expect.objectContaining({
					topicId: "t1",
					assigneeUserIds: [ADA.id],
				}),
			),
		);
		// A successful save closes the row's picker.
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		expect(updateStatusMutate).not.toHaveBeenCalled();
		expect(routerPush).not.toHaveBeenCalled();
	});

	it("unassigns everyone by unchecking all and saving", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({ assigneeUserIds: [ADA.id], assignees: [ADA] }),
		];
		renderList();

		await user.click(
			screen.getByRole("button", { name: "Assigned to Ada Lovelace" }),
		);
		await user.click(
			await screen.findByRole("checkbox", { name: /Ada Lovelace/ }),
		);
		await user.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(updateAssigneesMutate).toHaveBeenCalledWith(
				expect.objectContaining({ topicId: "t1", assigneeUserIds: [] }),
			),
		);
		// A successful save closes the row's picker.
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
	});

	it("offers 'Assign' on an unassigned topic and saves the selection", async () => {
		const user = userEvent.setup();
		state.topics = [makeTopic({ title: "Alpha topic" })];
		renderList();

		const assign = screen.getByRole("button", {
			name: "Assign people to Alpha topic",
		});
		expect(assign).toHaveTextContent("Assign");
		await user.click(assign);
		await user.click(
			await screen.findByRole("checkbox", { name: /Ada Lovelace/ }),
		);
		await user.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(updateAssigneesMutate).toHaveBeenCalledWith(
				expect.objectContaining({ assigneeUserIds: [ADA.id] }),
			),
		);
		// A successful save closes the row's picker.
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
	});

	it("disables the row's assignee control while its own write is pending", async () => {
		const user = userEvent.setup();
		let release: () => void = () => {};
		state.assigneesMutationGate = new Promise<void>((r) => {
			release = r;
		});
		state.topics = [makeTopic({ title: "Alpha topic" })];
		renderList();

		try {
			await user.click(
				screen.getByRole("button", {
					name: "Assign people to Alpha topic",
				}),
			);
			await user.click(
				await screen.findByRole("checkbox", { name: /Ada Lovelace/ }),
			);
			await user.click(screen.getByRole("button", { name: "Save" }));
			await waitFor(() =>
				expect(updateAssigneesMutate).toHaveBeenCalled(),
			);

			// The custom trigger carries no `disabled` of its own — this is the
			// picker's gate reaching it through the trigger slot (Task 4).
			expect(
				screen.getByRole("button", {
					name: "Assign people to Alpha topic",
				}),
			).toBeDisabled();
		} finally {
			release();
		}
	});

	// Behaviour, not wiring: Radix's outside-dismissal alone makes this hold.
	it("only one assignee picker is ever open", async () => {
		const user = userEvent.setup();
		state.topics = [
			makeTopic({
				title: "Alpha topic",
				assigneeUserIds: [ADA.id],
				assignees: [ADA],
				isRead: true,
			}),
		];
		renderList();

		await user.click(screen.getByTestId("topic-disclosure"));
		await user.click(
			screen.getByRole("button", { name: "Edit assignees" }),
		);
		// Each open picker is one Radix PopoverContent (role "dialog").
		expect(await screen.findAllByRole("dialog")).toHaveLength(1);

		await user.click(
			screen.getByRole("button", { name: "Assigned to Ada Lovelace" }),
		);
		await waitFor(() =>
			expect(screen.getAllByRole("dialog")).toHaveLength(1),
		);
		expect(
			screen.getByRole("button", { name: "Assigned to Ada Lovelace" }),
		).toHaveAttribute("aria-expanded", "true");
	});

	it("viewer, assigned: keeps the read-only list and offers no control", () => {
		state.topics = [
			makeTopic({
				title: "Alpha topic",
				assigneeUserIds: [ADA.id],
				assignees: [ADA],
			}),
		];
		renderList({ canEdit: false });

		// Scoped to the row: the list's "Assigned to me" view chip is itself
		// a button matching /assign/i.
		const row = rowOf("Alpha topic");
		expect(
			within(row).getByRole("list", { name: "Assigned to Ada Lovelace" }),
		).toBeInTheDocument();
		expect(
			within(row).queryByRole("button", { name: /assign/i }),
		).not.toBeInTheDocument();
	});

	it("viewer, unassigned: says nothing and offers no control", () => {
		state.topics = [makeTopic({ title: "Alpha topic" })];
		renderList({ canEdit: false });

		const row = rowOf("Alpha topic");
		expect(
			within(row).queryByRole("button", { name: /assign/i }),
		).not.toBeInTheDocument();
		expect(
			within(row).queryByLabelText(/^Assigned to/),
		).not.toBeInTheDocument();
	});
});
