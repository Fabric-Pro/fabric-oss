/**
 * Coverage for `InstructionsHistory`'s publish/delete mutations, added per
 * controller ruling R26: neither action had a test before this round.
 * Assertions target the translation KEY, not English copy, since the point
 * here is the wiring (CONFLICT surfacing, `onChanged` on success, which
 * statuses offer Delete), not the copy itself — with one exception, the
 * `t.raw()` label maps, which the local `next-intl` mock below resolves for
 * real because a lookup INTO them is the behaviour under test.
 */
import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

/**
 * The app's confirmation dialog, which is mounted once in the (saas) layout
 * and so is absent here. The mock records what each action asked, and by
 * default confirms, the way a person pressing the dialog's button would.
 */
const confirmMock = vi.hoisted(() => vi.fn());
type ConfirmOptions = {
	title: string;
	message?: string;
	confirmLabel?: string;
	destructive?: boolean;
	onConfirm: () => Promise<void> | void;
};
vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: confirmMock }),
}));

/**
 * `t()` keeps echoing the KEY, so the mutation-wiring assertions above stay
 * key-based; only `t.raw()` resolves the real `en.json` object. The shared
 * mock in `vitest.setup.ts` returns the key from `t.raw` too, which would
 * make `reasonLabels` a string and every lookup on it `undefined` — i.e.
 * the rendered label would silently fall back to the raw reason, which is
 * exactly the M3 bug these tests pin.
 */
vi.mock("next-intl", () => ({
	useTranslations: (namespace: string) => {
		const t = (key: string, values?: Record<string, unknown>) =>
			values === undefined
				? key
				: `${key}:${Object.values(values).join(",")}`;
		t.raw = (key: string) =>
			`${namespace}.${key}`
				.split(".")
				.reduce<unknown>(
					(node, part) =>
						node && typeof node === "object"
							? (node as Record<string, unknown>)[part]
							: undefined,
					en,
				);
		return t;
	},
	useLocale: () => "en",
	useFormatter: () => ({
		dateTime: (d: Date) => d.toISOString(),
		number: (n: number) => String(n),
		relativeTime: (d: Date) => d.toISOString(),
	}),
	useMessages: () => ({}),
	NextIntlClientProvider: ({ children }: { children: ReactNode }) => children,
}));

/** Every `compare` input the dialog asked for, in order. */
const compareInputs = vi.hoisted(() => [] as Array<Record<string, unknown>>);
/** Every `publish` input sent, in order — whether it carried `publishBeforeScan`. */
const publishInputs = vi.hoisted(() => [] as Array<Record<string, unknown>>);
/**
 * A publish for snapshot id "pending" never resolves on its own — the test
 * that uses it calls `pendingPublish.resolve()` itself, once it has asserted
 * what stays disabled while the request is in flight.
 */
const pendingPublish = vi.hoisted(
	() => ({ resolve: null }) as { resolve: (() => void) | null },
);

function mutationOptionsStub(
	mutationFn: (input: {
		snapshotId: string;
		publishBeforeScan?: boolean;
		expectedPublishedSnapshotId?: string | null;
	}) => Promise<unknown>,
) {
	return (
		opts: {
			onSuccess?: (data: unknown, vars: unknown) => void;
			onError?: (error: Error) => void;
		} = {},
	) => ({
		mutationFn,
		...opts,
	});
}

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				publish: {
					mutationOptions: mutationOptionsStub(async (input) => {
						publishInputs.push(input);
						if (input.snapshotId === "fail") {
							throw Object.assign(
								new Error(
									"A newer version is already published",
								),
								{ code: "CONFLICT" },
							);
						}
						if (input.snapshotId === "stale") {
							throw Object.assign(
								new Error("Another version was published"),
								{
									code: "CONFLICT",
									data: {
										reason: "PUBLISHED_CHANGED",
										publishedVersion: 9,
									},
								},
							);
						}
						if (input.snapshotId === "pending") {
							return new Promise((resolve) => {
								pendingPublish.resolve = () =>
									resolve({ published: true });
							});
						}
						return { published: true };
					}),
				},
				delete: {
					mutationOptions: mutationOptionsStub(async (input) => {
						if (input.snapshotId === "fail") {
							throw Object.assign(
								new Error(
									"The published snapshot cannot be deleted",
								),
								{ code: "CONFLICT" },
							);
						}
						return { deleted: true };
					}),
				},
				createDownloadUrl: {
					mutationOptions: mutationOptionsStub(async () => ({
						url: "https://example.com/download",
						fileCount: 0,
					})),
				},
				compare: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["compare", input],
						queryFn: async () => {
							compareInputs.push(
								input as Record<string, unknown>,
							);
							return {
								from: { id: "published", version: 9 },
								to: { id: "ready", version: 8 },
								added: [],
								removed: [],
								changed: [],
								unchangedCount: 4,
							};
						},
					}),
				},
			},
		},
	},
}));

import { InstructionsHistory } from "../InstructionsHistory";

