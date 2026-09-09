/**
 * Route guards on the project edit screen (Fizzy #2247).
 *
 * The screen is new, so it must not become a surface that is easier to reach
 * than the mutation behind it. Three gates, in the order the page applies them:
 *
 *   - `SIMPLIFIED_PROJECT_CREATION` off  -> the screen does not exist at all
 *   - project not readable               -> not found
 *   - readable but not updatable         -> back to the project, not a 404
 *
 * and one routing rule: a DRAFT belongs in the creation flow, which knows how
 * to resume and then activate it.
 *
 * The permission answer comes from `projects.get`, the same source the update
 * mutation will consult — a second opinion computed here could disagree with
 * it, and the disagreement would be invisible until someone hit save.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockGetSession,
	mockGetActiveOrganization,
	mockRedirect,
	mockNotFound,
	mockIsFeatureEnabled,
	mockProjectsGet,
	FormStub,
	BreadcrumbsStub,
	ControlsStub,
} = vi.hoisted(() => ({
	mockGetSession: vi.fn(),
	mockGetActiveOrganization: vi.fn(),
	mockRedirect: vi.fn(),
	mockNotFound: vi.fn(),
	mockIsFeatureEnabled: vi.fn(),
	mockProjectsGet: vi.fn(),
	FormStub: () => null,
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
	notFound: () => {
		mockNotFound();
		throw new Error("__NOT_FOUND__");
	},
}));

vi.mock("@repo/database", () => ({
	isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			get: (...args: unknown[]) => mockProjectsGet(...args),
		},
	},
}));

vi.mock("@saas/projects/components/SimplifiedProjectForm", () => ({
	SimplifiedProjectForm: FormStub,
}));
vi.mock("@saas/shared/components/PageBreadcrumbs", () => ({
	PageBreadcrumbs: BreadcrumbsStub,
}));
vi.mock("@saas/shared/components/TopRightControls", () => ({
	TopRightControls: ControlsStub,
}));

const ORG_ID = "org-A";
const ORG_SLUG = "example-org";
const PROJECT_ID = "proj-1";

const liveProject = {
	project: {
		id: PROJECT_ID,
		name: "Example Project",
		status: "ACTIVE",
		canUpdateProject: true,
	},
};

beforeEach(() => {
	vi.clearAllMocks();
	mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
	mockGetActiveOrganization.mockResolvedValue({
		id: ORG_ID,
		name: "Example Org",
	});
	mockIsFeatureEnabled.mockResolvedValue(true);
	mockProjectsGet.mockResolvedValue(liveProject);
});

afterEach(() => {
	vi.resetModules();
});

async function callPage() {
	const mod = await import(
		"../../../app/(saas)/app/(organizations)/[organizationSlug]/projects/[id]/edit/page"
	);
	return (
		mod.default as (args: {
			params: Promise<{ organizationSlug: string; id: string }>;
		}) => Promise<unknown>
	)({
		params: Promise.resolve({
			organizationSlug: ORG_SLUG,
			id: PROJECT_ID,
		}),
	});
}

type RenderedElement = { type: unknown; props: Record<string, unknown> };

function childOfType(result: unknown, type: unknown): RenderedElement | null {
	const raw = (result as RenderedElement).props.children;
	const children = (Array.isArray(raw) ? raw : [raw]) as RenderedElement[];
	return children.find((child) => child?.type === type) ?? null;
}

describe("project edit page — guards", () => {
	it("renders the form in edit mode on the happy path", async () => {
		const result = await callPage();

		expect(childOfType(result, FormStub)?.props).toMatchObject({
			organizationId: ORG_ID,
			projectId: PROJECT_ID,
			mode: "edit",
		});
	});

	// The screen exists only as part of the simplified flow. With the flag off
	// the wizard is still the edit surface and the header button routes there,
	// so this URL must not resolve at all.
	it("does not exist when the flag is off", async () => {
		mockIsFeatureEnabled.mockResolvedValue(false);

		await expect(callPage()).rejects.toThrow("__NOT_FOUND__");
		expect(mockNotFound).toHaveBeenCalled();
		// The gate runs before the project is ever fetched.
		expect(mockProjectsGet).not.toHaveBeenCalled();
	});

	it("asks the runtime resolver, scoped to the organization", async () => {
		await callPage();

		expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
			"SIMPLIFIED_PROJECT_CREATION",
			ORG_ID,
		);
	});

	it("is not found when the project cannot be read", async () => {
		mockProjectsGet.mockRejectedValue(new Error("NOT_FOUND"));

		await expect(callPage()).rejects.toThrow("__NOT_FOUND__");
		expect(mockNotFound).toHaveBeenCalled();
	});

	// Readable but not updatable is a different answer from "no such project",
	// and pretending otherwise would be a worse experience for a member who can
	// see the project perfectly well in the UI behind them.
	it("sends a member who cannot update the project back to it", async () => {
		mockProjectsGet.mockResolvedValue({
			project: { ...liveProject.project, canUpdateProject: false },
		});

		await expect(callPage()).rejects.toThrow(
			`__REDIRECT__:/app/${ORG_SLUG}/projects/${PROJECT_ID}`,
		);
		expect(mockNotFound).not.toHaveBeenCalled();
	});

	// A DRAFT has never been created, so there is nothing live to edit — the
	// creation flow is what knows how to resume and activate it.
	it("sends a DRAFT to the creation flow", async () => {
		mockProjectsGet.mockResolvedValue({
			project: { ...liveProject.project, status: "DRAFT" },
		});

		await expect(callPage()).rejects.toThrow(
			`__REDIRECT__:/app/${ORG_SLUG}/projects/new?projectId=${PROJECT_ID}`,
		);
	});
});
