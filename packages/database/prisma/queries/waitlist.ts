/**
 * Database queries for waitlist/lead capture
 * Used for pre-launch signups when the app is not live yet
 */

import { db, type Prisma } from "../client";

export interface WaitlistSignupInput {
	email: string;
	name?: string;
	source?: string;
	metadata?: Prisma.InputJsonValue;
}

/**
 * Add a new email to the waitlist
 * Returns the created entry or the existing one if email already exists
 */
export async function addToWaitlist(input: WaitlistSignupInput) {
	const { email, name, source, metadata } = input;

	// Use upsert to handle duplicate emails gracefully
	return await db.waitlist.upsert({
		where: { email: email.toLowerCase().trim() },
		create: {
			email: email.toLowerCase().trim(),
			name: name?.trim() || null,
			source: source || null,
			metadata: metadata ?? undefined,
		},
		update: {
			// If they sign up again, update their name and metadata if provided
			...(name && { name: name.trim() }),
			...(metadata && { metadata }),
		},
	});
}

/**
 * Check if an email is already on the waitlist
 */
export async function isEmailOnWaitlist(email: string): Promise<boolean> {
	const entry = await db.waitlist.findUnique({
		where: { email: email.toLowerCase().trim() },
		select: { id: true },
	});
	return !!entry;
}

/**
 * Get all waitlist entries (for admin purposes)
 */
export async function getWaitlistEntries(params?: {
	limit?: number;
	offset?: number;
	orderBy?: "asc" | "desc";
}) {
	const { limit = 100, offset = 0, orderBy = "desc" } = params || {};

	return await db.waitlist.findMany({
		take: limit,
		skip: offset,
		orderBy: { createdAt: orderBy },
	});
}

/**
 * Get total count of waitlist entries
 */
export async function getWaitlistCount(): Promise<number> {
	return await db.waitlist.count();
}

/**
 * Remove an email from the waitlist (e.g., when they become a user)
 */
export async function removeFromWaitlist(email: string) {
	return await db.waitlist.delete({
		where: { email: email.toLowerCase().trim() },
	});
}