function TestQueryProvider({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

describe("InstructionsHistory", () => {
	it("does not offer manual publish for a pending proposal", () => {
		render(
			<InstructionsHistory
				projectId="p"
				open
				onOpenChange={() => undefined}
				snapshots={[
					{
						id: "proposal",
						version: 8,
						status: "READY",
						source: "UPLOAD",
						fileCount: 1,
						createdAt: new Date(),
						proposalStatus: "PENDING",
					},
				]}
				publishedId="published"
				publishedVersion={7}
				onChanged={() => undefined}
			/>,
			{ wrapper: TestQueryProvider },
		);

		expect(
			screen.queryByRole("button", { name: "publishAction" }),
		).toBeNull();
	});

	// Fizzy #2563 spec §2.5: a suggestion that became a pull request reaches
	// agents only by being merged in the repository and synced back, so the
	// server refuses to publish it in any status (`repository_proposal`).
	// A MERGED or CLOSED row stays in its proposer's History, and after a
	// switch back to upload mode nothing else would hide Publish on it.
	it.each([["MERGED"], ["CLOSED"]] as const)(
		"never offers Publish for a suggestion whose pull request is %s, even in upload mode",
		(proposalStatus) => {
			render(
				<InstructionsHistory
					projectId="p"
					open
					onOpenChange={() => undefined}
					snapshots={[
						{
							id: "suggestion",
							version: 8,
							status: "READY",
							source: "UPLOAD",
							fileCount: 1,
							createdAt: new Date(),
							proposalStatus,
						},
					]}
					publishedId="published"
					publishedVersion={7}
					canPublish
					onChanged={() => undefined}
				/>,
				{ wrapper: TestQueryProvider },
			);

			expect(
				screen.queryByRole("button", { name: "publishAction" }),
			).toBeNull();
			expect(
				screen.queryByRole("button", { name: "rollbackAction" }),
			).toBeNull();
		},
	);
	beforeEach(() => {
		vi.clearAllMocks();
		compareInputs.length = 0;
		confirmMock.mockImplementation((options: ConfirmOptions) =>
			options.onConfirm(),
		);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("publish surfaces the server's CONFLICT message on failure and calls onChanged on success", async () => {
		const onChanged = vi.fn();
		render(
			<InstructionsHistory
				projectId="p"
				open
				onOpenChange={() => undefined}
				snapshots={[
					{
						id: "fail",
						version: 5,
						status: "READY",
						source: "UPLOAD",
						fileCount: 10,
						createdAt: new Date(),
					},
					{
						id: "ok",
						version: 6,
						status: "READY",
						source: "UPLOAD",
						fileCount: 10,
						createdAt: new Date(),
					},
				]}
				publishedId={null}
				publishedVersion={null}
				onChanged={onChanged}
			/>,
			{ wrapper: TestQueryProvider },
		);
		const publishButtons = screen.getAllByRole("button", {
			name: "publishAction",
		});
		await userEvent.click(publishButtons[0]);
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith("conflict"),
		);
		expect(onChanged).not.toHaveBeenCalled();

		await userEvent.click(publishButtons[1]);
		await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
	});

	it("delete surfaces the server's CONFLICT message on failure and calls onChanged on success", async () => {
		const onChanged = vi.fn();
		render(
			<InstructionsHistory
				projectId="p"
				open
				onOpenChange={() => undefined}
				snapshots={[
					{
						id: "fail",
						version: 3,
						status: "READY",
						source: "UPLOAD",
						fileCount: 10,
						createdAt: new Date(),
					},
					{
						id: "ok",
						version: 4,
						status: "READY",
						source: "UPLOAD",
						fileCount: 10,
						createdAt: new Date(),
					},
				]}
				publishedId={null}
				publishedVersion={null}
				onChanged={onChanged}
			/>,
			{ wrapper: TestQueryProvider },
		);
		const deleteButtons = screen.getAllByRole("button", {
			name: "deleteAction",
		});
		await userEvent.click(deleteButtons[0]);
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith("conflict"),
		);
		// A failed delete re-reads the list too: the version may already be
		// gone (a second click, or someone else's delete), and the row on
		// screen is then stale.
		expect(onChanged).toHaveBeenCalledTimes(1);

		await userEvent.click(deleteButtons[1]);
		await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
	});

	// M9: deleting a snapshot whose workflow is still running removes the row
	// the next activity reads, so it fails as a non-retryable
	// INSTRUCTION_SNAPSHOT_TENANT_MISMATCH — a tenancy-shaped error for a
	// self-inflicted click. Delete is offered only on a terminal status.
	it("offers Delete only for a snapshot whose workflow has finished", async () => {
		render(
			<InstructionsHistory
				projectId="p"
				open
				onOpenChange={() => undefined}
				snapshots={[
					{
						id: "validating",
						version: 9,
						status: "VALIDATING",
						source: "UPLOAD",
						fileCount: 3,
						createdAt: new Date(),
					},
					{
						id: "receiving",
						version: 8,
						status: "RECEIVING",
						source: "UPLOAD",
						fileCount: 3,
						createdAt: new Date(),
					},
					{
						id: "ready",
						version: 7,
						status: "READY",
						source: "UPLOAD",
						fileCount: 3,
						createdAt: new Date(),
					},
					{
						id: "rejected",
						version: 6,
						status: "REJECTED",
						source: "UPLOAD",
						fileCount: 3,
						createdAt: new Date(),
					},
					{
						id: "failed",
						version: 5,
						status: "FAILED",
						source: "UPLOAD",
						fileCount: 3,
						createdAt: new Date(),
					},
				]}
				publishedId={null}
				publishedVersion={null}
				onChanged={() => undefined}
			/>,
			{ wrapper: TestQueryProvider },
		);
		// READY, REJECTED and FAILED only — not the two in-flight rows.
		expect(
			screen.getAllByRole("button", { name: "deleteAction" }),
		).toHaveLength(3);
	});

	/**
	 * "Compare with published" carries the same gates as Download — a version
	 * whose bytes the server will not serve cannot be diffed either — plus
	 * one of its own: the published row has nothing to compare itself
	 * against, and with no published pointer there is no other side at all.
	 */
	it("offers a comparison only for a readable version that is not the published one", () => {
		render(
			<InstructionsHistory
				projectId="p"
				open
				onOpenChange={() => undefined}
				snapshots={[
					{
						id: "published",
						version: 9,
						status: "READY",
						source: "UPLOAD",
						fileCount: 4,
						createdAt: new Date(),
					},
					{
						id: "ready",
						version: 8,
						status: "READY",
						source: "UPLOAD",
						fileCount: 4,
						createdAt: new Date(),
					},
					{
						id: "rejected",
						version: 7,
						status: "REJECTED",
						source: "UPLOAD",
						fileCount: 4,
						createdAt: new Date(),
					},
					{
						id: "proposal",
						version: 6,
						status: "READY",
						source: "UPLOAD",
						fileCount: 4,
						createdAt: new Date(),
						proposalStatus: "PENDING",
					},
				]}
				publishedId="published"
				publishedVersion={9}
				onChanged={() => undefined}
			/>,
			{ wrapper: TestQueryProvider },
		);

		// Exactly the READY, non-published, non-proposal row.
		expect(
			screen.getAllByRole("button", { name: "compareAction" }),
		).toHaveLength(1);
		// Download is offered on both READY non-proposal rows, so the extra
		// gate here is the published row itself.
		expect(
			screen.getAllByRole("button", { name: "downloadAction" }),
		).toHaveLength(2);
	});

	/**
	 * The direction is the whole point: History compares PUBLISHED -> the
	 * selected version, i.e. "what changes if this version is published",
	 * not what that version was derived from. Counting buttons would not
	 * catch the two ids being handed over the wrong way round.
	 */
	it("opens the comparison from the published version to the selected one", async () => {
		render(
			<InstructionsHistory
				projectId="p"
				open
				onOpenChange={() => undefined}
				snapshots={[
					{
						id: "published",
						version: 9,
						status: "READY",
						source: "UPLOAD",
						fileCount: 4,
						createdAt: new Date(),
					},
					{
						id: "ready",
						version: 8,
						status: "READY",
						source: "UPLOAD",
						fileCount: 4,
						createdAt: new Date(),
					},
				]}
				publishedId="published"
				publishedVersion={9}
				onChanged={() => undefined}
			/>,
			{ wrapper: TestQueryProvider },
		);

		await userEvent.click(
			screen.getByRole("button", { name: "compareAction" }),
		);

		await waitFor(() => expect(compareInputs).toHaveLength(1));
		expect(compareInputs[0]).toEqual({
			projectId: "p",
			fromSnapshotId: "published",
			toSnapshotId: "ready",
		});
		// `t()` echoes `key:values` here, so this is the compare dialog's own
		// summary line with its four counts interpolated — proof the dialog
		// rendered, not just that the query ran.
		expect(await screen.findByText("summary:0,0,0,4")).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "closeButton" }),
		).toBeTruthy();
	});

	it("offers no comparison at all when the project has published nothing", () => {
		render(
			<InstructionsHistory
				projectId="p"
				open
				onOpenChange={() => undefined}
				snapshots={[
					{
						id: "ready",
						version: 8,
						status: "READY",
						source: "UPLOAD",
						fileCount: 4,
						createdAt: new Date(),
					},
				]}
				publishedId={null}
				publishedVersion={null}
				onChanged={() => undefined}
			/>,
			{ wrapper: TestQueryProvider },
		);

		expect(
			screen.queryByRole("button", { name: "compareAction" }),
		).toBeNull();
	});

	// M3/M4: "See why" rendered the raw `reason` ("secret") and the
	// `(truncated)` cap sentinel as if it were a file, while the banner
	// showing the SAME rows translated both. M4: the version line was the
	// one hardcoded English string in the component.
	it("translates rejection reasons and folds the truncation sentinel into a summary line", async () => {
		render(
			<InstructionsHistory
				projectId="p"
				open
				onOpenChange={() => undefined}
				snapshots={[
					{
						id: "rejected",
						version: 4,
						status: "REJECTED",
						source: "UPLOAD",
						fileCount: 2,
						createdAt: new Date(),
						rejection: [
							{
								path: ".env",
								reason: "secret",
								detail: "aws-access-key",
							},
							{ path: "notes.md", reason: "hash_mismatch" },
							{
								path: "(truncated)",
								reason: "truncated",
								detail: "42 more",
							},
						],
					},
				]}
				publishedId={null}
				publishedVersion={null}
				onChanged={() => undefined}
			/>,
			{ wrapper: TestQueryProvider },
		);
		await userEvent.click(
			screen.getByRole("button", { name: "seeWhyAction" }),
		);

		expect(screen.getByText("AWS access key id")).toBeTruthy();
		expect(screen.getByText("File changed during upload")).toBeTruthy();
		// The sentinel is a cap marker, never a file row.
		expect(screen.queryByText("(truncated)")).toBeNull();
		expect(screen.queryByText("truncated")).toBeNull();
		// `t()` still echoes, so this asserts the sentinel reached the SUMMARY
		// line carrying its detail, rather than the file table.
		expect(screen.getByText("truncatedSummary:42 more")).toBeTruthy();
		// M4: the version line goes through `t()` like every other string.
		expect(screen.getByText("versionLabel:4")).toBeTruthy();
	});

	/**
	 * The provenance line reads the STORED base version, not a lookup of
	 * `baseSnapshotId` in this list. The base may have been deleted or pruned
	 * — `baseSnapshotId` is `SetNull` in the database and the id would be
	 * gone — and those are exactly the rows whose provenance nobody can
	 * reconstruct by eye.
	 */
	it("names the version an edit came from even when that version is no longer listed", async () => {
		render(
			<InstructionsHistory
				projectId="p"
				open
				onOpenChange={() => undefined}
				snapshots={[
					{
						id: "edited",
						version: 9,
						status: "READY",
						source: "UPLOAD",
						fileCount: 10,
						createdAt: new Date(),
						baseVersion: 7,
					},
					{
						id: "uploaded",
						version: 8,
						status: "READY",
						source: "UPLOAD",
						fileCount: 10,
						createdAt: new Date(),
					},
				]}
				publishedId={null}
				publishedVersion={null}
				onChanged={() => undefined}
			/>,
			{ wrapper: TestQueryProvider },
		);

		// `t()` echoes `key:values`, so this is the interpolated version.
		expect(screen.getByText(/editedFrom:7/)).toBeTruthy();
		// The plain upload beside it claims no provenance at all.
		expect(screen.queryByText(/editedFrom:8/)).toBeNull();
	});

	/**
	 * Publishing a version BELOW the published one is a rollback, and the
	 * button has to say so: "Publish this version" on a row underneath the
	 * published one hides that later versions stop being what agents read.
	 * The server takes both the same way — it is one pointer move — so the
	 * direction is the only thing that changes here.
	 */
	describe("rollback labelling", () => {
		function renderWithPublished(
			publishedId: string | null,
			publishedVersion: number | null,
			publishedUnknown = false,
		) {
			render(
				<InstructionsHistory
					projectId="p"
					open
					onOpenChange={() => undefined}
					snapshots={[
						{
							id: "v9",
							version: 9,
							status: "READY",
							source: "UPLOAD",
							fileCount: 4,
							createdAt: new Date(),
						},
						{
							id: "v8",
							version: 8,
							status: "READY",
							source: "UPLOAD",
							fileCount: 4,
							createdAt: new Date(),
						},
						{
							id: "v7",
							version: 7,
							status: "READY",
							source: "UPLOAD",
							fileCount: 4,
							createdAt: new Date(),
						},
					]}
					publishedId={publishedId}
					publishedVersion={publishedVersion}
					publishedUnknown={publishedUnknown}
					onChanged={() => undefined}
				/>,
				{ wrapper: TestQueryProvider },
			);
		}

		it("offers a roll back below the published version and an ordinary publish above it", async () => {
			// v8 is published: v7 is behind it, v9 ahead of it.
			renderWithPublished("v8", 8);

			expect(
				screen.getAllByRole("button", { name: "rollbackAction" }),
			).toHaveLength(1);
			expect(
				screen.getAllByRole("button", { name: "publishAction" }),
			).toHaveLength(1);

			await userEvent.click(
				screen.getByRole("button", { name: "rollbackAction" }),
			);
			// `t()` echoes `key:values`, so this is the confirm copy with its
			// version interpolated — the rollback wording, not the publish one.
			expect(confirmMock).toHaveBeenCalledWith(
				expect.objectContaining({
					title: "rollbackConfirm:7",
					message: "rollbackConfirmBody",
					confirmLabel: "rollbackConfirmAction",
					destructive: true,
				}),
			);

			await userEvent.click(
				screen.getByRole("button", { name: "publishAction" }),
			);
			expect(confirmMock).toHaveBeenLastCalledWith(
				expect.objectContaining({
					title: "publishConfirm:9",
					confirmLabel: "publishConfirmAction",
					destructive: true,
				}),
			);
		});

		// Nothing published yet: no version is "earlier" than anything, so
		// every row keeps the forward wording it had before.
		it("keeps the forward wording for every version when the project has published nothing", () => {
			renderWithPublished(null, null);

			expect(
				screen.getAllByRole("button", { name: "publishAction" }),
			).toHaveLength(3);
			expect(
				screen.queryByRole("button", { name: "rollbackAction" }),
			).toBeNull();
		});

		/**
		 * "Nothing is published" and "we could not read what is published"
		 * arrive here identically — both as a null pointer — and they are not
		 * the same thing. Labelling every row "Publish this version" on a
		 * failed pointer query would hide the rollbacks among them, so the
		 * dialog says what happened and withholds the action instead.
		 */
		it("says the published version could not be loaded and offers no publish at all", () => {
			renderWithPublished(null, null, true);

			expect(screen.getByRole("alert").textContent).toBe(
				"publishedUnknown",
			);
			expect(
				screen.queryByRole("button", { name: "publishAction" }),
			).toBeNull();
			expect(
				screen.queryByRole("button", { name: "rollbackAction" }),
			).toBeNull();
			// Everything that does not depend on the pointer still works.
			expect(
				screen.getAllByRole("button", { name: "downloadAction" }),
			).toHaveLength(3);
			expect(screen.getByText("versionLabel:9")).toBeTruthy();
		});

		// The direction comes from the parent's published row, not from
		// matching `publishedId` inside this list. A row missing from the list
		// must not silently read as "nothing published".
		it("labels a rollback even when the published row is not in the list it was given", async () => {
			renderWithPublished("v8-not-listed", 8);

			expect(
				screen.getAllByRole("button", { name: "rollbackAction" }),
			).toHaveLength(1);
			await userEvent.click(
				screen.getByRole("button", { name: "rollbackAction" }),
			);
			expect(confirmMock).toHaveBeenCalledWith(
				expect.objectContaining({ title: "rollbackConfirm:7" }),
			);
		});
	});

	it("lets a reviewer publish a synced version without offering delete, and shows the sync runs it is given", () => {
		render(
			<InstructionsHistory
				projectId="p"
				open
				onOpenChange={() => undefined}
				snapshots={[
					{
						id: "synced",
						version: 8,
						status: "READY",
						source: "REPOSITORY",
						fileCount: 3,
						createdAt: new Date(),
					},
				]}
				publishedId="published"
				publishedVersion={7}
				canMutate={false}
				canPublish
				syncRuns={<div data-testid="sync-runs" />}
				onChanged={() => undefined}
			/>,
			{ wrapper: TestQueryProvider },
		);
		expect(
			screen.getByRole("button", { name: "publishAction" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "deleteAction" }),
		).toBeNull();
		expect(screen.getByTestId("sync-runs")).toBeInTheDocument();
	});

	// Fizzy #2878 §10: Fabric's copy of a repository project follows its
	// branch, so there is no version to publish, roll back to or delete by hand,
	// whatever the member may do. (Commits is what such a project shows once its
	// repository is confirmed; this is the list while that is not yet known.)
	it("offers no Publish, Roll back or Delete on a repository-backed project, even to someone who may publish and delete", () => {
		render(
			<InstructionsHistory
				projectId="p"
				open
				onOpenChange={() => undefined}
				snapshots={[
					{
						id: "synced",
						version: 9,
						status: "READY",
						source: "REPOSITORY",
						fileCount: 3,
						createdAt: new Date(),
					},
					{
						id: "uploaded",
						version: 8,
						status: "READY",
						source: "UPLOAD",
						fileCount: 3,
						createdAt: new Date(),
					},
				]}
				publishedId="published"
				publishedVersion={7}
				canMutate
				canPublish
				repositoryBacked
				onChanged={() => undefined}
			/>,
			{ wrapper: TestQueryProvider },
		);
		expect(
			screen.queryByRole("button", { name: "publishAction" }),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: "rollbackAction" }),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: "deleteAction" }),
		).toBeNull();
		expect(screen.getByText("versionLabel:9")).toBeTruthy();
		expect(screen.getByText("versionLabel:8")).toBeTruthy();
	});
});

