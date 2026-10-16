import { TIME_ZONES } from "@saas/shared/lib/time-zones";

/**
 * The time zones a schedule trigger can be read in. UTC leads the list: it is
 * the zone every schedule saved before the field existed runs in, and `Intl`
 * does not list it. The server accepts any name it recognises.
 */
export function listTimeZoneOptions(): { value: string; label: string }[] {
	return ["UTC", ...TIME_ZONES.filter((zone) => zone !== "UTC")].map(
		(zone) => ({
			value: zone,
			label: zone.replaceAll("_", " "),
		}),
	);
}
