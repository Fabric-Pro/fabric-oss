/**
 * The IANA time zone names this runtime knows, computed once at module load
 * (~600 entries). `Intl.supportedValuesOf` is ES2022+; an older runtime gets an
 * empty list rather than a throw at load, and callers keep showing a stored
 * zone that is not in it.
 */
export const TIME_ZONES: readonly string[] =
	typeof Intl.supportedValuesOf === "function"
		? Intl.supportedValuesOf("timeZone")
		: [];
