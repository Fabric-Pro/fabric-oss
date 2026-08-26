/**
 * Security Specification References
 *
 * Comprehensive RFC and specification references for security-focused code review.
 * Used by Warp agent to cite relevant specifications in security findings.
 */

export interface SecuritySpec {
	id: string;
	name: string;
	url: string;
	keywords: string[];
	description: string;
}

/**
 * RFC/Spec citation table with 12+ security specifications
 */
export const RFC_CITATIONS: SecuritySpec[] = [
	{
		id: "RFC6749",
		name: "OAuth 2.0 (RFC 6749)",
		url: "https://datatracker.ietf.org/doc/html/rfc6749",
		keywords: [
			"oauth",
			"authorization",
			"access-token",
			"refresh-token",
			"client-credentials",
			"authorization-code",
			"implicit-grant",
		],
		description:
			"The OAuth 2.0 authorization framework enables third-party applications to obtain limited access to HTTP services.",
	},
	{
		id: "RFC7636",
		name: "PKCE (RFC 7636)",
		url: "https://datatracker.ietf.org/doc/html/rfc7636",
		keywords: [
			"pkce",
			"code-challenge",
			"code-verifier",
			"proof-key",
			"x" + "xxxxx",
		],
		description:
			"Proof Key for Code Exchange by OAuth Public Clients prevents authorization code interception attacks.",
	},
	{
		id: "RFC7519",
		name: "JWT (RFC 7519)",
		url: "https://datatracker.ietf.org/doc/html/rfc7519",
		keywords: [
			"jwt",
			"json-web-token",
			"jose",
			"claims",
			"expiration",
			"issued-at",
		],
		description:
			"JSON Web Token (JWT) is a compact, URL-safe means of representing claims to be transferred between two parties.",
	},
	{
		id: "RFC7517",
		name: "JWK (RFC 7517)",
		url: "https://datatracker.ietf.org/doc/html/rfc7517",
		keywords: [
			"jwk",
			"json-web-key",
			"key-management",
			"rsa-key",
			"ec-key",
			"oct-key",
		],
		description:
			"JSON Web Key (JWK) is a JSON data structure that represents a cryptographic key.",
	},
	{
		id: "RFC7009",
		name: "Token Revocation (RFC 7009)",
		url: "https://datatracker.ietf.org/doc/html/rfc7009",
		keywords: ["token-revocation", "revoke", "invalidation", "logout"],
		description:
			"This specification defines a mechanism for a client to indicate that a previously obtained token is no longer needed.",
	},
	{
		id: "OIDC-Core",
		name: "OpenID Connect Core 1.0",
		url: "https://openid.net/specs/openid-connect-core-1_0.html",
		keywords: [
			"oidc",
			"openid-connect",
			"id-token",
			"userinfo",
			"discovery",
			"claims-request",
		],
		description:
			"OpenID Connect Core 1.0 - identity layer on top of OAuth 2.0 for authentication.",
	},
	{
		id: "WebAuthn-L2",
		name: "WebAuthn Level 2",
		url: "https://www.w3.org/TR/webauthn-2/",
		keywords: [
			"webauthn",
			"web-authentication",
			"passkey",
			"fido2",
			"authenticator",
			"public-key-credential",
		],
		description:
			"Web Authentication API for accessing scoped credentials created by authenticators.",
	},
	{
		id: "RFC6238",
		name: "TOTP (RFC 6238)",
		url: "https://datatracker.ietf.org/doc/html/rfc6238",
		keywords: [
			"totp",
			"time-based-otp",
			"2fa",
			"two-factor",
			"authenticator",
			"one-time-password",
		],
		description:
			"Time-based One-Time Password Algorithm for generating short-lived authentication codes.",
	},
	{
		id: "RFC4226",
		name: "HOTP (RFC 4226)",
		url: "https://datatracker.ietf.org/doc/html/rfc4226",
		keywords: ["hotp", "hmac-based-otp", "counter", "one-time-password"],
		description:
			"HMAC-Based One-Time Password Algorithm for generating authentication codes using HMAC.",
	},
	{
		id: "CORS",
		name: "CORS (Fetch + MDN)",
		url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS",
		keywords: [
			"cors",
			"cross-origin",
			"access-control",
			"origin",
			"credential",
			"expose-headers",
		],
		description:
			"Cross-Origin Resource Sharing - HTTP mechanism for controlled access to resources from different origins.",
	},
	{
		id: "CSP-L3",
		name: "CSP Level 3",
		url: "https://www.w3.org/TR/CSP3/",
		keywords: [
			"csp",
			"content-security-policy",
			"xss",
			"cross-site-scripting",
			"unsafe-inline",
			"script-src",
		],
		description:
			"Content Security Policy Level 3 - helps detect and mitigate XSS and data injection attacks.",
	},
	{
		id: "OWASP-Top10-2021",
		name: "OWASP Top 10 2021",
		url: "https://owasp.org/Top10/",
		keywords: [
			"owasp",
			"injection",
			"broken-auth",
			"sensitive-data",
			"xxe",
			"broken-access",
			"security-misconfiguration",
			"xss",
			"deserialization",
			"vulnerability",
		],
		description:
			"OWASP Top 10 2021 - most critical security risks to web applications.",
	},
	{
		id: "BCP195",
		name: "BCP 195 (TLS Best Practices)",
		url: "https://datatracker.ietf.org/doc/html/bcp195",
		keywords: ["tls", "ssl", "https", "secure-connection", "cipher-suite"],
		description:
			"Recommendations for Secure Use of TLS and DTLS - current best practices for transport layer security.",
	},
];

/**
 * Find relevant specs based on code keywords
 */
export function findRelevantSpecs(code: string): SecuritySpec[] {
	const lowerCode = code.toLowerCase();
	const codeWords = new Set(
		lowerCode.split(/[\s\n\r\t()[\]{};,.<>!?@#$%^&*+=\\-_'"`~]+/),
	);

	const scoredSpecs: Array<{ spec: SecuritySpec; score: number }> = [];

	for (const spec of RFC_CITATIONS) {
		let score = 0;
		for (const keyword of spec.keywords) {
			const lowerKeyword = keyword.toLowerCase();
			if (lowerCode.includes(lowerKeyword)) {
				// Exact substring match in code
				score += 3;
			}
			// Check individual words
			const keywordWords = lowerKeyword.split(/[\s-]+/);
			for (const kw of keywordWords) {
				if (codeWords.has(kw) && kw.length > 2) {
					score += 1;
				}
			}
		}
		if (score > 0) {
			scoredSpecs.push({ spec, score });
		}
	}

	// Sort by score descending, return specs
	scoredSpecs.sort((a, b) => b.score - a.score);
	return scoredSpecs.map((s) => s.spec);
}

/**
 * Format a spec citation in markdown format
 */
export function formatSpecCitation(spec: SecuritySpec): string {
	return `**${spec.name}**

${spec.description}

Specification: ${spec.url}

Related keywords: ${spec.keywords.join(", ")}`;
}

/**
 * Format multiple spec citations
 */
export function formatSpecCitations(specs: SecuritySpec[]): string {
	if (specs.length === 0) {
		return "";
	}
	return specs.map(formatSpecCitation).join("\n\n---\n\n");
}
