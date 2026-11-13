(() => {
  if (globalThis.__coordinateMacroLoaded) return;
  globalThis.__coordinateMacroLoaded = true;
  const isTopFrame = window === window.top;

  const state = {
    running: false,
    timer: null,
    config: null,
    stepIndex: 0,
    completedLoops: 0,
    nextAt: 0,
    picker: null,
    inFlight: false,
    stepStartedAt: 0,
    lastError: ''
  };

  function clearTimer() {
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
  }

  function stop() {
    state.running = false;
    state.inFlight = false;
    clearTimer();
  }

  function marker(x, y) {
    const dot = document.createElement('div');
    dot.style.cssText = [
      'position:fixed', `left:${x - 12}px`, `top:${y - 12}px`, 'width:24px', 'height:24px',
      'border:2px solid #ff5b35', 'border-radius:50%', 'z-index:2147483647',
      'pointer-events:none', 'box-shadow:0 0 0 4px rgba(255,91,53,.22)',
      'transition:transform .25s ease,opacity .25s ease'
    ].join(';');
    document.documentElement.append(dot);
    requestAnimationFrame(() => { dot.style.transform = 'scale(1.8)'; dot.style.opacity = '0'; });
    setTimeout(() => dot.remove(), 300);
  }

  function selectorFor(element) {
    if (!(element instanceof Element)) return '';
    if (element.id) return `#${CSS.escape(element.id)}`;
    for (const attribute of ['data-testid', 'data-id', 'aria-label', 'name']) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      const candidate = `${element.localName}[${attribute}="${CSS.escape(value)}"]`;
      try { if (document.querySelectorAll(candidate).length === 1) return candidate; } catch (_) {}
    }
    const parts = [];
    let current = element;
    while (current && current !== document.documentElement && parts.length < 8) {
      let part = current.localName;
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter((item) => item.localName === current.localName)
        : [];
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      parts.unshift(part);
      const candidate = parts.join(' > ');
      try { if (document.querySelectorAll(candidate).length === 1) return candidate; } catch (_) {}
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  function sampleCanvas(canvas, offsetX, offsetY) {
    if (!(canvas instanceof HTMLCanvasElement) || !canvas.width || !canvas.height) return null;
    const centerX = Math.min(canvas.width - 1, Math.max(0, Math.round(offsetX * canvas.width)));
    const centerY = Math.min(canvas.height - 1, Math.max(0, Math.round(offsetY * canvas.height)));
    const startX = Math.max(0, centerX - 1);
    const startY = Math.max(0, centerY - 1);
    const width = Math.min(3, canvas.width - startX);
    const height = Math.min(3, canvas.height - startY);
    try {
      const context2d = canvas.getContext('2d');
      if (context2d) {
        const pixels = context2d.getImageData(startX, startY, width, height).data;
        const totals = [0, 0, 0];
        for (let index = 0; index < pixels.length; index += 4) {
          totals[0] += pixels[index]; totals[1] += pixels[index + 1]; totals[2] += pixels[index + 2];
        }
        const count = pixels.length / 4;
        return totals.map((value) => Math.round(value / count));
      }
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (gl) {
        const pixels = new Uint8Array(width * height * 4);
        const readY = Math.max(0, canvas.height - startY - height);
        gl.readPixels(startX, readY, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        if (gl.getError() !== gl.NO_ERROR) return null;
        const totals = [0, 0, 0];
        for (let index = 0; index < pixels.length; index += 4) {
          totals[0] += pixels[index]; totals[1] += pixels[index + 1]; totals[2] += pixels[index + 2];
        }
        const count = pixels.length / 4;
        const result = totals.map((value) => Math.round(value / count));
        return result.some((value) => value !== 0) ? result : null;
      }
    } catch (_) {}
    return null;
  }

  function canvasMatches(canvas, descriptor) {
    if (!descriptor.canvasSample) return true;
    const current = sampleCanvas(canvas, descriptor.offsetX ?? 0.5, descriptor.offsetY ?? 0.5);
    if (!current) return true;
    const distance = Math.sqrt(current.reduce((total, value, index) => {
      const difference = value - descriptor.canvasSample[index];
      return total + difference * difference;
    }, 0));
    return distance <= 100;
  }

  function describeTarget(event) {
    const raw = event.target instanceof Element ? event.target : null;
    const element = raw?.closest('button, a, input, [role="button"], canvas') || raw;
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const descriptor = {
      selector: selectorFor(element),
      tag: element.localName,
      offsetX: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      offsetY: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
      text: element instanceof HTMLCanvasElement ? '' : (element.textContent || element.getAttribute('aria-label') || '').trim().slice(0, 80)
    };
    if (element instanceof HTMLCanvasElement) {
      descriptor.canvasSample = sampleCanvas(element, descriptor.offsetX, descriptor.offsetY);
    }
    return descriptor;
  }

  function dispatchClick(message) {
    let target = null;
    let x = Number(message.x);
    let y = Number(message.y);
    if (message.target?.selector) {
      try { target = document.querySelector(message.target.selector); } catch (_) {}
      if (!target) return { ok: false, reason: '目标元素尚未出现' };
      const rect = target.getBoundingClientRect();
      const style = getComputedStyle(target);
      if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') {
        return { ok: false, reason: '目标元素当前不可见' };
      }
      if (message.target.text) {
        const currentText = (target.textContent || target.getAttribute('aria-label') || '').trim();
        if (!currentText.includes(message.target.text)) return { ok: false, reason: '目标按钮文字尚未出现' };
      }
      if (target instanceof HTMLCanvasElement && !canvasMatches(target, message.target)) {
        return { ok: false, reason: '目标画面尚未出现' };
      }
      x = rect.left + rect.width * (message.target.offsetX ?? 0.5);
      y = rect.top + rect.height * (message.target.offsetY ?? 0.5);
    } else {
      target = document.elementFromPoint(x, y);
    }
    if (!target || !Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: '点击位置不可用' };
    const common = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
    try {
      target.dispatchEvent(new PointerEvent('pointerdown', { ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1 }));
      target.dispatchEvent(new MouseEvent('mousedown', { ...common, button: 0, buttons: 1 }));
      target.dispatchEvent(new PointerEvent('pointerup', { ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 0 }));
      target.dispatchEvent(new MouseEvent('mouseup', { ...common, button: 0, buttons: 0 }));
      target.click();
      return { ok: true, x, y, usedTarget: Boolean(message.target?.selector) };
    } catch (_) {
      target.click?.();
      return { ok: true, x, y, usedTarget: Boolean(message.target?.selector) };
    }
  }

  function schedule() {
    if (!state.running) return;
    clearTimer();
    const wait = Math.max(0, state.nextAt - Date.now());
    state.timer = setTimeout(runStep, wait);
  }

  async function runStep() {
    if (!state.running || state.inFlight || !state.config?.steps.length) return;
    state.inFlight = true;
    const step = state.config.steps[state.stepIndex];
    if (!state.stepStartedAt) state.stepStartedAt = Date.now();
    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: 'DISPATCH_FRAME_CLICK',
        frameId: step.frameId ?? 0,
        frameUrl: step.frameUrl || '',
        x: step.x,
        y: step.y,
        target: step.target || null,
        showMarker: state.config.showMarker
      });
    } catch (_) {
      response = { ok: false, reason: '页面暂时无法响应' };
    }
    state.inFlight = false;
    if (!state.running) return;
    if (!response?.ok) {
      if (Date.now() - state.stepStartedAt < 12000) {
        state.nextAt = Date.now() + 250;
        schedule();
        return;
      }
      state.lastError = `第 ${state.stepIndex + 1} 步超时：${response?.reason || '目标未出现'}`;
      stop();
      return;
    }
    state.stepStartedAt = 0;
    state.lastError = '';

    state.stepIndex += 1;
    if (state.stepIndex >= state.config.steps.length) {
      state.stepIndex = 0;
      state.completedLoops += 1;
      if (state.config.repeatCount > 0 && state.completedLoops >= state.config.repeatCount) {
        stop();
        return;
      }
    }

    // Use a wall-clock deadline. If Chrome throttles a hidden tab, the next delay
    // starts from the actual execution time instead of building up timer drift.
    const margin = Math.max(0, Number(state.config.delayMargin) || 0);
    state.nextAt = Date.now() + Math.max(50, step.delay * (1 + margin / 100));
    schedule();
  }

  function start(config) {
    stop();
    state.config = config;
    state.stepIndex = 0;
    state.completedLoops = 0;
    state.stepStartedAt = 0;
    state.lastError = '';
    state.running = true;
    state.nextAt = Date.now();
    schedule();
  }

  function stopPicker() {
    const picker = state.picker;
    if (!picker) return;
    window.removeEventListener('pointerdown', picker.onPointerDown, true);
    picker.panel?.remove();
    picker.cross.remove();
    state.picker = null;
  }

  function finishPicker() {
    chrome.runtime.sendMessage({ type: 'RECORDING_FINISH' }).then((response) => {
      if (response?.ok) return;
      if (state.picker?.panel) {
        const label = state.picker.panel.querySelector('[data-label]');
        label.textContent = response?.error || '还没有录制点击';
      }
    }).catch(() => {});
  }

  function activatePicker() {
    stopPicker();
    stop();
    let panel = null;
    if (isTopFrame) {
      panel = document.createElement('div');
      panel.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:12px;background:#17201b;color:white;font:600 13px/1.5 system-ui;box-shadow:0 8px 28px rgba(0,0,0,.28)';
      panel.innerHTML = '<span data-label>录制中：正常操作网页</span><button data-done>完成录制</button><button data-undo>撤销一步</button><button data-cancel>取消</button>';
      for (const button of panel.querySelectorAll('button')) {
        button.style.cssText = 'padding:6px 10px;border:0;border-radius:7px;cursor:pointer;font:700 12px system-ui';
      }
      panel.querySelector('[data-done]').style.background = '#59e1d7';
      panel.querySelector('[data-done]').addEventListener('click', (event) => {
        event.preventDefault(); event.stopPropagation(); finishPicker();
      });
      panel.querySelector('[data-undo]').addEventListener('click', (event) => {
        event.preventDefault(); event.stopPropagation();
        chrome.runtime.sendMessage({ type: 'RECORDING_UNDO' }).catch(() => {});
      });
      panel.querySelector('[data-cancel]').addEventListener('click', (event) => {
        event.preventDefault(); event.stopPropagation();
        chrome.runtime.sendMessage({ type: 'RECORDING_CANCEL' }).catch(() => {});
      });
      document.documentElement.append(panel);
    }
    const cross = document.createElement('div');
    cross.style.cssText = 'display:none;position:fixed;width:18px;height:18px;margin:-9px 0 0 -9px;border:2px solid #ff5b35;border-radius:50%;z-index:2147483646;pointer-events:none';
    document.documentElement.append(cross);

    const onPointerDown = (event) => {
      if (panel?.contains(event.target)) return;
      chrome.runtime.sendMessage({
        type: 'RECORD_CLICK',
        x: event.clientX,
        y: event.clientY,
        frameUrl: location.href,
        target: describeTarget(event)
      }).catch(() => {});
      cross.style.display = 'block';
      cross.style.left = `${event.clientX}px`;
      cross.style.top = `${event.clientY}px`;
    };
    state.picker = { panel, cross, onPointerDown };
    window.addEventListener('pointerdown', onPointerDown, true);
  }

  function startPicker() {
    stop();
    chrome.runtime.sendMessage({ type: 'RECORDING_START' }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'MACRO_START' && isTopFrame) { start(message.config); sendResponse({ ok: true }); }
    if (message.type === 'MACRO_STOP' && isTopFrame) { stop(); sendResponse({ ok: true }); }
    if (message.type === 'MACRO_STATE') {
      sendResponse({ running: state.running, stepIndex: state.stepIndex, completedLoops: state.completedLoops, error: state.lastError });
    }
    if (message.type === 'PICK_START' && isTopFrame) { startPicker(); sendResponse({ ok: true }); }
    if (message.type === 'PICKER_ACTIVATE') { activatePicker(); }
    if (message.type === 'PICKER_DEACTIVATE') { stopPicker(); }
    if (message.type === 'RECORD_COUNT' && isTopFrame && state.picker?.panel) {
      state.picker.panel.querySelector('[data-label]').textContent = `已录制 ${message.count} 步`;
    }
    if (message.type === 'FRAME_CLICK') {
      const result = dispatchClick(message);
      if (result.ok && message.showMarker) marker(result.x, result.y);
      sendResponse(result);
    }
  });

  // If an iframe navigates while a recording is in progress, its new content
  // script rejoins the existing recording automatically.
  chrome.runtime.sendMessage({ type: 'RECORDING_STATUS' }).then((response) => {
    if (response?.ok && !state.picker) activatePicker();
  }).catch(() => {});
})();
