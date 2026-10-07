/**
 * `InstructionsPublishedView` (and the `InstructionsRejectedBanner` it
 * composes) route every string through `useTranslations`, and the point of
 * this test is specifically to verify DYNAMIC values (a version number, file
 * counts, an uploader's name) are threaded correctly into that copy. The
 * shared `next-intl` mock in `vitest.setup.ts` only echoes the translation
 * KEY back and ignores interpolation values entirely, which would make that
 * unverifiable — so this suite overrides it with the shared `en-copy` helper,
 * which resolves the REAL `en.json` copy and performs the `{name}`-style and
 * plural substitution.
 */
import type { InstructionRejection } from "@repo/database";
import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () =>
	(await import("../../../__tests__/en-copy")).nextIntlMock(),
);

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
const finalizeResult = vi.hoisted(() => ({ status: "VALIDATING" }));
// `hold` parks the next finalize call until `release` runs, so a test can
// look at the button while a retry is in flight.
const finalizeGate = vi.hoisted(() => ({
	hold: false,
	release: null as (() => void) | null,
}));
const toastMock = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }));

vi.mock("sonner", () => ({ toast: toastMock }));

// The app's confirmation dialog is mounted once in the (saas) layout and is
// absent here; History, mounted inside this view, asks it before publishing.
vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({
		confirm: (options: { onConfirm: () => void }) => options.onConfirm(),
	}),
}));

/**
 * The file list per snapshot id, so a test can publish a new version whose
 * list differs from the one a file was selected in. Empty for every
 * snapshot a test does not set up, which is what the older tests expect.
 */
const filesBySnapshot = vi.hoisted(
	() => new Map<string, Array<Record<string, unknown>>>(),
);
const fileListGate = vi.hoisted(() => ({
	pending: new Set<string>(),
	releases: new Map<string, () => void>(),
}));

/**
 * The `compare` answer for the published row's base pair, and whether it
 * fails. Both matter: the base of an old version may have been deleted, which
 * makes the call 404, and the line must simply not appear rather than break.
 */
const compareState = vi.hoisted(() => ({
	result: null as Record<string, unknown> | null,
	error: null as Error | null,
	inputs: [] as Array<Record<string, unknown>>,
}));

/**
 * What `proposals.list` answers: the rows the header's Review button counts
 * from, and every input it was asked with.
 */
const proposalsState = vi.hoisted(() => ({
	items: [] as Array<Record<string, unknown>>,
	inputs: [] as Array<Record<string, unknown>>,
}));

/** What `listCommits` answers: the branch's first page, or a failure to read it. */
const commitsState = vi.hoisted(() => ({
	rows: [] as Array<Record<string, unknown>>,
	fails: false,
}));

function queryOptionsStub(queryFn: (input: unknown) => Promise<unknown>) {
	return (o: { input: unknown }) => ({
		queryKey: ["stub-query", o.input],
		queryFn: () => queryFn(o.input),
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
					queryOptions: queryOptionsStub(async (input) => {
						const { snapshotId } = input as { snapshotId: string };
						if (fileListGate.pending.has(snapshotId)) {
							await new Promise<void>((resolve) => {
								fileListGate.releases.set(snapshotId, resolve);
							});
						}
						return filesBySnapshot.get(snapshotId) ?? [];
					}),
				},
				compare: {
					queryOptions: queryOptionsStub(async (input) => {
						compareState.inputs.push(
							input as Record<string, unknown>,
						);
						if (compareState.error) {
							throw compareState.error;
						}
						return compareState.result;
					}),
				},
				getSettings: {
					queryOptions: queryOptionsStub(async () => ({
						ignoreGlobs: null,
						defaultIgnoreGlobs: [],
						sourceOfTruth: null,
					})),
				},
				proposals: {
					list: {
						queryOptions: queryOptionsStub(async (input) => {
							proposalsState.inputs.push(
								input as Record<string, unknown>,
							);
							return {
								items: proposalsState.items,
								nextCursor: null,
							};
						}),
					},
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
							if (finalizeGate.hold) {
								finalizeGate.hold = false;
								await new Promise<void>((resolve) => {
									finalizeGate.release = resolve;
								});
							}
							return { status: finalizeResult.status };
						},
					),
				},
				repository: {
					getCommitParent: {
						queryOptions: () => ({
							queryKey: ["commitParent"],
							enabled: false,
						}),
					},
				},
				repositorySync: {
					configure: {
						mutationOptions: mutationOptionsStub(async () => ({
							syncId: "sync_1",
							generation: 2,
						})),
					},
					listRuns: {
						queryOptions: queryOptionsStub(async () => ({
							runs: [],
						})),
					},
					disable: {
						mutationOptions: mutationOptionsStub(async () => ({
							disabled: true,
							hadConfiguration: true,
						})),
					},
					// The Commits dialog of a repository project: the branch's
					// history, which it reads once it is opened.
					listCommits: {
						queryOptions: queryOptionsStub(async () => {
							if (commitsState.fails) {
								throw new Error("unreachable");
							}
							return {
								commits: commitsState.rows,
								nextCursor: null,
							};
						}),
						key: () => ["stub-query"],
					},
				},
				revertCommit: {
					mutationOptions: mutationOptionsStub(async () => ({
						outcome: "reverted",
					})),
				},
			},
		},
	},
}));

