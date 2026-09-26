/**
 * The Coding Instructions configure dialog's folder browser (Fizzy #2725):
 *  - it lists the settled branch through `instructions.repositorySync.
 *    listTree`, debounced, and nothing without a repository and a branch;
 *  - it is a single-choice radio group: "Repository root" plus every
 *    folder, with files shown but never selectable;
 *  - the typed folder stays the only selection state: picking a row writes
 *    to it, and typing a listed folder (trimmed, trailing slashes stripped)
 *    selects that row;
 *  - search, and the loading, unsupported, empty, truncated, no-match,
 *    capped-search and error outcomes, mirror the Living Memory browser;
 *  - folder exclusions (Fizzy #2726): under the chosen folder, every row
 *    the sync would skip says so, and each folder's "Exclude" toggle stages
 *    `F/**` in the project's list, as the sync's own matcher decides.
 *
 * Like the sibling suites, this resolves the REAL `en.json` copy and throws
 * on a missing key.
 */
import en from "@repo/i18n/translations/en.json";
import { DEFAULT_IGNORE_GLOBS } from "@repo/instructions";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo, useState } from "react";
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
	return (key: string, values?: Record<string, unknown>) => {
		const raw = resolve(`${namespace}.${key}`);
		if (typeof raw !== "string") {
			throw new Error(`missing translation: ${namespace}.${key}`);
		}
		let out = raw;
		for (const [name, value] of Object.entries(values ?? {})) {
			out = out
				.replaceAll(`{${name}, number}`, String(value))
				.replaceAll(`{${name}}`, String(value));
		}
		return out;
	};
}

vi.mock("next-intl", () => ({
	useTranslations: (namespace: string) => makeT(namespace),
}));

const { listTreeMock, readIgnoreFileMock } = vi.hoisted(() => ({
	listTreeMock: vi.fn(),
	readIgnoreFileMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				repositorySync: {
					listTree: {
						queryOptions: (options: {
							input: unknown;
							[key: string]: unknown;
						}) => ({
							...options,
							queryKey: ["instructions-listTree", options.input],
							queryFn: () => listTreeMock(options.input),
						}),
					},
					readIgnoreFile: {
						queryOptions: (options: {
							input: unknown;
							[key: string]: unknown;
						}) => ({
							...options,
							queryKey: [
								"instructions-readIgnoreFile",
								options.input,
							],
							queryFn: () => readIgnoreFileMock(options.input),
						}),
					},
				},
			},
		},
	},
}));

import {
	type ExclusionEdits,
	NO_EXCLUSION_EDITS,
	stagedProjectGlobs,
	toggleExclusion,
} from "../../../lib/instructions-sync-exclusions";
import { InstructionsRepositorySyncTreeBrowser } from "../InstructionsRepositorySyncTreeBrowser";

const copy = en.projects.codingInstructions.repositorySync;

const TREE = {
	supported: true,
	truncated: false,
	entries: [
		{ path: "agents", type: "dir" },
		{ path: "agents/CLAUDE.md", type: "file" },
		{ path: "agents/skills", type: "dir" },
		{ path: "agents/skills/review.md", type: "file" },
		{ path: "tools", type: "dir" },
		{ path: "tools/claude", type: "dir" },
		{ path: "AGENTS.md", type: "file" },
	],
};

/**
 * The browser beside a folder input bound to the same state, as the dialog
 * wires them: the input is the only selection state.
 */
function Harness({
	initialRootPath = "",
	initialBranch = "main",
	integrationId = "int_1",
	onSelect = () => {},
}: {
	initialRootPath?: string;
	initialBranch?: string;
	integrationId?: string;
	onSelect?: (path: string) => void;
}) {
	const [rootPath, setRootPath] = useState(initialRootPath);
	const [branch, setBranch] = useState(initialBranch);
	return (
		<>
			<label htmlFor="branch">Branch</label>
			<input
				id="branch"
				value={branch}
				onChange={(e) => setBranch(e.target.value)}
			/>
			<InstructionsRepositorySyncTreeBrowser
				projectId="proj_1"
				repositoryIntegrationId={integrationId}
				branch={branch.trim()}
				rootPath={rootPath}
				disabled={false}
				onSelect={(path) => {
					onSelect(path);
					setRootPath(path);
				}}
			/>
			<label htmlFor="root">Folder</label>
			<input
				id="root"
				value={rootPath}
				onChange={(e) => setRootPath(e.target.value)}
			/>
		</>
	);
}

