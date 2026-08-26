/**
 * Auto-selection mappings for project wizard
 * Maps project types to recommended tech stacks and features
 */

/**
 * Map project types to recommended tech stack items
 */
const PROJECT_TYPE_TECH_STACK_MAP: Record<string, string[]> = {
	web: [
		"React",
		"Next.js",
		"TypeScript",
		"Tailwind CSS",
		"PostgreSQL",
		"Node.js",
		"Prisma",
	],
	mobile: [
		"React Native",
		"TypeScript",
		"Expo",
		"Firebase",
		"Redux",
		"React Navigation",
	],
	api: [
		"Node.js",
		"TypeScript",
		"Express.js",
		"PostgreSQL",
		"Docker",
		"Swagger",
		"JWT",
	],
	saas: [
		"React",
		"Next.js",
		"TypeScript",
		"Tailwind CSS",
		"PostgreSQL",
		"Stripe",
		"Better Auth",
		"Redis",
		"Vercel",
	],
	ecommerce: [
		"React",
		"Next.js",
		"TypeScript",
		"Tailwind CSS",
		"PostgreSQL",
		"Stripe",
		"Redis",
		"Algolia",
	],
	other: [],
};

/**
 * Map project types to recommended features
 */
const PROJECT_TYPE_FEATURES_MAP: Record<string, string[]> = {
	web: [
		"User Registration",
		"Login/Logout",
		"Password Reset",
		"Responsive Design",
		"Dark Mode",
		"CRUD Operations",
		"Form Validation",
	],
	mobile: [
		"Push Notifications",
		"Offline Support",
		"Biometric Authentication",
		"User Profiles",
		"Deep Linking",
		"App State Persistence",
	],
	api: [
		"REST API",
		"API Documentation",
		"API Rate Limiting",
		"API Authentication",
		"Data Validation",
		"Error Handling",
		"Logging",
	],
	saas: [
		"User Registration",
		"Login/Logout",
		"Two-Factor Authentication (2FA)",
		"Role-Based Access Control (RBAC)",
		"Subscription Management",
		"Payment Processing",
		"Invoice Generation",
		"Admin Dashboard",
		"Multi-language Support (i18n)",
		"Email Notifications",
		"User Onboarding",
	],
	ecommerce: [
		"Product Catalog",
		"Shopping Cart",
		"Checkout Process",
		"Payment Processing",
		"Order Management",
		"Inventory Management",
		"Product Reviews",
		"Wishlist",
		"User Registration",
		"Search",
	],
	other: [],
};

/**
 * Get combined tech stack recommendations for multiple project types
 */
export function getTechStackRecommendations(projectTypes: string[]): string[] {
	const recommendations = new Set<string>();
	for (const type of projectTypes) {
		const techs = PROJECT_TYPE_TECH_STACK_MAP[type] || [];
		for (const tech of techs) {
			recommendations.add(tech);
		}
	}
	return Array.from(recommendations);
}

/**
 * Get combined feature recommendations for multiple project types
 */
export function getFeatureRecommendations(projectTypes: string[]): string[] {
	const recommendations = new Set<string>();
	for (const type of projectTypes) {
		const features = PROJECT_TYPE_FEATURES_MAP[type] || [];
		for (const feature of features) {
			recommendations.add(feature);
		}
	}
	return Array.from(recommendations);
}