/**
 * Publish first, scan afterwards (Fizzy #2737). A version that went out
 * before its secret scan carries a "published before scan" badge and the
 * scan's outcome. History still offers to publish or roll back such a
 * version (Fizzy #2760), but the row's button opens
 * `PublishFlaggedVersionDialog` instead of a plain `window.confirm`: the
 * server's `deferred_scan_unresolved` refusal is what a plain confirm would
 * hit, and the dialog is how the acknowledgement it needs gets sent.
 */
describe("InstructionsHistory — deferred secret scan", () => {
	function renderScanned(
		scanned: Record<string, unknown>,
		props: Record<string, unknown> = {},
	) {
		return render(
			<InstructionsHistory
				projectId="p"
				open
				onOpenChange={() => undefined}
				snapshots={[
					{
						id: "scanned",
						version: 6,
						status: "READY",
						source: "UPLOAD",
						fileCount: 2,
						createdAt: new Date(),
						publishBeforeScan: true,
						...scanned,
					} as never,
				]}
				publishedId="published"
				publishedVersion={7}
				canPublish
				onChanged={() => undefined}
				{...props}
			/>,
			{ wrapper: TestQueryProvider },
		);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		publishInputs.length = 0;
		pendingPublish.resolve = null;
		confirmMock.mockImplementation((options: ConfirmOptions) =>
			options.onConfirm(),
		);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each([
		["ISSUES_FOUND", "scanIssuesPill"],
		["INCOMPLETE", "scanIncompletePill"],
	] as const)(
		"badges a %s scan and still offers the button, opening the acknowledgement dialog instead of a plain confirm",
		async (deferredScanStatus, pill) => {
			const user = userEvent.setup();
			renderScanned({ deferredScanStatus });
			expect(screen.getByText("publishedBeforeScanPill")).toBeTruthy();
			expect(screen.getByText(pill)).toBeTruthy();
			// Version 6 below the published version 7: a rollback.
			await user.click(
				screen.getByRole("button", { name: "rollbackAction" }),
			);
			expect(screen.getByText("flaggedDialogTitle")).toBeTruthy();
			// Same version/direction copy the plain confirm would have shown.
			expect(screen.getByText("rollbackConfirm:6")).toBeTruthy();
			expect(confirmMock).not.toHaveBeenCalled();
			expect(publishInputs).toHaveLength(0);
		},
	);

	// A scan still PENDING is refused unconditionally (no acknowledgement to
	// offer), so the row gets no button at all — only the badge and a note
	// explaining why (Fizzy #2760 review, deadlock avoidance).
	it("badges a PENDING scan, offers no button, and explains why", () => {
		renderScanned({ deferredScanStatus: "PENDING" });
		expect(screen.getByText("publishedBeforeScanPill")).toBeTruthy();
		expect(screen.getByText("scanPendingPill")).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "rollbackAction" }),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: "publishAction" }),
		).toBeNull();
		expect(screen.getByText("publishBlockedByScan")).toBeTruthy();
	});

	it("keeps the dialog's confirm disabled until both the option and its acknowledgement are ticked, then sends publishBeforeScan: true", async () => {
		const user = userEvent.setup();
		renderScanned({ deferredScanStatus: "ISSUES_FOUND" });
		await user.click(
			screen.getByRole("button", { name: "rollbackAction" }),
		);
		const confirm = screen.getByRole("button", { name: "confirmAction" });
		expect(confirm).toBeDisabled();

		await user.click(screen.getByRole("checkbox", { name: "label" }));
		expect(confirm).toBeDisabled();
		await user.click(screen.getByRole("checkbox", { name: "acknowledge" }));
		expect(confirm).toBeEnabled();

		await user.click(confirm);
		await waitFor(() => expect(publishInputs).toHaveLength(1));
		expect(publishInputs[0]).toMatchObject({
			projectId: "p",
			snapshotId: "scanned",
			publishBeforeScan: true,
		});
	});

	it("closes the dialog and refreshes History once the acknowledged publish succeeds", async () => {
		const user = userEvent.setup();
		const onChanged = vi.fn();
		renderScanned({ deferredScanStatus: "INCOMPLETE" }, { onChanged });
		await user.click(
			screen.getByRole("button", { name: "rollbackAction" }),
		);
		await user.click(screen.getByRole("checkbox", { name: "label" }));
		await user.click(screen.getByRole("checkbox", { name: "acknowledge" }));
		await user.click(screen.getByRole("button", { name: "confirmAction" }));
		await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
		expect(screen.queryByText("flaggedDialogTitle")).toBeNull();
	});

	// The dialog is mounted only while a row is being confirmed, so closing
	// it — cancel included — unmounts it; a later row's dialog is a fresh
	// mount with fresh state, never the previous row's ticks.
	it("resets both ticks when the dialog is cancelled, so a later row opens unchecked", async () => {
		const user = userEvent.setup();
		render(
			<InstructionsHistory
				projectId="p"
				open
				onOpenChange={() => undefined}
				snapshots={[
					{
						id: "rowA",
						version: 6,
						status: "READY",
						source: "UPLOAD",
						fileCount: 2,
						createdAt: new Date(),
						deferredScanStatus: "ISSUES_FOUND",
					},
					{
						id: "rowB",
						version: 5,
						status: "READY",
						source: "UPLOAD",
						fileCount: 2,
						createdAt: new Date(),
						deferredScanStatus: "INCOMPLETE",
					},
				]}
				publishedId="published"
				publishedVersion={7}
				canPublish
				onChanged={() => undefined}
			/>,
			{ wrapper: TestQueryProvider },
		);
		const [buttonA, buttonB] = screen.getAllByRole("button", {
			name: "rollbackAction",
		});
		await user.click(buttonA);
		await user.click(screen.getByRole("checkbox", { name: "label" }));
		await user.click(screen.getByRole("checkbox", { name: "acknowledge" }));
		await user.click(screen.getByRole("button", { name: "cancelAction" }));
		expect(screen.queryByText("flaggedDialogTitle")).toBeNull();

		await user.click(buttonB);
		expect(
			screen.getByRole("checkbox", { name: "label" }),
		).not.toBeChecked();
		// Not ticked yet, so the acknowledgement box is not even rendered.
		expect(
			screen.queryByRole("checkbox", { name: "acknowledge" }),
		).toBeNull();
	});

	// A deferred mutation promise: the request that has not resolved yet is
	// exactly what a fast double-click on Confirm would otherwise duplicate.
	it("sends exactly one request when Confirm is clicked twice while a publish is pending, and disables the controls meanwhile", async () => {
		const user = userEvent.setup();
		renderScanned({ id: "pending", deferredScanStatus: "ISSUES_FOUND" });
		await user.click(
			screen.getByRole("button", { name: "rollbackAction" }),
		);
		await user.click(screen.getByRole("checkbox", { name: "label" }));
		await user.click(screen.getByRole("checkbox", { name: "acknowledge" }));
		const confirm = screen.getByRole("button", { name: "confirmAction" });

		await user.click(confirm);
		await user.click(confirm);

		await waitFor(() => expect(confirm).toBeDisabled());
		expect(publishInputs).toHaveLength(1);
		expect(
			screen.getByRole("button", { name: "cancelAction" }),
		).toBeDisabled();
		expect(screen.getByRole("checkbox", { name: "label" })).toBeDisabled();
		expect(
			screen.getByRole("checkbox", { name: "acknowledge" }),
		).toBeDisabled();

		pendingPublish.resolve?.();
		await waitFor(() =>
			expect(screen.queryByText("flaggedDialogTitle")).toBeNull(),
		);
	});

	it("keeps the dialog open and shows the error toast when the acknowledged publish fails", async () => {
		const user = userEvent.setup();
		renderScanned({ id: "fail", deferredScanStatus: "ISSUES_FOUND" });
		await user.click(
			screen.getByRole("button", { name: "rollbackAction" }),
		);
		await user.click(screen.getByRole("checkbox", { name: "label" }));
		await user.click(screen.getByRole("checkbox", { name: "acknowledge" }));
		await user.click(screen.getByRole("button", { name: "confirmAction" }));

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith("conflict"),
		);
		expect(screen.getByText("flaggedDialogTitle")).toBeTruthy();
	});

	it("publishes a passed scan through the ordinary confirm, with no flag sent", async () => {
		const user = userEvent.setup();
		renderScanned({ deferredScanStatus: "PASSED" });
		expect(screen.getByText("scanPassedPill")).toBeTruthy();
		await user.click(
			screen.getByRole("button", { name: "rollbackAction" }),
		);
		// No dialog for a passed scan — the same confirmation as any other
		// row, and no flag sent.
		expect(screen.queryByText("flaggedDialogTitle")).toBeNull();
		expect(confirmMock).toHaveBeenCalled();
		await waitFor(() => expect(publishInputs).toHaveLength(1));
		expect(publishInputs[0]).not.toHaveProperty("publishBeforeScan");
	});

	// The button itself is what depended on the permission: a member who
	// cannot publish at all sees no button, flagged row or not.
	it("offers no publish/rollback button at all to a member who cannot publish", () => {
		renderScanned(
			{ deferredScanStatus: "ISSUES_FOUND" },
			{ canPublish: false, canMutate: false },
		);
		expect(
			screen.queryByRole("button", { name: "rollbackAction" }),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: "publishAction" }),
		).toBeNull();
	});

	it("badges nothing for an ordinary version, and sends no flag when published", async () => {
		const user = userEvent.setup();
		renderScanned({ publishBeforeScan: false, deferredScanStatus: null });
		expect(screen.queryByText("publishedBeforeScanPill")).toBeNull();
		await user.click(
			screen.getByRole("button", { name: "rollbackAction" }),
		);
		expect(screen.queryByText("flaggedDialogTitle")).toBeNull();
		await waitFor(() => expect(publishInputs).toHaveLength(1));
		expect(publishInputs[0]).not.toHaveProperty("publishBeforeScan");
	});

	it("lists the scan's findings behind See findings, with the rejected-upload labels", async () => {
		const user = userEvent.setup();
		renderScanned({
			deferredScanStatus: "ISSUES_FOUND",
			deferredScanFindings: [
				{
					path: "rules/deploy.md",
					reason: "secret",
					detail: "aws-access-key",
					line: 3,
				},
				{ path: "(truncated)", reason: "truncated", detail: "40" },
			],
		});
		expect(screen.queryByText("rules/deploy.md")).toBeNull();
		await user.click(
			screen.getByRole("button", { name: "seeFindingsAction" }),
		);
		expect(screen.getByText("rules/deploy.md")).toBeTruthy();
		expect(
			screen.getByText(
				en.projects.codingInstructions.rejectedBanner.secretLabels[
					"aws-access-key"
				],
			),
		).toBeTruthy();
		expect(screen.getByText("truncatedSummary:40")).toBeTruthy();
		expect(screen.queryByText("(truncated)")).toBeNull();
	});

	// An INCOMPLETE scan keeps what it found before a file defeated its last
	// attempt (Fizzy #2737 review), behind the same button, with a line
	// saying the scan could not check every file.
	it("lists an incomplete scan's findings behind See findings, and says the rest was not checked", async () => {
		const user = userEvent.setup();
		renderScanned({
			deferredScanStatus: "INCOMPLETE",
			deferredScanFindings: [
				{
					path: "rules/deploy.md",
					reason: "secret",
					detail: "aws-access-key",
					line: 3,
				},
			],
		});
		expect(screen.queryByText("scanIncompleteFindingsNote")).toBeNull();
		await user.click(
			screen.getByRole("button", { name: "seeFindingsAction" }),
		);
		expect(screen.getByText("rules/deploy.md")).toBeTruthy();
		expect(screen.getByText("scanIncompleteFindingsNote")).toBeTruthy();
	});

	// Fizzy #2759: the files an INCOMPLETE scan could not read are named, and
	// the note speaks of THOSE rows rather than of unlisted files.
	it("names the files an incomplete scan could not read, and says they were not scanned", async () => {
		const user = userEvent.setup();
		renderScanned({
			deferredScanStatus: "INCOMPLETE",
			deferredScanFindings: [
				{ path: "rules/deploy.md", reason: "scan_failed" },
			],
		});
		await user.click(
			screen.getByRole("button", { name: "seeFindingsAction" }),
		);
		expect(screen.getByText("rules/deploy.md")).toBeTruthy();
		expect(screen.getByText("scanUnreadableNote")).toBeTruthy();
		expect(screen.queryByText("scanIncompleteFindingsNote")).toBeNull();
	});

	it("offers no findings for an incomplete scan that established none", () => {
		renderScanned({
			deferredScanStatus: "INCOMPLETE",
			deferredScanFindings: null,
		});
		expect(
			screen.queryByRole("button", { name: "seeFindingsAction" }),
		).toBeNull();
	});

	// Deleting a version mid-scan removes the rows the scan reads, which only
	// turns its verdict into "could not finish".
	it("hides Delete while the scan is running, and offers it once it finished", () => {
		const { unmount } = renderScanned({ deferredScanStatus: "PENDING" });
		expect(
			screen.queryByRole("button", { name: "deleteAction" }),
		).toBeNull();
		unmount();
		renderScanned({ deferredScanStatus: "INCOMPLETE" });
		expect(
			screen.getByRole("button", { name: "deleteAction" }),
		).toBeTruthy();
	});
});

