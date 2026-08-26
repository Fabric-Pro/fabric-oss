"use client";

import { useEffect } from "react";

export default function LoginPage() {
	// Redirect to Fabric login
	useEffect(() => {
		const fabricApiUrl =
			process.env.NEXT_PUBLIC_FABRIC_API_URL || "http://localhost:3001";
		const currentUrl = window.location.origin;
		const loginUrl = `${fabricApiUrl}/login?callbackUrl=${encodeURIComponent(currentUrl)}`;
		window.location.href = loginUrl;
	}, []);

	return (
		<div className="min-h-screen flex flex-col items-center justify-center p-4 bg-black font-sans">
			<div className="w-full max-w-md bg-white p-8 rounded-2xl shadow-lg border border-ui-border text-center">
				<h1 className="text-3xl font-serif font-bold mb-6 text-tx-primary">
					Data Analyst Agent
				</h1>
				<p className="text-tx-secondary mb-8">
					Redirecting to Fabric login...
				</p>

				<div className="flex items-center justify-center">
					<div className="animate-spin rounded-full h-8 w-8 border-b-2 border-black"></div>
				</div>

				<p className="text-xs text-tx-secondary mt-8">
					If you are not redirected,{" "}
					<a
						href={`${process.env.NEXT_PUBLIC_FABRIC_API_URL || "http://localhost:3001"}/login`}
						className="text-blue-600 hover:underline"
					>
						click here to login
					</a>
				</p>
			</div>
		</div>
	);
}
