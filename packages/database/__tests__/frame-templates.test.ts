import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, Prisma } from "../prisma/client";
import {
	type CreateFrameTemplateInput,
	createFrameTemplate,
	deleteFrameTemplate,
	getFrameTemplateById,
	getFrameTemplateCategories,
	listFrameTemplates,
	substituteTemplateVariables,
	updateFrameTemplate,
} from "../prisma/queries/frame-templates";
import type { FrameDocument } from "../prisma/queries/frames";

const USER_ID = "test-template-user";
const ORG_ID = "test-template-org";

const sampleTemplateContent: FrameDocument = {
	version: 1,
	title: "Sample Template",
	description: "A sample template",
	kind: "frame",
	blocks: [
		{ id: "block-1", type: "markdown", content: "# {{companyName}}" },
		{ id: "block-2", type: "markdown", content: "Report for {{year}}" },
	],
};

beforeAll(async () => {
	const now = new Date();
	await db.$executeRaw(Prisma.sql`
		INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
		VALUES (${USER_ID}, ${"Test Templates"}, ${"templates@example.com"}, true, false, ${now}, ${now})
		ON CONFLICT (id) DO NOTHING
	`);
	await db.$executeRaw(Prisma.sql`
		INSERT INTO "organization" (id, name, slug, "createdAt")
		VALUES (${ORG_ID}, ${"Test Templates Org"}, ${ORG_ID}, ${now})
		ON CONFLICT (id) DO NOTHING
	`);
});

beforeEach(async () => {
	await db.frameTemplate.deleteMany({
		where: {
			OR: [
				{ organizationId: ORG_ID },
				{ isSystem: false },
				{ name: { contains: "Test Template" } },
			],
		},
	});
});

afterAll(async () => {
	await db.frameTemplate.deleteMany({
		where: {
			OR: [{ organizationId: ORG_ID }, { isSystem: false }],
		},
	});
});

describe("frame template queries", () => {
	it("creates a frame template", async () => {
		const input: CreateFrameTemplateInput = {
			name: "Dashboard Template",
			description: "A dashboard template",
			category: "Dashboard",
			content: sampleTemplateContent,
			organizationId: ORG_ID,
		};

		const template = await createFrameTemplate(input);

		expect(template.name).toBe("Dashboard Template");
		expect(template.category).toBe("Dashboard");
		expect(template.organizationId).toBe(ORG_ID);
		expect(template.isSystem).toBe(false);
	});

	it("retrieves a frame template by id", async () => {
		const created = await createFrameTemplate({
			name: "Test Template",
			category: "Report",
			content: sampleTemplateContent,
		});

		const fetched = await getFrameTemplateById(created.id);

		expect(fetched).not.toBeNull();
		expect(fetched?.name).toBe("Test Template");
		expect(fetched?.category).toBe("Report");
	});

	it("returns null for non-existent template", async () => {
		const fetched = await getFrameTemplateById("non-existent-id");
		expect(fetched).toBeNull();
	});

	it("lists templates with organization filter", async () => {
		// Create org-specific template
		await createFrameTemplate({
			name: "Org Template",
			category: "Dashboard",
			content: sampleTemplateContent,
			organizationId: ORG_ID,
		});

		// Create system template
		await createFrameTemplate({
			name: "System Template",
			category: "Dashboard",
			content: sampleTemplateContent,
			isSystem: true,
		});

		// List org templates (should include system + org)
		const orgTemplates = await listFrameTemplates({
			organizationId: ORG_ID,
			includeSystem: true,
		});

		expect(orgTemplates.length).toBeGreaterThanOrEqual(2);
		expect(orgTemplates.some((t) => t.name === "Org Template")).toBe(true);
		expect(orgTemplates.some((t) => t.name === "System Template")).toBe(
			true,
		);
	});

	it("filters templates by category", async () => {
		await createFrameTemplate({
			name: "Dashboard 1",
			category: "Dashboard",
			content: sampleTemplateContent,
			organizationId: ORG_ID,
		});

		await createFrameTemplate({
			name: "Report 1",
			category: "Report",
			content: sampleTemplateContent,
			organizationId: ORG_ID,
		});

		const dashboardTemplates = await listFrameTemplates({
			organizationId: ORG_ID,
			category: "Dashboard",
			includeSystem: false,
		});

		expect(dashboardTemplates).toHaveLength(1);
		expect(dashboardTemplates[0].name).toBe("Dashboard 1");
	});

	it("gets unique template categories", async () => {
		await createFrameTemplate({
			name: "Template 1",
			category: "TestDashboard",
			content: sampleTemplateContent,
			organizationId: ORG_ID,
		});

		await createFrameTemplate({
			name: "Template 2",
			category: "TestReport",
			content: sampleTemplateContent,
			organizationId: ORG_ID,
		});

		await createFrameTemplate({
			name: "Template 3",
			category: "TestDashboard", // Same category
			content: sampleTemplateContent,
			organizationId: ORG_ID,
		});

		const categories = await getFrameTemplateCategories(ORG_ID);

		expect(categories).toContain("TestDashboard");
		expect(categories).toContain("TestReport");
	});

	it("updates a frame template", async () => {
		const created = await createFrameTemplate({
			name: "Original Name",
			category: "Dashboard",
			content: sampleTemplateContent,
		});

		const updated = await updateFrameTemplate({
			id: created.id,
			name: "Updated Name",
			category: "Report",
		});

		expect(updated).not.toBeNull();
		expect(updated?.name).toBe("Updated Name");
		expect(updated?.category).toBe("Report");
	});

	it("deletes a frame template", async () => {
		const created = await createFrameTemplate({
			name: "To Delete",
			category: "Dashboard",
			content: sampleTemplateContent,
		});

		const deleted = await deleteFrameTemplate(created.id);
		expect(deleted).toBe(true);

		const fetched = await getFrameTemplateById(created.id);
		expect(fetched).toBeNull();
	});

	it("returns false when deleting non-existent template", async () => {
		const result = await deleteFrameTemplate("non-existent-id");
		expect(result).toBe(false);
	});

	it("substitutes template variables", () => {
		const content: FrameDocument = {
			version: 1,
			title: "{{companyName}} Report",
			description: "Annual report for {{year}}",
			kind: "frame",
			blocks: [
				{ id: "b1", type: "markdown", content: "# {{companyName}}" },
			],
		};

		const variables = {
			companyName: {
				type: "string" as const,
				label: "Company Name",
				default: "Acme",
			},
			year: { type: "string" as const, label: "Year", default: "2024" },
		};

		const values = { companyName: "Fabric", year: "2025" };

		const result = substituteTemplateVariables(content, variables, values);

		expect(result.title).toBe("Fabric Report");
		expect(result.description).toBe("Annual report for 2025");
		expect(result.blocks[0].content).toBe("# Fabric");
	});

	it("uses default values when values not provided", () => {
		const content: FrameDocument = {
			version: 1,
			title: "{{companyName}} Report",
			description: "Annual report",
			kind: "frame",
			blocks: [],
		};

		const variables = {
			companyName: {
				type: "string" as const,
				label: "Company",
				default: "DefaultCorp",
			},
		};

		const result = substituteTemplateVariables(content, variables, {});

		expect(result.title).toBe("DefaultCorp Report");
	});
});
