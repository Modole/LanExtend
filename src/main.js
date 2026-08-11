'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  Menu,
  net,
  powerSaveBlocker,
  screen,
  session,
  shell,
  systemPreferences
} = require('electron');
const { ConfigStore } = require('./core/config-store');
const { PROTOCOL_VERSION } = require('./core/constants');
const { DiscoveryAdvertiser, DiscoveryListener, SignalServer } = require('./core/network');
const { isPrivateIPv4, isValidPort } = require('./core/protocol');
const {
  MAX_RELEASE_RESPONSE_BYTES,
  RELEASE_API_URL,
  RELEASE_PAGE_URL,
  parseReleasePageUrl,
  parseReleasePayload
} = require('./core/updates');
const { VirtualDisplayManager, helperPath } = require('./core/virtual-display');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const explicitRole = process.argv.find((argument) => argument.startsWith('--role='))?.split('=')[1];
const role = explicitRole === 'host' || explicitRole === 'receiver'
  ? explicitRole
  : process.platform === 'win32' ? 'receiver' : 'host';
const allowMultipleInstances = process.argv.includes('--allow-multiple-instances');

if (allowMultipleInstances) {
  app.setPath('userData', path.join(app.getPath('temp'), `lanextend-dev-${role}`));
}

let mainWindow;
let configStore;
let discoveryListener;
let signalServer;
let advertiser;
let virtualDisplay;
let pendingCaptureSourceId = null;
let sleepBlockerId = null;
let serviceError = null;
let rendererReady = false;
let pendingRendererEvents = [];
let cleanupStarted = false;

function emitToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (rendererReady) {
    mainWindow.webContents.send(channel, payload);
    return;
  }
  if (channel === 'devices:changed' || channel === 'display:changed') {
    pendingRendererEvents = pendingRendererEvents.filter((event) => event.channel !== channel);
  }
  pendingRendererEvents.push({ channel, payload });
  if (pendingRendererEvents.length > 100) pendingRendererEvents.shift();
}

function mediaPermissionStatus() {
  if (process.platform !== 'darwin') return 'granted';
  try {
    return systemPreferences.getMediaAccessStatus('screen');
  } catch {
    return 'unknown';
  }
}

async function checkReleasePageFallback(signal) {
  const response = await net.fetch(RELEASE_PAGE_URL, {
    method: 'HEAD',
    redirect: 'manual',
    headers: { 'User-Agent': `LanExtend/${app.getVersion()}` },
    signal
  });
  const location = response.headers.get('location');
  if (response.status < 300 || response.status >= 400 || !location) {
    throw new Error(`GitHub 发布页返回 ${response.status}`);
  }
  const releaseUrl = new URL(location, RELEASE_PAGE_URL).toString();
  return parseReleasePageUrl(releaseUrl, app.getVersion());
}

async function checkForUpdates() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await net.fetch(RELEASE_API_URL, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `LanExtend/${app.getVersion()}`,
        'X-GitHub-Api-Version': '2022-11-28'
      },
      signal: controller.signal
    });
    if (response.status === 403 || response.status === 429) {
      return await checkReleasePageFallback(controller.signal);
    }
    if (!response.ok) {
      if (response.status === 404) throw new Error('项目暂未发布可下载版本');
      throw new Error(`GitHub 更新服务返回 ${response.status}`);
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RELEASE_RESPONSE_BYTES) {
      throw new Error('GitHub 版本信息超过大小限制');
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_RELEASE_RESPONSE_BYTES) {
      throw new Error('GitHub 版本信息超过大小限制');
    }
    return parseReleasePayload(JSON.parse(raw), app.getVersion());
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('检查更新超时，请确认网络后重试');
    if (error instanceof SyntaxError) throw new Error('GitHub 返回了无法识别的版本信息');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function mergedDevices() {
  const remembered = configStore.get().rememberedDevices;
  const discovered = discoveryListener?.list() || [];
  const byId = new Map(remembered.map((device) => [device.id, { ...device, online: false }]));
  for (const device of discovered) {
    byId.set(device.id, { ...byId.get(device.id), ...device, online: true });
  }
  return [...byId.values()].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return (b.lastConnected || b.lastSeen || 0) - (a.lastConnected || a.lastSeen || 0);
  });
}

async function listCaptureSources() {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 320, height: 180 }
  });
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    displayId: source.display_id || null,
    thumbnail: source.thumbnail?.isEmpty() ? null : source.thumbnail.toDataURL()
  }));
}

function configureDisplayCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 0, height: 0 }
      });
      const selected = sources.find((source) => source.id === pendingCaptureSourceId)
        || sources.find((source) => source.display_id === pendingCaptureSourceId);
      pendingCaptureSourceId = null;
      if (!selected) {
        callback({});
        return;
      }
      callback({ video: selected });
    } catch {
      callback({});
    }
  }, { useSystemPicker: false });
}

