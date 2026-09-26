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

	it("seeds the branch from the integration, configures, starts the first sync, and closes", async () => {
		const user = userEvent.setup();
		const { onOpenChange, onSaved } = renderDialog();

		expect(
			screen.getByLabelText(copy.configureDialog.branchLabel),
		).toHaveValue("develop");
		expect(
			screen.getByText("example-org/instructions"),
		).toBeInTheDocument();
		expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
		expect(
			screen.getByText(copy.configureDialog.afterSyncNotice),
		).toBeInTheDocument();
		expect(
			screen.getByRole("checkbox", {
				name: copy.configureDialog.automaticLabel,
			}),
		).toBeChecked();

		await user.type(
			screen.getByLabelText(copy.configureDialog.rootPathLabel),
			"agents/",
		);
		await user.click(
			screen.getByRole("button", { name: copy.configureDialog.submit }),
		);

		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(m.configure).toHaveBeenCalledWith({
			projectId: "proj_1",
			repositoryIntegrationId: "int_1",
			ref: "develop",
			rootPath: "agents/",
			automatic: true,
		});
		expect(m.syncNow).toHaveBeenCalledWith({ projectId: "proj_1" });
		expect(m.toastSuccess).toHaveBeenCalledWith(copy.syncNowResult.started);
		expect(onSaved).toHaveBeenCalled();
	});

	it("offers a choice when the project has more than one repository, and reseeds the branch", async () => {
		const user = userEvent.setup();
		renderDialog({ integrations: [INTEGRATION, SECOND] });
		await user.selectOptions(
			screen.getByLabelText(copy.configureDialog.repositoryLabel),
			"int_2",
		);
		expect(
			screen.getByLabelText(copy.configureDialog.branchLabel),
		).toHaveValue("trunk");
		expect(
			screen.getByRole("option", {
				name: "Azure DevOps · example-org/agents",
			}),
		).toBeInTheDocument();
	});

	it("keeps a missing branch inline, starts nothing, and stays open", async () => {
		m.configure.mockRejectedValue(orpcError("BRANCH_NOT_FOUND"));
		const user = userEvent.setup();
		const { onOpenChange } = renderDialog();
		await user.click(
			screen.getByRole("button", { name: copy.configureDialog.submit }),
		);

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
		await user.click(
			screen.getByRole("button", { name: copy.configureDialog.submit }),
		);
		await waitFor(() =>
			expect(m.toastError).toHaveBeenCalledWith(
				copy.configureDialog.errors.REPOSITORY_UNREACHABLE,
			),
		);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("seeds from the current configuration when changing it", () => {
		renderDialog({ current: CONFIGURED.configured });
		expect(
			screen.getByLabelText(copy.configureDialog.branchLabel),
		).toHaveValue("main");
		expect(
			screen.getByLabelText(copy.configureDialog.rootPathLabel),
		).toHaveValue("agents");
	});

	it("sends automatic: false when the member unticks Keep in sync automatically", async () => {
		const user = userEvent.setup();
		const { onOpenChange } = renderDialog();
		await user.click(
			screen.getByRole("checkbox", {
				name: copy.configureDialog.automaticLabel,
			}),
		);
		await user.click(
			screen.getByRole("button", { name: copy.configureDialog.submit }),
		);
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(m.configure).toHaveBeenCalledWith(
			expect.objectContaining({ automatic: false }),
		);
	});

	it("seeds the checkbox from the current configuration and says whom automatic runs publish as", () => {
		renderDialog({ current: CONFIGURED.configured });
		expect(
			screen.getByRole("checkbox", {
				name: copy.configureDialog.automaticLabel,
			}),
		).not.toBeChecked();
		expect(
			screen.getByText(copy.configureDialog.automaticHint),
		).toBeInTheDocument();
	});

	it("reports a run that was already going without calling it a failure", async () => {
		m.syncNow.mockResolvedValue({
			started: false,
			reason: "already_running",
		});
		const user = userEvent.setup();
		renderDialog();
		await user.click(
			screen.getByRole("button", { name: copy.configureDialog.submit }),
		);
		await waitFor(() =>
			expect(m.toastInfo).toHaveBeenCalledWith(
				copy.syncNowResult.already_running,
			),
		);
		expect(m.toastError).not.toHaveBeenCalled();
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
		await user.click(
			screen.getByRole("button", { name: copy.configureDialog.submit }),
		);
		const errors = copy.configureDialog.errors as Record<string, string>;
		expect(await screen.findByRole("alert")).toHaveTextContent(
			errors[code].replace("{ref}", "develop"),
		);
		expect(m.syncNow).not.toHaveBeenCalled();
	});

	// B-2 (Task 9 review): the inline error used to mark the branch field
	// invalid no matter which field the error was actually about.
	it("points the inline error at the folder field for INVALID_ROOT_PATH, leaving the branch field alone", async () => {
		m.configure.mockRejectedValue(orpcError("INVALID_ROOT_PATH"));
		const user = userEvent.setup();
		renderDialog();
		await user.click(
			screen.getByRole("button", { name: copy.configureDialog.submit }),
		);
		await screen.findByRole("alert");
		expect(
			screen.getByLabelText(copy.configureDialog.rootPathLabel),
		).toHaveAttribute("aria-invalid", "true");
		expect(
			screen.getByLabelText(copy.configureDialog.branchLabel),
		).not.toHaveAttribute("aria-invalid");
	});

	it("points the inline error at the branch field for BRANCH_NOT_FOUND, leaving the folder field alone", async () => {
		m.configure.mockRejectedValue(orpcError("BRANCH_NOT_FOUND"));
		const user = userEvent.setup();
		renderDialog();
		await user.click(
			screen.getByRole("button", { name: copy.configureDialog.submit }),
		);
		await screen.findByRole("alert");
		expect(
			screen.getByLabelText(copy.configureDialog.branchLabel),
		).toHaveAttribute("aria-invalid", "true");
		expect(
			screen.getByLabelText(copy.configureDialog.rootPathLabel),
		).not.toHaveAttribute("aria-invalid");
	});

	it("leaves both fields unattached for a repository-level inline error", async () => {
		m.configure.mockRejectedValue(orpcError("REPOSITORY_NOT_FOUND"));
		const user = userEvent.setup();
		renderDialog();
		await user.click(
			screen.getByRole("button", { name: copy.configureDialog.submit }),
		);
		await screen.findByRole("alert");
		expect(
			screen.getByLabelText(copy.configureDialog.branchLabel),
		).not.toHaveAttribute("aria-invalid");
		expect(
			screen.getByLabelText(copy.configureDialog.rootPathLabel),
		).not.toHaveAttribute("aria-invalid");
	});

	it("disables Submit while the branch is empty or whitespace", async () => {
		const user = userEvent.setup();
		renderDialog();
		const branchInput = screen.getByLabelText(
			copy.configureDialog.branchLabel,
		);
		await user.clear(branchInput);
		expect(
			screen.getByRole("button", { name: copy.configureDialog.submit }),
		).toBeDisabled();
		await user.type(branchInput, "   ");
		expect(
			screen.getByRole("button", { name: copy.configureDialog.submit }),
		).toBeDisabled();
	});

	it("still calls onSaved and closes when configure saves but syncNow rejects", async () => {
		m.syncNow.mockRejectedValue(new Error("boom"));
		const user = userEvent.setup();
		const { onOpenChange, onSaved } = renderDialog();
		await user.click(
			screen.getByRole("button", { name: copy.configureDialog.submit }),
		);
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(m.toastError).toHaveBeenCalledWith("boom");
		expect(onSaved).toHaveBeenCalled();
	});

	it("toasts when syncNow reports the repository connection is unavailable", async () => {
		m.syncNow.mockResolvedValue({
			started: false,
			reason: "integration_unavailable",
		});
		const user = userEvent.setup();
		renderDialog();
		await user.click(
			screen.getByRole("button", { name: copy.configureDialog.submit }),
		);
		await waitFor(() =>
			expect(m.toastError).toHaveBeenCalledWith(
				copy.syncNowResult.integration_unavailable,
			),
		);
	});

	describe("folder browser (Fizzy #2725)", () => {
		const TREE = {
			supported: true,
			truncated: false,
			entries: [
				{ path: "agents", type: "dir" },
				{ path: "agents/CLAUDE.md", type: "file" },
				{ path: "tools", type: "dir" },
				{ path: "tools/claude", type: "dir" },
			],
		};

		async function treeGroup() {
			return screen.findByRole("radiogroup", { name: copy.tree.label });
		}

		it("lists the chosen repository's branch between the branch and folder fields", async () => {
			m.listTree.mockResolvedValue(TREE);
			renderDialog();
			const group = await treeGroup();
			expect(m.listTree).toHaveBeenCalledWith({
				projectId: "proj_1",
				repositoryIntegrationId: "int_1",
				ref: "develop",
			});
			const branch = screen.getByLabelText(
				copy.configureDialog.branchLabel,
			);
			const folder = screen.getByLabelText(
				copy.configureDialog.rootPathLabel,
			);
			expect(
				branch.compareDocumentPosition(group) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
			expect(
				group.compareDocumentPosition(folder) &
					Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy();
		});

		it("writes a picked folder to the folder field, clears the inline error, and saves it", async () => {
			m.listTree.mockResolvedValue(TREE);
			m.configure.mockRejectedValueOnce(orpcError("INVALID_ROOT_PATH"));
			const user = userEvent.setup();
			const { onOpenChange } = renderDialog();
			const group = await treeGroup();

			await user.click(
				screen.getByRole("button", {
					name: copy.configureDialog.submit,
				}),
			);
			await screen.findByRole("alert");

			await user.click(
				within(group).getByRole("radio", { name: "tools/claude" }),
			);
			expect(
				screen.getByLabelText(copy.configureDialog.rootPathLabel),
			).toHaveValue("tools/claude");
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
			expect(
				screen.getByLabelText(copy.configureDialog.rootPathLabel),
			).not.toHaveAttribute("aria-invalid");

			await user.click(
				screen.getByRole("button", {
					name: copy.configureDialog.submit,
				}),
			);
			await waitFor(() =>
				expect(onOpenChange).toHaveBeenCalledWith(false),
			);
			expect(m.configure).toHaveBeenLastCalledWith(
				expect.objectContaining({ rootPath: "tools/claude" }),
			);
		});

		it("selects the stored folder's row when changing a configuration, and typing moves the selection", async () => {
			m.listTree.mockResolvedValue(TREE);
			const user = userEvent.setup();
			renderDialog({ current: CONFIGURED.configured });
			const group = await treeGroup();
			expect(
				within(group).getByRole("radio", { name: "agents" }),
			).toBeChecked();

			const folder = screen.getByLabelText(
				copy.configureDialog.rootPathLabel,
			);
			await user.clear(folder);
			expect(
				within(group).getByRole("radio", {
					name: copy.tree.repositoryRoot,
				}),
			).toBeChecked();
			await user.type(folder, "tools/claude/");
			expect(
				within(group).getByRole("radio", { name: "tools/claude" }),
			).toBeChecked();
		});

		it("keeps the typed folder working when the provider has no listing", async () => {
			m.listTree.mockResolvedValue({
				supported: false,
				entries: [],
				truncated: false,
			});
			const user = userEvent.setup();
			renderDialog();
			expect(
				await screen.findByText(copy.tree.unsupported),
			).toBeInTheDocument();
			await user.type(
				screen.getByLabelText(copy.configureDialog.rootPathLabel),
				"agents",
			);
			await user.click(
				screen.getByRole("button", {
					name: copy.configureDialog.submit,
				}),
			);
			await waitFor(() =>
				expect(m.configure).toHaveBeenCalledWith(
					expect.objectContaining({ rootPath: "agents" }),
				),
			);
		});
	});

	describe("folder exclusions (Fizzy #2726)", () => {
		const TREE = {
			supported: true,
			truncated: false,
			entries: [
				{ path: "agents", type: "dir" },
				{ path: "agents/skills", type: "dir" },
				{ path: "agents/drafts", type: "dir" },
				{ path: "tools", type: "dir" },
				{ path: "tools/claude", type: "dir" },
			],
		};
		const ex = copy.tree.exclusions;
		const exclude = (path: string) =>
			screen.getByRole("checkbox", {
				name: ex.toggleLabel.replace("{path}", path),
			});
		const submit = () =>
			screen.getByRole("button", { name: copy.configureDialog.submit });
		const treeGroup = () =>
			screen.getByRole("radiogroup", { name: copy.tree.label });

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
				defaultIgnoreGlobs: [],
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

		/** The dialog on the stored folder `agents`, its browser listed. */
		async function renderOnAgents(
			props: Partial<
				Parameters<typeof ConfigureRepositorySyncDialog>[0]
			> = {},
		) {
			m.listTree.mockResolvedValue(TREE);
			const rendered = renderDialog({
				current: CONFIGURED.configured,
				...props,
			});
			await screen.findByRole("radiogroup", { name: copy.tree.label });
			await waitFor(() => expect(exclude("agents/skills")).toBeEnabled());
			return rendered;
		}

		it("sends the staged exclusions WITH the configuration, never as a separate write, then starts the sync", async () => {
			const user = userEvent.setup();
			const { onOpenChange, onSaved } = await renderOnAgents();

			await user.click(exclude("agents/skills"));
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
				automatic: false,
				ignoreGlobs: [...DEFAULT_IGNORE_GLOBS, "skills/**"],
			});
			expect(m.syncNow).toHaveBeenCalledWith({ projectId: "proj_1" });
			expect(m.configure.mock.invocationCallOrder[0]).toBeLessThan(
				m.syncNow.mock.invocationCallOrder[0] ?? 0,
			);
			expect(onSaved).toHaveBeenCalled();
		});

		it("removes a turned-off folder's own rule from the project's list", async () => {
			stored = ["dist/**", "skills/**"];
			const user = userEvent.setup();
			const { onOpenChange } = await renderOnAgents();
			expect(exclude("agents/skills")).toBeChecked();

			await user.click(exclude("agents/skills"));
			await user.click(submit());

			await waitFor(() =>
				expect(onOpenChange).toHaveBeenCalledWith(false),
			);
			expect(configured().ignoreGlobs).toEqual(["dist/**"]);
		});

		it("applies the staged edits to the rules as saved at Save, keeping a rule saved elsewhere meanwhile", async () => {
			stored = ["dist/**"];
			const user = userEvent.setup();
			const { onOpenChange } = await renderOnAgents();
			await user.click(exclude("agents/skills"));
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

		it("sends no rules when none changed, a toggle turned on and back off included", async () => {
			const user = userEvent.setup();
			const { onOpenChange } = await renderOnAgents();

			await user.click(exclude("agents/skills"));
			await user.click(exclude("agents/skills"));
			await user.click(submit());

			await waitFor(() =>
				expect(onOpenChange).toHaveBeenCalledWith(false),
			);
			expect(configured()).not.toHaveProperty("ignoreGlobs");
			expect(m.syncNow).toHaveBeenCalled();
		});

		it("sends no rules when the fresh list already has the staged change", async () => {
			const user = userEvent.setup();
			const { onOpenChange } = await renderOnAgents();
			await user.click(exclude("agents/skills"));
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
			await user.click(exclude("agents/skills"));
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
			await user.click(
				within(treeGroup()).getByRole("radio", { name: "tools" }),
			);
			await waitFor(() => expect(exclude("tools/claude")).toBeEnabled());
			await user.click(exclude("tools/claude"));

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
			expect(exclude("tools/claude")).toBeChecked();
		});

		it("sends the staged rules again on a retry after a failed configure", async () => {
			m.configure.mockRejectedValueOnce(
				orpcError("REPOSITORY_UNREACHABLE"),
			);
			const user = userEvent.setup();
			const { onOpenChange } = await renderOnAgents();
			await user.click(exclude("agents/skills"));

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

		it("drops the staged exclusions when another folder is chosen, from the browser or typed", async () => {
			const user = userEvent.setup();
			await renderOnAgents();

			await user.click(exclude("agents/skills"));
			await user.click(
				within(treeGroup()).getByRole("radio", { name: "tools" }),
			);
			await user.click(
				within(treeGroup()).getByRole("radio", { name: "agents" }),
			);
			expect(exclude("agents/skills")).not.toBeChecked();

			await user.click(exclude("agents/skills"));
			const folder = screen.getByLabelText(
				copy.configureDialog.rootPathLabel,
			);
			await user.clear(folder);
			await user.type(folder, "agents");
			expect(exclude("agents/skills")).not.toBeChecked();

			// Re-spelling the same folder keeps them.
			await user.click(exclude("agents/skills"));
			await user.type(folder, "/");
			expect(exclude("agents/skills")).toBeChecked();
		});

		it("drops the staged exclusions when the branch changes", async () => {
			const user = userEvent.setup();
			const { onOpenChange } = await renderOnAgents();
			await user.click(exclude("agents/skills"));

			const branchField = screen.getByLabelText(
				copy.configureDialog.branchLabel,
			);
			await user.type(branchField, "-next");
			await waitFor(() =>
				expect(m.listTree).toHaveBeenCalledWith(
					expect.objectContaining({ ref: "main-next" }),
				),
			);
			await waitFor(() => expect(exclude("agents/skills")).toBeEnabled());
			expect(exclude("agents/skills")).not.toBeChecked();

			// Trailing spaces are the same branch: the edits stay.
			await user.click(exclude("agents/skills"));
			await user.type(branchField, "  ");
			expect(exclude("agents/skills")).toBeChecked();
			await user.clear(branchField);
			await user.type(branchField, "main-next");
			await waitFor(() => expect(exclude("agents/skills")).toBeEnabled());
			expect(exclude("agents/skills")).not.toBeChecked();

			await user.click(submit());
			await waitFor(() =>
				expect(onOpenChange).toHaveBeenCalledWith(false),
			);
			expect(configured()).not.toHaveProperty("ignoreGlobs");
		});

		it("drops the staged exclusions when another repository is chosen", async () => {
			const user = userEvent.setup();
			const { onOpenChange } = await renderOnAgents({
				integrations: [INTEGRATION, SECOND],
			});

			await user.click(exclude("agents/skills"));
			await user.selectOptions(
				screen.getByLabelText(copy.configureDialog.repositoryLabel),
				"int_2",
			);
			await waitFor(() => expect(exclude("agents/skills")).toBeEnabled());
			expect(exclude("agents/skills")).not.toBeChecked();

			await user.click(submit());
			await waitFor(() =>
				expect(onOpenChange).toHaveBeenCalledWith(false),
			);
			expect(configured()).not.toHaveProperty("ignoreGlobs");
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

	it("shows the last run's outcome, version and member", () => {
		render(
			<RepositorySyncStatus
				state={{ ...CONFIGURED, latestRun: run() }}
			/>,
		);
		expect(screen.getByRole("status")).toHaveTextContent(
			"published version 4",
		);
		expect(screen.getByRole("status")).toHaveTextContent("Example Member");
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
		expect(status).toHaveTextContent("published version 5");
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

	it("renders nothing with no run, no pause and nothing running", () => {
		const { container } = render(
			<RepositorySyncStatus state={CONFIGURED} />,
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
				/Sync now · published version 4 · commit 0123456 · version 4 · by Example Member/,
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
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
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
		expect(confirm).toHaveBeenCalledWith(
			copy.settings.switchConfirm.replace(
				"{repository}",
				"example-org/instructions",
			),
		);
		// The run history survives the switch, and the confirmation says so.
		expect(copy.settings.switchConfirm).toContain("Sync history is kept.");
		await waitFor(() =>
			expect(m.disable).toHaveBeenCalledWith({ projectId: "proj_1" }),
		);
		await waitFor(() => expect(onChanged).toHaveBeenCalled());
	});

	it("warns that a run in progress will not publish", async () => {
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		const user = userEvent.setup();
		renderSection({ ...CONFIGURED, running: true });
		await user.click(
			screen.getByRole("button", { name: copy.settings.switchToUpload }),
		);
		expect(confirm).toHaveBeenCalledWith(
			copy.settings.switchConfirmRunning.replace(
				"{repository}",
				"example-org/instructions",
			),
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
		vi.spyOn(window, "confirm").mockReturnValue(true);
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
		vi.spyOn(window, "confirm").mockReturnValue(true);
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
		// Not through configure: that would bump the generation.
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
			expect(m.toastError).toHaveBeenCalledWith("Not configured"),
		);
		expect(onChanged).not.toHaveBeenCalled();
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
