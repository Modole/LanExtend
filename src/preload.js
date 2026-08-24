'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('监听器必须是函数');
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('lanextend', Object.freeze({
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  rendererReady: () => ipcRenderer.invoke('app:renderer-ready'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  openLatestRelease: () => ipcRenderer.invoke('updates:open-release'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  getDevices: () => ipcRenderer.invoke('devices:get'),
  rememberDevice: (device, connected = false) => ipcRenderer.invoke(
    'devices:remember', device, connected
  ),
  forgetDevice: (id) => ipcRenderer.invoke('devices:forget', id),
  listSources: () => ipcRenderer.invoke('display:list-sources'),
  createVirtualDisplay: (options) => ipcRenderer.invoke('display:create-virtual', options),
  destroyVirtualDisplay: () => ipcRenderer.invoke('display:destroy-virtual'),
  getVirtualDisplayStatus: () => ipcRenderer.invoke('display:status'),
  prepareCapture: (sourceId) => ipcRenderer.invoke('capture:prepare', sourceId),
  sendReceiverSignal: (sessionId, message) => ipcRenderer.invoke(
    'receiver:send-signal', sessionId, message
  ),
  disconnectReceiver: (sessionId, reason) => ipcRenderer.invoke(
    'receiver:disconnect', sessionId, reason
  ),
  startInputSharing: (layout, clipboardEnabled, fileClipboardEnabled) => ipcRenderer.invoke(
    'input:host-start', layout, clipboardEnabled, fileClipboardEnabled
  ),
  stopInputSharing: () => ipcRenderer.invoke('input:host-stop'),
  getInputStatus: () => ipcRenderer.invoke('input:get-status'),
  applyRemoteClipboard: (message) => ipcRenderer.invoke('input:apply-clipboard', message),
  receiveFileOffer: (message, host) => ipcRenderer.invoke('input:receive-file-offer', message, host),
  applyFileStatus: (message) => ipcRenderer.invoke('input:apply-file-status', message),
  cancelFileTransfer: (transferId) => ipcRenderer.invoke('input:cancel-file-transfer', transferId),
  toggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
  setFullscreen: (enabled) => ipcRenderer.invoke('window:set-fullscreen', enabled),
  getScreenPermission: () => ipcRenderer.invoke('permission:get-screen-status'),
  openScreenSettings: () => ipcRenderer.invoke('permission:open-screen-settings'),
  requestAccessibility: () => ipcRenderer.invoke('permission:request-accessibility'),
  openAccessibilitySettings: () => ipcRenderer.invoke('permission:open-accessibility-settings'),
  validateTarget: (host, port) => ipcRenderer.invoke('network:validate-target', host, port),
  onDevicesChanged: (callback) => subscribe('devices:changed', callback),
  onDisplayChanged: (callback) => subscribe('display:changed', callback),
  onReceiverConnected: (callback) => subscribe('receiver:connected', callback),
  onReceiverDisconnected: (callback) => subscribe('receiver:disconnected', callback),
  onReceiverSignal: (callback) => subscribe('receiver:signal', callback),
  onReceiverListening: (callback) => subscribe('receiver:listening', callback),
  onScreenPermissionChanged: (callback) => subscribe('permission:screen-changed', callback),
  onInputOutbound: (callback) => subscribe('input:outbound', callback),
  onInputHostStatus: (callback) => subscribe('input:host-status', callback),
  onInputReceiverStatus: (callback) => subscribe('input:receiver-status', callback),
  onInputWarning: (callback) => subscribe('input:warning', callback),
  onFileTransfer: (callback) => subscribe('input:file-transfer', callback),
  onServiceError: (callback) => subscribe('service:error', callback)
}));
