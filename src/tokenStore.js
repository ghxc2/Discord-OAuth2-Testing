const fs = require('fs')
const path = require('path')

// Path To Include File
const filePath = path.join(__dirname, 'tokens.json');

// Save Refresh Tokens To File
function saveTokens(tokens) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(tokens, null, 2))
    } catch (e) {
        console.error("Error Writing Tokens To File: ", e)
    }
}

// Load Tokens From File
function loadTokens() {
    try {
        if (!fs.existsSync(filePath)) {
            return {}
        }
        const data = fs.readFileSync(filePath)
        return JSON.parse(data)
    } catch (e) {
        console.error("Error Reading Token File:", e)
        return {}
    }
}

// Retrieve Specific Token
function getToken(userID) {
    const tokens = loadTokens();
    return tokens[userID] || null;
}

// Update User's Token
function setToken(userID, token, refreshToken, expires, username) {
    const tokens = loadTokens();
    tokens[userID] = {token: token, refresh_token: refreshToken, expires: expires, username: username}
    saveTokens(tokens)
}

module.exports = {setToken, getToken}