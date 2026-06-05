# Secure Internal Messenger — Design Specification

> Repo document: `design.md`  
> Product: **Secure Internal Messenger**  
> Scope: Web beta UI/UX design direction for a company-internal secure messaging platform.

---

## 1. Product Design Goal

The product should feel like a **serious internal security tool**, not a casual consumer chat app.

The UI should communicate:

- trust
- privacy
- clarity
- company control
- strong security
- calm professionalism
- modern enterprise quality

The app supports:

- secure company login
- private 1:1 text messaging
- encrypted image sharing
- device verification
- security visibility
- admin metadata monitoring

The app does **not** support:

- public registration
- social login
- voice calls
- video calls
- public communities
- consumer-style reactions
- social-media-style profiles

---

## 2. Design Principles

### 2.1 Security First, But Not Scary

Security should be visible, but not overwhelming.

Good examples:

- small lock icons
- clear encryption badges
- calm green verified states
- short security explanations
- device verification states
- clear admin privacy notices

Avoid:

- hacker visuals
- aggressive warning colors everywhere
- cyberpunk overload
- fake “military-grade” language
- fear-based copywriting

---

### 2.2 Enterprise, Not Consumer

This is a company-internal communication platform.

The design should feel closer to:

- Slack
- Signal
- Linear
- Microsoft Teams admin/security areas
- modern security dashboards

It should not feel like:

- WhatsApp clone
- Discord clone
- Telegram public community app
- social media messenger

---

### 2.3 Minimal, Calm, Premium

The UI should be clean and focused.

Prefer:

- dark mode first
- clear spacing
- readable typography
- rounded cards
- subtle shadows
- soft gradients
- restrained animations
- high contrast for important actions

Avoid:

- too many colors
- busy backgrounds
- playful stickers
- unnecessary illustrations
- excessive emoji usage
- heavy animation

---

## 3. Visual Direction

### 3.1 Theme

Primary theme:

```text
Dark mode first
Enterprise SaaS
Security-focused
Premium and calm
```

### 3.2 Color Palette

Suggested palette:

| Purpose | Color Direction |
|---|---|
| Background | Dark navy / dark slate |
| Panels | Slightly lighter slate |
| Primary accent | Soft blue |
| Secondary accent | Muted purple |
| Success / verified | Soft green |
| Warning | Muted amber |
| Critical | Controlled red |
| Text primary | Near-white |
| Text secondary | Slate gray / muted blue-gray |
| Borders | Low-contrast slate border |

Example CSS tokens:

```css
:root {
  --color-bg-main: #0b1020;
  --color-bg-panel: #111827;
  --color-bg-card: #151f32;

  --color-text-primary: #f8fafc;
  --color-text-secondary: #94a3b8;
  --color-text-muted: #64748b;

  --color-primary: #3b82f6;
  --color-primary-soft: #60a5fa;
  --color-secondary: #8b5cf6;

  --color-success: #22c55e;
  --color-warning: #f59e0b;
  --color-danger: #ef4444;

  --color-border: rgba(148, 163, 184, 0.18);
  --color-shadow: rgba(0, 0, 0, 0.35);
}
```

---

## 4. Typography

### 4.1 Font Direction

Use a clean modern sans-serif font.

Good choices:

- Inter
- Geist
- SF Pro
- Roboto
- system UI stack

Recommended stack:

```css
font-family:
  Inter,
  ui-sans-serif,
  system-ui,
  -apple-system,
  BlinkMacSystemFont,
  "Segoe UI",
  sans-serif;
```

### 4.2 Text Hierarchy

| Element | Style |
|---|---|
| Page title | Large, bold, clear |
| Section title | Medium, semibold |
| Body text | Regular, high readability |
| Security notes | Small, muted, but readable |
| Metadata | Small, muted |
| Warning text | Short and direct |

---

## 5. Layout System

### 5.1 Desktop App Shell

The primary desktop layout should use three columns:

```text
┌──────────────────┬─────────────────────────────┬─────────────────────┐
│ Left Sidebar     │ Main Chat Area               │ Security Panel      │
│                  │                             │                     │
│ Navigation       │ Conversation Header          │ Encryption Status   │
│ Conversations    │ Messages                     │ Device Info         │
│ User Profile     │ Composer                     │ Verification        │
└──────────────────┴─────────────────────────────┴─────────────────────┘
```

Recommended widths:

```text
Left sidebar: 280–340px
Main chat area: flexible
Right security panel: 300–380px
```

### 5.2 Mobile Layout

