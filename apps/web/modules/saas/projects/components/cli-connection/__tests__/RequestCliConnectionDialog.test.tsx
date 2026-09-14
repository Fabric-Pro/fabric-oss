/**
 * Tests for `RequestCliConnectionDialog` — the CLI-connection prompt's second
 * offer: pass the job to the teammates who would actually do it (Fizzy #2457).
 *
 * What is pinned here, and why each one is load-bearing:
 *
 *   1. Recipients are PROJECT members, and the viewer is not one of them. A
 *      function tag is held per project in this data model; the handler expands
 *      tags strictly inside the roster and refuses the whole call on an id that
 *      is off it, so a picker offering anybody else composes a request that
 *      cannot succeed.
 *   2. A tag ask is confirmed before it is sent, whatever it resolves to. The
 *      client cannot count a tag's holders honestly before sending — see
 *      `askNeedsConfirmation` — so the confirmation is raised on the shape of
 *      the ask, and the real number is reported afterwards.
 *   3. A hand-picked fan-out above ten is confirmed too, on the count the
 *      picker CAN see. Ten is this repository's existing threshold for group
 *      mentions (`@saas/projects/lib/group-mention-confirm`).
 *   4. The result says what happened rather than what was attempted. The
 *      handler separates `notifiedCount`, `recipientCount`, `ineligibleCount`
 *      and `failedCount` precisely so this surface cannot overstate delivery:
 *      somebody already holding an unread ask is de-duplicated server-side and
 *      must not be counted as asked again, and neither must somebody whose
 *      write simply failed.
 *   5. The whole flow is operable from the keyboard, confirmation included, and
 *      focus follows the step change rather than being dropped on the body.
 *   6. A hand-picked selection cannot be composed past the server's recipient
 *      cap, and an over-cap ask that reaches the server anyway (a large
 *      function tag) is reported as the distinct, actionable refusal it is —
 *      never the generic "try again" copy, which would be false for it.
 *   7. The roster is de-duplicated by `userId` before it is offered: a creator
 *      who also holds an accepted self-invite must render as one checkbox,
 *      not two sharing a React key.
 *
 * The roster read and the ask are both driven through a mocked `orpc`, because
 * what is under test is the composition and the reporting, not the transport.
 * `@tanstack/react-query` itself is real: the ask runs mutate -> report ->
 * close, and a stubbed `useMutation` would let a broken call signature pass.
 */

import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listMembersMock, requestCliConnectionMock, toastMock } = vi.hoisted(
	() => ({
		listMembersMock: vi.fn(),
		requestCliConnectionMock: vi.fn(),
		toastMock: {
			success: vi.fn(),
			info: vi.fn(),
			error: vi.fn(),
		},
	}),
);

