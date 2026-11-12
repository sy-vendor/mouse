const stepsEl = document.querySelector('#steps');
const template = document.querySelector('#stepTemplate');
const messageEl = document.querySelector('#message');
const statusEl = document.querySelector('#status');
const repeatEl = document.querySelector('#repeatCount');
const markerEl = document.querySelector('#showMarker');

let activeTabId = null;

function addStep(step = { x: 100, y: 100, delay: 1000 }) {
  const row = template.content.firstElementChild.cloneNode(true);
  row.dataset.frameId = String(step.frameId ?? 0);
  row.querySelector('.x').value = step.x;
  row.querySelector('.y').value = step.y;
  row.querySelector('.delay').value = step.delay;
  row.querySelector('.remove').addEventListener('click', () => {
    row.remove();
    renumber();
  });
  stepsEl.append(row);
  renumber();
}

function renumber() {
  [...stepsEl.children].forEach((row, index) => {
    row.querySelector('.step-number').textContent = String(index + 1).padStart(2, '0');
  });
}

function readConfig() {
  const steps = [...stepsEl.children].map((row) => ({
    x: Number(row.querySelector('.x').value),
    y: Number(row.querySelector('.y').value),
    delay: Number(row.querySelector('.delay').value),
    frameId: Number(row.dataset.frameId) || 0
  }));
  if (!steps.length) throw new Error('请至少添加一个点击步骤');
  if (steps.some((s) => !Number.isFinite(s.x) || !Number.isFinite(s.y) || s.x < 0 || s.y < 0)) {
    throw new Error('坐标必须是大于或等于 0 的数字');
  }
  if (steps.some((s) => !Number.isFinite(s.delay) || s.delay < 0)) {
    throw new Error('间隔时间必须是大于或等于 0 的数字');
  }
  return {
    steps,
    repeatCount: Math.max(0, Math.floor(Number(repeatEl.value) || 0)),
    showMarker: markerEl.checked,
    schemaVersion: 2
  };
}

function showMessage(text, ok = false) {
  messageEl.textContent = text;
  messageEl.style.color = ok ? '#2e7554' : '#bd4126';
}

function setStatus(running, detail = '') {
  statusEl.textContent = running ? (detail || '运行中') : '已停止';
  statusEl.classList.toggle('running', running);
}

async function send(type, payload = {}) {
  if (activeTabId == null) throw new Error('没有可用的网页标签页');
  try {
    return await chrome.tabs.sendMessage(activeTabId, { type, ...payload }, { frameId: 0 });
  } catch (firstError) {
    // Tabs that were already open when the extension was installed/reloaded do
    // not receive manifest content scripts. Inject once and retry automatically.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: activeTabId, allFrames: true },
        files: ['content.js']
      });
      return await chrome.tabs.sendMessage(activeTabId, { type, ...payload }, { frameId: 0 });
    } catch (_) {
      throw new Error('无法连接此页面。请刷新游戏网页；Chrome 内部页面无法运行扩展');
    }
  }
}

document.querySelector('#addStep').addEventListener('click', () => addStep());

document.querySelector('#start').addEventListener('click', async () => {
  try {
    const config = readConfig();
    await chrome.storage.local.set({ macroConfig: config });
    await chrome.storage.local.remove('pickedSteps');
    await send('MACRO_START', { config });
    setStatus(true);
    showMessage('已在当前网页开始执行', true);
  } catch (error) {
    showMessage(error.message);
  }
});

document.querySelector('#stop').addEventListener('click', async () => {
  try {
    await send('MACRO_STOP');
    setStatus(false);
    showMessage('已停止', true);
  } catch (error) {
    showMessage(error.message);
  }
});

document.querySelector('#pickStep').addEventListener('click', async () => {
  try {
    const response = await send('PICK_START');
    if (!response?.ok) throw new Error('无法进入取点模式');
    window.close();
  } catch (error) {
    showMessage(error.message);
  }
});

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  const stored = await chrome.storage.local.get(['macroConfig', 'pickedSteps']);
  const legacyDemo = stored.macroConfig?.steps?.length === 2
    && stored.macroConfig.steps[0]?.x === 120 && stored.macroConfig.steps[0]?.y === 160
    && stored.macroConfig.steps[1]?.x === 260 && stored.macroConfig.steps[1]?.y === 160
    && !stored.macroConfig.schemaVersion;
  const config = (!legacyDemo && stored.macroConfig) || {
    steps: [],
    repeatCount: 0,
    showMarker: true,
    schemaVersion: 2
  };
  repeatEl.value = config.repeatCount ?? 0;
  markerEl.checked = config.showMarker !== false;
  const picked = stored.pickedSteps;
  (picked?.length ? picked : config.steps).forEach(addStep);
  if (picked?.length) {
    showMessage(`已录制 ${picked.length} 步，坐标和实际间隔已自动填写`, true);
  } else if (!config.steps.length) {
    showMessage('还没有点击步骤，请先录制一轮操作');
  }
  try {
    const state = await send('MACRO_STATE');
    setStatus(Boolean(state?.running), state?.running ? `第 ${state.stepIndex + 1} 步` : '');
  } catch (_) {
    setStatus(false);
  }
}

init().catch((error) => showMessage(error.message));
