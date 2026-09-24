/**
 * The repository-sync pieces of the Coding Instructions tab (design
 * 2026-09-23 §7.2-§7.4). Like the sibling suites, this resolves the REAL
 * `en.json` copy and throws on a missing key, so a component that asks for a
 * key nobody wrote fails here rather than rendering the key.
 */
import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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
	syncNow: vi.fn(),
	disable: vi.fn(),
	listRuns: vi.fn(),
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
	m.syncNow.mockResolvedValue({ started: true });
	m.disable.mockResolvedValue({ disabled: true, hadConfiguration: true });
	m.listRuns.mockResolvedValue({ runs: [] });
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
});

describe("RepositorySyncRuns (§7.3 History list)", () => {
	it("lists each run with its outcome, commit, version and member, and no trigger column", async () => {
		m.listRuns.mockResolvedValue({
			runs: [
				run(),
				run({
					id: "sync_1:run_b",
					status: "FAILED",
					error: "CLONE_FAILED",
					snapshotVersion: null,
					commitSha: null,
				}),
			],
		});
		render(<RepositorySyncRuns projectId="proj_1" running={false} />, {
			wrapper: Providers,
		});
		expect(
			await screen.findByText(
				/published version 4 · commit 0123456 · version 4 · by Example Member/,
			),
		).toBeInTheDocument();
		expect(screen.getByText(/failed/)).toBeInTheDocument();
		expect(screen.queryByText(/MANUAL/)).not.toBeInTheDocument();
	});

	it("says when there are no runs", async () => {
		render(<RepositorySyncRuns projectId="proj_1" running={false} />, {
			wrapper: Providers,
		});
		expect(await screen.findByText(copy.runs.empty)).toBeInTheDocument();
	});
});

describe("RepositorySyncSettingsSection (§7.4)", () => {
	function renderSection(state: RepositorySyncState) {
		const onChange = vi.fn();
		const onChanged = vi.fn();
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

	it("shows a reader the configuration without the actions", () => {
		renderSection({ ...CONFIGURED, canConfigure: false });
		expect(
			screen.getByText("example-org/instructions"),
		).toBeInTheDocument();
		expect(screen.queryByRole("button")).not.toBeInTheDocument();
	});
});
