/**
 * `InstructionsPublishedView` (and the `InstructionsRejectedBanner` it
 * composes) route every string through `useTranslations`, and the point of
 * this test is specifically to verify DYNAMIC values (a version number, file
 * counts, an uploader's name) are threaded correctly into that copy. The
 * shared `next-intl` mock in `vitest.setup.ts` only echoes the translation
 * KEY back and ignores interpolation values entirely, which would make that
 * unverifiable — so this suite overrides it with one that resolves the REAL
 * `en.json` copy and performs the `{name}`-style substitution, the same
 * technique `components/__tests__/DocumentsList-queued.test.tsx` uses.
 */
import type { InstructionRejection } from "@repo/database";
import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

function resolve(path: string): unknown {
	return path.split(".").reduce<unknown>((node, key) => {
		if (node && typeof node === "object") {
			return (node as Record<string, unknown>)[key];
		}
		return undefined;
	}, en);
}

function makeT(namespace: string) {
	const t = (key: string, values?: Record<string, unknown>) => {
		const raw = resolve(`${namespace}.${key}`);
		if (typeof raw !== "string") {
			throw new Error(`missing translation: ${namespace}.${key}`);
		}
		let out = raw;
		for (const [name, value] of Object.entries(values ?? {})) {
			out = out.replaceAll(`{${name}}`, String(value));
		}
		return out;
	};
	t.raw = (key: string) => resolve(`${namespace}.${key}`);
	return t;
}

vi.mock("next-intl", () => ({
	useTranslations: (namespace: string) => makeT(namespace),
	useLocale: () => "en",
	useFormatter: () => ({
		dateTime: (d: Date) => d.toISOString(),
		number: (n: number) => String(n),
		relativeTime: (d: Date) => d.toISOString(),
	}),
	useMessages: () => ({}),
	NextIntlClientProvider: ({ children }: { children: ReactNode }) => children,
}));

// `PageTourButton` (rendered in the header) calls `useFeatureFlag`, which
// throws without a `FeatureFlagProvider` ancestor — this view has none, so
// stub the hook the same way `ContextUploaderDialog.test.tsx` does. The
// PUBLISHING_SUITE value itself is irrelevant to this page's tour.
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));

/**
 * Controllable per test, mirroring `ProjectReadinessPanel`'s own tests: the
 * "Connect your agent" button fails closed on `organizationId`, so both the
 * present and absent case need to be driven from here rather than a fixed
 * mock.
 */
const orgContextState = vi.hoisted(() => ({
	organizationId: "org-hosting-the-project" as string | null,
	organizationSlug: "example-org" as string | null,
	isGuest: false,
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: orgContextState.organizationId,
		organizationSlug: orgContextState.organizationSlug,
		isGuest: orgContextState.isGuest,
	}),
}));

/**
 * `ConnectCliDialog` mints a real key and renders a live credential — none of
 * that belongs to this suite, which only has to prove the button opens it
 * with the right purpose and project name (the dialog's own contract is
 * pinned by `ConnectCliDialog.test.tsx`).
 */
const connectCliDialogProps: Array<Record<string, unknown>> = [];
vi.mock("@saas/projects/components/cli-connection/ConnectCliDialog", () => ({
	ConnectCliDialog: (props: Record<string, unknown>) => {
		connectCliDialogProps.push(props);
		if (!props.open) {
			return null;
		}
		return <div data-testid="connect-cli-dialog-stub" />;
	},
}));

const finalizeCalls: Array<Record<string, unknown>> = [];

function queryOptionsStub(queryFn: () => Promise<unknown>) {
	return (o: { input: unknown }) => ({
		queryKey: ["stub-query", o.input],
		queryFn,
	});
}

function mutationOptionsStub(mutationFn: (input: unknown) => Promise<unknown>) {
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
				listFiles: {
					queryOptions: queryOptionsStub(async () => []),
				},
				getSettings: {
					queryOptions: queryOptionsStub(async () => ({
						ignoreGlobs: null,
						defaultIgnoreGlobs: [],
						sourceOfTruth: null,
					})),
				},
				createDownloadUrl: {
					mutationOptions: mutationOptionsStub(async () => ({
						url: "https://example.com/download",
						fileCount: 0,
					})),
				},
				publish: {
					mutationOptions: mutationOptionsStub(async () => ({
						published: true,
					})),
				},
				delete: {
					mutationOptions: mutationOptionsStub(async () => ({
						deleted: true,
					})),
				},
				updateSettings: {
					mutationOptions: mutationOptionsStub(async () => ({
						ok: true,
					})),
				},
				finalize: {
					mutationOptions: mutationOptionsStub(
						async (input: unknown) => {
							finalizeCalls.push(
								input as Record<string, unknown>,
							);
							return { status: "VALIDATING" };
						},
					),
				},
			},
		},
	},
}));

