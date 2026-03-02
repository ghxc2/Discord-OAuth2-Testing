// Imports
const fs = require('fs')
const path = require('path');
const multer = require('multer');
const sharp = require('sharp')

// Local Imports
const { getAvatarPath } = require('../database/userConfigDatabase')

// Variables
const uploadRoot = path.join(__dirname, '..', 'user-data', 'uploads')
const muteIconPath = path.join(__dirname, 'icons', 'mute.png')
const deafIconPath = path.join(__dirname, 'icons', 'deaf.png')
const SAFE_SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}$/
const ALLOWED_ASSET_TYPES = new Set(['avatar', 'speaking', 'muted', 'deafened'])

// File Structure
// - user-data
// -- uploads
// --- userId
// ---- avatar1
// ----- avatars
// ---- avatar2
// ----- avatars
// ---- etc.

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            try {
                const dir = generateAvatarPath(req.userId, req.assetId)
                fs.mkdirSync(dir, { recursive: true })
                cb(null, dir)
            } catch (err) {
                cb(err)
            }
        },
        filename: (req, file, cb) => {
            try {
                const ext = path.extname(file.originalname).toLowerCase()
                const safeExt = ['.png', '.jpg', '.jpeg', '.gif'].includes(ext) ? ext : '.bin';
                const typeFromField = {
                    avatars: req.assetType,
                    avatarFile: 'avatar',
                    speakingFile: 'speaking',
                    mutedFile: 'muted',
                    deafenedFile: 'deafened',
                }[file.fieldname] || req.assetType || 'avatar'
                if (!ALLOWED_ASSET_TYPES.has(typeFromField)) {
                    throw new Error('Invalid asset type')
                }
                const dir = generateAvatarPath(req.userId, req.assetId)
                deleteExistingTypeFile(dir, req.assetId, typeFromField)
                cb(null, `${req.assetId}_${typeFromField}${safeExt}`)
            } catch (err) {
                cb(err)
            }
        },
    }),
    limits: { fileSize: 2 * 1024 * 1024}, // 2MB for now
    fileFilter: (req, file, cb) => {
        const ok = ['image/png', 'image/jpeg', 'image/gif'].includes(file.mimetype)
        cb(ok ? null : new Error('Invalid File Type'), ok)
    }
})

function generateAvatarPath(userId, assetId) {
    if (!SAFE_SEGMENT_RE.test(userId) || !SAFE_SEGMENT_RE.test(assetId)) {
        throw new Error('Invalid path segment')
    }
    const userRoot = path.resolve(uploadRoot, userId)
    const dir = path.resolve(userRoot, assetId)
    if (!(dir === userRoot || dir.startsWith(userRoot + path.sep))) {
        throw new Error('Invalid path')
    }
    return dir
}

function deleteExistingTypeFile(dir, assetId, assetType) {
    if (!fs.existsSync(dir)) return
    const targetBaseName = `${assetId}_${assetType}`
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
        if (!entry.isFile()) continue
        const parsed = path.parse(entry.name)
        if (parsed.name === targetBaseName) {
            fs.rmSync(path.join(dir, entry.name), { force: true })
        }
    }
}

function handleUpload(req, res) {
    const { userId, assetId, assetType } = req.params
    if (!SAFE_SEGMENT_RE.test(userId) || !SAFE_SEGMENT_RE.test(assetId) || !ALLOWED_ASSET_TYPES.has(assetType)) {
        return res.status(400).send('Invalid upload path')
    }
    req.userId = userId
    req.assetId = assetId
    req.assetType = assetType
    upload.single('avatars')(req, res, (err) => {
        if (err) {
            return res.status(400).send(err.message)
        } else {
            notifyAvatarChanged(req, userId)
            return res.redirect(req.get('referer'))
        }
    })
}

