/**
 * The repository-sync pieces of the Coding Instructions tab (design
 * 2026-09-23 §7.2-§7.4). Like the sibling suites, this resolves the REAL
 * `en.json` copy and throws on a missing key, so a component that asks for a
 * key nobody wrote fails here rather than rendering the key.
 */
import en from "@repo/i18n/translations/en.json";
import { DEFAULT_IGNORE_GLOBS } from "@repo/instructions";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	RepositorySyncState,
	SyncRunView,
} from "../../../lib/instructions-repository-sync";

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
}));

const m = vi.hoisted(() => ({
	configure: vi.fn(),
	updateProposalSettings: vi.fn(),
	syncNow: vi.fn(),
	disable: vi.fn(),
	listRuns: vi.fn(),
	listTree: vi.fn(),
	readIgnoreFile: vi.fn(),
	getSettings: vi.fn(),
	updateSettings: vi.fn(),
	toastSuccess: vi.fn(),
	toastInfo: vi.fn(),
	toastError: vi.fn(),
	// The app's confirmation dialog is mounted once in the (saas) layout and
	// is absent here: this records what an action asked and, by default,
	// confirms, as pressing the dialog's button would.
	confirm: vi.fn(),
}));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({
		confirm: (...a: unknown[]) => m.confirm(...a),
	}),
}));

vi.mock("sonner", () => ({
	toast: {
		success: (...a: unknown[]) => m.toastSuccess(...a),
		info: (...a: unknown[]) => m.toastInfo(...a),
		error: (...a: unknown[]) => m.toastError(...a),
	},
}));

function mutationOptionsStub(fn: (input: unknown) => Promise<unknown>) {
	return (
		opts: {
			onSuccess?: (data: unknown, vars: unknown) => void;
			onError?: (error: Error) => void;
		} = {},
	) => ({ mutationFn: fn, ...opts });
}

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				getSettings: {
					queryOptions: (o: { input: unknown }) => ({
						queryKey: ["getSettings", o.input],
						queryFn: () => m.getSettings(o.input),
					}),
				},
				updateSettings: {
					mutationOptions: mutationOptionsStub((i) =>
						m.updateSettings(i),
					),
				},
				repositorySync: {
					configure: {
						mutationOptions: mutationOptionsStub((i) =>
							m.configure(i),
						),
					},
					syncNow: {
						mutationOptions: mutationOptionsStub((i) =>
							m.syncNow(i),
						),
					},
					updateProposalSettings: {
						mutationOptions: mutationOptionsStub((i) =>
							m.updateProposalSettings(i),
						),
					},
					disable: {
						mutationOptions: mutationOptionsStub((i) =>
							m.disable(i),
						),
					},
					listRuns: {
						queryOptions: (o: { input: unknown }) => ({
							queryKey: ["listRuns", o.input],
							queryFn: () => m.listRuns(o.input),
						}),
					},
					listTree: {
						queryOptions: (o: {
							input: unknown;
							[key: string]: unknown;
						}) => ({
							...o,
							queryKey: ["listTree", o.input],
							queryFn: () => m.listTree(o.input),
						}),
					},
					readIgnoreFile: {
						queryOptions: (o: {
							input: unknown;
							[key: string]: unknown;
						}) => ({
							...o,
							queryKey: ["readIgnoreFile", o.input],
							queryFn: () => m.readIgnoreFile(o.input),
						}),
					},
				},
			},
		},
	},
}));

import { ConfigureRepositorySyncDialog } from "../ConfigureRepositorySyncDialog";
import { RepositorySyncRuns } from "../RepositorySyncRuns";
import { RepositorySyncSettingsSection } from "../RepositorySyncSettingsSection";
import { RepositorySyncStatus } from "../RepositorySyncStatus";

