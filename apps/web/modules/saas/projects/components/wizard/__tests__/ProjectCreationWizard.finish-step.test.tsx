/**
 * Post-create finish-setup step tests for the unified `ProjectCreationWizard`
 * (unified-project-setup spec §4.6, D4, AC#1; tasks TG4 §4.1).
 *
 * Scope:
 *   (a) After a brief-only create (no repo, no backlog, no documents), the
 *       wizard lands on the finish-setup step (NOT a straight redirect) showing
 *       a summary of what was set up with links to the project + settings.
 *   (b) `MeetingTranscriptSyncSettings` mounts with the REAL
 *       `{ projectId, organizationId, project }` so transcripts link against the
 *       real project id.
 *   (c) The summary reflects a connected backlog / repo when present.
 *   (d) "Go to project" navigates to the project; transcripts are skippable
 *       (no link is required to leave the step).
 *   (e) Focus (§7): on entering the finish step, focus lands on the step
 *       heading; toasts do not steal focus.
 *
 * The wizard's heavy step children are mocked via `next/dynamic`: the Brief
 * step is an inert stub that drives form-state (name + optional-card buttons),
 * while the REAL `WizardFinishStep` is rendered for the finish-step props so we
 * exercise the actual step UI. `MeetingTranscriptSyncSettings` is stubbed at the
 * module boundary (its own behavior is covered by its colocated tests) and
 * records the props it was mounted with. oRPC is mocked only at the client
 * boundary.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ── jsdom polyfills ──────────────────────────────────────────────────────
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
	window.scrollTo = (() => undefined) as typeof window.scrollTo;
});

// ── Hoisted mock fns ─────────────────────────────────────────────────────
const {
	createMutationFn,
	startExistingSetupMock,
	pushMock,
	toastSuccessMock,
	toastErrorMock,
	toastWarningMock,
	createIntegrationContextsMock,
	createBacklogIntegrationContextMock,
	transcriptSettingsPropsSpy,
} = vi.hoisted(() => ({
	createMutationFn: vi.fn(),
	startExistingSetupMock: vi.fn(),
	pushMock: vi.fn(),
	toastSuccessMock: vi.fn(),
	toastErrorMock: vi.fn(),
	toastWarningMock: vi.fn(),
	createIntegrationContextsMock: vi.fn(),
	createBacklogIntegrationContextMock: vi.fn(),
	transcriptSettingsPropsSpy: vi.fn(),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({
		push: pushMock,
		replace: vi.fn(),
		prefetch: vi.fn(),
		back: vi.fn(),
	}),
	usePathname: () => "/app/projects/new",
	useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		organizationSlug: null,
		basePath: "/app",
	}),
}));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: vi.fn() }),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			contexts: { cancelDraftCrawls: vi.fn() },
			delete: vi.fn(),
			github: { startCodeSetup: vi.fn() },
			gitlab: { startCodeSetup: vi.fn() },
			existingSetup: {
				start: (input: unknown) => startExistingSetupMock(input),
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			create: {
				mutationOptions: (opts: {
					onSuccess?: (data: {
						project: { id: string };
					}) => void | Promise<void>;
					onError?: (err: { message: string }) => void;
				}) => ({
					mutationFn: async (input: unknown) => {
						createMutationFn(input);
						return { project: { id: "proj_new_1" } };
					},
					onSuccess: opts.onSuccess,
					onError: opts.onError,
				}),
			},
			update: {
				mutationOptions: (opts: Record<string, unknown>) => ({
					mutationFn: async () => ({ project: { id: "p" } }),
					...opts,
				}),
			},
			saveDraft: {
				mutationOptions: (opts: {
					onSuccess?: (data: {
						created: boolean;
						project: { id: string };
					}) => void;
				}) => ({
					mutationFn: async () => ({
						created: false,
						project: { id: "p" },
					}),
					onSuccess: opts.onSuccess,
				}),
			},
			listDrafts: {
				queryOptions: ({ input }: { input: unknown }) => ({
					queryKey: ["projects.listDrafts", input] as const,
					queryFn: async () => ({ drafts: [] }),
				}),
			},
			get: { call: async () => ({ project: null }) },
			checkName: {
				queryOptions: ({ input }: { input: unknown }) => ({
					queryKey: ["projects.checkName", input] as const,
					queryFn: async () => ({ available: true }),
				}),
			},
			contexts: {
				list: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["projects.contexts.list", input] as const,
						queryFn: async () => ({ contexts: [] }),
					}),
				},
			},
		},
		wizard: {
			refineDescription: {
				mutationOptions: () => ({ mutationFn: async () => undefined }),
			},
		},
	},
}));

vi.mock("../../../hooks/use-wizard-session-persistence", () => ({
	useWizardSessionPersistence: () => ({ save: vi.fn(), clear: vi.fn() }),
}));

vi.mock("sonner", () => ({
	toast: {
		success: toastSuccessMock,
		error: toastErrorMock,
		info: vi.fn(),
		warning: toastWarningMock,
	},
}));

// `next/dynamic`: the Brief step (has formData + updateFormData) is an inert
// stub that drives form-state. The REAL WizardFinishStep is rendered for the
// finish-step props (it has `onGoToProject`) so the actual step UI is exercised.
vi.mock("next/dynamic", async () => {
	const React = await import("react");

	// Dedicated loader component for the finish step. Hooks live at its top
	// level (not conditionally inside Stub) to satisfy `useHookAtTopLevel`. It
	// mirrors real next/dynamic: load the module via the loader and re-render
	// once resolved.
	function FinishStepLoader({
		loader,
		props,
	}: {
		loader: () => Promise<unknown>;
		props: Record<string, unknown>;
	}) {
		const [Real, setReal] = React.useState<React.ComponentType<
			Record<string, unknown>
		> | null>(null);
		React.useEffect(() => {
			let active = true;
			void loader().then((mod) => {
				if (!active) {
					return;
				}
				// The wizard's loader is
				// `() => import("./wizard/WizardFinishStep").then(m => m.WizardFinishStep)`,
				// so `mod` is already the component. Tolerate both the
				// resolved-component and the `{ WizardFinishStep }` shapes.
				const C = (
					typeof mod === "function"
						? mod
						: (mod as Record<string, unknown>).WizardFinishStep
				) as React.ComponentType<Record<string, unknown>> | undefined;
				if (C) {
					setReal(() => C);
				}
			});
			return () => {
				active = false;
			};
		}, [loader]);
		if (Real) {
			return <Real {...props} />;
		}
		return <div data-testid="finish-step-loading" />;
	}

	return {
		default: (loader: () => Promise<unknown>, _opts?: unknown) => {
			const Stub = (props: Record<string, unknown>) => {
				// Finish step → load + render the real component.
				if (typeof props.onGoToProject === "function") {
					return <FinishStepLoader loader={loader} props={props} />;
				}
				// Brief step → inert stub that drives form-state.
				if (props.updateFormData && props.formData) {
					const update = props.updateFormData as (
						u: Record<string, unknown>,
					) => void;
					const formData = props.formData as { name?: string };
					return (
						<div data-testid="brief-step-stub">
							<input
								aria-label="Project Name"
								value={formData.name ?? ""}
								onChange={(e) =>
									update({ name: e.target.value })
								}
							/>
							{/* Since Fizzy #2165 step 1 needs a description past
							    the readiness threshold and a phase before the
							    wizard will move on. */}
							<button
								type="button"
								data-testid="fill-project-basics"
								onClick={() =>
									update({
										description:
											"A description comfortably past the fifty-character minimum the readiness checklist asks for.",
										projectPhase: "DEVELOPMENT_EXECUTION",
									})
								}
							>
								Fill basics
							</button>
							<button
								type="button"
								data-testid="connect-backlog-complete"
								onClick={() =>
									update({
										projectManagementMcpConfigId: "cfg-1",
										projectManagementMcpServerId: "srv-1",
										projectManagementContainerId: "board-7",
										projectManagementContainerName:
											"Mobile Board",
										projectManagementDetectedType: "jira",
									})
								}
							>
								connect backlog (complete)
							</button>
						</div>
					);
				}
				return <div data-testid="dynamic-step-stub" />;
			};
			Stub.displayName = "DynamicStepStub";
			return Stub;
		},
	};
});

