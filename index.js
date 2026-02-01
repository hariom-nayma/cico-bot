require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const sharp = require('sharp');
const moment = require('moment');
const fs = require('fs');
const path = require('path');

const bot = new Telegraf(process.env.BOT_TOKEN, {
    handlerTimeout: Infinity // Disable handler timeout for long-running operations like fetching 10 reports
});

const DB_PATH = path.join(__dirname, 'database.json');

// Helper to load database
function loadDB() {
    try {
        if (!fs.existsSync(DB_PATH)) return {};
        return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    } catch (e) {
        return {};
    }
}

// Helper to save database
function saveDB(data) {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// Helper to get user token (handles migration from string to object)
function getUserToken(userId) {
    const db = loadDB();
    const data = db[userId];
    if (!data) return null;
    if (typeof data === 'string') return data; // content is just token
    return data.token;
}

// Helper to save user token
function saveUserToken(userId, token) {
    const db = loadDB();
    let data = db[userId];

    // Initialize or migrate if string
    if (!data || typeof data === 'string') {
        data = { token: (typeof data === 'string' ? data : null), stretch: true };
    }

    data.token = token;
    db[userId] = data;
    saveDB(db);
}

// Helper to get stretch setting
function getStretchSetting(userId) {
    const db = loadDB();
    const data = db[userId];
    if (!data) return true; // Default to true (stretch enabled)
    if (typeof data === 'string') return true; // Default for legacy string records
    return data.stretch !== false; // Return true unless explicitly false
}

// Helper to save stretch setting
function saveStretchSetting(userId, isEnabled) {
    const db = loadDB();
    let data = db[userId] || { stretch: true }; // Default object if missing

    // Migrate if string
    if (typeof data === 'string') {
        data = { token: data, stretch: true };
    }

    data.stretch = isEnabled;
    db[userId] = data;
    saveDB(db);
}

// Helper to get stretch setting
function getStretchSetting(userId) {
    const db = loadDB();
    const data = db[userId];
    if (!data) return true; // Default to true (stretch enabled)
    if (typeof data === 'string') return true; // Default for legacy string records
    return data.stretch !== false; // Return true unless explicitly false
}

// Helper to save stretch setting
function saveStretchSetting(userId, isEnabled) {
    const db = loadDB();
    let data = db[userId] || { stretch: true }; // Default object if missing

    // Migrate if string
    if (typeof data === 'string') {
        data = { token: data, stretch: true };
    }

    data.stretch = isEnabled;
    db[userId] = data;
    saveDB(db);
}

// Helper to get dump channel
function getDumpChannel(userId) {
    const db = loadDB();
    const data = db[userId];
    if (!data || typeof data === 'string') return null;
    return data.dumpChannel;
}

// Helper to save dump channel
function saveDumpChannel(userId, channelId) {
    const db = loadDB();
    let data = db[userId] || { stretch: true };
    if (typeof data === 'string') data = { token: data, stretch: true };

    data.dumpChannel = channelId;
    db[userId] = data;
    saveDB(db);
}

async function processImage(imageUrl, shouldStretch = true) {
    try {
        const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            timeout: 15000 // 15s timeout for image download
        });
        const buffer = Buffer.from(response.data);

        // If stretching is disabled, return original buffer
        if (!shouldStretch) {
            return buffer;
        }

        const metadata = await sharp(buffer).metadata();

        // Stretch vertically by 2.0x 
        const newHeight = Math.floor(metadata.height * 2.0);

        const processedBuffer = await sharp(buffer)
            .resize({
                width: metadata.width,
                height: newHeight,
                fit: 'fill' // flatten/stretch to fit
            })
            .toBuffer();

        return processedBuffer;
    } catch (error) {
        console.error('Image Processing Error:', error.message);
        return imageUrl; // Fallback to original URL if processing fails
    }
}


const BASE_URL = process.env.BASE_URL;

// Helper to handle login
async function loginUser(email, password) {
    try {
        const url = `${BASE_URL}/student/studentLoginApi-web?email=${email}&password=${password}`;
        console.log(`Logging in user: ${email}`);
        const response = await axios.post(url);

        if (response.data && response.data.success && response.data.data && response.data.data.AccessToken) {
            return response.data.data.AccessToken;
        } else {
            // This might happen on 200 OK but success: false
            throw new Error('Login failed: ' + (response.data.message || 'Invalid response'));
        }
    } catch (error) {
        console.error('Login Error:', error.message);
        throw error; // Propagate error for the caller to handle 401
    }
}

