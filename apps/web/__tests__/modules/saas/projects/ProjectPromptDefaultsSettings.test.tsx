/**
 * The project tier's first UI (Fizzy #2068, Kiran's ask).
 *
 * `PromptBinding` has carried a `projectId` and the resolver has ranked it
 * between the organization's default and a personal override for some time, but
 * nothing could create one — the catalog could display a tier no surface could
 * set. These tests pin the two things most likely to be got wrong: that the
 * write is an ORG binding narrowed by `projectId` rather than some new scope,
 * and that the controls appear for exactly the people the server will accept.
 *
 * Run with:
 *   pnpm --filter web test __tests__/modules/saas/projects/ProjectPromptDefaultsSettings.test.tsx
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { catalogList, bindSet, bindClear, useActiveOrganization } = vi.hoisted(
	() => ({
		catalogList: vi.fn(),
		bindSet: vi.fn(),
		bindClear: vi.fn(),
		useActiveOrganization: vi.fn(),
	}),
);

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: {
			catalog: { list: catalogList },
			bind: { set: bindSet, clear: bindClear },
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-a",
		basePath: "/app/acme",
		isOrgContext: true,
	}),
}));

vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization,
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

import { ProjectPromptDefaultsSettings } from "@saas/projects/components/ProjectPromptDefaultsSettings";
import { toast } from "sonner";

const PROJECT = "proj-1";
const ACTION = "test_case_drafter";

/** One catalog entry for the action under test. */
const entry = (over: Record<string, unknown> = {}) => ({
	targetKey: ACTION,
	documentType: "GENERAL",
	storyKind: null,
	effectiveScope: "ORG",
	prompts: [
		{
			promptId: "p-org",
			promptName: "Org QA Strategy",
			promptVersionId: "pv-org",
			scope: "ORG",
			projectId: null,
			isDefault: true,
			isEffective: true,
		},
		{
			promptId: "p-sys",
			promptName: "Fabric QA Strategy",
			promptVersionId: "pv-sys",
			scope: "SYSTEM",
			projectId: null,
			isDefault: true,
			isEffective: false,
		},
	],
	...over,
});

const wrap = () =>
	render(
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false } },
				})
			}
		>
			<ProjectPromptDefaultsSettings projectId={PROJECT} />
		</QueryClientProvider>,
	);

beforeEach(() => {
	vi.clearAllMocks();
	useActiveOrganization.mockReturnValue({ isOrganizationAdmin: true });
	catalogList.mockResolvedValue({ entries: [entry()] });
	bindSet.mockResolvedValue({});
	bindClear.mockResolvedValue({});
});

describe("setting a prompt for one project", () => {
	it("asks the catalog for this project's view, not the organization's", async () => {
		wrap();
		await waitFor(() =>
			expect(catalogList).toHaveBeenCalledWith(
				expect.objectContaining({
					organizationId: "org-a",
					projectId: PROJECT,
				}),
			),
		);
	});

	it("writes an ORG binding narrowed to the project, not a new scope", async () => {
		// The tier is not its own scope in the data model. Writing scope
		// "PROJECT" would be rejected by the input schema, and writing ORG
		// without the projectId would change the whole organization's default —
		// the failure worth pinning.
		const user = userEvent.setup();
		wrap();

		// Every action renders at once with no tier; the catalog resolves after.
		// Waiting on the prompt name waits for the data this assertion needs.
		await screen.findByText(/Org QA Strategy/);
		await user.click(
			screen.getByRole("combobox", {
				name: /Set the prompt this project uses for Test Case Drafter/i,
			}),
		);
		await user.click(await screen.findByText("Fabric QA Strategy"));

		await waitFor(() =>
			expect(bindSet).toHaveBeenCalledWith(
				expect.objectContaining({
					targetType: "AGENT",
					targetKey: ACTION,
					documentType: "GENERAL",
					scope: "ORG",
					organizationId: "org-a",
					projectId: PROJECT,
					promptVersionId: "pv-sys",
					isDefault: true,
				}),
			),
		);
	});

	it("says so when the write stands the writer's own personal default down", async () => {
		// Setting an ORG-scope default clears the caller's personal default for
		// that action, server-side. Reported here because the alternative is
		// finding out days later, on another screen, with nothing tying it back
		// to this click.
		catalogList.mockResolvedValue({
			entries: [entry({ effectiveScope: "USER" })],
		});
		const user = userEvent.setup();
		wrap();

		await screen.findByText(/Org QA Strategy/);
		await user.click(
			screen.getByRole("combobox", {
				name: /Set the prompt this project uses for Test Case Drafter/i,
			}),
		);
		await user.click(await screen.findByText("Fabric QA Strategy"));

		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith(
				"This project now uses that prompt",
				expect.objectContaining({
					description: expect.stringMatching(
						/personal default for this action was cleared/i,
					),
				}),
			),
		);
	});

	it("stays quiet about a personal default the writer does not have", async () => {
		const user = userEvent.setup();
		wrap();

		await screen.findByText(/Org QA Strategy/);
		await user.click(
			screen.getByRole("combobox", {
				name: /Set the prompt this project uses for Test Case Drafter/i,
			}),
		);
		await user.click(await screen.findByText("Fabric QA Strategy"));

		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith(
				"This project now uses that prompt",
				{ description: undefined },
			),
		);
	});

	it("clears the project's own binding and leaves the organization's alone", async () => {
		catalogList.mockResolvedValue({
			entries: [
				entry({
					effectiveScope: "PROJECT",
					prompts: [
						{
							promptId: "p-proj",
							promptName: "Project QA Strategy",
							promptVersionId: "pv-proj",
							scope: "ORG",
							projectId: PROJECT,
							isDefault: true,
							isEffective: true,
						},
					],
				}),
			],
		});
		const user = userEvent.setup();
		wrap();

		await user.click(
			await screen.findByRole("button", {
				name: /Clear the project override for Test Case Drafter/i,
			}),
		);

		await waitFor(() =>
			expect(bindClear).toHaveBeenCalledWith(
				expect.objectContaining({
					scope: "ORG",
					organizationId: "org-a",
					projectId: PROJECT,
					targetKey: ACTION,
				}),
			),
		);
	});

	it("counts what this project has chosen for itself", async () => {
		catalogList.mockResolvedValue({
			entries: [
				entry({
					effectiveScope: "PROJECT",
					prompts: [
						{
							promptId: "p-proj",
							promptName: "Project Drafter",
							promptVersionId: "pv-proj",
							scope: "ORG",
							projectId: PROJECT,
							isDefault: true,
							isEffective: true,
						},
					],
				}),
			],
		});
		wrap();
		expect(
			await screen.findByText(/1 of \d+ actions use a prompt chosen/i),
		).toBeInTheDocument();
	});
});

