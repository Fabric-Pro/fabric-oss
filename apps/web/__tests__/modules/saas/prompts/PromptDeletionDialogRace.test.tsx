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

import { usePromptDeletion } from "@saas/prompts/hooks/use-prompt-deletion";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { deletionImpact, deletePrompt, confirmMock } = vi.hoisted(() => ({
	deletionImpact: vi.fn(),
	deletePrompt: vi.fn(),
	confirmMock: vi.fn(),
}));

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
		userRole: "admin",
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
	};
}

beforeEach(() => {
	deletionImpact.mockReset();
	deletePrompt.mockReset();
	confirmMock.mockReset();
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