const VIEWER_ID = "user-viewer";

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		user: {
			id: VIEWER_ID,
			name: "Robin Viewer",
			email: "robin@example.com",
		},
	}),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			members: {
				list: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["projects", "members", "list", input],
						queryFn: () => listMembersMock(input),
					}),
				},
			},
			readiness: {
				requestCliConnection: {
					// The real utility folds the caller's callbacks into the
					// options it builds; echoing that here is what lets the
					// component's own `onSuccess` / `onError` run for real.
					mutationOptions: (options: Record<string, unknown>) => ({
						mutationFn: (input: unknown) =>
							requestCliConnectionMock(input),
						...options,
					}),
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({ toast: toastMock }));

import {
	askNeedsConfirmation,
	MAX_HAND_PICKED_RECIPIENTS,
	summarizeCliConnectionAsk,
} from "../lib/cli-connection-nudge";
import { RequestCliConnectionDialog } from "../RequestCliConnectionDialog";

const PROJECT_ID = "project-under-test";
const ORGANIZATION_ID = "org-hosting-the-project";

/** The copy a reader actually sees. Restated rather than imported: these
 *  sentences are product-approved, and a test that re-imported the constants
 *  would pass just as happily after someone silently reworded them. */
const DIALOG_TITLE = "Ask a teammate to connect a coding tool";
const SEND_LABEL = "Send the ask";
const CONFIRM_TITLE = "Confirm this ask";
const CONFIRM_SEND_LABEL = "Send it";
const CONFIRM_BACK_LABEL = "Back";
const TAGS_LABEL = "Or everyone holding a function tag";

function member(userId: string, name: string) {
	return {
		userId,
		isGuest: false,
		user: {
			id: userId,
			name,
			email: `${userId}@example.com`,
			image: null,
		},
	};
}

/** Two teammates plus the viewer, who must never be offered as a recipient. */
const SMALL_ROSTER = [
	member("user-dana", "Dana Rivers"),
	member("user-sam", "Sam Ellis"),
	member(VIEWER_ID, "Robin Viewer"),
];

/** Twelve teammates: one more than the hand-picked confirmation threshold. */
const LARGE_ROSTER = Array.from({ length: 12 }, (_, index) =>
	member(`user-${index}`, `Teammate ${index}`),
);

/**
 * Two more teammates than the server's hand-picked recipient cap — enough to
 * prove the picker stops at the cap rather than merely warning near it.
 */
const CAP_PLUS_TWO_ROSTER = Array.from(
	{ length: MAX_HAND_PICKED_RECIPIENTS + 2 },
	(_, index) => member(`user-cap-${index}`, `Teammate ${index}`),
);

/**
 * A roster where the creator holds an accepted self-invite, reproducing the
 * gap `getProjectMembers` documents on `joinRosterFunctionTags`: "the creator
 * can appear twice… the `seen` set de-dups." Two rows, same `userId`, same
 * person — exactly what a creator who also accepted an invite to their own
 * project produces.
 */
const CREATOR_ID = "user-creator";
const DUPLICATE_CREATOR_ROSTER = [
	member(CREATOR_ID, "Casey Creator"),
	member(CREATOR_ID, "Casey Creator"),
	member("user-dana", "Dana Rivers"),
	member(VIEWER_ID, "Robin Viewer"),
];

function Harness({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
	const [open, setOpen] = useState(true);
	const [client] = useState(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: { retry: false },
					mutations: { retry: false },
				},
			}),
	);
	return (
		<QueryClientProvider client={client}>
			<RequestCliConnectionDialog
				onOpenChange={(next) => {
					setOpen(next);
					onOpenChange?.(next);
				}}
				open={open}
				organizationId={ORGANIZATION_ID}
				projectId={PROJECT_ID}
			/>
		</QueryClientProvider>
	);
}

async function renderDialog(onOpenChange?: (open: boolean) => void) {
	render(<Harness onOpenChange={onOpenChange} />);
	expect(await screen.findByText(DIALOG_TITLE)).toBeInTheDocument();
}

const askResult = (overrides?: {
	notifiedCount?: number;
	recipientCount?: number;
	ineligibleCount?: number;
	failedCount?: number;
}) => ({
	notifiedCount: overrides?.notifiedCount ?? 1,
	recipientCount: overrides?.recipientCount ?? 1,
	ineligibleCount: overrides?.ineligibleCount ?? 0,
	// The server's fourth count (Fizzy #2457 follow-up): recipients the
	// fan-out tried to write to and could not. Defaulted to zero here so
	// every existing fixture keeps meaning exactly what it said before this
	// count existed; tests below that care about it pass it explicitly.
	failedCount: overrides?.failedCount ?? 0,
});

beforeEach(() => {
	vi.clearAllMocks();
	listMembersMock.mockResolvedValue({ members: SMALL_ROSTER });
	requestCliConnectionMock.mockResolvedValue(askResult());
});

/* -------------------------------------------------------------------------- */
/* The rules                                                                   */
/* -------------------------------------------------------------------------- */

describe("askNeedsConfirmation", () => {
	it("confirms any ask that names a function tag, however small", () => {
		expect(
			askNeedsConfirmation({
				userIds: [],
				functionTags: ["DEVELOPER"],
			}),
		).toBe(true);
	});

	/**
	 * The asymmetry is deliberate. The confirmation exists for fan-out the
	 * sender cannot see, and a list of checkboxes is one they can — so ten
	 * named people pass where a single tag does not.
	 */
	it("lets a hand-picked list through up to ten, and stops at eleven", () => {
		const named = (count: number) =>
			Array.from({ length: count }, (_, index) => `user-${index}`);

		expect(
			askNeedsConfirmation({ userIds: named(10), functionTags: [] }),
		).toBe(false);
		expect(
			askNeedsConfirmation({ userIds: named(11), functionTags: [] }),
		).toBe(true);
	});
});

