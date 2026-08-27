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

vi.mock("sonner", () => ({ toast: { error: toastError } }));

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
				},
			},
		},
	};
});

vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: {} }));

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
		createdAt: new Date("2026-08-01T00:00:00Z"),
		updatedAt: new Date("2026-08-01T00:00:00Z"),
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
		whySuggested: null,
		meetingSpeakers: null,
		...overrides,
	};
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
			.getAllByTestId("topic-disclosure")
			.map((b) => b.textContent);
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
	it("preserves the incoming tier order in Suggested", () => {
		state.topics = [
			makeTopic({
				id: "tier1",
				title: "Contributed but old",
				status: "SUGGESTION",
				createdAt: new Date("2026-07-01T00:00:00Z"),
				updatedAt: new Date("2026-07-05T00:00:00Z"),
				rankReason: { kind: "contributed" },
			}),
			makeTopic({
				id: "tier3",
				title: "Newer but unranked",
				status: "SUGGESTION",
				createdAt: new Date("2026-08-20T00:00:00Z"),
				updatedAt: new Date("2026-08-25T00:00:00Z"),
			}),
		];
		renderList();
		const suggested = screen.getByRole("region", { name: /suggested/i });
		const titles = within(suggested)
			.getAllByTestId("topic-disclosure")
			.map((b) => b.textContent);
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
			.getAllByTestId("topic-disclosure")
			.map((b) => b.textContent);
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
