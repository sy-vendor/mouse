function recordingKey(tabId) {
  return `macroRecording:${tabId}`;
}

function broadcast(tabId, message, options) {
  chrome.tabs.sendMessage(tabId, message, options).catch(() => {});
}

async function getRecording(tabId) {
  const key = recordingKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return stored[key] || null;
}

async function setRecording(tabId, recording) {
  await chrome.storage.session.set({ [recordingKey(tabId)]: recording });
}

async function handleMessage(message, sender) {
  const tabId = sender.tab?.id;
  if (tabId == null) return { ok: false };

  if (message.type === 'RECORDING_START') {
    await setRecording(tabId, { points: [] });
    // A game iframe may have existed before the extension was reloaded. Inject
    // into every currently accessible frame instead of relying only on the
    // manifest's page-load injection.
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ['content.js']
      });
    } catch (_) {
      // The broadcast below still activates frames injected by the manifest.
    }
    broadcast(tabId, { type: 'PICKER_ACTIVATE' });
    return { ok: true };
  }

  if (message.type === 'RECORDING_STATUS') {
    return { ok: Boolean(await getRecording(tabId)) };
  }

  if (message.type === 'RECORD_CLICK') {
    const recording = await getRecording(tabId);
    if (!recording) return { ok: false };
    const now = Date.now();
    const previous = recording.points.at(-1);
    if (previous) previous.delay = Math.max(0, now - previous.clickedAt);
    recording.points.push({
      x: Math.round(message.x),
      y: Math.round(message.y),
      frameId: sender.frameId ?? 0,
      frameUrl: sender.url || message.frameUrl || '',
      target: message.target || null,
      delay: 1000,
      clickedAt: now
    });
    await setRecording(tabId, recording);
    broadcast(tabId, { type: 'RECORD_COUNT', count: recording.points.length }, { frameId: 0 });
    return { ok: true };
  }

  if (message.type === 'RECORDING_UNDO') {
    const recording = await getRecording(tabId);
    if (recording?.points.length) {
      recording.points.pop();
      await setRecording(tabId, recording);
    }
    broadcast(tabId, { type: 'RECORD_COUNT', count: recording?.points.length || 0 }, { frameId: 0 });
    return { ok: true };
  }

  if (message.type === 'RECORDING_CANCEL') {
    await chrome.storage.session.remove(recordingKey(tabId));
    broadcast(tabId, { type: 'PICKER_DEACTIVATE' });
    return { ok: true };
  }

  if (message.type === 'RECORDING_FINISH') {
    const recording = await getRecording(tabId);
    if (!recording?.points.length) return { ok: false, error: '还没有录制任何点击' };
    const last = recording.points.at(-1);
    last.delay = Math.max(0, Date.now() - last.clickedAt);
    const steps = recording.points.map(({ clickedAt, ...step }) => step);
    await chrome.storage.local.set({ pickedSteps: steps });
    await chrome.storage.session.remove(recordingKey(tabId));
    broadcast(tabId, { type: 'PICKER_DEACTIVATE' });
    return { ok: true, count: steps.length };
  }

  if (message.type === 'DISPATCH_FRAME_CLICK') {
    const clickMessage = {
      type: 'FRAME_CLICK',
      x: message.x,
      y: message.y,
      target: message.target || null,
      showMarker: message.showMarker
    };
    const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => []);
    const candidates = [];
    const original = frames.find((frame) => frame.frameId === (message.frameId ?? 0));
    if (original) candidates.push(original);
    if (message.frameUrl) {
      for (const frame of frames) {
        if (frame.url === message.frameUrl && !candidates.some((item) => item.frameId === frame.frameId)) candidates.push(frame);
      }
    }
    if (!candidates.length) candidates.push({ frameId: message.frameId ?? 0 });
    let lastResponse = { ok: false, reason: '目标页面框架尚未就绪' };
    for (const frame of candidates) {
      try {
        const response = await chrome.tabs.sendMessage(tabId, clickMessage, { frameId: frame.frameId });
        if (response?.ok) return response;
        if (response) lastResponse = response;
      } catch (_) {
        lastResponse = { ok: false, reason: '目标页面框架尚未就绪' };
      }
    }
    return lastResponse;
  }

  return { ok: false };
}

const handledTypes = new Set([
  'RECORDING_START', 'RECORDING_STATUS', 'RECORD_CLICK', 'RECORDING_UNDO',
  'RECORDING_CANCEL', 'RECORDING_FINISH', 'DISPATCH_FRAME_CLICK'
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!handledTypes.has(message.type)) return;
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
