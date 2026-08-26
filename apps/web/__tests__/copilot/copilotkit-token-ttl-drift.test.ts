/**
 * Guards the fix for the staging "Update Full Spec" incident: a run's
 * Databricks model call outlived the AI token's TTL, so every internal
 * Fabric API call the run made afterward 401'd.
 *
 * `route.ts`'s `export const maxDuration` must stay a static numeric literal
 * (Next.js route segment config is statically analyzed and can't import a
 * value), so it can't just import `COPILOTKIT_MAX_DURATION_SECONDS` from
 * `config.ts` — this test reads the live source and keeps the two in sync by
 * regex instead, mirroring the get-started registry's drift-test pattern.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	AI_TOKEN_TTL_SECONDS,
	COPILOTKIT_MAX_DURATION_SECONDS,
} from "../../app/api/copilotkit/config";

const ROUTE_PATH = join(process.cwd(), "app/api/copilotkit/route.ts");

function readRouteSource(): string {
	return readFileSync(ROUTE_PATH, "utf-8");
}

describe("copilotkit AI token TTL vs. route maxDuration", () => {
	it("issues a token that outlives the route's maxDuration", () => {
		expect(AI_TOKEN_TTL_SECONDS).toBeGreaterThan(
			COPILOTKIT_MAX_DURATION_SECONDS,
		);
	});

	it("route.ts's static maxDuration literal matches COPILOTKIT_MAX_DURATION_SECONDS", () => {
		const source = readRouteSource();
		const match = source.match(/maxDuration\s*=\s*(\d+)/);

		expect(match).not.toBeNull();
		expect(Number(match?.[1])).toBe(COPILOTKIT_MAX_DURATION_SECONDS);
	});
});
