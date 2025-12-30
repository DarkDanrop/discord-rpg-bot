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

  const speakerStream = new PassThrough();

  const player = createAudioPlayer();
  const resource = createAudioResource(speakerStream, {
    inputType: StreamType.Raw,
  });

  const subscription = connection.subscribe(player);
  player.play(resource);

  let ws = null;
  let pipeline = null;
  let pcmChunkCount = 0;

  function destroyPipeline(reason) {
    if (!pipeline) return;

    log.info?.(
      `Destruindo pipeline de áudio${reason ? ` (${reason})` : ''}`
    );

    try { pipeline.downsampledStream?.off('data', pipeline.handleData); } catch {}
    try { opusStream.unpipe(pipeline.decoder); } catch {}
    try { pipeline.decoder.unpipe?.(pipeline.ffmpeg); } catch {}
    try { pipeline.decoder.destroy(); } catch {}
    try { pipeline.ffmpeg.destroy(); } catch {}

    pipeline = null;
  }

  function handlePcmData(chunk) {
    if (ws?.readyState === WebSocket.OPEN) {
      pcmChunkCount += 1;
      if (pcmChunkCount <= 3 || pcmChunkCount % 50 === 0) {
        console.log('🎤 Sending chunk...');
      }

      const payload = { user_audio_chunk: chunk.toString('base64') };
      ws.send(JSON.stringify(payload));
    }
  }

  function createPipeline() {
    if (stopped) return;

    destroyPipeline('reiniciando');

    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 1,
      frameSize: 960,
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

    decoder.on('error', (err) => {
      log.warn?.('⚠️ Packet dropped (decoder error):', err?.message || err);
    });

    ffmpeg.on('error', (err) => {
      log.warn?.('⚠️ FFmpeg reported an error:', err?.message || err);
    });

    const downsampledStream = opusStream.pipe(decoder).pipe(ffmpeg);

    pipeline = {
      decoder,
      ffmpeg,
      downsampledStream,
      handleData: handlePcmData,
    };

    downsampledStream.on('data', handlePcmData);
  }

  function stop(reason) {
    if (stopped) return;
    stopped = true;

    log.info?.(`Encerrando bridge de voz${reason ? `: ${reason}` : ''}`);

    try { destroyPipeline('stop chamado'); } catch {}
    try { opusStream.destroy(); } catch {}
    try { speakerStream.end(); } catch {}
    try { player.stop(); } catch {}
    try { subscription.unsubscribe(); } catch {}
    try { ws?.close(); } catch {}
  }

  function pushIncomingAudio(buffer) {
    speakerStream.write(buffer);
  }

  createPipeline();

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
          console.log('🔊 Received audio from AI');
          pushIncomingAudio(data);
          return;
        }

        try {
          const parsed = JSON.parse(data.toString());
          const base64Audio = parsed?.data?.audio_event?.audio_base_64;

          if (base64Audio) {
            console.log('🔊 Received audio from AI');
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
