(() => {
  "use strict";

  // ── DOM refs ──
  const $ = (id) => document.getElementById(id);
  const canvas = $("canvas");
  const ctx = canvas.getContext("2d", { colorSpace: "srgb" });
  const canvasContainer = $("canvas-container");
  const dropZone = $("drop-zone");
  const cropSelect = $("crop-select");
  const globalColor = $("global-color");
  const brightnessSlider = $("brightness");
  const contrastSlider = $("contrast");
  const brightnessVal = $("brightness-val");
  const contrastVal = $("contrast-val");
  const annotationList = $("annotation-list");
  const propsPanel = $("properties-panel");
  const propLabel = $("prop-label");
  const propColor = $("prop-color");
  const propLabelColor = $("prop-label-color");
  const propFontSize = $("prop-font-size");
  const propFontSizeVal = $("prop-font-size-val");
  const propLineWidth = $("prop-line-width");
  const propLineWidthVal = $("prop-line-width-val");
  const propArrowhead = $("prop-arrowhead");
  const propLabelPos = $("prop-label-pos");
  const propDelete = $("prop-delete");
  const btnDownloadJpg = $("btn-download-jpg");
  const btnDownloadPng = $("btn-download-png");

  // Containers toggled by annotation type
  const containers = {
    lineColor: $("line-color-container"),
    lineWidth: $("line-width-container"),
    arrowhead: $("arrowhead-container"),
    labelPos: $("label-pos-container"),
  };

  const TOOLS = ["box", "arrow", "text", "select"];
  const TOOL_KEYS = { b: "box", a: "arrow", t: "text", v: "select" };
  const toolBtns = Object.fromEntries(TOOLS.map((t) => [t, $("tool-" + t)]));

  // ── State ──
  let originalImage = null;
  let displayScale = 1;
  let imgDrawW = 0, imgDrawH = 0;

  let currentTool = "box";
  let annotations = [];
  let selectedId = null;
  let nextId = 1;
  let counters = { box: 0, arrow: 0, text: 0 };
  let originalFileName = "image";
  let brightness = 100, contrast = 100;

  // Crop
  let cropRatio = null;
  let cropRect = null;

  // Drag interaction
  let isDragging = false;
  let dragType = null;  // "create" | "move" | "resize-handle" | "crop-move"
  let dragStart = { x: 0, y: 0 };
  let dragAnnotation = null;
  let dragHandle = null;
  let dragOffset = { x: 0, y: 0 };

  const HANDLE_SIZE = 7;

  // ── Helpers ──
  function getSelected() {
    return annotations.find((a) => a.id === selectedId) || null;
  }

  function dist(x1, y1, x2, y2) {
    return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
  }

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  function pointInRect(px, py, rx, ry, rw, rh) {
    return px >= rx && px <= rx + rw && py >= ry && py <= ry + rh;
  }

  function pointNearLine(px, py, x1, y1, x2, y2, tol) {
    const lenSq = (x2 - x1) ** 2 + (y2 - y1) ** 2;
    if (lenSq === 0) return dist(px, py, x1, y1) < tol;
    const t = clamp(((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / lenSq, 0, 1);
    return dist(px, py, x1 + t * (x2 - x1), y1 + t * (y2 - y1)) < tol;
  }

  // Unit vector from (x1,y1) toward (x2,y2), or {x:0,y:0} if zero-length
  function unitVec(x1, y1, x2, y2) {
    const len = dist(x1, y1, x2, y2) || 1;
    return { x: (x2 - x1) / len, y: (y2 - y1) / len };
  }

  // ── Annotation factory ──
  function createAnnotation(type, props) {
    counters[type]++;
    const defaults = {
      id: nextId++,
      type,
      label: "",
      color: globalColor.value,
      labelColor: globalColor.value,
      fontSize: 16,
    };
    if (type === "box" || type === "arrow") {
      defaults.lineWidth = 2;
    }
    if (type === "box") {
      defaults.labelPos = "top";
    }
    if (type === "arrow") {
      defaults.showHead = true;
    }
    return { ...defaults, ...props };
  }

  // Prompt for label; returns the string or null if cancelled
  function promptLabel(type) {
    const n = counters[type];
    const name = type.charAt(0).toUpperCase() + type.slice(1);
    return prompt(`Label for this ${type}:`, `${name} ${n}`);
  }

  // ── Tool switching ──
  function setTool(tool) {
    currentTool = tool;
    for (const [k, btn] of Object.entries(toolBtns)) {
      btn.classList.toggle("active", k === tool);
    }
    canvas.style.cursor = tool === "select" ? "default" : "crosshair";
    deselectAll();
  }

  for (const tool of TOOLS) {
    toolBtns[tool].addEventListener("click", () => setTool(tool));
  }

  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    if (TOOL_KEYS[e.key]) {
      setTool(TOOL_KEYS[e.key]);
    } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId != null) {
      deleteAnnotation(selectedId);
    } else if (e.key === "Escape") {
      deselectAll();
      if (cropRatio) { cropSelect.value = "none"; clearCrop(); }
    }
  });

  // ── Image upload ──
  $("file-input").addEventListener("change", (e) => {
    if (e.target.files.length) loadImageFile(e.target.files[0]);
  });

  canvasContainer.addEventListener("dragover", (e) => {
    e.preventDefault();
    canvasContainer.classList.add("drag-over");
  });
  canvasContainer.addEventListener("dragleave", () => {
    canvasContainer.classList.remove("drag-over");
  });
  canvasContainer.addEventListener("drop", (e) => {
    e.preventDefault();
    canvasContainer.classList.remove("drag-over");
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("image/")) loadImageFile(file);
  });

  function loadImageFile(file) {
    originalFileName = file.name.replace(/\.[^.]+$/, "");
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        originalImage = img;
        annotations = [];
        selectedId = null;
        nextId = 1;
        counters = { box: 0, arrow: 0, text: 0 };
        cropSelect.value = "none";
        cropRatio = null;
        cropRect = null;
        brightness = 100;
        contrast = 100;
        brightnessSlider.value = 100;
        contrastSlider.value = 100;
        brightnessVal.textContent = "100%";
        contrastVal.textContent = "100%";
        fitCanvas();
        btnDownloadJpg.disabled = false;
        btnDownloadPng.disabled = false;
        dropZone.classList.add("hidden");
        canvas.classList.add("visible");
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  }

  function fitCanvas() {
    if (!originalImage) return;
    const iw = originalImage.naturalWidth;
    const ih = originalImage.naturalHeight;
    displayScale = Math.min(canvasContainer.clientWidth / iw, canvasContainer.clientHeight / ih, 1);
    imgDrawW = Math.round(iw * displayScale);
    imgDrawH = Math.round(ih * displayScale);
    canvas.width = imgDrawW;
    canvas.height = imgDrawH;
    if (cropRatio) initCrop();
    render();
  }

  window.addEventListener("resize", fitCanvas);

  // ── Brightness / Contrast ──
  brightnessSlider.addEventListener("input", () => {
    brightness = +brightnessSlider.value;
    brightnessVal.textContent = brightness + "%";
    render();
  });
  contrastSlider.addEventListener("input", () => {
    contrast = +contrastSlider.value;
    contrastVal.textContent = contrast + "%";
    render();
  });

  // ── Crop ──
  cropSelect.addEventListener("change", () => {
    const val = cropSelect.value;
    if (val === "none") {
      clearCrop();
    } else {
      const [w, h] = val.split(":").map(Number);
      cropRatio = { w, h };
      initCrop();
    }
    render();
  });

  function clearCrop() {
    cropRatio = null;
    cropRect = null;
    render();
  }

  function initCrop() {
    if (!cropRatio || !originalImage) return;
    const ratio = cropRatio.w / cropRatio.h;
    let cw, ch;
    if (imgDrawW / imgDrawH > ratio) {
      ch = imgDrawH; cw = ch * ratio;
    } else {
      cw = imgDrawW; ch = cw / ratio;
    }
    cropRect = { x: (imgDrawW - cw) / 2, y: (imgDrawH - ch) / 2, w: cw, h: ch };
  }

  // ── Label position calculation (shared by render + export) ──
  function getBoxLabelPos(ann, fontSize, textW, scale) {
    const s = scale || 1;
    const pad = 4 * s;
    const bx = (ann.x * s), by = (ann.y * s);
    const bw = (ann.w * s), bh = (ann.h * s);
    const pos = ann.labelPos || "top";
    if (pos === "top") return { x: bx, y: by - fontSize - pad * 2 };
    if (pos === "bottom") return { x: bx, y: by + bh + pad };
    if (pos === "left") return { x: bx - textW - pad * 3, y: by };
    return { x: bx + bw + pad, y: by };
  }

  function getArrowLabelPos(x1, y1, x2, y2, fontSize, textW, pad) {
    const u = unitVec(x1, y1, x2, y2);
    const offset = fontSize + pad;
    return {
      x: x1 - u.x * offset - textW / 2,
      y: y1 - u.y * offset - fontSize / 2,
    };
  }

  // ── Rendering ──
  function render() {
    if (!originalImage) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.filter = `brightness(${brightness}%) contrast(${contrast}%)`;
    ctx.drawImage(originalImage, 0, 0, imgDrawW, imgDrawH);
    ctx.restore();

    for (const ann of annotations) {
      drawAnnotation(ann, ann.id === selectedId);
    }

    if (cropRect) drawCropOverlay();
  }

  function drawAnnotation(ann, selected) {
    ctx.save();
    ctx.strokeStyle = ann.color;
    ctx.fillStyle = ann.color;
    ctx.lineWidth = ann.lineWidth || 0;

    if (ann.type === "box") {
      ctx.strokeRect(ann.x, ann.y, ann.w, ann.h);
      drawBoxLabel(ann);
      if (selected) drawHandles(getBoxHandlePoints(ann));
    } else if (ann.type === "arrow") {
      drawArrowLine(ann);
      drawArrowLabelOnCanvas(ann);
      if (selected) drawCircleHandles([
        { x: ann.x1, y: ann.y1 },
        { x: ann.x2, y: ann.y2 },
      ]);
    } else if (ann.type === "text") {
      drawText(ann);
      if (selected) drawTextSelection(ann);
    }
    ctx.restore();
  }

  function drawArrowLine(ann) {
    ctx.beginPath();
    ctx.moveTo(ann.x1, ann.y1);
    ctx.lineTo(ann.x2, ann.y2);
    ctx.stroke();

    if (ann.showHead !== false) {
      const headLen = 10 + ann.lineWidth * 2;
      const angle = Math.atan2(ann.y2 - ann.y1, ann.x2 - ann.x1);
      ctx.beginPath();
      ctx.moveTo(ann.x2, ann.y2);
      ctx.lineTo(ann.x2 - headLen * Math.cos(angle - Math.PI / 6), ann.y2 - headLen * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(ann.x2 - headLen * Math.cos(angle + Math.PI / 6), ann.y2 - headLen * Math.sin(angle + Math.PI / 6));
      ctx.closePath();
      ctx.fill();
    }
  }

  function drawBoxLabel(ann) {
    if (!ann.label) return;
    ctx.font = `${ann.fontSize}px sans-serif`;
    const textW = ctx.measureText(ann.label).width;
    const pos = getBoxLabelPos(ann, ann.fontSize, textW);
    ctx.fillStyle = ann.labelColor || ann.color;
    ctx.textBaseline = "top";
    ctx.fillText(ann.label, pos.x, pos.y);
  }

  function drawArrowLabelOnCanvas(ann) {
    if (!ann.label) return;
    ctx.font = `${ann.fontSize}px sans-serif`;
    const textW = ctx.measureText(ann.label).width;
    const pos = getArrowLabelPos(ann.x1, ann.y1, ann.x2, ann.y2, ann.fontSize, textW, 6);
    ctx.fillStyle = ann.labelColor || ann.color;
    ctx.textBaseline = "top";
    ctx.fillText(ann.label, pos.x, pos.y);
  }

  function drawText(ann) {
    if (!ann.label) return;
    ctx.font = `${ann.fontSize}px sans-serif`;
    ctx.fillStyle = ann.labelColor || ann.color;
    ctx.textBaseline = "top";
    ctx.fillText(ann.label, ann.x, ann.y);
  }

  function getTextBounds(ann) {
    ctx.font = `${ann.fontSize}px sans-serif`;
    return { x: ann.x, y: ann.y, w: ctx.measureText(ann.label || " ").width, h: ann.fontSize };
  }

  function drawTextSelection(ann) {
    const b = getTextBounds(ann);
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4);
    ctx.setLineDash([]);
    // Resize handle at bottom-right
    drawHandles([{ x: b.x + b.w + 2, y: b.y + b.h + 2 }]);
  }

  // Shared handle drawing
  function drawHandles(points) {
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 1;
    const hs = HANDLE_SIZE / 2;
    for (const p of points) {
      ctx.fillRect(p.x - hs, p.y - hs, HANDLE_SIZE, HANDLE_SIZE);
      ctx.strokeRect(p.x - hs, p.y - hs, HANDLE_SIZE, HANDLE_SIZE);
    }
  }

  function drawCircleHandles(points) {
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 1;
    for (const p of points) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, HANDLE_SIZE / 2 + 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  function getBoxHandlePoints(ann) {
    return [
      { x: ann.x, y: ann.y, idx: 0 },
      { x: ann.x + ann.w, y: ann.y, idx: 1 },
      { x: ann.x + ann.w, y: ann.y + ann.h, idx: 2 },
      { x: ann.x, y: ann.y + ann.h, idx: 3 },
    ];
  }

  function drawCropOverlay() {
    const c = cropRect;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, 0, canvas.width, c.y);
    ctx.fillRect(0, c.y + c.h, canvas.width, canvas.height - c.y - c.h);
    ctx.fillRect(0, c.y, c.x, c.h);
    ctx.fillRect(c.x + c.w, c.y, canvas.width - c.x - c.w, c.h);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(c.x, c.y, c.w, c.h);
    ctx.setLineDash([]);
  }

  // ── Hit testing ──
  function hitTest(mx, my) {
    for (let i = annotations.length - 1; i >= 0; i--) {
      const ann = annotations[i];
      const isSelected = ann.id === selectedId;

      if (ann.type === "box") {
        if (isSelected) {
          const handle = hitHandlePoints(getBoxHandlePoints(ann), mx, my);
          if (handle !== null) return { type: "handle", ann, handle };
        }
        if (pointNearBoxEdge(ann, mx, my, 8) || pointInRect(mx, my, ann.x, ann.y, ann.w, ann.h)) {
          return { type: "annotation", ann };
        }
      } else if (ann.type === "arrow") {
        if (isSelected) {
          if (dist(mx, my, ann.x1, ann.y1) < 10) return { type: "handle", ann, handle: "start" };
          if (dist(mx, my, ann.x2, ann.y2) < 10) return { type: "handle", ann, handle: "end" };
        }
        if (pointNearLine(mx, my, ann.x1, ann.y1, ann.x2, ann.y2, 8)) {
          return { type: "annotation", ann };
        }
      } else if (ann.type === "text") {
        const b = getTextBounds(ann);
        if (isSelected) {
          const hx = b.x + b.w + 2, hy = b.y + b.h + 2;
          if (Math.abs(mx - hx) <= HANDLE_SIZE && Math.abs(my - hy) <= HANDLE_SIZE) {
            return { type: "handle", ann, handle: "text-resize" };
          }
        }
        if (pointInRect(mx, my, b.x, b.y, b.w, b.h)) {
          return { type: "annotation", ann };
        }
      }
    }
    return null;
  }

  function hitHandlePoints(handles, mx, my) {
    for (const h of handles) {
      if (Math.abs(mx - h.x) <= HANDLE_SIZE && Math.abs(my - h.y) <= HANDLE_SIZE) {
        return h.idx;
      }
    }
    return null;
  }

  function pointNearBoxEdge(ann, mx, my, tol) {
    return pointInRect(mx, my, ann.x - tol, ann.y - tol, ann.w + tol * 2, ann.h + tol * 2)
      && !pointInRect(mx, my, ann.x + tol, ann.y + tol, Math.max(0, ann.w - tol * 2), Math.max(0, ann.h - tol * 2));
  }

  // ── Mouse events ──
  function getMousePos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  canvas.addEventListener("mousedown", (e) => {
    if (!originalImage) return;
    const { x: mx, y: my } = getMousePos(e);

    // Crop drag (any tool)
    if (cropRect && pointInRect(mx, my, cropRect.x, cropRect.y, cropRect.w, cropRect.h)) {
      isDragging = true;
      dragType = "crop-move";
      dragOffset = { x: mx - cropRect.x, y: my - cropRect.y };
      return;
    }

    // Hit existing annotations (any tool)
    const hit = hitTest(mx, my);
    if (hit && hit.type === "handle") {
      selectAnnotation(hit.ann.id);
      isDragging = true;
      dragType = "resize-handle";
      dragAnnotation = hit.ann;
      dragHandle = hit.handle;
      dragStart = { x: mx, y: my };
    } else if (hit && hit.type === "annotation") {
      selectAnnotation(hit.ann.id);
      isDragging = true;
      dragType = "move";
      dragAnnotation = hit.ann;
      if (hit.ann.type === "box" || hit.ann.type === "text") {
        dragOffset = { x: mx - hit.ann.x, y: my - hit.ann.y };
      } else {
        dragOffset = { x: mx - hit.ann.x1, y: my - hit.ann.y1 };
      }
    } else if (currentTool === "box" || currentTool === "arrow") {
      deselectAll();
      isDragging = true;
      dragType = "create";
      dragStart = { x: mx, y: my };
    } else if (currentTool === "text") {
      deselectAll();
      counters.text++;
      const label = prompt("Text:", `Text ${counters.text}`);
      if (label === null) {
        counters.text--;
      } else {
        const ann = createAnnotation("text", { x: mx, y: my, label });
        annotations.push(ann);
        selectAnnotation(ann.id);
        updateSidebar();
      }
      render();
    } else {
      deselectAll();
    }
  });

  canvas.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const { x: mx, y: my } = getMousePos(e);

    if (dragType === "create") {
      render();
      ctx.save();
      ctx.strokeStyle = globalColor.value;
      ctx.lineWidth = 2;
      if (currentTool === "box") {
        ctx.strokeRect(
          Math.min(dragStart.x, mx), Math.min(dragStart.y, my),
          Math.abs(mx - dragStart.x), Math.abs(my - dragStart.y)
        );
      } else if (currentTool === "arrow") {
        ctx.fillStyle = globalColor.value;
        drawArrowLine({ x1: dragStart.x, y1: dragStart.y, x2: mx, y2: my, lineWidth: 2, showHead: true });
      }
      ctx.restore();
    } else if (dragType === "move") {
      const ann = dragAnnotation;
      if (ann.type === "box" || ann.type === "text") {
        ann.x = mx - dragOffset.x;
        ann.y = my - dragOffset.y;
      } else {
        const dx = mx - dragOffset.x - ann.x1;
        const dy = my - dragOffset.y - ann.y1;
        ann.x1 += dx; ann.y1 += dy;
        ann.x2 += dx; ann.y2 += dy;
      }
      render();
    } else if (dragType === "resize-handle") {
      const ann = dragAnnotation;
      if (ann.type === "box") {
        resizeBox(ann, dragHandle, mx, my);
      } else if (ann.type === "text") {
        ann.fontSize = clamp(Math.round(ann.fontSize + (my - dragStart.y)), 12, 72);
        dragStart.y = my;
      } else {
        if (dragHandle === "start") { ann.x1 = mx; ann.y1 = my; }
        else { ann.x2 = mx; ann.y2 = my; }
      }
      render();
    } else if (dragType === "crop-move") {
      cropRect.x = clamp(mx - dragOffset.x, 0, imgDrawW - cropRect.w);
      cropRect.y = clamp(my - dragOffset.y, 0, imgDrawH - cropRect.h);
      render();
    }
  });

  canvas.addEventListener("mouseup", (e) => {
    if (!isDragging) return;
    const { x: mx, y: my } = getMousePos(e);

    if (dragType === "create") {
      if (currentTool === "box") {
        const x = Math.min(dragStart.x, mx), y = Math.min(dragStart.y, my);
        const w = Math.abs(mx - dragStart.x), h = Math.abs(my - dragStart.y);
        if (w > 5 && h > 5) {
          const label = promptLabel("box");
          if (label !== null) {
            const ann = createAnnotation("box", { x, y, w, h, label });
            annotations.push(ann);
            selectAnnotation(ann.id);
          } else {
            counters.box--;
          }
        }
      } else if (currentTool === "arrow") {
        if (dist(dragStart.x, dragStart.y, mx, my) > 10) {
          const label = promptLabel("arrow");
          if (label !== null) {
            const ann = createAnnotation("arrow", {
              x1: dragStart.x, y1: dragStart.y, x2: mx, y2: my, label,
            });
            annotations.push(ann);
            selectAnnotation(ann.id);
          } else {
            counters.arrow--;
          }
        }
      }
    }

    isDragging = false;
    dragType = null;
    dragAnnotation = null;
    dragHandle = null;
    render();
    updateSidebar();
  });

  function resizeBox(ann, handleIdx, mx, my) {
    const r = ann.x + ann.w, b = ann.y + ann.h;
    if (handleIdx === 0) { ann.x = mx; ann.y = my; ann.w = r - mx; ann.h = b - my; }
    else if (handleIdx === 1) { ann.w = mx - ann.x; ann.y = my; ann.h = b - my; }
    else if (handleIdx === 2) { ann.w = mx - ann.x; ann.h = my - ann.y; }
    else if (handleIdx === 3) { ann.x = mx; ann.w = r - mx; ann.h = my - ann.y; }
  }

  // ── Selection ──
  function selectAnnotation(id) {
    selectedId = id;
    updateSidebar();
    updatePropsPanel();
    render();
  }

  function deselectAll() {
    selectedId = null;
    updateSidebar();
    updatePropsPanel();
    render();
  }

  function deleteAnnotation(id) {
    annotations = annotations.filter((a) => a.id !== id);
    if (selectedId === id) selectedId = null;
    updateSidebar();
    updatePropsPanel();
    render();
  }

  // ── Sidebar ──
  function updateSidebar() {
    annotationList.innerHTML = "";
    for (const ann of annotations) {
      const li = document.createElement("li");
      if (ann.id === selectedId) li.classList.add("selected");

      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = ann.color;
      li.appendChild(swatch);

      const text = document.createElement("span");
      text.textContent = ann.label || ann.type.charAt(0).toUpperCase() + ann.type.slice(1);
      li.appendChild(text);

      li.addEventListener("click", () => selectAnnotation(ann.id));
      annotationList.appendChild(li);
    }
  }

  function updatePropsPanel() {
    const ann = getSelected();
    if (!ann) { propsPanel.classList.add("hidden"); return; }

    propsPanel.classList.remove("hidden");
    const isText = ann.type === "text";

    propLabel.value = ann.label;
    propColor.value = ann.color;
    propLabelColor.value = ann.labelColor || ann.color;
    propFontSize.value = ann.fontSize;
    propFontSizeVal.textContent = ann.fontSize + "px";
    propLineWidth.value = ann.lineWidth || 2;
    propLineWidthVal.textContent = (ann.lineWidth || 2) + "px";

    containers.lineColor.style.display = isText ? "none" : "";
    containers.lineWidth.style.display = isText ? "none" : "";
    containers.arrowhead.style.display = ann.type === "arrow" ? "" : "none";
    containers.labelPos.style.display = ann.type === "box" ? "" : "none";

    if (ann.type === "arrow") propArrowhead.checked = ann.showHead !== false;
    if (ann.type === "box") propLabelPos.value = ann.labelPos;
  }

  // ── Property editors ──
  function onPropChange(fn) {
    return () => { const ann = getSelected(); if (ann) fn(ann); };
  }

  propLabel.addEventListener("input", onPropChange((ann) => {
    ann.label = propLabel.value; render(); updateSidebar();
  }));
  propColor.addEventListener("input", onPropChange((ann) => {
    ann.color = propColor.value; render(); updateSidebar();
  }));
  propLabelColor.addEventListener("input", onPropChange((ann) => {
    ann.labelColor = propLabelColor.value; render();
  }));
  propArrowhead.addEventListener("change", onPropChange((ann) => {
    if (ann.type === "arrow") { ann.showHead = propArrowhead.checked; render(); }
  }));
  propFontSize.addEventListener("input", onPropChange((ann) => {
    ann.fontSize = +propFontSize.value;
    propFontSizeVal.textContent = ann.fontSize + "px";
    render();
  }));
  propLineWidth.addEventListener("input", onPropChange((ann) => {
    ann.lineWidth = +propLineWidth.value;
    propLineWidthVal.textContent = ann.lineWidth + "px";
    render();
  }));
  propLabelPos.addEventListener("change", onPropChange((ann) => {
    if (ann.type === "box") { ann.labelPos = propLabelPos.value; render(); }
  }));
  propDelete.addEventListener("click", () => {
    if (selectedId != null) deleteAnnotation(selectedId);
  });

  // ── Export ──
  btnDownloadJpg.addEventListener("click", () => exportImage("jpeg"));
  btnDownloadPng.addEventListener("click", () => exportImage("png"));

  function exportImage(format) {
    if (!originalImage) return;
    const scale = 1 / displayScale;

    let sx = 0, sy = 0, sw = originalImage.naturalWidth, sh = originalImage.naturalHeight;
    if (cropRect) {
      sx = cropRect.x * scale; sy = cropRect.y * scale;
      sw = cropRect.w * scale; sh = cropRect.h * scale;
    }

    const offscreen = document.createElement("canvas");
    offscreen.width = sw;
    offscreen.height = sh;
    const octx = offscreen.getContext("2d", { colorSpace: "srgb" });

    octx.filter = `brightness(${brightness}%) contrast(${contrast}%)`;
    octx.drawImage(originalImage, sx, sy, sw, sh, 0, 0, sw, sh);
    octx.filter = "none";

    for (const ann of annotations) {
      octx.save();
      octx.strokeStyle = ann.color;
      octx.fillStyle = ann.color;
      octx.lineWidth = (ann.lineWidth || 0) * scale;

      if (ann.type === "text") {
        exportText(octx, ann, scale, sx, sy);
      } else if (ann.type === "box") {
        exportBox(octx, ann, scale, sx, sy);
      } else if (ann.type === "arrow") {
        exportArrow(octx, ann, scale, sx, sy);
      }
      octx.restore();
    }

    const ext = format === "png" ? "png" : "jpg";
    const mime = format === "png" ? "image/png" : "image/jpeg";
    offscreen.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${originalFileName}-tagit.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    }, mime, format === "png" ? undefined : 0.92);
  }

  function exportText(octx, ann, scale, sx, sy) {
    if (!ann.label) return;
    const fs = ann.fontSize * scale;
    octx.font = `${fs}px sans-serif`;
    octx.fillStyle = ann.labelColor || ann.color;
    octx.textBaseline = "top";
    octx.fillText(ann.label, ann.x * scale - sx, ann.y * scale - sy);
  }

  function exportBox(octx, ann, scale, sx, sy) {
    const bx = ann.x * scale - sx, by = ann.y * scale - sy;
    const bw = ann.w * scale, bh = ann.h * scale;
    octx.strokeRect(bx, by, bw, bh);

    if (!ann.label) return;
    const fs = ann.fontSize * scale;
    octx.font = `${fs}px sans-serif`;
    const textW = octx.measureText(ann.label).width;
    // Reuse shared position logic — pass a scaled-coords annotation
    const pos = getBoxLabelPos({ x: 0, y: 0, w: bw, h: bh, labelPos: ann.labelPos }, fs, textW);
    octx.fillStyle = ann.labelColor || ann.color;
    octx.textBaseline = "top";
    octx.fillText(ann.label, bx + pos.x, by + pos.y);
  }

  function exportArrow(octx, ann, scale, sx, sy) {
    const ax1 = ann.x1 * scale - sx, ay1 = ann.y1 * scale - sy;
    const ax2 = ann.x2 * scale - sx, ay2 = ann.y2 * scale - sy;

    octx.beginPath();
    octx.moveTo(ax1, ay1);
    octx.lineTo(ax2, ay2);
    octx.stroke();

    if (ann.showHead !== false) {
      const headLen = (10 + ann.lineWidth * 2) * scale;
      const angle = Math.atan2(ay2 - ay1, ax2 - ax1);
      octx.beginPath();
      octx.moveTo(ax2, ay2);
      octx.lineTo(ax2 - headLen * Math.cos(angle - Math.PI / 6), ay2 - headLen * Math.sin(angle - Math.PI / 6));
      octx.lineTo(ax2 - headLen * Math.cos(angle + Math.PI / 6), ay2 - headLen * Math.sin(angle + Math.PI / 6));
      octx.closePath();
      octx.fill();
    }

    if (!ann.label) return;
    const fs = ann.fontSize * scale;
    octx.font = `${fs}px sans-serif`;
    const textW = octx.measureText(ann.label).width;
    const pos = getArrowLabelPos(ax1, ay1, ax2, ay2, fs, textW, 6 * scale);
    octx.fillStyle = ann.labelColor || ann.color;
    octx.textBaseline = "top";
    octx.fillText(ann.label, pos.x, pos.y);
  }
})();
