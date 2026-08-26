/**
 * Shared types for the PM ticket import filtering feature (F-1035).
 *
 * These types define the `filters` input shape and the additive output fields
 * on `listPMTicketsProcedure`. They are colocated with the procedure and
 * consumed by both backend (procedure + activities) and frontend (dialog,
 * parser) to guarantee a single source of truth for the contract described in
 * spec §6.1.
 */

export type PMTicketListNote = {
	kind: "already_imported";
	id: number;
};

/**
 * Discriminated union of per-ID resolution errors surfaced by the
 * Pull-from-PM dialog. Most kinds carry only `kind + id`; `server` carries the
 * HTTP status code and `network` carries the underlying error message so the
 * UI can show context to the user.
 *
 * `auth` / `rate_limited` / `server` / `network` are emitted when a GitLab
 * per-ID fetch rejects with a `GitLabApiError` (or a non-GitLabApiError
 * exception) — they replace the previous behaviour where every rejection was
 * reported as `not_found`.
 */
export type PMTicketListError =
	| { kind: "not_found"; id: number }
	| { kind: "wrong_board"; id: number }
	| { kind: "auth"; id: number }
	| { kind: "rate_limited"; id: number }
	| { kind: "server"; id: number; status: number }
	| { kind: "network"; id: number; message: string };

export type ParseTicketIdsErrorKind =
	| "range_inversion"
	| "not_numeric"
	| "over_cap"
	| "empty_token";

export interface ParseTicketIdsError {
	kind: ParseTicketIdsErrorKind;
	token: string;
}

export type ParseTicketIdsResult =
	| { ok: true; ids: number[] }
	| { ok: false; errors: ParseTicketIdsError[] };

export const PARSE_TICKET_IDS_CAP = 200;
