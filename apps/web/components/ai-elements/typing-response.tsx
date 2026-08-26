"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import {
	chatMarkdownComponents,
	getChatMarkdownClassName,
} from "./chat-markdown";
import { normalizeTextToMarkdown } from "./text-normalizer";

/**
 * Typing animation hook that reveals text progressively
 * Creates the illusion of fast streaming regardless of how the text arrives
 *
 * Uses requestAnimationFrame for smooth 60fps animation.
 * Keeps polling for new text while enabled to ensure smooth streaming.
 *
 * ADAPTIVE SPEED: When text arrives faster than we can display (common with
 * ultra-fast providers like Cerebras), we dynamically increase the animation
 * speed to prevent jarring "catch up" behavior. The speed adapts smoothly
 * based on buffer size.
 */
function useTypingAnimation(
	text: string,
	options: {
		enabled?: boolean;
		/** Base characters per frame (minimum speed) */
		charsPerFrame?: number;
		/** Maximum characters per frame when buffer is large */
		maxCharsPerFrame?: number;
		targetFps?: number;
	} = {},
) {
	const {
		enabled = true,
		charsPerFrame = 3,
		maxCharsPerFrame = 15,
		targetFps = 60,
	} = options;
	const [displayedText, setDisplayedText] = useState(text);
	const [isAnimating, setIsAnimating] = useState(false);

	// Refs for animation state (don't trigger re-renders)
	const targetTextRef = useRef(text);
	const displayIndexRef = useRef(text.length);
	const rafIdRef = useRef<number | null>(null);
	const lastFrameTimeRef = useRef(0);
	const enabledRef = useRef(enabled);

	const frameInterval = 1000 / targetFps;

	// Keep enabled ref in sync
	useEffect(() => {
		enabledRef.current = enabled;
	}, [enabled]);

	// Update target text ref when text changes
	useEffect(() => {
		if (!enabled) {
			// Animation disabled - show full text immediately
			if (rafIdRef.current !== null) {
				cancelAnimationFrame(rafIdRef.current);
				rafIdRef.current = null;
			}
			setDisplayedText(text);
			displayIndexRef.current = text.length;
			targetTextRef.current = text;
			setIsAnimating(false);
			return;
		}

		if (!text) {
			if (rafIdRef.current !== null) {
				cancelAnimationFrame(rafIdRef.current);
				rafIdRef.current = null;
			}
			setDisplayedText("");
			displayIndexRef.current = 0;
			targetTextRef.current = "";
			setIsAnimating(false);
			return;
		}

		if (!text.startsWith(displayedText)) {
			// Snap to the authoritative text when the stream is rehydrated or merged.
			setDisplayedText(text);
			displayIndexRef.current = text.length;
			targetTextRef.current = text;
			setIsAnimating(false);
			return;
		}

		displayIndexRef.current = displayedText.length;

		// Update target
		targetTextRef.current = text;

		// Start animation loop if not already running
		if (rafIdRef.current === null) {
			setIsAnimating(true);
			lastFrameTimeRef.current = performance.now();

			const animate = (timestamp: number) => {
				// Check if we should stop (disabled or unmounted)
				if (!enabledRef.current) {
					rafIdRef.current = null;
					setIsAnimating(false);
					// Show full text when disabled
					setDisplayedText(targetTextRef.current);
					displayIndexRef.current = targetTextRef.current.length;
					return;
				}

				const elapsed = timestamp - lastFrameTimeRef.current;

				if (elapsed >= frameInterval) {
					lastFrameTimeRef.current =
						timestamp - (elapsed % frameInterval);

					const currentTarget = targetTextRef.current;
					const currentIndex = displayIndexRef.current;

					if (currentIndex < currentTarget.length) {
						// Calculate buffer size (how far behind we are)
						const bufferSize = currentTarget.length - currentIndex;

						// ADAPTIVE SPEED: Scale chars per frame based on buffer
						// - Buffer < 50 chars: use base speed (3 chars/frame = 180 chars/sec)
						// - Buffer 50-500 chars: linear scale up (3-15 chars/frame)
						// - Buffer > 500 chars: max speed (15 chars/frame = 900 chars/sec)
						//
						// This prevents "catching up" with ultra-fast providers while
						// maintaining smooth animation for normal speeds.
						let adaptiveChars = charsPerFrame;
						if (bufferSize > 50) {
							const scaleFactor = Math.min(
								(bufferSize - 50) / 450,
								1,
							);
							adaptiveChars = Math.round(
								charsPerFrame +
									(maxCharsPerFrame - charsPerFrame) *
										scaleFactor,
							);
						}

						// More text to reveal
						const nextIndex = Math.min(
							currentIndex + adaptiveChars,
							currentTarget.length,
						);
						displayIndexRef.current = nextIndex;
						setDisplayedText(currentTarget.slice(0, nextIndex));
					} else {
						setIsAnimating(false);
					}
				}

				// Keep animation running while enabled (streaming might add more text)
				rafIdRef.current = requestAnimationFrame(animate);
			};

			rafIdRef.current = requestAnimationFrame(animate);
		}
	}, [
		text,
		enabled,
		charsPerFrame,
		maxCharsPerFrame,
		frameInterval,
		displayedText,
	]);

	// Stop animation when disabled
	useEffect(() => {
		if (!enabled && rafIdRef.current !== null) {
			cancelAnimationFrame(rafIdRef.current);
			rafIdRef.current = null;
			setIsAnimating(false);
			// Ensure full text is shown
			setDisplayedText(targetTextRef.current);
			displayIndexRef.current = targetTextRef.current.length;
		}
	}, [enabled]);

	// Cleanup on unmount only
	useEffect(() => {
		return () => {
			if (rafIdRef.current !== null) {
				cancelAnimationFrame(rafIdRef.current);
				rafIdRef.current = null;
			}
		};
	}, []);

	return { displayedText, isAnimating };
}

