/**
 * Absolute UTC timestamp for the status surfaces.
 *
 * Deliberately not a relative "3 hours ago": mid-incident a customer is
 * correlating this against their own logs, and a relative time forces them to do
 * arithmetic against an unstated clock.
 */
export function formatUtc(value: string | Date): string {
	const date = typeof value === "string" ? new Date(value) : value;
	return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
