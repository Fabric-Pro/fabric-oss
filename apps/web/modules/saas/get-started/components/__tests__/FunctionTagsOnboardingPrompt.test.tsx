/**
 * FR4 recurring function-tags prompt modal.
 *
 * Coverage:
 *   1. Seeds `FunctionTagSelect` from `functionTags.getMyDefault`.
 *   2. Save persists via `setMyDefault(tags)` then closes; never opts out.
 *   3. "Not now" closes only — no `setMyDefault`, no opt-out (session dismiss).
 *   4. "Don't ask again" opts out (awaiting the promise) then closes.
 *   5. Escape / the dialog's X close button both route through the same
 *      `onOpenChange(false)` handler, which behaves like "Not now" (close
 *      only, no opt-out) rather than a silent no-op.
 *   6. A rejected `onOptOut` keeps the modal open (no `onClose`) and surfaces
 *      an error toast.
 *   7. A rejected Save keeps the modal open (no `onClose`) and surfaces an
 *      error toast.
 *   8. With an empty-default read, Save stays disabled and cannot persist
 *      `[]` (Codex F2).
 *
 * The modal never touches the onboarding-state query cache directly — it
 * only ever calls the `onOptOut` prop the controller hands it. That
 * invariant is exercised at the controller level
 * (`GetStartedController.functionTags.test.tsx`), not here.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getMyDefault = vi.fn();
const setMyDefault = vi.fn();

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		functionTags: {
			getMyDefault: {
				queryOptions: () => ({
					queryKey: ["ft", "getMyDefault"],
					queryFn: getMyDefault,
				}),
			},
		},
	},
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		functionTags: { setMyDefault: (i: unknown) => setMyDefault(i) },
	},
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({
	toast: { error: (...args: unknown[]) => toastError(...args) },
}));

import { FunctionTagsOnboardingPrompt } from "../FunctionTagsOnboardingPrompt";

function makeClient() {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
}

function renderPrompt(props: {
	onOptOut: () => Promise<void>;
	onClose: () => void;
}) {
	return render(
		<QueryClientProvider client={makeClient()}>
			<FunctionTagsOnboardingPrompt {...props} />
		</QueryClientProvider>,
	);
}

/** A promise plus externally-callable resolve/reject, for ordering assertions. */
function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

beforeEach(() => {
	getMyDefault.mockReset();
	setMyDefault.mockReset();
	toastError.mockReset();
	getMyDefault.mockResolvedValue({ tags: ["DEVELOPER"] });
	setMyDefault.mockResolvedValue({ tags: ["DEVELOPER"] });
});

