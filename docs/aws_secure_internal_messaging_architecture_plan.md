# AWS Secure Internal Messaging App — Architecture Plan

> ⚠️ **DEPRECATED / SUPERSEDED — do not follow this document.**
> This is an early AWS-first draft kept only for history. It still recommends AWS (EKS/RDS), Angular, ASP.NET Core, and SignalR — all of which were **replaced**. The live plan is [`secure_messaging_platform_plan.md`](secure_messaging_platform_plan.md): **Azure AKS, React + Vite PWA, NestJS, WebSocket, MLS, Postgres + RLS.**

## 0. Executive Summary

This document describes an AWS-first architecture for a **company-internal secure messaging application** focused on:

- **Text messages**
- **Image messages / image attachments**
- **No voice**
- **No video**
- **High privacy**
- **Cloud-native deployment**
- **Kubernetes flexibility**
- **Future native apps for iOS, Android, Windows, macOS, and desktop**

The recommended direction is to build a **custom secure internal messaging platform** where the backend acts as a delivery, identity, and coordination layer, while clients own encryption and decryption of message content.

The first beta should be a **web application** running on AWS, but the architecture must be designed so that the same backend can later support mobile and desktop apps.

---

## 1. Product Goal

### Main Goal

Build a private, company-internal messaging system with strong security, designed for sensitive business communication.

### First Beta Scope

The first beta should support:

- Company login
- User directory
- One-to-one messaging
- Text messages
- Image messages
- Encrypted attachments
- Basic delivery status
- Basic admin panel
- Device/session management
- Audit logs for security events

### Not Included in First Beta

The first beta should not include:

- Voice calls
- Video calls
- External users
- Public registration
- Federation with other messaging networks
- Complex group encryption
- Message search
- Compliance export
- AI features
- Bots
- File attachments beyond images

---

## 2. Core Architectural Principle

The most important rule:

> The server should deliver messages, not own the message content.

This means:

- Message content should be encrypted before it reaches the backend.
- Images should be encrypted before upload.
- The database should store encrypted payloads.
- Object storage should store encrypted blobs.
- Admins should see security metadata, not message content.

The backend should manage:

- Authentication
- Authorization
- User/device registration
- Public key directory
- Message routing
- Message storage
- Attachment references
- Audit events
- Operational monitoring

The backend should not manage:

- Plaintext messages
- Plaintext images
- User private keys
- Decryption of user conversations

---

## 3. Important Security Reality: Web Beta vs Native Apps

A web-only beta can be secure enough for testing and early internal usage, but it has a weakness:

> In a browser-based end-to-end encrypted app, the server delivers the JavaScript that performs encryption.

If the web server or deployment pipeline is compromised, an attacker could theoretically ship malicious JavaScript to users.

Therefore:

- Web beta is acceptable for MVP.
- Native apps are better for serious high-security production use.
- The architecture should prepare for native clients from day one.

Future native apps should store private keys in:

- iOS Keychain / Secure Enclave where possible
- Android Keystore
- Windows DPAPI / Credential Manager
- macOS Keychain

---

## 4. Recommended AWS Architecture

```text
User Browser
    |
    | HTTPS / WSS
    v
Amazon CloudFront
    |
    v
AWS WAF
    |
    v
Application Load Balancer / AWS Load Balancer Controller
    |
    v
Amazon EKS Cluster
    |
    +-- Frontend Web App
    +-- API Gateway Service
    +-- Auth Integration Service
    +-- Messaging Service
    +-- WebSocket Gateway
    +-- Key Directory Service
    +-- Attachment Service
    +-- Notification Service
    +-- Admin Service
    +-- Worker Services
    |
    +-- Amazon RDS PostgreSQL
    +-- Amazon ElastiCache Redis
    +-- Amazon S3
    +-- Amazon SQS / Amazon MSK / NATS later
    +-- AWS KMS
    +-- AWS Secrets Manager
    +-- Amazon CloudWatch
    +-- AWS CloudTrail
    +-- Amazon GuardDuty
```

---

## 5. AWS Services

