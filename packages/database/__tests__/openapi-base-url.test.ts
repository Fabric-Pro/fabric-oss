import { beforeEach, describe, expect, it, vi } from "vitest";

const mockService = vi.hoisted(() => ({
	create: vi.fn(),
	findFirst: vi.fn(),
	update: vi.fn(),
	configUpdate: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		openAPIService: mockService,
		openAPIServiceConfig: { update: mockService.configUpdate },
	},
}));

import {
	createOpenAPIService,
	updateOpenAPIService,
	updateOpenAPIServiceConfig,
} from "../prisma/queries/openapi";

beforeEach(() => vi.clearAllMocks());

describe("OpenAPI service base URL writes", () => {
	it.each(["http://127.0.0.1", "http://10.0.0.1", "file:///etc/passwd"])(
		"refuses an unsafe base URL on create: %s",
		async (baseUrl) => {
			await expect(
				createOpenAPIService({
					name: "Example API",
					specUrl: "https://example.com/openapi.json",
					specHash: "example-hash",
					baseUrl,
					createdById: "example-user",
					userId: "example-user",
				}),
			).rejects.toThrow("permitted public address");
			expect(mockService.create).not.toHaveBeenCalled();
		},
	);

	it("refuses an unsafe base URL on update before reading the row", async () => {
		await expect(
			updateOpenAPIService({
				id: "example-service",
				userId: "example-user",
				data: { baseUrl: "http://localhost" },
			}),
		).rejects.toThrow("permitted public address");
		expect(mockService.findFirst).not.toHaveBeenCalled();
		expect(mockService.update).not.toHaveBeenCalled();
	});

	it("refuses an unsafe config override before writing", async () => {
		await expect(
			updateOpenAPIServiceConfig({
				id: "example-config",
				data: { baseUrlOverride: "http://127.0.0.1" },
			}),
		).rejects.toThrow("permitted public address");
		expect(mockService.configUpdate).not.toHaveBeenCalled();
	});
});
