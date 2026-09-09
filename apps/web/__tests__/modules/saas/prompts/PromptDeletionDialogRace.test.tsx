/**
 * Two Deletes racing for one confirmation dialog, and an impact read that never
 * comes back (Fizzy #2328, review follow-up).
 *
 * `ConfirmationAlertProvider` holds ONE set of confirm options for the whole
 * app and `confirm()` replaces them wholesale. So a late
 * `prompts.deletionImpact` resolution calling `confirm()` again does not open a
 * second dialog — it rewrites the open one's message AND its `onConfirm` under
 * the same title and the same Delete button. The two rows racing are two
 * instances of `usePromptDeletion`, both mounted, so the hook's mounted ref
 * cannot see it: the operator reads about one prompt and confirms the deletion
 * of another.
 *
 * The same read has a second piece of bookkeeping to get right: WHY it came
 * back without figures. A refusal that says the caller's request resolved no
 * workspace is a fact about the deletion itself; a read that ran out of time
 * knows nothing at all. Both used to collapse into one absent value, so those
 * cases are here too — the classification is the read's own, and reaching it
 * through the confirmation's wording would test the formatter instead.
 *
 * A third piece of the same bookkeeping arrived with the #2403 review: WHO the
 * one recovery is offered to. `ActiveOrganizationProvider` skips its session
 * alignment for a viewer holding no membership in the workspace on screen, so
 * for them "reloading the page restores it" is a promise a reload cannot keep.
 * The hook decides that, which is why it is asserted here — and it can only be
 * asserted here, because no listing surface renders Delete on a SYSTEM prompt
 * for a viewer with no organization role (`canDeletePrompt`).
 *
 * These tests drive the hook through a bare button rather than through a
 * surface's overflow menu on purpose. The bug is in the hook's own bookkeeping,
 * and a Radix menu between the click and the assertion would only add
 * `aria-hidden` and pointer-event states to reason about. Which surfaces mount
 * the hook is `PromptDeleteAffordance.test.tsx`'s job; what the wait says is
 * `PromptDeleteConfirmation.test.tsx`'s.
 *
 * Run with:
 *   pnpm --filter web test __tests__/modules/saas/prompts/PromptDeletionDialogRace.test.tsx
 */

import { MISSING_ORGANIZATION_CONTEXT_ERROR_CODE } from "@repo/api/lib/missing-organization-context";
import {
	type PromptDeletionImpactRead,
	type PromptImpactUnavailableReason,
	readDeletionImpact,
	usePromptDeletion,
} from "@saas/prompts/hooks/use-prompt-deletion";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refusal } from "./support/refusal";

const { deletionImpact, deletePrompt, confirmMock, viewer } = vi.hoisted(
	() => ({
		deletionImpact: vi.fn(),
		deletePrompt: vi.fn(),
		confirmMock: vi.fn(),
		/** The person looking, as the organization context reports them. */
		viewer: { organizationRole: "admin" as string | null },
	}),
);

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: {
			delete: (input: unknown) => deletePrompt(input),
			// The second argument matters here: the timeout cancels the request
			// through it, so the mock must receive it rather than swallow it.
			deletionImpact: (input: unknown, options?: unknown) =>
				deletionImpact(input, options),
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: confirmMock }),
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user-1", role: "admin" } }),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		basePath: "/app/example-org",
		organizationId: "org-1",
		// `activeOrganizationUserRole` exactly as the provider yields it: the
		// viewer's role in the workspace on screen, or null when they hold no
		// membership in it. Null here is not an under-filled mock — it is the
		// project guest, the viewer the provider's alignment skips.
		userRole: viewer.organizationRole,
	}),
}));

const systemPrompt = {
	id: "p-sys",
	name: "Draft Generator",
	scope: "SYSTEM",
	organizationId: null,
	userId: null,
};

const otherSystemPrompt = {
	id: "p-sys-2",
	name: "Review Summariser",
	scope: "SYSTEM",
	organizationId: null,
	userId: null,
};

/** Confirms immediately, with no impact read at all — the ORG path. */
const orgPrompt = {
	id: "p-org",
	name: "Team Draft Generator",
	scope: "ORG",
	organizationId: "org-1",
	userId: null,
};

const busyImpact = {
	promptRowCount: 2,
	bindingCount: 5,
	organizationCount: 2,
	personalOverrideUserCount: 1,
	documentTypeLabels: ["Draft", "PRD"],
};

const quietImpact = {
	promptRowCount: 1,
	bindingCount: 0,
	organizationCount: 0,
	personalOverrideUserCount: 0,
	documentTypeLabels: [],
};

