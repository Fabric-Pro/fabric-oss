#!/usr/bin/env node
/**
 * Encrypt AI Gateway API key
 * Usage: BETTER_AUTH_SECRET="your-secret" AI_GATEWAY_API_KEY="your-key" node scripts/encrypt-key.js
 */

const { createCipheriv, randomBytes, scryptSync } = require("node:crypto");

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;

function getEncryptionKey() {
	const secret = process.env.BETTER_AUTH_SECRET;

	if (!secret) {
		throw new Error("BETTER_AUTH_SECRET environment variable is required");
	}

	const salt = "ai-gateway-encryption-salt-v1";
	return scryptSync(secret, salt, KEY_LENGTH);
}

function encryptApiKey(apiKey) {
	if (!apiKey) {
		throw new Error("API key cannot be empty");
	}

	const key = getEncryptionKey();
	const iv = randomBytes(IV_LENGTH);

	const cipher = createCipheriv(ALGORITHM, key, iv);

	let encrypted = cipher.update(apiKey, "utf8", "hex");
	encrypted += cipher.final("hex");

	const authTag = cipher.getAuthTag();

	return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

const AI_GATEWAY_API_KEY = process.env.AI_GATEWAY_API_KEY;

if (!AI_GATEWAY_API_KEY) {
	console.error("❌ AI_GATEWAY_API_KEY not found in environment variables");
	process.exit(1);
}

try {
	const encryptedKey = encryptApiKey(AI_GATEWAY_API_KEY);
	console.log("✅ Encrypted key:");
	console.log(encryptedKey);
} catch (error) {
	console.error("❌ Error:", error.message);
	process.exit(1);
}