describe("InstructionsHistory: publishing from the page the person saw", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		publishInputs.length = 0;
		confirmMock.mockImplementation((options: ConfirmOptions) =>
			options.onConfirm(),
		);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const row = (
		id: string,
		version: number,
		extra: Record<string, unknown> = {},
	) => ({
		id,
		version,
		status: "READY",
		source: "UPLOAD",
		fileCount: 3,
		createdAt: new Date(),
		...extra,
	});

	function renderHistory(
		snapshots: Array<ReturnType<typeof row>>,
		props: Partial<React.ComponentProps<typeof InstructionsHistory>> = {},
	) {
		const onChanged = vi.fn();
		render(
			<InstructionsHistory
				projectId="p"
				open
				onOpenChange={() => undefined}
				snapshots={snapshots}
				publishedId="v8"
				publishedVersion={8}
				onChanged={onChanged}
				{...props}
			/>,
			{ wrapper: TestQueryProvider },
		);
		return { onChanged };
	}

	it("sends the published version it displays with a publish and with a rollback", async () => {
		renderHistory([row("v9", 9), row("v8", 8), row("v7", 7)]);

		await userEvent.click(
			screen.getByRole("button", { name: "publishAction" }),
		);
		await userEvent.click(
			screen.getByRole("button", { name: "rollbackAction" }),
		);

		await waitFor(() => expect(publishInputs).toHaveLength(2));
		expect(publishInputs.map((i) => i.expectedPublishedSnapshotId)).toEqual(
			["v8", "v8"],
		);
	});

	it("says 'nothing was published' when nothing is", async () => {
		renderHistory([row("v1", 1)], {
			publishedId: null,
			publishedVersion: null,
		});

		await userEvent.click(
			screen.getByRole("button", { name: "publishAction" }),
		);

		await waitFor(() => expect(publishInputs).toHaveLength(1));
		expect(publishInputs[0]).toHaveProperty(
			"expectedPublishedSnapshotId",
			null,
		);
	});

	it("tells the person which version was published since, re-reads, and shows no generic error", async () => {
		const { onChanged } = renderHistory([row("stale", 9), row("v8", 8)]);

		await userEvent.click(
			screen.getByRole("button", { name: "publishAction" }),
		);

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith("publishedChanged:9"),
		);
		expect(toast.error).toHaveBeenCalledTimes(1);
		expect(onChanged).toHaveBeenCalledTimes(1);
	});

	it("warns a rollback how many running checks will publish themselves afterwards", async () => {
		renderHistory([
			row("v9", 9, { status: "VALIDATING", publishOnReady: true }),
			row("v10", 10, { status: "RECEIVING", publishOnReady: true }),
			row("v8", 8),
			row("v7", 7),
		]);

		await userEvent.click(
			screen.getByRole("button", { name: "rollbackAction" }),
		);

		expect(confirmMock).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "rollbackConfirm:7",
				message: "rollbackConfirmBody rollbackPendingNote:2",
			}),
		);
	});

	it("adds no warning to a rollback when nothing is still being checked, nor to a plain publish", async () => {
		renderHistory([
			row("v9", 9),
			row("v8", 8),
			row("v7", 7),
			row("v10", 10, { status: "VALIDATING", publishOnReady: true }),
		]);

		await userEvent.click(
			screen.getByRole("button", { name: "publishAction" }),
		);
		expect(confirmMock).toHaveBeenLastCalledWith(
			expect.objectContaining({ title: "publishConfirm:9" }),
		);
		expect(confirmMock.mock.lastCall?.[0]).not.toHaveProperty("message");
	});

	it("counts a repository sync run that has not staged its snapshot yet", async () => {
		renderHistory([row("v8", 8), row("v7", 7)], {
			syncRunPendingPublish: true,
		});

		await userEvent.click(
			screen.getByRole("button", { name: "rollbackAction" }),
		);

		expect(confirmMock).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "rollbackConfirm:7",
				message: "rollbackConfirmBody rollbackPendingNote:1",
			}),
		);
	});
});