function handleEditUpload(req, res) {
    const { userId, assetId } = req.params
    if (!SAFE_SEGMENT_RE.test(userId) || !SAFE_SEGMENT_RE.test(assetId)) {
        return res.status(400).send('Invalid upload path')
    }
    req.userId = userId
    req.assetId = assetId

    upload.fields([
        { name: 'avatarFile', maxCount: 1 },
        { name: 'speakingFile', maxCount: 1 },
        { name: 'mutedFile', maxCount: 1 },
        { name: 'deafenedFile', maxCount: 1 },
    ])(req, res, (err) => {
        if (err) {
            return res.status(400).send(err.message)
        }
        notifyAvatarChanged(req, userId)
        return res.redirect(`/avatars/${userId}/${assetId}/edit`)
    })
}

function notifyAvatarChanged(req, ownerUserId) {
    req.app?.locals?.pushVoiceUpdate?.(ownerUserId).catch(() => {})
    req.app?.locals?.pushKeyedVoiceUpdateAll?.().catch(() => {})
    req.app?.locals?.pushSettingsUpdate?.(ownerUserId).catch(() => {})
}

function getAllAvatarsForUser(userId) {
    const userDir = path.join(uploadRoot, userId)
    if (!fs.existsSync(userDir)) return []
    const assetDirs = fs.readdirSync(userDir, { withFileTypes: true })
    const avatars = []
    for (const entry of assetDirs) {
        if (!entry.isDirectory()) continue

        const assetId = entry.name
        const assetDirPath = path.join(userDir, assetId)
        const files = fs.readdirSync(assetDirPath, { withFileTypes: true })
        const items = []

        for (const fileEntry of files) {
            if (!fileEntry.isFile()) continue

            const fileName = fileEntry.name
            const parsed = path.parse(fileName)
            const parts = parsed.name.split('_')
            const assetType = parts.length > 1 ? parts.slice(1).join('_') : 'unknown'

            items.push({
                fileName,
                assetType,
                fullPath: path.join(assetDirPath, fileName),
            })
        }

        avatars.push({
            assetId,
            dirPath: assetDirPath,
            items,
        })
    }
    return avatars
}

function getAvatar(ownerUserId, assetId) {
    const dir = generateAvatarPath(ownerUserId, assetId)
    if (!fs.existsSync(dir)) return []
    const files = fs.readdirSync(dir, { withFileTypes: true })
    const items = []

    for (const fileEntry of files) {
        if (!fileEntry.isFile()) continue

        const fileName = fileEntry.name
        const parsed = path.parse(fileName)
        const parts = parsed.name.split('_')
        const assetType = parts.length > 1 ? parts.slice(1).join('_') : 'unknown'

        items.push({
            fileName,
            assetType,
            fullPath: path.join(dir, fileName),
        })
    }
    return items
}

function deleteAvatarDirectory(userId, assetId) {
    const dir = generateAvatarPath(userId, assetId)
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true })
    }
}

function deleteAvatarTypeFile(userId, assetId, assetType) {
    if (!ALLOWED_ASSET_TYPES.has(assetType)) {
        throw new Error('Invalid asset type')
    }
    const dir = generateAvatarPath(userId, assetId)
    deleteExistingTypeFile(dir, assetId, assetType)
}

function createAvatarDirectory(userId, assetId) {
    const dir = generateAvatarPath(userId, assetId)
    fs.mkdirSync(dir, { recursive: true })
    return dir
}

function createEmptyAvatarState() {
    return {
        avatar: null,
        speaking: null,
        muted: null,
        deafened: null,
        default: null,
    }
}

async function buildAvatarStateFromItems(items) {
    const avatarState = createEmptyAvatarState()
    const knownTypes = new Set(Object.keys(avatarState))

    for (const item of items) {
        if (!item || !knownTypes.has(item.assetType)) continue
        avatarState[item.assetType] = await fs.promises.readFile(item.fullPath)
    }

    avatarState.default = avatarState.default || avatarState.avatar || avatarState.speaking || null
    avatarState.speaking = avatarState.speaking || avatarState.avatar || avatarState.default || null

    return avatarState
}

async function renderPipelineToBuffer(pipeline, isAnimatedGif) {
    if (isAnimatedGif) {
        return pipeline.gif().toBuffer()
    }
    return pipeline.png().toBuffer()
}

