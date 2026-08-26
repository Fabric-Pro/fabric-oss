import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Middleware for Fabric Auth Integration
 *
 * This middleware validates the user's session against Fabric's Better Auth.
 * If the user is not authenticated, they are redirected to Fabric's login page.
 */

const FABRIC_API_URL = process.env.FABRIC_API_URL || "http://localhost:3001";

// Paths that don't require authentication
const PUBLIC_PATHS = [
	"/login",
	"/api/auth",
	"/_next",
	"/favicon.ico",
	"/health",
];

export async function middleware(request: NextRequest) {
	const { pathname } = request.nextUrl;

	// Allow public paths
	if (PUBLIC_PATHS.some((path) => pathname.startsWith(path))) {
		return NextResponse.next();
	}

	// Get session cookie
	const cookieHeader = request.headers.get("cookie");

	if (!cookieHeader) {
		// No cookies, redirect to login
		return redirectToLogin(request);
	}

	try {
		// Validate session with Fabric
		const response = await fetch(`${FABRIC_API_URL}/api/auth/get-session`, {
			method: "GET",
			headers: {
				Cookie: cookieHeader,
				"Content-Type": "application/json",
			},
			cache: "no-store",
		});

		if (!response.ok) {
			return redirectToLogin(request);
		}

		const data = await response.json();

		if (!data?.user?.id) {
			return redirectToLogin(request);
		}

		// User is authenticated, add user info to headers for downstream use
		const requestHeaders = new Headers(request.headers);
		requestHeaders.set("x-user-id", data.user.id);
		if (data.session?.activeOrganizationId) {
			requestHeaders.set(
				"x-organization-id",
				data.session.activeOrganizationId,
			);
		}

		return NextResponse.next({
			request: {
				headers: requestHeaders,
			},
		});
	} catch (error) {
		console.error("[Middleware] Auth validation error:", error);
		return redirectToLogin(request);
	}
}

function redirectToLogin(request: NextRequest): NextResponse {
	const loginUrl = new URL("/login", request.url);
	return NextResponse.redirect(loginUrl);
}

export const config = {
	matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
