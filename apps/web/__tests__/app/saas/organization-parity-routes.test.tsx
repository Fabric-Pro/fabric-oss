/**
 * Fizzy #1875 (R11, R12, R13) — the last three personal-only route trees.
 *
 * Automation templates and the task-planner agent were live features with no
 * organization-rooted route at all; agent-register was worse than unpaired —
 * the link helper prefixes the organization slug, and with no static `register`
 * segment in the organization group the link fell through to the dynamic
 * `[agentId]` route with the literal string as an id. All three now exist under
 * the slug, and the stale `settings/ai-gateway` redirect stub is gone.
 *
 * The personal routes were asserted alongside every organization one, because
 * that change added routes without retiring any. Retiring them is what came
 * next (R1), so what is asserted here now is that the organization routes still
 * stand and the personal ones have become a redirect.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render, renderHook, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSession, getActiveOrganization } = vi.hoisted(() => ({
	getSession: vi.fn(),
	getActiveOrganization: vi.fn(),
}));

vi.mock("@saas/auth/lib/server", () => ({
	getSession: (...args: unknown[]) => getSession(...args),
	getActiveOrganization: (...args: unknown[]) =>
		getActiveOrganization(...args),
}));

vi.mock("next/navigation", () => ({
	redirect: (to: string) => {
		throw new Error(`redirect:${to}`);
	},
	useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
	usePathname: () => "/app",
	useParams: () => ({}),
	useSearchParams: () => new URLSearchParams(),
}));

// The three surfaces under test are heavy client trees (CopilotKit runtime, an
// oRPC form, a paginated list). This suite is about WHICH surface each route
// mounts and with what tenant, so each is stubbed at its module boundary.
vi.mock("@saas/automation-templates/components/TemplatesList", () => ({
	TemplatesList: (props: { organizationId?: string }) => (
		<div
			data-testid="templates-list"
			data-org={props.organizationId ?? ""}
		/>
	),
}));
vi.mock("@saas/automation-templates/components/TemplateEditor", () => ({
	TemplateEditor: (props: {
		templateId?: string;
		organizationId?: string;
	}) => (
		<div
			data-testid="template-editor"
			data-template={props.templateId ?? ""}
			data-org={props.organizationId ?? ""}
		/>
	),
}));
vi.mock("@saas/agents/components/TaskPlannerWorkspace", () => ({
	TaskPlannerWorkspace: () => <div data-testid="task-planner" />,
}));
vi.mock("@saas/agents/components/RegisterExternalAgent", () => ({
	RegisterExternalAgent: () => <div data-testid="register-agent" />,
}));
vi.mock("@saas/shared/components/TopRightControls", () => ({
	TopRightControls: () => null,
}));
vi.mock("@saas/shared/components/PageBreadcrumbs", () => ({
	PageBreadcrumbs: () => null,
}));

import type { ActiveOrganization } from "@repo/auth";
import { useContextPath } from "@saas/organizations/hooks/use-organization-context";
import { ActiveOrganizationContext } from "@saas/organizations/lib/active-organization-context";
import OrgRegisterAgentPage from "../../../app/(saas)/app/(organizations)/[organizationSlug]/agents/register/page";
import OrgTaskPlannerPage from "../../../app/(saas)/app/(organizations)/[organizationSlug]/agents/task-planner/page";
import OrgTemplateDetailsPage from "../../../app/(saas)/app/(organizations)/[organizationSlug]/automation-templates/[id]/page";
import OrgNewTemplatePage from "../../../app/(saas)/app/(organizations)/[organizationSlug]/automation-templates/new/page";
import OrgTemplatesPage from "../../../app/(saas)/app/(organizations)/[organizationSlug]/automation-templates/page";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "../../..");
const repoRoot = path.resolve(webRoot, "../..");

const ORG = { id: "org-1", name: "Example Org", slug: "example-org" };
const params = Promise.resolve({ organizationSlug: ORG.slug });

beforeEach(() => {
	vi.clearAllMocks();
	getSession.mockResolvedValue({ user: { id: "user-1" } });
	getActiveOrganization.mockResolvedValue(ORG);
});

describe("automation templates — organization-rooted routes (R11)", () => {
	it("renders the list at /app/{slug}/automation-templates with the organization threaded in", async () => {
		render(await OrgTemplatesPage({ params }));

		const list = screen.getByTestId("templates-list");
		expect(list.getAttribute("data-org")).toBe("org-1");
		expect(getActiveOrganization).toHaveBeenCalledWith("example-org");
	});

	it("renders the editor at /app/{slug}/automation-templates/new", async () => {
		render(await OrgNewTemplatePage({ params }));

		const editor = screen.getByTestId("template-editor");
		expect(editor.getAttribute("data-org")).toBe("org-1");
		expect(editor.getAttribute("data-template")).toBe("");
	});

	it("renders the editor at /app/{slug}/automation-templates/{id}", async () => {
		render(
			await OrgTemplateDetailsPage({
				params: Promise.resolve({
					organizationSlug: ORG.slug,
					id: "tpl-1",
				}),
			}),
		);

		const editor = screen.getByTestId("template-editor");
		expect(editor.getAttribute("data-org")).toBe("org-1");
		expect(editor.getAttribute("data-template")).toBe("tpl-1");
	});

	it("sends a signed-out visitor to login, and a non-member back to /app", async () => {
		getSession.mockResolvedValue(null);
		await expect(OrgTemplatesPage({ params })).rejects.toThrow(
			"redirect:/auth/login",
		);

		getSession.mockResolvedValue({ user: { id: "user-1" } });
		getActiveOrganization.mockResolvedValue(null);
		await expect(OrgTemplatesPage({ params })).rejects.toThrow(
			"redirect:/app",
		);
	});

	// The personal counterparts this suite used to render alongside the
	// organization ones are gone (Fizzy #1875, R1), replaced by a redirect. What
	// is asserted now is that the redirect is what stands there — the pages
	// themselves must not come back.
	it("leaves only a redirect where the personal routes were", () => {
		const personalTree = path.join(
			webRoot,
			"app/(saas)/app/(account)/automation-templates",
		);

		expect(
			existsSync(path.join(personalTree, "[[...path]]/page.tsx")),
		).toBe(true);
		for (const gone of ["page.tsx", "new/page.tsx", "[id]/page.tsx"]) {
			expect(existsSync(path.join(personalTree, gone))).toBe(false);
		}
	});
});

describe("agents — organization-rooted task-planner and register (R11, R13)", () => {
	// These paired each surface against its personal twin. The twin is gone
	// (R1) — `/app/agents` is a redirect now — so what is left to assert is
	// that the organization surface still mounts, which was always the half
	// that mattered.
	it("renders the task planner under the organization slug", () => {
		render(OrgTaskPlannerPage() as ReactElement);
		expect(screen.getByTestId("task-planner")).toBeDefined();
	});

	it("renders agent-register under the organization slug", () => {
		render(OrgRegisterAgentPage() as ReactElement);
		expect(screen.getByTestId("register-agent")).toBeDefined();
	});

	it("leaves only a redirect where the personal agents tree was", () => {
		const personalAgents = path.join(webRoot, "app/(saas)/app/agents");

		expect(
			existsSync(path.join(personalAgents, "[[...path]]/page.tsx")),
		).toBe(true);
		for (const gone of [
			"page.tsx",
			"register/page.tsx",
			"task-planner/page.tsx",
		]) {
			expect(existsSync(path.join(personalAgents, gone))).toBe(false);
		}
	});

	/**
	 * The break this repairs is a ROUTING one, not a rendering one: with no
	 * static `register` segment the slug-prefixed link matched
	 * `agents/[agentId]` and asked the API for an agent called "register".
	 * Next resolves a static segment ahead of a sibling dynamic one, so the
	 * repair is the file existing beside `[agentId]`.
	 */
	it("the link the registry renders in organization context lands on that route", () => {
		const { result } = renderHook(() => useContextPath("agents/register"), {
			wrapper: ({ children }) => (
				<ActiveOrganizationContext.Provider
					value={{
						activeOrganization: {
							id: ORG.id,
							slug: ORG.slug,
							name: ORG.name,
							members: [],
						} as unknown as ActiveOrganization,
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
			),
		});

		// This is the href `AgentRegistryView` renders; before the repair it
		// resolved against `agents/[agentId]` with agentId === "register".
		expect(result.current).toBe("/app/example-org/agents/register");

		const segments = result.current.split("/").slice(1);
		expect(
			existsSync(
				path.join(
					webRoot,
					"app/(saas)/app/(organizations)/[organizationSlug]",
					segments.slice(2).join("/"),
					"page.tsx",
				),
			),
		).toBe(true);
	});

	it("resolves /app/{slug}/agents/register statically, not as an agent id", () => {
		const orgAgents = path.join(
			webRoot,
			"app/(saas)/app/(organizations)/[organizationSlug]/agents",
		);

		expect(existsSync(path.join(orgAgents, "register/page.tsx"))).toBe(
			true,
		);
		expect(existsSync(path.join(orgAgents, "task-planner/page.tsx"))).toBe(
			true,
		);
		// The dynamic sibling that used to swallow it is still there — the fix
		// is precedence, not its removal.
		expect(existsSync(path.join(orgAgents, "[agentId]/page.tsx"))).toBe(
			true,
		);
	});
});

