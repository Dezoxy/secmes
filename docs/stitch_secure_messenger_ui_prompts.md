# Stitch UI Prompts — Secure Internal Messenger

This document contains separate per-page prompts for generating a secure internal company messaging web app UI in Stitch.

Product concept:

> A company-only secure messaging platform for private text messages and encrypted image sharing.  
> No public registration. No voice calls. No video calls. Web beta first, native apps later.

---

## Recommended Generation Order

Use the prompts in this order:

1. Login Page
2. Main Chat Page
3. Empty Chat State
4. Contacts Page
5. Security Page
6. Settings Page
7. Admin-Lite Dashboard
8. New Conversation Modal
9. Image Attachment Flow
10. Mobile-Responsive Chat

This order helps Stitch establish the core visual style first, then expand into secondary screens.

---

# 1. Login Page Prompt

```text
Create a modern dark-mode login page for a secure internal company messaging web app.

Product name: Secure Internal Messenger

Purpose:
This is a company-only private messaging platform for secure text and encrypted image sharing. No public registration, no voice calls, no video calls.

Page layout:
- Full-screen dark background
- Centered login card
- Product logo placeholder at the top
- Main title: “Secure Internal Messenger”
- Subtitle: “Private messaging for your company”
- Primary button: “Continue with Company SSO”
- Small secondary text: “Company-approved accounts only”
- No email/password form
- No sign-up link
- No social login buttons

Security indicators inside or below the card:
- End-to-end encrypted messages
- Company identity required
- No public registration
- Secure device-based access

Visual style:
- Premium enterprise SaaS look
- Dark navy / slate background
- Soft blue and muted purple accents
- Subtle glowing gradient in the background
- Rounded card, soft shadows, clean typography
- Professional cybersecurity feeling
- Calm, trustworthy, serious, not playful

Optional background:
- Abstract encrypted network pattern
- Subtle blurred security grid
- Minimal lock or shield motif

Make the page polished, realistic, responsive, and production-quality.
```

---

# 2. Main Chat Page Prompt

```text
Create the main chat dashboard page for a secure internal company messaging web app.

Product:
Secure Internal Messenger

Purpose:
A company-only encrypted messaging app for private text messages and encrypted image sharing. No voice calls, no video calls, no public registration.

Layout:
Create a 3-column desktop web app layout:
1. Left sidebar for navigation and conversations
2. Main center chat area
3. Right security/device information panel

Left sidebar:
- User profile section at the top with avatar, name, and online status
- Search input: “Search conversations”
- Navigation items:
  - Messages
  - Contacts
  - Security
  - Settings
- Conversation list with realistic sample data
- Each conversation item should include:
  - Avatar
  - Contact name
  - Last message preview
  - Timestamp
  - Unread badge
  - Small lock icon showing encrypted conversation

Center chat area:
- Header with contact name, role/team, online status
- Encryption badge: “End-to-end encrypted”
- No voice call icon
- No video call icon
- Message bubbles for incoming and outgoing messages
- Include timestamps
- Include delivery states: Sent, Delivered, Read
- Include one encrypted image preview card
- Messages should look professional, clean, and readable
- Message composer at the bottom:
  - Text input placeholder: “Write a secure message…”
  - Image upload button
  - Send button
  - Small note: “Messages are encrypted before sending”

Right security panel:
- Title: “Security Details”
- Encryption status
- Verified device indicator
- Device fingerprint preview
- Last key update timestamp
- Active device list preview
- Button: “Verify device”
- Button: “View security details”
- Note: “Message content is not visible to administrators”

Visual style:
- Dark mode first
- Premium enterprise SaaS
- Cybersecurity-inspired but not too flashy
- Dark navy/slate background
- Blue/purple accents
- Green security indicators
- Rounded panels
- Clean spacing
- Serious company-internal feeling
- Similar quality to Slack + Signal + Linear + enterprise security console

Make it polished, responsive, realistic, and production-quality.
```

---

# 3. Empty Chat State Prompt

