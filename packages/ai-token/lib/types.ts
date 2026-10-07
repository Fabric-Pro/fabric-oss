/**
 * AI Token Types
 *
 * Type definitions for the AI Token exchange system.
 * Tokens are short-lived JWTs that identify a user/org for AI API key retrieval.
 */

/**
 * Claims embedded in an AI token
 */
export interface AITokenClaims {
	/** Issuer - always "fabric-portal" */
	iss: "fabric-portal";
	/** Subject - the user ID */
	sub: string;
	/** Expiration timestamp (Unix seconds) */
	exp: number;
	/** JWT ID - unique nonce for replay protection */
	jti: string;
	/** Issued at timestamp (Unix seconds) */
	iat: number;

	// Custom claims
	/** Organization ID (optional) */
	org?: string;
	/** Source identifier for audit logging (e.g., "document-generator", "orchestrator") */
	src: string;
	/**
	 * Present (true) only on a token minted for the member's own interactive
	 * work; the exchange may then hand over their ChatGPT plan (Fizzy #2939).
	 */
	pe?: true;
	/**
	 * Present (true) when an admin acting as the member minted the token. The
	 * exchange then never hands over the member's ChatGPT plan, whatever else
	 * the member chose. Never present together with `pe`.
	 */
	imp?: true;
}

/**
 * Options for issuing an AI token
 */
export interface IssueTokenOptions {
	/** User ID */
	userId: string;
	/** Organization ID (optional) */
	organizationId?: string;
	/** Source identifier for audit logging */
	source: string;
	/** Custom expiry in seconds (default: 300 = 5 minutes) */
	expirySeconds?: number;
	/**
	 * The token serves the member's own interactive work, so the exchange may
	 * resolve their ChatGPT plan. Leave unset for background work.
	 */
	planEligible?: boolean;
	/**
	 * An admin acting as the member is behind this mint (Fizzy #2939).
	 * Required, so every mint decides: pass the request's own answer
	 * (`isAiImpersonatedRequest()` inside a request or a Temporal run).
	 */
	impersonated: boolean;
}

/**
 * Result of token verification
 */
export interface VerifyTokenResult {
	valid: true;
	claims: AITokenClaims;
}

/**
 * Error from token verification
 */
export interface VerifyTokenError {
	valid: false;
	error: string;
	code: "EXPIRED" | "INVALID_SIGNATURE" | "MALFORMED" | "MISSING_CLAIMS";
}

/**
 * Result of exchanging a token for an API key
 */
export interface ExchangeResult {
	/** The decrypted API key */
	apiKey: string;
	/** The AI provider type */
	provider: string;
	/** The configured model string */
	model: string;
	/** Base URL for the provider (if applicable) */
	baseUrl?: string;
	/** Remaining token validity in seconds */
	expiresIn: number;
	/** For Azure AI Foundry - the user-defined deployment name */
	deploymentName?: string;
	/** Billing mode assigned by Fabric for this token's resolved AI config */
	billingMode?: string;
	/** Stripe customer id used for metered billing when applicable */
	billingCustomerId?: string;
	/**
	 * The ChatGPT plan behind `apiKey`, by its opaque key, when a plan serves
	 * the token (Fizzy #2770); see `ExchangeClientConfig.excludeSources`.
	 */
	planSource?: string;
}

/**
 * Cached API key entry
 */
export interface CachedKeyEntry {
	result: ExchangeResult;
	/** Expiry timestamp in milliseconds */
	expiresAt: number;
}

/**
 * Header name for AI tokens
 */
export const AI_TOKEN_HEADER = "X-AI-Token";

/**
 * Default token expiry in seconds (5 minutes)
 */
export const DEFAULT_TOKEN_EXPIRY_SECONDS = 300;
