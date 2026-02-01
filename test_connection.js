require('dotenv').config();
const axios = require('axios');

const token = process.env.BOT_TOKEN;
if (!token) {
    console.error('❌ No BOT_TOKEN found in .env');
    process.exit(1);
}

const maskedToken = token.substring(0, 5) + '...';
console.log(`Testing connection with token: ${maskedToken}`);

async function testConnection() {
    try {
        console.log('Sending request to api.telegram.org...');
        const response = await axios.get(`https://api.telegram.org/bot${token}/getMe`, { timeout: 10000 });
        console.log('✅ Connection Successful!');
        console.log('Bot Name:', response.data.result.first_name);
        console.log('Bot Username:', response.data.result.username);
    } catch (error) {
        console.error('❌ Connection Failed!');
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', error.response.data);
        } else {
            console.error('Error:', error.message);
        }
    }
}

testConnection();