// Helper to get attendance
// Helper to get attendance
async function getAttendance(token, limit = 1) {
    try {
        const endDate = moment().format('YYYY-MM-DD');
        // If limit is very high (magic number 9999 for "all"), fetch 10 years
        const daysToSubtract = limit > 365 ? 3650 : (limit > 30 ? 365 : 30);
        const startDate = moment().subtract(daysToSubtract, 'days').format('YYYY-MM-DD');

        const url = `${BASE_URL}/student/getStudentCheckInCheckOutHistory?startDate=${startDate}&endDate=${endDate}&limit=${limit}&offset=0&type=All`;
        console.log(`Fetching attendance from: ${url}`);

        const response = await axios.get(url, {
            headers: {
                'Authorization': token
            }
        });

        if (response.data && response.data.response && response.data.response.attendance) {
            return response.data.response.attendance;
        } else {
            return [];
        }

    } catch (error) {
        console.error('Attendance Fetch Error:', error.message);
        throw error;
    }
}

// Session management for login wizard
const loginSessions = {}; // userId -> { step: 'EMAIL' | 'PASSWORD', email: '' }

// Active dump sessions to support cancellation
const activeDumps = {}; // userId -> boolean

// Action: Get All Data
bot.action('get_all_data', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const userId = ctx.from.id;
        const token = getUserToken(userId);
        const dumpChannel = getDumpChannel(userId);

        if (!token) return ctx.reply('⚠️ Please /login first.');
        if (!dumpChannel) return ctx.reply('⚠️ No dump channel set. Use /dump <channel_id> to configure it first.');

        // Prevent multiple concurrent dumps
        if (activeDumps[userId]) {
            return ctx.reply('⚠️ A dump process is already running. Please wait or cancel it.');
        }

        await ctx.reply('🔄 Fetching all records (Last 10 Years)...');

        // Fetch all (Use large limit for "All Time")
        const attendanceRecords = await getAttendance(token, 9999);

        if (attendanceRecords.length === 0) {
            return ctx.reply('ℹ️ No records found.');
        }

        const total = attendanceRecords.length;
        const recordsToDump = [...attendanceRecords].reverse();

        // Mark dump as active
        activeDumps[userId] = true;

        // Send initial progress message with CANCEL button
        const startTime = Date.now();
        const progressMsg = await ctx.reply(
            generateProgressMessage(0, total, startTime),
            Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel Upload', 'cancel_dump')]])
        );

        let completed = 0;
        let cancelled = false;

        for (const record of recordsToDump) {
            // Check cancellation
            if (!activeDumps[userId]) {
                cancelled = true;
                break;
            }

            // Upload to dump channel
            await sendAttendanceReport(ctx, record, dumpChannel);
            completed++;

            // Update progress bar
            if (completed % 5 === 0 || completed === total) {
                try {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        progressMsg.message_id,
                        null,
                        generateProgressMessage(completed, total, startTime),
                        {
                            parse_mode: 'Markdown',
                            reply_markup: Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel Upload', 'cancel_dump')]]).reply_markup
                        }
                    );
                } catch (e) { }
            }

            await new Promise(r => setTimeout(r, 1000));
        }

        // Cleanup
        delete activeDumps[userId];

        if (cancelled) {
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                progressMsg.message_id,
                null,
                `🚫 *Upload Cancelled*\n\nCompleted: ${completed}/${total}`,
                { parse_mode: 'Markdown' }
            );
        } else {
            await ctx.Telegram?.editMessageText( // Try to remove cancel button on completion
                ctx.chat.id,
                progressMsg.message_id,
                null,
                generateProgressMessage(total, total, startTime) + "\n\n✅ *Done!*",
                { parse_mode: 'Markdown' }
            ).catch(() => { });

            await ctx.reply('✅ Bulk upload complete!');
        }

    } catch (error) {
        console.error(error);
        delete activeDumps[ctx.from.id];
        ctx.reply('❌ Error during bulk upload.');
    }
});

// Action: Cancel Dump
bot.action('cancel_dump', async (ctx) => {
    const userId = ctx.from.id;
    if (activeDumps[userId]) {
        activeDumps[userId] = false; // Set flag to false to stop loop
        await ctx.answerCbQuery('Stopping upload...');
    } else {
        await ctx.answerCbQuery('No active upload found.');
    }
});

