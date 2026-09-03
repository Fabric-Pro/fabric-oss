/**
 * Who is offered Delete, and who is offered Edit, on each of the three prompt
 * listing surfaces (Fizzy #2328, R1/R2/R3/R4/R13).
 *
 * `DeleteAuthority.test.ts` already pins the predicate itself. These tests pin
 * the WIRING: that each surface asks the predicate rather than deciding for
 * itself, that all three give the same answer for the same viewer and prompt
 * (AE10), and — just as important — that splitting the old shared `isEditable`
 * constant did not drag Edit along with Delete (R3).
 *
 * The Edit assertions are the regression guard for the tempting one-line
 * version of this change: repointing `isEditable` at the delete predicate would
 * make every Delete test here pass while quietly offering Edit on SYSTEM
 * prompts to a platform administrator, which this ticket does not touch.
 *
 * Run with:
 *   pnpm --filter web test __tests__/modules/saas/prompts/PromptDeleteAffordance.test.tsx
 */

import { PromptCard } from "@saas/prompts/components/PromptCard";
import { PromptManagementPage } from "@saas/prompts/components/PromptManagementPage";
import { PromptsListView } from "@saas/prompts/components/PromptsListView";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	globalRole: null as string | null,
	organizationId: "org-1" as string | null,
	organizationRole: null as string | null,
	prompts: [] as unknown[],
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: {
			delete: vi.fn(),
			deletionImpact: vi.fn(),
			bind: { clear: vi.fn(), set: vi.fn() },
			get: { byId: vi.fn().mockResolvedValue(null) },
			fork: { fork: vi.fn() },
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		prompts: {
			list: {
				queryOptions: () => ({
					queryKey: ["prompts", "list"],
					queryFn: async () => ({
						prompts: state.prompts,
						total: state.prompts.length,
					}),
				}),
			},
			categories: {
				queryOptions: () => ({
					queryKey: ["prompts", "categories"],
					queryFn: async () => ({ categories: [] }),
				}),
			},
			// The card mounts a preview sheet that reads the prompt by id.
			// Closed, so it never runs — but the option builder is still
			// dereferenced on render.
			get: {
				byId: {
					queryOptions: () => ({
						queryKey: ["prompts", "byId"],
						queryFn: async () => null,
						enabled: false,
					}),
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@saas/shared/components/ConfirmationAlertProvider", () => ({
	useConfirmationAlert: () => ({ confirm: vi.fn() }),
}));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: () => ({ user: { id: "user-1", role: state.globalRole } }),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		basePath: "/app/example-org",
		// `?? null` matches what the real hook yields — `string | null`, never
		// undefined — so the mock cannot hand the predicate a shape the app
		// never produces.
		organizationId: state.organizationId ?? null,
		userRole: state.organizationRole,
	}),
}));

// The management page's row also renders the binding manager, which runs
// queries of its own. Not what these tests are about.
vi.mock("@saas/prompts/components/PromptBindingManager", () => ({
	PromptBindingManager: () => null,
}));
vi.mock("@saas/prompts/components/PromptsHero", () => ({
	PromptsHero: () => null,
}));

const systemPrompt = {
	id: "p-sys",
	name: "Draft Generator",
	description: null,
	scope: "SYSTEM" as const,
	organizationId: null,
	userId: null,
	format: "PLAIN_TEXT" as const,
	category: null,
	tags: [] as string[],
	isPublic: true,
	usageCount: 0,
	lastUsedAt: null,
	createdAt: new Date("2026-01-01"),
	updatedAt: new Date("2026-01-01"),
	versions: [{ id: "pv-1", version: 1, content: "body" }],
	_count: { versions: 1 },
	forkedFrom: null,
};

const orgPrompt = {
	...systemPrompt,
	id: "p-org",
	name: "Team Draft Generator",
	scope: "ORG" as const,
	organizationId: "org-1",
};

type Fixture = typeof systemPrompt | typeof orgPrompt;

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

/**
 * The three surfaces, each reduced to "render this prompt" plus the menu item
 * that proves the menu actually opened.
 *
 * Without that anchor, every "the control is absent" assertion below would pass
 * just as happily against a menu that never opened — proving nothing.
 */
