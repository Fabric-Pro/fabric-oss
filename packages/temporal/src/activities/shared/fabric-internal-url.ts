import { isDeployedEnvironment } from "@repo/utils";

/**
 * Resolve the web app's base URL for worker→web bridge calls.
 *
 * Never falls back to localhost in a deployed environment: the Azure
 * worker container has `APP_URL` (deployment/azure/main.bicep), and an
 * unset chain there must surface as a loud activity failure instead of a
 * silent POST to `http://localhost:3000` inside the worker container.
 */
export function getFabricInternalBaseUrl(): string {
	const url =
		process.env.FABRIC_INTERNAL_URL ||
		process.env.RUNTIME_API_URL ||
		// Set on the Azure temporal worker container app.
		process.env.APP_URL ||
		process.env.NEXT_PUBLIC_APP_URL;
	if (url) {
		return url;
	}
	if (isDeployedEnvironment()) {
		throw new Error(
			"Fabric internal base URL is not configured for this environment — set APP_URL (or FABRIC_INTERNAL_URL) on the temporal worker.",
		);
	}
	return "http://localhost:3000";
}