function generateProgressMessage(completed, total, startTime) {
    const percentage = total > 0 ? Math.floor((completed / total) * 100) : 0;
    const progressBar = '▓'.repeat(Math.floor(percentage / 10)) + '░'.repeat(10 - Math.floor(percentage / 10));
    const remaining = total - completed;

    const elapsed = Date.now() - startTime;
    const rate = completed > 0 ? elapsed / completed : 0;
    const etaMs = rate * remaining;

    const formatTime = (ms) => {
        if (!isFinite(ms) || ms < 0) return 'Calculating...';
        const s = Math.floor(ms / 1000);
        const m = Math.floor(s / 60);
        return `${m}m ${s % 60}s`;
    };

    return `📥 *Uploading Attendance Data*\n\n` +
        `${progressBar} *${percentage}%*\n\n` +
        `✅ *Completed:* ${completed}/${total}\n` +
        `⏳ *Left:* ${remaining}\n` +
        `⏱ *Time Taken:* ${formatTime(elapsed)}\n` +
        `🚀 *ETA:* ${formatTime(etaMs)}`;
}

// Command: /login
bot.command('login', async (ctx) => {
    loginSessions[ctx.from.id] = { step: 'EMAIL' };
    await ctx.reply('📧 Please enter your email address:');
});

// Handle text messages for login wizard
bot.on('text', async (ctx, next) => {
    const userId = ctx.from.id;
    const session = loginSessions[userId];

    if (!session) {
        return next(); // Not in login flow, pass to other handlers
    }

    if (session.step === 'EMAIL') {
        session.email = ctx.message.text.trim();
        session.step = 'PASSWORD';
        await ctx.reply('🔑 Now please enter your password:');
    } else if (session.step === 'PASSWORD') {
        const password = ctx.message.text.trim();
        const email = session.email;

        // Clear session immediately or after attempt
        delete loginSessions[userId];

        await ctx.reply('🔄 Logging in...');

        // Delete password message for security (optional, best effort)
        try {
            await ctx.deleteMessage();
        } catch (e) { }

        try {
            const token = await loginUser(email, password);
            if (token) {
                saveUserToken(userId, token);
                await ctx.reply('✅ Login successful! You can now use /check and /attendance.');

                // Show profile after login
                await sendUserProfile(ctx, token);
            } else {
                await ctx.reply('❌ Login failed. Unexpected response.');
            }
        } catch (error) {
            if (error.response && error.response.status === 401) {
                await ctx.reply('❌ Login failed: Invalid email or password.');
            } else {
                console.error(error);
                await ctx.reply('❌ An error occurred during login. Please try again.');
            }
        }
    }
});

// Helper to get student profile
async function getStudentProfile(token) {
    try {
        const url = `${BASE_URL}/student/v1/getCurrentStudent`;
        console.log(`Fetching profile: ${url}`);
        const response = await axios.get(url, {
            headers: { 'Authorization': token }
        });
        return response.data;
    } catch (error) {
        console.error('Profile Fetch Error:', error.message);
        throw error;
    }
}

// Helper to send formatted profile
async function sendUserProfile(ctx, token) {
    try {
        await ctx.replyWithChatAction('typing');
        const profile = await getStudentProfile(token);

        if (!profile) {
            return ctx.reply('❌ Could not fetch profile.');
        }

        const name = escapeMarkdown(profile.fullName);
        const email = escapeMarkdown(profile.email);
        const mobile = escapeMarkdown(profile.mobile);
        const course = escapeMarkdown(profile.currentCourse);
        const applied = escapeMarkdown(profile.applyForCourse);
        const fees = profile.courseResponse ? escapeMarkdown(profile.courseResponse.courseFees) : 'N/A';
        const joinDate = escapeMarkdown(profile.joinDate);
        const userId = escapeMarkdown(profile.userId);
        const dob = escapeMarkdown(profile.dob);

        // Define status emoji
        const status = profile.active ? '🟢 Active' : '🔴 Inactive';

        const message =
            `👤 *Student Profile*\n\n` +
            `🆔 *User ID:* \`${userId}\`\n` +
            `📛 *Name:* ${name}\n` +
            `🎂 *DOB:* ${dob}\n` +
            `📱 *Mobile:* \`${mobile}\`\n` +
            `📧 *Email:* \`${email}\`\n` +
            `🎓 *Course:* ${course}\n` +
            `📚 *Applied For:* ${applied}\n` +
            `💰 *Fees:* ₹${fees}\n` +
            `📅 *Joined:* ${joinDate}\n` +
            `✨ *Status:* ${status}`;

        if (profile.profilePic) {
            // Use processImage but with stretching disabled (false)
            // Profile pics are usually standard aspect ratio
            const img = await processImage(profile.profilePic, false);

            if (Buffer.isBuffer(img)) {
                await ctx.replyWithPhoto({ source: img }, { caption: message, parse_mode: 'Markdown' });
            } else {
                await ctx.replyWithPhoto(img, { caption: message, parse_mode: 'Markdown' });
            }
        } else {
            await ctx.replyWithMarkdown(message);
        }

    } catch (e) {
        console.error("Error sending profile:", e);
        ctx.reply('❌ Failed to load profile details.');
    }
}