function Providers({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

const INTEGRATION = {
	id: "int_1",
	provider: "GITHUB",
	repositoryOwner: "example-org",
	repositoryName: "instructions",
	defaultBranch: "develop",
};
const SECOND = {
	id: "int_2",
	provider: "AZURE_DEVOPS",
	repositoryOwner: "example-org",
	repositoryName: "agents",
	defaultBranch: "trunk",
};
const CONFIGURED: RepositorySyncState = {
	sourceOfTruth: "REPOSITORY",
	canConfigure: true,
	running: false,
	configured: {
		syncId: "sync_1",
		repositoryIntegrationId: "int_1",
		provider: "GITHUB",
		repositoryOwner: "example-org",
		repositoryName: "instructions",
		repositoryUrl: "https://github.com/example-org/instructions.git",
		integrationStatus: "ACTIVE",
		ref: "main",
		rootPath: "agents",
		automatic: false,
		automaticPausedReason: null,
		automaticPausedAt: null,
		delegateName: "Example Member",
	},
	latestRun: null,
	availableIntegrations: [INTEGRATION],
};
const copy = en.projects.codingInstructions.repositorySync;
const directCopy = en.projects.codingInstructions.direct;

function run(overrides: Partial<SyncRunView> = {}): SyncRunView {
	return {
		id: "sync_1:run_a",
		trigger: "MANUAL",
		startedAt: new Date(),
		finishedAt: new Date(),
		status: "SUCCEEDED",
		error: null,
		note: null,
		commitSha: "0123456789abcdef0123456789abcdef01234567",
		snapshotId: "snap_1",
		snapshotVersion: 4,
		userName: "Example Member",
		fromCurrentConfiguration: true,
		...overrides,
	};
}

const orpcError = (code: string) =>
	Object.assign(new Error(code), { data: { code } });

beforeEach(() => {
	for (const fn of Object.values(m)) {
		fn.mockReset();
	}
	m.confirm.mockImplementation((options: { onConfirm: () => void }) =>
		options.onConfirm(),
	);
	m.configure.mockResolvedValue({ syncId: "sync_1", generation: 1 });
	m.updateProposalSettings.mockImplementation(
		async (i: { allowReaderProposals: boolean }) => ({
			allowReaderProposals: i.allowReaderProposals,
			generation: 1,
		}),
	);
	m.syncNow.mockResolvedValue({ started: true });
	m.disable.mockResolvedValue({ disabled: true, hadConfiguration: true });
	m.listRuns.mockResolvedValue({ runs: [] });
	m.listTree.mockResolvedValue({
		supported: true,
		entries: [],
		truncated: false,
	});
	m.readIgnoreFile.mockResolvedValue({
		supported: true,
		state: "absent",
		rules: [],
	});
	m.getSettings.mockResolvedValue({
		ignoreGlobs: null,
		defaultIgnoreGlobs: [],
		sourceOfTruth: "REPOSITORY",
	});
	m.updateSettings.mockResolvedValue({ ok: true });
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe("ConfigureRepositorySyncDialog (§7.2)", () => {
	/**
	 * The branch as the provider lists it: `agents` holds instructions, a
	 * skills folder and drafts; `tools/claude` is a second candidate root.
	 */
	const TREE = {
		supported: true,
		truncated: false,
		entries: [
			{ path: "agents", type: "dir" },
			{ path: "agents/CLAUDE.md", type: "file" },
			{ path: "agents/skills", type: "dir" },
			{ path: "agents/skills/review.md", type: "file" },
			{ path: "agents/drafts", type: "dir" },
			{ path: "agents/drafts/idea.md", type: "file" },
			{ path: "tools", type: "dir" },
			{ path: "tools/claude", type: "dir" },
			{ path: "tools/claude/settings.json", type: "file" },
		],
	};
	const UNSUPPORTED = { supported: false, entries: [], truncated: false };
	const sel = copy.tree.selection;

	beforeEach(() => {
		m.listTree.mockResolvedValue(TREE);
	});

	function renderDialog(
		props: Partial<
			Parameters<typeof ConfigureRepositorySyncDialog>[0]
		> = {},
	) {
		const onOpenChange = vi.fn();
		const onSaved = vi.fn();
		render(
			<ConfigureRepositorySyncDialog
				projectId="proj_1"
				open
				onOpenChange={onOpenChange}
				integrations={[INTEGRATION]}
				current={null}
				onSaved={onSaved}
				{...props}
			/>,
			{ wrapper: Providers },
		);
		return { onOpenChange, onSaved };
	}

	const submit = () =>
		screen.getByRole("button", { name: directCopy.saveConnection });
	const treeList = () => screen.getByRole("list", { name: copy.tree.label });
	const box = (path: string) =>
		within(treeList()).getByRole("checkbox", { name: path });
	const syncsList = () =>
		screen.getByRole("list", {
			name: copy.configureDialog.selectedPaths.label,
		});
	const typedFolder = () =>
		screen.getByLabelText(copy.configureDialog.typedPath.label);

	/** Tick `agents` in the tree, once it is listed. */
	async function pickAgents(user: ReturnType<typeof userEvent.setup>) {
		await user.click(
			await screen.findByRole("checkbox", { name: "agents" }),
		);
	}

	/** Type a folder into the typed input and use it. */
	async function typeFolder(
		user: ReturnType<typeof userEvent.setup>,
		folder: string,
	) {
		await user.clear(typedFolder());
		if (folder !== "") {
			await user.type(typedFolder(), folder);
		}
		await user.click(
			screen.getByRole("button", {
				name: copy.configureDialog.typedPath.add,
			}),
		);
	}

	it("saves the attached branch and folder without starting an import", async () => {
		const user = userEvent.setup();
		const { onOpenChange, onSaved } = renderDialog();

		expect(
			screen.getByLabelText(copy.configureDialog.branchLabel),
		).toHaveValue("develop");
		expect(
			screen.getByText("example-org/instructions"),
		).toBeInTheDocument();
		expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
		const notice = screen.getByText(directCopy.connectionNotice);
		expect(notice).toBeInTheDocument();
		expect(
			screen.queryByRole("checkbox", {
				name: copy.configureDialog.automaticLabel,
			}),
		).not.toBeInTheDocument();

		await pickAgents(user);
		await user.click(submit());

		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(m.configure).toHaveBeenCalledWith({
			projectId: "proj_1",
			repositoryIntegrationId: "int_1",
			ref: "develop",
			rootPath: "agents",
		});
		expect(m.syncNow).not.toHaveBeenCalled();
		expect(m.toastSuccess).toHaveBeenCalledWith(directCopy.connectionSaved);
		expect(onSaved).toHaveBeenCalled();
	});

	it("does not offer automatic imports for a previously scheduled connection", async () => {
		const user = userEvent.setup();
		const { onOpenChange, onSaved } = renderDialog({
			current: { ...CONFIGURED.configured, automatic: true },
		});
		expect(
			screen.queryByText(copy.configureDialog.automaticHint),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("checkbox", {
				name: copy.configureDialog.automaticLabel,
			}),
		).not.toBeInTheDocument();

		await user.click(submit());

		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(m.syncNow).not.toHaveBeenCalled();
		expect(m.configure.mock.calls[0]?.[0]).not.toHaveProperty("automatic");
		expect(m.toastInfo).not.toHaveBeenCalled();
		expect(onSaved).toHaveBeenCalled();
	});

	it("offers a choice when the project has more than one repository, and reseeds the branch", async () => {
		const user = userEvent.setup();
		renderDialog({ integrations: [INTEGRATION, SECOND] });
		// The design system's Select, not a native one: a combobox that opens
		// a listbox, so the choice is two clicks.
		const repository = screen.getByRole("combobox", {
			name: copy.configureDialog.repositoryLabel,
		});
		await user.click(repository);
		expect(
			screen.getByRole("option", {
				name: "GitHub · example-org/instructions",
			}),
		).toBeInTheDocument();
		await user.click(
			screen.getByRole("option", {
				name: "Azure DevOps · example-org/agents",
			}),
		);
		expect(
			screen.getByLabelText(copy.configureDialog.branchLabel),
		).toHaveValue("trunk");
		expect(repository).toHaveTextContent(
			"Azure DevOps · example-org/agents",
		);
	});

	it("keeps a missing branch inline, starts nothing, and stays open", async () => {
		m.configure.mockRejectedValue(orpcError("BRANCH_NOT_FOUND"));
		const user = userEvent.setup();
		const { onOpenChange } = renderDialog();
		await pickAgents(user);
		await user.click(submit());

		expect(await screen.findByRole("alert")).toHaveTextContent(
			copy.configureDialog.errors.BRANCH_NOT_FOUND.replace(
				"{ref}",
				"develop",
			),
		);
		expect(m.syncNow).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalled();
	});

	it("toasts an unreachable repository instead of blaming the form", async () => {
		m.configure.mockRejectedValue(orpcError("REPOSITORY_UNREACHABLE"));
		const user = userEvent.setup();
		renderDialog();
		await pickAgents(user);
		await user.click(submit());
		await waitFor(() =>
			expect(m.toastError).toHaveBeenCalledWith(
				copy.configureDialog.errors.REPOSITORY_UNREACHABLE,
			),
		);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("seeds from the current configuration when changing it", async () => {
		renderDialog({ current: CONFIGURED.configured });
		expect(
			screen.getByLabelText(copy.configureDialog.branchLabel),
		).toHaveValue("main");
		expect(
			await screen.findByRole("checkbox", { name: "agents" }),
		).toBeChecked();
		expect(within(syncsList()).getByText("agents/")).toBeInTheDocument();
	});

	// B-3 (Task 9 review): the five inline codes `configure` can throw, each
	// keeping the error inline (not a toast) and starting nothing.
	it.each([
		"BRANCH_NOT_FOUND",
		"REPOSITORY_CREDENTIALS_EXPIRED",
		"REPOSITORY_UNAVAILABLE",
		"REPOSITORY_NOT_FOUND",
		"INVALID_ROOT_PATH",
	] as const)("keeps %s inline and starts nothing", async (code) => {
		m.configure.mockRejectedValue(orpcError(code));
		const user = userEvent.setup();
		renderDialog();
		await pickAgents(user);
		await user.click(submit());
		const errors = copy.configureDialog.errors as Record<string, string>;
		expect(await screen.findByRole("alert")).toHaveTextContent(
			errors[code].replace("{ref}", "develop"),
		);
		expect(m.syncNow).not.toHaveBeenCalled();
	});

	// B-2 (Task 9 review): the inline error used to mark the branch field
	// invalid no matter which field the error was actually about. The folder
	// is a field only where it is typed.
	it("points the inline error at the typed folder for INVALID_ROOT_PATH, leaving the branch field alone", async () => {
		m.listTree.mockResolvedValue(UNSUPPORTED);
		m.configure.mockRejectedValue(orpcError("INVALID_ROOT_PATH"));
		const user = userEvent.setup();
		renderDialog();
		await screen.findByLabelText(copy.configureDialog.typedPath.label);
		await typeFolder(user, "agents");
		await user.click(submit());
		const alert = await screen.findByRole("alert");
		expect(typedFolder()).toHaveAttribute("aria-invalid", "true");
		expect(typedFolder()).toHaveAccessibleDescription(
			expect.stringContaining(alert.textContent ?? ""),
		);
		expect(
			screen.getByLabelText(copy.configureDialog.branchLabel),
		).not.toHaveAttribute("aria-invalid");
	});

	it("points the inline error at the branch field for BRANCH_NOT_FOUND, leaving the typed folder alone", async () => {
		m.listTree.mockResolvedValue(UNSUPPORTED);
		m.configure.mockRejectedValue(orpcError("BRANCH_NOT_FOUND"));
		const user = userEvent.setup();
		renderDialog();
		await screen.findByLabelText(copy.configureDialog.typedPath.label);
		await typeFolder(user, "agents");
		await user.click(submit());
		await screen.findByRole("alert");
		expect(
			screen.getByLabelText(copy.configureDialog.branchLabel),
		).toHaveAttribute("aria-invalid", "true");
		expect(typedFolder()).not.toHaveAttribute("aria-invalid");
	});

	it("leaves both fields unattached for a repository-level inline error", async () => {
		m.listTree.mockResolvedValue(UNSUPPORTED);
		m.configure.mockRejectedValue(orpcError("REPOSITORY_NOT_FOUND"));
		const user = userEvent.setup();
		renderDialog();
		await screen.findByLabelText(copy.configureDialog.typedPath.label);
		await typeFolder(user, "agents");
		await user.click(submit());
		await screen.findByRole("alert");
		expect(
			screen.getByLabelText(copy.configureDialog.branchLabel),
		).not.toHaveAttribute("aria-invalid");
		expect(typedFolder()).not.toHaveAttribute("aria-invalid");
	});

	it("disables Save while the branch is empty or whitespace, saying why", async () => {
		const user = userEvent.setup();
		renderDialog();
		await pickAgents(user);
		const branchInput = screen.getByLabelText(
			copy.configureDialog.branchLabel,
		);
		await user.clear(branchInput);
		expect(submit()).toBeDisabled();
		expect(submit()).toHaveAccessibleDescription(
			copy.configureDialog.saveBlocked.noBranch,
		);
		await user.type(branchInput, "   ");
		expect(submit()).toBeDisabled();
	});

	it("ignores Escape while the save is in flight, and closes once it has settled", async () => {
		let finish: (value: unknown) => void = () => {};
		m.configure.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const user = userEvent.setup();
		const { onOpenChange } = renderDialog();
		await pickAgents(user);
		await user.click(submit());

		await user.keyboard("{Escape}");

		expect(onOpenChange).not.toHaveBeenCalled();
		finish({ syncId: "sync_1", generation: 1 });
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
	});

	it("closes on Escape when nothing is in flight", async () => {
		const user = userEvent.setup();
		const { onOpenChange } = renderDialog();
		await screen.findByRole("list", { name: copy.tree.label });

		await user.keyboard("{Escape}");

		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	describe("choosing the folder in the selection tree (Fizzy #2725, #2750 §4)", () => {
		it("lists the chosen repository's branch under the branch field", async () => {
			renderDialog();
			const list = await screen.findByRole("list", {
				name: copy.tree.label,
			});
			expect(m.listTree).toHaveBeenCalledWith({
				projectId: "proj_1",
				repositoryIntegrationId: "int_1",
				ref: "develop",
			});
			const branch = screen.getByLabelText(
				copy.configureDialog.branchLabel,
			);
			expect(
				branch.compareDocumentPosition(list) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
		});

		it("ticks nothing for a new configuration and keeps Save disabled, pointing at why", async () => {
			renderDialog();
			await screen.findByRole("list", { name: copy.tree.label });
			for (const checkbox of within(treeList()).getAllByRole(
				"checkbox",
			)) {
				expect(checkbox).not.toBeChecked();
			}
			expect(submit()).toBeDisabled();
			expect(submit()).toHaveAccessibleDescription(
				copy.summary.nothingSelected,
			);
			// The repository root has no row to tick: the hint names Select all.
			expect(
				screen.getByText(copy.summary.nothingSelected),
			).toHaveTextContent("Select all to sync the whole repository.");
			// Coding Instructions syncs one folder: a file can't be ticked.
			expect(box("agents/CLAUDE.md")).toBeDisabled();
			expect(box("agents/CLAUDE.md")).toHaveAccessibleDescription(
				sel.syncsAFolder,
			);
			// No typed input while the tree lists the whole branch.
			expect(
				screen.queryByLabelText(copy.configureDialog.typedPath.label),
			).not.toBeInTheDocument();
		});

		it("ticking a folder syncs it and everything inside, and says so", async () => {
			const user = userEvent.setup();
			renderDialog();
			await pickAgents(user);
			await waitFor(() => expect(box("agents/skills")).toBeEnabled());
			expect(box("agents")).toBeChecked();
			expect(box("agents/skills")).toBeChecked();
			expect(box("agents/CLAUDE.md")).toBeChecked();
			expect(
				within(syncsList()).getByText("agents/"),
			).toBeInTheDocument();
			expect(
				screen.getByText(
					copy.summary.lead.replace("{folder}", "agents"),
				),
			).toBeInTheDocument();
			expect(
				screen.getByText(copy.summary.installedAs),
			).toBeInTheDocument();
			expect(submit()).toBeEnabled();
		});

		it("ticking another folder moves the sync there and clears the inline error", async () => {
			m.configure.mockRejectedValueOnce(orpcError("INVALID_ROOT_PATH"));
			const user = userEvent.setup();
			const { onOpenChange } = renderDialog();
			await pickAgents(user);
			await user.click(submit());
			await screen.findByRole("alert");

			await user.click(box("tools/claude"));
			expect(box("tools/claude")).toBeChecked();
			expect(box("agents")).not.toBeChecked();
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();

			await user.click(submit());
			await waitFor(() =>
				expect(onOpenChange).toHaveBeenCalledWith(false),
			);
			expect(m.configure).toHaveBeenLastCalledWith(
				expect.objectContaining({ rootPath: "tools/claude" }),
			);
		});

		it("opens the way to a stored folder deep in the tree", async () => {
			m.listTree.mockResolvedValue({
				...TREE,
				entries: [
					...TREE.entries,
					{ path: "tools/claude/skills", type: "dir" },
					{ path: "tools/claude/skills/a.md", type: "file" },
				],
			});
			renderDialog({
				current: {
					...(CONFIGURED.configured as NonNullable<
						RepositorySyncState["configured"]
					>),
					rootPath: "tools/claude/skills",
				},
			});
			expect(
				await screen.findByRole("checkbox", {
					name: "tools/claude/skills",
				}),
			).toBeChecked();
		});

		it("unticking the folder, or removing it from the list, selects nothing", async () => {
			const user = userEvent.setup();
			renderDialog({ current: CONFIGURED.configured });
			await waitFor(() => expect(box("agents")).toBeChecked());
			await user.click(box("agents"));
			expect(box("agents")).not.toBeChecked();
			expect(submit()).toBeDisabled();

			await user.click(box("agents"));
			await user.click(
				within(syncsList()).getByRole("button", {
					name: copy.configureDialog.selectedPaths.remove.replace(
						"{path}",
						"agents/",
					),
				}),
			);
			expect(box("agents")).not.toBeChecked();
			expect(
				screen.getByText(copy.summary.nothingSelected),
			).toBeInTheDocument();
		});

		it("Select all syncs the whole repository; Select none clears it", async () => {
			const user = userEvent.setup();
			const { onOpenChange } = renderDialog();
			await screen.findByRole("list", { name: copy.tree.label });
			await user.click(
				screen.getByRole("button", { name: copy.tree.selectNone }),
			);
			expect(submit()).toBeDisabled();
			await user.click(
				screen.getByRole("button", { name: copy.tree.selectAll }),
			);
			expect(
				within(syncsList()).getByText(
					copy.configureDialog.selectedPaths.wholeRepository,
				),
			).toBeInTheDocument();
			expect(box("agents")).toBeChecked();
			expect(box("tools")).toBeChecked();
			expect(screen.getByText(copy.summary.leadRoot)).toBeInTheDocument();

			await user.click(submit());
			await waitFor(() =>
				expect(onOpenChange).toHaveBeenCalledWith(false),
			);
			expect(m.configure).toHaveBeenCalledWith(
				expect.objectContaining({ rootPath: "" }),
			);
		});

		it("offers the folder as typed text when the provider has no listing", async () => {
			m.listTree.mockResolvedValue(UNSUPPORTED);
			const user = userEvent.setup();
			renderDialog();
			expect(
				await screen.findByText(copy.tree.unsupported),
			).toBeInTheDocument();

			await typeFolder(user, "");
			expect(screen.getByRole("alert")).toHaveTextContent(
				copy.configureDialog.typedPath.empty,
			);

			await typeFolder(user, "agents/");
			expect(
				within(syncsList()).getByText("agents/"),
			).toBeInTheDocument();
			await user.click(submit());
			await waitFor(() =>
				expect(m.configure).toHaveBeenCalledWith(
					expect.objectContaining({ rootPath: "agents" }),
				),
			);
		});

		it("offers the typed folder beside a truncated listing, and beside a failed one", async () => {
			m.listTree.mockResolvedValue({ ...TREE, truncated: true });
			const { unmount } = render(
				<ConfigureRepositorySyncDialog
					projectId="proj_1"
					open
					onOpenChange={vi.fn()}
					integrations={[INTEGRATION]}
					current={null}
					onSaved={vi.fn()}
				/>,
				{ wrapper: Providers },
			);
			expect(
				await screen.findByLabelText(
					copy.configureDialog.typedPath.label,
				),
			).toBeInTheDocument();
			unmount();

			m.listTree.mockRejectedValue(orpcError("REPOSITORY_UNREACHABLE"));
			renderDialog();
			expect(
				await screen.findByLabelText(
					copy.configureDialog.typedPath.label,
				),
			).toBeInTheDocument();
		});
	});

	describe("leaving things out by unticking them (Fizzy #2726, #2750 §4)", () => {
		/**
		 * The project's settings row as the server keeps it: a re-read
		 * answers what is stored, and only a successful `configure` that
		 * carried rules stores them (one transaction).
		 */
		let stored: string[] | null;
		beforeEach(() => {
			stored = null;
			m.getSettings.mockImplementation(async () => ({
				ignoreGlobs: stored,
				defaultIgnoreGlobs: [...DEFAULT_IGNORE_GLOBS],
				sourceOfTruth: "REPOSITORY",
			}));
			m.configure.mockImplementation(
				async (i: { ignoreGlobs?: string[] | null }) => {
					if (i.ignoreGlobs !== undefined) {
						stored = i.ignoreGlobs;
					}
					return { syncId: "sync_1", generation: 2 };
				},
			);
		});

		/** The configure input of call `n` (0-based). */
		const configured = (n = 0) =>
			m.configure.mock.calls[n]?.[0] as Record<string, unknown>;

		/** The dialog on the stored folder `agents`, its rules known. */
		async function renderOnAgents(
			props: Partial<
				Parameters<typeof ConfigureRepositorySyncDialog>[0]
			> = {},
		) {
			const rendered = renderDialog({
				current: CONFIGURED.configured,
				...props,
			});
			await screen.findByRole("list", { name: copy.tree.label });
			await waitFor(() => expect(box("agents/drafts")).toBeEnabled());
			return rendered;
		}

		it("saves exclusions atomically with the connection without starting an import", async () => {
			const user = userEvent.setup();
			const { onOpenChange, onSaved } = await renderOnAgents();

			await user.click(box("agents/skills"));
			expect(box("agents/skills")).not.toBeChecked();
			expect(box("agents")).toHaveAttribute("aria-checked", "mixed");
			expect(
				within(syncsList()).getByText(
					copy.configureDialog.selectedPaths.except.replace(
						"{path}",
						"agents/skills/",
					),
				),
			).toBeInTheDocument();
			await user.click(submit());

			await waitFor(() =>
				expect(onOpenChange).toHaveBeenCalledWith(false),
			);
			expect(m.updateSettings).not.toHaveBeenCalled();
			expect(m.configure).toHaveBeenCalledTimes(1);
			// A project with no rules of its own keeps the defaults it had.
			expect(configured()).toEqual({
				projectId: "proj_1",
				repositoryIntegrationId: "int_1",
				ref: "main",
				rootPath: "agents",
				ignoreGlobs: [...DEFAULT_IGNORE_GLOBS, "skills/**"],
			});
			expect(m.syncNow).not.toHaveBeenCalled();
			expect(onSaved).toHaveBeenCalled();
		});

		it("stages a file's own path, relative to the folder", async () => {
			const user = userEvent.setup();
			const { onOpenChange } = await renderOnAgents();
			await user.click(box("agents/CLAUDE.md"));
			await user.click(submit());
			await waitFor(() =>
				expect(onOpenChange).toHaveBeenCalledWith(false),
			);
			expect(configured().ignoreGlobs).toEqual([
				...DEFAULT_IGNORE_GLOBS,
				"CLAUDE.md",
			]);
		});

		it("says why a row inside an unticked folder can't be ticked", async () => {
			const user = userEvent.setup();
			await renderOnAgents();
			await user.click(box("agents/skills"));
			await user.click(
				within(treeList()).getByRole("button", { name: "skills" }),
			);
			expect(box("agents/skills/review.md")).toBeDisabled();
			expect(box("agents/skills/review.md")).toHaveAccessibleDescription(
				sel.leftOutBecause.replace("{path}", "agents/skills"),
			);
		});

		it("names the rule that leaves a row out when the tree can't change it", async () => {
			m.listTree.mockResolvedValue({
				...TREE,
				entries: [
					...TREE.entries,
					{ path: "agents/tasks", type: "dir" },
					{ path: "agents/tasks/todo.md", type: "file" },
					{ path: "agents/link.md", type: "file", regular: false },
					{ path: "agents/dr*fts", type: "dir" },
					{ path: "agents/dr*fts/x.md", type: "file" },
				],
			});
			await renderOnAgents();
			expect(box("agents/tasks")).toBeDisabled();
			expect(box("agents/tasks")).not.toBeChecked();
			expect(box("agents/tasks")).toHaveAccessibleDescription(
				sel.cause.default.replace("{rule}", "**/tasks/**"),
			);
			expect(box("agents/link.md")).toHaveAccessibleDescription(
				sel.notRegular,
			);
			expect(box("agents/dr*fts")).toBeDisabled();
			expect(box("agents/dr*fts")).toBeChecked();
			expect(box("agents/dr*fts")).toHaveAccessibleDescription(
				sel.wildcard,
			);
		});

		it("disables every new rule once the project's list is full, saying so", async () => {
			stored = Array.from({ length: 200 }, (_, i) => `rule-${i}/**`);
			renderDialog({ current: CONFIGURED.configured });
			await screen.findByRole("list", { name: copy.tree.label });
			await waitFor(() =>
				expect(box("agents/skills")).toHaveAccessibleDescription(
					/already has .* ignore rules/,
				),
			);
			expect(box("agents/skills")).toBeDisabled();
			expect(box("agents/skills")).toBeChecked();
		});

		it("ticking a row the member left out removes its own rule, and lists the saved rule before Save", async () => {
			stored = ["dist/**", "skills/**"];
			const user = userEvent.setup();
			const { onOpenChange } = await renderOnAgents();
			expect(box("agents/skills")).not.toBeChecked();
			expect(box("agents")).toHaveAttribute("aria-checked", "mixed");
			expect(
				screen.queryByText(copy.configureDialog.removalNotice),
			).not.toBeInTheDocument();

			await user.click(box("agents/skills"));
			expect(box("agents/skills")).toBeChecked();
			const notice = screen.getByText(copy.configureDialog.removalNotice);
			expect(notice.parentElement).toHaveTextContent("skills/**");
			expect(submit()).toHaveAccessibleDescription(
				expect.stringContaining(copy.configureDialog.removalNotice),
			);

			await user.click(submit());
			await waitFor(() =>
				expect(onOpenChange).toHaveBeenCalledWith(false),
			);
			expect(configured().ignoreGlobs).toEqual(["dist/**"]);
		});

		it("ticking a partial folder removes the member's rules inside it", async () => {
			stored = ["skills/**", "drafts/**"];
			const user = userEvent.setup();
			await renderOnAgents();
			expect(box("agents")).toHaveAttribute("aria-checked", "mixed");
			await user.click(box("agents"));
			expect(box("agents")).toBeChecked();
			expect(box("agents/skills")).toBeChecked();
			expect(box("agents/drafts")).toBeChecked();
			const notice = screen.getByText(copy.configureDialog.removalNotice);
			expect(notice.parentElement).toHaveTextContent("skills/**");
			expect(notice.parentElement).toHaveTextContent("drafts/**");
		});

		it("includes a left-out row again from the list", async () => {
			stored = ["skills/**"];
			const user = userEvent.setup();
			await renderOnAgents();
			await user.click(
				within(syncsList()).getByRole("button", {
					name: copy.configureDialog.selectedPaths.includeAgain.replace(
						"{path}",
						"agents/skills/",
					),
				}),
			);
			expect(box("agents/skills")).toBeChecked();
		});

		it("applies the staged edits to the rules as saved at Save, keeping a rule saved elsewhere meanwhile", async () => {
			stored = ["dist/**"];
			const user = userEvent.setup();
			const { onOpenChange } = await renderOnAgents();
			await user.click(box("agents/skills"));
			// Another member saves a rule while this dialog is open.
			stored = ["dist/**", "concurrent/**"];

			await user.click(submit());

			await waitFor(() =>
				expect(onOpenChange).toHaveBeenCalledWith(false),
			);
			expect(configured().ignoreGlobs).toEqual([
				"dist/**",
				"concurrent/**",
				"skills/**",
			]);
		});

		it("sends no rules when none changed, an untick ticked back included", async () => {
			const user = userEvent.setup();
			const { onOpenChange } = await renderOnAgents();

			await user.click(box("agents/skills"));
			await user.click(box("agents/skills"));
			await user.click(submit());

			await waitFor(() =>
				expect(onOpenChange).toHaveBeenCalledWith(false),
			);
			expect(configured()).not.toHaveProperty("ignoreGlobs");
			expect(m.syncNow).not.toHaveBeenCalled();
		});

		it("sends no rules when the fresh list already has the staged change", async () => {
			const user = userEvent.setup();
			const { onOpenChange } = await renderOnAgents();
			await user.click(box("agents/skills"));
			// Someone else saved exactly this change meanwhile.
			stored = [...DEFAULT_IGNORE_GLOBS, "skills/**"];

			await user.click(submit());

			await waitFor(() =>
				expect(onOpenChange).toHaveBeenCalledWith(false),
			);
			expect(configured()).not.toHaveProperty("ignoreGlobs");
		});

		it("saves nothing when the saved rules cannot be re-read at Save, and stays open", async () => {
			const user = userEvent.setup();
			const { onOpenChange, onSaved } = await renderOnAgents();
			await user.click(box("agents/skills"));
			m.getSettings.mockRejectedValue(new Error("boom"));

			await user.click(submit());

			await waitFor(() =>
				expect(m.toastError).toHaveBeenCalledWith(
					copy.configureDialog.errors.ignoreRulesUnavailable,
				),
			);
			expect(m.configure).not.toHaveBeenCalled();
			expect(m.syncNow).not.toHaveBeenCalled();
			expect(onOpenChange).not.toHaveBeenCalled();
			expect(onSaved).not.toHaveBeenCalled();
		});

		it("leaves the rules unchanged and claims nothing when a configure for ANOTHER folder fails", async () => {
			m.configure.mockRejectedValue(orpcError("BRANCH_NOT_FOUND"));
			const user = userEvent.setup();
			// Configured on `agents`; the member moves to `tools`.
			const { onOpenChange, onSaved } = await renderOnAgents();
			await user.click(box("tools"));
			await waitFor(() => expect(box("tools/claude")).toBeEnabled());
			await user.click(box("tools/claude"));

			await user.click(submit());

			expect(await screen.findByRole("alert")).toHaveTextContent(
				copy.configureDialog.errors.BRANCH_NOT_FOUND.replace(
					"{ref}",
					"main",
				),
			);
			// The rules went only with the configuration that failed.
			expect(m.configure).toHaveBeenCalledTimes(1);
			expect(configured()).toMatchObject({
				rootPath: "tools",
				ignoreGlobs: [...DEFAULT_IGNORE_GLOBS, "claude/**"],
			});
			expect(m.updateSettings).not.toHaveBeenCalled();
			expect(stored).toBeNull();
			// Nothing says it saved.
			expect(m.toastSuccess).not.toHaveBeenCalled();
			expect(m.toastInfo).not.toHaveBeenCalled();
			expect(m.syncNow).not.toHaveBeenCalled();
			expect(onSaved).not.toHaveBeenCalled();
			expect(onOpenChange).not.toHaveBeenCalled();
			// Still staged, to retry.
			expect(box("tools/claude")).not.toBeChecked();
		});

		it("sends the staged rules again on a retry after a failed configure", async () => {
			m.configure.mockRejectedValueOnce(
				orpcError("REPOSITORY_UNREACHABLE"),
			);
			const user = userEvent.setup();
			const { onOpenChange } = await renderOnAgents();
			await user.click(box("agents/skills"));

			await user.click(submit());
			await waitFor(() => expect(m.toastError).toHaveBeenCalled());
			await user.click(submit());

			await waitFor(() =>
				expect(onOpenChange).toHaveBeenCalledWith(false),
			);
			expect(configured(0).ignoreGlobs).toEqual([
				...DEFAULT_IGNORE_GLOBS,
				"skills/**",
			]);
			expect(configured(1).ignoreGlobs).toEqual(
				configured(0).ignoreGlobs,
			);
			expect(stored).toEqual([...DEFAULT_IGNORE_GLOBS, "skills/**"]);
		});

		it("drops the staged rules when another folder is ticked, and keeps them when the same folder is typed again", async () => {
			m.listTree.mockResolvedValue({ ...TREE, truncated: true });
			const user = userEvent.setup();
			await renderOnAgents();

			await user.click(box("agents/skills"));
			await user.click(box("tools"));
			await user.click(box("agents"));
			await waitFor(() => expect(box("agents/skills")).toBeEnabled());
			expect(box("agents/skills")).toBeChecked();

			// Typed: the same folder, spelled otherwise, keeps them.
			await user.click(box("agents/skills"));
			await typeFolder(user, "agents/");
			expect(box("agents/skills")).not.toBeChecked();
			// Another folder, typed, drops them.
			await typeFolder(user, "tools");
			await typeFolder(user, "agents");
			await waitFor(() => expect(box("agents/skills")).toBeEnabled());
			expect(box("agents/skills")).toBeChecked();
		});

		it("says inline when moving the folder clears the member's changes, until the next change (Fizzy #2752)", async () => {
			const user = userEvent.setup();
			await renderOnAgents();
			const notice = () => screen.queryByText(/^Moving the sync cleared/);

			await user.click(box("agents/skills"));
			expect(notice()).not.toBeInTheDocument();
			await user.click(box("tools"));
			expect(notice()).toHaveTextContent("agents/");

			// Moving back clears nothing more, and says nothing.
			await user.click(box("agents"));
			await waitFor(() => expect(box("agents/skills")).toBeEnabled());
			expect(box("agents/skills")).toBeChecked();
			expect(notice()).not.toBeInTheDocument();
		});

		it("opens the way to every item left out inside the stored folder (Fizzy #2752)", async () => {
			stored = ["claude/settings.json"];
			renderDialog({
				current: {
					...(CONFIGURED.configured as NonNullable<
						RepositorySyncState["configured"]
					>),
					rootPath: "tools",
				},
			});
			const leftOut = await screen.findByRole("checkbox", {
				name: "tools/claude/settings.json",
			});
			expect(leftOut).not.toBeChecked();
			// Its only file is out, so the folder is out too.
			expect(box("tools/claude")).not.toBeChecked();
		});

		it("drops the staged rules when the branch changes", async () => {
			const user = userEvent.setup();
			const { onOpenChange } = await renderOnAgents();
			await user.click(box("agents/skills"));

			const branchField = screen.getByLabelText(
				copy.configureDialog.branchLabel,
			);
			await user.type(branchField, "-next");
			await waitFor(() =>
				expect(m.listTree).toHaveBeenCalledWith(
					expect.objectContaining({ ref: "main-next" }),
				),
			);
			await waitFor(() => expect(box("agents/skills")).toBeEnabled());
			expect(box("agents/skills")).toBeChecked();

			// Trailing spaces are the same branch: the edits stay.
			await user.click(box("agents/skills"));
			await user.type(branchField, "  ");
			expect(box("agents/skills")).not.toBeChecked();
			await user.clear(branchField);
			await user.type(branchField, "main-next");
			await waitFor(() => expect(box("agents/skills")).toBeEnabled());
			expect(box("agents/skills")).toBeChecked();

			await user.click(submit());
			await waitFor(() =>
				expect(onOpenChange).toHaveBeenCalledWith(false),
			);
			expect(configured()).not.toHaveProperty("ignoreGlobs");
		});

		it("drops the staged rules when another repository is chosen", async () => {
			const user = userEvent.setup();
			const { onOpenChange } = await renderOnAgents({
				integrations: [INTEGRATION, SECOND],
			});

			await user.click(box("agents/skills"));
			await user.click(
				screen.getByRole("combobox", {
					name: copy.configureDialog.repositoryLabel,
				}),
			);
			await user.click(
				screen.getByRole("option", {
					name: "Azure DevOps · example-org/agents",
				}),
			);
			await waitFor(() => expect(box("agents/skills")).toBeEnabled());
			expect(box("agents/skills")).toBeChecked();

			await user.click(submit());
			await waitFor(() =>
				expect(onOpenChange).toHaveBeenCalledWith(false),
			);
			expect(configured()).not.toHaveProperty("ignoreGlobs");
		});

		it("can't tell what syncs while the project's rules could not be loaded, and says so", async () => {
			m.getSettings.mockRejectedValue(new Error("boom"));
			renderDialog({ current: CONFIGURED.configured });
			expect(
				await screen.findByText(copy.tree.notices.settingsError),
			).toHaveAttribute("role", "alert");
			await screen.findByRole("list", { name: copy.tree.label });
			expect(box("agents/skills")).toBeDisabled();
			expect(box("agents/skills")).toHaveAccessibleDescription(
				sel.cantTellYet,
			);
			expect(
				screen.getByText(copy.summary.cantCount),
			).toBeInTheDocument();
		});
	});

	describe("the synced folder's .fabricignore", () => {
		const WITH_IGNORE_FILE = {
			...TREE,
			entries: [
				...TREE.entries,
				{ path: "agents/.fabricignore", type: "file" },
			],
		};

		/** The dialog on the stored folder `agents`, the project rules saved. */
		async function renderOnAgents(
			saved: string[] | null,
			listing: unknown = WITH_IGNORE_FILE,
		) {
			m.getSettings.mockResolvedValue({
				ignoreGlobs: saved,
				defaultIgnoreGlobs: [...DEFAULT_IGNORE_GLOBS],
				sourceOfTruth: "REPOSITORY",
			});
			m.listTree.mockResolvedValue(listing);
			renderDialog({ current: CONFIGURED.configured });
			await screen.findByRole("list", { name: copy.tree.label });
		}

		it("reads it when the listing has it; with rules it replaces the project's and no row can be left out here", async () => {
			m.readIgnoreFile.mockResolvedValue({
				supported: true,
				state: "rules",
				rules: ["drafts/"],
			});
			await renderOnAgents(["skills/**"]);

			expect(
				await screen.findByText(copy.tree.notices.fabricignore),
			).toBeInTheDocument();
			expect(m.readIgnoreFile).toHaveBeenCalledWith({
				projectId: "proj_1",
				repositoryIntegrationId: "int_1",
				ref: "main",
				rootPath: "agents",
			});
			// The file's rule applies; the project's does not.
			expect(box("agents/drafts")).not.toBeChecked();
			expect(box("agents/drafts")).toHaveAccessibleDescription(
				sel.cause.fabricignore.replace("{rule}", "drafts/"),
			);
			expect(box("agents/skills")).toBeChecked();
			expect(box("agents/skills")).toBeDisabled();
			expect(box("agents/skills")).toHaveAccessibleDescription(
				sel.fabricignore,
			);
		});

		it("keeps the project's rules, and unticking, when the file has no rules", async () => {
			m.readIgnoreFile.mockResolvedValue({
				supported: true,
				state: "rules",
				rules: [],
			});
			await renderOnAgents(["skills/**"]);
			await waitFor(() => expect(box("agents/drafts")).toBeEnabled());
			expect(box("agents/skills")).not.toBeChecked();
			expect(box("agents/skills")).toBeEnabled();
			expect(
				screen.queryByText(copy.tree.notices.fabricignore),
			).not.toBeInTheDocument();
		});

		it("says a file over the sync's limit is ignored, and keeps the project's rules", async () => {
			m.readIgnoreFile.mockResolvedValue({
				supported: true,
				state: "tooLarge",
				rules: [],
			});
			await renderOnAgents(["skills/**"]);
			expect(
				await screen.findByText(copy.tree.notices.ignoreFileTooLarge),
			).toBeInTheDocument();
			expect(box("agents/skills")).not.toBeChecked();
			expect(box("agents/skills")).toBeEnabled();
		});

		it("says a file that is not UTF-8 text makes the sync refuse the folder, and shows no rules from it", async () => {
			m.readIgnoreFile.mockResolvedValue({
				supported: true,
				state: "encoding",
				rules: [],
			});
			await renderOnAgents(["skills/**"]);
			expect(
				await screen.findByText(copy.tree.notices.ignoreFileEncoding),
			).toHaveAttribute("role", "alert");
			expect(
				screen.queryByText(copy.tree.notices.fabricignore),
			).not.toBeInTheDocument();
			expect(box("agents/skills")).not.toBeChecked();
			expect(box("agents/skills")).toBeEnabled();
		});

		it("shows a failed read, and can't tell what syncs rather than showing the project's rules", async () => {
			m.readIgnoreFile.mockRejectedValue(new Error("network down"));
			await renderOnAgents(["skills/**"]);
			expect(
				await screen.findByText(copy.tree.notices.ignoreFileError),
			).toHaveAttribute("role", "alert");
			for (const path of ["agents/skills", "agents/drafts"]) {
				expect(box(path)).toBeDisabled();
				expect(box(path)).toHaveAccessibleDescription(sel.cantTellYet);
			}
		});

		it("can't tell what syncs while the file is being read", async () => {
			m.readIgnoreFile.mockReturnValue(new Promise(() => {}));
			await renderOnAgents(null);
			expect(
				await screen.findByText(copy.tree.notices.ignoreFileLoading),
			).toBeInTheDocument();
			expect(box("agents/skills")).toBeDisabled();
			expect(box("agents/skills")).toHaveAccessibleDescription(
				sel.cantTellYet,
			);
			expect(screen.getByText(copy.summary.counting)).toBeInTheDocument();
		});

		it("does not read a .fabricignore that is a symbolic link: the sync has no such file", async () => {
			await renderOnAgents(null, {
				...TREE,
				entries: [
					...TREE.entries,
					{
						path: "agents/.fabricignore",
						type: "file",
						regular: false,
					},
				],
			});
			await waitFor(() => expect(box("agents/skills")).toBeEnabled());
			expect(m.readIgnoreFile).not.toHaveBeenCalled();
			expect(box("agents/.fabricignore")).toHaveAccessibleDescription(
				sel.notRegular,
			);
		});

		it("reads only the synced folder's own file, not one elsewhere", async () => {
			const user = userEvent.setup();
			await renderOnAgents(null, {
				...TREE,
				entries: [
					...TREE.entries,
					{ path: "tools/.fabricignore", type: "file" },
				],
			});
			await waitFor(() => expect(box("agents/skills")).toBeEnabled());
			expect(m.readIgnoreFile).not.toHaveBeenCalled();
			m.readIgnoreFile.mockResolvedValue({
				supported: true,
				state: "absent",
				rules: [],
			});
			await user.click(box("tools"));
			await waitFor(() =>
				expect(m.readIgnoreFile).toHaveBeenCalledWith(
					expect.objectContaining({ rootPath: "tools" }),
				),
			);
		});

		it("reads the repository root's file for the whole repository", async () => {
			m.readIgnoreFile.mockResolvedValue({
				supported: true,
				state: "absent",
				rules: [],
			});
			const user = userEvent.setup();
			await renderOnAgents(null, {
				...TREE,
				entries: [
					...TREE.entries,
					{ path: ".fabricignore", type: "file" },
				],
			});
			await user.click(
				screen.getByRole("button", { name: copy.tree.selectAll }),
			);
			await waitFor(() =>
				expect(m.readIgnoreFile).toHaveBeenCalledWith(
					expect.objectContaining({ rootPath: "" }),
				),
			);
		});

		it("reads it from a truncated listing that may have stopped before it", async () => {
			m.readIgnoreFile.mockResolvedValue({
				supported: true,
				state: "absent",
				rules: [],
			});
			await renderOnAgents(null, { ...TREE, truncated: true });
			await waitFor(() =>
				expect(m.readIgnoreFile).toHaveBeenCalledWith(
					expect.objectContaining({ rootPath: "agents" }),
				),
			);
			await waitFor(() => expect(box("agents/skills")).toBeEnabled());
		});
	});
});

describe("RepositorySyncStatus (§7.3)", () => {
	it("says a run is in progress", () => {
		render(
			<RepositorySyncStatus state={{ ...CONFIGURED, running: true }} />,
		);
		expect(screen.getByText(copy.running)).toBeInTheDocument();
	});

	it("shows the last run's outcome, the commit it took and the member", () => {
		render(
			<RepositorySyncStatus
				state={{ ...CONFIGURED, latestRun: run() }}
			/>,
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			"took commit 0123456",
		);
		expect(screen.getByRole("status")).toHaveTextContent("Example Member");
	});

	it("reports a CHILD_ABORTED run as a publication, with no error line, once its version was retried and published", () => {
		const aborted = run({
			status: "FAILED",
			error: "CHILD_ABORTED",
			snapshotVersion: 12,
		});
		const { rerender } = render(
			<RepositorySyncStatus
				state={{ ...CONFIGURED, latestRun: aborted }}
				publishedVersion={11}
			/>,
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			"Syncing version 12 stopped before it finished. Try Sync now again.",
		);
		rerender(
			<RepositorySyncStatus
				state={{ ...CONFIGURED, latestRun: aborted }}
				publishedVersion={12}
			/>,
		);
		const status = screen.getByRole("status");
		expect(status).toHaveTextContent(
			"published version 12 after its checks were retried",
		);
		expect(status).not.toHaveTextContent("failed");
		expect(status).not.toHaveTextContent("stopped before it finished");
		expect(status.querySelector(".text-destructive")).toBeNull();
	});

	it("names what started the last run", () => {
		render(
			<RepositorySyncStatus
				state={{
					...CONFIGURED,
					latestRun: run({ trigger: "WEBHOOK" }),
				}}
			/>,
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			`(${copy.triggers.WEBHOOK})`,
		);
	});

	it("renders a trigger this build has no label for with the generic label (Decision 47)", () => {
		render(
			<RepositorySyncStatus
				state={{
					...CONFIGURED,
					latestRun: run({ trigger: "FUTURE_AUTOMATIC_TRIGGER" }),
				}}
			/>,
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			`(${copy.triggers.OTHER})`,
		);
	});

	it("says a failed fetch is retried while automatic sync is on, and asks for Sync now otherwise", () => {
		const configured = CONFIGURED.configured as NonNullable<
			RepositorySyncState["configured"]
		>;
		const failed = run({ status: "FAILED", error: "CLONE_FAILED" });
		const { rerender } = render(
			<RepositorySyncStatus
				state={{
					...CONFIGURED,
					configured: { ...configured, automatic: true },
					latestRun: failed,
				}}
			/>,
		);
		expect(
			screen.getByText(copy.errors.CLONE_FAILED_RETRYING),
		).toBeInTheDocument();
		rerender(
			<RepositorySyncStatus
				state={{ ...CONFIGURED, latestRun: failed }}
			/>,
		);
		expect(screen.getByText(copy.errors.CLONE_FAILED)).toBeInTheDocument();
	});

	it("a newer POLL run replaces a NOT_PUBLISHED line (Decision 9, Review Focus 5)", () => {
		const configured = CONFIGURED.configured as NonNullable<
			RepositorySyncState["configured"]
		>;
		const automatic = { ...configured, automatic: true };
		const { rerender } = render(
			<RepositorySyncStatus
				state={{
					...CONFIGURED,
					configured: automatic,
					latestRun: run({
						status: "NOT_PUBLISHED",
						error: "CONFIGURATION_CHANGED",
						startedAt: new Date(Date.now() - 10 * 60_000),
					}),
				}}
				onSyncNow={vi.fn()}
			/>,
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			copy.outcomes.notPublished.configuration_changed,
		);
		// The settings change made the sync due at once (Task 2), and the
		// next tick's POLL run is now the latest.
		rerender(
			<RepositorySyncStatus
				state={{
					...CONFIGURED,
					configured: automatic,
					latestRun: run({
						id: "sync_1:run_poll",
						trigger: "POLL",
						snapshotVersion: 5,
					}),
				}}
				onSyncNow={vi.fn()}
			/>,
		);
		const status = screen.getByRole("status");
		expect(status).toHaveTextContent("took commit 0123456");
		expect(status).toHaveTextContent(`(${copy.triggers.POLL})`);
		expect(status).not.toHaveTextContent(
			copy.outcomes.notPublished.configuration_changed,
		);
		expect(
			screen.queryByRole("button", { name: copy.syncAgainButton }),
		).not.toBeInTheDocument();
	});

	it("shows a pause with Re-enable, which reopens the configure dialog", async () => {
		const configured = CONFIGURED.configured as NonNullable<
			RepositorySyncState["configured"]
		>;
		const onConfigure = vi.fn();
		const user = userEvent.setup();
		render(
			<RepositorySyncStatus
				state={{
					...CONFIGURED,
					configured: {
						...configured,
						automatic: true,
						automaticPausedReason: "REF_MISSING",
					},
					latestRun: run({
						trigger: "POLL",
						status: "FAILED",
						error: "REF_MISSING",
					}),
				}}
				onConfigure={onConfigure}
			/>,
		);
		expect(
			screen.getByText(
				copy.pausedLine.replace(
					"{reason}",
					copy.pausedReasons.REF_MISSING,
				),
			),
		).toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: copy.reEnableButton }),
		);
		expect(onConfigure).toHaveBeenCalled();
	});

	it("names the missing branch", () => {
		render(
			<RepositorySyncStatus
				state={{
					...CONFIGURED,
					latestRun: run({ status: "FAILED", error: "REF_MISSING" }),
				}}
			/>,
		);
		expect(
			screen.getByText(copy.errors.REF_MISSING.replace("{ref}", "main")),
		).toBeInTheDocument();
	});

	it("says a run whose settings changed was not published and offers to sync again", async () => {
		const onSyncNow = vi.fn();
		const user = userEvent.setup();
		render(
			<RepositorySyncStatus
				state={{
					...CONFIGURED,
					latestRun: run({
						status: "NOT_PUBLISHED",
						error: "CONFIGURATION_CHANGED",
					}),
				}}
				onSyncNow={onSyncNow}
			/>,
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			copy.outcomes.notPublished.configuration_changed,
		);
		await user.click(
			screen.getByRole("button", { name: copy.syncAgainButton }),
		);
		expect(onSyncNow).toHaveBeenCalled();
	});

	it("calls an unfinished run with no open workflow interrupted", () => {
		render(
			<RepositorySyncStatus
				state={{
					...CONFIGURED,
					latestRun: run({ finishedAt: null, status: null }),
				}}
			/>,
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			copy.outcomes.interrupted,
		);
	});

	it("keeps the pause line dormant while automatic sync is off (PR 1)", () => {
		const configured = CONFIGURED.configured as NonNullable<
			RepositorySyncState["configured"]
		>;
		const { rerender } = render(
			<RepositorySyncStatus
				state={{
					...CONFIGURED,
					configured: {
						...configured,
						automaticPausedReason: "REF_MISSING",
					},
				}}
			/>,
		);
		expect(
			screen.queryByText(/Automatic sync paused/),
		).not.toBeInTheDocument();
		rerender(
			<RepositorySyncStatus
				state={{
					...CONFIGURED,
					configured: {
						...configured,
						automatic: true,
						automaticPausedReason: "REF_MISSING",
					},
				}}
			/>,
		);
		expect(screen.getByText(/Automatic sync paused/)).toBeInTheDocument();
	});

	it("says a configured sync's standing state even when no run has anything to report", () => {
		render(<RepositorySyncStatus state={CONFIGURED} />);

		const region = screen.getByRole("status");

		expect(region).toHaveTextContent(copy.status.automaticOff);
		expect(region).toHaveTextContent(copy.status.checkoutNote);
		// Still the region that takes no room when it has nothing in it.
		expect(region).toHaveClass("empty:sr-only");
	});

	it("mounts nothing for a project with no sync and no run", () => {
		const { container } = render(
			<RepositorySyncStatus
				state={{ ...CONFIGURED, configured: null, latestRun: null }}
			/>,
		);

		expect(container).toBeEmptyDOMElement();
	});

	it("announces into the same status region when a run starts, rather than mounting a new one", () => {
		const { rerender } = render(
			<RepositorySyncStatus state={CONFIGURED} />,
		);
		const region = screen.getByRole("status");

		rerender(
			<RepositorySyncStatus state={{ ...CONFIGURED, running: true }} />,
		);

		expect(screen.getByRole("status")).toBe(region);
		expect(region).toHaveTextContent(copy.running);
	});

	it("renders nothing for a sync that is not configured and has no run", () => {
		const { container } = render(
			<RepositorySyncStatus
				state={{ ...CONFIGURED, configured: null }}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("leaves out the last run of a sync that was switched off: it stays in History, not on the status line (Fizzy #2672)", () => {
		const { container } = render(
			<RepositorySyncStatus
				state={{
					...CONFIGURED,
					sourceOfTruth: "UPLOAD",
					configured: null,
					latestRun: run({
						status: "NOT_PUBLISHED",
						error: "CONFIGURATION_CHANGED",
						fromCurrentConfiguration: false,
					}),
				}}
				onSyncNow={vi.fn()}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
		expect(
			screen.queryByRole("button", { name: copy.syncAgainButton }),
		).not.toBeInTheDocument();
	});

	// Fizzy #2672: `running` is the project's (a sync workflow is open), not
	// this configuration's. A run left going by a switch to upload mode, or
	// by a switch-off-and-set-up-again, belongs to the sync that was switched
	// off and shows in History, not as progress of the current setup.
	it("shows no progress for a run of a sync that was switched off while it ran", () => {
		const { container } = render(
			<RepositorySyncStatus
				state={{
					...CONFIGURED,
					sourceOfTruth: "UPLOAD",
					configured: null,
					running: true,
					latestRun: run({
						finishedAt: null,
						status: null,
						snapshotVersion: null,
						fromCurrentConfiguration: false,
					}),
				}}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
		expect(screen.queryByText(copy.running)).not.toBeInTheDocument();
	});

	it("shows no progress when a run is open but no sync is configured and no receipt is in yet", () => {
		const { container } = render(
			<RepositorySyncStatus
				state={{
					...CONFIGURED,
					sourceOfTruth: "UPLOAD",
					configured: null,
					running: true,
				}}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("shows no progress for the sync set up again while the switched-off one's run is still open", () => {
		render(
			<RepositorySyncStatus
				state={{
					...CONFIGURED,
					running: true,
					latestRun: run({
						finishedAt: null,
						status: null,
						snapshotVersion: null,
						fromCurrentConfiguration: false,
					}),
				}}
			/>,
		);
		expect(screen.queryByText(copy.running)).not.toBeInTheDocument();
	});

	it("still shows progress for a run of the current configuration", () => {
		render(
			<RepositorySyncStatus
				state={{
					...CONFIGURED,
					running: true,
					latestRun: run({
						finishedAt: null,
						status: null,
						snapshotVersion: null,
					}),
				}}
			/>,
		);
		expect(screen.getByText(copy.running)).toBeInTheDocument();
	});
});

describe("RepositorySyncRuns (§7.3 History list)", () => {
	it("lists each run with its time, trigger, outcome, commit, version and member", async () => {
		m.listRuns.mockResolvedValue({
			runs: [
				run(),
				run({
					id: "sync_1:run_b",
					trigger: "POLL",
					status: "FAILED",
					error: "CLONE_FAILED",
					snapshotVersion: null,
					commitSha: null,
				}),
				run({
					id: "sync_1:run_c",
					trigger: "WEBHOOK",
					status: "UNCHANGED",
				}),
			],
		});
		render(<RepositorySyncRuns projectId="proj_1" running={false} />, {
			wrapper: Providers,
		});
		expect(
			await screen.findByText(
				/Sync now · took commit 0123456 · version 4 · by Example Member/,
			),
		).toBeInTheDocument();
		expect(screen.getByText(/Scheduled · failed/)).toBeInTheDocument();
		expect(
			screen.getByText(/Push · no changes since the published version/),
		).toBeInTheDocument();
		// The raw enum value is never shown.
		expect(
			screen.queryByText(/MANUAL|POLL|WEBHOOK/),
		).not.toBeInTheDocument();
	});

	it("says when there are no runs", async () => {
		render(<RepositorySyncRuns projectId="proj_1" running={false} />, {
			wrapper: Providers,
		});
		expect(await screen.findByText(copy.runs.empty)).toBeInTheDocument();
	});

	it("marks only the runs of a sync that was switched off (Fizzy #2672)", async () => {
		m.listRuns.mockResolvedValue({
			runs: [
				run({ id: "sync_2:run_b", trigger: "POLL" }),
				run({
					id: "sync_1:run_a",
					status: "NOT_PUBLISHED",
					error: "CONFIGURATION_CHANGED",
					fromCurrentConfiguration: false,
				}),
			],
		});
		render(<RepositorySyncRuns projectId="proj_1" running={false} />, {
			wrapper: Providers,
		});
		const items = await screen.findAllByRole("listitem");
		expect(items).toHaveLength(2);
		expect(items[0]).not.toHaveTextContent(copy.runs.previousConfiguration);
		expect(items[1]).toHaveTextContent(copy.runs.previousConfiguration);
		expect(items[1]).toHaveTextContent(
			copy.outcomes.notPublished.configuration_changed,
		);
	});
});

describe("RepositorySyncSettingsSection (§7.4)", () => {
	function renderSection(
		state: RepositorySyncState,
		onChanged = vi.fn(async (): Promise<void> => {}),
	) {
		const onChange = vi.fn();
		render(
			<RepositorySyncSettingsSection
				projectId="proj_1"
				state={state}
				onChange={onChange}
				onChanged={onChanged}
			/>,
			{ wrapper: Providers },
		);
		return { onChange, onChanged };
	}

	it("shows the configuration read-only with Change… and a confirmed switch to upload mode", async () => {
		const user = userEvent.setup();
		const { onChange, onChanged } = renderSection(CONFIGURED);

		expect(
			screen.getByText("example-org/instructions"),
		).toBeInTheDocument();
		expect(screen.getByText("main")).toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: copy.settings.changeButton }),
		);
		expect(onChange).toHaveBeenCalled();

		await user.click(
			screen.getByRole("button", { name: copy.settings.switchToUpload }),
		);
		expect(m.confirm).toHaveBeenCalledWith(
			expect.objectContaining({
				title: copy.settings.switchConfirmTitle,
				message: copy.settings.switchConfirm.replace(
					"{repository}",
					"example-org/instructions",
				),
				confirmLabel: copy.settings.switchToUpload,
				destructive: true,
			}),
		);
		// The run history survives the switch, and the confirmation says so.
		expect(copy.settings.switchConfirm).toContain("Sync history is kept.");
		await waitFor(() =>
			expect(m.disable).toHaveBeenCalledWith({ projectId: "proj_1" }),
		);
		await waitFor(() => expect(onChanged).toHaveBeenCalled());
	});

	it("warns that a run in progress will not publish", async () => {
		m.confirm.mockImplementation(() => undefined);
		const user = userEvent.setup();
		renderSection({ ...CONFIGURED, running: true });
		await user.click(
			screen.getByRole("button", { name: copy.settings.switchToUpload }),
		);
		expect(m.confirm).toHaveBeenCalledWith(
			expect.objectContaining({
				message: copy.settings.switchConfirmRunning.replace(
					"{repository}",
					"example-org/instructions",
				),
			}),
		);
		expect(copy.settings.switchConfirmRunning).toContain(
			"Sync history is kept.",
		);
		expect(m.disable).not.toHaveBeenCalled();
	});

	it("never locks a project left in repository mode with nothing configured", () => {
		renderSection({ ...CONFIGURED, configured: null });
		expect(
			screen.getByText(copy.settings.disconnected),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: copy.settings.switchToUpload }),
		).toBeInTheDocument();
	});

	it("turns automatic sync on through configure with the current values", async () => {
		const user = userEvent.setup();
		const { onChanged } = renderSection(CONFIGURED);
		const toggle = screen.getByRole("switch", {
			name: copy.settings.automatic,
		});
		expect(toggle).not.toBeChecked();
		expect(
			screen.getByText(copy.settings.automaticHint),
		).toBeInTheDocument();

		await user.click(toggle);

		await waitFor(() =>
			expect(m.configure).toHaveBeenCalledWith({
				projectId: "proj_1",
				repositoryIntegrationId: "int_1",
				ref: "main",
				rootPath: "agents",
				automatic: true,
			}),
		);
		await waitFor(() =>
			expect(m.toastSuccess).toHaveBeenCalledWith(
				copy.settings.automaticTurnedOn,
			),
		);
		expect(onChanged).toHaveBeenCalled();
	});

	it("turns automatic sync off the same way", async () => {
		const configured = CONFIGURED.configured as NonNullable<
			RepositorySyncState["configured"]
		>;
		const user = userEvent.setup();
		renderSection({
			...CONFIGURED,
			configured: { ...configured, automatic: true },
		});
		await user.click(
			screen.getByRole("switch", { name: copy.settings.automatic }),
		);
		await waitFor(() =>
			expect(m.configure).toHaveBeenCalledWith(
				expect.objectContaining({ automatic: false }),
			),
		);
		await waitFor(() =>
			expect(m.toastSuccess).toHaveBeenCalledWith(
				copy.settings.automaticTurnedOff,
			),
		);
	});

	it("reports a refused toggle with the configure dialog's copy", async () => {
		m.configure.mockRejectedValue(orpcError("BRANCH_NOT_FOUND"));
		const user = userEvent.setup();
		const { onChanged } = renderSection(CONFIGURED);
		await user.click(
			screen.getByRole("switch", { name: copy.settings.automatic }),
		);
		await waitFor(() =>
			expect(m.toastError).toHaveBeenCalledWith(
				copy.configureDialog.errors.BRANCH_NOT_FOUND.replace(
					"{ref}",
					"main",
				),
			),
		);
		expect(onChanged).not.toHaveBeenCalled();
	});

	it("disables every settings action while a toggle is saving, so two changes never race (Decision 40)", async () => {
		let finish: (value: { syncId: string; generation: number }) => void =
			() => {};
		m.configure.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const user = userEvent.setup();
		renderSection(CONFIGURED);
		await user.click(
			screen.getByRole("switch", { name: copy.settings.automatic }),
		);

		await waitFor(() =>
			expect(
				screen.getByRole("switch", { name: copy.settings.automatic }),
			).toBeDisabled(),
		);
		expect(
			screen.getByRole("button", { name: copy.settings.changeButton }),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: copy.settings.switchToUpload }),
		).toBeDisabled();

		finish({ syncId: "sync_1", generation: 2 });
		await waitFor(() =>
			expect(
				screen.getByRole("switch", { name: copy.settings.automatic }),
			).toBeEnabled(),
		);
		expect(
			screen.getByRole("button", { name: copy.settings.changeButton }),
		).toBeEnabled();
		expect(m.configure).toHaveBeenCalledTimes(1);
	});

	it("disables the toggle and Change… while a switch to upload mode is in flight (Decision 40)", async () => {
		m.disable.mockImplementation(() => new Promise(() => {}));
		const user = userEvent.setup();
		renderSection(CONFIGURED);
		await user.click(
			screen.getByRole("button", { name: copy.settings.switchToUpload }),
		);

		await waitFor(() =>
			expect(
				screen.getByRole("switch", { name: copy.settings.automatic }),
			).toBeDisabled(),
		);
		expect(
			screen.getByRole("button", { name: copy.settings.changeButton }),
		).toBeDisabled();
		expect(m.configure).not.toHaveBeenCalled();
	});

	it("keeps every settings action disabled until the tab has re-read what a switch to upload mode changed (Decision 53)", async () => {
		let settle: () => void = () => {};
		const onChanged = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					settle = resolve;
				}),
		);
		const user = userEvent.setup();
		renderSection(CONFIGURED, onChanged);
		await user.click(
			screen.getByRole("button", { name: copy.settings.switchToUpload }),
		);

		// The switch succeeded and the tab is re-reading. Until it has, the
		// section still shows the configuration the switch removed.
		await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
		expect(m.toastSuccess).toHaveBeenCalledWith(copy.settings.switched);
		const toggle = screen.getByRole("switch", {
			name: copy.settings.automatic,
		});
		expect(toggle).toBeDisabled();
		expect(
			screen.getByRole("button", { name: copy.settings.changeButton }),
		).toBeDisabled();
		// A click on the stale toggle builds no change from that configuration.
		await user.click(toggle);
		expect(m.configure).not.toHaveBeenCalled();

		settle();
		await waitFor(() =>
			expect(
				screen.getByRole("switch", { name: copy.settings.automatic }),
			).toBeEnabled(),
		);
		expect(m.configure).not.toHaveBeenCalled();
	});

	// Fizzy #2563 spec §12, §16.1-§16.2: an owner lets read-only members
	// propose as pull requests. Its own procedure, which never bumps the
	// generation, so turning it on or off never fails an in-flight proposal.
	it("lets a configurer allow read-only members to propose as pull requests, saying a merged proposal syncs even with automatic sync off", async () => {
		const user = userEvent.setup();
		const { onChanged } = renderSection(CONFIGURED);
		const toggle = screen.getByRole("switch", {
			name: copy.settings.readerProposalsLabel,
		});
		expect(toggle).not.toBeChecked();
		expect(toggle).toHaveAccessibleDescription(
			copy.settings.readerProposalsHint,
		);
		expect(copy.settings.readerProposalsHint).toContain(
			"A merged suggestion syncs even while automatic sync is off.",
		);

		await user.click(toggle);

		await waitFor(() =>
			expect(m.updateProposalSettings).toHaveBeenCalledWith({
				projectId: "proj_1",
				allowReaderProposals: true,
			}),
		);
		await waitFor(() =>
			expect(m.toastSuccess).toHaveBeenCalledWith(
				copy.settings.readerProposalsTurnedOn,
			),
		);
		expect(onChanged).toHaveBeenCalled();
		// Not through configure, which re-delegates the sync to the caller
		// and bumps the generation when what is synced changes.
		expect(m.configure).not.toHaveBeenCalled();
	});

	it("turns read-only proposals off the same way", async () => {
		const configured = CONFIGURED.configured as NonNullable<
			RepositorySyncState["configured"]
		>;
		const user = userEvent.setup();
		renderSection({
			...CONFIGURED,
			configured: { ...configured, allowReaderProposals: true },
		});
		const toggle = screen.getByRole("switch", {
			name: copy.settings.readerProposalsLabel,
		});
		expect(toggle).toBeChecked();
		await user.click(toggle);
		await waitFor(() =>
			expect(m.updateProposalSettings).toHaveBeenCalledWith({
				projectId: "proj_1",
				allowReaderProposals: false,
			}),
		);
		await waitFor(() =>
			expect(m.toastSuccess).toHaveBeenCalledWith(
				copy.settings.readerProposalsTurnedOff,
			),
		);
	});

	it("reports a refused reader-proposal toggle and re-reads nothing", async () => {
		m.updateProposalSettings.mockRejectedValue(new Error("Not configured"));
		const user = userEvent.setup();
		const { onChanged } = renderSection(CONFIGURED);
		await user.click(
			screen.getByRole("switch", {
				name: copy.settings.readerProposalsLabel,
			}),
		);
		await waitFor(() =>
			expect(m.toastError).toHaveBeenCalledWith(
				copy.actionErrors.updateProposalSettings,
			),
		);
		expect(onChanged).not.toHaveBeenCalled();
	});

	it("reports a failed switch to upload mode in the tab's own words, never the server's", async () => {
		m.disable.mockRejectedValue(new Error("upstream said no"));
		const user = userEvent.setup();
		renderSection(CONFIGURED);
		await user.click(
			screen.getByRole("button", { name: copy.settings.switchToUpload }),
		);
		await waitFor(() =>
			expect(m.toastError).toHaveBeenCalledWith(
				copy.actionErrors.disable,
			),
		);
		expect(m.toastError).not.toHaveBeenCalledWith("upstream said no");
	});

	it("disables every settings action while the reader-proposal toggle saves (Decision 40)", async () => {
		let finish: (value: unknown) => void = () => {};
		m.updateProposalSettings.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const user = userEvent.setup();
		renderSection(CONFIGURED);
		await user.click(
			screen.getByRole("switch", {
				name: copy.settings.readerProposalsLabel,
			}),
		);
		await waitFor(() =>
			expect(
				screen.getByRole("switch", { name: copy.settings.automatic }),
			).toBeDisabled(),
		);
		expect(
			screen.getByRole("switch", {
				name: copy.settings.readerProposalsLabel,
			}),
		).toBeDisabled();
		expect(
			screen.getByRole("button", { name: copy.settings.changeButton }),
		).toBeDisabled();
		finish({ allowReaderProposals: true, generation: 1 });
		await waitFor(() =>
			expect(
				screen.getByRole("switch", {
					name: copy.settings.readerProposalsLabel,
				}),
			).toBeEnabled(),
		);
	});

	it("shows a reader whether read-only members may propose, as text", () => {
		const configured = CONFIGURED.configured as NonNullable<
			RepositorySyncState["configured"]
		>;
		renderSection({
			...CONFIGURED,
			canConfigure: false,
			configured: { ...configured, allowReaderProposals: true },
		});
		expect(
			screen.getByText(copy.settings.readerProposalsOn),
		).toBeInTheDocument();
		expect(screen.queryByRole("switch")).not.toBeInTheDocument();
	});

	it("shows a reader the configuration and the automatic state without the actions", () => {
		renderSection({ ...CONFIGURED, canConfigure: false });
		expect(
			screen.getByText("example-org/instructions"),
		).toBeInTheDocument();
		expect(
			screen.getByText(copy.settings.automaticOff),
		).toBeInTheDocument();
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
		expect(screen.queryByRole("switch")).not.toBeInTheDocument();
	});
});

describe("RepositorySyncSettingsSection — what syncs (Fizzy #2750 §6)", () => {
	function renderSection(state: RepositorySyncState = CONFIGURED) {
		render(
			<RepositorySyncSettingsSection
				projectId="proj_1"
				state={state}
				onChange={vi.fn()}
				onChanged={vi.fn(async (): Promise<void> => {})}
			/>,
			{ wrapper: Providers },
		);
		return screen.getByTestId("instructions-sync-selection-summary");
	}

	it("names the folder, without a count, since no listing is read here", async () => {
		m.getSettings.mockResolvedValue({
			ignoreGlobs: [],
			defaultIgnoreGlobs: [...DEFAULT_IGNORE_GLOBS],
			sourceOfTruth: "REPOSITORY",
		});
		const summary = renderSection();
		await waitFor(() => expect(m.getSettings).toHaveBeenCalled());
		expect(summary).toHaveTextContent(
			copy.summary.lead.replace("{folder}", "agents"),
		);
		expect(summary).not.toHaveTextContent(
			copy.summary.projectRulesLeaveOut,
		);
		expect(summary).not.toHaveTextContent(/match/);
	});

	it("says the project's rules leave some files out when it has any, its own or the defaults", async () => {
		m.getSettings.mockResolvedValue({
			ignoreGlobs: null,
			defaultIgnoreGlobs: [...DEFAULT_IGNORE_GLOBS],
			sourceOfTruth: "REPOSITORY",
		});
		const summary = renderSection();
		await waitFor(() =>
			expect(summary).toHaveTextContent(
				copy.summary.projectRulesLeaveOut,
			),
		);
	});

	it("names the whole repository for the repository root", () => {
		const summary = renderSection({
			...CONFIGURED,
			configured: {
				...(CONFIGURED.configured as NonNullable<
					RepositorySyncState["configured"]
				>),
				rootPath: "",
			},
		});
		expect(summary).toHaveTextContent(copy.summary.leadRoot);
	});
});
