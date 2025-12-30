const { Transform } = require('node:stream');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const prism = require('prism-media');
const {
  EndBehaviorType,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
} = require('@discordjs/voice');
const ffmpegPath = require('ffmpeg-static');

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
    this.aiInputStream = null;
    this.ffmpegProcess = null;
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
    const args = [
      '-f',
      's16le',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-i',
      'pipe:0',
      '-f',
      's16le',
      '-ar',
      '48000',
      '-ac',
      '2',
      'pipe:1',
    ];

    if (!ffmpegPath) {
      throw new Error('ffmpeg-static não forneceu um caminho válido para o binário FFmpeg.');
    }

    this.ffmpegProcess = spawn(ffmpegPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.ffmpegProcess.on('error', (err) => {
      this.log.error?.('Erro no FFmpeg:', err?.message || err);
    });
    this.ffmpegProcess.stderr.on('data', (data) => {
      const message = data?.toString?.();
      if (message) {
        console.log('FFmpeg Debug:', message.trimEnd());
      }
    });
    this.ffmpegProcess.on('close', (code, signal) => {
      const codeInfo = Number.isInteger(code) ? `code ${code}` : 'code N/A';
      const signalInfo = signal ? `, signal ${signal}` : '';
      this.log.info?.(`FFmpeg process closed (${codeInfo}${signalInfo})`);
    });
    this.ffmpegProcess.stdin.on('error', (err) => {
      if (err?.code === 'EPIPE') {
        this.log.warn?.('FFmpeg stdin closed (EPIPE)');
        return;
      }
      this.log.error?.('Erro no stdin do FFmpeg:', err?.message || err);
    });

    this.aiInputStream = this.ffmpegProcess.stdin;

    this.player = createAudioPlayer();
    this.player.on('error', console.error);

    const resource = createAudioResource(this.ffmpegProcess.stdout, {
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
      this.log.info?.('🎤 Input sent:', chunk.length);
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
      const eventType = parsed?.type ?? parsed?.data?.type;

      console.log('📩 WS Message Type:', eventType);

      const base64Audio = parsed?.data?.audio_event?.audio_base_64;

      if (base64Audio && this.aiInputStream) {
        const decodedBuffer = Buffer.from(base64Audio, 'base64');
        console.log('🔊 Buffered Audio Chunk', decodedBuffer.length);
        this.aiInputStream.write(decodedBuffer);
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
      this.ffmpegProcess?.kill();
    } catch {}
    this.ffmpegProcess = null;
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
