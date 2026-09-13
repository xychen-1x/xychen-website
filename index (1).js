require("dotenv/config");
const { Client, GatewayIntentBits, REST, Routes, Collection, EmbedBuilder } = require("discord.js");
const Groq = require("groq-sdk");
const axios = require("axios");

let Replicate;
try {
  Replicate = require("replicate");
} catch (e) {}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
  ],
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const GIPHY_API_KEY = process.env.GIPHY_API_KEY;
const GIPHY_BASE_URL = "https://api.giphy.com/v1/gifs/search";
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
const ADMIN_LOG_CHANNEL_ID = process.env.ADMIN_LOG_CHANNEL_ID;
const OWNER_ID = process.env.OWNER_ID;

// ------------------- UTILITIES -------------------
const getGif = async (searchTerm, limit = 5) => {
  try {
    const response = await axios.get(GIPHY_BASE_URL, {
      params: {
        api_key: GIPHY_API_KEY,
        q: searchTerm || "funny",
        limit: limit,
        rating: "g",
        random_id: Math.random().toString(36).substring(7),
      },
    });
    const results = response.data.data;
    if (results && results.length > 0) {
      const randomIndex = Math.floor(Math.random() * results.length);
      return results[randomIndex].images.original.url || results[randomIndex].images.downsized.url;
    }
    return null;
  } catch (error) {
    console.error("GIF error:", error);
    return null;
  }
};

const getTrendingGif = async () => {
  try {
    const response = await axios.get("https://api.giphy.com/v1/gifs/trending", {
      params: { api_key: GIPHY_API_KEY, limit: 10, rating: "g" },
    });
    const results = response.data.data;
    if (results && results.length > 0) {
      const randomIndex = Math.floor(Math.random() * results.length);
      return results[randomIndex].images.original.url;
    }
    return null;
  } catch (error) {
    console.error("Trending error:", error);
    return null;
  }
};

const isGif = (message) =>
  message.attachments.some((att) => att.url && /\.(gif)$/i.test(att.url));

const isImage = (message) =>
  message.attachments.some((att) => att.url && /\.(png|jpg|jpeg|webp)$/i.test(att.url));

async function logError(error, context = "General") {
  console.error(error);
  if (ADMIN_LOG_CHANNEL_ID) {
    const channel = client.channels.cache.get(ADMIN_LOG_CHANNEL_ID);
    if (channel) {
      await channel
        .send(`❌ **${context}**: \`${error.message || error}\``)
        .catch(() => {});
    }
  }
}

// ------------------- COOLDOWNS -------------------
const cooldowns = new Collection();

function setCooldown(userId, command, seconds = 5) {
  const key = `${userId}-${command}`;
  cooldowns.set(key, Date.now() + seconds * 1000);
  setTimeout(() => cooldowns.delete(key), seconds * 1000);
}

function checkCooldown(userId, command) {
  const key = `${userId}-${command}`;
  const expiry = cooldowns.get(key);
  if (expiry && Date.now() < expiry) {
    const remaining = Math.ceil((expiry - Date.now()) / 1000);
    return remaining;
  }
  return 0;
}

// ------------------- CONTEXTUAL MEMORY -------------------
const channelMemory = new Map();

function addToMemory(channelId, role, content) {
  if (!channelMemory.has(channelId)) channelMemory.set(channelId, []);
  const history = channelMemory.get(channelId);
  history.push({ role, content });
  if (history.length > 12) history.splice(0, 2);
}

function getMemory(channelId) {
  return channelMemory.get(channelId) || [];
}

// ------------------- PERSONA & LOCATION -------------------
const userPersona = new Map();
const userLocation = new Map();