describe("InstructionsHistory: deleting a version", () => {
	function renderDeletable(onChanged = vi.fn()) {
		render(
			<InstructionsHistory
				projectId="p"
				open
				onOpenChange={() => undefined}
				snapshots={[
					{
						id: "ok",
						version: 5,
						status: "READY",
						source: "UPLOAD",
						fileCount: 3,
						createdAt: new Date(),
					},
				]}
				publishedId="published"
				publishedVersion={7}
				canMutate
				onChanged={onChanged}
			/>,
			{ wrapper: TestQueryProvider },
		);
		return onChanged;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		confirmMock.mockImplementation((options: ConfirmOptions) =>
			options.onConfirm(),
		);
	});

	it("asks in the app's own dialog, destructively, and says it cannot be undone", async () => {
		const onChanged = renderDeletable();

		await userEvent.click(
			screen.getByRole("button", { name: "deleteAction" }),
		);

		expect(confirmMock).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "deleteConfirm:5",
				message: "deleteConfirmBody",
				confirmLabel: "deleteConfirmAction",
				destructive: true,
			}),
		);
		await waitFor(() => expect(onChanged).toHaveBeenCalled());
	});

	// jsdom does not lay anything out. A device sweep at 375px found this row's
	// actions (Roll back, Download, Compare, Delete) in one unwrappable,
	// non-shrinking line that ran off the dialog's right edge.
	it("lets a version row's actions wrap and the row stack on a narrow screen", () => {
		renderDeletable();

		const actions = screen.getByRole("button", {
			name: "deleteAction",
		}).parentElement;
		expect(actions?.className).toContain("flex-wrap");
		expect(actions?.className).not.toContain("shrink-0");
		expect(actions?.parentElement?.className).toContain("flex-col");
		expect(actions?.parentElement?.className).toContain("sm:flex-row");
	});

	it("deletes nothing when the dialog is dismissed", async () => {
		confirmMock.mockImplementation(() => undefined);
		const onChanged = renderDeletable();

		await userEvent.click(
			screen.getByRole("button", { name: "deleteAction" }),
		);

		expect(confirmMock).toHaveBeenCalledTimes(1);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(onChanged).not.toHaveBeenCalled();
	});
});

describe("InstructionsHistory: what the dialog is called", () => {
	function renderTitled(repositoryBacked: boolean) {
		render(
			<InstructionsHistory
				projectId="p"
				open
				onOpenChange={() => undefined}
				snapshots={[]}
				publishedId={null}
				publishedVersion={null}
				repositoryBacked={repositoryBacked}
				onChanged={() => undefined}
			/>,
			{ wrapper: TestQueryProvider },
		);
	}

	it("calls an upload project's list Versions, not 'Upload history'", () => {
		renderTitled(false);

		expect(screen.getByText("title")).toBeTruthy();
		expect(screen.getByText("description")).toBeTruthy();
		expect(en.projects.codingInstructions.history.title).toBe("Versions");
	});

	it("calls a repository project's list Synced versions, because none of them was uploaded", () => {
		renderTitled(true);

		expect(screen.getByText("titleRepository")).toBeTruthy();
		expect(screen.getByText("descriptionRepository")).toBeTruthy();
		expect(en.projects.codingInstructions.history.titleRepository).toBe(
			"Synced versions",
		);
	});
});
