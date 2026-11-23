import { isRecord } from "./parlume-stream-auth";

const GUESTS_KEY = "guests";
const MAX_GUEST_ID_CHARS = 256;
const MAX_USER_ID_CHARS = 128;
const MAX_GUESTS = 200;

/** Posted when a guest is in the meeting, after the join notice. */
export const PARLUME_GUESTS_NOTICE =
	"**Notes only** · a guest is in this meeting\nI keep notes. I do not speak or answer in this chat while a guest is here.";

/** An external guest joined or left, as Fabric relays it. */
interface ParlumeGuestUpdate {
	id: string;
	joined: boolean;
}

/**
 * Where Fabric is with checking one participant: `pending` while it looks
 * them up, then done. Done with a `userId` is a confirmed project reader,
 * by their Fabric account; done without one is a guest the same relay
 * reports in `updates`, or someone who left when `updates` says so. `at` is
 * when Attendee saw the join or leave, when it said.
 */
interface ParlumePlacement {
	id: string;
	pending: boolean;
	userId: string | null;
	at: number | null;
}

/**
 * Fabric's `?action=guests` body. A bridge older than `placing` reads only
 * `updates`, which carries guests alone as it always has, so the checks
 * Fabric relays there change nothing for it.
 */
interface ParlumeGuestRelay {
	updates: ParlumeGuestUpdate[];
	placing: ParlumePlacement[];
}

interface ParlumeGuestState {
	/** The invitation named someone from outside the organization. */
	invited: boolean;
	/** The guests Attendee reported in the meeting now. */
	present: string[];
	/** Fabric checks who is in the meeting (`expectChecks`). */
	checked?: true;
	/** Fabric confirmed someone, so the room has been checked at all. */
	placed?: true;
	/** Participants Fabric is still checking. */
	pending?: string[];
	/** Confirmed project readers in the meeting, by Fabric account. */
	confirmed?: Record<string, string>;
	/** When each participant who left was last seen leaving. */
	left?: Record<string, number>;
}

function parsePlacement(value: unknown): ParlumePlacement | null {
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		!value.id ||
		value.id.length > MAX_GUEST_ID_CHARS ||
		typeof value.pending !== "boolean"
	) {
		return null;
	}
	const userId = value.userId ?? null;
	if (
		userId !== null &&
		(typeof userId !== "string" ||
			!userId ||
			userId.length > MAX_USER_ID_CHARS)
	) {
		return null;
	}
	const at = value.at ?? null;
	if (at !== null && (typeof at !== "number" || !Number.isFinite(at))) {
		return null;
	}
	return { id: value.id, pending: value.pending, userId, at };
}

/** Fabric's `?action=guests` body, or null when it is not one. */
export function parseParlumeGuestUpdates(
	body: unknown,
): ParlumeGuestRelay | null {
	if (
		!isRecord(body) ||
		!Array.isArray(body.updates) ||
		(body.placing !== undefined && !Array.isArray(body.placing))
	) {
		return null;
	}
	const updates: ParlumeGuestUpdate[] = [];
	for (const update of body.updates) {
		if (
			!isRecord(update) ||
			typeof update.id !== "string" ||
			!update.id ||
			update.id.length > MAX_GUEST_ID_CHARS ||
			typeof update.joined !== "boolean"
		) {
			return null;
		}
		updates.push({ id: update.id, joined: update.joined });
	}
	const placing: ParlumePlacement[] = [];
	for (const value of Array.isArray(body.placing) ? body.placing : []) {
		const placement = parsePlacement(value);
		if (!placement) {
			return null;
		}
		placing.push(placement);
	}
	return { updates, placing };
}

/**
 * Who is in the meeting, as far as Parlume answers (D2). A meeting whose
 * invitation named a guest counts as having one from the start, for its
 * whole length: Parlume cannot see when an invited guest who signed in
 * arrives. A guest Attendee reports counts while they are in the meeting.
 * While a guest is in, Parlume keeps notes only: it does not speak, answers
 * nothing in the chat and takes no command from a guest.
 *
 * Where Fabric checks each participant, Parlume also holds its answers
 * until Fabric has confirmed someone, and while anyone who joined is still
 * being checked.
 */
export class ParlumeGuests {
	private state: ParlumeGuestState = { invited: false, present: [] };

	constructor(
		private readonly storage: {
			get<T>(key: string): Promise<T | undefined>;
			put<T>(key: string, value: T): Promise<void>;
		},
	) {}

