/**
 * The project tier's first UI (Fizzy #2068, project tier).
 *
 * `PromptBinding` has carried a `projectId` and the resolver has ranked it
 * between the organization's default and a personal override for some time, but
 * nothing could create one — the catalog could display a tier no surface could
 * set. These tests pin the two things most likely to be got wrong: that the
 * write is an ORG binding narrowed by `projectId` rather than some new scope,
 * and that the controls appear for exactly the people the server will accept.
 *
 * The list is grouped by product area with the first area open, so a test
 * about an action elsewhere opens its group first. The flat "Inherited" list
 * and the per-row select it replaced are gone; the "Change" popover is the
 * picker now.
 *
 * Run with:
 *   pnpm --filter web test __tests__/modules/saas/projects/ProjectPromptDefaultsSettings.test.tsx
 */

import {
	listOfferedPromptActions,
	listPromptActions,
} from "@repo/utils/prompt-action-catalog";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The prompt actions offered depend on the Proposal artifact gate (Fizzy
// #2946), read through `useFeatureFlag`, which throws without a provider.
const flags = vi.hoisted(() => ({ proposalArtifact: false }));
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) =>
		key === "PROPOSAL_ARTIFACT" ? flags.proposalArtifact : false,
}));

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
			bindings: { set: bindSet, clear: bindClear },
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
const ACTION_ID = `${ACTION}:GENERAL:ANY`;
const QUALITY = /^Quality & Testing/;

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

const projectOverride = (promptName = "Project QA Strategy") =>
	entry({
		effectiveScope: "PROJECT",
		prompts: [
			{
				promptId: "p-proj",
				promptName,
				promptVersionId: "pv-proj",
				scope: "ORG",
				projectId: PROJECT,
				isDefault: true,
				isEffective: true,
			},
		],
	});

const wrap = (
	props: Partial<
		React.ComponentProps<typeof ProjectPromptDefaultsSettings>
	> = {},
) =>
	render(
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { queries: { retry: false } },
				})
			}
		>
			<ProjectPromptDefaultsSettings projectId={PROJECT} {...props} />
		</QueryClientProvider>,
	);

/** Waits for the catalog, then opens one product-area group. */
async function openGroup(
	user: ReturnType<typeof userEvent.setup>,
	name: RegExp,
) {
	await user.click(await screen.findByRole("button", { name }));
}

const changeButton = (label: string | RegExp) =>
	screen.getByRole("button", {
		name:
			typeof label === "string"
				? `Change the prompt this project uses for ${label}`
				: label,
	});

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

		await openGroup(user, QUALITY);
		await screen.findByText(/Org QA Strategy/);
		await user.click(changeButton("Test Case Drafter"));
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

		await openGroup(user, QUALITY);
		await user.click(changeButton("Test Case Drafter"));
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

		await openGroup(user, QUALITY);
		await user.click(changeButton("Test Case Drafter"));
		await user.click(await screen.findByText("Fabric QA Strategy"));

		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith(
				"This project now uses that prompt",
				{ description: undefined },
			),
		);
	});

	it("clears the project's own binding and leaves the organization's alone", async () => {
		catalogList.mockResolvedValue({ entries: [projectOverride()] });
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
			entries: [projectOverride("Project Drafter")],
		});
		wrap();
		expect(
			await screen.findByText(/1 of \d+ actions use a prompt chosen/i),
		).toBeInTheDocument();
	});

	it("lists the project's choices on top, each with its prompt and Clear", async () => {
		catalogList.mockResolvedValue({ entries: [projectOverride()] });
		wrap();

		const chosen = await screen.findByRole("region", {
			name: "Chosen for this project",
		});
		expect(
			within(chosen).getByText("Test Case Drafter"),
		).toBeInTheDocument();
		expect(
			within(chosen).getByRole("link", { name: "Project QA Strategy" }),
		).toHaveAttribute("href", "/app/acme/prompts/p-proj");
		expect(
			within(chosen).getByRole("button", {
				name: "Clear the project override for Test Case Drafter",
			}),
		).toBeInTheDocument();
	});

	it("has no chosen block when the project has chosen nothing", async () => {
		wrap();
		await screen.findByText(/0 of \d+ actions use a prompt chosen/i);
		expect(
			screen.queryByRole("region", { name: "Chosen for this project" }),
		).not.toBeInTheDocument();
	});
});

