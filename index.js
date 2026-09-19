require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits, Events, PermissionsBitField, REST, Routes, SlashCommandBuilder } = require('discord.js');
for (const key of ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID']) if (!process.env[key]) throw new Error(`${key} is required`);

const settings = new Map(), joins = new Map(), messages = new Map();
const defaults = () => ({ antiLink: true, antiSpam: true, antiRaid: true, antiBot: true });
const configFor = id => settings.get(id) || defaults();
const commands = [
  new SlashCommandBuilder().setName('guard-status').setDescription('Show GuardBot protection status'),
  new SlashCommandBuilder().setName('guard-config').setDescription('Enable or disable a protection').setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
    .addStringOption(o => o.setName('protection').setDescription('Protection module').setRequired(true).addChoices(
      { name: 'Anti link', value: 'antiLink' }, { name: 'Anti spam', value: 'antiSpam' },
      { name: 'Anti raid', value: 'antiRaid' }, { name: 'Block unverified bots', value: 'antiBot' }))
    .addBooleanOption(o => o.setName('enabled').setDescription('On or off').setRequired(true)),
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
  const route = process.env.DISCORD_GUILD_ID ? Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID) : Routes.applicationCommands(process.env.DISCORD_CLIENT_ID);
  await rest.put(route, { body: commands });
  console.log(`GuardBot online as ${ready.user.tag}; ${commands.length} slash commands registered.`);
});

client.on(Events.GuildMemberAdd, async member => {
  const cfg = configFor(member.guild.id);
  if (member.user.bot && cfg.antiBot && !member.user.flags?.has('VerifiedBot')) {
    if (member.bannable) await member.ban({ reason: 'GuardBot: unverified bot blocked' }).catch(console.error);
    return;
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

client.on(Events.InteractionCreate, async i => {
  if (!i.isChatInputCommand() || !i.guild) return;
  const reason = i.options.getString('reason') || `Action by ${i.user.tag}`;
  try {
    if (i.commandName === 'guard-status') return i.reply({ content: Object.entries(configFor(i.guild.id)).map(([k,v]) => `${v?'✅':'⛔'} ${k}`).join('\n'), ephemeral: true });
    if (i.commandName === 'guard-config') {
      settings.set(i.guild.id, { ...configFor(i.guild.id), [i.options.getString('protection')]: i.options.getBoolean('enabled') });
      return i.reply({ content: 'Protection setting updated. It remains active while this Render service is running.', ephemeral: true });
    }
    if (i.commandName === 'lockdown') {
      await i.channel.permissionOverwrites.edit(i.guild.roles.everyone, { SendMessages: i.options.getBoolean('enabled') ? false : null }, { reason });
      return i.reply({ content: i.options.getBoolean('enabled') ? '🔒 Channel locked.' : '🔓 Channel unlocked.', ephemeral: true });
    }
    if (i.commandName === 'purge') {
      const deleted = await i.channel.bulkDelete(i.options.getInteger('amount'), true);
      return i.reply({ content: `Deleted ${deleted.size} messages.`, ephemeral: true });
    }
    const member = i.options.getMember('member');
    if (!member) return i.reply({ content: 'Member not found.', ephemeral: true });
    if (i.commandName === 'timeout') await member.timeout(i.options.getInteger('minutes') * 60_000, reason);
    if (i.commandName === 'kick') await member.kick(reason);
    if (i.commandName === 'ban') await member.ban({ reason });
    return i.reply({ content: `✅ ${i.commandName} completed for ${member.user.tag}.`, ephemeral: true });
  } catch (error) {
    console.error(error);
    const response = { content: 'I could not complete that action. Check my role position and permissions.', ephemeral: true };
    return i.replied ? i.followUp(response) : i.reply(response);
  }
});

const app = express();
app.get('/', (_req, res) => res.json({ service: 'GuardBot Pro', status: client.isReady() ? 'online' : 'starting' }));
app.get('/health', (_req, res) => res.status(client.isReady() ? 200 : 503).json({ ready: client.isReady() }));
app.listen(process.env.PORT || 10000, () => console.log('Health server ready.'));
client.login(process.env.DISCORD_BOT_TOKEN);
