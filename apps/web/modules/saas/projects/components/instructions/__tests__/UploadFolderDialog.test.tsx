import en from "@repo/i18n/translations/en.json";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Fragment, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Resolve `t()`/`t.rich()` to the REAL shipped copy (not the raw key the
// repo's global `vitest.setup.ts` mock echoes back) so assertions below
// target actual rendered English, the same way
// `DiffReviewBar.test.tsx`/`CreateDocumentDialog.test.tsx` do for their own
// components.
const uploadDialogCopy = en.projects.codingInstructions.uploadDialog as Record<
	string,
	string
>;

function interpolate(template: string, values?: Record<string, unknown>) {
	if (!values) {
		return template;
	}
	return template.replace(/\{(\w+)\}/g, (_, name) => String(values[name]));
}

/** Minimal `t.rich` stand-in: replaces `<tag>inner</tag>` with `tags[tag](inner)`. */
function richRender(
	template: string,
	tags: Record<string, (chunks: string) => ReactNode>,
): ReactNode[] {
	const nodes: ReactNode[] = [];
	const re = /<(\w+)>(.*?)<\/\1>/g;
	let lastIndex = 0;
	let match: RegExpExecArray | null;
	let key = 0;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
	while ((match = re.exec(template))) {
		if (match.index > lastIndex) {
			nodes.push(
				<Fragment key={key++}>
					{template.slice(lastIndex, match.index)}
				</Fragment>,
			);
		}
		const render = tags[match[1]];
		nodes.push(
			<Fragment key={key++}>
				{render ? render(match[2]) : match[2]}
			</Fragment>,
		);
		lastIndex = re.lastIndex;
	}
	if (lastIndex < template.length) {
		nodes.push(
			<Fragment key={key++}>{template.slice(lastIndex)}</Fragment>,
		);
	}
	return nodes;
}

vi.mock("next-intl", () => ({
	useTranslations: () => {
		const t = (key: string, values?: Record<string, unknown>) =>
			interpolate(uploadDialogCopy[key] ?? key, values);
		t.rich = (
			key: string,
			tags: Record<string, (chunks: string) => ReactNode>,
		) => richRender(uploadDialogCopy[key] ?? key, tags);
		t.raw = (key: string) => uploadDialogCopy[key] ?? key;
		return t;
	},
}));

const uploadSnapshot = vi
	.fn()
	.mockResolvedValue({ snapshotId: "snap_1", serverExcludedPaths: [] });
vi.mock("../../../lib/upload-snapshot", () => ({
	uploadSnapshot: (...a: unknown[]) => uploadSnapshot(...a),
}));

// Tiny caps so the limits notice can be reached with a handful of files. Only
// the dialog's and `read-folder.ts`' view of the barrel changes; path
// validation inside `@repo/instructions` still uses the real numbers.
vi.mock("@repo/instructions", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/instructions")>();
	return {
		...actual,
		SNAPSHOT_LIMITS: {
			...actual.SNAPSHOT_LIMITS,
			maxFiles: 3,
			maxTotalBytes: 64,
		},
	};
});

import { UploadFolderDialog } from "../UploadFolderDialog";

function pick(path: string, content = "x") {
	const f = new File([content], path.slice(path.lastIndexOf("/") + 1));
	Object.defineProperty(f, "webkitRelativePath", { value: path });
	return f;
}

/** A root file picked without a folder: no `webkitRelativePath` at all. */
function pickRoot(name: string, content = "x") {
	return new File([content], name);
}

function renderDialog() {
	render(
		<UploadFolderDialog
			projectId="proj_1"
			open
			onOpenChange={() => undefined}
			onUploaded={vi.fn()}
		/>,
	);
}

function sourceChips(): string[] {
	const list = screen.getByRole("list", { name: "Added folders and files" });
	return Array.from(list.querySelectorAll("li")).map(
		(li) => li.querySelector(".font-mono")?.textContent ?? "",
	);
}

