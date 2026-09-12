"use client";

import { useEffect, useState } from "react";

/**
 * Types a rotating set of example prompts into a placeholder, one character
 * at a time, holds each finished line, erases it and moves to the next.
 * This is the Cosmos advisor's idle composer: the box is never empty, and
 * the examples double as a hint of what the Advisor is for.
 *
 * While `active` is false the hook returns the first phrase in full and
 * runs no timers, so a focused or non-empty composer costs nothing.
 * Reduced-motion users get the same static line.
 */
export function useTypewriterPlaceholder(
	phrases: readonly string[],
	active: boolean,
): string {
	const [text, setText] = useState(phrases[0] ?? "");

	useEffect(() => {
		if (!active || phrases.length === 0) {
			return;
		}
		if (
			typeof window !== "undefined" &&
			window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
		) {
			setText(phrases[0] ?? "");
			return;
		}

		let index = 0;
		let length = 0;
		let deleting = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const step = () => {
			const phrase = phrases[index] ?? "";
			if (!deleting) {
				length += 1;
				setText(phrase.slice(0, length));
				if (length >= phrase.length) {
					deleting = true;
					timer = setTimeout(step, 1800);
					return;
				}
				timer = setTimeout(step, 38 + Math.random() * 30);
				return;
			}
			length -= 1;
			setText(phrase.slice(0, Math.max(length, 0)));
			if (length <= 0) {
				deleting = false;
				index = (index + 1) % phrases.length;
				timer = setTimeout(step, 320);
				return;
			}
			timer = setTimeout(step, 14);
		};

		setText("");
		timer = setTimeout(step, 400);
		return () => {
			if (timer) {
				clearTimeout(timer);
			}
		};
	}, [active, phrases]);

	return text;
}
