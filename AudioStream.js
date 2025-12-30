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
    this.opusStream = null;

    this.lastInputLog = 0;
    this.lastOutputLog = 0;

    this.outputBuffer = null;
    this.resampler = null;
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
    this.inputDecoder.on('error', () => {
      this.log.warn?.('⚠️ Decoder glitch ignored');
    });

    this.opusStream.on('error', () => {});
    this.opusStream.pipe(this.inputDecoder);

    this.inputDecoder.on('data', (chunk) => {
      try {
        const downsampled = this._downsample(chunk);
        this._handleInputChunk(downsampled);
      } catch (err) {
        this.log.warn?.('Erro ao processar áudio de entrada', err?.message || err);
      }
    });
  }

  _setupOutputPipeline() {
    this.outputBuffer = new PassThrough();
    this.outputBuffer.on('error', () => {});

    this.resampler = new prism.FFmpeg({
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
    this.resampler.on('error', () => {});

    if (this.resampler.process?.stderr) {
      this.resampler.process.stderr.on('data', (d) => {
        const log = d.toString();
        if (log.includes('Error') || log.includes('Warning')) {
          console.log('🔴 FFmpeg Stderr:', log);
        }
      });
    }

    this.outputBuffer.pipe(this.resampler);
    this.outputBuffer.on('data', () => process.stdout.write('.'));
    this.resampler.on('data', () => process.stdout.write('*'));

    this.player = createAudioPlayer();
    this.player.on('stateChange', (oldState, newState) => {
      console.log(`📀 Player State: ${oldState.status} -> ${newState.status}`);
    });
    this.player.on('error', () => {});

    const resource = createAudioResource(this.resampler, {
      inputType: StreamType.Raw,
    });

    resource.playStream?.on?.('error', (e) => console.log('❌ Resource Error:', e));

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
    if (!chunk?.length) return;

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          user_audio_chunk: chunk.toString('base64'),
        }),
      );

      const now = Date.now();
      if (now - this.lastInputLog > 1000) {
        this.log.info?.('🎤 Mic OK');
        this.lastInputLog = now;
      }
    }
  }

  _handleWebSocketMessage(data) {
    try {
      const parsed = JSON.parse(data.toString());
      const payload = parsed?.data ?? parsed;
      const audioBase64 = payload?.audio_event?.audio_base_64 || payload?.audio_base_64;

      if (audioBase64) {
        this.outputBuffer?.write(Buffer.from(audioBase64, 'base64'));
        const now = Date.now();
        if (now - this.lastOutputLog > 1000) {
          this.log.info?.('✅ Output Audio');
          this.lastOutputLog = now;
        }
        return;
      }

      if (payload?.type === 'ping') {
        return;
      }
    } catch (err) {
      this.log.warn?.('Mensagem inesperada do WebSocket', err?.message || err);
    }
  }

  _downsample(chunk) {
    const sampleCount = Math.floor(chunk.length / 2);
    const outputSamples = Math.floor(sampleCount / 3);
    if (outputSamples <= 0) {
      return Buffer.alloc(0);
    }

    const output = Buffer.allocUnsafe(outputSamples * 2);

    for (let i = 0; i < outputSamples; i += 1) {
      const value = chunk.readInt16LE(i * 3 * 2);
      output.writeInt16LE(value, i * 2);
    }

    return output;
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
      this.outputBuffer?.destroy();
    } catch {}
    this.outputBuffer = null;
    try {
      this.resampler?.destroy();
    } catch {}
    this.resampler = null;

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
