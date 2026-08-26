/**
 * Technical Specification Prompt Configuration
 *
 * Expert-level prompt for generating detailed technical specifications
 * that guide implementation with precision and clarity.
 */

import type { DocumentPromptConfig } from "../types";

export const TECHNICAL_SPEC_PROMPT: DocumentPromptConfig = {
	id: "technical_spec",
	name: "Technical Specification",

	persona: `You are a staff engineer with 15+ years of experience writing technical specifications that teams can implement without ambiguity. You have led critical projects at high-scale companies where spec quality directly impacted delivery success.

Your technical specs are known for:
- Precise, unambiguous requirements that eliminate guesswork
- Deep consideration of edge cases and error handling
- Practical implementation guidance without over-prescribing
- Clear interfaces and contracts between components
- Thorough testing strategies covering unit, integration, and e2e testing
- Realistic complexity assessments

CRITICAL SECTIONS TO ALWAYS INCLUDE:
1. Executive Summary or Overview - high-level description of what's being built
2. System Architecture - components and how they interact
3. Data Models/Database Design - schema, entities, relationships
4. API Specifications - endpoints, request/response formats
5. Testing Strategy - unit, integration, e2e approach with coverage targets
6. Deployment/Infrastructure - how the system will be deployed and scaled
7. Security Considerations - authentication, authorization, data protection

You may combine related sections (e.g., "Deployment & Infrastructure" or "API & Data Models") but ensure all critical topics are covered.`,

	sections: [
		{
			name: "Document Metadata",
			required: true,
			guidance: `Provide document control information:

**Document Version**: Version number (e.g., v1.0, v2.1)

**Document Status**: Draft | In Review | Approved | Implemented

**Author**: Lead engineer/architect who created this spec

**Reviewers**: Technical reviewers and approvers

**Last Updated**: Date of last significant update

**Approval Date**: When this spec was formally approved

**Target Implementation**: Planned sprint/release`,
			example: `## Document Metadata

| Field | Value |
|-------|-------|
| **Version** | v1.3 |
| **Status** | Approved |
| **Author** | Alex Rodriguez (Staff Engineer) |
| **Reviewers** | Jane Smith (Tech Lead), Mike Chen (Principal Engineer) |
| **Last Updated** | January 15, 2024 |
| **Approval Date** | January 18, 2024 |
| **Target Implementation** | Sprint 45 (Week of January 22) |`,
		},
		{
			name: "Glossary & Definitions",
			required: true,
			guidance: `Define all terms and acronyms used in this specification (per IEEE 830):

**Standard Format**:

| Term | Definition | Context |
|------|------------|---------|
| [Term] | [Clear definition] | [Where it's used] |

**Include**:
- Domain-specific terminology
- Technical acronyms
- System-specific terms
- Industry standards referenced (e.g., RFC 2119 keywords)

**RFC 2119 Keywords** (use for requirements):
- **MUST / SHALL**: Absolute requirement
- **MUST NOT / SHALL NOT**: Absolute prohibition
- **SHOULD / RECOMMENDED**: May exist valid reasons to ignore, but full implications must be understood
- **SHOULD NOT / NOT RECOMMENDED**: May exist valid reasons when behavior acceptable, but implications understood
- **MAY / OPTIONAL**: Truly optional`,
			example: `## Glossary & Definitions

### RFC 2119 Keywords

This specification uses RFC 2119 keywords to indicate requirement levels:

| Keyword | Meaning |
|---------|---------|
| **MUST / SHALL** | Absolute requirement - no exceptions |
| **MUST NOT / SHALL NOT** | Absolute prohibition - forbidden |
| **SHOULD / RECOMMENDED** | Recommended but may have valid reasons to not follow |
| **SHOULD NOT** | Not recommended but may have valid reasons to do anyway |
| **MAY / OPTIONAL** | Truly optional - implementer can choose |

### Terms & Definitions

| Term | Definition | Context |
|------|------------|---------|
| **Idempotency Key** | Unique identifier for a request to prevent duplicate processing | Payment API requests |
| **Webhook** | HTTP callback triggered by system events | Event notification to external systems |
| **JWT** | JSON Web Token - compact token format for auth | Authorization header format |
| **Circuit Breaker** | Design pattern to prevent cascading failures | External API integration |
| **Event Sourcing** | Storing state changes as sequence of events | Order processing system |
| **Saga** | Pattern for managing distributed transactions | Multi-step checkout process |
| **RTO** | Recovery Time Objective - max acceptable downtime | Disaster recovery requirement |
| **RPO** | Recovery Point Objective - max acceptable data loss | Backup frequency requirement |

### Acronyms

| Acronym | Full Form | Usage |
|---------|-----------|-------|
| **API** | Application Programming Interface | All external integrations |
| **ACID** | Atomicity, Consistency, Isolation, Durability | Database transaction properties |
| **CRUD** | Create, Read, Update, Delete | Basic data operations |
| **DTO** | Data Transfer Object | API request/response models |
| **ORM** | Object-Relational Mapping | Database access layer (Prisma) |
| **TLS** | Transport Layer Security | Encryption protocol (min TLS 1.3) |
| **UUID** | Universally Unique Identifier | Standard ID format for entities |`,
		},
		{
			name: "Overview",
			required: true,
			guidance: `Set context for the specification:

**Purpose**: What feature or system is being specified?

**Background**: Why is this being built? What problem does it solve?

**Scope**: What this spec covers and explicitly doesn't cover.

**Prerequisites**: What must be in place before implementation.

**Terminology**: Define any domain-specific terms used in this document.

**Related Documents**: Links to PRD, architecture docs, design docs.`,
		},
		{
			name: "System Context",
			required: true,
			guidance: `Describe the system boundaries and external interfaces:

**System Context Diagram**: Use a diagram to show system boundaries:

\`\`\`mermaid
flowchart TB
    User[User/Client]
    System[This System]
    DB[(Database)]
    ExtAPI[External API]
    
    User -->|HTTPS| System
    System -->|SQL| DB
    System -->|REST| ExtAPI
\`\`\`

**External Actors**: Who/what interacts with the system.

**System Boundaries**: What is inside vs. outside scope.

**External Dependencies**: Systems this feature depends on.

**Integration Points**: How this system connects to others.`,
			example: `## System Context

### Context Diagram

\`\`\`mermaid
flowchart TB
    subgraph External
        User[Mobile App User]
        Admin[Admin Dashboard]
        Merchant[Merchant System]
    end
    
    subgraph "Payment Service (This System)"
        API[Payment API]
        Worker[Background Workers]
    end
    
    subgraph Dependencies
        DB[(PostgreSQL)]
        Cache[(Redis)]
        Stripe[Stripe API]
        Auth[Auth Service]
        Queue[RabbitMQ]
    end
    
    User -->|HTTPS/JWT| API
    Admin -->|HTTPS/JWT| API
    API -->|Validate Token| Auth
    API -->|Read/Write| DB
    API -->|Cache/Session| Cache
    API -->|Process Payment| Stripe
    API -->|Queue Job| Queue
    Queue -->|Consume| Worker
    Worker -->|Update Status| DB
    Worker -->|Webhook| Merchant
\`\`\`

### External Actors

| Actor | Description | Interface |
|-------|-------------|-----------|
| **Mobile App User** | End user making payments | REST API (HTTPS) |
| **Admin Dashboard** | Internal operators managing payments | REST API (HTTPS) |
| **Merchant System** | External merchant receiving webhooks | Webhooks (HTTPS POST) |
| **Background Jobs** | Automated processes (settlement, reconciliation) | Internal job queue |

### System Boundaries

**In Scope** (this system handles):
- Payment authorization and capture
- Payment method tokenization and storage
- Transaction status tracking
- Webhook delivery to merchants
- Refund and chargeback processing

**Out of Scope** (delegated to other systems):
- User authentication (handled by Auth Service)
- Fraud detection (handled by Fraud Service)
- Analytics and reporting (handled by Data Warehouse)
- Merchant onboarding (handled by Onboarding Service)

### External Dependencies

| System | Purpose | SLA | Failure Mode |
|--------|---------|-----|--------------|
| **Auth Service** | Token validation | 99.9%, <50ms | Reject requests (fail closed) |
| **Stripe API** | Payment processing | 99.95%, <1s | Queue for retry, show error to user |
| **PostgreSQL** | Data persistence | 99.95%, <20ms | Service unavailable (503) |
| **Redis** | Caching & rate limiting | 99.9%, <5ms | Degrade gracefully (skip cache) |
| **RabbitMQ** | Async job queue | 99.9% | Queue in DB, retry when available |

### Integration Points

**Inbound**:
- REST API: Mobile/web clients call payment endpoints
- Admin API: Internal tools for payment management
- Webhooks: Stripe sends payment status updates

**Outbound**:
- Stripe API: Process payments and refunds
- Auth Service: Validate JWT tokens
- Merchant Webhooks: Notify merchants of payment events
- Analytics Events: Publish to event stream`,
		},
		{
			name: "Use Cases",
			required: true,
			guidance: `Document formal use case specifications:

**For Each Use Case**:

**Use Case ID**: UC-001

**Name**: Descriptive name

**Primary Actor**: Who initiates the use case

**Preconditions**: What must be true before use case starts

**Postconditions**: What must be true after successful completion

**Main Success Scenario** (Basic Flow):
1. Actor does action
2. System responds
3. ...

**Alternative Flows**:
What happens in alternate scenarios

**Exception Flows**:
What happens when errors occur

**Business Rules**: Rules that govern this use case`,
			example: `## Use Cases

### UC-001: Process Payment

**Primary Actor**: Mobile App User

**Preconditions**:
- User is authenticated (valid JWT token)
- User has a saved payment method OR is providing card details
- Order total is greater than minimum amount ($0.50)

**Postconditions** (Success):
- Payment authorized or captured
- Payment record created in database
- User receives confirmation
- Merchant receives webhook notification

**Main Success Scenario**:
1. User initiates payment with order details and payment method
2. System validates JWT token with Auth Service
3. System validates payment amount and order details
4. System creates payment record with status "pending"
5. System calls Stripe API to authorize payment
6. Stripe returns authorization success
7. System updates payment record to "authorized"
8. System queues webhook job for merchant notification
9. System returns payment confirmation to user

**Alternative Flow 3a: Saved Payment Method**
- 3.1. User selects saved payment method by token ID
- 3.2. System retrieves tokenized card from database
- 3.3. Continue to step 4

**Alternative Flow 5a: 3D Secure Required**
- 5.1. Stripe returns "requires_action" with 3DS challenge URL
- 5.2. System returns 3DS challenge URL to client
- 5.3. User completes 3DS authentication
- 5.4. Client sends confirmation to system
- 5.5. System confirms payment with Stripe
- 5.6. Continue to step 6

**Exception Flow 2a: Invalid Token**
- 2.1. Auth Service returns 401 Unauthorized
- 2.2. System returns 401 error to user
- 2.3. Use case ends

**Exception Flow 5a: Insufficient Funds**
- 5.1. Stripe returns "card_declined" error
- 5.2. System updates payment record to "failed"
- 5.3. System returns user-friendly error: "Your card was declined. Please try another payment method."
- 5.4. Use case ends

**Exception Flow 5b: Stripe API Timeout**
- 5.1. Stripe API does not respond within 5 seconds
- 5.2. System marks payment as "pending" with retry flag
- 5.3. System queues background job to retry authorization
- 5.4. System returns 202 Accepted with payment ID
- 5.5. User polls for payment status or receives webhook when complete

**Business Rules**:
- BR-001: Minimum payment amount is $0.50 USD
- BR-002: Maximum payment amount is $10,000 USD per transaction
- BR-003: User can have maximum 5 saved payment methods
- BR-004: Payment authorization expires after 7 days if not captured
- BR-005: Failed payments can be retried up to 3 times within 24 hours

---

### UC-002: Refund Payment

**Primary Actor**: Admin User OR Automated Chargeback Process

**Preconditions**:
- Payment exists and is in "captured" status
- Refund amount ≤ original payment amount
- Original payment is less than 180 days old

**Postconditions** (Success):
- Refund processed with Stripe
- Refund record created
- Payment amount updated
- Merchant notified via webhook

**Main Success Scenario**:
1. Actor initiates refund with payment ID and amount
2. System validates payment exists and is refundable
3. System creates refund record with status "pending"
4. System calls Stripe API to process refund
5. Stripe returns refund success
6. System updates refund status to "succeeded"
7. System updates payment remaining amount
8. System queues webhook notification to merchant
9. System returns refund confirmation

**Alternative Flow 1a: Partial Refund**
- 1.1. Amount is less than original payment amount
- 1.2. System validates remaining amount ≥ $0
- 1.3. Continue to step 2

**Alternative Flow 1b: Full Refund**
- 1.1. Amount equals original payment amount
- 1.2. System will update payment status to "refunded" after success
- 1.3. Continue to step 2

**Exception Flow 2a: Payment Not Refundable**
- 2.1. Payment status is not "captured" (e.g., already refunded, still pending)
- 2.2. System returns 400 Bad Request: "Payment cannot be refunded in current status"
- 2.3. Use case ends

**Exception Flow 4a: Stripe Refund Fails**
- 4.1. Stripe returns error (e.g., "charge_already_refunded")
- 4.2. System updates refund status to "failed"
- 4.3. System logs error for manual review
- 4.4. System returns 400 Bad Request with error details
- 4.5. Use case ends

**Business Rules**:
- BR-006: Refunds can be processed up to 180 days after payment
- BR-007: Partial refunds allowed; total refunds cannot exceed original amount
- BR-008: Refunds typically take 5-10 business days to appear in user's account
- BR-009: Refunded payments cannot be refunded again (idempotent)`,
		},
		{
			name: "Requirements",
			required: true,
			guidance: `Document all requirements using RFC 2119 keywords (MUST, SHOULD, MAY):

**Functional Requirements**:
Hierarchical numbering (REQ-1.1, REQ-1.2, REQ-2.1) with:
- Requirement statement using RFC 2119 keywords
- Priority (P0/P1/P2 or Must-Have/Should-Have/Could-Have)
- Acceptance criteria (testable conditions)
- Rationale (why this requirement exists)

**Example**: 
- REQ-1.1: The system MUST validate JWT tokens with Auth Service before processing payments.
- REQ-1.2: The system SHOULD cache validation results for 5 minutes to reduce latency.
- REQ-1.3: The system MAY support multiple token formats (JWT, OAuth2) in future versions.

**Non-Functional Requirements** (with specific targets):
- Performance: P50/P95/P99 response times, throughput (requests/sec)
- Scalability: Concurrent users, data volume, growth projections
- Reliability: Uptime SLA (e.g., 99.95%), MTBF, MTTR
- Security: Encryption standards, authentication methods, compliance (PCI DSS)
- Accessibility: WCAG level, screen reader support

**Constraints**:
- Technical: Must use existing auth system, limited to PostgreSQL
- Business: Budget limits, launch deadline, resource availability
- Regulatory: GDPR compliance, PCI DSS Level 1, SOX requirements

Each requirement MUST be:
- Specific and unambiguous
- Testable with clear pass/fail criteria
- Traceable to use cases or business needs`,
		},
		{
			name: "Design Details",
			required: true,
			guidance: `Provide implementation guidance:

**High-Level Design**: System/component interactions.

**Detailed Design**:
For each component or module:
- Purpose and responsibility
- Public interface (API/methods)
- Internal structure (classes, functions)
- Data structures used
- Algorithms (with complexity analysis if relevant)

**Data Design**:
- Schema definitions (tables, collections)
- Data types and validation rules
- Indexes and query patterns
- Migration strategy (if modifying existing data)

**API Specification** (if applicable):
- Endpoints with methods
- Request/response formats (with examples)
- Authentication requirements
- Error responses
- Rate limiting

**Sequence Diagrams**: Use mermaid for complex interactions:

\`\`\`mermaid
sequenceDiagram
    participant U as User
    participant C as Controller
    participant S as Service
    participant R as Repository
    participant D as Database

    U->>C: HTTP Request
    C->>C: Validate Input
    C->>S: Process Request
    S->>R: Fetch Data
    R->>D: Query
    D-->>R: Results
    R-->>S: Entity
    S->>S: Apply Business Logic
    S-->>C: Result
    C-->>U: HTTP Response
\`\`\`

**State Machines**: Use mermaid state diagrams for stateful behavior:

\`\`\`mermaid
stateDiagram-v2
    [*] --> Created
    Created --> Pending: Submit
    Pending --> Processing: Start
    Processing --> Completed: Success
    Processing --> Failed: Error
    Failed --> Processing: Retry
    Completed --> [*]
    Failed --> [*]: Max Retries
\`\`\``,
		},
		{
			name: "Data Dictionary",
			required: true,
			guidance: `Define all data entities, attributes, types, and constraints:

**For Each Entity/Table**:

**Entity Name**: TableName

**Description**: Purpose of this entity

**Attributes**:

| Column | Type | Constraints | Description | Example |
|--------|------|-------------|-------------|---------|
| id | UUID | PK, NOT NULL | Unique identifier | "550e8400-e29b-41d4-a716-446655440000" |
| amount | INTEGER | NOT NULL, > 0 | Amount in cents | 9999 (= $99.99) |
| status | ENUM | NOT NULL | Payment status | "pending", "captured", "failed" |

**Indexes**: Columns that should be indexed for performance

**Relationships**: Foreign keys and how this entity relates to others

**Business Rules**: Validation rules and invariants`,
			example: `## Data Dictionary

### Entity: Payment

**Description**: Represents a payment transaction initiated by a user

**Table Name**: \`payments\`

**Attributes**:

| Column | Type | Constraints | Description | Example |
|--------|------|-------------|-------------|---------|
| \`id\` | UUID | PK, NOT NULL | Unique payment identifier | "550e8400-..." |
| \`user_id\` | UUID | FK, NOT NULL, INDEX | User who initiated payment | "123e4567-..." |
| \`merchant_id\` | UUID | FK, NOT NULL, INDEX | Merchant receiving payment | "789abcde-..." |
| \`amount\` | INTEGER | NOT NULL, > 0 | Amount in cents (to avoid float precision issues) | 9999 (= $99.99) |
| \`currency\` | CHAR(3) | NOT NULL, DEFAULT 'usd' | ISO 4217 currency code | "usd", "eur", "gbp" |
| \`status\` | ENUM | NOT NULL, INDEX | Payment status | "pending", "authorized", "captured", "failed", "refunded" |
| \`payment_method_id\` | UUID | FK, NULLABLE | Tokenized payment method used | "abc123-..." |
| \`stripe_payment_intent_id\` | VARCHAR(255) | UNIQUE, NULLABLE | Stripe payment intent ID | "pi_3L..." |
| \`failure_code\` | VARCHAR(50) | NULLABLE | Error code if failed | "card_declined", "insufficient_funds" |
| \`failure_message\` | TEXT | NULLABLE | Human-readable error | "Your card was declined" |
| \`metadata\` | JSONB | NULLABLE | Additional key-value data | {"order_id": "123", "customer_ip": "1.2.3.4"} |
| \`created_at\` | TIMESTAMP | NOT NULL, INDEX | When payment was created | "2024-01-15T10:30:00Z" |
| \`updated_at\` | TIMESTAMP | NOT NULL | Last update timestamp | "2024-01-15T10:30:05Z" |
| \`captured_at\` | TIMESTAMP | NULLABLE | When payment was captured | "2024-01-15T10:30:10Z" |

**Indexes**:
- PRIMARY KEY: \`id\`
- INDEX: \`user_id\` (for user payment history)
- INDEX: \`merchant_id\` (for merchant dashboard)
- INDEX: \`status\` (for filtering by status)
- INDEX: \`created_at DESC\` (for recent payments query)
- UNIQUE: \`stripe_payment_intent_id\` (prevent duplicates)

**Relationships**:
- \`user_id\` → \`users.id\` (Many payments to one user)
- \`merchant_id\` → \`merchants.id\` (Many payments to one merchant)
- \`payment_method_id\` → \`payment_methods.id\` (Many payments can use same method)
- ONE payment → MANY refunds (one-to-many with \`refunds\` table)

**Business Rules**:
- BR-001: \`amount\` MUST be >= 50 (minimum $0.50)
- BR-002: \`amount\` MUST be <= 1000000 (maximum $10,000)
- BR-003: \`status\` can only transition: pending → authorized → captured OR pending → failed
- BR-004: \`currency\` MUST match merchant's accepted currencies
- BR-005: \`captured_at\` MUST be NULL unless status = "captured"
- BR-006: Payment records are immutable after creation (status changes only, no amount/currency changes)

**Validation Rules**:
\`\`\`typescript
class PaymentValidation {
  // Amount must be integer cents between $0.50 and $10,000
  amount: z.number().int().min(50).max(1_000_000)
  
  // Currency must be ISO 4217 code
  currency: z.enum(['usd', 'eur', 'gbp', 'cad', ...])
  
  // Status enum
  status: z.enum(['pending', 'authorized', 'captured', 'failed', 'refunded'])
  
  // Metadata is optional key-value JSON
  metadata: z.record(z.string(), z.any()).optional()
}
\`\`\`

---

### Entity: PaymentMethod

**Description**: Tokenized payment method (credit card, bank account) stored for reuse

**Table Name**: \`payment_methods\`

**Attributes**:

| Column | Type | Constraints | Description | Example |
|--------|------|-------------|-------------|---------|
| \`id\` | UUID | PK, NOT NULL | Unique payment method identifier | "abc123-..." |
| \`user_id\` | UUID | FK, NOT NULL, INDEX | User who owns this payment method | "123e4567-..." |
| \`type\` | ENUM | NOT NULL | Payment method type | "card", "bank_account" |
| \`stripe_payment_method_id\` | VARCHAR(255) | UNIQUE, NOT NULL | Stripe payment method token | "pm_..." |
| \`last_four\` | CHAR(4) | NOT NULL | Last 4 digits for display | "4242" |
| \`brand\` | VARCHAR(20) | NULLABLE | Card brand | "visa", "mastercard", "amex" |
| \`exp_month\` | INTEGER | NULLABLE | Card expiration month | 12 |
| \`exp_year\` | INTEGER | NULLABLE | Card expiration year | 2025 |
| \`is_default\` | BOOLEAN | NOT NULL, DEFAULT false | Is this the default payment method | true/false |
| \`created_at\` | TIMESTAMP | NOT NULL | When payment method was added | "2024-01-15T10:30:00Z" |
| \`updated_at\` | TIMESTAMP | NOT NULL | Last update timestamp | "2024-01-15T10:30:00Z" |

**Indexes**:
- PRIMARY KEY: \`id\`
- INDEX: \`user_id\` (for user's saved payment methods)
- UNIQUE: \`stripe_payment_method_id\`

**Relationships**:
- \`user_id\` → \`users.id\` (Many payment methods to one user)
- MANY payments can use ONE payment_method (one-to-many with \`payments\`)

**Business Rules**:
- BR-007: Each user MUST have at most 5 payment methods
- BR-008: Each user MUST have at most 1 default payment method
- BR-009: Payment method MUST NOT be deleted if referenced by any non-failed payment

---

### Enums

**PaymentStatus**:
\`\`\`sql
CREATE TYPE payment_status AS ENUM (
  'pending',     -- Payment initiated but not yet authorized
  'authorized',  -- Funds authorized but not yet captured
  'captured',    -- Funds captured successfully
  'failed',      -- Payment failed (declined, timeout, etc.)
  'refunded'     -- Payment refunded (partially or fully)
);
\`\`\`

**Valid Status Transitions**:
- pending → authorized → captured
- pending → failed
- authorized → failed
- captured → refunded

**PaymentMethodType**:
\`\`\`sql
CREATE TYPE payment_method_type AS ENUM (
  'card',          -- Credit/debit card
  'bank_account',  -- Bank account (ACH)
  'wallet'         -- Digital wallet (Apple Pay, Google Pay)
);
\`\`\``,
		},
		{
			name: "Configuration Management",
			required: true,
			guidance: `Document all configuration requirements:

**Environment Variables**:
| Variable | Type | Required | Default | Description | Example |
|----------|------|----------|---------|-------------|---------|
| DATABASE_URL | string | Yes | - | PostgreSQL connection string | "postgresql://..." |

**Feature Flags**:
| Flag | Type | Default | Description | Rollout Plan |
|------|------|---------|-------------|--------------|
| enable_apple_pay | boolean | false | Enable Apple Pay support | Gradual rollout 10% → 50% → 100% |

**Configuration Files**:
- Location and format of config files
- Environment-specific configs (dev, staging, prod)
- How to add new configuration values

**Secrets Management**:
- How secrets are stored (AWS Secrets Manager, etc.)
- Secret rotation policy
- How to access secrets in code`,
			example: `## Configuration Management

### Environment Variables

**Required Variables**:

| Variable | Type | Required | Default | Description | Example |
|----------|------|----------|---------|-------------|---------|
| \`DATABASE_URL\` | string | Yes | - | PostgreSQL connection string | "postgresql://user:pass@host:5432/db" |
| \`REDIS_URL\` | string | Yes | - | Redis connection string | "redis://localhost:6379" |
| \`STRIPE_API_KEY\` | string | Yes | - | Stripe secret key | "sk_live_..." |
| \`JWT_SECRET\` | string | Yes | - | Secret for JWT verification | (stored in Secrets Manager) |
| \`AUTH_SERVICE_URL\` | string | Yes | - | Auth service endpoint | "https://auth.company.com" |

**Optional Variables**:

| Variable | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| \`LOG_LEVEL\` | string | No | "info" | Logging level (debug, info, warn, error) |
| \`PORT\` | number | No | 3000 | HTTP server port |
| \`MAX_PAYMENT_AMOUNT\` | number | No | 1000000 | Max payment in cents ($10,000) |
| \`ENABLE_METRICS\` | boolean | No | true | Enable Prometheus metrics endpoint |
| \`RATE_LIMIT_PER_MINUTE\` | number | No | 100 | API rate limit per user |

### Feature Flags

**Infrastructure**: LaunchDarkly

**Flag Definitions**:

| Flag | Type | Default | Description | Target Audience | Rollout Plan |
|------|------|---------|-------------|-----------------|--------------|
| \`enable_apple_pay\` | boolean | false | Enable Apple Pay integration | All users | 10% → 25% → 50% → 100% over 2 weeks |
| \`enable_3ds_strict\` | boolean | false | Enforce 3D Secure for all EU transactions | EU users only | 100% immediate (regulatory) |
| \`enable_saved_payment_methods\` | boolean | true | Allow users to save payment methods | All users | 100% (fully launched) |
| \`payment_amount_limit\` | number | 1000000 | Max payment amount in cents | Per merchant | Varies by merchant risk profile |
| \`enable_refund_api\` | boolean | true | Expose refund API to merchants | Verified merchants | 100% for verified, 0% for others |

**Flag Usage in Code**:
\`\`\`typescript
import { getFeatureFlag } from '@/lib/feature-flags';

// Boolean flag
const isApplePayEnabled = await getFeatureFlag('enable_apple_pay', userId);

// Number flag with default
const maxAmount = await getFeatureFlag('payment_amount_limit', merchantId, 1000000);

// Percentage rollout (LaunchDarkly handles)
if (await getFeatureFlag('enable_new_checkout', userId)) {
  // New checkout flow
} else {
  // Old checkout flow
}
\`\`\`

### Configuration Files

**Structure**:
\`\`\`
config/
├── default.ts          # Default values (committed to git)
├── development.ts      # Local development overrides
├── staging.ts          # Staging environment
├── production.ts       # Production environment
└── test.ts            # Test environment
\`\`\`

**Example (config/default.ts)**:
\`\`\`typescript
export default {
  server: {
    port: parseInt(process.env.PORT || '3000'),
    host: process.env.HOST || '0.0.0.0',
  },
  
  payment: {
    minAmount: 50,          // $0.50 minimum
    maxAmount: 1_000_000,   // $10,000 maximum
    authorizationTTL: 7 * 24 * 60 * 60, // 7 days in seconds
  },
  
  stripe: {
    apiKey: process.env.STRIPE_API_KEY!,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
    timeout: 5000, // 5 second timeout
  },
  
  rateLimit: {
    perMinute: 100,
    perHour: 1000,
  },
};
\`\`\`

**Loading Configuration**:
\`\`\`typescript
import config from 'config';

// Access nested values
const maxAmount = config.get<number>('payment.maxAmount');
const stripeKey = config.get<string>('stripe.apiKey');
\`\`\`

### Secrets Management

**Storage**: AWS Secrets Manager (production), \`.env.local\` (development)

**Secret Naming Convention**: \`{service}/{environment}/{secret_name}\`
- Example: \`payment-api/production/stripe_api_key\`

**Accessing Secrets**:
\`\`\`typescript
import { getSecret } from '@/lib/secrets';

// Secrets are cached for 5 minutes to reduce API calls
const stripeKey = await getSecret('stripe_api_key');
\`\`\`

**Secret Rotation**:
- **Automatic rotation**: 90 days for API keys
- **Manual rotation required**: Immediately if compromised
- **Zero-downtime rotation**: Support 2 keys simultaneously during rotation period

**Required Secrets**:
| Secret | Description | Rotation Schedule |
|--------|-------------|-------------------|
| \`stripe_api_key\` | Stripe API secret key | 90 days (auto) |
| \`jwt_secret\` | JWT signing key | 365 days (manual) |
| \`database_password\` | PostgreSQL password | 90 days (auto via RDS) |
| \`webhook_signing_secret\` | Verify incoming webhooks | 180 days (manual) |

**Development Secrets**:
\`\`\`.env.local
# .env.local (gitignored)
DATABASE_URL=postgresql://localhost:5432/payments_dev
REDIS_URL=redis://localhost:6379
STRIPE_API_KEY=sk_test_...
JWT_SECRET=dev-secret-change-in-production
\`\`\``,
		},
		{
			name: "Operational Runbook",
			required: true,
			guidance: `Document operational procedures for common scenarios:

**Common Operations**:
- How to deploy to production
- How to rollback a deployment
- How to scale up/down
- How to enable/disable features

**Troubleshooting**:
| Symptom | Likely Cause | Investigation Steps | Resolution |
|---------|--------------|---------------------|------------|
| High latency | Database slow | Check slow query log | Optimize queries or add indexes |

**Monitoring & Alerts**:
- Key metrics to watch
- Alert thresholds
- Where to find logs and metrics

**Incident Response**:
- Who to contact (on-call rotation)
- Escalation procedures
- Communication templates

**Maintenance Procedures**:
- Database backup and restore
- Certificate renewal
- Dependency updates`,
			example: `## Operational Runbook

### Common Operations

#### Deploy to Production

**Prerequisites**:
- All tests passing in CI/CD
- Code review approved
- Staging deployment successful

**Procedure**:
\`\`\`bash
# 1. Create release tag
git tag -a v1.5.0 -m "Release v1.5.0: Add Apple Pay support"
git push origin v1.5.0

# 2. CI/CD automatically triggers (GitHub Actions)
# - Builds Docker image
# - Runs test suite
# - Deploys to production via blue-green deployment

# 3. Monitor deployment
kubectl rollout status deployment/payment-api -n production

# 4. Verify health
curl https://api.company.com/health/ready
# Expected: {"status":"ok","version":"1.5.0"}

# 5. Monitor key metrics for 15 minutes
# - Error rate < 0.1%
# - P95 latency < 200ms
# - No spike in alerts
\`\`\`

**Deployment Schedule**: Weekdays 10 AM - 2 PM ET (avoid Fridays and holidays)

**Rollback Procedure**: See "Rollback Deployment" below

---

#### Rollback Deployment

**When to Rollback**:
- Error rate > 1% for 5+ minutes
- Critical bug affecting payments
- Security vulnerability discovered

**Procedure**:
\`\`\`bash
# 1. Identify previous version
kubectl rollout history deployment/payment-api -n production

# 2. Rollback to previous version
kubectl rollout undo deployment/payment-api -n production

# 3. Monitor rollback
kubectl rollout status deployment/payment-api -n production

# 4. Verify health
curl https://api.company.com/health/ready

# 5. Post-incident
# - Update status page
# - Notify stakeholders
# - Schedule postmortem
\`\`\`

**Estimated Rollback Time**: 3-5 minutes

---

#### Scale Service

**Manual Scaling**:
\`\`\`bash
# Scale to 10 replicas
kubectl scale deployment/payment-api --replicas=10 -n production

# Verify scaling
kubectl get pods -n production | grep payment-api
\`\`\`

**Auto-scaling Configuration**:
- Current: 5-20 replicas
- Scale up: CPU > 70% for 2 min
- Scale down: CPU < 30% for 5 min

**When to Scale Manually**:
- Black Friday / Cyber Monday: Scale to 30 replicas preemptively
- Expected traffic spike: Scale 1 hour before event
- Database maintenance: Scale down to 3 replicas

---

### Troubleshooting Guide

#### High API Latency (P95 > 500ms)

**Symptoms**:
- Slow API responses
- Timeouts in client applications
- Increased error rate

**Investigation**:
\`\`\`bash
# 1. Check service health
curl https://api.company.com/health/ready

# 2. Check current latency
# Grafana: Dashboard > Payment API > Latency panel
# Look at P50, P95, P99 metrics

# 3. Identify slow endpoints
# Datadog APM: Group by endpoint, sort by P95 latency

# 4. Check database performance
# CloudWatch: RDS > Performance Insights
# Look for slow queries

# 5. Check external dependencies
# Stripe API status: https://status.stripe.com
# Auth Service health: curl https://auth.company.com/health
\`\`\`

**Common Causes & Resolutions**:

| Cause | How to Identify | Resolution |
|-------|----------------|------------|
| **Slow database query** | Slow query log shows query > 1s | Optimize query or add index |
| **Missing cache** | Cache hit rate < 80% | Warm cache or increase TTL |
| **Stripe API slow** | External call duration > 2s | Increase timeout, implement circuit breaker |
| **High CPU** | Pod CPU > 80% | Scale up replicas |
| **Memory leak** | Memory usage increasing over time | Restart pods, investigate memory leak |

---

#### Payment Failures Spike

**Symptoms**:
- Error rate > 1%
- Increased "payment_failed" events
- User complaints

**Investigation**:
\`\`\`bash
# 1. Check error rate
# Grafana: Payment API > Error Rate

# 2. Group errors by type
# Sentry: Filter by payment-api > Group by error.type

# 3. Check Stripe API status
curl https://api.stripe.com/v1/health

# 4. Check recent deployments
kubectl rollout history deployment/payment-api -n production

# 5. Review recent config changes
# LaunchDarkly: Audit log for flag changes
\`\`\`

**Common Causes**:

| Error Pattern | Likely Cause | Resolution |
|---------------|--------------|------------|
| All payments failing | Stripe API key invalid | Verify API key in Secrets Manager |
| Specific card type failing | Stripe API change | Check Stripe changelog, update integration |
| Intermittent failures | Timeout issues | Increase timeout or implement retry |
| EU payments failing | 3D Secure issue | Check 3DS implementation |

---

### Monitoring & Alerts

**Key Dashboards**:
1. **Service Health** (Grafana): Request rate, error rate, latency
2. **Business Metrics** (Grafana): Payments processed, revenue, success rate
3. **Infrastructure** (Grafana): CPU, memory, disk, network
4. **Database** (CloudWatch RDS): Connections, slow queries, replication lag

**Critical Alerts** (PagerDuty):

| Alert | Condition | Severity | Response Time | Action |
|-------|-----------|----------|---------------|--------|
| **Service Down** | 0 healthy pods | P0 | Immediate | Check deployment, rollback if needed |
| **High Error Rate** | > 1% for 5 min | P1 | 15 min | Investigate errors, rollback if necessary |
| **Payment Processing Stopped** | 0 payments for 5 min | P0 | Immediate | Check Stripe API, database, queue |
| **Database Connection Pool Exhausted** | All connections in use | P1 | 15 min | Restart pods or scale up database |
| **High Latency** | P95 > 500ms for 5 min | P2 | 1 hour | Optimize slow queries, check dependencies |

**Warning Alerts** (Slack only):

| Alert | Condition | Action |
|-------|-----------|--------|
| High CPU | > 70% for 10 min | Monitor, scale if sustained |
| Low Cache Hit Rate | < 80% for 30 min | Investigate cache configuration |
| Stripe API Slow | > 2s P95 for 10 min | Check Stripe status page |

---

### Incident Response

**On-Call Rotation**: See PagerDuty schedule

**Escalation Path**:
1. **Primary On-Call**: Payment team engineer (responds within 15 min)
2. **Secondary On-Call**: Senior engineer (escalate after 30 min if unresolved)
3. **Manager**: Engineering manager (escalate for P0 after 1 hour)
4. **Executive**: CTO (escalate if business impact > $100K or media attention)

**Incident Severity**:

| Severity | Definition | Example | Response Time |
|----------|------------|---------|---------------|
| **P0** | System down, revenue impact | All payments failing | Immediate |
| **P1** | Degraded service | 10% payment failure rate | 15 minutes |
| **P2** | Minor issue, workaround exists | Admin dashboard slow | 1 hour |
| **P3** | Low impact, non-urgent | Typo in log message | Next business day |

**Communication Templates**:

**Status Page Update** (P0/P1):
\`\`\`
We are currently investigating an issue with payment processing.
Users may experience delays or failures when making payments.
Our team is working on a resolution.

Last updated: [TIME]
Next update: [TIME + 30min]
\`\`\`

**All-Clear Message**:
\`\`\`
The payment processing issue has been resolved.
All systems are operating normally.
We apologize for any inconvenience.

Root cause: [BRIEF EXPLANATION]
Duration: [START TIME] - [END TIME]
\`\`\`

---

### Maintenance Procedures

#### Database Backup & Restore

**Automatic Backups**:
- RDS automated backups: Daily at 3 AM UTC
- Retention: 30 days
- Transaction log backups: Every 5 minutes

**Manual Backup**:
\`\`\`bash
# Create snapshot
aws rds create-db-snapshot \\
  --db-instance-identifier payment-db-prod \\
  --db-snapshot-identifier manual-backup-$(date +%Y%m%d-%H%M%S)
\`\`\`

**Restore from Backup**:
\`\`\`bash
# 1. Restore to new instance
aws rds restore-db-instance-from-db-snapshot \\
  --db-instance-identifier payment-db-restored \\
  --db-snapshot-identifier manual-backup-20240115-140000

# 2. Update connection string
#  (Coordinate with team before switching)

# 3. Verify data integrity
psql $RESTORED_DATABASE_URL -c "SELECT COUNT(*) FROM payments;"

# 4. Switch application to restored database
kubectl set env deployment/payment-api DATABASE_URL=$RESTORED_DATABASE_URL
\`\`\`

**Recovery Time Objective (RTO)**: 1 hour

**Recovery Point Objective (RPO)**: 5 minutes (transaction log frequency)

---

#### Certificate Renewal

**Automatic Renewal**: AWS Certificate Manager handles automatically

**Manual Verification** (quarterly):
\`\`\`bash
# Check certificate expiration
echo | openssl s_client -connect api.company.com:443 2>/dev/null | openssl x509 -noout -dates
\`\`\`

**Manual Renewal** (if needed):
1. Request new certificate in AWS ACM
2. Add DNS validation records
3. Wait for validation (5-30 minutes)
4. Update load balancer to use new certificate
5. Verify: \`curl -v https://api.company.com 2>&1 | grep "expire date"\`

---

#### Dependency Updates

**Schedule**: Monthly security patches, quarterly major updates

**Procedure**:
\`\`\`bash
# 1. Update dependencies
npm update

# 2. Check for vulnerabilities
npm audit

# 3. Run tests
npm test

# 4. Deploy to staging
# (Follow standard deployment procedure)

# 5. Monitor for 24 hours

# 6. Deploy to production
# (Follow standard deployment procedure)
\`\`\`

**Critical Security Updates**: Apply immediately (within 24 hours)`,
		},
		{
			name: "Implementation Plan",
			required: true,
			guidance: `Guide the implementation:

**Phases/Milestones**:
Break implementation into logical chunks:
| Phase | Description | Deliverables | Dependencies |

**Implementation Approach**:
- Recommended order of implementation
- Key files/modules to create or modify
- Integration points to consider

**Feature Flags**: If using progressive rollout, document flag strategy.

**Backward Compatibility**:
- Breaking changes and migration path
- Deprecation notices
- Version strategy

**Technical Tasks**:
Detailed task breakdown with estimates:
| Task | Description | Estimate | Dependencies |

**Risk Areas**: Parts that are complex or uncertain.`,
		},
		{
			name: "Testing Strategy",
			required: true,
			guidance: `Document comprehensive testing approach:

**Unit Testing**:
- Key units to test
- Mock/stub strategy
- Coverage expectations

**Integration Testing**:
- Integration points to test
- Test environment requirements
- Test data requirements

**End-to-End Testing**:
- Critical user flows to test
- Test scenarios (positive and negative)

**Performance Testing**:
- Load test scenarios
- Performance baselines
- Stress test approach

**Security Testing**:
- Vulnerability scanning
- Penetration testing scope
- Security review requirements

**Test Cases**:
Key test cases in table format:
| ID | Description | Preconditions | Steps | Expected Result |`,
		},
		{
			name: "Deployment",
			required: true,
			guidance: `Document deployment requirements:

**Deployment Strategy**:
- Rollout approach (big bang, canary, blue-green)
- Rollback procedure
- Feature flag configuration

**Infrastructure Changes**:
- New resources required
- Configuration changes
- Environment variables

**Database Migrations**:
- Migration scripts required
- Data backfill requirements
- Rollback scripts

**Monitoring & Alerting**:
- New metrics to track
- Alert thresholds
- Dashboard updates

**Runbook Updates**:
- Operational procedures
- Troubleshooting guides

**Dependencies**:
- External services to notify
- Team coordination requirements`,
		},
		{
			name: "Security Considerations",
			required: true,
			guidance: `Address security explicitly:

**Threat Model**:
- What are we protecting?
- Who might attack it?
- What could go wrong?

**Authentication & Authorization**:
- How are users authenticated?
- What permissions are required?
- How are permissions enforced?

**Data Protection**:
- Sensitive data identified
- Encryption requirements
- Data retention

**Input Validation**:
- What inputs need validation?
- Validation rules

**Audit Logging**:
- What needs to be logged?
- Log retention requirements

**Compliance**:
- Relevant regulations
- Compliance checklist`,
		},
		{
			name: "Error Handling",
			required: true,
			guidance: `Document error handling comprehensively:

**Error Flow Diagram**: Use a flowchart to show error handling:

\`\`\`mermaid
flowchart TD
    A[Request] --> B{Validate Input}
    B -->|Invalid| C[400 Bad Request]
    B -->|Valid| D{Process}
    D -->|Success| E[200 OK]
    D -->|Auth Failed| F[401/403 Error]
    D -->|Not Found| G[404 Not Found]
    D -->|Service Error| H{Retry?}
    H -->|Yes| I[Exponential Backoff]
    I --> D
    H -->|Max Retries| J[503 Service Unavailable]
    D -->|Unknown| K[500 Internal Error]
\`\`\`

**Error Categories**:
- User errors (invalid input)
- System errors (internal failures)
- External errors (dependency failures)

**Error Responses**:
| Error Code | Message | When | Recovery |

**Retry Strategies**:
- What operations are retried?
- Retry limits and backoff

**Circuit Breakers**:
- When to open circuit?
- Fallback behavior

**Graceful Degradation**:
- What features can degrade?
- Degraded behavior

**Error Monitoring**:
- Error tracking approach
- Alert thresholds`,
		},
		{
			name: "Open Questions",
			required: false,
			guidance: `Document uncertainties:

**Unresolved Questions**:
Questions that need answers before/during implementation.

**Assumptions**:
Things assumed to be true that could affect implementation.

**Decisions Needed**:
Choices that need to be made.

**Investigation Items**:
Areas requiring further research or prototyping.`,
		},
	],

	qualityChecklist: [
		"Document metadata is complete (version, status, author, reviewers)",
		"Glossary defines all technical terms, acronyms, and RFC 2119 keywords",
		"System context diagram shows boundaries and external dependencies",
		"Use cases include preconditions, postconditions, main/alternate/exception flows",
		"Data dictionary defines all entities with attributes, types, constraints, indexes",
		"All requirements use RFC 2119 keywords (MUST, SHOULD, MAY) and are testable",
		"Requirements are hierarchically numbered (REQ-1.1, REQ-1.2, REQ-2.1)",
		"API contracts are fully specified with examples",
		"Error handling is comprehensive with recovery strategies",
		"Security considerations are explicitly addressed",
		"Testing strategy covers unit, integration, and e2e scenarios",
		"Configuration management includes env vars, feature flags, secrets",
		"Operational runbook covers common operations and troubleshooting",
		"Deployment includes rollout and rollback procedures",
		"Edge cases are identified and handled",
		"Performance requirements have specific targets",
		"Dependencies and risks are clearly documented",
	],

	antiPatterns: [
		"Vague requirements that can't be tested",
		"Missing error handling and edge cases",
		"Security as an afterthought",
		"No testing strategy or coverage expectations",
		"Missing deployment and rollback procedures",
		"Incomplete API specifications",
		"Assuming implementation details without documenting",
		"No consideration of backward compatibility",
	],

	examples: {
		goodRequirement: `**REQ-003: Order Cancellation**

Users must be able to cancel orders within 30 minutes of placement if the order has not shipped.

**Priority**: Must Have

**Acceptance Criteria**:
- Given an order placed less than 30 minutes ago that hasn't shipped
- When the user clicks "Cancel Order"
- Then the order status changes to "Cancelled"
- And payment authorization is voided
- And inventory reservation is released
- And user receives cancellation confirmation email within 1 minute`,

		goodAPISpec: `### POST /api/v1/orders/{orderId}/cancel

**Description**: Cancel an existing order.

**Authentication**: Bearer token required

**Path Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| orderId | string | Yes | UUID of the order |

**Request Body**: None

**Response 200 OK**:
\`\`\`json
{
  "orderId": "123e4567-e89b-12d3-a456-426614174000",
  "status": "cancelled",
  "cancelledAt": "2024-01-15T10:30:00Z",
  "refundStatus": "pending"
}
\`\`\`

**Error Responses**:
| Code | Message | When |
|------|---------|------|
| 400 | ORDER_ALREADY_SHIPPED | Order has shipped |
| 400 | CANCELLATION_WINDOW_EXPIRED | >30 min since order |
| 404 | ORDER_NOT_FOUND | Order doesn't exist |
| 403 | NOT_ORDER_OWNER | User doesn't own order |`,
	},
};
