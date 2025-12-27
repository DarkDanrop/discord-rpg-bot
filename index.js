import { Client, GatewayIntentBits } from "discord.js";
import {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  StreamType
} from "@discordjs/voice";
import prism from "prism-media";
import WebSocket from "ws";
import { PassThrough, Readable } from "stream";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;

if (!DISCORD_TOKEN) throw new Error("❌ Falta DISCORD_TOKEN");
if (!ELEVENLABS_API_KEY) throw new Error("❌ Falta ELEVENLABS_API_KEY");
if (!ELEVENLABS_AGENT_ID) throw new Error("❌ Falta ELEVENLABS_AGENT_ID");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const stateByGuild = new Map(); // guildId -> { ws, audioOut, player }

function downsample48kTo16k(pcm48k) {
  // pcm48k: Buffer int16 LE mono @48000
  // 48k -> 16k = fator 3: pega 1 a cada 3 samples
  const in16 = new Int16Array(pcm48k.buffer, pcm48k.byteOffset, Math.floor(pcm48k.length / 2));
  const outLen = Math.floor(in16.length / 3);
  const out16 = new Int16Array(outLen);
  for (let i = 0, j = 0; j < outLen; i += 3, j++) out16[j] = in16[i];
  return Buffer.from(out16.buffer);
}

function upsample16kTo48k(pcm16k) {
  // 16k -> 48k = fator 3: repete samples (simples e ok pra voz)
  const in16 = new Int16Array(pcm16k.buffer, pcm16k.byteOffset, Math.floor(pcm16k.length / 2));
  const out16 = new Int16Array(in16.length * 3);
  for (let i = 0; i < in16.length; i++) {
    const v = in16[i];
    const o = i * 3;
    out16[o] = v;
    out16[o + 1] = v;
    out16[o + 2] = v;
  }
  return Buffer.from(out16.buffer);
}

async function getSignedUrl(agentId) {
  // GET https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=...
  const url = `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`;
  const res = await fetch(url, { headers: { "xi-api-key": ELEVENLABS_API_KEY } });
  if (!res.ok) throw new Error(`Signed URL erro ${res.status}`);
  const json = await res.json();
  if (!json?.signed_url) throw new Error("Signed URL inválida");
  return json.signed_url;
}

function ensureGuildState(guildId) {
  let s = stateByGuild.get(guildId);
  if (!s) {
    s = { ws: null, audioOut: null, player: createAudioPlayer() };
    stateByGuild.set(guildId, s);
  }
  return s;
}

async function connectAgentWS(guild) {
  const s = ensureGuildState(guild.id);
  if (s.ws) return s.ws;

  const signedUrl = await getSignedUrl(ELEVENLABS_AGENT_ID);
  const ws = new WebSocket(signedUrl);

  ws.on("open", () => {
    console.log("✅ Agent WS conectado");

    // opcional: override de config (prompt/voz/etc)
    ws.send(JSON.stringify({
      type: "conversation_initiation_client_data",
      dynamic_variables: {
        // exemplo: você pode passar coisas do Discord aqui
        guild_name: guild.name
      }
    }));
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === "ping") {
        // responder pong
        ws.send(JSON.stringify({ type: "pong", event_id: msg.ping_event?.event_id }));
        return;
      }

      if (msg.type === "conversation_initiation_metadata") {
        console.log("🧠 conversation_id:", msg.conversation_initiation_metadata_event?.conversation_id);
        console.log("🎚️ formatos:", msg.conversation_initiation_metadata_event);
        return;
      }

      if (msg.type === "audio" && msg.audio_event?.audio_base_64) {
        const pcm16k = Buffer.from(msg.audio_event.audio_base_64, "base64");
        const pcm48k = upsample16kTo48k(pcm16k);
        // manda pro stream de saída contínuo
        if (s.audioOut) s.audioOut.write(pcm48k);
        return;
      }

      // úteis pra debug
      if (msg.type === "user_transcript") {
        console.log("🗣️ transcript:", msg.user_transcription_event?.user_transcript);
      }
      if (msg.type === "agent_response") {
        console.log("🤖 resposta:", msg.agent_response_event?.agent_response);
      }
    } catch (e) {
      // mensagens não-JSON (raro) ou parse error
      console.log("WS msg (raw):", data.toString().slice(0, 200));
    }
  });

  ws.on("close", () => {
    console.log("⚠️ Agent WS desconectou");
    s.ws = null;
  });

  ws.on("error", (err) => console.error("WS erro:", err));

  s.ws = ws;
  return ws;
}

function startAudioOutput(conn, guild) {
  const s = ensureGuildState(guild.id);

  // stream contínuo de PCM 48k mono 16-bit
  const out = new PassThrough();
  s.audioOut = out;

  conn.subscribe(s.player);

  const resource = createAudioResource(out, { inputType: StreamType.Raw });
  s.player.play(resource);

  console.log("🎧 Audio output iniciado (tocando respostas do agent)");
}

function startAudioInput(conn, guild) {
  const s = ensureGuildState(guild.id);
  const receiver = conn.receiver;

  // assina áudio de TODAS as pessoas que falarem no canal
  receiver.speaking.on("start", async (userId) => {
    try {
      if (!s.ws || s.ws.readyState !== WebSocket.OPEN) return;

      const opusStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 600 }
      });

      const decoder = new prism.opus.Decoder({
        rate: 48000,
        channels: 1,
        frameSize: 960
      });

      opusStream.pipe(decoder);

      decoder.on("data", (pcm48k) => {
        // converte e manda em chunk pro agent
        const pcm16k = downsample48kTo16k(pcm48k);
        const b64 = pcm16k.toString("base64");
        s.ws.send(JSON.stringify({ user_audio_chunk: b64 }));
      });

      decoder.on("end", () => {});
      decoder.on("error", () => {});
    } catch (e) {
      console.error("input stream erro:", e);
    }
  });

  console.log("🎙️ Audio input iniciado (enviando voz pro agent)");
}

client.once("ready", () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
  console.log("Comandos: !ping | !join | !leave");
});

client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  const content = msg.content.trim().toLowerCase();

  if (content === "!ping") {
    await msg.reply("pong ✅");
    return;
  }

  if (content === "!join") {
    const member = await msg.guild.members.fetch(msg.author.id);
    const voiceChannel = member?.voice?.channel;

    if (!voiceChannel) {
      await msg.reply("Entra num canal de voz e manda **!join** aqui 🙂");
      return;
    }

    const conn = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: msg.guild.id,
      adapterCreator: msg.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false
    });

    await connectAgentWS(msg.guild);

    startAudioOutput(conn, msg.guild);
    startAudioInput(conn, msg.guild);

    await msg.reply(`🎙️ Entrei em **${voiceChannel.name}** e conectei no ElevenLabs Agent (sempre ligado).`);
    return;
  }

  if (content === "!leave") {
    const conn = getVoiceConnection(msg.guild.id);
    if (conn) conn.destroy();

    const s = ensureGuildState(msg.guild.id);
    if (s.ws) s.ws.close();
    s.ws = null;

    if (s.audioOut) s.audioOut.end();
    s.audioOut = null;

    await msg.reply("👋 Saí do canal e fechei o Agent WS.");
    return;
  }
});

client.login(DISCORD_TOKEN);
