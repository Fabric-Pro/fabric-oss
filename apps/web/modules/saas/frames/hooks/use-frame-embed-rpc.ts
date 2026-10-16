"use client";

import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	type FrameEmbedToHostMessage,
	type FrameHostToEmbedMessage,
	isFrameEmbedToHostMessage,
	resolveEmbedOrigin,
} from "../lib/frame-embed-protocol";

const RPC_TIMEOUT_MS = 5000;
const MIN_FRAME_HEIGHT = 480;
const MAX_FRAME_HEIGHT = 12000;

/**
 * The shell's side of the embed it frames: what the embed reports about itself
 * (ready, its height, an error) and the requests the shell makes of it (export
 * the page as a PNG, show its code), each answered by id.
 *
 * Only the embed this shell framed may speak: a message counts when it comes
 * from the embed's origin *and* from one of the shell's own iframe windows.
 * Without both, any window holding a handle on this one - an opener, another
 * frame - could resize the frame or resolve a pending request with a payload of
 * its own.
 */
export function useFrameEmbedRpc({
	embedUrl,
	effectiveEmbedUrl,
	iframeRef,
	fullscreenIframeRef,
}: {
	/** Where the embed is served; its origin is the only one believed or answered. */
	embedUrl: string;
	/** The address the iframes load, which a slide number can change. */
	effectiveEmbedUrl: string;
	iframeRef: RefObject<HTMLIFrameElement | null>;
	fullscreenIframeRef: RefObject<HTMLIFrameElement | null>;
}) {
	const pendingRequestsRef = useRef(
		new Map<string, (message: FrameEmbedToHostMessage) => void>(),
	);
	const [frameHeight, setFrameHeight] = useState(720);
	const [iframeLoading, setIframeLoading] = useState(true);
	const [embedError, setEmbedError] = useState<string | null>(null);

	const embedWindows = useCallback(
		() => [
			iframeRef.current?.contentWindow,
			fullscreenIframeRef.current?.contentWindow,
		],
		[iframeRef, fullscreenIframeRef],
	);

	useEffect(() => {
		const expectedOrigin = resolveEmbedOrigin(embedUrl);

		const onMessage = (event: MessageEvent) => {
			if (
				event.origin !== expectedOrigin ||
				!event.source ||
				!embedWindows().some((candidate) => candidate === event.source)
			) {
				return;
			}
			if (!isFrameEmbedToHostMessage(event.data)) {
				return;
			}

			if (event.data.type === "fabric-frame:ready") {
				setIframeLoading(false);
				setEmbedError(null);
				return;
			}

			if (event.data.type === "fabric-frame:set-height") {
				const nextHeight = Number(event.data.height ?? 0);
				if (Number.isFinite(nextHeight) && nextHeight > 0) {
					setFrameHeight(
						Math.max(
							MIN_FRAME_HEIGHT,
							Math.min(nextHeight + 24, MAX_FRAME_HEIGHT),
						),
					);
					setIframeLoading(false);
				}
				return;
			}

			if (event.data.type === "fabric-frame:error") {
				setEmbedError(event.data.error);
				setIframeLoading(false);
				return;
			}

			if (
				event.data.type === "fabric-frame:export-png-result" ||
				event.data.type === "fabric-frame:display-code"
			) {
				const resolve = pendingRequestsRef.current.get(
					event.data.requestId,
				);
				if (resolve) {
					pendingRequestsRef.current.delete(event.data.requestId);
					resolve(event.data);
				}
			}
		};

		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [embedUrl, embedWindows]);

	useEffect(() => {
		setIframeLoading(true);
		setEmbedError(null);
	}, [effectiveEmbedUrl]);

	const requestFromEmbed = useCallback(
		(message: FrameHostToEmbedMessage) =>
			new Promise<FrameEmbedToHostMessage>((resolve, reject) => {
				const timeout = window.setTimeout(() => {
					pendingRequestsRef.current.delete(message.requestId);
					reject(new Error("Frame embed did not respond in time."));
				}, RPC_TIMEOUT_MS);

				pendingRequestsRef.current.set(
					message.requestId,
					(response) => {
						window.clearTimeout(timeout);
						resolve(response);
					},
				);
				iframeRef.current?.contentWindow?.postMessage(
					message,
					resolveEmbedOrigin(embedUrl),
				);
			}),
		[iframeRef, embedUrl],
	);

	/**
	 * After the iframe loads: stop the loading line shortly, and measure the
	 * embed's own document a few times as charts and fonts settle. The height the
	 * embed reports by message is the primary source; this is the fallback.
	 */
	const onEmbedLoad = useCallback(() => {
		window.setTimeout(() => setIframeLoading(false), 350);
		const iframe = iframeRef.current;
		if (!iframe) {
			return;
		}
		const measure = () => {
			try {
				const doc = iframe.contentDocument;
				if (!doc?.body) {
					return;
				}
				const html = doc.documentElement;
				const body = doc.body;
				const prevHtmlHeight = html.style.height;
				const prevBodyHeight = body.style.height;
				html.style.height = "auto";
				body.style.height = "auto";
				const height = Math.max(html.scrollHeight, body.scrollHeight);
				html.style.height = prevHtmlHeight;
				body.style.height = prevBodyHeight;
				if (height > 200) {
					setFrameHeight((previous) =>
						Math.max(previous, Math.min(height + 24, 6000)),
					);
				}
			} catch {
				// Cross-origin: the height the embed reports is all there is.
			}
		};
		for (const delay of [300, 900, 2000]) {
			window.setTimeout(measure, delay);
		}
	}, [iframeRef]);

	return {
		frameHeight,
		iframeLoading,
		embedError,
		embedWindows,
		requestFromEmbed,
		onEmbedLoad,
	};
}