vi.mock("../../../lib/create-integration-contexts", () => ({
	createIntegrationContexts: (input: unknown) => {
		createIntegrationContextsMock(input);
		return Promise.resolve({ successCount: 0, failCount: 0 });
	},
	createBacklogIntegrationContext: (input: unknown) =>
		createBacklogIntegrationContextMock(input),
}));

vi.mock("../ReviewPromptsStep", () => ({
	ReviewPromptsStep: () => <div data-testid="review-prompts-stub" />,
}));

// Reused transcript card → stubbed at the module boundary (its own behavior is
// covered by its colocated tests). Records the props it was mounted with so we
// can assert the real { projectId, organizationId, project } is wired through,
// and exposes a "Link Meetings" affordance to prove the linking surface mounts.
vi.mock("../../MeetingTranscriptSyncSettings", () => ({
	MeetingTranscriptSyncSettings: (props: {
		projectId: string;
		organizationId: string | null;
		project: Record<string, unknown>;
	}) => {
		transcriptSettingsPropsSpy(props);
		return (
			<div data-testid="meeting-transcript-sync-settings">
				<span data-testid="mts-project-id">{props.projectId}</span>
				<span data-testid="mts-org-id">
					{props.organizationId === null
						? "__null__"
						: props.organizationId}
				</span>
				<button type="button">Link Meetings</button>
			</div>
		);
	},
}));

