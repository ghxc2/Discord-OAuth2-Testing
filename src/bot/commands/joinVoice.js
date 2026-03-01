const { SlashCommandBuilder } = require('discord.js')
const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');

const { addUserToVoicePresence, removeUserFromVoicePresence, getUsersForChannel } = require("../voicePresence")

function emitVoiceActivity({ client, interaction, type, userId, guildId, channelId }) {
    const member = interaction.guild.members.cache.get(userId)
    client.emit('voiceActivity', {
        type,
        guildId,
        channelId,
        userId,
        username: member?.user?.username ?? userId,
        at: Date.now(),
    });
}

// Module To Run
module.exports = {
    // Basic Command Info
    data: new SlashCommandBuilder()
        .setName('join')
        .setDescription('Joins Users Current Voice Channel'),
    
    // Actual Command Logic
    async execute(interaction) {
        
        // Destroy Any Existing Voice Connection
        // Assure Removing Users From Memory that May have been in channel
        const existing = getVoiceConnection(interaction.guild.id);
        if (existing) {
            const oldGuildId = existing.joinConfig?.guildId;
            const oldChannelId = existing.joinConfig?.channelId;
            try {
                if (oldGuildId && oldChannelId) {
                    const userIds = getUsersForChannel(oldGuildId, oldChannelId);
                    for (const userId of userIds) {
                        removeUserFromVoicePresence(userId);
                    }
                }
            } finally {
                existing.destroy(); // leave current channel
            }
        }

        // Get User and VC they're in
        const member = await interaction.guild.members.fetch(interaction.user);
        const vc = member.voice.channel;

        // If They Aren't, reply and finish
        if (!vc) {
            await interaction.reply(`${member.user.tag} is not in a voice channel.`);
            return;
        } 

        // Get Client
        const client = interaction.client

        // Otherwise, join their reply and join the channel
        await interaction.reply(`${member.user.tag} is in: ${vc.name}`);
        const connection = joinVoiceChannel({
            channelId: vc.id,
            guildId: interaction.guildId,
            adapterCreator: interaction.guild.voiceAdapterCreator,
            selfDeaf: false
        })

        for (const [memberId] of vc.members ) {
            addUserToVoicePresence(memberId, interaction.guildId, vc.id)
        }

        // Voice Event Logic

        // On Green Circle Start
        connection.receiver.speaking.on('start', (userId) => {
            emitVoiceActivity({
                client,
                interaction,
                type: 'start',
                guildId: connection.joinConfig.guildId,
                channelId: connection.joinConfig.channelId,
                userId,
            })
        });
        
        // On Green Circle Ending
        connection.receiver.speaking.on('end', (userId) => {
            emitVoiceActivity({
                client,
                interaction,
                type: 'end',
                guildId: connection.joinConfig.guildId,
                channelId: connection.joinConfig.channelId,
                userId,
            })
        });
    }
}
