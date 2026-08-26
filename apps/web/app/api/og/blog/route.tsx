import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";

export const runtime = "edge";

export async function GET(request: NextRequest) {
	const { searchParams } = request.nextUrl;
	const title = searchParams.get("title") || "Fabric AI Blog";
	const tagsParam = searchParams.get("tags") || "";
	const tags = tagsParam ? tagsParam.split(",").slice(0, 4) : [];

	return new ImageResponse(
		<div
			style={{
				width: "100%",
				height: "100%",
				display: "flex",
				flexDirection: "column",
				backgroundColor: "#0f0f0e",
				fontFamily: "system-ui, sans-serif",
				position: "relative",
				overflow: "hidden",
			}}
		>
			{/* Dot grid */}
			<div
				style={{
					position: "absolute",
					inset: 0,
					backgroundImage:
						"radial-gradient(circle, rgba(255,255,255,0.07) 1px, transparent 1px)",
					backgroundSize: "32px 32px",
					display: "flex",
				}}
			/>

			{/* Radial glow top-left */}
			<div
				style={{
					position: "absolute",
					top: -80,
					left: -80,
					width: 420,
					height: 420,
					borderRadius: "50%",
					background:
						"radial-gradient(circle, rgba(234,88,12,0.18) 0%, transparent 70%)",
					display: "flex",
				}}
			/>

			<div
				style={{
					position: "relative",
					display: "flex",
					flexDirection: "column",
					justifyContent: "space-between",
					height: "100%",
					padding: "52px 60px 48px",
				}}
			>
				{/* Top: logo */}
				<div style={{ display: "flex", alignItems: "center", gap: 14 }}>
					<div
						style={{
							width: 44,
							height: 44,
							borderRadius: 8,
							border: "1.5px solid rgba(234,88,12,0.4)",
							background: "rgba(234,88,12,0.12)",
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
						}}
					>
						<svg
							width="24"
							height="30"
							viewBox="0 0 180 220"
							fill="none"
						>
							<title>Fabric logo</title>
							<path
								fill="#ea580c"
								d="M115.14,219.89h-21v-87.3c.028-21.221,17.239-38.41,38.46-38.41h7v21h-7c-9.634.011-17.443,7.816-17.46,17.45v87.26Z"
							/>
							<path
								fill="#ea580c"
								d="M83,181.48h-20.93v-53.08c.044-36.62,29.72-66.296,66.34-66.34h26.59v20.94h-26.59c-25.068.017-45.388,20.332-45.41,45.4v53.08Z"
							/>
							<path
								fill="#ea580c"
								d="M50.9,143.07h-20.9v-18.86c.061-52.039,42.231-94.209,94.27-94.27h46.09v21h-46.14c-40.456.044-73.248,32.814-73.32,73.27v18.86Z"
							/>
						</svg>
					</div>
					<span
						style={{
							fontSize: 26,
							fontWeight: 600,
							color: "#f5f0eb",
							letterSpacing: "-0.02em",
						}}
					>
						Fabric
					</span>
					<span
						style={{
							fontSize: 14,
							color: "#6b7280",
							marginLeft: 4,
							letterSpacing: "0.15em",
							textTransform: "uppercase",
						}}
					>
						Blog
					</span>
				</div>

				{/* Center: title */}
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						gap: 24,
					}}
				>
					{/* Editorial label */}
					<div
						style={{
							display: "flex",
							alignItems: "center",
							gap: 10,
						}}
					>
						<div
							style={{
								width: 3,
								height: 16,
								borderRadius: 2,
								background: "#9F2A3A",
							}}
						/>
						<span
							style={{
								fontSize: 13,
								fontWeight: 500,
								color: "#9ca3af",
								letterSpacing: "0.2em",
								textTransform: "uppercase",
							}}
						>
							Article
						</span>
					</div>

					<div
						style={{
							fontSize: title.length > 60 ? 44 : 52,
							fontWeight: 400,
							color: "#f5f0eb",
							lineHeight: 1.2,
							letterSpacing: "-0.025em",
							maxWidth: 860,
						}}
					>
						{title.length > 90 ? `${title.slice(0, 90)}…` : title}
					</div>

					{tags.length > 0 && (
						<div
							style={{
								display: "flex",
								flexWrap: "wrap",
								gap: 10,
							}}
						>
							{tags.map((tag) => (
								<div
									key={tag}
									style={{
										background: "rgba(234,88,12,0.1)",
										border: "1px solid rgba(234,88,12,0.25)",
										color: "#ea580c",
										padding: "6px 14px",
										borderRadius: 4,
										fontSize: 14,
										fontWeight: 500,
									}}
								>
									{tag}
								</div>
							))}
						</div>
					)}
				</div>

				{/* Bottom */}
				<span
					style={{
						fontSize: 16,
						color: "rgba(156,163,175,0.7)",
						letterSpacing: "0.05em",
					}}
				>
					fabric.pro
				</span>
			</div>
		</div>,
		{ width: 1200, height: 630 },
	);
}