function renderHarness(props: Parameters<typeof Harness>[0] = {}) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<Harness {...props} />
		</QueryClientProvider>,
	);
}

function group() {
	return screen.getByRole("radiogroup", { name: copy.tree.label });
}

async function renderTree(
	props: Parameters<typeof Harness>[0] = {},
	listing: unknown = TREE,
) {
	listTreeMock.mockResolvedValue(listing);
	const result = renderHarness(props);
	await screen.findByRole("radiogroup", { name: copy.tree.label });
	return result;
}

function radio(name: string) {
	return within(group()).getByRole("radio", { name });
}

function radioNames(): string[] {
	return within(group())
		.getAllByRole("radio")
		.map((r) => r.getAttribute("aria-label") ?? "");
}

beforeEach(() => {
	listTreeMock.mockReset();
	readIgnoreFileMock.mockReset();
});

describe("InstructionsRepositorySyncTreeBrowser — query", () => {
	it("lists nothing until the branch has settled, then the settled branch once", async () => {
		listTreeMock.mockResolvedValue(TREE);
		const user = userEvent.setup();
		renderHarness({ initialBranch: "" });
		await new Promise((r) => setTimeout(r, 600));
		expect(listTreeMock).not.toHaveBeenCalled();

		await user.type(screen.getByLabelText("Branch"), "develop");
		await waitFor(
			() =>
				expect(listTreeMock).toHaveBeenCalledWith({
					projectId: "proj_1",
					repositoryIntegrationId: "int_1",
					ref: "develop",
				}),
			{ timeout: 2000 },
		);
		// Debounced: no request for a partial branch name.
		expect(listTreeMock).toHaveBeenCalledTimes(1);
	});

	it("renders nothing and lists nothing without a repository", async () => {
		renderHarness({ integrationId: "" });
		await new Promise((r) => setTimeout(r, 600));
		expect(listTreeMock).not.toHaveBeenCalled();
		expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
	});

	it("says it is loading while the listing is in flight", async () => {
		listTreeMock.mockReturnValue(new Promise(() => {}));
		renderHarness();
		expect(await screen.findByText(copy.tree.loading)).toBeInTheDocument();
	});
});

describe("InstructionsRepositorySyncTreeBrowser — selection", () => {
	it("offers the repository root and every folder as radios, never a file", async () => {
		await renderTree();
		// Root folders open, deeper ones closed: `agents/skills` is shown,
		// its file is not.
		expect(radioNames()).toEqual([
			copy.tree.repositoryRoot,
			"agents",
			"agents/skills",
			"tools",
			"tools/claude",
		]);
		expect(within(group()).getByText("CLAUDE.md")).toBeInTheDocument();
		expect(within(group()).getByText("AGENTS.md")).toBeInTheDocument();
		expect(
			within(group()).queryByRole("radio", { name: "AGENTS.md" }),
		).not.toBeInTheDocument();
		expect(
			within(group()).queryByRole("radio", {
				name: "agents/CLAUDE.md",
			}),
		).not.toBeInTheDocument();
	});

	it("selects the repository root while the folder is empty", async () => {
		await renderTree();
		expect(radio(copy.tree.repositoryRoot)).toBeChecked();
		expect(radio("agents")).not.toBeChecked();
	});

	it("writes a picked folder to the input, and the root back as empty", async () => {
		const onSelect = vi.fn();
		const user = userEvent.setup();
		await renderTree({ onSelect });

		await user.click(radio("tools/claude"));
		expect(screen.getByLabelText("Folder")).toHaveValue("tools/claude");
		expect(radio("tools/claude")).toBeChecked();
		expect(radio(copy.tree.repositoryRoot)).not.toBeChecked();

		await user.click(radio(copy.tree.repositoryRoot));
		expect(screen.getByLabelText("Folder")).toHaveValue("");
		expect(onSelect).toHaveBeenLastCalledWith("");
	});

	it("picks a folder by its name's label too", async () => {
		const user = userEvent.setup();
		await renderTree();
		await user.click(within(group()).getByText("claude"));
		expect(screen.getByLabelText("Folder")).toHaveValue("tools/claude");
	});

	it("selects the row a typed folder names, trimmed and without trailing slashes", async () => {
		const user = userEvent.setup();
		await renderTree();
		const input = screen.getByLabelText("Folder");

		await user.type(input, "  agents/  ");
		expect(radio("agents")).toBeChecked();
		expect(radio(copy.tree.repositoryRoot)).not.toBeChecked();

		// A folder the tree does not list selects nothing.
		await user.clear(input);
		await user.type(input, "elsewhere");
		for (const r of within(group()).getAllByRole("radio")) {
			expect(r).not.toBeChecked();
		}
	});

	it("selects the row for any spelling configure stores as that folder", async () => {
		const user = userEvent.setup();
		await renderTree();
		const input = screen.getByLabelText("Folder");

		for (const typed of [
			"tools\\claude\\",
			"./tools/claude",
			"tools//claude",
		]) {
			await user.clear(input);
			await user.type(input, typed);
			expect(input).toHaveValue(typed);
			expect(radio("tools/claude")).toBeChecked();
		}
	});

	it("opens the folders on the way to the folder it opened with", async () => {
		await renderTree(
			{ initialRootPath: "agents/skills/nested" },
			{
				...TREE,
				entries: [
					...TREE.entries,
					{ path: "agents/skills/nested", type: "dir" },
				],
			},
		);
		expect(radio("agents/skills/nested")).toBeChecked();
	});

	it("reveals a folder's children when it is expanded, with aria-expanded on its toggle", async () => {
		const user = userEvent.setup();
		await renderTree();
		const toggle = within(group()).getByRole("button", { name: "skills" });
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(
			within(group()).queryByText("review.md"),
		).not.toBeInTheDocument();

		await user.click(toggle);
		expect(toggle).toHaveAttribute("aria-expanded", "true");
		expect(within(group()).getByText("review.md")).toBeInTheDocument();
	});
});

