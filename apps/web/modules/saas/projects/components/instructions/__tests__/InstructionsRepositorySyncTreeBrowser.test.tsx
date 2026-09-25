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
 *    capped-search and error outcomes, mirror the Living Memory browser.
 *
 * Like the sibling suites, this resolves the REAL `en.json` copy and throws
 * on a missing key.
 */
import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
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

const { listTreeMock } = vi.hoisted(() => ({ listTreeMock: vi.fn() }));

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
				},
			},
		},
	},
}));

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
