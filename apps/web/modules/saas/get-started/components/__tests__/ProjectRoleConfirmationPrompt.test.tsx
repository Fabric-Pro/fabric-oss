/**
 * Per-project role confirmation prompt (Fizzy #2264, AC6-AC10).
 *
 * Model: `FunctionTagsRequiredGate.test.tsx` — same module mocks, same
 * `QueryClientProvider` wrapper, same `selectTag` helper. This prompt is
 * DISMISSIBLE (D2) and per-project (not per-account), which is what most of
 * these tests exist to pin.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getMyDefault = vi.fn();
const getMyProjectStatus = vi.fn();
const confirmForProject = vi.fn();
let flagValue = true;
let snapshotValue: boolean | null = false;
// Mutable so a test can simulate an identity change without unmounting.
let mockUserId: string | undefined = "user-1";

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
				// Simplified shape (flat 3-tuple), unlike the faithful
				// `[path, { input, type }]` form `FunctionTagsRequiredGate.test.tsx`
				// uses — nothing in this file narrows or cross-checks the key, so
				// the simplification costs nothing here.
				queryOptions: ({ input }: { input: unknown }) => ({
					queryKey: ["ft", "getMyProjectStatus", input],
					queryFn: () => getMyProjectStatus(input),
				}),
				queryKey: ({ input }: { input: unknown }) => [
					"ft",
					"getMyProjectStatus",
					input,
				],
			},
		},
	},
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		functionTags: {
			confirmForProject: (i: unknown) => confirmForProject(i),
		},
	},
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => flagValue,
}));
vi.mock("@saas/shared/components/RoleTagSnapshotProvider", () => ({
	useRoleTagSnapshot: () => snapshotValue,
}));
// `useSession` throws outside `SessionProvider`, and this component (unlike
// `FunctionTagsRequiredGate`) reads it — mock to a REAL user id. Note
// `mockImplementation`, not a bare arrow returning a shared literal: any
// test about identity or re-seeding needs a FRESH object per call, not the
// same one handed back every time.
vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		user: mockUserId ? { id: mockUserId, name: "Test User" } : undefined,
		session: mockUserId ? { id: "test-session" } : null,
		loaded: true,
		reloadSession: vi.fn(),
	}),
}));

import { ProjectRoleConfirmationPrompt } from "../ProjectRoleConfirmationPrompt";

function renderPrompt(props: {
	projectId: string;
	organizationId?: string | null;
}) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const view = render(
		<QueryClientProvider client={client}>
			<ProjectRoleConfirmationPrompt
				projectId={props.projectId}
				organizationId={props.organizationId ?? null}
			/>
		</QueryClientProvider>,
	);
	// `view.rerender` (RTL's own) takes a ReactElement; the helper below
	// takes a props object and re-renders the SAME tree under the SAME
	// client, which is what lets a projectId change be observed without
	// unmounting. `...view` comes FIRST so this override wins — spreading it
	// last would silently restore RTL's `rerender` and break every caller
	// that passes a props object instead of an element.
	return {
		...view,
		client,
		rerender: (next: {
			projectId: string;
			organizationId?: string | null;
		}) =>
			view.rerender(
				<QueryClientProvider client={client}>
					<ProjectRoleConfirmationPrompt
						projectId={next.projectId}
						organizationId={next.organizationId ?? null}
					/>
				</QueryClientProvider>,
			),
	};
}

const title = () => screen.queryByText("Confirm your role on this project");

const DEFAULT_TAGS_KEY = ["ft", "getMyDefault"];
const statusKeyFor = (
	projectId: string,
	organizationId: string | null = null,
) => ["ft", "getMyProjectStatus", { projectId, organizationId }];

/**
 * Wait until the query at `queryKey` has actually SETTLED (not merely been
 * CALLED). `getMyDefault` / `getMyProjectStatus` resolve on a microtask, so
 * asserting a negative (`title()` absent) right after `toHaveBeenCalled()`
 * races that resolution — the assertion passes whether or not the real
 * behaviour is correct, because it can run before the data (and the effect
 * it drives) has had any chance to land. Polling the query cache's own
 * `status` is the deterministic version of the same wait.
 */
async function waitForQuery(
	client: QueryClient,
	queryKey: unknown[],
	status: "success" | "error" = "success",
) {
	await waitFor(() => {
		const query = client.getQueryCache().find({ queryKey });
		expect(query?.state.status).toBe(status);
	});
}