const surfaces = [
	{
		name: "the prompt card",
		anchor: "Duplicate",
		/** What this surface calls its edit entry, or null when it has none. */
		editLabel: "Edit",
		editIsScopeGated: true,
		render: (prompt: Fixture) => {
			wrap(<PromptCard prompt={prompt} />);
		},
	},
	{
		name: "the prompt list row",
		anchor: "Duplicate",
		editLabel: "Edit",
		editIsScopeGated: true,
		render: (prompt: Fixture) => {
			wrap(<PromptsListView prompts={[prompt]} onUpdate={() => {}} />);
		},
	},
	{
		name: "the prompt management table",
		anchor: "Fork",
		editLabel: "View/Edit",
		// This surface never gated its edit entry on scope, and this change
		// does not start.
		editIsScopeGated: false,
		render: (prompt: Fixture) => {
			state.prompts = [prompt];
			wrap(<PromptManagementPage organizationSlug="example-org" />);
		},
	},
];

/** Open a surface's overflow menu, by the accessible name it now carries. */
async function openMenu(anchor: string) {
	const user = userEvent.setup();
	const trigger = await screen.findByRole("button", {
		name: /^Actions for /,
	});
	await user.click(trigger);
	expect(await screen.findByText(anchor)).toBeInTheDocument();
	return user;
}

function asViewer(globalRole: string | null, organizationRole: string | null) {
	state.globalRole = globalRole;
	state.organizationRole = organizationRole;
	state.organizationId = "org-1";
}

describe.each(surfaces)("$name", (surface) => {
	beforeEach(() => {
		state.prompts = [];
	});

	it("offers Delete on a SYSTEM prompt to an authorised administrator", async () => {
		asViewer("admin", "admin");
		surface.render(systemPrompt);
		await openMenu(surface.anchor);

		expect(screen.getByText("Delete")).toBeInTheDocument();
	});

	it("withholds Delete from a global admin who is only a member here", async () => {
		// The server's requirePermission(PROMPT_DELETE) refuses this click, so
		// the control must not appear (AE2).
		asViewer("admin", "member");
		surface.render(systemPrompt);
		await openMenu(surface.anchor);

		expect(screen.queryByText("Delete")).not.toBeInTheDocument();
	});

	it("withholds Delete from an ordinary member (AE3)", async () => {
		asViewer(null, "member");
		surface.render(systemPrompt);
		await openMenu(surface.anchor);

		expect(screen.queryByText("Delete")).not.toBeInTheDocument();
	});

	it("still offers Delete on an ORG prompt to an organization admin", async () => {
		asViewer(null, "admin");
		surface.render(orgPrompt);
		await openMenu(surface.anchor);

		expect(screen.getByText("Delete")).toBeInTheDocument();
	});

	it("exposes an accessible name on the overflow trigger (AE12)", async () => {
		asViewer("admin", "admin");
		surface.render(systemPrompt);

		expect(
			await screen.findByRole("button", { name: /actions for/i }),
		).toBeInTheDocument();
	});

	it("leaves edit visibility exactly as it was, for an administrator", async () => {
		asViewer("admin", "admin");
		surface.render(systemPrompt);
		await openMenu(surface.anchor);

		if (surface.editIsScopeGated) {
			// R3: a SYSTEM prompt's Edit entry stayed hidden here before this
			// change and stays hidden now, administrator or not. The edit path
			// for an admin lives on the prompt detail page and is untouched.
			expect(
				screen.queryByText(surface.editLabel),
			).not.toBeInTheDocument();
		} else {
			expect(screen.getByText(surface.editLabel)).toBeInTheDocument();
		}
	});

	it("leaves edit visibility exactly as it was, for an ordinary member", async () => {
		asViewer(null, "member");
		surface.render(orgPrompt);
		await openMenu(surface.anchor);

		// An ORG prompt is editable on every surface, whatever the role — the
		// unchanged `isEditable` rule.
		expect(screen.getByText(surface.editLabel)).toBeInTheDocument();
	});
});

describe("the three surfaces agree (AE10)", () => {
	it.each([
		["an authorised administrator", "admin", "admin", true],
		["a global admin who is only a member", "admin", "member", false],
		["an ordinary member", null, "member", false],
		["a global admin with no active organization", "admin", null, false],
	])("for %s", async (_label, globalRole, organizationRole, expected) => {
		const answers: boolean[] = [];

		for (const surface of surfaces) {
			asViewer(globalRole, organizationRole);
			if (organizationRole === null) {
				state.organizationId = null;
			}
			state.prompts = [];
			surface.render(systemPrompt);
			await openMenu(surface.anchor);
			answers.push(screen.queryByText("Delete") !== null);
			cleanup();
		}

		expect(answers).toEqual([expected, expected, expected]);
	});
});