// Command Handler: /profile
bot.command('profile', async (ctx) => {
    const token = getUserToken(ctx.from.id);
    if (!token) return ctx.reply('⚠️ Please /login first.');
    await sendUserProfile(ctx, token);
});

// Helper to escape Markdown special characters to prevent 400 Bad Request
function escapeMarkdown(text) {
    if (!text) return '';
    // Escaping for Markdown V1 (which is what replyWithMarkdown uses)
    // Escapes: _, *, `, [
    return text.replace(/[_*`[]/g, '\\$&');
}
// Helper for rate limited sending
async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
// Helper to escape MarkdownV2 special characters
function escapeMarkdownV2(text) {
    if (!text) return '';
    return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

async function sendAttendanceReport(ctx, record, targetChatId = null) {
    // Determine target: if targetChatId is provided, use it; otherwise use ctx.chat.id
    const chatId = targetChatId || ctx.chat.id;
    const telegram = ctx.telegram;

    const shouldStretch = getStretchSetting(ctx.from.id);

    // Format Report using MarkdownV2
    // Quote block for timeline
    let message = `>📅 *Date:* ${escapeMarkdownV2(record.checkInDate)}\n`;
    message += `>⏰ *Check\\-In:* ${escapeMarkdownV2(record.checkInTime)}\n`;

    if (record.checkOutTime) {
        message += `>🛑 *Check\\-Out:* ${escapeMarkdownV2(record.checkOutTime)}\n`;
    }
    if (record.workingHour) {
        const hours = Math.floor(record.workingHour / 3600);
        const minutes = Math.floor((record.workingHour % 3600) / 60);
        message += `>⏳ *Duration:* ${hours}h ${minutes}m\n`;
    }

    // Work Report in Monospace
    if (record.workReport) {
        let report = record.workReport;
        if (report.length > 900) report = report.substring(0, 900) + '...';
        message += `\n📝 *Work Report:*\n\n\`${escapeMarkdownV2(report)}\``;
    }

    // Helper for safe sending with retry
    const safeSendPhoto = async (photo, caption) => {
        let retries = 3;
        while (retries > 0) {
            try {
                if (Buffer.isBuffer(photo)) {
                    await telegram.sendPhoto(chatId, { source: photo }, { caption });
                } else {
                    await telegram.sendPhoto(chatId, photo, { caption });
                }
                return;
            } catch (e) {
                if (e.description && e.description.includes('Too Many Requests')) {
                    const wait = (e.parameters?.retry_after || 10) + 1;
                    console.log(`429 on photo, waiting ${wait}s...`);
                    await sleep(wait * 1000);
                    retries--;
                } else {
                    throw e; // Non-retryable error
                }
            }
        }
    };

    // Helper for safe sending message
    const safeSendMessage = async (msg) => {
        let retries = 3;
        while (retries > 0) {
            try {
                await telegram.sendMessage(chatId, msg, { parse_mode: 'MarkdownV2' });
                return;
            } catch (e) {
                if (e.description && e.description.includes('Too Many Requests')) {
                    const wait = (e.parameters?.retry_after || 10) + 1;
                    console.log(`429 on message, waiting ${wait}s...`);
                    await sleep(wait * 1000);
                    retries--;
                } else {
                    console.error("MarkdownV2 Error, falling back to plain text:", e.description);
                    // Try fallback if markdown error
                    try {
                        await telegram.sendMessage(chatId, msg.replace(/[*_`\[\]()~>#+\-=|{}.!]/g, ''));
                    } catch (err) { }
                    return;
                }
            }
        }
    };

    // Send Images Individually with processing
    if (record.checkInImage) {
        try {
            if (!targetChatId) await ctx.replyWithChatAction('upload_photo'); // visual feedback only for direct chat

            const img = await processImage(record.checkInImage, shouldStretch);
            await safeSendPhoto(img, 'Check-In Image');
        } catch (e) {
            console.error("Error sending checkin img", e.message);
        }
    }
    if (record.checkOutImage) {
        try {
            if (!targetChatId) await ctx.replyWithChatAction('upload_photo');

            // processImage might fail or return original url
            const img = await processImage(record.checkOutImage, shouldStretch);
            await safeSendPhoto(img, 'Check-Out Image');
        } catch (e) {
            console.error("Error sending checkout img", e.message);
        }
    }

    try {
        await safeSendMessage(message);
    } catch (e) {
        console.error("Failed to send message", e.message);
    }
}

// Command Handler: /dump <channel_id>
bot.command('dump', async (ctx) => {
    try {
        const args = ctx.message.text.split(' ');
        if (args.length !== 2) {
            return ctx.reply('⚠️ Usage: /dump <channel_id>\nExample: /dump -1001234567890\n\nThis sets the channel where "Get All Data" will upload files.');
        }

        const channelId = args[1];
        saveDumpChannel(ctx.from.id, channelId);
        await ctx.reply(`✅ Dump channel set to: \`${channelId}\`\n\nNow use "Get All Data" in /attendance menu to upload records there.`);

    } catch (error) {
        console.error(error);
        ctx.reply('❌ Error saving dump channel.');
    }
});

// Command Handler: /check
bot.command('check', async (ctx) => {
    try {
        const token = getUserToken(ctx.from.id);
        if (!token) {
            return ctx.reply('⚠️ You are not logged in. Use /login <email> <password> first.');
        }

        await ctx.reply('🔄 Fetching latest attendance...');

        // Fetch just the latest 1 record
        const attendanceRecords = await getAttendance(token, 1);

        if (attendanceRecords.length === 0) {
            return ctx.reply('ℹ️ No attendance records found for the last 30 days.');
        }

        await sendAttendanceReport(ctx, attendanceRecords[0]);

    } catch (error) {
        console.error(error);
        if (error.response && error.response.status === 401) {
            ctx.reply('❌ Session expired. Please login again using /login.');
        } else {
            ctx.reply('❌ An error occurred while fetching data.');
        }
    }
});

// Command: /attendance
bot.command('attendance', async (ctx) => {
    await ctx.reply('📊 *Attendance Menu*',
        Markup.inlineKeyboard([
            [Markup.button.callback('📅 Today\'s Report', 'today_report')],
            [Markup.button.callback('🔟 Last 10 Reports', 'last_10_reports')],
            [Markup.button.callback('📥 Get All Data', 'get_all_data')]
        ])
    );
});

// Command: /settings
bot.command('settings', async (ctx) => {
    const isStretchEnabled = getStretchSetting(ctx.from.id);
    const statusText = isStretchEnabled ? '✅ Enabled (x2.0 Vertical)' : '❌ Disabled (Original)';

    await ctx.reply(`⚙️ *Image Settings*\n\nVertical Stretching: ${statusText}`,
        Markup.inlineKeyboard([
            [Markup.button.callback('✅ Enable Stretching', 'set_stretch_on')],
            [Markup.button.callback('❌ Disable Stretching', 'set_stretch_off')]
        ]),
        { parse_mode: 'Markdown' }
    );
});

// Action: Enable Stretching
bot.action('set_stretch_on', async (ctx) => {
    saveStretchSetting(ctx.from.id, true);
    await ctx.answerCbQuery('Image stretching enabled!');
    await ctx.editMessageText(`⚙️ *Image Settings*\n\nVertical Stretching: ✅ Enabled (x2.0 Vertical)`,
        {
            parse_mode: 'Markdown',
            reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('✅ Enable Stretching', 'set_stretch_on')],
                [Markup.button.callback('❌ Disable Stretching', 'set_stretch_off')]
            ]).reply_markup
        }
    );
});

// Action: Disable Stretching
bot.action('set_stretch_off', async (ctx) => {
    saveStretchSetting(ctx.from.id, false);
    await ctx.answerCbQuery('Image stretching disabled!');
    await ctx.editMessageText(`⚙️ *Image Settings*\n\nVertical Stretching: ❌ Disabled (Original)`,
        {
            parse_mode: 'Markdown',
            reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('✅ Enable Stretching', 'set_stretch_on')],
                [Markup.button.callback('❌ Disable Stretching', 'set_stretch_off')]
            ]).reply_markup
        }
    );
});

