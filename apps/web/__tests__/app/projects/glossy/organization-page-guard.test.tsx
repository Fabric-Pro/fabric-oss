/**
 * The server-side guard on the Glossy page of one document
 * (`/app/{organizationSlug}/projects/{id}/documents/{documentId}/glossy`;
 * Fizzy #2589, U14; R40, KTD20).
 *
 * The page MUST:
 *   - redirect to `/auth/login` when there is no session
 *   - return `notFound()` when the organization can't be resolved from the slug
 *   - return `notFound()` when `isFeatureEnabled("GLOSSY_EDITION",
 *     organization.id)` is false — resolved for THAT organization, after it
 *     is known and before any project access
 *   - return `notFound()` when the project read is refused
 *   - render `GlossyEditionPage` with the route ids and the project's name
 *
 * The page is a React Server Component, so the guard is exercised by calling
 * the page function with mocked session, organization, flag, oRPC, and
 * navigation imports and inspecting what it returns — as the Publishing Suite
 * route's guard test does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockGetSession,
	mockGetActiveOrganization,
	mockRedirect,
	mockNotFound,
	mockIsFeatureEnabled,
	mockProjectsGet,
	PageStub,
} = vi.hoisted(() => ({
	mockGetSession: vi.fn(),
	mockGetActiveOrganization: vi.fn(),
	mockRedirect: vi.fn(),
	mockNotFound: vi.fn(),
	mockIsFeatureEnabled: vi.fn(),
	mockProjectsGet: vi.fn(),
	PageStub: () => null,
}));

vi.mock("@saas/auth/lib/server", () => ({
	getSession: () => mockGetSession(),
	getActiveOrganization: (slug: string) => mockGetActiveOrganization(slug),
}));

vi.mock("next/navigation", () => ({
	// Next's redirect and notFound throw to halt the render; so do these.
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

// The client page is its own tests' business; this suite inspects the props
// the server component hands it.
vi.mock("@saas/projects/components/glossy/GlossyEditionPage", () => ({
	GlossyEditionPage: PageStub,
}));

const PROJECT_ID = "project-1";
const DOCUMENT_ID = "document-1";
const PROJECT_NAME = "Example Project";
const ORG_ID = "org-example";
const ORG_SLUG = "example-org";

type RenderedElement = { type: unknown; props: Record<string, unknown> };

async function callPage(): Promise<RenderedElement> {
	const mod = await import(
		"../../../../app/(saas)/app/(organizations)/[organizationSlug]/projects/[id]/documents/[documentId]/glossy/page"
	);
	return (
		mod.default as (args: {
			params: Promise<{
				id: string;
				documentId: string;
				organizationSlug: string;
			}>;
		}) => Promise<RenderedElement>
	)({
		params: Promise.resolve({
			id: PROJECT_ID,
			documentId: DOCUMENT_ID,
			organizationSlug: ORG_SLUG,
		}),
	});
}

function signedInToEnrolledOrganization() {
	mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
	mockGetActiveOrganization.mockResolvedValue({ id: ORG_ID });
	mockIsFeatureEnabled.mockResolvedValue(true);
	mockProjectsGet.mockResolvedValue({ project: { name: PROJECT_NAME } });
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.resetModules();
});

describe("Glossy page — route guard", () => {
	it("redirects a visitor with no session to /auth/login", async () => {
		mockGetSession.mockResolvedValue(null);

		await expect(callPage()).rejects.toThrow(/__REDIRECT__:\/auth\/login/);
		expect(mockRedirect).toHaveBeenCalledWith("/auth/login");
		expect(mockGetActiveOrganization).not.toHaveBeenCalled();
		expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
		expect(mockProjectsGet).not.toHaveBeenCalled();
	});

	it("returns notFound() when the organization can't be resolved from the slug", async () => {
		mockGetSession.mockResolvedValue({ user: { id: "user-1" } });
		mockGetActiveOrganization.mockResolvedValue(null);

		await expect(callPage()).rejects.toThrow(/__NOT_FOUND__/);
		expect(mockGetActiveOrganization).toHaveBeenCalledWith(ORG_SLUG);
		expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
		expect(mockProjectsGet).not.toHaveBeenCalled();
	});

	it("returns notFound() with the gate off for the resolved organization, before any project access", async () => {
		signedInToEnrolledOrganization();
		mockIsFeatureEnabled.mockResolvedValue(false);

		await expect(callPage()).rejects.toThrow(/__NOT_FOUND__/);
		expect(mockNotFound).toHaveBeenCalledTimes(1);
		expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
			"GLOSSY_EDITION",
			ORG_ID,
		);
		expect(mockProjectsGet).not.toHaveBeenCalled();
	});

	it("returns notFound() when the project read is refused", async () => {
		signedInToEnrolledOrganization();
		mockProjectsGet.mockRejectedValue(
			Object.assign(new Error("Not found"), { code: "NOT_FOUND" }),
		);

		await expect(callPage()).rejects.toThrow(/__NOT_FOUND__/);
		expect(mockNotFound).toHaveBeenCalledTimes(1);
	});

	it("renders the Glossy page with the route ids and the project's name", async () => {
		signedInToEnrolledOrganization();

		const result = await callPage();

		expect(mockNotFound).not.toHaveBeenCalled();
		expect(result.type).toBe(PageStub);
		expect(result.props).toEqual({
			projectId: PROJECT_ID,
			documentId: DOCUMENT_ID,
			organizationSlug: ORG_SLUG,
			projectName: PROJECT_NAME,
		});
		expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
			"GLOSSY_EDITION",
			ORG_ID,
		);
		// The RESOLVED organization id, never the slug or null.
		expect(mockProjectsGet).toHaveBeenCalledWith({
			id: PROJECT_ID,
			organizationId: ORG_ID,
		});
	});
});
