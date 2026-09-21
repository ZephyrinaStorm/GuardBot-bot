require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const {
  Client, GatewayIntentBits, Events, PermissionsBitField, REST, Routes,
  SlashCommandBuilder, ChannelType
} = require('discord.js');

if (!process.env.DISCORD_BOT_TOKEN) throw new Error('DISCORD_BOT_TOKEN is required');
const DATA_DIR = process.env.DATA_PATH || path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BLACKLIST_FILE = path.join(__dirname, 'blacklist.json');
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const loadJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const configs = loadJson(CONFIG_FILE, {});
function readBlacklist() {
  const data = JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf8'));
  if (!Array.isArray(data.banned) || !data.banned.every(id => typeof id === 'string' && /^\d{17,20}$/.test(id))) {
    throw new Error('blacklist.json must contain a banned array of Discord account IDs');
  }
  return new Set(data.banned);
}
// Check the file at startup; missing or malformed data must not silently disable protection.
readBlacklist();
async function banBlacklisted(member, ids) {
  if (!ids.has(member.id)) return false;
  if (member.bannable) await member.ban({ reason: 'GuardBot: account matched private moderation blocklist' }).catch(console.error);
  else console.warn(`Blacklisted account ${member.id} in ${member.guild.id} could not be banned. Check role order and Ban Members permission.`);
  return true;
}
const saveConfigs = () => fs.writeFileSync(CONFIG_FILE, JSON.stringify(configs, null, 2));
const defaults = () => ({ antiLink: true, antiSpam: true, antiRaid: true, antiBot: true, altMinimumDays: 7, altAction: 'alert', ageMinimum: 13, verifiedRoleId: null, unverifiedRoleId: null });
const configFor = id => configs[id] ||= defaults();
const joins = new Map(), messages = new Map();
const accountDays = user => Math.floor((Date.now() - user.createdTimestamp) / 86400000);
const safeName = value => value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);

