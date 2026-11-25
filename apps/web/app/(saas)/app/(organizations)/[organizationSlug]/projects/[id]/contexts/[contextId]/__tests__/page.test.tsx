import { beforeEach, expect, it, vi } from "vitest";
import OrganizationContextViewerPage from "../page";

const h = vi.hoisted(() => ({
	reach: vi.fn(),
	context: vi.fn(),
	url: vi.fn(),
	transcriptAccess: vi.fn(),
	notFound: vi.fn(() => {
		throw new Error("not found");
	}),
}));

vi.mock("@repo/database", () => ({
	getContextById: h.context,
	getUrlSourceContext: h.url,
	hasProjectAccess: h.reach,
}));
vi.mock("@saas/auth/lib/server", () => ({
	getSession: async () => ({ user: { id: "example-user" } }),
	getActiveOrganization: async () => ({ id: "example-org" }),
}));
vi.mock("next/navigation", () => ({ notFound: h.notFound, redirect: vi.fn() }));
vi.mock("@repo/api/modules/projects/lib/parlume-transcript-access", () => ({
	resolveParlumeTranscriptAccess: h.transcriptAccess,
	parlumeTranscriptNotice: () => null,
}));
vi.mock("@saas/projects/components/MeetingTranscriptPageView", () => ({
	MeetingTranscriptPageView: () => null,
}));
vi.mock("@saas/projects/components/UrlSourcePageView", () => ({
	UrlSourcePageView: () => null,
}));
vi.mock("@saas/shared/components/TopRightControls", () => ({
	TopRightControls: () => null,
}));

const projectId = "example-project";
const contextId = "example-context";

function open() {
	return OrganizationContextViewerPage({
		params: Promise.resolve({
			organizationSlug: "example-org",
			id: projectId,
			contextId,
		}),
		searchParams: Promise.resolve({}),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	h.reach.mockResolvedValue(true);
	h.context.mockResolvedValue({
		id: contextId,
		projectId,
		type: "MEETING_TRANSCRIPT",
		createdAt: new Date(0),
		content: "Example transcript",
	});
	h.transcriptAccess.mockResolvedValue("allowed");
	h.url.mockResolvedValue(null);
});

it("refuses a viewer without project reach before loading the context", async () => {
	h.reach.mockResolvedValue(false);
	await expect(open()).rejects.toThrow("not found");
	expect(h.context).not.toHaveBeenCalled();
});

it.each([
	["missing", null],
	[
		"on a different project",
		{ projectId: "example-other-project", type: "MEETING_TRANSCRIPT" },
	],
])("returns not found for a context that is %s", async (_, context) => {
	h.context.mockResolvedValue(context);
	await expect(open()).rejects.toThrow("not found");
	expect(h.transcriptAccess).not.toHaveBeenCalled();
	expect(h.url).not.toHaveBeenCalled();
});

it("renders a transcript on the reachable project using the scoped lookup", async () => {
	await expect(open()).resolves.toBeDefined();
	expect(h.reach).toHaveBeenCalledWith(projectId, "example-user");
	expect(h.context).toHaveBeenCalledWith(contextId, projectId, {
		userId: "example-user",
		organizationId: "example-org",
	});
	expect(h.transcriptAccess).toHaveBeenCalledWith({
		projectId,
		contextId,
		userId: "example-user",
	});
});

it("returns not found when a URL source disappears during loading", async () => {
	h.context.mockResolvedValue({ id: contextId, projectId, type: "LINK" });
	await expect(open()).rejects.toThrow("not found");
	expect(h.url).toHaveBeenCalledOnce();
});

it("renders a URL source scoped to the reachable project", async () => {
	h.context.mockResolvedValue({ id: contextId, projectId, type: "LINK" });
	h.url.mockResolvedValue({
		id: contextId,
		projectId,
		type: "LINK",
		sourceUrl: "https://example.com/context",
		createdAt: new Date(0),
		updatedAt: new Date(0),
	});
	await expect(open()).resolves.toBeDefined();
	expect(h.url).toHaveBeenCalledWith({
		contextId,
		projectId,
		userId: "example-user",
		organizationId: "example-org",
	});
});
