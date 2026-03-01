const { checkToken } = require('./users')

// Determines If Response has Valid Username Cookie
function hasCookieUserID(req) {
    const userID = req.cookies?.userID;
    return !!userID
}

// Builds UserID Cookie
function buildCookieUserID(res, userID, days) {
    const age = days * 24 * 60 * 60 * 1000
    res.cookie('userID', userID, {
        maxAge: age,
        httpOnly: true,
        sameSite: 'lax',
    })
}

// Returns Value of UserID in Cookie
function getCookieUsername(req) {
    return req.cookies?.userID
}

// Validates user cookie and token freshness
async function validateCookie(req, res) {
    const userID = req.cookies?.userID;
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
