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
- Desktop mirroring requires both `GROK_DESKTOP_MIRROR_CHAT_ID` and `GROK_DESKTOP_MIRROR_USER_ID`. Each must already be in its corresponding Telegram allowlist. Only that exact user/chat pair can change the persisted mirror override or receive desktop approval buttons.
- Keep `.env`, `GROK_GATEWAY_TOKEN_FILE`, and any existing `BRIDGE_STATE_PATH` mode `600`. Gateway discovery and state files must be regular, non-symlink files; the bridge refuses them when group or other permissions are set.
- Never commit `.env`, `bridge-state.json`, `gateway.json`, `bridge.log`, or `bridge.pid`.
- Do not send passwords, API keys, or other secrets through Telegram.

## What this bridge will not do

It does not expose an inbound internet port or webhook. Telegram access is outbound HTTPS long polling only.

Approval buttons are one-time and expire after 10 minutes. They never map to Grok's persistent `always` or `never` permissions. Secrets, captchas, rich widgets, and oversized approval text are refused and must be handled in Grok Bot on desktop.

Transcript prompts whose top-level `clientNonce` starts with `telegram:` were created by this bridge. A response entry proven by a live completion boundary is threaded only to its authorized originating chat. Entries without that proof are never sent to the originating chat; when a mirror destination is configured, they go only to that chat with neutral Grok-update labeling. Prompt-context delivery remains active when unsolicited desktop mirroring is turned off. Desktop mirror cursors and prompt delivery contexts are owner-only bridge state and advance per entry after successful Telegram delivery; delivery is intentionally at-least-once across crashes. Reply ownership is never inferred from the agent's current `lastMessageId`.