/**
 * One row's Delete control, reduced to the parts of the hook a surface renders:
 * the click, and the busy state the trigger carries while the impact is read.
 */
function DeleteControl({
	prompt,
}: {
	prompt: {
		id: string;
		name: string;
		scope: string;
		organizationId: string | null;
		userId: string | null;
	};
}) {
	const { requestDelete, triggerProps } = usePromptDeletion({ prompt });
	return <button type="button" onClick={requestDelete} {...triggerProps} />;
}

function renderRows(
	prompts: Array<Parameters<typeof DeleteControl>[0]["prompt"]>,
) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>
			{prompts.map((prompt) => (
				<DeleteControl key={prompt.id} prompt={prompt} />
			))}
		</QueryClientProvider>,
	);
}

/** The row's control, found by the accessible name the hook gives it. */
function rowControl(name: string): HTMLButtonElement {
	return screen.getByRole("button", {
		name: `Actions for ${name}`,
	}) as HTMLButtonElement;
}

/** The options behind the dialog as it stands right now. */
function currentConfirmOptions() {
	expect(confirmMock).toHaveBeenCalled();
	return confirmMock.mock.calls[confirmMock.mock.calls.length - 1][0] as {
		title: string;
		message: string;
		onConfirm: () => void;
		/** The third action the dialog renders, when it is given one. */
		secondaryAction?: { label: string; onSelect: () => void };
	};
}

beforeEach(() => {
	viewer.organizationRole = "admin";
	deletionImpact.mockReset();
	deletePrompt.mockReset();
	confirmMock.mockReset();
	vi.mocked(toast.error).mockReset();
	vi.mocked(toast.success).mockReset();
	deletePrompt.mockResolvedValue({
		success: true,
		promptKey: "draft_generator",
		scope: "SYSTEM",
		...busyImpact,
		retirementRecorded: true,
	});
});

afterEach(() => {
	vi.useRealTimers();
});

describe("an impact read that resolves after the operator has moved on", () => {
	it("does not rewrite the confirmation now open for another prompt", async () => {
		let releaseImpact: ((figures: unknown) => void) | undefined;
		deletionImpact.mockImplementation(
			() =>
				new Promise((resolve) => {
					releaseImpact = resolve;
				}),
		);

		const user = userEvent.setup();
		renderRows([systemPrompt, orgPrompt]);

		// Row A — a SYSTEM prompt, so the platform-wide impact is read first,
		// and this one is slow.
		await user.click(rowControl("Draft Generator"));
		expect(confirmMock).not.toHaveBeenCalled();

		// Row B — an ORG prompt, which needs no impact and confirms at once.
		await user.click(rowControl("Team Draft Generator"));
		expect(confirmMock).toHaveBeenCalledTimes(1);
		expect(currentConfirmOptions().message).toContain(
			"Team Draft Generator",
		);

		// Row A's fetch lands while row B's dialog is on screen.
		await act(async () => {
			releaseImpact?.(busyImpact);
		});

		// The dialog was not reopened, and — the part that would actually cost
		// data — its message still describes the prompt the operator chose.
		expect(confirmMock).toHaveBeenCalledTimes(1);
		expect(currentConfirmOptions().message).toContain(
			"Team Draft Generator",
		);
		expect(currentConfirmOptions().message).not.toContain(
			"Draft Generator?",
		);

		// And the button behind it still deletes that prompt, not the one whose
		// impact just arrived.
		currentConfirmOptions().onConfirm();
		await waitFor(() =>
			expect(deletePrompt).toHaveBeenCalledWith({ id: "p-org" }),
		);
		expect(deletePrompt).not.toHaveBeenCalledWith({ id: "p-sys" });
	});

	it("releases the abandoned row's busy state rather than stranding it", async () => {
		// Dropping the stale answer must not cost the operator the row: its
		// trigger has to come back, so choosing Delete there again asks afresh.
		let releaseImpact: ((figures: unknown) => void) | undefined;
		deletionImpact.mockImplementation(
			() =>
				new Promise((resolve) => {
					releaseImpact = resolve;
				}),
		);

		const user = userEvent.setup();
		renderRows([systemPrompt, orgPrompt]);

		await user.click(rowControl("Draft Generator"));
		expect(rowControl("Draft Generator")).toBeDisabled();
		expect(rowControl("Draft Generator")).toHaveAttribute(
			"aria-busy",
			"true",
		);

		await user.click(rowControl("Team Draft Generator"));
		await act(async () => {
			releaseImpact?.(busyImpact);
		});

		expect(rowControl("Draft Generator")).not.toBeDisabled();
		expect(rowControl("Draft Generator")).toHaveAttribute(
			"aria-busy",
			"false",
		);
	});

	it("confirms the later of two overlapping impact reads, whichever lands first", async () => {
		const resolvers = new Map<string, (figures: unknown) => void>();
		deletionImpact.mockImplementation(
			(input: { id: string }) =>
				new Promise((resolve) => {
					resolvers.set(input.id, resolve);
				}),
		);

		const user = userEvent.setup();
		renderRows([systemPrompt, otherSystemPrompt]);

		await user.click(rowControl("Draft Generator"));
		await user.click(rowControl("Review Summariser"));

		// The FIRST request answers last. Its figures are stale intent, not a
		// stale snapshot — nobody is waiting for them any more.
		await act(async () => {
			resolvers.get("p-sys-2")?.(quietImpact);
		});
		expect(confirmMock).toHaveBeenCalledTimes(1);
		expect(currentConfirmOptions().message).toContain("Review Summariser");

		await act(async () => {
			resolvers.get("p-sys")?.(busyImpact);
		});
		expect(confirmMock).toHaveBeenCalledTimes(1);
		expect(currentConfirmOptions().message).toContain("Review Summariser");
	});
});

