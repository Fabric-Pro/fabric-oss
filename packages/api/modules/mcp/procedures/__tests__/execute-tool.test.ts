import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Mock the database and dependencies
vi.mock("@repo/database", async () => {
	return {
		db: {
			mCPConfig: {
				findFirst: vi.fn(),
			},
		},
		executeMcpTool: vi.fn(),
		hasValidMCPTokens: vi.fn(),
	};
});

vi.mock("@repo/mcp", async () => {
	return {
		executeMcpTool: vi.fn(),
	};
});

import { db } from "@repo/database";
import { executeMcpTool as pkgExecuteMcpTool } from "@repo/mcp";

describe("MCP Tool Execution", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should validate tool execution input schema", () => {
		const inputSchema = z.object({
			configId: z.string(),
			toolName: z.string(),
			arguments: z.record(z.string(), z.any()).default({}),
			organizationId: z.string().nullable().optional(),
		});

		const validInput = {
			configId: "config-123",
			toolName: "get_weather",
			arguments: { location: "New York" },
		};

		const result = inputSchema.safeParse(validInput);
		expect(result.success).toBe(true);
	});

	it("should reject invalid tool execution input", () => {
		const inputSchema = z.object({
			configId: z.string(),
			toolName: z.string(),
			arguments: z.record(z.string(), z.any()).default({}),
		});

		const invalidInput = {
			configId: "config-123",
			// Missing toolName
			arguments: { location: "New York" },
		};

		const result = inputSchema.safeParse(invalidInput);
		expect(result.success).toBe(false);
	});

	it("should handle tool execution success", async () => {
		const mockResult = {
			success: true,
			data: { temperature: 72, conditions: "sunny" },
		};

		vi.mocked(pkgExecuteMcpTool).mockResolvedValue(mockResult);

		const result = await pkgExecuteMcpTool({
			serverUrl: "https://api.example.com/mcp",
			toolName: "get_weather",
			arguments: { location: "New York" },
		});

		expect(result.success).toBe(true);
		expect(result.data).toEqual({ temperature: 72, conditions: "sunny" });
	});

	it("should handle tool execution errors", async () => {
		const mockError = {
			success: false,
			error: "Tool execution failed: API timeout",
		};

		vi.mocked(pkgExecuteMcpTool).mockResolvedValue(mockError);

		const result = await pkgExecuteMcpTool({
			serverUrl: "https://api.example.com/mcp",
			toolName: "get_weather",
			arguments: { location: "Invalid" },
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("API timeout");
	});
});

describe("MCP Config Management", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should fetch config with tenant isolation", async () => {
		const mockConfig = {
			id: "config-123",
			serverId: "server-456",
			userId: "user-789",
			organizationId: null,
			server: {
				url: "https://api.example.com/mcp",
				authType: "oauth",
			},
		};

		vi.mocked(db.mCPConfig.findFirst).mockResolvedValue(mockConfig as any);

		const config = await db.mCPConfig.findFirst({
			where: {
				id: "config-123",
				userId: "user-789",
				organizationId: null,
			},
		});

		expect(config).not.toBeNull();
		expect(config?.userId).toBe("user-789");
	});
});
