'use strict';

const PROTOCOL_VERSION = 3;
const DISCOVERY_PORT = 47_771;
const SIGNAL_PORT = 47_772;
const MAX_SIGNAL_BYTES = 256 * 1024;
const MAX_BEACON_BYTES = 4 * 1024;
const MAX_FILE_ENTRIES = 10_000;
const MAX_FILE_TRANSFER_BYTES = 20 * 1024 * 1024 * 1024;

const DEFAULTS = Object.freeze({
  schemaVersion: 1,
  host: {
    width: 1920,
    height: 1080,
    fps: 30,
    bitrateMbps: 8,
    hiDPI: false,
    autoReconnect: true,
    lastDeviceId: null,
    lastSourceId: null
  },
  receiver: {
    id: null,
    name: null,
    port: SIGNAL_PORT,
    autoFullscreen: true
  },
  inputSharing: {
    lastDeviceId: null,
    clipboard: true,
    fileClipboard: true,
    autoReconnect: true,
    edgeDelayMs: 80,
    layouts: []
  },
  rememberedDevices: []
});

module.exports = {
  DEFAULTS,
  DISCOVERY_PORT,
  MAX_BEACON_BYTES,
  MAX_FILE_ENTRIES,
  MAX_FILE_TRANSFER_BYTES,
  MAX_SIGNAL_BYTES,
  PROTOCOL_VERSION,
  SIGNAL_PORT
};
