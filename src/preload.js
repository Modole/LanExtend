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
  toggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
  setFullscreen: (enabled) => ipcRenderer.invoke('window:set-fullscreen', enabled),
  openScreenSettings: () => ipcRenderer.invoke('permission:open-screen-settings'),
  validateTarget: (host, port) => ipcRenderer.invoke('network:validate-target', host, port),
  onDevicesChanged: (callback) => subscribe('devices:changed', callback),
  onDisplayChanged: (callback) => subscribe('display:changed', callback),
  onReceiverConnected: (callback) => subscribe('receiver:connected', callback),
  onReceiverDisconnected: (callback) => subscribe('receiver:disconnected', callback),
  onReceiverSignal: (callback) => subscribe('receiver:signal', callback),
  onReceiverListening: (callback) => subscribe('receiver:listening', callback),
  onServiceError: (callback) => subscribe('service:error', callback)
}));
