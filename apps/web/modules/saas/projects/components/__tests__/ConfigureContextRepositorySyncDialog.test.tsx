/**
 * The Living Memory repository-sync configure dialog (design 2026-09-23
 * §5.1, §7.2, Fizzy #2657; selection Fizzy #2750 §5.7, §6):
 *  - the integration select renders only when more than one ACTIVE
 *    integration exists, and the branch input seeds from the chosen
 *    integration's defaultBranch;
 *  - what syncs is chosen in the shared selection tree over the branch's
 *    `listTree`: a tick selects a folder or file, an untick inside a ticked
 *    folder leaves it out, a partial folder shows a dash, and a row the run
 *    would never sync says why;
 *  - the typed "Add a path" input is offered only where the tree cannot
 *    reach (no listing, a truncated one, or a failed one), validates as the
 *    server does, and is the same transition as a tick;
 *  - Save waits until something is selected and says why; it calls
 *    `configure` with the paths and, always explicitly, `excludedPaths`,
 *    then `syncNow`;
 *  - a server error code renders inline, including the codes about what the
 *    member left out, and `REPOSITORY_CHANGE_REQUIRES_DISCONNECT` names the
 *    repository change it refuses;
 *  - "Keep in sync automatically" (design §11.1, Fizzy #2673) is ticked for
 *    a first configure and sent, is seeded from the stored value when
 *    changing one, and is sent then only when the member touched it —
 *    omitted, the server keeps the stored value.
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
	const input = screen.getByLabelText(
		`${NS}.configureDialog.typedPath.label`,
	);
	await user.clear(input);
	if (path !== "") {
		await user.type(input, path);
	}
	await user.click(
		screen.getByRole("button", {
			name: `${NS}.configureDialog.typedPath.add`,
		}),
	);
}

/** The "Syncs" list under the tree. */
function syncsList() {
	return screen.getByRole("list", {
		name: `${NS}.configureDialog.selectedPaths.label`,
	});
}

function saveButton() {
	return screen.getByRole("button", { name: `${NS}.configureDialog.submit` });
}

const UNSUPPORTED = { supported: false, entries: [], truncated: false };

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

