import { Client, GatewayIntentBits } from "discord.js";
import {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus
} from "@discordjs/voice";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

if (!DISCORD_TOKEN) {
  console.error("❌ Falta DISCORD_TOKEN nas variáveis de ambiente.");
  process.exit(1);
}
if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
  console.warn("⚠️ ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID não definidos (o comando !say não vai funcionar ainda).");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const players = new Map(); // guildId -> audioPlayer

function getPlayer(guildId) {
  let p = players.get(guildId);
  if (!p) {
    p = createAudioPlayer();
    players.set(guildId, p);
  }
  return p;
}

async function elevenlabsTTS(text) {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    throw new Error("ElevenLabs não configurado (falta API key ou voice id).");
  }

  // Endpoint v1 TTS
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
      "Accept": "audio/mpeg"
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: {
        stability: 0.35,
        similarity_boost: 0.85,
        style: 0.2,
        use_speaker_boost: true
      }
    })
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`ElevenLabs erro ${res.status}: ${msg?.slice(0, 300)}`);
  }

  // Retorna o stream de áudio (MP3)
  return res.body; // ReadableStream
}

client.once("ready", () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
  console.log("Comandos: !ping | !join | !leave | !say <texto>");
});

client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot) return;
    const content = msg.content.trim();

    if (content.toLowerCase() === "!ping") {
      await msg.reply("pong ✅");
      return;
    }

    if (content.toLowerCase() === "!help") {
      await msg.reply(
        "Comandos:\n" +
          "- **!ping** (teste)\n" +
          "- **!join** (entra no seu canal de voz)\n" +
          "- **!leave** (sai do canal de voz)\n" +
          "- **!say texto...** (fala no canal com ElevenLabs)\n"
      );
      return;
    }

    if (content.toLowerCase() === "!join") {
      const member = await msg.guild.members.fetch(msg.author.id);
      const voiceChannel = member?.voice?.channel;

      if (!voiceChannel) {
        await msg.reply("Entra em um canal de voz primeiro, depois manda **!join** aqui 🙂");
        return;
      }

      const conn = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: msg.guild.id,
        adapterCreator: msg.guild.voiceAdapterCreator
      });

      const player = getPlayer(msg.guild.id);
      conn.subscribe(player);

      await msg.reply(`🎙️ Entrei no canal **${voiceChannel.name}**.`);
      return;
    }

    if (content.toLowerCase() === "!leave") {
      const conn = getVoiceConnection(msg.guild.id);
      if (conn) conn.destroy();
      await msg.reply("👋 Saí do canal de voz.");
      return;
    }

    if (content.toLowerCase().startsWith("!say ")) {
      const text = content.slice(5).trim();
      if (!text) {
        await msg.reply("Manda assim: **!say Olá, aventureiros!**");
        return;
      }

      const conn = getVoiceConnection(msg.guild.id);
      if (!conn) {
        await msg.reply("Eu não estou em nenhum canal de voz. Entra num canal e manda **!join** primeiro 🙂");
        return;
      }

      await msg.reply("🗣️ Falando...");

      const audioStream = await elevenlabsTTS(text);
      const resource = createAudioResource(audioStream, { inputType: undefined });

      const player = getPlayer(msg.guild.id);
      conn.subscribe(player);
      player.play(resource);

      // (opcional) esperar terminar
      await new Promise((resolve) => {
        const onIdle = () => {
          player.off(AudioPlayerStatus.Idle, onIdle);
          resolve();
        };
        player.on(AudioPlayerStatus.Idle, onIdle);
      });

      return;
    }
  } catch (err) {
    console.error(err);
    try {
      await msg.reply(`Deu erro: \`${String(err.message || err).slice(0, 180)}\``);
    } catch {}
  }
});

client.login(DISCORD_TOKEN);
