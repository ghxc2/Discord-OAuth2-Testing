require('dotenv').config();
const express = require('express');
const axios = require('axios');
const url = require('url');

const port = process.env.port || 1500;
const app = express();

app.get('/api/auth/discord/redirect', async (req, res) => {
    const { code } = req.query;

    if (code) {
        const formData = new URLSearchParams({
            client_id: process.env.client_id,
            client_secret: process.env.client_secret,
            grant_type: 'authorization_code',
            code: code.toString(),
            redirect_uri: 'http://localhost:1500/api/auth/discord/redirect',
        });

        console.log(formData.toString());
        const output = await axios.post('https://discord.com/api/v10/oauth2/token',
            formData, {
                headers: {
                    "Content-Type": 'application/x-www-form-urlencoded',
                }
        });

        console.log(output)
        
        if (output.data) {
            const access = output.data.access_token;
            const headers =  {
                'Authorization': `Bearer ${access}`,
            }



            // user info
            const userinfo = await axios.get('https://discord.com/api/v10/users/@me', {
                headers
            });
            
            // Refresh Token
            const formDataRefresh = new URLSearchParams({
                client_id: process.env.client_id,
                client_secret: process.env.client_secret,
                grant_type: 'refresh_token',
                refresh_token: output.data.refresh_token,
            });
            
            const refresh = await axios.post('https://discord.com/api/v10/oauth2/token',
                formDataRefresh, {
                    headers: {
                        "Content-Type": 'application/x-www-form-urlencoded',
                    }
            });
            
            console.log(output.data, userinfo.data, refresh.data)
        }
    }
});

app.listen(port, () => {console.log(`Running on ${port}`)})