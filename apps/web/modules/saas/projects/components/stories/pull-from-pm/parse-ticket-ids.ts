import {
	PARSE_TICKET_IDS_CAP,
	type ParseTicketIdsError,
	type ParseTicketIdsResult,
} from "@repo/api/modules/projects/procedures/stories/sync/list-pm-tickets-filters.types";

const NUMERIC_TOKEN = /^\d+$/;

/**
 * Parses the Ticket IDs textarea value into a deduped, sorted list of numeric
 * IDs. Grammar:
 *
 *   - Tokens separated by commas or newlines, whitespace-tolerant.
 *   - Tokens are either a positive integer or an inclusive range `start-end`
 *     where `start <= end`. Whitespace around the hyphen is tolerated.
 *   - Expanded result is deduped and capped at 200.
 *
 * Returns a discriminated union so callers can surface all parse errors in one
 * pass rather than stopping at the first failure.
 */
export function parseTicketIds(input: string): ParseTicketIdsResult {
	const errors: ParseTicketIdsError[] = [];
	const ids = new Set<number>();

	const rawTokens = splitTokens(input);

	for (const raw of rawTokens) {
		const token = raw.trim();

		if (token.length === 0) {
			continue;
		}

		const rangeParts = splitRange(token);

		if (rangeParts === null) {
			if (!NUMERIC_TOKEN.test(token)) {
				errors.push({ kind: "not_numeric", token });
				continue;
			}
			ids.add(Number.parseInt(token, 10));
			continue;
		}

		const [startRaw, endRaw] = rangeParts;

		if (!NUMERIC_TOKEN.test(startRaw) || !NUMERIC_TOKEN.test(endRaw)) {
			errors.push({ kind: "not_numeric", token });
			continue;
		}

		const start = Number.parseInt(startRaw, 10);
		const end = Number.parseInt(endRaw, 10);

		if (start > end) {
			errors.push({ kind: "range_inversion", token });
			continue;
		}

		for (let value = start; value <= end; value += 1) {
			ids.add(value);
			if (ids.size > PARSE_TICKET_IDS_CAP) {
				break;
			}
		}
	}

	if (ids.size > PARSE_TICKET_IDS_CAP) {
		errors.push({ kind: "over_cap", token: String(ids.size) });
	}

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	const sorted = [...ids].sort((a, b) => a - b);
	return { ok: true, ids: sorted };
}

function splitTokens(input: string): string[] {
	return input.split(/[,\n]/);
}

function splitRange(token: string): [string, string] | null {
	const hyphenIndex = token.indexOf("-");
	if (hyphenIndex === -1) {
		return null;
	}
	const left = token.slice(0, hyphenIndex).trim();
	const right = token.slice(hyphenIndex + 1).trim();
	return [left, right];
}
