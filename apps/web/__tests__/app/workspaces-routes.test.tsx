/** Document Workspaces and generated Pages have separate routes and compatible saved links. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	getOrganizationBySlug: vi.fn(),
	getAccessibleFrameById: vi.fn(),
	getWorkspaceAccessContext: vi.fn(),
	redirectIntoOrganization: vi.fn(),
}));
class RedirectSignal extends Error {
	constructor(readonly location: string) {
		super(`REDIRECT:${location}`);
	}
}
vi.mock("next/navigation", () => ({
	redirect: (location: string) => {
		throw new RedirectSignal(location);
	},
	notFound: () => {
		throw new Error("NOT_FOUND");
	},
}));
vi.mock("@saas/auth/lib/server", () => ({ getSession: mocks.getSession }));
vi.mock("@repo/database", () => ({
	getOrganizationBySlug: mocks.getOrganizationBySlug,
	getAccessibleFrameById: mocks.getAccessibleFrameById,
	getWorkspaceAccessContext: mocks.getWorkspaceAccessContext,
}));
vi.mock("@saas/organizations/lib/account-route-redirect", () => ({
	redirectIntoOrganization: mocks.redirectIntoOrganization,
}));
vi.mock("@saas/shared/components/PageBreadcrumbs", () => ({
	PageBreadcrumbs: () => null,
}));
vi.mock("@saas/shared/components/TopRightControls", () => ({
	TopRightControls: () => null,
}));
vi.mock("@saas/pages/components/PageView", () => ({ PageView: () => null }));
vi.mock("@saas/pages/components/PagesList", () => ({ PagesList: () => null }));
vi.mock("@saas/workspaces/components/WorkspacesList", () => ({
	WorkspacesList: () => null,
}));
vi.mock("@saas/workspaces/components/WorkspaceDetail", () => ({
	WorkspaceDetail: () => null,
}));
const ORG = "../../app/(saas)/app/(organizations)/[organizationSlug]";
const workspaceRoute = () => import(`${ORG}/workspaces/[id]/page`);
const pageRoute = () => import(`${ORG}/pages/[frameId]/page`);
const openWorkspace = async (id: string) =>
	(await workspaceRoute()).default({
		params: Promise.resolve({ organizationSlug: "example-org", id }),
	});
const openPage = async (frameId: string) =>
	(await pageRoute()).default({
		params: Promise.resolve({ organizationSlug: "example-org", frameId }),
	});
async function redirectTarget(run: () => Promise<unknown>) {
	try {
		await run();
	} catch (error) {
		if (error instanceof RedirectSignal) return error.location;
		throw error;
	}
	throw new Error("Expected redirect");
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.getSession.mockResolvedValue({
		user: { id: "user-1", email: "dev@example.com" },
	});
	mocks.getOrganizationBySlug.mockResolvedValue({
		id: "org-1",
		slug: "example-org",
	});
	mocks.getWorkspaceAccessContext.mockResolvedValue(null);
	mocks.getAccessibleFrameById.mockResolvedValue(null);
});
describe("document Workspaces", () => {
	it("opens an accessible document workspace at its original URL", async () => {
		mocks.getWorkspaceAccessContext.mockResolvedValue({
			organizationId: "org-1",
		});
		expect(await openWorkspace("docs-1")).toBeTruthy();
		expect(mocks.getAccessibleFrameById).not.toHaveBeenCalled();
	});
	it("redirects an authorized generated page's former URL to Pages", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue({
			id: "page-1",
			surface: "workspace",
		});
		expect(await redirectTarget(() => openWorkspace("page-1"))).toBe(
			"/app/example-org/pages/page-1",
		);
		expect(mocks.getAccessibleFrameById).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-1",
				userId: "user-1",
				id: "page-1",
			}),
		);
	});
	it("does not expose another organization's workspace or a denied page", async () => {
		mocks.getWorkspaceAccessContext.mockResolvedValue({
			organizationId: "org-2",
		});
		await expect(openWorkspace("foreign-1")).rejects.toThrow("NOT_FOUND");
	});
	it("keeps non-page frame links in the frame viewer", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue({
			id: "frame-1",
			surface: "artifact",
		});
		expect(await redirectTarget(() => openWorkspace("frame-1"))).toBe(
			"/app/example-org/frames/frame-1",
		);
	});
});
describe("generated Pages", () => {
	it("opens an accessible generated page without loading document workspace data", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue({
			id: "page-1",
			title: "Status",
			surface: "workspace",
		});
		expect(await openPage("page-1")).toBeTruthy();
		expect(mocks.getWorkspaceAccessContext).not.toHaveBeenCalled();
	});
	it("does not open an inaccessible page", async () => {
		await expect(openPage("denied")).rejects.toThrow("NOT_FOUND");
	});
	it("requires sign-in and a resolved organization", async () => {
		mocks.getSession.mockResolvedValue(null);
		expect(await redirectTarget(() => openPage("page-1"))).toBe(
			"/auth/login",
		);
		mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
		mocks.getOrganizationBySlug.mockResolvedValue(null);
		expect(await redirectTarget(() => openWorkspace("docs-1"))).toBe(
			"/app",
		);
		expect(mocks.getAccessibleFrameById).not.toHaveBeenCalled();
	});
});
describe("compatibility links", () => {
	it("redirects old Libraries URLs to document Workspaces with the query intact", async () => {
		const route = await import(`${ORG}/libraries/[[...path]]/page`);
		expect(
			await redirectTarget(() =>
				route.default({
					params: Promise.resolve({
						organizationSlug: "example-org",
						path: ["docs-1"],
					}),
					searchParams: Promise.resolve({
						tab: "documents",
						tag: ["one", "two"],
					}),
				}),
			),
		).toBe(
			"/app/example-org/workspaces/docs-1?tab=documents&tag=one&tag=two",
		);
	});
	it("redirects the old Libraries list", async () => {
		const route = await import(`${ORG}/libraries/[[...path]]/page`);
		expect(
			await redirectTarget(() =>
				route.default({
					params: Promise.resolve({
						organizationSlug: "example-org",
					}),
					searchParams: Promise.resolve({}),
				}),
			),
		).toBe("/app/example-org/workspaces");
	});
	it("keeps retired account document links pointing to document Workspaces", async () => {
		const route = await import(
			"../../app/(saas)/app/(account)/workspaces/[[...path]]/page"
		);
		await route.default({
			params: Promise.resolve({ path: ["docs-1"] }),
			searchParams: Promise.resolve({ tab: "documents" }),
		});
		expect(mocks.redirectIntoOrganization).toHaveBeenCalledWith(
			"workspaces",
			["docs-1"],
			{ tab: "documents" },
		);
	});
});
