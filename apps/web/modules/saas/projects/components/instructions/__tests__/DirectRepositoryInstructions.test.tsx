import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	connectDialogProps: [] as Array<Record<string, unknown>>,
	fileInputs: [] as Array<Record<string, unknown>>,
	historyProps: [] as Array<Record<string, unknown>>,
	calls: [] as string[],
	filesGate: null as Promise<void> | null,
	filesFailures: 0,
	sectionProps: null as null | {
		onChange: () => void;
		onChanged: () => Promise<void>;
	},
	settingsProps: null as null | {
		onOpenChange: (o: boolean) => void;
		onSaved?: () => void;
	},
}));

function queryOptions(
	name: string,
	queryFn: (input: Record<string, unknown>) => unknown,
) {
	return (options: { input: Record<string, unknown> }) => ({
		queryKey: [name, options.input],
		queryFn: async () => queryFn(options.input),
	});
}

vi.mock("next-intl", () => ({
	useTranslations: () =>
		Object.assign((key: string) => key, { raw: () => ({}) }),
}));
vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: vi.fn() }),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		organizationSlug: "example-org",
		isGuest: false,
	}),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				proposals: {
					myBranch: {
						queryOptions: queryOptions("my-branch", () => ({
							branch: null,
							files: [],
						})),
					},
					myBranchFile: {
						queryOptions: queryOptions(
							"my-branch-file",
							() => null,
						),
					},
				},
				repository: {
					key: ({ input }: { input: Record<string, unknown> }) => [
						"repository",
						input,
					],
					listFiles: {
						queryOptions: queryOptions("list-files", async () => {
							state.calls.push("listFiles");
							await state.filesGate;
							if (state.filesFailures > 0) {
								state.filesFailures--;
								throw new Error("transient");
							}
							return {
								files: [
									{ path: "AGENTS.md", kind: "INSTRUCTIONS" },
									{ path: "CLAUDE.md", kind: "INSTRUCTIONS" },
								],
								incomplete: false,
								refusal: null,
							};
						}),
					},
					getFile: {
						queryOptions: queryOptions("get-file", (input) => {
							state.fileInputs.push(input);
							state.calls.push(`getFile:${String(input.path)}`);
							return {
								state: "found",
								body: "Original instructions",
								size: 21,
								nextOffset: null,
								truncated: false,
							};
						}),
					},
					listCommits: {
						queryOptions: queryOptions("commits", () => {
							state.calls.push("listCommits");
							return { commits: [], nextCursor: null };
						}),
					},
				},
				repositorySync: {
					get: {
						queryOptions: queryOptions("repository-sync", () => ({
							canConfigure: true,
							availableIntegrations: [],
							configured: {
								syncId: "sync-1",
								repositoryIntegrationId: "integration-1",
								provider: "GITHUB",
								repositoryOwner: "example-org",
								repositoryName: "instructions",
								repositoryUrl:
									"https://github.com/example-org/instructions.git",
								integrationStatus: "ACTIVE",
								ref: "main",
								rootPath: "agents",
								automatic: false,
								automaticPausedReason: null,
								automaticPausedAt: null,
							},
						})),
					},
				},
			},
		},
	},
}));

vi.mock("@saas/projects/components/cli-connection/ConnectCliDialog", () => ({
	ConnectCliDialog: (props: Record<string, unknown>) => {
		state.connectDialogProps.push(props);
		return props.open ? <div data-testid="connect-dialog" /> : null;
	},
}));

vi.mock("../ConfigureRepositorySyncDialog", () => ({
	ConfigureRepositorySyncDialog: () => null,
}));

vi.mock("@saas/get-started/components/PageTourButton", () => ({
	PageTourButton: () => null,
}));
vi.mock("../InstructionsSettingsDialog", () => ({
	InstructionsSettingsDialog: (props: {
		onOpenChange: (o: boolean) => void;
		onSaved?: () => void;
		repositorySection?: React.ReactNode;
	}) => {
		state.settingsProps = props;
		return props.repositorySection ?? null;
	},
}));
vi.mock("../RepositorySyncSettingsSection", () => ({
	RepositorySyncSettingsSection: (props: {
		onChange: () => void;
		onChanged: () => Promise<void>;
	}) => {
		state.sectionProps = props;
		return null;
	},
}));

vi.mock("../InstructionsTree", () => ({
	InstructionsTree: () => null,
}));

vi.mock("../InstructionsCommits", () => ({
	InstructionsCommits: (props: Record<string, unknown>) => {
		state.historyProps.push(props);
		return null;
	},
}));

import { NAVIGATE_TO_SETTINGS_TAB_EVENT } from "../../settings-tab-navigation";
import { DirectRepositoryInstructions } from "../DirectRepositoryInstructions";

