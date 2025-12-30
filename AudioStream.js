const { PassThrough, Transform } = require('node:stream');
const WebSocket = require('ws');
const prism = require('prism-media');

try {
  prism.FFmpeg.getPath = () => require('ffmpeg-static');
} catch {}
const {
  EndBehaviorType,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
} = require('@discordjs/voice');

class AudioStream {
  constructor(connection, userId, options = {}) {
    const { agentId, apiKey, log = console } = options;

    if (!agentId) {
      throw new Error('agentId é obrigatório para iniciar o streaming em tempo real.');
    }

    if (!apiKey) {
      throw new Error('apiKey é obrigatório para iniciar o streaming em tempo real.');
    }

    this.connection = connection;
    this.userId = userId;
    this.agentId = agentId;
    this.apiKey = apiKey;
    this.log = log;

    this.stopped = false;
    this.ws = null;
    this.subscription = null;
    this.player = null;
    this.ffmpegStream = null;
    this.inputStream = null;
    this.opusStream = null;
    this.inputDecoder = null;
    this.downsampleStream = null;
  }

  async start() {
    if (this.stopped) return;

    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);

    this._setupOutputPipeline();
    this._setupInputPipeline();
    this._connectWebSocket();
  }

  _setupOutputPipeline() {
    this.inputStream = new PassThrough();
    this.ffmpegStream = new prism.FFmpeg({
      args: [
        '-analyseduration',
        '0',
        '-tune',
        'zerolatency',
        '-flags',
        'low_delay',
        '-f',
        's16le',
        '-ar',
        '16000',
        '-ac',
        '1',
        '-i',
        '-',
        '-c:a',
        'libopus',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-b:a',
        '96k',
        '-f',
        'ogg',
      ],
    });

    this.ffmpegStream.on('error', (err) => {
      this.log.error?.('Erro no FFmpeg:', err?.message || err);
    });

    this.ffmpegStream.on('data', (c) => {
      console.log('🟢 Outputting Opus chunk:', c.length);
    });

    this.inputStream.pipe(this.ffmpegStream);

    this.player = createAudioPlayer();
    this.player.on('error', (err) => {
      this.log.error?.('Erro no player de áudio:', err?.message || err);
    });

    const resource = createAudioResource(this.ffmpegStream, {
      inputType: StreamType.OggOpus,
    });

    this.subscription = this.connection.subscribe(this.player);
    this.player.play(resource);
  }

  _setupInputPipeline() {
    this.opusStream = this.connection.receiver.subscribe(this.userId, {
      end: { behavior: EndBehaviorType.Manual },
    });

    this.inputDecoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 1,
      frameSize: 960,
    });

    this.inputDecoder.on('error', (err) => {
      this.log.warn?.('Opus error ignored', err?.message || err);
    });

    this.downsampleStream = new Transform({
      transform(chunk, _encoding, callback) {
        // chunk is 16-bit PCM mono @ 48000Hz. Keep every 3rd sample to reach 16000Hz.
        const output = Buffer.alloc(Math.floor(chunk.length / 6) * 2);

        for (let readOffset = 0, writeOffset = 0; readOffset + 1 < chunk.length; readOffset += 6, writeOffset += 2) {
          output[writeOffset] = chunk[readOffset];
          output[writeOffset + 1] = chunk[readOffset + 1];
        }

        callback(null, output);
      },
    });

    const downsampledStream = this.opusStream
      .pipe(this.inputDecoder)
      .pipe(this.downsampleStream);

    downsampledStream.on('data', (chunk) => this._handleInputChunk(chunk));

    this.opusStream.on('error', (err) => {
      this.log.error?.('Erro no opusStream:', err?.message || err);
      this.stop('erro no opusStream');
    });
  }

  _connectWebSocket() {
    const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(
      this.agentId,
    )}&output_format=pcm_16000`;

    this.ws = new WebSocket(url, {
      headers: {
        'xi-api-key': this.apiKey,
      },
    });

    this.ws.on('open', () => {
      this.log.info?.('Conectado à Conversational AI (WebSocket)');
    });

    this.ws.on('message', (data) => this._handleWebSocketMessage(data));

    this.ws.on('ping', () => {
      this.log.info?.('Ping received');
    });

    this.ws.on('close', (code, reason) => {
      const readableReason = reason?.toString?.() || '';
      this.stop(`WebSocket fechado (${code}) ${readableReason}`.trim());
    });

    this.ws.on('error', (err) => {
      this.log.error?.('Erro no WebSocket:', err?.message || err);
      this.stop('erro no WebSocket');
    });
  }

  _handleInputChunk(chunk) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          user_audio_chunk: chunk.toString('base64'),
        }),
      );
    }
  }

  _handleWebSocketMessage(data) {
    try {
      const parsed = JSON.parse(data.toString());
      const payload = parsed?.data ?? parsed;

      const audioBase64 =
        payload?.audio_event?.audio_base_64 || payload?.audio_base_64;

      if (audioBase64) {
        if (this.inputStream?.writable) {
          this.inputStream.write(Buffer.from(audioBase64, 'base64'));
          this.log.info?.('✅ Input Buffer Written');
          this.log.info?.('✅ Received Audio Chunk of size:', audioBase64.length);
        }
        return;
      }

      if (payload?.type === 'ping') {
        this.log.info?.('Ping');
        return;
      }

    } catch (err) {
      this.log.warn?.('Mensagem inesperada do WebSocket', err?.message || err);
    }
  }

  stop(reason) {
    if (this.stopped) return;
    this.stopped = true;

    this.log.info?.(`Encerrando AudioStream${reason ? `: ${reason}` : ''}`);

    try {
      this.downsampleStream?.destroy();
    } catch {}
    try {
      this.inputDecoder?.destroy();
    } catch {}
    try {
      this.opusStream?.destroy();
    } catch {}
    try {
      this.inputStream?.destroy();
    } catch {}
    this.inputStream = null;
    try {
      this.ffmpegStream?.destroy();
    } catch {}
    this.ffmpegStream = null;
    try {
      this.player?.stop();
    } catch {}
    try {
      this.subscription?.unsubscribe();
    } catch {}
    try {
      this.ws?.close();
    } catch {}
  }
}

module.exports = { AudioStream };