| Area | AWS Service | Purpose |
|---|---|---|
| Compute | Amazon EKS | Kubernetes platform for backend workloads |
| Frontend delivery | Amazon CloudFront | Serve frontend globally and securely |
| Edge protection | AWS WAF | HTTP filtering, abuse protection, basic app-layer security |
| Load balancing | Application Load Balancer | Route traffic into EKS |
| Container registry | Amazon ECR | Store container images |
| Database | Amazon RDS PostgreSQL / Aurora PostgreSQL | Main relational database |
| Cache / realtime support | Amazon ElastiCache Redis | Presence, sessions, WebSocket fanout helper |
| Object storage | Amazon S3 | Store encrypted image blobs |
| Queue | Amazon SQS | Async message/attachment processing |
| Secrets | AWS Secrets Manager | Application secrets and rotation |
| Key management | AWS KMS | Cloud key management, envelope encryption, service encryption |
| Identity | Amazon Cognito or external IdP | Login and token issuance |
| DNS | Amazon Route 53 | DNS management |
| Logs | Amazon CloudWatch Logs | Application and platform logs |
| Audit | AWS CloudTrail | AWS API audit trail |
| Security monitoring | Amazon GuardDuty | Threat detection |
| Infrastructure as Code | Terraform | Reproducible cloud foundation |
| Kubernetes deployment | Helm / Argo CD | App deployment and GitOps |

---

## 6. Identity Strategy

### Recommended Identity Model

Do not build username/password authentication yourself.

Use one of these:

1. **Amazon Cognito**
2. **Microsoft Entra ID via OIDC/SAML federation**
3. **Okta via OIDC/SAML federation**
4. **Keycloak as self-managed IdP**

For a company-internal app, the best approach is usually:

```text
Corporate IdP
    |
    v
OIDC / SAML
    |
    v
Amazon Cognito or Backend OIDC validation
    |
    v
Messaging App
```

### Practical Recommendation

If the company already uses Microsoft 365:

```text
Microsoft Entra ID -> OIDC/SAML -> App
```

If you want AWS-native identity abstraction:

```text
Microsoft Entra ID / Okta / Google Workspace
        |
        v
Amazon Cognito
        |
        v
Messaging App
```

### Why This Matters

Identity controls:

- Who can log in
- MFA
- User lifecycle
- Disabled users
- Conditional access
- Future device trust
- Group/role mapping

---

## 7. Encryption and Protocol Direction

### Do Not Invent Crypto

The application should not implement a custom encryption protocol from scratch.

Recommended direction:

| Use Case | Recommended Protocol Direction |
|---|---|
| 1:1 messages | Signal-style protocol / Double Ratchet model |
| Group messages later | MLS — Messaging Layer Security |
| Attachments | Client-side envelope encryption |
| Transport | TLS 1.2+ / TLS 1.3 |
| Storage at rest | AWS-managed encryption + app-level encryption |

### MVP Crypto Model

For the first beta:

```text
User A browser generates device keys
User B browser generates device keys
Public keys are uploaded to Key Directory Service
Private keys stay on user devices
Messages are encrypted client-side
Backend stores ciphertext only
Recipient decrypts locally
```

### Image Encryption Flow

```text
User selects image
    |
    v
Browser creates random attachment key
    |
    v
Browser encrypts image locally
    |
    v
Encrypted image uploaded to S3
    |
    v
Message contains encrypted attachment metadata and reference
    |
    v
Recipient downloads encrypted blob
    |
    v
Recipient decrypts locally
```

### Important Security Boundary

AWS KMS is useful for infrastructure and service encryption, but it should not replace end-to-end encryption.

Use AWS KMS for:

- S3 server-side encryption
- RDS encryption
- EKS secrets encryption
- Application-level envelope encryption where the server is allowed to decrypt
- Internal service keys

Do not use AWS KMS as the main mechanism for user message privacy if the goal is true E2EE, because server-side KMS usually means the server can decrypt.

---

## 8. Application Components

### 8.1 Frontend Web App

Responsibilities:

- Login flow
- User interface
- Conversation list
- Message composer
- Image upload
- Client-side encryption
- Client-side decryption
- Local device key storage
- WebSocket connection

