// bot.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const schedule = require('node-schedule');
const mongoose = require('mongoose');

const app = express();

// Middleware
app.use(bodyParser.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// User Schema
const userSchema = new mongoose.Schema({
  chatId: { type: Number, required: true, unique: true },
  morningTime: { type: String, default: '11:30' },
  eveningTime: { type: String, default: '20:00' },
  morningJobName: String,
  eveningJobName: String,
  pendingMorning: { type: Boolean, default: false },
  pendingEvening: { type: Boolean, default: false },
  streak: { type: Number, default: 0 },
  lastActive: Date
});

const User = mongoose.model('User', userSchema);

// Initialize Telegram Bot
// const token = process.env.TELEGRAM_BOT_TOKEN;
const token = '8189601658:AAFfZJdXtKzqVII_ZqswocJE919gmUw5bDI';
const bot = new TelegramBot(token, { polling: false });

// Set Webhook
const webhookUrl = `${process.env.WEBHOOK_URL}/webhook`;
bot.setWebHook(webhookUrl)
  .then(() => console.log(`Webhook set to ${webhookUrl}`))
  .catch(console.error);

// Store active jobs
const activeJobs = {};

// Bot Functionality
async function scheduleUserJobs(chatId) {
  const user = await User.findOne({ chatId });
  if (!user) return;

  // Cancel existing jobs
  if (user.morningJobName && activeJobs[user.morningJobName]) {
    activeJobs[user.morningJobName].cancel();
    delete activeJobs[user.morningJobName];
  }
  if (user.eveningJobName && activeJobs[user.eveningJobName]) {
    activeJobs[user.eveningJobName].cancel();
    delete activeJobs[user.eveningJobName];
  }

  // Schedule morning message
  const [morningHour, morningMinute] = user.morningTime.split(':').map(Number);
  const morningJobName = `morning_${chatId}`;
  activeJobs[morningJobName] = schedule.scheduleJob(
    { hour: morningHour, minute: morningMinute, tz: 'Asia/Phnom_Penh' },
    async () => {
      await sendScheduledMessage(chatId, 'morning');
    }
  );

  // Schedule evening message
  const [eveningHour, eveningMinute] = user.eveningTime.split(':').map(Number);
  const eveningJobName = `evening_${chatId}`;
  activeJobs[eveningJobName] = schedule.scheduleJob(
    { hour: eveningHour, minute: eveningMinute, tz: 'Asia/Phnom_Penh' },
    async () => {
      await sendScheduledMessage(chatId, 'evening');
    }
  );

  // Update user with job names
  user.morningJobName = morningJobName;
  user.eveningJobName = eveningJobName;
  await user.save();
}

async function sendScheduledMessage(chatId, timeOfDay) {
  const user = await User.findOne({ chatId });
  if (!user) return;

  const message = timeOfDay === 'morning' 
    ? `🌞 Good morning! It's time for your morning routine! Reply "OK" when done.` 
    : `🌙 Good evening! Time for your evening reflection. Reply "OK" when done.`;

  const options = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "I did it!", callback_data: `ack_${timeOfDay}` }],
        [{ text: "Skip today", callback_data: `skip_${timeOfDay}` }]
      ]
    }
  };

  await bot.sendMessage(chatId, message, options);
  
  // Mark as pending
  if (timeOfDay === 'morning') {
    user.pendingMorning = true;
  } else {
    user.pendingEvening = true;
  }
  await user.save();

  // Set timeout to check response
  setTimeout(async () => {
    const updatedUser = await User.findOne({ chatId });
    if (!updatedUser) return;

    if ((timeOfDay === 'morning' && updatedUser.pendingMorning) || 
        (timeOfDay === 'evening' && updatedUser.pendingEvening)) {
      await bot.sendMessage(chatId, `⚠️ You missed your ${timeOfDay} activity. Your streak has been reset.`);
      updatedUser.streak = 0;
      if (timeOfDay === 'morning') {
        updatedUser.pendingMorning = false;
      } else {
        updatedUser.pendingEvening = false;
      }
      await updatedUser.save();
    }
  }, 6 * 60 * 60 * 1000); // 6 hours
}

