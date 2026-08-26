/**
 * Wizard-level D8 / AC#4 emission test for `ProjectCreationWizard`
 * (unified-project-setup spec §4.5, §5.1; tasks TG2 §2.1 / §2.2).
 *
 * Asserts the wizard's create `onSuccess` emits exactly ONE backlog INTEGRATION
 * context (via the shared `createBacklogIntegrationContext` helper) when a
 * backlog is connected, with the PM metadata mapped from form-state — and emits
 * NONE on the blank-optionals path (AC#3). The helper's own idempotency-guard /
 * 30-cap contract is unit-tested in
 * `lib/__tests__/create-integration-contexts.test.ts`; here we only verify the
 * wizard wires the emission correctly and gates it on `hasBacklogConnected`.
 *
 * NOTE: This file deliberately does NOT assert `skipAutoSync` /
 * `existingSetup.start` (TG3 owns the workflow-routing assertions in
 * `ProjectCreationWizard.submit-payload.test.tsx`).
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
	toastErrorMock,
	toastWarningMock,
	createIntegrationContextsMock,
	createBacklogIntegrationContextMock,
} = vi.hoisted(() => ({
	createMutationFn: vi.fn(),
	startExistingSetupMock: vi.fn(),
	pushMock: vi.fn(),
	toastErrorMock: vi.fn(),
	toastWarningMock: vi.fn(),
	createIntegrationContextsMock: vi.fn(),
	createBacklogIntegrationContextMock: vi.fn(),
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
		success: vi.fn(),
		error: toastErrorMock,
		info: vi.fn(),
		warning: toastWarningMock,
	},
}));

// Brief step stub: name input + a button that connects a FULLY configured
// backlog (PM tool + container + ADO team) so the wizard submit validation
// passes and the connected-backlog path runs.
vi.mock("next/dynamic", () => ({
	default: (
		_loader: () => Promise<unknown>,
		_opts?: { ssr?: boolean; loading?: () => React.ReactNode },
	) => {
		const Stub = (props: {
			formData?: { name?: string };
			updateFormData?: (u: Record<string, unknown>) => void;
		}) => {
			if (props.updateFormData && props.formData) {
				const update = props.updateFormData;
				return (
					<div data-testid="brief-step-stub">
						<input
							aria-label="Project Name"
							value={props.formData.name ?? ""}
							onChange={(e) => update({ name: e.target.value })}
						/>
						{/* Since Fizzy #2165 the wizard will not leave step 1
						    without a description past the readiness threshold
						    and a phase. One control here rather than a faithful
						    replica of the real fields: these tests are about the
						    wizard's routing and payload, and the fields' own
						    behaviour is covered in the step's tests. */}
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
}));

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

import { ProjectCreationWizard } from "../../ProjectCreationWizard";

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
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

/**
 * Fill the project brief. Since Fizzy #2165 the wizard requires more than a
 * name to leave step 1: a description over the readiness threshold and a phase,
 * because the checklist grades every project against both and nothing else
 * collects them. Development / Execution needs no expected start date.
 */
async function fillBasics(user: ReturnType<typeof userEvent.setup>) {
	await user.click(await screen.findByTestId("fill-project-basics"));
}

describe("ProjectCreationWizard — backlog INTEGRATION emission (D8 / AC#4)", () => {
	beforeEach(() => {
		createMutationFn.mockReset();
		startExistingSetupMock.mockReset();
		pushMock.mockReset();
		toastErrorMock.mockReset();
		toastWarningMock.mockReset();
		createIntegrationContextsMock.mockReset();
		createBacklogIntegrationContextMock.mockReset();
		createBacklogIntegrationContextMock.mockResolvedValue({
			created: true,
		});
		startExistingSetupMock.mockResolvedValue(undefined);
	});

	it("emits exactly one backlog INTEGRATION context with the PM metadata when a backlog is connected", async () => {
		const user = userEvent.setup();
		wrap(<ProjectCreationWizard />);

		const nameInput = await screen.findByLabelText(/project name/i);
		await user.type(nameInput, "Backlog Project");
		await fillBasics(user);
		await user.click(screen.getByTestId("connect-backlog-complete"));

		await gotoReviewAndCreate(user);

		await waitFor(() => {
			expect(createMutationFn).toHaveBeenCalledTimes(1);
		});
		await waitFor(() => {
			expect(createBacklogIntegrationContextMock).toHaveBeenCalledTimes(
				1,
			);
		});

		expect(createBacklogIntegrationContextMock).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj_new_1",
				// Personal context → org id null.
				organizationId: null,
				detectedType: "jira",
				mcpConfigId: "cfg-1",
				mcpServerId: "srv-1",
				containerId: "board-7",
				containerName: "Mobile Board",
			}),
		);
	});

	it("does NOT emit a backlog INTEGRATION context on the blank-optionals path (AC#3)", async () => {
		const user = userEvent.setup();
		wrap(<ProjectCreationWizard />);

		const nameInput = await screen.findByLabelText(/project name/i);
		await user.type(nameInput, "Brief Only Project");
		await fillBasics(user);

		await gotoReviewAndCreate(user);

		await waitFor(() => {
			expect(createMutationFn).toHaveBeenCalledTimes(1);
		});
		// The brief-only path lands on the post-create finish-setup step (D4,
		// §4.6) rather than redirecting, so synchronize on
		// `createIntegrationContexts` (always invoked first in onSuccess)
		// instead of `pushMock` (no longer called on this path).
		await waitFor(() => {
			expect(createIntegrationContextsMock).toHaveBeenCalled();
		});

		expect(createBacklogIntegrationContextMock).not.toHaveBeenCalled();
	});

	it("surfaces a warning toast and still redirects when the backlog emission fails (e.g. 30-cap)", async () => {
		createBacklogIntegrationContextMock.mockRejectedValue(
			new Error(
				"Maximum of 30 integration contexts allowed per project.",
			),
		);
		const user = userEvent.setup();
		wrap(<ProjectCreationWizard />);

		const nameInput = await screen.findByLabelText(/project name/i);
		await user.type(nameInput, "Capped Backlog Project");
		await fillBasics(user);
		await user.click(screen.getByTestId("connect-backlog-complete"));

		await gotoReviewAndCreate(user);

		await waitFor(() => {
			expect(createBacklogIntegrationContextMock).toHaveBeenCalledTimes(
				1,
			);
		});
		// The cap message is surfaced (not swallowed) …
		await waitFor(() => {
			expect(toastWarningMock).toHaveBeenCalledWith(
				expect.stringMatching(/Maximum of 30 integration contexts/),
			);
		});
		// … and the post-create redirect still happens.
		await waitFor(() => {
			expect(pushMock).toHaveBeenCalled();
		});
	});
});
