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
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	state,
	updateStatusMutate,
	setReadStateMutate,
	setSnoozeMutate,
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
	},
	updateStatusMutate: vi.fn(),
	setReadStateMutate: vi.fn(),
	setSnoozeMutate: vi.fn(),
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
					: updateStatusMutate;
		const rejects =
			(procedure === "projects.publishingSuite.setTopicReadState" &&
				state.setReadStateRejects) ||
			(procedure === "projects.publishingSuite.setTopicSnooze" &&
				state.setSnoozeRejects);
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
	useQueryClient: () => ({ invalidateQueries: invalidateQueriesMock }),
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

function renderList() {
	return render(
		<PublishingSuiteList
			projectId="proj-1"
			organizationId={null}
			canEdit
		/>,
	);
}

beforeEach(() => {
	state.topics = [];
	state.setReadStateRejects = false;
	state.setSnoozeRejects = false;
	state.statusMutationGate = null;
	state.readStateMutationGate = null;
	updateStatusMutate.mockReset();
	setReadStateMutate.mockReset();
	setSnoozeMutate.mockReset();
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
			// (called from the status mutation's `onSuccess`) is the reliable
			// signal that changeStatus's whole promise chain — including its
			// `finally` — has run, not just that the gate promise resolved.
			releaseStatusMutation();
			await waitFor(() =>
				expect(invalidateQueriesMock).toHaveBeenCalledTimes(1),
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
