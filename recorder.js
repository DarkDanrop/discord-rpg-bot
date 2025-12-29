import fs from 'node:fs';
import path from 'node:path';
import prism from 'prism-media';

import {
  joinVoiceChannel,
  EndBehaviorType,
  getVoiceConnection,
} from '@discordjs/voice';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function nowStamp() {
  const d = new Date();
  // yyyy-mm-dd_hh-mm-ss
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/**
 * Entra no canal e grava cada usuário em um .pcm separado
 * (Etapa 1 = estabilidade do Opus + não quebrar em EOF)
 */
export async function joinAndRecord(client, guildId, voiceChannelId) {
  const guild = await client.guilds.fetch(guildId);
  const channel = await guild.channels.fetch(voiceChannelId);

  if (!channel || channel.type !== 2) { // 2 = GuildVoice (VoiceChannel)
    throw new Error('VOICE_CHANNEL_ID não parece ser um canal de voz válido.');
  }

  const recordingsDir = path.resolve(process.cwd(), 'recordings');
  ensureDir(recordingsDir);

  console.log(`Entrando no canal de voz: ${channel.name}`);

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,  // importante: ouvir todo mundo
    selfMute: true,   // bot não fala
  });

  const receiver = connection.receiver;

  // Estado: 1 stream ativo por userId
  const active = new Map(); // userId -> { opusStream, decoder, out, filename }

  function cleanup(userId) {
    const s = active.get(userId);
    if (!s) return;

    active.delete(userId);

    try { s.opusStream.unpipe(); } catch {}
    try { s.decoder.destroy(); } catch {}
    try { s.opusStream.destroy(); } catch {}
    try { s.out.end(); } catch {}

    console.log(`✅ finalizou gravação: ${s.filename}`);
  }

  function startUser(userId) {
    if (active.has(userId)) return; // ignora start duplicado

    const filename = path.join(recordingsDir, `${userId}-${nowStamp()}.pcm`);

    // pega o stream opus do usuário
    const opusStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 250, // ms de silêncio pra encerrar
      },
    });

    // decoder opus -> PCM
    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960, // 20ms @ 48k
    });

    const out = fs.createWriteStream(filename);

    // pipeline: opus -> decoder -> arquivo
    opusStream.pipe(decoder).pipe(out);

    // Se qualquer coisa terminar/der erro, limpa tudo (evita push-after-eof)
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
    if (!s) return; // ignora end duplicado
    try { s.opusStream.destroy(); } catch {}
  }

  // Eventos de fala (o que tava te quebrando)
  receiver.speaking.on('start', (userId) => {
    // opcional: ignorar o próprio bot
    if (client.user && userId === client.user.id) return;
    startUser(userId);
  });

  receiver.speaking.on('end', (userId) => {
    if (client.user && userId === client.user.id) return;
    stopUser(userId);
  });

  // Só pra evitar conexões duplicadas caso você rode 2x
  const existing = getVoiceConnection(guild.id);
  if (existing && existing !== connection) {
    try { existing.destroy(); } catch {}
  }

  console.log('✅ pronto: fale no canal e veja arquivos aparecendo em /recordings');
}
