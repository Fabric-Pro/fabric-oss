/**
 * The published view while the project's uploaded instructions are being moved
 * into a repository (Fizzy #2878 §9): the tab's reads reach the controls it
 * pauses, in the sentence a refused action gives. The leaves (action bar, file
 * view) are proven in their own suites; this proves the view hands them the
 * reason, and hands nothing when no move is open.
 *
 * The heavy children are stubs that show what the view passes them.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { RepositoryMigrationView } from "../../../lib/instructions-migration";
import type { RepositorySyncState } from "../../../lib/instructions-repository-sync";

vi.mock("next-intl", async () =>
	(await import("../../../__tests__/en-copy")).nextIntlMock(),
);
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));
vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: vi.fn() }),
}));
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org_1",
		organizationSlug: "example-org",
		isGuest: false,
	}),
}));
vi.mock("@saas/projects/components/cli-connection/ConnectCliDialog", () => ({
	ConnectCliDialog: () => null,
}));

const TREE_FILE = { path: "docs/guide.md", kind: "DOC", name: "guide" };

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				listFiles: {
					queryOptions: (o: { input: unknown }) => ({
						queryKey: ["listFiles", o.input],
						queryFn: async () => [TREE_FILE],
					}),
				},
				compare: {
					queryOptions: (o: { input: unknown }) => ({
						queryKey: ["compare", o.input],
						queryFn: async () => null,
					}),
				},
				// The header counts the proposals waiting for a decision.
				proposals: {
					list: {
						queryOptions: (o: { input: unknown }) => ({
							queryKey: ["proposals.list", o.input],
							queryFn: async () => ({
								items: [],
								nextCursor: null,
							}),
						}),
					},
				},
				finalize: {
					mutationOptions: () => ({ mutationFn: async () => ({}) }),
				},
				createDownloadUrl: {
					mutationOptions: () => ({ mutationFn: async () => ({}) }),
				},
				delete: {
					mutationOptions: () => ({ mutationFn: async () => ({}) }),
				},
			},
		},
	},
}));

const fileViewProps: Array<Record<string, unknown>> = [];

vi.mock("../InstructionFileView", () => ({
	InstructionFileView: (props: Record<string, unknown>) => {
		fileViewProps.push(props);
		return <div data-testid="file-view" />;
	},
}));
vi.mock("../InstructionsTree", () => ({
	InstructionsTree: ({ onSelect }: { onSelect: (path: string) => void }) => (
		<button type="button" onClick={() => onSelect("docs/guide.md")}>
			select-file
		</button>
	),
}));
vi.mock("../AddInstructionFileDialog", () => ({
	AddInstructionFileDialog: () => null,
}));
vi.mock("../InstructionProposals", () => ({
	InstructionProposals: () => null,
}));
const commitsProps: Array<Record<string, unknown>> = [];

vi.mock("../InstructionsCommits", () => ({
	InstructionsCommits: (props: Record<string, unknown>) => {
		commitsProps.push(props);
		return null;
	},
}));
vi.mock("../InstructionsCompareDialog", () => ({
	InstructionsCompareDialog: () => null,
}));
vi.mock("../InstructionsHistory", () => ({ InstructionsHistory: () => null }));
const sectionProps: Array<Record<string, unknown>> = [];

vi.mock("../RepositorySyncSettingsSection", () => ({
	RepositorySyncSettingsSection: (props: Record<string, unknown>) => {
		sectionProps.push(props);
		return null;
	},
}));
const settingsDialogProps: Array<Record<string, unknown>> = [];

vi.mock("../InstructionsSettingsDialog", () => ({
	InstructionsSettingsDialog: (props: {
		repositorySection?: ReactNode;
		[key: string]: unknown;
	}) => {
		settingsDialogProps.push(props);
		return <>{props.repositorySection}</>;
	},
}));
vi.mock("../RepositoryPublishedSummary", () => ({
	RepositoryPublishedSummary: () => null,
}));
vi.mock("../RepositorySyncRuns", () => ({ RepositorySyncRuns: () => null }));
const statusProps: Array<Record<string, unknown>> = [];

vi.mock("../RepositorySyncStatus", () => ({
	RepositorySyncStatus: (props: Record<string, unknown>) => {
		statusProps.push(props);
		return null;
	},
}));
vi.mock("../InstructionsFailedChecksBanner", () => ({
	InstructionsFailedChecksBanner: () => null,
}));
vi.mock("../InstructionsCheckingStatus", () => ({
	InstructionsCheckingStatus: () => null,
}));
vi.mock("../InstructionsDeferredScanAlerts", () => ({
	InstructionsDeferredScanAlerts: () => null,
}));
vi.mock("../InstructionsSupersededNotice", () => ({
	InstructionsSupersededNotice: () => null,
}));
vi.mock("@saas/get-started/components/PageTourButton", () => ({
	PageTourButton: () => null,
}));

import { InstructionsPublishedView } from "../InstructionsPublishedView";

const PUBLISHED = {
	id: "snap_1",
	version: 3,
	status: "READY",
	source: "UPLOAD",
	fileCount: 1,
	excludedCount: 0,
	createdAt: "2026-10-01T10:00:00.000Z",
};

const SYNC: RepositorySyncState = {
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

const OPEN_MOVE: RepositoryMigrationView = {
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
	failure: null,
};

function Providers({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

function renderView(
	sync: RepositorySyncState | null,
	move: RepositoryMigrationView | null = null,
	{
		canReview = true,
		repositoryBacked = false,
		onMove = vi.fn(),
	}: {
		canReview?: boolean;
		repositoryBacked?: boolean;
		/** `null` is a tab that offers no move at all. */
		onMove?: (() => void) | null;
	} = {},
) {
	fileViewProps.length = 0;
	sectionProps.length = 0;
	statusProps.length = 0;
	settingsDialogProps.length = 0;
	commitsProps.length = 0;
	render(
		<InstructionsPublishedView
			projectId="proj_1"
			projectName="Checkout Rewrite"
			published={PUBLISHED}
			snapshots={[PUBLISHED]}
			onReplaceClick={vi.fn()}
			onChanged={vi.fn()}
			canEdit
			canReview={canReview}
			canRead
			repositoryBacked={repositoryBacked}
			repositoryConfirmed={repositoryBacked}
			repositorySync={
				sync
					? {
							state: sync,
							onConfigure: vi.fn(),
							onMove: onMove ?? undefined,
							onSyncNow: vi.fn(),
							syncNowPending: false,
							onChanged: async () => {},
							migration: {
								read: {
									migration: move,
									repository: null,
								},
								endedNotice: null,
								onDismissEndedNotice: vi.fn(),
							},
						}
					: undefined
			}
		/>,
		{ wrapper: Providers },
	);
}

