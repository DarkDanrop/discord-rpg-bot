const { PassThrough } = require('stream');
const WebSocket = require('ws');
const prism = require('prism-media');

prism.FFmpeg.getPath = () => require('ffmpeg-static');

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

    this.inputDecoder = null;
    this.inputResampler = null;
    this.opusStream = null;

    this.outputBuffer = null;
    this.outputResampler = null;
    this.encoder = null;
  }

  async start() {
    if (this.stopped) return;

    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);

    this._setupInputPipeline();
    this._setupOutputPipeline();
    this._connectWebSocket();
  }

  _setupInputPipeline() {
    this.opusStream = this.connection.receiver.subscribe(this.userId, {
      end: { behavior: EndBehaviorType.Manual },
    });

    this.inputDecoder = new prism.opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 });
    this.inputDecoder.on('error', () => {});

    this.inputResampler = new prism.FFmpeg({
      args: [
        '-analyseduration',
        '0',
        '-tune',
        'zerolatency',
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
    this.inputResampler.on('error', () => {});

    this.opusStream
      .on('error', () => {})
      .pipe(this.inputDecoder)
      .pipe(this.inputResampler)
      .on('data', (chunk) => this._handleInputChunk(chunk));
  }

  _setupOutputPipeline() {
    this.outputBuffer = new PassThrough();
    this.outputBuffer.on('error', () => {});

    this.outputResampler = new prism.FFmpeg({
      args: [
        '-analyseduration',
        '0',
        '-tune',
        'zerolatency',
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
        '2',
      ],
    });
    this.outputResampler.on('error', () => {});

    this.encoder = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
    this.encoder.on('error', () => {});

    this.outputBuffer.pipe(this.outputResampler).pipe(this.encoder);

    this.player = createAudioPlayer();
    this.player.on('error', () => {});

    const resource = createAudioResource(this.encoder, {
      inputType: StreamType.Opus,
    });

    this.subscription = this.connection.subscribe(this.player);
    this.player.play(resource);
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

    this.ws.on('ping', () => {});

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
      const audioBase64 = payload?.audio_event?.audio_base_64 || payload?.audio_base_64;

      if (audioBase64) {
        this.outputBuffer?.write(Buffer.from(audioBase64, 'base64'));
        this.log.info?.('✅ Audio Chunk Received');
        return;
      }

      if (payload?.type === 'ping') {
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
      this.opusStream?.destroy();
    } catch {}
    this.opusStream = null;
    try {
      this.inputDecoder?.destroy();
    } catch {}
    this.inputDecoder = null;
    try {
      this.inputResampler?.destroy();
    } catch {}
    this.inputResampler = null;

    try {
      this.outputBuffer?.destroy();
    } catch {}
    this.outputBuffer = null;
    try {
      this.outputResampler?.destroy();
    } catch {}
    this.outputResampler = null;
    try {
      this.encoder?.destroy();
    } catch {}
    this.encoder = null;

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
