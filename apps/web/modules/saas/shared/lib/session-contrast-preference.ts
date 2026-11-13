import { logger } from "@repo/logs";
import {
	type ContrastPreference,
	resolveContrastPreference,
} from "@repo/utils/contrast-preference";

/**
 * The palette the authenticated app renders for this person (Fizzy #1444).
 *
 * Read from the account on every request, so a choice made on one device is
 * the palette on the next (AC-4/AC-5). A stored value this build cannot read
 * renders the standard palette with nothing shown to the person (AC-6) — and is
 * logged, because it means something wrote the column that should not have.
 * "Never chose" is the common case and is not logged.
 */
export function sessionContrastPreference(user: {
	id: string;
	contrastPreference?: string | null;
}): ContrastPreference {
	const { preference, fallback } = resolveContrastPreference(
		user.contrastPreference,
	);
	if (fallback === "unrecognized") {
		logger.warn(
			"[SaaSLayout] Unrecognised contrast preference; rendering the standard palette",
			{
				userId: user.id,
				// Bounded: the column is free text, and a log line is not the
				// place to find out how long it can get.
				storedPreference: String(user.contrastPreference).slice(0, 64),
			},
		);
	}
	return preference;
}
