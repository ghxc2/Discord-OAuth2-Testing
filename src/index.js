// Imports
require('dotenv').config();
const express = require('express');
const url = require('url');
const cookieParser = require('cookie-parser');

// Current Project Imports
const { getToken } = require('./tokenStore')
const { validateUser, refreshUser,  isTokenExpired } = require('./users')
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
    let userID = req.cookies?.userID;
    console.log(userID)
    if (!userID) {
        res.clearCookie("userID")
        userID = null
    }
    if (userID) {
        try {
            if (isTokenExpired(userID)) {
                await refreshUser()
            }
        } catch (e) {
            if (code) {
                userID = await validateUser(code)
            }
        }
    } else {
        if (code) {
            userID = await validateUser(code)
            res.cookie("userID", userID)
        }
    }
    
    res.send(`Hello, ${getToken(userID)["username"]}`)
});

// App Start Logic
app.listen(port, () => {console.log(`Running on ${port}`)})