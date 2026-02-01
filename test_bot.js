require('dotenv').config();
const { Telegraf } = require('telegraf');

const token = process.env.BOT_TOKEN;
if (!token) {
    console.error('❌ No BOT_TOKEN found');
    process.exit(1);
}

const bot = new Telegraf(token);

console.log('Test bot: calling launch()...');
bot.launch().then(() => {
    console.log('✅ Test bot launched successfully!');
    process.exit(0);
}).catch(err => {
    console.error('❌ Test bot failed to launch:', err);
    process.exit(1);
});

// kill after 10s if hangs
setTimeout(() => {
    console.error('TIMEOUT: Test bot launch timed out after 10s');
    process.exit(1);
}, 10000);
