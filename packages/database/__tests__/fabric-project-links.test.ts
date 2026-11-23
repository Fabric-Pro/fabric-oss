import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../prisma/client", () => ({
	db: { organization: { findUnique: vi.fn() } },
}));
vi.mock("@repo/utils", () => ({ getBaseUrl: () => "https://app.test" }));

import { db } from "../prisma/client";
import {
	buildFabricContextUrl,
	buildFabricDocumentUrl,
	buildFabricProjectTabUrl,
	buildFabricStoryUrl,
	buildParlumeActionUrl,
	buildParlumePageUrl,
} from "../prisma/queries/projects/fabric-url";

beforeEach(() => {
	vi.resetAllMocks();
	delete process.env.NEXT_PUBLIC_APP_URL;
	delete process.env.APP_URL;
	vi.mocked(db.organization.findUnique).mockResolvedValue({
		slug: "example-org",
	} as never);
});

describe("project links", () => {
	it("opens a document, a source and a tab under the project's organization", async () => {
		const org = { projectId: "p1", organizationId: "o1" };

		expect(await buildFabricDocumentUrl({ ...org, documentId: "d1" })).toBe(
			"https://app.test/app/example-org/projects/p1/documents/d1",
		);
		expect(await buildFabricContextUrl({ ...org, contextId: "c1" })).toBe(
			"https://app.test/app/example-org/projects/p1/contexts/c1",
		);
		expect(await buildFabricProjectTabUrl({ ...org, tab: "stories" })).toBe(
			"https://app.test/app/example-org/projects/p1?tab=stories",
		);
		expect(await buildFabricStoryUrl({ ...org, storyId: "s1" })).toBe(
			"https://app.test/app/example-org/projects/p1/stories/s1",
		);
	});

	it("opens the project's Parlume page, which the join notice links to", async () => {
		expect(
			await buildParlumePageUrl({
				projectId: "p1",
				organizationId: "o1",
			}),
		).toBe("https://app.test/app/example-org/projects/p1/parlume");
	});

	it("opens a Parlume proposal's action page, and the same page ready to dismiss", async () => {
		const org = { projectId: "p1", organizationId: "o1" };

		expect(await buildParlumeActionUrl({ ...org, actionId: "a1" })).toBe(
			"https://app.test/app/example-org/projects/p1/parlume/actions/a1",
		);
		expect(
			await buildParlumeActionUrl({
				...org,
				actionId: "a1",
				intent: "dismiss",
			}),
		).toBe(
			"https://app.test/app/example-org/projects/p1/parlume/actions/a1?intent=dismiss",
		);
	});

	it("uses the personal route, with no organization lookup, for a personal project", async () => {
		expect(
			await buildFabricDocumentUrl({
				projectId: "p1",
				organizationId: null,
				documentId: "d1",
			}),
		).toBe("https://app.test/app/projects/p1/documents/d1");
		expect(db.organization.findUnique).not.toHaveBeenCalled();
	});

	it("prefers the configured app address over the fallback", async () => {
		process.env.NEXT_PUBLIC_APP_URL = "https://fabric.example";

		expect(
			await buildFabricProjectTabUrl({
				projectId: "p1",
				organizationId: "o1",
				tab: "decisions",
			}),
		).toBe(
			"https://fabric.example/app/example-org/projects/p1?tab=decisions",
		);
	});

	it("refuses an organization whose address is missing instead of linking to a page that will not load", async () => {
		vi.mocked(db.organization.findUnique).mockResolvedValue({
			slug: null,
		} as never);

		await expect(
			buildFabricDocumentUrl({
				projectId: "p1",
				organizationId: "o1",
				documentId: "d1",
			}),
		).rejects.toThrow("no address");
		vi.mocked(db.organization.findUnique).mockResolvedValue(null);
		await expect(
			buildFabricContextUrl({
				projectId: "p1",
				organizationId: "o1",
				contextId: "c1",
			}),
		).rejects.toThrow("no address");
	});
});
