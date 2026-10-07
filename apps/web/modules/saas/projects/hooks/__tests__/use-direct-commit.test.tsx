/**
 * "Committed" is announced after the page has re-read what the commit
 * changed, so the old file never sits under the toast.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	toastSuccess: vi.fn(),
	onSettled: null as ((result: unknown) => void) | null,
}));

vi.mock("next-intl", () => ({
	useTranslations: () => (key: string) => key,
}));
vi.mock("sonner", () => ({
	toast: { success: m.toastSuccess, error: vi.fn(), info: vi.fn() },
}));
vi.mock("../use-instruction-action-error", () => ({
	useInstructionActionError: () => () => "error",
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			instructions: {
				commitChange: async () => ({
					kind: "native",
					operationId: "operation-1",
				}),
			},
		},
	},
}));
vi.mock("../../components/instructions/DirectCommitStatus", () => ({
	DirectCommitBranchMovedDialog: () => null,
	DirectCommitPullRequestAlert: () => null,
	DirectCommitWatcher: (props: { onSettled: (result: unknown) => void }) => {
		m.onSettled = props.onSettled;
		return null;
	},
}));

import { useDirectCommit } from "../use-direct-commit";

function Harness({
	onChanged,
	onFinished,
}: {
	onChanged: () => Promise<void>;
	onFinished: () => void;
}) {
	const commit = useDirectCommit({
		projectId: "p",
		branch: "main",
		onChanged,
		onFinished,
	});
	return (
		<>
			<button
				type="button"
				onClick={() =>
					commit.start({
						message: "Update",
						changes: [],
						nativeBase: {
							generation: 1,
							commitSha: "a".repeat(40),
						},
					})
				}
			>
				commit
			</button>
			{commit.status}
		</>
	);
}

describe("useDirectCommit", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		m.onSettled = null;
	});

	it("announces the commit only after the page has been re-read", async () => {
		let finishReread = () => {};
		const reread = new Promise<void>((resolve) => {
			finishReread = resolve;
		});
		const onChanged = vi.fn(() => reread);
		const onFinished = vi.fn();
		const view = render(
			<QueryClientProvider client={new QueryClient()}>
				<Harness onChanged={onChanged} onFinished={onFinished} />
			</QueryClientProvider>,
		);
		view.getByRole("button", { name: "commit" }).click();
		await waitFor(() => expect(m.onSettled).not.toBeNull());

		act(() => {
			m.onSettled?.({
				kind: "committed",
				sha: "b".repeat(40),
				ref: "main",
			});
		});
		await waitFor(() => expect(onChanged).toHaveBeenCalled());
		expect(m.toastSuccess).not.toHaveBeenCalled();
		expect(onFinished).not.toHaveBeenCalled();

		await act(async () => {
			finishReread();
		});
		await waitFor(() => expect(m.toastSuccess).toHaveBeenCalledTimes(1));
		expect(onFinished).toHaveBeenCalledTimes(1);
	});
});
