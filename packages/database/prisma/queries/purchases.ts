import type { z } from "zod";
import { db } from "../client";
import type { PurchaseSchema } from "../zod";

/**
 * Get a purchase by ID with tenant isolation
 *
 * TENANT ISOLATION (XOR Pattern):
 * - ORGANIZATION CONTEXT (organizationId provided): Only org purchases
 * - PERSONAL CONTEXT (userId only, no organizationId): Only personal purchases
 */
export async function getPurchaseById(
	id: string,
	opts?: { userId?: string; organizationId?: string },
) {
	const purchase = await db.purchase.findUnique({
		where: { id },
	});

	if (!purchase || !opts) {
		return purchase;
	}

	// Verify tenant access
	if (opts.organizationId) {
		// Org context: purchase must belong to this org
		if (purchase.organizationId !== opts.organizationId) {
			return null;
		}
	} else if (opts.userId) {
		// Personal context: purchase must be personal (no org) and belong to user
		if (
			purchase.organizationId !== null ||
			purchase.userId !== opts.userId
		) {
			return null;
		}
	}

	return purchase;
}

/**
 * Get purchases for an organization
 * Only returns purchases that belong to the specified organization
 */
export async function getPurchasesByOrganizationId(organizationId: string) {
	return db.purchase.findMany({
		where: {
			organizationId,
		},
	});
}

/**
 * Get purchases for a user's personal account (not organization)
 *
 * TENANT ISOLATION (XOR Pattern):
 * Enforces strict isolation - only returns purchases where organizationId is null
 */
export async function getPurchasesByUserId(userId: string) {
	return db.purchase.findMany({
		where: {
			userId,
			organizationId: null, // XOR: Only personal purchases, not org purchases
		},
	});
}

export async function getPurchaseBySubscriptionId(subscriptionId: string) {
	return db.purchase.findFirst({
		where: {
			subscriptionId,
		},
	});
}

export async function createPurchase(
	purchase: Omit<
		z.infer<typeof PurchaseSchema>,
		"id" | "createdAt" | "updatedAt"
	>,
) {
	const created = await db.purchase.create({
		data: purchase,
	});

	return getPurchaseById(created.id);
}

export async function updatePurchase(
	purchase: Partial<
		Omit<z.infer<typeof PurchaseSchema>, "createdAt" | "updatedAt">
	> & { id: string },
) {
	const updated = await db.purchase.update({
		where: {
			id: purchase.id,
		},
		data: purchase,
	});

	return getPurchaseById(updated.id);
}

export async function deletePurchaseBySubscriptionId(subscriptionId: string) {
	await db.purchase.delete({
		where: {
			subscriptionId,
		},
	});
}
