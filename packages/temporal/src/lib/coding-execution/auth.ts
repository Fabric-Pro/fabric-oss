import { createHmac } from "node:crypto";

/**
 * Generates an internal authentication token with HMAC signature
 * Format: timestamp.signature
 *
 * The token includes:
 * - timestamp: Milliseconds since epoch (prevents replay of old tokens)
 * - signature: HMAC-SHA256 of the timestamp string
 *
 * Tokens expire after 5 minutes.
 *
 * @param secret - The shared secret for HMAC signing
 * @returns Token string
 */
export function generateInternalToken(secret: string): string {
	const timestamp = Date.now().toString();
	const signature = createHmac("sha256", secret)
		.update(timestamp)
		.digest("hex");
	return `${timestamp}.${signature}`;
}

/**
 * Generates authentication headers for internal API requests
 * @param secret - The shared secret for HMAC signing
 * @returns Headers object with Authorization header
 */
export function getAuthHeaders(secret: string): Record<string, string> {
	return {
		Authorization: `Bearer ${generateInternalToken(secret)}`,
		"Content-Type": "application/json",
	};
}

/**
 * Verifies an internal token
 * This should be called by the receiving server to validate tokens
 *
 * @param token - The token to verify
 * @param secret - The shared secret for HMAC signing
 * @param maxAgeMs - Maximum age of token in milliseconds (default: 5 minutes)
 * @returns true if token is valid and not expired
 */
export function verifyInternalToken(
	token: string,
	secret: string,
	maxAgeMs = 5 * 60 * 1000,
): boolean {
	const parts = token.split(".");
	if (parts.length !== 2) {
		return false;
	}

	const [timestamp, signature] = parts;

	// Verify timestamp is numeric
	const timestampNum = Number.parseInt(timestamp, 10);
	if (Number.isNaN(timestampNum)) {
		return false;
	}

	// Check token age
	const age = Date.now() - timestampNum;
	if (age < 0 || age > maxAgeMs) {
		return false;
	}

	// Verify signature
	const expectedSignature = createHmac("sha256", secret)
		.update(timestamp)
		.digest("hex");

	// Constant-time comparison to prevent timing attacks
	if (signature.length !== expectedSignature.length) {
		return false;
	}

	let result = 0;
	for (let i = 0; i < signature.length; i++) {
		result |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
	}

	return result === 0;
}