describe("who is offered the controls", () => {
	it("offers nothing to write to someone who is not an organization admin", async () => {
		// A project admin holds PROJECT_SETTINGS_EDIT but not organization
		// admin, and `bind.set` refuses them. Showing the control would be an
		// affordance the server rejects.
		useActiveOrganization.mockReturnValue({ isOrganizationAdmin: false });
		wrap();

		await screen.findByText(/Org QA Strategy/);
		expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", {
				name: /Clear the project override/i,
			}),
		).not.toBeInTheDocument();
		expect(
			screen.getByText(
				/Organization admins and owners can change these/i,
			),
		).toBeInTheDocument();
	});

	it("still shows a non-admin which prompt the project runs", async () => {
		useActiveOrganization.mockReturnValue({ isOrganizationAdmin: false });
		wrap();
		expect(await screen.findByText(/Org QA Strategy/)).toBeInTheDocument();
	});
});

describe("when the catalog cannot be read", () => {
	it("says so instead of reporting no overrides", async () => {
		catalogList.mockRejectedValue(new Error("database unavailable"));
		wrap();

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(
			"Could not load which prompts this project uses.",
		);
		expect(alert).not.toHaveTextContent("database unavailable");
		expect(
			within(alert).getByRole("button", { name: "Try again" }),
		).toBeInTheDocument();
	});
});

describe("a personal override on top of a project default", () => {
	/** The project has its own default AND the reader personally overrode the
	 *  same action. USER outranks PROJECT, so `effectiveScope` is "USER". */
	const shadowed = () =>
		catalogList.mockResolvedValue({
			entries: [
				entry({
					effectiveScope: "USER",
					prompts: [
						{
							promptId: "p-mine",
							promptName: "My Own Drafter",
							promptVersionId: "pv-mine",
							scope: "USER",
							projectId: null,
							isDefault: true,
							isEffective: true,
						},
						{
							promptId: "p-proj",
							promptName: "Project Drafter",
							promptVersionId: "pv-proj",
							scope: "ORG",
							projectId: PROJECT,
							isDefault: true,
							isEffective: false,
						},
					],
				}),
			],
		});

	it("still counts the project's own choice", async () => {
		// Bucketing on effectiveScope would file this under "inherited" and
		// report zero, telling an admin their project default does not exist.
		shadowed();
		wrap();
		expect(
			await screen.findByText(/1 of \d+ actions use a prompt chosen/i),
		).toBeInTheDocument();
	});

	it("still offers Clear for the project's own binding", async () => {
		shadowed();
		wrap();
		expect(
			await screen.findByRole("button", {
				name: /Clear the project override for Test Case Drafter/i,
			}),
		).toBeInTheDocument();
	});

	it("names the project's prompt and says the personal one runs instead", async () => {
		shadowed();
		wrap();
		expect(await screen.findByText(/Project Drafter/)).toBeInTheDocument();
		expect(
			screen.getByText(/your personal default runs instead/i),
		).toBeInTheDocument();
	});
});

describe("the inherited section toggle", () => {
	it("closes on the first click when it opened itself", async () => {
		// It auto-opens when the project has overridden nothing. Negating the
		// raw state rather than the displayed value makes the first click a
		// no-op, so the reader has to click "Hide" twice.
		const user = userEvent.setup();
		wrap();
		await screen.findByText(/Org QA Strategy/);

		const toggle = screen.getByRole("button", { name: /Inherited/ });
		expect(toggle).toHaveAttribute("aria-expanded", "true");

		await user.click(toggle);
		expect(toggle).toHaveAttribute("aria-expanded", "false");
	});
});
