/**
 * NHTSA VPIC Icon
 * Custom SVG car icon with proper dark mode support.
 * Uses currentColor for the main shape and contrasting fill for inner details.
 */
export function NhtsaVpicIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-label="NHTSA Vehicle Data"
			className={className}
			viewBox="0 0 24 24"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
		>
			<title>NHTSA Vehicle Data</title>
			{/* Car body */}
			<path
				d="M3 13h18v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5Z"
				fill="currentColor"
			/>
			{/* Car roof / windshield */}
			<path
				d="M5.5 13 7.5 8a1 1 0 0 1 .9-.6h7.2a1 1 0 0 1 .9.6l2 5H5.5Z"
				fill="currentColor"
			/>
			{/* Windshield detail */}
			<path
				d="M7.2 12.2 8.8 8.8h6.4l1.6 3.4H7.2Z"
				className="fill-white dark:fill-slate-900"
			/>
			{/* Wheels */}
			<circle cx="7.5" cy="18" r="1.8" fill="currentColor" />
			<circle cx="16.5" cy="18" r="1.8" fill="currentColor" />
			<circle
				cx="7.5"
				cy="18"
				r="0.8"
				className="fill-white dark:fill-slate-900"
			/>
			<circle
				cx="16.5"
				cy="18"
				r="0.8"
				className="fill-white dark:fill-slate-900"
			/>
			{/* Headlights */}
			<rect
				x="3"
				y="13.5"
				width="1.5"
				height="1"
				rx="0.3"
				className="fill-white dark:fill-slate-900"
			/>
			<rect
				x="19.5"
				y="13.5"
				width="1.5"
				height="1"
				rx="0.3"
				className="fill-white dark:fill-slate-900"
			/>
		</svg>
	);
}
