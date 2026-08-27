/**
 * API Specification Prompt Configuration
 *
 * Expert-level prompt for generating comprehensive API documentation
 * that enables developers to integrate quickly and correctly.
 */

import type { DocumentPromptConfig } from "../types";

export const API_SPEC_PROMPT: DocumentPromptConfig = {
	id: "api_spec",
	name: "API Specification",

	persona: `You are a senior API architect with 15+ years of experience designing APIs used by thousands of developers. You have built APIs at scale for platforms like Stripe, Twilio, and GitHub.

Your API documentation is known for:
- Developer-first design with intuitive endpoints
- Comprehensive examples that developers can copy and run
- Clear error handling that helps developers debug quickly
- Consistent patterns that reduce cognitive load
- Security best practices built in from the start
- Thorough coverage of edge cases

CRITICAL SECTIONS TO ALWAYS INCLUDE:
1. API Overview - what the API does, base URL, versioning strategy
2. Authentication - how to authenticate, obtain tokens, use API keys
3. Endpoints - all endpoints with request/response examples
4. Error Handling - error codes, error response format, common errors
5. Rate Limiting - rate limits, headers, how to handle 429 responses
6. Security - authentication methods, HTTPS requirements, best practices

You may combine related sections (e.g., "Authentication & Security" or "Error Handling & Status Codes") but ensure all critical topics are covered.`,

	sections: [
		{
			name: "API Metadata",
			required: true,
			guidance: `Provide OpenAPI 3.1 compatible metadata:

**OpenAPI Info Block**:
- Title: API name
- Version: Semantic version (e.g., 1.2.0)
- Description: What the API does
- Contact: Support email and team
- License: API license (MIT, proprietary, etc.)
- Terms of Service: Link to legal terms

**Servers**: Base URLs for different environments

**Tags**: Logical grouping of endpoints`,
			example: `## API Metadata

### OpenAPI Information

\`\`\`yaml
openapi: 3.1.0
info:
  title: Payment Processing API
  version: 2.5.0
  description: |
    RESTful API for processing payments, managing payment methods,
    and handling refunds. Supports credit cards, bank accounts, and
    digital wallets.
    
    Rate limit: 1000 requests per hour per API key.
    
  contact:
    name: API Support
    email: api-support@example.com
    url: https://developer.company.com/support
  
  license:
    name: Proprietary
    url: https://company.com/api-license
  
  termsOfService: https://company.com/terms

servers:
  - url: https://api.company.com/v2
    description: Production server
  - url: https://api-staging.company.com/v2
    description: Staging server (for testing)
  - url: https://api-sandbox.company.com/v2
    description: Sandbox server (test data, no real charges)

tags:
  - name: Payments
    description: Create, retrieve, and manage payments
  - name: Payment Methods
    description: Store and manage customer payment methods
  - name: Refunds
    description: Process full and partial refunds
  - name: Webhooks
    description: Configure webhooks for event notifications
\`\`\`

### API Version Information

| Version | Release Date | Status | EOL Date | Changes |
|---------|--------------|--------|----------|---------|
| v2.5.0 | 2024-01-15 | Current | - | Added Apple Pay support |
| v2.0.0 | 2023-10-01 | Supported | 2025-10-01 | Breaking: Removed v1 endpoints |
| v1.0.0 | 2023-01-01 | Deprecated | 2024-10-01 | Legacy version |`,
		},
		{
			name: "Design Principles",
			required: true,
			guidance: `Document API design philosophy and conventions:

**RESTful Principles**:
- Resource-oriented URLs
- HTTP methods for CRUD (GET, POST, PUT/PATCH, DELETE)
- Stateless interactions
- Standard HTTP status codes

**Naming Conventions**:
- URL structure: lowercase, hyphen-separated (\`/payment-methods\`)
- Resource names: plural nouns (\`/payments\`, \`/users\`)
- Query parameters: snake_case or camelCase (be consistent)

**URL Structure**:
\`\`\`
/v2/resources              # Collection
/v2/resources/{id}         # Individual resource
/v2/resources/{id}/sub     # Sub-resource
\`\`\`

**HTTP Methods**:
- GET: Read (safe, idempotent)
- POST: Create (not idempotent)
- PUT: Replace (idempotent)
- PATCH: Partial update (not idempotent)
- DELETE: Remove (idempotent)

**Idempotency**: POST requests use Idempotency-Key header for safe retries.`,
			example: `## Design Principles

### RESTful Constraints

1. **Client-Server**: Separation of concerns between UI and data storage
2. **Stateless**: Each request contains all necessary information
3. **Cacheable**: Responses explicitly indicate cacheability
4. **Layered System**: Client cannot tell if connected directly to end server
5. **Uniform Interface**: Consistent resource-based URLs and HTTP methods

### Naming Conventions

**Resource Names**: Plural nouns in lowercase with hyphens
- ✅ Good: \`/payments\`, \`/payment-methods\`, \`/bank-accounts\`
- ❌ Bad: \`/payment\`, \`/paymentMethods\`, \`/BankAccounts\`

**Query Parameters**: snake_case for consistency
- ✅ Good: \`?created_after=2024-01-01&sort_by=amount\`
- ❌ Bad: \`?createdAfter=2024-01-01&sortBy=amount\`

**Path Parameters**: camelCase or snake_case (be consistent)
- ✅ Good: \`/payments/{paymentId}\` or \`/payments/{payment_id}\`
- ❌ Bad: Mixing styles in same API

**Field Names in JSON**: camelCase
\`\`\`json
{
  "paymentId": "pay_123",
  "createdAt": "2024-01-15T10:30:00Z",
  "amountCents": 9999
}
\`\`\`

### URL Structure

\`\`\`
Base URL: https://api.company.com/v2

Resource Collections:
GET    /payments                      # List all payments
POST   /payments                      # Create a payment
GET    /payments/{id}                 # Get specific payment
PATCH  /payments/{id}                 # Update payment
DELETE /payments/{id}                 # Cancel payment

Sub-Resources:
GET    /payments/{id}/refunds         # List refunds for payment
POST   /payments/{id}/refunds         # Create refund
GET    /payments/{id}/refunds/{refundId}  # Get specific refund

Actions (non-CRUD):
POST   /payments/{id}/capture         # Capture authorized payment
POST   /payments/{id}/cancel          # Cancel pending payment
\`\`\`

### HTTP Methods & Semantics

| Method | Purpose | Safe? | Idempotent? | Request Body? | Response Body? |
|--------|---------|-------|-------------|---------------|----------------|
| **GET** | Retrieve resource(s) | ✅ Yes | ✅ Yes | ❌ No | ✅ Yes |
| **POST** | Create resource or action | ❌ No | ❌ No* | ✅ Yes | ✅ Yes |
| **PUT** | Replace entire resource | ❌ No | ✅ Yes | ✅ Yes | ✅ Yes |
| **PATCH** | Partial update | ❌ No | ❌ No** | ✅ Yes | ✅ Yes |
| **DELETE** | Remove resource | ❌ No | ✅ Yes | ❌ No | ❌ No*** |

*POST is idempotent when using Idempotency-Key header (see below)
**PATCH can be idempotent depending on operation semantics
***DELETE typically returns 204 No Content with empty body

### Idempotency

**POST Requests**: Use \`Idempotency-Key\` header to make safe retries:

\`\`\`http
POST /v2/payments HTTP/1.1
Authorization: Bearer sk_live_xxx
Idempotency-Key: a7b8c9d0-1234-5678-9abc-def012345678
Content-Type: application/json

{
  "amount": 9999,
  "currency": "usd",
  "paymentMethodId": "pm_123"
}
\`\`\`

**Idempotency Behavior**:
- First request: Processes normally, stores key for 24 hours
- Retry with same key within 24 hours: Returns original response (no duplicate charge)
- Different key: Treated as new request

**Key Requirements**:
- MUST be a UUID v4
- Unique per request (not per resource)
- Stored for 24 hours

### HTTP Status Codes

| Code | Meaning | Use Case |
|------|---------|----------|
| **200** OK | Success with body | GET, PATCH, PUT successful |
| **201** Created | Resource created | POST successful, returns resource |
| **202** Accepted | Async operation started | Long-running operation queued |
| **204** No Content | Success, no body | DELETE successful |
| **400** Bad Request | Invalid input | Validation errors |
| **401** Unauthorized | Missing/invalid auth | Missing or expired token |
| **403** Forbidden | Insufficient permissions | Valid auth but not allowed |
| **404** Not Found | Resource doesn't exist | GET /payments/invalid_id |
| **409** Conflict | Resource conflict | Duplicate idempotency key with different body |
| **422** Unprocessable Entity | Semantic error | Valid syntax but business logic rejects |
| **429** Too Many Requests | Rate limited | Exceeded rate limit |
| **500** Internal Server Error | Unexpected error | Server bug, unhandled exception |
| **502** Bad Gateway | Upstream error | Stripe API down |
| **503** Service Unavailable | Temporary outage | Planned maintenance |
| **504** Gateway Timeout | Upstream timeout | Stripe API slow |`,
		},
		{
			name: "Resource Model",
			required: true,
			guidance: `Define the domain model with resource relationships:

**Resource Hierarchy**: Show how resources relate to each other.

**For Each Resource**:
- Resource name and description
- Primary key structure
- Relationships to other resources (one-to-one, one-to-many, many-to-many)
- Available operations (GET, POST, PATCH, DELETE)

**Example**:
\`\`\`
User (1) ----< (Many) Payment
Payment (1) ----< (Many) Refund
User (1) ----< (Many) PaymentMethod
Payment (Many) >---- (1) PaymentMethod
\`\`\``,
			example: `## Resource Model

### Resource Hierarchy

\`\`\`mermaid
erDiagram
    USER ||--o{ PAYMENT : "makes"
    USER ||--o{ PAYMENT_METHOD : "has"
    PAYMENT ||--o{ REFUND : "has"
    PAYMENT }o--|| PAYMENT_METHOD : "uses"
    PAYMENT ||--o{ PAYMENT_EVENT : "emits"
    
    USER {
        uuid id PK
        string email
        timestamp created_at
    }
    
    PAYMENT {
        uuid id PK
        uuid user_id FK
        uuid payment_method_id FK
        integer amount
        string currency
        enum status
        timestamp created_at
    }
    
    PAYMENT_METHOD {
        uuid id PK
        uuid user_id FK
        enum type
        string last_four
        boolean is_default
    }
    
    REFUND {
        uuid id PK
        uuid payment_id FK
        integer amount
        enum status
        timestamp created_at
    }
    
    PAYMENT_EVENT {
        uuid id PK
        uuid payment_id FK
        enum event_type
        jsonb data
        timestamp created_at
    }
\`\`\`

### Resource Definitions

#### Payment

**Description**: Represents a payment transaction

**Endpoints**:
- \`GET /v2/payments\` - List payments
- \`POST /v2/payments\` - Create payment
- \`GET /v2/payments/{id}\` - Get payment
- \`POST /v2/payments/{id}/capture\` - Capture authorized payment
- \`POST /v2/payments/{id}/cancel\` - Cancel pending payment

**ID Format**: \`pay_\` prefix + 24 alphanumeric characters (e.g., \`pay_1A2B3C4D5E6F7G8H9I0J1K2L\`)

**Relationships**:
- **User** (many-to-one): Each payment belongs to one user
- **PaymentMethod** (many-to-one): Each payment uses one payment method
- **Refunds** (one-to-many): Each payment can have multiple refunds

**Lifecycle States**:
\`\`\`
pending → authorized → captured
   ↓           ↓
failed      canceled
   ↓
captured → refunded
\`\`\`

**Available Operations**:
| Operation | Endpoint | Idempotent? |
|-----------|----------|-------------|
| Create | POST /payments | Yes (with Idempotency-Key) |
| Retrieve | GET /payments/{id} | Yes |
| List | GET /payments | Yes |
| Capture | POST /payments/{id}/capture | Yes |
| Cancel | POST /payments/{id}/cancel | Yes |

---

#### PaymentMethod

**Description**: Tokenized payment method (card, bank account)

**Endpoints**:
- \`GET /v2/payment-methods\` - List user's payment methods
- \`POST /v2/payment-methods\` - Add payment method
- \`GET /v2/payment-methods/{id}\` - Get payment method
- \`PATCH /v2/payment-methods/{id}\` - Update (e.g., set as default)
- \`DELETE /v2/payment-methods/{id}\` - Remove payment method

**ID Format**: \`pm_\` prefix + 24 alphanumeric characters

**Relationships**:
- **User** (many-to-one): Each payment method belongs to one user
- **Payments** (one-to-many): One payment method can be used for multiple payments

**Types**:
- \`card\`: Credit/debit card
- \`bank_account\`: Bank account (ACH)
- \`wallet\`: Digital wallet (Apple Pay, Google Pay)

**Available Operations**:
| Operation | Endpoint | Idempotent? |
|-----------|----------|-------------|
| Create | POST /payment-methods | Yes (with Idempotency-Key) |
| Retrieve | GET /payment-methods/{id} | Yes |
| List | GET /payment-methods | Yes |
| Update | PATCH /payment-methods/{id} | No |
| Delete | DELETE /payment-methods/{id} | Yes |

---

#### Refund

**Description**: Full or partial refund of a captured payment

**Endpoints**:
- \`GET /v2/payments/{payment_id}/refunds\` - List refunds for payment
- \`POST /v2/payments/{payment_id}/refunds\` - Create refund
- \`GET /v2/refunds/{id}\` - Get refund

**ID Format**: \`ref_\` prefix + 24 alphanumeric characters

**Relationships**:
- **Payment** (many-to-one): Each refund belongs to one payment
- Total refunded amount cannot exceed payment amount

**Lifecycle States**:
\`\`\`
pending → succeeded
   ↓
failed
\`\`\`

**Available Operations**:
| Operation | Endpoint | Idempotent? |
|-----------|----------|-------------|
| Create | POST /payments/{id}/refunds | Yes (with Idempotency-Key) |
| Retrieve | GET /refunds/{id} | Yes |
| List | GET /payments/{id}/refunds | Yes |

---

### Sub-Resources vs. Top-Level Resources

**Sub-Resources** (accessed via parent):
- \`/payments/{id}/refunds\` - Refunds always scoped to payment
- Tightly coupled to parent resource
- Cannot exist without parent

**Top-Level Resources** (direct access):
- \`/refunds/{id}\` - Direct access for cross-payment queries
- Can be referenced independently
- Useful for admin dashboards and reporting

**Best Practice**: Provide both when resource is frequently accessed directly.`,
		},
		{
			name: "Overview",
			required: true,
			guidance: `Introduce the API:

**Purpose**: What does this API do? What problems does it solve?

**Base URL**: Production and sandbox/development URLs.

**API Style**: REST, GraphQL, gRPC, etc.

**Versioning**: How is the API versioned? (URL path, header, etc.)

**Content Type**: Supported request/response formats (JSON, etc.)

**Quick Start**: Minimal example to make a successful API call.

Write this section for a developer who has never seen your API before. They should be able to make their first successful call within 5 minutes of reading.`,
		},
		{
			name: "Authentication",
			required: true,
			guidance: `Document authentication thoroughly:

**Authentication Method**:
- API keys, OAuth 2.0, JWT, etc.
- How to obtain credentials
- Where to use them (header, query param, etc.)

**Examples**: Show exactly how to authenticate:
\`\`\`bash
curl -H "Authorization: Bearer YOUR_API_KEY" https://api.example.com/v1/resource
\`\`\`

**Token Lifecycle**:
- Token expiration
- Refresh token flow (if applicable)
- Revoking access

**Scopes/Permissions** (if applicable):
| Scope | Description | Access Level |

**Security Best Practices**:
- How to store credentials safely
- Rate limiting by auth type
- IP whitelisting (if available)`,
		},
		{
			name: "Endpoints",
			required: true,
			guidance: `Document each endpoint completely:

**For Each Endpoint**:

### METHOD /path/to/resource

**Description**: What this endpoint does.

**Authentication**: Required auth type and scopes.

**Path Parameters**:
| Name | Type | Required | Description |

**Query Parameters**:
| Name | Type | Required | Default | Description |

**Request Body** (for POST/PUT/PATCH):
- JSON schema or typed structure
- Required vs optional fields
- Validation rules
- Example request body

**Response**:
- Status codes with meaning
- Response body schema
- Example response

**Code Examples**:
Show examples in multiple languages (curl, JavaScript, Python).

Group endpoints logically by resource or domain.`,
		},
		{
			name: "Common Patterns",
			required: true,
			guidance: `Document standard patterns used across the API:

**Pagination**:
- Style: Cursor-based or offset-based
- Request parameters (\`limit\`, \`starting_after\`, \`ending_before\`)
- Response structure (data array + pagination metadata)

**Filtering**:
- Filter syntax (query parameters)
- Supported operators (equals, greater than, contains, etc.)
- Multiple filter combination (AND/OR logic)

**Sorting**:
- Sort parameter format (\`sort_by=field\` or \`sort=field:asc\`)
- Multiple sort fields
- Default sort order

**Field Selection** (Sparse Fieldsets):
- How to request specific fields (\`fields=id,name,email\`)
- Nested field syntax
- Performance benefits

**Expansion** (Related Resources):
- How to include related resources (\`expand=user,payment_method\`)
- Depth limits
- Performance considerations`,
			example: `## Common Patterns

### Pagination

**Strategy**: Cursor-based pagination for consistent results

**Request Parameters**:
| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| \`limit\` | integer | Number of results (1-100, default 10) | \`?limit=50\` |
| \`starting_after\` | string | Cursor to get results after | \`?starting_after=pay_xyz\` |
| \`ending_before\` | string | Cursor to get results before | \`?ending_before=pay_abc\` |

**Example Request**:
\`\`\`http
GET /v2/payments?limit=20&starting_after=pay_1234567890
\`\`\`

**Response Structure**:
\`\`\`json
{
  "object": "list",
  "url": "/v2/payments",
  "has_more": true,
  "data": [
    {
      "id": "pay_2345678901",
      "amount": 9999,
      "currency": "usd",
      "status": "captured",
      "created": 1705324800
    },
    // ... more payments
  ]
}
\`\`\`

**Pagination Links** (in response headers):
\`\`\`http
Link: <https://api.company.com/v2/payments?starting_after=pay_9999999999&limit=20>; rel="next"
\`\`\`

**Why Cursor-Based?**:
- Consistent results even when data changes
- No "page drift" problem (offset-based can skip/duplicate items)
- Better performance for large datasets

---

### Filtering

**Syntax**: Query parameters with operators

**Basic Filters** (exact match):
\`\`\`http
GET /v2/payments?status=captured&currency=usd
\`\`\`

**Range Filters**:
| Operator | Parameter Format | Example |
|----------|------------------|---------|
| Greater than | \`field[gt]=value\` | \`created[gt]=1705324800\` |
| Greater or equal | \`field[gte]=value\` | \`amount[gte]=10000\` |
| Less than | \`field[lt]=value\` | \`created[lt]=1705497600\` |
| Less or equal | \`field[lte]=value\` | \`amount[lte]=50000\` |

**Example**:
\`\`\`http
GET /v2/payments?amount[gte]=1000&amount[lte]=10000&created[gte]=2024-01-01
\`\`\`
*(Payments between $10 and $100, created after Jan 1, 2024)*

**String Filters**:
\`\`\`http
GET /v2/payments?customer_email[contains]=john@example.com
\`\`\`

**Multiple Values** (OR logic):
\`\`\`http
GET /v2/payments?status=captured&status=refunded
\`\`\`
*(Payments that are captured OR refunded)*

**Combination** (AND logic by default):
\`\`\`http
GET /v2/payments?status=captured&currency=usd&amount[gte]=10000
\`\`\`
*(Payments that are captured AND in USD AND >= $100)*

---

### Sorting

**Syntax**: \`sort\` parameter with field name and direction

**Format**: \`?sort=field:direction\`
- \`direction\`: \`asc\` (ascending, default) or \`desc\` (descending)

**Examples**:
\`\`\`http
# Sort by created date, newest first
GET /v2/payments?sort=created:desc

# Sort by amount, highest first
GET /v2/payments?sort=amount:desc

# Multiple sort fields (comma-separated)
GET /v2/payments?sort=status:asc,created:desc
\`\`\`

**Default Sort**: \`created:desc\` (newest first)

**Sortable Fields**:
- \`created\` - Creation timestamp
- \`amount\` - Payment amount
- \`status\` - Payment status (alphabetically)

**Non-Sortable Fields**: Fields not indexed or too expensive to sort

---

### Field Selection (Sparse Fieldsets)

**Purpose**: Reduce response size by requesting only needed fields

**Syntax**: \`fields\` parameter with comma-separated field names

**Example**:
\`\`\`http
GET /v2/payments/pay_123?fields=id,amount,currency,status
\`\`\`

**Response**:
\`\`\`json
{
  "id": "pay_123",
  "amount": 9999,
  "currency": "usd",
  "status": "captured"
}
\`\`\`
*(Only requested fields returned, \`created\`, \`updated\`, etc. omitted)*

**Nested Fields**:
\`\`\`http
GET /v2/payments?fields=id,user.name,user.email&expand=user
\`\`\`

**Performance Benefits**:
- Smaller response size (faster transfer)
- Reduced parsing time on client
- Lower database query cost (projection)

---

### Expansion (Including Related Resources)

**Purpose**: Include related resources in a single request (avoid N+1 queries)

**Syntax**: \`expand\` parameter with comma-separated relation names

**Example**:
\`\`\`http
GET /v2/payments/pay_123?expand=user,payment_method
\`\`\`

**Response Without Expansion**:
\`\`\`json
{
  "id": "pay_123",
  "user_id": "user_456",
  "payment_method_id": "pm_789",
  "amount": 9999
}
\`\`\`

**Response With Expansion**:
\`\`\`json
{
  "id": "pay_123",
  "user_id": "user_456",
  "user": {
    "id": "user_456",
    "email": "john@example.com",
    "name": "John Doe"
  },
  "payment_method_id": "pm_789",
  "payment_method": {
    "id": "pm_789",
    "type": "card",
    "brand": "visa",
    "last_four": "4242"
  },
  "amount": 9999
}
\`\`\`

**Nested Expansion**:
\`\`\`http
GET /v2/payments?expand=refunds,refunds.created_by
\`\`\`

**Depth Limit**: Maximum 3 levels of nesting

**Performance**: Expands use SQL JOINs - use sparingly in lists`,
		},
		{
			name: "Request/Response Formats",
			required: true,
			guidance: `Document data formats:

**Common Data Types**:
| Type | Format | Example |
(dates, IDs, enums, etc.)

**Pagination**:
- Pagination style (offset, cursor)
- Request parameters
- Response structure
- Example usage

**Filtering**:
- Filter syntax
- Supported operators
- Example queries

**Sorting**:
- Sort parameter format
- Sortable fields
- Default sort order

**Field Selection** (if supported):
- How to request specific fields
- Nested field syntax

**Common Objects**:
Document shared/reusable objects that appear across endpoints.`,
		},
		{
			name: "Error Handling",
			required: true,
			guidance: `Make errors developer-friendly:

**Error Response Format**:
\`\`\`json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable message",
    "details": [...]
  }
}
\`\`\`

**HTTP Status Codes**:
| Code | Meaning | When It Occurs |
| 400 | Bad Request | Invalid input |
| 401 | Unauthorized | Missing/invalid auth |
| 403 | Forbidden | Insufficient permissions |
| 404 | Not Found | Resource doesn't exist |
| 429 | Rate Limited | Too many requests |
| 500 | Server Error | Unexpected error |

**Error Codes**:
| Code | Description | Resolution |

**Validation Errors**:
How validation errors are structured, with examples.

**Retry Guidance**:
- Which errors are retryable
- Recommended retry strategy`,
		},
		{
			name: "Rate Limiting",
			required: true,
			guidance: `Document rate limits clearly:

**Rate Limits**:
| Endpoint/Category | Limit | Window |

**Rate Limit Headers**:
| Header | Description |
| X-RateLimit-Limit | Max requests allowed |
| X-RateLimit-Remaining | Requests remaining |
| X-RateLimit-Reset | When limit resets |

**Handling Rate Limits**:
- How to detect rate limiting (429 response)
- Recommended backoff strategy
- Example code for handling limits

**Increasing Limits**:
How to request higher limits if available.`,
		},
		{
			name: "Long-Running Operations",
			required: false,
			guidance: `Document async patterns for operations that take > 5 seconds:

**Async Pattern**:
1. Client initiates operation with POST
2. Server returns 202 Accepted with operation ID
3. Client polls status endpoint
4. Server notifies via webhook when complete (optional)

**Status Endpoint**: \`GET /v2/operations/{id}\`

**Polling Recommendations**:
- Initial: Poll every 1 second
- After 10 seconds: Poll every 5 seconds
- After 60 seconds: Poll every 30 seconds
- Max wait: 5 minutes, then timeout

**Webhook Notification**: Notify client when operation completes.`,
			example: `## Long-Running Operations

### Async Pattern for Bulk Operations

**Use Case**: Operations that take >5 seconds (bulk imports, report generation, large refunds)

**Flow**:

1. **Client initiates operation**:
\`\`\`http
POST /v2/refunds/bulk HTTP/1.1
Content-Type: application/json

{
  "payment_ids": ["pay_001", "pay_002", ..., "pay_100"],
  "reason": "Product recall"
}
\`\`\`

2. **Server responds 202 Accepted**:
\`\`\`http
HTTP/1.1 202 Accepted
Content-Type: application/json

{
  "operation_id": "op_abc123xyz",
  "status": "pending",
  "status_url": "/v2/operations/op_abc123xyz",
  "estimated_completion": "2024-01-15T10:35:00Z"
}
\`\`\`

3. **Client polls status endpoint**:
\`\`\`http
GET /v2/operations/op_abc123xyz HTTP/1.1
\`\`\`

**Response (in progress)**:
\`\`\`json
{
  "id": "op_abc123xyz",
  "type": "bulk_refund",
  "status": "processing",
  "progress": {
    "completed": 45,
    "total": 100,
    "percentage": 45
  },
  "created_at": "2024-01-15T10:30:00Z",
  "estimated_completion": "2024-01-15T10:35:00Z"
}
\`\`\`

**Response (complete)**:
\`\`\`json
{
  "id": "op_abc123xyz",
  "type": "bulk_refund",
  "status": "completed",
  "result": {
    "successful": 98,
    "failed": 2,
    "refund_ids": ["ref_001", "ref_002", ...],
    "errors": [
      {
        "payment_id": "pay_055",
        "error": "Already refunded"
      },
      {
        "payment_id": "pay_087",
        "error": "Insufficient funds"
      }
    ]
  },
  "created_at": "2024-01-15T10:30:00Z",
  "completed_at": "2024-01-15T10:34:27Z"
}
\`\`\`

4. **Webhook notification (optional)**:
\`\`\`http
POST https://merchant.com/webhooks HTTP/1.1
Content-Type: application/json

{
  "event_type": "operation.completed",
  "operation_id": "op_abc123xyz",
  "status": "completed",
  "timestamp": "2024-01-15T10:34:27Z"
}
\`\`\`

### Polling Best Practices

**Exponential Backoff**:
\`\`\`javascript
// Pseudocode for polling
let delay = 1000; // Start with 1 second
const maxDelay = 30000; // Cap at 30 seconds
const timeout = 300000; // 5 minute total timeout

while (status !== 'completed' && elapsed < timeout) {
  response = await fetch(\`/v2/operations/\${operationId}\`);
  status = response.status;
  
  if (status === 'processing') {
    await sleep(delay);
    delay = Math.min(delay * 1.5, maxDelay); // Exponential backoff
  }
}
\`\`\`

**HTTP Headers**:
- \`Retry-After\`: Server suggests next poll time (in seconds)
- \`X-RateLimit-Remaining\`: Check to avoid rate limiting

### Operation Lifecycle

\`\`\`
pending → processing → completed
   ↓            ↓
failed       failed
\`\`\`

**Status Values**:
- \`pending\`: Queued but not yet started
- \`processing\`: In progress
- \`completed\`: Successfully finished
- \`failed\`: Permanently failed
- \`canceled\`: User canceled operation`,
		},
		{
			name: "Batch Operations",
			required: false,
			guidance: `Document bulk create/update/delete patterns (optional):

**Batch Endpoint**: Single endpoint to process multiple operations.

**Request Format**:
\`\`\`json
{
  "operations": [
    {"method": "POST", "path": "/payments", "body": {...}},
    {"method": "PATCH", "path": "/payments/pay_123", "body": {...}},
    {"method": "DELETE", "path": "/payments/pay_456"}
  ]
}
\`\`\`

**Response Format**: Array of results matching request order.

**Error Handling**:
- Atomic: All succeed or all fail (transaction)
- Best-effort: Process all, return individual results
- Stop-on-error: Stop at first failure

**Rate Limiting**: Batch counts as single request or N requests?`,
			example: `## Batch Operations

### Batch API Endpoint

**Use Case**: Reduce round trips by sending multiple operations in one request

**Endpoint**: \`POST /v2/batch\`

**Request**:
\`\`\`json
{
  "operations": [
    {
      "id": "op1",
      "method": "POST",
      "path": "/v2/payments",
      "body": {
        "amount": 9999,
        "currency": "usd",
        "payment_method_id": "pm_123"
      }
    },
    {
      "id": "op2",
      "method": "PATCH",
      "path": "/v2/payment-methods/pm_456",
      "body": {
        "is_default": true
      }
    },
    {
      "id": "op3",
      "method": "DELETE",
      "path": "/v2/payment-methods/pm_789"
    }
  ],
  "mode": "best_effort"
}
\`\`\`

**Response**:
\`\`\`json
{
  "results": [
    {
      "id": "op1",
      "status": 201,
      "body": {
        "id": "pay_new123",
        "amount": 9999,
        "status": "captured"
      }
    },
    {
      "id": "op2",
      "status": 200,
      "body": {
        "id": "pm_456",
        "is_default": true
      }
    },
    {
      "id": "op3",
      "status": 404,
      "error": {
        "code": "resource_not_found",
        "message": "Payment method not found"
      }
    }
  ]
}
\`\`\`

### Batch Modes

| Mode | Behavior | Use Case |
|------|----------|----------|
| **best_effort** | Process all operations, return individual results | Independent operations |
| **atomic** | All succeed or all fail (transaction) | Related operations that must succeed together |
| **stop_on_error** | Stop at first failure | Ordered operations with dependencies |

**Example (atomic mode)**:
\`\`\`json
{
  "operations": [...],
  "mode": "atomic"
}
\`\`\`

If any operation fails, entire batch is rolled back.

### Rate Limiting

**Batch Counting**: Each operation counts toward rate limit individually
- Batch of 10 operations = 10 requests toward rate limit
- Prevents rate limit bypass via batching

**Limits**:
- Max operations per batch: 100
- Batch endpoint rate limit: 10 requests per minute

### Best Practices

**Use Batching For**:
- Bulk imports (create many resources)
- Dashboard loads (fetch multiple resources)
- Cascade updates (update related resources)

**Don't Use Batching For**:
- Critical path operations (adds latency)
- Operations requiring immediate feedback
- Unrelated operations (reduces clarity)`,
		},
		{
			name: "Webhooks",
			required: false,
			guidance: `Document webhook integration (if applicable):

**Webhook Overview**:
What events trigger webhooks.

**Event Types**:
| Event | Description | Payload |

**Payload Format**:
Common structure with example.

**Security**:
- Signature verification
- IP whitelisting
- HTTPS requirements

**Handling Webhooks**:
- Expected response
- Retry behavior on failure
- Idempotency considerations

**Testing Webhooks**:
How to test webhook integration.`,
		},
		{
			name: "SDKs & Code Examples",
			required: false,
			guidance: `Help developers get started quickly:

**Official SDKs**:
Links to official client libraries with installation instructions.

**Code Examples**:
Complete, runnable examples for common use cases:
- Authentication
- CRUD operations
- Error handling
- Pagination

**Postman/OpenAPI**:
Links to API collections for testing.

**Sandbox/Testing**:
How to use sandbox environment for testing.`,
		},
		{
			name: "API Deprecation Policy",
			required: true,
			guidance: `Document how features are deprecated and removed:

**Deprecation Timeline**: Minimum notice period before removal.

**Deprecation Headers**:
- \`Deprecation\`: Indicates the feature is deprecated
- \`Sunset\`: Date when feature will be removed
- \`Link\`: URL to migration guide

**Communication**:
- Email notifications to API consumers
- Changelog entries
- In-app warnings

**Migration Guides**: Step-by-step guides for each breaking change.

**Support Policy**: How long deprecated versions are supported.`,
			example: `## API Deprecation Policy

### Deprecation Timeline

**Standard Deprecation**: 12 months notice minimum
- Announce deprecation (email, changelog, docs)
- Add deprecation headers to responses
- Provide migration guide
- Remove after 12 months

**Security-Related Deprecation**: Immediate removal possible
- Critical vulnerabilities
- Compliance requirements
- Zero-day exploits

### Deprecation Headers

**Response Headers for Deprecated Endpoints**:
\`\`\`http
HTTP/1.1 200 OK
Deprecation: true
Sunset: Sat, 31 Dec 2024 23:59:59 GMT
Link: <https://docs.company.com/migration/v1-to-v2>; rel="deprecation"
Warning: 299 - "This endpoint is deprecated and will be removed on 2024-12-31"

{
  "id": "pay_123",
  ...
}
\`\`\`

**Field-Level Deprecation** (in response body):
\`\`\`json
{
  "id": "pay_123",
  "legacy_field": "value",
  "_warnings": [
    {
      "field": "legacy_field",
      "message": "This field is deprecated and will be removed in v3.0",
      "sunset": "2024-12-31",
      "migration_url": "https://docs.company.com/migration/legacy-field"
    }
  ]
}
\`\`\`

### Communication Plan

**6 Months Before Sunset**:
- Email all API consumers using deprecated feature
- Blog post announcement
- Update API documentation with deprecation notice
- Add deprecation headers

**3 Months Before Sunset**:
- Second email reminder
- In-app notifications (if applicable)
- Increase logging for deprecated feature usage

**1 Month Before Sunset**:
- Final email warning
- Status page banner
- Slack/Discord announcement (if community exists)

**After Sunset**:
- Feature returns 410 Gone (not 404 Not Found)
- Response body includes migration guide link

### Migration Guides

**Required Content**:
- What's changing and why
- Timeline with key dates
- Code examples (before/after)
- FAQ section

**Example Migration Guide Structure**:
\`\`\`markdown
# Migrating from /v1/payments to /v2/payments

## Timeline
- **2024-01-15**: v2 released, v1 still supported
- **2024-07-15**: v1 deprecated (6 months notice)
- **2025-01-15**: v1 sunset (removed)

## What Changed
- Payment status values changed: "success" → "captured"
- Amount field now in cents (integer) instead of dollars (float)
- New required field: \`currency\`

## Before (v1)
\`\`\`json
{
  "amount": 99.99,
  "status": "success"
}
\`\`\`

## After (v2)
\`\`\`json
{
  "amount": 9999,
  "currency": "usd",
  "status": "captured"
}
\`\`\`

## Migration Checklist
- [ ] Update base URL from /v1/ to /v2/
- [ ] Convert amount from dollars to cents (multiply by 100)
- [ ] Add \`currency\` field to all requests
- [ ] Update status value mappings
- [ ] Test in sandbox environment
- [ ] Update production code
\`\`\`

### Version Support Policy

| Version | Status | Support Level | EOL Date |
|---------|--------|---------------|----------|
| **v2.5** | Current | Full support + new features | - |
| **v2.0** | Supported | Bug fixes + security patches | 2025-10-01 |
| **v1.0** | Deprecated | Security patches only | 2024-10-01 |

**Support Levels**:
- **Full support**: Bug fixes, security patches, new features
- **Bug fixes + security**: No new features, only critical fixes
- **Security patches only**: Only critical security vulnerabilities
- **End of Life (EOL)**: No support, removed from API

### Sunset Response

**After Sunset Date**:
\`\`\`http
HTTP/1.1 410 Gone
Content-Type: application/json

{
  "error": {
    "code": "endpoint_removed",
    "message": "This endpoint was removed on 2024-10-01.",
    "migration_guide": "https://docs.company.com/migration/v1-to-v2",
    "current_version": "v2.5.0",
    "recommended_endpoint": "https://api.company.com/v2/payments"
  }
}
\`\`\`

**410 Gone vs 404 Not Found**:
- \`410 Gone\`: Resource once existed but was intentionally removed
- \`404 Not Found\`: Resource never existed or wrong URL`,
		},
		{
			name: "Client SDK Guidance",
			required: false,
			guidance: `Document SDKs and developer tooling (optional):

**Official SDKs**: Links to client libraries with installation instructions.

**Supported Languages**: List of languages with SDK availability.

**SDK Features**:
- Automatic retries
- Type safety
- Built-in pagination
- Error handling

**Code Generation**: OpenAPI spec can be used to generate clients.

**Community SDKs**: Unofficial libraries maintained by community.`,
			example: `## Client SDK Guidance

### Official SDKs

| Language | Package | Installation | Documentation |
|----------|---------|--------------|---------------|
| **JavaScript** | \`@company/payment-sdk\` | \`npm install @company/payment-sdk\` | [Docs](https://docs.company.com/sdk/js) |
| **Python** | \`company-payment\` | \`pip install company-payment\` | [Docs](https://docs.company.com/sdk/python) |
| **Ruby** | \`company-payment\` | \`gem install company-payment\` | [Docs](https://docs.company.com/sdk/ruby) |
| **PHP** | \`company/payment-sdk\` | \`composer require company/payment-sdk\` | [Docs](https://docs.company.com/sdk/php) |
| **Go** | \`github.com/company/payment-go\` | \`go get github.com/company/payment-go\` | [Docs](https://docs.company.com/sdk/go) |
| **Java** | \`com.company:payment-sdk\` | Maven/Gradle | [Docs](https://docs.company.com/sdk/java) |

### Quick Start (JavaScript)

\`\`\`javascript
import { PaymentClient } from '@company/payment-sdk';

const client = new PaymentClient({
  apiKey: process.env.PAYMENT_API_KEY,
  environment: 'production', // or 'sandbox'
});

// Create a payment
const payment = await client.payments.create({
  amount: 9999,
  currency: 'usd',
  paymentMethodId: 'pm_123',
});

// List payments with automatic pagination
for await (const payment of client.payments.list({ limit: 100 })) {
  console.log(payment.id, payment.amount);
}

// Error handling
try {
  await client.payments.capture('pay_123');
} catch (error) {
  if (error.type === 'card_error') {
    console.error('Card declined:', error.message);
  } else {
    throw error;
  }
}
\`\`\`

### SDK Features

**Automatic Retries**:
- Retries on network errors (exponential backoff)
- Retries on 429 Too Many Requests
- Respects \`Retry-After\` header
- Configurable max retries

**Type Safety** (TypeScript/Java/C#):
- Full TypeScript definitions
- Compile-time type checking
- IntelliSense support

**Built-in Pagination**:
- Async iterators (JavaScript)
- Generators (Python)
- Automatic cursor handling

**Idempotency**:
- Automatic \`Idempotency-Key\` generation
- Configurable idempotency keys

**Request/Response Logging**:
- Debug mode for troubleshooting
- Redacts sensitive data (API keys, card numbers)

### Code Generation from OpenAPI

**Generate Client from OpenAPI Spec**:

**OpenAPI Generator**:
\`\`\`bash
npm install @openapitools/openapi-generator-cli -g

openapi-generator-cli generate \\
  -i https://api.company.com/openapi.json \\
  -g typescript-fetch \\
  -o ./generated-client
\`\`\`

**Supported Generators**:
- \`typescript-fetch\`: TypeScript with Fetch API
- \`python\`: Python client
- \`go\`: Go client
- \`java\`: Java client
- \`csharp\`: C# client

**Generated Code Quality**: Production-ready with proper types and error handling

### Community SDKs

**Unofficial Libraries** (use at your own risk):
| Language | Package | Maintainer |
|----------|---------|------------|
| Rust | \`payment-rs\` | [@rustdev](https://github.com/rustdev) |
| Elixir | \`payment_ex\` | [@elixirdev](https://github.com/elixirdev) |

**Contributing**: We welcome community contributions! See [SDK Contributing Guide](https://github.com/company/sdk-guidelines)`,
		},
		{
			name: "OpenAPI Schema",
			required: true,
			guidance: `Provide complete OpenAPI 3.1 schema or link to it:

**Schema Location**: URL where full OpenAPI spec can be downloaded.

**Interactive Documentation**: Link to Swagger UI or similar tool.

**Schema Format**: JSON or YAML.

**Validation**: How to validate requests/responses against schema.

**Updates**: How often schema is updated, versioning.`,
			example: `## OpenAPI Schema

### Schema Downloads

**Latest Version (v2.5.0)**:
- **JSON**: [https://api.company.com/openapi.json](https://api.company.com/openapi.json)
- **YAML**: [https://api.company.com/openapi.yaml](https://api.company.com/openapi.yaml)

**Specific Version**:
- JSON: \`https://api.company.com/openapi/v2.5.0.json\`
- YAML: \`https://api.company.com/openapi/v2.5.0.yaml\`

**Schema Features**:
- OpenAPI 3.1.0 compliant
- Complete request/response schemas
- Example values for all fields
- Detailed error response schemas
- Security schemes (Bearer auth)
- Webhook schemas

### Interactive Documentation

**Swagger UI**: [https://api.company.com/docs](https://api.company.com/docs)
- Browse all endpoints
- Try API calls directly in browser
- See request/response examples
- Download schema

**Redoc**: [https://api.company.com/redoc](https://api.company.com/redoc)
- Beautiful, responsive documentation
- Search functionality
- Code samples in multiple languages

**Postman Collection**: [Download](https://api.company.com/postman-collection.json)
- Import into Postman
- Pre-configured requests
- Environment variables for sandbox/production

### Schema Validation

**Validate Requests**:
\`\`\`javascript
import Ajv from 'ajv';
import openapiSchema from './openapi.json';

const ajv = new Ajv();
const validate = ajv.compile(openapiSchema.paths['/v2/payments'].post);

const requestBody = {
  amount: 9999,
  currency: 'usd',
  payment_method_id: 'pm_123'
};

if (validate(requestBody)) {
  // Valid request
} else {
  console.error(validate.errors);
}
\`\`\`

**Validate Responses** (in tests):
\`\`\`javascript
import { validateResponse } from 'openapi-validator';

const response = await fetch('https://api.company.com/v2/payments/pay_123');
const json = await response.json();

const errors = validateResponse(json, openapiSchema, '/v2/payments/{id}', 'get');
expect(errors).toHaveLength(0); // No schema violations
\`\`\`

### Schema Structure

**Partial OpenAPI Schema Example**:
\`\`\`yaml
openapi: 3.1.0
info:
  title: Payment Processing API
  version: 2.5.0

paths:
  /v2/payments:
    post:
      summary: Create a payment
      operationId: createPayment
      tags:
        - Payments
      security:
        - bearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreatePaymentRequest'
      responses:
        '201':
          description: Payment created
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Payment'
        '400':
          $ref: '#/components/responses/BadRequest'
        '401':
          $ref: '#/components/responses/Unauthorized'

components:
  schemas:
    Payment:
      type: object
      required:
        - id
        - amount
        - currency
        - status
      properties:
        id:
          type: string
          pattern: '^pay_[a-zA-Z0-9]{24}$'
          example: pay_1A2B3C4D5E6F7G8H9I0J1K2L
        amount:
          type: integer
          minimum: 50
          maximum: 1000000
          example: 9999
          description: Amount in cents
        currency:
          type: string
          enum: [usd, eur, gbp]
          example: usd
        status:
          type: string
          enum: [pending, authorized, captured, failed, refunded]
          example: captured
  
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
\`\`\`

### Updates & Versioning

**Schema Update Frequency**: Updated with each API version release

**Breaking Changes**: Major version bump (v2.x.x → v3.0.0)
- Schema version matches API version
- Deprecation notices in schema descriptions

**Non-Breaking Changes**: Minor/patch version bump
- New optional fields: patch version
- New endpoints: minor version

**Changelog**: [https://api.company.com/changelog](https://api.company.com/changelog)`,
		},
		{
			name: "Changelog & Versioning",
			required: false,
			guidance: `Document API evolution:

**Versioning Strategy**:
How versions work, current version.

**Breaking Changes Policy**:
How breaking changes are communicated.

**Recent Changes**:
| Date | Version | Changes |

**Migration Guides**:
How to migrate between versions.`,
		},
	],

	qualityChecklist: [
		"API metadata includes OpenAPI 3.1 info block with version, contact, license, terms",
		"Design principles document RESTful constraints, naming conventions, URL structure",
		"Resource model shows entity relationships and available operations",
		"Common patterns (pagination, filtering, sorting, expansion) are standardized",
		"Every endpoint has complete documentation with examples",
		"Authentication is clearly explained with working examples",
		"Error codes are comprehensive with resolution guidance",
		"Rate limiting is documented with handling recommendations",
		"Request/response examples are complete and valid JSON",
		"Pagination, filtering, and sorting are explained",
		"Long-running operations use async pattern with polling guidance (if applicable)",
		"Batch operations are documented with atomic/best-effort modes (if applicable)",
		"API deprecation policy includes timeline, headers, and migration guides",
		"Client SDK guidance lists official libraries with installation instructions",
		"Complete OpenAPI 3.1 schema available for download",
		"Security best practices are documented",
		"Code examples are in multiple languages",
		"All data types and formats are defined",
	],

	antiPatterns: [
		"Missing or incomplete endpoint documentation",
		"Authentication examples that don't work",
		"Error codes without resolution guidance",
		"No rate limiting documentation",
		"Invalid JSON in examples",
		"Missing required parameters in documentation",
		"No code examples for common use cases",
		"Inconsistent terminology or patterns",
	],

	examples: {
		goodEndpoint: `### GET /v1/orders/{orderId}

Retrieve a single order by ID.

**Authentication**: Bearer token with \`orders:read\` scope

**Path Parameters**:
| Name | Type | Required | Description |
|------|------|----------|-------------|
| orderId | string | Yes | UUID of the order |

**Query Parameters**:
| Name | Type | Default | Description |
|------|------|---------|-------------|
| include | string | - | Comma-separated: items,customer,shipping |

**Response 200 OK**:
\`\`\`json
{
  "id": "ord_123abc",
  "status": "processing",
  "total": 9999,
  "currency": "usd",
  "items": [...],
  "created_at": "2024-01-15T10:30:00Z"
}
\`\`\`

**cURL Example**:
\`\`\`bash
curl https://api.example.com/v1/orders/ord_123abc \\
  -H "Authorization: Bearer sk_live_xxx"
\`\`\`

**JavaScript Example**:
\`\`\`javascript
const order = await client.orders.retrieve('ord_123abc');
\`\`\``,

		goodError: `### Error Codes

| Code | HTTP | Description | Resolution |
|------|------|-------------|------------|
| ORDER_NOT_FOUND | 404 | Order ID doesn't exist | Verify the order ID is correct |
| INVALID_STATUS_TRANSITION | 400 | Can't change to requested status | Check current status allows this transition |
| INSUFFICIENT_INVENTORY | 400 | Not enough stock | Reduce quantity or wait for restock |`,
	},
};
