require("dotenv").config();

const { Client, GatewayIntentBits } = require("discord.js");
const {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
} = require("@discordjs/voice");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;

if (!DISCORD_TOKEN || !GUILD_ID || !VOICE_CHANNEL_ID) {
  console.error("Faltou DISCORD_TOKEN, GUILD_ID ou VOICE_CHANNEL_ID nas env vars");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

async function onReady() {
  try {
    console.log(`Logado como ${client.user.tag}`);

    const guild = await client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(VOICE_CHANNEL_ID);

    if (!channel || !channel.isVoiceBased?.()) {
      console.error("VOICE_CHANNEL_ID não parece ser um canal de voz válido.");
      process.exit(1);
    }

    console.log(`Entrando no canal de voz: ${channel.name}`);

    const connection = joinVoiceChannel({
      channelId: VOICE_CHANNEL_ID,
      guildId: GUILD_ID,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    // IMPORTANTÍSSIMO: sem isso, o erro derruba o process e o Railway fica restartando
    connection.on("error", (err) => {
      console.error("VoiceConnection error:", err?.message || err);
    });

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      console.warn("VoiceConnection: Disconnected");
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    console.log("✅ VoiceConnection: Ready (conectado no canal)");

    // Se você chama teu recorder aqui, mantenha a linha abaixo e troque pelo teu start
    // require("./recorder").startRecording(connection, channel);

  } catch (err) {
    console.error("Erro no onReady:", err);
    process.exit(1);
  }
}

// Compat: discord.js v14 (ready) vs v15 (clientReady)
client.once("ready", onReady);
client.once("clientReady", onReady);

client.login(DISCORD_TOKEN);
