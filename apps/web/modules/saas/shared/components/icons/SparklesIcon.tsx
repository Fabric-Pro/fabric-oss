import { type SVGProps, useId } from "react";

/**
 * Databricks Genie lamp + 4-point sparkle icon with the signature
 * blue → violet → coral-red gradient.
 */
export function SparklesIcon(props: SVGProps<SVGSVGElement>) {
	const rawId = useId();
	const gradientId = `genie-grad-${rawId.replace(/:/g, "")}`;

	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="1em"
			height="1em"
			fill="none"
			viewBox="0 0 24 24"
			aria-hidden="true"
			{...props}
		>
			<defs>
				<linearGradient
					id={gradientId}
					x1="3"
					y1="4"
					x2="21"
					y2="20"
					gradientUnits="userSpaceOnUse"
				>
					<stop offset="0%" stopColor="#4285F4" />
					<stop offset="48%" stopColor="#A855F7" />
					<stop offset="100%" stopColor="#FF5F46" />
				</linearGradient>
			</defs>
			{/* Top 4-point Genie sparkle star */}
			<path
				d="M12.5 2.5C12.9 5.1 14.1 6.3 16.7 6.7C14.1 7.1 12.9 8.3 12.5 10.9C12.1 8.3 10.9 7.1 8.3 6.7C10.9 6.3 12.1 5.1 12.5 2.5Z"
				fill={`url(#${gradientId})`}
				stroke={`url(#${gradientId})`}
				strokeWidth={1.6}
				strokeLinejoin="round"
			/>
			{/* Curved Genie lamp handle, bowl, and spout */}
			<path
				d="M4.5 14.8V12A1.85 1.85 0 0 1 8.2 11.6C9.1 15.2 10.8 16.4 12.5 16.4C14.2 16.4 16.1 14.8 17.2 10.8H20.8"
				stroke={`url(#${gradientId})`}
				strokeWidth={2.4}
				strokeLinecap="butt"
				strokeLinejoin="round"
			/>
			{/* Lamp base bar */}
			<rect
				x="9.2"
				y="19"
				width="6.6"
				height="2.4"
				rx="0.4"
				fill={`url(#${gradientId})`}
			/>
		</svg>
	);
}
