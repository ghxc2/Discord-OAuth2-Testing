// Stores active voice presence by userId -> { guildId, channelId }
const voicePresence = new Map();
// Inverse index by "guildId:channelId" -> Set<userId>
const channelUsers = new Map();

// Bot Id
let botId = null;

function getChannelKey(guildId, channelId) {
    return `${guildId}:${channelId}`;
}

// Init voicePresence
// Pass Bot's Id to blacklist it from being added into voicePresence
function initVoicePresence(id) {
    botId = id;
}

function addUserToVoicePresence(userId, guildId, channelId) {
    if (userId === botId) return;
    if (!guildId || !channelId) return;

    // Remove stale index entry if user already tracked in another channel.
    const existing = voicePresence.get(userId);
    if (existing) {
        const oldKey = getChannelKey(existing.guildId, existing.channelId);
        const oldSet = channelUsers.get(oldKey);
        if (oldSet) {
            oldSet.delete(userId);
            if (oldSet.size === 0) channelUsers.delete(oldKey);
        }
    }

    voicePresence.set(userId, { guildId, channelId });

    const key = getChannelKey(guildId, channelId);
    if (!channelUsers.has(key)) {
        channelUsers.set(key, new Set());
    }
    channelUsers.get(key).add(userId);
}

function removeUserFromVoicePresence(userId) {
    const existing = voicePresence.get(userId);
    if (!existing) return;

    voicePresence.delete(userId);

    const key = getChannelKey(existing.guildId, existing.channelId);
    const set = channelUsers.get(key);
    if (!set) return;

    set.delete(userId);
    if (set.size === 0) channelUsers.delete(key);
}

function getUserVoiceGuild(userId) {
    return voicePresence.get(userId)?.guildId ?? null;
}

function getUserVoiceChannel(userId) {
    return voicePresence.get(userId)?.channelId ?? null;
}

function getUsersForChannel(guildId, channelId) {
    const key = getChannelKey(guildId, channelId);
    return [...(channelUsers.get(key) ?? new Set())];
}

module.exports = {
    initVoicePresence,
    addUserToVoicePresence,
    removeUserFromVoicePresence,
    getUserVoiceGuild,
    getUserVoiceChannel,
    getUsersForChannel,
};