	async load(): Promise<void> {
		this.state =
			(await this.storage.get<ParlumeGuestState>(GUESTS_KEY)) ??
			this.state;
	}

	/** A guest is in the meeting, or was invited to it. */
	get present(): boolean {
		return this.state.invited || this.state.present.length > 0;
	}

	/**
	 * Parlume may answer in front of everyone there: no guest is in and, where
	 * Fabric checks the meeting, it has confirmed someone and is checking
	 * no one.
	 */
	get open(): boolean {
		return (
			!this.present &&
			(!this.state.checked || this.state.placed === true) &&
			!this.state.pending?.length
		);
	}

	/** The Fabric accounts of the confirmed project readers in the meeting. */
	attendees(): string[] {
		return [...new Set(Object.values(this.state.confirmed ?? {}))];
	}

	/**
	 * The Fabric account of a confirmed participant in the meeting, by their
	 * participant id or the speaker key the voice keeps for them; null for
	 * anyone else, a name included.
	 */
	userFor(id: string | null): string | null {
		const confirmed = this.state.confirmed ?? {};
		return id !== null && Object.hasOwn(confirmed, id)
			? (confirmed[id] ?? null)
			: null;
	}

	/** This participant is a guest Attendee reported in the meeting. */
	isGuest(id: string | null): boolean {
		return id !== null && this.state.present.includes(id);
	}

	/** Fabric checks each participant: hold answers until it places someone. */
	async expectChecks(checks: boolean): Promise<void> {
		if (!checks || this.state.checked) {
			return;
		}
		this.state.checked = true;
		await this.storage.put(GUESTS_KEY, this.state);
	}

	/** Fabric said the invitation named a guest. Returns true when a guest just came in. */
	async invite(invited: boolean): Promise<boolean> {
		if (!invited || this.state.invited) {
			return false;
		}
		const arrived = !this.present;
		this.state.invited = true;
		await this.storage.put(GUESTS_KEY, this.state);
		return arrived;
	}

	/**
	 * Applies joins, leaves and checks. Nothing puts back someone who left:
	 * an outcome counts only for someone still being checked, and a check
	 * for a join Attendee saw before that participant's last leave (a
	 * delivery repeated after it) is ignored. `guestArrived` when a guest
	 * just came in; `closed` when Parlume could answer before this and now
	 * cannot, `opened` the other way round.
	 */
	async update(
		relay: ParlumeGuestRelay,
	): Promise<{ guestArrived: boolean; closed: boolean; opened: boolean }> {
		const before = this.present;
		const wasOpen = this.open;
		const leaving = (id: string) =>
			relay.updates.some((update) => update.id === id && !update.joined);
		const pending = new Set(this.state.pending ?? []);
		const confirmed = new Map(Object.entries(this.state.confirmed ?? {}));
		const left = new Map(Object.entries(this.state.left ?? {}));
		const repeated = (id: string, at: number | null) =>
			at !== null && at <= (left.get(id) ?? Number.NEGATIVE_INFINITY);
		const stale = new Set<string>();
		for (const { id, pending: checking, userId, at } of relay.placing) {
			if (leaving(id)) {
				pending.delete(id);
				confirmed.delete(id);
				if (at !== null) {
					left.set(id, Math.max(at, left.get(id) ?? at));
				}
			} else if (checking ? repeated(id, at) : !pending.has(id)) {
				stale.add(id);
			} else if (checking) {
				confirmed.delete(id);
				pending.add(id);
			} else {
				pending.delete(id);
				if (userId) {
					confirmed.set(id, userId);
					this.state.placed = true;
				}
			}
		}
		const present = new Set(this.state.present);
		for (const update of relay.updates) {
			if (stale.has(update.id)) {
				continue;
			}
			if (update.joined) {
				present.add(update.id);
			} else {
				present.delete(update.id);
			}
		}
		this.state.present = [...present].slice(-MAX_GUESTS);
		// Never capped: dropping someone still being checked would let
		// Parlume answer in front of them.
		this.state.pending = [...pending];
		this.state.confirmed = Object.fromEntries(
			[...confirmed].slice(-MAX_GUESTS),
		);
		this.state.left = Object.fromEntries([...left].slice(-MAX_GUESTS));
		await this.storage.put(GUESTS_KEY, this.state);
		return {
			guestArrived: !before && this.present,
			closed: wasOpen && !this.open,
			opened: !wasOpen && this.open,
		};
	}
}