describe("ConfigureContextRepositorySyncDialog — typed paths", () => {
	beforeEach(() => {
		configureMock.mockReset();
		syncNowMock.mockReset();
		listTreeMock.mockResolvedValue(UNSUPPORTED);
	});

	async function renderTyped(
		overrides: Parameters<typeof renderDialog>[0] = {},
	) {
		const handles = renderDialog(overrides);
		await screen.findByLabelText(`${NS}.configureDialog.typedPath.label`);
		return handles;
	}

	it("adds a valid path to what syncs and clears the input", async () => {
		const user = userEvent.setup();
		await renderTyped();
		await addPath(user, "docs/guides");
		expect(
			within(syncsList()).getByText("docs/guides"),
		).toBeInTheDocument();
		expect(
			(
				screen.getByLabelText(
					`${NS}.configureDialog.typedPath.label`,
				) as HTMLInputElement
			).value,
		).toBe("");
	});

	it("removes a path via its remove button", async () => {
		const user = userEvent.setup();
		await renderTyped();
		await addPath(user, "docs");
		await user.click(
			within(syncsList()).getByRole("button", {
				name: `${NS}.configureDialog.selectedPaths.remove${JSON.stringify({ path: "docs" })}`,
			}),
		);
		expect(
			screen.queryByRole("list", {
				name: `${NS}.configureDialog.selectedPaths.label`,
			}),
		).not.toBeInTheDocument();
	});

	it("rejects a trailing slash inline, tied to the input, without adding it", async () => {
		const user = userEvent.setup();
		await renderTyped();
		await addPath(user, "docs/");
		const error = screen.getByText(
			`${NS}.pathErrors.INVALID_PATH${JSON.stringify({ path: "docs/" })}`,
		);
		expect(error).toHaveAttribute("role", "alert");
		expect(
			screen.getByLabelText(`${NS}.configureDialog.typedPath.label`),
		).toHaveAccessibleDescription(error.textContent ?? "");
		expect(
			screen.queryByRole("list", {
				name: `${NS}.configureDialog.selectedPaths.label`,
			}),
		).not.toBeInTheDocument();
	});

	it("rejects a backslash inline", async () => {
		const user = userEvent.setup();
		await renderTyped();
		await addPath(user, "docs\\guides");
		expect(
			screen.getByText(
				`${NS}.pathErrors.INVALID_PATH${JSON.stringify({ path: "docs\\guides" })}`,
			),
		).toBeInTheDocument();
	});

	it("rejects a decomposed (NFD) spelling inline, as configure would", async () => {
		const user = userEvent.setup();
		await renderTyped();
		const decomposed = "docs/café.md";
		await addPath(user, decomposed);
		expect(
			screen.getByText(
				`${NS}.pathErrors.INVALID_PATH${JSON.stringify({ path: decomposed })}`,
			),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("list", {
				name: `${NS}.configureDialog.selectedPaths.label`,
			}),
		).not.toBeInTheDocument();
	});

	it("rejects a path longer than configure accepts inline", async () => {
		const user = userEvent.setup();
		await renderTyped();
		const long = `docs/${"x".repeat(1024)}`;
		await user.click(
			screen.getByLabelText(`${NS}.configureDialog.typedPath.label`),
		);
		await user.paste(long);
		await user.click(
			screen.getByRole("button", {
				name: `${NS}.configureDialog.typedPath.add`,
			}),
		);
		expect(
			screen.getByText(
				`${NS}.pathErrors.INVALID_PATH${JSON.stringify({ path: long })}`,
			),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("list", {
				name: `${NS}.configureDialog.selectedPaths.label`,
			}),
		).not.toBeInTheDocument();
	});

	it("rejects an excluded basename (CLAUDE.md), case-insensitively", async () => {
		const user = userEvent.setup();
		await renderTyped();
		await addPath(user, "docs/claude.md");
		expect(
			screen.getByText(
				`${NS}.pathErrors.EXCLUDED_PATH${JSON.stringify({ path: "docs/claude.md" })}`,
			),
		).toBeInTheDocument();
	});

	it("rejects a path inside one already selected", async () => {
		const user = userEvent.setup();
		await renderTyped();
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
		expect(
			within(syncsList()).queryByText("docs/guides"),
		).not.toBeInTheDocument();
	});

	it("absorbs the selected paths inside a typed folder, as ticking a partial folder does", async () => {
		const user = userEvent.setup();
		await renderTyped();
		await addPath(user, "docs/guides");
		await addPath(user, "docs/api");
		await addPath(user, "docs");
		expect(
			within(syncsList())
				.getAllByRole("listitem")
				.map((item) => item.textContent),
		).toEqual(["docs"]);
	});

	it("says what to do when nothing is typed, and names the whole repository when a path is inside it", async () => {
		const user = userEvent.setup();
		await renderTyped();
		await addPath(user, "");
		expect(
			screen.getByText(`${NS}.configureDialog.typedPath.empty`),
		).toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: `${NS}.tree.selectAll` }),
		);
		await addPath(user, "docs");
		expect(
			screen.getByText(
				`${NS}.pathErrors.INSIDE_WHOLE_REPOSITORY${JSON.stringify({ path: "docs" })}`,
			),
		).toBeInTheDocument();
	});

	it("checks the 50-path cap after absorbing", async () => {
		const user = userEvent.setup();
		const fifty = Array.from({ length: 50 }, (_, i) => `docs/p${i}`);
		await renderTyped({ current: configuration(fifty) });
		await addPath(user, "notes.md");
		expect(
			screen.getByText(
				`${NS}.pathErrors.TOO_MANY_PATHS${JSON.stringify({ max: 50 })}`,
			),
		).toBeInTheDocument();
		await addPath(user, "docs");
		expect(
			within(syncsList())
				.getAllByRole("listitem")
				.map((item) => item.textContent),
		).toEqual(["docs"]);
	});

	it("keeps Save disabled until something is selected, pointing at the reason", async () => {
		const user = userEvent.setup();
		await renderTyped();
		expect(saveButton()).toBeDisabled();
		expect(saveButton()).toHaveAccessibleDescription(
			`${NS}.summary.nothingSelected`,
		);
		await addPath(user, "docs");
		expect(saveButton()).toBeEnabled();
		expect(saveButton()).not.toHaveAttribute("aria-describedby");
	});

	it("says why Save is disabled without a branch", async () => {
		const user = userEvent.setup();
		await renderTyped();
		await addPath(user, "docs");
		await user.clear(
			screen.getByLabelText(`${NS}.configureDialog.branchLabel`),
		);
		expect(saveButton()).toBeDisabled();
		expect(saveButton()).toHaveAccessibleDescription(
			`${NS}.configureDialog.saveBlocked.noBranch`,
		);
	});
});

