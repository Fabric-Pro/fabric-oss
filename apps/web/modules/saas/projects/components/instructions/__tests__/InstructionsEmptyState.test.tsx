/**
 * `InstructionsEmptyState`'s "Connect your agent" button, in the "Developers
 * stay current" card. It reuses the exact contract `ConnectCliDialog.test.tsx`
 * already pins for the dialog itself (scopes, gateway endpoint, mint timing),
 * so this suite only has to prove the button renders in the right state, opens
 * the dialog with `purpose="coding-instructions"` and the project name, and
 * fails closed the same way `InstructionsPublishedView`'s own button does —
 * there is nothing to mint a key against without an organization id.
 *
 * `t.rich` is not part of the repo's global `next-intl` mock (`vitest.setup.ts`
 * only echoes `t`/`t.raw`), and this component calls it unconditionally for the
 * upload-instructions and history cards, so this suite resolves the REAL
 * `en.json` copy the same way `UploadFolderDialog.test.tsx` does for its own
 * `t.rich` calls.
 */
import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Fragment, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const emptyStateCopy = en.projects.codingInstructions.emptyState as Record<
	string,
	string
>;

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
		const renderTag = tags[match[1]];
		nodes.push(
			<Fragment key={key++}>
				{renderTag ? renderTag(match[2]) : match[2]}
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

function resolve(path: string): unknown {
	return path.split(".").reduce<unknown>((node, key) => {
		if (node && typeof node === "object") {
			return (node as Record<string, unknown>)[key];
		}
		return undefined;
	}, en);
}

/**
 * Namespace-aware, unlike the flat `emptyStateCopy` lookup this suite used
 * before it rendered anything beyond `InstructionsEmptyState` itself: fixing
 * B-1 (Task 9 review) mounts the real `RepositorySyncSettingsSection`, whose
 * copy lives under `repositorySync.settings`, not under `emptyState`.
 */
vi.mock("next-intl", () => ({
	useTranslations: (namespace: string) => {
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
		t.rich = (
			key: string,
			tags: Record<string, (chunks: string) => ReactNode>,
		) => {
			const raw = resolve(`${namespace}.${key}`);
			if (typeof raw !== "string") {
				throw new Error(`missing translation: ${namespace}.${key}`);
			}
			return richRender(raw, tags);
		};
		t.raw = (key: string) => resolve(`${namespace}.${key}`);
		return t;
	},
}));

const disableCalls: Array<Record<string, unknown>> = [];
const proposalSettingsCalls: Array<Record<string, unknown>> = [];
function mutationOptionsStub(mutationFn: (input: unknown) => Promise<unknown>) {
	return (
		opts: {
			onSuccess?: (data: unknown, vars: unknown) => void;
			onError?: (error: Error) => void;
		} = {},
	) => ({ mutationFn, ...opts });
}

const listRuns = vi.hoisted(() => vi.fn());

// `RepositorySyncSettingsSection`'s own procedures (disable, the automatic
// toggle's configure, and the read-only proposal toggle's
// updateProposalSettings), per B-1, and what the History dialog mounts once
// opened: its snapshot mutations and the sync-runs list.
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				publish: {
					mutationOptions: mutationOptionsStub(async () => ({})),
				},
				delete: {
					mutationOptions: mutationOptionsStub(async () => ({})),
				},
				createDownloadUrl: {
					mutationOptions: mutationOptionsStub(async () => ({
						url: "https://example.com/download",
					})),
				},
				repositorySync: {
					listRuns: {
						queryOptions: (o: { input: unknown }) => ({
							queryKey: ["listRuns", o.input],
							queryFn: () => listRuns(o.input),
						}),
					},
					configure: {
						mutationOptions: mutationOptionsStub(async () => ({
							syncId: "sync_1",
							generation: 2,
						})),
					},
					disable: {
						mutationOptions: mutationOptionsStub(async (input) => {
							disableCalls.push(input as Record<string, unknown>);
							return { disabled: true, hadConfiguration: true };
						}),
					},
					updateProposalSettings: {
						mutationOptions: mutationOptionsStub(async (input) => {
							proposalSettingsCalls.push(
								input as Record<string, unknown>,
							);
							return {
								allowReaderProposals: false,
								generation: 1,
							};
						}),
					},
				},
			},
		},
	},
}));

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