// ------------------- FETCH WEATHER WITH FALLBACK -------------------
const fetchWeather = async (cityQuery) => {
  const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(cityQuery)}&appid=${WEATHER_API_KEY}&units=metric`;
  try {
    const response = await axios.get(url);
    return response.data;
  } catch (err) {
    if (err.response && err.response.status === 404) {
      const geoUrl = `http://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(cityQuery)}&limit=1&appid=${WEATHER_API_KEY}`;
      const geoResponse = await axios.get(geoUrl);
      const geoData = geoResponse.data;
      if (geoData && geoData.length > 0) {
        const { name, country } = geoData[0];
        const newQuery = `${name}, ${country}`;
        const retryUrl = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(newQuery)}&appid=${WEATHER_API_KEY}&units=metric`;
        const retryResponse = await axios.get(retryUrl);
        return retryResponse.data;
      }
    }
    throw err;
  }
};

// ------------------- READY EVENT -------------------
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}!`);

  const commands = [
    { name: "ping", description: "Check bot latency" },
    {
      name: "weather",
      description: "Get current weather for a city",
      options: [{ name: "city", description: "City name (e.g., Manila, PH)", type: 3, required: false }],
    },
    {
      name: "forecast",
      description: "Get 5-day weather forecast for a city",
      options: [{ name: "city", description: "City name (e.g., Manila, PH)", type: 3, required: true }],
    },
    {
      name: "setlocation",
      description: "Set your default location for weather",
      options: [{ name: "city", description: "Your city (e.g., Manila, PH)", type: 3, required: true }],
    },
    { name: "summarize", description: "Summarize the last 20 messages in this channel" },
    {
      name: "youtube",
      description: "Search for a video on YouTube",
      options: [{ name: "query", description: "Search term", type: 3, required: true }],
    },
    {
      name: "reddit",
      description: "Get a random post from a subreddit",
      options: [{ name: "subreddit", description: "Subreddit name (default: memes)", type: 3, required: false }],
    },
    {
      name: "imagine",
      description: "Generate an image from a prompt",
      options: [{ name: "prompt", description: "Describe what you want", type: 3, required: true }],
    },
    {
      name: "persona",
      description: "Set a custom persona for the bot",
      options: [{ name: "description", description: 'e.g. "a pirate who loves tacos"', type: 3, required: true }],
    },
    {
      name: "dm",
      description: "Send a DM to a user (owner only)",
      options: [
        { name: "user", description: "The user to DM", type: 6, required: true },
        { name: "message", description: "The message to send", type: 3, required: true },
      ],
    },
    { name: "servers", description: "List all servers where the bot is (owner only)" },
    {
      name: "rps",
      description: "Play Rock Paper Scissors",
      options: [
        {
          name: "choice",
          description: "Your choice",
          type: 3,
          required: true,
          choices: [
            { name: "Rock", value: "rock" },
            { name: "Paper", value: "paper" },
            { name: "Scissors", value: "scissors" },
          ],
        },
      ],
    },
    {
      name: "8ball",
      description: "Ask the Magic 8-Ball a question",
      options: [{ name: "question", description: "Your question", type: 3, required: true }],
    },
    { name: "trivia", description: "Get a random trivia question" },
    {
      name: "roll",
      description: "Roll a dice",
      options: [{ name: "sides", description: "Number of sides (default: 6)", type: 4, required: false }],
    },
    { name: "help", description: "Show all commands and features" },
  ];

  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("✅ Slash commands registered.");
  } catch (error) {
    console.error("Failed to register slash commands:", error);
  }

  // Auto-messages
  const channelId = "1475291424554745947";
  const generateAutoMessage = async () => {
    try {
      const completion = await groq.chat.completions.create({
        model: "openai/gpt-oss-120b",
        messages: [
          { role: "system", content: "Generate a short, engaging conversation starter for a Discord server. Under 30 words. Use 1-2 emojis max. Casual and friendly." },
          { role: "user", content: "Generate a random conversation starter." },
        ],
      });
      return completion.choices[0].message.content;
    } catch (error) {
      await logError(error, "Auto-message generation");
      return "👋 Hello everyone! How's your day going?";
    }
  };

  const sendAutoMessage = async () => {
    try {
      const channel = client.channels.cache.get(channelId);
      if (!channel) {
        console.error(`Channel ${channelId} not found!`);
        return;
      }
      const message = await generateAutoMessage();
      await channel.send(message);
      console.log(`Auto-message sent: "${message}"`);
    } catch (error) {
      await logError(error, "Auto-message send");
    }
  };

  const scheduleNext = () => {
    const delay = 2 * 60 * 60 * 1000;
    console.log(`Next auto-message in 2 hours`);
    setTimeout(() => {
      sendAutoMessage();
      scheduleNext();
    }, delay);
  };

  setTimeout(() => {
    sendAutoMessage();
    scheduleNext();
  }, 10000);
});