// Generate Default Avatars and Return As Buffers (Speaking, Default, Muted, Deafened)
async function generateDefaultAvatarsForUser(avatarUrl) {
    // Default, Speaking, Muted, Deafened
    const avatars = createEmptyAvatarState()
    if (!avatarUrl) {
        return avatars
    }
    const source = await fetch(avatarUrl)
    if (!source.ok) {
        throw new Error('Failed to fetch avatar from URL')
    }
    const arrayBuffer = await source.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)
    const sourceMeta = await sharp(buffer, { animated: true }).metadata()
    const isAnimatedGif = sourceMeta.format === 'gif' && (sourceMeta.pages || 1) > 1
    const baseWidth = sourceMeta.width || 128
    const baseHeight = sourceMeta.height || 128
    const iconSize = Math.max(1, Math.min(96, Math.floor(Math.min(baseWidth, baseHeight) * 0.35)))

    // base avatar and speaking
    avatars.avatar = buffer
    avatars.speaking = buffer

    // default
    const defaultAvatar = await renderPipelineToBuffer(
        sharp(buffer, { animated: isAnimatedGif })
        .grayscale()
        ,
        isAnimatedGif
    )

    avatars.default = defaultAvatar 

    // muted
    const muteBuffer = await sharp(muteIconPath)
        .resize(iconSize, iconSize)
        .png()
        .toBuffer();

    const mutedAvatar = await renderPipelineToBuffer(
        sharp(buffer, { animated: isAnimatedGif })
            .grayscale()
            .composite([
                {
                    input: muteBuffer,
                    gravity: 'southeast',
                    blend: 'over',
                },
            ]),
        isAnimatedGif
    )
    avatars.muted = mutedAvatar

    // deafened
    const deafBuffer = await sharp(deafIconPath)
        .resize(iconSize, iconSize)
        .png()
        .toBuffer();

    const deafenedAvatar = await renderPipelineToBuffer(
        sharp(buffer, { animated: isAnimatedGif })
            .grayscale()
            .composite([
                {
                    input: deafBuffer,
                    gravity: 'southeast',
                    blend: 'over',
                },
            ]),
        isAnimatedGif
    )
    avatars.deafened = deafenedAvatar

    return avatars
}

async function getAvatarOrDefault(ownerUserId, targetUserId, targetUserAvatarUrl) {
    try {
        const avatarPath = getAvatarPath(ownerUserId, targetUserId)
        if (avatarPath && fs.existsSync(avatarPath)) {
            const parsedPath = parseUploadPath(avatarPath)
            if (parsedPath && parsedPath.assetId) {
                const avatarItems = getAvatar(ownerUserId, parsedPath.assetId)
                if (avatarItems.length > 0) {
                    return await buildAvatarStateFromItems(avatarItems)
                }
            }
        }
    } catch (err) {
        console.error("Error getting avatar, falling back to default:", err)
    }
    try {
        return await generateDefaultAvatarsForUser(targetUserAvatarUrl)
    } catch (err) {
        console.error("Error generating default avatar set:", err)
        return createEmptyAvatarState()
    }
}

function parseUploadPath(inputPath) {
    // Seperate Path Into Segments and Find 'uploads' Index
    const parts = path.normalize(inputPath).split(path.sep);
    const uploadsIdx = parts.lastIndexOf('uploads');

    // If Bad Path, return null
    if (uploadsIdx === -1 || parts.length < uploadsIdx + 3) {
        return null;
    }

    // get userId and assetId from path segments following 'uploads'
    const userId = parts[uploadsIdx + 1];
    const assetId = parts[uploadsIdx + 2];

    return { userId, assetId };
}

module.exports = {
    handleUpload,
    handleEditUpload,
    getAllAvatarsForUser,
    deleteAvatarDirectory,
    deleteAvatarTypeFile,
    createAvatarDirectory,
    getAvatarOrDefault,
    generateDefaultAvatarsForUser,
};
