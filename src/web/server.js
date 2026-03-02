// Imports
require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const session = require('express-session')
const helmet = require('helmet')
const path = require('path');
const fs = require('fs')
const crypto = require('crypto')
const sharp = require('sharp')

// Current Project Imports
const { validateUser, refreshUser, isTokenExpired, getUserNameFromUserID } = require('./users');
const { getCookieUsername, buildCookieUserID, validateCookie } = require('./cookies');
const { getConfigsForOwner, saveAvatarPath, getAvatarPath } = require('./database/userConfigDatabase')
const { getUserById, getUserByDisplayKey, rotateDisplayKey } = require('./database/userDatabase')
const { createSqliteSessionStore } = require('./database/sessionStore')
const {
    handleUpload,
    handleEditUpload,
    getAllAvatarsForUser,
    deleteAvatarDirectory,
    deleteAvatarTypeFile,
    createAvatarDirectory,
    getAvatarOrDefault,
    generateDefaultAvatarsForUser,
} = require('./avatars/avatars')
const SAFE_PARAM_RE = /^[A-Za-z0-9_-]{1,64}$/
const SAFE_FILE_RE = /^[A-Za-z0-9_-]{1,128}\.(png|jpe?g|gif)$/i
const ALLOWED_AVATAR_TYPES = new Set(['avatar', 'speaking', 'muted', 'deafened'])
const uploadRoot = path.join(__dirname, 'user-data', 'uploads')

async function bufferToDataUrl(buffer) {
    if (!buffer) return null
    const metadata = await sharp(buffer, { animated: true }).metadata().catch(() => null)
    const format = (metadata?.format || 'png').toLowerCase()
    const mimeType = {
        gif: 'image/gif',
        jpeg: 'image/jpeg',
        jpg: 'image/jpeg',
        png: 'image/png',
        webp: 'image/webp',
        avif: 'image/avif',
    }[format] || 'application/octet-stream'
    return `data:${mimeType};base64,${buffer.toString('base64')}`
}

async function avatarStateToDataUrls(avatarState) {
    const safeState = avatarState || {}
    return {
        avatar: await bufferToDataUrl(safeState.avatar),
        speaking: await bufferToDataUrl(safeState.speaking),
        muted: await bufferToDataUrl(safeState.muted),
        deafened: await bufferToDataUrl(safeState.deafened),
        default: await bufferToDataUrl(safeState.default),
    }
}

function pickAvatarForState(avatarSet, state = {}) {
    const safeSet = avatarSet || {}
    const isDeaf = !!state.deaf
    const isMuted = !!state.mute
    const isSpeaking = !!state.speaking

    if (isDeaf) {
        return safeSet.deafened || safeSet.muted || safeSet.speaking || safeSet.avatar || safeSet.default || null
    }
    if (isMuted) {
        return safeSet.muted || safeSet.deafened || safeSet.speaking || safeSet.avatar || safeSet.default || null
    }
    if (isSpeaking) {
        return safeSet.speaking || safeSet.avatar || safeSet.default || null
    }
    return safeSet.avatar || safeSet.default || safeSet.speaking || null
}

function isSafeParam(value) {
    return typeof value === 'string' && SAFE_PARAM_RE.test(value)
}

function getClientKey(req) {
    const trustProxy = !!req.app?.get('trust proxy')
    if (trustProxy) {
        const forwardedFor = req.headers['x-forwarded-for']
        if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
            return forwardedFor.split(',')[0].trim()
        }
    }
    return req.ip || req.socket?.remoteAddress || 'unknown'
}

function createFixedWindowRateLimiter({ windowMs, maxRequests, keyFn }) {
    const buckets = new Map()
    const maxBuckets = 5000
    let lastSweepAt = 0

    function sweepExpired(now) {
        if (now - lastSweepAt < windowMs) return
        lastSweepAt = now
        for (const [bucketKey, bucket] of buckets.entries()) {
            if (!bucket || now >= bucket.resetAt) {
                buckets.delete(bucketKey)
            }
        }
        if (buckets.size <= maxBuckets) return
        const overflow = buckets.size - maxBuckets
        let removed = 0
        for (const [bucketKey] of buckets.entries()) {
            buckets.delete(bucketKey)
            removed += 1
            if (removed >= overflow) break
        }
    }

    return (req, res, next) => {
        const now = Date.now()
        sweepExpired(now)
        const key = keyFn(req)
        const existing = buckets.get(key)

        if (!existing || now >= existing.resetAt) {
            buckets.set(key, { count: 1, resetAt: now + windowMs })
            return next()
        }

        if (existing.count >= maxRequests) {
            const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000))
            res.setHeader('Retry-After', String(retryAfter))
            return res.status(429).send('Too Many Requests')
        }

        existing.count += 1
        return next()
    }
}