describe("an impact read that never comes back", () => {
	it("is given up on, cancelled, and confirmed as unknown rather than left busy", async () => {
		vi.useFakeTimers();

		// A request that ignores its abort signal entirely — the transport
		// hanging, not merely a slow server. The bound has to hold anyway.
		let requestOptions: { signal?: AbortSignal } | undefined;
		deletionImpact.mockImplementation(
			(_input: unknown, options: { signal?: AbortSignal }) => {
				requestOptions = options;
				return new Promise(() => {});
			},
		);

		renderRows([systemPrompt]);
		// `fireEvent` rather than `userEvent`: the control here is a plain
		// button, and driving it synchronously keeps the clock the only thing
		// this test advances.
		fireEvent.click(rowControl("Draft Generator"));

		expect(rowControl("Draft Generator")).toBeDisabled();
		expect(confirmMock).not.toHaveBeenCalled();

		// Not an eager give-up: a slow-but-alive request still gets its answer
		// in.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(9_000);
		});
		expect(confirmMock).not.toHaveBeenCalled();

		// Past the bound, the flow stops waiting.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(21_000);
		});

		// The request is cancelled, not merely abandoned.
		expect(requestOptions?.signal?.aborted).toBe(true);

		// The same landing as a rejected impact read: unknown, never zero, and
		// the deletion is still offered (R7).
		expect(confirmMock).toHaveBeenCalledTimes(1);
		expect(currentConfirmOptions().message).toContain(
			"could not be determined",
		);
		expect(currentConfirmOptions().message).not.toMatch(
			/no bindings|0 bindings/,
		);

		// And the control the operator clicked is usable again.
		expect(rowControl("Draft Generator")).not.toBeDisabled();
		expect(rowControl("Draft Generator")).toHaveAttribute(
			"aria-busy",
			"false",
		);

		currentConfirmOptions().onConfirm();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(deletePrompt).toHaveBeenCalledWith({ id: "p-sys" });
	});
});

