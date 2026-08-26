/**
 * Fabric Auth Integration
 *
 * This module provides authentication using Fabric's Better Auth session.
 * When the data-analyst app runs alongside Fabric (same domain or subdomain),
 * it shares the session cookie and validates against Fabric's auth API.
 */

import { cookies, headers } from "next/headers";

export interface FabricSession {
	user: {
		id: string;
		email?: string;
		name?: string;
		image?: string;
	};
	session: {
		id: string;
		activeOrganizationId?: string;
	};
}

// Fabric API base URL - defaults to main app on port 3001
const FABRIC_API_URL = process.env.FABRIC_API_URL || "http://localhost:3001";

/**
 * Get the current user session from Fabric's Better Auth
 *
 * This makes a request to Fabric's session endpoint, forwarding the
 * session cookie to validate the user.
 */
export async function getFabricSession(): Promise<FabricSession | null> {
	try {
		const cookieStore = await cookies();
		const headersList = await headers();

		// Get all cookies to forward to Fabric
		const cookieHeader = cookieStore
			.getAll()
			.map((c) => `${c.name}=${c.value}`)
			.join("; ");

		if (!cookieHeader) {
			return null;
		}

		// Call Fabric's session endpoint
		const response = await fetch(`${FABRIC_API_URL}/api/auth/get-session`, {
			method: "GET",
			headers: {
				Cookie: cookieHeader,
				"Content-Type": "application/json",
			},
			cache: "no-store",
		});

		if (!response.ok) {
			console.log(
				"[FabricAuth] Session validation failed:",
				response.status,
			);
			return null;
		}

		const data = await response.json();

		if (!data?.user?.id) {
			return null;
		}

		return {
			user: {
				id: data.user.id,
				email: data.user.email,
				name: data.user.name,
				image: data.user.image,
			},
			session: {
				id: data.session?.id || data.user.id,
				activeOrganizationId: data.session?.activeOrganizationId,
			},
		};
	} catch (error) {
		console.error("[FabricAuth] Error getting session:", error);
		return null;
	}
}

/**
 * Get the Fabric login URL with redirect back to data-analyst
 */
function getFabricLoginUrl(redirectTo?: string): string {
	const dataAnalystUrl =
		process.env.DATA_ANALYST_URL || "http://localhost:3002";
	const callbackUrl = redirectTo || dataAnalystUrl;
	return `${FABRIC_API_URL}/login?callbackUrl=${encodeURIComponent(callbackUrl)}`;
}

/**
 * Get the Fabric logout URL
 */
function getFabricLogoutUrl(): string {
	const dataAnalystUrl =
		process.env.DATA_ANALYST_URL || "http://localhost:3002";
	return `${FABRIC_API_URL}/api/auth/sign-out?callbackUrl=${encodeURIComponent(dataAnalystUrl)}`;
}

/**
 * Validate session from request headers (for API routes)
 */
export async function validateSessionFromRequest(
	request: Request,
): Promise<FabricSession | null> {
	try {
		const cookieHeader = request.headers.get("cookie");

		if (!cookieHeader) {
			return null;
		}

		const response = await fetch(`${FABRIC_API_URL}/api/auth/get-session`, {
			method: "GET",
			headers: {
				Cookie: cookieHeader,
				"Content-Type": "application/json",
			},
			cache: "no-store",
		});

		if (!response.ok) {
			return null;
		}

		const data = await response.json();

		if (!data?.user?.id) {
			return null;
		}

		return {
			user: {
				id: data.user.id,
				email: data.user.email,
				name: data.user.name,
				image: data.user.image,
			},
			session: {
				id: data.session?.id || data.user.id,
				activeOrganizationId: data.session?.activeOrganizationId,
			},
		};
	} catch (error) {
		console.error("[FabricAuth] Error validating request session:", error);
		return null;
	}
}
