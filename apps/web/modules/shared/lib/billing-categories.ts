export function getBillingCategoryLabel(category: string): string {
	switch (category) {
		case "INCLUDED_CREDIT":
			return "Included credit";
		case "STRIPE_METERED":
			return "Stripe metered";
		case "EXTERNAL_BYOK":
			return "External BYOK";
		case "PLATFORM_UNBILLED":
			return "Platform unbilled";
		default:
			return category;
	}
}