describe("why an impact read came back without figures", () => {
	/** The read, asserted whole — a reason without figures, and nothing else. */
	function expectUnavailable(
		read: PromptDeletionImpactRead,
		reason: PromptImpactUnavailableReason,
	) {
		expect(read).toEqual({ figures: null, unavailableReason: reason });
	}

	it("names the workspace cause when the refusal carries its marker", async () => {
		// The marker, never the sentence: the wording is prose that will be
		// improved, and a client matching on it would break when it is.
		deletionImpact.mockRejectedValue(
			refusal("No organization context available", {
				errorCode: MISSING_ORGANIZATION_CONTEXT_ERROR_CODE,
			}),
		);

		expectUnavailable(
			await readDeletionImpact("p-sys"),
			"missing-workspace",
		);
	});

	it("claims nothing when the refusal carries no marker", async () => {
		// The same FORBIDDEN, for a different reason entirely — an operator who
		// simply may not read the platform-wide impact.
		deletionImpact.mockRejectedValue(
			refusal("You are not authorised to delete system prompts"),
		);

		expectUnavailable(await readDeletionImpact("p-sys"), "unknown");
	});

	it("claims nothing when the refusal carries a marker it does not know", async () => {
		// A cause added after this build shipped must not be reported as the one
		// cause this build can name.
		deletionImpact.mockRejectedValue(
			refusal("Refused", { errorCode: "SOME_LATER_CAUSE" }),
		);

		expectUnavailable(await readDeletionImpact("p-sys"), "unknown");
	});

	it("claims nothing when the read runs out of time", async () => {
		vi.useFakeTimers();

		// The failure that never reaches the `catch` at all: it settles through
		// the race, so it is the arm a reason derived from the error object
		// alone would leave unclassified — and unclassified would have to mean
		// the workspace cause, which this read heard nothing about.
		let requestOptions: { signal?: AbortSignal } | undefined;
		deletionImpact.mockImplementation(
			(_input: unknown, options: { signal?: AbortSignal }) => {
				requestOptions = options;
				return new Promise(() => {});
			},
		);

		const read = readDeletionImpact("p-sys");
		// Past the hook's ten-second bound.
		await vi.advanceTimersByTimeAsync(11_000);

		expectUnavailable(await read, "unknown");
		// And the bound still cancels the request it gave up on.
		expect(requestOptions?.signal?.aborted).toBe(true);
	});

	it("claims nothing when the read is aborted", async () => {
		const aborted = new Error("The operation was aborted.");
		aborted.name = "AbortError";
		deletionImpact.mockRejectedValue(aborted);

		expectUnavailable(await readDeletionImpact("p-sys"), "unknown");
	});

	it("claims nothing when the response itself carried nothing", async () => {
		// An empty response is not an impact of zero. Whatever the reason, a
		// read without figures always carries one, so the caller never has to
		// invent a sentence for a state the type does not describe.
		deletionImpact.mockResolvedValue(undefined);

		expectUnavailable(await readDeletionImpact("p-sys"), "unknown");
	});

	it("carries the figures and no reason when the read succeeds", async () => {
		deletionImpact.mockResolvedValue(busyImpact);

		expect(await readDeletionImpact("p-sys")).toEqual({
			figures: busyImpact,
			unavailableReason: null,
		});
	});
});

describe("who the workspace confirmation offers a recovery to", () => {
	/**
	 * The workspace branch's dialog, opened through the hook for whichever
	 * viewer the fixture currently describes.
	 *
	 * The refusal is the same one every time — the shared marker beside the
	 * server's sentence — so the ONLY thing that differs between the cases
	 * below is who is looking. That is what makes the pair worth having: it
	 * pins the gate to the viewer's membership rather than to anything about
	 * the failure.
	 */
	async function openWorkspaceConfirmation() {
		deletionImpact.mockRejectedValue(
			refusal("No organization context available", {
				errorCode: MISSING_ORGANIZATION_CONTEXT_ERROR_CODE,
			}),
		);

		const user = userEvent.setup();
		renderRows([systemPrompt]);
		await user.click(rowControl("Draft Generator"));
		await waitFor(() => expect(confirmMock).toHaveBeenCalled());

		return currentConfirmOptions();
	}

	it("offers the reload, and says so, to a viewer who holds a membership", async () => {
		const { message, secondaryAction } = await openWorkspaceConfirmation();

		expect(secondaryAction?.label).toBe("Reload the page");
		expect(message).toContain("reloading the page restores it");
	});

	it("names the cause but promises no remedy to a viewer who holds none", async () => {
		// The project guest: the workspace is on screen, and they are not in
		// its member list. `ActiveOrganizationProvider` returns early for
		// exactly this viewer, so a reload re-runs an effect that skips again —
		// the recovery is a no-op by construction, not merely unlikely to help.
		viewer.organizationRole = null;

		const { message, secondaryAction } = await openWorkspaceConfirmation();

		expect(secondaryAction).toBeUndefined();
		expect(message).not.toMatch(/reload/i);
		expect(message).not.toContain("restores it");
		// Withholding the remedy is not withholding the explanation: the cause
		// is still named, and it is still stated as a condition.
		expect(message).toBe(
			'Delete the system prompt "Draft Generator"? This request has no workspace to act in, so the deletion will be refused while the workspace is missing. You can still choose Delete, but what it would remove was never read, so if the workspace is restored first this may remove bindings belonging to other organizations and people.',
		);
		// And the sentence that stands in for the promise this branch used to
		// make is still there — the impact was never read, so the possibility
		// is stated rather than ruled out.
		expect(message).not.toMatch(/nothing will be removed/i);
	});

	it("still offers Delete to a viewer who holds no membership (R10)", async () => {
		// A dead end is the outcome this whole flow exists to avoid, and having
		// no membership is not a reason to impose one: the server is what
		// refuses the deletion, and it may refuse it a moment later than this.
		viewer.organizationRole = null;

		const options = await openWorkspaceConfirmation();
		options.onConfirm();

		await waitFor(() =>
			expect(deletePrompt).toHaveBeenCalledWith({ id: "p-sys" }),
		);
	});
});

