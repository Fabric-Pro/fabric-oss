import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";

export const runtime = "edge";

export async function GET(request: NextRequest) {
	const { searchParams } = request.nextUrl;

	const title =
		searchParams.get("title") || "The Complete Agent Engineering Platform";
	const description =
		searchParams.get("description") ||
		"Design agents for any domain. Connect any tool. Ship faster.";
	const label = searchParams.get("label") || "";

	// Load the full white logo for the OG image
	const logoUrl = new URL("/images/fabric-white-logo.png", request.url).href;
	const logoRes = await fetch(logoUrl);
	const logoData = await logoRes.arrayBuffer();
	const logoBytes = new Uint8Array(logoData);
	const binaryStr = logoBytes.reduce(
		(acc, byte) => acc + String.fromCharCode(byte),
		"",
	);
	const logoSrc = `data:image/png;base64,${btoa(binaryStr)}`;

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
			{/* Dot grid background */}
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

			{/* Warm radial glow top-left */}
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

			{/* Content */}
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
				{/* Top: full logo */}
				<div style={{ display: "flex", alignItems: "center" }}>
					<svg
						width="140"
						height="40"
						viewBox="0 0 140 40"
						fill="none"
					>
						<title>Fabric</title>
						<image href={logoSrc} width="140" height="40" />
					</svg>
				</div>

				{/* Center: main content */}
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						gap: 20,
					}}
				>
					{label && (
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
								{label}
							</span>
						</div>
					)}
					<div
						style={{
							fontSize: title.length > 50 ? 48 : 56,
							fontWeight: 400,
							color: "#f5f0eb",
							lineHeight: 1.15,
							letterSpacing: "-0.025em",
							maxWidth: 820,
						}}
					>
						{title}
					</div>
					<div
						style={{
							fontSize: 22,
							color: "#9ca3af",
							lineHeight: 1.5,
							maxWidth: 740,
						}}
					>
						{description.length > 120
							? `${description.slice(0, 120)}…`
							: description}
					</div>
				</div>

				{/* Bottom: tagline */}
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
					}}
				>
					<span
						style={{
							fontSize: 16,
							color: "rgba(156,163,175,0.7)",
							letterSpacing: "0.05em",
						}}
					>
						fabric.pro
					</span>
					<div
						style={{
							display: "flex",
							alignItems: "center",
							gap: 8,
							background: "rgba(234,88,12,0.1)",
							border: "1px solid rgba(234,88,12,0.25)",
							borderRadius: 6,
							padding: "6px 14px",
						}}
					>
						<span
							style={{
								fontSize: 14,
								color: "#ea580c",
								fontWeight: 500,
							}}
						>
							Agent Engineering Platform
						</span>
					</div>
				</div>
			</div>
		</div>,
		{ width: 1200, height: 630 },
	);
}
