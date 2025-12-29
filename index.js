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
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

let booted = false;
let connection = null;

const COMMAND_PREFIX = "!";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function connectVoice() {
  if (connection && connection.state?.status !== VoiceConnectionStatus.Destroyed) {
    return connection;
  }

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
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      console.log("✅ reconectou (signalling/connecting)");
    } catch {
      try {
        connection.destroy();
      } catch {}
      await sleep(1500);
      await safeConnectLoop();
    }
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  console.log("✅ VoiceConnection: Ready (conectado no canal)");
  return connection;
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

// usa o novo evento clientReady para evitar o warning de depreciação do v15
client.once("clientReady", boot);

client.login(DISCORD_TOKEN);

client.on("messageCreate", async (message) => {
  if (!message.content?.startsWith(COMMAND_PREFIX)) return;
  if (message.author.bot) return;

  const [command] = message.content
    .slice(COMMAND_PREFIX.length)
    .trim()
    .split(/\s+/);

  const cmd = command?.toLowerCase();

  if (cmd === "ping") {
    await message.reply("Pong!");
    return;
  }

  if (cmd === "help") {
    await message.reply(
      [
        "Comandos disponíveis:",
        "!join - conecta no canal de voz configurado",
        "!leave - sai do canal de voz",
        "!ping - teste rápido de vida do bot",
        "!help - mostra esta mensagem",
      ].join("\n")
    );
    return;
  }

  if (cmd === "join") {
    try {
      await safeConnectLoop();
      await message.reply("Entrei (ou já estava) no canal de voz configurado.");
    } catch (err) {
      const reason = err?.message || String(err);
      await message.reply(`Não consegui entrar no voice: ${reason}`);
    }
    return;
  }

  if (cmd === "leave") {
    if (connection) {
      try {
        connection.destroy();
        connection = null;
        await message.reply("Saí do canal de voz.");
      } catch (err) {
        const reason = err?.message || String(err);
        await message.reply(`Erro ao sair do voice: ${reason}`);
      }
    } else {
      await message.reply("Não estou em nenhum canal de voz agora.");
    }
  }
});
