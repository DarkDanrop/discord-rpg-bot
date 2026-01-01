const { PassThrough } = require('stream');
const WebSocket = require('ws');
const prism = require('prism-media');

prism.FFmpeg.getPath = () => require('ffmpeg-static');

const VAD_THRESHOLD = 200; // Filters background static so silence truly ends a turn
const DISCORD_SAMPLE_RATE = 48000;
const AI_SAMPLE_RATE = 16000;
const RESPONSE_SILENCE_TIMEOUT_MS = 3000;
const RESPONSE_SILENCE_PADDING_BYTES = 9600; // ~200ms of silence padding
const MAX_WS_RECONNECT_ATTEMPTS = 5;
const MAX_WS_RECONNECT_DELAY_MS = 8000;
const WS_RECONNECT_BASE_DELAY_MS = 1000;

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

    this.currentResponseStream = null;
    this.silenceTimeout = null;

    this.reconnectAttempts = 0;
    this.reconnectTimer = null;

    this.heartbeatInterval = null;

    this.watchdogInterval = null;
    this.lastAudioPacketTime = Date.now();

    this.speakingFrames = 0;
    this.silenceFrames = 0;
    this.isSpeaking = false;
    this.isRecovering = false;
    this.isInterrupting = false;
  }

  /**
   * Bootstraps bidirectional audio once Discord voice is ready.
   * Keeps the battle-tested input/output pipelines intact to avoid regression.
   */
  async start() {
    if (this.stopped) return;

    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);

    this._setupInputPipeline();
    this._setupOutputPipeline();
    this._connectWebSocket();
  }

  /**
   * Manual JS VAD/downsampling to avoid FFmpeg pipe latency and maintain Railway/Discord stability.
   * Handles Discord's stereo input while providing hysteresis-based gating to avoid rapid toggling.
   */
  _setupInputPipeline() {
    this.opusStream = this.connection.receiver.subscribe(this.userId, {
      end: { behavior: EndBehaviorType.Manual },
    });

    this.opusStream.on('error', () => {});

    const setupDecoderStream = () => {
      if (this.stopped) return;

      if (this.inputDecoder) {
        try {
          this.opusStream?.unpipe(this.inputDecoder);
        } catch {}

        try {
          this.inputDecoder.removeAllListeners();
          this.inputDecoder.destroy();
        } catch {}
      }

      const decoder = new prism.opus.Decoder({ rate: DISCORD_SAMPLE_RATE, channels: 2, frameSize: 960 });
      this.inputDecoder = decoder;

      decoder.on('error', () => {
        if (this.isRecovering) return;

        this.isRecovering = true;
        this.log.warn?.('⚠️ Decoder glitch detected. Cooling down...');

        try {
          this.opusStream?.unpipe(decoder);
        } catch {}
        try {
          decoder.destroy();
        } catch {}

        setTimeout(() => {
          if (this.stopped) {
            this.isRecovering = false;
            return;
          }
          setupDecoderStream();
          this.isRecovering = false;
        }, 500);
      });

      decoder.on('data', (chunk) => {
        try {
          const wasSpeaking = this.isSpeaking;
          this.lastAudioPacketTime = Date.now();
          const downsampled = this._downsample(chunk);
          this._handleInputChunk(downsampled);

          if (!wasSpeaking && this.isSpeaking) {
            const isBotActive = this.player?.state?.status !== 'idle';

            if (isBotActive) {
              this.log.info?.('🔥 INTERRUPT TRIGGERED');
              this.isInterrupting = true;
              if (this.player?.state?.status !== 'idle') {
                this.log.info?.('✋ User interrupted bot. Stopping playback.');
                try {
                  this.player.stop();
                } catch {}
              }

              if (this.currentResponseStream) {
                try {
                  this.currentResponseStream.destroy();
                } catch {}
              }
              this.currentResponseStream = null;

              if (this.silenceTimeout) {
                clearTimeout(this.silenceTimeout);
                this.silenceTimeout = null;
              }

              this.speakingFrames = 0;
            }
          }

          const now = Date.now();
          if (now - this.lastInputLog > 3000) {
            this.log.info?.('🎤 User is speaking...');
            this.lastInputLog = now;
          }
        } catch (err) {
          this.log.warn?.('Erro ao processar áudio de entrada', err?.message || err);
        }
      });

      this.opusStream.pipe(decoder);
    };

    setupDecoderStream();

    if (!this.watchdogInterval) {
      this.watchdogInterval = setInterval(() => {
        const timeSinceLastPacket = Date.now() - this.lastAudioPacketTime;

        if (timeSinceLastPacket > 500 && this.isSpeaking) {
          this.isSpeaking = false;
          this.silenceFrames = 0;
          this.isInterrupting = false;
          this.log.info?.('🛑 Watchdog: Stream stopped (Mute detected). Ending turn.');
        }
      }, 200);
    }
  }

  /**
   * Keeps playback isolated and logs transitions so we can spot Discord player hiccups quickly.
   */
  _setupOutputPipeline() {
    this.player = createAudioPlayer();
    this.player.on('stateChange', (oldState, newState) => {
      console.log(`📀 Player State: ${oldState.status} -> ${newState.status}`);
      if (newState.status === 'idle') {
        console.log('⚠️ Player went idle (stream ended?)');
      }
    });
    this.player.on('error', () => {});
    this.subscription = this.connection.subscribe(this.player);
  }

  /**
   * Connects to ElevenLabs WS with reconnection via exponential backoff to survive transient drops.
   */
  _connectWebSocket() {
    const url = `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${encodeURIComponent(
      this.agentId,
    )}&output_format=pcm_16000`;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.ws = new WebSocket(url, {
      headers: {
        'xi-api-key': this.apiKey,
      },
    });

    this.ws.on('open', () => {
      this.log.info?.('Conectado à Conversational AI (WebSocket)');
      this.reconnectAttempts = 0;

      this._startHeartbeat();
    });

    this.ws.on('message', (data) => {
      if (this.isInterrupting) return;
      this._handleWebSocketMessage(data);
    });

    this.ws.on('ping', () => {});

    this.ws.on('close', (code, reason) => {
      const readableReason = reason?.toString?.() || '';
      if (this.stopped) return;

      const description = `WebSocket fechado (${code}) ${readableReason}`.trim();
      this.log.warn?.(`${description} — tentando reconectar...`);
      this._clearHeartbeat();
      this.ws = null;
      this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      this.log.error?.('Erro no WebSocket:', err?.message || err);
      this._scheduleReconnect();
    });
  }

  _startHeartbeat() {
    this._clearHeartbeat();

    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000);
  }

  _clearHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    if (this.reconnectTimer) return;

    if (this.reconnectAttempts >= MAX_WS_RECONNECT_ATTEMPTS) {
      this.stop('limite de reconexões do WebSocket atingido');
      return;
    }

    const delay = Math.min(
      WS_RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts,
      MAX_WS_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempts += 1;

    this.reconnectTimer = setTimeout(() => {
      this._connectWebSocket();
    }, delay);
  }

  /**
   * Pushes downsampled PCM chunks upstream while avoiding backpressure overhead.
   */
  _handleInputChunk(chunk) {
    if (!chunk?.length) return;

    const wasSpeaking = this.isSpeaking;
    let amplitude = 0;
    for (let i = 0; i < chunk.length; i += 2) {
      const value = Math.abs(chunk.readInt16LE(i));
      if (value > amplitude) {
        amplitude = value;
      }
      if (amplitude > VAD_THRESHOLD) {
        break;
      }
    }

    if (amplitude > VAD_THRESHOLD) {
      this.speakingFrames += 1;
      this.silenceFrames = 0;

      if (this.speakingFrames >= 3) {
        this.isSpeaking = true;
      }
    } else {
      this.silenceFrames += 1;
      this.speakingFrames = 0;

      if (this.silenceFrames > 80) {
        this.isSpeaking = false;
      }
    }

    if (!this.isSpeaking) {
      if (wasSpeaking) {
        this.isInterrupting = false;
      }
      return;
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          user_audio_chunk: chunk.toString('base64'),
        }),
      );
    }
  }

  /**
   * Routes ElevenLabs responses back into Discord playback with lightweight parsing.
   */
  _handleWebSocketMessage(data) {
    try {
      const parsed = JSON.parse(data.toString());
      const payload = parsed?.data ?? parsed;
      const audioBase64 = payload?.audio_event?.audio_base_64 || payload?.audio_base_64;

      if (audioBase64) {
        this._writeOutputAudio(Buffer.from(audioBase64, 'base64'));

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

  /**
   * Raw PCM re-encoding via FFmpeg; keep args untouched to satisfy Discord/FFmpeg quirks.
   */
  _writeOutputAudio(buffer) {
    if (!buffer?.length) return;

    const streamEnded =
      !this.currentResponseStream ||
      this.currentResponseStream.destroyed ||
      this.currentResponseStream.writableEnded;

    if (streamEnded) {
      this.log.info?.('🔊 Starting new audio response stream');
      this.currentResponseStream = new PassThrough({ highWaterMark: 1024 * 1024 });
      this.currentResponseStream.on('error', () => {});

      const args = [
        '-f',
        's16le',
        '-ar',
        String(AI_SAMPLE_RATE),
        '-ac',
        '1',
        '-i',
        '-',
        '-f',
        's16le',
        '-ar',
        String(DISCORD_SAMPLE_RATE),
        '-ac',
        '2',
      ];

      const ffmpeg = new prism.FFmpeg({ args });
      ffmpeg.on('error', (err) => this.log.warn?.('⚠️ FFmpeg error', err?.message || err));

      this.currentResponseStream.pipe(ffmpeg);

      if (ffmpeg.process?.stderr) {
        ffmpeg.process.stderr.on('data', (d) => {
          const log = d.toString();
          if (log.includes('Error') || log.includes('Warning')) {
            console.log('🔴 FFmpeg Stderr:', log);
          }
        });
      }

      const resource = createAudioResource(ffmpeg, {
        inputType: StreamType.Raw,
      });
      resource.playStream?.on?.('error', (e) => console.log('❌ Resource Error:', e));

      this.player?.play(resource);
      console.log('🗣️ Started new speech segment');
    }

    this.currentResponseStream.write(buffer);

    if (this.silenceTimeout) {
      clearTimeout(this.silenceTimeout);
    }

    this.silenceTimeout = setTimeout(() => {
      try {
        const silence = Buffer.alloc(RESPONSE_SILENCE_PADDING_BYTES, 0);
        this.currentResponseStream?.write(silence);
        this.currentResponseStream?.end();
      } catch {}
      this.currentResponseStream = null;
      console.log('🤫 Speech segment ended');
    }, RESPONSE_SILENCE_TIMEOUT_MS);
  }

  /**
   * Decimates audio frames client-side to keep latency low for AI ingestion.
   */
  _downsample(chunk) {
    const output = Buffer.allocUnsafe(Math.floor(chunk.length / 12) * 2);
    let outIndex = 0;

    for (let offset = 0; offset <= chunk.length - 12; offset += 12) {
      const left = chunk.readInt16LE(offset);
      const right = chunk.readInt16LE(offset + 2);
      const mixed = Math.round((left + right) / 2);

      output.writeInt16LE(mixed, outIndex);
      outIndex += 2;
    }

    return output.subarray(0, outIndex);
  }

  /**
   * Tear down every stream handle so we don't leak resources between sessions.
   */
  stop(reason) {
    if (this.stopped) return;
    this.stopped = true;

    this.log.info?.(`Encerrando AudioStream${reason ? `: ${reason}` : ''}`);

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }

    this._clearHeartbeat();

    try {
      this.opusStream?.destroy();
    } catch {}
    this.opusStream = null;
    try {
      this.inputDecoder?.destroy();
    } catch {}
    this.inputDecoder = null;

    try {
      this.currentResponseStream?.destroy();
    } catch {}
    this.currentResponseStream = null;
    if (this.silenceTimeout) {
      clearTimeout(this.silenceTimeout);
      this.silenceTimeout = null;
    }

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
