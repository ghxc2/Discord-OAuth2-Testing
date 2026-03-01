// Imports
require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

// Current Project Imports
const { validateUser, refreshUser, isTokenExpired, getUserNameFromUserID } = require('./users');
const { getCookieUsername, buildCookieUserID, validateCookie } = require('./cookies');
const { getConfigsForOwner, saveConfig } = require('./database/userConfigDatabase')

function setupWeb({ app }) {
    // Setup View Engine
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, './views'));
    app.use(express.urlencoded({ extended: true }));

    // Allows App to use Cookies
    app.use(cookieParser())

    // Home Page
    app.get('/', async (req, res) => {
        res.send("Welcome")
    })

    // Page Directed To From Discord Link
    app.get('/api/auth/discord/redirect', async (req, res) => {
        const { code, error } = req.query;
        let userID = getCookieUsername(req)

        if (error) {
            consoleLogger(`Discord OAuth error: ${error}`)
            redirectError(res)
            return
        }

        try {
            // Existing session flow
            if (userID) {
                if (isTokenExpired(userID)) {
                    await refreshUser(userID)
                }
            } else {
                // First login flow
                if (!code) {
                    consoleLogger("No code in callback")
                    redirectError(res)
                    return
                }

                userID = await validateUser(code)
                if (!userID) {
                    redirectError(res)
                    return
                }
            }

            buildCookieUserID(res, userID, 7)
            res.send(`Hello, ${getUserNameFromUserID(userID)}`)
        } catch (e) {
            console.error("OAuth callback failed:", e.message)
            redirectError(res)
        }
    });

    // Voice Related
    app.get('/voice', async (req, res) => {
        try {
            const userID = await validateCookie(req, res)
            const username = getUserNameFromUserID(userID)
            res.render('voice', { 
                username,
                users: Object.values(app.locals.users),
            })
        } catch (err) {
            return;
        }
        
    })

    app.post('/voice/submit', (req, res) => {
    const channel = req.body.channel; // user-entered string
    res.send(`You entered: ${channel}`);
    });

    // Error Page
    app.get('/error', async (req, res) => {
        res.send(`Please Login Using this <a href='https://discord.com/oauth2/authorize?client_id=${process.env.WEB_CLIENT_ID}&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A1500%2Fapi%2Fauth%2Fdiscord%2Fredirect&scope=identify+guilds+connections+email+guilds.join+gdm.join'>link</a>`)
    })
    
    // Static Files
    app.use('/static', express.static(path.join(__dirname, 'public')));
    
    app.get('/settings', async (req, res) => {
        try {
            const ownerUserId = await validateCookie(req, res)
            const username = getUserNameFromUserID(ownerUserId)
            const users = await app.locals.botClient.getVoiceUsers(ownerUserId)
            const configs = getConfigsForOwner(ownerUserId)
            const configMap = Object.fromEntries(
                configs.map((cfg) => [cfg.target_user_id, cfg])
            )
            const userMap = Object.fromEntries(
                users.map((u) => [u.userId, u])
            )

            res.render('settings', { 
                username,
                users,
                configs,
                configMap,
                userMap,
            })
        } catch (err) {
            return;
        }
    })

    app.post('/settings/config/:targetUserId', async (req, res) => {
        try {
            const ownerUserId = await validateCookie(req, res)
            const targetUserId = req.params.targetUserId
            const nickname = (req.body.nickname ?? '').trim()

            if (!targetUserId) {
                return res.status(400).send('Missing target user ID');
            }

            saveConfig({
                ownerUserId,
                targetUserId,
                nickname: nickname || null,
                avatarPath: null,
            })

            return res.redirect('/settings')
        } catch (err) {
            return;
        }
    })
}

// Easy Function to Redirect to Error Page
function redirectError(res) {
    res.redirect("/error")
}

// Subscribe To Voice Listener Event using a passed function
function voiceListener({ client, handler }) {
    client.on('voiceActivity', (evt) => handler(evt))
}

// /voice Page Event Logic
function setupVoiceEvent({ app, client }) {
    // Create Set for VoiceStreams
    app.locals.voiceStreams = new Set()

    // /voice/events setup
    app.get('/voice/events', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.()

        // Add The Current Session to Voice Stream
        app.locals.voiceStreams.add(res);

        // Remove Session when Closed
        req.on('close', () => app.locals.voiceStreams.delete(res));
    })
    const handler = (evt) => {
        const u = ensureUser({ evt, app });

        // Event Type Handling
        switch (evt.type) {
            case 'start':
                u.speaking = true;
                break;
            case 'end':
                u.speaking = false;
                break;
            case 'mute':
                u.mute = true;
                break;
            case 'unmute':
                u.mute = false;
                break;
            case 'deaf':
                u.deaf = true;
                break;
            case 'undeaf':
                u.deaf = false;
                break;
            default:
                // Here just incase
                break;
        }

        // Update Locals with user
        app.locals.users[u.userId] = u

        // Send User Info to Browser
        const users = app.locals.users
        const payload = `data: ${JSON.stringify({ type: 'state', users: users })}\n\n`;
        for (const stream of app.locals.voiceStreams) stream.write(payload);
    }

    voiceListener({ client, handler })
}

function ensureUser({ app, evt }) {
    const users = app.locals.users;
    if (!users[evt.userId]) {
        users[evt.userId] = {
            userId: evt.userId,
            username: evt.username,
            speaking: false,
            mute: false,
            deaf: false,
        }
    }
    return users[evt.userId]
}

// App Start Logic
function startWeb({ client }) {

    // App Variables
    const port = process.env.PORT || 1500;
    const app = express();
    app.locals.botClient = client
    app.locals.users = {}
    setupWeb({ app })
    setupVoiceEvent({ app, client })

    app.listen(port, () => { consoleLogger(`Running on ${port}`) })
}

// Log To Console Marked as Web
function consoleLogger(message) {
	console.info(`[Web] ${message}`)
}

module.exports = { startWeb }