```text
Create an empty state page for a secure internal company messaging app.

Context:
This appears when the user is logged in but has not selected a conversation yet.

Layout:
- Keep the same app shell as the main chat page
- Left sidebar with navigation and conversation list
- Main center area shows the empty state
- Optional right security panel can be hidden or show a neutral security summary

Main empty state content:
- Centered abstract security/chat illustration or icon
- Title: “Select a conversation”
- Subtitle: “Your private company messages will appear here”
- Security note: “Text and images are encrypted end-to-end”
- Optional button: “Start new secure conversation”

Left sidebar:
- User profile at the top
- Search conversations input
- Navigation:
  - Messages
  - Contacts
  - Security
  - Settings
- Conversation list with sample users

Visual style:
- Dark mode
- Premium enterprise SaaS
- Calm, minimal, clean
- Dark navy/slate background
- Subtle blue/purple accents
- Small green lock/security indicators
- Rounded cards
- Professional and trustworthy

Important:
- No voice call UI
- No video call UI
- No public registration
- Avoid consumer/social-media style
- Make it feel company-internal and security-first

Make the empty state polished, realistic, and production-quality.
```

---

# 4. Contacts Page Prompt

```text
Create a Contacts page for a secure internal company messaging web app.

Product:
Secure Internal Messenger

Purpose:
The Contacts page shows company users who can be messaged securely. This is not a social network and not a public contact list. It is company-internal only.

Layout:
- Use the same dark-mode app shell as the main chat dashboard
- Left sidebar with navigation:
  - Messages
  - Contacts
  - Security
  - Settings
- Main content area for contacts
- Optional right panel for selected contact security details

Main content:
- Page title: “Company Contacts”
- Subtitle: “Start secure conversations with verified company users”
- Search input: “Search people, teams, or email”
- Filters:
  - All
  - Online
  - Verified devices
  - Recently active
- Contact cards or table layout

Each contact should show:
- Avatar
- Full name
- Role or team
- Company email
- Online/offline status
- Device verification status
- Button: “Message”
- Small lock icon for secure messaging availability

Selected contact side panel:
- Contact name
- Team/role
- Verified devices count
- Last active timestamp
- Encryption availability
- Button: “Start secure chat”
- Button: “View device keys”

Visual style:
- Dark mode first
- Premium enterprise SaaS
- Clean, serious, secure
- Dark navy/slate background
- Blue and muted purple accents
- Green indicators for verified/secure status
- Rounded cards and soft shadows
- Professional company-internal feeling

Important:
- No public invite flow
- No external users
- No social media profile features
- No voice or video options

Make the page polished, realistic, responsive, and production-quality.
```

---

# 5. Security Page Prompt

```text
Create a Security page for a secure internal company messaging web app.

Product:
Secure Internal Messenger

Purpose:
This page helps the user understand encryption, device trust, key verification, and account security.

Layout:
- Same dark-mode app shell
- Left sidebar navigation:
  - Messages
  - Contacts
  - Security
  - Settings
- Main content area with security dashboard cards
- Optional right panel with security recommendations

Main title:
“Security”

Subtitle:
“Manage encryption, trusted devices, and secure access.”

Security overview cards:
1. End-to-end encryption
   - Status: Active
   - Description: “Messages and images are encrypted before sending.”
2. Company identity
   - Status: Verified
   - Provider: Company SSO
3. Trusted devices
   - Status: 2 active devices
4. Key verification
   - Status: Recommended

Sections:
- Encryption Status
  - End-to-end encryption active
  - Message content not visible to administrators
  - Image attachments encrypted before upload

- Device Verification
  - Current device
  - Device fingerprint preview
  - Button: “Verify this device”
  - Button: “Compare fingerprint”

- Trusted Devices
  - List of registered devices
  - Device name
  - Browser/platform
  - Last active timestamp
  - Trust status
  - Revoke button

- Security Events
  - Recent login
  - New device registered
  - Key updated
  - Device revoked

Visual style:
- Serious cybersecurity dashboard
- Dark mode
- Premium enterprise SaaS
- Dark navy/slate
- Blue/purple accents
- Green secure indicators
- Yellow warning indicators for recommended actions
- Rounded panels and clean spacing

Important:
- Make it clear and understandable
- Avoid scary hacker visuals
- No consumer/social style
- No voice/video features

Make the page polished, realistic, responsive, and production-quality.
```

---

# 6. Settings Page Prompt

