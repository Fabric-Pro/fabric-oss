import { orpc } from "@shared/lib/orpc-query-utils";

/**
 * The one base key every non-member-contact read hangs off (Fizzy #2340).
 *
 * WHY THIS IS A FUNCTION AND NOT A LITERAL. Three query-key shapes coexist in
 * this app: hand-written tuples (`["organization", id, "invitations"]`), oRPC's
 * generated `[path, { input, type }]` pairs, and the older `queryKey()` helper
 * form. A filter written in the wrong one of those three matches NOTHING and
 * `invalidateQueries` reports no error — the list simply never refreshes, and
 * the bug looks like a stale server instead of a typo.
 *
 * So the key is derived from the same procedure object the reads use rather
 * than spelled out. `key()` returns the path-only prefix
 * (`[["todos","contacts","list"], {}]`), which partially matches every
 * `queryOptions({ input })` key hanging below it, whatever input it carried.
 * That is deliberately broader than one organization's list: a contact write
 * only ever happens in the organization being looked at, and invalidating one
 * extra cached list is free next to missing the one on screen.
 */
export const organizationContactsQueryKey = () =>
	orpc.todos.contacts.list.key();

/**
 * A blank optional field means "not given", never an empty string.
 *
 * Both contact forms — the settings register and the one the To Do list opens
 * from an unassigned row — normalise `email` and `company` the same way before
 * calling `contacts.create`, and the server's own schema documents the same
 * contract. It lived twice because the two forms were written in parallel; one
 * definition is what keeps them from drifting apart.
 */
export function trimmedOrUndefined(value: string): string | undefined {
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}