function getUploadFilePath({ userId, assetId, fileName }) {
    if (!isSafeParam(userId) || !isSafeParam(assetId) || !SAFE_FILE_RE.test(fileName || '')) {
        return null
    }
    const parsedName = path.parse(fileName).name
    if (!parsedName.startsWith(`${assetId}_`)) {
        return null
    }
    const ownerRoot = path.resolve(uploadRoot, userId)
    const candidatePath = path.resolve(ownerRoot, assetId, fileName)
    if (!candidatePath.startsWith(ownerRoot + path.sep)) {
        return null
    }
    return candidatePath
}

function buildUploadSignature({ sessionSecret, userId, assetId, fileName, exp }) {
    return crypto
        .createHmac('sha256', sessionSecret)
        .update(`${userId}:${assetId}:${fileName}:${exp}`)
        .digest('hex')
}

function hasValidUploadSignature({ sessionSecret, userId, assetId, fileName, exp, sig }) {
    if (!sig || typeof sig !== 'string') return false
    const expected = buildUploadSignature({ sessionSecret, userId, assetId, fileName, exp })
    const expectedBuf = Buffer.from(expected, 'utf8')
    const providedBuf = Buffer.from(sig, 'utf8')
    if (expectedBuf.length !== providedBuf.length) return false
    return crypto.timingSafeEqual(expectedBuf, providedBuf)
}

function parseUploadPathForIds(inputPath) {
    if (!inputPath || typeof inputPath !== 'string') return null
    const parts = path.normalize(inputPath).split(path.sep)
    const uploadsIdx = parts.lastIndexOf('uploads')
    if (uploadsIdx === -1 || parts.length < uploadsIdx + 3) return null
    const userId = parts[uploadsIdx + 1]
    const assetId = parts[uploadsIdx + 2]
    if (!isSafeParam(userId) || !isSafeParam(assetId)) return null
    return { userId, assetId }
}

function buildSignedUploadUrl({ sessionSecret, userId, assetId, fileName, ttlMs = 5 * 60 * 1000 }) {
    const exp = Date.now() + ttlMs
    const sig = buildUploadSignature({ sessionSecret, userId, assetId, fileName, exp })
    return `/public/uploads/${encodeURIComponent(userId)}/${encodeURIComponent(assetId)}/${encodeURIComponent(fileName)}?exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}`
}

function findAssetTypeToFileMap({ userId, assetId }) {
    const result = {}
    const assetDir = path.resolve(uploadRoot, userId, assetId)
    if (!assetDir.startsWith(path.resolve(uploadRoot, userId) + path.sep)) return result
    if (!fs.existsSync(assetDir)) return result

    const files = fs.readdirSync(assetDir, { withFileTypes: true })
    for (const entry of files) {
        if (!entry.isFile()) continue
        const fileName = entry.name
        if (!SAFE_FILE_RE.test(fileName)) continue

        const parsed = path.parse(fileName)
        if (!parsed.name.startsWith(`${assetId}_`)) continue
        const assetType = parsed.name.slice(assetId.length + 1)
        if (!ALLOWED_AVATAR_TYPES.has(assetType)) continue
        result[assetType] = fileName
    }
    return result
}

function withSignedAvatarSet({ users, ownerUserId, sessionSecret }) {
    return (users || []).map((u) => {
        const configuredAvatarPath = getAvatarPath(ownerUserId, u.userId)
        const parsed = parseUploadPathForIds(configuredAvatarPath)
        if (!parsed || parsed.userId !== ownerUserId) return u

        const typeToFile = findAssetTypeToFileMap({
            userId: parsed.userId,
            assetId: parsed.assetId,
        })
        if (!Object.keys(typeToFile).length) return u

        const signedSet = {}
        for (const [assetType, fileName] of Object.entries(typeToFile)) {
            signedSet[assetType] = buildSignedUploadUrl({
                sessionSecret,
                userId: parsed.userId,
                assetId: parsed.assetId,
                fileName,
            })
        }

        const nextAvatarSet = {
            ...(u.avatarSet || {}),
            ...signedSet,
        }
        return {
            ...u,
            avatarSet: nextAvatarSet,
            avatarUrl: pickAvatarForState(nextAvatarSet, u) || u.avatarUrl || null,
        }
    })
}