function renderDirectInstructions(
	props: Partial<Parameters<typeof DirectRepositoryInstructions>[0]> = {},
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<DirectRepositoryInstructions
				projectId="project-1"
				projectName="Repository instructions"
				canConfigure
				refreshing={false}
				onRefresh={async () => undefined}
				onReread={async () => undefined}
				onUserRefresh={async () => undefined}
				state={{
					availability: "READY",
					provider: "GITHUB",
					repositoryUrl:
						"https://github.com/example-org/instructions",
					ref: "main",
					rootPath: "agents",
					generation: 1,
					currentCommitSha: "a".repeat(40),
				}}
				{...props}
			/>
		</QueryClientProvider>,
	);
}

describe("DirectRepositoryInstructions — load order", () => {
	it("reads the default file while the file list is still loading, and the commit list only afterwards", async () => {
		state.calls.length = 0;
		let release = () => {};
		state.filesGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		renderDirectInstructions();
		await waitFor(() => expect(state.calls).toContain("getFile:CLAUDE.md"));
		expect(state.calls).not.toContain("getFile:AGENTS.md");
		expect(state.calls).not.toContain("listCommits");
		release();
		state.filesGate = null;
		await waitFor(() => expect(state.calls).toContain("listCommits"), {
			timeout: 4_000,
		});
		expect(state.calls.indexOf("listCommits")).toBeGreaterThan(
			state.calls.indexOf("listFiles"),
		);
	});

	it("offers a retry when the file list fails to load, and shows the tree after it", async () => {
		state.filesGate = null;
		state.filesFailures = 1;
		renderDirectInstructions();
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("loadError");
		fireEvent.click(screen.getByRole("button", { name: "retryLoad" }));
		await waitFor(() =>
			expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
		);
	});

	it("re-reads the current commit when the settings dialog closes only if a setting was saved", async () => {
		const onReread = vi.fn(async () => undefined);
		renderDirectInstructions({ onReread });
		await waitFor(() => expect(state.settingsProps).not.toBeNull());
		act(() => state.settingsProps?.onOpenChange(false));
		expect(onReread).not.toHaveBeenCalled();
		act(() => {
			state.settingsProps?.onSaved?.();
			state.settingsProps?.onOpenChange(false);
		});
		expect(onReread).toHaveBeenCalledTimes(1);
		act(() => state.settingsProps?.onOpenChange(false));
		expect(onReread).toHaveBeenCalledTimes(1);
	});

	it("does not carry a saved-settings flag past a close through the section's own change flow", async () => {
		const onReread = vi.fn(async () => undefined);
		state.sectionProps = null;
		renderDirectInstructions({ onReread });
		await waitFor(() => expect(state.sectionProps).not.toBeNull());
		await act(async () => {
			await state.sectionProps?.onChanged();
		});
		act(() => state.sectionProps?.onChange());
		expect(onReread).toHaveBeenCalledTimes(1);
		act(() => state.settingsProps?.onOpenChange(false));
		expect(onReread).toHaveBeenCalledTimes(1);
	});

	it("truncates a long branch pill instead of clipping it", async () => {
		state.filesGate = null;
		renderDirectInstructions({
			state: {
				availability: "READY",
				provider: "GITHUB",
				repositoryUrl: "https://github.com/example-org/instructions",
				ref: "feature/a-very-long-branch-name-that-cannot-fit-on-a-phone",
				rootPath: "agents",
				generation: 1,
				currentCommitSha: "a".repeat(40),
			},
		});
		const pill = await screen.findByTestId("instructions-branch-pill");
		expect(pill).toHaveAttribute("title", pill.textContent ?? "");
		expect(pill).toHaveClass("max-w-full", "min-w-0");
		expect(pill.querySelector(".truncate")).not.toBeNull();
	});

	it("links the Source to the ref on screen, not the repository's default branch", async () => {
		state.filesGate = null;
		renderDirectInstructions({
			state: {
				availability: "READY",
				provider: "GITHUB",
				repositoryUrl: "https://github.com/example-org/instructions",
				ref: "feature/proposal-1",
				rootPath: "",
				generation: 1,
				currentCommitSha: "a".repeat(40),
			},
		});

		const source = await screen.findByRole("link", {
			name: /statusSourceRepository/,
		});

		expect(source).toHaveAttribute(
			"href",
			"https://github.com/example-org/instructions/tree/feature/proposal-1",
		);
	});
});