```text
Create a Settings page for a secure internal company messaging web app.

Product:
Secure Internal Messenger

Purpose:
User settings for account, devices, security, appearance, and notifications.

Layout:
- Same dark-mode app shell
- Left sidebar navigation:
  - Messages
  - Contacts
  - Security
  - Settings
- Main content area with settings sections
- Clean card-based layout

Main title:
“Settings”

Sections:

1. Account
- Display name
- Company email
- Team/role
- Login provider: Company SSO
- Account status: Company verified

2. Devices
- Registered devices list
- Current device highlighted
- Device name
- Browser/platform
- Last active timestamp
- Trust status
- Button: “Revoke device”
- Button: “Rename device”

3. Security
- End-to-end encryption: Active
- Key verification: Recommended
- Session timeout setting
- Device trust level
- Button: “View security details”

4. Appearance
- Theme selector:
  - Dark
  - System
  - Light
- Density selector:
  - Comfortable
  - Compact

5. Notifications
- Desktop notifications toggle
- New message notification toggle
- Security event notification toggle
- Delivery/read receipt preferences

6. Privacy
- Read receipts toggle
- Online status visibility
- Typing indicator toggle

Visual style:
- Dark mode first
- Premium enterprise SaaS
- Clean and calm
- Dark navy/slate background
- Blue/purple accents
- Green status indicators
- Rounded cards
- Professional internal-company design

Important:
- No public sign-up
- No password change form if using company SSO
- No voice/video settings
- No social profile settings

Make it polished, realistic, responsive, and production-quality.
```

---

# 7. Admin-Lite Dashboard Prompt

```text
Create an Admin Lite dashboard page for a secure internal company messaging web app.

Product:
Secure Internal Messenger

Purpose:
This admin page gives company admins visibility into users, devices, login events, and delivery health, but admins must not see message contents.

Important privacy rule:
Clearly show that administrators can view security metadata, but cannot read message content or see image content.

Layout:
- Dark-mode admin dashboard
- Left sidebar navigation:
  - Overview
  - Users
  - Devices
  - Security Events
  - Delivery Health
  - Settings
- Main dashboard area with overview cards and tables

Top overview cards:
1. Active users
2. Registered devices
3. Verified devices
4. Messages delivered today
5. Security events
6. Failed logins

Main sections:

1. User Activity
- Table with:
  - User
  - Email
  - Team
  - Last active
  - Device count
  - Status

2. Device Management
- Table with:
  - Device name
  - Owner
  - Platform/browser
  - Last active
  - Trust status
  - Action: Review / Revoke

3. Security Events
- Event feed with:
  - New device registered
  - Device revoked
  - Key updated
  - Failed login
  - Suspicious session

4. Message Delivery Health
- Delivery success rate
- Queue status
- WebSocket status
- Attachment upload health
- No message content visible

Privacy notice card:
Title: “Content privacy protected”
Text: “Administrators can monitor security metadata and delivery health, but message text and image contents remain encrypted and unavailable to administrators.”

Visual style:
- Dark mode
- Enterprise security operations dashboard
- Clean, serious, professional
- Dark navy/slate background
- Blue/purple accents
- Green healthy indicators
- Yellow warning indicators
- Red critical indicators only where needed
- Rounded cards, tables, and charts

Important:
- Do not show actual message text
- Do not show image previews
- No surveillance-style UI
- No voice/video features
- Make it company-internal, privacy-first, and enterprise-grade

Make the page polished, realistic, responsive, and production-quality.
```

---

# 8. New Conversation Modal Prompt

```text
Create a “Start New Secure Conversation” modal for a secure internal company messaging web app.

Context:
This modal opens inside the messaging dashboard.

Purpose:
Allow a user to start a new encrypted 1:1 conversation with another verified company user.

Modal layout:
- Centered modal over dark blurred background
- Title: “Start secure conversation”
- Subtitle: “Choose a verified company user to begin encrypted messaging.”
- Search input: “Search by name, team, or company email”
- List of company users

Each user row:
- Avatar
- Full name
- Team/role
- Company email
- Online status
- Device verification status
- Small lock icon
- Button: “Start chat”

Security note:
“Messages are encrypted before they leave your device.”

Empty search state:
- Text: “No matching company users found”
- Subtitle: “Only approved company accounts can be contacted.”

Visual style:
- Dark mode
- Premium enterprise SaaS
- Clean, focused modal
- Dark navy/slate background
- Blue/purple accents
- Green verified indicators
- Rounded corners and soft shadow

Important:
- No external invite
- No public contacts
- No group chat for now
- No voice/video options

Make it polished, realistic, and production-quality.
```

