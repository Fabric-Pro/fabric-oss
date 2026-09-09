/**
 * Route tests for the new-project page's SIMPLIFIED_PROJECT_CREATION branch
 * (Fizzy #2247).
 *
 * The flag is a rollback lever, so both directions matter equally. Off, the
 * page must behave exactly as it did before this change — the five-step
 * wizard, the same props, the legacy `?step=` still honoured, an ACTIVE
 * project still reaching the wizard. On, the simplified form serves instead
 * and an ACTIVE project is sent to the project itself rather than to a
 * creation form.
 *
 * The flag is resolved server-side here on purpose: a NEXT_PUBLIC_ mirror is
 * inlined at build time, which would put the rollback behind a redeploy. The
 * last test pins that the page asks `isFeatureEnabled` on every render.
 *
 * The page is a React Server Component, so it is invoked directly with mocked
 * session / org / database / navigation imports and asserted on the element
 * tree it returns — the same approach as the publishing-suite page guards.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockGetSession,
	mockGetActiveOrganization,
	mockRedirect,
	mockIsFeatureEnabled,
	mockGetProjectSummaryById,
	WizardStub,
	SimplifiedStub,
	BreadcrumbsStub,
	ControlsStub,
} = vi.hoisted(() => ({
	mockGetSession: vi.fn(),
	mockGetActiveOrganization: vi.fn(),
	mockRedirect: vi.fn(),
	mockIsFeatureEnabled: vi.fn(),
	mockGetProjectSummaryById: vi.fn(),
	WizardStub: () => null,
	SimplifiedStub: () => null,
	BreadcrumbsStub: () => null,
	ControlsStub: () => null,
}));

vi.mock("@saas/auth/lib/server", () => ({
	getSession: () => mockGetSession(),
	getActiveOrganization: (slug: string) => mockGetActiveOrganization(slug),
}));

vi.mock("next/navigation", () => ({
	redirect: (target: string) => {
		mockRedirect(target);
		throw new Error(`__REDIRECT__:${target}`);
	},
}));

vi.mock("@repo/database", () => ({
	isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
	getProjectSummaryById: (...args: unknown[]) =>
		mockGetProjectSummaryById(...args),
}));

vi.mock("@saas/projects/components/ProjectCreationWizard", () => ({
	ProjectCreationWizard: WizardStub,
}));

vi.mock("@saas/projects/components/SimplifiedProjectForm", () => ({
	SimplifiedProjectForm: SimplifiedStub,
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
	mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
	mockGetActiveOrganization.mockResolvedValue({
		id: ORG_ID,
		name: "Example Org",
	});
	mockGetProjectSummaryById.mockResolvedValue(null);
});

afterEach(() => {
	vi.resetModules();
});

async function callPage(
	searchParams: { step?: string; projectId?: string } = {},
) {
	const mod = await import(
		"../../../app/(saas)/app/(organizations)/[organizationSlug]/projects/new/page"
	);
	return (
		mod.default as (args: {
			params: Promise<{ organizationSlug: string }>;
			searchParams: Promise<{ step?: string; projectId?: string }>;
		}) => Promise<unknown>
	)({
		params: Promise.resolve({ organizationSlug: ORG_SLUG }),
		searchParams: Promise.resolve(searchParams),
	});
}

type RenderedElement = { type: unknown; props: Record<string, unknown> };

function childOfType(result: unknown, type: unknown): RenderedElement | null {
	const raw = (result as RenderedElement).props.children;
	const children = (Array.isArray(raw) ? raw : [raw]) as RenderedElement[];
	return children.find((child) => child?.type === type) ?? null;
}

describe("new-project page — SIMPLIFIED_PROJECT_CREATION", () => {
	it("serves the five-step wizard when the flag is off", async () => {
		mockIsFeatureEnabled.mockResolvedValue(false);

		const result = await callPage();

		expect(childOfType(result, WizardStub)).not.toBeNull();
		expect(childOfType(result, SimplifiedStub)).toBeNull();
	});

	it("serves the simplified form when the flag is on", async () => {
		mockIsFeatureEnabled.mockResolvedValue(true);

		const result = await callPage();

		expect(childOfType(result, SimplifiedStub)).not.toBeNull();
		expect(childOfType(result, WizardStub)).toBeNull();
	});

	// Rollback has to be exact, so the wizard's props are pinned as they were
	// before the branch existed: a legacy `?step=` still reaches it, and so
	// does `freshStart` for a visit carrying neither parameter.
	it("passes the legacy step through to the wizard unchanged", async () => {
		mockIsFeatureEnabled.mockResolvedValue(false);

		const result = await callPage({ step: "3" });

		expect(childOfType(result, WizardStub)?.props).toMatchObject({
			organizationId: ORG_ID,
			initialStep: 3,
			freshStart: false,
		});
	});

	it("flags a visit with no parameters as a fresh start", async () => {
		mockIsFeatureEnabled.mockResolvedValue(false);

		const result = await callPage();

		expect(childOfType(result, WizardStub)?.props).toMatchObject({
			freshStart: true,
		});
	});

	// The simplified form is one step, so a `?step=` left over from an old
	// link means nothing to it and must not be forwarded.
	it("does not forward a legacy step to the simplified form", async () => {
		mockIsFeatureEnabled.mockResolvedValue(true);

		const result = await callPage({ step: "3" });

		const props = childOfType(result, SimplifiedStub)?.props;
		expect(props).not.toHaveProperty("initialStep");
		expect(props).toMatchObject({ organizationId: ORG_ID });
	});
});

describe("new-project page — an ACTIVE project on the creation route", () => {
	const activeProject = {
		id: "proj-live",
		name: "Live project",
		status: "ACTIVE",
	};
	const draftProject = {
		id: "proj-draft",
		name: "Half-finished",
		status: "DRAFT",
	};

	// The "Edit Project" link on an ACTIVE project sends the user here with
	// `?step=1&projectId=`, which is the requirements/code mismatch the card
	// names: an already-live project has nothing to do on a creation form, so
	// it lands on the edit screen instead.
	it("sends an ACTIVE project to the edit screen", async () => {
		mockIsFeatureEnabled.mockResolvedValue(true);
		mockGetProjectSummaryById.mockResolvedValue(activeProject);

		await expect(
			callPage({ step: "1", projectId: "proj-live" }),
		).rejects.toThrow(
			"__REDIRECT__:/app/example-org/projects/proj-live/edit",
		);
		expect(mockRedirect).toHaveBeenCalledWith(
			"/app/example-org/projects/proj-live/edit",
		);
	});

	// The redirect is part of what the flag turns on. With the flag off the
	// route must still behave exactly as it did before, or rolling back would
	// change a second thing as a side effect.
	it("leaves the route alone for an ACTIVE project when the flag is off", async () => {
		mockIsFeatureEnabled.mockResolvedValue(false);
		mockGetProjectSummaryById.mockResolvedValue(activeProject);

		const result = await callPage({ step: "1", projectId: "proj-live" });

		expect(mockRedirect).not.toHaveBeenCalled();
		expect(childOfType(result, WizardStub)).not.toBeNull();
	});

	it("lets an unfinished DRAFT through to the simplified form", async () => {
		mockIsFeatureEnabled.mockResolvedValue(true);
		mockGetProjectSummaryById.mockResolvedValue(draftProject);

		const result = await callPage({ projectId: "proj-draft" });

		expect(mockRedirect).not.toHaveBeenCalled();
		expect(childOfType(result, SimplifiedStub)?.props).toMatchObject({
			projectId: "proj-draft",
		});
	});

	// A project id that does not resolve — deleted, or belonging to someone
	// else — must not redirect anywhere that would confirm it exists.
	it("does not redirect for a project the user cannot see", async () => {
		mockIsFeatureEnabled.mockResolvedValue(true);
		mockGetProjectSummaryById.mockResolvedValue(null);

		const result = await callPage({ projectId: "proj-someone-elses" });

		expect(mockRedirect).not.toHaveBeenCalled();
		expect(childOfType(result, SimplifiedStub)).not.toBeNull();
	});
});

describe("new-project page — where the flag is read", () => {
	// Resolved per request against the organization, never from a build-time
	// NEXT_PUBLIC_ mirror: that is what makes the switch a console change
	// rather than a redeploy.
	it("asks the runtime resolver, scoped to the organization", async () => {
		mockIsFeatureEnabled.mockResolvedValue(true);

		await callPage();

		expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
			"SIMPLIFIED_PROJECT_CREATION",
			ORG_ID,
		);
	});
});