const commands = [
  new SlashCommandBuilder().setName('help').setDescription('Show GuardBot commands and setup help'),
  new SlashCommandBuilder().setName('guard-status').setDescription('Show GuardBot protection status'),
  new SlashCommandBuilder().setName('guard-config').setDescription('Enable or disable a protection').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .addStringOption(o => o.setName('protection').setDescription('Protection module').setRequired(true).addChoices(
      { name: 'Anti link', value: 'antiLink' }, { name: 'Anti spam', value: 'antiSpam' },
      { name: 'Anti raid', value: 'antiRaid' }, { name: 'Block unverified bots', value: 'antiBot' }))
    .addBooleanOption(o => o.setName('enabled').setDescription('On or off').setRequired(true)),
  new SlashCommandBuilder().setName('alt-config').setDescription('Configure detection for newly created Discord accounts').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .addIntegerOption(o => o.setName('minimum_days').setDescription('Accounts younger than this are flagged').setMinValue(1).setMaxValue(365).setRequired(true))
    .addStringOption(o => o.setName('action').setDescription('Automatic action when a new member joins').setRequired(true).addChoices(
      { name: 'Alert only', value: 'alert' }, { name: 'Timeout', value: 'timeout' }, { name: 'Kick', value: 'kick' }, { name: 'Ban', value: 'ban' })),
  new SlashCommandBuilder().setName('alt-scan').setDescription('List members whose accounts are under the configured age').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder().setName('alt-remove').setDescription('Remove accounts under the configured account-age limit').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .addStringOption(o => o.setName('action').setDescription('How to remove flagged members').setRequired(true).addChoices({ name: 'Kick', value: 'kick' }, { name: 'Ban', value: 'ban' }))
    .addStringOption(o => o.setName('confirm').setDescription('Type REMOVE to confirm').setRequired(true)),
  new SlashCommandBuilder().setName('agegate-setup').setDescription('Configure a self-attested community age gate').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .addIntegerOption(o => o.setName('minimum_age').setDescription('Minimum community age').setMinValue(13).setMaxValue(100).setRequired(true))
    .addRoleOption(o => o.setName('verified_role').setDescription('Role granted after verification').setRequired(true))
    .addRoleOption(o => o.setName('unverified_role').setDescription('Optional role removed after verification')),
  new SlashCommandBuilder().setName('age-verify').setDescription('Self-attest that you meet the community age requirement')
    .addIntegerOption(o => o.setName('age').setDescription('Your age; it is checked but not stored').setMinValue(13).setMaxValue(100).setRequired(true)),
  new SlashCommandBuilder().setName('backup-create').setDescription('Create a server structure backup').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .addStringOption(o => o.setName('name').setDescription('Backup name').setMaxLength(40)),
  new SlashCommandBuilder().setName('backup-list').setDescription('List saved server backups').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
  new SlashCommandBuilder().setName('backup-restore').setDescription('Restore missing roles and channels from a backup').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .addStringOption(o => o.setName('id').setDescription('Backup ID from /backup-list').setRequired(true))
    .addStringOption(o => o.setName('confirm').setDescription('Type RESTORE to confirm').setRequired(true)),
  new SlashCommandBuilder().setName('lockdown').setDescription('Lock or unlock the current channel').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
    .addBooleanOption(o => o.setName('enabled').setDescription('True locks the channel').setRequired(true)),
  new SlashCommandBuilder().setName('timeout').setDescription('Temporarily timeout a member').setDefaultMemberPermissions(PermissionsBitField.Flags.ModerateMembers)
    .addUserOption(o => o.setName('member').setDescription('Member to timeout').setRequired(true))
    .addIntegerOption(o => o.setName('minutes').setDescription('1 to 10080 minutes').setMinValue(1).setMaxValue(10080).setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason')),
  new SlashCommandBuilder().setName('kick').setDescription('Kick a member').setDefaultMemberPermissions(PermissionsBitField.Flags.KickMembers)
    .addUserOption(o => o.setName('member').setDescription('Member to kick').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason')),
  new SlashCommandBuilder().setName('ban').setDescription('Ban a member').setDefaultMemberPermissions(PermissionsBitField.Flags.BanMembers)
    .addUserOption(o => o.setName('member').setDescription('Member to ban').setRequired(true)).addStringOption(o => o.setName('reason').setDescription('Reason')),
  new SlashCommandBuilder().setName('purge').setDescription('Delete recent messages').setDefaultMemberPermissions(PermissionsBitField.Flags.ManageMessages)
    .addIntegerOption(o => o.setName('amount').setDescription('1 to 100 messages').setMinValue(1).setMaxValue(100).setRequired(true))
].map(c => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
client.once(Events.ClientReady, async ready => {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  // A bot user's ID is its application ID. Derive it from the logged-in token
  // so a stale DISCORD_CLIENT_ID setting cannot target a different app.
  const applicationId = ready.user.id;
  if (process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_ID !== applicationId) {
    console.warn('DISCORD_CLIENT_ID does not match the logged-in bot; ignoring it.');
  }
  try {
    await rest.put(Routes.applicationCommands(applicationId), { body: commands });
    console.log(`GuardBot online as ${ready.user.tag}; ${commands.length} global slash commands registered.`);
  } catch (error) {
    console.error('Could not register global commands for this bot application:', error);
  }
  // Remove the matching guild commands left by earlier versions so they do not
  // appear alongside the new global commands. Only this application's commands
  // and only names registered by GuardBot are affected.
  if (process.env.DISCORD_GUILD_ID) {
    try {
      const guildId = process.env.DISCORD_GUILD_ID;
      const oldCommands = await rest.get(Routes.applicationGuildCommands(applicationId, guildId));
      const names = new Set([...commands.map(command => command.name), 'blacklist-check', 'blacklist-enforce']);
      for (const command of oldCommands.filter(command => names.has(command.name))) {
        await rest.delete(Routes.applicationGuildCommand(applicationId, guildId, command.id));
      }
      console.log('Removed matching legacy guild commands.');
    } catch (error) {
      console.error('Global commands registered, but legacy guild command cleanup failed:', error);
    }
  }
  const ids = readBlacklist();
  for (const guild of ready.guilds.cache.values()) {
    try {
      const members = await guild.members.fetch();
      for (const member of members.values()) await banBlacklisted(member, ids);
    } catch (error) {
      console.error(`Could not check existing members in ${guild.id} against blacklist.json:`, error);
    }
  }
});
client.on(Events.Error, error => console.error('Discord gateway error:', error));

client.on(Events.GuildMemberAdd, async member => {
  if (await banBlacklisted(member, readBlacklist())) return;
  const cfg = configFor(member.guild.id);
  if (cfg.unverifiedRoleId) await member.roles.add(cfg.unverifiedRoleId, 'GuardBot age gate').catch(() => {});
  if (member.user.bot && cfg.antiBot && !member.user.flags?.has('VerifiedBot')) {
    if (member.bannable) await member.ban({ reason: 'GuardBot: unverified bot blocked' }).catch(console.error);
    return;
  }
  if (!member.user.bot && accountDays(member.user) < cfg.altMinimumDays) {
    const reason = `GuardBot: account is ${accountDays(member.user)} days old; minimum is ${cfg.altMinimumDays}`;
    if (cfg.altAction === 'alert' && member.guild.systemChannel) await member.guild.systemChannel.send(`⚠️ Possible alt account: ${member.user.tag} — ${reason}`).catch(() => {});
    if (cfg.altAction === 'timeout' && member.moderatable) await member.timeout(24 * 60 * 60_000, reason).catch(console.error);
    if (cfg.altAction === 'kick' && member.kickable) await member.kick(reason).catch(console.error);
    if (cfg.altAction === 'ban' && member.bannable) await member.ban({ reason }).catch(console.error);
  }
  if (!cfg.antiRaid || member.user.bot) return;
  const now = Date.now(), recent = (joins.get(member.guild.id) || []).filter(t => now - t < 15000);
  recent.push(now); joins.set(member.guild.id, recent);
  if (recent.length >= 8 && member.moderatable) await member.timeout(10 * 60_000, 'GuardBot: raid join burst').catch(console.error);
});

client.on(Events.MessageCreate, async message => {
  if (!message.guild || message.author.bot || message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return;
  const cfg = configFor(message.guild.id);
  if (cfg.antiLink && /(https?:\/\/|discord(?:app)?\.com\/invite\/|discord\.gg\/)/i.test(message.content)) return void await message.delete().catch(() => {});
  if (!cfg.antiSpam) return;
  const key = `${message.guild.id}:${message.author.id}`, now = Date.now(), recent = (messages.get(key) || []).filter(t => now - t < 7000);
  recent.push(now); messages.set(key, recent);
  if (recent.length >= 6) {
    messages.delete(key); await message.delete().catch(() => {});
    if (message.member.moderatable) await message.member.timeout(5 * 60_000, 'GuardBot: spam').catch(console.error);
  }
});

function backupGuild(guild, name) {
  const id = `${Date.now()}-${safeName(name || 'backup')}`;
  const data = {
    id, guildId: guild.id, guildName: guild.name, createdAt: new Date().toISOString(),
    roles: guild.roles.cache.filter(r => !r.managed && r.id !== guild.id).map(r => ({ name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable, permissions: r.permissions.bitfield.toString() })),
    channels: guild.channels.cache.filter(c => [ChannelType.GuildCategory, ChannelType.GuildText, ChannelType.GuildVoice].includes(c.type)).map(c => ({ name: c.name, type: c.type, parentName: c.parent?.name || null, topic: c.type === ChannelType.GuildText ? c.topic : null, nsfw: c.type === ChannelType.GuildText ? c.nsfw : false }))
  };
  fs.writeFileSync(path.join(BACKUP_DIR, `${guild.id}-${id}.json`), JSON.stringify(data, null, 2));
  return data;
}

async function restoreGuild(guild, data) {
  let roles = 0, channels = 0;
  for (const role of data.roles) if (!guild.roles.cache.some(r => r.name === role.name)) {
    await guild.roles.create({ name: role.name, color: role.color, hoist: role.hoist, mentionable: role.mentionable, permissions: BigInt(role.permissions), reason: `GuardBot restore ${data.id}` }); roles++;
  }
  const categories = data.channels.filter(c => c.type === ChannelType.GuildCategory);
  for (const channel of categories) if (!guild.channels.cache.some(c => c.type === channel.type && c.name === channel.name)) {
    await guild.channels.create({ name: channel.name, type: channel.type, reason: `GuardBot restore ${data.id}` }); channels++;
  }
  for (const channel of data.channels.filter(c => c.type !== ChannelType.GuildCategory)) if (!guild.channels.cache.some(c => c.type === channel.type && c.name === channel.name)) {
    const parent = channel.parentName ? guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === channel.parentName) : null;
    await guild.channels.create({ name: channel.name, type: channel.type, parent: parent?.id, topic: channel.topic || undefined, nsfw: channel.nsfw || false, reason: `GuardBot restore ${data.id}` }); channels++;
  }
  return { roles, channels };
}

client.on(Events.InteractionCreate, async i => {
  if (!i.isChatInputCommand() || !i.guild) return;
  const reason = i.options.getString('reason') || `Action by ${i.user.tag}`;
  try {
    if (i.commandName === 'help') return i.reply({ content: '**GuardBot Pro**\nProtection: `/guard-status`, `/guard-config`, `/alt-config`, `/alt-scan`, `/alt-remove`\nAge gate: `/agegate-setup`, `/age-verify`\nBackups: `/backup-create`, `/backup-list`, `/backup-restore`\nModeration: `/lockdown`, `/timeout`, `/kick`, `/ban`, `/purge`\nThe private blacklist automatically bans matching accounts on join and checks existing members when the bot starts. Alt detection uses account age as a risk signal. Age verification is self-attested.', ephemeral: true });
    if (i.commandName === 'guard-status') {
      const c = configFor(i.guild.id);
      return i.reply({ content: `Anti-link: ${c.antiLink?'on':'off'}\nAnti-spam: ${c.antiSpam?'on':'off'}\nAnti-raid: ${c.antiRaid?'on':'off'}\nBlock unverified bots: ${c.antiBot?'on':'off'}\nAlt threshold: ${c.altMinimumDays} days (${c.altAction})\nAge gate: ${c.ageMinimum}+`, ephemeral: true });
    }
    if (i.commandName === 'guard-config') {
      const c = configFor(i.guild.id); c[i.options.getString('protection')] = i.options.getBoolean('enabled'); saveConfigs();
      return i.reply({ content: 'Protection setting saved.', ephemeral: true });
    }
    if (i.commandName === 'alt-config') {
      const c = configFor(i.guild.id); c.altMinimumDays = i.options.getInteger('minimum_days'); c.altAction = i.options.getString('action'); saveConfigs();
      return i.reply({ content: `Accounts younger than ${c.altMinimumDays} days will use action: ${c.altAction}.`, ephemeral: true });
    }
    if (i.commandName === 'alt-scan') {
      await i.deferReply({ ephemeral: true }); await i.guild.members.fetch(); const c = configFor(i.guild.id);
      const flagged = i.guild.members.cache.filter(m => !m.user.bot && accountDays(m.user) < c.altMinimumDays).sort((a,b) => a.user.createdTimestamp-b.user.createdTimestamp).first(50);
      return i.editReply(flagged.length ? flagged.map(m => `${m.user.tag} — ${accountDays(m.user)} days old`).join('\n') : 'No accounts were flagged.');
    }
    if (i.commandName === 'alt-remove') {
      if (i.options.getString('confirm') !== 'REMOVE') return i.reply({ content: 'Cancelled. Type REMOVE exactly to confirm.', ephemeral: true });
      await i.deferReply({ ephemeral: true }); await i.guild.members.fetch(); const c = configFor(i.guild.id), action = i.options.getString('action');
      const flagged = [...i.guild.members.cache.values()].filter(m => !m.user.bot && m.id !== i.user.id && accountDays(m.user) < c.altMinimumDays);
      let removed = 0; for (const m of flagged) { if (action === 'kick' && m.kickable) { await m.kick('GuardBot alt removal'); removed++; } if (action === 'ban' && m.bannable) { await m.ban({ reason: 'GuardBot alt removal' }); removed++; } }
      return i.editReply(`Completed: ${removed} member(s) ${action === 'ban' ? 'banned' : 'kicked'}.`);
    }
    if (i.commandName === 'agegate-setup') {
      const c = configFor(i.guild.id); c.ageMinimum = i.options.getInteger('minimum_age'); c.verifiedRoleId = i.options.getRole('verified_role').id; c.unverifiedRoleId = i.options.getRole('unverified_role')?.id || null; saveConfigs();
      return i.reply({ content: `Age gate set to ${c.ageMinimum}+. This is self-attestation, not identity verification.`, ephemeral: true });
    }
    if (i.commandName === 'age-verify') {
      const c = configFor(i.guild.id), age = i.options.getInteger('age');
      if (!c.verifiedRoleId) return i.reply({ content: 'An administrator must run `/agegate-setup` first.', ephemeral: true });
      if (age < c.ageMinimum) return i.reply({ content: `You do not meet this community's ${c.ageMinimum}+ requirement. No age was stored.`, ephemeral: true });
      await i.member.roles.add(c.verifiedRoleId, 'GuardBot age self-attestation'); if (c.unverifiedRoleId) await i.member.roles.remove(c.unverifiedRoleId, 'GuardBot age self-attestation').catch(() => {});
      return i.reply({ content: 'Age requirement confirmed and verified role added. Your age was not stored.', ephemeral: true });
    }
    if (i.commandName === 'backup-create') {
      const backup = backupGuild(i.guild, i.options.getString('name')); return i.reply({ content: `Backup created: \`${backup.id}\``, ephemeral: true });
    }
    if (i.commandName === 'backup-list') {
      const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith(`${i.guild.id}-`) && f.endsWith('.json')).slice(-20);
      return i.reply({ content: files.length ? files.map(f => `\`${loadJson(path.join(BACKUP_DIR, f), {}).id}\``).join('\n') : 'No backups found.', ephemeral: true });
    }
    if (i.commandName === 'backup-restore') {
      if (i.options.getString('confirm') !== 'RESTORE') return i.reply({ content: 'Cancelled. Type RESTORE exactly to confirm.', ephemeral: true });
      const id = safeName(i.options.getString('id')), file = path.join(BACKUP_DIR, `${i.guild.id}-${id}.json`), data = loadJson(file, null);
      if (!data || data.guildId !== i.guild.id) return i.reply({ content: 'Backup not found.', ephemeral: true });
      await i.deferReply({ ephemeral: true }); const result = await restoreGuild(i.guild, data); return i.editReply(`Restore complete: ${result.roles} roles and ${result.channels} channels recreated. Existing items were not deleted.`);
    }
    if (i.commandName === 'lockdown') {
      await i.channel.permissionOverwrites.edit(i.guild.roles.everyone, { SendMessages: i.options.getBoolean('enabled') ? false : null }, { reason });
      return i.reply({ content: i.options.getBoolean('enabled') ? '🔒 Channel locked.' : '🔓 Channel unlocked.', ephemeral: true });
    }
    if (i.commandName === 'purge') { const deleted = await i.channel.bulkDelete(i.options.getInteger('amount'), true); return i.reply({ content: `Deleted ${deleted.size} messages.`, ephemeral: true }); }
    const member = i.options.getMember('member'); if (!member) return i.reply({ content: 'Member not found.', ephemeral: true });
    if (i.commandName === 'timeout') await member.timeout(i.options.getInteger('minutes') * 60_000, reason);
    if (i.commandName === 'kick') await member.kick(reason);
    if (i.commandName === 'ban') await member.ban({ reason });
    return i.reply({ content: `✅ ${i.commandName} completed for ${member.user.tag}.`, ephemeral: true });
  } catch (error) {
    console.error(error); const response = { content: 'I could not complete that action. Check my role position, permissions, and storage settings.', ephemeral: true };
    return i.replied || i.deferred ? i.followUp(response) : i.reply(response);
  }
});

const app = express();
app.get('/', (_req, res) => res.json({ service: 'GuardBot Pro', status: client.isReady() ? 'online' : 'starting', commands: commands.length }));
app.get('/health', (_req, res) => res.status(client.isReady() ? 200 : 503).json({ ready: client.isReady() }));
app.listen(process.env.PORT || 10000, () => console.log('Health server ready.'));
client.login(process.env.DISCORD_BOT_TOKEN);
