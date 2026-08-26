/**
 * ProviderIcon Component
 *
 * Displays a branded icon treatment for a data connection provider.
 */

"use client";

import { cn } from "@ui/lib";
import type { DataConnectionProvider } from "../lib/providers";

function GoogleDriveBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d="M7.71 3.5L1.15 15l3.43 5.97L11.14 9.46 7.71 3.5zm1.04 0l6.87 11.96H23l-3.43-5.98L13.58 3.5H8.75zm7.58 12.96H1.72L5.15 22.5h15.12l3.43-5.97-.01-.07H16.33z" />
		</svg>
	);
}

function DropboxBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d="M7.193 2.16 1.5 5.79l5.693 3.63 5.71-3.63-5.71-3.63Zm9.613 0-5.709 3.63 5.709 3.63 5.694-3.63-5.694-3.63ZM7.193 10.7 1.5 14.33l5.693 3.63 5.71-3.63-5.71-3.63Zm9.613 0-5.709 3.63 5.709 3.63 5.694-3.63-5.694-3.63ZM12 18.547l-4.807 3.06L12 24l4.807-2.393L12 18.547Z" />
		</svg>
	);
}

function CodaBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d="M8.4 3.2h7.2a1.6 1.6 0 0 1 1.6 1.6v3.6h-3.2V6.4H10v11.2h4V15.6h3.2v3.6a1.6 1.6 0 0 1-1.6 1.6H8.4a4.8 4.8 0 0 1 0-9.6h2v3.2h-2a1.6 1.6 0 0 0 0 3.2H6.8a4.8 4.8 0 0 1 0-9.6H8.4V3.2Z" />
		</svg>
	);
}

function GitBookBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d="M4 4.75A2.75 2.75 0 0 1 6.75 2h10.5A2.75 2.75 0 0 1 20 4.75v14.5A2.75 2.75 0 0 1 17.25 22H6.75A2.75 2.75 0 0 1 4 19.25V4.75Zm4.5 1.75v11h2.75c2.9 0 4.75-1.84 4.75-4.99 0-3.13-1.86-5.01-4.75-5.01H8.5Zm2.5 2.12h.24c1.55 0 2.5 1.08 2.5 2.89 0 1.82-.94 2.87-2.5 2.87H11V8.62Z" />
		</svg>
	);
}

export function NotionBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466l1.823 1.447zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.934zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952l1.448.327s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.14c-.093-.514.28-.887.747-.933l3.222-.187zM2.31.75l13.075-.933c1.588-.14 1.961-.047 2.942.654l4.063 2.84c.654.467.887.747.887 1.4v15.17c0 1.026-.373 1.634-1.68 1.727l-15.458.933c-.98.047-1.448-.093-1.962-.747L.654 18.773c-.56-.747-.794-1.307-.794-1.96V2.477C-.14 1.731.233.843 2.31.75z" />
		</svg>
	);
}

function ConfluenceBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d="M.87 18.257c-.248.382-.53.875-.763 1.245a.764.764 0 0 0 .255 1.04l4.965 3.054a.764.764 0 0 0 1.058-.26c.199-.332.454-.763.733-1.221 1.967-3.247 3.945-2.853 7.508-1.146l4.957 2.377a.764.764 0 0 0 1.028-.382l2.36-5.2a.765.765 0 0 0-.382-1.003c-1.04-.497-2.792-1.337-4.869-2.334-7.906-3.794-14.16-3.216-16.85 3.83zm22.26-12.514c.249-.382.531-.875.764-1.245a.764.764 0 0 0-.256-1.04L18.673.404a.764.764 0 0 0-1.058.26c-.199.332-.454.763-.733 1.221-1.967 3.247-3.945 2.853-7.508 1.146L4.417.654a.764.764 0 0 0-1.028.382L1.03 6.236a.765.765 0 0 0 .382 1.003c1.04.497 2.792 1.337 4.869 2.334 7.906 3.794 14.16 3.216 16.849-3.83z" />
		</svg>
	);
}

function SlackBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
		</svg>
	);
}

export function GitHubBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d="M12 0C5.373 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.565 21.797 24 17.3 24 12 24 5.373 18.627 0 12 0z" />
		</svg>
	);
}

