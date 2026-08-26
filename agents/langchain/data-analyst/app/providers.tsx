"use client";

/**
 * App Providers
 *
 * With Fabric auth, session is handled via cookies and middleware.
 * No SessionProvider is needed since we validate against Fabric's API.
 */
export function Providers({ children }: { children: React.ReactNode }) {
	return <>{children}</>;
}
