import { describe, expect, it, vi } from "vitest";

// getTenantDb() must build on the module-imported base client. A lazy
// require() bypassed this mock, and under the Next.js bundler it returned a
// pending async module, so db was undefined.
const mocks = vi.hoisted(() => {
	const tenantClient = { client: "tenant" };
	return { tenantClient, $extends: vi.fn(() => tenantClient) };
});

vi.mock("../prisma/client", () => ({
	db: { $extends: mocks.$extends },
}));

import { getTenantDb } from "../src/tenant-db";

describe("getTenantDb", () => {
	it("extends the imported base client once and reuses the result", () => {
		expect(getTenantDb()).toBe(mocks.tenantClient);
		expect(getTenantDb()).toBe(mocks.tenantClient);
		expect(mocks.$extends).toHaveBeenCalledTimes(1);
	});
});
