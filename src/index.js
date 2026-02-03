// Imports
require('dotenv').config();
const express = require('express');
const url = require('url');
const cookieParser = require('cookie-parser');

// Current Project Imports
const { getToken } = require('./tokenStore')
const { validateUser, refreshUser,  isTokenExpired, retrieveUser, getUserNameFromUserID, checkToken} = require('./users')
const { getCookieUsername, buildCookieUserID } = require('./cookies')

// App Variables
const port = process.env.port || 1500;
const app = express();

// Allows App to use Cookies
app.use(cookieParser())

// Home Page
app.get('/', async (req, res) => {
    res.send("Welcome")
})

// Page Directed To From Discord Link
app.get('/api/auth/discord/redirect', async (req, res) => {
    const { code } = req.query;
    console.log(req.query)
    let userID = getCookieUsername(req)
    console.log(userID)
    if (!userID) {
        if (!code) {
            redirectError(res)
            return
        }
        res.clearCookie("userID")
        userID = null
    }
    
    try {
        if (isTokenExpired(userID)) {
            await refreshUser()
        }
    } catch (e) {
        if (code) {
            userID = await validateUser(code)
        }
    }
    
    buildCookieUserID(res, userID, 7)
    res.send(`Hello, ${getUserNameFromUserID(userID)}`)
});

// Voice Related
app.get('/voice', async (req, res) => {
    let userID = req.cookies?.userID;
    console.log(userID)
    if (!userID) {
        redirectError(res)
    }
    // Assure User Token Valid
    checkToken(userID)
    res.send(`Hello, ${getUserNameFromUserID(userID)}`)
    
})

// Failed Login
app.get('/error', async (req, res) => {
    res.send("Please Login Using: https://discord.com/oauth2/authorize?client_id=1468061028008067174&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A1500%2Fapi%2Fauth%2Fdiscord%2Fredirect&scope=identify+guilds+connections+email+guilds.join+gdm.join+voice")
})

// Easy Function to Redirect to Error Page
function redirectError(res) {
    res.redirect("/error")
}

// App Start Logic
app.listen(port, () => {console.log(`Running on ${port}`)})