// ------------------- INTERACTION CREATE -------------------
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;

  const { commandName, user, options, channel } = interaction;
  const userId = user.id;

  const cd = checkCooldown(userId, commandName);
  if (cd > 0) {
    return interaction.reply({
      content: `⏳ Please wait ${cd} second(s) before using \`/${commandName}\` again.`,
      ephemeral: true,
    });
  }
  setCooldown(userId, commandName, 5);

  const isOwner = userId === OWNER_ID;

  try {
    switch (commandName) {
      case "ping": {
        const latency = Date.now() - interaction.createdTimestamp;
        await interaction.reply(`🏓 Pong! Latency: ${latency}ms`);
        break;
      }

      case "weather": {
        let city = options.getString("city");
        if (!city) {
          city = userLocation.get(userId);
          if (!city) {
            return interaction.reply("❌ Please provide a city or set your default location with `/setlocation`.");
          }
        }
        await interaction.deferReply();
        if (!WEATHER_API_KEY) {
          return interaction.editReply("❌ Weather API key not configured.");
        }
        try {
          const data = await fetchWeather(city);
          const sunrise = new Date(data.sys.sunrise * 1000).toLocaleTimeString();
          const sunset = new Date(data.sys.sunset * 1000).toLocaleTimeString();
          const windKmh = (data.wind.speed * 3.6).toFixed(1);

          const reply = `🌤️ **${data.name}, ${data.sys.country}**
🌡️ Temp: ${data.main.temp}°C (Feels like: ${data.main.feels_like}°C)
💧 Humidity: ${data.main.humidity}%
💨 Wind: ${data.wind.speed} m/s (${windKmh} km/h)
📊 Pressure: ${data.main.pressure} hPa
🌅 Sunrise: ${sunrise} | Sunset: ${sunset}
☁️ ${data.weather[0].description}`;

          await interaction.editReply(reply);
        } catch (err) {
          await logError(err, "Weather API");
          await interaction.editReply("❌ City not found or API error. Try adding country code (e.g., 'Manila, PH').");
        }
        break;
      }

      case "forecast": {
        const city = options.getString("city");
        await interaction.deferReply();
        if (!WEATHER_API_KEY) {
          return interaction.editReply("❌ Weather API key not configured.");
        }
        const url = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(city)}&appid=${WEATHER_API_KEY}&units=metric`;
        try {
          const response = await axios.get(url);
          const data = response.data;
          const daily = data.list.filter((item, index) => index % 8 === 0).slice(0, 5);
          let forecastMsg = `📅 **5-Day Forecast for ${data.city.name}, ${data.city.country}**\n`;
          daily.forEach(day => {
            const date = new Date(day.dt * 1000).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            forecastMsg += `\n**${date}** – ${day.weather[0].description}\n🌡️ High: ${day.main.temp_max}°C | Low: ${day.main.temp_min}°C`;
          });
          await interaction.editReply(forecastMsg);
        } catch (err) {
          await logError(err, "Forecast API");
          await interaction.editReply("❌ Forecast not found. Check city name.");
        }
        break;
      }

      case "setlocation": {
        const city = options.getString("city");
        userLocation.set(userId, city);
        await interaction.reply(`✅ Your default location is now **${city}**.\nUse \`/weather\` without a city to check this location.`);
        break;
      }

      case "summarize": {
        await interaction.deferReply();
        try {
          const messages = await channel.messages.fetch({ limit: 20 });
          const text = messages.reverse().map(m => `${m.author.username}: ${m.content}`).join('\n');
          if (!text.trim()) {
            return interaction.editReply("📝 No messages to summarize.");
          }
          const completion = await groq.chat.completions.create({
            model: "openai/gpt-oss-120b",
            messages: [
              { role: "system", content: "Summarize the following Discord conversation in 3-5 sentences. Keep it neutral and concise." },
              { role: "user", content: text },
            ],
          });
          await interaction.editReply(`📝 **Summary:**\n${completion.choices[0].message.content}`);
        } catch (err) {
          await logError(err, "Summarize");
          await interaction.editReply("❌ Failed to summarize.");
        }
        break;
      }

      case "youtube": {
  const query = options.getString("query");
  await interaction.deferReply();
  try {
    // Gumamit ng Invidious public instance
    const response = await axios.get(`https://yewtu.be/api/v1/search?q=${encodeURIComponent(query)}&type=video&maxResults=5`);
    const results = response.data;
    
    if (!results || results.length === 0) {
      return interaction.editReply("No results found. Try a different keyword.");
    }
    
    // Pumili ng random video mula sa results
    const video = results[Math.floor(Math.random() * results.length)];
    await interaction.editReply(`🎥 **${video.title}**\nhttps://www.youtube.com/watch?v=${video.videoId}`);
  } catch (err) {
    console.error("YouTube search error:", err);
    await interaction.editReply("❌ YouTube search failed. Try again later.");
  }
  break;
}

      case "reddit": {
        const subreddit = options.getString("subreddit") || "memes";
        await interaction.deferReply();
        try {
          const url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=50`;
          const response = await axios.get(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 10000
          });
          const posts = response.data.data.children.filter(p => !p.data.over_18);
          if (posts.length === 0) {
            return interaction.editReply(`No SFW posts found in r/${subreddit}.`);
          }
          const randomPost = posts[Math.floor(Math.random() * posts.length)].data;
          await interaction.editReply(`📌 **${randomPost.title}**\n${randomPost.url}`);
        } catch (err) {
          console.error("Reddit error:", err.response?.status);
          await logError(err, "Reddit");
          let errorMsg = "❌ Failed to fetch from Reddit.";
          if (err.response?.status === 403) errorMsg += " Access blocked. Try a different subreddit or try again later.";
          else if (err.response?.status === 404) errorMsg += " Subreddit not found.";
          else if (err.code === 'ECONNABORTED') errorMsg += " Request timed out.";
          await interaction.editReply(errorMsg);
        }
        break;
      }

      case "imagine": {
        const prompt = options.getString("prompt");
        if (!Replicate || !REPLICATE_TOKEN) {
          return interaction.reply("❌ Image generation is not configured (Replicate API token missing).");
        }
        await interaction.deferReply();
        const replicate = new Replicate({ auth: REPLICATE_TOKEN });
        try {
          const output = await replicate.run(
            "black-forest-labs/flux-1.1-pro",
            {
              input: {
                prompt: prompt,
                aspect_ratio: "1:1",
                output_format: "webp",
                output_quality: 80,
              }
            }
          );
          const embed = new EmbedBuilder()
            .setTitle(`🎨 ${prompt}`)
            .setImage(output)
            .setColor(0x00AE86)
            .setFooter({ text: `Generated by Xychen` })
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });
        } catch (err) {
          await logError(err, "Image generation");
          await interaction.editReply("❌ Failed to generate image. Please try again.");
        }
        break;
      }

      case "persona": {
        const desc = options.getString("description");
        userPersona.set(userId, desc);
        await interaction.reply(`✅ Your persona has been set to: "${desc}"`);
        break;
      }

      case "dm": {
        if (!isOwner) {
          return interaction.reply({ content: "❌ Only the bot owner can use this command.", ephemeral: true });
        }
        const targetUser = options.getUser("user");
        const message = options.getString("message");
        try {
          await targetUser.send(message);
          await interaction.reply({ content: `✅ DM sent to **${targetUser.tag}**`, ephemeral: true });
        } catch (err) {
          await interaction.reply({ content: `❌ Failed to send DM to **${targetUser.tag}**. They may have DMs disabled.`, ephemeral: true });
        }
        break;
      }

      case "servers": {
        if (!isOwner) {
          return interaction.reply({ content: "❌ Only the bot owner can use this command.", ephemeral: true });
        }
        const guilds = client.guilds.cache.map(g =>
          `**${g.name}** (${g.id})\n👑 Owner: <@${g.ownerId}>\n👥 Members: ${g.memberCount}`
        );
        const embed = new EmbedBuilder()
          .setTitle(`🤖 Bot Servers (${client.guilds.cache.size})`)
          .setDescription(guilds.join('\n\n') || 'No servers yet.')
          .setColor(0x00AE86)
          .setTimestamp();

        await interaction.reply({ embeds: [embed] });
        break;
      }

      case "rps": {
        const userChoice = options.getString("choice");
        const choices = ["rock", "paper", "scissors"];
        const botChoice = choices[Math.floor(Math.random() * choices.length)];
        let result = "";
        if (userChoice === botChoice) result = "It's a tie! 🤝";
        else if (
          (userChoice === "rock" && botChoice === "scissors") ||
          (userChoice === "paper" && botChoice === "rock") ||
          (userChoice === "scissors" && botChoice === "paper")
        ) {
          result = "You win! 🎉";
        } else {
          result = "I win! 😎";
        }
        await interaction.reply(`I chose **${botChoice}**! ${result}`);
        break;
      }

      case "8ball": {
        const question = options.getString("question");
        const responses = [
          "Yes, definitely! ✅", "No, sorry. ❌", "Maybe. 🤔",
          "I don't think so. 😕", "Absolutely! 💯", "Ask again later. ⏳",
          "Signs point to yes. 🔮", "Cannot predict now. 🌙", "Very doubtful. 😬",
        ];
     const reply = responses[Math.floor(Math.random() * responses.length)];
        await interaction.reply(`🎱 ${reply}`);
        break;
      }

      case "trivia": {
        await interaction.deferReply();
        try {
          const completion = await groq.chat.completions.create({
            model: "openai/gpt-oss-120b",
            messages: [
              { role: "system", content: "Generate a short trivia question with 4 options (A, B, C, D). Mark the correct answer with an asterisk (*). Keep it fun." },
              { role: "user", content: "Generate a trivia question." },
            ],
          });
          await interaction.editReply(`🧠 **Trivia Time!**\n${completion.choices[0].message.content}`);
        } catch (err) {
          await logError(err, "Trivia");
          await interaction.editReply("❌ Could not generate trivia.");
        }
        break;
      }

      case "roll": {
        const sides = options.getInteger("sides") || 6;
        if (sides < 2 || sides > 100) {
          return interaction.reply("🎲 Use a number between 2 and 100.");
        }
        const roll = Math.floor(Math.random() * sides) + 1;
        await interaction.reply(`🎲 You rolled a **${roll}** (1-${sides})!`);
        break;
      }

      case "help": {
        await interaction.reply(
          "🤖 **Xychen Commands**\n\n" +
          "🎮 **Games:** `/rps`, `/8ball`, `/trivia`, `/roll`\n" +
          "🌐 **External:** `/weather`, `/forecast`, `/setlocation`, `/youtube`, `/reddit`, `/imagine`\n" +
          "🧠 **AI:** `/summarize`, `/persona`, `@Xychen <message>`\n" +
          "🛠️ **Utility:** `/ping`, `/help`\n" +
          "👑 **Owner Only:** `/dm`, `/servers`\n\n" +
          "🖼️ Send images/GIFs/stickers → I'll reply!\n" +
          "⏳ Cooldown: 5 seconds per command."
        );
        break;
      }

      default:
        await interaction.reply("Unknown command.");
    }
  } catch (error) {
    await logError(error, `Slash command: ${commandName}`);
    if (!interaction.replied) {
      await interaction.reply({ content: "❌ An error occurred.", ephemeral: true });
    }
  }
});

// ------------------- MESSAGE CREATE -------------------
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (isImage(message)) {
    try {
      const reply = await groq.chat.completions.create({
        model: "openai/gpt-oss-120b",
        messages: [
          { role: "system", content: "Reply to someone who sent an image. Keep it short (under 20 words), casual, and engaging. Use 1-2 emojis max." },
          { role: "user", content: "Reply to an image someone sent." },
        ],
      });
      await message.reply(reply.choices[0].message.content);
    } catch (error) {
      await logError(error, "Image reply");
      await message.reply("🖼️ Nice image!");
    }
    return;
  }

  if (isGif(message)) {
    try {
      const keywords = message.content.replace(/<@!?\d+>/g, "").trim() || "funny";
      const gifUrl = await getGif(keywords, 5);
      if (gifUrl) {
        await message.reply(gifUrl);
        return;
      }
      const trendingGif = await getTrendingGif();
      if (trendingGif) {
        await message.reply(trendingGif);
        return;
      }
      const reply = await groq.chat.completions.create({
        model: "openai/gpt-oss-120b",
        messages: [
          { role: "system", content: "Reply to someone who sent a GIF. Keep it short (under 15 words), casual, and fun. Use 1-2 emojis max." },
          { role: "user", content: "Reply to a GIF someone sent." },
        ],
      });
      await message.reply(reply.choices[0].message.content);
    } catch (error) {
      await logError(error, "GIF reply");
      await message.reply("🎬 Nice GIF!");
    }
    return;
  }

  if (message.stickers.size > 0) {
    try {
      const stickerName = message.stickers.first().name;
      const reply = await groq.chat.completions.create({
        model: "openai/gpt-oss-120b",
        messages: [
          { role: "system", content: "Reply to someone who sent a sticker. Keep it short (under 15 words), casual, and fun. Use 1-2 emojis max." },
          { role: "user", content: `Reply to someone who sent a sticker named "${stickerName}".` }
        ]
      });
      await message.reply(reply.choices[0].message.content);
    } catch (error) {
      await logError(error, "Sticker reply");
      await message.reply("🎨 Cool sticker!");
    }
    return;
  }

  const args = message.content.split(" ");
  const command = args[0].toLowerCase();

  const textCommands = ["!rps", "!8ball", "!trivia", "!roll", "!help"];
  if (textCommands.includes(command)) {
    const cd = checkCooldown(message.author.id, command);
    if (cd > 0) return;
    setCooldown(message.author.id, command, 5);
  }

  if (command === "!rps") {
    const userChoice = args[1]?.toLowerCase();
    if (!["rock", "paper", "scissors"].includes(userChoice)) {
      return message.reply("🎮 Use `!rps rock`, `!rps paper`, or `!rps scissors`.");
    }
    const choices = ["rock", "paper", "scissors"];
    const botChoice = choices[Math.floor(Math.random() * choices.length)];
    let result = "";
    if (userChoice === botChoice) result = "It's a tie! 🤝";
    else if (
      (userChoice === "rock" && botChoice === "scissors") ||
      (userChoice === "paper" && botChoice === "rock") ||
      (userChoice === "scissors" && botChoice === "paper")
    ) {
      result = "You win! 🎉";
    } else {
      result = "I win! 😎";
    }
    await message.reply(`I chose **${botChoice}**! ${result}`);
    return;
  }

  if (command === "!8ball") {
    const question = args.slice(1).join(" ");
    if (!question) return message.reply("❓ Ask a question! Example: `!8ball Will I win?`");
    const responses = [
      "Yes, definitely! ✅", "No, sorry. ❌", "Maybe. 🤔",
      "I don't think so. 😕", "Absolutely! 💯", "Ask again later. ⏳",
      "Signs point to yes. 🔮", "Cannot predict now. 🌙", "Very doubtful. 😬"
    ];
    const reply = responses[Math.floor(Math.random() * responses.length)];
    await message.reply(`🎱 ${reply}`);
    return;
  }

  if (command === "!trivia") {
    try {
      const completion = await groq.chat.completions.create({
        model: "openai/gpt-oss-120b",
        messages: [
          { role: "system", content: "Generate a short trivia question with 4 options (A, B, C, D). Mark the correct answer with an asterisk (*). Keep it fun." },
          { role: "user", content: "Generate a trivia question." }
        ]
      });
      await message.reply(`🧠 **Trivia Time!**\n${completion.choices[0].message.content}`);
    } catch (error) {
      await logError(error, "Trivia text");
      await message.reply("🧠 Sorry, I can't think of a trivia right now.");
    }
    return;
  }

  if (command === "!roll") {
    const sides = parseInt(args[1]) || 6;
    if (sides < 2 || sides > 100) return message.reply("🎲 Use a number between 2 and 100.");
    const roll = Math.floor(Math.random() * sides) + 1;
    await message.reply(`🎲 You rolled a **${roll}** (1-${sides})!`);
    return;
  }

  if (command === "!help") {
    await message.reply(
      "🤖 **Xychen Commands**\n\n" +
      "🎮 **Games:** `!rps`, `!8ball`, `!trivia`, `!roll`\n" +
      "💬 **Chat:** `@Xychen <message>`\n" +
      "🖼️ Send images/GIFs/stickers → I'll reply!\n" +
      "🌐 Use `/help` for more commands (weather, youtube, reddit, imagine, etc.)"
    );
    return;
  }

  if (!message.mentions.has(client.user)) return;

  const userMessage = message.content.replace(/<@!?\d+>/g, "").trim();
  if (!userMessage) {
    return message.reply("👋 What would you like to ask?");
  }

  try {
    const gifKeywords = ["gif", "meme", "send gif", "funny", "reaction"];
    const wantsGif = gifKeywords.some((kw) => userMessage.toLowerCase().includes(kw));
    if (wantsGif || Math.random() < 0.2) {
      const keywords = userMessage.split(" ").slice(0, 3).join(" ") || "funny";
      const gifUrl = await getGif(keywords, 5);
      if (gifUrl) {
        const aiReply = await groq.chat.completions.create({
          model: "openai/gpt-oss-120b",
          messages: [
            { role: "system", content: "Reply to a user's question. Keep it under 30 words. Use 1-2 emojis max. Be helpful and friendly." },
            { role: "user", content: userMessage },
          ],
        });
        await message.reply(`${aiReply.choices[0].message.content}\n\n${gifUrl}`);
        return;
      }
    }

    const persona = userPersona.get(message.author.id) || "a friendly Discord chatbot";
    const systemContent = `You are ${persona}. Reply in a conversational tone. Keep it under 50 words. Use 1-2 emojis max.`;
    const history = getMemory(message.channel.id);
    const messages = [
      { role: "system", content: systemContent },
      ...history,
      { role: "user", content: userMessage },
    ];

    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-120b",
      messages,
    });
    const reply = completion.choices[0].message.content;
    addToMemory(message.channel.id, "user", userMessage);
    addToMemory(message.channel.id, "assistant", reply);

    await message.reply(reply);
  } catch (error) {
    await logError(error, "Mention AI");
    await message.reply("😅 Sorry, I'm having trouble thinking right now.");
  }
});

// ------------------- GUILD CREATE (Track invites) --------
client.on("guildCreate", async (guild) => {
  try {
    const owner = await guild.fetchOwner();
    console.log(`✅ Bot added to: ${guild.name} (${guild.id}) by ${owner.user.tag} (${owner.user.id})`);
    try {
      await owner.user.send(`Hello! Thank you for adding Xychen to **${guild.name}**! 🎉\n\nType \`/help\` to see all commands.`);
    } catch (dmErr) {
      console.log(`Cannot DM owner of ${guild.name}`);
    }
  } catch (err) {
    console.error("Guild create error:", err);
  }
});

// ------------------- LOGIN -------------------
client.login(process.env.DISCORD_TOKEN);