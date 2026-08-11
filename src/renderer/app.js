(() => {
  'use strict';

  const PROTOCOL_VERSION = 1;
  const SIGNAL_TYPES = new Set(['hello', 'offer', 'answer', 'ice', 'disconnect', 'ping', 'pong']);
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
    updateChecking: false
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
    byId('open-screen-permission').addEventListener('click', () => api.openScreenSettings());
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
  }

  function selectDevice(id) {
    if (state.hostConnection) return;
    state.selectedDeviceId = id;
    renderDevices();
    setConnectionSteps('display');
    const device = state.devices.find((item) => item.id === id);
    if (device) {
      setText('connect-button-label', `扩展到 ${device.name}`);
      setText('connect-hint', `${formatAddress(device.host, device.port)} · 主端主动连接`);
    }
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
    button.disabled = Boolean(state.hostConnection || state.reconnectTimer || !state.selectedDeviceId || !sourceReady);
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

  async function beginHostConnection(isReconnect) {
    if (state.hostConnection) return;
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    const device = state.devices.find((item) => item.id === state.selectedDeviceId);
    if (!device) {
      toast('请先选择子端', '选择自动发现的设备，或手动添加 IP 地址', 'warning');
      updateConnectAvailability();
      return;
    }

    const options = readHostOptions();
    const connection = {
      id: `${Date.now()}-${Math.random()}`,
      device: { ...device },
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
    renderHostConnecting(device, isReconnect ? `正在第 ${state.reconnectAttempt} 次重连` : '正在准备扩展屏');

    try {
      const target = await api.validateTarget(device.host, Number(device.port));
      if (!target?.valid) throw new Error('子端不是有效的私有局域网地址');
      state.bootstrap.settings = await api.updateSettings({ host: options });
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
      toast(isReconnect ? '自动重连未成功' : '无法开始扩展', message, 'error', 7200);
      if (isReconnect && options.autoReconnect) scheduleReconnect(message);
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
    setConnectionSteps('display');
    setHostActivity('正在连接 Windows 子端', formatAddress(connection.device.host, connection.device.port));
    const socket = new WebSocket(`ws://${connection.device.host}:${connection.device.port}`);
    connection.ws = socket;
    socket.addEventListener('open', () => {
      if (state.hostConnection !== connection) return;
      setHostActivity('子端已响应', '正在协商扩展画面');
      connection.welcomeTimer = window.setTimeout(() => handleHostLoss(connection, '子端握手超时'), 10_000);
    });
    socket.addEventListener('message', (event) => {
      handleHostSocketMessage(connection, event.data).catch((error) => handleHostLoss(connection, errorText(error)));
    });
    socket.addEventListener('error', () => {
      if (state.hostConnection === connection && !connection.intentional) setHostActivity('无法连接子端', '请检查子端、防火墙与局域网');
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
        await prepareHostMediaAndOffer(connection);
      }
      return;
    }
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
      online: true,
      lastSeen: Date.now()
    };
    connection.device = actual;
    connection.options.lastDeviceId = actual.id;
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
  }

  function handleHostLoss(connection, reason, reconnectAllowed = true) {
    if (state.hostConnection !== connection || connection.failed || connection.intentional) return;
    connection.failed = true;
    const reconnect = reconnectAllowed
      && connection.options.autoReconnect
      && byId('auto-reconnect').checked;
    state.hostConnection = null;
    cleanupHostConnection(connection);
    renderHostIdle();
    toast('扩展屏连接已中断', reason, reconnect ? 'warning' : 'error', 6000);
    if (reconnect) scheduleReconnect(reason);
    else if (connection.virtualOwned) api.destroyVirtualDisplay().catch(() => {});
  }

  function scheduleReconnect(reason) {
    if (state.reconnectTimer || state.hostConnection || !byId('auto-reconnect').checked) return;
    state.reconnectAttempt += 1;
    const delay = Math.min(12_000, 1600 * (2 ** Math.min(state.reconnectAttempt - 1, 3)));
    let seconds = Math.ceil(delay / 1000);
    setSidebarStatus('busy', `${seconds} 秒后自动重连`, reason);
    byId('connect-button').hidden = true;
    byId('disconnect-button').hidden = false;
    setText('disconnect-button', '取消自动重连');
    clearInterval(state.reconnectCountdownTimer);
    state.reconnectCountdownTimer = window.setInterval(() => {
      seconds -= 1;
      if (seconds > 0 && state.reconnectTimer) setSidebarStatus('busy', `${seconds} 秒后自动重连`, reason);
    }, 1000);
    state.reconnectTimer = window.setTimeout(() => {
      window.clearInterval(state.reconnectCountdownTimer);
      state.reconnectCountdownTimer = null;
      state.reconnectTimer = null;
      beginHostConnection(true);
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
    state.hostConnection = null;
    if (connection) {
      connection.intentional = true;
      if (connection.ws?.readyState === WebSocket.OPEN) {
        try { connection.ws.send(JSON.stringify(makeSignal('disconnect', { reason }))); } catch { /* Closing. */ }
      }
      cleanupHostConnection(connection);
    }
    if (state.virtualDisplayRunning || connection?.virtualOwned) api.destroyVirtualDisplay().catch(() => {});
    renderHostIdle();
    refreshDevices();
    toast(wasReconnecting || !connection?.connected ? '连接已取消' : '扩展屏已断开', wasReconnecting ? '已停止自动重连' : '子端已恢复等待状态');
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
      ensureReceiverPeer();
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
    setRoleVisibility(state.role);
    setText('app-version', `局域网扩展屏 · ${bootstrap.appVersion || '0.2.0'}`);
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
      const permissionGranted = bootstrap.permission === 'granted';
      byId('permission-banner').hidden = permissionGranted;
      renderDevices();
      renderCaptureMode();
      renderHostIdle();
    } else {
      bindReceiverUi();
      applyReceiverSettings(bootstrap.settings);
      renderReceiverIdle();
    }

    await api.rendererReady();

    if (state.role === 'host') {
      await refreshSources(false);
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
