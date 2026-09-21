/**
 * Route guard for the consolidated To Do page (Fizzy #2340).
 *
 * The page is a React Server Component, so it cannot go through
 * @testing-library — it is invoked directly with its imports mocked and the
 * returned element tree inspected, mirroring
 * `apps/web/__tests__/app/projects/publishing/organization-page-guard.test.tsx`.
 *
 * What is pinned here is deliberately only what the route itself owns:
 *   - no session → `/auth/login`, before the organization is ever looked up;
 *   - an unresolvable slug → `/app`;
 *   - a resolved organization → its ID, not the slug, reaches the client shell.
 *
 * The `TODO_LIST` rollout gate is NOT a route guard: `todos.list` refuses the
 * read for an organization that is not enrolled and the sidebar entry is
 * absent, so the capability is unreachable without a second gate here. That is
 * a decision, not an omission — see the page's own docblock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockGetSession,
	mockGetOrganizationBySlug,
	mockRedirect,
	mockNotFound,
	mockIsFeatureEnabled,
	ShellStub,
	BreadcrumbsStub,
	ControlsStub,
} = vi.hoisted(() => ({
	mockGetSession: vi.fn(),
	mockGetOrganizationBySlug: vi.fn(),
	mockRedirect: vi.fn(),
	mockNotFound: vi.fn(),
	mockIsFeatureEnabled: vi.fn(),
	// Hoisted so the assertions identify each child by REFERENCE rather than
	// by position — reordering the wrapper is a layout decision, not a bug.
	ShellStub: () => null,
	BreadcrumbsStub: () => null,
	ControlsStub: () => null,
}));

vi.mock("@saas/auth/lib/server", () => ({
	getSession: () => mockGetSession(),
}));

vi.mock("@repo/database", () => ({
	getOrganizationBySlug: (slug: string) => mockGetOrganizationBySlug(slug),
	isFeatureEnabled: (key: string, organizationId?: string) =>
		mockIsFeatureEnabled(key, organizationId),
}));

vi.mock("next/navigation", () => ({
	redirect: (target: string) => {
		// Mirror Next's semantics: `redirect()` throws, so everything after it
		// is unreachable. A mock that merely records would let the page run on
		// with a null organization and hide the very bug this test exists for.
		mockRedirect(target);
		throw new Error(`__REDIRECT__:${target}`);
	},
	notFound: () => {
		// Next's notFound() throws too, for the same reason redirect() does.
		mockNotFound();
		throw new Error("__NOT_FOUND__");
	},
}));

vi.mock("@saas/todos/components/TodoListPage", () => ({
	TodoListPage: ShellStub,
}));
vi.mock("@saas/shared/components/PageBreadcrumbs", () => ({
	PageBreadcrumbs: BreadcrumbsStub,
}));
vi.mock("@saas/shared/components/TopRightControls", () => ({
	TopRightControls: ControlsStub,
}));

const ORG_ID = "org-A";
const ORG_SLUG = "example-org";

beforeEach(() => {
	vi.clearAllMocks();
	// Default the gate ON so the existing guard cases exercise the guards they
	// were written for, not the rollout gate. Set after clearAllMocks, which
	// would otherwise wipe the resolved value straight back out.
	mockIsFeatureEnabled.mockResolvedValue(true);
});

afterEach(() => {
	vi.resetModules();
});

async function callPage() {
	const mod = await import(
		"../../../../app/(saas)/app/(organizations)/[organizationSlug]/todos/page"
	);
	return (
		mod.default as (args: {
			params: Promise<{ organizationSlug: string }>;
		}) => Promise<unknown>
	)({ params: Promise.resolve({ organizationSlug: ORG_SLUG }) });
}

type RenderedElement = { type: unknown; props: Record<string, unknown> };

function childOfType(result: unknown, type: unknown): RenderedElement {
	const raw = (result as RenderedElement).props.children;
	const children = (Array.isArray(raw) ? raw : [raw]) as RenderedElement[];
	const found = children.find((child) => child?.type === type);
	if (!found) {
		throw new Error("the page did not render the expected child");
	}
	return found;
}

describe("To Do page — route guard", () => {
	it("sends a signed-out visitor to the login page", async () => {
		mockGetSession.mockResolvedValue(null);

		await expect(callPage()).rejects.toThrow("__REDIRECT__:/auth/login");

		expect(mockRedirect).toHaveBeenCalledWith("/auth/login");
		// The organization lookup is a database read; it must not happen for a
		// visitor who has not proven who they are.
		expect(mockGetOrganizationBySlug).not.toHaveBeenCalled();
	});

	it("sends the caller back to /app when the slug resolves to nothing", async () => {
		mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
		mockGetOrganizationBySlug.mockResolvedValue(null);

		await expect(callPage()).rejects.toThrow("__REDIRECT__:/app");

		expect(mockGetOrganizationBySlug).toHaveBeenCalledWith(ORG_SLUG);
		expect(mockRedirect).toHaveBeenCalledWith("/app");
	});

	it("hands the client shell the resolved organization ID, not the slug", async () => {
		mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
		mockGetOrganizationBySlug.mockResolvedValue({
			id: ORG_ID,
			slug: ORG_SLUG,
		});

		const result = await callPage();

		expect(mockRedirect).not.toHaveBeenCalled();
		// `todos.list` filters the whole tenant boundary on this value, and the
		// slug is not it.
		expect(childOfType(result, ShellStub).props.organizationId).toBe(
			ORG_ID,
		);
		expect(childOfType(result, BreadcrumbsStub).props.items).toEqual([
			{ label: "To Do" },
		]);
	});
});

describe("To Do page — rollout gate", () => {
	it("is absent, not explained, when the gate is off", async () => {
		// A rollout gate off means the capability does not exist. A shell that
		// renders "not turned on yet" to a hand-typed URL is the shape of a
		// disabled feature, which CONCEPTS.md reserves for a Kill switch.
		mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
		mockGetOrganizationBySlug.mockResolvedValue({ id: "org-1" });
		mockIsFeatureEnabled.mockResolvedValue(false);

		await expect(callPage()).rejects.toThrow("__NOT_FOUND__");

		expect(mockNotFound).toHaveBeenCalled();
	});

	it("asks the gate about THIS organization, not globally", async () => {
		mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
		mockGetOrganizationBySlug.mockResolvedValue({ id: "org-1" });
		mockIsFeatureEnabled.mockResolvedValue(true);

		await callPage();

		expect(mockIsFeatureEnabled).toHaveBeenCalledWith("TODO_LIST", "org-1");
	});
});
