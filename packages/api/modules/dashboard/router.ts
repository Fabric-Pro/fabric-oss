/**
 * Dashboard API Router
 *
 * Provides endpoints for dashboard statistics and activity
 */

import { getDashboardActivity } from "./procedures/get-activity";
import { getDashboardCuratedFeedback } from "./procedures/get-curated-feedback";
import { getDashboardDeliveryInsights } from "./procedures/get-delivery-insights";
import { getDashboardMyWork } from "./procedures/get-my-work";
import { getDashboardStats } from "./procedures/get-stats";
import { recordDashboardCuratedFeedback } from "./procedures/record-curated-feedback";

export const dashboardRouter = {
	stats: getDashboardStats,
	activity: getDashboardActivity,
	myWork: getDashboardMyWork,
	deliveryInsights: getDashboardDeliveryInsights,
	curatedFeedback: {
		list: getDashboardCuratedFeedback,
		record: recordDashboardCuratedFeedback,
	},
};
