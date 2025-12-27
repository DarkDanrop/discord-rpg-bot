import { Client, GatewayIntentBits } from "discord.js";
import { joinVoiceChannel, getVoiceConnection } from "@discordjs/voice";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

if (!DISCORD_TOKEN) {
  console.error("❌ Falta DISCORD_TOKEN nas variáveis de ambiente.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once("ready", () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
  console.log("👉 Use !join no canal de texto enquanto você estiver num canal de voz.");
});

client.on("messageCreate", async (msg) => {
  try {
    if (msg.author.bot) return;

    const content = msg.content.trim().toLowerCase();
    if (content === "!ping") {
      await msg.reply("pong ✅");
      return;
    }

    if (content === "!join") {
      const member = await msg.guild.members.fetch(msg.author.id);
      const voiceChannel = member?.voice?.channel;

      if (!voiceChannel) {
        await msg.reply("Entra em um canal de voz primeiro, depois manda **!join** aqui 🙂");
        return;
      }

      joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: msg.guild.id,
        adapterCreator: msg.guild.voiceAdapterCreator
      });

      await msg.reply(`🎙️ Entrei no canal **${voiceChannel.name}**.`);
      return;
    }

    if (content === "!leave") {
      const conn = getVoiceConnection(msg.guild.id);
      if (conn) conn.destroy();
      await msg.reply("👋 Saí do canal de voz.");
      return;
    }

    if (content === "!help") {
      await msg.reply(
        "Comandos:\n" +
        "- **!ping** (teste)\n" +
        "- **!join** (entra no seu canal de voz)\n" +
        "- **!leave** (sai do canal)\n"
      );
      return;
    }
  } catch (err) {
    console.error(err);
    try { await msg.reply("Deu um erro aqui. Olha o log do bot."); } catch {}
  }
});

client.login(DISCORD_TOKEN);
