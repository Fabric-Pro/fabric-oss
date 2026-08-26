/**
 * Database queries for Document Locks
 *
 * Handles optimistic locking for collaborative document editing.
 * Locks automatically expire after a timeout (default 5 minutes).
 * Heartbeat mechanism extends the lock while user is actively editing.
 */

import { db } from "../../client";

const LOCK_TIMEOUT_MINUTES = 5;
const HEARTBEAT_EXTENSION_MINUTES = 5;

/**
 * Attempt to acquire a lock on a document
 *
 * TENANT ISOLATION: organizationId is included for proper tenant filtering.
 *
 * @returns The lock if acquired, or null if already locked by another user
 */
export async function acquireDocumentLock(
	documentId: string,
	userId: string,
	userName: string,
	organizationId?: string,
): Promise<{
	acquired: boolean;
	lock: any;
	lockedBy?: { userId: string; userName: string };
}> {
	// First, clean up expired locks
	await cleanupExpiredLocks();

	// Check if there's an existing lock
	const existingLock = await db.documentLock.findUnique({
		where: { documentId },
	});

	if (existingLock) {
		// If locked by the same user, extend the lock
		if (existingLock.userId === userId) {
			const updatedLock = await extendLock(documentId, userId);
			return { acquired: true, lock: updatedLock };
		}

		// Check if the lock has expired
		if (existingLock.expiresAt < new Date()) {
			// Lock expired, delete and acquire new one
			await db.documentLock.delete({ where: { documentId } });
		} else {
			// Lock is held by another user
			return {
				acquired: false,
				lock: null,
				lockedBy: {
					userId: existingLock.userId,
					userName: existingLock.userName,
				},
			};
		}
	}

	// Create new lock
	const expiresAt = new Date();
	expiresAt.setMinutes(expiresAt.getMinutes() + LOCK_TIMEOUT_MINUTES);

	try {
		const lock = await db.documentLock.create({
			data: {
				documentId,
				userId,
				userName,
				expiresAt,
				organizationId,
			},
		});
		return { acquired: true, lock };
	} catch (error: any) {
		// Handle race condition - another user acquired the lock
		if (error.code === "P2002") {
			const currentLock = await db.documentLock.findUnique({
				where: { documentId },
			});
			if (currentLock) {
				return {
					acquired: false,
					lock: null,
					lockedBy: {
						userId: currentLock.userId,
						userName: currentLock.userName,
					},
				};
			}
		}
		throw error;
	}
}

/**
 * Release a document lock
 * Only the lock holder can release the lock
 */
export async function releaseDocumentLock(
	documentId: string,
	userId: string,
): Promise<boolean> {
	const result = await db.documentLock.deleteMany({
		where: {
			documentId,
			userId,
		},
	});

	return result.count > 0;
}

/**
 * Extend a lock's expiration (heartbeat)
 * Called periodically while user is editing
 */
export async function extendLock(
	documentId: string,
	_userId: string,
): Promise<any> {
	const expiresAt = new Date();
	expiresAt.setMinutes(expiresAt.getMinutes() + HEARTBEAT_EXTENSION_MINUTES);

	return await db.documentLock.update({
		where: { documentId },
		data: {
			expiresAt,
			lastHeartbeat: new Date(),
		},
	});
}

/**
 * Get the current lock status for a document
 */
export async function getDocumentLockStatus(documentId: string): Promise<{
	isLocked: boolean;
	lockedBy?: {
		userId: string;
		userName: string;
	};
	expiresAt?: Date;
}> {
	const lock = await db.documentLock.findUnique({
		where: { documentId },
	});

	if (!lock) {
		return { isLocked: false };
	}

	// Check if expired
	if (lock.expiresAt < new Date()) {
		// Clean up expired lock
		await db.documentLock.delete({ where: { documentId } });
		return { isLocked: false };
	}

	return {
		isLocked: true,
		lockedBy: {
			userId: lock.userId,
			userName: lock.userName,
		},
		expiresAt: lock.expiresAt,
	};
}

/**
 * Clean up all expired locks
 * Should be called periodically
 */
export async function cleanupExpiredLocks(): Promise<number> {
	const result = await db.documentLock.deleteMany({
		where: {
			expiresAt: { lt: new Date() },
		},
	});

	return result.count;
}

/**
 * Force release a lock (admin action)
 * Use with caution - may cause data conflicts
 */
export async function forceReleaseDocumentLock(
	documentId: string,
): Promise<boolean> {
	const result = await db.documentLock.deleteMany({
		where: { documentId },
	});

	return result.count > 0;
}

/**
 * Get all active locks for a project
 * Useful for displaying who is editing what
 */
export async function getProjectActiveLocks(projectId: string): Promise<
	Array<{
		documentId: string;
		documentTitle: string;
		userId: string;
		userName: string;
		acquiredAt: Date;
		expiresAt: Date;
	}>
> {
	const locks = await db.documentLock.findMany({
		where: {
			document: {
				projectId,
			},
			expiresAt: { gt: new Date() },
		},
		include: {
			document: {
				select: {
					id: true,
					title: true,
				},
			},
		},
	});

	return locks.map((lock) => ({
		documentId: lock.documentId,
		documentTitle: lock.document.title,
		userId: lock.userId,
		userName: lock.userName,
		acquiredAt: lock.acquiredAt,
		expiresAt: lock.expiresAt,
	}));
}