function createWindow() {
  rendererReady = false;
  const rendererPath = path.join(__dirname, 'renderer', 'index.html');
  const rendererUrl = pathToFileURL(rendererPath);
  mainWindow = new BrowserWindow({
    width: role === 'host' ? 1180 : 1080,
    height: role === 'host' ? 780 : 720,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: role === 'host' ? 'LanExtend 主端' : 'LanExtend 子端',
    backgroundColor: '#07111f',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  Menu.setApplicationMenu(null);
  mainWindow.loadFile(rendererPath, {
    query: { role }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const target = new URL(url);
      if (target.protocol !== 'file:' || target.pathname !== rendererUrl.pathname) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  mainWindow.webContents.on('did-start-loading', () => {
    rendererReady = false;
  });
}

async function startHostServices() {
  discoveryListener = new DiscoveryListener();
  discoveryListener.on('changed', () => emitToRenderer('devices:changed', mergedDevices()));
  discoveryListener.on('warning', (error) => {
    if (process.env.LANEXTEND_DEBUG) console.warn('[discovery]', error.message);
  });
  discoveryListener.on('error', (error) => emitToRenderer('service:error', {
    service: 'discovery', message: error.message
  }));
  try {
    await discoveryListener.start();
  } catch (error) {
    emitToRenderer('service:error', { service: 'discovery', message: error.message });
  }
}

async function stopReceiverServices() {
  advertiser?.stop();
  advertiser = null;
  await signalServer?.stop();
  signalServer = null;
  if (sleepBlockerId !== null) {
    powerSaveBlocker.stop(sleepBlockerId);
    sleepBlockerId = null;
  }
}

async function startReceiverServices() {
  const receiver = configStore.get().receiver;
  try {
    signalServer = new SignalServer(receiver, { port: receiver.port });
    signalServer.on('connected', (connection) => {
      if (sleepBlockerId === null) sleepBlockerId = powerSaveBlocker.start('prevent-display-sleep');
      emitToRenderer('receiver:connected', connection);
    });
    signalServer.on('message', (event) => emitToRenderer('receiver:signal', event));
    signalServer.on('disconnected', (event) => {
      if (sleepBlockerId !== null) {
        powerSaveBlocker.stop(sleepBlockerId);
        sleepBlockerId = null;
      }
      emitToRenderer('receiver:disconnected', event);
    });
    signalServer.on('warning', (error) => {
      if (process.env.LANEXTEND_DEBUG) console.warn('[signal]', error.message);
    });
    signalServer.on('error', (error) => emitToRenderer('service:error', {
      service: 'signal', message: error.message
    }));
    await signalServer.start();
    emitToRenderer('receiver:listening', { port: receiver.port });
  } catch (error) {
    await stopReceiverServices();
    throw error;
  }

  const reportAdvertiserFailure = (error) => {
    serviceError = {
      service: 'advertiser',
      message: `局域网自动发现不可用，仍可通过手动 IP 连接：${error.message}`
    };
    emitToRenderer('service:error', serviceError);
  };

  try {
    advertiser = new DiscoveryAdvertiser(receiver);
    advertiser.on('error', reportAdvertiserFailure);
    advertiser.on('warning', (error) => {
      if (process.env.LANEXTEND_DEBUG) console.warn('[advertiser]', error.message);
    });
    await advertiser.start();
    serviceError = null;
  } catch (error) {
    try { advertiser?.stop(); } catch { /* A failed bind may already have closed the socket. */ }
    advertiser = null;
    reportAdvertiserFailure(error);
  }
}

function registerIpc() {
  ipcMain.handle('app:renderer-ready', () => {
    rendererReady = true;
    const events = pendingRendererEvents;
    pendingRendererEvents = [];
    for (const event of events) emitToRenderer(event.channel, event.payload);
    return true;
  });
  ipcMain.handle('app:bootstrap', async () => {
    const displayStatus = virtualDisplay.getStatus();
    const capability = displayStatus.supported
      ? await virtualDisplay.probe().catch((error) => ({
        supported: false,
        reason: error.message
      }))
      : { supported: false, reason: 'native helper 尚未构建或当前平台不支持' };
    return {
      role,
      platform: process.platform,
      protocolVersion: PROTOCOL_VERSION,
      appVersion: app.getVersion(),
      settings: configStore.get(),
      devices: role === 'host' ? mergedDevices() : [],
      permission: mediaPermissionStatus(),
      virtualDisplay: { ...displayStatus, capability },
      serviceError,
      displays: screen.getAllDisplays().map((display) => ({
        id: String(display.id),
        label: display.label,
        bounds: display.bounds,
        scaleFactor: display.scaleFactor
      }))
    };
  });
  ipcMain.handle('updates:check', () => checkForUpdates());
  ipcMain.handle('updates:open-release', async () => {
    await shell.openExternal(RELEASE_PAGE_URL);
    return true;
  });

  ipcMain.handle('settings:update', async (_event, patch) => {
    const previous = configStore.get();
    const next = configStore.updateSettings(patch);
    if (role === 'receiver'
      && (previous.receiver.port !== next.receiver.port
        || previous.receiver.name !== next.receiver.name)) {
      try {
        await stopReceiverServices();
        await startReceiverServices();
      } catch (error) {
        configStore.updateSettings({ receiver: previous.receiver });
        let rollbackMessage = '';
        try {
          await stopReceiverServices();
          await startReceiverServices();
        } catch (rollbackError) {
          rollbackMessage = `；恢复旧监听也失败：${rollbackError.message}`;
        }
        serviceError = {
          service: 'receiver',
          message: `新设置无法启动，已恢复原设置：${error.message}${rollbackMessage}`
        };
        emitToRenderer('service:error', serviceError);
        throw new Error(serviceError.message);
      }
    }
    return configStore.get();
  });
  ipcMain.handle('devices:get', () => mergedDevices());
  ipcMain.handle('devices:remember', (_event, device, connected) => {
    const saved = configStore.rememberDevice(device, Boolean(connected));
    emitToRenderer('devices:changed', mergedDevices());
    return saved;
  });
  ipcMain.handle('devices:forget', (_event, id) => {
    const state = configStore.forgetDevice(String(id));
    emitToRenderer('devices:changed', mergedDevices());
    return state;
  });

  ipcMain.handle('display:list-sources', () => listCaptureSources());
  ipcMain.handle('display:create-virtual', async (_event, options) => {
    if (role !== 'host') throw new Error('只有主端可以创建扩展屏');
    const display = await virtualDisplay.create(options);
    emitToRenderer('display:changed', virtualDisplay.getStatus());
    return display;
  });
  ipcMain.handle('display:destroy-virtual', async () => {
    await virtualDisplay.destroy();
    emitToRenderer('display:changed', virtualDisplay.getStatus());
    return virtualDisplay.getStatus();
  });
  ipcMain.handle('display:status', () => virtualDisplay.getStatus());
  ipcMain.handle('capture:prepare', async (_event, sourceId) => {
    if (typeof sourceId !== 'string' || sourceId.length > 256) throw new Error('捕获源无效');
    const sources = await listCaptureSources();
    if (!sources.some((source) => source.id === sourceId || source.displayId === sourceId)) {
      throw new Error('所选显示器已不可用，请刷新后重试');
    }
    pendingCaptureSourceId = sourceId;
    return true;
  });

  ipcMain.handle('receiver:send-signal', (_event, sessionId, message) => {
    if (role !== 'receiver') return false;
    return signalServer?.send(String(sessionId), message) || false;
  });
  ipcMain.handle('receiver:disconnect', (_event, sessionId, reason) => {
    if (role !== 'receiver') return false;
    return signalServer?.disconnect(String(sessionId), reason) || false;
  });

  ipcMain.handle('window:toggle-fullscreen', () => {
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
    return mainWindow.isFullScreen();
  });
  ipcMain.handle('window:set-fullscreen', (_event, enabled) => {
    mainWindow.setFullScreen(Boolean(enabled));
    return mainWindow.isFullScreen();
  });
  ipcMain.handle('permission:open-screen-settings', async () => {
    if (process.platform !== 'darwin') return false;
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    return true;
  });
  ipcMain.handle('network:validate-target', (_event, host, port) => ({
    valid: isPrivateIPv4(String(host)) && isValidPort(Number(port))
  }));
}

async function cleanup() {
  discoveryListener?.stop();
  await stopReceiverServices();
  await virtualDisplay?.destroy();
}

if (!allowMultipleInstances && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('dev.lanextend.desktop');
    configStore = new ConfigStore(app.getPath('userData'));
    virtualDisplay = new VirtualDisplayManager({
      executable: helperPath({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        projectRoot: PROJECT_ROOT
      })
    });
    virtualDisplay.on('stopped', () => emitToRenderer('display:changed', virtualDisplay.getStatus()));
    createWindow();
    configureDisplayCapture();
    registerIpc();
    if (role === 'host') await startHostServices();
    else {
      try {
        await startReceiverServices();
      } catch (error) {
        serviceError = { service: 'receiver', message: error.message };
        emitToRenderer('service:error', serviceError);
      }
    }
  }).catch((error) => {
    console.error(error);
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    event.preventDefault();
    if (cleanupStarted) return;
    cleanupStarted = true;
    const deadline = new Promise((resolve) => setTimeout(resolve, 4_000));
    Promise.race([cleanup(), deadline])
      .catch((error) => {
        if (process.env.LANEXTEND_DEBUG) console.warn('[cleanup]', error.message);
      })
      .finally(() => app.exit(0));
  });
}
