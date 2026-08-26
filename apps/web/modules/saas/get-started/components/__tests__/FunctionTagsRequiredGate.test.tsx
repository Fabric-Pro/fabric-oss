/**
 * Blocking role-tag gate (Fizzy #2264, AC1-AC5).
 *
 * What actually makes the modal undismissable: it renders `<Dialog open>`
 * with NO `onOpenChange` handler (`FunctionTagsRequiredGate.tsx`, and
 * `Dialog` is a bare `DialogPrimitive.Root` — `modules/ui/components/
 * dialog.tsx`). Every Radix dismissal path — Escape, outside pointer-down,
 * a close button — terminates in a call to `onOpenChange(false)`; with no
 * handler wired up, that call has nowhere to go, `open` never changes, and
 * the dialog stays mounted no matter what the user does. The
 * `onEscapeKeyDown` / `onPointerDownOutside` / `onInteractOutside`
 * `preventDefault()` calls on `DialogContent` are defensive depth, not the
 * mechanism — they would only start to matter if someone later wired an
 * `onOpenChange` onto the `Dialog`. Deleting all three handlers leaves
 * every test below green.
 *
 * The dismissal tests assert the modal is STILL PRESENT after each attempt,
 * which pins the actual (missing-`onOpenChange`) mechanism — it does not
 * distinguish that from the `preventDefault` handlers, so don't read "the
 * modal survived" as proof the handlers matter. The one thing here that IS
 * genuinely pinned by a test is `hideCloseButton` (see "AC4: has no close
 * button and resists Escape").
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getMyDefault = vi.fn();
const setMyDefault = vi.fn();
let flagValue = true;
let snapshotValue: boolean | null = false;

// The real `@orpc/tanstack-query` route path for `getMyProjectStatus` — an
// array of segments, shared by both `key()` and `queryKey()` below so the
// mock stays faithful to `generateOperationKey(path, state)`.
const PROJECT_STATUS_PATH = ["functionTags", "getMyProjectStatus"];

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		functionTags: {
			getMyDefault: {
				queryOptions: () => ({
					queryKey: ["ft", "getMyDefault"],
					queryFn: getMyDefault,
				}),
			},
			getMyProjectStatus: {
				// Faithful to the real `@orpc/tanstack-query`
				// `generateOperationKey(path, state)`: both forms share the SAME
				// `path` — an array of route segments, not a dotted string — and
				// differ only in `state`. `key()` with no options is `[path, {}]`
				// (two-element PARTIAL form, what `invalidateQueries` prefix-
				// matches on); `queryKey({ input })` is `[path, { input, type:
				// "query" }]` (exact, scoped to one project).
				//
				// Deliberately faithful, not simplified: a mock exposing only
				// `key()` would make the Step-7 negative control (narrowing
				// `key()` to `queryKey({ input })` in the component) redden on a
				// `TypeError` thrown inside `onSuccess` rather than on the
				// narrowed key's actual CONTENT — which proves the control
				// detects the method's ABSENCE, not the narrowing it claims to
				// catch.
				key: () => [PROJECT_STATUS_PATH, {}],
				queryKey: ({ input }: { input: unknown }) => [
					PROJECT_STATUS_PATH,
					{ input, type: "query" },
				],
			},
		},
	},
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		functionTags: { setMyDefault: (i: unknown) => setMyDefault(i) },
	},
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => flagValue,
}));
vi.mock("@saas/shared/components/RoleTagSnapshotProvider", () => ({
	useRoleTagSnapshot: () => snapshotValue,
}));

import {
	FunctionTagsRequiredGate,
	killSwitchRefetchInterval,
	shouldEnforce,
} from "../FunctionTagsRequiredGate";

// MUST be the same literal as the `queryKey` in the `orpc` mock above.
// `setQueryData` hashes the key EXACTLY (see
// `modules/saas/admin/component/feature-flags/__tests__/FeatureFlagsPanel.test.tsx:64`),
// so a near-miss writes to a cache slot the component never subscribed to —
// and every transition test below quietly stops testing anything instead of
// failing. If you change one, change both.
const QUERY_KEY = ["ft", "getMyDefault"];

function renderGate() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const view = render(
		<QueryClientProvider client={client}>
			<FunctionTagsRequiredGate />
		</QueryClientProvider>,
	);
	return { ...view, client };
}

const title = () => screen.queryByText("Set your function tags");

// Radix attaches its outside-pointerdown listener one macrotask after the
// content mounts (so the interaction that opened the dialog cannot
// immediately dismiss it). Flush that macrotask deterministically before
// and after outside interactions — a zero-delay queue drain, not a wait.
// Mirrors `DuplicateScanCompletionDialog.test.tsx`'s helper of the same name.
async function flushMacrotasks() {
	await act(async () => {
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
	});
}

// FunctionTagSelect renders a Popover trigger labelled by `aria-label`, and
// each selected tag carries a nested role="button" named `Remove <Label>`.
// Selecting means: open the popover, then click the option's TEXT.
// getByRole("button", { name: /developer/i }) matches neither of those.
async function selectTag(
	user: ReturnType<typeof userEvent.setup>,
	label: string,
) {
	await user.click(screen.getByLabelText("Your default function tags"));
	await user.click(await screen.findByText(label));
}

beforeEach(() => {
	vi.clearAllMocks();
	flagValue = true;
	snapshotValue = false;
	getMyDefault.mockResolvedValue({ tags: [], enforcementEnabled: true });
	// The REAL shape: set-my-default.ts returns `{ tags }` only. Fabricating
	// `enforcementEnabled` here would hide the cache-shape bug this test
	// exists to catch.
	setMyDefault.mockResolvedValue({ tags: ["DEVELOPER"] });
});

describe("FunctionTagsRequiredGate", () => {
	it("AC1: opens for a tagless user when enforcement is on", async () => {
		renderGate();
		await waitFor(() => expect(title()).toBeInTheDocument());
	});

	it("AC3: stays closed for a user who already has tags", async () => {
		// `snapshotValue = false` (a STALE snapshot claiming tagless) rather
		// than `true`: with `true` the snapshot alone would already satisfy
		// this assertion and the `data` branch of `shouldEnforce` would never
		// run. Asserting through `waitFor` on the title proves the live read
		// (which says "has tags") overrides the snapshot, not merely that a
		// snapshot of `true` never opened anything.
		snapshotValue = false;
		getMyDefault.mockResolvedValue({
			tags: ["DEVELOPER"],
			enforcementEnabled: true,
		});
		renderGate();
		await waitFor(() => expect(title()).not.toBeInTheDocument());
	});

	it("stays closed when the payload flag is off", async () => {
		// The query is `enabled: flagFromPayload`, so with the flag off it
		// never fires — `getMyDefault` having-been-called can no longer be
		// used as a synchronisation barrier here. The title is what actually
		// decides the gate, so wait on that instead, and separately assert
		// the request was skipped (the whole point of `enabled`).
		flagValue = false;
		renderGate();
		await waitFor(() => expect(title()).not.toBeInTheDocument());
		expect(getMyDefault).not.toHaveBeenCalled();
	});

	it("closes when a LATER poll reports enforcement disabled (kill switch)", async () => {
		// Starts OPEN, then transitions. A version that merely starts with
		// enforcementEnabled:false would still pass with polling removed
		// entirely, which is the regression it is supposed to catch.
		const { client } = renderGate();
		await waitFor(() => expect(title()).toBeInTheDocument());

		client.setQueryData(QUERY_KEY, { tags: [], enforcementEnabled: false });

		await waitFor(() => expect(title()).not.toBeInTheDocument());
	});

	it("wires killSwitchRefetchInterval into the live query", async () => {
		// Nothing above exercises this wiring: the previous test drives the
		// transition via `client.setQueryData` directly, and the
		// `killSwitchRefetchInterval` describe block below calls the factory
		// in isolation. Deleting the `refetchInterval:
		// killSwitchRefetchInterval(...)` line from the component would leave
		// all other tests green while silently disconnecting an admin's kill
		// switch from an already-open gate. Assert the live query actually
		// received a function-valued `refetchInterval`, via the query cache
		// rather than by mocking `useQuery` itself.
		const { client } = renderGate();
		await waitFor(() => expect(title()).toBeInTheDocument());
		const query = client.getQueryCache().find({ queryKey: QUERY_KEY });
		expect(typeof query?.options.refetchInterval).toBe("function");
	});

	// The poll is verified by invoking the exact callback the component hands
	// to `useQuery`, with v5-shaped query state. NOT with fake timers: in
	// React Query v5 an interval fetch only runs while the focus manager
	// reports focused, so a `vi.advanceTimersByTime` test here either hangs or
	// passes for the wrong reason. This repo already hit that
	// (`__tests__/modules/saas/projects/newsletter-approval-chat-channels.test.tsx:499`
	// needs real timers plus `focusManager.setFocused(true)`).
	describe("killSwitchRefetchInterval", () => {
		const stub = (data: unknown) => ({ state: { data } }) as never;

		it("polls every 30s while the gate would be open", () => {
			const interval = killSwitchRefetchInterval(true, false);
			expect(interval(stub({ tags: [], enforcementEnabled: true }))).toBe(
				30_000,
			);
		});

		it("stops once the user has tags", () => {
			const interval = killSwitchRefetchInterval(true, false);
			expect(
				interval(
					stub({ tags: ["DEVELOPER"], enforcementEnabled: true }),
				),
			).toBe(false);
		});

		it("stops once enforcement is withdrawn", () => {
			const interval = killSwitchRefetchInterval(true, false);
			expect(
				interval(stub({ tags: [], enforcementEnabled: false })),
			).toBe(false);
		});

		it("never polls when the payload flag is off", () => {
			const interval = killSwitchRefetchInterval(false, false);
			expect(interval(stub({ tags: [], enforcementEnabled: true }))).toBe(
				false,
			);
		});
	});

	// `shouldEnforce` is the riskiest function in this file and is about to
	// gain a second caller (Task 5's `GetStartedController`), but until now
	// it only had coverage indirectly, through the component. Drive every
	// combination directly.
	describe("shouldEnforce", () => {
		type Data = { tags: string[]; enforcementEnabled: boolean } | undefined;

		const NO_READ: Data = undefined;
		const EMPTY_ON: Data = { tags: [], enforcementEnabled: true };
		const HAS_TAGS_ON: Data = {
			tags: ["DEVELOPER"],
			enforcementEnabled: true,
		};
		const EMPTY_OFF: Data = { tags: [], enforcementEnabled: false };

		// flagFromPayload=false: forced closed regardless of anything else —
		// "flag off wins over everything". 12 rows, all `false`.
		const flagOffRows: Array<[boolean, boolean | null, Data, boolean]> = (
			[true, false, null] as const
		).flatMap((snapshot) =>
			[NO_READ, EMPTY_ON, HAS_TAGS_ON, EMPTY_OFF].map(
				(data): [boolean, boolean | null, Data, boolean] => [
					false,
					snapshot,
					data,
					false,
				],
			),
		);

		// flagFromPayload=true: the interesting half.
		const flagOnRows: Array<[boolean, boolean | null, Data, boolean]> = [
			// No read has ever returned — fall back to the snapshot. Only
			// `snapshot === false` opens the gate; `null` ("unknown", server
			// read failed) does NOT (D12).
			[true, true, NO_READ, false],
			[true, false, NO_READ, true],
			[true, null, NO_READ, false],
			// A read HAS returned and it's empty — the gate opens regardless
			// of what the (now-superseded) snapshot claims. "Live data beats
			// the snapshot."
			[true, true, EMPTY_ON, true],
			[true, false, EMPTY_ON, true],
			[true, null, EMPTY_ON, true],
			// A read HAS returned with tags — closed regardless of snapshot.
			[true, true, HAS_TAGS_ON, false],
			[true, false, HAS_TAGS_ON, false],
			[true, null, HAS_TAGS_ON, false],
			// The kill switch: even an empty read does not open the gate once
			// enforcement has been withdrawn. Can only ever turn it OFF —
			// there is no data/snapshot combination anywhere in this table
			// that a `false` enforcementEnabled turns into `true`.
			[true, true, EMPTY_OFF, false],
			[true, false, EMPTY_OFF, false],
			[true, null, EMPTY_OFF, false],
		];

		const allRows = [...flagOffRows, ...flagOnRows];

		it.each(allRows)(
			"flagFromPayload=%s snapshot=%s data=%j -> %s",
			(flagFromPayload, snapshot, data, expected) => {
				expect(shouldEnforce(flagFromPayload, snapshot, data)).toBe(
					expected,
				);
			},
		);

		it("exactly 4 of the 24 combinations enforce the gate", () => {
			// Not a magic number: the count falls out of the table above —
			// 1 (NO_READ + snapshot===false) + 3 (EMPTY_ON, all snapshots).
			// Every HAS_TAGS_ON and EMPTY_OFF row is `false`, and the entire
			// flagFromPayload=false half is `false`.
			const trueCount = allRows.filter(
				([, , , expected]) => expected,
			).length;
			expect(trueCount).toBe(4);
		});

		it("property: the kill switch can only turn the gate OFF, never on", () => {
			// Same tags (empty — the strongest case FOR opening), same
			// snapshot: flipping enforcementEnabled from true to false can
			// only remove a `true`, never introduce one.
			expect(shouldEnforce(true, false, EMPTY_ON)).toBe(true);
			expect(shouldEnforce(true, false, EMPTY_OFF)).toBe(false);
		});

		it("property: an unknown (null) snapshot does not open the gate", () => {
			expect(shouldEnforce(true, null, NO_READ)).toBe(false);
		});

		it("property: the bypass self-heals once real data arrives", () => {
			// The other half of the property above: `null` alone stays
			// closed, but is not a permanent lock — a subsequent real read
			// overrides it the moment it lands, even though the snapshot
			// itself never changes.
			expect(shouldEnforce(true, null, NO_READ)).toBe(false);
			expect(shouldEnforce(true, null, EMPTY_ON)).toBe(true);
		});

		it("property: live data beats the snapshot in both directions", () => {
			// Snapshot says "has tags", live data says tagless -> data wins,
			// gate opens.
			expect(shouldEnforce(true, true, EMPTY_ON)).toBe(true);
			// Snapshot says tagless, live data says "has tags" -> data wins,
			// gate stays shut.
			expect(shouldEnforce(true, false, HAS_TAGS_ON)).toBe(false);
		});

		it("property: the payload flag off wins over everything else", () => {
			// Every other input here would open the gate on its own —
			// tagless data, a tagless snapshot — but the flag is the first
			// thing checked and short-circuits regardless.
			expect(shouldEnforce(false, false, EMPTY_ON)).toBe(false);
		});
	});

	it("does NOT open when the payload flag is off but the poll says true", async () => {
		// Same barrier fix as above: with `enabled: flagFromPayload` this
		// mocked "the poll says true" value is never even fetched — the flag
		// wins before the read is ever consulted.
		flagValue = false;
		getMyDefault.mockResolvedValue({ tags: [], enforcementEnabled: true });
		renderGate();
		await waitFor(() => expect(title()).not.toBeInTheDocument());
		expect(getMyDefault).not.toHaveBeenCalled();
	});

	it("AC4: has no close button and resists Escape", async () => {
		renderGate();
		await waitFor(() => expect(title()).toBeInTheDocument());
		expect(screen.queryByRole("button", { name: /close/i })).toBeNull();
		fireEvent.keyDown(document.activeElement ?? document.body, {
			key: "Escape",
			code: "Escape",
		});
		await waitFor(() => expect(title()).toBeInTheDocument());
	});

	it("AC4: stays present after an outside pointer-down", async () => {
		// Spec §7's dismissal list includes an outside click. The other AC4
		// tests cover Escape and the (absent) close button; this covers the
		// third path.
		renderGate();
		await waitFor(() => expect(title()).toBeInTheDocument());
		await flushMacrotasks();

		fireEvent.pointerDown(document.body);
		fireEvent.click(document.body);
		await flushMacrotasks();

		expect(title()).toBeInTheDocument();
	});

	it("AC4: offers no dismissal affordance", async () => {
		// Scoped to the FOOTER specifically, not the whole dialog: the
		// FunctionTagSelect trigger and each selected tag's "Remove <Label>"
		// span are ALSO buttons, so counting buttons across the whole dialog
		// would either miscount or force excluding those by name — which
		// would not catch a "Skip", "Later", or "Continue without tags"
		// button added to the footer. Asserting the footer holds exactly one
		// button, named Save/Try again, catches all of those.
		renderGate();
		await waitFor(() => expect(title()).toBeInTheDocument());
		const footer = screen.getByTestId("function-tags-gate-footer");
		const footerButtons = within(footer).getAllByRole("button");
		expect(footerButtons).toHaveLength(1);
		expect(footerButtons[0]).toHaveAccessibleName(/save|try again/i);
	});

	it("opens from the snapshot alone when the read never succeeds", async () => {
		getMyDefault.mockRejectedValue(new Error("offline"));
		renderGate();
		await waitFor(() => expect(title()).toBeInTheDocument());
		expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
	});

	it("D12: an unknown snapshot does not open the gate", async () => {
		snapshotValue = null;
		getMyDefault.mockRejectedValue(new Error("offline"));
		renderGate();
		await waitFor(() => expect(getMyDefault).toHaveBeenCalled());
		expect(title()).not.toBeInTheDocument();
	});

	it("D12: opens once a later read succeeds and returns no tags", async () => {
		// The other half of D12: the bypass must be SELF-HEALING. Without
		// this, a permanently-closed gate would satisfy the test above.
		snapshotValue = null;
		getMyDefault.mockRejectedValue(new Error("offline"));
		const { client } = renderGate();
		await waitFor(() => expect(getMyDefault).toHaveBeenCalled());
		expect(title()).not.toBeInTheDocument();

		client.setQueryData(QUERY_KEY, { tags: [], enforcementEnabled: true });

		await waitFor(() => expect(title()).toBeInTheDocument());
	});

	it("keeps an in-progress selection across a refetch that returns the same tags", async () => {
		// Raised on the PR: the seeding effect depends on `data?.tags`, and
		// this query refetches (30s kill-switch poll, and on window focus).
		// If a refetch reseeded, it would wipe a selection the user had not
		// saved yet — on a modal they cannot dismiss.
		//
		// It does not, and the reason is React Query's `structuralSharing`
		// (default `true`; this app does not override it — see
		// `modules/shared/lib/query-client.ts`). A refetch whose payload is
		// deeply equal returns the PREVIOUS object, so `data.tags` keeps its
		// identity and the effect never re-runs. Deep equality is also why a
		// change to `enforcementEnabled` alone cannot wipe the selection:
		// the top-level object is new, but the untouched `tags` array keeps
		// its reference.
		//
		// This test exists because that safety is implicit: disable
		// structural sharing globally and it goes red instead of a user
		// silently losing their input.
		//
		// `mockImplementation`, NOT the `beforeEach` `mockResolvedValue`:
		// the latter hands back the SAME object on every call, so the
		// identity this test is about would be preserved by the mock rather
		// than by the code, and the test would pass with structural sharing
		// switched off. A real response is freshly parsed each time.
		getMyDefault.mockImplementation(async () => ({
			tags: [],
			enforcementEnabled: true,
		}));
		const user = userEvent.setup();
		const { client } = renderGate();
		await waitFor(() => expect(title()).toBeInTheDocument());
		await selectTag(user, "Developer");
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Remove Developer" }),
			).toBeInTheDocument(),
		);

		const before = getMyDefault.mock.calls.length;
		await act(async () => {
			await client.refetchQueries({ queryKey: QUERY_KEY });
		});
		expect(getMyDefault.mock.calls.length).toBeGreaterThan(before);
		// Let the observer notify and any resulting effect run before
		// asserting — otherwise this checks the frame BEFORE a reseed would
		// have landed and passes whether or not one happens.
		await flushMacrotasks();

		// The unsaved selection survived, and Save is still actionable.
		expect(
			screen.getByRole("button", { name: "Remove Developer" }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /save/i })).toBeEnabled();
	});

	it("AC2: saves the selection and stays closed through reconciliation", async () => {
		const user = userEvent.setup();
		renderGate();
		await waitFor(() => expect(title()).toBeInTheDocument());
		// Anchored to the statement that actually decides, not just to the
		// modal being open: the picker stays disabled until `data` lands, and
		// a click on a disabled trigger is silently swallowed. This only
		// passed before because the mocked promise resolves in a microtask
		// `waitFor`'s act-wrapper happens to flush — a CI-only flake this
		// repo has already shipped and had to diagnose.
		await waitFor(() =>
			expect(
				screen.getByLabelText("Your default function tags"),
			).toBeEnabled(),
		);
		await selectTag(user, "Developer");

		// The success handler writes the cache and THEN invalidates, and
		// React Query refetches an active invalidated query. Without moving
		// the mock forward, that refetch returns the empty set again and the
		// gate reopens — so this assertion would be racing a transient cache
		// value. Model the server: after the save, reads return what was
		// saved.
		getMyDefault.mockResolvedValue({
			tags: ["DEVELOPER"],
			enforcementEnabled: true,
		});

		const save = screen.getByRole("button", { name: /save/i });
		await waitFor(() => expect(save).toBeEnabled());
		await user.click(save);

		await waitFor(() =>
			expect(setMyDefault).toHaveBeenCalledWith({ tags: ["DEVELOPER"] }),
		);
		await waitFor(() => expect(title()).not.toBeInTheDocument());

		// Survives reconciliation rather than merely flickering shut.
		await waitFor(() =>
			expect(getMyDefault.mock.calls.length).toBeGreaterThan(1),
		);
		expect(title()).not.toBeInTheDocument();
	});

	it("closes after a successful save even if the follow-up refetch fails", async () => {
		const user = userEvent.setup();
		renderGate();
		await waitFor(() => expect(title()).toBeInTheDocument());
		// Anchored to the statement that actually decides, not just to the
		// modal being open: the picker stays disabled until `data` lands, and
		// a click on a disabled trigger is silently swallowed. This only
		// passed before because the mocked promise resolves in a microtask
		// `waitFor`'s act-wrapper happens to flush — a CI-only flake this
		// repo has already shipped and had to diagnose.
		await waitFor(() =>
			expect(
				screen.getByLabelText("Your default function tags"),
			).toBeEnabled(),
		);
		await selectTag(user, "Developer");
		getMyDefault.mockRejectedValue(new Error("offline"));
		await user.click(screen.getByRole("button", { name: /save/i }));
		await waitFor(() => expect(title()).not.toBeInTheDocument());
	});

	it("AC5: shows an inline error and a retry path when the save fails", async () => {
		const user = userEvent.setup();
		setMyDefault.mockRejectedValue(new Error("nope"));
		renderGate();
		await waitFor(() => expect(title()).toBeInTheDocument());
		// Anchored to the statement that actually decides, not just to the
		// modal being open: the picker stays disabled until `data` lands, and
		// a click on a disabled trigger is silently swallowed. This only
		// passed before because the mocked promise resolves in a microtask
		// `waitFor`'s act-wrapper happens to flush — a CI-only flake this
		// repo has already shipped and had to diagnose.
		await waitFor(() =>
			expect(
				screen.getByLabelText("Your default function tags"),
			).toBeEnabled(),
		);
		await selectTag(user, "Developer");
		await user.click(screen.getByRole("button", { name: /save/i }));
		await waitFor(() =>
			expect(screen.getByRole("alert")).toBeInTheDocument(),
		);
		expect(title()).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /try again/i }),
		).toBeInTheDocument();
	});

	it("AC5: a retry after a failure succeeds and closes", async () => {
		const user = userEvent.setup();
		setMyDefault.mockRejectedValueOnce(new Error("nope"));
		renderGate();
		await waitFor(() => expect(title()).toBeInTheDocument());
		// Anchored to the statement that actually decides, not just to the
		// modal being open: the picker stays disabled until `data` lands, and
		// a click on a disabled trigger is silently swallowed. This only
		// passed before because the mocked promise resolves in a microtask
		// `waitFor`'s act-wrapper happens to flush — a CI-only flake this
		// repo has already shipped and had to diagnose.
		await waitFor(() =>
			expect(
				screen.getByLabelText("Your default function tags"),
			).toBeEnabled(),
		);
		await selectTag(user, "Developer");
		await user.click(screen.getByRole("button", { name: /save/i }));
		await waitFor(() =>
			expect(screen.getByRole("alert")).toBeInTheDocument(),
		);

		// Same reason as AC2: the retry's reconciliation must not hand the
		// gate an empty set back.
		getMyDefault.mockResolvedValue({
			tags: ["DEVELOPER"],
			enforcementEnabled: true,
		});

		await user.click(screen.getByRole("button", { name: /try again/i }));
		await waitFor(() => expect(title()).not.toBeInTheDocument());
	});

	it("re-opens when a successful save is followed by a successful empty read", async () => {
		const user = userEvent.setup();
		const { client } = renderGate();
		await waitFor(() => expect(title()).toBeInTheDocument());
		// Anchored to the statement that actually decides, not just to the
		// modal being open: the picker stays disabled until `data` lands, and
		// a click on a disabled trigger is silently swallowed. This only
		// passed before because the mocked promise resolves in a microtask
		// `waitFor`'s act-wrapper happens to flush — a CI-only flake this
		// repo has already shipped and had to diagnose.
		await waitFor(() =>
			expect(
				screen.getByLabelText("Your default function tags"),
			).toBeEnabled(),
		);
		await selectTag(user, "Developer");

		// Reconcile HONESTLY first, so the gate is closed for the right
		// reason. Skipping this makes the test pass on the post-save refetch
		// returning empty — i.e. for the wrong reason entirely, and it would
		// keep passing if the two-rule precedence were replaced by the
		// rejected "mutation always wins" tier.
		getMyDefault.mockResolvedValue({
			tags: ["DEVELOPER"],
			enforcementEnabled: true,
		});
		await user.click(screen.getByRole("button", { name: /save/i }));
		await waitFor(() => expect(title()).not.toBeInTheDocument());
		await waitFor(() =>
			expect(getMyDefault.mock.calls.length).toBeGreaterThan(1),
		);

		// NOW another route clears the account. A live read proving the user
		// is tagless must win over the earlier successful mutation.
		client.setQueryData(QUERY_KEY, { tags: [], enforcementEnabled: true });
		await waitFor(() => expect(title()).toBeInTheDocument());
	});

	it("a successful account save invalidates EVERY getMyProjectStatus query", async () => {
		// The PARTIAL key, not an exact one: the user may have several projects
		// cached and all of their `defaultTags` just went stale. `key()` matches by
		// prefix; `queryKey({ input })` matches one project and silently misses the
		// rest — which is the mutation this test exists to catch.
		const user = userEvent.setup();
		const { client } = renderGate();
		const spy = vi.spyOn(client, "invalidateQueries");

		await waitFor(() => expect(title()).toBeInTheDocument());
		await selectTag(user, "Developer");
		await user.click(screen.getByRole("button", { name: /save/i }));
		await waitFor(() => expect(setMyDefault).toHaveBeenCalled());

		const invalidated = spy.mock.calls
			.map((c) => c[0]?.queryKey)
			.filter((k): k is unknown[] => Array.isArray(k));

		const statusKey = invalidated.find((k) =>
			JSON.stringify(k).includes("getMyProjectStatus"),
		);
		expect(statusKey).toBeDefined();
		// `[path, {}]` — two elements, second empty. The exact form is
		// `[path, { input, type: "query" }]`, which would scope the invalidation to
		// ONE project.
		expect(statusKey).toHaveLength(2);
		expect(statusKey?.[1]).toEqual({});
	});
});
