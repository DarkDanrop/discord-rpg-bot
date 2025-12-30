require('dotenv').config();

const { Client, Events, GatewayIntentBits, Partials } = require('discord.js');
const {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');
const { AudioStream } = require('./AudioStream');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

if (!DISCORD_TOKEN || !GUILD_ID || !VOICE_CHANNEL_ID) {
  console.error('Faltou DISCORD_TOKEN, GUILD_ID ou VOICE_CHANNEL_ID nas env vars');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

let booted = false;
let connection = null;
let audioStream = null;

const COMMAND_PREFIX = '!';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectVoice() {
  if (connection && connection.state?.status !== VoiceConnectionStatus.Destroyed) {
    return connection;
  }

  const guild = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(VOICE_CHANNEL_ID);

  if (!channel || !channel.isVoiceBased?.()) {
    throw new Error('VOICE_CHANNEL_ID não parece ser um canal de voz válido.');
  }

  console.log(`Entrando no canal de voz: ${channel.name}`);

  connection = joinVoiceChannel({
    channelId: VOICE_CHANNEL_ID,
    guildId: GUILD_ID,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  connection.on('error', (err) => {
    console.error('VoiceConnection error:', err?.message || err);
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    console.warn('⚠️ VoiceConnection: Disconnected — tentando reconectar...');
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      console.log('✅ reconectou (signalling/connecting)');
    } catch {
      try {
        connection.destroy();
      } catch {}
      await sleep(1500);
      await safeConnectLoop();
    }
  });

  let errorListener;
  const errorPromise = new Promise((_, reject) => {
    errorListener = (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      reject(error);
    };
    connection.once('error', errorListener);
  });

  try {
    await Promise.race([
      entersState(connection, VoiceConnectionStatus.Ready, 20_000),
      errorPromise,
    ]);
  } finally {
    if (errorListener) {
      connection.off('error', errorListener);
    }
  }
  console.log('✅ VoiceConnection: Ready (conectado no canal)');
  return connection;
}

async function safeConnectLoop() {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      console.log(`🔁 tentativa de conectar no voice: ${attempt}/10`);
      await connectVoice();
      return;
    } catch (err) {
      const msg = err?.message || String(err);
      console.error('Erro ao conectar voice:', msg);
      await sleep(3000);
    }
  }

  console.error('❌ não consegui conectar no voice após 10 tentativas.');
}

function stopAudioStream(reason) {
  if (!audioStream) return;
  try {
    audioStream.stop(reason);
  } catch (err) {
    console.warn('Erro ao parar AudioStream:', err?.message || err);
  }
  audioStream = null;
}

async function boot() {
  if (booted) return;
  booted = true;

  console.log(`Logado como ${client.user.tag}`);
  await safeConnectLoop();
}

client.once(Events.ClientReady, boot);
client.login(DISCORD_TOKEN);

client.on('messageCreate', async (message) => {
  if (!message.content?.startsWith(COMMAND_PREFIX)) return;
  if (message.author.bot) return;

  const [command] = message.content
    .slice(COMMAND_PREFIX.length)
    .trim()
    .split(/\s+/);

  const cmd = command?.toLowerCase();

  if (cmd === 'ping') {
    await message.reply('Pong!');
    return;
  }

  if (cmd === 'help') {
    await message.reply(
      [
        'Comandos disponíveis:',
        '!join - conecta no canal de voz configurado',
        '!leave - sai do canal de voz',
        '!realtime - inicia streaming bidirecional com a ElevenLabs (autor da mensagem)',
        '!stoprealtime - encerra o streaming bidirecional ativo',
        '!ping - teste rápido de vida do bot',
        '!help - mostra esta mensagem',
      ].join('\n'),
    );
    return;
  }

  if (cmd === 'join') {
    try {
      await safeConnectLoop();
      await message.reply('Entrei (ou já estava) no canal de voz configurado.');
    } catch (err) {
      const reason = err?.message || String(err);
      await message.reply(`Não consegui entrar no voice: ${reason}`);
    }
    return;
  }

  if (cmd === 'leave') {
    if (connection) {
      try {
        stopAudioStream('leave command');
        connection.destroy();
        connection = null;
        await message.reply('Saí do canal de voz.');
      } catch (err) {
        const reason = err?.message || String(err);
        await message.reply(`Erro ao sair do voice: ${reason}`);
      }
    } else {
      await message.reply('Não estou em nenhum canal de voz agora.');
    }
    return;
  }

  if (cmd === 'realtime') {
    if (!ELEVENLABS_AGENT_ID || !ELEVENLABS_API_KEY) {
      await message.reply(
        'Configure ELEVENLABS_AGENT_ID e ELEVENLABS_API_KEY para usar o modo em tempo real.',
      );
      return;
    }

    const member = message.member;
    const memberVoiceChannelId = member?.voice?.channelId;
    if (!memberVoiceChannelId) {
      await message.reply('Você precisa estar em um canal de voz para iniciar o streaming.');
      return;
    }

    if (memberVoiceChannelId !== VOICE_CHANNEL_ID) {
      await message.reply(
        'Entre primeiro no canal de voz configurado (VOICE_CHANNEL_ID) para iniciar o streaming.',
      );
      return;
    }

    try {
      await safeConnectLoop();
      stopAudioStream('novo streaming solicitado');

      audioStream = new AudioStream(connection, member.id, {
        agentId: ELEVENLABS_AGENT_ID,
        apiKey: ELEVENLABS_API_KEY,
        log: console,
      });

      await audioStream.start();

      await message.reply(
        'Streaming bidirecional iniciado. Fale no canal e receba a resposta do agente em tempo real.',
      );
    } catch (err) {
      stopAudioStream('falha ao iniciar streaming');
      const reason = err?.message || String(err);
      await message.reply(`Não consegui iniciar o streaming: ${reason}`);
    }
    return;
  }

  if (cmd === 'stoprealtime') {
    if (audioStream) {
      stopAudioStream('pedido do usuário');
      await message.reply('Streaming bidirecional interrompido.');
    } else {
      await message.reply('Nenhum streaming bidirecional estava ativo.');
    }
    return;
  }
});
