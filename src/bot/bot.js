// Imports
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getVoiceConnection, EndBehaviorType } = require('@discordjs/voice');
// Discord Many Imports
const {
	Client,
	GatewayIntentBits,
	Collection,
	Events,
	MessageFlags,
	REST,
	Routes,
} = require("discord.js")
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
		console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
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
	console.log(`Registered ${commands.length} global command(s).`);
}

// Voice Listener
client.on('voiceActivity', (evt) => {
    console.log(`[voice] ${evt.userID} ${evt.type} in ${evt.channelId}`);
});

// Ready Printer
client.once(Events.ClientReady, async (c) => {
	console.log(`${c.user.username} Is Ready`)
	try {
		await registerCommands();
	} catch (error) {
		console.error("Failed to register commands:", error);
	}
});

// Exit Logic
async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);

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



client.login(process.env.TOKEN)
