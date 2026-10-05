/**
 * The status line of a move of uploaded instructions into a repository (Fizzy
 * #2878 §9), one line per state the server reports, with Cancel move and Retry
 * for the members who may. Copy is the real `en.json`; a sentence nobody wrote
 * fails here rather than rendering as a key.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	RepositoryMigrationRead,
	RepositoryMigrationView,
} from "../../../lib/instructions-migration";
import type {
	RepositoryMigrationControls,
	RepositorySyncState,
} from "../../../lib/instructions-repository-sync";

vi.mock("next-intl", async () =>
	(await import("../../../__tests__/en-copy")).nextIntlMock(),
);

const m = vi.hoisted(() => ({
	cancel: vi.fn(),
	retry: vi.fn(),
	confirm: vi.fn(),
	toastSuccess: vi.fn(),
	toastInfo: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
	toast: {
		success: (...a: unknown[]) => m.toastSuccess(...a),
		info: (...a: unknown[]) => m.toastInfo(...a),
		error: (...a: unknown[]) => m.toastError(...a),
	},
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
				repositorySync: {
					cancelMigration: {
						mutationOptions: mutationOptionsStub((i) =>
							m.cancel(i),
						),
					},
					retryMigration: {
						mutationOptions: mutationOptionsStub((i) => m.retry(i)),
					},
				},
			},
		},
	},
}));

import { RepositorySyncStatus } from "../RepositorySyncStatus";

function Providers({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

const CONFIGURED = {
	syncId: "sync_1",
	repositoryIntegrationId: "int_1",
	provider: "GITHUB",
	repositoryOwner: "example-org",
	repositoryName: "instructions",
	repositoryUrl: "https://github.com/example-org/instructions.git",
	integrationStatus: "ACTIVE",
	ref: "main",
	rootPath: "docs/instructions",
	automatic: true,
	automaticPausedReason: "MIGRATING",
	automaticPausedAt: null,
	delegateName: null,
};

function stateOf(
	migration: RepositorySyncState["migration"],
): RepositorySyncState {
	return {
		sourceOfTruth: "UPLOAD",
		canConfigure: true,
		running: false,
		configured: migration ? CONFIGURED : null,
		latestRun: null,
		availableIntegrations: [],
		migration,
	};
}

function moveOf(
	overrides: Partial<RepositoryMigrationView> = {},
): RepositoryMigrationView {
	return {
		state: "OPEN",
		closing: false,
		startedAt: "2026-10-02T10:00:00.000Z",
		startedByUserId: "user-1",
		snapshotId: "snap-1",
		branchId: "branch-1",
		syncId: "sync_1",
		pullRequest: {
			url: "https://example.com/pull/12",
			externalId: "12",
			state: "OPEN",
		},
		targetMismatch: false,
		failure: null,
		...overrides,
	};
}

function readOf(
	overrides: Partial<RepositoryMigrationView> = {},
): RepositoryMigrationRead {
	return {
		migration: moveOf(overrides),
		repository: {
			provider: "GITHUB",
			owner: "example-org",
			name: "instructions",
			ref: "main",
			folder: "docs/instructions",
		},
	};
}

function renderStatus({
	read,
	canManage = true,
	pointer = "PROPOSING",
	endedNotice = null,
}: {
	read: RepositoryMigrationRead | undefined;
	canManage?: boolean;
	pointer?: "PROPOSING" | "SWITCHING";
	endedNotice?: {
		pullRequest: string | null;
		repository: string | null;
	} | null;
}) {
	const onMigrationChanged = vi.fn(async (): Promise<void> => {});
	const onDismissEndedNotice = vi.fn();
	const migration: RepositoryMigrationControls = {
		read,
		endedNotice,
		onDismissEndedNotice,
	};
	render(
		<RepositorySyncStatus
			projectId="proj_1"
			state={stateOf({ state: pointer })}
			migration={migration}
			canManageMigration={canManage}
			onMigrationChanged={onMigrationChanged}
		/>,
		{ wrapper: Providers },
	);
	return { onMigrationChanged, onDismissEndedNotice };
}

beforeEach(() => {
	for (const fn of Object.values(m)) {
		fn.mockReset();
	}
	m.cancel.mockResolvedValue({ state: "CANCELING" });
	m.retry.mockResolvedValue({ retried: true });
	m.confirm.mockImplementation((options: { onConfirm: () => void }) =>
		options.onConfirm(),
	);
});

describe("the status line of a move, per state", () => {
	it("says the pull request is being prepared", () => {
		renderStatus({
			read: readOf({ state: "PROPOSING", pullRequest: null }),
		});

		expect(screen.getByRole("status")).toHaveTextContent(
			"Preparing the pull request…",
		);
	});

	it("names the repository while the first read of the move is still on its way", () => {
		renderStatus({ read: undefined });

		expect(screen.getByRole("status")).toHaveTextContent(
			"Moving these instructions to example-org/instructions (main)…",
		);
	});

	it("says an open pull request awaits its merge and that the instructions stay as published", () => {
		renderStatus({ read: readOf({ state: "OPEN" }) });

		expect(screen.getByRole("status")).toHaveTextContent(
			"Moving to example-org/instructions (main): pull request #12 awaiting merge — instructions stay as published until it merges",
		);
		expect(
			screen.getByRole("link", { name: "View pull request" }),
		).toHaveAttribute("href", "https://example.com/pull/12");
	});

	it("never links an address that is not https", () => {
		renderStatus({
			read: readOf({
				state: "OPEN",
				pullRequest: {
					url: "javascript:alert(1)",
					externalId: "12",
					state: "OPEN",
				},
			}),
		});

		expect(screen.queryByRole("link")).not.toBeInTheDocument();
	});

	it("says the pull request is being closed while a cancel settles, with nothing to press", () => {
		renderStatus({ read: readOf({ state: "OPEN", closing: true }) });

		expect(screen.getByRole("status")).toHaveTextContent(
			"Closing pull request #12…",
		);
		expect(
			screen.queryByRole("button", { name: "Cancel move" }),
		).not.toBeInTheDocument();
	});

	it.each(["MERGED", "SWITCHING"] as const)(
		"says a %s move is switching the project over, with nothing to press",
		(state) => {
			renderStatus({
				read: readOf({ state }),
				pointer: state === "SWITCHING" ? "SWITCHING" : "PROPOSING",
			});

			expect(screen.getByRole("status")).toHaveTextContent(
				"Merged — switching the project to the repository…",
			);
			expect(screen.queryByRole("button")).not.toBeInTheDocument();
		},
	);

	it("says a closed pull request ended the move and leaves the instructions as published", () => {
		renderStatus({
			read: readOf({
				state: "ABANDONED",
				pullRequest: {
					url: "https://example.com/pull/12",
					externalId: "12",
					state: "CLOSED",
				},
			}),
		});

		expect(screen.getByRole("status")).toHaveTextContent(
			"Pull request #12 was closed without merging, so the move has ended. The instructions stay as published.",
		);
	});

	it("says a pull request merged into another branch was not synced, and leaves the instructions as published", () => {
		renderStatus({
			read: readOf({
				state: "ABANDONED",
				targetMismatch: true,
				pullRequest: {
					url: "https://example.com/pull/12",
					externalId: "12",
					state: "MERGED",
				},
			}),
		});

		expect(screen.getByRole("status")).toHaveTextContent(
			"Pull request #12 was merged into another branch; Fabric did not sync it, so the move has ended. The instructions stay as published.",
		);
		expect(
			screen.getByRole("button", { name: "Cancel move" }),
		).toBeInTheDocument();
	});

	it("says a project switched to the repository behind the move's back can only leave through upload mode", () => {
		renderStatus({
			read: readOf({
				state: "BLOCKED",
				pullRequest: null,
				failure: { code: "SOURCE_FLIPPED", retryable: false },
			}),
		});

		expect(screen.getByRole("status")).toHaveTextContent(
			"Moving to example-org/instructions (main) is blocked. This project was switched to example-org/instructions outside the move, so the move can't continue. Switch the project back to upload mode in Settings.",
		);
		expect(
			screen.queryByRole("button", { name: "Retry" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Cancel move" }),
		).not.toBeInTheDocument();
	});

	it("does not describe the paused sync as a sync to re-enable", () => {
		renderStatus({ read: readOf({ state: "OPEN" }) });

		expect(screen.queryByText(/paused/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/Re-enable/)).not.toBeInTheDocument();
	});
});

describe("a blocked move", () => {
	const BLOCKED = (code: string, retryable: boolean) =>
		readOf({
			state: "BLOCKED",
			pullRequest: null,
			failure: { code, retryable },
		});

	it("says what went wrong, in words chosen by the failure's code, and offers Retry when it can help", async () => {
		const user = userEvent.setup();
		const { onMigrationChanged } = renderStatus({
			read: BLOCKED("AUTHENTICATION_FAILED", true),
		});

		expect(screen.getByRole("status")).toHaveTextContent(
			"Moving to example-org/instructions (main) is blocked. Fabric can't reach example-org/instructions with the connection it has. Reconnect it in the project's repository settings, then retry.",
		);
		await user.click(screen.getByRole("button", { name: "Retry" }));

		await waitFor(() =>
			expect(m.retry).toHaveBeenCalledWith({ projectId: "proj_1" }),
		);
		await waitFor(() => expect(onMigrationChanged).toHaveBeenCalled());
		expect(m.toastSuccess).toHaveBeenCalledWith("Retrying the move.");
	});

	it("offers only Cancel move when no retry can fix it", () => {
		renderStatus({ read: BLOCKED("TARGET_BRANCH_MISSING", false) });

		expect(screen.getByRole("status")).toHaveTextContent(
			"The branch main no longer exists in example-org/instructions. Cancel the move and start it again.",
		);
		expect(
			screen.queryByRole("button", { name: "Retry" }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Cancel move" }),
		).toBeInTheDocument();
	});

	it("falls back to a generic sentence for a code it does not know, never server text", () => {
		renderStatus({ read: BLOCKED("SOMETHING_NEW", true) });

		expect(screen.getByRole("status")).toHaveTextContent(
			"The move ran into a problem it can't describe. Retry, or cancel the move and start it again.",
		);
	});

	it("says a retry can't fix it when the server says so", async () => {
		const user = userEvent.setup();
		m.retry.mockRejectedValue(
			Object.assign(new Error("TEXT THAT MUST NOT BE SHOWN"), {
				code: "PRECONDITION_FAILED",
				data: { reason: "MIGRATION_NOT_RETRYABLE" },
			}),
		);
		renderStatus({ read: BLOCKED("AUTHENTICATION_FAILED", true) });

		await user.click(screen.getByRole("button", { name: "Retry" }));

		await waitFor(() =>
			expect(m.toastError).toHaveBeenCalledWith(
				"A retry can't fix this. Cancel the move and start it again.",
			),
		);
	});
});

describe("cancelling a move", () => {
	it("asks first, destructively, then cancels and says the pull request is closing", async () => {
		const user = userEvent.setup();
		const { onMigrationChanged } = renderStatus({
			read: readOf({ state: "OPEN" }),
		});

		await user.click(screen.getByRole("button", { name: "Cancel move" }));

		expect(m.confirm).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Cancel the move to example-org/instructions?",
				confirmLabel: "Cancel move",
				destructive: true,
			}),
		);
		await waitFor(() =>
			expect(m.cancel).toHaveBeenCalledWith({ projectId: "proj_1" }),
		);
		await waitFor(() => expect(onMigrationChanged).toHaveBeenCalled());
		expect(m.toastSuccess).toHaveBeenCalledWith(
			"Closing the pull request. Changes unlock once it is closed.",
		);
	});

	it("says the move is canceled when nothing was open to close", async () => {
		const user = userEvent.setup();
		m.cancel.mockResolvedValue({ state: "ABANDONED" });
		renderStatus({
			read: readOf({ state: "PROPOSING", pullRequest: null }),
		});

		await user.click(screen.getByRole("button", { name: "Cancel move" }));

		await waitFor(() =>
			expect(m.toastSuccess).toHaveBeenCalledWith(
				"The move was canceled.",
			),
		);
	});

	it.each([
		[
			"MIGRATION_MERGED",
			"The pull request was merged, so the move can't be canceled: the project is switching to the repository.",
		],
		[
			"MIGRATION_PREPARING",
			"The move is still being prepared. Try again in a moment.",
		],
		[
			"MIGRATION_CHANGED",
			"The pull request changed just now. Refresh and try again.",
		],
		["MIGRATION_NOT_OPEN", "No move is open any more."],
		[
			"MIGRATION_SOURCE_FLIPPED",
			"This project was switched to its repository outside this move, so the move can't be canceled. Switch the project back to upload mode instead.",
		],
	])("words %s in a plain sentence", async (reason, sentence) => {
		const user = userEvent.setup();
		m.cancel.mockRejectedValue(
			Object.assign(new Error("TEXT THAT MUST NOT BE SHOWN"), {
				code: "CONFLICT",
				data: { reason },
			}),
		);
		renderStatus({ read: readOf({ state: "OPEN" }) });

		await user.click(screen.getByRole("button", { name: "Cancel move" }));

		await waitFor(() =>
			expect(m.toastError).toHaveBeenCalledWith(sentence),
		);
	});
});

describe("who sees what", () => {
	it.each([
		["OPEN", readOf({ state: "OPEN" })],
		[
			"BLOCKED",
			readOf({
				state: "BLOCKED",
				failure: { code: "AUTHENTICATION_FAILED", retryable: true },
			}),
		],
		["ABANDONED", readOf({ state: "ABANDONED" })],
		["PROPOSING", readOf({ state: "PROPOSING", pullRequest: null })],
	])("shows a reader the %s status and no way to change it", (_s, read) => {
		renderStatus({ read, canManage: false });

		expect(screen.getByRole("status")).not.toBeEmptyDOMElement();
		expect(
			screen.queryByRole("button", { name: /Cancel move|Retry/ }),
		).not.toBeInTheDocument();
	});
});

describe("the notice a move that ended without merging leaves", () => {
	it("names the repository and the pull request, and goes when it is dismissed", async () => {
		const user = userEvent.setup();
		const onDismissEndedNotice = vi.fn();
		render(
			<RepositorySyncStatus
				projectId="proj_1"
				state={stateOf(null)}
				migration={{
					read: undefined,
					endedNotice: {
						pullRequest: "12",
						repository: "example-org/instructions",
					},
					onDismissEndedNotice,
				}}
				canManageMigration
			/>,
			{ wrapper: Providers },
		);

		expect(screen.getByRole("status")).toHaveTextContent(
			"The move to example-org/instructions ended: pull request #12 was closed without merging. The instructions stay as published.",
		);
		await user.click(screen.getByRole("button", { name: "Dismiss" }));

		expect(onDismissEndedNotice).toHaveBeenCalledTimes(1);
	});

	it("says a pull request merged into another branch, once the move is gone", () => {
		render(
			<RepositorySyncStatus
				projectId="proj_1"
				state={stateOf(null)}
				migration={{
					read: undefined,
					endedNotice: {
						pullRequest: "12",
						repository: "example-org/instructions",
						mergedElsewhere: true,
					},
					onDismissEndedNotice: vi.fn(),
				}}
			/>,
			{ wrapper: Providers },
		);

		expect(screen.getByRole("status")).toHaveTextContent(
			"The move to example-org/instructions ended: pull request #12 was merged into another branch; Fabric did not sync it. The instructions stay as published.",
		);
	});

	it("says the same without a pull request when none was ever opened", () => {
		render(
			<RepositorySyncStatus
				projectId="proj_1"
				state={stateOf(null)}
				migration={{
					read: undefined,
					endedNotice: { pullRequest: null, repository: null },
					onDismissEndedNotice: vi.fn(),
				}}
			/>,
			{ wrapper: Providers },
		);

		expect(screen.getByRole("status")).toHaveTextContent(
			"The move to the repository ended before its pull request was merged. The instructions stay as published.",
		);
	});
});