export function GitLabBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d="M12 22.672 16.418 9.07H7.582L12 22.672Z" />
			<path d="M12 22.672 7.582 9.07H1.39L12 22.672Z" opacity="0.78" />
			<path
				d="M1.39 9.07.048 13.196a.917.917 0 0 0 .333 1.025L12 22.672 1.39 9.07Z"
				opacity="0.62"
			/>
			<path
				d="M1.39 9.07h6.192L4.92.874a.458.458 0 0 0-.87 0L1.39 9.07Z"
				opacity="0.86"
			/>
			<path d="M12 22.672 16.418 9.07h6.192L12 22.672Z" opacity="0.78" />
			<path
				d="M22.61 9.07l1.342 4.126a.917.917 0 0 1-.333 1.025L12 22.672 22.61 9.07Z"
				opacity="0.62"
			/>
			<path
				d="M22.61 9.07h-6.192L19.08.874a.458.458 0 0 1 .87 0l2.66 8.196Z"
				opacity="0.86"
			/>
		</svg>
	);
}

export function BitbucketBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d="M2.168 3.5c-.177 0-.307.164-.274.338l2.805 16.892c.03.181.186.314.368.314h13.866c.182 0 .338-.133.368-.314l2.805-16.892c.033-.174-.097-.338-.274-.338H2.168Zm12.186 10.913H9.647l-1.273 5.076h6.693l-.713-3.043Z" />
		</svg>
	);
}

function MicrosoftBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="none"
		>
			<rect x="2" y="2" width="9" height="9" rx="1.8" fill="#F25022" />
			<rect x="13" y="2" width="9" height="9" rx="1.8" fill="#7FBA00" />
			<rect x="2" y="13" width="9" height="9" rx="1.8" fill="#00A4EF" />
			<rect x="13" y="13" width="9" height="9" rx="1.8" fill="#FFB900" />
		</svg>
	);
}

export function JiraBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 32 32"
			fill="none"
		>
			<path
				d="M27.006 4H15.451c0 2.88 2.332 5.211 5.212 5.211h2.125v2.058c0 2.88 2.332 5.211 5.212 5.211V4.995A.995.995 0 0 0 27.006 4Z"
				fill="#2684FF"
			/>
			<path
				d="M21.28 9.76H9.726c0 2.88 2.332 5.211 5.212 5.211h2.125v2.058c0 2.88 2.332 5.211 5.212 5.211V10.755a.995.995 0 0 0-.995-.995Z"
				fill="url(#jira-grad-a)"
			/>
			<path
				d="M15.554 15.52H4c0 2.88 2.332 5.211 5.212 5.211h2.125v2.058c0 2.88 2.332 5.211 5.212 5.211V16.515a.995.995 0 0 0-.995-.995Z"
				fill="url(#jira-grad-b)"
			/>
			<defs>
				<linearGradient
					id="jira-grad-a"
					x1="22.034"
					y1="9.773"
					x2="17.118"
					y2="14.843"
					gradientUnits="userSpaceOnUse"
				>
					<stop offset="0.176" stopColor="#0052CC" />
					<stop offset="1" stopColor="#2684FF" />
				</linearGradient>
				<linearGradient
					id="jira-grad-b"
					x1="16.641"
					y1="15.564"
					x2="10.957"
					y2="21.094"
					gradientUnits="userSpaceOnUse"
				>
					<stop offset="0.176" stopColor="#0052CC" />
					<stop offset="1" stopColor="#2684FF" />
				</linearGradient>
			</defs>
		</svg>
	);
}

