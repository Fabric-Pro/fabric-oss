/**
 * Who started each chat thread the in-memory runner holds (Fizzy #2946).
 *
 * The runtime's `InMemoryAgentRunner` keeps every thread's events in one
 * process-wide store and replays a thread to any `agent/connect` that names
 * its id. The store records no owner, so this registry does: the first run on
 * a thread binds it to the session user, and the runner refuses another
 * user's run, replay or stop on it (`./proposal-run-runner`).
 *
 * Bounded like the route's tenant cache: insertion order, oldest entry dropped
 * first. A run's start and end and every replay by the owner move its thread
 * to the back, and the cap sits well above the store's own thread cap (1,000
 * by default, also refreshed on use), so a thread the store still holds keeps
 * its owner. A finished thread the registry has never seen, or has dropped,
 * behaves as it always has; one still running is joined by nobody, since its
 * owner can no longer be told apart.
 */

const THREAD_OWNERS_MAX_ENTRIES = 5000;

export class ThreadOwners {
	private readonly owners = new Map<string, string>();

	constructor(private readonly maxEntries = THREAD_OWNERS_MAX_ENTRIES) {}

	/**
	 * Binds an unowned thread to `userId` and refreshes one they own. False,
	 * changing nothing, when another user owns it.
	 */
	claim(threadId: string, userId: string): boolean {
		const owner = this.owners.get(threadId);
		if (owner !== undefined && owner !== userId) {
			return false;
		}
		this.owners.delete(threadId);
		this.owners.set(threadId, userId);
		if (this.owners.size > this.maxEntries) {
			const oldest = this.owners.keys().next().value;
			if (oldest !== undefined) {
				this.owners.delete(oldest);
			}
		}
		return true;
	}

	/**
	 * False when another user owns the thread. Refreshes a thread `userId`
	 * owns; never binds an unowned one.
	 */
	admits(threadId: string, userId: string): boolean {
		const owner = this.owners.get(threadId);
		if (owner === undefined) {
			return true;
		}
		if (owner !== userId) {
			return false;
		}
		this.owners.delete(threadId);
		this.owners.set(threadId, owner);
		return true;
	}

	/** True when some user owns the thread. Refreshes nothing. */
	isOwned(threadId: string): boolean {
		return this.owners.has(threadId);
	}

	/** Forgets the thread when `userId` owns it. */
	release(threadId: string, userId: string): void {
		if (this.owners.get(threadId) === userId) {
			this.owners.delete(threadId);
		}
	}
}

/** The registry beside the runtime's process-wide in-memory store. */
export const threadOwners = new ThreadOwners();
