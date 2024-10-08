const {
  useMultiFileAuthState,
  Browsers,
  default: makeWASocket,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const logger = require('../config/logger');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');
const ResponseError = require('../error/response-error');
const { STATUS_CODE } = require('../constant/status-code');
const {
  RECONNECT_REASONS,
  RESTART_SESSION_REASONS,
  CONNECT_TIMEOUT,
  KEEP_ALIVE_INTERVAL,
  RETRY_REQUEST_DELAY,
  TIME_INITIALIZATION,
  TIME_TOGENERATE_QR,
  SECONDS
} = require('../constant/wa-const');

const msgRetryCounterCache = new NodeCache();

class WaService {
  constructor(token) {
    this.token = token;
    this.sock = null;
    this.initialized = false;
    this.connectionStatus = 'close';
    this.qr = undefined;
    this.needToScan = false;
  }

  async init() {
    if (this.initialized) return;

    try {
      const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, '../../', 'sessions', this.token));
      const { version } = await fetchLatestBaileysVersion();

      this.sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        logger,
        printQRInTerminal: false,
        browser: Browsers.macOS('Chrome', 'Mpedia'),
        connectTimeoutMs: CONNECT_TIMEOUT * SECONDS,
        keepAliveIntervalMs: KEEP_ALIVE_INTERVAL * SECONDS,
        retryRequestDelayMs: RETRY_REQUEST_DELAY * SECONDS,
        generateHighQualityLinkPreview: true,
        fireInitQueries: false,
        msgRetryCounterCache
      });

      this.sock.ev.on('connection.update', this.connectionUpdateHandler.bind(this));
      this.sock.ev.on('creds.update', saveCreds);

      this.initialized = true;
      logger.info(`WhatsApp socket initialized for ${this.token}`);
    } catch (error) {
      logger.error(`Failed to initialize WhatsApp socket for ${this.token}: ${error.message}`);
      throw new ResponseError(STATUS_CODE.HTTP_PRECONDITION_FAILED, error.message);
    }
  }

  cleanup() {
    try {
      if (this.sock) {
        this.sock.ws.close();
      }

      const sessionPath = path.join(__dirname, '../../', 'sessions', this.token);
      if (fs.existsSync(sessionPath)) {
        fs.rmdirSync(sessionPath, { recursive: true });
        logger.info(`Session for ${this.token} cleaned up successfully`);
      } else {
        logger.warn(`Session path ${sessionPath} does not exist, nothing to clean up.`);
      }

      this.initialized = false;
    } catch (error) {
      logger.error(`Error during cleanup for ${this.token}: ${error.message}`);
      throw new ResponseError(STATUS_CODE.HTTP_CLEAN_UP_FAILED, 'Cleanup error');
    }
  }

  connectionUpdateHandler(update) {
    try {
      const { connection, lastDisconnect, qr } = update;
      this.qr = qr;
      this.needToScan = !!qr;

      if (connection === 'close') {
        this.connectionStatus = 'close';
        const lastDisconnectCode = lastDisconnect?.error?.output?.statusCode;
        logger.info(`Connection status for ${this.token}: ${connection}, lastDisconnectCode: ${lastDisconnectCode}`);

        if (RECONNECT_REASONS.includes(lastDisconnectCode)) {
          logger.info(`Attempting to reconnect for ${this.token}...`);
          this.initialized = false;
          this.init();
        } else if (RESTART_SESSION_REASONS.includes(lastDisconnectCode)) {
          logger.info(`Restarting session for ${this.token} due to disconnect reason ${lastDisconnectCode}...`);
          this.cleanup();
          this.init();
        } else {
          logger.error(`Unhandled disconnect reason: ${lastDisconnectCode} for ${this.token}`);
          throw new ResponseError(STATUS_CODE.HTTP_PRECONDITION_FAILED, `Unhandled disconnect reason: ${lastDisconnectCode}`);
        }
      } else if (connection === 'open') {
        this.connectionStatus = 'open';
        logger.info(`Connection established for ${this.token}`);
      } else if (connection === 'connecting') {
        this.connectionStatus = 'connecting';
      }
    } catch (error) {
      logger.error(`Error handling connection update for ${this.token}: ${error.message}`);
      throw new ResponseError(STATUS_CODE.HTTP_PRECONDITION_FAILED, `Connection update error: ${error.message}`);
    }
  }

  async ensureConnection() {
    try {
      if (!this.initialized) {
        logger.warn(`Socket not initialized or inactive for ${this.token}, attempting to reconnect...`);
        await this.init();
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      if (!this.sock) {
        throw new ResponseError(STATUS_CODE.HTTP_NOT_ALLOWED, 'Socket not initialized');
      }
    } catch (error) {
      logger.error(`Error ensuring connection for ${this.token}: ${error.message}`);
      throw error;
    }
  }

  async getAllGroups() {
    try {
      await this.ensureConnection();
      if (!this.sock) {
        throw new ResponseError(STATUS_CODE.HTTP_NOT_ALLOWED, 'Connection not open');
      }

      const groups = await this.sock.groupFetchAllParticipating();
      const groupsList = Object.entries(groups)
        .slice(0)
        .map(groupEntry => groupEntry[1]);

      return groupsList;
    } catch (error) {
      logger.error(`Failed to get all groups for ${this.token}: ${error.message}`);
      throw new ResponseError(STATUS_CODE.HTTP_PRECONDITION_FAILED, 'Failed to get all groups');
    }
  }

  async generateQr() {
    try {
      if (!this.initialized) {
        logger.warn(`Socket not initialized or inactive for ${this.token}, attempting to reconnect...`);
        await this.init();
        await new Promise(resolve => setTimeout(resolve, TIME_INITIALIZATION * SECONDS));
      }

      if (!this.sock) {
        throw new ResponseError(STATUS_CODE.HTTP_NOT_ALLOWED, 'Socket not initialized');
      }

      while (!this.qr) {
        logger.info(`Waiting to generate QR code for ${this.token}`);

        if (!this.needToScan) {
          logger.info(`QR code not needed for ${this.token}`);
          return { message: "You're all set!" };
        }

        await new Promise(resolve => setTimeout(resolve, TIME_TOGENERATE_QR * SECONDS));
      }

      return QRCode.toBuffer(this.qr);
    } catch (error) {
      logger.error(`Failed to generate QR code for ${this.token}: ${error.message}`);
      throw new ResponseError(STATUS_CODE.HTTP_SERVICE_UNAVAILABLE, 'Failed to generate QR code');
    }
  }

  async getStatus() {
    if (!this.initialized) {
      logger.warn(`Socket not initialized or inactive for ${this.token}, attempting to reconnect...`);
      await this.init();
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    return this.connectionStatus === 'open';
  }

  async sendMessage(to, message) {
    try {
      await this.ensureConnection();
      if (!this.sock) {
        throw new ResponseError(STATUS_CODE.HTTP_NOT_ALLOWED, 'Connection not open');
      }

      await this.sock.sendMessage(to, {
        text: message
      });

      return 'Message sent successfully';
    } catch (error) {
      logger.error(`Failed to send message from ${this.token} to ${to}: ${error.message}`);

      if (this.connectionStatus !== 'open') {
        throw new ResponseError(STATUS_CODE.HTTP_PRECONDITION_FAILED, 'Connection not open');
      } else {
        throw new ResponseError(STATUS_CODE.HTTP_INTERNAL_SERVER_ERROR, 'Failed to send message');
      }
    }
  }
}

module.exports = WaService;