Recommended technologies:

```text
React / Next.js / Angular
TypeScript
WebCrypto API
IndexedDB
Service Worker later
WebSocket client
```

For your style and previous direction, Angular is completely acceptable.

Recommended beta choice:

```text
Angular + TypeScript + WebCrypto + IndexedDB
```

---

### 8.2 Backend API Service

Responsibilities:

- Validate user tokens
- Enforce authorization
- Manage users and conversations
- Store encrypted messages
- Issue presigned S3 upload URLs
- Manage device registration
- Manage public keys
- Expose admin APIs

Recommended technologies:

```text
ASP.NET Core
PostgreSQL
OpenTelemetry
Redis integration
JWT validation
```

Recommended beta choice:

```text
ASP.NET Core + PostgreSQL
```

---

### 8.3 WebSocket Gateway

Responsibilities:

- Maintain live client connections
- Deliver encrypted messages in real time
- Notify clients about delivery state
- Handle typing indicators if allowed
- Handle presence if allowed

Beta option:

```text
ASP.NET Core SignalR
```

Alternative:

```text
Native WebSocket service
```

For first version, SignalR is a very practical .NET choice.

---

### 8.4 Key Directory Service

Responsibilities:

- Store user public keys
- Store device public keys
- Store signed pre-keys
- Store one-time pre-keys
- Allow clients to fetch recipient key bundles
- Track revoked devices

Should store:

```text
public identity key
public signed pre-key
public one-time pre-keys
device id
key creation time
key expiration/revocation status
```

Should never store:

```text
private keys
plaintext session keys
plaintext message keys
```

---

### 8.5 Messaging Service

Responsibilities:

- Accept encrypted messages
- Validate sender access to conversation
- Store ciphertext
- Create delivery events
- Push event to WebSocket gateway
- Support offline delivery

The message service does not need to understand message content.

---

### 8.6 Attachment Service

Responsibilities:

- Generate S3 presigned upload URLs
- Store encrypted attachment references
- Validate ownership and access
- Manage object lifecycle rules
- Delete expired attachments if needed

S3 should store only encrypted blobs.

Recommended S3 setup:

- Block public access
- Bucket policy denies public access
- SSE-KMS enabled
- Versioning optional
- Lifecycle rules for cleanup
- Access only through backend-issued presigned URLs
- No direct public object URLs

---

### 8.7 Admin Service

Responsibilities:

- Manage users
- View registered devices
- Revoke sessions/devices
- View audit logs
- View system health
- Manage feature flags

Admins should see:

```text
users
active devices
last login time
conversation metadata
message count
delivery failures
security events
```

Admins should not see:

```text
message text
image content
attachment content
private keys
```

---

## 9. Data Model

### Users

```text
users
- id
- external_identity_id
- email
- display_name
- status
- created_at
- updated_at
```

### Devices

```text
devices
- id
- user_id
- device_name
- device_type
- public_identity_key
- public_signed_pre_key
- status
- created_at
- last_seen_at
- revoked_at
```

### One-Time Pre-Keys

```text
one_time_pre_keys
- id
- device_id
- public_key
- used_at
- created_at
```

### Conversations

```text
conversations
- id
- type
- created_at
- updated_at
```

### Conversation Members

```text
conversation_members
- conversation_id
- user_id
- role
- joined_at
- removed_at
```

### Messages

```text
messages
- id
- conversation_id
- sender_user_id
- sender_device_id
- ciphertext
- encrypted_metadata
- created_at
- expires_at
```

### Attachments

```text
attachments
- id
- message_id
- s3_bucket
- s3_object_key
- encrypted_size
- encrypted_metadata
- created_at
- expires_at
```

### Delivery Receipts

```text
delivery_receipts
- id
- message_id
- recipient_user_id
- recipient_device_id
- status
- created_at
```

### Audit Events

```text
audit_events
- id
- actor_user_id
- event_type
- ip_address
- user_agent
- metadata
- created_at
```

---

## 10. Network Architecture

Recommended AWS network design:

