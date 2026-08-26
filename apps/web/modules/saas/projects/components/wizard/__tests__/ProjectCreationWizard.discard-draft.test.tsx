/**
 * Component tests for `ProjectCreationWizard`'s Discard Draft handler
 * (Group 10 of the unified context-uploader wizard spec).
 *
 * Spec:
 * - fabric/specs/2026-05-23-unified-context-uploader-wizard/spec.md §6.2
 *   (Explicit "Discard Draft" trigger), §6.4 (silent cancellation), §7.3.
 * - fabric/specs/2026-05-23-unified-context-uploader-wizard/tasks.md Group 10.
 *
 * Scope (per tasks.md 10.3):
 *   (a) Happy path — clicking Discard Draft fires
 *       `orpcClient.projects.contexts.cancelDraftCrawls({ projectId, organizationId })`
 *       THEN `orpcClient.projects.delete({ id: projectId, organizationId })`
 *       in that order.
 *   (b) Cancel-rejects branch — even when `cancelDraftCrawls` throws, the
 *       delete call still fires.
 *
 * The test mocks both procedures at module boundary so call-order can be
 * asserted via `mock.calls` ordering. Heavy wizard-step children + the
 * draft-save mutation are mocked as inert stubs so the test focuses on the
 * footer button → handler wiring without spinning up the full wizard tree.
 *
 * No toast assertion — the cancel step is silent. A delete
 * failure DOES surface a toast (legitimate error state) but neither
 * scenario in (a)/(b) exercises a delete failure.
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
});

// ── Hoisted mock fns ─────────────────────────────────────────────────────

const {
	cancelDraftCrawlsMock,
	deleteProjectMock,
	pushMock,
	confirmMock,
	clearWizardSessionMock,
	saveDraftMock,
	projectGetMock,
	listDraftsMock,
	checkNameMock,
} = vi.hoisted(() => ({
	cancelDraftCrawlsMock: vi.fn(),
	deleteProjectMock: vi.fn(),
	pushMock: vi.fn(),
	// Default behaviour: auto-confirm. Individual tests can override.
	confirmMock: vi.fn((opts: { onConfirm: () => void | Promise<void> }) => {
		void opts.onConfirm();
	}),
	clearWizardSessionMock: vi.fn(),
	saveDraftMock: vi.fn(),
	projectGetMock: vi.fn(),
	listDraftsMock: vi.fn(),
	checkNameMock: vi.fn(),
}));

// ── Module mocks ─────────────────────────────────────────────────────────

vi.mock("next/navigation", () => ({
	useRouter: () => ({
		push: pushMock,
		replace: vi.fn(),
		prefetch: vi.fn(),
		back: vi.fn(),
	}),
	usePathname: () => "/app/projects/new",
	useSearchParams: () => new URLSearchParams("?projectId=proj_draft_test"),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		organizationSlug: null,
		basePath: "/app",
	}),
}));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: confirmMock }),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			contexts: {
				cancelDraftCrawls: (input: unknown) =>
					cancelDraftCrawlsMock(input),
			},
			delete: (input: unknown) => deleteProjectMock(input),
			// Unused in this test, but the wizard body references the unified
			// post-create workflow start (O1, spec §4.7) in its create/update
			// `onSuccess`. Stub it so the module-boundary mock matches the
			// surface the wizard touches. (The retired `github.startCodeSetup` /
			// `gitlab.startCodeSetup` calls are gone — see the submit-payload
			// test for the routing assertions.)
			existingSetup: {
				start: vi.fn(),
			},
		},
	},
}));

// `orpc.projects.*` query/mutation options. The wizard uses:
//   - `orpc.projects.saveDraft.mutationOptions(...)`
//   - `orpc.projects.listDrafts.queryOptions({ input })` (.queryKey lookup)
//   - `orpc.projects.get.call({...})` via the existing-project query
//   - `orpc.projects.checkName.queryOptions(...)` (in child step)
//
// All other oRPC routers used by child steps are mocked indirectly via the
// dynamic-import mock below.
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			create: {
				mutationOptions: (opts: Record<string, unknown>) => ({
					mutationFn: async () => undefined,
					...opts,
				}),
			},
			update: {
				mutationOptions: (opts: Record<string, unknown>) => ({
					mutationFn: async () => undefined,
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
					mutationFn: async (input: unknown) => saveDraftMock(input),
					onSuccess: opts.onSuccess,
				}),
			},
			listDrafts: {
				queryOptions: ({ input }: { input: unknown }) => ({
					queryKey: ["projects.listDrafts", input] as const,
					queryFn: () => listDraftsMock(input),
				}),
			},
			get: {
				call: (input: unknown) => projectGetMock(input),
			},
			checkName: {
				queryOptions: ({ input }: { input: unknown }) => ({
					queryKey: ["projects.checkName", input] as const,
					queryFn: () => checkNameMock(input),
				}),
			},
			// Post-H4 fix: BasicInfoStep also calls `projects.contexts.list`
			// to derive attachmentSummaries for refine. No-op mock returning
			// an empty contexts list keeps the wizard render happy.
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
				mutationOptions: () => ({
					mutationFn: async () => undefined,
				}),
			},
		},
	},
}));

// Wizard session persistence: capture `clear()` so the test can assert it
// runs after a successful discard.
vi.mock("../../../hooks/use-wizard-session-persistence", () => ({
	useWizardSessionPersistence: () => ({
		save: vi.fn(),
		clear: clearWizardSessionMock,
	}),
}));

// Sonner: capture the toast call. We DON'T assert against it on the silent
// path (cancellation is silent per §6.4); the cancel-rejects test simply
// proves the delete still fires regardless.
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// `next/dynamic` returns the heavy step components via async import. Replace
// the dynamic loader with a trivial stub so the steps render as inert
// placeholders — the test only cares about the footer button.
vi.mock("next/dynamic", () => ({
	default: (
		_loader: () => Promise<unknown>,
		_opts?: { ssr?: boolean; loading?: () => React.ReactNode },
	) => {
		const Stub = () => <div data-testid="dynamic-step-stub" />;
		Stub.displayName = "DynamicStepStub";
		return Stub;
	},
}));

// `create-integration-contexts` is invoked from the activation path only; not
// exercised here, but stub the import so it doesn't pull in heavy deps.
vi.mock("../../../lib/create-integration-contexts", () => ({
	createIntegrationContexts: vi.fn(),
}));

// Import after mocks ───────────────────────────────────────────────────────
import { ProjectCreationWizard } from "../../ProjectCreationWizard";

// ── Helpers ──────────────────────────────────────────────────────────────

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

/**
 * Render the wizard in a state where a DRAFT exists in this session.
 *
 * The simplest way to get `canDiscardDraft === true` is to hand the
 * component a `projectId` prop AND have the project-get query resolve to a
 * row with `status: "DRAFT"`. The hydration effect then fires
 * `setIsDraftResume(true)` + `setCreatedProjectId(project.id)`, so the
 * Discard button renders even though `isEditMode === true`.
 */