describe("FunctionTagsOnboardingPrompt", () => {
	it("seeds FunctionTagSelect from getMyDefault", async () => {
		renderPrompt({ onOptOut: vi.fn(), onClose: vi.fn() });
		expect(await screen.findByText("Developer")).toBeInTheDocument();
	});

	it("Save persists via setMyDefault then closes; never opts out", async () => {
		const onOptOut = vi.fn();
		const onClose = vi.fn();
		const user = userEvent.setup();
		renderPrompt({ onOptOut, onClose });
		await screen.findByText("Developer");

		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() =>
			expect(setMyDefault).toHaveBeenCalledWith({ tags: ["DEVELOPER"] }),
		);
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(onOptOut).not.toHaveBeenCalled();
	});

	it('"Not now" closes only — no setMyDefault, no opt-out', async () => {
		const onOptOut = vi.fn();
		const onClose = vi.fn();
		const user = userEvent.setup();
		renderPrompt({ onOptOut, onClose });
		await screen.findByText("Developer");

		await user.click(screen.getByRole("button", { name: /not now/i }));

		expect(onClose).toHaveBeenCalled();
		expect(setMyDefault).not.toHaveBeenCalled();
		expect(onOptOut).not.toHaveBeenCalled();
	});

	it('"Don\'t ask again" opts out then closes', async () => {
		const optGate = deferred<void>();
		const onOptOut = vi.fn(() => optGate.promise);
		const onClose = vi.fn();
		const user = userEvent.setup();
		renderPrompt({ onOptOut, onClose });
		await screen.findByText("Developer");

		await user.click(
			screen.getByRole("button", { name: /don't ask again/i }),
		);

		await waitFor(() => expect(onOptOut).toHaveBeenCalled());
		expect(onClose).not.toHaveBeenCalled(); // waits for opt-out to resolve
		optGate.resolve();
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(setMyDefault).not.toHaveBeenCalled();
	});

	it("the X close button closes without opting out (session dismiss)", async () => {
		const onOptOut = vi.fn();
		const onClose = vi.fn();
		const user = userEvent.setup();
		renderPrompt({ onOptOut, onClose });
		await screen.findByText("Developer");

		await user.click(screen.getByRole("button", { name: /close/i }));

		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(onOptOut).not.toHaveBeenCalled();
		expect(setMyDefault).not.toHaveBeenCalled();
	});

	it("Escape closes without opting out (same onOpenChange handler)", async () => {
		const onOptOut = vi.fn();
		const onClose = vi.fn();
		renderPrompt({ onOptOut, onClose });
		await screen.findByText("Developer");

		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(onOptOut).not.toHaveBeenCalled();
	});

	it("a rejected Don't-ask-again keeps the modal open and toasts", async () => {
		const onOptOut = vi.fn().mockRejectedValue(new Error("network down"));
		const onClose = vi.fn();
		const user = userEvent.setup();
		renderPrompt({ onOptOut, onClose });
		await screen.findByText("Developer");

		await user.click(
			screen.getByRole("button", { name: /don't ask again/i }),
		);

		await waitFor(() => expect(toastError).toHaveBeenCalled());
		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});

	it("a rejected Save keeps the modal open and toasts", async () => {
		setMyDefault.mockRejectedValue(new Error("network down"));
		const onOptOut = vi.fn();
		const onClose = vi.fn();
		const user = userEvent.setup();
		renderPrompt({ onOptOut, onClose });
		await screen.findByText("Developer");

		await user.click(screen.getByRole("button", { name: /^save$/i }));

		await waitFor(() => expect(toastError).toHaveBeenCalled());
		expect(onClose).not.toHaveBeenCalled();
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});

	it("with the target empty-default read, Save stays disabled and cannot persist [] (Codex F2)", async () => {
		getMyDefault.mockResolvedValue({ tags: [] });
		const onOptOut = vi.fn();
		const onClose = vi.fn();
		const user = userEvent.setup();
		renderPrompt({ onOptOut, onClose });

		// Read resolved to [] — the picker is enabled (read succeeded) but Save
		// must stay disabled because nothing is selected, so a no-selection
		// Save can't write [] and leave the user re-eligible.
		await waitFor(() =>
			expect(
				screen.getByLabelText("Your default function tags"),
			).not.toBeDisabled(),
		);
		const saveButton = screen.getByRole("button", { name: /^save$/i });
		expect(saveButton).toBeDisabled();
		await user.click(saveButton);
		expect(setMyDefault).not.toHaveBeenCalled();
	});

	it("keeps the picker and Save disabled while getMyDefault is pending, blocks Save from firing setMyDefault, then enables once it resolves", async () => {
		// Hold the read open so we can observe the pre-resolution state — a
		// gate written as `disabled={busy}` (mutation state only, no read
		// gate) would leave the picker and Save enabled here even though
		// `data`/`value` are still empty, letting a click persist `{ tags: [] }`
		// over the user's real defaults.
		let resolveDefault!: (v: { tags: string[] }) => void;
		getMyDefault.mockReturnValue(
			new Promise((resolve) => {
				resolveDefault = resolve;
			}),
		);
		const onOptOut = vi.fn();
		const onClose = vi.fn();

		const user = userEvent.setup();
		renderPrompt({ onOptOut, onClose });

		const picker = screen.getByLabelText("Your default function tags");
		const saveButton = screen.getByRole("button", { name: /^save$/i });
		expect(picker).toBeDisabled();
		expect(saveButton).toBeDisabled();

		// Clicking a disabled Save must not reach the mutation.
		await user.click(saveButton);
		expect(setMyDefault).not.toHaveBeenCalled();
		expect(onOptOut).not.toHaveBeenCalled();

		resolveDefault({ tags: ["DEVELOPER"] });
		await screen.findByText("Developer");

		await waitFor(() => {
			expect(
				screen.getByLabelText("Your default function tags"),
			).not.toBeDisabled();
			expect(
				screen.getByRole("button", { name: /^save$/i }),
			).not.toBeDisabled();
		});
	});

	it("keeps the picker and Save disabled when getMyDefault REJECTS (React Query v5: isLoading/isPending goes false on error too)", async () => {
		getMyDefault.mockRejectedValue(new Error("network down"));
		const onOptOut = vi.fn();
		const onClose = vi.fn();

		renderPrompt({ onOptOut, onClose });

		await waitFor(() => {
			expect(
				screen.getByLabelText("Your default function tags"),
			).toBeDisabled();
			expect(
				screen.getByRole("button", { name: /^save$/i }),
			).toBeDisabled();
		});
		expect(setMyDefault).not.toHaveBeenCalled();
	});
});
