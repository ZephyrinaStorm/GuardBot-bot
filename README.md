# GuardBot Pro

Modern Discord.js v14 anti-raid and moderation bot for Drago Gaming. It combines the useful ideas from both older `scottoss/antiraid` projects with GuardBot Pro, without their obsolete APIs or unsafe automatic inviter bans.

## Protection

- Join-burst anti-raid timeouts
- Anti-spam timeouts
- Link and Discord-invite filtering
- Optional blocking of unverified bots
- `/guard-status`, `/guard-config`, `/lockdown`, `/timeout`, `/kick`, `/ban`, and `/purge`
- Render-compatible health endpoint
- `/help` command with setup guidance
- Account-age based alt detection, scanning, and confirmed removal
- Self-attested age gate that does not store birth dates
- Server structure backups with non-destructive restoration

## Discord and Render setup

Create a Discord application and bot, then enable **Server Members Intent** and **Message Content Intent**. Invite it with `bot` and `applications.commands`. Give it View Channels, Send Messages, Manage Messages, Moderate Members, Kick Members, Ban Members, and Manage Channels. Place its role above members it must moderate.

Create a Render Blueprint from `render.yaml`. Enter `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, and `DISCORD_GUILD_ID` as secret environment values. Never commit the token. Guild-scoped slash commands update immediately; omit `DISCORD_GUILD_ID` only for global commands.

Backups and server settings are stored under `DATA_PATH`. Render's local filesystem is temporary unless you attach a persistent disk. For durable backups on a paid Render service, mount a disk and set `DATA_PATH` to its mount path, such as `/var/data`.

Alt detection uses Discord account age as a risk signal and cannot prove that someone is an alternate account. Start with **Alert only**, review results with `/alt-scan`, and use `/alt-remove` only after reviewing the list. The age gate is self-attestation; it checks an entered age, grants the configured role, and does not store the age or date of birth.

The free Render web service may sleep when idle. Continuous protection needs a paid always-on instance or another always-on host.
