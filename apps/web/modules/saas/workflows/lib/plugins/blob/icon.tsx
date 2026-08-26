/** Blob mark. Simple glyph — no official single-path SVG is published. */
export function BlobIcon({ className }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			xmlns="http://www.w3.org/2000/svg"
			role="img"
			aria-label="Blob"
		>
			<title>Blob</title>
			<path d="M21 8v8a2 2 0 0 1-1 1.7l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.7l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8Z" />
			<path d="m3.3 7 8.7 5 8.7-5M12 22V12" />
		</svg>
	);
}
