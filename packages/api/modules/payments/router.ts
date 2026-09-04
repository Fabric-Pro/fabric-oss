import * as aiUsageLimits from "./procedures/ai-usage-limits";
import { createCheckoutLink } from "./procedures/create-checkout-link";
import { createCustomerPortalLink } from "./procedures/create-customer-portal-link";
import { getAiActivityEstimate } from "./procedures/get-ai-activity-estimate";
import { getAiActivityFacets } from "./procedures/get-ai-activity-facets";
import { getAiActivityTimeSeries } from "./procedures/get-ai-activity-time-series";
import { getAiUsageBreakdown } from "./procedures/get-ai-usage-breakdown";
import { listAiActivity } from "./procedures/list-ai-activity";
import { listPurchases } from "./procedures/list-purchases";

export const paymentsRouter = {
	createCheckoutLink,
	createCustomerPortalLink,
	getAiActivityEstimate,
	getAiActivityFacets,
	getAiActivityTimeSeries,
	getAiUsageBreakdown,
	listAiActivity,
	listPurchases,
	// New `aiUsageLimits` sub-namespace per spec
	// `delete` is re-exposed from `delete_` (reserved-word workaround).
	aiUsageLimits: {
		list: aiUsageLimits.list,
		status: aiUsageLimits.status,
		providerOptions: aiUsageLimits.providerOptions,
		upsert: aiUsageLimits.upsert,
		delete: aiUsageLimits.delete_,
	},
};
