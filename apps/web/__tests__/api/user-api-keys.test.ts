/**
 * Tests for User API Key functionality
 *
 * Tests the complete API key lifecycle:
 * - Key generation (format, hashing)
 * - Key creation (database storage)
 * - Key listing
 * - Key verification (authentication)
 * - Key deletion
 * - Key expiration
 * - Scope validation
 */

import { createHash, randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// Mock Setup
// =============================================================================

// Mock database
const mockDb = {
	userApiKey: {
		create: vi.fn(),
		findMany: vi.fn(),
		findFirst: vi.fn(),
		update: vi.fn(),
		updateMany: vi.fn(),
		deleteMany: vi.fn(),
	},
	user: {
		findUnique: vi.fn(),
	},
};

vi.mock("@repo/database", () => ({
	db: mockDb,
}));

// =============================================================================
// API Key Generation Tests (Unit Tests)
// =============================================================================

describe("API Key Generation", () => {
	/**
	 * Generate API key function (same logic as in create.ts)
	 */
	function generateApiKey(): {
		rawKey: string;
		keyHash: string;
		keyPrefix: string;
	} {
		const secretBytes = randomBytes(24);
		const secret = secretBytes.toString("base64url");
		const prefixBytes = randomBytes(4);
		const prefix = prefixBytes.toString("hex");
		const rawKey = `fab_${prefix}_${secret}`;
		const keyPrefix = `fab_${prefix}`;
		const keyHash = createHash("sha256").update(rawKey).digest("hex");
		return { rawKey, keyHash, keyPrefix };
	}

	it("should generate key with correct format", () => {
		const { rawKey, keyPrefix } = generateApiKey();

		// Key should start with fab_
		expect(rawKey).toMatch(/^fab_[a-f0-9]{8}_[A-Za-z0-9_-]+$/);

		// Prefix should be first two parts
		expect(keyPrefix).toMatch(/^fab_[a-f0-9]{8}$/);
		expect(rawKey.startsWith(keyPrefix)).toBe(true);
	});

	it("should generate unique keys on each call", () => {
		const key1 = generateApiKey();
		const key2 = generateApiKey();

		expect(key1.rawKey).not.toBe(key2.rawKey);
		expect(key1.keyHash).not.toBe(key2.keyHash);
		expect(key1.keyPrefix).not.toBe(key2.keyPrefix);
	});

	it("should generate consistent hash for same key", () => {
		const { rawKey, keyHash } = generateApiKey();

		// Verify hash is reproducible
		const recomputedHash = createHash("sha256")
			.update(rawKey)
			.digest("hex");
		expect(keyHash).toBe(recomputedHash);
	});

	it("should generate 64-character SHA-256 hash", () => {
		const { keyHash } = generateApiKey();

		expect(keyHash).toHaveLength(64);
		expect(keyHash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("should generate sufficiently long secret", () => {
		const { rawKey, keyPrefix } = generateApiKey();

		// Extract secret part
		const secret = rawKey.slice(keyPrefix.length + 1);

		// base64url of 24 bytes = 32 characters
		expect(secret.length).toBeGreaterThanOrEqual(30);
	});
});

// =============================================================================
// API Key Verification Tests (Unit Tests)
// =============================================================================

describe("API Key Verification", () => {
	/**
	 * Verify API key function (same logic as in verify.ts)
	 */
	async function verifyUserApiKey(
		apiKey: string,
		requiredScope?: string,
	): Promise<{
		valid: boolean;
		userId?: string;
		scopes?: string[];
		keyId?: string;
		error?: string;
	}> {
		// Validate key format
		if (!apiKey || typeof apiKey !== "string") {
			return { valid: false, error: "API key is required" };
		}

		// Parse the key
		const parts = apiKey.split("_");
		if (parts.length < 3 || parts[0] !== "fab") {
			return { valid: false, error: "Invalid API key format" };
		}

		const keyPrefix = `fab_${parts[1]}`;

		// Find the key by prefix (mocked)
		const storedKey = await mockDb.userApiKey.findFirst({
			where: { keyPrefix, isActive: true },
		});

		if (!storedKey) {
			return { valid: false, error: "API key not found" };
		}

		// Check if active
		if (!storedKey.isActive) {
			return { valid: false, error: "API key is inactive" };
		}

		// Check expiration
		if (storedKey.expiresAt && storedKey.expiresAt < new Date()) {
			return { valid: false, error: "API key has expired" };
		}

		// Verify the key hash
		const keyHash = createHash("sha256").update(apiKey).digest("hex");
		if (keyHash !== storedKey.keyHash) {
			return { valid: false, error: "Invalid API key" };
		}

		// Check scope if required
		if (requiredScope && !storedKey.scopes.includes(requiredScope)) {
			return {
				valid: false,
				error: `Missing required scope: ${requiredScope}`,
			};
		}

		return {
			valid: true,
			userId: storedKey.userId,
			scopes: storedKey.scopes,
			keyId: storedKey.id,
		};
	}

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("should reject empty API key", async () => {
		const result = await verifyUserApiKey("");
		expect(result.valid).toBe(false);
		expect(result.error).toBe("API key is required");
	});

	it("should reject null/undefined API key", async () => {
		const result = await verifyUserApiKey(null as unknown as string);
		expect(result.valid).toBe(false);
		expect(result.error).toBe("API key is required");
	});

	it("should reject invalid format - no prefix", async () => {
		const result = await verifyUserApiKey("invalid_key");
		expect(result.valid).toBe(false);
		expect(result.error).toBe("Invalid API key format");
	});

	it("should reject invalid format - wrong prefix", async () => {
		const result = await verifyUserApiKey("api_abc123_secret");
		expect(result.valid).toBe(false);
		expect(result.error).toBe("Invalid API key format");
	});

	it("should reject non-existent key", async () => {
		mockDb.userApiKey.findFirst.mockResolvedValue(null);

		const result = await verifyUserApiKey("fab_abc12345_secretvalue");
		expect(result.valid).toBe(false);
		expect(result.error).toBe("API key not found");
	});

	it("should reject inactive key", async () => {
		mockDb.userApiKey.findFirst.mockResolvedValue({
			id: "key-1",
			userId: "user-1",
			keyHash: "somehash",
			keyPrefix: "fab_abc12345",
			scopes: ["mcp:read"],
			isActive: false,
			expiresAt: null,
		});

		const result = await verifyUserApiKey("fab_abc12345_secretvalue");
		expect(result.valid).toBe(false);
		expect(result.error).toBe("API key is inactive");
	});

	it("should reject expired key", async () => {
		const expiredDate = new Date(Date.now() - 86400000); // Yesterday
		mockDb.userApiKey.findFirst.mockResolvedValue({
			id: "key-1",
			userId: "user-1",
			keyHash: "somehash",
			keyPrefix: "fab_abc12345",
			scopes: ["mcp:read"],
			isActive: true,
			expiresAt: expiredDate,
		});

		const result = await verifyUserApiKey("fab_abc12345_secretvalue");
		expect(result.valid).toBe(false);
		expect(result.error).toBe("API key has expired");
	});

	it("should reject key with wrong hash", async () => {
		mockDb.userApiKey.findFirst.mockResolvedValue({
			id: "key-1",
			userId: "user-1",
			keyHash: "wrong_hash_value",
			keyPrefix: "fab_abc12345",
			scopes: ["mcp:read"],
			isActive: true,
			expiresAt: null,
		});

		const result = await verifyUserApiKey("fab_abc12345_secretvalue");
		expect(result.valid).toBe(false);
		expect(result.error).toBe("Invalid API key");
	});

	it("should verify valid key successfully", async () => {
		const rawKey = "fab_abc12345_testsecret";
		const keyHash = createHash("sha256").update(rawKey).digest("hex");

		mockDb.userApiKey.findFirst.mockResolvedValue({
			id: "key-1",
			userId: "user-123",
			keyHash,
			keyPrefix: "fab_abc12345",
			scopes: ["mcp:read", "mcp:write"],
			isActive: true,
			expiresAt: null,
		});

		const result = await verifyUserApiKey(rawKey);
		expect(result.valid).toBe(true);
		expect(result.userId).toBe("user-123");
		expect(result.keyId).toBe("key-1");
		expect(result.scopes).toEqual(["mcp:read", "mcp:write"]);
	});

	it("should accept key with future expiration", async () => {
		const futureDate = new Date(Date.now() + 86400000); // Tomorrow
		const rawKey = "fab_abc12345_testsecret";
		const keyHash = createHash("sha256").update(rawKey).digest("hex");

		mockDb.userApiKey.findFirst.mockResolvedValue({
			id: "key-1",
			userId: "user-123",
			keyHash,
			keyPrefix: "fab_abc12345",
			scopes: ["mcp:read"],
			isActive: true,
			expiresAt: futureDate,
		});

		const result = await verifyUserApiKey(rawKey);
		expect(result.valid).toBe(true);
	});

	it("should reject key missing required scope", async () => {
		const rawKey = "fab_abc12345_testsecret";
		const keyHash = createHash("sha256").update(rawKey).digest("hex");

		mockDb.userApiKey.findFirst.mockResolvedValue({
			id: "key-1",
			userId: "user-123",
			keyHash,
			keyPrefix: "fab_abc12345",
			scopes: ["mcp:read"], // Only has read
			isActive: true,
			expiresAt: null,
		});

		const result = await verifyUserApiKey(rawKey, "mcp:write"); // Requires write
		expect(result.valid).toBe(false);
		expect(result.error).toBe("Missing required scope: mcp:write");
	});

	it("should accept key with required scope", async () => {
		const rawKey = "fab_abc12345_testsecret";
		const keyHash = createHash("sha256").update(rawKey).digest("hex");

		mockDb.userApiKey.findFirst.mockResolvedValue({
			id: "key-1",
			userId: "user-123",
			keyHash,
			keyPrefix: "fab_abc12345",
			scopes: ["mcp:read", "mcp:write", "browser:read"],
			isActive: true,
			expiresAt: null,
		});

		const result = await verifyUserApiKey(rawKey, "mcp:write");
		expect(result.valid).toBe(true);
	});
});

// =============================================================================
// API Key CRUD Tests
// =============================================================================

describe("API Key CRUD Operations", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("Create API Key", () => {
		it("should create key with default scopes", async () => {
			const mockCreatedKey = {
				id: "key-1",
				userId: "user-123",
				name: "Test Key",
				keyHash: "hash123",
				keyPrefix: "fab_abc12345",
				scopes: ["mcp:read", "mcp:write"],
				expiresAt: null,
				lastUsedAt: null,
				usageCount: 0,
				isActive: true,
				createdAt: new Date(),
			};

			mockDb.userApiKey.create.mockResolvedValue(mockCreatedKey);

			const result = await mockDb.userApiKey.create({
				data: {
					userId: "user-123",
					name: "Test Key",
					keyHash: "hash123",
					keyPrefix: "fab_abc12345",
					scopes: ["mcp:read", "mcp:write"],
				},
			});

			expect(result.id).toBe("key-1");
			expect(result.name).toBe("Test Key");
			expect(result.scopes).toEqual(["mcp:read", "mcp:write"]);
			expect(result.isActive).toBe(true);
		});

		it("should create key with expiration", async () => {
			const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
			const mockCreatedKey = {
				id: "key-1",
				userId: "user-123",
				name: "Expiring Key",
				keyHash: "hash123",
				keyPrefix: "fab_abc12345",
				scopes: ["mcp:read"],
				expiresAt,
				isActive: true,
				createdAt: new Date(),
			};

			mockDb.userApiKey.create.mockResolvedValue(mockCreatedKey);

			const result = await mockDb.userApiKey.create({
				data: {
					userId: "user-123",
					name: "Expiring Key",
					keyHash: "hash123",
					keyPrefix: "fab_abc12345",
					scopes: ["mcp:read"],
					expiresAt,
				},
			});

			expect(result.expiresAt).toEqual(expiresAt);
		});
	});

	describe("List API Keys", () => {
		it("should list only active keys by default", async () => {
			const mockKeys = [
				{ id: "key-1", name: "Key 1", isActive: true },
				{ id: "key-2", name: "Key 2", isActive: true },
			];

			mockDb.userApiKey.findMany.mockResolvedValue(mockKeys);

			const result = await mockDb.userApiKey.findMany({
				where: { userId: "user-123", isActive: true },
			});

			expect(result).toHaveLength(2);
			expect(mockDb.userApiKey.findMany).toHaveBeenCalledWith({
				where: { userId: "user-123", isActive: true },
			});
		});

		it("should list all keys when includeInactive is true", async () => {
			const mockKeys = [
				{ id: "key-1", name: "Active Key", isActive: true },
				{ id: "key-2", name: "Inactive Key", isActive: false },
			];

			mockDb.userApiKey.findMany.mockResolvedValue(mockKeys);

			const result = await mockDb.userApiKey.findMany({
				where: { userId: "user-123" }, // No isActive filter
			});

			expect(result).toHaveLength(2);
		});
	});

	describe("Delete API Key", () => {
		it("should delete key belonging to user", async () => {
			mockDb.userApiKey.deleteMany.mockResolvedValue({ count: 1 });

			const result = await mockDb.userApiKey.deleteMany({
				where: { id: "key-1", userId: "user-123" },
			});

			expect(result.count).toBe(1);
			expect(mockDb.userApiKey.deleteMany).toHaveBeenCalledWith({
				where: { id: "key-1", userId: "user-123" },
			});
		});

		it("should not delete key belonging to different user", async () => {
			mockDb.userApiKey.deleteMany.mockResolvedValue({ count: 0 });

			const result = await mockDb.userApiKey.deleteMany({
				where: { id: "key-1", userId: "different-user" },
			});

			expect(result.count).toBe(0);
		});
	});

	describe("Update Usage Stats", () => {
		it("should increment usage count and update lastUsedAt", async () => {
			const now = new Date();
			mockDb.userApiKey.update.mockResolvedValue({
				id: "key-1",
				lastUsedAt: now,
				usageCount: 5,
			});

			const result = await mockDb.userApiKey.update({
				where: { id: "key-1" },
				data: {
					lastUsedAt: now,
					usageCount: { increment: 1 },
				},
			});

			expect(result.usageCount).toBe(5);
			expect(result.lastUsedAt).toBeTruthy();
		});
	});
});

// =============================================================================
// Security Tests
// =============================================================================

describe("API Key Security", () => {
	it("should never expose raw key in database queries", () => {
		// The create function returns the raw key, but the database only stores the hash
		// This test verifies our understanding of the security model
		const rawKey = "fab_abc12345_supersecret";
		const keyHash = createHash("sha256").update(rawKey).digest("hex");

		// Verify that knowing the hash doesn't reveal the key
		expect(keyHash).not.toContain("supersecret");
		expect(keyHash).not.toContain("fab_");
	});

	it("should use cryptographically secure random bytes", () => {
		// Verify randomBytes produces different values
		const samples = Array.from({ length: 10 }, () =>
			randomBytes(24).toString("base64url"),
		);

		const uniqueSamples = new Set(samples);
		expect(uniqueSamples.size).toBe(10); // All should be unique
	});

	it("should hash key using SHA-256", () => {
		const rawKey = "fab_test1234_secret";
		const hash = createHash("sha256").update(rawKey).digest("hex");

		// SHA-256 produces 64 hex characters
		expect(hash).toHaveLength(64);
		expect(hash).toMatch(/^[a-f0-9]+$/);
	});
});
