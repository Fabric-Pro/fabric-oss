/** Superagent mark. Simple glyph — no official single-path SVG is published. */
export function SuperagentIcon({ className }: { className?: string }) {
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
			aria-label="Superagent"
		>
			<title>Superagent</title>
			<path d="M12 2 3 7v5c0 5 3.8 9.3 9 10 5.2-.7 9-5 9-10V7l-9-5Z" />
			<path d="m9 12 2 2 4-4" />
		</svg>
	);
}
