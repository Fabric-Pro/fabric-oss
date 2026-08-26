import type { SVGProps } from "react";

export function PuzzleIcon(props: SVGProps<SVGSVGElement>) {
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
			<path
				fill="currentColor"
				d="M8 4a3 3 0 1 1 5.83 1H18a1 1 0 0 1 1 1v4.17a3 3 0 1 1 0 5.659V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4.17C8.06 4.687 8 4.35 8 4Z"
			/>
		</svg>
	);
}
