/**
 * "Discard this upload" (Fizzy #2878 follow-up): the delete of an upload that
 * never finished, behind a destructive confirmation. The header's "Checking
 * your upload" state and History's "Upload did not finish" row share it.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () =>
	(await import("../../__tests__/en-copy")).nextIntlMock(),
);

const m = vi.hoisted(() => ({
	remove: vi.fn(),
	confirm: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: m.confirm }),
}));
vi.mock("sonner", () => ({
	toast: { success: m.toastSuccess, error: m.toastError, info: vi.fn() },
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				delete: {
					mutationOptions: (opts: Record<string, unknown> = {}) => ({
						mutationFn: (input: unknown) => m.remove(input),
						...opts,
					}),
				},
			},
		},
	},
}));

import { useDiscardUpload } from "../use-discard-upload";

function Providers({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

function setup() {
	const onChanged = vi.fn();
	const hook = renderHook(
		() => useDiscardUpload({ projectId: "proj_1", onChanged }),
		{ wrapper: Providers },
	);
	return { ...hook, onChanged };
}

beforeEach(() => {
	for (const fn of Object.values(m)) {
		fn.mockReset();
	}
	m.remove.mockResolvedValue({ deleted: true });
	m.confirm.mockImplementation((options: { onConfirm: () => void }) =>
		options.onConfirm(),
	);
});

describe("useDiscardUpload", () => {
	it("asks first, destructively, in words about an upload that never finished", () => {
		const { result } = setup();

		act(() => result.current.discard("snap_1"));

		expect(m.confirm).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Discard this upload?",
				message:
					"It never finished uploading, so nothing from it was kept or published. You can upload again afterwards.",
				confirmLabel: "Discard upload",
				destructive: true,
			}),
		);
	});

	it("deletes the snapshot, says so, and has the tab re-read", async () => {
		const { result, onChanged } = setup();

		act(() => result.current.discard("snap_1"));

		await waitFor(() =>
			expect(m.remove).toHaveBeenCalledWith({
				projectId: "proj_1",
				snapshotId: "snap_1",
			}),
		);
		await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
		expect(m.toastSuccess).toHaveBeenCalledWith("Upload discarded.");
	});

	it("deletes nothing when the confirmation is declined", () => {
		m.confirm.mockImplementation(() => undefined);
		const { result } = setup();

		act(() => result.current.discard("snap_1"));

		expect(m.remove).not.toHaveBeenCalled();
	});

	it("words a refusal by its code, never the server's text, and re-reads", async () => {
		m.remove.mockRejectedValue(
			Object.assign(new Error("TEXT THAT MUST NOT BE SHOWN"), {
				code: "CONFLICT",
			}),
		);
		const { result, onChanged } = setup();

		act(() => result.current.discard("snap_1"));

		await waitFor(() =>
			expect(m.toastError).toHaveBeenCalledWith(
				"This changed while you were working. Refresh and try again.",
			),
		);
		expect(onChanged).toHaveBeenCalledTimes(1);
	});

	it("reports it is working while the delete is in flight", async () => {
		let finish: (value: unknown) => void = () => {};
		m.remove.mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		const { result } = setup();

		act(() => result.current.discard("snap_1"));

		await waitFor(() => expect(result.current.pending).toBe(true));
		finish({ deleted: true });
		await waitFor(() => expect(result.current.pending).toBe(false));
	});
});