describe("what a deletion the server refused tells the operator", () => {
	/**
	 * The refusal's own sentence, byte-for-byte as every refusing site says it.
	 *
	 * It is the backend's vocabulary (the "organization" vs "workspace" rule
	 * on `MISSING_ORGANIZATION_CONTEXT_ERROR_CODE`) and it describes the
	 * request, not the deletion. Repeated verbatim into
	 * a toast titled "Failed to delete prompt", it reads as the operator having
	 * been turned away from this prompt.
	 */
	const REFUSAL_SENTENCE = "This operation requires an organization context";

	/** Chooses Delete on the one rendered row, then confirms it. */
	async function deleteAndConfirm(
		prompt: Parameters<typeof DeleteControl>[0]["prompt"],
	) {
		const user = userEvent.setup();
		renderRows([prompt]);

		await user.click(rowControl(prompt.name));
		await waitFor(() => expect(confirmMock).toHaveBeenCalled());

		currentConfirmOptions().onConfirm();
		await waitFor(() => expect(toast.error).toHaveBeenCalled());
	}

	/** The one error toast the refusal produced, title and description. */
	function failureToast(): { title: string; description: string } {
		expect(toast.error).toHaveBeenCalledTimes(1);
		const [title, options] = vi.mocked(toast.error).mock.calls[0] as [
			string,
			{ description?: string } | undefined,
		];
		return { title, description: options?.description ?? "" };
	}

	/** Asserts the whole toast names the cause and borrows nothing. */
	function expectWorkspaceWording({
		title,
		description,
	}: {
		title: string;
		description: string;
	}) {
		const whole = `${title} ${description}`;
		expect(whole).toContain("workspace");
		// Not the server's sentence, and not the unattributed title that used
		// to sit above it.
		expect(whole).not.toContain(REFUSAL_SENTENCE);
		expect(title).not.toBe("Failed to delete prompt");
		// The backend's word for the tenant never reaches the operator.
		expect(whole).not.toMatch(/organization/i);
		// "Workspace session" is this product's name for a coding-agent run,
		// so the cause must not borrow it.
		expect(whole).not.toMatch(/workspace session/i);
	}

	it("names the workspace rather than repeating the server's sentence, for a SYSTEM prompt", async () => {
		deletionImpact.mockResolvedValue(busyImpact);
		deletePrompt.mockRejectedValue(
			refusal(REFUSAL_SENTENCE, {
				errorCode: MISSING_ORGANIZATION_CONTEXT_ERROR_CODE,
			}),
		);

		await deleteAndConfirm(systemPrompt);

		expectWorkspaceWording(failureToast());
	});

	it("names the workspace for a prompt at a scope where no impact read ran", async () => {
		// The case this unit exists for. An ORG prompt cannot be bound outside
		// the tenant looking at it, so the hook never calls the impact
		// endpoint — which leaves this toast as the ONLY place the cause can
		// ever be named for such a prompt.
		deletePrompt.mockRejectedValue(
			refusal(REFUSAL_SENTENCE, {
				errorCode: MISSING_ORGANIZATION_CONTEXT_ERROR_CODE,
			}),
		);

		await deleteAndConfirm(orgPrompt);

		expect(deletionImpact).not.toHaveBeenCalled();
		expectWorkspaceWording(failureToast());
	});

	it("still surfaces the server's own message when the refusal is about authority", async () => {
		// A refusal with no marker is a different refusal, and the server's
		// reason for it is more use than any wording this hook could invent.
		deletionImpact.mockResolvedValue(busyImpact);
		deletePrompt.mockRejectedValue(
			refusal("You are not authorised to delete system prompts"),
		);

		await deleteAndConfirm(systemPrompt);

		expect(failureToast()).toEqual({
			title: "Failed to delete prompt",
			description: "You are not authorised to delete system prompts",
		});
	});

	it("still surfaces the server's own message for a marker this build does not know", async () => {
		// A cause added after this build shipped is not the one cause this
		// build can name.
		deletePrompt.mockRejectedValue(
			refusal("Refused", { errorCode: "SOME_LATER_CAUSE" }),
		);

		await deleteAndConfirm(orgPrompt);

		expect(failureToast()).toEqual({
			title: "Failed to delete prompt",
			description: "Refused",
		});
	});

	it("is unchanged for a failure that says nothing about its cause", async () => {
		deletePrompt.mockRejectedValue(new Error("Failed to fetch"));

		await deleteAndConfirm(orgPrompt);

		expect(failureToast()).toEqual({
			title: "Failed to delete prompt",
			description: "Failed to fetch",
		});
	});
});
