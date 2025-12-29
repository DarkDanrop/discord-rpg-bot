import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { joinAndRecord } from './recorder.js';

const {
  DISCORD_TOKEN,
  GUILD_ID,
  VOICE_CHANNEL_ID,
} = process.env;

if (!DISCORD_TOKEN || !GUILD_ID || !VOICE_CHANNEL_ID) {
  console.error('Faltou DISCORD_TOKEN, GUILD_ID ou VOICE_CHANNEL_ID nas env vars');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once('ready', async () => {
  console.log(`Logado como ${client.user.tag}`);
  try {
    await joinAndRecord(client, GUILD_ID, VOICE_CHANNEL_ID);
  } catch (err) {
    console.error('Erro no joinAndRecord:', err);
  }
});

client.login(DISCORD_TOKEN);