```text
VPC
|
+-- Public Subnets
|   +-- NAT Gateway
|   +-- Public Load Balancer
|
+-- Private App Subnets
|   +-- EKS worker nodes
|   +-- Internal services
|
+-- Private Data Subnets
    +-- RDS PostgreSQL
    +-- ElastiCache Redis
```

### Rules

- EKS nodes should run in private subnets.
- RDS should not be publicly accessible.
- Redis should not be publicly accessible.
- S3 access should use VPC endpoints where possible.
- Secrets Manager, KMS, ECR, CloudWatch access should use VPC endpoints where practical.
- Only ALB/CloudFront should face the internet.

---

## 11. Kubernetes Architecture

### Namespaces

```text
messaging-prod
messaging-staging
messaging-dev
platform
observability
security
```

### Workloads

```text
frontend
api
websocket-gateway
key-directory-service
attachment-service
admin-api
message-worker
audit-worker
notification-worker
```

### Kubernetes Add-ons

```text
AWS Load Balancer Controller
External Secrets Operator
cert-manager
ExternalDNS
Cluster Autoscaler or Karpenter
OpenTelemetry Collector
Prometheus / Grafana or AWS managed monitoring
```

### Security Controls

```text
NetworkPolicies
Pod Security Standards
non-root containers
read-only root filesystem
resource limits
image scanning
short-lived service account tokens
IRSA for AWS permissions
```

IRSA means IAM Roles for Service Accounts. It allows Kubernetes service accounts to access AWS services without static AWS keys inside pods.

---

## 12. AWS Account Structure

For a serious company project, use multiple AWS accounts:

```text
management account
security account
log archive account
dev account
staging account
prod account
```

Simpler beta structure:

```text
dev account
prod account
```

Recommended minimum:

```text
shared-services account
staging account
production account
```

---

## 13. Secrets and Key Management

### Use AWS Secrets Manager For

- Database credentials
- API secrets
- Third-party integration secrets
- Admin bootstrap secrets
- Rotation-managed credentials

### Use AWS KMS For

- RDS encryption
- S3 SSE-KMS
- EKS envelope encryption
- Secrets Manager encryption
- Application envelope encryption if needed

### Do Not Store

```text
.env files in GitHub
long-lived AWS access keys in Kubernetes secrets
private user encryption keys on the server
plaintext database credentials in Helm values
```

---

## 14. Message Flow

### Sending a Text Message

```text
1. User logs in through IdP.
2. Browser loads conversation.
3. Browser fetches recipient public key bundle.
4. Browser encrypts message locally.
5. Browser sends ciphertext to backend API.
6. Backend validates sender authorization.
7. Backend stores ciphertext in PostgreSQL.
8. Backend publishes delivery event.
9. WebSocket gateway pushes encrypted message to recipient.
10. Recipient browser decrypts locally.
```

### Sending an Image

```text
1. User selects image.
2. Browser creates random attachment encryption key.
3. Browser encrypts image locally.
4. Browser requests upload URL from backend.
5. Backend creates presigned S3 upload URL.
6. Browser uploads encrypted image blob to S3.
7. Browser sends encrypted attachment metadata as message.
8. Recipient receives encrypted metadata.
9. Recipient downloads encrypted blob.
10. Recipient decrypts image locally.
```

---

## 15. Observability

You need observability without leaking private content.

### Logs Should Include

```text
request id
user id
service name
operation name
status code
latency
error category
conversation id hash if needed
message id
```

### Logs Should Not Include

```text
message text
image names
plaintext metadata
private keys
tokens
full authorization headers
presigned URLs
```

### Monitoring Stack

Recommended:

```text
OpenTelemetry
CloudWatch Logs
CloudWatch Metrics
AWS X-Ray or Tempo
Prometheus metrics
Grafana dashboards
Alertmanager / AWS SNS alerts
```

---

## 16. CI/CD Plan

```text
Developer pushes code
    |
    v
GitHub Pull Request
    |
    +-- unit tests
    +-- integration tests
    +-- linting
    +-- SAST
    +-- dependency scanning
    +-- container image scan
    +-- Terraform validation
    +-- Helm validation
    |
    v
Merge to main
    |
    v
Build container image
    |
    v
Push image to Amazon ECR
    |
    v
Deploy to staging
    |
    v
Smoke tests
    |
    v
Manual approval
    |
    v
Deploy to production
```