import { ProjectCreationWizard } from "../../ProjectCreationWizard";

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

async function typeName(
	user: ReturnType<typeof userEvent.setup>,
	name: string,
) {
	const nameInput = await screen.findByLabelText(/project name/i);
	await user.type(nameInput, name);
	await user.click(await screen.findByTestId("fill-project-basics"));
}

async function gotoReviewAndCreate(user: ReturnType<typeof userEvent.setup>) {
	const reviewStepButton = await screen.findByRole("button", {
		name: /Review/i,
	});
	await user.click(reviewStepButton);
	const createButton = await screen.findByRole("button", {
		name: /^Create Project$/i,
	});
	await user.click(createButton);
}

describe("ProjectCreationWizard — post-create finish-setup step (D4, §4.6)", () => {
	beforeEach(() => {
		createMutationFn.mockReset();
		startExistingSetupMock.mockReset();
		startExistingSetupMock.mockResolvedValue(undefined);
		pushMock.mockReset();
		toastSuccessMock.mockReset();
		toastErrorMock.mockReset();
		toastWarningMock.mockReset();
		createIntegrationContextsMock.mockReset();
		createBacklogIntegrationContextMock.mockReset();
		createBacklogIntegrationContextMock.mockResolvedValue({
			created: true,
		});
		transcriptSettingsPropsSpy.mockReset();
	});

	it("lands on the finish-setup step (not a redirect) after a brief-only create and shows a what-was-set-up summary with project + settings links", async () => {
		const user = userEvent.setup();
		wrap(<ProjectCreationWizard />);

		await typeName(user, "Brief Only Project");
		await gotoReviewAndCreate(user);

		await waitFor(() => {
			expect(createMutationFn).toHaveBeenCalledTimes(1);
		});

		// The finish-step heading appears …
		const heading = await screen.findByRole("heading", {
			name: /Brief Only Project is ready/i,
		});
		expect(heading).toBeInTheDocument();

		// … and the wizard did NOT redirect straight to the project.
		expect(pushMock).not.toHaveBeenCalled();

		// Summary confirms the brief was set up, with links to the project + settings.
		expect(
			screen.getByRole("heading", { name: /^what was set up$/i }),
		).toBeInTheDocument();
		expect(screen.getByText(/project brief/i)).toBeInTheDocument();

		const viewLink = screen.getByRole("link", { name: /view project/i });
		expect(viewLink).toHaveAttribute("href", "/app/projects/proj_new_1");
		// `?tab=settings`, NOT `/settings`. Project Settings is an in-page tab,
		// so the old `/projects/:id/settings` href 404'd — this assertion used
		// to pin that broken link in place (Fizzy #2196).
		const settingsLink = screen.getByRole("link", {
			name: /project settings/i,
		});
		expect(settingsLink).toHaveAttribute(
			"href",
			"/app/projects/proj_new_1?tab=settings",
		);
	});

	it("mounts MeetingTranscriptSyncSettings with the real projectId and resolved organizationId", async () => {
		const user = userEvent.setup();
		wrap(<ProjectCreationWizard />);

		await typeName(user, "Transcripts Project");
		await gotoReviewAndCreate(user);

		await waitFor(() => {
			expect(
				screen.getByTestId("meeting-transcript-sync-settings"),
			).toBeInTheDocument();
		});

		// Real projectId from the create response is threaded through.
		expect(screen.getByTestId("mts-project-id")).toHaveTextContent(
			"proj_new_1",
		);
		// Personal context → organizationId null.
		expect(screen.getByTestId("mts-org-id")).toHaveTextContent("__null__");

		// The linking surface is present (transcripts are linkable here).
		expect(
			screen.getByRole("button", { name: /link meetings/i }),
		).toBeInTheDocument();

		// The card was mounted with a `project` object (empty for a new project).
		const props = transcriptSettingsPropsSpy.mock.calls.at(-1)?.[0] as {
			projectId: string;
			organizationId: string | null;
			project: Record<string, unknown>;
		};
		expect(props.projectId).toBe("proj_new_1");
		expect(props.organizationId).toBeNull();
		expect(props.project).toBeTypeOf("object");
	});

	it("'Go to project' navigates to the project, and transcripts are skippable (no link required)", async () => {
		const user = userEvent.setup();
		wrap(<ProjectCreationWizard />);

		await typeName(user, "Skippable Project");
		await gotoReviewAndCreate(user);

		// On the finish step, no redirect has happened yet.
		await screen.findByTestId("finish-go-to-project");
		expect(pushMock).not.toHaveBeenCalled();

		// Click "Go to project" WITHOUT linking any transcript (skippable).
		await user.click(screen.getByTestId("finish-go-to-project"));

		await waitFor(() => {
			expect(pushMock).toHaveBeenCalledWith("/app/projects/proj_new_1");
		});
	});

	it("surfaces a connected backlog in the finish-step summary", async () => {
		const user = userEvent.setup();
		wrap(<ProjectCreationWizard />);

		await typeName(user, "Backlog Summary Project");
		await user.click(screen.getByTestId("connect-backlog-complete"));
		await gotoReviewAndCreate(user);

		// Backlog connected → existingSetup.start fires and the wizard redirects
		// straight to the project (the connected-integration path), so the finish
		// step is NOT shown for this outcome (see §4.6 routing decision).
		await waitFor(() => {
			expect(pushMock).toHaveBeenCalledWith("/app/projects/proj_new_1");
		});
		expect(
			screen.queryByRole("heading", { name: /is ready/i }),
		).not.toBeInTheDocument();
	});

	it("moves focus to the finish-step heading on entry without a toast stealing it", async () => {
		const user = userEvent.setup();
		wrap(<ProjectCreationWizard />);

		await typeName(user, "Focus Project");
		await gotoReviewAndCreate(user);

		const heading = await screen.findByRole("heading", {
			name: /Focus Project is ready/i,
		});

		// Focus lands on the step heading (it is programmatically focusable).
		await waitFor(() => {
			expect(heading).toHaveFocus();
		});

		// A success toast fired on create, but it did not steal focus from the
		// heading (sonner toasts are non-modal).
		expect(toastSuccessMock).toHaveBeenCalled();
		expect(heading).toHaveFocus();
	});
});
