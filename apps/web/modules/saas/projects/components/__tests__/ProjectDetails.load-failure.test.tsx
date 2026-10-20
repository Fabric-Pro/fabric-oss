/**
 * What the project page says when `projects.get` produced no project.
 *
 * Staging, right after sign-in: the page mounted while the session still named
 * another organization, `projects.get` came back FORBIDDEN, and the page told
 * the user the project did not exist — with a "Back to Projects" button that
 * left the organization for `/app/projects`. Only an absent project is "not
 * found"; any other failure is a load error that offers a retry, and the way
 * back stays inside the workspace on screen.
 *
 * The harness mirrors `ProjectDetails.tab-deep-link.test.tsx`; only the
 * project read and the organization context differ.
 */

import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isProjectNotFound } from "../ProjectUnavailable";

vi.mock("@saas/get-started/components/ProjectRoleConfirmationPrompt", () => ({
	ProjectRoleConfirmationPrompt: () => null,
}));

const { nav, projectRead } = vi.hoisted(() => ({
	nav: {
		router: {
			replace: vi.fn(),
			push: vi.fn(),
			prefetch: vi.fn(),
			back: vi.fn(),
		},
	},
	projectRead: vi.fn(),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => nav.router,
	usePathname: () => "/app/acme/projects/proj-1",
	useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/dynamic", () => ({
	default: () => {
		function DynamicTabStub() {
			return <div data-testid="dynamic-tab-stub" />;
		}
		return DynamicTabStub;
	},
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({
		user: { id: "test-user-id", name: "Test User" },
		session: { id: "test-session" },
		loaded: true,
		reloadSession: vi.fn(),
	}),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-acme",
		organizationSlug: "acme",
		organizationName: "Acme",
		basePath: "/app/acme",
		isOrgContext: true,
		isPersonalContext: false,
		isOrganizationAdmin: false,
		userRole: "member",
		loaded: true,
		organization: null,
	}),
}));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: vi.fn() }),
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));

vi.mock("@saas/shared/components/PageBreadcrumbs", () => ({
	PageBreadcrumbs: () => <nav data-testid="breadcrumbs-stub" />,
}));

vi.mock("@saas/agents/components/FabricAgentLauncher", () => ({
	useRegisterFabricAgentContext: vi.fn(),
}));

vi.mock("../../hooks", () => ({
	useProjectPresence: vi.fn(),
}));

vi.mock("../ProjectHeader", () => ({
	ProjectHeader: () => <div data-testid="project-header-stub" />,
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			github: { setupStatus: vi.fn() },
			restore: vi.fn(),
			permanentDelete: vi.fn(),
			recordVisit: vi.fn().mockResolvedValue({ recorded: true }),
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			members: {
				list: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["projects", "members", "list", input],
						queryFn: async () => [],
					}),
				},
			},
			readiness: {
				requestCliConnection: {
					mutationOptions: (options: Record<string, unknown>) => ({
						mutationFn: async () => ({
							notifiedCount: 0,
							recipientCount: 0,
							ineligibleCount: 0,
						}),
						...options,
					}),
				},
			},
			get: {
				queryOptions: ({ input }: { input: unknown }) => ({
					queryKey: ["projects.get", input],
					queryFn: () => projectRead(),
				}),
			},
			testCases: {
				list: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["projects.testCases.list", input],
						queryFn: async () => ({ items: [], total: 0 }),
					}),
				},
			},
			tabVisibility: {
				get: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["projects.tabVisibility.get", input],
						queryFn: async () => ({ config: null }),
					}),
				},
			},
			tabPreferences: {
				get: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["projects.tabPreferences.get", input],
						queryFn: async () => ({ prefs: null }),
					}),
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

import { ProjectDetails } from "../ProjectDetails";

const TEST_PROJECT = {
	id: "proj-1",
	name: "Test Project",
	userRole: "owner",
	canEditSettings: true,
	canPublish: true,
	deletedAt: null,
	codeAnalysisStatus: "COMPLETED",
	repositoryUrl: null,
	repositoryOwner: null,
	repositoryName: null,
	scheduledPermanentDeleteAt: null,
};

function renderProjectDetails() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<ProjectDetails projectId="proj-1" organizationSlug="acme" />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	nav.router.push.mockClear();
	projectRead.mockReset();
	window.sessionStorage.clear();
});

describe("ProjectDetails — a project that did not load", () => {
	it("shows a load error with a retry, not 'not found', for a FORBIDDEN read", async () => {
		projectRead.mockRejectedValue(
			new ORPCError("FORBIDDEN", { message: "Not a member" }),
		);

		renderProjectDetails();

		expect(
			await screen.findByText("Couldn't load this project"),
		).toBeInTheDocument();
		expect(screen.queryByText("Project not found")).toBeNull();
		expect(
			screen.getByRole("button", { name: /try again/i }),
		).toBeInTheDocument();
	});

	it("re-reads the project on retry and shows it once it loads", async () => {
		const user = userEvent.setup();
		projectRead
			.mockRejectedValueOnce(
				new ORPCError("FORBIDDEN", { message: "Not a member" }),
			)
			.mockResolvedValue({ project: TEST_PROJECT });

		renderProjectDetails();

		await user.click(
			await screen.findByRole("button", { name: /try again/i }),
		);

		expect(
			await screen.findByTestId("project-header-stub"),
		).toBeInTheDocument();
		expect(projectRead).toHaveBeenCalledTimes(2);
	});

	it("shows 'not found' without a retry for a NOT_FOUND read", async () => {
		projectRead.mockRejectedValue(
			new ORPCError("NOT_FOUND", { message: "Project not found" }),
		);

		renderProjectDetails();

		expect(
			await screen.findByText("Project not found"),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
	});

	it("goes back to the projects list of the workspace on screen", async () => {
		const user = userEvent.setup();
		projectRead.mockRejectedValue(
			new ORPCError("NOT_FOUND", { message: "Project not found" }),
		);

		renderProjectDetails();

		await user.click(
			await screen.findByRole("button", { name: "Back to Projects" }),
		);

		expect(nav.router.push).toHaveBeenCalledWith("/app/acme/projects");
	});
});

describe("isProjectNotFound", () => {
	it("treats an empty answer and a NOT_FOUND as absent", () => {
		expect(isProjectNotFound(null)).toBe(true);
		expect(isProjectNotFound(new ORPCError("NOT_FOUND"))).toBe(true);
	});

	it("treats every other failure as a failed read", () => {
		expect(isProjectNotFound(new ORPCError("FORBIDDEN"))).toBe(false);
		expect(isProjectNotFound(new ORPCError("INTERNAL_SERVER_ERROR"))).toBe(
			false,
		);
		expect(isProjectNotFound(new TypeError("Failed to fetch"))).toBe(false);
	});
});