describe("ConfigureContextRepositorySyncDialog — submit", () => {
	beforeEach(() => {
		configureMock.mockReset();
		syncNowMock.mockReset();
		listTreeMock.mockResolvedValue(UNSUPPORTED);
	});

	async function renderAndSelectDocs() {
		const user = userEvent.setup();
		const handles = renderDialog();
		await screen.findByLabelText(`${NS}.configureDialog.typedPath.label`);
		await addPath(user, "docs");
		return { user, ...handles };
	}

	it("calls configure with the paths and an explicit empty excludedPaths, then syncNow, then reports success and closes", async () => {
		configureMock.mockResolvedValue({ syncId: "sync_1", generation: 1 });
		syncNowMock.mockResolvedValue({ started: true });
		const { user, onOpenChange, onSaved } = await renderAndSelectDocs();
		await user.click(saveButton());

		await waitFor(() =>
			expect(configureMock).toHaveBeenCalledWith({
				projectId: "proj_1",
				organizationId: "org_1",
				repositoryIntegrationId: "int_1",
				ref: "main",
				paths: ["docs"],
				excludedPaths: [],
				automatic: true,
			}),
		);
		expect(configureMock.mock.calls[0]?.[0]).toHaveProperty(
			"excludedPaths",
			[],
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
		const { user } = await renderAndSelectDocs();
		await user.click(saveButton());

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

	it.each([
		["EXCLUDED_PATH_POLICY_FILE", { path: "docs/.contextignore" }],
		["TOO_MANY_EXCLUDED_PATHS", {}],
		["EXCLUDED_PATH_OUTSIDE_SELECTION", { path: "notes/old.md" }],
		[
			"EXCLUDED_PATH_OVERLAP",
			{ path: "docs/old/a.md", withPath: "docs/old" },
		],
		["EXCLUDED_PATHS_STALE", {}],
	] as const)(
		"renders %s inline with its path, tied to the paths field, and does not start syncNow (Fizzy #2750 §5.3)",
		async (code, data) => {
			configureMock.mockRejectedValue({
				message: "server message",
				data: { code, ...data },
			});
			const { user } = await renderAndSelectDocs();
			await user.click(saveButton());

			const error = await screen.findByText(
				`${NS}.configureDialog.errors.${code}${JSON.stringify({
					path: "path" in data ? data.path : "",
					withPath: "withPath" in data ? data.withPath : "",
					managedCount: 0,
				})}`,
			);
			expect(error).toHaveAttribute("role", "alert");
			expect(
				screen.getByLabelText(`${NS}.configureDialog.typedPath.label`),
			).toHaveAttribute("aria-invalid", "true");
			expect(syncNowMock).not.toHaveBeenCalled();
			expect(toast.error).not.toHaveBeenCalledWith(
				expect.stringContaining(code),
			);
		},
	);

	it("names the disconnect-first requirement for REPOSITORY_CHANGE_REQUIRES_DISCONNECT", async () => {
		configureMock.mockRejectedValue({
			message: "server message",
			data: {
				code: "REPOSITORY_CHANGE_REQUIRES_DISCONNECT",
				managedCount: 5,
			},
		});
		const { user } = await renderAndSelectDocs();
		await user.click(saveButton());

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
	excludedPaths: ["docs/old"],
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
		await user.click(
			screen.getByRole("button", { name: `${NS}.tree.selectAll` }),
		);
		await user.click(automaticCheckbox());
		await user.click(saveButton());
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
		// What is left out is always sent, unchanged here (Fizzy #2750 §5.2).
		expect(configureMock.mock.calls[0]?.[0]).toEqual({
			projectId: "proj_1",
			organizationId: "org_1",
			repositoryIntegrationId: "int_1",
			ref: "release",
			paths: ["docs"],
			excludedPaths: ["docs/old"],
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

// ── The selection tree (Fizzy #2674, #2750) ────────────────────────────────

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

async function renderTree(
	overrides: Parameters<typeof renderDialog>[0] = {},
	listing: unknown = TREE,
) {
	listTreeMock.mockResolvedValue(listing);
	const handles = renderDialog(overrides);
	await screen.findByRole("list", { name: `${NS}.tree.label` });
	return handles;
}

function configuration(paths: string[], excludedPaths: string[] = []) {
	return {
		syncId: "sync_1",
		repositoryIntegrationId: "int_1",
		ref: "main",
		paths,
		excludedPaths,
		automatic: false,
		automaticPausedReason: null,
		automaticPausedAt: null,
		nextCheckAt: null,
		failureCount: 0,
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

	it("starts with nothing ticked for a new configuration, and offers no typed input while the tree lists everything", async () => {
		await renderTree();
		for (const box of within(treeList()).getAllByRole("checkbox")) {
			expect(box).toHaveAttribute("aria-checked", "false");
		}
		expect(
			screen.getByText(`${NS}.summary.nothingSelected`),
		).toBeInTheDocument();
		expect(saveButton()).toBeDisabled();
		expect(
			screen.queryByLabelText(`${NS}.configureDialog.typedPath.label`),
		).not.toBeInTheDocument();
	});

	it("ticking a folder selects it, and everything inside it syncs and can be unticked", async () => {
		const user = userEvent.setup();
		await renderTree();
		await user.click(treeCheckbox("docs"));

		expect(treeCheckbox("docs")).toBeChecked();
		expect(treeCheckbox("docs/guide.md")).toBeChecked();
		expect(treeCheckbox("docs/guide.md")).toBeEnabled();
		expect(treeCheckbox("docs/api")).toBeChecked();
		expect(within(syncsList()).getByText("docs/")).toBeInTheDocument();
		expect(saveButton()).toBeEnabled();

		await user.click(treeCheckbox("docs"));
		expect(treeCheckbox("docs")).not.toBeChecked();
		expect(treeCheckbox("docs/guide.md")).not.toBeChecked();
	});

	it("unticking inside a ticked folder leaves it out, shows the folder as partial and lists the exception", async () => {
		const user = userEvent.setup();
		await renderTree();
		await user.click(treeCheckbox("docs"));
		await user.click(treeCheckbox("docs/guide.md"));

		expect(treeCheckbox("docs/guide.md")).not.toBeChecked();
		expect(treeCheckbox("docs")).toHaveAttribute("aria-checked", "mixed");
		expect(
			within(syncsList()).getByText(
				`${NS}.configureDialog.selectedPaths.except${JSON.stringify({ path: "docs/guide.md" })}`,
			),
		).toBeInTheDocument();

		// Ticking the partial folder clears what was left out inside it.
		await user.click(treeCheckbox("docs"));
		expect(treeCheckbox("docs")).toBeChecked();
		expect(treeCheckbox("docs/guide.md")).toBeChecked();
	});

	it("a left-out folder's contents say why they can't be ticked", async () => {
		const user = userEvent.setup();
		await renderTree();
		await user.click(treeCheckbox("docs"));
		await user.click(treeCheckbox("docs/api"));
		await user.click(
			within(treeList()).getByRole("button", { name: "api" }),
		);

		expect(treeCheckbox("docs/api/ref.md")).toBeDisabled();
		expect(treeCheckbox("docs/api/ref.md")).toHaveAccessibleDescription(
			`${NS}.tree.selection.leftOutBecause${JSON.stringify({ path: "docs/api" })}`,
		);
	});

	it("includes a left-out path again from the list", async () => {
		const user = userEvent.setup();
		await renderTree();
		await user.click(treeCheckbox("docs"));
		await user.click(treeCheckbox("docs/guide.md"));
		await user.click(
			within(syncsList()).getByRole("button", {
				name: `${NS}.configureDialog.selectedPaths.includeAgain${JSON.stringify({ path: "docs/guide.md" })}`,
			}),
		);
		expect(treeCheckbox("docs/guide.md")).toBeChecked();
		expect(treeCheckbox("docs")).toBeChecked();
	});

	it("ticking a file outside every selection selects it, and its folder reads partial until ticked", async () => {
		const user = userEvent.setup();
		await renderTree();
		await user.click(treeCheckbox("docs/guide.md"));
		expect(treeCheckbox("docs/guide.md")).toBeChecked();
		expect(treeCheckbox("docs")).toHaveAttribute("aria-checked", "mixed");
		expect(
			within(syncsList()).getByText("docs/guide.md"),
		).toBeInTheDocument();

		// Ticking the folder absorbs the file.
		await user.click(treeCheckbox("docs"));
		expect(
			within(syncsList())
				.getAllByRole("listitem")
				.map((item) => item.textContent),
		).toEqual(["docs/"]);
	});

	it("says why a row the run would never sync can't be ticked", async () => {
		const user = userEvent.setup();
		await renderTree(
			{},
			{
				supported: true,
				truncated: false,
				entries: [
					{ path: "docs", type: "dir" },
					{
						path: "docs/AGENTS.md",
						type: "file",
						selectRefusal: "EXCLUDED_PATH",
					},
					{ path: "docs/logo.png", type: "file" },
					{ path: "docs/link.md", type: "file", regular: false },
					{ path: "skills", type: "dir" },
					{ path: "skills/x.md", type: "file" },
				],
			},
		);
		expect(treeCheckbox("docs/AGENTS.md")).toHaveAccessibleDescription(
			`${NS}.tree.selection.codingInstructionsFile`,
		);
		expect(treeCheckbox("docs/logo.png")).toHaveAccessibleDescription(
			`${NS}.tree.selection.nonText`,
		);
		expect(treeCheckbox("docs/link.md")).toHaveAccessibleDescription(
			`${NS}.tree.selection.symlink`,
		);
		for (const path of [
			"docs/AGENTS.md",
			"docs/logo.png",
			"docs/link.md",
		]) {
			expect(treeCheckbox(path), path).toBeDisabled();
		}
		// Inside the ticked whole repository, `skills/` is a default rule.
		await user.click(
			screen.getByRole("button", { name: `${NS}.tree.selectAll` }),
		);
		expect(treeCheckbox("skills")).toBeDisabled();
		expect(treeCheckbox("skills")).toHaveAccessibleDescription(
			`${NS}.tree.selection.defaultRule${JSON.stringify({ rule: "skills/" })}`,
		);
	});

	it("disables a tick that would pass 50 selected paths, and says why", async () => {
		const fifty = Array.from({ length: 50 }, (_, i) => `selected-${i}`);
		await renderTree({ current: configuration(fifty) });
		expect(treeCheckbox("README.md")).toBeDisabled();
		expect(treeCheckbox("README.md")).toHaveAccessibleDescription(
			`${NS}.tree.selection.tooManyPaths${JSON.stringify({ max: 50 })}`,
		);
	});

	it("Select all syncs the whole repository; Select none clears it", async () => {
		const user = userEvent.setup();
		await renderTree();
		await user.click(
			screen.getByRole("button", { name: `${NS}.tree.selectAll` }),
		);
		expect(
			within(syncsList()).getByText(
				`${NS}.configureDialog.selectedPaths.wholeRepository`,
			),
		).toBeInTheDocument();
		expect(treeCheckbox("docs")).toBeChecked();
		expect(treeCheckbox("README.md")).toBeChecked();
		await user.click(
			screen.getByRole("button", { name: `${NS}.tree.selectNone` }),
		);
		expect(
			screen.getByText(`${NS}.summary.nothingSelected`),
		).toBeInTheDocument();
		expect(saveButton()).toBeDisabled();
	});

	it("summarizes what syncs with a live count that never promises", async () => {
		const user = userEvent.setup();
		await renderTree();
		await user.click(treeCheckbox("docs"));
		await user.click(treeCheckbox("docs/guide.md"));
		expect(
			screen.getByText(
				`${NS}.summary.leadExcept${JSON.stringify({
					excluded: 1,
					what: `${NS}.summary.what.folders${JSON.stringify({ folders: 1 })}`,
				})}`,
			),
		).toBeInTheDocument();
		// docs/api/ref.md is the one listed file left.
		expect(
			screen.getByText(
				`${NS}.summary.matchNow${JSON.stringify({ count: 1 })}`,
			),
		).toBeInTheDocument();
	});

	it("opens the way to a stored selection and shows what it leaves out", async () => {
		await renderTree({
			current: configuration(["docs"], ["docs/api/ref.md"]),
		});
		expect(treeCheckbox("docs")).toHaveAttribute("aria-checked", "mixed");
		expect(treeCheckbox("docs/api")).toHaveAttribute(
			"aria-checked",
			"mixed",
		);
		expect(treeCheckbox("docs/api/ref.md")).not.toBeChecked();
		expect(treeCheckbox("docs/guide.md")).toBeChecked();
	});

	it("submits the paths and what is left out, whatever chose them", async () => {
		configureMock.mockResolvedValue({ syncId: "sync_1", generation: 1 });
		syncNowMock.mockResolvedValue({ started: true });
		const user = userEvent.setup();
		await renderTree();

		await user.click(treeCheckbox("README.md"));
		await user.click(treeCheckbox("docs"));
		await user.click(treeCheckbox("docs/api"));
		await user.click(saveButton());

		await waitFor(() =>
			expect(configureMock).toHaveBeenCalledWith({
				projectId: "proj_1",
				organizationId: "org_1",
				repositoryIntegrationId: "int_1",
				ref: "main",
				paths: ["README.md", "docs"],
				excludedPaths: ["docs/api"],
				// A first configure always sends the automatic checkbox, ticked
				// by default (Fizzy #2673).
				automatic: true,
			}),
		);
	});

	it("clearing every exclusion sends an explicit empty list", async () => {
		configureMock.mockResolvedValue({ syncId: "sync_1", generation: 2 });
		syncNowMock.mockResolvedValue({ started: true });
		const user = userEvent.setup();
		await renderTree({ current: configuration(["docs"], ["docs/api"]) });
		await user.click(treeCheckbox("docs"));
		await user.click(saveButton());
		await waitFor(() => expect(configureMock).toHaveBeenCalledTimes(1));
		expect(configureMock.mock.calls[0]?.[0]).toMatchObject({
			paths: ["docs"],
			excludedPaths: [],
		});
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
		expect(within(syncsList()).getByText("docs")).toBeInTheDocument();
	});

	it("says the branch has no files when the listing is empty", async () => {
		renderDialog();
		expect(await screen.findByText(`${NS}.tree.empty`)).toBeInTheDocument();
	});

	it("says only the first entries are shown when the listing is truncated, and offers the typed input", async () => {
		const user = userEvent.setup();
		await renderTree({}, { ...TREE, truncated: true });
		expect(
			screen.getByText(
				`${NS}.tree.truncated${JSON.stringify({ max: 20_000 })}`,
			),
		).toBeInTheDocument();
		// A path beyond the listing, typed: the same selection the tree shows.
		await addPath(user, "notes/today.md");
		expect(
			within(syncsList()).getByText("notes/today.md"),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				`${NS}.summary.matchTruncated${JSON.stringify({ count: 0 })}`,
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
		expect(within(syncsList()).getByText("docs")).toBeInTheDocument();
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
