/**
 * Dashboard API Router
 *
 * Provides endpoints for dashboard statistics and activity
 */

import { getDashboardActivity } from "./procedures/get-activity";
import { getDashboardMyWork } from "./procedures/get-my-work";
import { getDashboardStats } from "./procedures/get-stats";

export const dashboardRouter = {
	stats: getDashboardStats,
	activity: getDashboardActivity,
	myWork: getDashboardMyWork,
};
