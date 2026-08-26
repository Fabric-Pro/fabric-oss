import type { KnowledgeBaseSourceCategoryValue } from "@repo/api/modules/projects/procedures/contexts/knowledge-base-category.types";

/**
 * The eight Knowledge Base Source Categories, in the order the acceptance
 * criteria specify (Fizzy #2165). Classifying a link is what lets the project
 * readiness checklist tell a wiki from a marketing page; without it every link
 * is just "a link".
 *
 * Lives here rather than beside either picker because two surfaces now offer
 * the choice — the Add Context dialog when a source is created, and a URL
 * source's own Settings card when an older one is being classified after the
 * fact. A second copy of the labels would drift from the first.
 */
export const KNOWLEDGE_BASE_CATEGORY_OPTIONS: ReadonlyArray<{
	value: KnowledgeBaseSourceCategoryValue;
	label: string;
}> = [
	{ value: "KNOWLEDGE_BASE_WIKI", label: "Knowledge Base / Wiki" },
	{ value: "PRODUCT_DOCUMENTATION", label: "Product Documentation" },
	{
		value: "TECHNICAL_DEVELOPER_DOCUMENTATION",
		label: "Technical / Developer Documentation",
	},
	{ value: "API_DOCUMENTATION", label: "API Documentation" },
	{ value: "HELP_CENTER_SUPPORT_DOCS", label: "Help Center / Support Docs" },
	{ value: "MARKETING_WEBSITE", label: "Marketing Website" },
	{
		value: "COMPLIANCE_SECURITY_DOCUMENTATION",
		label: "Compliance / Security Documentation",
	},
	{ value: "OTHER", label: "Other" },
];
