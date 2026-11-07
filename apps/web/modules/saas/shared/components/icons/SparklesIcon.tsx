import type { SVGProps } from "react";

export function SparklesIcon(props: SVGProps<SVGSVGElement>) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width="1em"
			height="1em"
			viewBox="0 0 24 24"
			aria-hidden="true"
			{...props}
		>
			<text
				x="12"
				y="12"
				textAnchor="middle"
				dominantBaseline="central"
				fontSize="21"
				fill="currentColor"
			>
				🧞
			</text>
		</svg>
	);
}