describe("prompt names link to the prompt", () => {
	it("links a row's prompt to that prompt's page", async () => {
		const user = userEvent.setup();
		wrap();

		await openGroup(user, QUALITY);
		expect(
			await screen.findByRole("link", { name: "Org QA Strategy" }),
		).toHaveAttribute("href", "/app/acme/prompts/p-org");
	});

	it("names the built-in text without a link", async () => {
		// Every action but the one under test has no catalog entry, so the
		// first group (open by default) is all built-in text.
		wrap();
		await screen.findByText(/0 of \d+ actions use a prompt chosen/i);
		expect(screen.getAllByText("Built-in text").length).toBeGreaterThan(0);
		expect(
			screen.queryByRole("link", { name: "Built-in text" }),
		).not.toBeInTheDocument();
	});

	it("links the picker's running prompt and sends its footer to the catalog at this action", async () => {
		const user = userEvent.setup();
		wrap();

		await openGroup(user, QUALITY);
		await user.click(changeButton("Test Case Drafter"));
		const picker = await screen.findByRole("dialog");

		expect(
			within(picker).getByRole("link", { name: "Org QA Strategy" }),
		).toHaveAttribute("href", "/app/acme/prompts/p-org");
		expect(
			within(picker).getByRole("link", {
				name: /Edit or create prompts in the Prompt Library/,
			}),
		).toHaveAttribute(
			"href",
			`/app/acme/prompts/catalog?action=${encodeURIComponent(ACTION_ID)}`,
		);
		// The prompt that runs now is marked among the choices.
		expect(
			within(picker).getByRole("button", {
				name: /^Org QA Strategy.*Runs now/,
			}),
		).toBeInTheDocument();
	});
});

