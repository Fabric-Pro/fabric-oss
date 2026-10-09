/** `ab***@example.com`: enough to tell accounts apart, not to address one. */
export function maskEmail(email: string | null): string | null {
	if (!email) {
		return null;
	}
	const at = email.lastIndexOf("@");
	if (at <= 0) {
		return "***";
	}
	return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
}
