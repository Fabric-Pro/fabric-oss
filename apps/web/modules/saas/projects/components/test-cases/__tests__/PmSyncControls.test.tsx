/**
 * PmSyncControls — Unlink & re-create for a test case (Fizzy #3045).
 *
 * A case whose earlier create may already exist in the PM tool (an
 * unconfirmed or orphaned create, which keeps the case's create claim) fails
 * every later push until the user clears it: a plain Retry can only fail
 * again. Such a FAILED message names "Unlink & re-create"; the controls then
 * offer that action, behind a confirmation, instead of Retry, and, while the
 * case has no PM link, Link to existing item, which links the case to the PM
 * item the user names and creates nothing.
 *
 * next-intl is globally key-mocked in vitest.setup.ts (labels === keys).
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MutationOptions = {
	key: string;
	onSuccess?: (data: unknown) => void;
	onError?: (error: Error) => void;
};

const h = vi.hoisted(() => ({
	mutate: {} as Record<string, ReturnType<typeof vi.fn>>,
	mutateAsync: {} as Record<string, ReturnType<typeof vi.fn>>,
	invalidateQueries: vi.fn(),
	options: {} as Record<string, MutationOptions>,
	confirm: vi.fn(),
	canPush: true,
	toast: {
		success: vi.fn(),
		error: vi.fn(),
		message: vi.fn(),
	},
}));

vi.mock("@tanstack/react-query", () => ({
	useMutation: (options: MutationOptions) => {
		h.options[options.key] = options;
		h.mutate[options.key] ??= vi.fn();
		h.mutateAsync[options.key] ??= vi.fn();
		return {
			mutate: h.mutate[options.key],
			mutateAsync: h.mutateAsync[options.key],
			isPending: false,
		};
	},
	useQueryClient: () => ({ invalidateQueries: h.invalidateQueries }),
}));

vi.mock("sonner", () => ({ toast: h.toast }));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: h.confirm }),
}));

vi.mock("../use-test-case-sync-capability", () => ({
	useTestCaseSyncCapability: () => ({
		canPush: h.canPush,
		unsupportedCopy: "not supported",
	}),
}));

vi.mock("@shared/lib/orpc-query-utils", () => {
	const mutation = (key: string) => ({
		mutationOptions: (opts: object) => ({ ...opts, key }),
	});
	return {
		orpc: {
			projects: {
				testCases: {
					list: { key: () => ["cases"] },
					get: { queryKey: () => ["case"] },
					sync: {
						bulk: mutation("bulk"),
						retry: mutation("retry"),
						dismiss: mutation("dismiss"),
						linkPmItem: mutation("linkPmItem"),
					},
				},
			},
		},
	};
});

import { PmSyncControls } from "../PmSyncControls";

const UNCONFIRMED =
	"The create request to fizzy failed (timed out), and Fabric cannot tell whether fizzy created the item anyway, so a fizzy item may already exist for it. Check fizzy; if there is none, fix the cause if needed and use Unlink & re-create.";
const LEGACY_OTHER_TOOL =
	"This item is linked to a ticket in a different PM tool, so Fabric did not create a new one in fizzy. To make a new ticket in fizzy, use Unlink & re-create (the old ticket is not deleted).";

function renderControls(
	status: "FAILED" | "CONFLICT" | "SUCCESS",
	error: string | null,
	externalId: string | null = null,
) {
	return render(
		<PmSyncControls
			projectId="p1"
			organizationId="org-1"
			testCaseId="tc1"
			externalId={externalId}
			pmAutoSyncEnabled={false}
			onToggle={vi.fn()}
			lastPmSyncStatus={status}
			lastPmSyncError={error}
		/>,
	);
}

beforeEach(() => {
	for (const spy of [
		...Object.values(h.mutate),
		...Object.values(h.mutateAsync),
	]) {
		spy.mockReset();
	}
	h.invalidateQueries.mockReset();
	h.confirm.mockReset();
	h.canPush = true;
	for (const spy of Object.values(h.toast)) {
		spy.mockReset();
	}
});

describe("PmSyncControls Unlink & re-create", () => {
	it.each([
		["an unconfirmed or orphaned create", UNCONFIRMED],
		["a legacy link to another PM tool", LEGACY_OTHER_TOOL],
	])(
		"offers Unlink & re-create instead of Retry for %s, behind a confirmation",
		(_label, error) => {
			renderControls("FAILED", error);

			expect(
				screen.queryByRole("button", { name: "sync.retry" }),
			).toBeNull();
			fireEvent.click(
				screen.getByRole("button", { name: "sync.unlinkRecreate" }),
			);

			// Nothing is sent until the user confirms.
			expect(h.mutate.retry).not.toHaveBeenCalled();
			expect(h.confirm).toHaveBeenCalledTimes(1);
			const options = h.confirm.mock.calls[0]?.[0] as {
				title: string;
				message: string;
				confirmLabel: string;
				cancelLabel: string;
				destructive: boolean;
				onConfirm: () => void;
			};
			expect(options).toMatchObject({
				title: "sync.unlinkRecreateTitle",
				message: "sync.unlinkRecreateMessage",
				confirmLabel: "sync.unlinkRecreate",
				cancelLabel: "actions.cancel",
				destructive: true,
			});

			options.onConfirm();

			expect(h.mutate.retry).toHaveBeenCalledWith({
				projectId: "p1",
				testCaseId: "tc1",
				organizationId: "org-1",
				unlinkFirst: true,
			});
		},
	);

	it("an ordinary failure keeps the plain Retry", () => {
		renderControls("FAILED", "Failed to update work item 7: 500");

		expect(
			screen.queryByRole("button", { name: "sync.unlinkRecreate" }),
		).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "sync.retry" }));

		expect(h.confirm).not.toHaveBeenCalled();
		expect(h.mutate.retry).toHaveBeenCalledWith({
			projectId: "p1",
			testCaseId: "tc1",
			organizationId: "org-1",
		});
	});

	it("is not offered on a CONFLICT, whatever its text", () => {
		renderControls("CONFLICT", UNCONFIRMED);

		expect(
			screen.queryByRole("button", { name: "sync.unlinkRecreate" }),
		).toBeNull();
		expect(screen.getByRole("button", { name: "sync.retry" })).toBeTruthy();
	});

	it("is disabled when the connected tool cannot take test cases", () => {
		h.canPush = false;
		renderControls("FAILED", UNCONFIRMED);

		const button = screen.getByRole("button", {
			name: "sync.unlinkRecreate",
		}) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
	});

	it("says so when a push of the case is already running", () => {
		renderControls("FAILED", UNCONFIRMED);

		h.options.retry?.onSuccess?.({
			enqueued: false,
			reason: "already-running",
		});

		expect(h.toast.message).toHaveBeenCalledWith("sync.alreadyRunning");
		expect(h.toast.error).not.toHaveBeenCalled();
	});

	it("shows the server's message when the case changed since it was loaded", () => {
		renderControls("FAILED", UNCONFIRMED);

		h.options.retry?.onError?.(new Error("This item's PM link changed"));

		expect(h.toast.error).toHaveBeenCalledWith(
			"This item's PM link changed",
		);
	});
});

describe("PmSyncControls Link to existing item", () => {
	it("links an unlinked case to the item the user names, trimmed", async () => {
		renderControls("FAILED", UNCONFIRMED);
		h.mutateAsync.linkPmItem?.mockResolvedValue({
			linked: true,
			externalId: "1234",
			externalUrl: null,
		});
		fireEvent.click(
			screen.getByRole("button", { name: "sync.linkExisting" }),
		);

		const field = await screen.findByLabelText("sync.linkExistingLabel");
		// The dialog moves focus to its one field.
		await waitFor(() => expect(document.activeElement).toBe(field));
		fireEvent.change(field, { target: { value: "  1234 " } });
		fireEvent.click(
			screen.getByRole("button", { name: "sync.linkExistingSubmit" }),
		);

		await waitFor(() =>
			expect(h.mutateAsync.linkPmItem).toHaveBeenCalledWith({
				projectId: "p1",
				testCaseId: "tc1",
				organizationId: "org-1",
				externalId: "1234",
			}),
		);
		await waitFor(() =>
			expect(
				screen.queryByLabelText("sync.linkExistingLabel"),
			).toBeNull(),
		);
		// Nothing else is sent: no retry, no push.
		expect(h.mutate.retry).not.toHaveBeenCalled();
		expect(h.mutate.bulk).not.toHaveBeenCalled();
	});

	it.each([
		["Cancel", "cancel"],
		["Escape", "escape"],
	] as const)(
		"returns focus to the opening button when dismissed with %s",
		async (_label, how) => {
			renderControls("FAILED", UNCONFIRMED);
			const opener = screen.getByRole("button", {
				name: "sync.linkExisting",
			});
			fireEvent.click(opener);
			const field = await screen.findByLabelText(
				"sync.linkExistingLabel",
			);

			if (how === "cancel") {
				fireEvent.click(
					screen.getByRole("button", { name: "actions.cancel" }),
				);
			} else {
				fireEvent.keyDown(field, { key: "Escape" });
			}

			await waitFor(() =>
				expect(
					screen.queryByLabelText("sync.linkExistingLabel"),
				).toBeNull(),
			);
			await waitFor(() => expect(document.activeElement).toBe(opener));
			expect(h.mutateAsync.linkPmItem).not.toHaveBeenCalled();
		},
	);

	it("shows the server's refusal in the dialog and keeps it open", async () => {
		renderControls("FAILED", UNCONFIRMED);
		h.mutateAsync.linkPmItem?.mockRejectedValue(
			new Error('Item "1234" was not found in the PM tool.'),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "sync.linkExisting" }),
		);
		fireEvent.change(
			await screen.findByLabelText("sync.linkExistingLabel"),
			{ target: { value: "1234" } },
		);
		fireEvent.click(
			screen.getByRole("button", { name: "sync.linkExistingSubmit" }),
		);

		expect((await screen.findByRole("alert")).textContent).toBe(
			'Item "1234" was not found in the PM tool.',
		);
		expect(screen.getByLabelText("sync.linkExistingLabel")).toBeTruthy();
	});

	it("refreshes the case after a link and after a refusal", () => {
		renderControls("FAILED", UNCONFIRMED);

		h.options.linkPmItem?.onSuccess?.({
			linked: true,
			externalId: "1234",
			externalUrl: null,
		});
		expect(h.invalidateQueries).toHaveBeenCalled();
		expect(h.toast.success).toHaveBeenCalledWith("sync.linkedExisting");

		h.invalidateQueries.mockReset();
		h.options.linkPmItem?.onError?.(new Error("stale"));
		expect(h.invalidateQueries).toHaveBeenCalled();
	});

	it("is hidden when the case is linked", () => {
		renderControls("FAILED", LEGACY_OTHER_TOOL, "777");

		expect(
			screen.getByRole("button", { name: "sync.unlinkRecreate" }),
		).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "sync.linkExisting" }),
		).toBeNull();
	});

	it("is not offered for an ordinary failure", () => {
		renderControls("FAILED", "Failed to update work item 7: 500");

		expect(
			screen.queryByRole("button", { name: "sync.linkExisting" }),
		).toBeNull();
	});
});
