import { db } from "../client";
import type { FrameDocument } from "./frames";

export interface FrameTemplateVariable {
	type: "string" | "number" | "boolean" | "select";
	default?: string | number | boolean;
	label: string;
	options?: string[];
	required?: boolean;
}

export interface FrameTemplate {
	id: string;
	name: string;
	description?: string;
	category: string;
	content: FrameDocument;
	variables?: Record<string, FrameTemplateVariable>;
	organizationId?: string;
	isSystem: boolean;
	createdAt: Date;
	updatedAt: Date;
}

export interface CreateFrameTemplateInput {
	name: string;
	description?: string;
	category: string;
	content: FrameDocument;
	variables?: Record<string, FrameTemplateVariable>;
	organizationId?: string;
	isSystem?: boolean;
}

export async function createFrameTemplate(
	input: CreateFrameTemplateInput,
): Promise<FrameTemplate> {
	const template = await db.frameTemplate.create({
		data: {
			name: input.name,
			description: input.description,
			category: input.category,
			content: input.content as any,
			variables: input.variables as any,
			organizationId: input.organizationId ?? null,
			isSystem: input.isSystem ?? false,
		},
	});

	return {
		id: template.id,
		name: template.name,
		description: template.description ?? undefined,
		category: template.category,
		content: template.content as unknown as FrameDocument,
		variables:
			(template.variables as unknown as Record<
				string,
				FrameTemplateVariable
			>) ?? undefined,
		organizationId: template.organizationId ?? undefined,
		isSystem: template.isSystem,
		createdAt: template.createdAt,
		updatedAt: template.updatedAt,
	};
}

export async function getFrameTemplateById(
	id: string,
): Promise<FrameTemplate | null> {
	const template = await db.frameTemplate.findUnique({
		where: { id },
	});

	if (!template) {
		return null;
	}

	return {
		id: template.id,
		name: template.name,
		description: template.description ?? undefined,
		category: template.category,
		content: template.content as unknown as FrameDocument,
		variables:
			(template.variables as unknown as Record<
				string,
				FrameTemplateVariable
			>) ?? undefined,
		organizationId: template.organizationId ?? undefined,
		isSystem: template.isSystem,
		createdAt: template.createdAt,
		updatedAt: template.updatedAt,
	};
}

export interface ListFrameTemplatesInput {
	organizationId?: string;
	category?: string;
	includeSystem?: boolean;
}

export async function listFrameTemplates(
	input: ListFrameTemplatesInput = {},
): Promise<FrameTemplate[]> {
	const where: any = {};

	if (input.organizationId) {
		where.OR = [
			{ organizationId: input.organizationId },
			...(input.includeSystem !== false ? [{ isSystem: true }] : []),
		];
	} else if (input.includeSystem !== false) {
		where.isSystem = true;
	}

	if (input.category) {
		where.category = input.category;
	}

	const templates = await db.frameTemplate.findMany({
		where,
		orderBy: [{ isSystem: "desc" }, { name: "asc" }],
	});

	return templates.map((template) => ({
		id: template.id,
		name: template.name,
		description: template.description ?? undefined,
		category: template.category,
		content: template.content as unknown as FrameDocument,
		variables:
			(template.variables as unknown as Record<
				string,
				FrameTemplateVariable
			>) ?? undefined,
		organizationId: template.organizationId ?? undefined,
		isSystem: template.isSystem,
		createdAt: template.createdAt,
		updatedAt: template.updatedAt,
	}));
}

export async function getFrameTemplateCategories(
	organizationId?: string,
): Promise<string[]> {
	const where: any = {};

	if (organizationId) {
		where.OR = [{ organizationId }, { isSystem: true }];
	} else {
		where.isSystem = true;
	}

	const categories = await db.frameTemplate.findMany({
		where,
		select: { category: true },
		distinct: ["category"],
		orderBy: { category: "asc" },
	});

	return categories.map((c) => c.category);
}

export async function deleteFrameTemplate(id: string): Promise<boolean> {
	try {
		await db.frameTemplate.delete({
			where: { id },
		});
		return true;
	} catch {
		return false;
	}
}

export interface UpdateFrameTemplateInput {
	id: string;
	name?: string;
	description?: string;
	category?: string;
	content?: FrameDocument;
	variables?: Record<string, FrameTemplateVariable>;
}

export async function updateFrameTemplate(
	input: UpdateFrameTemplateInput,
): Promise<FrameTemplate | null> {
	try {
		const template = await db.frameTemplate.update({
			where: { id: input.id },
			data: {
				name: input.name,
				description: input.description,
				category: input.category,
				content: input.content as any,
				variables: input.variables as any,
			},
		});

		return {
			id: template.id,
			name: template.name,
			description: template.description ?? undefined,
			category: template.category,
			content: template.content as unknown as FrameDocument,
			variables:
				(template.variables as unknown as Record<
					string,
					FrameTemplateVariable
				>) ?? undefined,
			organizationId: template.organizationId ?? undefined,
			isSystem: template.isSystem,
			createdAt: template.createdAt,
			updatedAt: template.updatedAt,
		};
	} catch {
		return null;
	}
}

export function substituteTemplateVariables(
	content: FrameDocument,
	variables: Record<string, FrameTemplateVariable>,
	values: Record<string, string>,
): FrameDocument {
	let contentStr = JSON.stringify(content);

	for (const [key, variable] of Object.entries(variables)) {
		const placeholder = `{{${key}}}`;
		const value = values[key] ?? variable.default ?? "";
		contentStr = contentStr.split(placeholder).join(String(value));
	}

	return JSON.parse(contentStr) as FrameDocument;
}