describe("summarizeCliConnectionAsk", () => {
	it("reports rows written, not people picked", () => {
		expect(
			summarizeCliConnectionAsk(
				askResult({ notifiedCount: 3, recipientCount: 3 }),
			),
		).toEqual({
			tone: "success",
			message: "Asked 3 teammates to connect a coding tool.",
		});
	});

	/**
	 * The case the three de-duplicated/ineligible/failed counts exist for.
	 * Two rows written, five people reached, three more dropped — a single
	 * "asked N" could not tell the sender any of that, and "asked 10" would
	 * be a lie about eight people.
	 */
	it("separates the de-duplicated from the ineligible", () => {
		const summary = summarizeCliConnectionAsk(
			askResult({
				notifiedCount: 2,
				recipientCount: 5,
				ineligibleCount: 3,
			}),
		);

		expect(summary.tone).toBe("success");
		expect(summary.message).toBe(
			"Asked 2 teammates to connect a coding tool. No new notification went to 3 teammates — an unread ask was already waiting, or these notifications are muted. Left out 3 teammates who cannot create an API key.",
		);
	});

	it("does not celebrate an ask that delivered nothing", () => {
		expect(
			summarizeCliConnectionAsk(
				askResult({ notifiedCount: 0, recipientCount: 4 }),
			),
		).toEqual({
			tone: "info",
			message:
				"No new notification went out — an unread ask was already waiting for 4 teammates, or these notifications are muted.",
		});
	});

	/**
	 * The case `failedCount` exists for (Fizzy #2457 follow-up). A write that
	 * THREW is not the same as one that was skipped because an unread ask was
	 * already there — folding it into `recipientCount - notifiedCount` would
	 * tell the sender this person had "already" been asked, when nobody
	 * reached them at all and they are exactly the one the sender should
	 * follow up on.
	 *
	 * This pins the counter-check for Fix 1: against the pre-fix
	 * `summarizeCliConnectionAsk`, which only ever read `notifiedCount`,
	 * `recipientCount` and `ineligibleCount`, this exact sentence did not
	 * exist — the old code would have said the false "already waiting, or
	 * muted" sentence for this person instead.
	 */
	it("never reports a failed write as an already-waiting or muted ask", () => {
		const summary = summarizeCliConnectionAsk(
			askResult({ notifiedCount: 0, recipientCount: 1, failedCount: 1 }),
		);

		expect(summary.tone).toBe("info");
		expect(summary.message).toBe(
			"Nobody was notified. The notification failed to send to 1 teammate — try asking again, or reach out directly.",
		);
		expect(summary.message).not.toMatch(/already waiting/);
		expect(summary.message).not.toMatch(/muted/);
	});

	it("tells the two kinds of quiet recipient apart when both are present", () => {
		const summary = summarizeCliConnectionAsk(
			askResult({ notifiedCount: 2, recipientCount: 5, failedCount: 1 }),
		);

		// recipientCount(5) = notifiedCount(2) + failedCount(1) + quiet(2)
		expect(summary.tone).toBe("success");
		expect(summary.message).toBe(
			"Asked 2 teammates to connect a coding tool. No new notification went to 2 teammates — an unread ask was already waiting, or these notifications are muted. The notification failed to send to 1 teammate — try asking again, or reach out directly.",
		);
	});

	it("tells the two kinds of quiet recipient apart when nobody was notified", () => {
		const summary = summarizeCliConnectionAsk(
			askResult({ notifiedCount: 0, recipientCount: 3, failedCount: 1 }),
		);

		expect(summary.tone).toBe("info");
		expect(summary.message).toBe(
			"No new notification went out — an unread ask was already waiting for 2 teammates, or these notifications are muted. The notification also failed to send to 1 teammate — try asking again, or reach out directly.",
		);
	});

	it("says so when everybody matched was ineligible", () => {
		expect(
			summarizeCliConnectionAsk(
				askResult({
					notifiedCount: 0,
					recipientCount: 0,
					ineligibleCount: 2,
				}),
			),
		).toEqual({
			tone: "info",
			message:
				"Nobody was asked — 2 teammates matched, and cannot create an API key.",
		});
	});

	it("reads at a count of one", () => {
		expect(
			summarizeCliConnectionAsk(
				askResult({
					notifiedCount: 1,
					recipientCount: 2,
					ineligibleCount: 1,
				}),
			).message,
		).toBe(
			"Asked 1 teammate to connect a coding tool. No new notification went to 1 teammate — an unread ask was already waiting, or these notifications are muted. Left out 1 teammate who cannot create an API key.",
		);
	});

	it("reads a lone failed write at a count of one", () => {
		expect(
			summarizeCliConnectionAsk(
				askResult({
					notifiedCount: 0,
					recipientCount: 1,
					failedCount: 1,
				}),
			).message,
		).toBe(
			"Nobody was notified. The notification failed to send to 1 teammate — try asking again, or reach out directly.",
		);
	});
});

