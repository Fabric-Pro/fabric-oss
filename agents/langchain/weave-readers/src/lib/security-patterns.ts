/**
 * Security Patterns Database
 *
 * Comprehensive security patterns organized by category.
 * Used by Warp agent for vulnerability scanning.
 */

type Severity = "critical" | "high" | "medium" | "low";

export interface SecurityPattern {
	id: string;
	name: string;
	severity: Severity;
	category: string;
	grepPatterns: string[];
	filePatterns: string[];
	description: string;
	remediation: string;
	rfcRefs: string[];
}

/**
 * Security patterns organized by category
 */
export const SECURITY_PATTERNS: SecurityPattern[] = [
	// ============================================
	// INJECTION (8 patterns)
	// ============================================
	{
		id: "sql-injection",
		name: "SQL Injection",
		severity: "critical",
		category: "Injection",
		grepPatterns: [
			"SELECT.*\\+.*",
			"execute\\(",
			"query\\(",
			"\\.format\\(",
			"string interpolation.*sql",
			'f"SELECT',
			"`SELECT.*\\$",
		],
		filePatterns: ["*.ts", "*.js", "*.py", "*.java", "*.php"],
		description:
			"Dynamic SQL construction without proper parameterization allows SQL injection attacks.",
		remediation:
			"Use parameterized queries (prepared statements) for all database access. Never concatenate user input into SQL strings.",
		rfcRefs: ["OWASP-Top10-2021"],
	},
	{
		id: "command-injection",
		name: "Command Injection",
		severity: "critical",
		category: "Injection",
		grepPatterns: [
			"exec\\(",
			"system\\(",
			"shell_exec",
			"popen\\(",
			"proc_open\\(",
			"child_process",
			"\\$*\\s*\\|\\s*bash",
			"\\|\\s*sh\\s",
			"&&.*\\w+",
		],
		filePatterns: ["*.ts", "*.js", "*.py", "*.php", "*.sh"],
		description:
			"User input is used in shell commands without proper sanitization, allowing arbitrary command execution.",
		remediation:
			"Avoid shell commands when possible. If required, use allowlists for input validation and avoid shell invocation.",
		rfcRefs: ["OWASP-Top10-2021"],
	},
	{
		id: "xss",
		name: "Cross-Site Scripting (XSS)",
		severity: "high",
		category: "Injection",
		grepPatterns: [
			"dangerouslySetInnerHTML",
			"innerHTML\\s*=",
			"\\.html\\(",
			"\\.append\\(",
			"document\\.write",
			"eval\\(",
			"new Function\\(",
			"\\.html\\s*<",
			"[innerText|textContent].*user",
		],
		filePatterns: ["*.tsx", "*.jsx", "*.html", "*.vue", "*.svelte"],
		description:
			"Untrusted data is displayed without proper encoding, allowing JavaScript injection.",
		remediation:
			"Use framework-safe APIs like textContent instead of innerHTML. Implement Content Security Policy (CSP).",
		rfcRefs: ["CSP-L3", "OWASP-Top10-2021"],
	},
	{
		id: "xpath-injection",
		name: "XPath Injection",
		severity: "high",
		category: "Injection",
		grepPatterns: [
			"xpath\\s*\\+",
			"//*[\\[\\[].*\\+",
			"xpath.evaluate",
			"ElementTree.*\\+",
		],
		filePatterns: ["*.ts", "*.js", "*.py", "*.java", "*.xml"],
		description:
			"Dynamic XPath construction from user input allows XML injection attacks.",
		remediation:
			"Use parameterized XPath queries or XPath expression builders. Validate and sanitize all input.",
		rfcRefs: ["OWASP-Top10-2021"],
	},
	{
		id: "ldap-injection",
		name: "LDAP Injection",
		severity: "high",
		category: "Injection",
		grepPatterns: [
			"ldap.*\\+",
			"search.*\\+",
			"distinguishedName.*\\+",
			"ldap_search\\(",
		],
		filePatterns: ["*.ts", "*.js", "*.py", "*.java", "*.php"],
		description:
			"User input in LDAP queries without proper sanitization allows LDAP injection.",
		remediation:
			"Use LDAP query builders with proper escaping. Avoid string concatenation for LDAP DN construction.",
		rfcRefs: ["OWASP-Top10-2021"],
	},
	{
		id: "nosql-injection",
		name: "NoSQL Injection",
		severity: "high",
		category: "Injection",
		grepPatterns: [
			"\\$where\\s*:",
			"\\$ne\\s*:",
			"\\$regex\\s*:",
			"findOne\\({.*\\+",
			"mongo.*\\+.*user",
			"mongoose.*\\+",
		],
		filePatterns: ["*.ts", "*.js"],
		description:
			"Query operators or selectors are constructed from user input in NoSQL databases.",
		remediation:
			"Use query builder methods with typed parameters. Validate input types before query construction.",
		rfcRefs: ["OWASP-Top10-2021"],
	},
	{
		id: "template-injection",
		name: "Template Injection (SSTI)",
		severity: "critical",
		category: "Injection",
		grepPatterns: [
			"render_template_string",
			"\\{\\{.*\\}\\}",
			"Template\\s*\\(",
			"render\\..*template",
			"nunjucks",
			"handlebars",
			"\\$\\{.*\\}",
		],
		filePatterns: ["*.py", "*.js", "*.ts", "*.html"],
		description:
			"User input is directly interpolated into template strings, enabling server-side template injection.",
		remediation:
			"Never pass user input directly to template renderers. Use template contexts with explicit variable allowlisting.",
		rfcRefs: ["OWASP-Top10-2021"],
	},
	{
		id: "xxe",
		name: "XML External Entity (XXE)",
		severity: "critical",
		category: "Injection",
		grepPatterns: [
			"<!DOCTYPE.*ENTITY",
			"<!\\[CDATA",
			"externalEntity",
			"XMLReader",
			"DocumentBuilder",
			"SAXParser",
			"xmlParse",
			"simplexml_load",
		],
		filePatterns: ["*.java", "*.php", "*.py", "*.js", "*.xml"],
		description:
			"XML parser is configured to process external entities, allowing file disclosure or SSRF.",
		remediation:
			"Disable DTD processing and external entities in XML parsers. Use less complex data formats like JSON when possible.",
		rfcRefs: ["OWASP-Top10-2021"],
	},

	// ============================================
	// AUTHENTICATION (6 patterns)
	// ============================================
	{
		id: "weak-password-policy",
		name: "Weak Password Policy",
		severity: "high",
		category: "Authentication",
		grepPatterns: [
			"password.*==.*null",
			"password\\.length\\s*<",
			"minLength.*[1-7]",
			"no.*password.*validation",
		],
		filePatterns: ["*.ts", "*.js", "*.py", "*.java"],
		description:
			"Password requirements are too weak, allowing easily guessable passwords.",
		remediation:
			"Enforce minimum 8 characters with mixed case, numbers, and special characters. Check against known weak passwords.",
		rfcRefs: ["OWASP-Top10-2021"],
	},
	{
		id: "missing-mfa",
		name: "Missing Multi-Factor Authentication",
		severity: "high",
		category: "Authentication",
		grepPatterns: [
			"totp",
			"totp.*verify",
			"mfa",
			"two-factor",
			"authenticator",
			"webauthn",
			"passkey",
		],
		filePatterns: ["*.ts", "*.js", "*.py"],
		description:
			"Authentication system lacks multi-factor authentication support for sensitive operations.",
		remediation:
			"Implement MFA using TOTP (RFC 6238), WebAuthn, or push notifications. Require MFA for privilege escalation.",
		rfcRefs: ["RFC6238", "WebAuthn-L2", "OWASP-Top10-2021"],
	},
	{
		id: "session-fixation",
		name: "Session Fixation",
		severity: "high",
		category: "Authentication",
		grepPatterns: [
			"session\\.regenerate",
			"session_destroy",
			"session_id\\(",
			"jsessionid",
			"PHPSESSID",
		],
		filePatterns: ["*.ts", "*.js", "*.php", "*.java"],
		description:
			"Application doesn't regenerate session IDs after authentication, allowing session fixation attacks.",
		remediation:
			"Regenerate session ID after any privilege level change (login, role change). Use secure, HTTP-only cookies.",
		rfcRefs: ["OWASP-Top10-2021"],
	},
	{
		id: "insecure-cookie-flags",
		name: "Insecure Cookie Flags",
		severity: "medium",
		category: "Authentication",
		grepPatterns: [
			"cookie.*Secure\\s*=",
			"cookie.*HttpOnly\\s*=",
			"cookie.*SameSite\\s*=",
			"setcookie.*[^S][^e][^c]",
			"res\\.cookie.*without",
		],
		filePatterns: ["*.ts", "*.js", "*.php", "*.java", "*.py"],
		description:
			"Cookies lack security flags like Secure, HttpOnly, or SameSite, exposing them to theft.",
		remediation:
			"Always set Secure=true, HttpOnly=true, and SameSite=Strict/Lax for authentication cookies.",
		rfcRefs: ["OWASP-Top10-2021"],
	},
	{
		id: "credential-hardcoding",
		name: "Hardcoded Credentials",
		severity: "critical",
		category: "Authentication",
		grepPatterns: [
			"password\\s*=\\s*['\"][^'\"]{3,}",
			"api_key\\s*=\\s*['\"][^'\"]{8,}",
			"secret\\s*=\\s*['\"][^'\"]{8,}",
			"token\\s*=\\s*['\"][^'\"]{8,}",
			"Authorization.*Basic",
			"Authorization.*Bearer",
		],
		filePatterns: ["*.ts", "*.js", "*.py", "*.java", "*.php", "*.env"],
		description:
			"Credentials are hardcoded in source code, exposing them in version control and deployments.",
		remediation:
			"Use environment variables or secrets managers. Never commit credentials. Rotate exposed credentials immediately.",
		rfcRefs: ["OWASP-Top10-2021"],
	},
	{
		id: "jwt-none-algorithm",
		name: "JWT 'none' Algorithm Vulnerability",
		severity: "critical",
		category: "Authentication",
		grepPatterns: [
			"algorithm.*none",
			'"none"\\s*:',
			"alg.*=.*\\s*\\|\\|.*\\s*",
			"JWT.*verify.*none",
			"jsonwebtoken.*none",
		],
		filePatterns: ["*.ts", "*.js", "*.py", "*.java"],
		description:
			"Application accepts JWTs with 'none' algorithm, allowing attackers to forge tokens.",
		remediation:
			"Always specify expected algorithms. Verify algorithm matches. Use a JWT library that doesn't allow 'none' by default.",
		rfcRefs: ["RFC7519", "OWASP-Top10-2021"],
	},

	// ============================================
	// AUTHORIZATION (5 patterns)
	// ============================================
	{
		id: "missing-authorization",
		name: "Missing Authorization Check",
		severity: "high",
		category: "Authorization",
		grepPatterns: [
			"isAuthenticated",
			"isAuthorized",
			"checkPermission",
			"requireAuth",
			"@Auth.*route",
			"middleware.*auth",
			"ensureAuthenticated",
		],
		filePatterns: ["*.ts", "*.js", "*.py", "*.java"],
		description:
			"Endpoint or function lacks authorization check, allowing unauthorized access.",
		remediation:
			"Implement authorization checks at every entry point. Use middleware or decorators consistently. Verify user has required role/permission.",
		rfcRefs: ["OWASP-Top10-2021"],
	},
	{
		id: "privilege-escalation",
		name: "Privilege Escalation",
		severity: "critical",
		category: "Authorization",
		grepPatterns: [
			"role\\s*=\\s*['\"]admin",
			"isAdmin\\s*=",
			"user\\.role\\s*!",
			"checkAdmin",
			"hasRole\\(['\"]admin",
		],
		filePatterns: ["*.ts", "*.js", "*.py", "*.java"],
		description:
			"Vulnerability allows users to gain elevated privileges beyond their authorized level.",
		remediation:
			"Validate authorization server-side. Never trust client-supplied roles. Implement principle of least privilege.",
		rfcRefs: ["OWASP-Top10-2021"],
	},
	{
		id: "idor",
		name: "Insecure Direct Object Reference (IDOR)",
		severity: "high",
		category: "Authorization",
		grepPatterns: [
			"/user/\\d+",
			"/api/.*/\\d+",
			"\\.findById\\(",
			"getParameter.*id",
			"request\\.params",
			"@PathVariable",
		],
		filePatterns: ["*.ts", "*.js", "*.py", "*.java"],
		description:
			"Application exposes direct references to internal objects without authorization verification.",
		remediation:
			"Verify ownership or permissions for every object access. Use indirect references or access control checks.",
		rfcRefs: ["OWASP-Top10-2021"],
	},
	{
		id: "forced-browsing",
		name: "Forced Browsing",
		severity: "medium",
		category: "Authorization",
		grepPatterns: [
			"admin.*panel",
			"/admin/",
			"/dashboard",
			"/manage",
			"/internal/",
			"/api/admin",
		],
		filePatterns: ["*.ts", "*.js", "*.py", "*.java", "*.html"],
		description:
			"Application allows access to sensitive pages/endpoints through direct URL guessing.",
		remediation:
			"Implement proper access controls. Use indirect references. Add rate limiting and monitoring for sensitive endpoints.",
		rfcRefs: ["OWASP-Top10-2021"],
	},
	{
		id: "method-spoofing",
		name: "HTTP Method Spoofing",
		severity: "low",
		category: "Authorization",
		grepPatterns: [
			"method.*override",
			"_method\\s*=",
			"X-HTTP-Method",
			"X-HTTP-Method-Override",
		],
		filePatterns: ["*.ts", "*.js", "*.py", "*.java", "*.php"],
		description:
			"Application uses method override headers, potentially bypassing security controls meant for specific HTTP methods.",
		remediation:
			"Apply authorization and validation for actual HTTP methods. Don't rely solely on method type for security decisions.",
		rfcRefs: ["OWASP-Top10-2021"],
	},

	// ============================================
	// CRYPTOGRAPHY (5 patterns)
	// ============================================
	{
		id: "weak-hashing-md5",
		name: "Weak Hashing (MD5)",
		severity: "critical",
		category: "Cryptography",
		grepPatterns: [
			"md5\\(",
			"hashlib\\.md5",
			"MessageDigest\\.getInstance.*MD5",
			"\\$pass.*md5",
			"bcrypt.*md5",
		],
		filePatterns: ["*.ts", "*.js", "*.py", "*.java", "*.php"],
		description:
			"MD5 is used for password hashing. MD5 is cryptographically broken and allows collision attacks.",
		remediation:
			"Use bcrypt, scrypt, Argon2, or PBKDF2 with appropriate work factors. MD5 should only be used for non-security purposes like checksums.",
		rfcRefs: ["RFC7519", "OWASP-Top10-2021"],
	},
	{
		id: "weak-hashing-sha1",
		name: "Weak Hashing (SHA-1)",
		severity: "high",
		category: "Cryptography",
		grepPatterns: [
			"sha1\\(",
			"hashlib\\.sha1",
			"MessageDigest\\.getInstance.*SHA-1",
			"\\$pass.*sha1",
		],
		filePatterns: ["*.ts", "*.js", "*.py", "*.java"],
		description:
			"SHA-1 is used for security purposes. SHA-1 is deprecated and vulnerable to collision attacks.",
		remediation:
			"Migrate to SHA-256 or stronger. Use SHA-1 only for non-security purposes like file integrity checks.",
		rfcRefs: ["RFC7519", "BCP195", "OWASP-Top10-2021"],
	},
	{
		id: "static-iv",
		name: "Static Initialization Vector (IV)",
		severity: "high",
		category: "Cryptography",
		grepPatterns: [
			"IvParameterSpec.*new",
			"initVector.*static",
			"iv\\s*=\\s*new.*\\d+",
			"cipher.*init.*0",
			"zero IV",
		],
		filePatterns: ["*.ts", "*.js", "*.py", "*.java"],
		description:
			"Encryption uses a static IV, weakening encryption and allowing pattern detection.",
		remediation:
			"Always generate a random IV for each encryption operation. Use cryptographic random number generator.",
		rfcRefs: ["BCP195", "OWASP-Top10-2021"],
	},
	{
		id: "weak-randomness",
		name: "Weak Random Number Generation",
		severity: "high",
		category: "Cryptography",
		grepPatterns: [
			"Math\\.random\\(\\)",
			"random\\.random\\(\\)",
			"rand\\(\\)",
			"srand\\(",
			"random_bytes.*non-crypto",
		],
		filePatterns: ["*.ts", "*.js", "*.py", "*.java", "*.php"],
		description:
			"Non-cryptographic random number generator is used for security-sensitive operations.",
		remediation:
			"Use crypto.getRandomValues() in JavaScript, os.urandom() in Python, SecureRandom in Java. Never use Math.random() for security.",
		rfcRefs: ["RFC7519", "BCP195"],
	},
	{
		id: "certificate-validation-disabled",
		name: "Disabled Certificate Validation",
		severity: "critical",
		category: "Cryptography",
		grepPatterns: [
			"rejectUnauthorized\\s*:\\s*false",
			"verify\\s*:\\s*false",
			"checkServerIdentity.*\\|\\|",
			"tls.*acceptInvalid",
			"ssl_verify\\s*=\\s*false",
			"curl.*-k\\s",
			"setCustomValidity\\(\\).*true",
		],
		filePatterns: ["*.ts", "*.js", "*.py", "*.php", "*.sh"],
		description:
			"TLS/SSL certificate validation is disabled, enabling man-in-the-middle attacks.",
		remediation:
			"Always validate certificates properly. Use certificate pinning if needed. Never disable validation in production.",
		rfcRefs: ["BCP195", "OWASP-Top10-2021"],
	},

	// ============================================
	// CONFIGURATION (5 patterns)
	// ============================================
	{
		id: "debug-mode-enabled",
		name: "Debug Mode Enabled in Production",
		severity: "high",
		category: "Configuration",
		grepPatterns: [
			"DEBUG\\s*=\\s*true",
			"debug\\s*=\\s*true",
			"\\.env.*development",
			"process\\.env\\.NODE_ENV.*development",
			"__DEBUG__",
		],
		filePatterns: ["*.ts", "*.js", "*.py", "*.java", "*.php", "*.env*"],
		description:
			"Application runs with debug features enabled in production, exposing sensitive information.",
		remediation:
			"Set NODE_ENV=production. Disable debug logging in production. Use separate configs for dev/prod.",
		rfcRefs: ["OWASP-Top10-2021"],
	},
	{
		id: "cors-wildcard",
		name: "CORS Wildcard Origin",
		severity: "high",
		category: "Configuration",
		grepPatterns: [
			"Access-Control-Allow-Origin\\s*:\\s*\\*",
			"origin\\s*:\\s*\\*",
			"cors.*\\*",
			"allowedOrigins.*\\*",
		],
		filePatterns: ["*.ts", "*.js", "*.py", "*.java"],
		description:
			"CORS allows all origins (*), permitting cross-origin attacks on APIs.",
		remediation:
			"Explicitly list allowed origins. Validate origin header server-side. Use 'same-origin' when appropriate.",
		rfcRefs: ["CORS", "OWASP-Top10-2021"],
	},
	{
		id: "security-headers-missing",
		name: "Security Headers Missing",
		severity: "medium",
		category: "Configuration",
		grepPatterns: [
			"X-Frame-Options",
			"X-Content-Type-Options",
			"X-XSS-Protection",
			"Content-Security-Policy",
			"Strict-Transport-Security",
			"Referrer-Policy",
		],
		filePatterns: ["*.ts", "*.js", "*.py", "*.java", "*.html"],
		description:
			"Essential security headers are missing, reducing protection against common attacks.",
		remediation:
			"Add all standard security headers: CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy.",
		rfcRefs: ["CSP-L3", "OWASP-Top10-2021"],
	},
	{
		id: "verbose-errors",
		name: "Verbose Error Messages",
		severity: "medium",
		category: "Configuration",
		grepPatterns: [
			"\\.stack",
			"error\\.stack",
			"exception\\.printStackTrace",
			"console\\.trace",
			"\\.message",
			"debug.*error",
		],
		filePatterns: ["*.ts", "*.js", "*.py", "*.java", "*.php"],
		description:
			"Error messages expose stack traces or internal details in production.",
		remediation:
			"Log full details server-side only. Return generic error messages to clients. Implement custom error handlers.",
		rfcRefs: ["OWASP-Top10-2021"],
	},
	{
		id: "default-credentials",
		name: "Default Credentials",
		severity: "critical",
		category: "Configuration",
		grepPatterns: [
			"admin\\s*:[^:]",
			"password\\s*=\\s*admin",
			"root\\s*:[^:]",
			"default.*password",
			"changeme",
			"letmein",
		],
		filePatterns: [
			"*.ts",
			"*.js",
			"*.py",
			"*.java",
			"*.php",
			"*.env*",
			"*.yaml",
			"*.yml",
		],
		description:
			"Application uses default credentials which are well-known and exploitable.",
		remediation:
			"Require password change on first login. Use generated passwords. Remove default admin accounts.",
		rfcRefs: ["OWASP-Top10-2021"],
	},

	// ============================================
	// DEPENDENCIES (3 patterns)
	// ============================================
	{
		id: "known-vulnerable-dependency",
		name: "Known Vulnerable Dependency",
		severity: "critical",
		category: "Dependencies",
		grepPatterns: [
			"lodash\\s*3\\.",
			"serialize-javascript",
			"minimist\\s*<",
			"event-stream\\s*<",
			"npm ls.*vulnerable",
			"npm audit",
		],
		filePatterns: [
			"package.json",
			"requirements.txt",
			"pom.xml",
			"build.gradle",
		],
		description:
			"Application uses a dependency with known security vulnerabilities.",
		remediation:
			"Regularly run npm audit, Snyk, or Dependabot. Update vulnerable dependencies immediately. Pin known-good versions.",
		rfcRefs: ["OWASP-Top10-2021"],
	},
	{
		id: "outdated-dependency",
		name: "Outdated Dependency",
		severity: "low",
		category: "Dependencies",
		grepPatterns: [
			"npm outdated",
			"pip list.*outdated",
			"Dependabot",
			"renovate",
		],
		filePatterns: ["package.json", "requirements.txt", "package-lock.json"],
		description:
			"Dependencies are significantly outdated, potentially missing security patches.",
		remediation:
			"Implement automated dependency updates. Use Renovate or Dependabot. Review update changelogs for security implications.",
		rfcRefs: [],
	},
	{
		id: "unverified-dependency",
		name: "Unverified Dependency Source",
		severity: "medium",
		category: "Dependencies",
		grepPatterns: [
			"npm install.*github:",
			"npm install.*gitlab:",
			"pip install.*git+",
			"git://",
			"http://registry",
		],
		filePatterns: [
			"package.json",
			"requirements.txt",
			"Dockerfile",
			"docker-compose.yml",
		],
		description:
			"Dependencies are installed from unverified or non-HTTPS sources.",
		remediation:
			"Only use npm registry or trusted sources. Verify checksums. Audit dependencies before CI/CD.",
		rfcRefs: ["OWASP-Top10-2021"],
	},

	// ============================================
	// SECRETS (4 patterns)
	// ============================================
	{
		id: "api-key-hardcoded",
		name: "Hardcoded API Key",
		severity: "critical",
		category: "Secrets",
		grepPatterns: [
			"api[_-]?key\\s*=\\s*['\"][A-Za-z0-9]{16,}",
			"API[_-]?KEY\\s*=\\s*['\"]",
			"apikey\\s*=\\s*['\"][^'\"]{8,}",
			"x-api-key\\s*=\\s*['\"][^'\"]{8,}",
		],
		filePatterns: ["*.ts", "*.js", "*.py", "*.java", "*.php", "*.env*"],
		description:
			"API keys are hardcoded in source code, exposing them in version control.",
		remediation:
			"Use environment variables or secrets manager. Never commit secrets. Use .gitignore for .env files.",
		rfcRefs: ["OWASP-Top10-2021"],
	},
	{
		id: "password-hardcoded",
		name: "Hardcoded Password",
		severity: "critical",
		category: "Secrets",
		grepPatterns: [
			"password\\s*=\\s*['\"][^'\"]{4,}",
			"passwd\\s*=\\s*['\"]",
			"pwd\\s*=\\s*['\"]",
			"DB_PASS\\s*=\\s*['\"]",
			"DATABASE_PASSWORD\\s*=\\s*['\"]",
		],
		filePatterns: ["*.ts", "*.js", "*.py", "*.java", "*.php", "*.env*"],
		description:
			"Passwords are hardcoded in source code, exposing them in version control.",
		remediation:
			"Use environment variables or secrets manager. Never commit passwords. Rotate exposed passwords.",
		rfcRefs: ["OWASP-Top10-2021"],
	},
	{
		id: "private-key-hardcoded",
		name: "Hardcoded Private Key",
		severity: "critical",
		category: "Secrets",
		grepPatterns: [
			"PRIVATE[_-]?KEY",
			"-----BEGIN.*PRIVATE KEY-----",
			"-----BEGIN RSA PRIVATE KEY-----",
			"-----BEGIN EC PRIVATE KEY-----",
			"-----BEGIN OPENSSH PRIVATE KEY-----",
		],
		filePatterns: ["*.ts", "*.js", "*.py", "*.pem", "*.key", "*.env*"],
		description:
			"Private keys are hardcoded in source code, completely exposing cryptographic identity.",
		remediation:
			"Use secure key storage (HSM, KMS). Never store private keys in code. Use key rotation.",
		rfcRefs: ["RFC7517", "RFC7519", "OWASP-Top10-2021"],
	},
	{
		id: "secret-in-logs",
		name: "Sensitive Data in Logs",
		severity: "high",
		category: "Secrets",
		grepPatterns: [
			"console\\.log.*password",
			"console\\.log.*token",
			"console\\.log.*secret",
			"console\\.log.*key",
			"logger\\..*password",
			"logger\\..*token",
			"logger\\..*auth",
		],
		filePatterns: ["*.ts", "*.js", "*.py", "*.java", "*.php"],
		description:
			"Sensitive data is written to logs, exposing it to log injection attacks and unauthorized access.",
		remediation:
			"Sanitize logs to mask sensitive fields. Never log passwords, tokens, or keys. Implement log access controls.",
		rfcRefs: ["OWASP-Top10-2021"],
	},

	// ============================================
	// INPUT VALIDATION (4 patterns)
	// ============================================
	{
		id: "missing-input-validation",
		name: "Missing Input Validation",
		severity: "high",
		category: "Input Validation",
		grepPatterns: [
			"validate",
			"sanitize",
			"parseInt",
			"parseFloat",
			"Number\\(",
			"parse\\(",
			"assert",
			"require\\(",
		],
		filePatterns: ["*.ts", "*.js", "*.py", "*.java"],
		description:
			"User input is used without validation, allowing malformed or malicious data.",
		remediation:
			"Validate all input on server side. Use schema validation (Zod, Yup, Joi). Implement allowlists where possible.",
		rfcRefs: ["OWASP-Top10-2021"],
	},
	{
		id: "file-upload-validation",
		name: "Unrestricted File Upload",
		severity: "critical",
		category: "Input Validation",
		grepPatterns: [
			"upload",
			"multer",
			"express-fileupload",
			"formidable",
			"move_uploaded_file",
			"multipart",
			"file\\.name",
		],
		filePatterns: ["*.ts", "*.js", "*.php", "*.java", "*.py"],
		description:
			"File upload lacks validation, allowing execution of malicious files.",
		remediation:
			"Validate file type, size, and content. Store uploads outside webroot. Use random filenames. Scan for malware.",
		rfcRefs: ["OWASP-Top10-2021"],
	},
	{
		id: "path-traversal",
		name: "Path Traversal",
		severity: "high",
		category: "Input Validation",
		grepPatterns: [
			"\\.\\.\\/",
			"\\.\\.\\\\",
			"path\\.join.*user",
			"resolve.*user",
			"realpath.*user",
			"readFile.*\\+",
			"open.*\\+",
		],
		filePatterns: ["*.ts", "*.js", "*.py", "*.php", "*.java"],
		description:
			"Application uses user input in file paths without validation, allowing directory traversal.",
		remediation:
			"Validate and sanitize all file paths. Use basename() and realpath(). Don't concatenate user input into paths.",
		rfcRefs: ["OWASP-Top10-2021"],
	},
	{
		id: "open-redirect",
		name: "Open Redirect",
		severity: "medium",
		category: "Input Validation",
		grepPatterns: [
			"redirect.*\\+",
			"location\\.href\\s*=",
			"window\\.location\\s*=",
			"res\\.redirect",
			"return.*redirect",
		],
		filePatterns: ["*.ts", "*.js", "*.php", "*.java", "*.py"],
		description:
			"Application redirects users to arbitrary URLs based on user input.",
		remediation:
			"Validate redirect URLs against an allowlist. Don't include user input directly in redirects. Warn users of external links.",
		rfcRefs: ["OWASP-Top10-2021"],
	},
];