---

# 9. Image Attachment Flow Prompt

```text
Create an image attachment upload UI flow for a secure internal company messaging web app.

Context:
This appears in the chat composer when the user uploads an image.

Purpose:
The app supports encrypted image sharing only. Images should appear as secure encrypted attachments.

States to design:

1. Image selected
- Small preview card above the message composer
- File name
- File size
- Remove button
- Security note: “Image will be encrypted before upload”

2. Encryption/upload progress
- Progress bar
- Status text:
  - “Encrypting image locally…”
  - “Uploading encrypted image…”
  - “Preparing secure message…”

3. Uploaded image message
- Image preview card inside chat bubble
- Lock icon
- Timestamp
- Delivery status
- Label: “Encrypted image”

4. Upload error
- Error card
- Text: “Image upload failed”
- Retry button
- Remove button

Visual style:
- Dark mode
- Premium enterprise SaaS
- Secure, calm, professional
- Dark navy/slate background
- Blue/purple accents
- Green security indicators
- Rounded image cards
- Clean progress UI

Important:
- No video attachment UI
- No voice attachment UI
- No public sharing
- No social reactions
- Make the encryption status visible but not overwhelming

Make the flow polished, realistic, responsive, and production-quality.
```

---

# 10. Mobile-Responsive Chat Prompt

```text
Create a mobile-responsive version of the secure internal messaging web app.

Product:
Secure Internal Messenger

Purpose:
The first beta is a website, but the UI should be designed mobile-first enough to prepare for future native apps.

Mobile layout:
- Bottom navigation or compact top navigation
- Conversation list screen
- Chat screen
- Security details screen
- Settings screen

Conversation list screen:
- Header with app name and user avatar
- Search input
- Conversation cards with:
  - Avatar
  - Name
  - Last message preview
  - Timestamp
  - Unread badge
  - Lock icon

Chat screen:
- Header with back button, contact name, online status, encryption badge
- No voice call icon
- No video call icon
- Message bubbles
- Encrypted image preview
- Composer:
  - Text input
  - Image upload button
  - Send button

Security details screen:
- Encryption active
- Verified device indicator
- Device fingerprint preview
- Last key update
- Verify device button

Visual style:
- Dark mode
- Premium enterprise mobile SaaS
- Clean and serious
- Dark navy/slate background
- Blue/purple accents
- Green security indicators
- Rounded cards
- Smooth spacing
- Professional and company-internal

Important:
- No public registration
- No voice/video UI
- No social features
- Keep the design ready for future iOS and Android apps

Make it polished, realistic, responsive, and production-quality.
```

---

# Follow-Up Refinement Prompts

Use these after Stitch generates a screen.

## Make the UI more enterprise

```text
Make this UI feel more enterprise-grade, more serious, and less consumer-chat-like. Increase the cybersecurity and internal-company feeling while keeping it clean and modern.
```

## Improve privacy/security messaging

```text
Improve the security messaging across the page. Make encryption, device verification, company-only access, and admin content privacy easier to understand without making the interface feel scary.
```

## Make it more premium

```text
Make the design more premium and polished. Improve spacing, typography, card hierarchy, shadows, and subtle gradients. Keep dark mode and the secure enterprise style.
```

## Remove unwanted communication features

```text
Remove any voice call, video call, public sign-up, social invite, or consumer social features. This product only supports company-only secure text messaging and encrypted image sharing.
```

## Prepare for future native apps

```text
Adjust the layout and components so the design can later be reused for iOS, Android, and desktop apps. Keep the current output as a responsive web app, but make the interaction patterns mobile-friendly.
```

---

# Product Rules For All Screens

Use these rules consistently:

```text
- Company-only access
- Login only through Company SSO
- No public sign-up
- No password login in the app
- No social login
- No voice calls
- No video calls
- No external users in beta
- Text messages only
- Image sharing only as encrypted attachments
- Message content must not be visible to administrators
- Admins can view security metadata and delivery health only
- Dark-mode-first enterprise UI
- Serious, private, secure, professional feeling
```

---

# Suggested File Location In Repo

Recommended path:

```text
docs/product/stitch-ui-prompts.md
```

Alternative paths:

```text
docs/design/stitch-ui-prompts.md
docs/frontend/stitch-ui-prompts.md
product/stitch-ui-prompts.md
```
