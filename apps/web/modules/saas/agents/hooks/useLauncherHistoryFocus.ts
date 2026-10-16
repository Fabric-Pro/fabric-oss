"use client";

import { useCallback, useEffect, useRef } from "react";

const CHAT_INPUT = "textarea:not([disabled])";

/** How long to wait for a chat that is still loading to show its input. */
const CHAT_INPUT_WAIT_MS = 5_000;

type ReturnTarget = "toggle" | "chat";

/**
 * Focuses the first chat input inside `container` as soon as there is one, and
 * returns a function that stops waiting. The chat loads on demand and, for a
 * conversation reopened from the history, after the conversation has been read,
 * so its input may not exist yet when focus is asked for.
 */
function focusChatInput(container: HTMLElement | null): () => void {
	if (!container) {
		return () => {};
	}
	const focusIfThere = () => {
		const input = container.querySelector<HTMLElement>(CHAT_INPUT);
		input?.focus();
		return input !== null;
	};
	if (focusIfThere()) {
		return () => {};
	}
	const observer = new MutationObserver(() => {
		if (focusIfThere()) {
			observer.disconnect();
		}
	});
	observer.observe(container, { childList: true, subtree: true });
	const timer = setTimeout(() => observer.disconnect(), CHAT_INPUT_WAIT_MS);
	return () => {
		observer.disconnect();
		clearTimeout(timer);
	};
}

/**
 * Where focus goes when the drawer's history closes. The history hides the
 * chat, so closing it would otherwise drop focus with the element that held
 * it. Leaving by "Back to chat" returns to the button that opened the history;
 * choosing a conversation goes to the chat input once the chat is showing.
 * Closing with the header button itself moves nothing: focus is already there.
 */
export function useLauncherHistoryFocus(historyOpen: boolean) {
	const toggleRef = useRef<HTMLButtonElement>(null);
	const chatRef = useRef<HTMLDivElement>(null);
	const returnTo = useRef<ReturnTarget | null>(null);

	useEffect(() => {
		const target = returnTo.current;
		returnTo.current = null;
		if (historyOpen) {
			return;
		}
		if (target === "toggle") {
			toggleRef.current?.focus();
			return;
		}
		if (target === "chat") {
			return focusChatInput(chatRef.current);
		}
	}, [historyOpen]);

	const closingTo = useCallback((target: ReturnTarget) => {
		returnTo.current = target;
	}, []);

	return { toggleRef, chatRef, closingTo };
}
