/**
 * History's rows for an upload nobody finished (Fizzy #2878 follow-up). An
 * upload that stays RECEIVING for more than an hour is not being checked: no
 * workflow was ever started for it. History says so ("Upload did not finish")
 * and offers to discard it, which the "Checking" rows it used to be mistaken
 * for never could.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () =>
	(await import("../../../__tests__/en-copy")).nextIntlMock(),
);

const m = vi.hoisted(() => ({
	remove: vi.fn(),
	confirm: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
	toast: { success: m.toastSuccess, error: m.toastError, info: vi.fn() },
}));
vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: m.confirm }),
}));

function mutationOptionsStub(fn: (input: unknown) => Promise<unknown>) {
	return (opts: Record<string, unknown> = {}) => ({
		mutationFn: fn,
		...opts,
	});
}

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				delete: {
					mutationOptions: mutationOptionsStub((i) => m.remove(i)),
				},
				publish: {
					mutationOptions: mutationOptionsStub(async () => ({})),
				},
				createDownloadUrl: {
					mutationOptions: mutationOptionsStub(async () => ({})),
				},
			},
		},
	},
}));

import { InstructionsHistory } from "../InstructionsHistory";

const minutesAgo = (minutes: number) =>
	new Date(Date.now() - minutes * 60_000).toISOString();

function row(over: Record<string, unknown> = {}) {
	return {
		id: "snap_1",
		version: 4,
		status: "RECEIVING",
		source: "UPLOAD",
		fileCount: 12,
		createdAt: minutesAgo(180),
		user: { name: "Alex Example" },
		proposalStatus: null,
		...over,
	};
}

function Providers({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

function renderHistory(
	snapshots: Array<ReturnType<typeof row>>,
	props: Partial<ComponentProps<typeof InstructionsHistory>> = {},
) {
	const onChanged = vi.fn();
	render(
		<InstructionsHistory
			projectId="proj_1"
			open
			onOpenChange={() => undefined}
			snapshots={snapshots as never}
			publishedId={null}
			publishedVersion={null}
			onChanged={onChanged}
			{...props}
		/>,
		{ wrapper: Providers },
	);
	return { onChanged };
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

describe("InstructionsHistory and an upload that did not finish", () => {
	it("reads an upload still RECEIVING after an hour as one that did not finish", () => {
		renderHistory([row()]);

		expect(screen.getByText("Upload did not finish")).toBeInTheDocument();
		expect(screen.queryByText("Checking")).not.toBeInTheDocument();
	});

	it("offers to discard it, asks first, and deletes it", async () => {
		const user = userEvent.setup();
		const { onChanged } = renderHistory([row()]);

		await user.click(screen.getByRole("button", { name: "Discard" }));

		expect(m.confirm).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Discard this upload?",
				confirmLabel: "Discard upload",
				destructive: true,
			}),
		);
		await waitFor(() =>
			expect(m.remove).toHaveBeenCalledWith({
				projectId: "proj_1",
				snapshotId: "snap_1",
			}),
		);
		await waitFor(() => expect(onChanged).toHaveBeenCalled());
	});

	it("keeps calling a recent RECEIVING upload one being checked, with nothing to discard", () => {
		renderHistory([row({ createdAt: minutesAgo(10) })]);

		expect(screen.getByText("Checking")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Discard" }),
		).not.toBeInTheDocument();
	});

	it("never offers a discard for a VALIDATING upload, however old", () => {
		renderHistory([
			row({ status: "VALIDATING", createdAt: minutesAgo(600) }),
		]);

		expect(screen.getByText("Checking")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Discard" }),
		).not.toBeInTheDocument();
	});

	it("does not call a repository sync's old RECEIVING snapshot an upload that did not finish", () => {
		renderHistory([row({ source: "REPOSITORY" })]);

		expect(screen.getByText("Checking")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Discard" }),
		).not.toBeInTheDocument();
	});

	it("says it did not finish to a reader, who is offered nothing to do about it", () => {
		renderHistory([row()], { canMutate: false });

		expect(screen.getByText("Upload did not finish")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Discard" }),
		).not.toBeInTheDocument();
	});
});