describe("grouping and filtering", () => {
	it("opens the first group and keeps the rest closed until asked", async () => {
		const user = userEvent.setup();
		wrap();

		const first = await screen.findByRole("button", {
			name: /^Project Documents/,
		});
		const quality = screen.getByRole("button", { name: QUALITY });
		expect(first).toHaveAttribute("aria-expanded", "true");
		expect(quality).toHaveAttribute("aria-expanded", "false");

		await user.click(quality);
		expect(quality).toHaveAttribute("aria-expanded", "true");
		await user.click(first);
		expect(first).toHaveAttribute("aria-expanded", "false");
	});

	it("puts a tier chip on a group with an organization default", async () => {
		wrap();
		expect(
			await screen.findByRole("button", { name: QUALITY }),
		).toHaveTextContent("1 Organization");
	});

	it("searches action names and opens every group with a match", async () => {
		const user = userEvent.setup();
		wrap();
		await screen.findByRole("button", { name: QUALITY });

		await user.type(
			screen.getByRole("searchbox", { name: "Search prompt actions" }),
			"Test Case Drafter",
		);

		expect(screen.getByRole("button", { name: QUALITY })).toHaveAttribute(
			"aria-expanded",
			"true",
		);
		expect(
			screen.queryByRole("button", { name: /^Project Documents/ }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "Org QA Strategy" }),
		).toBeInTheDocument();
	});

	it("searches prompt names too", async () => {
		const user = userEvent.setup();
		wrap();
		await screen.findByRole("button", { name: QUALITY });

		await user.type(
			screen.getByRole("searchbox", { name: "Search prompt actions" }),
			"org qa",
		);

		expect(
			screen.getByRole("button", {
				name: "Change the prompt this project uses for Test Case Drafter",
			}),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: QUALITY })).toHaveTextContent(
			/1 of \d+/,
		);
	});

	it("counts each tier on its chip and filters to it", async () => {
		const user = userEvent.setup();
		wrap();
		await screen.findByRole("button", { name: QUALITY });

		const offered = listOfferedPromptActions(false).length;
		const tiers = screen.getByRole("group", {
			name: "Filter by where the prompt comes from",
		});
		expect(
			within(tiers).getByRole("button", { name: `All ${offered}` }),
		).toHaveAttribute("aria-pressed", "true");
		expect(
			within(tiers).getByRole("button", {
				name: `Built-in ${offered - 1}`,
			}),
		).toBeInTheDocument();
		// Nobody here has a personal default, so there is no chip for one.
		expect(
			within(tiers).queryByRole("button", { name: /^Personal/ }),
		).not.toBeInTheDocument();

		const org = within(tiers).getByRole("button", {
			name: "Organization 1",
		});
		await user.click(org);
		expect(org).toHaveAttribute("aria-pressed", "true");
		expect(
			screen.queryByRole("button", { name: /^Project Documents/ }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "Org QA Strategy" }),
		).toBeInTheDocument();

		// A second click on the active chip goes back to All.
		await user.click(org);
		expect(org).toHaveAttribute("aria-pressed", "false");
	});

	it("says when nothing matches and clears the filters on request", async () => {
		const user = userEvent.setup();
		wrap();
		await screen.findByRole("button", { name: QUALITY });

		const search = screen.getByRole("searchbox", {
			name: "Search prompt actions",
		});
		await user.type(search, "no such action");
		expect(
			screen.getByText("No actions match “no such action”."),
		).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Clear filters" }));
		expect(search).toHaveValue("");
		expect(
			screen.getByRole("button", { name: QUALITY }),
		).toBeInTheDocument();
	});

	it("applies a search another card asks for", async () => {
		const { rerender } = wrap();
		await screen.findByRole("button", { name: QUALITY });

		rerender(
			<QueryClientProvider
				client={
					new QueryClient({
						defaultOptions: { queries: { retry: false } },
					})
				}
			>
				<ProjectPromptDefaultsSettings
					projectId={PROJECT}
					focusRequest={{ search: "Clarifying Questions", seq: 1 }}
				/>
			</QueryClientProvider>,
		);

		expect(
			await screen.findByRole("searchbox", {
				name: "Search prompt actions",
			}),
		).toHaveValue("Clarifying Questions");
	});
});

