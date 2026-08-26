/**
 * Tenant Context Signing Utilities
 *
 * Provides HMAC-based signing and verification for tenant context
 * to ensure tamper-proof inter-service communication.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { TenantContext } from "../types";

/**
 * Signed tenant context payload
 */
export interface SignedTenantContext {
	/** Base64 encoded tenant context JSON */
	payload: string;
	/** HMAC-SHA256 signature */
	signature: string;
	/** Timestamp when signed (Unix ms) */
	timestamp: number;
}

/**
 * Options for signing tenant context
 */
export interface SigningOptions {
	/** Maximum age of signed context in milliseconds (default: 5 minutes) */
	maxAge?: number;
}

const DEFAULT_MAX_AGE = 5 * 60 * 1000; // 5 minutes
const ALGORITHM = "sha256";

/**
 * Get the service secret from environment
 * @throws Error if AGENT_SERVICE_SECRET is not set
 */
export function getServiceSecret(): string {
	const secret = process.env.AGENT_SERVICE_SECRET;
	if (!secret) {
		throw new Error(
			"AGENT_SERVICE_SECRET environment variable is not set. " +
				"This is required for secure inter-agent communication.",
		);
	}
	if (secret.length < 32) {
		throw new Error(
			"AGENT_SERVICE_SECRET must be at least 32 characters long for security.",
		);
	}
	return secret;
}

/**
 * Sign tenant context for secure transmission
 *
 * @param context - The tenant context to sign
 * @param secret - The shared secret (defaults to AGENT_SERVICE_SECRET env var)
 * @returns Signed tenant context with payload, signature, and timestamp
 */
export function signTenantContext(
	context: TenantContext,
	secret?: string,
): SignedTenantContext {
	const signingSecret = secret || getServiceSecret();
	const timestamp = Date.now();

	// Create payload with context and timestamp
	const payloadData = {
		...context,
		_ts: timestamp,
	};

	const payload = Buffer.from(JSON.stringify(payloadData)).toString("base64");

	// Create HMAC signature
	const hmac = createHmac(ALGORITHM, signingSecret);
	hmac.update(payload);
	const signature = hmac.digest("hex");

	return {
		payload,
		signature,
		timestamp,
	};
}

/**
 * Verify and extract tenant context from signed payload
 *
 * @param signed - The signed tenant context
 * @param secret - The shared secret (defaults to AGENT_SERVICE_SECRET env var)
 * @param options - Verification options
 * @returns The verified tenant context
 * @throws Error if signature is invalid or context is expired
 */
export function verifyTenantContext(
	signed: SignedTenantContext,
	secret?: string,
	options: SigningOptions = {},
): TenantContext {
	const signingSecret = secret || getServiceSecret();
	const maxAge = options.maxAge ?? DEFAULT_MAX_AGE;

	// Verify signature using timing-safe comparison
	const hmac = createHmac(ALGORITHM, signingSecret);
	hmac.update(signed.payload);
	const expectedSignature = hmac.digest("hex");

	const signatureBuffer = Buffer.from(signed.signature, "hex");
	const expectedBuffer = Buffer.from(expectedSignature, "hex");

	if (signatureBuffer.length !== expectedBuffer.length) {
		throw new SignatureVerificationError("Invalid signature length");
	}

	if (!timingSafeEqual(signatureBuffer, expectedBuffer)) {
		throw new SignatureVerificationError("Invalid signature");
	}

	// Decode and parse payload
	const payloadJson = Buffer.from(signed.payload, "base64").toString("utf-8");
	const payloadData = JSON.parse(payloadJson) as TenantContext & {
		_ts: number;
	};

	// Verify timestamp
	const age = Date.now() - payloadData._ts;
	if (age > maxAge) {
		throw new SignatureVerificationError(
			`Tenant context expired (age: ${age}ms, maxAge: ${maxAge}ms)`,
		);
	}

	if (age < -60000) {
		// Allow 1 minute clock skew
		throw new SignatureVerificationError(
			"Tenant context timestamp is in the future",
		);
	}

	// Remove internal timestamp and return context
	const { _ts, ...context } = payloadData;
	return context as TenantContext;
}

/**
 * Error thrown when signature verification fails
 */
export class SignatureVerificationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SignatureVerificationError";
	}
}