describe("InstructionsRepositorySyncTreeBrowser — search", () => {
	it("shows only matches with their ancestor folders, and restores the tree when cleared", async () => {
		const user = userEvent.setup();
		await renderTree();
		const search = screen.getByRole("searchbox", {
			name: copy.tree.searchPlaceholder,
		});

		await user.type(search, "review");
		expect(radioNames()).toEqual([
			copy.tree.repositoryRoot,
			"agents",
			"agents/skills",
		]);
		expect(within(group()).getByText("review.md")).toBeInTheDocument();

		await user.type(search, "-nothing");
		expect(screen.getByText(copy.tree.noMatches)).toBeInTheDocument();
		// The root stays choosable whatever the search.
		expect(radio(copy.tree.repositoryRoot)).toBeInTheDocument();

		await user.clear(search);
		expect(radioNames()).toContain("tools/claude");
	});

	it("caps the matches at 200 and asks for a narrower search", async () => {
		const user = userEvent.setup();
		const many = Array.from({ length: 250 }, (_, i) => ({
			path: `notes/folder-${String(i).padStart(3, "0")}`,
			type: "dir",
		}));
		await renderTree(
			{},
			{
				supported: true,
				truncated: false,
				entries: [{ path: "notes", type: "dir" }, ...many],
			},
		);
		await user.type(
			screen.getByRole("searchbox", {
				name: copy.tree.searchPlaceholder,
			}),
			"folder-",
		);
		expect(
			screen.getByText(copy.tree.refineSearch.replace("{max}", "200")),
		).toBeInTheDocument();
		// 200 matches, their one ancestor folder, and the root.
		expect(radioNames()).toHaveLength(202);
	});
});

