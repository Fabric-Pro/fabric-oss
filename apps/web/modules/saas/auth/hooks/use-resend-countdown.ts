import { useCallback, useEffect, useRef, useState } from "react";

interface ResendCountdownResult {
	secondsLeft: number;
	isActive: boolean;
	startCountdown: (resetSeconds: number) => void;
}

function getResendCooldownStorageKey(email: string): string {
	return `fabric:verify-resend:${email.toLowerCase().trim()}`;
}

/**
 * Synchronously checks whether a persisted resend cooldown is still running
 * for the given email. The hook itself restores the countdown in an effect
 * (i.e., one commit late), so mount-time guards that must not restart an
 * already-running cooldown cannot rely on `isActive` — they should call
 * this instead.
 */
export function hasActiveResendCooldown(email: string): boolean {
	try {
		const raw = localStorage.getItem(getResendCooldownStorageKey(email));
		if (!raw) {
			return false;
		}
		const stored = JSON.parse(raw) as { resendAllowedAt?: number };
		return (
			typeof stored.resendAllowedAt === "number" &&
			stored.resendAllowedAt > Date.now()
		);
	} catch {
		// localStorage unavailable (e.g., private browsing) or corrupted data
		return false;
	}
}

/**
 * Manages a countdown timer for email verification resend,
 * persisted to localStorage so it survives page refresh.
 *
 * @param email - The email address used to scope the localStorage key
 */
export function useResendCountdown(email: string): ResendCountdownResult {
	const [secondsLeft, setSecondsLeft] = useState(0);
	const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const storageKey = getResendCooldownStorageKey(email);

	const clearTimer = useCallback(() => {
		if (intervalRef.current !== null) {
			clearInterval(intervalRef.current);
			intervalRef.current = null;
		}
	}, []);

	const removeStorageKey = useCallback((key: string) => {
		try {
			localStorage.removeItem(key);
		} catch {
			// localStorage unavailable (e.g., private browsing)
		}
	}, []);

	// On mount (or email change): check localStorage for an active timer.
	// Always reset secondsLeft first so a previous email's countdown
	// doesn't carry over when the email field changes.
	useEffect(() => {
		let remaining = 0;
		try {
			const raw = localStorage.getItem(storageKey);
			if (raw) {
				const stored = JSON.parse(raw) as { resendAllowedAt?: number };
				if (stored.resendAllowedAt) {
					remaining = Math.ceil(
						(stored.resendAllowedAt - Date.now()) / 1000,
					);
					if (remaining <= 0) {
						remaining = 0;
						removeStorageKey(storageKey);
					}
				}
			}
		} catch {
			// localStorage unavailable or corrupted data
		}
		setSecondsLeft(remaining);
	}, [storageKey, removeStorageKey]);

	// Interval to decrement the countdown each second
	useEffect(() => {
		if (secondsLeft <= 0) {
			clearTimer();
			return;
		}

		intervalRef.current = setInterval(() => {
			setSecondsLeft((prev) => {
				if (prev <= 1) {
					removeStorageKey(storageKey);
					return 0;
				}
				return prev - 1;
			});
		}, 1000);

		return () => {
			clearTimer();
		};
	}, [secondsLeft > 0, storageKey, clearTimer, removeStorageKey]);

	const startCountdown = useCallback(
		(resetSeconds: number) => {
			const resendAllowedAt = Date.now() + resetSeconds * 1000;
			try {
				localStorage.setItem(
					storageKey,
					JSON.stringify({ resendAllowedAt }),
				);
			} catch {
				// localStorage unavailable; timer still works for this session
			}
			setSecondsLeft(resetSeconds);
		},
		[storageKey],
	);

	// Cleanup interval on unmount
	useEffect(() => {
		return () => {
			clearTimer();
		};
	}, [clearTimer]);

	return {
		secondsLeft,
		isActive: secondsLeft > 0,
		startCountdown,
	};
}