// The file pane has its own query (`getFile`) and its own tests; here it
// only needs to say WHICH path it was asked to show, and keep the props it was
// given (the change badge's inputs among them).
const fileViewProps: Array<Record<string, unknown>> = [];
vi.mock("../InstructionFileView", () => ({
	InstructionFileView: (props: {
		currentSnapshotId?: string;
		onDraftStateChange?: (
			draft: {
				snapshotId: string;
				path: string;
			} | null,
		) => void;
		path: string;
		projectId: string;
		snapshotId: string;
	}) => {
		const [draftPath, setDraftPath] = useState<string | null>(null);
		fileViewProps.push(props);
		return (
			<>
				<div
					data-draft-path={draftPath ?? ""}
					data-current-snapshot-id={props.currentSnapshotId}
					data-snapshot-id={props.snapshotId}
					data-testid="file-view"
				>
					{props.path}
				</div>
				<button
					onClick={() => {
						setDraftPath(props.path);
						props.onDraftStateChange?.({
							snapshotId: props.snapshotId,
							path: props.path,
						});
					}}
					type="button"
				>
					Keep draft
				</button>
			</>
		);
	},
}));
/** The props the proposals dialog was last mounted with. */
const proposalsProps: Array<Record<string, unknown>> = [];
vi.mock("../InstructionProposals", () => ({
	InstructionProposals: (props: Record<string, unknown>) => {
		proposalsProps.push(props);
		return null;
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

/**
 * The header keeps Connect your agent, Upload or Replace, History and Download
 * in view and puts everything else under More. Opening it is the first step of
 * reaching any of those, and what it holds are `menuitem`s.
 */
async function openMore() {
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: "More" }));
	return user;
}

function menuItem(name: string) {
	return screen.getByRole("menuitem", { name });
}

function queryMenuItem(name: string) {
	return screen.queryByRole("menuitem", { name });
}

beforeEach(() => {
	orgContextState.organizationId = "org-hosting-the-project";
	orgContextState.organizationSlug = "example-org";
	orgContextState.isGuest = false;
	connectCliDialogProps.length = 0;
	filesBySnapshot.clear();
	fileListGate.pending.clear();
	fileListGate.releases.clear();
	compareState.result = null;
	compareState.error = null;
	compareState.inputs = [];
	proposalsProps.length = 0;
	proposalsState.items = [];
	proposalsState.inputs = [];
	fileViewProps.length = 0;
	finalizeResult.status = "VALIDATING";
	commitsState.rows = [];
	commitsState.fails = false;
	toastMock.info.mockClear();
	toastMock.error.mockClear();
});

function treeFile(id: string, path: string): Record<string, unknown> {
	return {
		id,
		path,
		kind: "KNOWLEDGE",
		name: null,
		description: null,
		size: 12,
		mimeType: "text/markdown",
		isText: true,
		mode: null,
	};
}

/**
 * The selection is a path, and a path can outlive the version it was chosen
 * in: Delete file publishes a version without it, and the pane must not go
 * on asking the new version for a file it does not have.
 */
describe("InstructionsPublishedView — selection across versions", () => {
	function publishedSnapshot(id: string, version: number) {
		return {
			id,
			version,
			status: "READY",
			fileCount: 2,
			excludedCount: 0,
			createdAt: new Date(),
			source: "UPLOAD",
			user: { id: "u", name: "A. Member" },
		} as never;
	}

	function renderVersion(id: string, version: number, projectId = "p") {
		return (
			<InstructionsPublishedView
				projectId={projectId}
				projectName="Checkout Rewrite"
				published={publishedSnapshot(id, version)}
				snapshots={[] as never}
				onReplaceClick={() => undefined}
				onChanged={() => undefined}
			/>
		);
	}

	it("drops the selection when the published version no longer has that file", async () => {
		filesBySnapshot.set("s8", [
			treeFile("f1", "guide.md"),
			treeFile("f2", "notes.md"),
		]);
		filesBySnapshot.set("s9", [treeFile("f1", "guide.md")]);
		const user = userEvent.setup();
		const view = render(renderVersion("s8", 8), {
			wrapper: TestQueryProvider,
		});

		await user.click(
			await screen.findByRole("button", { name: "notes.md" }),
		);
		expect(screen.getByTestId("file-view")).toHaveTextContent("notes.md");

		// Delete file published version 9 and the poll swapped it in. Wait
		// for the NEW list to have rendered before judging the pane: while
		// it loads, the pane is empty for a different reason, and asserting
		// then would pass for an implementation that restores the stale
		// path once the list arrives.
		view.rerender(renderVersion("s9", 9));
		expect(
			await screen.findByRole("button", { name: "guide.md" }),
		).toBeInTheDocument();

		expect(screen.queryByTestId("file-view")).not.toBeInTheDocument();
		expect(
			screen.getByText(
				en.projects.codingInstructions.publishedView.selectFilePrompt,
			),
		).toBeInTheDocument();
	});

	it("falls back to the entry file, not to the file that is gone, when the version has one", async () => {
		filesBySnapshot.set("s8", [
			treeFile("f1", "AGENTS.md"),
			treeFile("f2", "notes.md"),
		]);
		filesBySnapshot.set("s9", [treeFile("f1", "AGENTS.md")]);
		const user = userEvent.setup();
		const view = render(renderVersion("s8", 8), {
			wrapper: TestQueryProvider,
		});
		await user.click(
			await screen.findByRole("button", { name: "notes.md" }),
		);
		expect(screen.getByTestId("file-view")).toHaveTextContent("notes.md");

		view.rerender(renderVersion("s9", 9));
		await waitFor(() =>
			expect(screen.getByTestId("file-view")).toHaveTextContent(
				"AGENTS.md",
			),
		);

		expect(screen.getByTestId("file-view")).not.toHaveTextContent(
			"notes.md",
		);
	});

	describe("the file the tab opens on", () => {
		function renderFiles(paths: string[]) {
			filesBySnapshot.set(
				"s8",
				paths.map((path, i) => treeFile(`f${i}`, path)),
			);
			return render(renderVersion("s8", 8), {
				wrapper: TestQueryProvider,
			});
		}

		it("is the root CLAUDE.md, before the root AGENTS.md", async () => {
			renderFiles(["AGENTS.md", "CLAUDE.md", "README.md"]);

			expect(await screen.findByTestId("file-view")).toHaveTextContent(
				"CLAUDE.md",
			);
			expect(
				screen.getByRole("button", { name: "CLAUDE.md" }),
			).toHaveAttribute("aria-current", "true");
		});

		it("is the root AGENTS.md when there is no CLAUDE.md", async () => {
			renderFiles(["README.md", "AGENTS.md"]);

			expect(await screen.findByTestId("file-view")).toHaveTextContent(
				"AGENTS.md",
			);
		});

		it("is nothing when neither is at the root, which asks the reader to pick one", async () => {
			renderFiles(["docs/CLAUDE.md", "README.md"]);

			expect(
				await screen.findByText(
					en.projects.codingInstructions.publishedView
						.selectFilePrompt,
				),
			).toBeInTheDocument();
			expect(screen.queryByTestId("file-view")).not.toBeInTheDocument();
		});

		it("gives way to the file the reader picks, and opens the folders above it", async () => {
			const user = userEvent.setup();
			renderFiles(["CLAUDE.md", "docs/guides/setup.md"]);
			await screen.findByTestId("file-view");

			await user.click(screen.getByRole("button", { name: /docs/ }));
			await user.click(screen.getByRole("button", { name: /guides/ }));
			await user.click(screen.getByRole("button", { name: "setup.md" }));

			expect(screen.getByTestId("file-view")).toHaveTextContent(
				"docs/guides/setup.md",
			);
		});
	});

	it("keeps the selection when the file survives into the new version, without flashing the prompt while its list loads", async () => {
		filesBySnapshot.set("s8", [
			treeFile("f1", "AGENTS.md"),
			treeFile("f2", "notes.md"),
		]);
		filesBySnapshot.set("s9", [
			treeFile("f1", "AGENTS.md"),
			treeFile("f2", "notes.md"),
		]);
		const user = userEvent.setup();
		const view = render(renderVersion("s8", 8), {
			wrapper: TestQueryProvider,
		});
		await user.click(
			await screen.findByRole("button", { name: "notes.md" }),
		);
		expect(screen.getByTestId("file-view")).toHaveTextContent("notes.md");

		view.rerender(renderVersion("s9", 9));
		// Immediately after the swap the new list is pending: no prompt.
		expect(
			screen.queryByText(
				en.projects.codingInstructions.publishedView.selectFilePrompt,
			),
		).not.toBeInTheDocument();

		await waitFor(() => {
			expect(screen.getByTestId("file-view")).toHaveTextContent(
				"notes.md",
			);
		});
		expect(
			screen.queryByText(
				en.projects.codingInstructions.publishedView.selectFilePrompt,
			),
		).not.toBeInTheDocument();
	});

	it("keeps the mounted editor's prior file while the next published list loads", async () => {
		filesBySnapshot.set("s8", [treeFile("f1", "notes.md")]);
		filesBySnapshot.set("s9", [treeFile("f1", "notes.md")]);
		const user = userEvent.setup();
		const view = render(renderVersion("s8", 8), {
			wrapper: TestQueryProvider,
		});
		await user.click(
			await screen.findByRole("button", { name: "notes.md" }),
		);

		fileListGate.pending.add("s9");
		view.rerender(renderVersion("s9", 9));
		await waitFor(() =>
			expect(fileListGate.releases.get("s9")).toBeTypeOf("function"),
		);

		expect(screen.getByTestId("file-view")).toHaveTextContent("notes.md");
		expect(screen.getByTestId("file-view")).toHaveAttribute(
			"data-snapshot-id",
			"s8",
		);
		expect(screen.getByTestId("file-view")).toHaveAttribute(
			"data-current-snapshot-id",
			"s9",
		);

		fileListGate.pending.delete("s9");
		fileListGate.releases.get("s9")?.();
		await waitFor(() =>
			expect(screen.getByTestId("file-view")).toHaveAttribute(
				"data-snapshot-id",
				"s9",
			),
		);
	});

	it("keeps a drafted file mounted after the next version removes it", async () => {
		filesBySnapshot.set("s8", [treeFile("f1", "notes.md")]);
		filesBySnapshot.set("s9", []);
		const user = userEvent.setup();
		const view = render(renderVersion("s8", 8), {
			wrapper: TestQueryProvider,
		});
		await user.click(
			await screen.findByRole("button", { name: "notes.md" }),
		);
		await user.click(screen.getByRole("button", { name: "Keep draft" }));

		view.rerender(renderVersion("s9", 9));
		await waitFor(() =>
			expect(screen.getByTestId("file-view")).toHaveAttribute(
				"data-snapshot-id",
				"s8",
			),
		);
		expect(screen.getByTestId("file-view")).toHaveTextContent("notes.md");
	});

	it("keeps a drafted removed entry file ahead of the successor's default file", async () => {
		filesBySnapshot.set("s8", [treeFile("f1", "AGENTS.md")]);
		filesBySnapshot.set("s9", [treeFile("f2", "CLAUDE.md")]);
		const user = userEvent.setup();
		const view = render(renderVersion("s8", 8), {
			wrapper: TestQueryProvider,
		});
		await user.click(
			await screen.findByRole("button", { name: "AGENTS.md" }),
		);
		await user.click(screen.getByRole("button", { name: "Keep draft" }));

		view.rerender(renderVersion("s9", 9));
		await waitFor(() =>
			expect(screen.getByTestId("file-view")).toHaveAttribute(
				"data-snapshot-id",
				"s8",
			),
		);
		expect(screen.getByTestId("file-view")).toHaveTextContent("AGENTS.md");
	});

	it("does not hold a prior project's drafted file while another project loads", async () => {
		filesBySnapshot.set("s8", [treeFile("f1", "notes.md")]);
		const user = userEvent.setup();
		const view = render(renderVersion("s8", 8, "project-a"), {
			wrapper: TestQueryProvider,
		});
		await user.click(
			await screen.findByRole("button", { name: "notes.md" }),
		);
		await user.click(screen.getByRole("button", { name: "Keep draft" }));

		fileListGate.pending.add("s9");
		view.rerender(renderVersion("s9", 9, "project-b"));
		await waitFor(() =>
			expect(fileListGate.releases.get("s9")).toBeTypeOf("function"),
		);

		expect(screen.queryByTestId("file-view")).toBeNull();
		fileListGate.pending.delete("s9");
		fileListGate.releases.get("s9")?.();
	});

	it("resets the file editor when another project's files are already cached", async () => {
		filesBySnapshot.set("s8", [treeFile("f1", "notes.md")]);
		filesBySnapshot.set("s9", [treeFile("f2", "CLAUDE.md")]);
		const user = userEvent.setup();
		const view = render(renderVersion("s8", 8, "project-a"), {
			wrapper: TestQueryProvider,
		});
		await user.click(
			await screen.findByRole("button", { name: "notes.md" }),
		);
		await user.click(screen.getByRole("button", { name: "Keep draft" }));
		expect(screen.getByTestId("file-view")).toHaveAttribute(
			"data-draft-path",
			"notes.md",
		);

		view.rerender(renderVersion("s9", 9, "project-b"));
		await waitFor(() =>
			expect(screen.getByTestId("file-view")).toHaveAttribute(
				"data-snapshot-id",
				"s9",
			),
		);
		expect(screen.getByTestId("file-view")).toHaveAttribute(
			"data-draft-path",
			"",
		);
	});
});

describe("InstructionsPublishedView", () => {
	it("states the published version as labelled facts and shows the rejected banner for a newer rejected upload", async () => {
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
		const strip = screen.getByTestId("instructions-status-strip");
		expect(strip).toHaveTextContent("SourceFolder upload");
		expect(strip).toHaveTextContent(/PublishedA\. Member · \d+m ago/);
		expect(strip).toHaveTextContent("Stored452 files");
		expect(strip).toHaveTextContent(
			"Left out2,164 files by the rules in .fabricignore",
		);
		expect(screen.queryByText(/^Uploaded by/)).not.toBeInTheDocument();
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

	// R30/I2: FAILED is the checks breaking, not a verdict on the files, and
	// finalize re-runs them in place, so there is a way back that is not
	// re-uploading the whole folder while the stuck row stays behind.
	describe("a FAILED newest version", () => {
		const failedSnapshot = (source: "UPLOAD" | "REPOSITORY") =>
			({
				id: "s3",
				version: 3,
				status: "FAILED",
				source,
				fileCount: 0,
				excludedCount: 0,
				createdAt: new Date(),
			}) as never;
		const publishedV2 = {
			id: "s2",
			version: 2,
			status: "READY",
			source: "UPLOAD",
			fileCount: 1,
			excludedCount: 0,
			createdAt: new Date(),
			user: { id: "u", name: "A. Member" },
		} as never;

		function renderFailed(
			source: "UPLOAD" | "REPOSITORY",
			props: Record<string, unknown> = {},
			onChanged: () => void = () => undefined,
		) {
			return render(
				<InstructionsPublishedView
					projectId="p"
					projectName="Checkout Rewrite"
					published={null}
					snapshots={[failedSnapshot(source)] as never}
					onReplaceClick={() => undefined}
					onChanged={onChanged}
					canEdit
					{...props}
				/>,
				{ wrapper: TestQueryProvider },
			);
		}

		it("upload mode: offers 'Retry checks' and 'Upload again', and wires retry to finalize", async () => {
			const onChanged = vi.fn();
			finalizeCalls.length = 0;
			renderFailed("UPLOAD", {}, onChanged);

			const alert = screen.getByRole("alert");
			expect(alert).toHaveTextContent(
				"We could not finish checking version 3",
			);
			expect(alert).toHaveTextContent("not a verdict on your files");
			expect(alert).toHaveTextContent("nothing was published");
			expect(
				screen.getByRole("button", { name: "Upload again" }),
			).toBeInTheDocument();

			await userEvent.click(
				screen.getByRole("button", { name: "Retry checks" }),
			);

			await waitFor(() => expect(onChanged).toHaveBeenCalled());
			expect(finalizeCalls).toEqual([
				{ projectId: "p", snapshotId: "s3" },
			]);
			expect(toastMock.info).not.toHaveBeenCalled();
		});

		it("names the version that stays published", () => {
			render(
				<InstructionsPublishedView
					projectId="p"
					projectName="Checkout Rewrite"
					published={publishedV2}
					snapshots={[failedSnapshot("UPLOAD")] as never}
					onReplaceClick={() => undefined}
					onChanged={() => undefined}
					canEdit
				/>,
				{ wrapper: TestQueryProvider },
			);
			expect(screen.getByRole("alert")).toHaveTextContent(
				"Version 2 stays published.",
			);
		});

		it("repository mode: offers 'Retry checks' for a synced version, never 'Upload again', and says no new sync runs", async () => {
			finalizeCalls.length = 0;
			renderFailed("REPOSITORY", {
				repositoryBacked: true,
				repositoryConfirmed: true,
			});

			const alert = screen.getByRole("alert");
			expect(alert).toHaveTextContent("same commit");
			expect(alert).toHaveTextContent("does not sync again");
			expect(
				screen.queryByRole("button", { name: "Upload again" }),
			).toBeNull();

			await userEvent.click(
				screen.getByRole("button", { name: "Retry checks" }),
			);
			await waitFor(() =>
				expect(finalizeCalls).toEqual([
					{ projectId: "p", snapshotId: "s3" },
				]),
			);
		});

		it("repository mode: an uploaded version is stale, cannot be retried, and says syncing publishes instead", () => {
			renderFailed("UPLOAD", {
				repositoryBacked: true,
				repositoryConfirmed: true,
			});
			const alert = screen.getByRole("alert");
			expect(alert).toHaveTextContent(
				"uploaded before the repository became the source",
			);
			expect(alert).toHaveTextContent("published by syncing instead");
			expect(within(alert).queryByRole("button")).toBeNull();
		});

		it("repository mode off: a synced version is stale, cannot be retried, and says uploading publishes instead", () => {
			renderFailed("REPOSITORY", { repositoryBacked: false });
			const alert = screen.getByRole("alert");
			expect(alert).toHaveTextContent("no longer the source");
			expect(alert).toHaveTextContent("published by uploading a folder");
			expect(alert).not.toHaveTextContent("Ask someone");
			expect(within(alert).queryByRole("button")).toBeNull();
		});

		it("an editor never sees the ask-someone copy while repository mode is unconfirmed", () => {
			renderFailed("REPOSITORY", {
				repositoryBacked: true,
				repositoryConfirmed: false,
			});
			const alert = screen.getByRole("alert");
			expect(alert).not.toHaveTextContent("Ask someone");
			expect(within(alert).queryByRole("button")).toBeNull();
		});

		it("without edit rights: no buttons, and it asks someone who can edit to retry", () => {
			renderFailed("UPLOAD", { canEdit: false });
			const alert = screen.getByRole("alert");
			expect(alert).toHaveTextContent(
				"Ask someone who can edit coding instructions to retry the checks",
			);
			expect(within(alert).queryByRole("button")).toBeNull();
		});

		it("while a retry is in flight: the button reads 'Retrying checks…', is busy, and Upload again is disabled", async () => {
			finalizeGate.release = null;
			finalizeGate.hold = true;
			renderFailed("UPLOAD");
			await userEvent.click(
				screen.getByRole("button", { name: "Retry checks" }),
			);
			const busy = await screen.findByRole("button", {
				name: "Retrying checks…",
			});
			expect(busy).toBeDisabled();
			expect(busy).toHaveAttribute("aria-busy", "true");
			expect(
				screen.getByRole("button", { name: "Upload again" }),
			).toBeDisabled();
			finalizeGate.release?.();
			await waitFor(() =>
				expect(
					screen.getByRole("button", { name: "Retry checks" }),
				).toBeEnabled(),
			);
		});

		it("tells the user to retry in a moment when the previous run is still closing", async () => {
			finalizeResult.status = "FAILED";
			const onChanged = vi.fn();
			renderFailed("UPLOAD", {}, onChanged);

			await userEvent.click(
				screen.getByRole("button", { name: "Retry checks" }),
			);

			await waitFor(() => expect(toastMock.info).toHaveBeenCalled());
			expect(toastMock.info).toHaveBeenCalledWith(
				en.projects.codingInstructions.publishedView
					.retryChecksStillClosing,
			);
		});
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
			en.projects.codingInstructions.publishedView.checkingSummaryUpload,
		);
		expect(checking).toBeInTheDocument();
		// Announced without an interaction, so it needs a live region.
		expect(checking).toHaveAttribute("aria-live", "polite");
	});

	describe("the checks' progress pill", () => {
		const view = (
			newest: Record<string, unknown>,
			props: Record<string, unknown> = {},
		) =>
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
								source: "UPLOAD",
								fileCount: 4,
								excludedCount: 0,
								createdAt: new Date(),
								...newest,
							} as never,
						] as never
					}
					onReplaceClick={() => undefined}
					onChanged={() => undefined}
					{...props}
				/>,
				{ wrapper: TestQueryProvider },
			);
		const copy = en.projects.codingInstructions.publishedView;

		it("says how many files the checks have decided out of how many", () => {
			view({
				status: "VALIDATING",
				progressPhase: "CHECKING",
				progressDone: 40,
				progressTotal: 120,
			});

			expect(
				screen.getByText("Checking 40 of 120 files"),
			).toBeInTheDocument();
			expect(screen.queryByText(copy.checkingSummaryUpload)).toBeNull();
		});

		it("words the saving pass as saving", () => {
			view({
				status: "VALIDATING",
				progressPhase: "SAVING",
				progressDone: 3,
				progressTotal: 120,
			});

			expect(
				screen.getByText("Saving 3 of 120 files"),
			).toBeInTheDocument();
		});

		it("announces the phase, and keeps the count out of the live region's text", () => {
			view({
				status: "VALIDATING",
				progressPhase: "CHECKING",
				progressDone: 40,
				progressTotal: 120,
			});

			expect(screen.getByText(copy.checkingPhase)).toHaveClass("sr-only");
			expect(
				screen.getByText("Checking 40 of 120 files"),
			).toHaveAttribute("aria-hidden", "true");
			expect(
				screen
					.getByText("Checking 40 of 120 files")
					.closest("[aria-live]"),
			).toHaveAttribute("aria-live", "polite");
		});

		it("keeps today's copy when nothing has reported yet", () => {
			view({ status: "VALIDATING" });

			expect(
				screen.getByText(copy.checkingSummaryUpload),
			).toBeInTheDocument();
		});

		it("keeps today's copy for a count that does not add up", () => {
			view({
				status: "VALIDATING",
				progressPhase: "CHECKING",
				progressDone: 130,
				progressTotal: 120,
			});

			expect(
				screen.getByText(copy.checkingSummaryUpload),
			).toBeInTheDocument();
		});

		it("says Publishing while the pointer catches up with a version that passed its checks", () => {
			view(
				{ status: "READY", publishOnReady: true },
				{ awaitingPublish: true },
			);

			expect(screen.getByText(copy.publishing)).toBeInTheDocument();
		});

		it("says nothing of publishing once the wait is over, or for a version that is not set to publish", () => {
			const { unmount } = view(
				{ status: "READY", publishOnReady: true },
				{ awaitingPublish: false },
			);
			expect(screen.queryByText(copy.publishing)).toBeNull();
			unmount();
		});
	});

	it("shows no failed-checks banner when the newest snapshot is READY", () => {
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
		expect(
			screen.queryByRole("button", { name: "Retry checks" }),
		).toBeNull();
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
			// `localSetupRouteFor` (Fizzy #2721): an upload project (the
			// default here — `repositoryBacked` is unset) offers the upload
			// route.
			localSetup: { kind: "upload" },
		});
	});

	it("offers no CLI route while repository settings have not loaded", async () => {
		const user = userEvent.setup();
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
				snapshots={[] as never}
				onReplaceClick={() => undefined}
				onChanged={() => undefined}
				// `repositoryBacked` fails closed while settings load, and
				// `repositoryConfirmed` is left unset the same way a caller
				// whose settings query has not resolved yet would leave it.
				repositoryBacked
			/>,
			{ wrapper: TestQueryProvider },
		);
		await user.click(
			screen.getByRole("button", { name: "Connect your agent" }),
		);
		expect(
			connectCliDialogProps[connectCliDialogProps.length - 1],
		).toMatchObject({ localSetup: null });
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

	it("offers Add file to an editor, under More", async () => {
		renderPublished({ canEdit: true });
		expect(
			screen.queryByRole("button", { name: "Add file" }),
		).not.toBeInTheDocument();
		await openMore();
		expect(menuItem("Add file")).toBeInTheDocument();
	});

	it("offers proposal review from its capability even when direct editing is unavailable", async () => {
		renderPublished({ canEdit: false, canReview: true });
		await openMore();
		expect(menuItem("Review proposals")).toBeInTheDocument();
	});

	it("lets a viewer propose a file without offering direct editing", async () => {
		renderPublished();
		await openMore();
		expect(menuItem("Propose file")).toBeInTheDocument();
		expect(menuItem("Your proposals")).toBeInTheDocument();
	});

	// jsdom does not lay anything out, so these pin the classes a device sweep
	// found missing: at 375px the fixed 340px tree column pushed the file pane
	// off the right edge, and a menu item's icon touched its label.
	it("stacks the tree above the file pane below the lg breakpoint", () => {
		renderPublished();

		const tree = document.querySelector(
			'[data-onboarding-target="coding-instructions-tree"]',
		);
		const columns = tree?.parentElement?.className ?? "";
		expect(columns).toContain("grid-cols-1");
		// Side by side only from lg: at md the app sidebar left the file pane
		// about 110px wide beside a 340px tree.
		expect(columns).toContain("lg:grid-cols-[280px_minmax(0,1fr)]");
		expect(columns).toContain("xl:grid-cols-[340px_minmax(0,1fr)]");
		expect(columns).not.toMatch(/(^|\s)md:grid-cols-/);
		expect(columns).not.toMatch(/(^|\s)grid-cols-\[340px/);
	});

	it("separates a menu item's icon from its label", async () => {
		renderPublished({ canEdit: true });
		await openMore();

		expect(menuItem("Add file").className).toContain("gap-2");
		expect(menuItem("Settings").className).toContain("gap-2");
	});

	it("offers nothing for a repository-backed project, even to an editor", async () => {
		renderPublished({
			canEdit: true,
			canReview: true,
			repositoryBacked: true,
		});
		await openMore();
		expect(queryMenuItem("Add file")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Replace" }),
		).not.toBeInTheDocument();
		expect(queryMenuItem("Review proposals")).not.toBeInTheDocument();
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

	/**
	 * A ROLLBACK is not a stranded edit. After a rollback from v9 to v8, v9 is
	 * still the newest READY row, still newer than the pointer, and its base
	 * is no longer published — every other condition for this line holds. But
	 * v9 DID publish and a person deliberately replaced it, so saying it "was
	 * not published" is false, and it would invite them to re-publish the very
	 * thing they had just chosen to leave behind. `publishedAt` is what tells
	 * the two apart; nothing ever clears it.
	 */
	it("says nothing for a version that published and was then rolled back from", () => {
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
			publishedAt: new Date("2026-09-17T10:00:00.000Z"),
		});

		expect(screen.queryByText(/was not published/)).not.toBeInTheDocument();
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

/**
 * "Changed in this version" answers the question the published summary
 * cannot: an edit publishes a whole new version, and the sentence above it
 * says how many files that version HOLDS, never which ones it touched.
 *
 * It exists only for a version with a base, and only when that base is still
 * readable. `baseSnapshotId` is `SetNull`, so an old version's base is
 * routinely gone and `compare` answers NOT_FOUND — a normal state that must
 * leave the header whole rather than showing a half-written line.
 */
describe("InstructionsPublishedView — since the version it was edited from", () => {
	function renderPublished(published: Record<string, unknown>) {
		render(
			<InstructionsPublishedView
				projectId="p"
				projectName="Checkout Rewrite"
				published={published as never}
				snapshots={[] as never}
				onReplaceClick={() => undefined}
				onChanged={() => undefined}
			/>,
			{ wrapper: TestQueryProvider },
		);
	}

	function editedVersion(overrides: Record<string, unknown> = {}) {
		return {
			id: "s9",
			version: 9,
			status: "READY",
			fileCount: 12,
			excludedCount: 0,
			createdAt: new Date(),
			source: "UPLOAD",
			user: { id: "u", name: "A. Member" },
			baseSnapshotId: "s8",
			baseVersion: 8,
			...overrides,
		};
	}

	it("names what the published version changed from the version it was edited from", async () => {
		compareState.result = {
			from: { id: "s8", version: 8 },
			to: { id: "s9", version: 9 },
			added: [{ path: "new.md" }],
			removed: [],
			changed: [{ path: "AGENTS.md" }, { path: "notes.md" }],
			unchangedCount: 9,
		};
		renderPublished(editedVersion());

		const strip = screen.getByTestId("instructions-status-strip");
		const since = await within(strip).findByText("Since version 8");
		const fact = since.parentElement as HTMLElement;
		expect(within(fact).getByText("1 added")).toHaveClass("text-success");
		expect(within(fact).getByText("2 changed")).toHaveClass(
			"text-highlight-ink",
		);
		// Nothing was removed, so nothing says so.
		expect(within(fact).queryByText(/removed/)).toBeNull();
		expect(fact).toHaveTextContent("1 added · 2 changed");
		expect(
			within(fact).getByRole("button", { name: "See what changed" }),
		).toBeInTheDocument();
		expect(compareState.inputs).toEqual([
			{ projectId: "p", fromSnapshotId: "s8", toSnapshotId: "s9" },
		]);
	});

	it("counts the removed files too, in the destructive colour", async () => {
		compareState.result = {
			from: { id: "s8", version: 8 },
			to: { id: "s9", version: 9 },
			added: [],
			removed: [{ path: "old.md" }],
			changed: [{ path: "AGENTS.md" }],
			unchangedCount: 9,
		};
		renderPublished(editedVersion());

		const since = await screen.findByText("Since version 8");
		const fact = since.parentElement as HTMLElement;
		expect(fact).toHaveTextContent("1 changed · 1 removed");
		expect(within(fact).getByText("1 removed")).toHaveClass(
			"text-destructive",
		);
	});

	it("marks the added and changed files in the tree and names them in the file's own header", async () => {
		compareState.result = {
			from: { id: "s8", version: 8 },
			to: { id: "s9", version: 9 },
			added: [{ path: "new.md" }],
			removed: [],
			changed: [{ path: "AGENTS.md" }],
			unchangedCount: 9,
		};
		filesBySnapshot.set("s9", [
			treeFile("f1", "AGENTS.md"),
			treeFile("f2", "new.md"),
			treeFile("f3", "plain.md"),
		]);
		renderPublished(editedVersion());

		const agents = await screen.findByRole("button", {
			name: /AGENTS\.md/,
		});
		await waitFor(() =>
			expect(within(agents).getByText("M")).toBeInTheDocument(),
		);
		expect(
			within(screen.getByRole("button", { name: /new\.md/ })).getByText(
				"A",
			),
		).toBeInTheDocument();
		expect(
			within(
				screen.getByRole("button", { name: /plain\.md/ }),
			).queryByText(/^[AM]$/),
		).toBeNull();
		expect(
			screen.getByTestId("instructions-tree-legend"),
		).toHaveTextContent("A added M changed");
		// The tab opens on AGENTS.md, which the published version changed.
		expect(screen.getByTestId("file-view")).toHaveTextContent("AGENTS.md");
		expect(fileViewProps.at(-1)).toMatchObject({
			path: "AGENTS.md",
			change: "changed",
			publishedVersion: 9,
		});
	});

	it("opens the comparison for that exact pair", async () => {
		compareState.result = {
			from: { id: "s8", version: 8 },
			to: { id: "s9", version: 9 },
			added: [],
			removed: [],
			changed: [{ path: "AGENTS.md" }],
			unchangedCount: 9,
		};
		renderPublished(editedVersion());

		await userEvent.click(
			await screen.findByRole("button", { name: "See what changed" }),
		);
		expect(
			await screen.findByRole("heading", { name: "Compare versions" }),
		).toBeInTheDocument();
	});

	it("says so plainly when the edit changed no files at all", async () => {
		compareState.result = {
			from: { id: "s8", version: 8 },
			to: { id: "s9", version: 9 },
			added: [],
			removed: [],
			changed: [],
			unchangedCount: 12,
		};
		renderPublished(editedVersion());

		const since = await screen.findByText("Since version 8");
		expect(since.parentElement).toHaveTextContent("No file changes");
		expect(
			screen.queryByRole("button", { name: "See what changed" }),
		).toBeNull();
		expect(
			screen.queryByTestId("instructions-tree-legend"),
		).not.toBeInTheDocument();
	});

	it("says nothing at all for an uploaded version with no base", async () => {
		renderPublished(
			editedVersion({ baseSnapshotId: null, baseVersion: null }),
		);

		const strip = screen.getByTestId("instructions-status-strip");
		expect(within(strip).getByText("Folder upload")).toBeInTheDocument();
		expect(within(strip).queryByText(/^Since version/)).toBeNull();
		expect(screen.queryByTestId("instructions-tree-legend")).toBeNull();
		// Nothing to compare, so nothing was asked of the server.
		expect(compareState.inputs).toEqual([]);
	});

	it("shows no such fact when the base version can no longer be read", async () => {
		compareState.error = new Error("Snapshot not found");
		renderPublished(editedVersion());

		const strip = screen.getByTestId("instructions-status-strip");
		await waitFor(() => expect(compareState.inputs).toHaveLength(1));
		expect(within(strip).queryByText(/^Since version/)).toBeNull();
		expect(within(strip).getByText("Stored")).toBeInTheDocument();
	});

	it("calls an edit an edit, not a folder upload", () => {
		renderPublished(editedVersion());

		const strip = screen.getByTestId("instructions-status-strip");
		expect(
			within(strip).getByText("Edited from version 8"),
		).toBeInTheDocument();
		expect(within(strip).queryByText("Folder upload")).toBeNull();
	});
});

describe("InstructionsPublishedView — repository sync (§7.1, §7.3)", () => {
	const configured = {
		syncId: "sync_1",
		repositoryIntegrationId: "int_1",
		provider: "GITHUB",
		repositoryOwner: "example-org",
		repositoryName: "instructions",
		repositoryUrl: "https://github.com/example-org/instructions.git",
		integrationStatus: "ACTIVE",
		ref: "main",
		rootPath: "",
		automatic: false,
		automaticPausedReason: null,
		automaticPausedAt: null,
		delegateName: "A. Member",
	};
	function controls(state: Record<string, unknown> = {}) {
		return {
			state: {
				sourceOfTruth: "REPOSITORY" as const,
				canConfigure: true,
				running: false,
				configured,
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
				...state,
			},
			onConfigure: vi.fn(),
			onSyncNow: vi.fn(),
			syncNowPending: false,
			onChanged: vi.fn(),
		};
	}
	function view(
		repositorySync: ReturnType<typeof controls>,
		props: Record<string, unknown> = {},
	) {
		return (
			<InstructionsPublishedView
				projectId="p"
				projectName="Checkout Rewrite"
				published={
					{
						id: "s7",
						version: 7,
						status: "READY",
						fileCount: 4,
						excludedCount: 1,
						createdAt: new Date(),
						source: "REPOSITORY",
						sourceRef: "main",
						sourceCommitSha:
							"0123456789abcdef0123456789abcdef01234567",
						repositoryIntegrationId: "int_1",
						user: { id: "u", name: "A. Member" },
					} as never
				}
				snapshots={[] as never}
				onReplaceClick={() => undefined}
				onChanged={() => undefined}
				repositoryBacked
				repositorySync={repositorySync}
				{...props}
			/>
		);
	}

	it("ends Publishing when the matching repository sync failed, while showing that failure", () => {
		render(
			view(
				controls({
					latestRun: {
						id: "sync_1:run_b",
						trigger: "MANUAL",
						startedAt: new Date(),
						finishedAt: new Date(),
						status: "FAILED",
						error: "CHILD_ABORTED",
						note: null,
						commitSha: null,
						snapshotId: "s8",
						snapshotVersion: 8,
						userName: null,
						fromCurrentConfiguration: true,
					},
				}),
				{
					awaitingPublish: true,
					snapshots: [
						{
							id: "s8",
							version: 8,
							status: "READY",
							source: "REPOSITORY",
							publishOnReady: true,
						} as never,
					],
				},
			),
			{ wrapper: TestQueryProvider },
		);

		expect(
			screen.queryByText(
				en.projects.codingInstructions.publishedView.publishing,
			),
		).toBeNull();
		expect(screen.getByTestId("repository-sync-copy")).toHaveTextContent(
			"Syncing version 8 stopped before it finished. Try Sync now again.",
		);
	});

	it("lets the repository sync own its in-flight snapshot progress without a run snapshot id", () => {
		const pending = {
			id: "s8",
			version: 8,
			status: "VALIDATING",
			source: "REPOSITORY",
			proposalDestination: null,
			progressPhase: "CHECKING",
			progressDone: 10,
			progressTotal: 40,
			createdAt: new Date(),
			sourceCommitSha: "a".repeat(40),
		};
		render(
			view(
				controls({
					running: true,
					latestRun: {
						id: "run-1",
						trigger: "MANUAL",
						startedAt: new Date(),
						finishedAt: null,
						status: null,
						error: null,
						note: null,
						commitSha: "a".repeat(40),
						snapshotId: null,
						snapshotVersion: 8,
						userName: null,
						fromCurrentConfiguration: true,
						progress: { phase: "COPYING", done: 40, total: 40 },
					},
					inFlightSnapshot: {
						status: "VALIDATING",
						version: 8,
						scanPending: false,
						progress: { phase: "CHECKING", done: 20, total: 40 },
					},
				}),
				{ snapshots: [pending], repositoryConfirmed: true },
			),
			{ wrapper: TestQueryProvider },
		);
		expect(screen.getByText("Checking 20 of 40 files")).toBeInTheDocument();
		expect(screen.queryByText("Checking 10 of 40 files")).toBeNull();
	});

	it("keeps an independent upload visible beside repository sync progress", () => {
		const upload = {
			id: "s8",
			version: 8,
			status: "VALIDATING",
			source: "UPLOAD",
			proposalDestination: null,
			progressPhase: "SAVING",
			progressDone: 10,
			progressTotal: 40,
			createdAt: new Date(),
			sourceCommitSha: null,
		};
		render(
			view(
				controls({
					running: true,
					latestRun: {
						id: "run-1",
						trigger: "MANUAL",
						startedAt: new Date(),
						finishedAt: null,
						status: null,
						error: null,
						note: null,
						commitSha: "a".repeat(40),
						snapshotId: "s7",
						snapshotVersion: 7,
						userName: null,
						fromCurrentConfiguration: true,
						progress: { phase: "COPYING", done: 40, total: 40 },
					},
					inFlightSnapshot: {
						status: "VALIDATING",
						version: 7,
						scanPending: false,
						progress: { phase: "SAVING", done: 20, total: 40 },
					},
				}),
				{ snapshots: [upload], repositoryConfirmed: true },
			),
			{ wrapper: TestQueryProvider },
		);

		expect(screen.getByText("Saving 10 of 40 files")).toBeInTheDocument();
		expect(screen.getByText("Saving 20 of 40 files")).toBeInTheDocument();
	});

	it("lets the repository sync own publishing while the pointer catches up", () => {
		render(
			view(
				controls({
					running: true,
					latestRun: {
						id: "run-1",
						trigger: "MANUAL",
						startedAt: new Date(),
						finishedAt: null,
						status: null,
						error: null,
						note: null,
						commitSha: "a".repeat(40),
						snapshotId: null,
						snapshotVersion: 8,
						userName: null,
						fromCurrentConfiguration: true,
						progress: { phase: "COPYING", done: 40, total: 40 },
					},
					inFlightSnapshot: {
						status: "READY",
						version: 8,
						scanPending: false,
						progress: null,
					},
				}),
				{
					awaitingPublish: true,
					snapshots: [
						{
							id: "s8",
							version: 8,
							status: "READY",
							source: "REPOSITORY",
							publishOnReady: true,
						} as never,
					],
					repositoryConfirmed: true,
				},
			),
			{ wrapper: TestQueryProvider },
		);

		expect(
			screen.getAllByText(
				en.projects.codingInstructions.publishedView.publishing,
			),
		).toHaveLength(2);
		expect(
			screen.getByTestId("repository-sync-progress"),
		).toHaveTextContent(
			en.projects.codingInstructions.publishedView.publishing,
		);
	});

	// Fizzy #2563 spec §12: on a repository-backed project a proposal opens a
	// pull request, so proposing comes back — for a member holding
	// INSTRUCTION_CREATE, or a reader once the project allows it — while
	// direct mutation stays off.
	//
	// Fizzy #2878 §10: someone who may commit adds a file to the branch, as
	// they would with git; suggesting is the reader's way and the editor's
	// alternative, inside the same dialog.
	it("offers an editor Add file, which commits to the branch, and no Replace or version save", async () => {
		render(view(controls(), { canEdit: true, canRead: true }), {
			wrapper: TestQueryProvider,
		});
		await openMore();
		expect(menuItem("Add file")).toBeInTheDocument();
		expect(queryMenuItem("Suggest a change")).toBeNull();
		expect(screen.queryByRole("button", { name: "Replace" })).toBeNull();
	});

	it("offers a reader Suggest a change only once read-only members may propose", async () => {
		const off = render(view(controls(), { canRead: true }), {
			wrapper: TestQueryProvider,
		});
		await openMore();
		expect(queryMenuItem("Suggest a change")).toBeNull();
		off.unmount();
		render(
			view(
				controls({
					canConfigure: false,
					configured: { ...configured, allowReaderProposals: true },
				}),
				{ canRead: true },
			),
			{ wrapper: TestQueryProvider },
		);
		await openMore();
		expect(menuItem("Suggest a change")).toBeInTheDocument();
	});

	it("offers no suggestion while repository mode is unconfirmed or nothing is configured", async () => {
		const unconfirmed = render(
			view(controls(), { canEdit: true, repositoryConfirmed: false }),
			{ wrapper: TestQueryProvider },
		);
		await openMore();
		expect(queryMenuItem("Suggest a change")).toBeNull();
		unconfirmed.unmount();
		render(view(controls({ configured: null }), { canEdit: true }), {
			wrapper: TestQueryProvider,
		});
		await openMore();
		expect(queryMenuItem("Suggest a change")).toBeNull();
	});

	// Read-only mode refuses every write to a connected source, a commit to
	// the branch included, whatever the member's role.
	it("offers an editor no commit while the project is in Read-only mode, only the pull request", async () => {
		render(view(controls(), { canEdit: true, readOnlyMode: true }), {
			wrapper: TestQueryProvider,
		});
		await openMore();

		expect(queryMenuItem("Add file")).toBeNull();
		expect(menuItem("Suggest a change")).toBeInTheDocument();
	});

	it("says in the status block that Fabric's copy is syncing a commit made from this tab", () => {
		render(
			view(controls(), {
				syncingCommit: {
					sha: "0123456789abcdef0123456789abcdef01234567",
					ref: "main",
				},
			}),
			{ wrapper: TestQueryProvider },
		);

		expect(
			screen.getByText(
				"Committed 0123456 to main · Fabric's copy is syncing…",
			),
		).toBeInTheDocument();
	});

	it("opens the suggestion dialog for a reader naming the repository and branch the pull request targets", async () => {
		render(
			view(
				controls({
					canConfigure: false,
					configured: { ...configured, allowReaderProposals: true },
				}),
				{ canRead: true },
			),
			{ wrapper: TestQueryProvider },
		);
		const user = await openMore();
		await user.click(menuItem("Suggest a change"));
		expect(
			await screen.findByText(
				/This opens a pull request in example-org\/instructions against main\./,
			),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Commit to main" }),
		).toBeNull();
	});

	it("opens the add dialog for an editor naming the branch the file is committed to", async () => {
		render(view(controls(), { canEdit: true }), {
			wrapper: TestQueryProvider,
		});
		const user = await openMore();
		await user.click(menuItem("Add file"));
		expect(
			await screen.findByText(
				/This commits the file to main in example-org\/instructions/,
			),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Commit to main" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Suggest as a pull request" }),
		).toBeInTheDocument();
		expect(screen.getByLabelText("Commit message")).toHaveValue(
			"Add a file",
		);
	});

	it("lets a reviewer browse suggestions, but never decide them here", async () => {
		render(view(controls(), { canEdit: true, canReview: true }), {
			wrapper: TestQueryProvider,
		});
		await openMore();
		expect(menuItem("Suggested changes")).toBeInTheDocument();
		const last = proposalsProps.at(-1);
		expect(last).toMatchObject({
			canReview: true,
			canDecide: false,
			repositoryBacked: true,
			repositoryProvider: "GITHUB",
		});
	});

	it("keeps a reader's own suggestions browsable after read-only proposals are turned off", async () => {
		render(view(controls({ canConfigure: false }), { canRead: true }), {
			wrapper: TestQueryProvider,
		});
		await openMore();
		expect(menuItem("Suggested changes")).toBeInTheDocument();
		expect(proposalsProps.at(-1)).toMatchObject({ canReview: false });
	});

	// Repository mode can outlive its configuration (the
	// integration was disconnected, or its delegate deleted). A reader who
	// suggested under the opt-in keeps "Suggested changes" (status, Refresh,
	// Retry, Withdraw) then; only proposing needs a configured target. The
	// server lists a non-reviewer only their own rows either way.
	it("keeps a reader's suggestions browsable once the sync configuration is gone, with no Suggest", async () => {
		const gone = render(
			view(controls({ canConfigure: false, configured: null }), {
				canRead: true,
			}),
			{ wrapper: TestQueryProvider },
		);
		await openMore();
		expect(menuItem("Suggested changes")).toBeInTheDocument();
		expect(queryMenuItem("Suggest a change")).toBeNull();
		expect(proposalsProps.at(-1)).toMatchObject({ canReview: false });
		gone.unmount();

		// Only CONFIRMED repository mode: while settings load (or fail),
		// `repositoryBacked` alone offers a reader nothing.
		render(
			view(controls({ canConfigure: false, configured: null }), {
				canRead: true,
				repositoryConfirmed: false,
			}),
			{ wrapper: TestQueryProvider },
		);
		await openMore();
		expect(queryMenuItem("Suggested changes")).toBeNull();
	});

	it("offers Sync from repository to a configurer with an ACTIVE integration and nothing configured", async () => {
		const c = controls({ sourceOfTruth: "UPLOAD", configured: null });
		render(view(c, { repositoryBacked: false }), {
			wrapper: TestQueryProvider,
		});
		const user = await openMore();
		await user.click(menuItem("Sync from repository"));
		expect(c.onConfigure).toHaveBeenCalled();
	});

	// `localSetupRouteFor` (Fizzy #2721): the Connect dialog's CLI route for a
	// repository-backed project.
	it("computes the repository local-setup route from the configured sync", async () => {
		const user = userEvent.setup();
		render(view(controls(), { canEdit: true, repositoryConfirmed: true }), {
			wrapper: TestQueryProvider,
		});
		await user.click(
			screen.getByRole("button", { name: "Connect your agent" }),
		);
		const lastProps =
			connectCliDialogProps[connectCliDialogProps.length - 1];
		expect(lastProps).toMatchObject({
			localSetup: {
				kind: "repository",
				cloneUrl: "https://github.com/example-org/instructions.git",
				directory: "instructions",
				ref: "main",
				rootPath: null,
			},
		});
	});

	it("offers no CLI route for a repository project with nothing configured", async () => {
		const user = userEvent.setup();
		render(
			view(controls({ configured: null }), {
				canEdit: true,
				repositoryConfirmed: true,
			}),
			{ wrapper: TestQueryProvider },
		);
		await user.click(
			screen.getByRole("button", { name: "Connect your agent" }),
		);
		expect(
			connectCliDialogProps[connectCliDialogProps.length - 1],
		).toMatchObject({ localSetup: null });
	});

	it("offers Sync now once configured, and holds it with a spinner while a run is open", async () => {
		const c = controls();
		const rendered = render(view(c), { wrapper: TestQueryProvider });
		const user = await openMore();
		await user.click(menuItem("Sync now"));
		expect(c.onSyncNow).toHaveBeenCalled();
		rendered.rerender(view(controls({ running: true })));
		await user.click(screen.getByRole("button", { name: "More" }));
		expect(menuItem("Syncing…")).toHaveAttribute("data-disabled");
	});

	it("shows a reader the last sync but neither button", () => {
		render(
			view(
				controls({
					canConfigure: false,
					latestRun: {
						id: "sync_1:run_a",
						trigger: "MANUAL",
						startedAt: new Date(),
						finishedAt: new Date(),
						status: "SUCCEEDED",
						error: null,
						note: null,
						commitSha: "0123456789abcdef0123456789abcdef01234567",
						snapshotId: "s7",
						snapshotVersion: 7,
						userName: "A. Member",
						fromCurrentConfiguration: true,
					},
				}),
			),
			{ wrapper: TestQueryProvider },
		);
		expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Sync from repository" }),
		).toBeNull();
		expect(screen.getByText(/took commit 0123456/)).toBeInTheDocument();
	});

	// Fizzy #2878 §10: the header reads like git. The pill names the branch
	// and the commit Fabric's copy is of; under it, the commit's own author,
	// age and subject, from the branch's history.
	describe("the header of a repository project", () => {
		const PUBLISHED_SHA = "0123456789abcdef0123456789abcdef01234567";

		function publishedCommit(over: Record<string, unknown> = {}) {
			return {
				sha: PUBLISHED_SHA,
				author: { name: "Jane Doe" },
				date: new Date(Date.now() - 2 * 3_600_000).toISOString(),
				message: "Tighten lint rules\n\nA longer body.",
				url: `https://github.com/example-org/instructions/commit/${PUBLISHED_SHA}`,
				parent: "9".repeat(40),
				published: 7,
				refused: false,
				isFabric: false,
				...over,
			};
		}

		it("names the branch and the short commit in the pill, not a version number", () => {
			render(view(controls()), { wrapper: TestQueryProvider });

			expect(screen.getByText("main @ 0123456")).toBeInTheDocument();
			expect(screen.queryByText("Version 7 is published")).toBeNull();
		});

		it("says who made the commit, when, and what they said, from the branch's history", async () => {
			commitsState.rows = [
				publishedCommit({ sha: "f".repeat(40), published: null }),
				publishedCommit(),
			];
			render(view(controls()), { wrapper: TestQueryProvider });

			const line = await screen.findByTestId(
				"repository-published-summary",
			);

			expect(line).toHaveTextContent(
				/^Jane Doe · 2h ago · “Tighten lint rules”$/,
			);
			// The body of the message is not the subject.
			expect(line).not.toHaveTextContent(/longer body/);
			// It is the Published fact of the strip, whose other facts say
			// where the version came from and what it holds.
			const strip = screen.getByTestId("instructions-status-strip");
			expect(within(strip).getByText("Published")).toBeInTheDocument();
			expect(strip).toHaveTextContent(
				"Sourceexample-org/instructions @ main",
			);
			expect(strip).toHaveTextContent("Stored4 files");
			expect(strip).toHaveTextContent(
				"Left out1 file by the default rules",
			);
		});

		it("finds the published commit by its version when the version records no commit", async () => {
			commitsState.rows = [publishedCommit({ sha: "e".repeat(40) })];
			render(
				view(controls(), {
					published: {
						id: "s7",
						version: 7,
						status: "READY",
						fileCount: 4,
						excludedCount: 1,
						createdAt: new Date(),
						source: "REPOSITORY",
						sourceRef: "main",
						sourceCommitSha: null,
						repositoryIntegrationId: "int_1",
						user: { id: "u", name: "A. Member" },
					},
				}),
				{ wrapper: TestQueryProvider },
			);

			expect(
				await screen.findByTestId("repository-published-summary"),
			).toHaveTextContent(/^Jane Doe · 2h ago/);
		});

		it("says the message was withheld when the secret scan withheld it", async () => {
			commitsState.rows = [
				publishedCommit({ message: null, messageWithheld: true }),
			];
			render(view(controls()), { wrapper: TestQueryProvider });

			expect(
				await screen.findByTestId("repository-published-summary"),
			).toHaveTextContent(/^Jane Doe · 2h ago · message withheld$/);
		});

		it("falls back to what the version itself knows when the commit is not on the first page", async () => {
			commitsState.rows = [
				publishedCommit({ sha: "f".repeat(40), published: null }),
			];
			render(view(controls()), { wrapper: TestQueryProvider });

			expect(
				await screen.findByTestId("repository-published-summary"),
			).toHaveTextContent(/^A\. Member · \d+m ago$/);
			expect(
				screen.getByTestId("instructions-status-strip"),
			).toHaveTextContent("Sourceexample-org/instructions @ main");
		});

		it("falls back the same way when the history cannot be read, and says nothing wrong", async () => {
			commitsState.fails = true;
			render(view(controls()), { wrapper: TestQueryProvider });

			expect(
				await screen.findByTestId("repository-published-summary"),
			).toHaveTextContent(/^A\. Member · \d+m ago$/);
		});

		it("reads no history at all for an upload project, whose header is unchanged", () => {
			render(
				view(controls({ sourceOfTruth: "UPLOAD", configured: null }), {
					repositoryBacked: false,
					published: {
						id: "s7",
						version: 7,
						status: "READY",
						fileCount: 2,
						excludedCount: 0,
						createdAt: new Date(),
						source: "UPLOAD",
						user: { id: "u", name: "A. Member" },
					},
				}),
				{ wrapper: TestQueryProvider },
			);

			expect(
				screen.getByText("Version 7 is published"),
			).toBeInTheDocument();
			const strip = screen.getByTestId("instructions-status-strip");
			expect(strip).toHaveTextContent("SourceFolder upload");
			expect(strip).toHaveTextContent(/PublishedA\. Member · \d+m ago/);
			expect(
				screen.queryByTestId("repository-published-summary"),
			).toBeNull();
		});
	});

	// Fizzy #2878 §10: a repository project's History is the branch's commits;
	// its copy follows the branch, so nothing is published, rolled back or
	// deleted by hand, even by a reviewer.
	it("opens the branch's commits, not a list of versions to publish, and keeps the sync runs under it", async () => {
		const user = userEvent.setup();
		render(
			view(controls(), {
				canEdit: true,
				canReview: true,
				snapshots: [
					{
						id: "s8",
						version: 8,
						status: "READY",
						source: "REPOSITORY",
						fileCount: 4,
						excludedCount: 0,
						createdAt: new Date(),
						publishOnReady: false,
					},
				],
			}),
			{ wrapper: TestQueryProvider },
		);
		await user.click(screen.getByRole("button", { name: "Commits" }));

		expect(await screen.findByText("Commits on main")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Publish this version" }),
		).toBeNull();
		expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
		expect(await screen.findAllByText("Sync runs")).not.toHaveLength(0);
	});

	it("sends a rejected sync back to the repository and offers Sync again", async () => {
		const c = controls();
		const user = userEvent.setup();
		render(
			view(c, {
				snapshots: [
					{
						id: "s8",
						version: 8,
						status: "REJECTED",
						source: "REPOSITORY",
						fileCount: 1,
						excludedCount: 0,
						createdAt: new Date(),
						rejection: [
							{
								path: "a.md",
								reason: "secret",
								detail: "github-token",
							},
						],
					},
				],
			}),
			{ wrapper: TestQueryProvider },
		);
		expect(
			screen.getByText(
				en.projects.codingInstructions.rejectedBanner.bodyRepository,
			),
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Sync again" }));
		expect(c.onSyncNow).toHaveBeenCalled();
	});

	// Fizzy #2878 §10: a direct commit the scan refused is a snapshot of its
	// own (never pushed, so still an upload-sourced row). It reads as a refused
	// commit to the branch, with nothing to upload or sync again.
	it("words a refused direct commit as a commit that was not made, with no upload or sync to repeat", () => {
		const c = controls();
		render(
			view(c, {
				canEdit: true,
				snapshots: [
					{
						id: "s8",
						version: 8,
						status: "REJECTED",
						source: "UPLOAD",
						proposalDestination: "REPOSITORY_COMMIT",
						fileCount: 1,
						excludedCount: 0,
						createdAt: new Date(),
						rejection: [
							{
								path: "a.md",
								reason: "secret",
								detail: "github-token",
							},
						],
					},
				],
			}),
			{ wrapper: TestQueryProvider },
		);

		expect(
			screen.getByRole("heading", {
				name: "Commit not made: 1 file contains secrets",
			}),
		).toBeInTheDocument();
		expect(
			screen.getByText(/Nothing was pushed to main\./),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Sync again" })).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Upload again" }),
		).toBeNull();
	});

	it("names the commit being checked when a synced version is", () => {
		const c = controls();
		render(
			view(c, {
				snapshots: [
					{
						id: "s8",
						version: 8,
						status: "VALIDATING",
						source: "REPOSITORY",
						sourceCommitSha:
							"b1c2d3e4f5061728394a5b6c7d8e9f0123456789",
						fileCount: 4,
						excludedCount: 0,
						createdAt: new Date(),
					},
				],
			}),
			{ wrapper: TestQueryProvider },
		);

		expect(
			screen.getByText("Checking commit b1c2d3e."),
		).toBeInTheDocument();
	});

	it("names the refused commit and the commit Fabric's copy stays at in the rejected banner", () => {
		const c = controls();
		render(
			view(c, {
				snapshots: [
					{
						id: "s8",
						version: 8,
						status: "REJECTED",
						source: "REPOSITORY",
						sourceCommitSha:
							"b1c2d3e4f5061728394a5b6c7d8e9f0123456789",
						fileCount: 1,
						excludedCount: 0,
						createdAt: new Date(),
						rejection: [
							{
								path: "a.md",
								reason: "secret",
								detail: "github-token",
							},
						],
					},
				],
			}),
			{ wrapper: TestQueryProvider },
		);

		expect(
			screen.getByRole("heading", {
				name: "Commit b1c2d3e refused: 1 file contains secrets",
			}),
		).toBeInTheDocument();
		expect(
			screen.getByText("Fabric's copy stays at commit 0123456."),
		).toBeInTheDocument();
	});

	it("says a direct commit is being checked before it is committed, not that an upload is", () => {
		const c = controls();
		render(
			view(c, {
				canEdit: true,
				snapshots: [
					{
						id: "s8",
						version: 8,
						status: "VALIDATING",
						source: "UPLOAD",
						proposalDestination: "REPOSITORY_COMMIT",
						fileCount: 4,
						excludedCount: 0,
						createdAt: new Date(),
					},
				],
			}),
			{ wrapper: TestQueryProvider },
		);

		expect(
			screen.getByText(
				en.projects.codingInstructions.publishedView
					.checkingSummaryCommit,
			),
		).toBeInTheDocument();
		expect(
			screen.queryByText(
				en.projects.codingInstructions.publishedView
					.checkingSummaryUpload,
			),
		).toBeNull();
	});

	it("leaves a direct commit whose checks broke to the editor that made it, with no banner to retry an upload", () => {
		const c = controls();
		render(
			view(c, {
				canEdit: true,
				snapshots: [
					{
						id: "s8",
						version: 8,
						status: "FAILED",
						source: "UPLOAD",
						proposalDestination: "REPOSITORY_COMMIT",
						fileCount: 4,
						excludedCount: 0,
						createdAt: new Date(),
					},
				],
			}),
			{ wrapper: TestQueryProvider },
		);

		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
		expect(screen.queryByText(/didn't finish/i)).toBeNull();
	});

	// Spec §4: while the repository is the source of truth, uploads are off
	// and the server refuses them. A rejected upload left over from before
	// the switch must not lead back to the upload dialog.
	it("offers no Upload again for an upload rejected before the project switched to its repository", () => {
		const c = controls();
		render(
			view(c, {
				snapshots: [
					{
						id: "s8",
						version: 8,
						status: "REJECTED",
						source: "UPLOAD",
						fileCount: 1,
						excludedCount: 0,
						createdAt: new Date(),
						rejection: [
							{
								path: "a.md",
								reason: "secret",
								detail: "github-token",
							},
						],
					},
				],
			}),
			{ wrapper: TestQueryProvider },
		);
		expect(
			screen.getByRole("heading", {
				name: "Upload rejected: 1 file contains secrets",
			}),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Upload again" }),
		).toBeNull();
		expect(
			screen.queryByText(
				en.projects.codingInstructions.rejectedBanner.body,
			),
		).toBeNull();
		expect(
			screen.getByText(
				en.projects.codingInstructions.rejectedBanner
					.bodyUploadRepositoryBacked,
			),
		).toBeInTheDocument();
	});

	// While settings load the tab fails closed for actions
	// (`repositoryBacked`) but has not confirmed repository mode, so the
	// banner keeps the upload copy and still offers no upload.
	it("keeps the upload copy for a rejected upload while repository mode is unconfirmed", () => {
		const c = controls();
		render(
			view(c, {
				repositoryConfirmed: false,
				snapshots: [
					{
						id: "s8",
						version: 8,
						status: "REJECTED",
						source: "UPLOAD",
						fileCount: 1,
						excludedCount: 0,
						createdAt: new Date(),
						rejection: [{ path: "a.md", reason: "missing" }],
					},
				],
			}),
			{ wrapper: TestQueryProvider },
		);
		const banner = en.projects.codingInstructions.rejectedBanner;
		expect(screen.getByText(banner.body)).toBeInTheDocument();
		expect(
			screen.queryByText(banner.bodyUploadRepositoryBacked),
		).toBeNull();
		expect(screen.queryByText(banner.bodyRepository)).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Upload again" }),
		).toBeNull();
	});

	// A sync abandoned before its checks ran (storage down through every
	// attempt) says nothing about the files: no "fix these files" body and
	// no file table, and it is named a sync, not an upload.
	it("gives an abandoned sync a neutral banner rather than asking for files to be fixed", () => {
		const c = controls();
		render(
			view(c, {
				snapshots: [
					{
						id: "s8",
						version: 8,
						status: "REJECTED",
						source: "REPOSITORY",
						fileCount: 1,
						excludedCount: 0,
						createdAt: new Date(),
						rejection: [{ path: "(upload)", reason: "abandoned" }],
					},
				],
			}),
			{ wrapper: TestQueryProvider },
		);
		const banner = en.projects.codingInstructions.rejectedBanner;
		expect(
			screen.getByRole("heading", {
				name: banner.titleAbandonedRepository,
			}),
		).toBeInTheDocument();
		expect(
			screen.getByText(banner.bodyAbandonedRepository),
		).toBeInTheDocument();
		expect(screen.queryByText(banner.bodyRepository)).toBeNull();
		expect(screen.queryByText("(upload)")).toBeNull();
		expect(screen.queryByText(banner.reasonLabels.abandoned)).toBeNull();
	});
});

/**
 * Publish first, scan afterwards (Fizzy #2737). The published pointer row
 * carries its own deferred scan, and the view says what that scan means for
 * the version members are reading: running, found something, or could not
 * finish. Nothing is withdrawn automatically, so each alert sits above a
 * version that stays published.
 */
describe("InstructionsPublishedView — deferred secret scan", () => {
	const copy = en.projects.codingInstructions.publishedView;

	function renderScanned(
		published: Record<string, unknown>,
		props: Record<string, unknown> = {},
	) {
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
						publishBeforeScan: true,
						...published,
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

	it("says the published version is still being scanned, as a status rather than an alert", () => {
		renderScanned({ deferredScanStatus: "PENDING" });
		const title = copy.deferredScanPendingTitle.replace("{version}", "7");
		const status = screen.getByText(title).closest('[role="status"]');
		expect(status).not.toBeNull();
		expect(
			screen.getByText(copy.deferredScanPendingBody),
		).toBeInTheDocument();
		expect(
			screen.queryByText(
				copy.deferredScanIssuesTitle.replace("{version}", "7"),
			),
		).toBeNull();
	});

	it("shows the scan's findings in the rejected-upload file table and opens History", async () => {
		const user = userEvent.setup();
		const findings: InstructionRejection[] = [
			{
				path: "rules/deploy.md",
				reason: "secret",
				detail: "aws-access-key",
				line: 12,
			},
			{ path: "notes.md", reason: "missing" },
		];
		renderScanned({
			deferredScanStatus: "ISSUES_FOUND",
			deferredScanFindings: findings,
		});
		expect(
			screen.getByText(
				copy.deferredScanIssuesTitle.replace("{version}", "7"),
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				copy.deferredScanIssuesBody.replace("{version}", "7"),
			),
		).toBeInTheDocument();
		const banner = en.projects.codingInstructions.rejectedBanner;
		expect(screen.getByText("rules/deploy.md")).toBeInTheDocument();
		expect(
			screen.getByText(banner.secretLabels["aws-access-key"]),
		).toBeInTheDocument();
		expect(
			screen.getByText(banner.lineLabel.replace("{line}", "12")),
		).toBeInTheDocument();
		expect(screen.getByText("notes.md")).toBeInTheDocument();
		expect(
			screen.getByText(banner.reasonLabels.missing),
		).toBeInTheDocument();

		await user.click(
			screen.getByRole("button", {
				name: copy.deferredScanHistoryButton,
			}),
		);
		expect(
			await screen.findByText(
				en.projects.codingInstructions.history.title,
			),
		).toBeInTheDocument();
	});

	it("says a scan that could not finish left the version unchecked, not clean", () => {
		renderScanned({
			deferredScanStatus: "INCOMPLETE",
			deferredScanFindings: null,
		});
		expect(
			screen.queryByText(
				copy.deferredScanIncompleteFindingsTitle.replace(
					"{version}",
					"7",
				),
			),
		).toBeNull();
		expect(
			screen.getByText(
				copy.deferredScanIncompleteTitle.replace("{version}", "7"),
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(copy.deferredScanIncompleteBody),
		).toBeInTheDocument();
	});

	// Fizzy #2759: a scan that found nothing but could not read some files
	// names them, under the "could not finish" warning rather than the
	// "found possible secrets" one.
	it("lists the files an incomplete scan could not read, without claiming it found anything", () => {
		renderScanned({
			deferredScanStatus: "INCOMPLETE",
			deferredScanFindings: [
				{ path: "rules/deploy.md", reason: "scan_failed" },
			],
		});
		expect(
			screen.queryByText(
				copy.deferredScanIncompleteFindingsTitle.replace(
					"{version}",
					"7",
				),
			),
		).toBeNull();
		expect(
			screen.getByText(
				copy.deferredScanIncompleteTitle.replace("{version}", "7"),
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(copy.deferredScanIncompleteUnreadableBody),
		).toBeInTheDocument();
		expect(screen.queryByText(copy.deferredScanIncompleteBody)).toBeNull();
		expect(screen.getByText("rules/deploy.md")).toBeInTheDocument();
		expect(
			screen.getByText(
				en.projects.codingInstructions.rejectedBanner.reasonLabels
					.scan_failed,
			),
		).toBeInTheDocument();
	});

	it("shows the unreadable files among an incomplete scan's findings when it also found something", () => {
		renderScanned({
			deferredScanStatus: "INCOMPLETE",
			deferredScanFindings: [
				{
					path: "rules/deploy.md",
					reason: "secret",
					detail: "aws-access-key",
					line: 12,
				},
				{ path: "rules/other.md", reason: "scan_failed" },
			],
		});
		expect(
			screen.getByText(
				copy.deferredScanIncompleteFindingsTitle.replace(
					"{version}",
					"7",
				),
			),
		).toBeInTheDocument();
		expect(screen.getByText("rules/deploy.md")).toBeInTheDocument();
		expect(screen.getByText("rules/other.md")).toBeInTheDocument();
		expect(
			screen.getByText(
				copy.deferredScanIncompleteFindingsUnreadableBody.replace(
					"{version}",
					"7",
				),
			),
		).toBeInTheDocument();
		expect(
			screen.queryByText(
				copy.deferredScanIncompleteFindingsBody.replace(
					"{version}",
					"7",
				),
			),
		).toBeNull();
		expect(
			screen.queryByText(copy.deferredScanIncompleteUnreadableBody),
		).toBeNull();
	});

	// A scan that could not check every file but established findings before
	// it stopped keeps them (Fizzy #2737 review): they are shown in the same
	// table, and the copy says the rest was not checked.
	it("shows an incomplete scan's findings, and says the scan could not check every file", async () => {
		const user = userEvent.setup();
		renderScanned({
			deferredScanStatus: "INCOMPLETE",
			deferredScanFindings: [
				{
					path: "rules/deploy.md",
					reason: "secret",
					detail: "aws-access-key",
					line: 12,
				},
			],
		});
		expect(
			screen.getByText(
				copy.deferredScanIncompleteFindingsTitle.replace(
					"{version}",
					"7",
				),
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				copy.deferredScanIncompleteFindingsBody.replace(
					"{version}",
					"7",
				),
			),
		).toBeInTheDocument();
		expect(screen.getByText("rules/deploy.md")).toBeInTheDocument();
		expect(
			screen.getByText(
				en.projects.codingInstructions.rejectedBanner.secretLabels[
					"aws-access-key"
				],
			),
		).toBeInTheDocument();
		// Not the "nothing was found" copy of an incomplete scan without any.
		expect(screen.queryByText(copy.deferredScanIncompleteBody)).toBeNull();

		await user.click(
			screen.getByRole("button", {
				name: copy.deferredScanHistoryButton,
			}),
		);
		expect(
			await screen.findByText(
				en.projects.codingInstructions.history.title,
			),
		).toBeInTheDocument();
	});

	it("says nothing once the scan passed, or for an ordinary version", () => {
		const titles = [
			copy.deferredScanPendingTitle,
			copy.deferredScanIssuesTitle,
			copy.deferredScanIncompleteTitle,
			copy.deferredScanIncompleteFindingsTitle,
		].map((title) => title.replace("{version}", "7"));
		const { unmount } = renderScanned({ deferredScanStatus: "PASSED" });
		for (const title of titles) {
			expect(screen.queryByText(title)).toBeNull();
		}
		unmount();
		renderScanned({ publishBeforeScan: false, deferredScanStatus: null });
		for (const title of titles) {
			expect(screen.queryByText(title)).toBeNull();
		}
	});

	// The add-file option publishes before the scan, so it needs the publish
	// permission (`canReview`) as well as direct editing.
	it("offers publish-before-scan in Add file only to an editor who can also publish", async () => {
		const user = userEvent.setup();
		const label = en.projects.codingInstructions.publishBeforeScan.label;
		const { unmount } = renderScanned(
			{ publishBeforeScan: false, deferredScanStatus: null },
			{ canEdit: true, canReview: true },
		);
		await user.click(screen.getByRole("button", { name: "More" }));
		await user.click(menuItem("Add file"));
		expect(await screen.findByLabelText(label)).toBeInTheDocument();
		unmount();

		renderScanned(
			{ publishBeforeScan: false, deferredScanStatus: null },
			{ canEdit: true, canReview: false },
		);
		await user.click(screen.getByRole("button", { name: "More" }));
		await user.click(menuItem("Add file"));
		await screen.findByRole("dialog");
		expect(screen.queryByLabelText(label)).toBeNull();
	});
});

/**
 * Nine buttons in a row wrapped to four lines on a phone. The header now keeps
 * the actions that set the tab up and read it (Connect your agent, Upload or
 * Replace, History, Download) in view and puts everything else under More,
 * while every page-tour anchor stays on an element that is rendered.
 */
describe("InstructionsPublishedView — the header", () => {
	const published = {
		id: "s7",
		version: 7,
		status: "READY",
		fileCount: 4,
		excludedCount: 0,
		createdAt: new Date(),
		source: "UPLOAD",
		user: { id: "u", name: "A. Member" },
	};

	function renderHeader(props: Record<string, unknown> = {}) {
		return render(
			<InstructionsPublishedView
				projectId="p"
				projectName="Checkout Rewrite"
				published={published as never}
				snapshots={[] as never}
				onReplaceClick={() => undefined}
				onChanged={() => undefined}
				{...props}
			/>,
			{ wrapper: TestQueryProvider },
		);
	}

	it("keeps History, Download, More and the primary action in view for an editor, and puts the rest under More", async () => {
		renderHeader({ canEdit: true, canReview: true });

		const bar = screen.getByTestId("instructions-actions");
		expect(
			within(bar)
				.getAllByRole("button")
				.map(
					(button) =>
						button.getAttribute("aria-label") ?? button.textContent,
				),
		).toEqual(["History", "Download", "More", "Upload new version"]);
		await openMore();
		expect(
			screen.getAllByRole("menuitem").map((item) => item.textContent),
		).toEqual(["Review proposals", "Add file", "Settings"]);
	});

	it("moves Connect your agent out of the header and beside Fabric MCP in the status strip", async () => {
		const user = userEvent.setup();
		renderHeader({ canEdit: true });

		const bar = screen.getByTestId("instructions-actions");
		expect(
			within(bar).queryByRole("button", { name: "Connect your agent" }),
		).toBeNull();
		const strip = screen.getByTestId("instructions-status-strip");
		const fact = within(strip).getByText("Agents read it through")
			.parentElement as HTMLElement;
		expect(fact).toHaveTextContent("Fabric MCP");
		await user.click(
			within(fact).getByRole("button", { name: "Connect your agent" }),
		);
		expect(
			await screen.findByTestId("connect-cli-dialog-stub"),
		).toBeInTheDocument();
	});

	describe("Review proposals", () => {
		const awaiting = (over: Record<string, unknown> = {}) => ({
			id: "p1",
			version: 3,
			status: "READY",
			proposalStatus: "PENDING",
			destination: "FABRIC",
			...over,
		});

		it("reads the first page of proposals for a reviewer and shows how many wait for a decision", async () => {
			proposalsState.items = [
				awaiting({ id: "p1" }),
				awaiting({ id: "p2", status: "REJECTED" }),
				awaiting({ id: "p3", status: "VALIDATING" }),
				awaiting({ id: "p4", proposalStatus: "APPROVED" }),
				awaiting({ id: "p5", destination: "REPOSITORY" }),
			];
			renderHeader({ canEdit: true, canReview: true });

			expect(
				await screen.findByRole("button", {
					name: "Review proposals, 2 waiting",
				}),
			).toBeInTheDocument();
			expect(proposalsState.inputs).toEqual([
				{ projectId: "p", limit: 25 },
			]);
			const bar = screen.getByTestId("instructions-actions");
			expect(
				within(bar)
					.getAllByRole("button")
					.map(
						(button) =>
							button.getAttribute("aria-label") ??
							button.textContent,
					),
			).toEqual([
				"Review proposals, 2 waiting",
				"History",
				"Download",
				"More",
				"Upload new version",
			]);
			await openMore();
			expect(queryMenuItem("Review proposals")).toBeNull();
		});

		it("opens the proposals dialog from the header button", async () => {
			proposalsState.items = [awaiting()];
			renderHeader({ canEdit: true, canReview: true });

			await userEvent.click(
				await screen.findByRole("button", {
					name: "Review proposals, 1 waiting",
				}),
			);

			expect(proposalsProps.at(-1)).toMatchObject({ open: true });
		});

		it("keeps Review proposals under More when nothing waits for a decision", async () => {
			proposalsState.items = [
				awaiting({ proposalStatus: "APPROVED" }),
				awaiting({ id: "p2", status: "RECEIVING" }),
			];
			renderHeader({ canEdit: true, canReview: true });

			await waitFor(() => expect(proposalsState.inputs).toHaveLength(1));
			expect(
				screen.queryByRole("button", { name: /Review proposals/ }),
			).toBeNull();
			await openMore();
			expect(menuItem("Review proposals")).toBeInTheDocument();
		});

		it("reads no proposals for someone who cannot review them", async () => {
			proposalsState.items = [awaiting()];
			renderHeader({ canEdit: true, canReview: false, canRead: true });

			await openMore();
			expect(proposalsState.inputs).toEqual([]);
			expect(
				screen.queryByRole("button", { name: /Review proposals/ }),
			).toBeNull();
		});

		it("reads no proposals for a repository project, whose suggestions are decided on their pull requests", async () => {
			proposalsState.items = [awaiting()];
			renderHeader({
				canEdit: true,
				canReview: true,
				repositoryBacked: true,
				repositoryConfirmed: true,
			});

			await openMore();
			expect(proposalsState.inputs).toEqual([]);
			expect(
				screen.queryByRole("button", { name: /Review proposals/ }),
			).toBeNull();
		});
	});

	describe("the status strip's left-out files", () => {
		const leftOutVersion = (over: Record<string, unknown> = {}) => ({
			...published,
			excludedCount: 3,
			excludedPaths: [
				{ path: "tasks/a.md", rule: "tasks/" },
				{ path: "tasks/b.md", rule: "tasks/" },
				{ path: "retro.md", rule: "retro.md" },
			],
			settingsFrozen: { layer: "fabricignore" },
			...over,
		});

		it("names the rule layer beside the count and offers to show the files", () => {
			renderHeader({ published: leftOutVersion() });

			const strip = screen.getByTestId("instructions-status-strip");
			expect(strip).toHaveTextContent(
				"Left out3 files by the rules in .fabricignoreShow",
			);
			expect(
				within(strip).getByRole("button", { name: "Show" }),
			).toHaveAttribute("aria-pressed", "false");
		});

		it("lists them greyed in the tree from the strip, and hides them again", async () => {
			const user = userEvent.setup();
			filesBySnapshot.set(String(published.id), [
				treeFile("f1", "CLAUDE.md"),
			]);
			renderHeader({ published: leftOutVersion() });
			await screen.findByRole("button", { name: /CLAUDE\.md/ });

			await user.click(screen.getByRole("button", { name: "Show" }));

			const row = screen.getByText("retro.md").closest("div");
			expect(row).toHaveAttribute("title", "Left out by retro.md");
			expect(row).toHaveTextContent("left out · retro.md");
			expect(
				screen.getByRole("button", { name: "Hide" }),
			).toHaveAttribute("aria-pressed", "true");

			await user.click(screen.getByRole("button", { name: "Hide" }));

			expect(screen.queryByText("retro.md")).toBeNull();
		});

		it("keeps the strip's switch and the tree footer's in step", async () => {
			const user = userEvent.setup();
			filesBySnapshot.set(String(published.id), [
				treeFile("f1", "CLAUDE.md"),
			]);
			renderHeader({ published: leftOutVersion() });
			await screen.findByRole("button", { name: /CLAUDE\.md/ });

			await user.click(
				screen.getByRole("button", { name: "Show 3 left-out files" }),
			);

			expect(
				screen.getByRole("button", { name: "Hide" }),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: "Hide left-out files" }),
			).toBeInTheDocument();
			expect(screen.getByText("retro.md")).toBeInTheDocument();
		});

		it("says it shows the first few when the version kept fewer names than files it left out", async () => {
			const user = userEvent.setup();
			filesBySnapshot.set(String(published.id), [
				treeFile("f1", "CLAUDE.md"),
			]);
			renderHeader({
				published: leftOutVersion({ excludedCount: 4000 }),
			});
			await screen.findByRole("button", { name: /CLAUDE\.md/ });
			expect(screen.queryByText(/Showing the first/)).toBeNull();

			await user.click(screen.getByRole("button", { name: "Show" }));

			expect(screen.getByText("Showing the first 3")).toBeInTheDocument();
			expect(
				screen.getByTestId("instructions-status-strip"),
			).toHaveTextContent("4,000 files");
		});

		it("keeps the count alone, with no Show and no tree toggle, for a version that stored no names", async () => {
			filesBySnapshot.set(String(published.id), [
				treeFile("f1", "CLAUDE.md"),
			]);
			renderHeader({
				published: leftOutVersion({
					excludedPaths: [],
					excludedCount: 4,
				}),
			});
			await screen.findByRole("button", { name: /CLAUDE\.md/ });

			const strip = screen.getByTestId("instructions-status-strip");
			expect(strip).toHaveTextContent("Left out4 files by the rules");
			expect(
				within(strip).queryByRole("button", { name: "Show" }),
			).toBeNull();
			expect(
				screen.queryByRole("button", { name: /left-out/ }),
			).toBeNull();
		});

		it("says nothing about left-out files when nothing was left out", () => {
			renderHeader({
				published: leftOutVersion({
					excludedPaths: [],
					excludedCount: 0,
				}),
			});

			expect(
				within(
					screen.getByTestId("instructions-status-strip"),
				).queryByText("Left out"),
			).toBeNull();
		});

		it("says one file in the singular", () => {
			renderHeader({
				published: leftOutVersion({
					excludedCount: 1,
					fileCount: 1,
					excludedPaths: [{ path: "retro.md", rule: "retro.md" }],
				}),
			});

			const strip = screen.getByTestId("instructions-status-strip");
			expect(strip).toHaveTextContent("Stored1 file");
			expect(strip).toHaveTextContent("Left out1 file by the rules");
		});
	});

	it("keeps Settings reachable for a reader too, since the dialog shows them read-only", async () => {
		renderHeader();

		await openMore();

		expect(menuItem("Settings")).toBeInTheDocument();
	});

	// Fizzy #2878 §10: a repository project's History is Commits, and the same
	// anchor (and so the same tour step) stays on the button.
	it("calls the history button Commits on a repository project, with its tour anchor kept", () => {
		renderHeader({
			canEdit: true,
			repositoryBacked: true,
			repositoryConfirmed: true,
			repositorySync: {
				state: {
					sourceOfTruth: "REPOSITORY",
					canConfigure: true,
					running: false,
					configured: {
						syncId: "sync_1",
						repositoryIntegrationId: "int_1",
						provider: "GITHUB",
						repositoryOwner: "example-org",
						repositoryName: "instructions",
						repositoryUrl:
							"https://github.com/example-org/instructions.git",
						integrationStatus: "ACTIVE",
						ref: "main",
						rootPath: "",
						automatic: false,
						automaticPausedReason: null,
						automaticPausedAt: null,
						delegateName: "A. Member",
					},
					latestRun: null,
					availableIntegrations: [],
				},
				onConfigure: vi.fn(),
				onSyncNow: vi.fn(),
				syncNowPending: false,
				onChanged: vi.fn(),
			},
		});

		expect(screen.getByRole("button", { name: "Commits" })).toHaveAttribute(
			"data-onboarding-target",
			"coding-instructions-history",
		);
		expect(screen.queryByRole("button", { name: "History" })).toBeNull();
	});

	it("keeps the Connect, History and More tour anchors on the buttons themselves", () => {
		renderHeader({ canEdit: true });

		expect(
			screen.getByRole("button", { name: "Connect your agent" }),
		).toHaveAttribute(
			"data-onboarding-target",
			"coding-instructions-connect",
		);
		expect(screen.getByRole("button", { name: "History" })).toHaveAttribute(
			"data-onboarding-target",
			"coding-instructions-history",
		);
		expect(screen.getByRole("button", { name: "More" })).toHaveAttribute(
			"data-onboarding-target",
			"instructions-more-actions",
		);
	});

	// A spotlight on an element nobody can see is a broken tour. The menu's
	// items are not rendered while it is closed, so the one step for what lives
	// there is anchored on the More button, and nothing else carries an anchor
	// while hidden from view.
	it("anchors the menu's tour step on the More button, with no anchor on a hidden element", () => {
		renderHeader({
			canEdit: true,
			repositoryBacked: true,
			repositoryConfirmed: true,
			canRead: true,
			repositorySync: {
				state: {
					sourceOfTruth: "REPOSITORY",
					canConfigure: true,
					running: false,
					configured: {
						syncId: "sync_1",
						repositoryIntegrationId: "int_1",
						provider: "GITHUB",
						repositoryOwner: "example-org",
						repositoryName: "instructions",
						repositoryUrl:
							"https://github.com/example-org/instructions.git",
						integrationStatus: "ACTIVE",
						ref: "main",
						rootPath: "",
						automatic: false,
						automaticPausedReason: null,
						automaticPausedAt: null,
						delegateName: "A. Member",
					},
					latestRun: null,
					availableIntegrations: [],
				},
				onConfigure: vi.fn(),
				onSyncNow: vi.fn(),
				syncNowPending: false,
				onChanged: vi.fn(),
			},
		});

		const anchors = document.querySelectorAll("[data-onboarding-target]");
		expect(anchors.length).toBeGreaterThan(0);
		for (const anchor of anchors) {
			expect(
				anchor.closest('[aria-hidden="true"]'),
				`${anchor.getAttribute("data-onboarding-target")} sits on or inside an aria-hidden element`,
			).toBeNull();
		}
		expect(
			document.querySelector(
				'[data-onboarding-target="instructions-more-actions"]',
			),
		).toBe(screen.getByRole("button", { name: "More" }));
		for (const gone of [
			"instructions-sync-now",
			"instructions-sync-from-repository",
			"instructions-propose-pull-request",
		]) {
			expect(
				document.querySelector(`[data-onboarding-target="${gone}"]`),
			).toBeNull();
		}
	});

	it("says a synced commit is being checked, not an upload", () => {
		renderHeader({
			snapshots: [
				{
					id: "s8",
					version: 8,
					status: "VALIDATING",
					source: "REPOSITORY",
					fileCount: 4,
					excludedCount: 0,
					createdAt: new Date(),
				},
			] as never,
		});

		expect(
			screen.getByText(
				en.projects.codingInstructions.publishedView
					.checkingSummaryRepository,
			),
		).toBeInTheDocument();
		expect(
			screen.queryByText(
				en.projects.codingInstructions.publishedView
					.checkingSummaryUpload,
			),
		).not.toBeInTheDocument();
	});

	it("opens Settings read-only for a viewer and editable for an editor", async () => {
		const reader = renderHeader({ canEdit: false });
		const user = await openMore();
		await user.click(menuItem("Settings"));
		expect(
			await screen.findByTestId("instructions-settings-read-only"),
		).toBeInTheDocument();
		reader.unmount();

		renderHeader({ canEdit: true });
		const editor = await openMore();
		await editor.click(menuItem("Settings"));
		await screen.findByRole("dialog");
		expect(
			screen.queryByTestId("instructions-settings-read-only"),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Save" }),
		).toBeInTheDocument();
	});

	it("shows what the settings failure notice puts above everything, when the tab passes one", () => {
		renderHeader({
			notice: <p data-testid="tab-notice">Settings failed</p>,
		});

		expect(screen.getByTestId("tab-notice")).toBeInTheDocument();
	});
});
