/**
 * Lightweight secret redaction applied to file content BEFORE it is sent to the
 * AI describe step (security — R5). Own implementation (modelled on the
 * code-indexing secret scan, not imported) tuned for the describe use case:
 * we only need to keep obvious credentials out of LLM prompts, not produce a
 * forensic report.
 */

interface RedactionPattern {
	label: string;
	regex: RegExp;
}

const PATTERNS: RedactionPattern[] = [
	// PEM private keys (multi-line)
	{
		label: "private-key",
		regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g,
	},
	// AWS access key id
	{ label: "aws-key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
	// Slack / GitHub / generic provider tokens
	{ label: "provider-token", regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
	{ label: "github-token", regex: /\bgh[pousr]_[0-9A-Za-z]{20,}\b/g },
	// Bearer tokens
	{ label: "bearer", regex: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g },
	// key = "secret-ish value" assignments (api keys, secrets, passwords, tokens)
	{
		label: "assigned-secret",
		regex: /((?:api[_-]?key|secret|password|passwd|token|access[_-]?token|client[_-]?secret)\s*[:=]\s*)(['"]?)([^\s'"]{8,})(['"]?)/gi,
	},
];

export interface RedactionResult {
	redacted: string;
	count: number;
}

/**
 * Replace obvious secrets with a placeholder. Returns the redacted content and
 * the number of redactions performed.
 */
export function redactSecrets(content: string): RedactionResult {
	let count = 0;
	let redacted = content;
	for (const { regex } of PATTERNS) {
		redacted = redacted.replace(regex, (_match, ...groups) => {
			count++;
			// For assignment-style matches, keep the key + quotes, redact the value.
			if (groups.length >= 4 && typeof groups[0] === "string") {
				const [prefix, openQuote, , closeQuote] = groups as string[];
				return `${prefix}${openQuote ?? ""}[REDACTED]${closeQuote ?? ""}`;
			}
			return "[REDACTED]";
		});
	}
	return { redacted, count };
}
