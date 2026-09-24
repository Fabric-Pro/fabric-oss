/**
 * The Living Memory repository-sync configure dialog (design 2026-09-23
 * §5.1, §7.2, Fizzy #2657):
 *  - the integration select renders only when more than one ACTIVE
 *    integration exists, and the branch input seeds from the chosen
 *    integration's defaultBranch;
 *  - the paths chips editor validates each addition client-side, mirroring
 *    the server's `paths.ts` rules, with inline errors;
 *  - submit calls `configure` then `syncNow`;
 *  - a server error code renders inline, and `configure`'s
 *    `REPOSITORY_CHANGE_REQUIRES_DISCONNECT` names the repository change it
 *    refuses;
 *  - "Keep in sync automatically" (design §11.1, Fizzy #2673) is ticked for
 *    a first configure and sent, is seeded from the stored value when
 *    changing one, and is sent then only when the member touched it —
 *    omitted, the server keeps the stored value.
 *  - the tree browser (Fizzy #2674) lists the branch through `listTree`,
 *    writes to the same chips as the typed input, disables what the chip
 *    validation would refuse, searches, and degrades to typed paths.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		class ResizeObserverPolyfill {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		}
		(
			globalThis as unknown as {
				ResizeObserver: typeof ResizeObserverPolyfill;
			}
		).ResizeObserver = ResizeObserverPolyfill;
	}
	if (typeof Element.prototype.hasPointerCapture === "undefined") {
		Element.prototype.hasPointerCapture = () => false;
	}
	if (typeof Element.prototype.scrollIntoView === "undefined") {
		Element.prototype.scrollIntoView = () => undefined;
	}
});

const { configureMock, syncNowMock, listTreeMock } = vi.hoisted(() => ({
	configureMock: vi.fn(),
	syncNowMock: vi.fn(),
	listTreeMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			contexts: {
				repositorySync: {
					configure: {
						mutationOptions: () => ({
							mutationFn: (input: unknown) =>
								configureMock(input),
						}),
					},
					syncNow: {
						mutationOptions: () => ({
							mutationFn: (input: unknown) => syncNowMock(input),
						}),
					},
					listTree: {
						queryOptions: (options: {
							input: unknown;
							[key: string]: unknown;
						}) => ({
							...options,
							queryKey: ["listTree", options.input],
							queryFn: () => listTreeMock(options.input),
						}),
					},
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("next-intl", () => {
	function makeT(namespace: string) {
		const t = (key: string, values?: Record<string, unknown>) =>
			values
				? `${namespace}.${key}${JSON.stringify(values)}`
				: `${namespace}.${key}`;
		return t;
	}
	return {
		useTranslations: (namespace: string) => makeT(namespace),
	};
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const EMPTY_TREE = { supported: true, entries: [], truncated: false };

beforeEach(() => {
	listTreeMock.mockReset();
	listTreeMock.mockResolvedValue(EMPTY_TREE);
});

import { toast } from "sonner";
import { ConfigureContextRepositorySyncDialog } from "../ConfigureContextRepositorySyncDialog";

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

const NS = "projects.contexts.livingMemory.repositorySync";

const ONE_INTEGRATION = [
	{
		id: "int_1",
		provider: "GITHUB",
		repositoryOwner: "example-org",
		repositoryName: "memory",
		defaultBranch: "main",
		status: "ACTIVE",
	},
];

const TWO_INTEGRATIONS = [
	...ONE_INTEGRATION,
	{
		id: "int_2",
		provider: "GITLAB",
		repositoryOwner: "example-org",
		repositoryName: "other",
		defaultBranch: "trunk",
		status: "ACTIVE",
	},
];

function renderDialog(
	overrides: Partial<
		React.ComponentProps<typeof ConfigureContextRepositorySyncDialog>
	> = {},
) {
	const onOpenChange = vi.fn();
	const onSaved = vi.fn();
	wrap(
		<ConfigureContextRepositorySyncDialog
			projectId="proj_1"
			organizationId="org_1"
			open={true}
			onOpenChange={onOpenChange}
			integrations={ONE_INTEGRATION}
			current={null}
			onSaved={onSaved}
			{...overrides}
		/>,
	);
	return { onOpenChange, onSaved };
}

async function addPath(user: ReturnType<typeof userEvent.setup>, path: string) {
	const input = screen.getByLabelText(`${NS}.configureDialog.pathsLabel`);
	await user.clear(input);
	if (path !== "") {
		await user.type(input, path);
	}
	await user.click(screen.getByText(`${NS}.configureDialog.addPath`));
}

describe("ConfigureContextRepositorySyncDialog — integration select", () => {
	beforeEach(() => {
		configureMock.mockReset();
		syncNowMock.mockReset();
	});

	it("hides the select and shows the single repository as text when only one integration is ACTIVE", () => {
		renderDialog({ integrations: ONE_INTEGRATION });
		expect(
			screen.queryByLabelText(`${NS}.configureDialog.repositoryLabel`),
		).not.toBeInTheDocument();
		expect(screen.getByText("example-org/memory")).toBeInTheDocument();
	});

	it("shows the select when more than one integration is ACTIVE, and seeds the branch from the chosen one", async () => {
		const user = userEvent.setup();
		renderDialog({ integrations: TWO_INTEGRATIONS });
		const select = screen.getByLabelText(
			`${NS}.configureDialog.repositoryLabel`,
		) as HTMLSelectElement;
		expect(select).toBeInTheDocument();
		expect(
			(
				screen.getByLabelText(
					`${NS}.configureDialog.branchLabel`,
				) as HTMLInputElement
			).value,
		).toBe("main");

		await user.selectOptions(select, "int_2");
		expect(
			(
				screen.getByLabelText(
					`${NS}.configureDialog.branchLabel`,
				) as HTMLInputElement
			).value,
		).toBe("trunk");
	});

	it("never offers an integration that isn't ACTIVE", () => {
		renderDialog({
			integrations: [
				...TWO_INTEGRATIONS,
				{
					id: "int_3",
					provider: "GITHUB",
					repositoryOwner: "example-org",
					repositoryName: "revoked",
					defaultBranch: "main",
					status: "REVOKED",
				},
			],
		});
		expect(screen.queryByText(/revoked/)).not.toBeInTheDocument();
	});
});

describe("ConfigureContextRepositorySyncDialog — paths chips validation", () => {
	beforeEach(() => {
		configureMock.mockReset();
		syncNowMock.mockReset();
	});

	it("adds a valid path as a chip and clears the input", async () => {
		const user = userEvent.setup();
		renderDialog();
		await addPath(user, "docs/guides");
		const chips = screen.getByTestId("context-sync-paths-chips");
		expect(within(chips).getByText("docs/guides")).toBeInTheDocument();
		expect(
			(
				screen.getByLabelText(
					`${NS}.configureDialog.pathsLabel`,
				) as HTMLInputElement
			).value,
		).toBe("");
	});

	it("removes a chip via its remove button", async () => {
		const user = userEvent.setup();
		renderDialog();
		await addPath(user, "docs");
		const chips = screen.getByTestId("context-sync-paths-chips");
		await user.click(
			within(chips).getByLabelText(
				`${NS}.configureDialog.removePath${JSON.stringify({ path: "docs" })}`,
			),
		);
		expect(within(chips).queryByText("docs")).not.toBeInTheDocument();
	});

	it("rejects a trailing slash inline, without adding a chip", async () => {
		const user = userEvent.setup();
		renderDialog();
		await addPath(user, "docs/");
		expect(
			screen.getByText(
				`${NS}.pathErrors.INVALID_PATH${JSON.stringify({ path: "docs/" })}`,
			),
		).toBeInTheDocument();
		expect(
			within(screen.getByTestId("context-sync-paths-chips")).queryByText(
				"docs/",
			),
		).not.toBeInTheDocument();
	});

	it("rejects a backslash inline", async () => {
		const user = userEvent.setup();
		renderDialog();
		await addPath(user, "docs\\guides");
		expect(
			screen.getByText(
				`${NS}.pathErrors.INVALID_PATH${JSON.stringify({ path: "docs\\guides" })}`,
			),
		).toBeInTheDocument();
	});

	it("rejects an excluded basename (CLAUDE.md), case-insensitively", async () => {
		const user = userEvent.setup();
		renderDialog();
		await addPath(user, "docs/claude.md");
		expect(
			screen.getByText(
				`${NS}.pathErrors.EXCLUDED_PATH${JSON.stringify({ path: "docs/claude.md" })}`,
			),
		).toBeInTheDocument();
	});

	it("rejects a path that overlaps one already selected", async () => {
		const user = userEvent.setup();
		renderDialog();
		await addPath(user, "docs");
		await addPath(user, "docs/guides");
		expect(
			screen.getByText(
				`${NS}.pathErrors.PATH_PREFIX_OVERLAP${JSON.stringify({
					path: "docs/guides",
					withPath: "docs",
				})}`,
			),
		).toBeInTheDocument();
		const chips = screen.getByTestId("context-sync-paths-chips");
		expect(
			within(chips).queryByText("docs/guides"),
		).not.toBeInTheDocument();
	});

	it("only allows the whole-repository selection alone", async () => {
		const user = userEvent.setup();
		renderDialog();
		await addPath(user, "docs");
		await addPath(user, "");
		expect(
			screen.getByText(
				`${NS}.pathErrors.PATH_PREFIX_OVERLAP${JSON.stringify({
					path: "",
					withPath: "docs",
				})}`,
			),
		).toBeInTheDocument();
	});

	it("keeps Save disabled until at least one path is selected", async () => {
		const user = userEvent.setup();
		renderDialog();
		const submit = screen.getByText(`${NS}.configureDialog.submit`);
		expect(submit.closest("button")).toBeDisabled();
		await addPath(user, "docs");
		expect(submit.closest("button")).toBeEnabled();
	});
});

describe("ConfigureContextRepositorySyncDialog — submit", () => {
	beforeEach(() => {
		configureMock.mockReset();
		syncNowMock.mockReset();
	});

	it("calls configure then syncNow, then reports success and closes", async () => {
		configureMock.mockResolvedValue({ syncId: "sync_1", generation: 1 });
		syncNowMock.mockResolvedValue({ started: true });
		const user = userEvent.setup();
		const { onOpenChange, onSaved } = renderDialog();

		await addPath(user, "docs");
		await user.click(screen.getByText(`${NS}.configureDialog.submit`));

		await waitFor(() =>
			expect(configureMock).toHaveBeenCalledWith({
				projectId: "proj_1",
				organizationId: "org_1",
				repositoryIntegrationId: "int_1",
				ref: "main",
				paths: ["docs"],
				automatic: true,
			}),
		);
		await waitFor(() =>
			expect(syncNowMock).toHaveBeenCalledWith({
				projectId: "proj_1",
				organizationId: "org_1",
			}),
		);
		await waitFor(() => expect(onSaved).toHaveBeenCalled());
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(toast.success).toHaveBeenCalledWith(
			`${NS}.syncNowResult.started`,
		);
	});

	it("renders a server error code inline, attached to the branch field, and does not start syncNow", async () => {
		configureMock.mockRejectedValue({
			message: "server message",
			data: { code: "BRANCH_NOT_FOUND" },
		});
		const user = userEvent.setup();
		renderDialog();
		await addPath(user, "docs");
		await user.click(screen.getByText(`${NS}.configureDialog.submit`));

		expect(
			await screen.findByText(
				`${NS}.configureDialog.errors.BRANCH_NOT_FOUND${JSON.stringify({
					path: "",
					withPath: "",
					managedCount: 0,
				})}`,
			),
		).toBeInTheDocument();
		expect(
			screen.getByLabelText(`${NS}.configureDialog.branchLabel`),
		).toHaveAttribute("aria-invalid", "true");
		expect(syncNowMock).not.toHaveBeenCalled();
	});

	it("names the disconnect-first requirement for REPOSITORY_CHANGE_REQUIRES_DISCONNECT", async () => {
		configureMock.mockRejectedValue({
			message: "server message",
			data: {
				code: "REPOSITORY_CHANGE_REQUIRES_DISCONNECT",
				managedCount: 5,
			},
		});
		const user = userEvent.setup();
		renderDialog();
		await addPath(user, "docs");
		await user.click(screen.getByText(`${NS}.configureDialog.submit`));

		expect(
			await screen.findByText(
				`${NS}.configureDialog.errors.REPOSITORY_CHANGE_REQUIRES_DISCONNECT${JSON.stringify(
					{ path: "", withPath: "", managedCount: 5 },
				)}`,
			),
		).toBeInTheDocument();
		expect(syncNowMock).not.toHaveBeenCalled();
	});
});

const CURRENT = {
	syncId: "sync_1",
	repositoryIntegrationId: "int_1",
	ref: "release",
	paths: ["docs"],
	automatic: false,
	automaticPausedReason: null,
	automaticPausedAt: null,
	nextCheckAt: "2026-09-23T10:00:00.000Z",
	failureCount: 0,
	lastAppliedCommitSha: null,
	configuredByName: "Example Member",
	createdAt: "2026-09-23T09:00:00.000Z",
	updatedAt: "2026-09-23T09:00:00.000Z",
	integration: {
		provider: "GITHUB",
		repositoryOwner: "example-org",
		repositoryName: "memory",
		status: "ACTIVE",
	},
};

function automaticCheckbox() {
	return screen.getByRole("checkbox", {
		name: `${NS}.configureDialog.automaticLabel`,
	});
}

describe("ConfigureContextRepositorySyncDialog — Keep in sync automatically", () => {
	beforeEach(() => {
		configureMock.mockReset();
		syncNowMock.mockReset();
		configureMock.mockResolvedValue({ syncId: "sync_1", generation: 2 });
		syncNowMock.mockResolvedValue({ started: true });
	});

	it("is ticked for a first configure and says whom automatic syncs run as", () => {
		renderDialog();
		expect(automaticCheckbox()).toBeChecked();
		expect(automaticCheckbox()).toHaveAttribute(
			"aria-describedby",
			"context-sync-automatic-hint",
		);
		expect(
			screen.getByText(`${NS}.configureDialog.automaticHint`),
		).toHaveAttribute("id", "context-sync-automatic-hint");
	});

	it("sends automatic: false when the member unticks it on a first configure", async () => {
		const user = userEvent.setup();
		const { onOpenChange } = renderDialog();
		await addPath(user, "docs");
		await user.click(automaticCheckbox());
		await user.click(screen.getByText(`${NS}.configureDialog.submit`));
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(configureMock).toHaveBeenCalledWith(
			expect.objectContaining({ automatic: false }),
		);
	});

	it("seeds from the stored value when changing a configuration", () => {
		renderDialog({ current: CURRENT });
		expect(automaticCheckbox()).not.toBeChecked();
	});

	it("seeds a stored on as ticked", () => {
		renderDialog({ current: { ...CURRENT, automatic: true } });
		expect(automaticCheckbox()).toBeChecked();
	});

	it("omits automatic from configure when changing a configuration without touching it", async () => {
		const user = userEvent.setup();
		const { onOpenChange } = renderDialog({
			current: { ...CURRENT, automatic: true },
		});
		await user.click(screen.getByText(`${NS}.configureDialog.submit`));
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(configureMock).toHaveBeenCalledTimes(1);
		expect(configureMock.mock.calls[0]?.[0]).toEqual({
			projectId: "proj_1",
			organizationId: "org_1",
			repositoryIntegrationId: "int_1",
			ref: "release",
			paths: ["docs"],
		});
		expect(configureMock.mock.calls[0]?.[0]).not.toHaveProperty(
			"automatic",
		);
	});

	it("sends the new value when changing a configuration after touching it", async () => {
		const user = userEvent.setup();
		const { onOpenChange } = renderDialog({ current: CURRENT });
		await user.click(automaticCheckbox());
		await user.click(screen.getByText(`${NS}.configureDialog.submit`));
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(configureMock).toHaveBeenCalledWith(
			expect.objectContaining({ automatic: true }),
		);
	});
});

// ── Tree browser (Fizzy #2674) ─────────────────────────────────────────────

/** Provider order, deliberately unsorted; `src` is only implied by its file. */
const TREE = {
	supported: true,
	truncated: false,
	entries: [
		{ path: "README.md", type: "file" },
		{ path: "docs", type: "dir" },
		{ path: "docs/guide.md", type: "file" },
		{ path: "docs/api", type: "dir" },
		{ path: "docs/api/ref.md", type: "file" },
		{ path: "src/index.ts", type: "file" },
		{ path: "assets", type: "dir" },
	],
};