describe("who is offered the controls", () => {
	it("offers nothing to write to someone who is not an organization admin", async () => {
		// A project admin holds PROJECT_SETTINGS_EDIT but not organization
		// admin, and `bind.set` refuses them. Showing the control would be an
		// affordance the server rejects.
		useActiveOrganization.mockReturnValue({ isOrganizationAdmin: false });
		const user = userEvent.setup();
		wrap();

		await openGroup(user, QUALITY);
		await screen.findByText(/Org QA Strategy/);
		expect(
			screen.queryByRole("button", { name: /^Change the prompt/ }),
		).not.toBeInTheDocument();
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
		const user = userEvent.setup();
		wrap();
		await openGroup(user, QUALITY);
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
		// Bucketing on effectiveScope would report zero, telling an admin their
		// project default does not exist.
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

describe("the client proposal prompt (Fizzy #2801)", () => {
	// The bind procedure refuses a personal default for this action. This
	// surface never offers one: a project default is an ORG binding narrowed
	// to the project, with no tier to choose, so the action needs no special
	// case here. Pinned so a tier picker added later cannot quietly start
	// writing USER for it.
	const CLIENT_MAIN = "proposal_client_main";

	it("writes an ORG binding narrowed to the project, never a personal one", async () => {
		catalogList.mockResolvedValue({
			entries: [
				entry({
					targetKey: CLIENT_MAIN,
					documentType: "PROPOSAL",
					prompts: [
						{
							promptId: "p-org-client",
							promptName: "Org Client Proposal",
							promptVersionId: "pv-org-client",
							scope: "ORG",
							projectId: null,
							isDefault: true,
							isEffective: true,
						},
						{
							promptId: "p-sys-client",
							promptName: "Fabric Client Proposal",
							promptVersionId: "pv-sys-client",
							scope: "SYSTEM",
							projectId: null,
							isDefault: true,
							isEffective: false,
						},
					],
				}),
			],
		});
		const user = userEvent.setup();
		wrap();

		// Project Documents is the group open by default.
		await screen.findByText(/Org Client Proposal/);
		await user.click(
			changeButton(
				/Change the prompt this project uses for Client proposal \(Main\)/i,
			),
		);
		// The choice is a prompt, not a tier: nothing reads "Personal".
		const picker = await screen.findByRole("dialog");
		expect(
			within(picker).queryByText(/personal|just for me/i),
		).not.toBeInTheDocument();
		await user.click(within(picker).getByText("Fabric Client Proposal"));

		await waitFor(() =>
			expect(bindSet).toHaveBeenCalledWith(
				expect.objectContaining({
					targetKey: CLIENT_MAIN,
					documentType: "PROPOSAL",
					scope: "ORG",
					organizationId: "org-a",
					projectId: PROJECT,
					promptVersionId: "pv-sys-client",
				}),
			),
		);
		expect(bindSet).not.toHaveBeenCalledWith(
			expect.objectContaining({ scope: "USER" }),
		);
	});
});

describe("a project default at a legacy Proposal action (Fizzy #2946)", () => {
	// With the Proposal artifact on, Client proposal (Main) writes Proposals,
	// so a project default saved at the Draft flow's Proposal action never
	// runs. It is listed apart, uncounted, and can still be cleared: dropping
	// it from the page would leave no way to remove it.
	const ALL = listPromptActions().length;
	const LEGACY_KEY = "project_document_generator";
	const legacyLabel = listPromptActions().find(
		(a) => a.id === `${LEGACY_KEY}:PROPOSAL:ANY`,
	)?.label as string;
	const legacyProjectDefault = () =>
		entry({
			targetKey: LEGACY_KEY,
			documentType: "PROPOSAL",
			effectiveScope: "PROJECT",
			prompts: [
				{
					promptId: "p-proj-proposal",
					promptName: "Project Proposal Prompt",
					promptVersionId: "pv-proj-proposal",
					scope: "ORG",
					projectId: PROJECT,
					isDefault: true,
					isEffective: true,
				},
			],
		});

	beforeEach(() => {
		flags.proposalArtifact = true;
		catalogList.mockResolvedValue({ entries: [legacyProjectDefault()] });
	});
	afterEach(() => {
		flags.proposalArtifact = false;
	});

	it("lists it as no longer used, not counted among the project's choices", async () => {
		wrap();

		const group = await screen.findByRole("region", {
			name: "projectGroupTitle",
		});
		expect(within(group).getByText(legacyLabel)).toBeInTheDocument();
		expect(within(group).getByText("actionNote")).toBeInTheDocument();
		expect(
			screen.getByText(
				new RegExp(`^0 of ${ALL - 2} actions use a prompt chosen`),
			),
		).toBeInTheDocument();
		// Not among the project's choices.
		expect(
			screen.queryByRole("region", { name: "Chosen for this project" }),
		).not.toBeInTheDocument();
	});

	it("clears it as the project's own binding", async () => {
		const user = userEvent.setup();
		wrap();

		const group = await screen.findByRole("region", {
			name: "projectGroupTitle",
		});
		await user.click(
			within(group).getByRole("button", {
				name: `Clear the project override for ${legacyLabel}`,
			}),
		);

		await waitFor(() =>
			expect(bindClear).toHaveBeenCalledWith(
				expect.objectContaining({
					targetKey: LEGACY_KEY,
					documentType: "PROPOSAL",
					scope: "ORG",
					organizationId: "org-a",
					projectId: PROJECT,
				}),
			),
		);
	});

	it("counts it as the project's choice, with no separate group, with the gate off", async () => {
		flags.proposalArtifact = false;
		wrap();

		expect(
			await screen.findByText(
				new RegExp(`^1 of ${ALL} actions use a prompt chosen`),
			),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("region", { name: "projectGroupTitle" }),
		).not.toBeInTheDocument();
		expect(screen.queryByText("actionNote")).not.toBeInTheDocument();
	});
});