import { InstructionsPublishedView } from "../InstructionsPublishedView";

function TestQueryProvider({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

beforeEach(() => {
	orgContextState.organizationId = "org-hosting-the-project";
	orgContextState.organizationSlug = "example-org";
	orgContextState.isGuest = false;
	connectCliDialogProps.length = 0;
});

describe("InstructionsPublishedView", () => {
	it("states the published version in one sentence and shows the rejected banner for a newer rejected upload", async () => {
		const rejection: InstructionRejection[] = [
			{
				path: ".claude/settings.json",
				reason: "secret",
				detail: "azure-devops-pat",
				line: 41,
			},
		];
		render(
			<InstructionsPublishedView
				projectId="p"
				projectName="Checkout Rewrite"
				published={
					{
						id: "s7",
						version: 7,
						status: "READY",
						fileCount: 452,
						excludedCount: 2164,
						createdAt: new Date(),
						source: "UPLOAD",
						user: { id: "u", name: "A. Member" },
						settingsFrozen: { layer: "fabricignore" },
					} as never
				}
				snapshots={
					[
						{
							id: "s8",
							version: 8,
							status: "REJECTED",
							rejection,
						} as never,
					] as never
				}
				onReplaceClick={() => undefined}
				onChanged={() => undefined}
			/>,
			{ wrapper: TestQueryProvider },
		);
		expect(screen.getByText("Version 7 is published")).toBeInTheDocument();
		expect(
			screen.getByText(
				/Uploaded by A\. Member .* from a folder\. 452 files stored, 2,164 left out/,
			),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", {
				name: "Upload rejected: 1 file contains secrets",
			}),
		).toBeInTheDocument();
		expect(screen.getByText(".claude/settings.json")).toBeInTheDocument();
		expect(
			screen.getByText("Azure DevOps personal access token"),
		).toBeInTheDocument();
	});

	// R30/I2: FAILED is a dead branch until something writes it, and until
	// this banner exists there is no way back from one except re-uploading
	// the whole folder while the stuck row stays behind.
	it("offers 'Try again' for a FAILED newest snapshot and wires it to finalize", async () => {
		const onChanged = vi.fn();
		finalizeCalls.length = 0;
		render(
			<InstructionsPublishedView
				projectId="p"
				projectName="Checkout Rewrite"
				published={null}
				snapshots={
					[
						{
							id: "s3",
							version: 3,
							status: "FAILED",
							source: "UPLOAD",
							fileCount: 0,
							excludedCount: 0,
							createdAt: new Date(),
						} as never,
					] as never
				}
				onReplaceClick={() => undefined}
				onChanged={onChanged}
			/>,
			{ wrapper: TestQueryProvider },
		);

		const alert = screen.getByRole("alert");
		expect(alert).toHaveTextContent(
			"We could not finish checking this upload",
		);
		expect(alert).toHaveTextContent("Checking version 3 stopped");

		await userEvent.click(
			screen.getByRole("button", { name: "Try again" }),
		);

		await waitFor(() => expect(onChanged).toHaveBeenCalled());
		expect(finalizeCalls).toEqual([{ projectId: "p", snapshotId: "s3" }]);
	});

	// M7: `checking` was computed but rendered only as the third branch of a
	// `published ? … : checking ? … : …` chain, so it could never appear
	// while a version was published — which is exactly a REPLACE upload, the
	// case where the tab otherwise looks untouched for the whole check.
	it("says a newer upload is being checked while the previous version stays published", () => {
		render(
			<InstructionsPublishedView
				projectId="p"
				projectName="Checkout Rewrite"
				published={
					{
						id: "s7",
						version: 7,
						status: "READY",
						fileCount: 4,
						excludedCount: 0,
						createdAt: new Date(),
						source: "UPLOAD",
						user: { id: "u", name: "A. Member" },
					} as never
				}
				snapshots={
					[
						{
							id: "s8",
							version: 8,
							status: "VALIDATING",
							source: "UPLOAD",
							fileCount: 4,
							excludedCount: 0,
							createdAt: new Date(),
						} as never,
					] as never
				}
				onReplaceClick={() => undefined}
				onChanged={() => undefined}
			/>,
			{ wrapper: TestQueryProvider },
		);
		// Both lines: the published version is still the published one, AND
		// the new upload is visibly in progress.
		expect(screen.getByText("Version 7 is published")).toBeInTheDocument();
		const checking = screen.getByText(
			en.projects.codingInstructions.publishedView.checkingSummary,
		);
		expect(checking).toBeInTheDocument();
		// Announced without an interaction, so it needs a live region.
		expect(checking).toHaveAttribute("aria-live", "polite");
	});

	it("does not offer 'Try again' when the newest snapshot is READY", () => {
		render(
			<InstructionsPublishedView
				projectId="p"
				projectName="Checkout Rewrite"
				published={null}
				snapshots={
					[
						{
							id: "s3",
							version: 3,
							status: "READY",
							source: "UPLOAD",
							fileCount: 1,
							excludedCount: 0,
							createdAt: new Date(),
						} as never,
					] as never
				}
				onReplaceClick={() => undefined}
				onChanged={() => undefined}
			/>,
			{ wrapper: TestQueryProvider },
		);
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
	});
});

