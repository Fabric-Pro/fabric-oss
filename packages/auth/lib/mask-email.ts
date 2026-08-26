/**
 * Masks an email address for safe display in notifications:
 * `john@example.com` → `j***@example.com`. Reveals enough that the
 * account owner can recognise it without exposing the full address
 * to a reader who may not be them.
 */
export function maskEmail(email: string): string {
	const atIndex = email.indexOf("@");
	if (atIndex <= 0) {
		return `***${email.slice(atIndex)}`;
	}
	const local = email.slice(0, atIndex);
	const domain = email.slice(atIndex);
	return `${local[0]}***${domain}`;
}