/** The preview tree's row paths, in rendered order (each row's own text node). */
function rowPaths(): string[] {
	const tree = document.querySelector(".max-h-\\[400px\\]");
	return Array.from(tree?.querySelectorAll("span.font-mono") ?? []).map(
		(span) =>
			Array.from(span.childNodes)
				.filter((n) => n.nodeType === Node.TEXT_NODE)
				.map((n) => n.textContent)
				.join(""),
	);
}

describe("UploadFolderDialog", () => {
	beforeEach(() => {
		uploadSnapshot.mockClear();
	});

	it("previews kept and excluded rows, then uploads only what is kept", async () => {
		const onUploaded = vi.fn();
		render(
			<UploadFolderDialog
				projectId="proj_1"
				open
				onOpenChange={() => undefined}
				onUploaded={onUploaded}
			/>,
		);
		const input = screen.getByLabelText(
			"Choose folder",
		) as HTMLInputElement;
		await userEvent.upload(input, [
			pick("repo/CLAUDE.md", "# x"),
			pick("repo/tasks/a.md"),
		]);
		await waitFor(() =>
			expect(
				screen.getByText(
					/1 files, .* will be uploaded\. 1 files will be left out\./,
				),
			).toBeInTheDocument(),
		);
		expect(screen.getByText("default rule")).toBeInTheDocument();
		await userEvent.click(
			screen.getByRole("button", { name: /Upload 1 files/ }),
		);
		await waitFor(() => expect(onUploaded).toHaveBeenCalledWith("snap_1"));
		expect(uploadSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj_1",
				publishOnReady: true,
			}),
		);
	});

	it("warns that a credential file will be rejected, naming it, while leaving Upload enabled (R28)", async () => {
		render(
			<UploadFolderDialog
				projectId="proj_1"
				open
				onOpenChange={() => undefined}
				onUploaded={vi.fn()}
			/>,
		);
		await userEvent.upload(
			screen.getByLabelText("Choose folder") as HTMLInputElement,
			[pick("repo/CLAUDE.md", "# x"), pick("repo/.env", "PORT=3000")],
		);

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("1 files will be rejected");
		expect(alert).toHaveTextContent(".env");
		expect(screen.getByText("will be rejected")).toBeInTheDocument();
		// The server is the authority; a client-side guess must never be able
		// to block an upload the server would have accepted.
		expect(
			screen.getByRole("button", { name: /Upload 2 files/ }),
		).toBeEnabled();
	});

	it("clicking the visible 'Choose folder' button clicks the (sr-only, not display:none) file input", async () => {
		// The regression this guards: Chromium 124+ silently refuses to open
		// the OS folder picker for a programmatic `.click()` on an input
		// with `display: none` (`className="hidden"`); `sr-only` (visually
		// hidden, still in the layout/accessibility tree) does not have that
		// restriction. jsdom doesn't enforce the Chromium-specific block
		// either way, so this test can only prove the button-to-input WIRING
		// (that clicking the button calls `.click()` on the real input
		// element) and that the input is not `display:none` — actual
		// Chromium behavior needs a browser, per the review that raised
		// this.
		const clickSpy = vi.spyOn(HTMLInputElement.prototype, "click");
		render(
			<UploadFolderDialog
				projectId="proj_1"
				open
				onOpenChange={() => undefined}
				onUploaded={vi.fn()}
			/>,
		);
		const input = screen.getByLabelText("Choose folder");
		expect(input).not.toHaveClass("hidden");
		await userEvent.click(
			screen.getByRole("button", { name: "Choose folder" }),
		);
		expect(clickSpy).toHaveBeenCalled();
		clickSpy.mockRestore();
	});

	it("combines several folders and root files into one upload, and drops a removed source", async () => {
		const user = userEvent.setup();
		renderDialog();
		const folderInput = screen.getByLabelText(
			"Choose folder",
		) as HTMLInputElement;
		await user.upload(folderInput, [pick("repo/CLAUDE.md", "# x")]);
		await screen.findByRole("list", { name: "Added folders and files" });

		// A second folder keeps its name by default, so `.claude/agents/`
		// stays where `classifyPath` recognises it.
		await user.upload(folderInput, [pick(".claude/agents/a.md")]);
		await waitFor(() => expect(sourceChips()).toEqual(["repo", ".claude"]));
		expect(
			screen.getByRole("checkbox", { name: "Keep the .claude/ prefix" }),
		).toBeChecked();
		expect(
			screen.getByRole("checkbox", { name: "Keep the repo/ prefix" }),
		).not.toBeChecked();

		await user.upload(
			screen.getByLabelText("Choose files") as HTMLInputElement,
			[pickRoot("AGENTS.md", "# a")],
		);
		await waitFor(() =>
			expect(sourceChips()).toEqual(["repo", ".claude", "1 files"]),
		);
		expect(rowPaths()).toEqual([
			".claude/agents",
			"AGENTS.md",
			"CLAUDE.md",
		]);

		await user.click(screen.getByRole("button", { name: "Remove repo" }));
		await waitFor(() =>
			expect(sourceChips()).toEqual([".claude", "1 files"]),
		);
		expect(rowPaths()).toEqual([".claude/agents", "AGENTS.md"]);

		await user.click(
			screen.getByRole("button", { name: /Upload 2 files/ }),
		);
		await waitFor(() => expect(uploadSnapshot).toHaveBeenCalled());
		const call = uploadSnapshot.mock.calls[0]?.[0] as {
			entries: Array<{ path: string; kind: string }>;
		};
		expect(call.entries.map((e) => [e.path, e.kind])).toEqual([
			[".claude/agents/a.md", "AGENT"],
			["AGENTS.md", "INSTRUCTIONS"],
		]);
	});

	it("refuses an add that would put two files at one path, keeping the first pick", async () => {
		const user = userEvent.setup();
		renderDialog();
		const folderInput = screen.getByLabelText(
			"Choose folder",
		) as HTMLInputElement;
		await user.upload(folderInput, [
			pick("repo/CLAUDE.md", "# x"),
			pick("repo/docs/README.md"),
		]);
		await screen.findByRole("list", { name: "Added folders and files" });

		// Kept under its own name, `docs/readme.md` is the same file as the
		// first folder's `docs/README.md` on a case-insensitive filesystem.
		await user.upload(folderInput, [pick("docs/readme.md")]);
		expect(
			await screen.findByText(
				"Two added files would both be stored as docs/readme.md. Remove one, or change whether a folder keeps its name.",
			),
		).toBeInTheDocument();
		expect(sourceChips()).toEqual(["repo"]);
		expect(rowPaths()).toEqual(["CLAUDE.md", "docs"]);
		expect(
			screen.getByRole("button", { name: /Upload 2 files/ }),
		).toBeEnabled();
	});

	it("blocks an upload over the file limit, counting only the files that would be sent", async () => {
		const user = userEvent.setup();
		renderDialog();
		const folderInput = screen.getByLabelText(
			"Choose folder",
		) as HTMLInputElement;
		// Three kept plus two excluded: at the limit, because excluded files
		// are never sent and so never count.
		await user.upload(folderInput, [
			pick("repo/a.md"),
			pick("repo/b.md"),
			pick("repo/c.md"),
			pick("repo/node_modules/x/index.js"),
			pick("repo/node_modules/x/package.json"),
		]);
		const upload = await screen.findByRole("button", {
			name: /Upload 3 files/,
		});
		expect(upload).toBeEnabled();
		expect(
			screen.queryByText(/a version can hold/),
		).not.toBeInTheDocument();

		await user.upload(
			screen.getByLabelText("Choose files") as HTMLInputElement,
			[pickRoot("CLAUDE.md")],
		);
		expect(
			await screen.findByText(
				/4 files is more than the 3 a version can hold/,
			),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Upload 4 files/ }),
		).toBeDisabled();
	});

	it("blocks an upload over the byte limit, counting only the files that would be sent", async () => {
		const user = userEvent.setup();
		renderDialog();
		// 10 kept bytes plus 200 excluded ones: under the 64-byte limit,
		// because the excluded file is never sent.
		await user.upload(
			screen.getByLabelText("Choose folder") as HTMLInputElement,
			[
				pick("repo/a.md", "x".repeat(10)),
				pick("repo/node_modules/big.js", "x".repeat(200)),
			],
		);
		const upload = await screen.findByRole("button", {
			name: /Upload 1 files/,
		});
		expect(upload).toBeEnabled();
		expect(
			screen.queryByText(/a version can hold/),
		).not.toBeInTheDocument();

		await user.upload(
			screen.getByLabelText("Choose files") as HTMLInputElement,
			[pickRoot("CLAUDE.md", "x".repeat(60))],
		);
		expect(
			await screen.findByText(
				/70 B is more than the 64 B a version can hold/,
			),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Upload 2 files/ }),
		).toBeDisabled();
	});

	it("names the clash when one name would be both a file and a folder", async () => {
		const user = userEvent.setup();
		renderDialog();
		await user.upload(
			screen.getByLabelText("Choose files") as HTMLInputElement,
			[pickRoot("docs")],
		);
		await screen.findByRole("list", { name: "Added folders and files" });
		await user.upload(
			screen.getByLabelText("Choose folder") as HTMLInputElement,
			[pick("docs/a.md")],
		);
		expect(
			await screen.findByText(
				"docs is both a file and a folder (it would hold docs/a.md). Remove one, or change whether a folder keeps its name.",
			),
		).toBeInTheDocument();
		expect(sourceChips()).toEqual(["1 files"]);
	});

	// The visible buttons were disabled while settings loaded, but the
	// inputs they click were not: a keyboard or screen-reader user could
	// reach an input directly and pick against the wrong ignore rules.
	it("disables the file inputs, and keeps them out of the tab order, while settings load", () => {
		render(
			<UploadFolderDialog
				projectId="proj_1"
				open
				onOpenChange={() => undefined}
				onUploaded={vi.fn()}
				settingsReady={false}
			/>,
		);
		for (const label of ["Choose folder", "Choose files"]) {
			const input = screen.getByLabelText(label);
			expect(input).toBeDisabled();
			expect(input).toHaveAttribute("tabindex", "-1");
		}
	});

	// The dialog stays mounted while closed, so a pick still hashing when
	// the person closes it would otherwise land afterwards and greet them on
	// the next open with the folder they dismissed.
	it("discards a pick that finishes reading after the dialog was closed", async () => {
		const user = userEvent.setup();
		let finishRead: (buf: ArrayBuffer) => void = () => undefined;
		const slow = pick("repo/CLAUDE.md", "# x");
		Object.defineProperty(slow, "arrayBuffer", {
			value: () =>
				new Promise<ArrayBuffer>((resolve) => {
					finishRead = resolve;
				}),
		});
		const props = {
			projectId: "proj_1",
			onOpenChange: vi.fn(),
			onUploaded: vi.fn(),
		};
		const { rerender } = render(<UploadFolderDialog {...props} open />);

		await user.upload(
			screen.getByLabelText("Choose folder") as HTMLInputElement,
			[slow],
		);
		await user.click(screen.getByRole("button", { name: "Cancel" }));
		expect(props.onOpenChange).toHaveBeenCalledWith(false);
		rerender(<UploadFolderDialog {...props} open={false} />);

		await act(async () => {
			finishRead(new TextEncoder().encode("# x").buffer as ArrayBuffer);
			await new Promise((r) => setTimeout(r, 50));
		});
		rerender(<UploadFolderDialog {...props} open />);

		expect(
			screen.getByRole("button", { name: "Choose folder" }),
		).toBeEnabled();
		expect(
			screen.queryByRole("list", { name: "Added folders and files" }),
		).not.toBeInTheDocument();
		expect(
			screen.getByText(uploadDialogCopy.pickTitle),
		).toBeInTheDocument();
	});
});
