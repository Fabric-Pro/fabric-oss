/**
 * Step-counter invariance tests for the unified `ProjectCreationWizard`.
 *
 * Regression guard for the "step counter intermittently shows only 2 steps
 * (Brief, Review) instead of 5" bug. Connecting a repo during NEW-project
 * creation must NOT collapse the stepper: the wizard always presents the full
 * 5-step standard flow (Brief · Tech Stack · Modules · Review · Generate). A
 * connected repo changes only the Review-pane content + CTA label, never the
 * number of steps.
 *
 * The previous behavior dropped Tech Stack / Modules / Generate from the stepper
 * whenever a repo was present (`isCodeBased`), so "keeps all 5 steps after a
 * repo is connected" fails against the pre-fix code.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

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

vi.mock("next/navigation", () => ({
	useRouter: () => ({
		push: vi.fn(),
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
			existingSetup: { start: vi.fn() },
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			create: {
				mutationOptions: (opts: Record<string, unknown>) => ({
					mutationFn: async () => ({ project: { id: "proj_new_1" } }),
					...opts,
				}),
			},
			update: {
				mutationOptions: (opts: Record<string, unknown>) => ({
					mutationFn: async () => ({ project: { id: "p" } }),
					...opts,
				}),
			},
			saveDraft: {
				mutationOptions: (opts: Record<string, unknown>) => ({
					mutationFn: async () => ({
						created: false,
						project: { id: "p" },
					}),
					...opts,
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
		error: vi.fn(),
		info: vi.fn(),
		warning: vi.fn(),
	},
}));

// Brief-step stub: a project-name input + a button that connects a GitHub repo
// (sets `selectedGitHubRepos`). All other dynamic steps render an inert stub —
// the stepper labels we assert on are rendered by the wizard itself, not by the
// dynamic step components.
vi.mock("next/dynamic", () => ({
	default: (
		_loader: () => Promise<unknown>,
		_opts?: { ssr?: boolean; loading?: () => ReactNode },
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
							data-testid="connect-github-repo"
							onClick={() =>
								update({
									selectedGitHubRepos: [
										{
											name: "app",
											fullName: "acme/app",
											owner: "acme",
											htmlUrl:
												"https://github.com/acme/app",
											defaultBranch: "main",
											description: null,
											language: "TypeScript",
											isPrivate: false,
											updatedAt: "2026-01-01T00:00:00Z",
											stars: 0,
											isFork: false,
										},
									],
								})
							}
						>
							connect repo
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
	createIntegrationContexts: () =>
		Promise.resolve({ successCount: 0, failCount: 0 }),
	createBacklogIntegrationContext: () => Promise.resolve({ created: false }),
}));

vi.mock("../ReviewPromptsStep", () => ({
	ReviewPromptsStep: () => <div data-testid="review-prompts-stub" />,
}));

import { ProjectCreationWizard } from "../../ProjectCreationWizard";

function wrap(ui: ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

// Each stepper circle is a <button> whose accessible name starts with the step
// name (e.g. "Brief, current step", "Tech Stack"). All five must always exist.
const STEP_NAMES = ["Brief", "Tech Stack", "Modules", "Review", "Generate"];

function expectAllFiveSteps() {
	for (const name of STEP_NAMES) {
		expect(
			screen.getByRole("button", { name: new RegExp(`^${name}`, "i") }),
		).toBeInTheDocument();
	}
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

describe("ProjectCreationWizard — step-counter invariance", () => {
	it("shows all 5 steps on first render (no repo connected)", async () => {
		wrap(<ProjectCreationWizard />);
		await screen.findByTestId("brief-step-stub");
		expectAllFiveSteps();
	});

	it("keeps all 5 steps after a repo is connected (no code-based collapse)", async () => {
		const user = userEvent.setup();
		wrap(<ProjectCreationWizard />);

		const nameInput = await screen.findByLabelText(/project name/i);
		await user.type(nameInput, "Repo Project");
		await fillBasics(user);
		await user.click(screen.getByTestId("connect-github-repo"));

		// Tech Stack / Modules / Generate are exactly the steps the old
		// `isCodeBased` 2-step flow dropped — they must remain present.
		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: /Tech Stack/i }),
			).toBeInTheDocument();
		});
		expectAllFiveSteps();
	});

	it("a repo-connected project still gets the analysis Review pane + 'Create & Analyze' CTA", async () => {
		const user = userEvent.setup();
		wrap(<ProjectCreationWizard />);

		const nameInput = await screen.findByLabelText(/project name/i);
		await user.type(nameInput, "Repo Project");
		await fillBasics(user);
		await user.click(screen.getByTestId("connect-github-repo"));

		// Review is always step 4 now; jump straight to it.
		await user.click(screen.getByRole("button", { name: /^Review/i }));

		expect(
			await screen.findByText(/Review Before Analysis/i),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Create & Analyze/i }),
		).toBeInTheDocument();
	});
});

/**
 * Fizzy #2165. The checklist spreadsheet leaves project description, phase and
 * expected development start date off the checklist because they "will be
 * required during new project onboarding" — and nothing required them, so every
 * project was graded against a guessed phase and a description that might be
 * one word.
 *
 * The step circles let you jump to any step before the last, so a check that
 * lived only in the Next handler could be walked straight past. These assert
 * the circles honour it too.
 */
describe("the project brief has to be answered before moving on", () => {
	it("will not let the stepper skip past an unanswered brief", async () => {
		const user = userEvent.setup();
		wrap(<ProjectCreationWizard />);

		const nameInput = await screen.findByLabelText(/project name/i);
		await user.type(nameInput, "Half-filled Project");

		const techStackStep = screen.getByRole("button", {
			name: /Tech Stack/i,
		}) as HTMLButtonElement;
		expect(techStackStep.disabled).toBe(true);
	});

	it("opens the rest of the wizard once it is answered", async () => {
		const user = userEvent.setup();
		wrap(<ProjectCreationWizard />);

		const nameInput = await screen.findByLabelText(/project name/i);
		await user.type(nameInput, "Fully-filled Project");
		await fillBasics(user);

		await waitFor(() => {
			expect(
				(
					screen.getByRole("button", {
						name: /Tech Stack/i,
					}) as HTMLButtonElement
				).disabled,
			).toBe(false);
		});
	});
});