/**
 * Controllable per test, mirroring `InstructionsPublishedView.test.tsx`: the
 * button fails closed on `organizationId`, so both the present and absent
 * case need to be driven from here rather than a fixed mock.
 */
const orgContextState = vi.hoisted(() => ({
	organizationId: "org-hosting-the-project" as string | null,
	organizationSlug: "example-org" as string | null,
	isGuest: false,
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: orgContextState.organizationId,
		organizationSlug: orgContextState.organizationSlug,
		isGuest: orgContextState.isGuest,
	}),
}));

const connectCliDialogProps: Array<Record<string, unknown>> = [];
vi.mock("@saas/projects/components/cli-connection/ConnectCliDialog", () => ({
	ConnectCliDialog: (props: Record<string, unknown>) => {
		connectCliDialogProps.push(props);
		if (!props.open) {
			return null;
		}
		return <div data-testid="connect-cli-dialog-stub" />;
	},
}));

import { InstructionsEmptyState } from "../InstructionsEmptyState";

beforeEach(() => {
	orgContextState.organizationId = "org-hosting-the-project";
	orgContextState.organizationSlug = "example-org";
	orgContextState.isGuest = false;
	connectCliDialogProps.length = 0;
	disableCalls.length = 0;
	listRuns.mockReset();
	listRuns.mockResolvedValue({ runs: [] });
});

