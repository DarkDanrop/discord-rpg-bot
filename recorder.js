const fs = require('node:fs');
const path = require('node:path');
const prism = require('prism-media');

const {
  joinVoiceChannel,
  EndBehaviorType,
  getVoiceConnection,
} = require('@discordjs/voice');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// Railway: grava em /tmp (é o lugar “mais seguro” em containers)
function getRecordingsDir() {
  const base = process.env.RECORDINGS_DIR || '/tmp';
  return path.join(base, 'recordings');
}

async function joinAndRecord(client, guildId, voiceChannelId) {
  const guild = await client.guilds.fetch(guildId);
  const channel = await guild.channels.fetch(voiceChannelId);

  // 2 = GuildVoice no discord.js v14
  if (!channel || channel.type !== 2) {
    throw new Error('VOICE_CHANNEL_ID não parece ser um canal de voz válido.');
  }

  const recordingsDir = getRecordingsDir();
  ensureDir(recordingsDir);

  console.log(`Entrando no canal de voz: ${channel.name}`);
  console.log(`Gravando em: ${recordingsDir}`);

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
  });

  // evita conexão duplicada se rodar 2 instâncias
  const existing = getVoiceConnection(guild.id);
  if (existing && existing !== connection) {
    try { existing.destroy(); } catch {}
  }

  const receiver = connection.receiver;

  // userId -> streams
  const active = new Map();

  function cleanup(userId) {
    const s = active.get(userId);
    if (!s) return;
    active.delete(userId);

    try { s.opusStream.unpipe(); } catch {}
    try { s.decoder.destroy(); } catch {}
    try { s.opusStream.destroy(); } catch {}
    try { s.out.end(); } catch {}

    console.log(`✅ finalizou: ${s.filename}`);
  }

  function startUser(userId) {
    if (active.has(userId)) return;
    if (client.user && userId === client.user.id) return;

    const filename = path.join(recordingsDir, `${userId}-${nowStamp()}.pcm`);

    const opusStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 250,
      },
    });

    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });

    const out = fs.createWriteStream(filename);

    opusStream.pipe(decoder).pipe(out);

    // qualquer finalização/erro limpa tudo (evita “push after EOF”)
    opusStream.once('end', () => cleanup(userId));
    opusStream.once('close', () => cleanup(userId));
    opusStream.once('error', () => cleanup(userId));
    decoder.once('error', () => cleanup(userId));
    out.once('error', () => cleanup(userId));

    active.set(userId, { opusStream, decoder, out, filename });
    console.log(`🎙️ gravando userId=${userId} -> ${filename}`);
  }

  function stopUser(userId) {
    const s = active.get(userId);
    if (!s) return;
    try { s.opusStream.destroy(); } catch {}
  }

  receiver.speaking.on('start', startUser);
  receiver.speaking.on('end', stopUser);

  console.log('✅ pronto: fale no canal e verifique os .pcm em recordings/');
}

module.exports = { joinAndRecord };