describe("InstructionsRepositorySyncTreeBrowser — outcomes", () => {
	it("says a provider without a listing can't be browsed, and the typed folder still works", async () => {
		listTreeMock.mockResolvedValue({
			supported: false,
			entries: [],
			truncated: false,
		});
		const user = userEvent.setup();
		renderHarness();
		expect(
			await screen.findByText(copy.tree.unsupported),
		).toBeInTheDocument();
		expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
		expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();

		await user.type(screen.getByLabelText("Folder"), "agents");
		expect(screen.getByLabelText("Folder")).toHaveValue("agents");
	});

	it("says the branch has no files when the listing is empty", async () => {
		listTreeMock.mockResolvedValue({
			supported: true,
			entries: [],
			truncated: false,
		});
		renderHarness();
		expect(await screen.findByText(copy.tree.empty)).toBeInTheDocument();
		expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
	});

	it("says only the first entries are shown when the listing is truncated", async () => {
		await renderTree({}, { ...TREE, truncated: true });
		expect(
			screen.getByText(
				copy.tree.truncated.replace("{max, number}", "20000"),
			),
		).toBeInTheDocument();
	});

	it("shows a listing refusal with configure's copy for the same code", async () => {
		listTreeMock.mockRejectedValue(
			Object.assign(new Error("server message"), {
				data: { code: "BRANCH_NOT_FOUND" },
			}),
		);
		renderHarness({ initialBranch: "develop" });
		expect(await screen.findByRole("alert")).toHaveTextContent(
			copy.configureDialog.errors.BRANCH_NOT_FOUND.replace(
				"{ref}",
				"develop",
			),
		);
	});

	it("words an unreachable repository as configure does", async () => {
		listTreeMock.mockRejectedValue(
			Object.assign(new Error("server message"), {
				data: { code: "REPOSITORY_UNREACHABLE" },
			}),
		);
		renderHarness();
		expect(await screen.findByRole("alert")).toHaveTextContent(
			copy.configureDialog.errors.REPOSITORY_UNREACHABLE,
		);
	});

	it("falls back to the tree's own message, not the save failure, for an unmapped error", async () => {
		listTreeMock.mockRejectedValue(new Error("network down"));
		renderHarness();
		expect(await screen.findByRole("alert")).toHaveTextContent(
			copy.tree.error,
		);
	});
});

