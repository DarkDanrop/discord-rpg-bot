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
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

let booted = false;

async function boot() {
  if (booted) return;
  booted = true;

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

    connection.on("error", (err) => {
      console.error("VoiceConnection error:", err?.message || err);
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    console.log("✅ VoiceConnection: Ready (conectado no canal)");

    // Se você tiver recorder.js, chama aqui:
    // require("./recorder").startRecording(connection, channel);

  } catch (err) {
    console.error("Erro no boot:", err);
    process.exit(1);
  }
}

// discord.js v14 usa 'ready'.
// v15 renomeia pra 'clientReady'.
// Pra cobrir ambos sem duplicar, checa se existe o evento e registra só 1.
if (client.on.length) {
  // Registra os dois, mas protege com booted
  client.once("ready", boot);
  client.once("clientReady", boot);
} else {
  client.once("ready", boot);
}

client.login(DISCORD_TOKEN);