/**
 * The "Connect your agent" button fails closed on `organizationId` the same
 * way `ProjectReadinessPanel`'s own issuing view does (there is nothing to
 * mint a key against without one), and opens `ConnectCliDialog` with
 * `purpose="coding-instructions"` so its starter sentence names the
 * published instructions rather than general project context.
 */
describe("InstructionsPublishedView — connect your agent", () => {
	function renderPublished() {
		return render(
			<InstructionsPublishedView
				projectId="p"
				projectName="Checkout Rewrite"
				published={
					{
						id: "s7",
						version: 7,
						status: "READY",
						fileCount: 4,
						excludedCount: 0,
						createdAt: new Date(),
						source: "UPLOAD",
						user: { id: "u", name: "A. Member" },
					} as never
				}
				snapshots={[] as never}
				onReplaceClick={() => undefined}
				onChanged={() => undefined}
			/>,
			{ wrapper: TestQueryProvider },
		);
	}

	it("renders the button when an organization id is present and opens the dialog with the coding-instructions purpose and project name", async () => {
		const user = userEvent.setup();
		renderPublished();

		const button = screen.getByRole("button", {
			name: "Connect your agent",
		});
		expect(button).toHaveAttribute(
			"data-onboarding-target",
			"coding-instructions-connect",
		);
		expect(
			screen.queryByTestId("connect-cli-dialog-stub"),
		).not.toBeInTheDocument();

		await user.click(button);

		expect(
			screen.getByTestId("connect-cli-dialog-stub"),
		).toBeInTheDocument();
		const lastProps =
			connectCliDialogProps[connectCliDialogProps.length - 1];
		expect(lastProps).toMatchObject({
			open: true,
			organizationId: "org-hosting-the-project",
			organizationSlug: "example-org",
			projectName: "Checkout Rewrite",
			purpose: "coding-instructions",
		});
	});

	it("does not render the button when there is no organization id", () => {
		orgContextState.organizationId = null;
		renderPublished();

		expect(
			screen.queryByRole("button", { name: "Connect your agent" }),
		).not.toBeInTheDocument();
	});

	// An invited cross-organization project guest views this project under
	// the HOST organization's thin record, so `organizationId` is truthy but
	// there is no membership row for the guest in that organization — the
	// create procedure's host-membership check would refuse them.
	it("does not render the button or mount the dialog for an invited guest", () => {
		orgContextState.isGuest = true;
		renderPublished();

		expect(
			screen.queryByRole("button", { name: "Connect your agent" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByTestId("connect-cli-dialog-stub"),
		).not.toBeInTheDocument();
	});
});

/**
 * Fizzy #2546. "Add file" and the per-file Edit/Delete actions exist only for
 * someone who may change the published files AND only when the project's
 * instructions are not repository-backed — spec §6.12 makes git the single
 * source of truth for such a project, and the server refuses an edit there.
 */
describe("InstructionsPublishedView — editing entry points", () => {
	function renderPublished(props: Record<string, unknown> = {}) {
		return render(
			<InstructionsPublishedView
				projectId="p"
				projectName="Checkout Rewrite"
				published={
					{
						id: "s7",
						version: 7,
						status: "READY",
						fileCount: 4,
						excludedCount: 0,
						createdAt: new Date(),
						source: "UPLOAD",
						user: { id: "u", name: "A. Member" },
					} as never
				}
				snapshots={[] as never}
				onReplaceClick={() => undefined}
				onChanged={() => undefined}
				{...props}
			/>,
			{ wrapper: TestQueryProvider },
		);
	}

	it("offers Add file to an editor", () => {
		renderPublished({ canEdit: true });
		expect(
			screen.getByRole("button", { name: "Add file" }),
		).toBeInTheDocument();
	});

	it("offers nothing to a viewer without edit rights", () => {
		renderPublished();
		expect(
			screen.queryByRole("button", { name: "Add file" }),
		).not.toBeInTheDocument();
	});

	it("offers nothing for a repository-backed project, even to an editor", () => {
		renderPublished({ canEdit: true, repositoryBacked: true });
		expect(
			screen.queryByRole("button", { name: "Add file" }),
		).not.toBeInTheDocument();
	});
});

/**
 * BLOCKING (round 5). Two people editing the same published version each get
 * a new version holding the other's unchanged files, so the automatic
 * publish is a fast-forward: the second one does NOT take the pointer
 * (`publishInstructionSnapshot`, `requireBaseUnmoved`). It stays READY and
 * unpublished, and without this line the tab simply showed the older tree
 * with nothing to say about the version that had just been saved.
 */
describe("InstructionsPublishedView — an edit the published version outran", () => {
	function renderWithNewest(newest: Record<string, unknown>) {
		return render(
			<InstructionsPublishedView
				projectId="p"
				projectName="Checkout Rewrite"
				published={
					{
						id: "s8",
						version: 8,
						status: "READY",
						fileCount: 4,
						excludedCount: 0,
						createdAt: new Date(),
						source: "UPLOAD",
						user: { id: "u", name: "A. Member" },
						baseSnapshotId: "s7",
						baseVersion: 7,
					} as never
				}
				snapshots={[newest] as never}
				onReplaceClick={() => undefined}
				onChanged={() => undefined}
			/>,
			{ wrapper: TestQueryProvider },
		);
	}

	it("says a READY edit was not published because its base stopped being the published version", () => {
		// v9 was derived from v7, but v8 — derived from the same v7 — got
		// there first.
		renderWithNewest({
			id: "s9",
			version: 9,
			status: "READY",
			source: "UPLOAD",
			fileCount: 4,
			excludedCount: 0,
			createdAt: new Date(),
			publishOnReady: true,
			baseSnapshotId: "s7",
			baseVersion: 7,
		});

		expect(
			screen.getByText(
				/Version 9 passed its checks but was not published: it was edited from version 7, and version 8 has been published since/,
			),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Open History" }),
		).toBeInTheDocument();
	});

	it("says nothing for a version deliberately saved without publishing", () => {
		// "Save as a new version" is unpublished on purpose. The pointer did
		// not outrun anything and there is nothing to report.
		renderWithNewest({
			id: "s9",
			version: 9,
			status: "READY",
			source: "UPLOAD",
			fileCount: 4,
			excludedCount: 0,
			createdAt: new Date(),
			publishOnReady: false,
			baseSnapshotId: "s8",
			baseVersion: 8,
		});

		expect(screen.queryByText(/was not published/)).not.toBeInTheDocument();
	});

	/**
	 * BLOCKING, round two: the base can be deleted or pruned between READY and
	 * the publish activity, which nulls `baseSnapshotId`. The row is still an
	 * edit, it still did not publish, and this is the case with nothing else
	 * on the page to explain it — so the line has to key on `baseVersion`.
	 */
	it("says so for an edit whose base version was deleted entirely", () => {
		renderWithNewest({
			id: "s9",
			version: 9,
			status: "READY",
			source: "UPLOAD",
			fileCount: 4,
			excludedCount: 0,
			createdAt: new Date(),
			publishOnReady: true,
			baseSnapshotId: null,
			baseVersion: 7,
		});

		expect(
			screen.getByText(
				/Version 9 passed its checks but was not published: it was edited from version 7/,
			),
		).toBeInTheDocument();
	});

	it("says nothing while an edit of the CURRENT published version is still converging", () => {
		// The ordinary case, one poll before the pointer moves: v9 was
		// derived from v8, which is still published.
		renderWithNewest({
			id: "s9",
			version: 9,
			status: "READY",
			source: "UPLOAD",
			fileCount: 4,
			excludedCount: 0,
			createdAt: new Date(),
			publishOnReady: true,
			baseSnapshotId: "s8",
			baseVersion: 8,
		});

		expect(screen.queryByText(/was not published/)).not.toBeInTheDocument();
	});
});