describe("DirectRepositoryInstructions — repository sign-in", () => {
	it("offers Reconnect, which opens the project's repository settings, when the sign-in expired", () => {
		const received: unknown[] = [];
		const listener = (event: Event) => {
			received.push(event instanceof CustomEvent ? event.detail : null);
		};
		window.addEventListener(NAVIGATE_TO_SETTINGS_TAB_EVENT, listener);

		renderDirectInstructions({
			state: { availability: "CREDENTIALS_EXPIRED" },
		});
		fireEvent.click(screen.getByRole("button", { name: "reconnect" }));

		window.removeEventListener(NAVIGATE_TO_SETTINGS_TAB_EVENT, listener);
		expect(received).toEqual([
			{ projectId: "project-1", settingsTab: "development" },
		]);
	});

	it("offers no Reconnect when the repository is merely disconnected", () => {
		renderDirectInstructions({ state: { availability: "DISCONNECTED" } });

		expect(
			screen.queryByRole("button", { name: "reconnect" }),
		).not.toBeInTheDocument();
	});
});

describe("DirectRepositoryInstructions — connect checkout setup", () => {
	it("preserves the editor draft across repository outage and reconnection", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const ready = {
			availability: "READY" as const,
			provider: "GITHUB",
			repositoryUrl: "https://github.com/example-org/instructions",
			ref: "main",
			rootPath: "agents",
			generation: 1,
			currentCommitSha: "a".repeat(40),
		};
		const view = (
			repositoryState: Parameters<
				typeof DirectRepositoryInstructions
			>[0]["state"],
			projectId = "outage-project",
		) => (
			<QueryClientProvider client={client}>
				<DirectRepositoryInstructions
					projectId={projectId}
					projectName="Outage test"
					canConfigure
					canEdit
					refreshing={false}
					onRefresh={() => undefined}
					state={repositoryState}
				/>
			</QueryClientProvider>
		);
		const rendered = render(view(ready));
		await waitFor(() =>
			expect(
				screen.getByRole("button", {
					name: "editButton",
					exact: true,
				}),
			).not.toHaveAttribute("aria-disabled", "true"),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "editButton", exact: true }),
		);
		const editor = screen.getByRole("textbox", { name: "editorLabel" });
		fireEvent.change(editor, { target: { value: "Keep the exact draft" } });
		rendered.rerender(view({ availability: "UNAVAILABLE" }));
		expect(
			screen.getByRole("textbox", { name: "editorLabel" }),
		).toHaveValue("Keep the exact draft");
		expect(
			screen.queryByRole("button", { name: "commitToBranch" }),
		).not.toBeInTheDocument();
		rendered.rerender(view(ready));
		expect(
			screen.getByRole("textbox", { name: "editorLabel" }),
		).toHaveValue("Keep the exact draft");
		rendered.rerender(
			view({ availability: "UNAVAILABLE" }, "another-project"),
		);
		expect(
			screen.queryByRole("textbox", { name: "editorLabel" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText("Original instructions"),
		).not.toBeInTheDocument();
	});

	it.each([
		{
			canEdit: true,
			readOnlyMode: false,
			canCompare: true,
			canRevert: true,
		},
		{
			canEdit: true,
			readOnlyMode: true,
			canCompare: true,
			canRevert: false,
		},
		{
			canEdit: false,
			readOnlyMode: false,
			canCompare: false,
			canRevert: false,
		},
	])(
		"preserves history permissions for canEdit=$canEdit, readOnlyMode=$readOnlyMode",
		async ({ canEdit, readOnlyMode, canCompare, canRevert }) => {
			state.historyProps.length = 0;
			renderDirectInstructions({
				canEdit,
				readOnlyMode,
				canReview: false,
			});
			fireEvent.click(
				screen.getByRole("button", { name: "commitsButton" }),
			);
			await waitFor(() => {
				expect(state.historyProps.at(-1)).toMatchObject({
					canCompare,
					canRevert,
				});
			});
		},
	);

	it("passes the native repository checkout route to Connect instead of hiding it behind MCP-only setup", async () => {
		state.connectDialogProps.length = 0;
		state.fileInputs.length = 0;
		renderDirectInstructions();

		fireEvent.click(screen.getByRole("button", { name: "connectButton" }));

		await waitFor(() => {
			const openDialog = state.connectDialogProps.find(
				(props) =>
					props.open === true &&
					typeof props.localSetup === "object" &&
					props.localSetup !== null &&
					"kind" in props.localSetup &&
					props.localSetup.kind === "repository",
			);
			expect(openDialog).toMatchObject({
				purpose: "coding-instructions",
				localSetup: {
					kind: "repository",
					cloneUrl: "https://github.com/example-org/instructions.git",
					directory: "instructions",
					ref: "main",
					rootPath: "agents",
				},
			});
			expect(openDialog).not.toHaveProperty("mcpOnly");
		});
	});

	it("opens the root CLAUDE.md by default, reading only that file and not AGENTS.md or every listed file", async () => {
		state.connectDialogProps.length = 0;
		state.fileInputs.length = 0;
		renderDirectInstructions();

		await waitFor(() => {
			expect(state.fileInputs).toEqual([
				expect.objectContaining({ path: "CLAUDE.md", offset: 0 }),
			]);
		});
	});
});