export function LinearBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 100 100"
			fill="currentColor"
		>
			<path d="M1.22541 61.5228c-.2225-.9485.90748-1.5459 1.59638-.857L38.4637 97.1782c.6889.6889.0915 1.8189-.857 1.5964C20.0515 94.4522 5.54779 79.9485 1.22541 61.5228zM.00189135 46.8891c-.01764375.2833.08887225.5599.28957275.7606L52.3503 99.7085c.2007.2007.4773.3075.7606.2896 2.3692-.1476 4.6938-.46 6.9624-.9259.7645-.157 1.0301-1.0963.4782-1.6481L2.57595 39.4485c-.55186-.5519-1.49117-.2863-1.648174.4782-.465915 2.2686-.779293 4.5932-.926819 6.9624zM4.71619 32.3058c-.2927.1431-.4855.4337-.4738.7665L66.9377 95.758c.3328.0117.6234-.1811.7665-.4738 1.1906-2.4361 2.1793-4.9676 2.9576-7.5813.1932-.6491-.0581-1.3448-.6372-1.6239L8.89425 29.3482c-.57913-.279-1.27482-.0277-1.62388.572-.77842 1.6106-1.47966 3.2575-2.55418 2.3856zM13.7855 19.2469l67.1127 67.1127c2.0044-1.6589 3.8874-3.4765 5.6282-5.4157.4085-.461.3927-1.1631-.0375-1.6114L20.2314 13.6094c-.4484-.4302-1.1504-.4461-1.6114-.0375-1.9392 1.7408-3.7568 3.6238-5.4157 5.6282-.0781.0943-.1351.1978-.1731.3076-.1809.5206.0571 1.0985.7543 1.1392zM25.4653 9.3894L90.6106 74.5347c1.2894-1.8894 2.4621-3.8559 3.5125-5.8925.2766-.5607.1167-1.2366-.381-1.6342L32.9252 5.8577c-.3975-.4977-1.0734-.6576-1.6342-.381-2.0366 1.0504-4.003 2.2231-5.8925 3.5125-.0929.0646-.1775.1405-.2525.228-.3799.4384-.3576 1.0946.2193 1.5702zM39.0535 2.08369C40.9988.891999 43.0128-.000072 45.0589.000003L99.9999 54.941c.0001 2.0461-.8918 4.0601-2.0836 6.0054-.5835.9655-1.8055 1.0729-2.3766.4888L38.5646 4.46025c-.5842-.57113-.4768-1.79314.4889-2.37656z" />
		</svg>
	);
}

function IntercomBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d="M19.882 0H4.118A4.12 4.12 0 0 0 0 4.118v15.764A4.12 4.12 0 0 0 4.118 24h15.764A4.12 4.12 0 0 0 24 19.882V4.118A4.12 4.12 0 0 0 19.882 0zm-1.7 15.3a.79.79 0 0 1-.79.79H6.608a.79.79 0 0 1 0-1.58h11.384a.79.79 0 0 1 .79.79zm0-3.3a.79.79 0 0 1-.79.79H6.608a.79.79 0 0 1 0-1.58h11.384a.79.79 0 0 1 .79.79zm0-3.3a.79.79 0 0 1-.79.79H6.608a.79.79 0 0 1 0-1.58h11.384a.79.79 0 0 1 .79.79z" />
		</svg>
	);
}

export function ZendeskBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 -30.5 256 256"
			fill="currentColor"
		>
			<path d="M118.249 51.233v142.773H0L118.249 51.233ZM118.249 0c0 32.644-26.48 59.125-59.125 59.125S0 32.644 0 0h118.249ZM137.751 194.006c0-32.677 26.448-59.125 59.125-59.125 32.676 0 59.124 26.448 59.124 59.125H137.751ZM137.751 142.74V0H256L137.751 142.74Z" />
		</svg>
	);
}

function SnowflakeBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d="M22.638 13.553l-1.88-1.085 1.234-.329a.75.75 0 0 0-.386-1.448l-2.692.718-2.597-1.5 2.597-1.5 2.692.718a.75.75 0 1 0 .386-1.448l-1.234-.33 1.88-1.085a.75.75 0 1 0-.748-1.298l-1.88 1.085.33-1.234a.75.75 0 1 0-1.449-.386l-.718 2.692L16.5 8.423V5.227l1.973-1.973a.75.75 0 0 0-1.06-1.06L16.5 3.106V1a.75.75 0 0 0-1.5 0v2.106l-.913-.912a.75.75 0 0 0-1.06 1.06L15 5.227v3.196l-2.75-1.587V3.77l1.28-1.281a.75.75 0 1 0-1.06-1.06L12 1.898V.75a.75.75 0 0 0-1.5 0v1.148l-.47-.47a.75.75 0 1 0-1.06 1.061l1.28 1.28v3.067L7.5 9.424V6.228l1.973-1.974a.75.75 0 0 0-1.06-1.06L7.5 4.106V2a.75.75 0 0 0-1.5 0v2.106l-.912-.913a.75.75 0 0 0-1.061 1.06L6 6.228v3.196L3.403 7.836l-.718-2.692a.75.75 0 1 0-1.448.386l.33 1.234L-.314 5.679a.75.75 0 1 0-.748 1.298l1.88 1.085-1.234.33a.75.75 0 0 0 .386 1.448l2.692-.718L5.26 10.71 2.662 12.21l-2.692-.718a.75.75 0 0 0-.386 1.448l1.234.33-1.88 1.085a.75.75 0 1 0 .748 1.298l1.88-1.085-.33 1.234a.75.75 0 1 0 1.449.386l.718-2.692L6 11.91v3.196l-1.974 1.973a.75.75 0 1 0 1.061 1.06L6 17.228v2.106a.75.75 0 0 0 1.5 0v-2.106l.913.913a.75.75 0 1 0 1.06-1.061L7.5 15.107v-3.197l2.75 1.588v3.066l-1.28 1.281a.75.75 0 1 0 1.06 1.06l.47-.469v1.148a.75.75 0 0 0 1.5 0v-1.148l.47.47a.75.75 0 1 0 1.06-1.061l-1.28-1.28V13.5L15 11.91v3.197l-1.414 1.414a.75.75 0 1 0 1.06 1.06l.855-.854v2.107a.75.75 0 0 0 1.5 0v-2.107l.912.913a.75.75 0 1 0 1.061-1.06L17.06 15.1v-3.196l2.597 1.5.718 2.692a.75.75 0 1 0 1.448-.386l-.33-1.234 1.88 1.085a.75.75 0 1 0 .748-1.298l.001-.005z" />
		</svg>
	);
}

function BigQueryBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d="M5.676 10.595h2.052v5.244a5.892 5.892 0 0 1-2.052-2.088v-3.156zm18.179 10.836a.504.504 0 0 1 0 .708l-1.716 1.716a.504.504 0 0 1-.708 0l-4.248-4.248a.206.206 0 0 1-.007-.007c-.02-.02-.028-.045-.043-.066a10.736 10.736 0 0 1-6.334 2.065C4.835 21.599 0 16.764 0 10.799S4.835 0 10.8 0s10.799 4.835 10.799 10.8c0 2.369-.772 4.553-2.066 6.333.025.017.052.028.074.05l4.248 4.248zm-5.028-10.632a8.015 8.015 0 1 0-8.028 8.028h.024a8.016 8.016 0 0 0 8.004-8.028zm-4.86 4.98a6.002 6.002 0 0 0 2.04-2.184v-1.764h-2.04v3.948zm-4.5.948c.442.057.887.08 1.332.072.4.025.8.025 1.2 0V7.692H9.468v9.035z" />
		</svg>
	);
}

function S3BrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d="M11.515.567a1 1 0 0 1 .97 0l8.25 4.619a1 1 0 0 1 .515.873v11.882a1 1 0 0 1-.515.873l-8.25 4.619a1 1 0 0 1-.97 0l-8.25-4.619A1 1 0 0 1 3 17.94V6.06a1 1 0 0 1 .515-.873ZM12 2.587 5.03 6.49 12 10.394l6.97-3.904Zm7.25 5.601-6.75 3.78v9.264l6.75-3.78Zm-14.5 0v9.264l6.75 3.78v-9.264Z" />
		</svg>
	);
}

function GoogleStorageBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="none"
		>
			<path
				d="M7.5 3.5A3.5 3.5 0 0 0 4 7v10a3.5 3.5 0 0 0 3.5 3.5h9A3.5 3.5 0 0 0 20 17V9.75a2.75 2.75 0 0 0-.805-1.945l-3-3A2.75 2.75 0 0 0 14.25 4h-6.75Z"
				fill="#4285F4"
			/>
			<path
				d="M15 4.2v3.05c0 .414.336.75.75.75h3.05L15 4.2Z"
				fill="#AECBFA"
			/>
			<path
				d="M8.25 12.75a3.75 3.75 0 0 1 6.953-1.955 2.5 2.5 0 1 1 .547 4.939H8.75a2.75 2.75 0 0 1-.5-5.455Z"
				fill="#34A853"
			/>
			<path
				d="M8.75 15.734h4.2a2.3 2.3 0 0 0 0-4.6c-.777 0-1.462.388-1.88.98a1.95 1.95 0 1 0-2.32 3.62Z"
				fill="#FBBC04"
			/>
		</svg>
	);
}

