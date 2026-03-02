const { checkToken } = require('./users')

// Determines If Response has Valid Username Cookie
function hasCookieUserID(req) {
    const userID = req.session?.userID;
    return !!userID
}

// Builds UserID Cookie
async function buildCookieUserID(req, userID, days) {
    const age = days * 24 * 60 * 60 * 1000
    await new Promise((resolve, reject) => {
        req.session.regenerate((err) => {
            if (err) return reject(err)
            req.session.userID = userID
            req.session.cookie.maxAge = age
            return resolve()
        })
    })
}

// Returns Value of UserID in Cookie
function getCookieUsername(req) {
    return req.session?.userID
}

// Validates user cookie and token freshness
async function validateCookie(req, res) {
    const userID = req.session?.userID;
    if (!userID) {
        res.redirect('/error')
        throw new Error("Invalid ID")
    }

    try {
        await checkToken(userID)
    } catch (e) {
        console.error("Token check failed:", e.message)
        res.redirect('/error')
        throw new Error("Invalid ID")
    }

    return userID
}

module.exports = { hasCookieUserID, buildCookieUserID, getCookieUsername, validateCookie }
