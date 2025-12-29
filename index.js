import "libsodium-wrappers";

import { Client, GatewayIntentBits } from "discord.js";
import {
  joinVoiceChannel,
  getVoiceConnection,
  EndBehaviorType,
} from "@discordjs/voice";
import prism from "prism-media";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

if (!DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN não definido nas variáveis do ambiente.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

// ====== ÁUDIO: ouvir qualquer um do canal (menos o bot) ======
function startListening(connection) {
  const receiver = connection.receiver;

  receiver.speaking.on("start", (userId) => {
    // ignora o próprio bot
    if (userId === client.user.id) return;

    console.log("🎤 speaking start:", userId);

    const opusStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 600, // ms de silêncio para encerrar
      },
    });

    // Discord voice = Opus -> PCM 48k stereo
    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });

    const pcmStream = opusStream.pipe(decoder);

    pcmStream.on("data", (chunk) => {
      // chunk é PCM bruto (Buffer)
      // Próximo passo: downsample 48k stereo -> 16k mono e mandar pro ElevenLabs WS
      console.log("🔊 pcm chunk bytes:", chunk.length);
    });

    pcmStream.on("end", () => console.log("🛑 speaking end:", userId));
    pcmStream.on("error", (e) => console.error("❌ pcm error", e));
    opusStream.on("error", (e) => console.error("❌ opus error", e));
  });

  console.log("👂 Receiver ligado: ouvindo o canal (exceto o bot).");
}

// ====== Comandos ======
async function handleJoin(message) {
  if (!message.guild) return;

  const member = await message.guild.members.fetch(message.author.id);
  const channel = member?.voice?.channel;

  if (!channel) {
    await message.reply("Entra em um canal de voz primeiro, depois manda `!join` 🙂");
    return;
  }

  // se já existe conexão, reaproveita
  let connection = getVoiceConnection(message.guild.id);

  if (!connection) {
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    startListening(connection);
  }

  await message.reply(`🎧 Entrei no canal **${channel.name}**. Pode falar que eu tô “ouvindo” (logando PCM).`);
}

async function handleLeave(message) {
  if (!message.guild) return;

  const connection = getVoiceConnection(message.guild.id);
  if (!connection) {
    await message.reply("Não estou em nenhum canal de voz.");
    return;
  }

  connection.destroy();
  await message.reply("👋 Saí do canal de voz.");
}

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const text = message.content.trim();

  if (text === "!ping") {
    await message.reply("pong ✅");
    return;
  }

  if (text === "!join") {
    await handleJoin(message);
    return;
  }

  if (text === "!leave") {
    await handleLeave(message);
    return;
  }
});

client.once("ready", () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
  console.log("Comandos: !ping | !join | !leave");
});

client.login(DISCORD_TOKEN);