function treeList() {
	return screen.getByRole("list", { name: `${NS}.tree.label` });
}

function visibleTreePaths(): string[] {
	return within(treeList())
		.getAllByRole("checkbox")
		.map((box) => box.getAttribute("aria-label") ?? "");
}

function treeCheckbox(path: string) {
	return within(treeList()).getByRole("checkbox", { name: path });
}

function chips() {
	return screen.getByTestId("context-sync-paths-chips");
}

async function renderTree(
	overrides: Parameters<typeof renderDialog>[0] = {},
	listing: unknown = TREE,
) {
	listTreeMock.mockResolvedValue(listing);
	const handles = renderDialog(overrides);
	await screen.findByRole("list", { name: `${NS}.tree.label` });
	return handles;
}

function configuration(paths: string[]) {
	return {
		syncId: "sync_1",
		repositoryIntegrationId: "int_1",
		ref: "main",
		paths,
		lastAppliedCommitSha: null,
		configuredByName: null,
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-01T00:00:00.000Z",
		integration: {
			provider: "GITHUB",
			repositoryOwner: "example-org",
			repositoryName: "memory",
			status: "ACTIVE",
		},
	};
}

describe("ConfigureContextRepositorySyncDialog — tree query", () => {
	beforeEach(() => {
		configureMock.mockReset();
		syncNowMock.mockReset();
	});

	it("does not list anything until both the repository and the branch are set, then lists the settled branch once", async () => {
		const user = userEvent.setup();
		renderDialog({
			integrations: [{ ...ONE_INTEGRATION[0], defaultBranch: "" }],
		});
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(listTreeMock).not.toHaveBeenCalled();

		await user.type(
			screen.getByLabelText(`${NS}.configureDialog.branchLabel`),
			"develop",
		);
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

	it("does not list anything without an ACTIVE repository", async () => {
		renderDialog({ integrations: [] });
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(listTreeMock).not.toHaveBeenCalled();
	});
});

describe("ConfigureContextRepositorySyncDialog — tree browsing", () => {
	beforeEach(() => {
		configureMock.mockReset();
		syncNowMock.mockReset();
	});

	it("puts folders first, each group sorted, with root folders open and deeper ones closed", async () => {
		await renderTree();
		expect(visibleTreePaths()).toEqual([
			"assets",
			"docs",
			"docs/api",
			"docs/guide.md",
			"src",
			"src/index.ts",
			"README.md",
		]);
		expect(
			within(treeList()).getByRole("button", { name: "docs" }),
		).toHaveAttribute("aria-expanded", "true");
		expect(
			within(treeList()).getByRole("button", { name: "api" }),
		).toHaveAttribute("aria-expanded", "false");
	});

	it("reveals a folder's children when it is expanded", async () => {
		const user = userEvent.setup();
		await renderTree();
		await user.click(
			within(treeList()).getByRole("button", { name: "api" }),
		);
		expect(treeCheckbox("docs/api/ref.md")).toBeInTheDocument();
		expect(
			within(treeList()).getByRole("button", { name: "api" }),
		).toHaveAttribute("aria-expanded", "true");
	});

	it("names every checkbox by its full path and gives every folder toggle aria-expanded", async () => {
		await renderTree();
		for (const box of within(treeList()).getAllByRole("checkbox")) {
			expect(box).toHaveAccessibleName(
				box.getAttribute("aria-label") ?? "",
			);
		}
		expect(visibleTreePaths()).toContain("docs/guide.md");
		for (const name of ["assets", "docs", "api", "src"]) {
			expect(
				within(treeList()).getByRole("button", { name }),
			).toHaveAttribute("aria-expanded");
		}
	});
});

describe("ConfigureContextRepositorySyncDialog — tree selection", () => {
	beforeEach(() => {
		configureMock.mockReset();
		syncNowMock.mockReset();
	});

	it("checking a folder adds its chip and covers its descendants; unchecking removes the chip", async () => {
		const user = userEvent.setup();
		await renderTree();
		await user.click(treeCheckbox("docs"));

		expect(within(chips()).getByText("docs")).toBeInTheDocument();
		expect(treeCheckbox("docs")).toBeChecked();
		expect(treeCheckbox("docs/guide.md")).toBeDisabled();
		expect(treeCheckbox("docs/guide.md")).not.toBeChecked();
		expect(treeCheckbox("docs/api")).toBeDisabled();
		expect(
			screen.getAllByText(`${NS}.tree.coveredByParent`).length,
		).toBeGreaterThan(0);

		await user.click(treeCheckbox("docs"));
		expect(within(chips()).queryByText("docs")).not.toBeInTheDocument();
		expect(treeCheckbox("docs/guide.md")).toBeEnabled();
	});

	it("checking a file adds its chip", async () => {
		const user = userEvent.setup();
		await renderTree();
		await user.click(treeCheckbox("README.md"));
		expect(within(chips()).getByText("README.md")).toBeInTheDocument();
		expect(treeCheckbox("README.md")).toBeChecked();
	});

	it("removing a folder's chip unchecks it and re-enables its descendants", async () => {
		const user = userEvent.setup();
		await renderTree();
		await user.click(treeCheckbox("docs"));
		expect(treeCheckbox("docs/guide.md")).toBeDisabled();

		await user.click(
			within(chips()).getByLabelText(
				`${NS}.configureDialog.removePath${JSON.stringify({ path: "docs" })}`,
			),
		);
		expect(treeCheckbox("docs")).not.toBeChecked();
		expect(treeCheckbox("docs/guide.md")).toBeEnabled();
		expect(
			screen.queryByText(`${NS}.tree.coveredByParent`),
		).not.toBeInTheDocument();
	});

	it("disables a folder while a path inside it is selected, and says why", async () => {
		const user = userEvent.setup();
		await renderTree();
		await user.click(treeCheckbox("docs/guide.md"));

		expect(treeCheckbox("docs")).toBeDisabled();
		expect(treeCheckbox("docs")).not.toBeChecked();
		expect(
			screen.getByText(`${NS}.tree.containsSelected`),
		).toBeInTheDocument();
		expect(within(chips()).queryByText("docs")).not.toBeInTheDocument();
	});

	it("still rejects an overlapping typed path after a tree selection", async () => {
		const user = userEvent.setup();
		await renderTree();
		await user.click(treeCheckbox("docs"));
		await addPath(user, "docs/guides");
		expect(
			screen.getByText(
				`${NS}.pathErrors.PATH_PREFIX_OVERLAP${JSON.stringify({
					path: "docs/guides",
					withPath: "docs",
				})}`,
			),
		).toBeInTheDocument();
	});

	it("shows the cap message and leaves the box unchecked when 50 paths are already selected", async () => {
		const user = userEvent.setup();
		const fifty = Array.from({ length: 50 }, (_, i) => `selected-${i}`);
		await renderTree({ current: configuration(fifty) });

		await user.click(treeCheckbox("README.md"));
		expect(
			screen.getByText(
				`${NS}.pathErrors.TOO_MANY_PATHS${JSON.stringify({ max: 50 })}`,
			),
		).toBeInTheDocument();
		expect(treeCheckbox("README.md")).not.toBeChecked();
		expect(
			within(chips()).queryByText("README.md"),
		).not.toBeInTheDocument();

		await addPath(user, "notes.md");
		expect(
			screen.getByText(
				`${NS}.pathErrors.TOO_MANY_PATHS${JSON.stringify({ max: 50 })}`,
			),
		).toBeInTheDocument();
	});

	it("disables the whole tree while the whole repository is selected", async () => {
		const user = userEvent.setup();
		await renderTree();
		await addPath(user, "");
		expect(
			screen.getByText(`${NS}.tree.wholeRepository`),
		).toBeInTheDocument();
		for (const box of within(treeList()).getAllByRole("checkbox")) {
			expect(box).toBeDisabled();
		}
	});

	it("submits the same paths whether they came from the tree or the input", async () => {
		configureMock.mockResolvedValue({ syncId: "sync_1", generation: 1 });
		syncNowMock.mockResolvedValue({ started: true });
		const user = userEvent.setup();
		await renderTree();

		await user.click(treeCheckbox("README.md"));
		await addPath(user, "docs");
		await user.click(screen.getByText(`${NS}.configureDialog.submit`));

		await waitFor(() =>
			expect(configureMock).toHaveBeenCalledWith({
				projectId: "proj_1",
				organizationId: "org_1",
				repositoryIntegrationId: "int_1",
				ref: "main",
				paths: ["README.md", "docs"],
				// A first configure always sends the automatic checkbox, ticked
				// by default (Fizzy #2673).
				automatic: true,
			}),
		);
		// The typed "docs" is the tree's "docs": its row reads as checked.
		expect(treeCheckbox("docs")).toBeChecked();
	});
});

describe("ConfigureContextRepositorySyncDialog — tree search", () => {
	beforeEach(() => {
		configureMock.mockReset();
		syncNowMock.mockReset();
	});

	function searchBox() {
		return screen.getByRole("searchbox", {
			name: `${NS}.tree.searchPlaceholder`,
		});
	}

	it("shows only matches with their ancestor folders, expanded, and restores the tree when cleared", async () => {
		const user = userEvent.setup();
		await renderTree();
		// Collapse a root folder first: clearing the search must restore it.
		await user.click(
			within(treeList()).getByRole("button", { name: "src" }),
		);
		expect(visibleTreePaths()).not.toContain("src/index.ts");

		await user.type(searchBox(), "REF");
		expect(visibleTreePaths()).toEqual([
			"docs",
			"docs/api",
			"docs/api/ref.md",
		]);
		expect(
			within(treeList()).getByRole("button", { name: "api" }),
		).toHaveAttribute("aria-expanded", "true");

		await user.clear(searchBox());
		expect(visibleTreePaths()).toEqual([
			"assets",
			"docs",
			"docs/api",
			"docs/guide.md",
			"src",
			"README.md",
		]);
		expect(
			within(treeList()).getByRole("button", { name: "api" }),
		).toHaveAttribute("aria-expanded", "false");
	});

	it("caps the matches at 200 and asks for a narrower search", async () => {
		const user = userEvent.setup();
		const entries = Array.from({ length: 201 }, (_, i) => ({
			path: `notes/note-${String(i).padStart(3, "0")}.md`,
			type: "file",
		}));
		await renderTree({}, { supported: true, truncated: false, entries });
		expect(
			screen.queryByText(
				`${NS}.tree.refineSearch${JSON.stringify({ max: 200 })}`,
			),
		).not.toBeInTheDocument();

		await user.type(searchBox(), "note-");
		expect(
			screen.getByText(
				`${NS}.tree.refineSearch${JSON.stringify({ max: 200 })}`,
			),
		).toBeInTheDocument();
		// 200 files plus their one folder.
		expect(visibleTreePaths()).toHaveLength(201);
		expect(visibleTreePaths()).not.toContain("notes/note-200.md");
	});
});

describe("ConfigureContextRepositorySyncDialog — tree outcomes", () => {
	beforeEach(() => {
		configureMock.mockReset();
		syncNowMock.mockReset();
	});

	it("hides the tree for a provider without a listing and keeps the typed input", async () => {
		listTreeMock.mockResolvedValue({
			supported: false,
			entries: [],
			truncated: false,
		});
		const user = userEvent.setup();
		renderDialog();
		expect(
			await screen.findByText(`${NS}.tree.unsupported`),
		).toBeInTheDocument();
		expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("list", { name: `${NS}.tree.label` }),
		).not.toBeInTheDocument();

		await addPath(user, "docs");
		expect(within(chips()).getByText("docs")).toBeInTheDocument();
	});

	it("says the branch has no files when the listing is empty", async () => {
		renderDialog();
		expect(await screen.findByText(`${NS}.tree.empty`)).toBeInTheDocument();
	});

	it("says only the first entries are shown when the listing is truncated", async () => {
		await renderTree({}, { ...TREE, truncated: true });
		expect(
			screen.getByText(
				`${NS}.tree.truncated${JSON.stringify({ max: 20_000 })}`,
			),
		).toBeInTheDocument();
	});

	it("shows a listing refusal inline with configure's copy, and typing still adds a path", async () => {
		listTreeMock.mockRejectedValue({
			message: "server message",
			data: { code: "BRANCH_NOT_FOUND" },
		});
		const user = userEvent.setup();
		renderDialog();
		expect(
			await screen.findByText(
				`${NS}.configureDialog.errors.BRANCH_NOT_FOUND${JSON.stringify({
					path: "main",
					withPath: "",
					managedCount: 0,
				})}`,
			),
		).toBeInTheDocument();

		await addPath(user, "docs");
		expect(within(chips()).getByText("docs")).toBeInTheDocument();
	});

	it("falls back to the tree's own message for an unreachable repository", async () => {
		listTreeMock.mockRejectedValue({
			message: "server message",
			data: { code: "REPOSITORY_UNREACHABLE" },
		});
		renderDialog();
		expect(await screen.findByText(`${NS}.tree.error`)).toBeInTheDocument();
	});
});
