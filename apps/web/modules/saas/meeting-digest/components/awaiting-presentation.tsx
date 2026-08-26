import { ClockIcon } from "lucide-react";

/**
 * The single source of truth for how "linked, but no transcript synced yet"
 * looks (#2051).
 *
 * Two surfaces render this state and they must be indistinguishable: the team
 * rows added by #2051, and the personal-path rows PR #2226 still produces for
 * occurrences no agenda dated. #2051 does NOT retire #2226 — per-occurrence
 * calendar coverage is out of reach for a team-facing endpoint (FR4) — so both
 * can appear on one calendar and any drift between them would read as two
 * different states.
 *
 * Two independent non-colour channels, as the accessibility NFR requires: a
 * text badge and an icon carrying an accessible name.
 */
export const AWAITING_PRESENTATION = {
	Icon: ClockIcon,
	iconLabel: "Awaiting transcript",
	badge: "Not synced yet",
	titleSuffix: "awaiting transcript",
} as const;
