/**
 * Auth Compatibility Layer
 *
 * This module provides backwards compatibility with the old NextAuth API
 * while using Fabric's Better Auth for actual authentication.
 */

import {
	validateSessionFromRequest,
	getFabricSession,
	type FabricSession,
} from "./fabric-auth";

export interface Session {
	user: {
		id: string;
		email?: string;
		name?: string;
		image?: string;
	};
}

/**
 * Get the current session (for Server Components and API routes)
 * This is a compatibility shim that maps Fabric session to the old format
 */
export async function auth(): Promise<Session | null> {
	const session = await getFabricSession();
	if (!session) return null;

	return {
		user: {
			id: session.user.id,
			email: session.user.email,
			name: session.user.name,
			image: session.user.image,
		},
	};
}

/**
 * Handler exports for API route compatibility
 * In Fabric auth, these are handled by the middleware, so we export no-ops
 */
const handlers = {
	GET: () =>
		new Response(JSON.stringify({ error: "Auth is handled by Fabric" }), {
			status: 200,
		}),
	POST: () =>
		new Response(JSON.stringify({ error: "Auth is handled by Fabric" }), {
			status: 200,
		}),
};

// No-op functions for compatibility
async function signIn() {
	// Handled by redirecting to Fabric login
	return;
}

async function signOut() {
	// Handled by redirecting to Fabric logout
	return;
}
