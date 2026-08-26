"use client";

import { X } from "lucide-react";
import {
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";

interface ImageLightboxProps {
	/** URL of the image to display */
	src: string;
	/** Alt text for the image */
	alt: string;
	/** All image sources in the document for multi-image navigation */
	images?: Array<{ src: string; alt: string }>;
	/** Index of the current image in the images array */
	currentIndex?: number;
	/** Called when the lightbox should close */
	onClose: () => void;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.3;

/**
 * Full-screen image lightbox overlay.
 *
 * Features:
 * - Zoom via scroll wheel
 * - Pan via drag when zoomed in
 * - Keyboard navigation: Escape to close, arrow keys for multi-image
 * - Focus trap within lightbox
 * - Screen reader announces "Image lightbox" on open
 * - motion-safe transitions for entrance/exit
 *
 * Accessibility:
 * - role="dialog" with aria-modal
 * - aria-label on close button
 * - Focus trapped inside the lightbox
 * - Reduced motion preferences respected
 */
export function ImageLightbox({
	src,
	alt,
	images,
	currentIndex = 0,
	onClose,
}: ImageLightboxProps) {
	const [zoom, setZoom] = useState(MIN_ZOOM);
	const [pan, setPan] = useState({ x: 0, y: 0 });
	const [isDragging, setIsDragging] = useState(false);
	const [activeIndex, setActiveIndex] = useState(currentIndex);
	const [isVisible, setIsVisible] = useState(false);

	const dragStartRef = useRef({ x: 0, y: 0 });
	const panStartRef = useRef({ x: 0, y: 0 });
	const containerRef = useRef<HTMLDivElement>(null);
	const closeButtonRef = useRef<HTMLButtonElement>(null);

	const activeSrc = images?.[activeIndex]?.src ?? src;
	const activeAlt = images?.[activeIndex]?.alt ?? alt;
	const hasMultiple = images && images.length > 1;

	// Entrance animation
	useEffect(() => {
		// Small delay to trigger CSS transition
		const raf = requestAnimationFrame(() => setIsVisible(true));
		return () => cancelAnimationFrame(raf);
	}, []);

	// Focus trap and keyboard navigation
	useEffect(() => {
		closeButtonRef.current?.focus();

		const handleKeyDown = (e: KeyboardEvent) => {
			switch (e.key) {
				case "Escape":
					handleClose();
					break;
				case "ArrowLeft":
					if (hasMultiple) {
						e.preventDefault();
						setActiveIndex((prev) =>
							prev > 0 ? prev - 1 : (images?.length ?? 1) - 1,
						);
						resetView();
					}
					break;
				case "ArrowRight":
					if (hasMultiple) {
						e.preventDefault();
						setActiveIndex((prev) =>
							prev < (images?.length ?? 1) - 1 ? prev + 1 : 0,
						);
						resetView();
					}
					break;
				case "Tab":
					// Focus trap: keep focus within the lightbox
					e.preventDefault();
					closeButtonRef.current?.focus();
					break;
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [hasMultiple, images?.length]);

	const resetView = useCallback(() => {
		setZoom(MIN_ZOOM);
		setPan({ x: 0, y: 0 });
	}, []);

	const handleClose = useCallback(() => {
		setIsVisible(false);
		// Wait for exit transition
		setTimeout(onClose, 200);
	}, [onClose]);

	// Zoom via scroll wheel
	const handleWheel = useCallback((e: React.WheelEvent) => {
		e.preventDefault();
		const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
		setZoom((prev) => {
			const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev + delta));
			// Reset pan when zooming back to 1x
			if (next <= MIN_ZOOM) {
				setPan({ x: 0, y: 0 });
			}
			return next;
		});
	}, []);

	// Pan via drag when zoomed
	const handleMouseDown = useCallback(
		(e: ReactMouseEvent) => {
			if (zoom <= MIN_ZOOM) {
				return;
			}
			e.preventDefault();
			setIsDragging(true);
			dragStartRef.current = { x: e.clientX, y: e.clientY };
			panStartRef.current = { ...pan };
		},
		[zoom, pan],
	);

	const handleMouseMove = useCallback(
		(e: ReactMouseEvent) => {
			if (!isDragging) {
				return;
			}
			const dx = e.clientX - dragStartRef.current.x;
			const dy = e.clientY - dragStartRef.current.y;
			setPan({
				x: panStartRef.current.x + dx,
				y: panStartRef.current.y + dy,
			});
		},
		[isDragging],
	);

	const handleMouseUp = useCallback(() => {
		setIsDragging(false);
	}, []);

	// Close on overlay click (not on image)
	const handleOverlayClick = useCallback(
		(e: ReactMouseEvent) => {
			if (e.target === e.currentTarget) {
				handleClose();
			}
		},
		[handleClose],
	);

	const lightbox = (
		<div
			ref={containerRef}
			role="dialog"
			aria-modal="true"
			aria-label="Image lightbox"
			className={`fixed inset-0 z-50 flex items-center justify-center transition-opacity duration-200 ${
				isVisible ? "opacity-100" : "opacity-0"
			}`}
			style={{ willChange: "opacity" }}
			onWheel={handleWheel}
			onMouseMove={handleMouseMove}
			onMouseUp={handleMouseUp}
			onMouseLeave={handleMouseUp}
		>
			{/* Semi-transparent dark overlay */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: overlay click handled with keyboard via Escape */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: overlay is a dismissal target, not interactive content */}
			<div
				className="absolute inset-0 bg-black/80"
				onClick={handleOverlayClick}
			/>

			{/* Close button */}
			<button
				ref={closeButtonRef}
				type="button"
				className="absolute top-4 right-4 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-black/50 text-white transition-colors duration-150 hover:bg-black/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
				aria-label="Close lightbox"
				onClick={handleClose}
			>
				<X className="h-5 w-5" />
			</button>

			{/* Navigation arrows for multi-image */}
			{hasMultiple && (
				<>
					<button
						type="button"
						className="absolute left-4 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-black/50 text-white transition-colors duration-150 hover:bg-black/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
						aria-label="Previous image"
						onClick={() => {
							setActiveIndex((prev) =>
								prev > 0 ? prev - 1 : (images?.length ?? 1) - 1,
							);
							resetView();
						}}
					>
						<span className="text-lg" aria-hidden="true">
							&#8592;
						</span>
					</button>
					<button
						type="button"
						className="absolute right-4 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-black/50 text-white transition-colors duration-150 hover:bg-black/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
						aria-label="Next image"
						onClick={() => {
							setActiveIndex((prev) =>
								prev < (images?.length ?? 1) - 1 ? prev + 1 : 0,
							);
							resetView();
						}}
					>
						<span className="text-lg" aria-hidden="true">
							&#8594;
						</span>
					</button>
				</>
			)}

			{/* Image counter */}
			{hasMultiple && (
				<div
					className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 rounded-full bg-black/50 px-3 py-1 text-sm text-white"
					aria-live="polite"
				>
					{activeIndex + 1} / {images.length}
				</div>
			)}

			{/* Image container */}
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: click prevents propagation only, not interactive */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: drag-to-pan container, keyboard alternative via arrow keys */}
			<div
				className={`relative z-[1] select-none ${isDragging ? "cursor-grabbing" : zoom > MIN_ZOOM ? "cursor-grab" : "cursor-default"}`}
				style={{
					transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
					willChange: "transform",
				}}
				onMouseDown={handleMouseDown}
				onClick={(e) => e.stopPropagation()}
			>
				{/* biome-ignore lint/performance/noImgElement: lightbox displays external/S3 URLs that cannot use next/image optimization */}
				<img
					src={activeSrc}
					alt={activeAlt}
					className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain motion-safe:transition-transform motion-safe:duration-200"
					draggable={false}
				/>
			</div>
		</div>
	);

	// Portal to document body to avoid z-index issues
	if (typeof window === "undefined") {
		return null;
	}
	return createPortal(lightbox, document.body);
}