Mobile should use separate views instead of a cramped 3-column layout:

```text
Conversation List
↓
Chat Screen
↓
Security Details
↓
Settings
```

Mobile navigation options:

- bottom navigation
- compact top navigation
- slide-in security panel

Do not simply shrink the desktop view.

---

## 6. Main Screens

## 6.1 Login Page

### Goal

Let company users authenticate securely through company SSO.

### Requirements

Include:

- product logo placeholder
- product name
- tagline
- “Continue with Company SSO” button
- security indicators
- no public registration
- no email/password form
- no social login

### Suggested copy

```text
Secure Internal Messenger
Private messaging for your company

[Continue with Company SSO]

Company-approved accounts only
```

Security indicators:

```text
End-to-end encrypted messages
Company identity required
No public registration
Secure device-based access
```

---

## 6.2 Main Chat Page

### Goal

Allow users to send and receive private encrypted text and image messages.

### Layout

The main chat page contains:

- left conversation sidebar
- center chat area
- right security panel

### Left Sidebar

Should include:

- user profile
- online status
- search input
- navigation
- conversation list

Conversation item should include:

- avatar
- contact name
- last message preview
- timestamp
- unread badge
- lock icon

### Main Chat Area

Should include:

- contact name
- role/team
- online status
- encryption badge
- message bubbles
- encrypted image cards
- delivery states
- composer

Do not include:

- voice call button
- video call button

### Message Composer

Should include:

- text input
- image upload button
- send button
- short encryption note

Suggested placeholder:

```text
Write a secure message…
```

Suggested note:

```text
Messages are encrypted before sending.
```

---

## 6.3 Empty Chat State

### Goal

Give the user a calm default state when no conversation is selected.

Suggested copy:

```text
Select a conversation
Your private company messages will appear here.

Text and images are encrypted end-to-end.
```

Optional button:

```text
Start new secure conversation
```

---

## 6.4 Contacts Page

### Goal

Show verified company users who can be messaged.

### Requirements

Include:

- search
- filters
- user cards or table
- message action
- device verification state

Contact fields:

- avatar
- full name
- role/team
- company email
- online status
- verified device status
- secure messaging lock icon

Do not include:

- public invites
- external contacts
- social profile fields

---

## 6.5 Security Page

### Goal

Help users understand and manage their security state.

### Sections

Include:

- encryption status
- company identity status
- trusted devices
- key verification
- security events

Recommended cards:

```text
End-to-end encryption: Active
Company identity: Verified
Trusted devices: 2 active devices
Key verification: Recommended
```

---

## 6.6 Settings Page

### Goal

Let users manage account, device, security, appearance, notification, and privacy preferences.

### Sections

```text
Account
Devices
Security
Appearance
Notifications
Privacy
```

Do not include password change if authentication is handled by company SSO.

---

## 6.7 Admin-Lite Dashboard

### Goal

Allow admins to monitor security metadata and delivery health without exposing message content.

### Admins can see

- users
- devices
- login events
- failed logins
- delivery health
- security events
- message metadata

### Admins cannot see

- message text
- image content
- attachment previews
- encryption keys

### Required privacy notice

```text
Administrators can monitor security metadata and delivery health, but message text and image contents remain encrypted and unavailable to administrators.
```

---

## 7. Component System

## 7.1 Core Components

Required components:

- AppShell
- Sidebar
- NavigationItem
- ConversationList
- ConversationItem
- ChatHeader
- MessageBubble
- ImageMessageCard
- MessageComposer
- SecurityBadge
- DeviceStatusBadge
- SecurityPanel
- UserAvatar
- SearchInput
- SettingsCard
- AdminMetricCard
- AdminTable
- SecurityEventFeed
- Modal

---

## 7.2 Badge Types

Use badges consistently.

| Badge | Meaning |
|---|---|
| Encrypted | Conversation uses encryption |
| Verified | Device or identity verified |
| Unverified | Verification needed |
| Online | User is currently online |
| Offline | User not currently active |
| Warning | Security action recommended |
| Revoked | Device/session is revoked |

---

## 7.3 Message States

Messages should support:

```text
Sending
Sent
Delivered
Read
Failed
```

Visual style:

- `Sending`: muted spinner or subtle clock
- `Sent`: single check or text
- `Delivered`: double check or text
- `Read`: read indicator
- `Failed`: warning state with retry

---

## 7.4 Image Attachment States

Image upload flow should support:

```text
Selected
Encrypting locally
Uploading encrypted image
Uploaded
Failed
Removed
```

