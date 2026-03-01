// Imports
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getVoiceConnection, EndBehaviorType } = require('@discordjs/voice');

// Local Imports
const {
	initVoicePresence,
	getUserVoiceGuild,
	getUserVoiceChannel,
	getUsersForChannel,
	addUserToVoicePresence,
	removeUserFromVoicePresence,
} = require("./voicePresence");

// Discord Many Imports
const {
	Client,
	GatewayIntentBits,
	Collection,
	Events,
	MessageFlags,
	REST,
	Routes,
} = require("discord.js");

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
})



// Gather Commands from commands folder
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.js'));
for (const file of commandFiles) {
	const filePath = path.join(commandsPath, file);
	const command = require(filePath);
	// Set a new item in the Collection with the key as the command name and the value as the exported module
	if ('data' in command && 'execute' in command) {
		client.commands.set(command.data.name, command);
	} else {
		consoleLogger(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
	}
}

// Command Executer 
client.on(Events.InteractionCreate, async (interaction) => {
	// If Not Command
	if (!interaction.isChatInputCommand()) return;

	// Get Command
	const command = interaction.client.commands.get(interaction.commandName);
	
	// If Command Invalid
	if (!command) {
		console.error(`No command matching ${interaction.commandName} was found.`);
		return;
	}

	// Try To Run Command
	try {
		await command.execute(interaction);
	
	// Command Run Error
	// Inform of Fail
	} catch (error) {
		console.error(error);
		if (interaction.replied || interaction.deferred) {
			await interaction.followUp({
				content: 'There was an error while executing this command!',
				flags: MessageFlags.Ephemeral,
			});
		} else {
			await interaction.reply({
				content: 'There was an error while executing this command!',
				flags: MessageFlags.Ephemeral,
			});
		}
	}
});

// Command Registerer
async function registerCommands() {
	const commands = client.commands.map((command) => command.data.toJSON());
	const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
	const appId = process.env.WEB_CLIENT_ID;

	// PUT Commands
	await rest.put(Routes.applicationCommands(appId), { body: commands });
	consoleLogger(`Registered ${commands.length} global command(s).`);
}

// Voice state listener
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
	const userId = newState.id;
	const guildId = newState.guildId;
	const channelId = newState.channelId;

	const disconnected = !!oldState.channelId && oldState.channelId !== newState.channelId;

	if (disconnected) {
		removeUserFromVoicePresence(userId);
		return;
	}

	const connected = !oldState.channelId && !!newState.channelId;
	if (connected) {
		addUserToVoicePresence(userId, guildId, newState.channelId);
	}

	const moved = !!oldState.channelId && !!newState.channelId && oldState.channelId !== newState.channelId;
	if (moved) {
		addUserToVoicePresence(userId, guildId, newState.channelId);
	}

	const newMuted = newState.serverMute || newState.selfMute;
	const oldMuted = oldState.serverMute || oldState.selfMute;
	if (oldMuted !== newMuted) {
		client.emit('voiceActivity', {
			type: newMuted ? 'mute' : 'unmute',
			guildId,
			channelId,
			userId,
			username: newState.member?.user?.username ?? userId,
			at: Date.now(),
		});
	}

	const newDeafened = newState.serverDeaf || newState.selfDeaf;
	const oldDeafened = oldState.serverDeaf || oldState.selfDeaf;
	if (oldDeafened !== newDeafened) {
		client.emit('voiceActivity', {
			type: newDeafened ? 'deaf' : 'undeaf',
			guildId,
			channelId,
			userId,
			username: newState.member?.user?.username ?? userId,
			at: Date.now(),
		});
	}
});

// Return All Users In User's Voice
async function getVoiceUsers(id) {
	const users = []
	try {
		// Guild Validation
		const guildId = getUserVoiceGuild(id)
		const channelId = getUserVoiceChannel(id)
		const guild = client.guilds.cache.get(guildId)
		if (!guild || !channelId) return users

		// Get users from voicePresence inverse index instead of channel member iteration.
		const userIds = getUsersForChannel(guildId, channelId);
		for (const userId of userIds) {
			const member = guild.members.cache.get(userId) ?? await guild.members.fetch(userId).catch(() => null);
			if (!member) continue;

			users.push({
				userId,
				username: member.user?.username ?? userId,
				avatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 64 }),
			})
		}
	} catch (err) {
		consoleLogger("Invalid Voice Users Request")
	}
	return users

	
}

// Ready Printer
client.once(Events.ClientReady, async (c) => {
	consoleLogger(`${c.user.username} Is Ready`)
	try {
		await registerCommands();
	} catch (error) {
		console.error("Failed to register commands:", error);
	}
});

// Exit Logic
async function shutdown(signal) {
  consoleLogger(`Received ${signal}, shutting down...`);

  try {
    // Close voice connections
    for (const guildId of client.guilds.cache.keys()) {
        getVoiceConnection(guildId)?.destroy();
    }
    // disconnect bot cleanly
    await client.destroy(); 
    } catch (err) {
        console.error('Shutdown error:', err);
    } finally {
        process.exit(0);
    }
}

// Ctrl+C
process.on('SIGINT', () => shutdown('SIGINT'));  
// container/system stop 
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Start Bot Function
// Returns Active Bot Client
async function startBot() {
	// Start Bot
	await client.login(process.env.TOKEN)

	// Wait until Bot is Ready
	await new Promise((resolve) => client.once(Events.ClientReady, resolve))
	initVoicePresence(client.user.id)
	client.getVoiceUsers = getVoiceUsers
	// Return Client
	return client
}

// Log To Console Marked as Bot
function consoleLogger(message) {
	console.info(`[Bot] ${message}`)
}

module.exports = { startBot, getVoiceUsers }
