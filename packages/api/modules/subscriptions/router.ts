/**
 * Subscriptions Router
 *
 * Opt-in "watch this item" subscriptions for documents and features. When a
 * subscribed item changes, `fanOut.subscriptionUpdate` (notification-service)
 * writes a `SUBSCRIPTION`-category notification to each subscriber. Isolation
 * is app-layer: procedures gate on `requireProjectPermission(PROJECT_READ)`
 * and scope rows by `userId` (+ stored `organizationId`).
 */

import { getSubscriptionStatusProcedure } from "./procedures/get-status";
import { subscribeProcedure } from "./procedures/subscribe";
import { unsubscribeProcedure } from "./procedures/unsubscribe";

export const subscriptionsRouter = {
	subscribe: subscribeProcedure,
	unsubscribe: unsubscribeProcedure,
	getStatus: getSubscriptionStatusProcedure,
};