// Command Handlers
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  let user = await User.findOne({ chatId });

  if (!user) {
    user = new User({ chatId });
    await user.save();
    await scheduleUserJobs(chatId);
  }

  const options = {
    reply_markup: {
      keyboard: [
        [{ text: "⏰ Set Morning Time" }, { text: "🌙 Set Evening Time" }],
        [{ text: "📊 My Stats" }, { text: "❌ Unsubscribe" }]
      ],
      resize_keyboard: true
    }
  };

  await bot.sendMessage(chatId, `Welcome back! Here are your options:`, options);
});

bot.onText(/Set (Morning|Evening) Time/, async (msg, match) => {
  const chatId = msg.chat.id;
  const timeOfDay = match[1].toLowerCase();
  await bot.sendMessage(chatId, `Please enter your ${timeOfDay} time in 24-hour format (HH:MM), Cambodia timezone.\nExample: ${timeOfDay === 'morning' ? '07:30' : '20:00'}`);
});

bot.on('message', async (msg) => {
  if (!msg.text) return;
  
  const chatId = msg.chat.id;
  const text = msg.text;
  
  if (/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(text)) {
    const user = await User.findOne({ chatId });
    if (!user) return;
    
    const isMorning = text.split(':')[0] < 12;
    
    if (isMorning) {
      user.morningTime = text;
    } else {
      user.eveningTime = text;
    }
    
    await user.save();
    await scheduleUserJobs(chatId);
    await bot.sendMessage(chatId, `${isMorning ? 'Morning' : 'Evening'} time set to ${text}!`);
  }
});

// Callback Handlers
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;
  const user = await User.findOne({ chatId });
  
  if (!user) return;
  
  if (data.startsWith('ack_')) {
    const timeOfDay = data.split('_')[1];
    
    if (timeOfDay === 'morning') {
      user.pendingMorning = false;
    } else {
      user.pendingEvening = false;
    }
    
    user.streak += 1;
    user.lastActive = new Date();
    await user.save();
    
    await bot.answerCallbackQuery(callbackQuery.id, { text: `Great job! ${user.streak} day streak!` });
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: chatId, message_id: callbackQuery.message.message_id }
    );
  } else if (data.startsWith('skip_')) {
    const timeOfDay = data.split('_')[1];
    
    if (timeOfDay === 'morning') {
      user.pendingMorning = false;
    } else {
      user.pendingEvening = false;
    }
    
    await user.save();
    
    await bot.answerCallbackQuery(callbackQuery.id, { text: "Okay, skipped for today." });
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [] },
      { chat_id: chatId, message_id: callbackQuery.message.message_id }
    );
  }
});

// Stats Handler
bot.onText(/My Stats/, async (msg) => {
  const chatId = msg.chat.id;
  const user = await User.findOne({ chatId });
  
  if (!user) return;
  
  const statsMessage = `
📊 Your Stats:
- Current Streak: ${user.streak} days
- Morning Time: ${user.morningTime}
- Evening Time: ${user.eveningTime}
- Last Active: ${user.lastActive ? user.lastActive.toLocaleString() : 'Never'}
  `;
  
  await bot.sendMessage(chatId, statsMessage);
});

// Unsubscribe Handler
bot.onText(/Unsubscribe/, async (msg) => {
  const chatId = msg.chat.id;
  const user = await User.findOne({ chatId });
  
  if (!user) return;
  
  if (user.morningJobName && activeJobs[user.morningJobName]) {
    activeJobs[user.morningJobName].cancel();
    delete activeJobs[user.morningJobName];
  }
  if (user.eveningJobName && activeJobs[user.eveningJobName]) {
    activeJobs[user.eveningJobName].cancel();
    delete activeJobs[user.eveningJobName];
  }
  
  await User.deleteOne({ chatId });
  await bot.sendMessage(chatId, "You've been unsubscribed from all messages. Use /start to subscribe again.");
});

// Webhook Endpoint
app.post('/webhook', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Start Server
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  bot.getMe().then((me) => console.log(`Bot ${me.username} is running...`));
});
