import { Client, GatewayIntentBits } from "discord.js";
import {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  StreamType,
} from "@discordjs/voice";
import prism from "prism-media";
import WebSocket from "ws";
import { PassThrough } from "stream";

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
    GatewayIntentBits.MessageContent,
  ],
});

const guildState = new Map(); // guildId -> { ws, out, player, conn }

function getState(guildId) {
  let s = guildState.get(guildId);
  if (!s) {
    s = { ws: null, out: null, player: createAudioPlayer(), conn: null };
    guildState.set(guildId, s);
  }
  return s;
}

// Discord receiver -> PCM 48k int16 mono
// Eleven convai audio -> PCM 16k int16 mono (na prática, é o formato mais comum)
// Vamos fazer downsample/upsample simples (x3) pra funcionar.
function downsample48kTo16k(pcm48k) {
  const input = new Int16Array(pcm48k.buffer, pcm48k.byteOffset, Math.floor(pcm48k.length / 2));
  const outLen = Math.floor(input.length / 3);
  const out = new Int16Array(outLen);
  for (let i = 0, j = 0; j < outLen; i += 3, j++) out[j] = input[i];
  return Buffer.from(out.buffer);
}

function upsample16kTo48k(pcm16k) {
  const input = new Int16Array(pcm16k.buffer, pcm16k.byteOffset, Math.floor(pcm16k.length / 2));
  const out = new Int16Array(input.length * 3);
  for (let i = 0; i < input.length; i++) {
    const v = input[i];
    const o = i * 3;
    out[o] = v;
    out[o + 1] = v;
    out[o + 2] = v;
  }
  return Buffer.from(out.buffer);
}

async function getSignedUrl() {
  const url = `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(
    ELEVENLABS_AGENT_ID
  )}`;

  const res = await fetch(url, {
    headers: { "xi-api-key": ELEVENLABS_API_KEY },
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`❌ get-signed-url ${res.status}: ${t.slice(0, 200)}`);
  }

  const json = await res.json();
  if (!json?.signed_url) throw new Error("❌ signed_url não veio na resposta");
  return json.signed_url;
}

async function connectAgent(guild) {
  const s = getState(guild.id);
  if (s.ws && s.ws.readyState === WebSocket.OPEN) return s.ws;

  const signedUrl = await getSignedUrl();
  const ws = new WebSocket(signedUrl);

  ws.on("open", () => {
    console.log("✅ Agent WS conectado");

    // “empurrão” pra modo conversa (ajuda o agent a se comportar como player)
    ws.send(
      JSON.stringify({
        type: "conversation_initiation_client_data",
        conversation_config_override: {
          conversation_mode: "conversation",
          response_timing: "natural",
          allow_interruptions: true,
          language: "pt-BR",
        },
        dynamic_variables: {
          guild_name: guild.name,
          context: "mesa de RPG por voz no Discord. Você é um jogador (player), não o mestre.",
        },
      })
    );
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // ping/pong
    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", event_id: msg.ping_event?.event_id }));
      return;
    }

    // debug úteis
    if (msg.type === "conversation_initiation_metadata") {
      const meta = msg.conversation_initiation_metadata_event;
      console.log("🧠 conversation_id:", meta?.conversation_id);
      return;
    }
    if (msg.type === "user_transcript") {
      console.log("🗣️ transcript:", msg.user_transcription_event?.user_transcript);
      return;
    }
    if (msg.type === "agent_response") {
      console.log("🤖 agent_response:", msg.agent_response_event?.agent_response);
      return;
    }

    // áudio do agent
    if (msg.type === "audio" && msg.audio_event?.audio_base_64) {
      const s2 = getState(guild.id);
      if (!s2.out) return;

      const pcm16k = Buffer.from(msg.audio_event.audio_base_64, "base64");
      const pcm48k = upsample16kTo48k(pcm16k);
      s2.out.write(pcm48k);
    }
  });

  ws.on("close", () => {
    console.log("⚠️ Agent WS desconectou");
    const s2 = getState(guild.id);
    s2.ws = null;
  });

  ws.on("error", (e) => console.error("WS erro:", e));

  s.ws = ws;
  return ws;
}

function startOutput(conn, guild) {
  const s = getState(guild.id);

  // stream contínuo de PCM raw 48k mono
  const out = new PassThrough();
  s.out = out;

  conn.subscribe(s.player);
  const resource = createAudioResource(out, { inputType: StreamType.Raw });
  s.player.play(resource);

  console.log("🎧 Output iniciado (tocando áudio do agent no Discord)");
}

function startInput(conn, guild) {
  const s = getState(guild.id);
  const receiver = conn.receiver;

  receiver.speaking.on("start", (userId) => {
    // Só manda áudio quando o WS está pronto
    if (!s.ws || s.ws.readyState !== WebSocket.OPEN) return;

    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 700 },
    });

    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 1,
      frameSize: 960,
    });

    opusStream.pipe(decoder);

    decoder.on("data", (pcm48k) => {
      // anti-eco simples: se você quiser “tudo sempre”, comenta este bloco depois.
      // por enquanto, isso evita o bot re-alimentar a própria fala caso ele seja capturado.
      // (não impede ele de ouvir o mestre e outros humanos.)
      // if (userId === client.user.id) return;

      const pcm16k = downsample48kTo16k(pcm48k);
      const b64 = pcm16k.toString("base64");
      try {
        s.ws.send(JSON.stringify({ user_audio_chunk: b64 }));
      } catch {}
    });

    decoder.on("error", () => {});
  });

  console.log("🎙️ Input iniciado (enviando áudio do Discord pro agent)");
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
    const vc = member?.voice?.channel;
    if (!vc) {
      await msg.reply("Entra em um canal de voz e manda **!join**.");
      return;
    }

    const conn = joinVoiceChannel({
      channelId: vc.id,
      guildId: msg.guild.id,
      adapterCreator: msg.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    const s = getState(msg.guild.id);
    s.conn = conn;

    await connectAgent(msg.guild);
    startOutput(conn, msg.guild);
    startInput(conn, msg.guild);

    await msg.reply(`🎙️ Entrei em **${vc.name}** e conectei no ElevenLabs Agent (sempre ligado).`);
    return;
  }

  if (content === "!leave") {
    const s = getState(msg.guild.id);

    const conn = getVoiceConnection(msg.guild.id);
    if (conn) conn.destroy();

    if (s.ws) s.ws.close();
    s.ws = null;

    if (s.out) s.out.end();
    s.out = null;

    await msg.reply("👋 Saí do canal e fechei o Agent.");
  }
});

client.login(DISCORD_TOKEN);