interface TypingResponseProps {
	children: string;
	className?: string;
	/** Enable typing animation (default: true for new content) */
	animate?: boolean;
	/** Base characters to reveal per frame (default: 3, ~180 chars/sec) */
	charsPerFrame?: number;
	/** Maximum characters per frame when buffer is large (default: 15, ~900 chars/sec) */
	maxCharsPerFrame?: number;
	/** Target frames per second (default: 60) */
	targetFps?: number;
	/** Custom markdown components */
	components?: Record<string, any>;
	/**
	 * Normalize Unicode formatting to markdown (default: true).
	 * Converts Unicode bullets (•), decorative headers, etc. to proper markdown.
	 * Useful for reasoning models that output plain text with Unicode formatting.
	 */
	normalizeMarkdown?: boolean;
	streaming?: boolean;
}

/**
 * TypingResponse - Renders text with a smooth, adaptive typing animation
 *
 * This component creates the illusion of streaming by progressively revealing
 * text character by character, regardless of how the text arrives from the server.
 *
 * ADAPTIVE SPEED: For ultra-fast providers like Cerebras (1000+ tokens/sec),
 * the animation automatically speeds up when text arrives faster than it can
 * display, preventing the jarring "catch up" behavior.
 *
 * Speed ranges:
 * - Normal: 3 chars/frame @ 60fps = ~180 chars/sec (readable)
 * - Max: 15 chars/frame @ 60fps = ~900 chars/sec (for catching up)
 */
export const TypingResponse = memo(
	({
		children,
		className,
		animate = true,
		charsPerFrame = 3,
		maxCharsPerFrame = 15,
		targetFps = 60,
		components,
		normalizeMarkdown = true,
		streaming = false,
	}: TypingResponseProps) => {
		// Normalize text to convert Unicode formatting to markdown
		// This fixes rendering issues with reasoning models that output Unicode bullets, etc.
		const normalizedText = useMemo(() => {
			if (!normalizeMarkdown) {
				return children;
			}
			return normalizeTextToMarkdown(children);
		}, [children, normalizeMarkdown]);

		const { displayedText, isAnimating } = useTypingAnimation(
			normalizedText,
			{
				enabled: animate,
				charsPerFrame,
				maxCharsPerFrame,
				targetFps,
			},
		);

		return (
			<Streamdown
				className={getChatMarkdownClassName(className)}
				components={{ ...chatMarkdownComponents, ...components }}
				parseIncompleteMarkdown={streaming || isAnimating}
			>
				{displayedText}
			</Streamdown>
		);
	},
);

TypingResponse.displayName = "TypingResponse";
