/**
 * `/workspaces` is the organization's Workspaces now; it was the document
 * libraries. A saved link to a library has to keep arriving at the library, and
 * an id that is neither a page the viewer may open nor a library of this
 * organization has to stay not found.
 */
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
vi.mock("@saas/workspaces/components/WorkspacePage", () => ({
	WorkspacePage: () => null,
}));
vi.mock("@saas/workspaces/components/WorkspacesList", () => ({
	WorkspacesList: () => null,
}));
vi.mock("@saas/libraries/components/LibrariesList", () => ({
	LibrariesList: () => null,
}));

const ORG_ROUTES = "../../app/(saas)/app/(organizations)/[organizationSlug]";
const WORKSPACE_PAGE = `${ORG_ROUTES}/workspaces/[frameId]/page`;
const ACCOUNT_REDIRECT =
	"../../app/(saas)/app/(account)/workspaces/[[...path]]/page";

const organization = { id: "org-1", slug: "example-org" };

async function openWorkspace(frameId: string) {
	const page = await import(WORKSPACE_PAGE);
	return page.default({
		params: Promise.resolve({ organizationSlug: "example-org", frameId }),
	});
}

async function redirectTarget(run: () => Promise<unknown>) {
	try {
		await run();
	} catch (error) {
		if (error instanceof RedirectSignal) {
			return error.location;
		}
		throw error;
	}
	return null;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getSession.mockResolvedValue({
		user: { id: "user-1", email: "viewer@example.com" },
	});
	mocks.getOrganizationBySlug.mockResolvedValue(organization);
	mocks.getAccessibleFrameById.mockResolvedValue({
		id: "frame-1",
		title: "Delivery status",
		surface: "workspace",
	});
	mocks.getWorkspaceAccessContext.mockResolvedValue(null);
});

describe("/workspaces/<id>", () => {
	it("opens a workspace page the viewer may open, looked up in the URL's organization", async () => {
		const element = await openWorkspace("frame-1");

		expect(mocks.getAccessibleFrameById).toHaveBeenCalledWith({
			id: "frame-1",
			userId: "user-1",
			userEmail: "viewer@example.com",
			organizationId: "org-1",
		});
		expect(element).toBeTruthy();
		expect(mocks.getWorkspaceAccessContext).not.toHaveBeenCalled();
	});

	it("sends an old link to a document library to that library", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue(null);
		mocks.getWorkspaceAccessContext.mockResolvedValue({
			organizationId: "org-1",
		});

		expect(await redirectTarget(() => openWorkspace("library-9"))).toBe(
			"/app/example-org/libraries/library-9",
		);
		expect(mocks.getWorkspaceAccessContext).toHaveBeenCalledWith(
			"library-9",
			"user-1",
		);
	});

	it("does not send the viewer to a library of another organization", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue(null);
		mocks.getWorkspaceAccessContext.mockResolvedValue({
			organizationId: "org-2",
		});

		await expect(openWorkspace("library-9")).rejects.toThrow("NOT_FOUND");
	});

	it("does not send the viewer to a library they cannot open", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue(null);
		mocks.getWorkspaceAccessContext.mockResolvedValue(null);

		await expect(openWorkspace("nothing")).rejects.toThrow("NOT_FOUND");
	});

	it("opens a frame that is not a workspace in the frame viewer", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue({
			id: "frame-2",
			title: "Report",
			surface: "artifact",
		});

		expect(await redirectTarget(() => openWorkspace("frame-2"))).toBe(
			"/app/example-org/frames/frame-2",
		);
	});

	it("sends a signed-out viewer to sign in, and an unknown organization to the app", async () => {
		mocks.getSession.mockResolvedValue(null);
		expect(await redirectTarget(() => openWorkspace("frame-1"))).toBe(
			"/auth/login",
		);

		mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
		mocks.getOrganizationBySlug.mockResolvedValue(null);
		expect(await redirectTarget(() => openWorkspace("frame-1"))).toBe(
			"/app",
		);
		expect(mocks.getAccessibleFrameById).not.toHaveBeenCalled();
	});
});

describe("the retired /app/workspaces", () => {
	it("keeps arriving at the libraries, whatever the path below it", async () => {
		const page = await import(ACCOUNT_REDIRECT);

		await page.default({
			params: Promise.resolve({ path: ["library-9"] }),
			searchParams: Promise.resolve({ tab: "documents" }),
		});

		expect(mocks.redirectIntoOrganization).toHaveBeenCalledWith(
			"libraries",
			["library-9"],
			{ tab: "documents" },
		);
	});

	it("sends the bare path to the libraries list", async () => {
		const page = await import(ACCOUNT_REDIRECT);

		await page.default({
			params: Promise.resolve({}),
			searchParams: Promise.resolve({}),
		});

		expect(mocks.redirectIntoOrganization).toHaveBeenCalledWith(
			"libraries",
			undefined,
			{},
		);
	});
});