describe("InstructionsRepositorySyncTreeBrowser — folder exclusions (Fizzy #2726)", () => {
	const ex = copy.tree.exclusions;

	const EXCLUSION_TREE = {
		supported: true,
		truncated: false,
		entries: [
			{ path: "agents", type: "dir" },
			{ path: "agents/CLAUDE.md", type: "file" },
			{ path: "agents/notes.jsonl", type: "file" },
			{ path: "agents/node_modules", type: "dir" },
			{ path: "agents/node_modules/pkg.js", type: "file" },
			{ path: "agents/skills", type: "dir" },
			{ path: "agents/skills/review.md", type: "file" },
			{ path: "agents/skills/deep", type: "dir" },
			{ path: "tools", type: "dir" },
			{ path: "tools/claude", type: "dir" },
			{ path: "AGENTS.md", type: "file" },
		],
	};

	/**
	 * The browser with exclusions, holding the staged edits as the dialog
	 * does, and showing the staged project list so a test can read what
	 * Save would write.
	 */
	function ExclusionHarness({
		saved,
		initialRootPath,
		settingsFailed = false,
	}: {
		saved: readonly string[] | null;
		initialRootPath: string;
		settingsFailed?: boolean;
	}) {
		const [rootPath, setRootPath] = useState(initialRootPath);
		const [edits, setEdits] = useState<ExclusionEdits>(NO_EXCLUSION_EDITS);
		const staged = useMemo(
			() =>
				settingsFailed ? undefined : stagedProjectGlobs(saved, edits),
			[saved, edits, settingsFailed],
		);
		return (
			<>
				<InstructionsRepositorySyncTreeBrowser
					projectId="proj_1"
					repositoryIntegrationId="int_1"
					branch="main"
					rootPath={rootPath}
					disabled={false}
					onSelect={setRootPath}
					exclusions={{
						projectGlobs: staged,
						settingsFailed,
						onToggle: (pattern, exclude) =>
							setEdits((prev) =>
								toggleExclusion(prev, pattern, exclude),
							),
					}}
				/>
				<label htmlFor="root">Folder</label>
				<input
					id="root"
					value={rootPath}
					onChange={(e) => setRootPath(e.target.value)}
				/>
				<output data-testid="staged">
					{staged === undefined ? "unloaded" : JSON.stringify(staged)}
				</output>
			</>
		);
	}

	async function renderExclusions(
		props: Partial<Parameters<typeof ExclusionHarness>[0]> = {},
		listing: unknown = EXCLUSION_TREE,
	) {
		listTreeMock.mockResolvedValue(listing);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<ExclusionHarness
					saved={props.saved ?? null}
					initialRootPath={props.initialRootPath ?? "agents"}
					settingsFailed={props.settingsFailed}
				/>
			</QueryClientProvider>,
		);
		await screen.findByRole("radiogroup", { name: copy.tree.label });
	}

	function toggleFor(path: string) {
		return screen.getByRole("checkbox", {
			name: ex.toggleLabel.replace("{path}", path),
		});
	}

	function staged(): unknown {
		const text = screen.getByTestId("staged").textContent ?? "";
		return text === "unloaded" ? text : JSON.parse(text);
	}

	function rowOf(name: string): HTMLElement {
		const label = within(group()).getByText(name, {
			selector: "label, span",
		});
		const row = label.closest("div, li");
		if (!row) {
			throw new Error(`no row for ${name}`);
		}
		return row as HTMLElement;
	}

	it("offers an Exclude toggle for each folder under the chosen folder, none for the chosen folder itself or outside it", async () => {
		await renderExclusions();
		const names = screen
			.getAllByRole("checkbox")
			.map((c) => c.getAttribute("aria-label"));
		expect(names).toEqual([
			ex.toggleLabel.replace("{path}", "agents/node_modules"),
			ex.toggleLabel.replace("{path}", "agents/skills"),
		]);
		expect(screen.getByText(ex.hint)).toBeInTheDocument();
		expect(readIgnoreFileMock).not.toHaveBeenCalled();
	});

	it("stages F/** relative to the chosen folder, seeded with the defaults for a project with no rules, and shows it excluded", async () => {
		const user = userEvent.setup();
		await renderExclusions({ saved: null });
		expect(staged()).toBeNull();

		await user.click(toggleFor("agents/skills"));

		expect(toggleFor("agents/skills")).toBeChecked();
		expect(toggleFor("agents/skills")).toBeEnabled();
		expect(staged()).toEqual([...DEFAULT_IGNORE_GLOBS, "skills/**"]);
		expect(
			within(rowOf("skills")).getByText(ex.excluded),
		).toBeInTheDocument();
	});

	it("marks everything inside an excluded folder excluded by that folder, its toggles disabled", async () => {
		const user = userEvent.setup();
		await renderExclusions({ saved: ["skills/**"] });
		await user.click(
			within(group()).getByRole("button", { name: "skills" }),
		);

		const deep = toggleFor("agents/skills/deep");
		expect(deep).toBeDisabled();
		expect(deep).toBeChecked();
		expect(deep).toHaveAccessibleDescription(
			ex.cause.ancestor.replace("{path}", "agents/skills"),
		);
		expect(
			within(rowOf("review.md")).getByText(ex.excluded),
		).toBeInTheDocument();
	});

	it("removes exactly the folder's own rule when it is turned off, compared as the matcher compares", async () => {
		const user = userEvent.setup();
		await renderExclusions({ saved: ["dist/**", "Skills/**"] });
		expect(toggleFor("agents/skills")).toBeChecked();

		await user.click(toggleFor("agents/skills"));

		expect(toggleFor("agents/skills")).not.toBeChecked();
		expect(staged()).toEqual(["dist/**"]);
		expect(within(rowOf("skills")).queryByText(ex.excluded)).toBeNull();
	});

	it("puts a project with no rules back to none when an exclusion is staged and then turned off", async () => {
		const user = userEvent.setup();
		await renderExclusions({ saved: null });
		await user.click(toggleFor("agents/skills"));
		await user.click(toggleFor("agents/skills"));
		expect(staged()).toBeNull();
	});

	it("shows a folder another rule skips as excluded, naming the rule, with its toggle disabled", async () => {
		await renderExclusions({ saved: null });
		const toggle = toggleFor("agents/node_modules");
		expect(toggle).toBeDisabled();
		expect(toggle).toBeChecked();
		expect(toggle).toHaveAccessibleDescription(
			ex.cause.default.replace("{rule}", "**/node_modules/**"),
		);
		expect(
			within(rowOf("node_modules")).getByText(ex.excluded),
		).toBeInTheDocument();
	});

	it("shows files the sync would skip as excluded, in words", async () => {
		await renderExclusions({ saved: null });
		expect(
			within(rowOf("notes.jsonl")).getByText(ex.excluded),
		).toBeInTheDocument();
		expect(within(rowOf("CLAUDE.md")).queryByText(ex.excluded)).toBeNull();
	});

	it("shows a symbolic link as skipped because it is not a regular file, never as synced, with no toggle", async () => {
		await renderExclusions(
			// No rule of the project's matches either link.
			{ saved: [] },
			{
				...EXCLUSION_TREE,
				entries: [
					...EXCLUSION_TREE.entries,
					{ path: "agents/linked.md", type: "file", regular: false },
					// A link to a folder is a blob in git: listed as a file.
					{ path: "agents/linked-dir", type: "file", regular: false },
				],
			},
		);

		for (const name of ["linked.md", "linked-dir"]) {
			const row = rowOf(name);
			expect(within(row).getByText(ex.excluded)).toBeInTheDocument();
			expect(
				within(row).getByText(ex.cause.notRegular),
			).toBeInTheDocument();
			expect(within(row).queryByRole("checkbox")).toBeNull();
			expect(within(row).queryByRole("radio")).toBeNull();
		}
		// A regular file beside them is synced.
		expect(within(rowOf("CLAUDE.md")).queryByText(ex.excluded)).toBeNull();
		expect(
			screen.queryByRole("checkbox", {
				name: ex.toggleLabel.replace("{path}", "agents/linked-dir"),
			}),
		).toBeNull();
	});

	it("disables the toggle of a folder whose path contains * or ?, saying why", async () => {
		await renderExclusions(
			{ saved: [] },
			{
				...EXCLUSION_TREE,
				entries: [
					...EXCLUSION_TREE.entries,
					{ path: "agents/wild*card", type: "dir" },
				],
			},
		);
		const toggle = toggleFor("agents/wild*card");
		expect(toggle).toBeDisabled();
		expect(toggle).toHaveAccessibleDescription(ex.block.wildcard);
	});

	it("disables every new exclusion once the project's list is full, saying so", async () => {
		const full = Array.from({ length: 200 }, (_, i) => `r${i}/**`);
		await renderExclusions({ saved: full });
		const message = ex.block.full.replace("{max, number}", "200");
		expect(screen.getByText(message)).toBeInTheDocument();
		expect(toggleFor("agents/skills")).toBeDisabled();
		expect(toggleFor("agents/skills")).toHaveAccessibleDescription(message);
	});

	it("follows the chosen folder: patterns and toggles are relative to it", async () => {
		const user = userEvent.setup();
		await renderExclusions({ initialRootPath: "" });
		expect(toggleFor("agents")).toBeEnabled();
		expect(toggleFor("tools/claude")).toBeEnabled();

		await user.click(toggleFor("agents/skills"));
		expect(staged()).toEqual([...DEFAULT_IGNORE_GLOBS, "agents/skills/**"]);
	});

	describe("the chosen folder's .fabricignore", () => {
		const WITH_IGNORE_FILE = {
			...EXCLUSION_TREE,
			entries: [
				...EXCLUSION_TREE.entries,
				{ path: "agents/.fabricignore", type: "file" },
				{ path: "agents/drafts", type: "dir" },
			],
		};

		it("reads it when the listing has it, and with rules it replaces the project's: every toggle disabled, its exclusions shown", async () => {
			readIgnoreFileMock.mockResolvedValue({
				supported: true,
				state: "rules",
				rules: ["drafts/"],
			});
			await renderExclusions({ saved: ["skills/**"] }, WITH_IGNORE_FILE);

			expect(
				await screen.findByText(ex.fabricignore),
			).toBeInTheDocument();
			expect(readIgnoreFileMock).toHaveBeenCalledWith({
				projectId: "proj_1",
				repositoryIntegrationId: "int_1",
				ref: "main",
				rootPath: "agents",
			});
			for (const toggle of screen.getAllByRole("checkbox")) {
				expect(toggle).toBeDisabled();
			}
			expect(toggleFor("agents/skills")).toHaveAccessibleDescription(
				ex.fabricignore,
			);
			// The file's rule applies; the project's does not. A skipped
			// folder's toggle says both why it is skipped and why it is
			// locked.
			expect(toggleFor("agents/drafts")).toBeChecked();
			expect(toggleFor("agents/drafts")).toHaveAccessibleDescription(
				`${ex.cause.fabricignore.replace("{rule}", "drafts/")} ${ex.fabricignore}`,
			);
			expect(
				within(rowOf("drafts")).getByText(ex.excluded),
			).toBeInTheDocument();
			expect(toggleFor("agents/skills")).not.toBeChecked();
			expect(within(rowOf("skills")).queryByText(ex.excluded)).toBeNull();
		});

		it("keeps the project's rules and the toggles when the file has no rules", async () => {
			readIgnoreFileMock.mockResolvedValue({
				supported: true,
				state: "rules",
				rules: [],
			});
			await renderExclusions({ saved: ["skills/**"] }, WITH_IGNORE_FILE);

			await waitFor(() =>
				expect(toggleFor("agents/drafts")).toBeEnabled(),
			);
			expect(toggleFor("agents/skills")).toBeChecked();
			expect(toggleFor("agents/skills")).toBeEnabled();
			expect(screen.queryByText(ex.fabricignore)).not.toBeInTheDocument();
		});

		it("says a file over the sync's limit is ignored, and keeps the project's rules", async () => {
			readIgnoreFileMock.mockResolvedValue({
				supported: true,
				state: "tooLarge",
				rules: [],
			});
			await renderExclusions({ saved: ["skills/**"] }, WITH_IGNORE_FILE);

			expect(
				await screen.findByText(ex.ignoreFileTooLarge),
			).toBeInTheDocument();
			expect(toggleFor("agents/skills")).toBeChecked();
			expect(toggleFor("agents/skills")).toBeEnabled();
		});

		it("shows a failed read, disables every toggle, and shows no exclusions rather than the project's", async () => {
			readIgnoreFileMock.mockRejectedValue(new Error("network down"));
			await renderExclusions({ saved: ["skills/**"] }, WITH_IGNORE_FILE);

			expect(await screen.findByRole("alert")).toHaveTextContent(
				ex.ignoreFileError,
			);
			for (const toggle of screen.getAllByRole("checkbox")) {
				expect(toggle).toBeDisabled();
				expect(toggle).toHaveAccessibleDescription(ex.ignoreFileError);
			}
			expect(within(group()).queryByText(ex.excluded)).toBeNull();
		});

		it("disables the toggles while the file is being read", async () => {
			readIgnoreFileMock.mockReturnValue(new Promise(() => {}));
			await renderExclusions({ saved: null }, WITH_IGNORE_FILE);

			expect(
				await screen.findByText(ex.ignoreFileLoading),
			).toBeInTheDocument();
			for (const toggle of screen.getAllByRole("checkbox")) {
				expect(toggle).toBeDisabled();
			}
		});

		it("does not read a .fabricignore that is a symbolic link: the sync has no such file", async () => {
			await renderExclusions(
				{ saved: null },
				{
					...EXCLUSION_TREE,
					entries: [
						...EXCLUSION_TREE.entries,
						{
							path: "agents/.fabricignore",
							type: "file",
							regular: false,
						},
					],
				},
			);
			expect(toggleFor("agents/skills")).toBeEnabled();
			expect(readIgnoreFileMock).not.toHaveBeenCalled();
			expect(
				within(rowOf(".fabricignore")).getByText(ex.cause.notRegular),
			).toBeInTheDocument();
		});

		it("reads only the chosen folder's own file, not one elsewhere", async () => {
			await renderExclusions(
				{ initialRootPath: "tools" },
				WITH_IGNORE_FILE,
			);
			expect(toggleFor("tools/claude")).toBeEnabled();
			expect(readIgnoreFileMock).not.toHaveBeenCalled();
		});

		it("reads the repository root's file for the repository root", async () => {
			readIgnoreFileMock.mockResolvedValue({
				supported: true,
				state: "absent",
				rules: [],
			});
			await renderExclusions(
				{ initialRootPath: "" },
				{
					...EXCLUSION_TREE,
					entries: [
						...EXCLUSION_TREE.entries,
						{ path: ".fabricignore", type: "file" },
					],
				},
			);
			await waitFor(() =>
				expect(readIgnoreFileMock).toHaveBeenCalledWith(
					expect.objectContaining({ rootPath: "" }),
				),
			);
		});

		it("reads it from a truncated listing that may have stopped before it", async () => {
			readIgnoreFileMock.mockResolvedValue({
				supported: true,
				state: "absent",
				rules: [],
			});
			await renderExclusions({}, { ...EXCLUSION_TREE, truncated: true });
			await waitFor(() =>
				expect(readIgnoreFileMock).toHaveBeenCalledWith(
					expect.objectContaining({ rootPath: "agents" }),
				),
			);
			await waitFor(() =>
				expect(toggleFor("agents/skills")).toBeEnabled(),
			);
		});
	});

	it("offers no exclusions while the project's rules could not be loaded, and says so", async () => {
		await renderExclusions({ settingsFailed: true });
		expect(screen.getByRole("alert")).toHaveTextContent(ex.settingsError);
		expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
	});

	it("offers no exclusions without the dialog's exclusions, as before", async () => {
		await renderTree();
		expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
		expect(screen.queryByText(ex.hint)).not.toBeInTheDocument();
	});
});