function renderWizardWithDraft(projectId = "proj_draft_test") {
	projectGetMock.mockResolvedValue({
		project: {
			id: projectId,
			status: "DRAFT",
			name: "Draft in flight",
			description: null,
			features: [],
			contexts: [],
			wizardState: null,
		},
	});
	checkNameMock.mockResolvedValue({ available: true });
	listDraftsMock.mockResolvedValue({ drafts: [] });
	return wrap(<ProjectCreationWizard projectId={projectId} />);
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("ProjectCreationWizard — Discard Draft (Group 10)", () => {
	beforeEach(() => {
		cancelDraftCrawlsMock.mockReset();
		deleteProjectMock.mockReset();
		pushMock.mockReset();
		clearWizardSessionMock.mockReset();
		saveDraftMock.mockReset();
		projectGetMock.mockReset();
		listDraftsMock.mockReset();
		checkNameMock.mockReset();
		// Reset confirmMock but keep the auto-confirm behaviour.
		confirmMock.mockReset();
		confirmMock.mockImplementation(
			(opts: { onConfirm: () => void | Promise<void> }) => {
				void opts.onConfirm();
			},
		);
	});

	// ── (a) Happy path: cancel BEFORE delete, in order ─────────────────────
	it("fires cancelDraftCrawls then projects.delete in that order on confirmed Discard", async () => {
		cancelDraftCrawlsMock.mockResolvedValue({
			cancelledCount: 2,
			skippedTerminalCount: 0,
			errors: [],
		});
		deleteProjectMock.mockResolvedValue({
			success: true,
			softDeleted: true,
		});

		renderWizardWithDraft("proj_draft_42");

		// The Discard button only renders once the hydration effect has
		// flipped `isDraftResume = true` (after the project-get query
		// resolves). Wait for it before clicking.
		const button = await screen.findByTestId("discard-draft-button");
		expect(button).toBeInTheDocument();
		expect(button).toHaveAttribute("aria-label", "Discard draft");

		const user = userEvent.setup();
		await user.click(button);

		// The confirm modal is auto-confirmed via the mock. Wait for both
		// procedures to fire — the cancel runs before delete inside the
		// onConfirm handler.
		await waitFor(() => {
			expect(deleteProjectMock).toHaveBeenCalledTimes(1);
		});

		// (1) Cancel was called once, with the DRAFT projectId + null org.
		expect(cancelDraftCrawlsMock).toHaveBeenCalledTimes(1);
		expect(cancelDraftCrawlsMock).toHaveBeenCalledWith({
			projectId: "proj_draft_42",
			organizationId: null,
		});

		// (2) Delete was called once, with the same id.
		expect(deleteProjectMock).toHaveBeenCalledWith({
			id: "proj_draft_42",
			organizationId: null,
		});

		// (3) Ordering: cancel finished before delete started. Vitest mocks
		// stamp `invocationCallOrder` per call; assert cancel < delete.
		const cancelOrder =
			cancelDraftCrawlsMock.mock.invocationCallOrder[0] ?? 0;
		const deleteOrder = deleteProjectMock.mock.invocationCallOrder[0] ?? 0;
		expect(cancelOrder).toBeLessThan(deleteOrder);

		// (4) Post-delete: caches invalidated and sessionStorage cleared,
		// then the user is pushed back to /app/projects.
		await waitFor(() => {
			expect(clearWizardSessionMock).toHaveBeenCalled();
		});
		expect(pushMock).toHaveBeenCalledWith("/app/projects");
	});

	// ── (b) Cancel rejects, delete still fires ─────────────────────────────
	it("still fires projects.delete when cancelDraftCrawls rejects", async () => {
		cancelDraftCrawlsMock.mockRejectedValue(
			new Error("boom — temporal unreachable"),
		);
		deleteProjectMock.mockResolvedValue({
			success: true,
			softDeleted: true,
		});

		renderWizardWithDraft("proj_draft_99");

		const button = await screen.findByTestId("discard-draft-button");
		const user = userEvent.setup();
		await user.click(button);

		// Cancel was attempted (and rejected).
		await waitFor(() => {
			expect(cancelDraftCrawlsMock).toHaveBeenCalledTimes(1);
		});

		// Delete still fired — that's the contract spec §6.2 pins.
		await waitFor(() => {
			expect(deleteProjectMock).toHaveBeenCalledTimes(1);
		});
		expect(deleteProjectMock).toHaveBeenCalledWith({
			id: "proj_draft_99",
			organizationId: null,
		});

		// Ordering still holds: cancel ran first.
		const cancelOrder =
			cancelDraftCrawlsMock.mock.invocationCallOrder[0] ?? 0;
		const deleteOrder = deleteProjectMock.mock.invocationCallOrder[0] ?? 0;
		expect(cancelOrder).toBeLessThan(deleteOrder);
	});
});
