/**
 * `InstructionFileView` routes all chrome copy through `useTranslations`, so
 * this suite overrides the shared `next-intl` mock (which only echoes the
 * translation KEY back, per `vitest.setup.ts`) with one that resolves the
 * REAL `en.json` copy — the same technique
 * `components/__tests__/DocumentsList-queued.test.tsx` uses. This is what
 * lets "Disabled, runs only when a person calls it" (the model-invocation
 * label) be asserted as real shipped copy.
 *
 * The header renders the file's CLASSIFIED `name`/`description` fields
 * (not a re-parse of the frontmatter block) — see the component's own doc
 * comment. The fixture below deliberately omits a `description:` frontmatter
 * key so this suite proves that: the frontmatter block only carries `name`,
 * `effort`, `allowed-tools`, and `disable-model-invocation`, yet the
 * description still renders from the mocked file row.
 */
import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chooseFileAction } from "./file-actions-menu";

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

// The row the mocked `getFile` returns. Mutable so each test can swap in the
// shape it needs (a binary row, a truncated text row) without a second mock
// factory — `vi.mock` is hoisted, so the factory closes over this binding
// rather than a value.
const fileResponse = vi.hoisted(() => ({
	current: {} as Record<string, unknown>,
}));

const TEXT_FILE = {
	path: ".claude/skills/example-qa-test/SKILL.md",
	kind: "SKILL",
	name: "example-qa-test",
	description: "Use when the user provides a work item ID.",
	size: 31000,
	mimeType: "text/markdown",
	isText: true,
	mode: null,
	body: "---\nname: example-qa-test\neffort: max\nallowed-tools: Read, Glob\ndisable-model-invocation: true\n---\n\n# Example QA Test Workflow\nBody.",
	offset: 0,
	nextOffset: null,
	truncated: false,
	url: null,
};

// The one call an Edit / Delete file save makes. Mocked at the module
// boundary: what matters here is the CHANGE SET the component sends and
// whether it sends one at all, not the derive → PUT → finalize transport,
// which `edit-snapshot.ts` owns and the API tests cover.
const editMocks = vi.hoisted(() => ({
	editInstructionSnapshot: vi.fn(),
	toastInfo: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
}));
vi.mock("@saas/projects/lib/edit-snapshot", () => ({
	editInstructionSnapshot: (...a: unknown[]) =>
		editMocks.editInstructionSnapshot(...a),
}));
// The app's confirmation dialog, mounted once in the (saas) layout and so
// absent here. `confirmMock` records what each destructive action asked and,
// unless a test says otherwise, confirms, as pressing the dialog's button would.
const confirmMock = vi.hoisted(() => vi.fn());
vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: confirmMock }),
}));
vi.mock("sonner", () => ({
	toast: {
		info: (...a: unknown[]) => editMocks.toastInfo(...a),
		success: (...a: unknown[]) => editMocks.toastSuccess(...a),
		error: (...a: unknown[]) => editMocks.toastError(...a),
	},
}));

// The member branch projection `InstructionFileView` reads to show "From
// your branch" or the `restored_unavailable` notice (Fizzy #2738 spec §10
// "Editor"). Empty by default: most tests are not repository-backed, and a
// `myBranch` with no `files` entry for the viewed path is exactly a no-op.
const branchResponse = vi.hoisted(() => ({
	current: {
		branch: null as { id: string } | null,
		liveChanges: 0,
		files: [] as Array<{
			path: string;
			state: "written" | "deleted" | "restored_unavailable";
			sha256: string | null;
			snapshotId: string | null;
		}>,
		branches: [] as unknown[],
	},
	// `pending` never resolves the `myBranch` projection itself (not merely
	// the later `myBranchFile` read); `error` rejects it. Both simulate the
	// review finding: the projection can be loading or failed independently
	// of, and before, the branch file it would otherwise gate on.
	pending: false,
	error: null as Error | null,
}));
const branchFileResponse = vi.hoisted(() => ({
	current: {} as Record<string, unknown>,
	// `pending` never resolves the query (a written path whose bytes have
	// not arrived yet); `error` rejects it. Both let a test hold
	// `myBranchFile` in a state short of success, which `.current` alone
	// cannot do once it settles synchronously in these mocks.
	pending: false,
	error: null as Error | null,
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				getFile: {
					queryOptions: (o: unknown) => ({
						queryKey: ["getFile", o],
						queryFn: async () => fileResponse.current,
					}),
				},
				proposals: {
					myBranch: {
						queryOptions: (o: unknown) => ({
							queryKey: ["myBranch", o],
							queryFn: async () => {
								if (branchResponse.pending) {
									return new Promise(() => {});
								}
								if (branchResponse.error) {
									throw branchResponse.error;
								}
								return branchResponse.current;
							},
						}),
					},
					myBranchFile: {
						queryOptions: (o: unknown) => ({
							queryKey: ["myBranchFile", o],
							queryFn: async () => {
								if (branchFileResponse.pending) {
									return new Promise(() => {});
								}
								if (branchFileResponse.error) {
									throw branchFileResponse.error;
								}
								return branchFileResponse.current;
							},
						}),
					},
				},
			},
		},
	},
}));

import { InstructionFileView } from "../InstructionFileView";