Recommended tools:

```text
GitHub Actions
Amazon ECR
Terraform
Helm
Argo CD later
Trivy
Checkov
tfsec
Dependabot / Renovate
```

---

## 17. Terraform Structure

Suggested repository layout:

```text
infra/
  terraform/
    accounts/
    networking/
    eks/
    rds/
    redis/
    s3/
    kms/
    secrets/
    monitoring/
    iam/
    environments/
      dev/
      staging/
      prod/

apps/
  frontend/
  backend/
  websocket-gateway/
  key-directory/
  attachment-service/

charts/
  messaging-platform/

.github/
  workflows/
```

### Terraform Should Manage

```text
VPC
subnets
route tables
security groups
EKS cluster
node groups / Karpenter
RDS
Redis
S3 buckets
KMS keys
IAM roles
Secrets Manager entries
CloudWatch log groups
Route 53 records
WAF
CloudFront
```

### Terraform Should Not Manage Initially

```text
individual app users
message data
runtime-generated keys
short-lived sessions
```

---

## 18. Security Threat Model

### Main Threats

| Threat | Protection |
|---|---|
| Database leak | Store ciphertext only |
| S3 leak | Client-side encryption + SSE-KMS + private bucket |
| Stolen cloud credentials | IAM least privilege + MFA + CloudTrail + GuardDuty |
| Compromised pod | NetworkPolicies + IRSA + secret minimization |
| Compromised admin account | MFA + least privilege + audit logging |
| Compromised user password | SSO MFA + session controls |
| Lost device | Device revocation |
| Malicious insider | No plaintext access, audit logs |
| Web app compromise | Strong CI/CD, CSP, SRI where possible, later native apps |
| Browser extension malware | Hard to fully prevent; use managed devices later |

---

## 19. Compliance and Company Policy Decision

You must decide early:

```text
Should company admins ever be able to read messages?
```

### Option A — Maximum Privacy

- Admins cannot read messages.
- Server cannot decrypt content.
- Lost keys mean lost messages.
- Harder compliance/export.

### Option B — Enterprise Compliance Mode

- Messages can be escrowed or journaled.
- Admin/compliance team can recover content.
- Weaker privacy.
- Easier legal/compliance workflows.

### Recommendation

For your stated goal, choose:

```text
Option A for beta: no admin content access.
```

Later, if business requires it, add a separate compliance mode per tenant or per organization.

---

## 20. MVP Delivery Plan

### Phase 0 — Architecture Foundation

Deliverables:

- Threat model
- MVP scope
- AWS account structure
- Terraform baseline
- EKS cluster
- RDS PostgreSQL
- S3 bucket
- KMS keys
- Secrets Manager
- Basic CI/CD

### Phase 1 — Identity and User Directory

Deliverables:

- OIDC login
- User profile sync
- Role mapping
- Admin role
- Session handling
- Audit events for login/logout

### Phase 2 — Device and Key Management

Deliverables:

- Device registration
- Client key generation
- Public key upload
- Key bundle fetch
- Device revocation
- Local private key storage

### Phase 3 — One-to-One Text Messaging

Deliverables:

- Conversation creation
- Encrypted text message send
- Encrypted message storage
- WebSocket delivery
- Offline message retrieval
- Delivery status

### Phase 4 — Image Messaging

Deliverables:

- Client-side image encryption
- Presigned upload URL
- S3 encrypted blob storage
- Encrypted image metadata
- Recipient image download/decrypt

### Phase 5 — Hardening

Deliverables:

- Rate limiting
- WAF rules
- Audit dashboards
- Monitoring dashboards
- Alerting
- Penetration test preparation
- Backup and restore test
- Disaster recovery plan

### Phase 6 — Native App Preparation

Deliverables:

- Stable public API
- Device abstraction
- Push notification design
- Native key storage design
- Mobile threat model
- API versioning

---

## 21. Future Native App Architecture

Later clients:

```text
iOS app
Android app
Windows desktop app
macOS desktop app
Web app
```

