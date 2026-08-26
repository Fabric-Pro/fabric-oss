import { getAgentTemplateCategories } from "@repo/database";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

// Category metadata for UI display
const categoryMeta: Record<
	string,
	{ label: string; description: string; icon: string }
> = {
	DATA: {
		label: "Data",
		description: "Analytics, SQL queries, data visualization",
		icon: "database",
	},
	DESIGN: {
		label: "Design",
		description: "UI/UX, visual design, prototyping",
		icon: "palette",
	},
	ENGINEERING: {
		label: "Engineering",
		description: "Code review, debugging, API design",
		icon: "code",
	},
	FINANCE: {
		label: "Finance",
		description: "Financial analysis, budgeting, forecasting",
		icon: "dollar-sign",
	},
	HIRING: {
		label: "Hiring",
		description: "Recruiting, interviews, candidate evaluation",
		icon: "users",
	},
	KNOWLEDGE: {
		label: "Knowledge",
		description: "Documentation, FAQs, knowledge management",
		icon: "book-open",
	},
	LEGAL: {
		label: "Legal",
		description: "Contracts, compliance, legal review",
		icon: "scale",
	},
	MARKETING: {
		label: "Marketing",
		description: "Content creation, campaigns, brand",
		icon: "megaphone",
	},
	OPERATIONS: {
		label: "Operations",
		description: "Process optimization, workflows",
		icon: "settings",
	},
	PRODUCT: {
		label: "Product",
		description: "PRDs, roadmaps, feature planning",
		icon: "package",
	},
	PRODUCT_MANAGEMENT: {
		label: "Product Management",
		description: "Strategy, prioritization, stakeholder management",
		icon: "target",
	},
	PRODUCTIVITY: {
		label: "Productivity",
		description: "Task management, meeting summaries",
		icon: "zap",
	},
	SALES: {
		label: "Sales",
		description: "Account management, proposals, CRM",
		icon: "trending-up",
	},
	SUPPORT: {
		label: "Support",
		description: "Customer support, ticket analysis, FAQs",
		icon: "headphones",
	},
	GENERAL: {
		label: "General",
		description: "Multi-purpose assistants",
		icon: "sparkles",
	},
};

export const getCategoriesProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_TEMPLATE_READ))
	.handler(async () => {
		const categoriesWithCount = await getAgentTemplateCategories();

		const categories = categoriesWithCount.map((cat) => ({
			category: cat.category,
			count: cat.count,
			...categoryMeta[cat.category],
		}));

		return { categories };
	});
