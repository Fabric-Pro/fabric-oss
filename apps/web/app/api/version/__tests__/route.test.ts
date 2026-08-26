import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../route";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("GET /api/version", () => {
	it("returns the baked build version and is never cached", async () => {
		vi.stubEnv("NEXT_PUBLIC_APP_VERSION", "sha-123");
		const response = GET();

		expect(response.headers.get("cache-control")).toContain("no-store");

		const body = await response.json();
		expect(body.version).toBe("sha-123");
	});
});