/* -------------------------------------------------------------------------- */
/* The roster                                                                  */
/* -------------------------------------------------------------------------- */

describe("RequestCliConnectionDialog — who can be asked", () => {
	it("offers the project's members and never the viewer", async () => {
		await renderDialog();

		expect(
			await screen.findByRole("checkbox", { name: "Ask Dana Rivers" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("checkbox", { name: "Ask Sam Ellis" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("checkbox", { name: "Ask Robin Viewer" }),
		).not.toBeInTheDocument();
	});

	it("reads the roster for this project only", async () => {
		await renderDialog();

		await waitFor(() => expect(listMembersMock).toHaveBeenCalled());
		expect(listMembersMock).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			organizationId: ORGANIZATION_ID,
		});
	});

	it("says the tag route is scoped to this project, not the organization", async () => {
		await renderDialog();

		expect(
			screen.getByText(
				/Function tags are held per project\. This reaches the holders on this project, not everyone in the organization\./,
			),
		).toBeInTheDocument();
	});

	it("cannot send an empty ask", async () => {
		await renderDialog();

		expect(
			await screen.findByRole("button", { name: SEND_LABEL }),
		).toBeDisabled();
	});

	/**
	 * Counter-check for Fix 3: against the pre-fix `selectableMembers`, which
	 * only filtered out the viewer, this roster (the creator's synthesised row
	 * plus their own accepted self-invite, both `userId: "user-creator"`)
	 * renders TWO checkboxes named "Ask Casey Creator" sharing one React key —
	 * this test's first assertion (`getAllByRole` returns exactly one) fails
	 * against that code and passes against the de-dup fix.
	 */
	it("renders a creator who also holds an accepted self-invite once, not twice", async () => {
		listMembersMock.mockResolvedValue({
			members: DUPLICATE_CREATOR_ROSTER,
		});
		await renderDialog();

		const creatorCheckboxes = await screen.findAllByRole("checkbox", {
			name: "Ask Casey Creator",
		});
		expect(creatorCheckboxes).toHaveLength(1);

		// Ticking the one row must not silently tick a phantom second row —
		// there is only the one to observe, so this is really asserting the
		// row is singular rather than that the click "worked twice".
		const user = userEvent.setup();
		await user.click(creatorCheckboxes[0]);
		expect(creatorCheckboxes[0]).toBeChecked();

		await user.click(screen.getByRole("button", { name: SEND_LABEL }));
		await waitFor(() =>
			expect(requestCliConnectionMock).toHaveBeenCalledWith({
				projectId: PROJECT_ID,
				organizationId: ORGANIZATION_ID,
				userIds: [CREATOR_ID],
				functionTags: [],
			}),
		);
	});
});

/* -------------------------------------------------------------------------- */
/* Asking                                                                      */
/* -------------------------------------------------------------------------- */

describe("RequestCliConnectionDialog — asking by name", () => {
	it("sends the picked people and reports what was written", async () => {
		const user = userEvent.setup();
		const onOpenChange = vi.fn();
		await renderDialog(onOpenChange);

		await user.click(
			await screen.findByRole("checkbox", { name: "Ask Dana Rivers" }),
		);
		await user.click(screen.getByRole("button", { name: SEND_LABEL }));

		await waitFor(() =>
			expect(requestCliConnectionMock).toHaveBeenCalledTimes(1),
		);
		expect(requestCliConnectionMock).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			organizationId: ORGANIZATION_ID,
			userIds: ["user-dana"],
			functionTags: [],
		});
		await waitFor(() =>
			expect(toastMock.success).toHaveBeenCalledWith(
				"Asked 1 teammate to connect a coding tool.",
			),
		);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	/** A handful of people is a number the sender can see, so nothing intervenes. */
	it("does not stop to confirm a small hand-picked ask", async () => {
		const user = userEvent.setup();
		await renderDialog();

		await user.click(
			await screen.findByRole("checkbox", { name: "Ask Dana Rivers" }),
		);
		await user.click(
			screen.getByRole("checkbox", { name: "Ask Sam Ellis" }),
		);
		await user.click(screen.getByRole("button", { name: SEND_LABEL }));

		expect(screen.queryByText(CONFIRM_TITLE)).not.toBeInTheDocument();
		await waitFor(() =>
			expect(requestCliConnectionMock).toHaveBeenCalledTimes(1),
		);
	});

	it("tells the truth when some were deduplicated and some were ineligible", async () => {
		requestCliConnectionMock.mockResolvedValue(
			askResult({
				notifiedCount: 2,
				recipientCount: 5,
				ineligibleCount: 3,
			}),
		);
		const user = userEvent.setup();
		await renderDialog();

		await user.click(
			await screen.findByRole("checkbox", { name: "Ask Dana Rivers" }),
		);
		await user.click(screen.getByRole("button", { name: SEND_LABEL }));

		await waitFor(() =>
			expect(toastMock.success).toHaveBeenCalledWith(
				"Asked 2 teammates to connect a coding tool. No new notification went to 3 teammates — an unread ask was already waiting, or these notifications are muted. Left out 3 teammates who cannot create an API key.",
			),
		);
	});

	/**
	 * The end-to-end pin for Fix 1: a recipient the fan-out could not WRITE to
	 * is not the same as one who already had an unread ask, and the toast the
	 * sender actually sees must say so.
	 *
	 * Counter-check: against the pre-fix `summarizeCliConnectionAsk`, which
	 * read only `notifiedCount`, `recipientCount` and `ineligibleCount`, this
	 * server response (`recipientCount: 1`, `notifiedCount: 0`) would have
	 * produced "No new notification went out — an unread ask was already
	 * waiting for 1 teammate, or these notifications are muted." — telling the
	 * sender a colleague nobody reached had already been asked. This test
	 * fails against that code and passes against the fix.
	 */
	it("tells the sender a write failed rather than claiming the recipient was already asked", async () => {
		requestCliConnectionMock.mockResolvedValue(
			askResult({ notifiedCount: 0, recipientCount: 1, failedCount: 1 }),
		);
		const user = userEvent.setup();
		await renderDialog();

		await user.click(
			await screen.findByRole("checkbox", { name: "Ask Dana Rivers" }),
		);
		await user.click(screen.getByRole("button", { name: SEND_LABEL }));

		await waitFor(() =>
			expect(toastMock.info).toHaveBeenCalledWith(
				"Nobody was notified. The notification failed to send to 1 teammate — try asking again, or reach out directly.",
			),
		);
		expect(toastMock.success).not.toHaveBeenCalled();
		for (const call of toastMock.info.mock.calls) {
			expect(call[0]).not.toMatch(/already waiting/);
			expect(call[0]).not.toMatch(/muted/);
		}
	});

	it("does not report a delivery in the success register when nothing was sent", async () => {
		requestCliConnectionMock.mockResolvedValue(
			askResult({
				notifiedCount: 0,
				recipientCount: 0,
				ineligibleCount: 2,
			}),
		);
		const user = userEvent.setup();
		await renderDialog();

		await user.click(
			await screen.findByRole("checkbox", { name: "Ask Dana Rivers" }),
		);
		await user.click(screen.getByRole("button", { name: SEND_LABEL }));

		await waitFor(() =>
			expect(toastMock.info).toHaveBeenCalledWith(
				"Nobody was asked — 2 teammates matched, and cannot create an API key.",
			),
		);
		expect(toastMock.success).not.toHaveBeenCalled();
	});

	it("keeps the picker and says nothing internal when the ask fails", async () => {
		requestCliConnectionMock.mockRejectedValue(
			new Error('relation "notification" does not exist'),
		);
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const user = userEvent.setup();
		await renderDialog();

		await user.click(
			await screen.findByRole("checkbox", { name: "Ask Dana Rivers" }),
		);
		await user.click(screen.getByRole("button", { name: SEND_LABEL }));

		await waitFor(() =>
			expect(toastMock.error).toHaveBeenCalledWith(
				"The ask could not be sent. Try again, or ask your team directly.",
			),
		);
		// The server's own message never reaches the reader: this repository is
		// public and such a string can carry an internal detail.
		expect(
			screen.queryByText(/relation "notification" does not exist/),
		).not.toBeInTheDocument();
		expect(screen.getByText(DIALOG_TITLE)).toBeInTheDocument();
		consoleError.mockRestore();
	});

	/**
	 * The end-to-end pin for Fix 2's first half: an over-cap ask — here, a
	 * function tag that resolves to more people than one ask may reach — must
	 * not land on the same "Try again" dead end as an ordinary failure. Retrying
	 * this exact request fails identically forever, and the reader was already
	 * told a tag's true size cannot be known before sending (`CONFIRM_TAG_NOTE`),
	 * so "try again" teaches them nothing they can act on.
	 *
	 * Counter-check: the pre-fix `onError` replaced EVERY server message with
	 * `SEND_ERROR`, so this exact refusal — matched now by `data.code` — used
	 * to produce the identical generic toast the ordinary-failure test above
	 * asserts. This test fails against that code (wrong message, and it would
	 * also assert `consoleError` was never called, which the old code did
	 * call) and passes against the fix.
	 */
	it("reports a distinguishable, actionable message when the ask resolves over the cap", async () => {
		requestCliConnectionMock.mockRejectedValue(
			new ORPCError("BAD_REQUEST", {
				message:
					"This ask reaches 60 people, and one ask may reach at most 50 at once. Name fewer people, or a narrower function tag.",
				data: {
					code: "TOO_MANY_RECIPIENTS",
					recipientCount: 60,
					maxRecipients: 50,
				},
			}),
		);
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const user = userEvent.setup();
		await renderDialog();

		// A tag ask always confirms first, whatever it resolves to — the
		// refusal only reaches the server on "Send it".
		await screen.findByRole("checkbox", { name: "Ask Dana Rivers" });
		fireEvent.click(screen.getByLabelText(TAGS_LABEL));
		fireEvent.click(screen.getByRole("option", { name: "Developer" }));
		await user.click(screen.getByRole("button", { name: SEND_LABEL }));
		await user.click(
			screen.getByRole("button", { name: CONFIRM_SEND_LABEL }),
		);

		await waitFor(() =>
			expect(toastMock.error).toHaveBeenCalledWith(
				"This ask reaches 60 people, and one ask may reach at most 50 at once. Narrow the function tag, or pick fewer people.",
			),
		);
		// Different from, not a rewording of, the generic retry copy: that
		// copy is actively false for a refusal that fails identically forever.
		expect(toastMock.error).not.toHaveBeenCalledWith(
			"The ask could not be sent. Try again, or ask your team directly.",
		);
		// Not logged as an unexpected break: the server named this refusal on
		// purpose, and it is not a bug for this surface to report.
		expect(consoleError).not.toHaveBeenCalled();
		consoleError.mockRestore();
	});
});

/* -------------------------------------------------------------------------- */
/* Confirmation                                                                */
/* -------------------------------------------------------------------------- */

describe("RequestCliConnectionDialog — confirming a fan-out", () => {
	it("confirms a tag ask before sending it, then sends the tag", async () => {
		const user = userEvent.setup();
		await renderDialog();

		await screen.findByRole("checkbox", { name: "Ask Dana Rivers" });
		// The real tag picker, driven as its own suite drives it.
		fireEvent.click(screen.getByLabelText(TAGS_LABEL));
		fireEvent.click(screen.getByRole("option", { name: "Developer" }));

		await user.click(screen.getByRole("button", { name: SEND_LABEL }));

		expect(await screen.findByText(CONFIRM_TITLE)).toBeInTheDocument();
		expect(requestCliConnectionMock).not.toHaveBeenCalled();
		expect(
			screen.getByText(/Fabric cannot tell you how many people that is/),
		).toBeInTheDocument();

		await user.click(
			screen.getByRole("button", { name: CONFIRM_SEND_LABEL }),
		);

		await waitFor(() =>
			expect(requestCliConnectionMock).toHaveBeenCalledWith({
				projectId: PROJECT_ID,
				organizationId: ORGANIZATION_ID,
				userIds: [],
				functionTags: ["DEVELOPER"],
			}),
		);
	});

	it("confirms a hand-picked ask above ten, and sends every one of them", async () => {
		listMembersMock.mockResolvedValue({ members: LARGE_ROSTER });
		const user = userEvent.setup();
		await renderDialog();

		await screen.findByRole("checkbox", { name: "Ask Teammate 0" });
		for (const entry of LARGE_ROSTER) {
			await user.click(
				screen.getByRole("checkbox", {
					name: `Ask ${entry.user.name}`,
				}),
			);
		}

		await user.click(screen.getByRole("button", { name: SEND_LABEL }));

		expect(await screen.findByText(CONFIRM_TITLE)).toBeInTheDocument();
		expect(requestCliConnectionMock).not.toHaveBeenCalled();
		expect(
			screen.getByText(
				"You have picked 12 people. Each one gets their own notification.",
			),
		).toBeInTheDocument();

		await user.click(
			screen.getByRole("button", { name: CONFIRM_SEND_LABEL }),
		);

		await waitFor(() =>
			expect(requestCliConnectionMock).toHaveBeenCalledTimes(1),
		);
		expect(requestCliConnectionMock.mock.calls[0][0].userIds).toHaveLength(
			12,
		);
	});

	it("sends nothing when the confirmation is declined", async () => {
		const user = userEvent.setup();
		await renderDialog();

		await screen.findByRole("checkbox", { name: "Ask Dana Rivers" });
		fireEvent.click(screen.getByLabelText(TAGS_LABEL));
		fireEvent.click(screen.getByRole("option", { name: "Developer" }));
		await user.click(screen.getByRole("button", { name: SEND_LABEL }));

		expect(await screen.findByText(CONFIRM_TITLE)).toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: CONFIRM_BACK_LABEL }),
		);

		expect(await screen.findByText(DIALOG_TITLE)).toBeInTheDocument();
		expect(requestCliConnectionMock).not.toHaveBeenCalled();
	});

	/**
	 * The confirmation must warn about the unknown rather than name a number.
	 * There is no honest pre-count for a tag — see `askNeedsConfirmation` — and
	 * a made-up one would be the overstatement this whole ticket is correcting.
	 */
	it("promises no number it cannot know", async () => {
		const user = userEvent.setup();
		await renderDialog();

		await screen.findByRole("checkbox", { name: "Ask Dana Rivers" });
		fireEvent.click(screen.getByLabelText(TAGS_LABEL));
		fireEvent.click(screen.getByRole("option", { name: "Developer" }));
		await user.click(screen.getByRole("button", { name: SEND_LABEL }));

		expect(await screen.findByText(CONFIRM_TITLE)).toBeInTheDocument();
		expect(
			screen.queryByText(/You have picked \d+ people/),
		).not.toBeInTheDocument();
	});
});

