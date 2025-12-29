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
let connection = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function connectVoice() {
  const guild = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(VOICE_CHANNEL_ID);

  if (!channel || !channel.isVoiceBased?.()) {
    throw new Error("VOICE_CHANNEL_ID não parece ser um canal de voz válido.");
  }

  console.log(`Entrando no canal de voz: ${channel.name}`);

  connection = joinVoiceChannel({
    channelId: VOICE_CHANNEL_ID,
    guildId: GUILD_ID,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  connection.on("error", (err) => {
    console.error("VoiceConnection error:", err?.message || err);
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    console.warn("⚠️ VoiceConnection: Disconnected — tentando reconectar...");
    try {
      // tenta recuperar rápido
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      console.log("✅ reconectou (signalling/connecting)");
    } catch {
      // reconecta do zero
      try {
        connection.destroy();
      } catch {}
      await sleep(1500);
      await safeConnectLoop();
    }
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  console.log("✅ VoiceConnection: Ready (conectado no canal)");
}

async function safeConnectLoop() {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      console.log(`🔁 tentativa de conectar no voice: ${attempt}/10`);
      await connectVoice();
      return; // sucesso
    } catch (err) {
      const msg = err?.message || String(err);
      console.error("Erro ao conectar voice:", msg);

      // erro típico do Railway / cloud UDP discovery
      // a gente só tenta de novo em vez de matar o container
      await sleep(3000);
    }
  }

  console.error("❌ não consegui conectar no voice após 10 tentativas.");
  // não dá exit; deixa rodando pra você ver logs e ajustar rede
}

async function boot() {
  if (booted) return;
  booted = true;

  console.log(`Logado como ${client.user.tag}`);
  await safeConnectLoop();

  // aqui depois a gente liga o recorder de verdade (Etapa 4 parte 2)
  // require("./recorder").startRecording(connection);
}

// remove o warning: no v14 use ready; no v15 use clientReady
if (typeof client.once === "function") {
  if ("clientReady" in client) {
    // alguns builds expõem isso, mas o evento é o nome que importa
    client.once("clientReady", boot);
  } else {
    client.once("ready", boot);
  }
} else {
  client.once("ready", boot);
}

client.login(DISCORD_TOKEN);