Suggested UI copy:

```text
Encrypting image locally…
Uploading encrypted image…
Image upload failed
Encrypted image
```

---

## 8. Security UX Rules

### 8.1 Make Encryption Visible

Encryption should be visible in:

- chat header
- message composer
- image upload flow
- security panel
- settings/security page

But keep it calm and understandable.

---

### 8.2 Avoid False Promises

Do not use vague claims like:

```text
100% secure
unhackable
military-grade encryption
impossible to intercept
```

Use clearer language:

```text
Messages are encrypted before they leave your device.
Message content is not visible to administrators.
Device verification helps confirm who you are messaging.
```

---

### 8.3 Admin Transparency

The UI should clearly separate:

```text
Security metadata
```

from:

```text
Message content
```

Admins should never see a fake preview of encrypted messages.

---

### 8.4 Device Trust

Device trust is a central security concept.

Each device should have:

- device name
- platform/browser
- last active
- trust status
- verification status
- revoke action

Example:

```text
MacBook Pro — Chrome
Current device
Verified
Last active: now
```

---

## 9. Interaction Rules

### 9.1 Message Sending

Expected flow:

```text
User writes message
↓
Client encrypts message
↓
Message is sent
↓
Message appears in chat as sending
↓
Server acknowledges delivery
↓
Message state changes to sent/delivered/read
```

### 9.2 Image Sending

Expected flow:

```text
User selects image
↓
Client shows preview
↓
Client encrypts image locally
↓
Encrypted blob uploads
↓
Encrypted message with attachment reference is sent
↓
Recipient decrypts image locally
```

### 9.3 New Conversation

Expected flow:

```text
User clicks Start new secure conversation
↓
Searches company users
↓
Selects verified user
↓
Device/key status is shown
↓
Starts 1:1 encrypted chat
```

---

## 10. Accessibility Requirements

Minimum requirements:

- readable contrast
- keyboard navigation
- focus states
- screen-reader-friendly labels
- clear button text
- no color-only status indicators
- scalable typography
- touch-friendly mobile targets

Status indicators should use both color and text/icon.

Bad:

```text
green dot only
```

Good:

```text
green dot + “Verified”
```

---

## 11. Responsive Behavior

### Desktop

Use 3-column layout.

### Tablet

Use 2-column layout:

```text
Sidebar + Main Chat
Security Panel as drawer
```

### Mobile

Use separate screens:

```text
Conversation List
Chat
Security Details
Settings
```

No tiny right panel on mobile.

---

## 12. Copywriting Tone

Tone should be:

- clear
- calm
- direct
- professional
- security-aware

Avoid:

- hype
- jokes
- consumer slang
- fear-based language
- fake security marketing

Good examples:

```text
Messages are encrypted before sending.
Company-approved accounts only.
Verify this device to improve account security.
Message content is not visible to administrators.
```

---

## 13. Design Quality Checklist

Before accepting a generated UI, check:

- [ ] Does it look enterprise-grade?
- [ ] Is dark mode clean and readable?
- [ ] Is there no public sign-up?
- [ ] Is there no voice/video UI?
- [ ] Are encryption states visible?
- [ ] Are device verification states visible?
- [ ] Is admin content privacy clear?
- [ ] Is the layout responsive?
- [ ] Are message states clear?
- [ ] Are image attachments shown as encrypted?
- [ ] Does it avoid playful consumer-chat styling?
- [ ] Does it feel like a company-internal security product?

---

## 14. Suggested File Structure

Suggested frontend design-related structure:

```text
docs/
  product/
    design.md
    stitch-ui-prompts.md
    architecture.md

src/
  app/
  components/
    layout/
    chat/
    security/
    settings/
    admin/
  styles/
    tokens.css
    globals.css
  lib/
    api/
    crypto/
    auth/
```

---

## 15. Future Native App Considerations

Even though the first beta is web-only, the design should prepare for future native apps.

Design decisions that help later:

- keep navigation simple
- keep chat interaction standard
- keep security panel modular
- avoid desktop-only workflows
- separate conversation list from chat view
- make device verification a reusable screen
- keep image attachment flow simple
- avoid browser-specific UI assumptions

Future platforms:

```text
iOS
Android
Windows
macOS
Linux
```

---

## 16. Final Design Direction

The product should look and feel like:

```text
A private company messenger
+
A modern security dashboard
+
A calm enterprise SaaS platform
```

The user should immediately understand:

```text
This is internal.
This is secure.
This is not public.
This is not a social app.
This is built for serious company communication.
```