// Action: Today's Report
bot.action('today_report', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const token = getUserToken(ctx.from.id);
        if (!token) return ctx.reply('⚠️ Please /login first.');

        await ctx.reply('🔄 Fetching today\'s report...');
        const attendanceRecords = await getAttendance(token, 1);

        if (attendanceRecords.length === 0) {
            return ctx.reply('ℹ️ No records found.');
        }

        await sendAttendanceReport(ctx, attendanceRecords[0]);

    } catch (error) {
        console.error(error);
        ctx.reply('❌ Error fetching data.');
    }
});

// Action: Last 10 Reports
bot.action('last_10_reports', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const token = getUserToken(ctx.from.id);
        if (!token) return ctx.reply('⚠️ Please /login first.');

        await ctx.reply('🔄 Fetching last 10 reports...');
        const attendanceRecords = await getAttendance(token, 10); // Fetch 10

        if (attendanceRecords.length === 0) {
            return ctx.reply('ℹ️ No records found.');
        }

        // Loop and send reports. Maybe add a small delay to avoid rate limits if user has spam protection?
        // Basic implementation:
        for (const record of attendanceRecords) {
            await sendAttendanceReport(ctx, record);
        }
        await ctx.reply('✅ All reports sent.');

    } catch (error) {
        console.error(error);
        ctx.reply('❌ Error fetching data.');
    }
});