function R2BrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="none"
		>
			<path
				d="M6 6.75c0-1.519 1.231-2.75 2.75-2.75h6.5A2.75 2.75 0 0 1 18 6.75v10.5A2.75 2.75 0 0 1 15.25 20h-6.5A2.75 2.75 0 0 1 6 17.25V6.75Z"
				fill="#F38020"
			/>
			<path
				d="M9.2 8.5h4.4a2.1 2.1 0 1 1 0 4.2H12.6l2.424 2.424a.8.8 0 1 1-1.132 1.132L10.336 12.7H9.2v2.756a.8.8 0 1 1-1.6 0V9.3a.8.8 0 0 1 .8-.8Zm0 2.6v.001h4.4a.5.5 0 1 0 0-1H9.2v.999Z"
				fill="white"
			/>
		</svg>
	);
}

function AirtableBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="none"
		>
			<path
				d="M10.93 1.35 2.54 4.6c-.73.28-.79 1.3-.1 1.68l8.37 4.48a2.5 2.5 0 0 0 2.38.08l8.9-4.43c.73-.36.7-1.41-.05-1.73L13.37 1.3a3.27 3.27 0 0 0-2.44.05Z"
				fill="#FCB400"
			/>
			<path
				d="m13.73 12.16 1.4 6.99c.12.6.76.93 1.31.67l5.22-2.46a1 1 0 0 0 .57-.99l-.5-7.54c-.04-.67-.75-1.08-1.35-.8l-6.11 2.91a1 1 0 0 0-.54 1.12Z"
				fill="#18BFFF"
			/>
			<path
				d="M10.8 12.73.96 7.58A.66.66 0 0 0 0 8.17v7.2c0 .36.2.68.52.84l9.84 5.15c.44.23.96-.09.96-.59v-7.2a.94.94 0 0 0-.52-.84Z"
				fill="#F82B60"
			/>
		</svg>
	);
}

function SalesforceBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d="M10.006 5.415a4.195 4.195 0 013.045-1.306c1.56 0 2.954.9 3.69 2.205.63-.3 1.35-.45 2.1-.45 2.85 0 5.159 2.34 5.159 5.22s-2.31 5.22-5.176 5.22c-.345 0-.69-.044-1.02-.104a3.75 3.75 0 01-3.3 1.95c-.6 0-1.155-.15-1.65-.375A4.314 4.314 0 018.88 20.4a4.302 4.302 0 01-4.05-2.82c-.27.062-.54.076-.825.076-2.204 0-4.005-1.8-4.005-4.05 0-1.5.811-2.805 2.01-3.51-.255-.57-.39-1.2-.39-1.846 0-2.58 2.1-4.65 4.65-4.65 1.53 0 2.85.705 3.72 1.8" />
		</svg>
	);
}

function HubSpotBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d="M18.164 7.93V5.084a2.198 2.198 0 001.267-1.978v-.067A2.2 2.2 0 0017.238.845h-.067a2.2 2.2 0 00-2.193 2.193v.067a2.196 2.196 0 001.252 1.973l.013.006v2.852a6.22 6.22 0 00-2.969 1.31l.012-.01-7.828-6.095A2.497 2.497 0 104.3 4.656l-.012.006 7.697 5.991a6.176 6.176 0 00-1.038 3.446c0 1.343.425 2.588 1.147 3.607l-.013-.02-2.342 2.343a1.968 1.968 0 00-.58-.095h-.002a2.033 2.033 0 102.033 2.033 1.978 1.978 0 00-.1-.595l.005.014 2.317-2.317a6.247 6.247 0 104.782-11.134l-.036-.005zm-.964 9.378a3.206 3.206 0 113.215-3.207v.002a3.206 3.206 0 01-3.207 3.207z" />
		</svg>
	);
}

function GongBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="none"
		>
			<rect
				x="1.5"
				y="7"
				width="4.5"
				height="10"
				rx="2.25"
				fill="currentColor"
			/>
			<rect
				x="9.75"
				y="3"
				width="4.5"
				height="18"
				rx="2.25"
				fill="currentColor"
			/>
			<rect
				x="18"
				y="7"
				width="4.5"
				height="10"
				rx="2.25"
				fill="currentColor"
			/>
		</svg>
	);
}

function GmailBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z" />
		</svg>
	);
}

function TeamsBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="none"
		>
			<path
				d="M15.5 5.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"
				fill="#7B83EB"
			/>
			<path
				d="M19.5 7.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5Z"
				fill="#4F58CA"
			/>
			<path
				d="M13.5 7H6.25A2.25 2.25 0 0 0 4 9.25v7.5A2.25 2.25 0 0 0 6.25 19h7.5A2.25 2.25 0 0 0 16 16.75v-7.5A2.25 2.25 0 0 0 13.75 7H13.5Z"
				fill="#505AC9"
			/>
			<path d="M8 10.2v1.6h1.8V17h2v-5.2h1.8v-1.6H8Z" fill="white" />
			<path
				d="M17 8.5h3A2 2 0 0 1 22 10.5v5A2.5 2.5 0 0 1 19.5 18H17V8.5Z"
				fill="#7B83EB"
			/>
		</svg>
	);
}

export function AsanaBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
		>
			<path d="M17.4 13.5a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Zm-10.8 0a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Zm5.4-10.2a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z" />
		</svg>
	);
}

export function ClickUpBrandIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="none"
		>
			<path
				d="M5.114 18.52a1 1 0 0 1 .106-1.41l4.913-4.227a1 1 0 0 1 1.34.028l3.218 2.975 4.073-4.467a1 1 0 1 1 1.477 1.348l-4.752 5.21a1 1 0 0 1-1.417.071l-3.297-3.048-4.251 3.658a1 1 0 0 1-1.41-.108Z"
				fill="url(#clickup-gradient-1)"
			/>
			<path
				d="M7.224 9.376a1 1 0 0 1 .674-1.742h8.204a1 1 0 0 1 .674 1.742l-3.875 3.47a1.35 1.35 0 0 1-1.802 0l-3.875-3.47Z"
				fill="url(#clickup-gradient-2)"
			/>
			<defs>
				<linearGradient
					id="clickup-gradient-1"
					x1="4.625"
					y1="17.536"
					x2="19.617"
					y2="17.536"
					gradientUnits="userSpaceOnUse"
				>
					<stop stopColor="#8930FD" />
					<stop offset="1" stopColor="#49CCF9" />
				</linearGradient>
				<linearGradient
					id="clickup-gradient-2"
					x1="7.148"
					y1="10.24"
					x2="16.852"
					y2="10.24"
					gradientUnits="userSpaceOnUse"
				>
					<stop stopColor="#FF02F0" />
					<stop offset="1" stopColor="#FFBA1A" />
				</linearGradient>
			</defs>
		</svg>
	);
}

type IconEntry =
	| { type: "svg"; component: React.ComponentType<{ className?: string }> }
	| { type: "img"; src: string; alt: string };

const PROVIDER_ICONS: Record<DataConnectionProvider, IconEntry> = {
	GOOGLE_DRIVE: { type: "svg", component: GoogleDriveBrandIcon },
	S3: { type: "svg", component: S3BrandIcon },
	GOOGLE_STORAGE: { type: "svg", component: GoogleStorageBrandIcon },
	R2: { type: "svg", component: R2BrandIcon },
	DROPBOX: { type: "svg", component: DropboxBrandIcon },
	AIRTABLE: { type: "svg", component: AirtableBrandIcon },
	CODA: { type: "svg", component: CodaBrandIcon },
	GITBOOK: { type: "svg", component: GitBookBrandIcon },
	NOTION: { type: "svg", component: NotionBrandIcon },
	CONFLUENCE: { type: "svg", component: ConfluenceBrandIcon },
	TEAMS: { type: "svg", component: TeamsBrandIcon },
	INTERCOM: { type: "svg", component: IntercomBrandIcon },
	GITHUB: { type: "svg", component: GitHubBrandIcon },
	GITLAB: { type: "svg", component: GitLabBrandIcon },
	BITBUCKET: { type: "svg", component: BitbucketBrandIcon },
	SLACK: { type: "svg", component: SlackBrandIcon },
	SNOWFLAKE: { type: "svg", component: SnowflakeBrandIcon },
	BIGQUERY: { type: "svg", component: BigQueryBrandIcon },
	ZENDESK: { type: "svg", component: ZendeskBrandIcon },
	GONG: { type: "svg", component: GongBrandIcon },
	GMAIL: { type: "svg", component: GmailBrandIcon },
	MICROSOFT_365: { type: "svg", component: MicrosoftBrandIcon },
	SALESFORCE: { type: "svg", component: SalesforceBrandIcon },
	HUBSPOT: { type: "svg", component: HubSpotBrandIcon },
	JIRA: { type: "svg", component: JiraBrandIcon },
	LINEAR: { type: "svg", component: LinearBrandIcon },
	ASANA: { type: "svg", component: AsanaBrandIcon },
	CLICKUP: { type: "svg", component: ClickUpBrandIcon },
};