describe("the stale ai-gateway redirect stub is gone (R12)", () => {
	const stub = path.join(
		webRoot,
		"app/(saas)/app/(account)/settings/ai-gateway",
	);

	it("no longer resolves in either route tree", () => {
		expect(existsSync(stub)).toBe(false);
		expect(
			existsSync(
				path.join(
					webRoot,
					"app/(saas)/app/(organizations)/[organizationSlug]/settings/ai-gateway",
				),
			),
		).toBe(false);
	});

	it("is not linked from anywhere in the app", () => {
		const roots = [
			path.join(webRoot, "app"),
			path.join(webRoot, "modules"),
			path.join(repoRoot, "packages"),
		];
		const offenders: string[] = [];

		const walk = (dir: string) => {
			for (const entry of readdirSync(dir)) {
				if (entry === "node_modules" || entry === ".next") {
					continue;
				}
				const full = path.join(dir, entry);
				if (statSync(full).isDirectory()) {
					walk(full);
					continue;
				}
				if (!/\.(ts|tsx)$/.test(entry)) {
					continue;
				}
				const source = readFileSync(full, "utf8");
				// The Vercel AI Gateway provider and the `ai-gateway-encryption`
				// utility share the word; only a settings ROUTE counts here.
				if (/settings\/ai-gateway/.test(source)) {
					offenders.push(path.relative(repoRoot, full));
				}
			}
		};

		for (const root of roots) {
			walk(root);
		}

		expect(offenders).toEqual([]);
	});
});
