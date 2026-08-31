/**
 * Fizzy #1875 (R11): automation templates now mount in BOTH route trees, so
 * every navigation they perform has to follow the tree they were opened in.
 *
 * These tests assert the TRANSITIONS, not the render. Before this change the
 * three components hard-coded `/app/automation-templates/...` in five places —
 * an organization-rooted page would have rendered perfectly and then walked the
 * user into the personal tree on the first click. A render-only test passes on
 * exactly that broken version, so each case here drives a real interaction and
 * inspects where the router was sent.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { push, listTemplates, createTemplate } = vi.hoisted(() => ({
	push: vi.fn(),
	listTemplates: vi.fn(),
	createTemplate: vi.fn(),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({
		push,
		replace: vi.fn(),
		back: vi.fn(),
		refresh: vi.fn(),
	}),
	usePathname: () => "/app",
	useParams: () => ({}),
	useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		automationTemplates: {
			list: {
				queryOptions: (opts: { input: unknown }) => ({
					queryKey: ["automationTemplates", "list", opts.input],
					queryFn: () => listTemplates(opts.input),
				}),
			},
			get: {
				queryOptions: (opts: { input: unknown }) => ({
					queryKey: ["automationTemplates", "get", opts.input],
					queryFn: async () => null,
				}),
			},
			create: {
				mutationOptions: (opts: {
					onSuccess?: (data: unknown) => void;
					onError?: (error: Error) => void;
				}) => ({
					mutationFn: (input: unknown) => createTemplate(input),
					onSuccess: opts.onSuccess,
					onError: opts.onError,
				}),
			},
			update: {
				mutationOptions: (opts: {
					onSuccess?: (data: unknown) => void;
					onError?: (error: Error) => void;
				}) => ({
					mutationFn: async () => ({}),
					onSuccess: opts.onSuccess,
					onError: opts.onError,
				}),
			},
			execute: {
				mutationOptions: (opts: {
					onSuccess?: (data: unknown) => void;
				}) => ({
					mutationFn: async () => ({}),
					onSuccess: opts?.onSuccess,
				}),
			},
			delete: {
				mutationOptions: (opts: {
					onSuccess?: (data: unknown) => void;
				}) => ({
					mutationFn: async () => ({}),
					onSuccess: opts?.onSuccess,
				}),
			},
		},
	},
}));

// The header pulls in the whole "Get started" controller; this suite is about
// where a click sends the router, not about the Compass launcher.
vi.mock("@saas/shared/components/PageHeader", () => ({
	PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

import type { ActiveOrganization } from "@repo/auth";
import { TemplateEditor } from "@saas/automation-templates/components/TemplateEditor";
import { TemplatesList } from "@saas/automation-templates/components/TemplatesList";
import { ActiveOrganizationContext } from "@saas/organizations/lib/active-organization-context";

const TEMPLATE = {
	id: "tpl-1",
	name: "Nightly invoice pull",
	description: null,
	category: null,
	tags: [],
	isPublic: false,
	useCount: 3,
	lastUsedAt: null,
	createdAt: new Date("2026-08-01T00:00:00.000Z").toISOString(),
	updatedAt: new Date("2026-08-01T00:00:00.000Z").toISOString(),
	version: 1,
	parameters: [],
};

/**
 * The active organization is derived from the URL slug by
 * `ActiveOrganizationProvider`, so seeding the context here is the same signal
 * a real organization-rooted route produces.
 */
function withContext(organizationSlug: string | null) {
	const activeOrganization = organizationSlug
		? ({
				id: "org-1",
				slug: organizationSlug,
				name: "Example Org",
				members: [],
			} as unknown as ActiveOrganization)
		: null;

	return function Wrapper({ children }: { children: ReactNode }) {
		const client = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		});
		return (
			<QueryClientProvider client={client}>
				<ActiveOrganizationContext.Provider
					value={{
						activeOrganization,
						activeOrganizationUserRole: null,
						isOrganizationAdmin: false,
						loaded: true,
						isSwitching: false,
						switchingToSlug: null,
						setActiveOrganization: async () => {},
						refetchActiveOrganization: async () => {},
					}}
				>
					{children}
				</ActiveOrganizationContext.Provider>
			</QueryClientProvider>
		);
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	listTemplates.mockResolvedValue({ templates: [TEMPLATE], total: 1 });
	createTemplate.mockResolvedValue({ template: { id: "tpl-new" } });
});

describe("automation templates — navigation follows the tree it was opened in", () => {
	describe("inside an organization", () => {
		it("opens a template at the organization-rooted route", async () => {
			render(<TemplatesList organizationId="org-1" />, {
				wrapper: withContext("example-org"),
			});

			const view = await screen.findByRole("button", { name: /^view$/i });
			await userEvent.click(view);

			expect(push).toHaveBeenCalledWith(
				"/app/example-org/automation-templates/tpl-1",
			);
			expect(push).not.toHaveBeenCalledWith(
				"/app/automation-templates/tpl-1",
			);
		});

		it("creates a template at the organization-rooted route", async () => {
			render(<TemplatesList organizationId="org-1" />, {
				wrapper: withContext("example-org"),
			});

			await userEvent.click(
				await screen.findByRole("button", { name: /new template/i }),
			);

			expect(push).toHaveBeenCalledWith(
				"/app/example-org/automation-templates/new",
			);
			expect(push).not.toHaveBeenCalledWith(
				"/app/automation-templates/new",
			);
		});

		it("lands a saved template on the organization-rooted route", async () => {
			render(<TemplateEditor organizationId="org-1" />, {
				wrapper: withContext("example-org"),
			});

			await userEvent.type(
				screen.getByLabelText(/name/i),
				"Nightly invoice pull",
			);
			await userEvent.click(
				screen.getByRole("button", { name: /^create$/i }),
			);

			await waitFor(() =>
				expect(push).toHaveBeenCalledWith(
					"/app/example-org/automation-templates/tpl-new",
				),
			);
			expect(push).not.toHaveBeenCalledWith(
				"/app/automation-templates/tpl-new",
			);
		});
	});

	describe("in personal context (unchanged by this change)", () => {
		it("opens a template at the personal route", async () => {
			render(<TemplatesList />, { wrapper: withContext(null) });

			await userEvent.click(
				await screen.findByRole("button", { name: /^view$/i }),
			);

			expect(push).toHaveBeenCalledWith(
				"/app/automation-templates/tpl-1",
			);
		});

		it("creates a template at the personal route", async () => {
			render(<TemplatesList />, { wrapper: withContext(null) });

			await userEvent.click(
				await screen.findByRole("button", { name: /new template/i }),
			);

			expect(push).toHaveBeenCalledWith("/app/automation-templates/new");
		});

		it("lands a saved template on the personal route", async () => {
			render(<TemplateEditor />, { wrapper: withContext(null) });

			await userEvent.type(
				screen.getByLabelText(/name/i),
				"Nightly invoice pull",
			);
			await userEvent.click(
				screen.getByRole("button", { name: /^create$/i }),
			);

			await waitFor(() =>
				expect(push).toHaveBeenCalledWith(
					"/app/automation-templates/tpl-new",
				),
			);
		});
	});
});
