const { PassThrough } = require('node:stream');
const WebSocket = require('ws');
const prism = require('prism-media');
const ffmpegPath = require('ffmpeg-static');
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
    this.outputFFmpeg = null;
    this.aiInputStream = null;
    this.opusStream = null;
    this.inputDecoder = null;
    this.inputFFmpeg = null;
  }

  async start() {
    if (this.stopped) return;

    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);

    this._setupOutputPipeline();
    this._setupInputPipeline();
    this._connectWebSocket();
  }

  _setupOutputPipeline() {
    this.aiInputStream = new PassThrough();

    this.outputFFmpeg = new prism.FFmpeg({
      command: ffmpegPath,
      args: [
        '-f',
        's16le',
        '-ar',
        '16000',
        '-ac',
        '1',
        '-i',
        '-',
        '-f',
        's16le',
        '-ar',
        '48000',
        '-ac',
        '1',
      ],
    });

    this.outputFFmpeg.on('error', (err) => {
      this.log.warn?.('⚠️ FFmpeg (output) error:', err?.message || err);
    });

    const speakerStream = this.aiInputStream.pipe(this.outputFFmpeg);

    this.player = createAudioPlayer();
    const resource = createAudioResource(speakerStream, {
      inputType: StreamType.Raw,
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

    this.inputDecoder.on('error', () => {
      // CRITICAL FIX: ignore corrupted silence packets to avoid crashes
    });

    this.inputFFmpeg = new prism.FFmpeg({
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

    this.inputFFmpeg.on('error', (err) => {
      this.log.warn?.('⚠️ FFmpeg (input) error:', err?.message || err);
    });

    const downsampledStream = this.opusStream
      .pipe(this.inputDecoder)
      .pipe(this.inputFFmpeg);

    downsampledStream.on('data', (chunk) => this._handleInputChunk(chunk));

    this.opusStream.on('error', (err) => {
      this.log.error?.('Erro no opusStream:', err?.message || err);
      this.stop('erro no opusStream');
    });
  }

  _connectWebSocket() {
    const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(
      this.agentId,
    )}`;

    this.ws = new WebSocket(url, {
      headers: {
        'xi-api-key': this.apiKey,
      },
    });

    this.ws.on('open', () => {
      this.log.info?.('Conectado à Conversational AI (WebSocket)');
    });

    this.ws.on('message', (data) => this._handleWebSocketMessage(data));

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
      const base64Audio = parsed?.data?.audio_event?.audio_base_64;

      if (base64Audio) {
        const buffer = Buffer.from(base64Audio, 'base64');
        this.aiInputStream?.write(buffer);
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
      this.inputFFmpeg?.destroy();
    } catch {}
    try {
      this.inputDecoder?.destroy();
    } catch {}
    try {
      this.opusStream?.destroy();
    } catch {}
    try {
      this.outputFFmpeg?.destroy();
    } catch {}
    try {
      this.aiInputStream?.destroy();
    } catch {}
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
