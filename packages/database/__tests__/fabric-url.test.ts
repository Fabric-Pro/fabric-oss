import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../prisma/client", () => ({
	db: { organization: { findUnique: vi.fn() } },
}));
vi.mock("@repo/utils", () => ({ getBaseUrl: () => "https://app.test" }));

import { db } from "../prisma/client";
import {
	buildReleaseNotesUrl,
	formatBackLinkForProvider,
	normalizeBackLinkFromProvider,
	placeFabricBackLink,
} from "../prisma/queries/projects/fabric-url";

beforeEach(() => {
	vi.clearAllMocks();
	// biome-ignore lint/performance/noDelete: test env isolation
	delete process.env.NEXT_PUBLIC_APP_URL;
	// biome-ignore lint/performance/noDelete: test env isolation
	delete process.env.APP_URL;
});

describe("buildReleaseNotesUrl", () => {
	it("personal send: no org lookup, personal route", async () => {
		const url = await buildReleaseNotesUrl({
			projectId: "p1",
			organizationId: null,
		});
		expect(url).toBe("https://app.test/app/projects/p1?tab=release-notes");
		expect(db.organization.findUnique).not.toHaveBeenCalled();
	});

	it("org send: resolves the slug into the org-scoped route", async () => {
		vi.mocked(db.organization.findUnique).mockResolvedValue({
			slug: "acme",
		} as never);
		const url = await buildReleaseNotesUrl({
			projectId: "p1",
			organizationId: "o1",
		});
		expect(db.organization.findUnique).toHaveBeenCalledWith({
			where: { id: "o1" },
			select: { slug: true },
		});
		// The org slug must be in the path — a personal-route link would 404 for
		// org projects (ProjectDetails derives tenant from the URL path).
		expect(url).toBe(
			"https://app.test/app/acme/projects/p1?tab=release-notes",
		);
	});

	it("org with no slug: falls back to the personal route", async () => {
		vi.mocked(db.organization.findUnique).mockResolvedValue({
			slug: null,
		} as never);
		const url = await buildReleaseNotesUrl({
			projectId: "p1",
			organizationId: "o1",
		});
		expect(url).toBe("https://app.test/app/projects/p1?tab=release-notes");
	});

	it("prefers NEXT_PUBLIC_APP_URL over getBaseUrl (worker-safe base)", async () => {
		process.env.NEXT_PUBLIC_APP_URL = "https://fabric.pro";
		const url = await buildReleaseNotesUrl({
			projectId: "p1",
			organizationId: null,
		});
		expect(url).toBe(
			"https://fabric.pro/app/projects/p1?tab=release-notes",
		);
	});
});

describe("back-link regex bounds (js/polynomial-redos)", () => {
	it("formatBackLinkForProvider leaves a long description with no back-link unchanged", () => {
		const longDescription = `${"x".repeat(10_000)} no back-link here`;
		expect(formatBackLinkForProvider(longDescription, "fizzy")).toBe(
			longDescription,
		);
	});

	it("normalizeBackLinkFromProvider leaves a long description with no back-link unchanged", () => {
		const longDescription = `${"y".repeat(10_000)} no back-link here`;
		expect(normalizeBackLinkFromProvider(longDescription, "fizzy")).toBe(
			longDescription,
		);
	});

	it("placeFabricBackLink still finds and repositions the anchor in a long description", () => {
		const fabricUrl = "https://app.example.com/app/projects/p1/stories/s1";
		const longDescription = `${"z".repeat(10_000)}\n<p><a href="${fabricUrl}">View in Fabric</a></p>`;
		const result = placeFabricBackLink({
			description: longDescription,
			acceptanceCriteria: null,
			fabricUrl,
		});
		expect(result.description).toContain(
			`<p><a href="${fabricUrl}">View in Fabric</a></p>`,
		);
		expect(result.description.match(/View in Fabric/g)).toHaveLength(1);
	});
});