const OPEN_SENTENCE =
	"Moving to the repository: pull request #12 is open. Changes are paused until it is merged and synced, or the move is canceled.";

describe("InstructionsPublishedView while a move into a repository is open", () => {
	it("pauses Upload new version with the sentence a refused action gives", () => {
		renderView(SYNC, OPEN_MOVE);

		expect(
			screen.getByRole("button", { name: "Upload new version" }),
		).toHaveAttribute("aria-disabled", "true");
	});

	it("hands the open file's view the reason Edit, Rename and Delete are paused", async () => {
		const user = userEvent.setup();
		renderView(SYNC, OPEN_MOVE);

		await user.click(await screen.findByText("select-file"));

		await screen.findByTestId("file-view");
		expect(fileViewProps.at(-1)?.pausedReason).toBe(OPEN_SENTENCE);
	});

	it("says the changes are paused before the move has been read", async () => {
		const user = userEvent.setup();
		renderView(SYNC, null);

		await user.click(await screen.findByText("select-file"));

		await screen.findByTestId("file-view");
		expect(fileViewProps.at(-1)?.pausedReason).toBe(
			"Moving to the repository. Changes are paused until the pull request is merged and synced, or the move is canceled.",
		);
	});

	it("tells the settings dialog why the ignore rules cannot be changed", () => {
		renderView(SYNC, OPEN_MOVE);

		expect(settingsDialogProps.at(-1)?.pausedReason).toBe(OPEN_SENTENCE);
	});

	it("tells it nothing when no move is open", () => {
		renderView({ ...SYNC, migration: null });

		expect(settingsDialogProps.at(-1)?.pausedReason).toBeNull();
	});

	it("pauses nothing when no move is open", async () => {
		const user = userEvent.setup();
		renderView({ ...SYNC, migration: null });

		await user.click(await screen.findByText("select-file"));

		await screen.findByTestId("file-view");
		expect(fileViewProps.at(-1)?.pausedReason).toBeNull();
		expect(
			screen.getByRole("button", { name: "Upload new version" }),
		).not.toHaveAttribute("aria-disabled");
	});
});