/* -------------------------------------------------------------------------- */
/* The hand-picked cap (Fizzy #2457 follow-up)                                 */
/* -------------------------------------------------------------------------- */

describe("RequestCliConnectionDialog — the hand-picked cap", () => {
	/**
	 * Counter-check for Fix 2's guard: the pre-fix picker let every checkbox
	 * stay enabled and never rendered a cap explanation at all, so both
	 * assertions here — the disabled (cap + 1)th box and the visible note —
	 * fail against that code and pass against the fix.
	 */
	it("stops a hand-picked selection at the cap, with an explanation at the point of selection", async () => {
		listMembersMock.mockResolvedValue({ members: CAP_PLUS_TWO_ROSTER });
		const user = userEvent.setup();
		await renderDialog();

		await screen.findByRole("checkbox", { name: "Ask Teammate 0" });
		expect(
			screen.queryByText(/You've reached the limit/),
		).not.toBeInTheDocument();

		for (let index = 0; index < MAX_HAND_PICKED_RECIPIENTS; index++) {
			await user.click(
				screen.getByRole("checkbox", { name: `Ask Teammate ${index}` }),
			);
		}

		// The explanation sits on the page now — not only announced once via
		// the live region, which a reader tabbing back in would never hear.
		expect(
			screen.getByText(
				`You've reached the limit of ${MAX_HAND_PICKED_RECIPIENTS} people for one hand-picked ask. Remove someone to add another, or reach more people through a function tag instead.`,
			),
		).toBeInTheDocument();

		// Reachable but inert: the (cap + 1)th box is disabled rather than
		// silently ignoring a press, which would read as broken.
		const oneOverCap = screen.getByRole("checkbox", {
			name: `Ask Teammate ${MAX_HAND_PICKED_RECIPIENTS}`,
		});
		expect(oneOverCap).toBeDisabled();
		expect(oneOverCap).not.toBeChecked();
		await user.click(oneOverCap);
		expect(oneOverCap).not.toBeChecked();

		// Freeing a slot by unchecking one already-picked box always works —
		// the cap must never trap a selection at exactly the limit.
		await user.click(
			screen.getByRole("checkbox", { name: "Ask Teammate 0" }),
		);
		expect(
			screen.queryByText(/You've reached the limit/),
		).not.toBeInTheDocument();
		expect(oneOverCap).not.toBeDisabled();
	});

	/**
	 * The guard's whole point, proven at the send boundary rather than only at
	 * the checkbox: however many rows a reader tries to tick, the request this
	 * view composes never names more than the cap.
	 */
	it("never composes a request naming more than the cap", async () => {
		listMembersMock.mockResolvedValue({ members: CAP_PLUS_TWO_ROSTER });
		const user = userEvent.setup();
		await renderDialog();

		await screen.findByRole("checkbox", { name: "Ask Teammate 0" });
		for (const entry of CAP_PLUS_TWO_ROSTER) {
			// Try every row, including the two past the cap — the guard, not
			// this loop, is what must keep the selection from growing further.
			await user.click(
				screen.getByRole("checkbox", {
					name: `Ask ${entry.user.name}`,
				}),
			);
		}

		// Above the confirm threshold too, so this raises the confirmation —
		// whose own count comes straight from the selection the guard capped.
		await user.click(screen.getByRole("button", { name: SEND_LABEL }));
		expect(
			await screen.findByText(
				`You have picked ${MAX_HAND_PICKED_RECIPIENTS} people. Each one gets their own notification.`,
			),
		).toBeInTheDocument();

		await user.click(
			screen.getByRole("button", { name: CONFIRM_SEND_LABEL }),
		);
		await waitFor(() =>
			expect(requestCliConnectionMock).toHaveBeenCalledTimes(1),
		);
		expect(requestCliConnectionMock.mock.calls[0][0].userIds).toHaveLength(
			MAX_HAND_PICKED_RECIPIENTS,
		);
	});
});

/* -------------------------------------------------------------------------- */
/* Accessibility                                                               */
/* -------------------------------------------------------------------------- */

describe("RequestCliConnectionDialog — keyboard and announcements", () => {
	it("composes, confirms and sends an ask without a pointer", async () => {
		const user = userEvent.setup();
		await renderDialog();

		const dana = await screen.findByRole("checkbox", {
			name: "Ask Dana Rivers",
		});
		dana.focus();
		await user.keyboard(" ");
		expect(dana).toBeChecked();

		// The send control must be REACHABLE by tabbing, not merely focusable:
		// a control a keyboard user cannot walk to is not operable.
		const send = screen.getByRole("button", { name: SEND_LABEL });
		for (
			let step = 0;
			step < 12 && document.activeElement !== send;
			step++
		) {
			await user.tab();
		}
		expect(send).toHaveFocus();
		await user.keyboard("{Enter}");

		await waitFor(() =>
			expect(requestCliConnectionMock).toHaveBeenCalledTimes(1),
		);
	});

	it("moves focus onto the confirmation instead of dropping it on the page", async () => {
		const user = userEvent.setup();
		await renderDialog();

		await screen.findByRole("checkbox", { name: "Ask Dana Rivers" });
		fireEvent.click(screen.getByLabelText(TAGS_LABEL));
		fireEvent.click(screen.getByRole("option", { name: "Developer" }));
		await user.click(screen.getByRole("button", { name: SEND_LABEL }));

		const confirmSend = await screen.findByRole("button", {
			name: CONFIRM_SEND_LABEL,
		});
		await waitFor(() => expect(confirmSend).toHaveFocus());

		await user.keyboard("{Enter}");
		await waitFor(() =>
			expect(requestCliConnectionMock).toHaveBeenCalledTimes(1),
		);
	});

	it("announces the confirmation rather than only drawing it", async () => {
		const user = userEvent.setup();
		const { container } = render(<Harness />);

		await screen.findByRole("checkbox", { name: "Ask Dana Rivers" });
		fireEvent.click(screen.getByLabelText(TAGS_LABEL));
		fireEvent.click(screen.getByRole("option", { name: "Developer" }));
		await user.click(screen.getByRole("button", { name: SEND_LABEL }));

		await waitFor(() => {
			const liveRegion = document.querySelector('[aria-live="polite"]');
			expect(liveRegion?.textContent).toContain(
				"Confirm this ask before it is sent.",
			);
		});
		expect(container).toBeTruthy();
	});
});
