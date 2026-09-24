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
vi.mock("sonner", () => ({
	toast: {
		info: (...a: unknown[]) => editMocks.toastInfo(...a),
		success: (...a: unknown[]) => editMocks.toastSuccess(...a),
		error: (...a: unknown[]) => editMocks.toastError(...a),
	},
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
		fileResponse.current = { ...TEXT_FILE };
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
				"Showing the first 200000 characters. Download the snapshot for the full file.",
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
		expect(
			screen.queryByText(/Download the snapshot for the full file/),
		).not.toBeInTheDocument();
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
				screen.queryByRole("button", { name: "Delete file" }),
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
			const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
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
				await screen.findByRole("button", { name: "Delete file" }),
			);

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
			confirm.mockRestore();
		});

		it("submits a reader deletion as a proposal", async () => {
			const user = userEvent.setup();
			const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
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
				await screen.findByRole("button", { name: "Delete file" }),
			);

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
			expect(confirm).toHaveBeenCalledWith(
				"Submit a deletion proposal for .claude/skills/example-qa-test/SKILL.md?",
			);
			confirm.mockRestore();
		});

		it("deletes nothing when the confirmation is declined", async () => {
			const user = userEvent.setup();
			const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
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
				await screen.findByRole("button", { name: "Delete file" }),
			);

			expect(editMocks.editInstructionSnapshot).not.toHaveBeenCalled();
			confirm.mockRestore();
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
				"This file is not text. Use Add file to replace it.",
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
});