describe("InstructionsEmptyState — connect your agent", () => {
	it("renders the button when an organization id is present and opens the dialog with the coding-instructions purpose and project name", async () => {
		const user = userEvent.setup();
		render(
			<InstructionsEmptyState
				projectId="p"
				projectName="Checkout Rewrite"
				onUploadClick={() => undefined}
				localSetup={{ kind: "upload" }}
			/>,
		);

		const button = screen.getByRole("button", {
			name: "Connect your agent",
		});
		expect(
			screen.queryByTestId("connect-cli-dialog-stub"),
		).not.toBeInTheDocument();

		await user.click(button);

		expect(
			screen.getByTestId("connect-cli-dialog-stub"),
		).toBeInTheDocument();
		const lastProps =
			connectCliDialogProps[connectCliDialogProps.length - 1];
		expect(lastProps).toMatchObject({
			open: true,
			organizationId: "org-hosting-the-project",
			organizationSlug: "example-org",
			projectName: "Checkout Rewrite",
			purpose: "coding-instructions",
			// The dialog offers `fabric instructions init` from the empty
			// state too: it needs the project to name and the gate the tab
			// computed from the source-of-truth setting.
			projectId: "p",
			localSetup: { kind: "upload" },
		});
	});

	it("passes the local-setup route through unchanged, and it is null by default", async () => {
		const user = userEvent.setup();
		render(
			<InstructionsEmptyState
				projectId="p"
				projectName="Checkout Rewrite"
				onUploadClick={() => undefined}
			/>,
		);
		await user.click(
			screen.getByRole("button", { name: "Connect your agent" }),
		);
		expect(
			connectCliDialogProps[connectCliDialogProps.length - 1],
		).toMatchObject({ localSetup: null });
	});

	it("does not render the button when there is no organization id", () => {
		orgContextState.organizationId = null;
		render(
			<InstructionsEmptyState
				projectId="p"
				projectName="Checkout Rewrite"
				onUploadClick={() => undefined}
			/>,
		);

		expect(
			screen.queryByRole("button", { name: "Connect your agent" }),
		).not.toBeInTheDocument();
	});

	it("describes agents reading over the Fabric MCP server in the developers card", () => {
		render(
			<InstructionsEmptyState
				projectId="p"
				projectName="Checkout Rewrite"
				onUploadClick={() => undefined}
			/>,
		);

		expect(screen.getByText(/Fabric MCP server/i)).toBeInTheDocument();
	});

	// An invited cross-organization project guest views this project under
	// the HOST organization's thin record, so `organizationId` is truthy but
	// there is no membership row for the guest in that organization — the
	// create procedure's host-membership check would refuse them.
	it("does not render the button or mount the dialog for an invited guest", () => {
		orgContextState.isGuest = true;
		render(
			<InstructionsEmptyState
				projectId="p"
				projectName="Checkout Rewrite"
				onUploadClick={() => undefined}
			/>,
		);

		expect(
			screen.queryByRole("button", { name: "Connect your agent" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByTestId("connect-cli-dialog-stub"),
		).not.toBeInTheDocument();
	});
});

describe("InstructionsEmptyState — repository sync (§7.1)", () => {
	const configured = {
		syncId: "sync_1",
		repositoryIntegrationId: "int_1",
		provider: "GITHUB",
		repositoryOwner: "example-org",
		repositoryName: "instructions",
		repositoryUrl: "https://github.com/example-org/instructions.git",
		integrationStatus: "ACTIVE",
		ref: "main",
		rootPath: "",
		automatic: false,
		automaticPausedReason: null,
		automaticPausedAt: null,
		delegateName: "Example Member",
	};
	function controls(state: Record<string, unknown> = {}) {
		return {
			state: {
				sourceOfTruth: "UPLOAD" as const,
				canConfigure: true,
				running: false,
				configured: null,
				latestRun: null,
				availableIntegrations: [
					{
						id: "int_1",
						provider: "GITHUB",
						repositoryOwner: "example-org",
						repositoryName: "instructions",
						defaultBranch: "main",
					},
				],
				...state,
			},
			onConfigure: vi.fn(),
			onSyncNow: vi.fn(),
			syncNowPending: false,
			onChanged: vi.fn(),
		};
	}

	it("offers Sync from repository beside Upload folder and opens the configure dialog", async () => {
		const c = controls();
		render(
			<InstructionsEmptyState
				projectId="p"
				projectName="Checkout Rewrite"
				onUploadClick={() => undefined}
				repositorySync={c}
			/>,
		);
		await userEvent.click(
			screen.getByRole("button", { name: emptyStateCopy.syncButton }),
		);
		expect(c.onConfigure).toHaveBeenCalled();
	});

	it("offers Sync now once configured, held while a run is open", () => {
		render(
			<InstructionsEmptyState
				projectId="p"
				projectName="Checkout Rewrite"
				onUploadClick={() => undefined}
				repositorySync={controls({
					configured,
					sourceOfTruth: "REPOSITORY",
					running: true,
				})}
			/>,
			{ wrapper: Providers },
		);
		expect(
			screen.getByRole("button", { name: emptyStateCopy.syncNowButton }),
		).toBeDisabled();
	});

	// B-1 (Task 9 review): a first sync that fails before any snapshot exists
	// (ROOT_MISSING, LIMITS_EXCEEDED, TREE_REFUSED, or a vanished integration)
	// leaves the project here, in REPOSITORY mode, with nothing published.
	// Spec §7.4 promises the project is never locked, so both the recovery
	// actions must be reachable from this screen too, not only from Settings.
	it("never locks a project whose first sync failed: Change… and Switch to upload mode are reachable here", () => {
		render(
			<InstructionsEmptyState
				projectId="p"
				projectName="Checkout Rewrite"
				onUploadClick={() => undefined}
				repositorySync={controls({
					configured,
					sourceOfTruth: "REPOSITORY",
					latestRun: {
						id: "sync_1:run_a",
						trigger: "MANUAL",
						startedAt: new Date(),
						finishedAt: new Date(),
						status: "FAILED",
						error: "ROOT_MISSING",
						note: null,
						commitSha: null,
						snapshotId: null,
						snapshotVersion: null,
						userName: "Example Member",
						fromCurrentConfiguration: true,
					},
				})}
			/>,
			{ wrapper: Providers },
		);
		expect(
			screen.getByRole("button", { name: "Change…" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Switch to upload mode" }),
		).toBeInTheDocument();
	});

	// Codex review of Fizzy #2672: a first sync failed, nothing was ever
	// published, and the member switched to upload mode. The status line
	// rightly leaves the old run out, so History is the only place the
	// confirmation's "Sync history is kept." can be checked from here.
	it("opens History with the kept sync runs, marked as from a switched-off sync, when nothing was ever published", async () => {
		const user = userEvent.setup();
		const keptRun = {
			id: "sync_1:run_a",
			trigger: "MANUAL",
			startedAt: new Date(),
			finishedAt: new Date(),
			status: "FAILED",
			error: "ROOT_MISSING",
			note: null,
			commitSha: null,
			snapshotId: null,
			snapshotVersion: null,
			userName: "Example Member",
			fromCurrentConfiguration: false,
		};
		listRuns.mockResolvedValue({ runs: [keptRun] });
		render(
			<InstructionsEmptyState
				projectId="p"
				projectName="Checkout Rewrite"
				onUploadClick={() => undefined}
				repositorySync={controls({ latestRun: keptRun })}
			/>,
			{ wrapper: Providers },
		);

		await user.click(
			screen.getByRole("button", { name: emptyStateCopy.historyButton }),
		);

		const dialog = await screen.findByRole("dialog");
		expect(
			await within(dialog).findByText(
				en.projects.codingInstructions.repositorySync.runs
					.previousConfiguration,
			),
		).toBeInTheDocument();
		expect(listRuns).toHaveBeenCalledWith({ projectId: "p" });
	});

	it("offers no History before any sync has run", () => {
		render(
			<InstructionsEmptyState
				projectId="p"
				projectName="Checkout Rewrite"
				onUploadClick={() => undefined}
				repositorySync={controls()}
			/>,
		);
		expect(
			screen.queryByRole("button", {
				name: emptyStateCopy.historyButton,
			}),
		).toBeNull();
		expect(listRuns).not.toHaveBeenCalled();
	});

	// Fizzy #2563 spec §12: the read-only proposal setting belongs to the
	// Repository section, so it is reachable before the first version is
	// published too. Nothing on this screen offers a suggestion itself:
	// a proposal needs a published version to change.
	it("keeps the read-only proposal setting reachable before anything is published, and offers no suggestion", async () => {
		proposalSettingsCalls.length = 0;
		render(
			<InstructionsEmptyState
				projectId="p"
				projectName="Checkout Rewrite"
				onUploadClick={() => undefined}
				repositorySync={controls({
					configured: { ...configured, allowReaderProposals: true },
					sourceOfTruth: "REPOSITORY",
				})}
			/>,
			{ wrapper: Providers },
		);
		const toggle = screen.getByRole("switch", {
			name: "Let read-only members propose changes as pull requests",
		});
		expect(toggle).toBeChecked();
		await userEvent.click(toggle);
		expect(proposalSettingsCalls).toEqual([
			{ projectId: "p", allowReaderProposals: false },
		]);
		expect(screen.queryByRole("button", { name: /suggest/i })).toBeNull();
	});

	it("offers no sync button to a member who cannot configure, and no dead one without the controls", () => {
		const { rerender } = render(
			<InstructionsEmptyState
				projectId="p"
				projectName="Checkout Rewrite"
				onUploadClick={() => undefined}
				repositorySync={controls({ canConfigure: false })}
			/>,
		);
		expect(
			screen.queryByRole("button", { name: emptyStateCopy.syncButton }),
		).toBeNull();
		rerender(
			<InstructionsEmptyState
				projectId="p"
				projectName="Checkout Rewrite"
				onUploadClick={() => undefined}
			/>,
		);
		expect(
			screen.queryByRole("button", { name: emptyStateCopy.syncButton }),
		).toBeNull();
	});
});