// Action: Get All Data
bot.action('get_all_data', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const userId = ctx.from.id;
        const token = getUserToken(userId);
        const dumpChannel = getDumpChannel(userId);

        if (!token) return ctx.reply('⚠️ Please /login first.');
        if (!dumpChannel) return ctx.reply('⚠️ No dump channel set. Use /dump <channel_id> to configure it first.');

        await ctx.reply('🔄 Fetching all records (last 365 days)...');

        // Fetch all (365 days limit)
        const attendanceRecords = await getAttendance(token, 365);

        if (attendanceRecords.length === 0) {
            return ctx.reply('ℹ️ No records found.');
        }

        const total = attendanceRecords.length;
        // Reverse to upload oldest first
        const recordsToDump = [...attendanceRecords].reverse();

        // Send initial progress message
        const startTime = Date.now();
        const progressMsg = await ctx.reply(generateProgressMessage(0, total, startTime));

        let completed = 0;

        for (const record of recordsToDump) {
            // Upload to dump channel
            await sendAttendanceReport(ctx, record, dumpChannel);
            completed++;

            // Update progress bar every 5 records or on last one to avoid rate limits
            if (completed % 5 === 0 || completed === total) {
                try {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id,
                        progressMsg.message_id,
                        null,
                        generateProgressMessage(completed, total, startTime),
                        { parse_mode: 'Markdown' }
                    );
                } catch (e) {
                    // Ignore errors (e.g. message not modified)
                }
            }

            // Small delay
            await new Promise(r => setTimeout(r, 1000));
        }

        await ctx.reply('✅ Bulk upload complete!');

    } catch (error) {
        console.error(error);
        ctx.reply('❌ Error during bulk upload.');
    }
});

function generateProgressMessage(completed, total, startTime) {
    const percentage = Math.floor((completed / total) * 100);
    const progressBar = '▓'.repeat(Math.floor(percentage / 10)) + '░'.repeat(10 - Math.floor(percentage / 10));
    const remaining = total - completed;

    const elapsed = Date.now() - startTime;
    const rate = completed > 0 ? elapsed / completed : 0;
    const etaMs = rate * remaining;

    const formatTime = (ms) => {
        const s = Math.floor(ms / 1000);
        const m = Math.floor(s / 60);
        return `${m}m ${s % 60}s`;
    };

    return `📥 *Uploading Attendance Data*\n\n` +
        `${progressBar} *${percentage}%*\n\n` +
        `✅ *Completed:* ${completed}/${total}\n` +
        `⏳ *Left:* ${remaining}\n` +
        `⏱ *Time Taken:* ${formatTime(elapsed)}\n` +
        `🚀 *ETA:* ${formatTime(etaMs)}`;
}


bot.launch().then(() => {
    console.log('🤖 CICO Bot is running!');
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