function TestQueryProvider({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

describe("InstructionFileView", () => {
	beforeEach(() => {
		confirmMock.mockReset();
		confirmMock.mockImplementation((options: { onConfirm: () => void }) =>
			options.onConfirm(),
		);
		fileResponse.current = { ...TEXT_FILE };
		branchResponse.current = {
			branch: null,
			liveChanges: 0,
			files: [],
			branches: [],
		};
		branchResponse.pending = false;
		branchResponse.error = null;
		branchFileResponse.current = {};
		branchFileResponse.pending = false;
		branchFileResponse.error = null;
		for (const fn of Object.values(editMocks)) {
			fn.mockReset();
		}
		editMocks.editInstructionSnapshot.mockResolvedValue({
			snapshotId: "snap_new",
			version: 8,
		});
	});

	it("renders frontmatter as a header and the body without the frontmatter block", async () => {
		render(
			<InstructionFileView
				projectId="p"
				snapshotId="s"
				path=".claude/skills/example-qa-test/SKILL.md"
			/>,
			{ wrapper: TestQueryProvider },
		);
		expect(
			await screen.findByRole("heading", { name: "example-qa-test" }),
		).toBeInTheDocument();
		expect(
			screen.getByText("Use when the user provides a work item ID."),
		).toBeInTheDocument();
		expect(
			screen.getByText("Disabled, runs only when a person calls it"),
		).toBeInTheDocument();
		expect(screen.getByText("Read, Glob")).toBeInTheDocument();
		expect(screen.queryByText(/^---$/)).not.toBeInTheDocument();
	});

	// jsdom does not lay anything out. A device sweep at 375px found the
	// header's Copy path, Edit and Delete file buttons clipped by the card,
	// because the toolbar could not wrap. They are now a Copy path icon, Edit
	// and a File actions menu in one group, and the bar around the path and
	// that group is what wraps.
	it("lets the header's actions wrap instead of being clipped on a narrow screen", async () => {
		render(
			<InstructionFileView
				projectId="p"
				snapshotId="s"
				path=".claude/skills/example-qa-test/SKILL.md"
				canEdit
			/>,
			{ wrapper: TestQueryProvider },
		);

		const bar = (await screen.findByRole("button", { name: "Edit" }))
			.parentElement?.parentElement;
		expect(bar?.className).toContain("flex-wrap");
		expect(bar?.firstElementChild?.className).toContain("flex-wrap");
	});

	// Task 14 finding 4: the two branches the server can return besides a
	// whole text body had no coverage at all, including the download link
	// that round added `target`/`rel` to.
	it("renders a binary file as a download link instead of a body", async () => {
		fileResponse.current = {
			...TEXT_FILE,
			path: "assets/logo.png",
			kind: "OTHER",
			name: null,
			description: null,
			mimeType: "image/png",
			isText: false,
			body: null,
			url: "https://storage.example.com/signed/logo.png",
		};
		render(
			<InstructionFileView
				projectId="p"
				snapshotId="s"
				path="assets/logo.png"
			/>,
			{ wrapper: TestQueryProvider },
		);
		expect(
			await screen.findByText("This is a binary file.", { exact: false }),
		).toBeInTheDocument();
		const link = screen.getByRole("link", { name: "Download it" });
		expect(link).toHaveAttribute(
			"href",
			"https://storage.example.com/signed/logo.png",
		);
		// A signed storage URL opens in a new tab, and `rel` keeps that tab
		// from reaching back through `window.opener`.
		expect(link).toHaveAttribute("target", "_blank");
		expect(link).toHaveAttribute("rel", "noopener noreferrer");
	});

	it("tells the reader the body is cut short when the server truncated it", async () => {
		fileResponse.current = {
			...TEXT_FILE,
			path: "docs/big.md",
			kind: "KNOWLEDGE",
			name: null,
			description: null,
			body: "# Long document\nFirst page only.",
			truncated: true,
			nextOffset: 200_000,
		};
		render(
			<InstructionFileView
				projectId="p"
				snapshotId="s"
				path="docs/big.md"
			/>,
			{ wrapper: TestQueryProvider },
		);
		expect(
			await screen.findByText(
				"Showing the first 200000 characters. Download the version for the full file.",
			),
		).toBeInTheDocument();
	});

	it("shows no truncation note for a complete body", async () => {
		render(
			<InstructionFileView
				projectId="p"
				snapshotId="s"
				path=".claude/skills/example-qa-test/SKILL.md"
			/>,
			{ wrapper: TestQueryProvider },
		);
		await screen.findByRole("heading", { name: "example-qa-test" });
		expect(screen.queryByText(/for the full file/)).not.toBeInTheDocument();
	});

	// "Copy MCP call" put a pseudo-call no MCP client accepts on the
	// clipboard. The one thing a person actually wants from a file in the
	// tree is its path, so that is what the button copies now.
	it("copies the file's path, and offers no pseudo-call", async () => {
		const user = userEvent.setup();
		const writeText = vi.fn(async () => undefined);
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});
		render(
			<InstructionFileView
				projectId="p"
				snapshotId="s"
				path=".claude/skills/example-qa-test/SKILL.md"
			/>,
			{ wrapper: TestQueryProvider },
		);
		await screen.findByRole("heading", { name: "example-qa-test" });
		expect(
			screen.queryByRole("button", { name: /MCP call/ }),
		).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Copy path" }));

		expect(writeText).toHaveBeenCalledWith(
			".claude/skills/example-qa-test/SKILL.md",
		);
		await waitFor(() =>
			expect(editMocks.toastSuccess).toHaveBeenCalledWith("Path copied"),
		);
	});
	/**
	 * Fizzy #2546. Editing a file in the tab has to produce a NEW VERSION
	 * through the ordinary upload path, not an in-place write — so what this
	 * suite asserts is the change set the component hands to
	 * `editInstructionSnapshot`, and, just as important, the cases where it
	 * hands over nothing at all.
	 */
	describe("editing", () => {
		it("lets a reader submit an edited file as a proposal without requesting direct publication", async () => {
			const user = userEvent.setup();
			render(
				<InstructionFileView
					projectId="p"
					snapshotId="s"
					path=".claude/skills/example-qa-test/SKILL.md"
					canPropose
				/>,
				{ wrapper: TestQueryProvider },
			);

			await user.click(
				await screen.findByRole("button", { name: "Edit" }),
			);
			await user.clear(screen.getByRole("textbox"));
			await user.type(screen.getByRole("textbox"), "# Proposed");
			await user.click(
				screen.getByRole("button", { name: "Submit proposal" }),
			);

			await waitFor(() =>
				expect(editMocks.editInstructionSnapshot).toHaveBeenCalledWith(
					expect.objectContaining({
						proposal: true,
						publishOnReady: false,
					}),
				),
			);
		});

		it("offers no Edit or Delete without edit rights", async () => {
			render(
				<InstructionFileView
					projectId="p"
					snapshotId="s"
					path=".claude/skills/example-qa-test/SKILL.md"
				/>,
				{ wrapper: TestQueryProvider },
			);
			await screen.findByRole("heading", { name: "example-qa-test" });
			expect(
				screen.queryByRole("button", { name: "Edit" }),
			).not.toBeInTheDocument();
			expect(
				screen.queryByRole("button", { name: "File actions" }),
			).not.toBeInTheDocument();
		});

		it("saves the edited body as a put and publishes it", async () => {
			const user = userEvent.setup();
			render(
				<InstructionFileView
					projectId="p"
					snapshotId="s"
					path=".claude/skills/example-qa-test/SKILL.md"
					canEdit
				/>,
				{ wrapper: TestQueryProvider },
			);
			await user.click(
				await screen.findByRole("button", { name: "Edit" }),
			);
			const editor = screen.getByRole("textbox");
			await user.clear(editor);
			await user.type(editor, "# Replaced");
			await user.click(
				screen.getByRole("button", { name: "Save and publish" }),
			);

			await waitFor(() =>
				expect(editMocks.editInstructionSnapshot).toHaveBeenCalled(),
			);
			const call = editMocks.editInstructionSnapshot.mock
				.calls[0]![0] as {
				projectId: string;
				baseSnapshotId: string;
				publishOnReady: boolean;
				edits: Array<{ op: string; path: string; body: Blob }>;
			};
			expect(call).toMatchObject({
				projectId: "p",
				baseSnapshotId: "s",
				publishOnReady: true,
			});
			expect(call.edits).toHaveLength(1);
			expect(call.edits[0]).toMatchObject({
				op: "put",
				path: ".claude/skills/example-qa-test/SKILL.md",
			});
			expect(await call.edits[0]!.body.text()).toBe("# Replaced");
		});

		it('"Save as a new version" does not claim the published pointer', async () => {
			const user = userEvent.setup();
			render(
				<InstructionFileView
					projectId="p"
					snapshotId="s"
					path=".claude/skills/example-qa-test/SKILL.md"
					canEdit
				/>,
				{ wrapper: TestQueryProvider },
			);
			await user.click(
				await screen.findByRole("button", { name: "Edit" }),
			);
			const editor = screen.getByRole("textbox");
			await user.type(editor, "\nmore");
			await user.click(
				screen.getByRole("button", { name: "Save as a new version" }),
			);

			await waitFor(() =>
				expect(editMocks.editInstructionSnapshot).toHaveBeenCalledWith(
					expect.objectContaining({ publishOnReady: false }),
				),
			);
		});

		it("makes no version at all when the body is unchanged", async () => {
			const user = userEvent.setup();
			render(
				<InstructionFileView
					projectId="p"
					snapshotId="s"
					path=".claude/skills/example-qa-test/SKILL.md"
					canEdit
				/>,
				{ wrapper: TestQueryProvider },
			);
			await user.click(
				await screen.findByRole("button", { name: "Edit" }),
			);
			await user.click(
				screen.getByRole("button", { name: "Save and publish" }),
			);

			expect(editMocks.editInstructionSnapshot).not.toHaveBeenCalled();
			expect(editMocks.toastInfo).toHaveBeenCalledWith(
				"Nothing changed, so no new version was made.",
			);
		});

		it("sends a delete change once the confirmation is accepted", async () => {
			const user = userEvent.setup();
			render(
				<InstructionFileView
					projectId="p"
					snapshotId="s"
					path=".claude/skills/example-qa-test/SKILL.md"
					canEdit
				/>,
				{ wrapper: TestQueryProvider },
			);
			await chooseFileAction(user, "Delete file");

			await waitFor(() =>
				expect(editMocks.editInstructionSnapshot).toHaveBeenCalledWith(
					expect.objectContaining({
						edits: [
							{
								op: "delete",
								path: ".claude/skills/example-qa-test/SKILL.md",
							},
						],
					}),
				),
			);
			// Asked in the app's own dialog, destructively, with the action
			// named on the button rather than a bare "Confirm".
			expect(confirmMock).toHaveBeenCalledWith(
				expect.objectContaining({
					title: "Delete .claude/skills/example-qa-test/SKILL.md and publish a new version?",
					confirmLabel: "Delete file",
					destructive: true,
				}),
			);
		});

		it("submits a reader deletion as a proposal", async () => {
			const user = userEvent.setup();
			render(
				<InstructionFileView
					projectId="p"
					snapshotId="s"
					path=".claude/skills/example-qa-test/SKILL.md"
					canPropose
				/>,
				{ wrapper: TestQueryProvider },
			);
			await chooseFileAction(user, "Delete file");

			await waitFor(() =>
				expect(editMocks.editInstructionSnapshot).toHaveBeenCalledWith(
					expect.objectContaining({
						proposal: true,
						publishOnReady: false,
						edits: [
							{
								op: "delete",
								path: ".claude/skills/example-qa-test/SKILL.md",
							},
						],
					}),
				),
			);
			expect(confirmMock).toHaveBeenCalledWith(
				expect.objectContaining({
					title: "Submit a deletion proposal for .claude/skills/example-qa-test/SKILL.md?",
					confirmLabel: "Submit proposal",
					destructive: true,
				}),
			);
		});

		// Fizzy #2563 spec §12: on a repository-backed project a suggestion
		// opens a pull request, and the person is told where, and that the
		// push can start CI, before they submit — here as in the dialog.
		it("says a suggested edit opens a pull request in the repository before it is submitted", async () => {
			const user = userEvent.setup();
			render(
				<InstructionFileView
					projectId="p"
					snapshotId="s"
					path=".claude/skills/example-qa-test/SKILL.md"
					canPropose
					repositoryTarget={{
						repository: "example-org/example-repo",
						ref: "main",
					}}
				/>,
				{ wrapper: TestQueryProvider },
			);
			await user.click(
				await screen.findByRole("button", { name: "Edit" }),
			);
			expect(
				screen.getByText(
					/Submitting opens a pull request in example-org\/example-repo against main\./,
				),
			).toBeInTheDocument();
			await user.clear(screen.getByRole("textbox"));
			await user.type(screen.getByRole("textbox"), "# Suggested");
			await user.click(
				screen.getByRole("button", {
					name: "Suggest as a pull request",
				}),
			);
			await waitFor(() =>
				expect(editMocks.editInstructionSnapshot).toHaveBeenCalledWith(
					expect.objectContaining({ proposal: true }),
				),
			);
			expect(editMocks.toastSuccess).toHaveBeenCalledWith(
				"Suggestion submitted. Fabric opens the pull request once the files pass their checks.",
			);
		});

		it("names the repository and branch when confirming a suggested deletion", async () => {
			const user = userEvent.setup();
			render(
				<InstructionFileView
					projectId="p"
					snapshotId="s"
					path=".claude/skills/example-qa-test/SKILL.md"
					canPropose
					repositoryTarget={{
						repository: "example-org/example-repo",
						ref: "main",
					}}
				/>,
				{ wrapper: TestQueryProvider },
			);
			await chooseFileAction(user, "Delete file");
			expect(confirmMock).toHaveBeenCalledWith(
				expect.objectContaining({
					title: "Suggest deleting .claude/skills/example-qa-test/SKILL.md? Once the change passes its checks, Fabric opens a pull request in example-org/example-repo against main.",
					confirmLabel: "Suggest deletion",
					destructive: true,
				}),
			);
			await waitFor(() =>
				expect(editMocks.editInstructionSnapshot).toHaveBeenCalledWith(
					expect.objectContaining({ proposal: true }),
				),
			);
		});

		it("deletes nothing when the confirmation is declined", async () => {
			const user = userEvent.setup();
			confirmMock.mockImplementation(() => undefined);
			render(
				<InstructionFileView
					projectId="p"
					snapshotId="s"
					path=".claude/skills/example-qa-test/SKILL.md"
					canEdit
				/>,
				{ wrapper: TestQueryProvider },
			);
			await chooseFileAction(user, "Delete file");

			expect(confirmMock).toHaveBeenCalledTimes(1);
			expect(editMocks.editInstructionSnapshot).not.toHaveBeenCalled();
		});

		it("refuses to edit a binary file and says why", async () => {
			const user = userEvent.setup();
			fileResponse.current = {
				...TEXT_FILE,
				path: "assets/logo.png",
				kind: "OTHER",
				name: null,
				description: null,
				isText: false,
				body: null,
				url: "https://storage.example.com/signed/logo.png",
			};
			render(
				<InstructionFileView
					projectId="p"
					snapshotId="s"
					path="assets/logo.png"
					canEdit
				/>,
				{ wrapper: TestQueryProvider },
			);
			await user.click(
				await screen.findByRole("button", { name: "Edit" }),
			);

			expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
			expect(editMocks.toastInfo).toHaveBeenCalledWith(
				"This file is not text, so it can't be edited here. Replace it with Add file.",
			);
		});

		it("names the same way out for a file that is too large, not a different one", async () => {
			const user = userEvent.setup();
			fileResponse.current = {
				...TEXT_FILE,
				size: 6_000_000,
				truncated: true,
				nextOffset: 200_000,
			};
			render(
				<InstructionFileView
					projectId="p"
					snapshotId="s"
					path=".claude/skills/example-qa-test/SKILL.md"
					canEdit
				/>,
				{ wrapper: TestQueryProvider },
			);
			await user.click(
				await screen.findByRole("button", { name: "Edit" }),
			);

			expect(editMocks.toastInfo).toHaveBeenCalledWith(
				"This file is too large to edit here. Replace it with Add file.",
			);
		});

		it("tells a reader to replace a file with the control they actually have", async () => {
			const user = userEvent.setup();
			fileResponse.current = {
				...TEXT_FILE,
				path: "assets/logo.png",
				kind: "OTHER",
				isText: false,
				body: null,
				url: "https://storage.example.com/signed/logo.png",
			};
			render(
				<InstructionFileView
					projectId="p"
					snapshotId="s"
					path="assets/logo.png"
					canPropose
				/>,
				{ wrapper: TestQueryProvider },
			);
			await user.click(
				await screen.findByRole("button", { name: "Edit" }),
			);

			expect(editMocks.toastInfo).toHaveBeenCalledWith(
				"This file is not text, so it can't be edited here. Replace it with Propose file.",
			);
		});

		it("refuses to edit .fabricignore, which decides what the version excludes", async () => {
			const user = userEvent.setup();
			fileResponse.current = {
				...TEXT_FILE,
				path: ".fabricignore",
				kind: "OTHER",
				name: null,
				description: null,
				size: 40,
				body: "tasks/\n",
			};
			render(
				<InstructionFileView
					projectId="p"
					snapshotId="s"
					path=".fabricignore"
					canEdit
				/>,
				{ wrapper: TestQueryProvider },
			);
			await user.click(
				await screen.findByRole("button", { name: "Edit" }),
			);

			expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
			expect(editMocks.editInstructionSnapshot).not.toHaveBeenCalled();
		});

		/**
		 * IMPORTANT (round 5). The draft used to be keyed by PATH alone, and
		 * this component is not remounted when `snapshotId` changes: the
		 * tab's poll swaps in a teammate's newly published version while the
		 * editor is open. The draft was read from the old version, the save
		 * would claim the new one as its base — a base the server agrees is
		 * published — and the teammate's change would be overwritten by text
		 * that never saw it.
		 */
		it("will not save a draft against a version published after the draft was opened", async () => {
			const user = userEvent.setup();
			const { rerender } = render(
				<InstructionFileView
					projectId="p"
					snapshotId="s"
					path=".claude/skills/example-qa-test/SKILL.md"
					canEdit
				/>,
				{ wrapper: TestQueryProvider },
			);
			await user.click(
				await screen.findByRole("button", { name: "Edit" }),
			);
			await user.clear(screen.getByRole("textbox"));
			await user.type(screen.getByRole("textbox"), "# Mine");

			// The teammate publishes; the tab's poll rerenders this component
			// with the new published snapshot id, in place.
			fileResponse.current = { ...TEXT_FILE, body: "# Theirs" };
			rerender(
				<InstructionFileView
					projectId="p"
					snapshotId="s2"
					path=".claude/skills/example-qa-test/SKILL.md"
					canEdit
				/>,
			);

			// The typed text is still on screen — nothing of theirs is lost
			// by protecting the teammate's change, and nothing of the
			// teammate's is lost by keeping it.
			expect(await screen.findByRole("alert")).toHaveTextContent(
				"Someone published a new version while you were editing",
			);
			expect(screen.getByRole("textbox")).toHaveValue("# Mine");
			// ...and there is no way at all to save it.
			expect(
				screen.queryByRole("button", { name: "Save and publish" }),
			).not.toBeInTheDocument();
			expect(
				screen.queryByRole("button", {
					name: "Save as a new version",
				}),
			).not.toBeInTheDocument();
			expect(editMocks.editInstructionSnapshot).not.toHaveBeenCalled();

			// Discarding returns the reader, and Edit then starts from the
			// version that is actually published — which is the only way a
			// save can carry the new id.
			await user.click(screen.getByRole("button", { name: "Discard" }));
			await user.click(
				await screen.findByRole("button", { name: "Edit" }),
			);
			await user.type(screen.getByRole("textbox"), " plus mine");
			await user.click(
				screen.getByRole("button", { name: "Save and publish" }),
			);

			await waitFor(() =>
				expect(editMocks.editInstructionSnapshot).toHaveBeenCalledTimes(
					1,
				),
			);
			const call = editMocks.editInstructionSnapshot.mock
				.calls[0]![0] as {
				baseSnapshotId: string;
				edits: Array<{ op: string; path: string; body: Blob }>;
			};
			expect(call.baseSnapshotId).toBe("s2");
			expect(await call.edits[0]!.body.text()).toBe("# Theirs plus mine");
		});
	});

	// Design 2026-09-23 §5.8: a Guild file's frontmatter carries keys the
	// header has no dedicated row for. `parseFrontmatter` already keeps them;
	// the header now shows them as written.
	it("shows frontmatter keys it has no dedicated row for, as written", async () => {
		fileResponse.current = {
			...TEXT_FILE,
			path: "Knowledge/deploys.md",
			kind: "KNOWLEDGE",
			name: "deploys",
			description: "How deploys work.",
			body: "---\nname: deploys\ndescription: How deploys work.\nowner: platform-team\ntags: [deploy, ops]\nstatus: active\nsince: 2026-01-01\nareas:\n  - api\n  - web\n---\n\nBody.",
		};
		render(
			<InstructionFileView
				projectId="p"
				snapshotId="s"
				path="Knowledge/deploys.md"
			/>,
			{ wrapper: TestQueryProvider },
		);
		expect(await screen.findByText("owner")).toBeInTheDocument();
		expect(screen.getByText("platform-team")).toBeInTheDocument();
		expect(screen.getByText("[deploy, ops]")).toBeInTheDocument();
		expect(screen.getByText("active")).toBeInTheDocument();
		expect(screen.getByText("2026-01-01")).toBeInTheDocument();
		expect(screen.getByText(/- api\s+- web/)).toBeInTheDocument();
		// The heading and description are not repeated as rows.
		expect(screen.queryByText("description")).toBeNull();
	});

	/**
	 * The viewer's accepting branch's projection of the viewed path (Fizzy
	 * #2738 spec §10 "Editor"): a `written` path reads the branch's own
	 * bytes and is labelled "From your branch"; a `restored_unavailable`
	 * path opens the published version under its own notice and never
	 * substitutes content. Only relevant on a repository-backed project,
	 * where `myBranch` is queried at all.
	 */
	describe("the member branch version", () => {
		const repositoryTarget = {
			repository: "example-org/example-repo",
			ref: "main",
		};

		it("shows no 'From your branch' label or notice with no branch entry for the path", async () => {
			branchResponse.current = {
				branch: { id: "branch_1" },
				liveChanges: 1,
				files: [],
				branches: [],
			};
			render(
				<InstructionFileView
					projectId="p"
					snapshotId="s"
					path=".claude/skills/example-qa-test/SKILL.md"
					repositoryTarget={repositoryTarget}
				/>,
				{ wrapper: TestQueryProvider },
			);
			await screen.findByRole("heading", { name: "example-qa-test" });
			expect(
				screen.queryByText("From your branch"),
			).not.toBeInTheDocument();
			expect(screen.getByText("Body.")).toBeInTheDocument();
		});

		it("labels a written branch path 'From your branch' and shows the branch's own bytes, not the published body", async () => {
			branchResponse.current = {
				branch: { id: "branch_1" },
				liveChanges: 1,
				files: [
					{
						path: ".claude/skills/example-qa-test/SKILL.md",
						state: "written",
						sha256: "abc",
						snapshotId: "snap_branch",
					},
				],
				branches: [],
			};
			branchFileResponse.current = {
				branchId: "branch_1",
				path: ".claude/skills/example-qa-test/SKILL.md",
				snapshotId: "snap_branch",
				sha256: "abc",
				size: 40,
				mimeType: "text/markdown",
				isText: true,
				mode: null,
				body: "# From the branch\nBranch-only body.",
				offset: 0,
				nextOffset: null,
				truncated: false,
				url: null,
			};
			render(
				<InstructionFileView
					projectId="p"
					snapshotId="s"
					path=".claude/skills/example-qa-test/SKILL.md"
					repositoryTarget={repositoryTarget}
				/>,
				{ wrapper: TestQueryProvider },
			);
			expect(
				await screen.findByText("From your branch"),
			).toBeInTheDocument();
			expect(screen.getByText("Branch-only body.")).toBeInTheDocument();
			// The published body's own text is gone: the branch's bytes replaced
			// it, not merely joined it.
			expect(screen.queryByText("Body.")).not.toBeInTheDocument();
		});

		/**
		 * Regression for the review finding: Edit used to seed the draft from
		 * the PUBLISHED body and compare "unchanged" against it too, so a
		 * small edit on top of a written branch version could silently
		 * overwrite the member's own branch content instead of building on
		 * it. Both the seed and the comparison have to be the resolved
		 * DISPLAY body — the branch's, here — never the published one
		 * underneath it.
		 */
		it("seeds Edit from the branch's own body and submits on top of it, not the published body", async () => {
			const user = userEvent.setup();
			branchResponse.current = {
				branch: { id: "branch_1" },
				liveChanges: 1,
				files: [
					{
						path: ".claude/skills/example-qa-test/SKILL.md",
						state: "written",
						sha256: "abc",
						snapshotId: "snap_branch",
					},
				],
				branches: [],
			};
			branchFileResponse.current = {
				branchId: "branch_1",
				path: ".claude/skills/example-qa-test/SKILL.md",
				snapshotId: "snap_branch",
				sha256: "abc",
				size: 40,
				mimeType: "text/markdown",
				isText: true,
				mode: null,
				body: "# From the branch\nBranch-only body.",
				offset: 0,
				nextOffset: null,
				truncated: false,
				url: null,
			};
			render(
				<InstructionFileView
					projectId="p"
					snapshotId="s"
					path=".claude/skills/example-qa-test/SKILL.md"
					canEdit
					repositoryTarget={repositoryTarget}
				/>,
				{ wrapper: TestQueryProvider },
			);
			// Wait for the branch's own bytes to resolve before pressing
			// Edit: its accessible name is "Edit" either way, so pressing it
			// while `myBranchFile` is still loading would click the
			// disabled-tooltip variant instead of opening the editor.
			await screen.findByText("From your branch");
			await user.click(screen.getByRole("button", { name: "Edit" }));
			// Seeded from the branch's body — the published body's own text
			// ("Body.", from `TEXT_FILE`) never appears in the draft.
			expect(screen.getByRole("textbox")).toHaveValue(
				"# From the branch\nBranch-only body.",
			);
			await user.type(screen.getByRole("textbox"), "\nplus an edit");
			await user.click(
				screen.getByRole("button", { name: "Save and publish" }),
			);
			await waitFor(() =>
				expect(editMocks.editInstructionSnapshot).toHaveBeenCalled(),
			);
			const call = editMocks.editInstructionSnapshot.mock
				.calls[0]![0] as {
				edits: Array<{ op: string; path: string; body: Blob }>;
			};
			// Built on the branch's content, not the published one: it would
			// read "Body.\nplus an edit" if the draft had been seeded from
			// the published body instead.
			expect(await call.edits[0]!.body.text()).toBe(
				"# From the branch\nBranch-only body.\nplus an edit",
			);
		});

		it("makes no version when the branch's own body is unchanged, even though it differs from the published body", async () => {
			const user = userEvent.setup();
			branchResponse.current = {
				branch: { id: "branch_1" },
				liveChanges: 1,
				files: [
					{
						path: ".claude/skills/example-qa-test/SKILL.md",
						state: "written",
						sha256: "abc",
						snapshotId: "snap_branch",
					},
				],
				branches: [],
			};
			branchFileResponse.current = {
				branchId: "branch_1",
				path: ".claude/skills/example-qa-test/SKILL.md",
				snapshotId: "snap_branch",
				sha256: "abc",
				size: 40,
				mimeType: "text/markdown",
				isText: true,
				mode: null,
				body: "# From the branch\nBranch-only body.",
				offset: 0,
				nextOffset: null,
				truncated: false,
				url: null,
			};
			render(
				<InstructionFileView
					projectId="p"
					snapshotId="s"
					path=".claude/skills/example-qa-test/SKILL.md"
					canEdit
					repositoryTarget={repositoryTarget}
				/>,
				{ wrapper: TestQueryProvider },
			);
			// See the sibling test above: wait for the branch's own bytes
			// before pressing Edit, whose accessible name doesn't change
			// between the disabled and the real button.
			await screen.findByText("From your branch");
			await user.click(screen.getByRole("button", { name: "Edit" }));
			await user.click(
				screen.getByRole("button", { name: "Save and publish" }),
			);
			// If "unchanged" had compared against the published body ("Body.",
			// which differs from the branch's), this would have been treated
			// as a real change and submitted.
			expect(editMocks.editInstructionSnapshot).not.toHaveBeenCalled();
			expect(editMocks.toastInfo).toHaveBeenCalledWith(
				"Nothing changed, so no new version was made.",
			);
		});

		/**
		 * Review finding (round 2): only the later `myBranchFile` read was
		 * gated on loading/error. The `myBranch` PROJECTION itself is a
		 * separate query that can be loading (or fail) first — while it is,
		 * `branchEntry` is undefined, so a fast Edit click before it resolves
		 * used to seed a draft from the published body even though the
		 * branch turns out to hold a different one underneath it.
		 */
		it("keeps editing unavailable while the branch projection itself is still loading", async () => {
			const user = userEvent.setup();
			branchResponse.pending = true;
			render(
				<InstructionFileView
					projectId="p"
					snapshotId="s"
					path=".claude/skills/example-qa-test/SKILL.md"
					canEdit
					repositoryTarget={repositoryTarget}
				/>,
				{ wrapper: TestQueryProvider },
			);
			expect(
				await screen.findByText(
					"Loading your branch's version of this file…",
				),
			).toBeInTheDocument();
			// No silent fallback to the published body, and no destructive
			// seed, while the projection itself is still unresolved.
			expect(screen.queryByText("Body.")).not.toBeInTheDocument();
			await user.click(screen.getByRole("button", { name: "Edit" }));
			expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
			expect(editMocks.toastInfo).toHaveBeenCalledWith(
				"Loading your branch's version of this file…",
			);
		});

		// The projection resolving to no branch entry for this path at all
		// (the ordinary case for most files) is covered by "shows no 'From
		// your branch' label or notice with no branch entry for the path"
		// and the plain, non-repository-backed editing tests above: editing
		// the published body is fine once there is no branch version that
		// could be silently overwritten.

		it("keeps editing unavailable and shows an error state when the branch projection itself fails to load", async () => {
			const user = userEvent.setup();
			branchResponse.error = new Error("network down");
			render(
				<InstructionFileView
					projectId="p"
					snapshotId="s"
					path=".claude/skills/example-qa-test/SKILL.md"
					canEdit
					repositoryTarget={repositoryTarget}
				/>,
				{ wrapper: TestQueryProvider },
			);
			expect(await screen.findByRole("alert")).toHaveTextContent(
				"Fabric could not load your branch's version of this file. Refresh the page to try again.",
			);
			expect(screen.queryByText("Body.")).not.toBeInTheDocument();
			await user.click(screen.getByRole("button", { name: "Edit" }));
			expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
			expect(editMocks.toastInfo).toHaveBeenCalledWith(
				"Fabric could not load your branch's version of this file. Refresh the page to try again.",
			);
		});

		it("keeps editing unavailable and shows a loading state while a written branch file has not resolved yet", async () => {
			const user = userEvent.setup();
			branchResponse.current = {
				branch: { id: "branch_1" },
				liveChanges: 1,
				files: [
					{
						path: ".claude/skills/example-qa-test/SKILL.md",
						state: "written",
						sha256: "abc",
						snapshotId: "snap_branch",
					},
				],
				branches: [],
			};
			branchFileResponse.pending = true;
			render(
				<InstructionFileView
					projectId="p"
					snapshotId="s"
					path=".claude/skills/example-qa-test/SKILL.md"
					canEdit
					repositoryTarget={repositoryTarget}
				/>,
				{ wrapper: TestQueryProvider },
			);
			expect(
				await screen.findByText(
					"Loading your branch's version of this file…",
				),
			).toBeInTheDocument();
			// Never a silent fallback to the published body while the
			// branch's own bytes are still unresolved.
			expect(screen.queryByText("Body.")).not.toBeInTheDocument();
			await user.click(screen.getByRole("button", { name: "Edit" }));
			expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
			expect(editMocks.toastInfo).toHaveBeenCalledWith(
				"Loading your branch's version of this file…",
			);
		});

		it("keeps editing unavailable and shows an error state when a written branch file fails to load", async () => {
			const user = userEvent.setup();
			branchResponse.current = {
				branch: { id: "branch_1" },
				liveChanges: 1,
				files: [
					{
						path: ".claude/skills/example-qa-test/SKILL.md",
						state: "written",
						sha256: "abc",
						snapshotId: "snap_branch",
					},
				],
				branches: [],
			};
			branchFileResponse.error = new Error("network down");
			render(
				<InstructionFileView
					projectId="p"
					snapshotId="s"
					path=".claude/skills/example-qa-test/SKILL.md"
					canEdit
					repositoryTarget={repositoryTarget}
				/>,
				{ wrapper: TestQueryProvider },
			);
			expect(await screen.findByRole("alert")).toHaveTextContent(
				"Fabric could not load your branch's version of this file. Refresh the page to try again.",
			);
			// Never a silent fallback to the published body once the branch's
			// own bytes are confirmed unreachable.
			expect(screen.queryByText("Body.")).not.toBeInTheDocument();
			await user.click(screen.getByRole("button", { name: "Edit" }));
			expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
			expect(editMocks.toastInfo).toHaveBeenCalledWith(
				"Fabric could not load your branch's version of this file. Refresh the page to try again.",
			);
		});

		/**
		 * Review finding (round 2): edit eligibility used to come from the
		 * PUBLISHED file `f` even while showing a branch version — so a
		 * binary or truncated branch body could still be replaced by an
		 * empty (or silently shortened) text draft. `TEXT_FILE` here is
		 * text and well within any size limit, proving the refusal is read
		 * from the branch's own response, not the published one.
		 */
		it("refuses to edit a branch file that is binary, even though the published file is text", async () => {
			const user = userEvent.setup();
			branchResponse.current = {
				branch: { id: "branch_1" },
				liveChanges: 1,
				files: [
					{
						path: ".claude/skills/example-qa-test/SKILL.md",
						state: "written",
						sha256: "abc",
						snapshotId: "snap_branch",
					},
				],
				branches: [],
			};
			branchFileResponse.current = {
				branchId: "branch_1",
				path: ".claude/skills/example-qa-test/SKILL.md",
				snapshotId: "snap_branch",
				sha256: "abc",
				size: 900,
				mimeType: "image/png",
				isText: false,
				mode: null,
				body: null,
				offset: 0,
				nextOffset: null,
				truncated: false,
				url: "https://storage.example.com/signed/branch-logo.png",
			};
			render(
				<InstructionFileView
					projectId="p"
					snapshotId="s"
					path=".claude/skills/example-qa-test/SKILL.md"
					canEdit
					repositoryTarget={repositoryTarget}
				/>,
				{ wrapper: TestQueryProvider },
			);
			expect(
				await screen.findByText("This is a binary file.", {
					exact: false,
				}),
			).toBeInTheDocument();
			// Never the published text body, and no textarea a click could
			// have replaced it with.
			expect(screen.queryByText(/Example QA Test Workflow/)).toBeNull();
			await user.click(screen.getByRole("button", { name: "Edit" }));
			expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
			expect(editMocks.toastInfo).toHaveBeenCalledWith(
				"This file is not text, so it can't be edited here. Replace it with Suggest a change.",
			);
			expect(editMocks.editInstructionSnapshot).not.toHaveBeenCalled();
		});

		it("refuses to edit a branch file whose body was cut short, even though the published file is not truncated", async () => {
			const user = userEvent.setup();
			branchResponse.current = {
				branch: { id: "branch_1" },
				liveChanges: 1,
				files: [
					{
						path: ".claude/skills/example-qa-test/SKILL.md",
						state: "written",
						sha256: "abc",
						snapshotId: "snap_branch",
					},
				],
				branches: [],
			};
			branchFileResponse.current = {
				branchId: "branch_1",
				path: ".claude/skills/example-qa-test/SKILL.md",
				snapshotId: "snap_branch",
				sha256: "abc",
				size: 400_000,
				mimeType: "text/markdown",
				isText: true,
				mode: null,
				body: "# From the branch\nFirst page only.",
				offset: 0,
				nextOffset: 200_000,
				truncated: true,
				url: null,
			};
			render(
				<InstructionFileView
					projectId="p"
					snapshotId="s"
					path=".claude/skills/example-qa-test/SKILL.md"
					canEdit
					repositoryTarget={repositoryTarget}
				/>,
				{ wrapper: TestQueryProvider },
			);
			expect(
				await screen.findByText(
					"Showing the first 200000 characters. Download the version for the full file.",
				),
			).toBeInTheDocument();
			await user.click(screen.getByRole("button", { name: "Edit" }));
			// Saving a truncated body would silently delete the rest of the
			// branch's file, so no textarea is offered at all.
			expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
			expect(editMocks.toastInfo).toHaveBeenCalledWith(
				"This file is too large to edit here. Replace it with Suggest a change.",
			);
			expect(editMocks.editInstructionSnapshot).not.toHaveBeenCalled();
		});

		it("shows the restored_unavailable notice and the published body, never a substitution", async () => {
			branchResponse.current = {
				branch: { id: "branch_1" },
				liveChanges: 1,
				files: [
					{
						path: ".claude/skills/example-qa-test/SKILL.md",
						state: "restored_unavailable",
						sha256: null,
						snapshotId: null,
					},
				],
				branches: [],
			};
			render(
				<InstructionFileView
					projectId="p"
					snapshotId="s"
					path=".claude/skills/example-qa-test/SKILL.md"
					repositoryTarget={repositoryTarget}
				/>,
				{ wrapper: TestQueryProvider },
			);
			expect(
				await screen.findByText(
					"Your branch holds an earlier version of this file that Fabric cannot show here",
				),
			).toBeInTheDocument();
			expect(
				screen.getByText("Use when the user provides a work item ID."),
			).toBeInTheDocument();
			expect(
				screen.queryByText("From your branch"),
			).not.toBeInTheDocument();
		});

		it("gives the 'no changes' refusal the withdrawal hint for a repository suggestion", async () => {
			const user = userEvent.setup();
			render(
				<InstructionFileView
					projectId="p"
					snapshotId="s"
					path=".claude/skills/example-qa-test/SKILL.md"
					canPropose
					repositoryTarget={repositoryTarget}
				/>,
				{ wrapper: TestQueryProvider },
			);
			await user.click(
				await screen.findByRole("button", { name: "Edit" }),
			);
			await user.click(
				screen.getByRole("button", {
					name: "Suggest as a pull request",
				}),
			);
			expect(editMocks.toastInfo).toHaveBeenCalledWith(
				"Nothing changed, so no new suggestion was made. To remove this file's suggested change, withdraw it in Review proposals, or edit the branch in the repository.",
			);
			expect(editMocks.editInstructionSnapshot).not.toHaveBeenCalled();
		});
	});
});
