(() => {
  'use strict';

  const PROTOCOL_VERSION = 3;
  const SIGNAL_TYPES = new Set([
    'hello', 'offer', 'answer', 'ice', 'disconnect', 'ping', 'pong', 'control', 'input', 'clipboard',
    'file-offer', 'file-status'
  ]);
  const DEFAULT_SIGNAL_PORT = 47772;
  const api = window.lanextend;

  const state = {
    bootstrap: null,
    role: null,
    devices: [],
    sources: [],
    selectedDeviceId: null,
    hostConnection: null,
    reconnectTimer: null,
    reconnectCountdownTimer: null,
    reconnectAttempt: 0,
    reconnectMode: 'display',
    virtualDisplayRunning: false,
    receiverSession: null,
    receiverPeer: null,
    receiverPendingIce: [],
    receiverStatsTimer: null,
    receiverStatsPrevious: null,
    receiverOverlayTimer: null,
    receiverHost: null,
    receiverFullscreen: false,
    earlyReceiverConnection: null,
    earlyReceiverSignals: [],
    listeningPort: null,
    updateInfo: null,
    updateChecking: false,
    screenPermission: 'unknown',
    inputLayout: null,
    inputAccessibility: false,
    inputStatus: { supported: false, running: false, active: false },
    receiverInputStatus: { running: false, active: false, clipboard: false, files: false },
    pendingClipboard: null,
    fileTransfer: null,
    inputDrag: null
  };

  const byId = (id) => document.getElementById(id);
  const all = (selector, root = document) => [...root.querySelectorAll(selector)];
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

  function setText(id, value) {
    const element = byId(id);
    if (element) element.textContent = String(value);
  }

  function errorText(error, fallback = '操作没有完成，请稍后重试') {
    if (error && typeof error.message === 'string' && error.message.trim()) return error.message.trim();
    if (typeof error === 'string' && error.trim()) return error.trim();
    return fallback;
  }

  function toast(title, message = '', kind = 'success', duration = 4200) {
    const region = byId('toast-region');
    if (!region) return;
    const item = document.createElement('div');
    item.className = `toast${kind === 'success' ? '' : ` is-${kind}`}`;
    const symbol = document.createElement('span');
    symbol.className = 'toast-symbol';
    symbol.textContent = kind === 'error' ? '×' : kind === 'warning' ? '!' : '✓';
    const copy = document.createElement('div');
    copy.className = 'toast-copy';
    const heading = document.createElement('strong');
    heading.textContent = title;
    const detail = document.createElement('span');
    detail.textContent = message;
    copy.append(heading, detail);
    const close = document.createElement('button');
    close.className = 'toast-close';
    close.type = 'button';
    close.setAttribute('aria-label', '关闭通知');
    close.textContent = '×';
    const remove = () => item.remove();
    close.addEventListener('click', remove);
    item.append(symbol, copy, close);
    region.append(item);
    window.setTimeout(remove, duration);
  }

  function setSidebarStatus(kind, title, detail) {
    const card = byId('sidebar-status-title')?.closest('.sidebar-status');
    if (card) card.className = `sidebar-status${kind ? ` is-${kind}` : ''}`;
    setText('sidebar-status-title', title);
    setText('sidebar-status-detail', detail);
  }

  function setConnectionSteps(stage) {
    const order = ['device', 'display', 'stream'];
    const activeIndex = order.indexOf(stage);
    all('#connection-steps .step').forEach((element) => {
      const index = order.indexOf(element.dataset.step);
      element.classList.toggle('is-done', activeIndex >= 0 && index < activeIndex);
      element.classList.toggle('is-current', index === activeIndex);
      const marker = element.querySelector('i');
      if (marker) marker.textContent = activeIndex >= 0 && index < activeIndex ? '✓' : String(index + 1);
    });
  }

  function formatAddress(host, port) {
    return `${host}:${port}`;
  }

  function formatBitrate(bitsPerSecond) {
    if (!Number.isFinite(bitsPerSecond) || bitsPerSecond < 0) return '—';
    return `${(bitsPerSecond / 1_000_000).toFixed(bitsPerSecond >= 10_000_000 ? 1 : 2)} Mbps`;
  }

  function formatLatency(milliseconds) {
    return Number.isFinite(milliseconds) ? `${Math.max(0, Math.round(milliseconds))} ms` : '—';
  }

  function formatBytes(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    if (value < 1024) return `${Math.round(value)} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
    if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
    return `${(value / 1024 ** 3).toFixed(2)} GiB`;
  }

  function renderFileTransfer(event = {}) {
    if (!event.transferId) return;
    const previous = state.fileTransfer?.transferId === event.transferId ? state.fileTransfer : {};
    const now = performance.now();
    const elapsed = previous.sampledAt ? (now - previous.sampledAt) / 1000 : 0;
    const byteDelta = Math.max(0, (Number(event.bytes) || 0) - (Number(previous.bytes) || 0));
    const rate = elapsed > 0.05 && byteDelta > 0 ? byteDelta / elapsed : Number(previous.rate) || 0;
    const transfer = { ...previous, ...event, rate, sampledAt: now };
    state.fileTransfer = transfer;
    const prefix = state.role === 'receiver' ? 'receiver' : 'host';
    const card = byId(`${prefix}-file-transfer`);
    const progress = byId(`${prefix}-file-transfer-progress`);
    const cancel = byId(`${prefix}-file-transfer-cancel`);
    if (!card || !progress || !cancel) return;
    card.hidden = false;
    card.classList.toggle('is-complete', ['completed', 'sent'].includes(transfer.status));
    card.classList.toggle('is-error', ['error', 'canceled'].includes(transfer.status));
    setText(`${prefix}-file-transfer-name`, transfer.name || '文件剪贴板传输');
    const total = Math.max(0, Number(transfer.totalBytes) || 0);
    const bytes = Math.max(0, Number(transfer.bytes) || 0);
    progress.max = Math.max(1, total);
    progress.value = Math.min(progress.max, bytes);
    const labels = {
      offered: '等待另一台设备接收',
      sending: `正在发送 · ${formatBytes(bytes)} / ${formatBytes(total)} · ${formatBytes(rate)}/s`,
      sent: '文件内容已发送，等待写入剪贴板',
      receiving: `正在接收 · ${formatBytes(bytes)} / ${formatBytes(total)} · ${formatBytes(rate)}/s`,
      completed: transfer.direction === 'send'
        ? `对方已接收并写入文件剪贴板 · ${formatBytes(total)}`
        : `已接收并写入文件剪贴板 · ${formatBytes(total)}`,
      canceled: '传输已取消',
      error: transfer.message || '文件传输失败'
    };
    setText(`${prefix}-file-transfer-detail`, labels[transfer.status] || '正在准备文件传输');
    cancel.hidden = ['completed', 'sent', 'canceled', 'error'].includes(transfer.status);
    if (transfer.status === 'completed' && previous.status !== 'completed') {
      toast('文件剪贴板已同步', '现在可以直接在 Finder 或资源管理器中粘贴');
    } else if (transfer.status === 'error' && previous.status !== 'error') {
      toast('文件传输失败', transfer.message || '请重新复制后再试', 'error', 7200);
    }
  }

  function formatLastSeen(device) {
    const timestamp = device.lastConnected || device.lastSeen || device.discoveredAt;
    if (!timestamp) return device.online ? '刚刚发现' : '已记忆';
    const elapsed = Math.max(0, Date.now() - timestamp);
    if (elapsed < 60_000) return device.online ? '刚刚在线' : '刚刚使用';
    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
    if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
    return `${Math.floor(elapsed / 86_400_000)} 天前`;
  }

  function makeSignal(type, payload = {}) {
    if (!SIGNAL_TYPES.has(type)) throw new Error(`未知信令类型：${type}`);
    return { type, protocol: PROTOCOL_VERSION, ...payload };
  }

  function serializeDescription(description) {
    if (!description) return null;
    if (typeof description.toJSON === 'function') return description.toJSON();
    return { type: description.type, sdp: description.sdp };
  }

  function serializeCandidate(candidate) {
    if (!candidate) return null;
    if (typeof candidate.toJSON === 'function') return candidate.toJSON();
    return {
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid,
      sdpMLineIndex: candidate.sdpMLineIndex,
      usernameFragment: candidate.usernameFragment
    };
  }

  function parseSignal(raw, allowWelcome = false) {
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > 262_144) {
      throw new Error('收到的信令格式无效');
    }
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      throw new Error('收到的信令不是有效 JSON');
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('收到的信令结构无效');
    if (message.protocol !== PROTOCOL_VERSION) throw new Error('主端与子端协议版本不兼容');
    if (allowWelcome && message.type === 'welcome') {
      if (!message.receiver
        || typeof message.receiver.id !== 'string'
        || message.receiver.id.length < 1
        || message.receiver.id.length > 128
        || typeof message.receiver.name !== 'string'
        || message.receiver.name.length < 1
        || message.receiver.name.length > 64
        || !Number.isInteger(message.receiver.port)
        || message.receiver.port < 1
        || message.receiver.port > 65_535
        || (message.receiver.authMode !== undefined && message.receiver.authMode !== 'none')
        || (message.transportSecurity !== undefined && message.transportSecurity !== 'none')) {
        throw new Error('子端欢迎消息无效');
      }
      return message;
    }
    if (!SIGNAL_TYPES.has(message.type)) throw new Error('收到不支持的信令类型');
    if (message.type === 'hello'
      && (typeof message.hostId !== 'string'
        || message.hostId.length < 1
        || message.hostId.length > 128
        || typeof message.name !== 'string'
        || message.name.length < 1
        || message.name.length > 64)) {
      throw new Error('收到的 hello 信令无效');
    }
    if (message.type === 'offer' || message.type === 'answer') {
      if (!message.sdp
        || typeof message.sdp !== 'object'
        || message.sdp.type !== message.type
        || typeof message.sdp.sdp !== 'string'
        || message.sdp.sdp.length < 1
        || new TextEncoder().encode(message.sdp.sdp).byteLength > 220_000) {
        throw new Error('收到的 SDP 信令无效');
      }
    }
    if (message.type === 'ice' && message.candidate !== null) {
      if (!message.candidate
        || typeof message.candidate !== 'object'
        || typeof message.candidate.candidate !== 'string'
        || message.candidate.candidate.length < 1
        || new TextEncoder().encode(message.candidate.candidate).byteLength > 8_192) {
        throw new Error('收到的 ICE candidate 无效');
      }
    }
    if ((message.type === 'ping' || message.type === 'pong')
      && (!Number.isFinite(message.timestamp) || message.timestamp < 0)) {
      throw new Error('收到的心跳信令无效');
    }
    if (message.type === 'disconnect'
      && message.reason !== undefined
      && (typeof message.reason !== 'string'
        || new TextEncoder().encode(message.reason).byteLength > 120)) {
      throw new Error('收到的断开信令无效');
    }
    if (message.type === 'control') {
      const actions = new Set(['share-start', 'share-ready', 'share-stop', 'active', 'inactive', 'error']);
      if (!actions.has(message.action)) throw new Error('收到的键鼠控制信令无效');
      if (message.files !== undefined && typeof message.files !== 'boolean') {
        throw new Error('收到的文件剪贴板设置无效');
      }
      if (message.screen !== undefined
        && (!message.screen || !Number.isInteger(message.screen.width) || !Number.isInteger(message.screen.height))) {
        throw new Error('收到的屏幕信息无效');
      }
    }
    if (message.type === 'input') {
      const kinds = new Set(['pointer', 'button', 'wheel', 'key', 'releaseAll']);
      if (!message.event || !kinds.has(message.event.kind)) throw new Error('收到的输入事件无效');
    }
    if (message.type === 'clipboard'
      && (typeof message.text !== 'string'
        || new TextEncoder().encode(message.text).byteLength > 128 * 1024
        || typeof message.revision !== 'string')) {
      throw new Error('收到的剪贴板消息无效');
    }
    if (message.type === 'file-offer') {
      const transfer = message.transfer;
      if (!transfer
        || typeof transfer.id !== 'string'
        || !/^[0-9a-f-]{36}$/.test(transfer.id)
        || !Number.isInteger(transfer.port) || transfer.port < 1 || transfer.port > 65_535
        || !Number.isInteger(transfer.itemCount) || transfer.itemCount < 1 || transfer.itemCount > 10_000
        || !Number.isSafeInteger(transfer.totalBytes) || transfer.totalBytes < 0 || transfer.totalBytes > 20 * 1024 ** 3
        || !Array.isArray(transfer.names) || transfer.names.length < 1 || transfer.names.length > 16
        || transfer.names.some((name) => typeof name !== 'string' || !name
          || name.length > 180 || new TextEncoder().encode(name).byteLength > 512
          || /[\u0000-\u001f<>:"/\\|?*]/.test(name) || /[. ]$/.test(name)
          || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
        || !Number.isSafeInteger(transfer.expiresAt) || transfer.expiresAt <= 0) {
        throw new Error('收到的文件传输清单无效');
      }
    }
    if (message.type === 'file-status'
      && (typeof message.transferId !== 'string'
        || !/^[0-9a-f-]{36}$/.test(message.transferId)
        || !['receiving', 'completed', 'canceled', 'error'].includes(message.status)
        || (message.bytes !== undefined
          && (!Number.isSafeInteger(message.bytes) || message.bytes < 0 || message.bytes > 20 * 1024 ** 3))
        || (message.totalBytes !== undefined
          && (!Number.isSafeInteger(message.totalBytes) || message.totalBytes < 0
            || message.totalBytes > 20 * 1024 ** 3))
        || (message.message !== undefined
          && (typeof message.message !== 'string'
            || new TextEncoder().encode(message.message).byteLength > 512)))) {
      throw new Error('收到的文件传输状态无效');
    }
    return message;
  }

  function stableDisplaySerial(deviceId) {
    const input = `lanextend:display:${deviceId || 'local-default'}`;
    const bytes = new TextEncoder().encode(input);
    let hash = 0x811c9dc5;
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
    return hash || 1;
  }

  function setRoleVisibility(role) {
    all('.role-only').forEach((element) => {
      element.hidden = !element.classList.contains(`${role}-only`);
    });
    all('.role-panel').forEach((element) => {
      element.hidden = !element.classList.contains(`${role}-only`);
    });
    document.body.dataset.role = role;
    setText('role-label', role === 'host' ? 'macOS 主端 · 最高权限' : 'Windows 子端 · 接收模式');
    setText('page-eyebrow', role === 'host' ? 'MACOS · 主端' : 'WINDOWS · 子端');
    setText('page-title', role === 'host' ? '扩展工作台' : '接收工作台');
  }

  function renderUpdateControl(kind, title, detail) {
    const control = byId('update-control');
    if (!control) return;
    control.classList.toggle('is-checking', kind === 'checking');
    control.classList.toggle('is-available', kind === 'available');
    control.classList.toggle('is-error', kind === 'error');
    control.disabled = kind === 'checking';
    setText('update-title', title);
    setText('update-detail', detail);
  }

  async function checkForUpdates({ quiet = false } = {}) {
    if (state.updateChecking) return;
    state.updateChecking = true;
    renderUpdateControl('checking', '正在检查更新', '连接 GitHub Releases…');
    try {
      const info = await api.checkForUpdates();
      if (!info
        || typeof info.currentVersion !== 'string'
        || typeof info.latestVersion !== 'string'
        || typeof info.updateAvailable !== 'boolean') {
        throw new Error('更新服务返回了无法识别的信息');
      }
      state.updateInfo = info;
      if (info.updateAvailable) {
        renderUpdateControl('available', `发现 v${info.latestVersion}`, '点击前往 GitHub 下载');
        if (!quiet) toast('发现新版本', `LanExtend v${info.latestVersion} 已可下载`);
      } else {
        renderUpdateControl('current', '已是最新版本', `当前 v${info.currentVersion} · 点击复查`);
        if (!quiet) toast('无需更新', `当前已是 LanExtend v${info.currentVersion}`);
      }
    } catch (error) {
      state.updateInfo = null;
      renderUpdateControl('error', '暂时无法检查更新', '点击重试');
      if (!quiet) toast('检查更新失败', errorText(error), 'warning', 6200);
    } finally {
      state.updateChecking = false;
    }
  }

  function bindUpdateUi() {
    renderUpdateControl('idle', '检查更新', `当前 v${state.bootstrap.appVersion || '0.0.0'}`);
    byId('update-control')?.addEventListener('click', async () => {
      if (state.updateInfo?.updateAvailable) {
        try {
          await api.openLatestRelease();
        } catch (error) {
          toast('无法打开下载页', errorText(error), 'error');
        }
        return;
      }
      await checkForUpdates();
    });
  }

  function bindCommonUi() {
    all('[data-scroll-to]').forEach((button) => {
      button.addEventListener('click', () => {
        const target = byId(button.dataset.scrollTo);
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        all('.nav-item').forEach((item) => item.classList.toggle('is-active', item === button));
      });
    });
    all('[data-close-dialog]').forEach((button) => {
      button.addEventListener('click', () => byId(button.dataset.closeDialog)?.close());
    });
    byId('manual-device-dialog')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) event.currentTarget.close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.receiverFullscreen) setReceiverFullscreen(false);
    });
  }

  function bindIpcEvents() {
    api.onDevicesChanged((devices) => {
      if (!Array.isArray(devices)) return;
      state.devices = devices;
      if (state.role === 'host') renderDevices();
    });
    api.onDisplayChanged((status) => {
      state.virtualDisplayRunning = Boolean(status?.running);
      if (state.role === 'host') renderVirtualStatus(status);
    });
    api.onReceiverListening((event) => {
      state.listeningPort = Number(event?.port) || state.listeningPort;
      if (state.role === 'receiver') renderListeningStatus();
    });
    api.onReceiverConnected((connection) => {
      if (state.role !== 'receiver') {
        state.earlyReceiverConnection = connection;
        return;
      }
      onReceiverConnected(connection);
    });
    api.onReceiverDisconnected((event) => {
      if (!state.role) {
        if (!event?.sessionId || state.earlyReceiverConnection?.id === event.sessionId) state.earlyReceiverConnection = null;
        state.earlyReceiverSignals = state.earlyReceiverSignals.filter((item) => item?.sessionId !== event?.sessionId);
        return;
      }
      if (state.role === 'receiver') onReceiverDisconnected(event);
    });
    api.onReceiverSignal((event) => {
      if (!state.role) {
        state.earlyReceiverSignals.push(event);
        return;
      }
      if (state.role === 'receiver') handleReceiverSignal(event).catch((error) => {
        toast('无法处理主端信令', errorText(error), 'error');
        disconnectReceiver('信令协商失败');
      });
    });
    api.onServiceError((event) => {
      const serviceName = event?.service === 'discovery' ? '设备发现' : event?.service === 'advertiser' ? '局域网广播' : '连接服务';
      toast(`${serviceName}出现问题`, errorText(event?.message), 'error', 6500);
      if (state.role === 'receiver') {
        const badge = byId('receiver-service-badge');
        if (badge) {
          badge.textContent = '服务异常';
          badge.className = 'capability-badge is-error';
        }
        setSidebarStatus('error', '接收服务异常', errorText(event?.message));
      }
    });
    api.onInputOutbound((payload) => {
      const connection = state.hostConnection;
      if (state.role !== 'host' || !connection || connection.intentional) return;
      if (!payload?.type || !SIGNAL_TYPES.has(payload.type)) return;
      sendHostSignal(connection, makeSignal(payload.type, payload));
    });
    api.onInputHostStatus((status) => {
      state.inputStatus = { ...state.inputStatus, ...status };
      if (state.role === 'host') renderInputStatus();
    });
    api.onInputReceiverStatus((status) => {
      if (state.role === 'receiver') renderReceiverInputStatus(status);
    });
    api.onInputWarning((event) => toast('键鼠共享提示', errorText(event?.message), 'warning', 6200));
    api.onFileTransfer((event) => renderFileTransfer(event));
  }

  function applyHostSettings(settings) {
    const host = settings.host;
    byId('display-width').value = host.width;
    byId('display-height').value = host.height;
    byId('display-fps').value = String(host.fps);
    byId('display-bitrate').value = String(host.bitrateMbps);
    byId('display-hidpi').checked = Boolean(host.hiDPI);
    byId('auto-reconnect').checked = Boolean(host.autoReconnect);
    updateBitrateRange();

    const preset = `${host.width}x${host.height}`;
    const option = all('#resolution-preset option').find((item) => item.value === preset);
    byId('resolution-preset').value = option ? preset : 'custom';
    byId('custom-resolution').hidden = Boolean(option);
    state.selectedDeviceId = host.lastDeviceId || null;
    const input = settings.inputSharing || {};
    byId('clipboard-sync').checked = input.clipboard !== false;
    byId('file-clipboard-sync').checked = input.fileClipboard !== false;
    byId('input-auto-reconnect').checked = input.autoReconnect !== false;
    byId('input-edge-delay').value = String(Number.isInteger(input.edgeDelayMs) ? input.edgeDelayMs : 80);
    setText('input-edge-delay-output', `${byId('input-edge-delay').value} ms`);
    if (!state.selectedDeviceId && input.lastDeviceId) state.selectedDeviceId = input.lastDeviceId;
  }

  function readHostOptions() {
    let width;
    let height;
    const preset = byId('resolution-preset').value;
    if (preset === 'custom') {
      width = clamp(Math.round(Number(byId('display-width').value) || 1920), 800, 7680);
      height = clamp(Math.round(Number(byId('display-height').value) || 1080), 600, 4320);
      if (width % 2) width += width === 7680 ? -1 : 1;
      if (height % 2) height += height === 4320 ? -1 : 1;
      byId('display-width').value = width;
      byId('display-height').value = height;
    } else {
      [width, height] = preset.split('x').map(Number);
    }
    return {
      width,
      height,
      fps: Number(byId('display-fps').value),
      bitrateMbps: Number(byId('display-bitrate').value),
      hiDPI: byId('display-hidpi').checked,
      autoReconnect: byId('auto-reconnect').checked,
      lastDeviceId: state.selectedDeviceId,
      lastSourceId: byId('capture-source').value || state.bootstrap.settings.host.lastSourceId || null
    };
  }

  function localDisplayRects() {
    return (state.bootstrap?.displays || []).map((display, index) => ({
      id: String(display.id),
      label: display.label || `Mac 显示器 ${index + 1}`,
      x: Math.round(display.bounds?.x || 0),
      y: Math.round(display.bounds?.y || 0),
      width: Math.max(1, Math.round(display.bounds?.width || 1920)),
      height: Math.max(1, Math.round(display.bounds?.height || 1080))
    }));
  }

  function defaultInputLayout(device) {
    const locals = localDisplayRects();
    const top = Math.min(...locals.map((display) => display.y));
    const topRow = locals.filter((display) => display.y === top);
    const anchor = topRow.reduce((best, display) => (
      !best || display.x + display.width > best.x + best.width ? display : best
    ), null) || { x: 0, y: 0, width: 1920, height: 1080 };
    return {
      deviceId: device?.id || '',
      x: anchor.x + anchor.width,
      y: anchor.y,
      width: Math.round(device?.display?.width || 1920),
      height: Math.round(device?.display?.height || 1080)
    };
  }

  function ensureInputLayout(reset = false) {
    const device = state.devices.find((item) => item.id === state.selectedDeviceId);
    if (!device) {
      state.inputLayout = null;
      return null;
    }
    if (!reset && state.inputLayout?.deviceId === device.id) return state.inputLayout;
    const saved = (state.bootstrap.settings.inputSharing?.layouts || [])
      .find((layout) => layout.deviceId === device.id);
    state.inputLayout = reset ? defaultInputLayout(device) : { ...(saved || defaultInputLayout(device)) };
    if (device.display) {
      state.inputLayout.width = device.display.width;
      state.inputLayout.height = device.display.height;
    }
    return state.inputLayout;
  }

  function readInputOptions() {
    const layout = ensureInputLayout();
    const previous = state.bootstrap.settings.inputSharing || {};
    const layouts = (previous.layouts || []).filter((item) => item.deviceId !== layout?.deviceId);
    if (layout) layouts.push({ ...layout });
    return {
      lastDeviceId: state.selectedDeviceId,
      clipboard: byId('clipboard-sync').checked,
      fileClipboard: byId('file-clipboard-sync').checked,
      autoReconnect: byId('input-auto-reconnect').checked,
      edgeDelayMs: Number(byId('input-edge-delay').value) || 0,
      layouts
    };
  }

  async function persistInputOptions() {
    if (!state.bootstrap || !state.inputLayout) return;
    state.bootstrap.settings = await api.updateSettings({ inputSharing: readInputOptions() });
  }

  function snapInputLayout(layout, threshold) {
    const remote = { ...layout };
    let best = { distance: threshold, x: remote.x, y: remote.y };
    for (const local of localDisplayRects()) {
      const candidates = [
        { distance: Math.abs(remote.x - (local.x + local.width)), x: local.x + local.width, y: remote.y },
        { distance: Math.abs((remote.x + remote.width) - local.x), x: local.x - remote.width, y: remote.y },
        { distance: Math.abs(remote.y - (local.y + local.height)), x: remote.x, y: local.y + local.height },
        { distance: Math.abs((remote.y + remote.height) - local.y), x: remote.x, y: local.y - remote.height }
      ];
      for (const candidate of candidates) if (candidate.distance < best.distance) best = candidate;
    }
    return { ...remote, x: Math.round(best.x), y: Math.round(best.y) };
  }

  function renderInputLayout() {
    const container = byId('layout-nodes');
    const canvas = byId('input-layout-canvas');
    if (!container || !canvas) return;
    container.replaceChildren();
    const layout = ensureInputLayout();
    const locals = localDisplayRects();
    const device = state.devices.find((item) => item.id === state.selectedDeviceId);
    setText('input-device-name', device?.name || '请先选择 Windows 子端');
    setText('input-device-resolution', layout ? `${layout.width} × ${layout.height}` : '—');
    if (!locals.length) return;
    const rectangles = layout ? [...locals, layout] : locals;
    const left = Math.min(...rectangles.map((rect) => rect.x));
    const top = Math.min(...rectangles.map((rect) => rect.y));
    const right = Math.max(...rectangles.map((rect) => rect.x + rect.width));
    const bottom = Math.max(...rectangles.map((rect) => rect.y + rect.height));
    const canvasWidth = Math.max(320, canvas.clientWidth || 640);
    const canvasHeight = Math.max(220, canvas.clientHeight || 330);
    const padding = 24;
    const scale = Math.min((canvasWidth - padding * 2) / Math.max(1, right - left), (canvasHeight - padding * 2) / Math.max(1, bottom - top));
    const offsetX = (canvasWidth - (right - left) * scale) / 2 - left * scale;
    const offsetY = (canvasHeight - (bottom - top) * scale) / 2 - top * scale;
    const createNode = (rect, remote, index) => {
      const node = document.createElement('div');
      node.className = `layout-node${remote ? ' is-remote' : ''}${state.hostConnection ? ' is-disabled' : ''}`;
      node.style.left = `${offsetX + rect.x * scale}px`;
      node.style.top = `${offsetY + rect.y * scale}px`;
      node.style.width = `${Math.max(58, rect.width * scale)}px`;
      node.style.height = `${Math.max(40, rect.height * scale)}px`;
      const copy = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = remote ? (device?.name || 'Windows') : `Mac · ${index + 1}`;
      const dimensions = document.createElement('small');
      dimensions.textContent = `${rect.width} × ${rect.height}`;
      copy.append(title, dimensions);
      node.append(copy);
      if (remote) {
        node.dataset.remote = 'true';
        node.addEventListener('pointerdown', (event) => beginInputLayoutDrag(event, scale));
      }
      container.append(node);
    };
    locals.forEach((rect, index) => createNode(rect, false, index));
    if (layout) createNode(layout, true, locals.length);
  }

  function beginInputLayoutDrag(event, scale) {
    if (state.hostConnection || !state.inputLayout) return;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Window-level listeners keep the drag alive. */ }
    event.currentTarget.classList.add('is-dragging');
    state.inputDrag = {
      pointerId: event.pointerId,
      node: event.currentTarget,
      startX: event.clientX,
      startY: event.clientY,
      layout: { ...state.inputLayout },
      scale
    };
  }

  function moveInputLayoutDrag(event) {
    const drag = state.inputDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const candidate = {
      ...drag.layout,
      x: drag.layout.x + (event.clientX - drag.startX) / drag.scale,
      y: drag.layout.y + (event.clientY - drag.startY) / drag.scale
    };
    state.inputLayout = snapInputLayout(candidate, 85 / drag.scale);
    renderInputLayout();
    const replacement = byId('layout-nodes').querySelector('[data-remote="true"]');
    replacement?.classList.add('is-dragging');
    state.inputDrag.node = replacement;
  }

  function endInputLayoutDrag(event) {
    if (!state.inputDrag || event.pointerId !== state.inputDrag.pointerId) return;
    state.inputDrag.node?.classList.remove('is-dragging');
    state.inputDrag = null;
    persistInputOptions().catch((error) => toast('无法保存设备布局', errorText(error), 'error'));
  }

  function updateBitrateRange() {
    const range = byId('display-bitrate');
    const value = Number(range.value);
    const progress = ((value - Number(range.min)) / (Number(range.max) - Number(range.min))) * 100;
    for (let bucket = 0; bucket <= 100; bucket += 10) range.classList.remove(`range-p-${bucket}`);
    range.classList.add(`range-p-${Math.round(progress / 10) * 10}`);
    setText('bitrate-output', `${value} Mbps`);
  }

  function bindHostUi() {
    byId('refresh-devices').addEventListener('click', refreshDevices);
    byId('open-manual-device').addEventListener('click', () => {
      byId('manual-device-error').textContent = '';
      byId('manual-device-dialog').showModal();
      window.setTimeout(() => byId('manual-host').focus(), 50);
    });
    byId('manual-device-form').addEventListener('submit', saveManualDevice);
    byId('refresh-sources').addEventListener('click', () => refreshSources(true));
    all('input[name="captureMode"]').forEach((input) => input.addEventListener('change', renderCaptureMode));
    byId('resolution-preset').addEventListener('change', () => {
      const custom = byId('resolution-preset').value === 'custom';
      byId('custom-resolution').hidden = !custom;
      if (!custom) {
        const [width, height] = byId('resolution-preset').value.split('x');
        byId('display-width').value = width;
        byId('display-height').value = height;
      }
    });
    byId('display-bitrate').addEventListener('input', updateBitrateRange);
    byId('capture-source').addEventListener('change', () => updateConnectAvailability());
    byId('connect-button').addEventListener('click', () => beginHostConnection(false));
    byId('disconnect-button').addEventListener('click', () => disconnectHost('由主端断开'));
    byId('input-connect-button').addEventListener('click', () => beginHostConnection(false, 'input'));
    byId('input-disconnect-button').addEventListener('click', () => disconnectHost('由主端停止键鼠共享'));
    byId('reset-input-layout').addEventListener('click', () => {
      ensureInputLayout(true);
      renderInputLayout();
      persistInputOptions().catch((error) => toast('无法保存设备布局', errorText(error), 'error'));
    });
    byId('input-edge-delay').addEventListener('input', () => {
      setText('input-edge-delay-output', `${byId('input-edge-delay').value} ms`);
    });
    byId('input-edge-delay').addEventListener('change', () => persistInputOptions().catch(() => {}));
    byId('clipboard-sync').addEventListener('change', () => persistInputOptions().catch(() => {}));
    byId('file-clipboard-sync').addEventListener('change', () => persistInputOptions().catch(() => {}));
    byId('input-auto-reconnect').addEventListener('change', () => persistInputOptions().catch(() => {}));
    byId('host-file-transfer-cancel').addEventListener('click', () => {
      if (state.fileTransfer?.transferId) api.cancelFileTransfer(state.fileTransfer.transferId);
    });
    window.addEventListener('pointermove', moveInputLayoutDrag);
    window.addEventListener('pointerup', endInputLayoutDrag);
    window.addEventListener('pointercancel', endInputLayoutDrag);
    window.addEventListener('resize', () => renderInputLayout());
    byId('request-accessibility').addEventListener('click', async () => {
      const granted = await api.requestAccessibility();
      if (!granted) {
        await api.openAccessibilitySettings();
        toast('请开启辅助功能权限', '在列表中允许 LanExtend，然后返回并再次启动键鼠共享。', 'warning', 7200);
      }
      await refreshInputStatus();
    });
    byId('open-screen-permission').addEventListener('click', async () => {
      await api.openScreenSettings();
      window.setTimeout(() => refreshScreenPermission(), 800);
    });
  }

  async function refreshInputStatus() {
    if (state.role !== 'host') return state.inputStatus;
    try {
      const result = await api.getInputStatus();
      state.inputAccessibility = Boolean(result?.accessibility);
      state.inputStatus = { ...state.inputStatus, ...(result?.status || {}), supported: Boolean(result?.supported) };
    } catch {
      state.inputAccessibility = false;
    }
    renderInputStatus();
    return state.inputStatus;
  }

  function renderInputStatus() {
    const badge = byId('input-sharing-badge');
    const live = byId('input-live-status');
    const button = byId('input-connect-button');
    if (!badge || !live || !button) return;
    byId('accessibility-banner').hidden = state.inputAccessibility || !state.inputStatus.supported;
    live.className = `input-live-status${state.inputStatus.active ? ' is-active' : state.inputStatus.running ? ' is-ready' : ''}`;
    if (!state.inputStatus.supported) {
      badge.textContent = '组件不可用';
      badge.className = 'capability-badge is-error';
      live.querySelector('strong').textContent = '键鼠助手不可用';
      live.querySelector('small').textContent = '请重新构建或安装完整版本';
    } else if (state.inputStatus.active) {
      badge.textContent = '正在控制 Windows';
      badge.className = 'capability-badge is-success';
      live.querySelector('strong').textContent = '控制权在 Windows';
      live.querySelector('small').textContent = '将鼠标移回相邻边缘即可返回 Mac';
    } else if (state.inputStatus.running) {
      badge.textContent = '共享运行中';
      badge.className = 'capability-badge is-success';
      live.querySelector('strong').textContent = '等待跨越屏幕边缘';
      live.querySelector('small').textContent = '当前键盘和鼠标仍由 Mac 控制';
    } else {
      badge.textContent = state.inputAccessibility ? '可以启动' : '需要系统权限';
      badge.className = 'capability-badge';
      live.querySelector('strong').textContent = '尚未启动';
      live.querySelector('small').textContent = '鼠标仍由 Mac 控制';
    }
    const hasDevice = Boolean(state.devices.find((item) => item.id === state.selectedDeviceId));
    button.disabled = Boolean(state.hostConnection || !hasDevice || !state.inputStatus.supported);
    button.textContent = hasDevice ? '启动键鼠共享' : '请先选择 Windows 子端';
    renderInputLayout();
  }

  function renderScreenPermission(status) {
    state.screenPermission = status || 'unknown';
    const granted = state.screenPermission === 'granted';
    const banner = byId('permission-banner');
    if (banner) banner.hidden = granted;
    setText(
      'permission-message',
      state.screenPermission === 'denied'
        ? '系统当前未授权这个 LanExtend 副本，因此扩展屏不可用；键鼠共享不受影响。'
        : '扩展屏功能需要此权限；键鼠共享不受影响。授权后返回此窗口会自动重新检测。'
    );
    updateConnectAvailability();
    return granted;
  }

  async function refreshScreenPermission() {
    if (state.role !== 'host') return false;
    try {
      return renderScreenPermission(await api.getScreenPermission());
    } catch {
      return renderScreenPermission('unknown');
    }
  }

  function renderCaptureMode() {
    const existing = document.querySelector('input[name="captureMode"]:checked')?.value === 'existing';
    byId('source-picker-row').hidden = !existing;
    updateConnectAvailability();
  }

  function renderVirtualStatus(status = state.bootstrap.virtualDisplay) {
    const badge = byId('virtual-badge');
    if (!badge) return;
    const capabilitySupported = status?.capability?.supported
      ?? state.bootstrap?.virtualDisplay?.capability?.supported
      ?? status?.supported;
    if (status?.running) {
      badge.textContent = '虚拟屏运行中';
      badge.className = 'capability-badge is-success';
    } else if (capabilitySupported) {
      badge.textContent = '支持虚拟显示';
      badge.className = 'capability-badge';
    } else {
      badge.textContent = '使用已有显示器';
      badge.className = 'capability-badge';
    }
  }

  function renderDevices() {
    const list = byId('device-list');
    const empty = byId('device-empty');
    list.replaceChildren();
    setText('device-count', state.devices.filter((device) => device.online).length);
    empty.hidden = state.devices.length > 0;
    list.hidden = state.devices.length === 0;

    if (state.selectedDeviceId && !state.devices.some((device) => device.id === state.selectedDeviceId)) {
      state.selectedDeviceId = null;
    }

    for (const device of state.devices) {
      const card = document.createElement('div');
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
      card.className = `device-card${device.id === state.selectedDeviceId ? ' is-selected' : ''}${device.online === false ? ' is-disabled' : ''}`;
      card.dataset.deviceId = device.id;
      const icon = document.createElement('span');
      icon.className = 'device-icon';
      const copy = document.createElement('span');
      copy.className = 'device-copy';
      const name = document.createElement('strong');
      name.textContent = device.name || 'Windows 子端';
      const meta = document.createElement('span');
      meta.className = 'device-meta';
      const online = document.createElement('i');
      online.className = `device-online${device.online ? ' is-online' : ''}`;
      const address = document.createElement('span');
      address.textContent = formatAddress(device.host, device.port);
      const seen = document.createElement('span');
      seen.textContent = device.online ? '在线' : formatLastSeen(device);
      meta.append(online, address, seen);
      copy.append(name, meta);
      const check = document.createElement('span');
      check.className = 'device-check';
      check.textContent = '✓';
      card.append(icon, copy, check);
      card.addEventListener('click', () => selectDevice(device.id));
      card.addEventListener('keydown', (event) => {
        if (event.target !== card) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectDevice(device.id);
        }
      });

      if (!device.online || device.lastConnected || String(device.id).startsWith('manual:')) {
        const forget = document.createElement('button');
        forget.type = 'button';
        forget.className = 'device-forget';
        forget.setAttribute('aria-label', `忘记 ${device.name}`);
        forget.title = '忘记设备';
        forget.textContent = '×';
        forget.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          forgetDevice(device.id);
        });
        card.append(forget);
      }
      list.append(card);
    }
    updateConnectAvailability();
    renderInputLayout();
    renderInputStatus();
  }

  function selectDevice(id) {
    if (state.hostConnection) return;
    state.selectedDeviceId = id;
    state.inputLayout = null;
    renderDevices();
    setConnectionSteps('display');
    const device = state.devices.find((item) => item.id === id);
    if (device) {
      setText('connect-button-label', `扩展到 ${device.name}`);
      setText('connect-hint', `${formatAddress(device.host, device.port)} · 主端主动连接`);
    }
    renderInputLayout();
    renderInputStatus();
  }

  async function forgetDevice(id) {
    try {
      await api.forgetDevice(id);
      if (state.selectedDeviceId === id) state.selectedDeviceId = null;
      state.devices = await api.getDevices();
      renderDevices();
      toast('已忘记设备', '它仍可在下次广播时重新出现');
    } catch (error) {
      toast('无法忘记设备', errorText(error), 'error');
    }
  }

  async function refreshDevices() {
    const button = byId('refresh-devices');
    button.classList.add('is-spinning');
    try {
      state.devices = await api.getDevices();
      renderDevices();
    } catch (error) {
      toast('刷新设备失败', errorText(error), 'error');
    } finally {
      window.setTimeout(() => button.classList.remove('is-spinning'), 350);
    }
  }

  async function saveManualDevice(event) {
    event.preventDefault();
    const name = byId('manual-name').value.trim() || 'Windows 子端';
    const host = byId('manual-host').value.trim();
    const port = Number(byId('manual-port').value);
    const errorElement = byId('manual-device-error');
    const saveButton = byId('save-manual-device');
    errorElement.textContent = '';
    saveButton.disabled = true;
    try {
      const validation = await api.validateTarget(host, port);
      if (!validation?.valid) throw new Error('请输入有效的私有局域网 IPv4 地址和端口');
      const device = {
        id: `manual:${host}:${port}`.slice(0, 128),
        name,
        host,
        port,
        online: false,
        lastSeen: Date.now()
      };
      await api.rememberDevice(device, false);
      state.devices = await api.getDevices();
      state.selectedDeviceId = device.id;
      renderDevices();
      byId('manual-device-dialog').close();
      setConnectionSteps('display');
      toast('子端已添加', `可以主动连接 ${formatAddress(host, port)}`);
    } catch (error) {
      errorElement.textContent = errorText(error);
    } finally {
      saveButton.disabled = false;
    }
  }

  async function refreshSources(showFeedback = false, preferredId = null) {
    const button = byId('refresh-sources');
    button?.classList.add('is-spinning');
    const select = byId('capture-source');
    const prior = preferredId || select.value || state.bootstrap?.settings?.host?.lastSourceId;
    try {
      state.sources = await api.listSources();
      select.replaceChildren();
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = state.sources.length ? '请选择要发送的显示器' : '没有可用的显示器';
      select.append(placeholder);
      for (const source of state.sources) {
        const option = document.createElement('option');
        option.value = source.id;
        option.textContent = source.name || `显示器 ${source.displayId || ''}`;
        select.append(option);
      }
      if (prior && state.sources.some((source) => source.id === prior)) select.value = prior;
      if (showFeedback) toast('显示器列表已刷新', `找到 ${state.sources.length} 个可捕获来源`);
      updateConnectAvailability();
      return state.sources;
    } catch (error) {
      select.replaceChildren();
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '无法读取显示器';
      select.append(option);
      if (showFeedback) toast('读取显示器失败', errorText(error), 'error');
      return [];
    } finally {
      window.setTimeout(() => button?.classList.remove('is-spinning'), 300);
    }
  }

  function updateConnectAvailability() {
    const button = byId('connect-button');
    if (!button) return;
    const mode = document.querySelector('input[name="captureMode"]:checked')?.value || 'virtual';
    const sourceReady = mode === 'virtual' || Boolean(byId('capture-source').value);
    const permissionReady = state.role !== 'host' || state.screenPermission === 'granted';
    button.disabled = Boolean(state.hostConnection || state.reconnectTimer || !state.selectedDeviceId || !sourceReady || !permissionReady);
    if (!state.selectedDeviceId) setText('connect-button-label', '选择设备后开始扩展');
    else if (!state.hostConnection) {
      const device = state.devices.find((item) => item.id === state.selectedDeviceId);
      setText('connect-button-label', device ? `扩展到 ${device.name}` : '开始扩展');
    }
  }

  async function chooseCaptureSource(options, connection) {
    const mode = document.querySelector('input[name="captureMode"]:checked')?.value || 'virtual';
    if (mode === 'existing') {
      const id = byId('capture-source').value;
      const source = state.sources.find((item) => item.id === id);
      if (!source) throw new Error('请先选择要发送的已有显示器');
      return source;
    }

    const selected = connection.device;
    const serial = stableDisplaySerial(selected?.id);
    let display;
    try {
      display = await api.createVirtualDisplay({
        width: options.width,
        height: options.height,
        fps: options.fps,
        hiDPI: options.hiDPI,
        name: `LanExtend · ${selected?.name || '扩展屏'}`.slice(0, 64),
        serial
      });
      connection.virtualOwned = true;
      state.virtualDisplayRunning = true;
      if (display?.extended === false) {
        await api.destroyVirtualDisplay();
        connection.virtualOwned = false;
        state.virtualDisplayRunning = false;
        throw new Error('macOS 未能把新显示器切换为扩展模式，为避免误投主屏已自动移除');
      }
    } catch (error) {
      await switchToCaptureFallback(error);
      throw new Error(`虚拟扩展屏创建失败：${errorText(error)}。请选择一个已有显示器后重试。`);
    }

    const wanted = [display?.displayId, display?.id].filter((value) => value !== undefined && value !== null).map(String);
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const sources = await refreshSources(false);
      const match = sources.find((source) => wanted.includes(String(source.displayId)))
        || sources.find((source) => /LanExtend/i.test(source.name || ''));
      if (match) return match;
      await sleep(250);
    }
    await switchToCaptureFallback(new Error('系统尚未公布新建的虚拟显示器'));
    throw new Error('虚拟屏已创建，但暂时无法捕获。请选择已有显示器后重试。');
  }

  async function switchToCaptureFallback(reason) {
    const existingRadio = document.querySelector('input[name="captureMode"][value="existing"]');
    if (existingRadio) existingRadio.checked = true;
    renderCaptureMode();
    await refreshSources(false);
    toast('已切换到兼容模式', errorText(reason), 'warning', 6800);
  }

  async function acquireCapture(source, options, connection) {
    await api.prepareCapture(source.id);
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('当前运行环境不支持屏幕捕获');
    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: false,
      video: {
        width: { ideal: options.width },
        height: { ideal: options.height },
        frameRate: { ideal: options.fps, max: options.fps }
      }
    });
    const track = stream.getVideoTracks()[0];
    if (!track) {
      stream.getTracks().forEach((item) => item.stop());
      throw new Error('没有获得可用的视频轨道');
    }
    try { track.contentHint = 'detail'; } catch { /* Older WebRTC builds may not expose it. */ }
    try {
      await track.applyConstraints({
        width: { ideal: options.width, max: options.width },
        height: { ideal: options.height, max: options.height },
        frameRate: { ideal: options.fps, max: options.fps }
      });
    } catch {
      // Some desktop capture backends expose a fixed mode; sender bitrate still remains bounded.
    }
    track.addEventListener('ended', () => {
      if (state.hostConnection === connection && !connection.intentional) handleHostLoss(connection, '屏幕捕获已停止');
    }, { once: true });
    connection.stream = stream;
    connection.source = source;
    return stream;
  }

  function createPeerConnection() {
    return new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });
  }

  async function configureSender(sender, options, track = null) {
    try {
      const parameters = sender.getParameters();
      if (!parameters.encodings?.length) parameters.encodings = [{}];
      parameters.encodings[0].maxBitrate = options.bitrateMbps * 1_000_000;
      parameters.encodings[0].maxFramerate = options.fps;
      const settings = track?.getSettings?.() || {};
      const scale = Math.max(
        1,
        Number(settings.width) / options.width || 1,
        Number(settings.height) / options.height || 1
      );
      if (scale > 1.01) parameters.encodings[0].scaleResolutionDownBy = scale;
      parameters.degradationPreference = 'maintain-resolution';
      await sender.setParameters(parameters);
    } catch {
      // The selected WebRTC backend may defer encoding parameters until negotiation.
    }
  }

  function addPreferredVideoSender(pc, stream) {
    const track = stream.getVideoTracks()[0];
    let transceiver;
    try {
      transceiver = pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
    } catch {
      return pc.addTrack(track, stream);
    }
    try {
      const capabilities = typeof RTCRtpSender.getCapabilities === 'function'
        ? RTCRtpSender.getCapabilities('video')
        : null;
      if (capabilities?.codecs?.length && typeof transceiver.setCodecPreferences === 'function') {
        const rank = (codec) => {
          const mime = String(codec.mimeType || '').toLowerCase();
          if (mime === 'video/h264') return 0;
          if (mime === 'video/vp8') return 1;
          if (mime === 'video/rtx' || mime === 'video/red' || mime === 'video/ulpfec') return 2;
          return 3;
        };
        const codecs = capabilities.codecs
          .map((codec, index) => ({ codec, index }))
          .sort((left, right) => rank(left.codec) - rank(right.codec) || left.index - right.index)
          .map((entry) => entry.codec);
        transceiver.setCodecPreferences(codecs);
      }
    } catch {
      // Codec preference is an optimization; WebRTC's negotiated default remains a safe fallback.
    }
    return transceiver.sender;
  }

  async function beginHostConnection(isReconnect, requestedMode = 'display') {
    if (state.hostConnection) return;
    const mode = requestedMode === 'input' ? 'input' : 'display';
    if (mode === 'display' && !(await refreshScreenPermission())) {
      toast('需要屏幕录制权限', '请在系统设置中授权当前安装在“应用程序”目录的 LanExtend，然后返回此窗口。', 'warning', 7200);
      return;
    }
    if (mode === 'input') {
      await refreshInputStatus();
      if (!state.inputStatus.supported) {
        toast('键鼠共享组件不可用', '请安装包含原生输入助手的完整版本。', 'error', 7200);
        return;
      }
      if (!state.inputAccessibility) {
        const granted = await api.requestAccessibility();
        state.inputAccessibility = Boolean(granted);
        renderInputStatus();
        if (!granted) {
          await api.openAccessibilitySettings();
          toast('需要辅助功能权限', '开启 LanExtend 后返回此窗口，再次点击“启动键鼠共享”。', 'warning', 7200);
          return;
        }
      }
    }
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    const device = state.devices.find((item) => item.id === state.selectedDeviceId);
    if (!device) {
      toast('请先选择子端', '选择自动发现的设备，或手动添加 IP 地址', 'warning');
      updateConnectAvailability();
      return;
    }

    const options = mode === 'input' ? readInputOptions() : readHostOptions();
    const connection = {
      id: `${Date.now()}-${Math.random()}`,
      device: { ...device },
      mode,
      options,
      stream: null,
      source: null,
      pc: null,
      ws: null,
      virtualOwned: false,
      intentional: false,
      failed: false,
      connected: false,
      offered: false,
      pendingIce: [],
      statsTimer: null,
      statsPrevious: null,
      heartbeatTimer: null,
      welcomeTimer: null,
      negotiationTimer: null,
      lastPongAt: null,
      lastPingRtt: null
    };
    state.hostConnection = connection;
    state.reconnectMode = mode;
    renderInputStatus();
    if (mode === 'input') renderInputConnecting(device, isReconnect);
    else renderHostConnecting(device, isReconnect ? `正在第 ${state.reconnectAttempt} 次重连` : '正在准备扩展屏');

    try {
      const target = await api.validateTarget(device.host, Number(device.port));
      if (!target?.valid) throw new Error('子端不是有效的私有局域网地址');
      state.bootstrap.settings = await api.updateSettings(
        mode === 'input' ? { inputSharing: options } : { host: options }
      );
      await api.rememberDevice(device, false);
      if (state.hostConnection !== connection || connection.intentional) {
        cleanupHostConnection(connection);
        return;
      }
      openHostSocket(connection);
    } catch (error) {
      if (state.hostConnection !== connection) return;
      state.hostConnection = null;
      cleanupHostConnection(connection);
      const message = errorText(error);
      renderHostIdle();
      toast(isReconnect ? '自动重连未成功' : mode === 'input' ? '无法启动键鼠共享' : '无法开始扩展', message, 'error', 7200);
      if (isReconnect && options.autoReconnect) scheduleReconnect(message, mode);
      else if (connection.virtualOwned) api.destroyVirtualDisplay().catch(() => {});
    }
  }

  function wireHostPeer(connection) {
    const pc = connection.pc;
    pc.onicecandidate = (event) => {
      sendHostSignal(connection, makeSignal('ice', {
        candidate: serializeCandidate(event.candidate)
      }));
    };
    pc.onconnectionstatechange = () => {
      if (state.hostConnection !== connection || connection.intentional) return;
      if (pc.connectionState === 'connected') markHostConnected(connection);
      else if (pc.connectionState === 'failed') handleHostLoss(connection, 'WebRTC 连接失败');
      else if (pc.connectionState === 'closed') handleHostLoss(connection, '画面连接已关闭');
      else if (pc.connectionState === 'disconnected') {
        setHostActivity('连接暂时中断', '正在等待网络恢复');
        window.setTimeout(() => {
          if (state.hostConnection === connection && pc.connectionState === 'disconnected') {
            handleHostLoss(connection, '局域网连接已中断');
          }
        }, 4500);
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'checking') setHostActivity('正在建立点对点通道', '检测局域网路径');
    };
  }

  function openHostSocket(connection) {
    if (connection.mode === 'display') setConnectionSteps('display');
    if (connection.mode === 'display') setHostActivity('正在连接 Windows 子端', formatAddress(connection.device.host, connection.device.port));
    else setInputActivity('正在连接 Windows 子端', formatAddress(connection.device.host, connection.device.port));
    const socket = new WebSocket(`ws://${connection.device.host}:${connection.device.port}`);
    connection.ws = socket;
    socket.addEventListener('open', () => {
      if (state.hostConnection !== connection) return;
      if (connection.mode === 'display') setHostActivity('子端已响应', '正在协商扩展画面');
      else setInputActivity('子端已响应', '正在启动键鼠接收器');
      connection.welcomeTimer = window.setTimeout(() => handleHostLoss(connection, '子端握手超时'), 10_000);
    });
    socket.addEventListener('message', (event) => {
      handleHostSocketMessage(connection, event.data).catch((error) => handleHostLoss(connection, errorText(error)));
    });
    socket.addEventListener('error', () => {
      if (state.hostConnection === connection && !connection.intentional) {
        if (connection.mode === 'display') setHostActivity('无法连接子端', '请检查子端、防火墙与局域网');
        else setInputActivity('无法连接子端', '请检查子端、防火墙与局域网');
      }
    });
    socket.addEventListener('close', (event) => {
      if (state.hostConnection !== connection || connection.intentional) return;
      const reason = event.reason || (event.code === 1013 ? '子端当前正在使用' : `信令连接已关闭 (${event.code})`);
      handleHostLoss(connection, reason, event.code !== 1000 && event.code !== 1008);
    });
  }

  async function handleHostSocketMessage(connection, raw) {
    if (state.hostConnection !== connection || connection.intentional) return;
    const message = parseSignal(raw, true);
    if (message.type === 'welcome') {
      clearTimeout(connection.welcomeTimer);
      if (!message.receiver?.id || !message.receiver?.name) throw new Error('子端欢迎消息缺少设备信息');
      await reconcileConnectedDevice(connection, message.receiver);
      if (state.hostConnection !== connection || connection.intentional) return;
      sendHostSignal(connection, makeSignal('hello', {
        hostId: state.bootstrap.settings.receiver.id || 'lanextend-macos-host',
        name: 'Mac 主端'
      }));
      connection.lastPongAt = performance.now();
      startHostHeartbeat(connection);
      if (!connection.offered) {
        connection.offered = true;
        if (connection.mode === 'input') {
          const layout = ensureInputLayout();
          sendHostSignal(connection, makeSignal('control', {
            action: 'share-start',
            clipboard: connection.options.clipboard,
            files: connection.options.fileClipboard,
            screen: { width: layout.width, height: layout.height }
          }));
          clearTimeout(connection.negotiationTimer);
          connection.negotiationTimer = window.setTimeout(() => {
            if (state.hostConnection === connection && !connection.connected) {
              handleHostLoss(connection, 'Windows 键鼠接收器启动超时');
            }
          }, 15_000);
        } else await prepareHostMediaAndOffer(connection);
      }
      return;
    }
    if (message.type === 'control') {
      if (message.action === 'share-ready' && connection.mode === 'input') {
        const layout = ensureInputLayout();
        if (message.screen) {
          layout.width = message.screen.width;
          layout.height = message.screen.height;
        }
        await persistInputOptions();
        await api.startInputSharing({
          locals: localDisplayRects(),
          remote: { ...layout },
          edgeDelayMs: connection.options.edgeDelayMs
        }, connection.options.clipboard, connection.options.fileClipboard);
        if (state.pendingClipboard) {
          await api.applyRemoteClipboard(state.pendingClipboard);
          state.pendingClipboard = null;
        }
        markInputConnected(connection);
        return;
      }
      if (message.action === 'error') throw new Error(message.message || 'Windows 无法启动键鼠接收器');
      return;
    }
    if (message.type === 'clipboard') {
      const applied = await api.applyRemoteClipboard(message);
      if (!applied) state.pendingClipboard = message;
      return;
    }
    if (message.type === 'file-offer') {
      if (connection.mode !== 'input' || !connection.options.fileClipboard) return;
      await api.receiveFileOffer(message, connection.device.host);
      return;
    }
    if (message.type === 'file-status') {
      await api.applyFileStatus(message);
      return;
    }
    if (message.type === 'input') return;
    if (message.type === 'answer') {
      await connection.pc.setRemoteDescription(message.sdp);
      for (const candidate of connection.pendingIce.splice(0)) await connection.pc.addIceCandidate(candidate);
      return;
    }
    if (message.type === 'ice') {
      if (connection.pc.remoteDescription) await connection.pc.addIceCandidate(message.candidate);
      else connection.pendingIce.push(message.candidate);
      return;
    }
    if (message.type === 'pong') {
      connection.lastPongAt = performance.now();
      connection.lastPingRtt = Math.max(0, performance.now() - message.timestamp);
      if (connection.connected) setText('stat-latency', formatLatency(connection.lastPingRtt));
      return;
    }
    if (message.type === 'ping') {
      sendHostSignal(connection, makeSignal('pong', { timestamp: message.timestamp }));
      return;
    }
    if (message.type === 'disconnect') handleHostLoss(connection, message.reason || '子端已断开', false);
  }

  async function prepareHostMediaAndOffer(connection) {
    try {
      setConnectionSteps('display');
      setHostActivity('正在准备显示器', `${connection.options.width} × ${connection.options.height} · ${connection.options.fps} FPS`);
      const source = await chooseCaptureSource(connection.options, connection);
      if (state.hostConnection !== connection || connection.intentional) {
        if (connection.virtualOwned) api.destroyVirtualDisplay().catch(() => {});
        return;
      }
      setHostActivity('正在请求屏幕画面', source.name || '已选择显示器');
      const stream = await acquireCapture(source, connection.options, connection);
      if (state.hostConnection !== connection || connection.intentional) {
        stream.getTracks().forEach((track) => track.stop());
        if (connection.virtualOwned) api.destroyVirtualDisplay().catch(() => {});
        return;
      }

      const pc = createPeerConnection();
      connection.pc = pc;
      const sender = addPreferredVideoSender(pc, stream);
      await configureSender(sender, connection.options, stream.getVideoTracks()[0]);
      wireHostPeer(connection);
      state.bootstrap.settings.host.lastSourceId = source.id;
      await api.updateSettings({ host: { ...connection.options, lastSourceId: source.id } });

      setConnectionSteps('stream');
      setHostActivity('正在建立点对点画面', '已准备扩展屏，等待 WebRTC 通道');
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await configureSender(sender, connection.options, stream.getVideoTracks()[0]);
      sendHostSignal(connection, makeSignal('offer', { sdp: serializeDescription(pc.localDescription) }));
      clearTimeout(connection.negotiationTimer);
      connection.negotiationTimer = window.setTimeout(() => {
        if (state.hostConnection === connection && !connection.connected) {
          handleHostLoss(connection, '画面协商超时，请检查 Windows 防火墙');
        }
      }, 20_000);
    } catch (error) {
      if (state.hostConnection !== connection) {
        connection.stream?.getTracks().forEach((track) => track.stop());
        if (connection.virtualOwned) api.destroyVirtualDisplay().catch(() => {});
        return;
      }
      state.hostConnection = null;
      cleanupHostConnection(connection);
      renderHostIdle();
      if (connection.virtualOwned) api.destroyVirtualDisplay().catch(() => {});
      toast('无法准备扩展画面', errorText(error), 'error', 7200);
    }
  }

  function sendHostSignal(connection, message) {
    if (state.hostConnection !== connection || connection.intentional) return false;
    if (connection.ws?.readyState !== WebSocket.OPEN) return false;
    connection.ws.send(JSON.stringify(message));
    return true;
  }

  async function reconcileConnectedDevice(connection, receiver) {
    const previousId = connection.device.id;
    const actual = {
      ...connection.device,
      id: String(receiver.id).slice(0, 128),
      name: String(receiver.name).slice(0, 64),
      port: Number(receiver.port) || connection.device.port,
      capabilities: Array.isArray(receiver.capabilities) ? receiver.capabilities : connection.device.capabilities,
      display: receiver.display || connection.device.display || null,
      online: true,
      lastSeen: Date.now()
    };
    connection.device = actual;
    connection.options.lastDeviceId = actual.id;
    if (connection.mode === 'input' && state.inputLayout) {
      state.inputLayout.deviceId = actual.id;
      if (actual.display) {
        state.inputLayout.width = actual.display.width;
        state.inputLayout.height = actual.display.height;
      }
    }
    state.selectedDeviceId = actual.id;
    await api.rememberDevice(actual, true);
    state.bootstrap.settings.host.lastDeviceId = actual.id;
    if (previousId !== actual.id && String(previousId).startsWith('manual:')) {
      await api.forgetDevice(previousId).catch(() => {});
    }
    state.devices = (await api.getDevices()).map((device) => device.id === actual.id ? { ...device, online: true } : device);
    renderDevices();
  }

  function startHostHeartbeat(connection) {
    clearInterval(connection.heartbeatTimer);
    const heartbeat = () => {
      if (state.hostConnection !== connection || connection.intentional) return;
      if (Number.isFinite(connection.lastPongAt) && performance.now() - connection.lastPongAt > 15_000) {
        handleHostLoss(connection, '子端心跳超时');
        return;
      }
      if (connection.ws?.readyState === WebSocket.OPEN) {
        sendHostSignal(connection, makeSignal('ping', { timestamp: performance.now() }));
      }
    };
    heartbeat();
    connection.heartbeatTimer = window.setInterval(heartbeat, 5000);
  }

  function markHostConnected(connection) {
    if (connection.connected || state.hostConnection !== connection) return;
    connection.connected = true;
    clearTimeout(connection.negotiationTimer);
    state.reconnectAttempt = 0;
    setConnectionSteps('missing');
    all('#connection-steps .step').forEach((element) => {
      element.classList.remove('is-current');
      element.classList.add('is-done');
      const marker = element.querySelector('i');
      if (marker) marker.textContent = '✓';
    });
    byId('signal-beam').classList.add('is-connected');
    byId('host-stats').hidden = false;
    setText('stat-connection', '已扩展');
    setText('stat-device', connection.device.name);
    setText('host-hero-title', `正在扩展到 ${connection.device.name}`);
    setText('host-hero-description', '画面通过局域网点对点传输；可在 macOS 显示器设置中调整扩展屏位置。');
    setSidebarStatus('online', '扩展屏已连接', formatAddress(connection.device.host, connection.device.port));
    byId('connect-button').hidden = true;
    byId('disconnect-button').hidden = false;
    setText('disconnect-button', '断开扩展屏');
    byId('capture-mode').disabled = true;
    startHostStats(connection);
    toast('扩展屏已连接', `${connection.device.name} 正在显示 Mac 扩展画面`);
  }

  function markInputConnected(connection) {
    if (connection.connected || state.hostConnection !== connection) return;
    connection.connected = true;
    clearTimeout(connection.negotiationTimer);
    state.reconnectAttempt = 0;
    state.inputStatus = { ...state.inputStatus, running: true, active: false };
    byId('input-connect-button').hidden = true;
    byId('input-disconnect-button').hidden = false;
    byId('reset-input-layout').disabled = true;
    setSidebarStatus('online', '键鼠共享已启动', connection.device.name);
    renderInputStatus();
    toast('键鼠共享已启动', `将鼠标移向布局中与 ${connection.device.name} 相邻的边缘即可切换`);
  }

  function startHostStats(connection) {
    clearInterval(connection.statsTimer);
    const update = async () => {
      if (state.hostConnection !== connection || !connection.pc) return;
      try {
        const report = await connection.pc.getStats();
        let outbound;
        let candidatePair;
        report.forEach((entry) => {
          if (entry.type === 'outbound-rtp' && !entry.isRemote && (entry.kind === 'video' || entry.mediaType === 'video')) outbound = entry;
          if (entry.type === 'candidate-pair' && (entry.nominated || entry.state === 'succeeded') && (!candidatePair || entry.selected)) candidatePair = entry;
        });
        if (outbound) {
          let bitrate;
          if (connection.statsPrevious && outbound.timestamp > connection.statsPrevious.timestamp) {
            bitrate = ((outbound.bytesSent - connection.statsPrevious.bytes) * 8 * 1000) / (outbound.timestamp - connection.statsPrevious.timestamp);
          }
          connection.statsPrevious = { bytes: outbound.bytesSent, timestamp: outbound.timestamp };
          const trackSettings = connection.stream?.getVideoTracks()[0]?.getSettings?.() || {};
          const width = outbound.frameWidth || trackSettings.width || connection.options.width;
          const height = outbound.frameHeight || trackSettings.height || connection.options.height;
          setText('stat-resolution', width && height ? `${width} × ${height}` : '—');
          setText('stat-fps', Number.isFinite(outbound.framesPerSecond) ? `${Math.round(outbound.framesPerSecond)} FPS` : `${connection.options.fps} FPS`);
          setText('stat-bitrate', formatBitrate(bitrate));
        }
        const rtcLatency = candidatePair?.currentRoundTripTime * 1000;
        setText('stat-latency', formatLatency(Number.isFinite(rtcLatency) ? rtcLatency : connection.lastPingRtt));
      } catch {
        // Stats are best-effort and must never interrupt the stream.
      }
    };
    update();
    connection.statsTimer = window.setInterval(update, 1000);
  }

  function setHostActivity(title, detail) {
    setSidebarStatus('busy', title, detail);
    setText('connect-button-label', title);
    setText('connect-hint', detail);
  }

  function setInputActivity(title, detail) {
    const live = byId('input-live-status');
    if (live) {
      live.className = 'input-live-status is-ready';
      live.querySelector('strong').textContent = title;
      live.querySelector('small').textContent = detail;
    }
    const badge = byId('input-sharing-badge');
    if (badge) {
      badge.textContent = '正在连接';
      badge.className = 'capability-badge';
    }
    setSidebarStatus('busy', title, detail);
  }

  function renderHostConnecting(device, detail) {
    byId('connect-button').disabled = true;
    byId('connect-button').hidden = true;
    byId('disconnect-button').hidden = false;
    setText('disconnect-button', '取消连接');
    setHostActivity('正在建立扩展屏', detail);
    setText('host-hero-title', `正在连接 ${device.name}`);
    setText('host-hero-description', '正在准备独立显示器、屏幕捕获与局域网点对点传输。');
    setText('stat-device', device.name);
  }

  function renderInputConnecting(device, isReconnect) {
    byId('input-connect-button').hidden = true;
    byId('input-disconnect-button').hidden = false;
    byId('input-disconnect-button').textContent = '取消连接';
    byId('reset-input-layout').disabled = true;
    setInputActivity(
      isReconnect ? `正在第 ${state.reconnectAttempt} 次重连` : `正在连接 ${device.name}`,
      '正在准备键鼠与剪贴板通道'
    );
  }

  function renderInputIdle() {
    byId('input-connect-button').hidden = false;
    byId('input-disconnect-button').hidden = true;
    byId('input-disconnect-button').textContent = '停止键鼠共享';
    byId('reset-input-layout').disabled = false;
    state.inputStatus = { ...state.inputStatus, running: false, active: false };
    renderInputStatus();
  }

  function renderHostIdle() {
    byId('connect-button').hidden = false;
    byId('disconnect-button').hidden = true;
    setText('disconnect-button', '断开扩展屏');
    byId('capture-mode').disabled = false;
    byId('host-stats').hidden = true;
    byId('signal-beam').classList.remove('is-connected');
    setText('host-hero-title', '把一台 Windows 设备变成 Mac 扩展屏');
    setText('host-hero-description', '选择同一局域网内的子端，LanExtend 会创建独立虚拟显示器并以低延迟画面传输。');
    setSidebarStatus('online', '正在发现子端', '局域网服务运行中');
    setConnectionSteps(state.selectedDeviceId ? 'display' : 'device');
    updateConnectAvailability();
    renderInputIdle();
  }

  function cleanupHostConnection(connection) {
    connection.intentional = true;
    clearTimeout(connection.welcomeTimer);
    clearTimeout(connection.negotiationTimer);
    clearInterval(connection.heartbeatTimer);
    clearInterval(connection.statsTimer);
    if (connection.ws) {
      connection.ws.onopen = null;
      connection.ws.onmessage = null;
      connection.ws.onerror = null;
      connection.ws.onclose = null;
      try { connection.ws.close(); } catch { /* Already closed. */ }
    }
    if (connection.pc) {
      connection.pc.onicecandidate = null;
      connection.pc.onconnectionstatechange = null;
      connection.pc.oniceconnectionstatechange = null;
      try { connection.pc.close(); } catch { /* Already closed. */ }
    }
    connection.stream?.getTracks().forEach((track) => track.stop());
    if (connection.mode === 'input') {
      state.pendingClipboard = null;
      api.stopInputSharing().catch(() => {});
    }
  }

  function handleHostLoss(connection, reason, reconnectAllowed = true) {
    if (state.hostConnection !== connection || connection.failed || connection.intentional) return;
    connection.failed = true;
    const reconnectToggle = connection.mode === 'input' ? byId('input-auto-reconnect') : byId('auto-reconnect');
    const reconnect = reconnectAllowed && connection.options.autoReconnect && reconnectToggle.checked;
    state.hostConnection = null;
    cleanupHostConnection(connection);
    renderHostIdle();
    toast(connection.mode === 'input' ? '键鼠共享已中断' : '扩展屏连接已中断', reason, reconnect ? 'warning' : 'error', 6000);
    if (reconnect) scheduleReconnect(reason, connection.mode);
    else if (connection.virtualOwned) api.destroyVirtualDisplay().catch(() => {});
  }

  function scheduleReconnect(reason, mode = state.reconnectMode) {
    const reconnectToggle = mode === 'input' ? byId('input-auto-reconnect') : byId('auto-reconnect');
    if (state.reconnectTimer || state.hostConnection || !reconnectToggle.checked) return;
    state.reconnectMode = mode;
    state.reconnectAttempt += 1;
    const delay = Math.min(12_000, 1600 * (2 ** Math.min(state.reconnectAttempt - 1, 3)));
    let seconds = Math.ceil(delay / 1000);
    setSidebarStatus('busy', `${seconds} 秒后自动重连`, reason);
    byId('connect-button').hidden = true;
    byId('disconnect-button').hidden = false;
    setText('disconnect-button', '取消自动重连');
    if (mode === 'input') {
      byId('connect-button').hidden = false;
      byId('disconnect-button').hidden = true;
      byId('input-connect-button').hidden = true;
      byId('input-disconnect-button').hidden = false;
      setText('input-disconnect-button', '取消自动重连');
    }
    clearInterval(state.reconnectCountdownTimer);
    state.reconnectCountdownTimer = window.setInterval(() => {
      seconds -= 1;
      if (seconds > 0 && state.reconnectTimer) setSidebarStatus('busy', `${seconds} 秒后自动重连`, reason);
    }, 1000);
    state.reconnectTimer = window.setTimeout(() => {
      window.clearInterval(state.reconnectCountdownTimer);
      state.reconnectCountdownTimer = null;
      state.reconnectTimer = null;
      beginHostConnection(true, mode);
    }, delay);
  }

  function disconnectHost(reason) {
    const wasReconnecting = Boolean(state.reconnectTimer);
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    clearInterval(state.reconnectCountdownTimer);
    state.reconnectCountdownTimer = null;
    state.reconnectAttempt = 0;
    const connection = state.hostConnection;
    const mode = connection?.mode || state.reconnectMode;
    state.hostConnection = null;
    if (connection) {
      connection.intentional = true;
      if (connection.ws?.readyState === WebSocket.OPEN) {
        try { connection.ws.send(JSON.stringify(makeSignal('disconnect', { reason }))); } catch { /* Closing. */ }
      }
      cleanupHostConnection(connection);
    }
    if (mode === 'input') api.stopInputSharing().catch(() => {});
    if (mode === 'display' && (state.virtualDisplayRunning || connection?.virtualOwned)) api.destroyVirtualDisplay().catch(() => {});
    renderHostIdle();
    refreshDevices();
    toast(
      wasReconnecting || !connection?.connected ? '连接已取消' : mode === 'input' ? '键鼠共享已停止' : '扩展屏已断开',
      wasReconnecting ? '已停止自动重连' : '子端已恢复等待状态'
    );
  }

  function applyReceiverSettings(settings) {
    const receiver = settings.receiver;
    byId('receiver-name').value = receiver.name || 'Windows 子端';
    byId('receiver-port').value = receiver.port || DEFAULT_SIGNAL_PORT;
    byId('receiver-auto-fullscreen').checked = Boolean(receiver.autoFullscreen);
    setText('receiver-name-summary', receiver.name || 'Windows 子端');
    state.listeningPort = receiver.port;
    renderListeningStatus();
  }

  function bindReceiverUi() {
    byId('receiver-settings-form').addEventListener('submit', saveReceiverSettings);
    byId('receiver-fullscreen-top').addEventListener('click', () => setReceiverFullscreen(!state.receiverFullscreen));
    byId('receiver-fullscreen-overlay').addEventListener('click', () => setReceiverFullscreen(!state.receiverFullscreen));
    byId('receiver-disconnect-overlay').addEventListener('click', () => disconnectReceiver('由子端断开'));
    byId('receiver-file-transfer-cancel').addEventListener('click', () => {
      if (state.fileTransfer?.transferId) api.cancelFileTransfer(state.fileTransfer.transferId);
    });
    byId('play-video').addEventListener('click', async () => {
      try {
        await byId('remote-video').play();
        byId('play-video').hidden = true;
      } catch (error) {
        toast('无法开始播放', errorText(error), 'error');
      }
    });
    const video = byId('remote-video');
    video.addEventListener('loadedmetadata', renderReceiverVideoDimensions);
    video.addEventListener('resize', renderReceiverVideoDimensions);
    const stage = byId('receiver-overview');
    const overlay = byId('receiver-video-overlay');
    stage.addEventListener('pointermove', () => revealReceiverOverlay());
    stage.addEventListener('pointerleave', hideReceiverOverlay);
    stage.addEventListener('touchstart', () => revealReceiverOverlay(3200), { passive: true });
    stage.addEventListener('focusin', () => revealReceiverOverlay(3200));
    overlay.addEventListener('pointerenter', () => clearTimeout(state.receiverOverlayTimer));
    overlay.addEventListener('pointerleave', () => revealReceiverOverlay(900));
  }

  function hideReceiverOverlay() {
    clearTimeout(state.receiverOverlayTimer);
    state.receiverOverlayTimer = null;
    const overlay = byId('receiver-video-overlay');
    if (!overlay) return;
    overlay.classList.remove('is-visible');
    overlay.setAttribute('aria-hidden', 'true');
  }

  function revealReceiverOverlay(duration = 2200) {
    const overlay = byId('receiver-video-overlay');
    if (!overlay || overlay.hidden || !byId('receiver-overview')?.classList.contains('has-video')) return;
    clearTimeout(state.receiverOverlayTimer);
    overlay.classList.add('is-visible');
    overlay.setAttribute('aria-hidden', 'false');
    state.receiverOverlayTimer = window.setTimeout(() => {
      if (overlay.matches(':hover') || overlay.matches(':focus-within')) {
        revealReceiverOverlay(900);
        return;
      }
      hideReceiverOverlay();
    }, duration);
  }

  function renderListeningStatus() {
    setText('listen-port', `端口 ${state.listeningPort || '—'}`);
    if (!state.receiverSession) {
      setSidebarStatus('online', '等待 Mac 主端', `监听端口 ${state.listeningPort || '—'}`);
      const badge = byId('receiver-service-badge');
      if (badge) {
        badge.textContent = '监听中';
        badge.className = 'capability-badge is-success';
      }
    }
  }

  function renderReceiverInputStatus(status = {}) {
    state.receiverInputStatus = { ...state.receiverInputStatus, ...status };
    if (status.running === false) {
      if (status.clipboard === undefined) state.receiverInputStatus.clipboard = false;
      if (status.files === undefined) state.receiverInputStatus.files = false;
    }
    const current = state.receiverInputStatus;
    const badge = byId('receiver-input-badge');
    if (!badge) return;
    if (current.active) {
      badge.textContent = '正在控制';
      badge.className = 'capability-badge is-success';
      setText('receiver-input-state', 'Mac 正在控制此设备');
      setSidebarStatus('online', '键鼠控制中', state.receiverHost?.name || 'Mac 主端');
      setText('receiver-state-kicker', '键鼠共享');
      setText('receiver-state-title', '当前由 Mac 键盘和鼠标控制');
      setText('receiver-state-description', '鼠标移回相邻屏幕边缘后，控制权会自动返回 Mac。');
    } else if (current.running) {
      badge.textContent = '共享已就绪';
      badge.className = 'capability-badge is-success';
      setText('receiver-input-state', '等待鼠标进入');
      setSidebarStatus('online', '键鼠共享已就绪', state.receiverHost?.name || 'Mac 主端');
      setText('receiver-state-kicker', '键鼠共享已就绪');
      setText('receiver-state-title', '等待 Mac 鼠标跨越屏幕边缘');
      setText('receiver-state-description', '当前不传输画面；两台设备继续显示各自的本地内容。');
    } else {
      badge.textContent = status.error ? '启动失败' : '待机';
      badge.className = status.error ? 'capability-badge is-error' : 'capability-badge';
      setText('receiver-input-state', status.error || '等待 Mac');
    }
    setText('receiver-clipboard-state', current.clipboard ? '纯文本同步中' : '未启动');
    setText('receiver-file-clipboard-state', current.files ? '文件与文件夹同步中' : '未启动');
  }

  async function saveReceiverSettings(event) {
    event.preventDefault();
    const button = byId('save-receiver-settings');
    button.disabled = true;
    try {
      const receiver = {
        name: byId('receiver-name').value.trim(),
        port: Number(byId('receiver-port').value),
        autoFullscreen: byId('receiver-auto-fullscreen').checked
      };
      const settings = await api.updateSettings({ receiver });
      state.bootstrap.settings = settings;
      applyReceiverSettings(settings);
      toast('子端设置已保存', '局域网广播已使用新的名称与端口');
    } catch (error) {
      toast('保存设置失败', errorText(error), 'error');
    } finally {
      button.disabled = false;
    }
  }

  function onReceiverConnected(connection) {
    if (!connection?.id) return;
    cleanupReceiverPeer(false);
    state.receiverSession = connection;
    state.receiverHost = { name: 'Mac 主端', address: connection.remoteAddress || '局域网地址' };
    setText('receiver-state-kicker', '主端已连接');
    setText('receiver-state-title', '正在协商扩展画面');
    setText('receiver-state-description', '已建立局域网信令连接，正在创建低延迟视频通道。');
    setText('receiver-host-summary', connection.remoteAddress || 'Mac 主端');
    setText('remote-address', connection.remoteAddress || '局域网直连');
    setSidebarStatus('busy', 'Mac 主端正在连接', connection.remoteAddress || '局域网直连');
    const badge = byId('receiver-service-badge');
    badge.textContent = '协商中';
    badge.className = 'capability-badge';
  }

  function ensureReceiverPeer() {
    if (state.receiverPeer) return state.receiverPeer;
    const pc = createPeerConnection();
    state.receiverPeer = pc;
    pc.onicecandidate = (event) => {
      sendReceiverSignal(makeSignal('ice', {
        candidate: serializeCandidate(event.candidate)
      }));
    };
    pc.ontrack = (event) => {
      let stream = event.streams?.[0];
      if (!stream) {
        stream = byId('remote-video').srcObject instanceof MediaStream ? byId('remote-video').srcObject : new MediaStream();
        stream.addTrack(event.track);
      }
      showReceiverStream(stream);
    };
    pc.onconnectionstatechange = () => {
      if (pc !== state.receiverPeer) return;
      if (pc.connectionState === 'connected') markReceiverConnected();
      else if (pc.connectionState === 'failed') disconnectReceiver('WebRTC 画面连接失败');
      else if (pc.connectionState === 'disconnected') {
        setSidebarStatus('busy', '画面暂时中断', '正在等待局域网恢复');
        window.setTimeout(() => {
          if (pc === state.receiverPeer && pc.connectionState === 'disconnected') disconnectReceiver('画面连接已中断');
        }, 5000);
      }
    };
    return pc;
  }

  async function handleReceiverSignal(event) {
    if (!event?.sessionId || !event.message) return;
    if (!state.receiverSession || state.receiverSession.id !== event.sessionId) {
      onReceiverConnected({ id: event.sessionId, remoteAddress: 'Mac 主端' });
    }
    const message = event.message;
    if (message.protocol !== PROTOCOL_VERSION || !SIGNAL_TYPES.has(message.type)) throw new Error('主端信令协议不兼容');
    if (message.type === 'hello') {
      state.receiverHost = { ...state.receiverHost, name: String(message.name || 'Mac 主端').slice(0, 64) };
      setText('remote-host-name', state.receiverHost.name);
      setText('receiver-host-summary', state.receiverHost.name);
      return;
    }
    if (message.type === 'offer') {
      const pc = ensureReceiverPeer();
      await pc.setRemoteDescription(message.sdp);
      for (const candidate of state.receiverPendingIce.splice(0)) await pc.addIceCandidate(candidate);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendReceiverSignal(makeSignal('answer', { sdp: serializeDescription(pc.localDescription) }));
      return;
    }
    if (message.type === 'ice') {
      const pc = ensureReceiverPeer();
      if (pc.remoteDescription) await pc.addIceCandidate(message.candidate);
      else state.receiverPendingIce.push(message.candidate);
      return;
    }
    if (message.type === 'ping') {
      await sendReceiverSignal(makeSignal('pong', { timestamp: message.timestamp }));
      return;
    }
    if (message.type === 'pong') return;
    if (message.type === 'disconnect') await disconnectReceiver(message.reason || '主端已断开');
  }

  async function sendReceiverSignal(message) {
    if (!state.receiverSession?.id) return false;
    return api.sendReceiverSignal(state.receiverSession.id, message);
  }

  async function showReceiverStream(stream) {
    const video = byId('remote-video');
    video.srcObject = stream;
    byId('receiver-overview').classList.add('has-video');
    byId('receiver-video-overlay').hidden = false;
    hideReceiverOverlay();
    try {
      await video.play();
      byId('play-video').hidden = true;
    } catch {
      byId('play-video').hidden = false;
    }
    renderReceiverVideoDimensions();
    if (byId('receiver-auto-fullscreen').checked) await setReceiverFullscreen(true);
  }

  function markReceiverConnected() {
    setText('receiver-state-kicker', '画面已连接');
    setText('receiver-state-title', '正在接收 Mac 扩展画面');
    setText('receiver-state-description', '视频通过局域网 WebRTC 点对点传输。');
    setSidebarStatus('online', '正在接收扩展画面', state.receiverHost?.name || 'Mac 主端');
    setText('receiver-host-summary', state.receiverHost?.name || 'Mac 主端');
    const badge = byId('receiver-service-badge');
    badge.textContent = '接收中';
    badge.className = 'capability-badge is-success';
    startReceiverStats();
    toast('扩展画面已连接', `${state.receiverHost?.name || 'Mac 主端'} 已开始传输`);
  }

  function renderReceiverVideoDimensions() {
    const video = byId('remote-video');
    setText('receiver-resolution', video.videoWidth && video.videoHeight ? `${video.videoWidth} × ${video.videoHeight}` : '—');
  }

  function startReceiverStats() {
    clearInterval(state.receiverStatsTimer);
    state.receiverStatsPrevious = null;
    const update = async () => {
      const pc = state.receiverPeer;
      if (!pc) return;
      try {
        const report = await pc.getStats();
        let inbound;
        let candidatePair;
        report.forEach((entry) => {
          if (entry.type === 'inbound-rtp' && !entry.isRemote && (entry.kind === 'video' || entry.mediaType === 'video')) inbound = entry;
          if (entry.type === 'candidate-pair' && (entry.nominated || entry.state === 'succeeded') && (!candidatePair || entry.selected)) candidatePair = entry;
        });
        if (inbound) {
          let bitrate;
          if (state.receiverStatsPrevious && inbound.timestamp > state.receiverStatsPrevious.timestamp) {
            bitrate = ((inbound.bytesReceived - state.receiverStatsPrevious.bytes) * 8 * 1000) / (inbound.timestamp - state.receiverStatsPrevious.timestamp);
          }
          state.receiverStatsPrevious = { bytes: inbound.bytesReceived, timestamp: inbound.timestamp };
          setText('receiver-fps', `${Number.isFinite(inbound.framesPerSecond) ? Math.round(inbound.framesPerSecond) : '—'} FPS`);
          setText('receiver-bitrate', formatBitrate(bitrate));
          if (inbound.frameWidth && inbound.frameHeight) setText('receiver-resolution', `${inbound.frameWidth} × ${inbound.frameHeight}`);
        }
        setText('receiver-latency', formatLatency(candidatePair?.currentRoundTripTime * 1000));
      } catch {
        // Stats are informational only.
      }
    };
    update();
    state.receiverStatsTimer = window.setInterval(update, 1000);
  }

  async function setReceiverFullscreen(enabled) {
    const target = Boolean(enabled);
    try {
      const actual = await api.setFullscreen(target);
      state.receiverFullscreen = Boolean(actual);
    } catch {
      state.receiverFullscreen = target;
    }
    document.body.classList.toggle('receiver-fullscreen', state.receiverFullscreen);
    setText('receiver-fullscreen-top', state.receiverFullscreen ? '退出全屏' : '全屏播放');
    setText('receiver-fullscreen-overlay', state.receiverFullscreen ? '退出全屏' : '全屏');
  }

  function cleanupReceiverPeer(clearSession = true) {
    hideReceiverOverlay();
    clearInterval(state.receiverStatsTimer);
    state.receiverStatsTimer = null;
    state.receiverStatsPrevious = null;
    state.receiverPendingIce = [];
    const peer = state.receiverPeer;
    state.receiverPeer = null;
    if (peer) {
      peer.onicecandidate = null;
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
      try { peer.close(); } catch { /* Already closed. */ }
    }
    const video = byId('remote-video');
    if (video) {
      if (video.srcObject instanceof MediaStream) video.srcObject.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
    }
    byId('receiver-overview')?.classList.remove('has-video');
    if (byId('receiver-video-overlay')) byId('receiver-video-overlay').hidden = true;
    if (byId('play-video')) byId('play-video').hidden = true;
    if (clearSession) state.receiverSession = null;
  }

  async function disconnectReceiver(reason) {
    const sessionId = state.receiverSession?.id;
    if (sessionId) {
      await api.sendReceiverSignal(sessionId, makeSignal('disconnect', { reason })).catch(() => false);
      await api.disconnectReceiver(sessionId, reason).catch(() => false);
    }
    cleanupReceiverPeer(true);
    await setReceiverFullscreen(false);
    renderReceiverIdle(reason);
  }

  function onReceiverDisconnected(event) {
    if (state.receiverSession && event?.sessionId && state.receiverSession.id !== event.sessionId) return;
    const reason = event?.reason || (event?.code === 1000 ? '主端已正常断开' : '主端连接已结束');
    cleanupReceiverPeer(true);
    renderReceiverInputStatus({ running: false, active: false, clipboard: false });
    if (state.receiverFullscreen) setReceiverFullscreen(false);
    renderReceiverIdle(reason);
  }

  function renderReceiverIdle(reason = '') {
    setText('receiver-state-kicker', '子端已就绪');
    setText('receiver-state-title', '等待 Mac 主端连接');
    setText('receiver-state-description', reason ? `${reason}。接收服务仍在运行，可随时重新连接。` : '保持此窗口开启。Mac 会在同一局域网内自动发现这台设备。');
    setText('receiver-host-summary', '未连接');
    setText('remote-host-name', 'Mac 主端');
    setText('receiver-resolution', '—');
    setText('receiver-fps', '— FPS');
    setText('receiver-bitrate', '— Mbps');
    setText('receiver-latency', '— ms');
    state.receiverHost = null;
    renderReceiverInputStatus({ running: false, active: false, clipboard: false });
    renderListeningStatus();
  }

  async function initialize() {
    if (!api) throw new Error('预加载接口不可用，无法启动 LanExtend');
    bindCommonUi();
    bindIpcEvents();
    const bootstrap = await api.bootstrap();
    if (bootstrap.protocolVersion !== PROTOCOL_VERSION) throw new Error(`协议版本不兼容：应用返回 v${bootstrap.protocolVersion}`);
    state.bootstrap = bootstrap;
    state.role = bootstrap.role;
    state.devices = Array.isArray(bootstrap.devices) ? bootstrap.devices : [];
    state.virtualDisplayRunning = Boolean(bootstrap.virtualDisplay?.running);
    state.inputAccessibility = Boolean(bootstrap.inputSharing?.accessibility);
    state.inputStatus = {
      ...state.inputStatus,
      ...(bootstrap.inputSharing?.status || {}),
      supported: Boolean(bootstrap.inputSharing?.supported)
    };
    setRoleVisibility(state.role);
    setText('app-version', `扩展屏与键鼠共享 · ${bootstrap.appVersion || '0.4.2'}`);
    setText('protocol-chip', `协议 v${bootstrap.protocolVersion}`);
    bindUpdateUi();

    if (state.role === 'host') {
      bindHostUi();
      applyHostSettings(bootstrap.settings);
      renderVirtualStatus(bootstrap.virtualDisplay);
      const virtualSupported = bootstrap.virtualDisplay?.capability?.supported
        ?? bootstrap.virtualDisplay?.supported;
      if (!virtualSupported) {
        const fallbackMode = document.querySelector('input[name="captureMode"][value="existing"]');
        if (fallbackMode) fallbackMode.checked = true;
      }
      renderScreenPermission(bootstrap.permission);
      renderDevices();
      renderCaptureMode();
      renderHostIdle();
      renderInputLayout();
      renderInputStatus();
    } else {
      bindReceiverUi();
      applyReceiverSettings(bootstrap.settings);
      renderReceiverIdle();
      renderReceiverInputStatus();
    }

    await api.rendererReady();

    if (state.role === 'host') {
      api.onScreenPermissionChanged((status) => renderScreenPermission(status));
      window.addEventListener('focus', () => {
        refreshScreenPermission();
        refreshInputStatus();
      });
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
          refreshScreenPermission();
          refreshInputStatus();
        }
      });
      await refreshSources(false);
      await refreshInputStatus();
    } else {
      if (state.earlyReceiverConnection) {
        onReceiverConnected(state.earlyReceiverConnection);
        state.earlyReceiverConnection = null;
      }
      for (const event of state.earlyReceiverSignals.splice(0)) {
        await handleReceiverSignal(event);
      }
    }

    byId('app').hidden = false;
    document.body.classList.remove('is-booting');
    const boot = byId('boot-screen');
    boot.classList.add('is-dismissing');
    window.setTimeout(() => boot.remove(), 300);
    window.setTimeout(() => checkForUpdates({ quiet: true }), 1800);
  }

  initialize().catch((error) => {
    const boot = byId('boot-screen');
    if (boot) {
      boot.replaceChildren();
      const message = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = 'LanExtend 无法启动';
      const detail = document.createElement('span');
      detail.textContent = errorText(error);
      message.append(title, detail);
      boot.append(message);
    }
  });
})();
