import type { Metadata } from "next";
import { JetBrains_Mono, Manrope, Newsreader } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const headingFont = Newsreader({
	weight: ["300", "400", "500", "700"],
	subsets: ["latin"],
	variable: "--font-heading",
	display: "swap",
});

const bodyFont = Manrope({
	weight: ["300", "400", "500", "600", "700"],
	subsets: ["latin"],
	variable: "--font-body",
	display: "swap",
});

const codeFont = JetBrains_Mono({
	weight: ["300", "400", "500", "600", "700"],
	subsets: ["latin"],
	variable: "--font-code",
	display: "swap",
});

export const metadata: Metadata = {
	title: "Data Analyst Agent - Powered by Fabric",
	description:
		"Analyze data, generate insights, and create visualizations with AI. Powered by Fabric MCP Tool Router.",
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="en">
			<body
				className={`${bodyFont.variable} ${headingFont.variable} ${codeFont.variable} antialiased font-sans`}
			>
				<Providers>{children}</Providers>
			</body>
		</html>
	);
}
