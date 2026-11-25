import { beforeEach, expect, it, vi } from "vitest";
import OrganizationContextSummaryPage from "../page";

const h = vi.hoisted(() => ({
	name: vi.fn(),
	reach: vi.fn(),
	summary: vi.fn(),
	redirect: vi.fn(() => {
		throw new Error("redirect");
	}),
}));

vi.mock("@repo/database", () => ({
	getProjectNameById: h.name,
	hasProjectAccess: h.reach,
	getLatestCompletedContextSummary: h.summary,
	parseSummaryReferences: () => [],
}));
vi.mock("@repo/utils/feature-flag", () => ({
	isContextSummarizationEnabled: () => true,
}));
vi.mock("@saas/auth/lib/server", () => ({
	getSession: async () => ({ user: { id: "example-user" } }),
	getActiveOrganization: async () => ({ id: "example-org" }),
}));
vi.mock("next/navigation", () => ({ redirect: h.redirect }));
vi.mock("@saas/projects/components/ContextSummaryPageView", () => ({
	ContextSummaryPageView: () => null,
}));
vi.mock("@saas/shared/components/TopRightControls", () => ({
	TopRightControls: () => null,
}));

function open() {
	return OrganizationContextSummaryPage({
		params: Promise.resolve({
			organizationSlug: "example-org",
			id: "example-project",
		}),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	h.name.mockResolvedValue("Example project");
	h.reach.mockResolvedValue(true);
	h.summary.mockResolvedValue({
		id: "example-summary",
		content: "Example summary",
		coveredThrough: new Date(0),
		coveredContextCount: 1,
		updatedAt: new Date(0),
	});
});

it("checks project reach before loading a context summary", async () => {
	h.name.mockResolvedValue(null);
	await expect(open()).rejects.toThrow("redirect");
	expect(h.summary).not.toHaveBeenCalled();
});

it("refuses a viewer without project reach before the name or summary lookups", async () => {
	h.reach.mockResolvedValue(false);
	await expect(open()).rejects.toThrow("redirect");
	expect(h.name).not.toHaveBeenCalled();
	expect(h.summary).not.toHaveBeenCalled();
});

it("renders a summary for a reachable project", async () => {
	await expect(open()).resolves.toBeDefined();
	expect(h.name).toHaveBeenCalledWith(
		"example-project",
		"example-user",
		"example-org",
	);
	expect(h.summary).toHaveBeenCalledWith({
		projectId: "example-project",
		userId: "example-user",
		organizationId: "example-org",
	});
});