All clients should use the same backend APIs:

```text
Auth API
Device API
Key Directory API
Conversation API
Message API
Attachment API
WebSocket API
Admin API
```

Native clients improve security because private keys can be stored in OS-backed secure storage.

---

## 22. Recommended Initial Tech Stack

### Frontend

```text
Angular
TypeScript
WebCrypto API
IndexedDB
WebSocket / SignalR client
```

### Backend

```text
ASP.NET Core
PostgreSQL
Redis
SignalR / WebSocket
OpenTelemetry
```

### Infrastructure

```text
AWS EKS
Amazon RDS PostgreSQL
Amazon S3
Amazon ElastiCache Redis
AWS KMS
AWS Secrets Manager
Amazon ECR
CloudFront
AWS WAF
Route 53
Terraform
Helm
GitHub Actions
```

### Security

```text
OIDC SSO
MFA through IdP
IRSA
KMS encryption
Secrets rotation
NetworkPolicies
CloudTrail
GuardDuty
CloudWatch
```

---

## 23. Recommended Beta Architecture Diagram

```text
                        +----------------------+
                        |      Company IdP      |
                        | Entra / Okta / Google |
                        +----------+-----------+
                                   |
                                   | OIDC / SAML
                                   v
+------------+        +------------+------------+
|   Browser  | -----> | CloudFront + AWS WAF    |
| Web Client | HTTPS  +------------+------------+
+-----+------+                     |
      |                            v
      | WSS / HTTPS       +--------+---------+
      +-----------------> | ALB / Ingress    |
                           +--------+---------+
                                    |
                                    v
                           +--------+---------+
                           |     Amazon EKS   |
                           +--------+---------+
                                    |
        +---------------------------+----------------------------+
        |                           |                            |
        v                           v                            v
+---------------+         +------------------+          +----------------+
| Messaging API |         | WebSocket Gateway|          | Key Directory  |
+-------+-------+         +--------+---------+          +-------+--------+
        |                          |                            |
        v                          v                            v
+---------------+         +------------------+          +----------------+
| RDS Postgres  |         | ElastiCache Redis|          | RDS Postgres   |
+---------------+         +------------------+          +----------------+
        |
        v
+---------------+
| Encrypted Msg |
+---------------+

+------------------+
| Attachment API   |
+--------+---------+
         |
         v
+------------------+
| S3 Encrypted Blobs|
+------------------+
```

---

## 24. Key Decisions to Make Before Coding

### Decision 1 — Identity Provider

Choose one:

```text
Amazon Cognito
Microsoft Entra ID
Okta
Keycloak
```

Recommended for company use:

```text
Existing company IdP + OIDC
```

### Decision 2 — Admin Content Access

Choose one:

```text
No admin content access
Compliance escrow mode
```

Recommended for beta:

```text
No admin content access
```

### Decision 3 — Frontend Framework

Choose one:

```text
Angular
React / Next.js
```

Recommended for you:

```text
Angular if you want enterprise structure
React/Next.js if you want faster UI ecosystem
```

### Decision 4 — Realtime Technology

Choose one:

```text
SignalR
Native WebSocket
SSE
```

Recommended for .NET backend:

```text
SignalR
```

### Decision 5 — Group Chat Timing

Recommended:

```text
Do not build group chat in beta.
```

Group encryption is much harder than 1:1 messaging.

---

## 25. Final Recommendation

Build the beta as:

```text
AWS-native, Kubernetes-based, company-internal, encrypted messaging platform.
```

Recommended first implementation:

```text
Frontend: Angular + TypeScript
Backend: ASP.NET Core
Realtime: SignalR / WebSocket
Database: Amazon RDS PostgreSQL
Cache: Amazon ElastiCache Redis
Storage: Amazon S3
Compute: Amazon EKS
Secrets: AWS Secrets Manager
Keys: AWS KMS
Identity: Corporate IdP via OIDC, optionally through Cognito
IaC: Terraform
Deployment: Helm + GitHub Actions
Monitoring: CloudWatch + OpenTelemetry
```

The most important design principle:

> The cloud should operate the platform, but the clients should own message privacy.