// FunctionTagSelect renders a Popover trigger labelled by `aria-label`, and
// each selected tag carries a nested role="button" named `Remove <Label>`.
// Selecting means: open the popover, then click the option's TEXT. Mirrors
// `FunctionTagsRequiredGate.test.tsx`'s helper of the same name.
async function selectTag(
	user: ReturnType<typeof userEvent.setup>,
	label: string,
) {
	await user.click(screen.getByLabelText("Your role on this project"));
	await user.click(await screen.findByText(label));
}

beforeEach(() => {
	vi.clearAllMocks();
	sessionStorage.clear();
	flagValue = true;
	snapshotValue = false;
	mockUserId = "user-1";
	getMyDefault.mockResolvedValue({
		tags: ["DEVELOPER"],
		enforcementEnabled: true,
	});
	getMyProjectStatus.mockResolvedValue({
		confirmed: false,
		tags: [],
		defaultTags: ["DEVELOPER"],
		version: 1,
	});
	confirmForProject.mockResolvedValue({
		success: true,
		tags: ["DEVELOPER"],
		version: 2,
	});
});

describe("ProjectRoleConfirmationPrompt", () => {
	describe("opening", () => {
		it("opens for an unconfirmed member when enforcement is live", async () => {
			renderPrompt({ projectId: "project-a" });
			await waitFor(() => expect(title()).toBeInTheDocument());
		});

		it("does NOT open when the payload flag is off", async () => {
			flagValue = false;
			renderPrompt({ projectId: "project-a" });
			await waitFor(() =>
				expect(getMyDefault).not.toHaveBeenCalled(),
			).catch(() => {
				// getMyDefault may still be skipped via `enabled`; the real
				// assertion is the title.
			});
			expect(title()).not.toBeInTheDocument();
		});

		it("does NOT open when the poll says enforcementEnabled is false", async () => {
			getMyDefault.mockResolvedValue({
				tags: ["DEVELOPER"],
				enforcementEnabled: false,
			});
			const { client } = renderPrompt({ projectId: "project-a" });
			await waitForQuery(client, DEFAULT_TAGS_KEY);
			expect(title()).not.toBeInTheDocument();
		});

		it("does NOT open when `confirmed` is true", async () => {
			getMyProjectStatus.mockResolvedValue({
				confirmed: true,
				tags: ["DEVELOPER"],
				defaultTags: ["DEVELOPER"],
				version: 3,
			});
			const { client } = renderPrompt({ projectId: "project-a" });
			await waitForQuery(client, statusKeyFor("project-a"));
			expect(title()).not.toBeInTheDocument();
		});

		it("does NOT open while the read has NEVER succeeded (data === undefined)", async () => {
			getMyProjectStatus.mockRejectedValue(new Error("offline"));
			const { client } = renderPrompt({ projectId: "project-a" });
			await waitForQuery(client, statusKeyFor("project-a"), "error");
			expect(title()).not.toBeInTheDocument();
		});

		it('STAYS open when a later refetch fails after a successful read (status "error" with data retained)', async () => {
			const { client } = renderPrompt({ projectId: "project-a" });
			await waitFor(() => expect(title()).toBeInTheDocument());

			getMyProjectStatus.mockRejectedValue(new Error("offline"));
			await act(async () => {
				await client
					.refetchQueries({
						queryKey: [
							"ft",
							"getMyProjectStatus",
							{ projectId: "project-a", organizationId: null },
						],
					})
					.catch(() => {
						// Expected to fail — that is the point of the test.
					});
			});

			expect(title()).toBeInTheDocument();
		});

		it("closes an already-open prompt once a refetch reports enforcement withdrawn", async () => {
			// Mirrors `FunctionTagsRequiredGate.test.tsx`'s own kill-switch
			// test: write directly to the cache, standing in for whatever
			// refetch happens to land (a window-focus refetch, or the
			// member navigating away and back) — see the guard's own
			// comment for why nothing is actively polling `myTags` while
			// this prompt is open.
			const { client } = renderPrompt({ projectId: "project-a" });
			await waitFor(() => expect(title()).toBeInTheDocument());

			client.setQueryData(DEFAULT_TAGS_KEY, {
				tags: ["DEVELOPER"],
				enforcementEnabled: false,
			});

			await waitFor(() => expect(title()).not.toBeInTheDocument());
		});

		it("does NOT open while the ACCOUNT gate is up (tagless user, shouldEnforce true)", async () => {
			getMyDefault.mockResolvedValue({
				tags: [],
				enforcementEnabled: true,
			});
			const { client } = renderPrompt({ projectId: "project-a" });
			// Wait for BOTH queries to settle: `accountGateUp` reads `myTags`,
			// and `eligible` also reads `status`, so a version of the code
			// that dropped `!accountGateUp` would still open once `status`
			// alone has landed — the account-tags query settling too is what
			// makes this control meaningful.
			await waitForQuery(client, DEFAULT_TAGS_KEY);
			await waitForQuery(client, statusKeyFor("project-a"));
			expect(title()).not.toBeInTheDocument();
		});

		it("closes if the account gate comes up AFTER opening (D12 ordering: status resolves before myTags)", async () => {
			// D12: an unknown (null) snapshot does NOT open the account gate
			// by itself — `shouldEnforce(true, null, undefined)` is false.
			// If `getMyProjectStatus` resolves before `getMyDefault`, this
			// prompt can open on `accountGateUp === false`, and only
			// afterwards does `myTags` land empty and flip the account gate
			// up. `eligible` only gates the OPEN transition, so the render
			// guard must reconsider `accountGateUp` independently — this is
			// what "Never fires while the account gate is up" (top of the
			// file) actually requires once both surfaces can be live at
			// once.
			snapshotValue = null;
			let resolveDefault!: (v: {
				tags: string[];
				enforcementEnabled: boolean;
			}) => void;
			getMyDefault.mockReturnValue(
				new Promise((resolve) => {
					resolveDefault = resolve;
				}),
			);
			getMyProjectStatus.mockResolvedValue({
				confirmed: false,
				tags: [],
				defaultTags: ["DEVELOPER"],
				version: 1,
			});

			renderPrompt({ projectId: "project-a" });
			// The project-status read lands and opens the prompt before the
			// account-tags read has resolved at all.
			await waitFor(() => expect(title()).toBeInTheDocument());

			// NOW the account-tags read lands, empty — the account gate
			// comes up.
			await act(async () => {
				resolveDefault({ tags: [], enforcementEnabled: true });
			});

			await waitFor(() => expect(title()).not.toBeInTheDocument());
		});

		it("does NOT re-open in the same tab session after a dismissal", async () => {
			const user = userEvent.setup();
			renderPrompt({ projectId: "project-a" });
			await waitFor(() => expect(title()).toBeInTheDocument());
			await user.click(screen.getByRole("button", { name: "Not now" }));
			await waitFor(() => expect(title()).not.toBeInTheDocument());

			// `toHaveBeenCalled()` fires the instant the SECOND instance
			// mounts — synchronous, before its query resolves — so waiting
			// on it and then asserting the negative would pass even with
			// `markShown()` deleted entirely: `eligible` is still `false`
			// (status undefined) at that instant regardless of session
			// suppression. Wait for the second instance's OWN query to
			// actually settle instead.
			const { client: second } = renderPrompt({ projectId: "project-a" });
			await waitForQuery(second, statusKeyFor("project-a"));
			expect(title()).not.toBeInTheDocument();
		});

		it("a dismissal on project A does not suppress the prompt on project B", async () => {
			// The session key is `${userId}:${projectId}`. Keyed on userId alone, a
			// member of twelve projects would see this once and never again — the
			// prompt would look like it worked while silently covering one project.
			const user = userEvent.setup();

			// RERENDER with a new projectId — do NOT unmount. `renderPrompt`'s
			// `rerender` deliberately omits any `key`, so this reconciles the
			// SAME component instance across the A -> B switch (the opposite of
			// the real `ProjectDetails` mount, which DOES carry `key={projectId}`
			// — see line ~861 below); an `unmount()` here would discard exactly
			// the state that can strand the prompt closed, and the test would
			// pass against the broken code either way.
			//
			// What actually holds this open: `openedForKeyRef` is keyed by
			// `sessionKey` (`${userId}:${projectId}`), not a bare boolean, so a
			// same-instance switch to a NEW project still re-arms it. That is a
			// property of THIS component, independent of whether the parent
			// remounts it — `key={projectId}` on the real mount is a separate,
			// additional guard (for state that does NOT self-heal on a prop
			// change, e.g. `conflicted`; see "a KEYED remount ..." below), not
			// what this test exercises.
			const { rerender } = renderPrompt({ projectId: "project-a" });
			await waitFor(() => expect(title()).toBeInTheDocument());
			await user.click(screen.getByRole("button", { name: "Not now" }));
			await waitFor(() => expect(title()).not.toBeInTheDocument());

			rerender({ projectId: "project-b" });
			// Same user, same tab session, different project — it must open again.
			await waitFor(() => expect(title()).toBeInTheDocument());
		});

		it("a dismissal on project A survives a round trip through project B", async () => {
			// A -> B -> A, no unmount (same reasoning as the A -> B test
			// above). B is already CONFIRMED, so it never opens anything of
			// its own — an ineligible project in between must not erase the
			// fact that A was already handled this session. A version that
			// keys the "already opened" guard on a bare boolean (reset
			// whenever `sessionKey` merely CHANGES, rather than tracking
			// which key was actually decided) reopens here: the commit where
			// `sessionKey` flips back to A still reads a stale,
			// not-yet-re-seeded session-flag value from B.
			const user = userEvent.setup();
			getMyProjectStatus.mockImplementation(
				async (input: { projectId: string }) =>
					input.projectId === "project-b"
						? {
								confirmed: true,
								tags: ["DEVELOPER"],
								defaultTags: ["DEVELOPER"],
								version: 1,
							}
						: {
								confirmed: false,
								tags: [],
								defaultTags: ["DEVELOPER"],
								version: 1,
							},
			);

			const { client, rerender } = renderPrompt({
				projectId: "project-a",
			});
			await waitFor(() => expect(title()).toBeInTheDocument());
			await user.click(screen.getByRole("button", { name: "Not now" }));
			await waitFor(() => expect(title()).not.toBeInTheDocument());

			rerender({ projectId: "project-b" });
			await waitForQuery(client, statusKeyFor("project-b"));
			expect(title()).not.toBeInTheDocument();

			rerender({ projectId: "project-a" });
			// Give any (incorrect) reopening logic every chance to run
			// before asserting the negative — the buggy version fires
			// synchronously in the same commit, but this also lets any
			// deferred re-seed settle.
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			expect(title()).not.toBeInTheDocument();
		});

		it("a KEYED remount — the real ProjectDetails mount — clears a stale conflict banner on a project switch", async () => {
			// The `rerender` tests above use `renderPrompt`'s helper, which
			// deliberately never applies a `key` to the child element — they
			// prove `sessionKey`-based re-opening (an internal, self-healing
			// mechanism) works even when the SAME instance survives a project
			// switch. That means neither of them still exercises what
			// `key={projectId}` on the `ProjectDetails` mount actually
			// guards: `conflicted` is a bare `useState(false)` with no
			// re-seed effect of its own — unlike `value` (re-seeded from
			// `status`) and `openedForKeyRef` (keyed by `sessionKey`) — so
			// nothing but an actual unmount clears it. That unmount is
			// exactly what the real mount's `key={projectId}` produces — this
			// reproduces it directly, rather than rendering through
			// `ProjectDetails` itself.
			const user = userEvent.setup();
			getMyProjectStatus.mockImplementation(
				async (input: { projectId: string }) =>
					input.projectId === "project-b"
						? {
								confirmed: false,
								tags: [],
								defaultTags: ["DEVELOPER"],
								version: 1,
							}
						: {
								confirmed: false,
								tags: ["DEVELOPER"],
								defaultTags: ["DEVELOPER"],
								version: 1,
							},
			);
			confirmForProject.mockRejectedValue(new ORPCError("CONFLICT"));

			const client = new QueryClient({
				defaultOptions: {
					queries: { retry: false },
					mutations: { retry: false },
				},
			});
			const tree = (projectId: string) => (
				<QueryClientProvider client={client}>
					<ProjectRoleConfirmationPrompt
						key={projectId}
						projectId={projectId}
						organizationId={null}
					/>
				</QueryClientProvider>
			);

			const { rerender } = render(tree("project-a"));
			await waitFor(() => expect(title()).toBeInTheDocument());
			await user.click(screen.getByRole("button", { name: "Confirm" }));
			await waitFor(() =>
				expect(screen.getByRole("alert")).toHaveTextContent(
					/changed while/i,
				),
			);

			rerender(tree("project-b"));
			await waitForQuery(client, statusKeyFor("project-b"));
			await waitFor(() => expect(title()).toBeInTheDocument());
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		});
	});

	describe("pre-fill (AC7 / D5)", () => {
		it("project tags win when non-empty", async () => {
			getMyProjectStatus.mockResolvedValue({
				confirmed: false,
				tags: ["ARCHITECT"],
				defaultTags: ["DEVELOPER"],
				version: 1,
			});
			renderPrompt({ projectId: "project-a" });
			await waitFor(() => expect(title()).toBeInTheDocument());
			await waitFor(() =>
				expect(
					screen.getByRole("button", { name: "Remove Architect" }),
				).toBeInTheDocument(),
			);
			expect(
				screen.queryByRole("button", { name: "Remove Developer" }),
			).not.toBeInTheDocument();
		});

		it("falls back to the account default when project tags are empty", async () => {
			getMyProjectStatus.mockResolvedValue({
				confirmed: false,
				tags: [],
				defaultTags: ["DEVELOPER"],
				version: 1,
			});
			renderPrompt({ projectId: "project-a" });
			await waitFor(() => expect(title()).toBeInTheDocument());
			await waitFor(() =>
				expect(
					screen.getByRole("button", { name: "Remove Developer" }),
				).toBeInTheDocument(),
			);
		});

		it("the disclosure line renders ONLY when the two diverge", async () => {
			getMyProjectStatus.mockResolvedValue({
				confirmed: false,
				tags: ["DEVELOPER"],
				defaultTags: ["DEVELOPER"],
				version: 1,
			});
			renderPrompt({ projectId: "project-a" });
			await waitFor(() => expect(title()).toBeInTheDocument());
			await waitFor(() =>
				expect(
					screen.getByRole("button", { name: "Remove Developer" }),
				).toBeInTheDocument(),
			);
			expect(
				screen.queryByText(/An administrator set your role/i),
			).not.toBeInTheDocument();
		});

		it("the disclosure names both sets using FUNCTION_TAG_LABELS, not raw enums", async () => {
			getMyProjectStatus.mockResolvedValue({
				confirmed: false,
				tags: ["ARCHITECT"],
				defaultTags: ["DEVELOPER"],
				version: 1,
			});
			renderPrompt({ projectId: "project-a" });
			await waitFor(() => expect(title()).toBeInTheDocument());
			// Scoped to the disclosure paragraph itself: the selected tag's
			// own badge ALSO renders "Architect" as text (in "Remove
			// Architect"), so an unscoped `getByText` is ambiguous.
			const disclosure = await screen.findByText(
				/An administrator set your role/i,
			);
			expect(disclosure).toHaveTextContent(/Architect/);
			expect(disclosure).toHaveTextContent(/Developer/);
			expect(disclosure).not.toHaveTextContent(/ARCHITECT\b/);
			expect(disclosure).not.toHaveTextContent(/DEVELOPER\b/);
		});
	});

	describe("confirming", () => {
		it("Confirm is disabled while the selection is empty (the §5.8 floor)", async () => {
			getMyProjectStatus.mockResolvedValue({
				confirmed: false,
				tags: [],
				defaultTags: [],
				version: 1,
			});
			renderPrompt({ projectId: "project-a" });
			await waitFor(() => expect(title()).toBeInTheDocument());
			expect(
				screen.getByRole("button", { name: "Confirm" }),
			).toBeDisabled();
		});

		it("Confirm sends the tags AND the CURRENT expectedVersion (not necessarily the one it opened with)", async () => {
			// Starts with an empty selection so this exercises the real
			// picker interaction (via `selectTag`) rather than confirming a
			// value the pre-fill already supplied.
			const user = userEvent.setup();
			getMyProjectStatus.mockResolvedValue({
				confirmed: false,
				tags: [],
				defaultTags: [],
				version: 7,
			});
			renderPrompt({ projectId: "project-a" });
			await waitFor(() => expect(title()).toBeInTheDocument());
			await selectTag(user, "Developer");
			await waitFor(() =>
				expect(
					screen.getByRole("button", { name: "Remove Developer" }),
				).toBeInTheDocument(),
			);
			await user.click(screen.getByRole("button", { name: "Confirm" }));
			await waitFor(() =>
				expect(confirmForProject).toHaveBeenCalledWith({
					projectId: "project-a",
					organizationId: null,
					tags: ["DEVELOPER"],
					expectedVersion: 7,
				}),
			);
		});

		it("carries a non-null organizationId through both the status query and the confirm payload", async () => {
			// Every other test uses the `?? null` default, leaving both the
			// query key and the mutation payload unpinned for org context —
			// and `confirm-for-project.ts` BAD_REQUESTs on a mismatch with
			// the project's own `organizationId`.
			const user = userEvent.setup();
			getMyProjectStatus.mockResolvedValue({
				confirmed: false,
				tags: ["DEVELOPER"],
				defaultTags: ["DEVELOPER"],
				version: 4,
			});
			renderPrompt({ projectId: "project-a", organizationId: "org-1" });
			await waitFor(() =>
				expect(getMyProjectStatus).toHaveBeenCalledWith({
					projectId: "project-a",
					organizationId: "org-1",
				}),
			);
			await waitFor(() => expect(title()).toBeInTheDocument());
			await waitFor(() =>
				expect(
					screen.getByRole("button", { name: "Remove Developer" }),
				).toBeInTheDocument(),
			);
			await user.click(screen.getByRole("button", { name: "Confirm" }));
			await waitFor(() =>
				expect(confirmForProject).toHaveBeenCalledWith({
					projectId: "project-a",
					organizationId: "org-1",
					tags: ["DEVELOPER"],
					expectedVersion: 4,
				}),
			);
		});

		it("success closes the prompt and does not re-open on remount", async () => {
			// The default mock (`tags: []`, `defaultTags: ["DEVELOPER"]`)
			// already pre-fills a non-empty selection, so Confirm is
			// actionable without an explicit `selectTag` — waiting on the
			// pre-filled badge anchors this to the statement that actually
			// enables the button rather than to the dialog merely being open.
			const user = userEvent.setup();
			renderPrompt({ projectId: "project-a" });
			await waitFor(() => expect(title()).toBeInTheDocument());
			await waitFor(() =>
				expect(
					screen.getByRole("button", { name: "Remove Developer" }),
				).toBeInTheDocument(),
			);
			await user.click(screen.getByRole("button", { name: "Confirm" }));
			await waitFor(() => expect(title()).not.toBeInTheDocument());

			// Same weakness as "does NOT re-open ... after a dismissal":
			// `toHaveBeenCalled()` resolves synchronously on mount, before
			// the second instance's query has settled, so this must wait
			// for the query itself rather than the call.
			const { client: second } = renderPrompt({ projectId: "project-a" });
			await waitForQuery(second, statusKeyFor("project-a"));
			expect(title()).not.toBeInTheDocument();
		});

		it("success closes it EVEN IF the follow-up status refetch then FAILS", async () => {
			// This app sets retry:false, so the retained response still says
			// confirmed:false — the negative control is the invalidate-only
			// formulation, which leaves the member staring at a prompt for a
			// confirmation that already succeeded, free to fire a second
			// audit row.
			const user = userEvent.setup();
			renderPrompt({ projectId: "project-a" });
			await waitFor(() => expect(title()).toBeInTheDocument());
			await waitFor(() =>
				expect(
					screen.getByRole("button", { name: "Remove Developer" }),
				).toBeInTheDocument(),
			);
			getMyProjectStatus.mockRejectedValue(new Error("offline"));
			await user.click(screen.getByRole("button", { name: "Confirm" }));
			await waitFor(() => expect(title()).not.toBeInTheDocument());
		});

		it("the prompt STAYS OPEN across the render in which it marks itself shown", async () => {
			// Eligibility, session suppression and visibility are three
			// different things, and collapsing them closes the dialog on the
			// very next render.
			renderPrompt({ projectId: "project-a" });
			await waitFor(() => expect(title()).toBeInTheDocument());
			// Let a few renders elapse (effects, state settles).
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			expect(title()).toBeInTheDocument();
		});

		it("a CONFLICT keeps the prompt open and re-renders over the NEW tags", async () => {
			// The whole point of the version token: an admin changed this member's
			// tags while the prompt sat open. Reporting success here would write the
			// stale selection back and revert the admin with no trace but the audit
			// log.
			const user = userEvent.setup();

			getMyProjectStatus
				.mockResolvedValueOnce({
					confirmed: false,
					tags: ["DEVELOPER"],
					defaultTags: ["DEVELOPER"],
					version: 1,
				})
				// The refetch the CONFLICT branch triggers: the administrator's new
				// assignment, at a new version.
				.mockResolvedValue({
					confirmed: false,
					tags: ["ARCHITECT"],
					defaultTags: ["DEVELOPER"],
					version: 2,
				});
			// A distinctive message, deliberately DIFFERENT from the
			// dialog's own "changed while..." copy — an empty message (as
			// `new ORPCError("CONFLICT")` carries) would let the "never
			// render a raw server error string" contract pass by luck,
			// since there would be nothing distinguishing to leak.
			confirmForProject.mockRejectedValue(
				new ORPCError("CONFLICT", {
					message: "diagnostic-detail-should-never-reach-the-dialog",
				}),
			);

			renderPrompt({ projectId: "project-a" });
			await waitFor(() => expect(title()).toBeInTheDocument());
			await user.click(screen.getByRole("button", { name: "Confirm" }));

			// Still open, told why (in OUR copy, not the server's), and now
			// showing what the administrator set.
			await waitFor(() =>
				expect(screen.getByRole("alert")).toHaveTextContent(
					/changed while/i,
				),
			);
			expect(
				screen.queryByText(
					/diagnostic-detail-should-never-reach-the-dialog/i,
				),
			).not.toBeInTheDocument();
			expect(title()).toBeInTheDocument();
			await waitFor(() =>
				expect(
					screen.getByRole("button", { name: "Remove Architect" }),
				).toBeInTheDocument(),
			);
			// …and the disclosure line, because ARCHITECT now diverges from the
			// DEVELOPER account default.
			expect(
				screen.getByText(/An administrator set your role/i),
			).toBeInTheDocument();
		});

		it("a CONFLICT followed by a different failure clears the conflict banner and shows the generic alert", async () => {
			// Without clearing `conflicted` on a non-CONFLICT error, a
			// retry that fails for an unrelated reason (a network blip, an
			// unhandled 500) would leave the STALE "changed while this was
			// open" copy on screen while the generic-alert branch
			// (`confirm.isError && !conflicted`) stays suppressed — the
			// member gets no feedback for the second failure at all.
			const user = userEvent.setup();
			getMyProjectStatus.mockResolvedValue({
				confirmed: false,
				tags: ["DEVELOPER"],
				defaultTags: ["DEVELOPER"],
				version: 1,
			});
			confirmForProject
				.mockRejectedValueOnce(new ORPCError("CONFLICT"))
				.mockRejectedValueOnce(new Error("network blip"));

			renderPrompt({ projectId: "project-a" });
			await waitFor(() => expect(title()).toBeInTheDocument());
			await waitFor(() =>
				expect(
					screen.getByRole("button", { name: "Remove Developer" }),
				).toBeInTheDocument(),
			);
			await user.click(screen.getByRole("button", { name: "Confirm" }));
			await waitFor(() =>
				expect(screen.getByRole("alert")).toHaveTextContent(
					/changed while/i,
				),
			);

			// Retry — the version conflict is resolved (status re-fetched
			// unchanged), so this attempt fails for a different reason.
			await user.click(screen.getByRole("button", { name: "Confirm" }));
			await waitFor(() =>
				expect(screen.getByRole("alert")).toHaveTextContent(
					/couldn't confirm your role/i,
				),
			);
			expect(
				screen.queryByText(/changed while/i),
			).not.toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: /try again/i }),
			).toBeInTheDocument();
		});

		it('a non-CONFLICT failure shows an inline role="alert" and a retry affordance', async () => {
			const user = userEvent.setup();
			getMyProjectStatus.mockResolvedValue({
				confirmed: false,
				tags: ["DEVELOPER"],
				defaultTags: ["DEVELOPER"],
				version: 1,
			});
			confirmForProject.mockRejectedValue(new Error("nope"));
			renderPrompt({ projectId: "project-a" });
			await waitFor(() => expect(title()).toBeInTheDocument());
			await waitFor(() =>
				expect(
					screen.getByRole("button", { name: "Remove Developer" }),
				).toBeInTheDocument(),
			);
			await user.click(screen.getByRole("button", { name: "Confirm" }));
			await waitFor(() =>
				expect(screen.getByRole("alert")).toBeInTheDocument(),
			);
			expect(title()).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: /try again/i }),
			).toBeInTheDocument();
		});
	});

	describe("dismissing (D2)", () => {
		it("X, Esc and Cancel all close it", async () => {
			// Unlike the account gate, this `Dialog` is NOT passed
			// `hideCloseButton` — `DialogContent` renders its default close
			// (X) button (accessible name "Close",
			// `modules/ui/components/dialog.tsx`), and it dismisses via the
			// same `onOpenChange` path as Escape and "Not now" (Cancel).
			const user = userEvent.setup();
			renderPrompt({ projectId: "project-a" });
			await waitFor(() => expect(title()).toBeInTheDocument());
			await user.keyboard("{Escape}");
			await waitFor(() => expect(title()).not.toBeInTheDocument());

			renderPrompt({ projectId: "project-b" });
			await waitFor(() => expect(title()).toBeInTheDocument());
			await user.click(screen.getByRole("button", { name: "Not now" }));
			await waitFor(() => expect(title()).not.toBeInTheDocument());

			renderPrompt({ projectId: "project-c" });
			await waitFor(() => expect(title()).toBeInTheDocument());
			await user.click(screen.getByRole("button", { name: "Close" }));
			await waitFor(() => expect(title()).not.toBeInTheDocument());
		});

		it("nothing is persisted on dismiss (no mutation call)", async () => {
			const user = userEvent.setup();
			renderPrompt({ projectId: "project-a" });
			await waitFor(() => expect(title()).toBeInTheDocument());
			await user.click(screen.getByRole("button", { name: "Not now" }));
			await waitFor(() => expect(title()).not.toBeInTheDocument());
			expect(confirmForProject).not.toHaveBeenCalled();
		});

		it("it re-fires on a fresh mount in a NEW session", async () => {
			const user = userEvent.setup();
			renderPrompt({ projectId: "project-a" });
			await waitFor(() => expect(title()).toBeInTheDocument());
			await user.click(screen.getByRole("button", { name: "Not now" }));
			await waitFor(() => expect(title()).not.toBeInTheDocument());

			// A NEW session: sessionStorage cleared, simulating a new tab.
			sessionStorage.clear();
			renderPrompt({ projectId: "project-a" });
			await waitFor(() => expect(title()).toBeInTheDocument());
		});
	});

	it("is mounted by ProjectDetails", () => {
		// The component decides entirely for itself whether to open, so its mount
		// is a single structural line with no behaviour of its own to assert. What
		// can still go wrong is somebody deleting that line — this catches exactly
		// that. Same technique the get-started drift test uses on this same file.
		// Resolve from THIS file, not by copying drift.test.ts's literal — that
		// file sits at a different depth and its "../../../../../.." would land in
		// the wrong place here. Derive it and assert the file was actually read.
		const source = readFileSync(
			path.resolve(
				__dirname,
				"../../../../../modules/saas/projects/components/ProjectDetails.tsx",
			),
			"utf8",
		);
		expect(source).toContain("ProjectRoleConfirmationPrompt } from");
		expect(source).toContain("<ProjectRoleConfirmationPrompt");
		// Keyed, so per-project state resets on an in-place project switch.
		expect(source).toMatch(
			/<ProjectRoleConfirmationPrompt[\s\S]{0,80}key=\{projectId\}/,
		);
		// POSITION, not mere presence. The mount comment claims it sits below the
		// `!project` and `deletedAt` guards so it can never fire on a not-found or
		// soft-deleted view — and a bare `toContain` is green with the mount moved
		// above them, commented out, or wrapped in `{false && …}`. Anchor it to
		// text that only exists inside the not-found / soft-deleted branches.
		//
		// `lastIndexOf`, not `indexOf`: "Back to Projects" appears THREE times
		// in `ProjectDetails.tsx` — the `!project` branch, the soft-deleted
		// non-owner branch, and the soft-deleted owner branch (the LAST one).
		// `indexOf` anchors on the FIRST occurrence, so it only proves the
		// mount is below the not-found branch — a mount placed inside either
		// soft-deleted branch would still pass. `lastIndexOf` anchors below
		// all three, matching what the comment above actually claims.
		expect(
			source.indexOf("<ProjectRoleConfirmationPrompt"),
		).toBeGreaterThan(source.lastIndexOf("Back to Projects"));
	});
});
