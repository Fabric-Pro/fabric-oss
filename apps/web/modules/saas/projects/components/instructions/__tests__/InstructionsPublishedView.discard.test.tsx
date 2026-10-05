/**
 * The published view's "Checking your upload" line and the way out of an
 * upload that never finished (Fizzy #2878 follow-up): the view hands the line a
 * discard only for an unfinished upload the viewer may remove, and the discard
 * asks first and deletes that snapshot. The line itself and the delete are
 * proven in their own suites; this proves the view wires them.
 *
 * The heavy children are stubs that show what the view passes them.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstructionsSnapshot } from "../../../lib/instructions-snapshot";

vi.mock("next-intl", async () =>
	(await import("../../../__tests__/en-copy")).nextIntlMock(),
);

const m = vi.hoisted(() => ({
	remove: vi.fn(),
	confirm: vi.fn(),
	statusProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));
vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: m.confirm }),
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
				listFiles: {
					queryOptions: (o: { input: unknown }) => ({
						queryKey: ["listFiles", o.input],
						queryFn: async () => [],
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
					mutationOptions: mutationOptionsStub(async () => ({})),
				},
				createDownloadUrl: {
					mutationOptions: mutationOptionsStub(async () => ({})),
				},
				delete: {
					mutationOptions: mutationOptionsStub((i) => m.remove(i)),
				},
			},
		},
	},
}));

vi.mock("../InstructionsCheckingStatus", () => ({
	InstructionsCheckingStatus: (props: Record<string, unknown>) => {
		m.statusProps.push(props);
		return null;
	},
}));
vi.mock("../InstructionFileView", () => ({ InstructionFileView: () => null }));
vi.mock("../InstructionsTree", () => ({ InstructionsTree: () => null }));
vi.mock("../AddInstructionFileDialog", () => ({
	AddInstructionFileDialog: () => null,
}));
vi.mock("../InstructionProposals", () => ({
	InstructionProposals: () => null,
}));
vi.mock("../InstructionsCommits", () => ({ InstructionsCommits: () => null }));
vi.mock("../InstructionsCompareDialog", () => ({
	InstructionsCompareDialog: () => null,
}));
vi.mock("../InstructionsHistory", () => ({ InstructionsHistory: () => null }));
vi.mock("../InstructionsSettingsDialog", () => ({
	InstructionsSettingsDialog: () => null,
}));
vi.mock("../RepositoryPublishedSummary", () => ({
	RepositoryPublishedSummary: () => null,
}));
vi.mock("../RepositorySyncRuns", () => ({ RepositorySyncRuns: () => null }));
vi.mock("../RepositorySyncStatus", () => ({
	RepositorySyncStatus: () => null,
}));
vi.mock("../RepositorySyncSettingsSection", () => ({
	RepositorySyncSettingsSection: () => null,
}));
vi.mock("../InstructionsFailedChecksBanner", () => ({
	InstructionsFailedChecksBanner: () => null,
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

function snapshot(over: Partial<InstructionsSnapshot> = {}) {
	return {
		id: "snap_3",
		version: 3,
		status: "READY",
		source: "UPLOAD",
		fileCount: 10,
		excludedCount: 0,
		createdAt: "2026-10-03T10:00:00.000Z",
		...over,
	} as InstructionsSnapshot;
}

const PUBLISHED = snapshot();

function Providers({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

function renderView(newest: InstructionsSnapshot, canEdit = true) {
	m.statusProps.length = 0;
	const onChanged = vi.fn();
	render(
		<InstructionsPublishedView
			projectId="proj_1"
			projectName="Checkout Rewrite"
			published={PUBLISHED}
			snapshots={[newest, PUBLISHED]}
			onReplaceClick={vi.fn()}
			onChanged={onChanged}
			canEdit={canEdit}
			canReview={canEdit}
			canRead
			repositoryBacked={false}
			repositoryConfirmed={false}
		/>,
		{ wrapper: Providers },
	);
	return { onChanged };
}

const lastStatus = () => m.statusProps.at(-1);

beforeEach(() => {
	m.remove.mockReset();
	m.remove.mockResolvedValue({ deleted: true });
	m.confirm.mockReset();
	m.confirm.mockImplementation((options: { onConfirm: () => void }) =>
		options.onConfirm(),
	);
});

describe("InstructionsPublishedView and an upload that never finished", () => {
	it("hands the line a discard for an unfinished upload the viewer may remove", () => {
		renderView(snapshot({ id: "snap_4", version: 4, status: "RECEIVING" }));

		expect(lastStatus()?.onDiscard).toBeTypeOf("function");
	});

	it("asks first, destructively, then deletes that snapshot and has the tab re-read", async () => {
		const { onChanged } = renderView(
			snapshot({ id: "snap_4", version: 4, status: "RECEIVING" }),
		);

		act(() => (lastStatus()?.onDiscard as () => void)());

		expect(m.confirm).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Discard this upload?",
				destructive: true,
			}),
		);
		await waitFor(() =>
			expect(m.remove).toHaveBeenCalledWith({
				projectId: "proj_1",
				snapshotId: "snap_4",
			}),
		);
		await waitFor(() => expect(onChanged).toHaveBeenCalled());
	});

	it("hands nothing for an upload whose checks are running", () => {
		renderView(
			snapshot({ id: "snap_4", version: 4, status: "VALIDATING" }),
		);

		expect(lastStatus()?.onDiscard).toBeUndefined();
	});

	it("hands nothing to a viewer who may not edit", () => {
		renderView(
			snapshot({ id: "snap_4", version: 4, status: "RECEIVING" }),
			false,
		);

		expect(lastStatus()?.onDiscard).toBeUndefined();
	});

	it("hands nothing for a repository sync's snapshot, which its run owns", () => {
		renderView(
			snapshot({
				id: "snap_4",
				version: 4,
				status: "RECEIVING",
				source: "REPOSITORY",
			}),
		);

		expect(lastStatus()?.onDiscard).toBeUndefined();
	});
});
