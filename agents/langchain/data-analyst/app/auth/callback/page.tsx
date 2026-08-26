"use client";

import { useEffect } from "react";
import { Loader } from "@/components/ui/loader";

/**
 * Auth Callback Page
 *
 * This page handles callbacks from Fabric's login.
 * After Fabric authenticates the user, they are redirected here,
 * and we then redirect them to the main app.
 */
export default function CallbackPage() {
	useEffect(() => {
		// Fabric has already authenticated the user via cookies
		// Just redirect to home page
		window.location.href = "/";
	}, []);

	return (
		<div className="min-h-screen flex flex-col items-center justify-center gap-4">
			<Loader size="lg" />
			<p className="text-gray-500">Completing sign in...</p>
		</div>
	);
}
