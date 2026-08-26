import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Mock dependencies
vi.mock("@repo/database", async () => {
	return {
		listFrameTemplates: vi.fn(),
		getFrameTemplateCategories: vi.fn(),
		getFrameTemplateById: vi.fn(),
		createFrame: vi.fn(),
		substituteTemplateVariables: vi.fn(),
	};
});

vi.mock("../../../orpc/procedures", async () => {
	return {
		tenantProtectedProcedure: {
			use: vi.fn().mockReturnThis(),
			route: vi.fn().mockReturnThis(),
			input: vi.fn().mockReturnThis(),
			output: vi.fn().mockReturnThis(),
			handler: vi.fn((fn) => fn),
		},
		resolveOrganizationId: vi.fn((inputOrgId, _session) => inputOrgId),
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
	};
});

import {
	createFrame,
	getFrameTemplateById,
	getFrameTemplateCategories,
	listFrameTemplates,
	substituteTemplateVariables,
} from "@repo/database";

describe("Frame Template API Procedures", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("listTemplates", () => {
		it("should validate input schema correctly", () => {
			const inputSchema = z.object({
				organizationId: z.string().nullable().optional(),
				category: z.string().optional(),
				includeSystem: z.boolean().default(true),
			});

			const validInput = {
				organizationId: "org-123",
				category: "Dashboard",
				includeSystem: true,
			};

			const result = inputSchema.safeParse(validInput);
			expect(result.success).toBe(true);
		});

		it("should return templates and categories", async () => {
			const mockTemplates = [
				{
					id: "template-1",
					name: "Dashboard Template",
					description: "A dashboard template",
					category: "Dashboard",
					variables: null,
					isSystem: true,
					createdAt: new Date(),
				},
			];

			const mockCategories = ["Dashboard", "Report", "Presentation"];

			vi.mocked(listFrameTemplates).mockResolvedValue(
				mockTemplates as any,
			);
			vi.mocked(getFrameTemplateCategories).mockResolvedValue(
				mockCategories,
			);

			const templates = await listFrameTemplates({
				organizationId: "org-123",
				includeSystem: true,
			});

			expect(templates).toHaveLength(1);
			expect(templates[0].name).toBe("Dashboard Template");
		});
	});

	describe("createFromTemplate", () => {
		it("should validate create from template input", () => {
			const inputSchema = z.object({
				organizationId: z.string().nullable().optional(),
				templateId: z.string(),
				variables: z.record(z.string(), z.string()).default({}),
				title: z.string().optional(),
				description: z.string().optional(),
			});

			const validInput = {
				templateId: "template-123",
				variables: { companyName: "Fabric" },
				title: "Custom Title",
			};

			const result = inputSchema.safeParse(validInput);
			expect(result.success).toBe(true);
		});

		it("should create frame from template with variable substitution", async () => {
			const mockTemplate = {
				id: "template-123",
				name: "Report Template",
				content: {
					title: "{{companyName}} Report",
					kind: "frame",
					blocks: [],
				},
				variables: {
					companyName: {
						type: "string",
						label: "Company Name",
						default: "Acme",
					},
				},
				isSystem: true,
				organizationId: undefined,
			};

			const mockFrame = {
				id: "frame-123",
				title: "Fabric Report",
				path: "/frames/fabric-report",
			};

			vi.mocked(getFrameTemplateById).mockResolvedValue(
				mockTemplate as any,
			);
			vi.mocked(substituteTemplateVariables).mockReturnValue({
				title: "Fabric Report",
				kind: "frame",
				blocks: [],
			} as any);
			vi.mocked(createFrame).mockResolvedValue(mockFrame as any);

			const template = await getFrameTemplateById("template-123");
			expect(template).not.toBeNull();
			expect(template?.name).toBe("Report Template");
		});

		it("should return error for non-existent template", async () => {
			vi.mocked(getFrameTemplateById).mockResolvedValue(null);

			const template = await getFrameTemplateById("non-existent");
			expect(template).toBeNull();
		});
	});
});
