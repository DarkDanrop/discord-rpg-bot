const { PassThrough } = require('node:stream');
const WebSocket = require('ws');
const prism = require('prism-media');
const ffmpegPath = require('ffmpeg-static');
const {
  EndBehaviorType,
  StreamType,
  createAudioPlayer,
  createAudioResource,
  entersState,
  VoiceConnectionStatus,
} = require('@discordjs/voice');

function startRealtimeBridge(connection, userId, options) {
  const {
    agentId,
    apiKey,
    log = console,
  } = options || {};

  if (!agentId) {
    throw new Error('agentId é obrigatório para iniciar o streaming em tempo real.');
  }

  if (!apiKey) {
    throw new Error('apiKey é obrigatório para iniciar o streaming em tempo real.');
  }

  let stopped = false;
  const receiver = connection.receiver;
  const opusStream = receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.Manual },
  });

  const decoder = new prism.opus.Decoder({
    rate: 48000,
    channels: 1,
    frameSize: 960,
  });

  decoder.on('error', (err) => {
    log.error?.('Erro no decoder:', err?.message || err);
  });

  const ffmpeg = new prism.FFmpeg({
    command: ffmpegPath,
    args: [
      '-f',
      's16le',
      '-ar',
      '48000',
      '-ac',
      '1',
      '-i',
      '-',
      '-f',
      's16le',
      '-ar',
      '16000',
      '-ac',
      '1',
    ],
  });

  ffmpeg.on('error', (err) => {
    log.error?.('Erro no ffmpeg:', err?.message || err);
  });

  const downsampledStream = opusStream.pipe(decoder).pipe(ffmpeg);
  const speakerStream = new PassThrough();

  const player = createAudioPlayer();
  const resource = createAudioResource(speakerStream, {
    inputType: StreamType.Raw,
  });

  const subscription = connection.subscribe(player);
  player.play(resource);

  let ws = null;

  function stop(reason) {
    if (stopped) return;
    stopped = true;

    log.info?.(`Encerrando bridge de voz${reason ? `: ${reason}` : ''}`);

    try { downsampledStream.off('data', handlePcmData); } catch {}
    try { opusStream.destroy(); } catch {}
    try { decoder.destroy(); } catch {}
    try { ffmpeg.destroy(); } catch {}
    try { speakerStream.end(); } catch {}
    try { player.stop(); } catch {}
    try { subscription.unsubscribe(); } catch {}
    try { ws?.close(); } catch {}
  }

  function handlePcmData(chunk) {
    if (ws?.readyState === WebSocket.OPEN) {
      const payload = { user_audio_chunk: chunk.toString('base64') };
      ws.send(JSON.stringify(payload));
    }
  }

  function pushIncomingAudio(buffer) {
    speakerStream.write(buffer);
  }

  downsampledStream.on('data', handlePcmData);
  opusStream.on('error', (err) => {
    log.error?.('Erro no opusStream:', err?.message || err);
    stop('erro no opusStream');
  });

  entersState(connection, VoiceConnectionStatus.Ready, 20_000)
    .then(() => {
      ws = new WebSocket(
        `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(agentId)}`,
        {
          headers: {
            'xi-api-key': apiKey,
          },
        }
      );

      ws.on('open', () => {
        log.info?.('Conectado à Conversational AI (WebSocket)');
      });

      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          pushIncomingAudio(data);
          return;
        }

        try {
          const parsed = JSON.parse(data.toString());
          const base64Audio = parsed?.data?.audio_event?.audio_base_64;

          if (base64Audio) {
            pushIncomingAudio(Buffer.from(base64Audio, 'base64'));
          }
        } catch (err) {
          log.warn?.('Mensagem não-binária inesperada do WebSocket', err?.message || err);
        }
      });

      ws.on('close', (code, reason) => {
        const readableReason = reason?.toString?.() || '';
        stop(`WebSocket fechado (${code}) ${readableReason}`.trim());
      });

      ws.on('error', (err) => {
        log.error?.('Erro no WebSocket:', err?.message || err);
        stop('erro no WebSocket');
      });
    })
    .catch((err) => {
      log.error?.('Conexão de voz não ficou pronta:', err?.message || err);
      stop('voice connection não pronta');
    });

  return {
    ws,
    stop,
  };
}

module.exports = { startRealtimeBridge };
