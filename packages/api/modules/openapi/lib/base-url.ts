import { ORPCError } from "@orpc/server";
import { getUnsafeUrlReason } from "@repo/utils/url-security";

export function validateOpenAPIBaseUrl(
	baseUrl: string | null | undefined,
	source: "spec" | "saved" = "saved",
): void {
	if (baseUrl && getUnsafeUrlReason(baseUrl)) {
		throw new ORPCError("BAD_REQUEST", {
			message:
				source === "spec"
					? "OpenAPI spec server URL is not a permitted public address. Supply a public base URL."
					: "OpenAPI base URL must be a permitted public address",
		});
	}
}
