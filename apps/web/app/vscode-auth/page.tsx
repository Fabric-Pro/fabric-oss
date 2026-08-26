"use client";

import { useEffect, useState } from "react";

export default function VscodeAuthPage() {
	const [code, setCode] = useState<string | null>(null);
	const [status, setStatus] = useState<
		"idle" | "authorizing" | "done" | "denied" | "error"
	>("idle");
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		setCode(params.get("code"));
	}, []);

	async function handleAuthorize() {
		if (!code) {
			return;
		}
		setStatus("authorizing");
		setError(null);

		try {
			const res = await fetch("/api/vscode-auth/approve", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				credentials: "include",
				body: JSON.stringify({ code }),
			});

			const data = await res.json();

			if (!res.ok) {
				if (res.status === 401) {
					// Not logged in — redirect to login with return URL
					window.location.href = `/auth/login?callbackURL=${encodeURIComponent(window.location.href)}`;
					return;
				}
				throw new Error(data.error || "Authorization failed");
			}

			setStatus("done");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Unknown error");
			setStatus("error");
		}
	}

	async function handleDeny() {
		if (!code) {
			return;
		}
		setStatus("denied");

		await fetch("/api/vscode-auth/deny", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			credentials: "include",
			body: JSON.stringify({ code }),
		}).catch(() => {});
	}

	if (!code) {
		return (
			<div style={styles.container}>
				<div style={styles.card}>
					<Logo />
					<h1 style={styles.title}>Invalid Authorization Link</h1>
					<p style={styles.body}>
						This link is missing the authorization code. Please
						retry from VS Code.
					</p>
				</div>
			</div>
		);
	}

	if (status === "done") {
		return (
			<div style={styles.container}>
				<div style={styles.card}>
					<Logo />
					<div style={styles.checkmark}>✓</div>
					<h1 style={styles.title}>Authorized!</h1>
					<p style={styles.body}>
						Fabric Code has been authorized. You can close this
						window and return to VS Code.
					</p>
				</div>
			</div>
		);
	}

	if (status === "denied") {
		return (
			<div style={styles.container}>
				<div style={styles.card}>
					<Logo />
					<h1 style={styles.title}>Authorization Denied</h1>
					<p style={styles.body}>
						You denied access. Close this window and try again from
						VS Code if needed.
					</p>
				</div>
			</div>
		);
	}

	return (
		<div style={styles.container}>
			<div style={styles.card}>
				<Logo />
				<h1 style={styles.title}>Authorize Fabric Code</h1>
				<p style={styles.body}>
					The <strong>Fabric Code</strong> VS Code extension is
					requesting access to your Fabric account.
				</p>
				<p style={styles.body}>
					This will create an API key that the extension uses to
					connect to your configured AI providers.
				</p>
				{error && <p style={styles.errorText}>{error}</p>}
				<div style={styles.buttonRow}>
					<button
						type="button"
						onClick={handleAuthorize}
						disabled={status === "authorizing"}
						style={{ ...styles.button, ...styles.primaryButton }}
					>
						{status === "authorizing"
							? "Authorizing…"
							: "Authorize"}
					</button>
					<button
						type="button"
						onClick={handleDeny}
						disabled={status === "authorizing"}
						style={{ ...styles.button, ...styles.secondaryButton }}
					>
						Deny
					</button>
				</div>
			</div>
		</div>
	);
}

function Logo() {
	return (
		<div style={styles.logoWrapper}>
			<svg
				width="56"
				height="68"
				viewBox="0 0 180 220"
				fill="none"
				xmlns="http://www.w3.org/2000/svg"
				role="img"
				aria-labelledby="fabric-code-logo-title"
			>
				<title id="fabric-code-logo-title">Fabric Code logo</title>
				<path
					fill="white"
					d="M115.14,219.89h-21v-87.3c.028-21.221,17.239-38.41,38.46-38.41h7v21h-7c-9.634.011-17.443,7.816-17.46,17.45v87.26Z"
				/>
				<path
					fill="white"
					d="M83,181.48h-20.93v-53.08c.044-36.62,29.72-66.296,66.34-66.34h26.59v20.94h-26.59c-25.068.017-45.388,20.332-45.41,45.4v53.08Z"
				/>
				<path
					fill="white"
					d="M50.9,143.07h-20.9v-18.86c.061-52.039,42.231-94.209,94.27-94.27h46.09v21h-46.14c-40.456.044-73.248,32.814-73.32,73.27v18.86Z"
				/>
			</svg>
		</div>
	);
}

const styles: Record<string, React.CSSProperties> = {
	container: {
		minHeight: "100vh",
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		background: "#0f0f11",
		fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
	},
	card: {
		background: "#1a1a1e",
		border: "1px solid #2e2e33",
		borderRadius: "16px",
		padding: "40px",
		maxWidth: "420px",
		width: "100%",
		textAlign: "center",
		color: "#e8e8ed",
	},
	logoWrapper: {
		marginBottom: "24px",
		display: "flex",
		justifyContent: "center",
		alignItems: "center",
	},
	title: {
		fontSize: "22px",
		fontWeight: 700,
		marginBottom: "12px",
		color: "#fff",
	},
	body: {
		fontSize: "14px",
		color: "#9999a8",
		lineHeight: 1.6,
		marginBottom: "12px",
	},
	errorText: { color: "#f87171", fontSize: "13px", marginBottom: "16px" },
	checkmark: { fontSize: "48px", color: "#4ade80", marginBottom: "12px" },
	buttonRow: {
		display: "flex",
		gap: "12px",
		marginTop: "24px",
		justifyContent: "center",
	},
	button: {
		padding: "10px 24px",
		borderRadius: "8px",
		fontSize: "14px",
		fontWeight: 600,
		cursor: "pointer",
		border: "none",
	},
	primaryButton: { background: "#6366F1", color: "#fff" },
	secondaryButton: { background: "#2e2e33", color: "#9999a8" },
};
