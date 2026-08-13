# Security

This project is unofficial and is not affiliated with xAI, Grok, or Telegram.

## Report a vulnerability

If you find a security issue, do **not** open a public GitHub issue.

- Prefer [GitHub Security Advisories](https://github.com/ssbrouhard/grokbot-telegram-bridge/security/advisories/new).
- Include the affected version or commit, reproduction steps, and impact.
- Do not attach `.env` files, bot tokens, gateway tokens, state files, or logs that may contain chat IDs.

## Hard requirements

- `GROK_GATEWAY_URL` must be a loopback host (`127.0.0.1`, `localhost`, or `::1`). The process refuses other hosts and gateway redirects.
- Every inbound Telegram update must be a private chat and must match both `TELEGRAM_ALLOWED_USER_IDS` and `TELEGRAM_ALLOWED_CHAT_IDS`. Other updates are ignored.
- Desktop mirroring requires both `GROK_DESKTOP_MIRROR_CHAT_ID` and `GROK_DESKTOP_MIRROR_USER_ID`. Each must already be in its corresponding Telegram allowlist. Only that exact user/chat pair can change the persisted mirror override or receive mirrored permission approvals and autonomous routine choices.
- Keep `.env`, `GROK_GATEWAY_TOKEN_FILE`, and any existing `BRIDGE_STATE_PATH` mode `600`. Gateway discovery and state files must be regular, non-symlink files; the bridge refuses them when group or other permissions are set.
- Never commit `.env`, `bridge-state.json`, `gateway.json`, `bridge.log`, or `bridge.pid`.
- Do not send passwords, API keys, or other secrets through Telegram.

## What this bridge will not do

It does not expose an inbound internet port or webhook. Telegram access is outbound HTTPS long polling only.

Permission approval buttons are one-time and expire after 10 minutes. They never map to Grok's persistent `always` or `never` permissions. Autonomous routine choice cards are separate one-time actions: they are bound to the configured mirror user, chat, Telegram message, Grok agent, and transcript entry; submit the selected exact value as a new prompt; and expire after 12 hours. Secrets, captchas, other rich widgets, and oversized content are refused and must be handled in Grok Bot on desktop.

Transcript prompts whose top-level `clientNonce` starts with `telegram:` were created by this bridge. The mirror watcher excludes each such prompt and its response turn to prevent reflection and feedback loops. Desktop mirror cursors are owner-only bridge state and advance after successful Telegram delivery; delivery is intentionally at-least-once across crashes.
