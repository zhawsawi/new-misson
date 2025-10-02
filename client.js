const WebSocket = require('ws');
const EventEmitter = require('events');

const blackListedEvents = ["CHANNEL_UNREAD_UPDATE", "CONVERSATION_SUMMARY_UPDATE", "SESSIONS_REPLACE"];
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const statusList = ["online", "idle", "dnd", "invisible", "offline"];

class voiceClient extends EventEmitter {
  ws = null;
  heartbeatInterval;
  sequenceNumber = null;
  firstLoad = true;
  reconnectAttempts = 0;
  ignoreReconnect = false;
  reconnectTimeout;
  invalidSession = false;
  token;
  guildId;
  channelId;
  selfMute;
  selfDeaf;
  autoReconnect;
  presence;
  user_id = null;
  connected = false;

  constructor(config) {
    super();
    if (!config.token) throw new Error('token is required');
    this.token = config.token;
    this.guildId = config.serverId;
    this.channelId = config.channelId;
    this.selfMute = config.selfMute ?? true;
    this.selfDeaf = config.selfDeaf ?? true;
    this.autoReconnect = {
      enabled: config.autoReconnect?.enabled ?? false,
      delay: (config.autoReconnect?.delay ?? 1) * 1000,
      maxRetries: config.autoReconnect?.maxRetries ?? 9999,
    };
    this.presence = config.presence ?? null;
  }

  connect() {
    if (this.invalidSession) return;
    this.ws = new WebSocket(GATEWAY_URL, { skipUTF8Validation: true });
    this.setMaxListeners(5);

    this.ws.on('open', () => {
      this.connected = true;
      this.emit('connected');
      this.emit('debug', '🌐 Connected to Discord Gateway');
    });

    this.ws.on('message', (data) => {
      const payload = JSON.parse(data.toString());
      const { t: eventType, s: seq, op, d } = payload;
      if (blackListedEvents.includes(eventType)) return;
      if (seq !== null) this.sequenceNumber = seq;

      switch (op) {
        case 10:
          this.emit('debug', 'Received Hello (op 10)');
          this.startHeartbeat(d.heartbeat_interval);
          this.identify();
          break;
        case 11:
          this.emit('debug', 'Heartbeat acknowledged');
          break;
        case 9:
          this.emit('debug', 'Invalid session. Reconnecting...');
          this.invalidSession = true;
          if (this.ws) this.ws.terminate();
          this.cleanup();
          setTimeout(() => {
            this.invalidSession = false;
            this.connect();
          }, 10000);
          break;
        case 0:
          if (eventType === 'READY') {
            this.user_id = d.user.id;
            this.emit('ready', {
              username: d.user.username,
              discriminator: d.user.discriminator,
            });
            this.emit('debug', `🎉 Logged in as ${d.user.username}#${d.user.discriminator}`);
            this.joinVoiceChannel();
            this.sendStatusUpdate();
          } else if (eventType === 'VOICE_STATE_UPDATE') {
            if (
              d.user_id === this.user_id &&
              d.channel_id === this.channelId &&
              d.guild_id === this.guildId &&
              this.firstLoad
            ) {
              this.emit('voiceReady');
              this.emit('debug', 'Successfully joined voice channel');
              this.firstLoad = false;
            } else if (
              d.user_id === this.user_id &&
              (this.guildId && this.channelId && (d.channel_id !== this.channelId || d.guild_id !== this.guildId))
            ) {
              if (this.autoReconnect.enabled) {
                if (this.ignoreReconnect) return;
                this.reconnectAttempts++;
                if (this.reconnectAttempts < this.autoReconnect.maxRetries) {
                  if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
                  this.emit('debug', `Reconnecting... (${this.reconnectAttempts}/${this.autoReconnect.maxRetries})`);
                  this.ignoreReconnect = true;
                  this.reconnectTimeout = setTimeout(() => this.joinVoiceChannel(), this.autoReconnect.delay);
                } else {
                  this.emit('debug', 'Max reconnect attempts reached. Stopping.');
                  this.cleanup();
                }
              }
            }
          }
          break;
      }
    });

    this.ws.on('close', () => {
      this.connected = false;
      this.emit('disconnected');
      this.emit('debug', '❌ Disconnected. Reconnecting...');
      this.cleanup();

      if (!this.invalidSession) {
        setTimeout(() => this.connect(), 5000);
      } else {
        this.emit('debug', '🛑 Session invalid. Will not reconnect.');
      }
    });

    this.ws.on('error', (err) => {
      this.emit('error', err);
      this.emit('debug', `WebSocket error: ${err.message}`);
    });
  }

  startHeartbeat(interval) {
    this.heartbeatInterval = setInterval(() => {
      this.ws?.send(JSON.stringify({ op: 1, d: this.sequenceNumber }));
      this.emit('debug', 'Sending heartbeat');
    }, interval);
  }

  identify() {
    const payload = {
      op: 2,
      d: {
        token: this.token,
        intents: 128,
        properties: {
          os: 'Windows',
          browser: 'Chrome',
          device: '',
        },
      },
    };
    this.ws?.send(JSON.stringify(payload));
    this.emit('debug', 'Sending identify payload');
  }

  joinVoiceChannel() {
    if (!this.guildId || !this.channelId) return;
    const voiceStateUpdate = {
      op: 4,
      d: {
        guild_id: this.guildId,
        channel_id: this.channelId,
        self_mute: this.selfMute,
        self_deaf: this.selfDeaf,
      },
    };
    this.ws?.send(JSON.stringify(voiceStateUpdate));
    this.emit('debug', '🎤 Sent voice channel join request');
    setTimeout(() => {
      this.ignoreReconnect = false;
    }, 1000);
  }

  cleanup() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.ws = null;
    this.sequenceNumber = null;
  }

  sendStatusUpdate() {
    const status = this.presence?.status?.toLowerCase();
    if (!status || !statusList.includes(status)) return;
    const payload = {
      op: 3,
      d: {
        status: this.presence.status,
        activities: [],
        since: Math.floor(Date.now() / 1000) - 10,
        afk: true,
      },
    };
    this.ws?.send(JSON.stringify(payload));
    this.emit('debug', `Status updated to ${this.presence.status}`);
  }

  disconnect() {
    this.cleanup();
    this.emit('debug', 'Client manually disconnected');
  }
}

module.exports = { voiceClient };
