"use client";

import { Button } from "@ui/components/button";
import { AlertTriangleIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

const STORAGE_PREFIX = "fabric-ai-notice-dismissed:";

function readDismissed(key: string): boolean {
	try {
		return window.localStorage.getItem(STORAGE_PREFIX + key) === "1";
	} catch {
		return false;
	}
}

function writeDismissed(key: string, dismissed: boolean) {
	try {
		if (dismissed) {
			window.localStorage.setItem(STORAGE_PREFIX + key, "1");
		} else {
			window.localStorage.removeItem(STORAGE_PREFIX + key);
		}
	} catch {
		// Storage can be unavailable (private mode, quota); the notice then
		// simply behaves as before within this page load.
	}
}

/**
 * Dismissal for the floating AI notices.
 *
 * Once a reader has cancelled a notice it stays cancelled: across navigation,
 * across reloads, per tenant. The notice does not vanish outright — the
 * caller renders `CollapsedNotice` in its place, a small marker that reopens
 * the full card — so the information stays one click away without asking
 * for attention on every page.
 *
 * `dismissed` is `undefined` until the stored answer for THIS key has been
 * read. Callers render nothing in that window, so a tenant switch never
 * flashes the previous tenant's answer.
 */
export function useNoticeDismissal(key: string) {
	const [state, setState] = useState<{
		key: string;
		dismissed: boolean;
	} | null>(null);

	useEffect(() => {
		setState({ key, dismissed: readDismissed(key) });
	}, [key]);

	const dismiss = useCallback(() => {
		writeDismissed(key, true);
		setState({ key, dismissed: true });
	}, [key]);

	const restore = useCallback(() => {
		writeDismissed(key, false);
		setState({ key, dismissed: false });
	}, [key]);

	return {
		dismissed: state?.key === key ? state.dismissed : undefined,
		dismiss,
		restore,
	};
}

/**
 * The collapsed form of a dismissed notice: an amber marker the size of an
 * icon button. It carries the notice's name for assistive tech and as a
 * tooltip, and reopens the full card on click.
 */
export function CollapsedNotice({
	label,
	onOpen,
}: {
	label: string;
	onOpen: () => void;
}) {
	return (
		<Button
			type="button"
			variant="outline"
			size="icon"
			onClick={onOpen}
			aria-label={label}
			title={label}
			className="pointer-events-auto size-8 rounded-full border-highlight/40 bg-card text-highlight-ink shadow-md hover:bg-highlight/10 hover:text-highlight-ink motion-safe:animate-in motion-safe:fade-in"
		>
			<AlertTriangleIcon className="size-4" aria-hidden="true" />
		</Button>
	);
}
