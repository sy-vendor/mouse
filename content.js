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
    picker: null
  };

  function clearTimer() {
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
  }

  function stop() {
    state.running = false;
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

  function dispatchClick(x, y) {
    const target = document.elementFromPoint(x, y);
    if (!target) return false;
    const common = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
    try {
      target.dispatchEvent(new PointerEvent('pointerdown', { ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1 }));
      target.dispatchEvent(new MouseEvent('mousedown', { ...common, button: 0, buttons: 1 }));
      target.dispatchEvent(new PointerEvent('pointerup', { ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 0 }));
      target.dispatchEvent(new MouseEvent('mouseup', { ...common, button: 0, buttons: 0 }));
      target.click();
      return true;
    } catch (_) {
      target.click?.();
      return true;
    }
  }

  function schedule() {
    if (!state.running) return;
    clearTimer();
    const wait = Math.max(0, state.nextAt - Date.now());
    state.timer = setTimeout(runStep, wait);
  }

  function runStep() {
    if (!state.running || !state.config?.steps.length) return;
    const step = state.config.steps[state.stepIndex];
    chrome.runtime.sendMessage({
      type: 'DISPATCH_FRAME_CLICK',
      frameId: step.frameId ?? 0,
      x: step.x,
      y: step.y,
      showMarker: state.config.showMarker
    }).catch(() => {});

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
    state.nextAt = Date.now() + Math.max(0, step.delay);
    schedule();
  }

  function start(config) {
    stop();
    state.config = config;
    state.stepIndex = 0;
    state.completedLoops = 0;
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
        y: event.clientY
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
      sendResponse({ running: state.running, stepIndex: state.stepIndex, completedLoops: state.completedLoops });
    }
    if (message.type === 'PICK_START' && isTopFrame) { startPicker(); sendResponse({ ok: true }); }
    if (message.type === 'PICKER_ACTIVATE') { activatePicker(); }
    if (message.type === 'PICKER_DEACTIVATE') { stopPicker(); }
    if (message.type === 'RECORD_COUNT' && isTopFrame && state.picker?.panel) {
      state.picker.panel.querySelector('[data-label]').textContent = `已录制 ${message.count} 步`;
    }
    if (message.type === 'FRAME_CLICK') {
      dispatchClick(message.x, message.y);
      if (message.showMarker) marker(message.x, message.y);
    }
  });

  // If an iframe navigates while a recording is in progress, its new content
  // script rejoins the existing recording automatically.
  chrome.runtime.sendMessage({ type: 'RECORDING_STATUS' }).then((response) => {
    if (response?.ok && !state.picker) activatePicker();
  }).catch(() => {});
})();
