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

module.exports = { hasCookieUserID, buildCookieUserID, getCookieUsername }