function setupWeb({ app }) {
    // Setup View Engine
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, './views'));
    app.use(express.urlencoded({ extended: true }));
    app.use(helmet({
        contentSecurityPolicy: {
            useDefaults: true,
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'"],
                imgSrc: ["'self'", "data:", "blob:", "https:"],
                connectSrc: ["'self'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'"],
                frameAncestors: ["'self'"],
                upgradeInsecureRequests: null,
            },
        },
    }))

    // Allows App to use Cookies
    app.use(cookieParser())
    const sessionSecret = process.env.SESSION_SECRET
    if (!sessionSecret) {
        throw new Error('SESSION_SECRET is required')
    }
    app.use(session({
        name: 'sid',
        secret: sessionSecret,
        store: createSqliteSessionStore(session),
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            sameSite: 'lax',
            secure: process.env.NODE_ENV === 'production',
            maxAge: 7 * 24 * 60 * 60 * 1000,
        },
    }))

    const oauthRateLimit = createFixedWindowRateLimiter({
        windowMs: 60 * 1000,
        maxRequests: 30,
        keyFn: (req) => getClientKey(req),
    })
    const publicDisplayRateLimit = createFixedWindowRateLimiter({
        windowMs: 60 * 1000,
        maxRequests: 60,
        keyFn: (req) => getClientKey(req),
    })
    const publicUploadsRateLimit = createFixedWindowRateLimiter({
        windowMs: 60 * 1000,
        maxRequests: 180,
        keyFn: (req) => getClientKey(req),
    })

    // Home Page
    app.get('/', async (req, res) => {
        const oauthState = crypto.randomBytes(24).toString('hex')
        req.session.oauthState = oauthState
        const authUrl = `https://discord.com/oauth2/authorize?client_id=${process.env.WEB_CLIENT_ID}&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A1500%2Fapi%2Fauth%2Fdiscord%2Fredirect&scope=identify+guilds+connections+email+guilds.join+gdm.join&state=${encodeURIComponent(oauthState)}`
        res.send(`Welcome. <a href="${authUrl}">Login with Discord</a>`)
    })

    // Page Directed To From Discord Link
    app.get('/api/auth/discord/redirect', oauthRateLimit, async (req, res) => {
        const { code, error, state } = req.query;
        let userID = getCookieUsername(req)

        if (error) {
            consoleLogger(`Discord OAuth error: ${error}`)
            redirectError(res)
            return
        }

        try {
            const expectedState = req.session?.oauthState
            if (!state || !expectedState || state !== expectedState) {
                consoleLogger("OAuth state mismatch")
                redirectError(res)
                return
            }
            delete req.session.oauthState

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

            await buildCookieUserID(req, userID, 7)
            res.redirect('/voice')
        } catch (e) {
            console.error("OAuth callback failed:", e.message)
            redirectError(res)
        }
    });

    // Voice Related
    async function buildVoiceUsersForOwner(ownerUserId) {
        const voiceUsers = await app.locals.botClient.getVoiceUsers(ownerUserId)
        return await Promise.all(voiceUsers
            .filter((u) => u.userId !== app.locals.botClient.user?.id)
            .map(async (u) => {
                const existing = app.locals.users[u.userId] || {}
                const avatarState = await getAvatarOrDefault(ownerUserId, u.userId, u.avatarUrl || null)
                const avatarSet = await avatarStateToDataUrls(avatarState)
                const state = {
                    speaking: !!existing.speaking,
                    mute: !!existing.mute,
                    deaf: !!existing.deaf,
                }
                return {
                    userId: u.userId,
                    username: u.username,
                    discordAvatarUrl: u.avatarUrl || null,
                    speaking: state.speaking,
                    mute: state.mute,
                    deaf: state.deaf,
                    avatarSet,
                    avatarUrl: pickAvatarForState(avatarSet, state),
                }
            }))
    }
    app.locals.buildVoiceUsersForOwner = buildVoiceUsersForOwner

    app.get('/voice', async (req, res) => {
        try {
            const userID = await validateCookie(req, res)
            const username = getUserNameFromUserID(userID)
            const voiceStatus = await app.locals.botClient.isBotInSameVoiceChannel(userID)
            const users = await buildVoiceUsersForOwner(userID)
            res.render('voice', { 
                username,
                users,
                voiceStatus,
            })
        } catch (err) {
            return;
        }
        
    })

    // Display All Voice Users in Channel with Avatars
    // Only Displays Avatar from Set Matching Current State (Speaking/Muted/Deafened)
    app.get('/voice/display', async (req, res) => {
        try {
            const userID = await validateCookie(req, res)
            const users = await buildVoiceUsersForOwner(userID)
            res.render('viewDisplay', { 
                users,
                voiceEventPath: '/voice/events',
            })
        } catch (err) {
            return;
        }
        
    })

    app.get('/voice/display/:key', publicDisplayRateLimit, async (req, res) => {
        try {
            const key = (req.params.key || '').trim()
            const owner = key ? getUserByDisplayKey(key) : null
            if (!owner?.user_id) {
                return res.status(404).send('Not Found')
            }
            const users = withSignedAvatarSet({
                users: await buildVoiceUsersForOwner(owner.user_id),
                ownerUserId: owner.user_id,
                sessionSecret,
            })
            res.render('viewDisplay', {
                users,
                voiceEventPath: `/voice/events/${encodeURIComponent(key)}`,
            })
        } catch (err) {
            return res.status(500).send('Internal Server Error')
        }
    })

    app.get('/voice/status', async (req, res) => {
        try {
            const userID = await validateCookie(req, res)
            const voiceStatus = await app.locals.botClient.isBotInSameVoiceChannel(userID)
            return res.json({ voiceStatus })
        } catch (err) {
            if (res.headersSent) return
            return res.status(401).json({ error: 'Unauthorized' })
        }
    })

    app.post('/voice/submit', (req, res) => {
    const channel = req.body.channel; // user-entered string
    res.send(`You entered: ${channel}`);
    });

    // Error Page
    app.get('/error', async (req, res) => {
        const oauthState = crypto.randomBytes(24).toString('hex')
        req.session.oauthState = oauthState
        res.send(`Please Login Using this <a href='https://discord.com/oauth2/authorize?client_id=${process.env.WEB_CLIENT_ID}&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A1500%2Fapi%2Fauth%2Fdiscord%2Fredirect&scope=identify+guilds+connections+email+guilds.join+gdm.join&state=${encodeURIComponent(oauthState)}'>link</a>`)
    })
    
    app.get('/uploads/:userId/:assetId/:fileName', async (req, res) => {
        try {
            const ownerUserId = await validateCookie(req, res)
            const { userId, assetId, fileName } = req.params
            if (ownerUserId !== userId) {
                return res.status(403).send('Forbidden')
            }
            const filePath = getUploadFilePath({ userId, assetId, fileName })
            if (!filePath || !fs.existsSync(filePath)) {
                return res.status(404).send('Not Found')
            }
            return res.sendFile(filePath)
        } catch (err) {
            if (res.headersSent) return
            return res.status(401).send('Unauthorized')
        }
    })

    app.get('/public/uploads/:userId/:assetId/:fileName', publicUploadsRateLimit, async (req, res) => {
        const { userId, assetId, fileName } = req.params
        const exp = Number(req.query.exp || 0)
        const sig = String(req.query.sig || '')
        if (!Number.isFinite(exp) || exp <= Date.now()) {
            return res.status(403).send('Expired')
        }
        const filePath = getUploadFilePath({ userId, assetId, fileName })
        if (!filePath || !fs.existsSync(filePath)) {
            return res.status(404).send('Not Found')
        }
        const isValidSig = hasValidUploadSignature({
            sessionSecret,
            userId,
            assetId,
            fileName,
            exp,
            sig,
        })
        if (!isValidSig) {
            return res.status(403).send('Forbidden')
        }
        res.setHeader('Cache-Control', 'private, max-age=60')
        return res.sendFile(filePath)
    })

    // Static Files
    app.use('/static', express.static(path.join(__dirname, 'public')));
    app.locals.settingsStreams = app.locals.settingsStreams || new Map()

    async function buildSettingsData(ownerUserId) {
        const voiceUsers = await app.locals.botClient.getVoiceUsers(ownerUserId)
        const configs = getConfigsForOwner(ownerUserId)
        const targetUserIds = Array.from(new Set([
            ...voiceUsers.map((u) => u.userId),
            ...configs.map((c) => c.target_user_id),
        ]))
        const voiceUserMap = Object.fromEntries(
            voiceUsers.map((u) => [u.userId, u])
        )
        const users = await Promise.all(
            targetUserIds.map(async (targetUserId) => {
                const fromVoice = voiceUserMap[targetUserId]
                if (fromVoice) return fromVoice

                const fetchedUser = await app.locals.botClient.users.fetch(targetUserId).catch(() => null)
                return {
                    userId: targetUserId,
                    username: fetchedUser?.username ?? targetUserId,
                    avatarUrl: fetchedUser?.displayAvatarURL({ extension: 'png', size: 64 }) ?? null,
                }
            })
        )
        const avatarSetEntries = await Promise.all(
            users.map(async (u) => {
                const avatarState = await getAvatarOrDefault(ownerUserId, u.userId, u.avatarUrl || null)
                const avatarSet = await avatarStateToDataUrls(avatarState)
                return [u.userId, avatarSet]
            })
        )
        const avatarSetMap = Object.fromEntries(avatarSetEntries)
        const peopleInCall = voiceUsers.map((u) => {
            const avatarSet = avatarSetMap[u.userId] || null
            const selectedAvatarUrl = pickAvatarForState(avatarSet, {}) || u.avatarUrl || null
            return {
                ...u,
                discordAvatarUrl: u.avatarUrl || null,
                avatarUrl: selectedAvatarUrl,
                selectedAvatarUrl,
                avatarSet,
            }
        })
        const userMap = Object.fromEntries(
            users.map((u) => {
                const avatarSet = avatarSetMap[u.userId] || null
                return [u.userId, {
                    ...u,
                    selectedAvatarUrl: pickAvatarForState(avatarSet, {}) || u.avatarUrl || null,
                    selectedAvatarSet: avatarSet,
                }]
            })
        )

        return {
            voiceUsers,
            peopleInCall,
            users,
            configs,
            userMap,
        }
    }

    function getOrCreateSettingsStreamSet(ownerUserId) {
        if (!app.locals.settingsStreams.has(ownerUserId)) {
            app.locals.settingsStreams.set(ownerUserId, new Set())
        }
        return app.locals.settingsStreams.get(ownerUserId)
    }

    async function pushSettingsUpdate(ownerUserId) {
        const streamSet = app.locals.settingsStreams.get(ownerUserId)
        if (!streamSet || streamSet.size === 0) return

        const { peopleInCall } = await buildSettingsData(ownerUserId)
        const payload = `data: ${JSON.stringify({
            peopleInCall,
        })}\n\n`

        for (const stream of streamSet) {
            stream.write(payload)
        }
    }

    app.locals.pushSettingsUpdate = pushSettingsUpdate
    app.locals.pushSettingsUpdateAll = async () => {
        const ownerUserIds = [...app.locals.settingsStreams.keys()]
        for (const ownerUserId of ownerUserIds) {
            await pushSettingsUpdate(ownerUserId)
        }
    }
    
    // Settings Page
    app.get('/settings', async (req, res) => {
        try {
            const ownerUserId = await validateCookie(req, res)
            const username = getUserNameFromUserID(ownerUserId)
            const displayKey = getUserById(ownerUserId)?.display_key || null
            const displayUrl = displayKey ? `${req.protocol}://${req.get('host')}/voice/display/${displayKey}` : null
            const { peopleInCall, users, configs, userMap } = await buildSettingsData(ownerUserId)

            res.render('settings', { 
                username,
                displayKey,
                displayUrl,
                peopleInCall,
                users,
                configs,
                userMap,
            })
        } catch (err) {
            return;
        }
    })

    // Settings SSE events
    app.get('/settings/events', async (req, res) => {
        try {
            const ownerUserId = await validateCookie(req, res)

            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders?.()

            const streamSet = getOrCreateSettingsStreamSet(ownerUserId)
            streamSet.add(res)

            await pushSettingsUpdate(ownerUserId)

            req.on('close', () => {
                const currentSet = app.locals.settingsStreams.get(ownerUserId)
                if (!currentSet) return
                currentSet.delete(res)
                if (currentSet.size === 0) {
                    app.locals.settingsStreams.delete(ownerUserId)
                }
            })
        } catch (err) {
            if (res.headersSent) return
            return res.status(401).end()
        }
    })

    // Settings Edit Page
    app.get('/settings/:targetUserId/edit', async (req, res) => {
        try {
            const ownerUserId = await validateCookie(req, res)
            const targetUserId = req.params.targetUserId
            if (!targetUserId) {
                return res.redirect('/settings');
            }

            const targetUser = await app.locals.botClient.users.fetch(targetUserId).catch(() => null)
            const targetAvatarUrl = targetUser?.displayAvatarURL({ extension: 'png', size: 256 }) ?? null
            const currentAvatarState = await getAvatarOrDefault(ownerUserId, targetUserId, targetAvatarUrl)
            const currentAvatar = await avatarStateToDataUrls(currentAvatarState)
            const defaultAvatarSet = targetAvatarUrl
                ? await avatarStateToDataUrls(await generateDefaultAvatarsForUser(targetAvatarUrl))
                : await avatarStateToDataUrls(null)
            const userAllAvatars = getAllAvatarsForUser(ownerUserId)

            res.render('settingsConfigEdit', {
                username: getUserNameFromUserID(ownerUserId),
                ownerUserId,
                targetUserId,
                targetUser,
                currentAvatar,
                defaultAvatarSet,
                userAllAvatars,
            })
        } catch (err) {
            return;
        }
    })

    app.post('/settings/:targetUserId/avatar-select', async (req, res) => {
        try {
            const ownerUserId = await validateCookie(req, res)
            const targetUserId = req.params.targetUserId
            const selectedAssetId = (req.body.assetId || '').trim()

            if (!targetUserId) {
                return res.redirect('/settings')
            }

            let avatarPath = null
            if (selectedAssetId && selectedAssetId !== 'default') {
                if (!isSafeParam(selectedAssetId)) {
                    return res.status(400).send('Invalid avatar set')
                }
                const candidatePath = path.join(__dirname, 'user-data', 'uploads', ownerUserId, selectedAssetId)
                if (candidatePath.startsWith(path.join(__dirname, 'user-data', 'uploads', ownerUserId)) && fs.existsSync(candidatePath)) {
                    avatarPath = candidatePath
                }
            }

            saveAvatarPath({
                ownerUserId,
                targetUserId,
                avatarPath,
            })
            app.locals.pushVoiceUpdate?.(ownerUserId).catch(() => {})
            app.locals.pushKeyedVoiceUpdateAll?.().catch(() => {})
            app.locals.pushSettingsUpdate?.(ownerUserId).catch(() => {})

            return res.redirect(`/settings/${targetUserId}/edit`)
        } catch (err) {
            return res.status(500).send('Internal Server Error')
        }
    })

    app.post('/settings/display-key/rotate', async (req, res) => {
        try {
            const ownerUserId = await validateCookie(req, res)
            rotateDisplayKey(ownerUserId)
            return res.redirect('/settings')
        } catch (err) {
            return res.status(500).send('Internal Server Error')
        }
    })

    // Avatars
    app.get('/avatars', async (req, res) => {
        try {
            const ownerUserId = await validateCookie(req, res)
            const username = getUserNameFromUserID(ownerUserId)
            const avatars = getAllAvatarsForUser(ownerUserId)

            res.render('avatars', {
                username,
                avatars,
                ownerUserId
            })
        } catch (err) {
            return;
        }
    })

    // Delete Avatar
    app.post('/avatars/:userId/:assetId/delete', async (req, res) => {
        try {
            const ownerUserId = await validateCookie(req, res)
            if (ownerUserId !== req.params.userId) {
                return res.status(403).send('Forbidden');
            }
            const { userId, assetId } = req.params
            if (!isSafeParam(userId) || !isSafeParam(assetId)) {
                return res.status(400).send('Invalid path');
            }
            deleteAvatarDirectory(userId, assetId)
            app.locals.pushVoiceUpdate?.(ownerUserId).catch(() => {})
            app.locals.pushKeyedVoiceUpdateAll?.().catch(() => {})
            app.locals.pushSettingsUpdate?.(ownerUserId).catch(() => {})
            return res.redirect('/avatars')
        } catch (err) {
            return res.status(500).send('Internal Server Error');
        }
    })

    // Avatar Editor Upload
    app.post('/avatars/:userId/:assetId/edit', async (req, res) => {
        try {
            const ownerUserId = await validateCookie(req, res)
            if (ownerUserId !== req.params.userId) {
                return res.status(403).send('Forbidden');
            }
            if (!isSafeParam(req.params.userId) || !isSafeParam(req.params.assetId)) {
                return res.status(400).send('Invalid path');
            }

            return handleEditUpload(req, res);
        } catch (err) {
            return;
        }
    });

    // Delete Avatar Type
    app.post('/avatars/:userId/:assetId/:assetType/delete', async (req, res) => {
        try {
            const ownerUserId = await validateCookie(req, res)
            if (ownerUserId !== req.params.userId) {
                return res.status(403).send('Forbidden');
            }
            const { userId, assetId, assetType } = req.params
            if (!isSafeParam(userId) || !isSafeParam(assetId) || !ALLOWED_AVATAR_TYPES.has(assetType)) {
                return res.status(400).send('Invalid path');
            }
            deleteAvatarTypeFile(userId, assetId, assetType)
            app.locals.pushVoiceUpdate?.(ownerUserId).catch(() => {})
            app.locals.pushKeyedVoiceUpdateAll?.().catch(() => {})
            app.locals.pushSettingsUpdate?.(ownerUserId).catch(() => {})
            return res.redirect(`/avatars/${userId}/${assetId}/edit`)
        } catch (err) {
            return res.status(500).send('Internal Server Error');
        }
    })

    // Avatars Upload
    app.post('/avatars/:userId/:assetId/:assetType', async (req, res) => {
        try {
            const ownerUserId = await validateCookie(req, res)
            if (ownerUserId !== req.params.userId) {
                return res.status(403).send('Forbidden');
            }
            if (!isSafeParam(req.params.userId) || !isSafeParam(req.params.assetId) || !ALLOWED_AVATAR_TYPES.has(req.params.assetType)) {
                return res.status(400).send('Invalid path');
            }

            return handleUpload(req, res);
        } catch (err) {
            return;
        }
    });

    // Create Avatar Directory
    app.post('/avatars/:userId/:assetId/', async (req, res) => { 
        try {
            const ownerUserId = await validateCookie(req, res)
            if (ownerUserId !== req.params.userId) {
                return res.status(403).send('Forbidden');
            }

            const { userId, assetId } = req.params
            if (!isSafeParam(userId) || !isSafeParam(assetId)) {
                return res.status(400).send('Invalid path');
            }
            createAvatarDirectory(userId, assetId)
            return res.redirect(`/avatars/${userId}/${assetId}/edit`)
        } catch (err) {
            return res.status(500).send('Internal Server Error');
        }
    })

    // Avatars Editor
    app.get('/avatars/:userId/:assetId/edit', async (req, res) => {
        try {
            const ownerUserId = await validateCookie(req, res)
            if (ownerUserId !== req.params.userId) {
                return res.status(403).send('Forbidden');
            }

            const { assetId } = req.params
            if (!isSafeParam(req.params.userId) || !isSafeParam(assetId)) {
                return res.status(400).send('Invalid path');
            }
            const avatars = getAllAvatarsForUser(ownerUserId)
            const asset = avatars.find((a) => a.assetId === assetId)
            const assetsByType = Object.fromEntries(
                (asset?.items || []).map((item) => [item.assetType, item])
            )

            res.render('avatarEdit', {
                username: getUserNameFromUserID(ownerUserId),
                ownerUserId,
                assetId,
                assetsByType,
            })
        } catch (err) {
            return;
        }
    });

    // Safety redirect for stale clients submitting bad upload URL.
    app.get('/avatars/:userId/:assetId/undefined', async (req, res) => {
        try {
            const ownerUserId = await validateCookie(req, res)
            if (ownerUserId !== req.params.userId) {
                return res.status(403).send('Forbidden');
            }
            return res.redirect(`/avatars/${req.params.userId}/${req.params.assetId}/edit`)
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
    // Create owner-scoped sets for VoiceStreams
    app.locals.voiceStreamsByOwner = app.locals.voiceStreamsByOwner || new Map()

    function getOrCreateVoiceStreamSet(ownerUserId) {
        if (!app.locals.voiceStreamsByOwner.has(ownerUserId)) {
            app.locals.voiceStreamsByOwner.set(ownerUserId, new Set())
        }
        return app.locals.voiceStreamsByOwner.get(ownerUserId)
    }

    app.locals.keyedVoiceStreamsByDisplayKey = app.locals.keyedVoiceStreamsByDisplayKey || new Map()
    app.locals.voiceSseConnectionsByIp = app.locals.voiceSseConnectionsByIp || new Map()
    app.locals.keyedVoiceSseConnectionsByIp = app.locals.keyedVoiceSseConnectionsByIp || new Map()
    function getOrCreateKeyedVoiceStreamSet(displayKey) {
        if (!app.locals.keyedVoiceStreamsByDisplayKey.has(displayKey)) {
            app.locals.keyedVoiceStreamsByDisplayKey.set(displayKey, new Set())
        }
        return app.locals.keyedVoiceStreamsByDisplayKey.get(displayKey)
    }

    function claimSseConnection(map, key, maxPerKey) {
        const current = map.get(key) || 0
        if (current >= maxPerKey) return false
        map.set(key, current + 1)
        return true
    }

    function releaseSseConnection(map, key) {
        const current = map.get(key) || 0
        if (current <= 1) {
            map.delete(key)
            return
        }
        map.set(key, current - 1)
    }

    const authEventsRateLimit = createFixedWindowRateLimiter({
        windowMs: 60 * 1000,
        maxRequests: 120,
        keyFn: (req) => getClientKey(req),
    })
    const keyedEventsRateLimit = createFixedWindowRateLimiter({
        windowMs: 60 * 1000,
        maxRequests: 60,
        keyFn: (req) => getClientKey(req),
    })

    async function pushVoiceUpdate(ownerUserId) {
        const streamSet = app.locals.voiceStreamsByOwner.get(ownerUserId)
        if (!streamSet || streamSet.size === 0) return

        const users = await app.locals.buildVoiceUsersForOwner?.(ownerUserId).catch(() => [])
        const usersById = Object.fromEntries((users || []).map((u) => [u.userId, u]))
        const payload = `data: ${JSON.stringify({ type: 'state', users: usersById })}\n\n`

        for (const stream of streamSet) {
            stream.write(payload)
        }
    }

    app.locals.pushVoiceUpdate = pushVoiceUpdate
    app.locals.pushVoiceUpdateAll = async () => {
        const ownerUserIds = [...app.locals.voiceStreamsByOwner.keys()]
        for (const ownerUserId of ownerUserIds) {
            await pushVoiceUpdate(ownerUserId)
        }
    }

    async function pushKeyedVoiceUpdate(displayKey, ownerUserId) {
        const streamSet = app.locals.keyedVoiceStreamsByDisplayKey.get(displayKey)
        if (!streamSet || streamSet.size === 0) return

        const users = await app.locals.buildVoiceUsersForOwner?.(ownerUserId).catch(() => [])
        const signedUsers = withSignedAvatarSet({
            users,
            ownerUserId,
            sessionSecret: process.env.SESSION_SECRET,
        })
        const usersById = Object.fromEntries((signedUsers || []).map((u) => [u.userId, u]))
        const payload = `data: ${JSON.stringify({ type: 'state', users: usersById })}\n\n`

        for (const stream of streamSet) {
            stream.write(payload)
        }
    }

    app.locals.pushKeyedVoiceUpdateAll = async () => {
        const displayKeys = [...app.locals.keyedVoiceStreamsByDisplayKey.keys()]
        for (const displayKey of displayKeys) {
            const owner = getUserByDisplayKey(displayKey)
            if (!owner?.user_id) continue
            await pushKeyedVoiceUpdate(displayKey, owner.user_id)
        }
    }

    // /voice/events setup
    app.get('/voice/events', authEventsRateLimit, async (req, res) => {
        try {
            const clientKey = getClientKey(req)
            if (!claimSseConnection(app.locals.voiceSseConnectionsByIp, clientKey, 5)) {
                return res.status(429).send('Too Many Open Connections')
            }
            const ownerUserId = await validateCookie(req, res)
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders?.()

            const streamSet = getOrCreateVoiceStreamSet(ownerUserId)
            streamSet.add(res);

            await pushVoiceUpdate(ownerUserId)

            req.on('close', () => {
                const currentSet = app.locals.voiceStreamsByOwner.get(ownerUserId)
                if (currentSet) {
                    currentSet.delete(res)
                }
                if (currentSet && currentSet.size === 0) {
                    app.locals.voiceStreamsByOwner.delete(ownerUserId)
                }
                releaseSseConnection(app.locals.voiceSseConnectionsByIp, clientKey)
            });
        } catch (err) {
            releaseSseConnection(app.locals.voiceSseConnectionsByIp, getClientKey(req))
            if (res.headersSent) return
            return res.status(401).end()
        }
    })

    app.get('/voice/events/:key', keyedEventsRateLimit, async (req, res) => {
        try {
            const clientKey = getClientKey(req)
            if (!claimSseConnection(app.locals.keyedVoiceSseConnectionsByIp, clientKey, 3)) {
                return res.status(429).send('Too Many Open Connections')
            }
            const key = (req.params.key || '').trim()
            const owner = key ? getUserByDisplayKey(key) : null
            const ownerUserId = owner?.user_id || null
            if (!ownerUserId) {
                releaseSseConnection(app.locals.keyedVoiceSseConnectionsByIp, clientKey)
                return res.status(404).end()
            }

            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders?.()

            const streamSet = getOrCreateKeyedVoiceStreamSet(key)
            streamSet.add(res);

            await pushKeyedVoiceUpdate(key, ownerUserId)

            req.on('close', () => {
                const currentSet = app.locals.keyedVoiceStreamsByDisplayKey.get(key)
                if (currentSet) {
                    currentSet.delete(res)
                }
                if (currentSet && currentSet.size === 0) {
                    app.locals.keyedVoiceStreamsByDisplayKey.delete(key)
                }
                releaseSseConnection(app.locals.keyedVoiceSseConnectionsByIp, clientKey)
            });
        } catch (err) {
            releaseSseConnection(app.locals.keyedVoiceSseConnectionsByIp, getClientKey(req))
            return res.status(500).end()
        }
    })
    
    const handler = (evt) => {
        if (evt.userId === app.locals.botClient.user?.id) return;
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

        // Send owner-scoped voice payloads to browser
        app.locals.pushVoiceUpdateAll?.().catch(() => {});
        app.locals.pushKeyedVoiceUpdateAll?.().catch(() => {});
        app.locals.pushSettingsUpdateAll?.().catch(() => {});
    }

    voiceListener({ client, handler })

    // Keep /settings live list in sync for join/leave/move events too.
    client.on('voiceStateUpdate', () => {
        app.locals.pushVoiceUpdateAll?.().catch(() => {});
        app.locals.pushKeyedVoiceUpdateAll?.().catch(() => {});
        app.locals.pushSettingsUpdateAll?.().catch(() => {});
    });
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

function resolveTrustProxySetting(rawValue) {
    if (rawValue == null) return false
    const value = String(rawValue).trim().toLowerCase()
    if (!value || value === 'false' || value === '0' || value === 'off' || value === 'no') {
        return false
    }
    if (value === 'true' || value === '1' || value === 'on' || value === 'yes') {
        return true
    }
    if (/^\d+$/.test(value)) {
        return Number(value)
    }
    return value
}

// App Start Logic
function startWeb({ client }) {

    // App Variables
    const port = process.env.PORT || 1500;
    const app = express();
    app.set('trust proxy', resolveTrustProxySetting(process.env.TRUST_PROXY))
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
