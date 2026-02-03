require('dotenv').config();
const express = require('express');
const axios = require('axios');
const url = require('url');
const cookieParser = require('cookie-parser');

const {setToken, getToken } = require('./tokenStore')

const port = process.env.port || 1500;
const app = express();

// Allows App to use Cookies
app.use(cookieParser())
app.get('/', async (req, res) => {
    res.send("Welcome")
})
app.get('/api/auth/discord/redirect', async (req, res) => {
    const { code } = req.query;
    let userID = req.cookies?.userID;
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
            res.cookie('userID', userID)
        }
    }
    
    res.send(`Hello, ${getToken(userID)["username"]}`)
});

async function validateUser(code) {

    // Form to Retrieve Token
    const formData = new URLSearchParams({
        client_id: process.env.client_id,
        client_secret: process.env.client_secret,
        grant_type: 'authorization_code',
        code: code.toString(),
        redirect_uri: 'http://localhost:1500/api/auth/discord/redirect',
    });

    // Retrieve Token From Discord API
    const output = await axios.post('https://discord.com/api/v10/oauth2/token',
        formData, {
            headers: {
                "Content-Type": 'application/x-www-form-urlencoded',
            }
    });
    
    // If Successfully Retrieved Token
    if (output.data) {
        const userinfo = await retrieveUser(output.data.access_token)
        saveUserInfo(userinfo)
        return userinfo.data.id
    }
    
}

async function refreshUser(username) {

    const data = getToken(username)
    // Refresh Token
    const formDataRefresh = new URLSearchParams({
    client_id: process.env.client_id,
    client_secret: process.env.client_secret,
    grant_type: 'refresh_token',
    refresh_token: output.data.refresh_token,
    });

    // Retrieve ref
    const refresh = await axios.post('https://discord.com/api/v10/oauth2/token',
        formDataRefresh, {
            headers: {
                "Content-Type": 'application/x-www-form-urlencoded',
            }
    });

    // If Successfully Retrieved Token
    if (refresh.data) {
        const userinfo = await retrieveUser(refresh.data.access_token)
        saveUserInfo(userinfo)
    }
}

function isTokenExpired(userID) {
    return Date.now() > getToken(userID)["expires"]
}

async function retrieveUser(token) {
    const headers =  {
        'Authorization': `Bearer ${token}`,
    }

    // user info
    const userinfo = await axios.get('https://discord.com/api/v10/users/@me', {
        headers
    });

    return userinfo
}

function saveUserInfo(userinfo) {
    // Logic To Save Token to Memory
    const expires = Math.floor(Date.now() / 1000) + userinfo.data.expires_in
    console.log(userinfo.data)
    setToken(userinfo.data.id, userinfo.data.access_token, userinfo.data.refresh_token, expires, userinfo.data.username)
}

app.listen(port, () => {console.log(`Running on ${port}`)})