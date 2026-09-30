import { createHash, timingSafeEqual } from "node:crypto";

export function isAgentServiceRequestAuthorized(
	provided: string | null,
): boolean {
	const expected = process.env.AGENT_SERVICE_SECRET;
	return Boolean(
		provided &&
			expected &&
			timingSafeEqual(
				createHash("sha256").update(provided).digest(),
				createHash("sha256").update(expected).digest(),
			),
	);
}
