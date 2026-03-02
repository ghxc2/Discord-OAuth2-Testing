const { db } = require('./database')

db.exec(`
    CREATE TABLE IF NOT EXISTS web_sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expires INTEGER NOT NULL
    );
`)
db.exec(`
    CREATE INDEX IF NOT EXISTS idx_web_sessions_expires
    ON web_sessions (expires);
`)

const getSessionStmt = db.prepare(`
    SELECT sess, expires
    FROM web_sessions
    WHERE sid = ?
    LIMIT 1
`)
const upsertSessionStmt = db.prepare(`
    INSERT INTO web_sessions (sid, sess, expires)
    VALUES (@sid, @sess, @expires)
    ON CONFLICT(sid) DO UPDATE SET
        sess = excluded.sess,
        expires = excluded.expires
`)
const updateSessionExpiryStmt = db.prepare(`
    UPDATE web_sessions
    SET expires = @expires
    WHERE sid = @sid
`)
const deleteSessionStmt = db.prepare(`
    DELETE FROM web_sessions
    WHERE sid = ?
`)
const deleteExpiredSessionsStmt = db.prepare(`
    DELETE FROM web_sessions
    WHERE expires <= ?
`)

function createSqliteSessionStore(sessionLib, { cleanupIntervalMs = 10 * 60 * 1000 } = {}) {
    class SqliteSessionStore extends sessionLib.Store {
        constructor() {
            super()
            this.cleanupTimer = setInterval(() => {
                try {
                    deleteExpiredSessionsStmt.run(Date.now())
                } catch (_) {
                    // no-op: session cleanup failure should not crash the app
                }
            }, cleanupIntervalMs)
            this.cleanupTimer.unref?.()
        }

        get(sid, cb) {
            try {
                const row = getSessionStmt.get(sid)
                if (!row) return cb(null, null)

                if (row.expires <= Date.now()) {
                    deleteSessionStmt.run(sid)
                    return cb(null, null)
                }

                const sessionData = JSON.parse(row.sess)
                return cb(null, sessionData)
            } catch (err) {
                return cb(err)
            }
        }

        set(sid, sess, cb) {
            try {
                const expires = getSessionExpiresAt(sess)
                upsertSessionStmt.run({
                    sid,
                    sess: JSON.stringify(sess),
                    expires,
                })
                if (typeof cb === 'function') cb(null)
            } catch (err) {
                if (typeof cb === 'function') cb(err)
            }
        }

        touch(sid, sess, cb) {
            try {
                const expires = getSessionExpiresAt(sess)
                updateSessionExpiryStmt.run({ sid, expires })
                if (typeof cb === 'function') cb(null)
            } catch (err) {
                if (typeof cb === 'function') cb(err)
            }
        }

        destroy(sid, cb) {
            try {
                deleteSessionStmt.run(sid)
                if (typeof cb === 'function') cb(null)
            } catch (err) {
                if (typeof cb === 'function') cb(err)
            }
        }
    }

    return new SqliteSessionStore()
}

function getSessionExpiresAt(sess) {
    const cookie = sess?.cookie || {}
    const now = Date.now()

    if (cookie.expires) {
        const expiresMs = new Date(cookie.expires).getTime()
        if (Number.isFinite(expiresMs) && expiresMs > now) {
            return expiresMs
        }
    }

    if (Number.isFinite(cookie.maxAge) && cookie.maxAge > 0) {
        return now + cookie.maxAge
    }

    return now + (24 * 60 * 60 * 1000)
}

module.exports = {
    createSqliteSessionStore,
}