const PROVIDER_COLORS: Record<DataConnectionProvider, string> = {
	GOOGLE_DRIVE: "bg-background text-[#0F9D58] ring-1 ring-border/60",
	S3: "bg-background text-[#FF9900] ring-1 ring-border/60",
	GOOGLE_STORAGE: "bg-background text-[#4285F4] ring-1 ring-border/60",
	R2: "bg-background text-[#F38020] ring-1 ring-border/60",
	DROPBOX: "bg-background text-[#0061FF] ring-1 ring-border/60",
	AIRTABLE: "bg-background text-[#F59E0B] ring-1 ring-border/60",
	CODA: "bg-background text-[#F45D01] ring-1 ring-border/60",
	GITBOOK:
		"bg-background text-[#111827] ring-1 ring-border/60 dark:bg-zinc-100 dark:text-[#111827]",
	NOTION: "bg-white text-[#111111] ring-1 ring-border/60 dark:bg-zinc-100 dark:text-[#111111]",
	CONFLUENCE: "bg-background text-[#1868DB] ring-1 ring-border/60",
	TEAMS: "bg-background text-[#5B5FC7] ring-1 ring-border/60",
	INTERCOM: "bg-background text-[#286EFA] ring-1 ring-border/60",
	GITHUB: "bg-white text-[#111827] ring-1 ring-border/60 dark:bg-zinc-100 dark:text-[#111827]",
	GITLAB: "bg-background text-[#FC6D26] ring-1 ring-border/60",
	BITBUCKET: "bg-background text-[#0052CC] ring-1 ring-border/60",
	SLACK: "bg-background text-[#611F69] ring-1 ring-border/60 dark:text-violet-300",
	SNOWFLAKE: "bg-background text-[#29B5E8] ring-1 ring-border/60",
	BIGQUERY: "bg-background text-[#4285F4] ring-1 ring-border/60",
	ZENDESK:
		"bg-background text-[#03363D] ring-1 ring-border/60 dark:bg-zinc-100 dark:text-[#03363D]",
	GONG: "bg-background text-[#1B4BF5] ring-1 ring-border/60",
	GMAIL: "bg-background text-[#EA4335] ring-1 ring-border/60",
	MICROSOFT_365: "bg-background text-foreground ring-1 ring-border/60",
	SALESFORCE: "bg-background text-[#00A1E0] ring-1 ring-border/60",
	HUBSPOT: "bg-background text-[#FF7A59] ring-1 ring-border/60",
	JIRA: "bg-background ring-1 ring-border/60",
	LINEAR: "bg-background text-[#5E6AD2] ring-1 ring-border/60",
	ASANA: "bg-background text-[#F06A6A] ring-1 ring-border/60",
	CLICKUP: "bg-background text-[#7C3AED] ring-1 ring-border/60",
};

interface ProviderIconProps {
	provider: DataConnectionProvider;
	size?: "sm" | "md" | "lg";
	className?: string;
}

const SIZE_CLASSES = {
	sm: "h-9 w-9",
	md: "h-11 w-11",
	lg: "h-12 w-12",
};

const ICON_SIZE_CLASSES = {
	sm: "h-5 w-5",
	md: "h-6 w-6",
	lg: "h-7 w-7",
};

export function ProviderIcon({
	provider,
	size = "md",
	className,
}: ProviderIconProps) {
	const entry = PROVIDER_ICONS[provider];
	const colorClass = PROVIDER_COLORS[provider];
	const sizeClass = SIZE_CLASSES[size];
	const iconSizeClass = ICON_SIZE_CLASSES[size];

	return (
		<div
			className={cn(
				"flex shrink-0 items-center justify-center rounded-xl shadow-sm",
				sizeClass,
				colorClass,
				className,
			)}
		>
			{entry.type === "img" ? (
				// biome-ignore lint/performance/noImgElement: provider icons use dynamic external URLs
				<img
					src={entry.src}
					alt={entry.alt}
					className={cn(iconSizeClass, "object-contain")}
					aria-hidden="true"
				/>
			) : (
				<div className="flex h-full w-full items-center justify-center p-2">
					<entry.component
						className={cn(iconSizeClass, "shrink-0")}
					/>
				</div>
			)}
		</div>
	);
}
