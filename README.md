# discord-rpg-bot
Bot de Discord para entrar em canal de voz (base para RPG com voz + ElevenLabs).
Comandos: !join, !leave, !realtime, !stoprealtime, !ping, !help

## Modo de conversação em tempo real

Defina as variáveis de ambiente abaixo para ativar a ponte bidirecional com a ElevenLabs Conversational AI:

- `ELEVENLABS_AGENT_ID`
- `ELEVENLABS_API_KEY`

Depois de configurar, use `!realtime` (estando no canal de voz configurado) para enviar seu áudio em streaming e ouvir as respostas do agente. Use `!stoprealtime` para encerrar.