describe("InstructionsPublishedView and the way out of a move", () => {
	const SWITCHING_SYNC: RepositorySyncState = {
		...SYNC,
		sourceOfTruth: "REPOSITORY",
		migration: { state: "SWITCHING" },
	};

	it("gives the settings section the tab's read of the move, so it knows whether a blocked move may leave", () => {
		renderView(SYNC, OPEN_MOVE);

		const given = sectionProps.at(-1)?.migration as
			| { read?: { migration?: { state: string } } }
			| undefined;
		expect(given?.read?.migration?.state).toBe("OPEN");
	});

	it("pauses Revert in the Commits of a project that is switching over, with the reason", async () => {
		const user = userEvent.setup();
		renderView(
			SWITCHING_SYNC,
			{ ...OPEN_MOVE, state: "SWITCHING" },
			{ repositoryBacked: true },
		);

		await user.click(
			await screen.findByRole("button", { name: "Commits" }),
		);

		expect(commitsProps.at(-1)?.pausedReason).toBe(
			"Moving to the repository: the pull request was merged and the project is switching to the repository. Changes are paused until that finishes.",
		);
	});

	it("pauses nothing in Commits when no move is open", async () => {
		const user = userEvent.setup();
		renderView({ ...SWITCHING_SYNC, migration: null }, null, {
			repositoryBacked: true,
		});

		await user.click(
			await screen.findByRole("button", { name: "Commits" }),
		);

		expect(commitsProps.at(-1)?.pausedReason).toBeNull();
	});
});

describe("InstructionsPublishedView and the status of a move", () => {
	it("hands the status the tab's read of the move and the project it belongs to", () => {
		renderView(SYNC, OPEN_MOVE);

		const given = statusProps.at(-1);
		expect(given?.projectId).toBe("proj_1");
		expect(
			(given?.migration as { read?: { migration?: { state: string } } })
				?.read?.migration?.state,
		).toBe("OPEN");
		expect(given?.onMigrationChanged).toBeTypeOf("function");
	});

	it("lets a member who may create and update cancel or retry", () => {
		renderView(SYNC, OPEN_MOVE);

		expect(statusProps.at(-1)?.canManageMigration).toBe(true);
	});

	it("shows a member who may not update the status and nothing to change it with", () => {
		renderView(SYNC, OPEN_MOVE, { canReview: false });

		expect(statusProps.at(-1)?.canManageMigration).toBe(false);
	});
});

describe("InstructionsPublishedView and the way to move uploaded instructions", () => {
	const UPLOADS: RepositorySyncState = {
		...SYNC,
		configured: null,
		migration: null,
	};

	it("gives the settings section the way to open the move when the member may create and update", () => {
		const onMove = vi.fn();
		renderView(UPLOADS, null, { onMove });

		const given = sectionProps.at(-1)?.onMove as (() => void) | undefined;
		expect(given).toBeTypeOf("function");
		given?.();

		expect(onMove).toHaveBeenCalledTimes(1);
	});

	it("gives nothing to a member who may not update", () => {
		renderView(UPLOADS, null, { canReview: false });

		expect(sectionProps.at(-1)?.onMove).toBeUndefined();
	});

	it("gives nothing for a project whose source is not confirmed to be uploads", () => {
		renderView(UPLOADS, null, { repositoryBacked: true });

		expect(sectionProps.at(-1)?.onMove).toBeUndefined();
	});

	it("gives nothing when the tab offers no move", () => {
		renderView(UPLOADS, null, { onMove: null });

		expect(sectionProps.at(-1)?.onMove).toBeUndefined();
	});
});
