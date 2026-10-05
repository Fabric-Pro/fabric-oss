/**
 * The Settings dialog's Repository section around a move of uploaded
 * instructions into a repository (Fizzy #2878 §9). While a move is open the
 * server refuses every setting the section changes, so the section reports the
 * move and offers none of them.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryMigrationView } from "../../../lib/instructions-migration";
import type { RepositorySyncState } from "../../../lib/instructions-repository-sync";

vi.mock("next-intl", async () =>
	(await import("../../../__tests__/en-copy")).nextIntlMock(),
);

const m = vi.hoisted(() => ({
	confirm: vi.fn(),
	disable: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: m.confirm }),
}));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), info: vi.fn(), error: m.toastError },
}));

function mutationOptionsStub() {
	return (opts: Record<string, unknown> = {}) => ({
		mutationFn: async () => ({}),
		...opts,
	});
}

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				getSettings: {
					queryOptions: (o: { input: unknown }) => ({
						queryKey: ["getSettings", o.input],
						queryFn: async () => ({
							ignoreGlobs: null,
							defaultIgnoreGlobs: [],
							sourceOfTruth: "UPLOAD",
						}),
					}),
				},
				repositorySync: {
					configure: { mutationOptions: mutationOptionsStub() },
					disable: {
						mutationOptions: (
							opts: Record<string, unknown> = {},
						) => ({
							mutationFn: (input: unknown) => m.disable(input),
							...opts,
						}),
					},
					updateProposalSettings: {
						mutationOptions: mutationOptionsStub(),
					},
				},
			},
		},
	},
}));

import { RepositorySyncSettingsSection } from "../RepositorySyncSettingsSection";

function Providers({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

const MOVING: RepositorySyncState = {
	sourceOfTruth: "UPLOAD",
	canConfigure: true,
	running: false,
	configured: {
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
	},
	latestRun: null,
	availableIntegrations: [],
	migration: { state: "PROPOSING" },
};

function renderSection(
	state: RepositorySyncState,
	onMove?: () => void,
	read?: RepositoryMigrationView | null,
) {
	const onChanged = vi.fn(async (): Promise<void> => {});
	render(
		<RepositorySyncSettingsSection
			projectId="proj_1"
			state={state}
			onChange={vi.fn()}
			onChanged={onChanged}
			onMove={onMove}
			migration={
				read === undefined
					? undefined
					: {
							read: { migration: read, repository: null },
							endedNotice: null,
							onDismissEndedNotice: vi.fn(),
						}
			}
		/>,
		{ wrapper: Providers },
	);
	return { onChanged };
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

describe("RepositorySyncSettingsSection while a move into a repository is open", () => {
	it("names where the instructions are moving and says settings are paused", () => {
		renderSection(MOVING);

		expect(
			screen.getByText("example-org/instructions"),
		).toBeInTheDocument();
		expect(screen.getByText("docs/instructions")).toBeInTheDocument();
		expect(
			screen.getByText(
				"These instructions are being moved into this repository. Its settings are paused until the pull request is merged and synced, or the move is canceled.",
			),
		).toBeInTheDocument();
	});

	it("offers none of the settings the server refuses", () => {
		renderSection(MOVING);

		expect(screen.queryByRole("switch")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Change…" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Switch to upload mode" }),
		).not.toBeInTheDocument();
	});

	it("does not describe the sync's pause as something to re-enable", () => {
		renderSection(MOVING);

		expect(screen.queryByText(/Re-enable/)).not.toBeInTheDocument();
	});

	it("still offers the settings of an ordinary repository project", () => {
		renderSection({
			...MOVING,
			sourceOfTruth: "REPOSITORY",
			migration: null,
			configured: MOVING.configured && {
				...MOVING.configured,
				automaticPausedReason: null,
			},
		});

		expect(screen.getAllByRole("switch").length).toBeGreaterThan(0);
		expect(
			screen.getByRole("button", { name: "Switch to upload mode" }),
		).toBeInTheDocument();
	});
});

const UPLOADS: RepositorySyncState = {
	sourceOfTruth: "UPLOAD",
	canConfigure: true,
	running: false,
	configured: null,
	latestRun: null,
	availableIntegrations: [
		{
			id: "int_1",
			provider: "GITHUB",
			repositoryOwner: "example-org",
			repositoryName: "instructions",
			defaultBranch: "main",
		},
	],
	migration: null,
};

describe("RepositorySyncSettingsSection and the way to move uploaded instructions", () => {
	it("offers to move the instructions into a repository, and opens the move when asked", async () => {
		const user = userEvent.setup();
		const onMove = vi.fn();
		renderSection(UPLOADS, onMove);

		expect(
			screen.getByRole("heading", {
				name: "Move these instructions into a repository",
			}),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"Open one pull request that adds the published files to a repository connected to this project. They stay as published until it merges, and then the project syncs from the repository.",
			),
		).toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: "Move to a repository…" }),
		);

		expect(onMove).toHaveBeenCalledTimes(1);
	});

	it("offers nothing to someone the tab did not allow to move them", () => {
		renderSection(UPLOADS);

		expect(
			screen.queryByRole("button", { name: "Move to a repository…" }),
		).not.toBeInTheDocument();
		expect(screen.queryByRole("heading")).not.toBeInTheDocument();
	});

	it("offers nothing when no repository is connected to move into", () => {
		renderSection({ ...UPLOADS, availableIntegrations: [] }, vi.fn());

		expect(screen.queryByRole("heading")).not.toBeInTheDocument();
	});

	it("offers nothing while a move is already open", () => {
		renderSection(MOVING, vi.fn());

		expect(
			screen.queryByRole("button", { name: "Move to a repository…" }),
		).not.toBeInTheDocument();
	});
});

// Cancel cannot end a project that is switching over (the first sync from the
// repository may never succeed) or a blocked move, and the server answers
// `disable` with MIGRATION_OPEN in every other state: switching back to upload
// mode is offered in exactly those two (Fizzy #2878 §9).
describe("RepositorySyncSettingsSection and the way out of a move", () => {
	const SWITCHING: RepositorySyncState = {
		...MOVING,
		sourceOfTruth: "REPOSITORY",
		migration: { state: "SWITCHING" },
	};

	beforeEach(() => {
		for (const fn of Object.values(m)) {
			fn.mockReset();
		}
		m.disable.mockResolvedValue({});
		m.confirm.mockImplementation((options: { onConfirm: () => void }) =>
			options.onConfirm(),
		);
	});

	it("offers Switch to upload mode to a project that is switching over, even before the move is read", () => {
		renderSection(SWITCHING);

		expect(
			screen.getByRole("button", { name: "Switch to upload mode" }),
		).toBeInTheDocument();
	});

	it("offers it for a blocked move, including one whose project was switched behind its back", () => {
		renderSection(
			MOVING,
			undefined,
			moveOf({
				state: "BLOCKED",
				pullRequest: null,
				failure: { code: "SOURCE_FLIPPED", retryable: false },
			}),
		);

		expect(
			screen.getByRole("button", { name: "Switch to upload mode" }),
		).toBeInTheDocument();
	});

	it.each([
		["preparing", moveOf({ state: "PROPOSING", pullRequest: null })],
		["open", moveOf()],
		["merged and settling", moveOf({ state: "MERGED" })],
		["ended", moveOf({ state: "ABANDONED" })],
	])(
		"does not offer it while the move is %s, when the server would refuse",
		(_label, move) => {
			renderSection(MOVING, undefined, move);

			expect(
				screen.queryByRole("button", { name: "Switch to upload mode" }),
			).not.toBeInTheDocument();
		},
	);

	it("does not offer it before the move has been read and is not switching", () => {
		renderSection(MOVING);

		expect(
			screen.queryByRole("button", { name: "Switch to upload mode" }),
		).not.toBeInTheDocument();
	});

	it("does not offer it to someone who cannot configure the sync", () => {
		renderSection({ ...SWITCHING, canConfigure: false });

		expect(
			screen.queryByRole("button", { name: "Switch to upload mode" }),
		).not.toBeInTheDocument();
	});

	it("asks first, destructively, in words about the move, then switches and re-reads", async () => {
		const user = userEvent.setup();
		const { onChanged } = renderSection(SWITCHING);

		await user.click(
			screen.getByRole("button", { name: "Switch to upload mode" }),
		);

		expect(m.confirm).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Switch to upload mode?",
				message:
					"Fabric ends the move to example-org/instructions and goes back to upload mode. The uploaded files stay as published, and anything already merged in the repository stays there. Editing and uploading in Fabric come back.",
				confirmLabel: "Switch to upload mode",
				destructive: true,
			}),
		);
		await vi.waitFor(() =>
			expect(m.disable).toHaveBeenCalledWith({ projectId: "proj_1" }),
		);
		await vi.waitFor(() => expect(onChanged).toHaveBeenCalled());
	});

	it("words a refusal in the shared sentence", async () => {
		const user = userEvent.setup();
		m.disable.mockRejectedValue(
			Object.assign(new Error("TEXT THAT MUST NOT BE SHOWN"), {
				code: "CONFLICT",
				data: {
					reason: "MIGRATION_OPEN",
					state: "SWITCHING",
					pullRequest: null,
				},
			}),
		);
		renderSection(SWITCHING);

		await user.click(
			screen.getByRole("button", { name: "Switch to upload mode" }),
		);

		await vi.waitFor(() =>
			expect(m.toastError).toHaveBeenCalledWith(
				expect.stringMatching(
					/^Moving to the repository: the pull request was merged and the project is switching/,
				),
			),
		);
	});
});
