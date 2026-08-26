/**
 * Secure OAuth State Management
 *
 * Uses HMAC-SHA256 to sign OAuth state, preventing tampering.
 * Includes timestamp to prevent replay attacks.
 */

import crypto from "node:crypto";

interface OAuthStatePayload {
	userId: string;
	organizationId?: string;
	provider: string;
	nonce: string;
	timestamp: number;
	returnUrl?: string;
	redirectUri?: string;
	/** When "project", the OAuth callback stores credentials in ProjectRepositoryIntegration */
	targetType?: "user" | "project";
	/** Required when targetType is "project" */
	projectId?: string;
	/** Repository URL for project-level integrations */
	repositoryUrl?: string;
	repositoryOwner?: string;
	repositoryName?: string;
	defaultBranch?: string;
	roleTag?: string;
	/**
	 * PKCE code_verifier (S256). Set by providers that initiate PKCE
	 * (currently GitLab) so the callback can send it on the token exchange.
	 * Optional: providers without PKCE simply omit it, and old in-flight
	 * states from before PKCE rollout will not have it either.
	 */
	codeVerifier?: string;
}

const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Get secret key for HMAC signing
 */
function getSecretKey(): string {
	const key =
		process.env.ENCRYPTION_KEY ||
		process.env.AUTH_SECRET ||
		process.env.BETTER_AUTH_SECRET;
	if (!key) {
		throw new Error(
			"ENCRYPTION_KEY, AUTH_SECRET, or BETTER_AUTH_SECRET environment variable is required for OAuth state signing",
		);
	}
	return key;
}

/**
 * Create HMAC-SHA256 signature
 */
function createHmacSignature(data: string, secretKey: string): string {
	return crypto
		.createHmac("sha256", secretKey)
		.update(data)
		.digest("base64url");
}

/**
 * Generate a random nonce
 */
function generateNonce(): string {
	return crypto.randomBytes(16).toString("hex");
}

/**
 * Encode OAuth state with signature
 */
export function encodeOAuthState(payload: {
	userId: string;
	organizationId?: string;
	provider: string;
	returnUrl?: string;
	redirectUri?: string;
	targetType?: "user" | "project";
	projectId?: string;
	repositoryUrl?: string;
	repositoryOwner?: string;
	repositoryName?: string;
	defaultBranch?: string;
	roleTag?: string;
	/** PKCE code_verifier (S256). See OAuthStatePayload for details. */
	codeVerifier?: string;
}): string {
	const secretKey = getSecretKey();

	const statePayload: OAuthStatePayload = {
		...payload,
		nonce: generateNonce(),
		timestamp: Date.now(),
	};

	const payloadJson = JSON.stringify(statePayload);
	const payloadBase64 = Buffer.from(payloadJson).toString("base64url");

	// Create HMAC signature
	const signature = createHmacSignature(payloadBase64, secretKey);

	// Combine payload and signature
	return `${payloadBase64}.${signature}`;
}

/**
 * Decode and verify OAuth state
 * Returns null if signature is invalid or state has expired
 */
export function decodeOAuthState(
	encodedState: string,
): OAuthStatePayload | null {
	const secretKey = getSecretKey();

	const parts = encodedState.split(".");
	if (parts.length !== 2) {
		return null;
	}

	const [payloadBase64, signature] = parts;

	// Verify signature (timing-safe comparison). Guarded because
	// timingSafeEqual throws RangeError when the two buffers differ in length —
	// i.e. any attacker-supplied signature that isn't a valid HMAC — and that
	// must read as "invalid", not surface as a 500 on the public callback.
	let expectedSignature: Buffer;
	let suppliedSignature: Buffer;
	try {
		expectedSignature = Buffer.from(
			createHmacSignature(payloadBase64, secretKey),
		);
		suppliedSignature = Buffer.from(signature);
	} catch {
		return null;
	}
	if (
		suppliedSignature.length !== expectedSignature.length ||
		!crypto.timingSafeEqual(suppliedSignature, expectedSignature)
	) {
		return null;
	}

	// Decode payload
	try {
		const payloadJson = Buffer.from(payloadBase64, "base64url").toString(
			"utf8",
		);
		const payload = JSON.parse(payloadJson) as OAuthStatePayload;

		// Check timestamp (prevent replay attacks)
		const age = Date.now() - payload.timestamp;
		if (age > STATE_MAX_AGE_MS || age < 0) {
			return null;
		}

		return payload;
	} catch {
		return null;
	}
}
