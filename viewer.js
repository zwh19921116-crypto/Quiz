let quizData = null;
let currentIndex = 0;
let score = 0;
let answerChecked = false;

function isDataUrl(value) {
  return /^data:/i.test(String(value || "").trim());
}

function deriveAttachmentName(url) {
  const raw = String(url || "").trim();
  if (!raw) return "Attachment";
  if (isDataUrl(raw)) return "Embedded attachment";

  try {
    const parsed = new URL(raw, window.location.href);
    const segments = parsed.pathname.split("/").filter((item) => item !== "");
    return decodeURIComponent(segments[segments.length - 1] || raw);
  } catch (error) {
    const segments = raw.split("/").filter((item) => item !== "");
    return segments[segments.length - 1] || raw;
  }
}

function normalizeSolutionAttachment(item) {
  if (typeof item === "string") {
    const url = item.trim();
    if (!url) return null;
    return {
      name: deriveAttachmentName(url),
      url,
      embedded: isDataUrl(url)
    };
  }

  if (!item || typeof item !== "object") {
    return null;
  }

  const url = String(item.url || item.href || "").trim();
  if (!url) return null;
  return {
    name: String(item.name || "").trim() || deriveAttachmentName(url),
    url,
    embedded: Boolean(item.embedded) || isDataUrl(url)
  };
}

function normalizeSolutionAttachments(items) {
  if (!Array.isArray(items)) return [];
  return items.map(normalizeSolutionAttachment).filter((item) => item && item.url);
}

function ensureToastHost() {
  let host = document.getElementById("toastStack");
  if (!host) {
    host = document.createElement("div");
    host.id = "toastStack";
    host.className = "toast-stack";
    document.body.appendChild(host);
  }
  return host;
}

function showToast(message, variant = "info") {
  const host = ensureToastHost();
  const toast = document.createElement("div");
  toast.className = `toast ${variant}`;
  toast.textContent = message;
  host.appendChild(toast);
  window.setTimeout(() => {
    toast.classList.add("fade-out");
    window.setTimeout(() => {
      toast.remove();
    }, 220);
  }, 2200);
}

function normalizeQuestion(item) {
  const options = Array.isArray(item.options) ? item.options.filter((opt) => String(opt).trim() !== "") : [];
  const resultType = normalizeResultType(item.resultType);

  const normalized = {
    question: item.question || "Untitled Question",
    resultType,
    options,
    correctAnswer: item.correctAnswer,
    notesAttachments: Array.isArray(item.notesAttachments) ? item.notesAttachments : [],
    solutionAttachments: normalizeSolutionAttachments(item.solutionAttachments),
    image: item.image || "",
    solution: item.solution || ""
  };

  if (item.interactiveApp) {
    normalized.interactiveApp = item.interactiveApp;
  }

  return normalized;
}

function normalizeResultType(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");

  if (!normalized) return "multiple-choice";
  if (["multiple-choice", "multiplechoice", "mcq"].includes(normalized)) return "multiple-choice";
  if (["short-answer", "shortanswer", "short"].includes(normalized)) return "short-answer";
  if (["true-false", "truefalse", "boolean"].includes(normalized)) return "true-false";
  if (["checkbox", "multi-select", "multiselect"].includes(normalized)) return "checkbox";

  return "multiple-choice";
}

function resetRuntimeForLoadedQuiz() {
  currentIndex = 0;
  score = 0;
  answerChecked = false;
  document.getElementById("checkAnswerBtn").style.display = "inline-block";
  document.getElementById("nextQuestionBtn").style.display = "inline-block";
  document.getElementById("notesViewerBtn").style.display = "inline-block";
  document.getElementById("showSolutionBtn").classList.add("hidden");
  document.getElementById("resultBox").textContent = "";
  document.getElementById("resultBox").className = "";
  closeSolutionModal();
}

function applySingleQuiz(quiz) {
  quizData = quiz;

  resetRuntimeForLoadedQuiz();
  document.getElementById("quizTitle").textContent = quiz.title || "Quiz Viewer";

  if (!Array.isArray(quiz.questions) || quiz.questions.length === 0) {
    document.getElementById("quizContainer").innerHTML = "<p>This quiz has no questions yet.</p>";
    document.getElementById("checkAnswerBtn").style.display = "none";
    document.getElementById("nextQuestionBtn").style.display = "none";
    document.getElementById("notesViewerBtn").style.display = "none";
    document.getElementById("notesViewerPanel").classList.add("hidden");
    document.getElementById("progressText").textContent = "Question 0 of 0";
    document.getElementById("scoreText").textContent = "Score: 0";
    document.getElementById("viewerProgressFill").style.width = "0%";
    return;
  }

  renderQuestion();
}

function getRequestedFile() {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("file");
  return requested ? requested.trim() : "quiz-database.json";
}

function setError(message) {
  document.getElementById("quizContainer").innerHTML = `<p>${message}</p>`;
  document.getElementById("checkAnswerBtn").style.display = "none";
  document.getElementById("nextQuestionBtn").style.display = "none";
  document.getElementById("notesViewerBtn").style.display = "none";
}

function splitPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter((item) => item !== "");
}

function parseQuizPayload(rawData) {
  return {
    title: rawData.title || "Quiz Viewer",
    questions: Array.isArray(rawData.questions) ? rawData.questions.map(normalizeQuestion) : []
  };
}

async function loadQuizFromLocalHandle(requestedFile) {
  if (typeof window.showDirectoryPicker !== "function") {
    throw new Error("Local file access is not supported in this browser.");
  }

  const rootHandle = await window.showDirectoryPicker({ mode: "read" });
  const segments = splitPath(requestedFile);
  if (segments.length === 0) {
    throw new Error("Invalid quiz path.");
  }

  const fileName = segments.pop();
  let directoryHandle = rootHandle;

  for (const segment of segments) {
    directoryHandle = await directoryHandle.getDirectoryHandle(segment, { create: false });
  }

  const fileHandle = await directoryHandle.getFileHandle(fileName, { create: false });
  const file = await fileHandle.getFile();
  const text = await file.text();
  return JSON.parse(text);
}

function updateHeader() {
  const total = quizData.questions.length;
  const done = currentIndex;
  const progress = total === 0 ? 0 : Math.max(0, Math.min(100, Math.round((done / total) * 100)));

  document.getElementById("progressText").textContent = `Question ${currentIndex + 1} of ${total}`;
  document.getElementById("scoreText").textContent = `Score: ${score}`;
  document.getElementById("viewerProgressFill").style.width = `${progress}%`;
}

function getExpectedAnswers(question) {
  const raw = question.correctAnswer;

  if (Array.isArray(raw)) {
    return raw.map((item) => String(item).trim()).filter((item) => item !== "");
  }

  if (Number.isInteger(raw) && question.options[raw]) {
    return [String(question.options[raw]).trim()];
  }

  if (typeof raw === "string") {
    if (question.resultType === "checkbox") {
      return raw.split(",").map((item) => item.trim()).filter((item) => item !== "");
    }
    return [raw.trim()].filter((item) => item !== "");
  }

  return [];
}

function norm(text) {
  return String(text || "").trim().toLowerCase();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ── Interactive App renderer ───────────────────────────────────────────────
function safeInteractiveColor(value, fallback = "#2563eb") {
  return /^#[0-9a-fA-F]{3,6}$/.test(String(value || "").trim()) ? String(value).trim() : fallback;
}

function buildNumberLineSvgString(config) {
  const min = Number(config.min ?? -10);
  const max = Number(config.max ?? 10);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) return "";
  const points = Array.isArray(config.points) ? config.points : [];
  const arrows = Array.isArray(config.arrows) ? config.arrows : [];
  const svgW = 600;
  const svgH = 130;
  const padX = 50;
  const lineY = 75;
  const tickH = 10;
  const usable = svgW - padX * 2;
  const xPos = (val) => padX + ((val - min) / (max - min)) * usable;
  const parts = [];
  parts.push('<defs><marker id="nl-arr" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="#f59e0b"/></marker></defs>');
  parts.push(`<line x1="${padX - 12}" y1="${lineY}" x2="${svgW - padX + 12}" y2="${lineY}" stroke="#334155" stroke-width="2"/>`);
  parts.push(`<polygon points="${padX - 22},${lineY} ${padX - 12},${lineY - 5} ${padX - 12},${lineY + 5}" fill="#334155"/>`);
  parts.push(`<polygon points="${svgW - padX + 22},${lineY} ${svgW - padX + 12},${lineY - 5} ${svgW - padX + 12},${lineY + 5}" fill="#334155"/>`);

  const range = max - min;
  let step = 1;
  if (range > 40) step = 5;
  else if (range > 20) step = 2;

  for (let i = min; i <= max; i += step) {
    const x = xPos(i);
    const isZero = i === 0;
    parts.push(`<line x1="${x}" y1="${lineY - tickH}" x2="${x}" y2="${lineY + tickH}" stroke="#334155" stroke-width="${isZero ? 2 : 1}"/>`);
    parts.push(`<text x="${x}" y="${lineY + 26}" text-anchor="middle" font-size="12" fill="${isZero ? "#1e293b" : "#64748b"}" font-weight="${isZero ? "bold" : "normal"}">${i}</text>`);
  }

  arrows.forEach((arrow) => {
    const fx = xPos(Number(arrow.from));
    const tx = xPos(Number(arrow.to));
    if (![fx, tx].every(Number.isFinite)) return;
    const mx = (fx + tx) / 2;
    const peak = lineY - 38;
    const label = escapeHtml(String(arrow.label || ""));
    parts.push(`<path d="M ${fx} ${lineY - 10} Q ${mx} ${peak} ${tx} ${lineY - 10}" stroke="#f59e0b" stroke-width="2" fill="none" marker-end="url(#nl-arr)"/>`);
    if (label) parts.push(`<text x="${mx}" y="${peak - 6}" text-anchor="middle" font-size="12" fill="#b45309" font-weight="bold">${label}</text>`);
  });

  points.forEach((point) => {
    const x = xPos(Number(point.value));
    if (!Number.isFinite(x)) return;
    const color = safeInteractiveColor(point.color, "#2563eb");
    const label = escapeHtml(String(point.label || ""));
    parts.push(`<circle cx="${x}" cy="${lineY}" r="8" fill="${color}" stroke="white" stroke-width="2"/>`);
    if (label) parts.push(`<text x="${x}" y="${lineY - 16}" text-anchor="middle" font-size="11" fill="${color}" font-weight="bold">${label}</text>`);
  });

  return `<div class="nl-container"><svg viewBox="0 0 ${svgW} ${svgH}" width="100%" preserveAspectRatio="xMidYMid meet">${parts.join("")}</svg></div>`;
}

function buildCartesianPlaneSvgString(config) {
  const xMin = Number(config.xMin ?? -10);
  const xMax = Number(config.xMax ?? 10);
  const yMin = Number(config.yMin ?? -10);
  const yMax = Number(config.yMax ?? 10);
  if (![xMin, xMax, yMin, yMax].every(Number.isFinite) || xMin >= xMax || yMin >= yMax) return "";
  const points = Array.isArray(config.points) ? config.points : [];
  const segments = Array.isArray(config.segments) ? config.segments : [];
  const size = 320;
  const pad = 36;
  const usable = size - pad * 2;
  const xPos = (x) => pad + ((x - xMin) / (xMax - xMin)) * usable;
  const yPos = (y) => size - pad - ((y - yMin) / (yMax - yMin)) * usable;
  const axisX = xMin <= 0 && xMax >= 0 ? xPos(0) : null;
  const axisY = yMin <= 0 && yMax >= 0 ? yPos(0) : null;
  const parts = [];
  const xRange = xMax - xMin;
  const yRange = yMax - yMin;
  let xStep = 1;
  let yStep = 1;
  if (xRange > 20) xStep = xRange > 40 ? 5 : 2;
  if (yRange > 20) yStep = yRange > 40 ? 5 : 2;

  for (let x = xMin; x <= xMax; x += xStep) {
    const xCoord = xPos(x);
    parts.push(`<line x1="${xCoord}" y1="${pad}" x2="${xCoord}" y2="${size - pad}" stroke="#dbe6f3" stroke-width="1"/>`);
    parts.push(`<text x="${xCoord}" y="${size - pad + 18}" text-anchor="middle" font-size="11" fill="#64748b">${x}</text>`);
  }
  for (let y = yMin; y <= yMax; y += yStep) {
    const yCoord = yPos(y);
    parts.push(`<line x1="${pad}" y1="${yCoord}" x2="${size - pad}" y2="${yCoord}" stroke="#dbe6f3" stroke-width="1"/>`);
    parts.push(`<text x="${pad - 10}" y="${yCoord + 4}" text-anchor="end" font-size="11" fill="#64748b">${y}</text>`);
  }
  if (axisX !== null) parts.push(`<line x1="${axisX}" y1="${pad - 6}" x2="${axisX}" y2="${size - pad + 6}" stroke="#334155" stroke-width="2"/>`);
  if (axisY !== null) parts.push(`<line x1="${pad - 6}" y1="${axisY}" x2="${size - pad + 6}" y2="${axisY}" stroke="#334155" stroke-width="2"/>`);

  segments.forEach((segment) => {
    const x1 = xPos(Number(segment.x1));
    const y1 = yPos(Number(segment.y1));
    const x2 = xPos(Number(segment.x2));
    const y2 = yPos(Number(segment.y2));
    if (![x1, y1, x2, y2].every(Number.isFinite)) return;
    const color = safeInteractiveColor(segment.color, "#f59e0b");
    const label = escapeHtml(String(segment.label || ""));
    parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`);
    if (label) parts.push(`<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 8}" text-anchor="middle" font-size="11" fill="${color}" font-weight="bold">${label}</text>`);
  });

  points.forEach((point) => {
    const x = xPos(Number(point.x));
    const y = yPos(Number(point.y));
    if (![x, y].every(Number.isFinite)) return;
    const color = safeInteractiveColor(point.color, "#2563eb");
    const label = escapeHtml(String(point.label || ""));
    parts.push(`<circle cx="${x}" cy="${y}" r="6" fill="${color}" stroke="white" stroke-width="2"/>`);
    if (label) parts.push(`<text x="${x + 10}" y="${y - 10}" font-size="11" fill="${color}" font-weight="bold">${label}</text>`);
  });

  return `<div class="cartesian-container"><svg viewBox="0 0 ${size} ${size}" width="100%" preserveAspectRatio="xMidYMid meet">${parts.join("")}</svg></div>`;
}

function buildStemLeafMarkup(config) {
  const values = Array.isArray(config.values) ? config.values.slice() : [];
  const stemUnit = Math.max(1, Number.parseInt(config.stemUnit, 10) || 10);
  if (values.length === 0) return "";
  const grouped = new Map();
  values.sort((a, b) => a - b).forEach((value) => {
    const stem = Math.trunc(value / stemUnit);
    const leaf = Math.abs(value - stem * stemUnit);
    if (!grouped.has(stem)) grouped.set(stem, []);
    grouped.get(stem).push(leaf);
  });
  const rows = Array.from(grouped.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([stem, leaves]) => `<tr><th>${stem}</th><td>${leaves.join(" ")}</td></tr>`)
    .join("");
  return `
    <div class="stem-leaf-container">
      <div class="stem-leaf-key">Key: ${stemUnit === 10 ? "2 | 5 = 25" : `stem × ${stemUnit} + leaf`}</div>
      <table class="stem-leaf-table">
        <thead><tr><th>Stem</th><th>Leaves</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function buildPythagorasMarkup(config) {
  const sideA = escapeHtml(config.sideA || "?");
  const sideB = escapeHtml(config.sideB || "?");
  const sideC = escapeHtml(config.sideC || "?");
  const caption = escapeHtml(config.caption || "Use a² + b² = c²");
  return `
    <div class="triangle-demo-card">
      <svg viewBox="0 0 320 240" width="100%" preserveAspectRatio="xMidYMid meet">
        <polygon points="60,200 60,70 250,200" fill="#eff6ff" stroke="#1d4ed8" stroke-width="3"/>
        <polyline points="60,200 84,200 84,176 60,176" fill="none" stroke="#334155" stroke-width="2"/>
        <text x="42" y="142" font-size="14" fill="#1e3a8a" font-weight="bold">a = ${sideA}</text>
        <text x="140" y="220" font-size="14" fill="#1e3a8a" font-weight="bold">b = ${sideB}</text>
        <text x="168" y="124" font-size="14" fill="#b45309" font-weight="bold">c = ${sideC}</text>
      </svg>
      <p class="triangle-demo-caption">${caption}</p>
    </div>
  `;
}

function buildTrigSummary(config) {
  const focusFunction = ["sin", "cos", "tan"].includes(config.focusFunction) ? config.focusFunction : "sin";
  const opposite = String(config.opposite || "?").trim() || "?";
  const adjacent = String(config.adjacent || "?").trim() || "?";
  const hypotenuse = String(config.hypotenuse || "?").trim() || "?";
  const numMap = { sin: opposite, cos: adjacent, tan: opposite };
  const denMap = { sin: hypotenuse, cos: hypotenuse, tan: adjacent };
  const numericNum = Number.parseFloat(numMap[focusFunction]);
  const numericDen = Number.parseFloat(denMap[focusFunction]);
  const approx = Number.isFinite(numericNum) && Number.isFinite(numericDen) && numericDen !== 0
    ? ` ≈ ${(numericNum / numericDen).toFixed(3)}`
    : "";
  return `${focusFunction} θ = ${numMap[focusFunction]} / ${denMap[focusFunction]}${approx}`;
}

function buildTrigonometryMarkup(config) {
  const angleDeg = Number.parseFloat(config.angleDeg);
  const angleLabel = Number.isFinite(angleDeg) ? `${angleDeg}°` : "θ";
  const opposite = escapeHtml(config.opposite || "?");
  const adjacent = escapeHtml(config.adjacent || "?");
  const hypotenuse = escapeHtml(config.hypotenuse || "?");
  const summary = escapeHtml(buildTrigSummary(config));
  return `
    <div class="triangle-demo-card">
      <svg viewBox="0 0 320 240" width="100%" preserveAspectRatio="xMidYMid meet">
        <polygon points="60,200 220,200 220,80" fill="#f0fdf4" stroke="#15803d" stroke-width="3"/>
        <polyline points="220,200 196,200 196,176 220,176" fill="none" stroke="#334155" stroke-width="2"/>
        <path d="M 90 200 A 30 30 0 0 0 84 183" fill="none" stroke="#dc2626" stroke-width="2"/>
        <text x="86" y="186" font-size="13" fill="#dc2626" font-weight="bold">${escapeHtml(angleLabel)}</text>
        <text x="124" y="220" font-size="14" fill="#166534" font-weight="bold">adj = ${adjacent}</text>
        <text x="234" y="146" font-size="14" fill="#166534" font-weight="bold">opp = ${opposite}</text>
        <text x="146" y="128" font-size="14" fill="#b45309" font-weight="bold">hyp = ${hypotenuse}</text>
      </svg>
      <p class="triangle-demo-caption">${summary}</p>
    </div>
  `;
}

function cloneInteractiveApp(app) {
  if (!app) return null;
  try {
    return JSON.parse(JSON.stringify(app));
  } catch (error) {
    return null;
  }
}

function getInteractiveAppTitle(type) {
  if (type === "number-line") return "Interactive: Number Line";
  if (type === "cartesian-plane") return "Interactive: Cartesian Plane";
  if (type === "stem-and-leaf") return "Interactive: Stem-and-Leaf Plot";
  if (type === "pythagoras") return "Interactive: Pythagoras Triangle";
  if (type === "trigonometry") return "Interactive: Trigonometry Triangle";
  return "Interactive Math";
}

function updateInteractivePreview(preview, app) {
  if (!preview || !app || !app.type) return;

  let content = "";
  if (app.type === "number-line") {
    content = buildNumberLineSvgString(app.config || {});
  } else if (app.type === "cartesian-plane") {
    content = buildCartesianPlaneSvgString(app.config || {});
  } else if (app.type === "stem-and-leaf") {
    content = buildStemLeafMarkup(app.config || {});
  } else if (app.type === "pythagoras") {
    content = buildPythagorasMarkup(app.config || {});
  } else if (app.type === "trigonometry") {
    content = buildTrigonometryMarkup(app.config || {});
  }

  preview.innerHTML = content || "<p class='helper-text'>No interactive preview available.</p>";
}

function renderInteractiveDetails(host, lines) {
  const detailHost = host.querySelector(".interactive-app-details");
  if (!detailHost) return;
  const items = Array.isArray(lines) ? lines.filter((line) => String(line || "").trim() !== "") : [];
  if (items.length === 0) {
    detailHost.innerHTML = "<p class='helper-text'>No current interaction details.</p>";
    return;
  }
  detailHost.innerHTML = items.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
}

function buildNumberLineDetailLines(app) {
  const config = app.config || {};
  const points = Array.isArray(config.points) ? config.points : [];
  const arrows = Array.isArray(config.arrows) ? config.arrows : [];
  const pointSummary = points.length > 0
    ? `Selected points: ${points.map((point, index) => `${point.label || `Point ${index + 1}`} = ${point.value}`).join(", ")}`
    : "Selected points: none";
  const arrowSummary = arrows.length > 0
    ? `Configured jumps: ${arrows.map((arrow) => `${arrow.from} to ${arrow.to}${arrow.label ? ` (${arrow.label})` : ""}`).join(" | ")}`
    : "Configured jumps: none";
  return [pointSummary, arrowSummary, `Visible range: ${config.min} to ${config.max}`];
}

function buildCartesianDetailLines(app) {
  const config = app.config || {};
  const points = Array.isArray(config.points) ? config.points : [];
  const segments = Array.isArray(config.segments) ? config.segments : [];
  const pointSummary = points.length > 0
    ? `Current coordinates: ${points.map((point, index) => `${point.label || `Point ${index + 1}`} (${point.x}, ${point.y})`).join(", ")}`
    : "Current coordinates: none";
  const segmentSummary = segments.length > 0
    ? `Reference segments: ${segments.map((segment) => `${segment.label || "segment"} [(${segment.x1}, ${segment.y1}) to (${segment.x2}, ${segment.y2})]`).join(" | ")}`
    : "Reference segments: none";
  return [pointSummary, segmentSummary, `Axes range: x ${config.xMin} to ${config.xMax}, y ${config.yMin} to ${config.yMax}`];
}

function buildStemLeafDetailLines(app) {
  const config = app.config || {};
  const values = Array.isArray(config.values) ? config.values.slice().sort((a, b) => a - b) : [];
  return [
    `Current values: ${values.length > 0 ? values.join(", ") : "none"}`,
    `Stem unit: ${config.stemUnit || 10}`,
    `Value count: ${values.length}`
  ];
}

function buildPythagorasDetailLines(app) {
  const config = app.config || {};
  return [
    `Current triangle: a = ${config.sideA || "?"}, b = ${config.sideB || "?"}, c = ${config.sideC || "?"}`,
    `Equation shown: (${config.sideA || "a"})^2 + (${config.sideB || "b"})^2 = (${config.sideC || "c"})^2`,
    `Caption: ${config.caption || "Use a² + b² = c²"}`
  ];
}

function buildTrigonometryDetailLines(app) {
  const config = app.config || {};
  return [
    `Selected angle: ${config.angleDeg || 35}°`,
    `Selected sides: opposite = ${config.opposite || "?"}, adjacent = ${config.adjacent || "?"}, hypotenuse = ${config.hypotenuse || "?"}`,
    `Focus ratio: ${buildTrigSummary(config)}`
  ];
}

function updateInteractiveDetails(host, app) {
  if (!host || !app || !app.type) return;
  let lines = [];
  if (app.type === "number-line") {
    lines = buildNumberLineDetailLines(app);
  } else if (app.type === "cartesian-plane") {
    lines = buildCartesianDetailLines(app);
  } else if (app.type === "stem-and-leaf") {
    lines = buildStemLeafDetailLines(app);
  } else if (app.type === "pythagoras") {
    lines = buildPythagorasDetailLines(app);
  } else if (app.type === "trigonometry") {
    lines = buildTrigonometryDetailLines(app);
  }
  renderInteractiveDetails(host, lines);
}

function mountNumberLineInteractive(host, app) {
  const config = app.config || {};
  const points = Array.isArray(config.points) ? config.points : [];
  const min = Number.isFinite(Number(config.min)) ? Number(config.min) : -10;
  const max = Number.isFinite(Number(config.max)) ? Number(config.max) : 10;

  const controls = points.length > 0
    ? points.map((point, index) => `
      <label class="interactive-control-row">
        <span>${escapeHtml(point.label || `Point ${index + 1}`)}</span>
        <input type="range" min="${min}" max="${max}" step="1" value="${Number(point.value) || 0}" data-role="point-range" data-index="${index}" />
        <input type="number" min="${min}" max="${max}" step="1" value="${Number(point.value) || 0}" data-role="point-number" data-index="${index}" />
      </label>
    `).join("")
    : "<p class='helper-text'>No points configured for this number line.</p>";

  host.innerHTML = `
    <div class="interactive-app-preview"></div>
    <div class="interactive-app-controls">${controls}</div>
    <div class="interactive-app-details"></div>
  `;

  const preview = host.querySelector(".interactive-app-preview");
  const sync = (index, value) => {
    if (!points[index]) return;
    const next = Math.max(min, Math.min(max, Number(value)));
    points[index].value = next;
    host.querySelectorAll(`[data-index="${index}"]`).forEach((input) => {
      input.value = String(next);
    });
    updateInteractivePreview(preview, app);
    updateInteractiveDetails(host, app);
  };

  host.querySelectorAll("[data-role='point-range']").forEach((input) => {
    input.addEventListener("input", () => sync(Number(input.dataset.index), input.value));
  });
  host.querySelectorAll("[data-role='point-number']").forEach((input) => {
    input.addEventListener("input", () => sync(Number(input.dataset.index), input.value));
  });

  updateInteractivePreview(preview, app);
  updateInteractiveDetails(host, app);
}

function mountCartesianInteractive(host, app) {
  const config = app.config || {};
  const points = Array.isArray(config.points) ? config.points : [];
  const xMin = Number.isFinite(Number(config.xMin)) ? Number(config.xMin) : -10;
  const xMax = Number.isFinite(Number(config.xMax)) ? Number(config.xMax) : 10;
  const yMin = Number.isFinite(Number(config.yMin)) ? Number(config.yMin) : -10;
  const yMax = Number.isFinite(Number(config.yMax)) ? Number(config.yMax) : 10;

  const controls = points.length > 0
    ? points.map((point, index) => `
      <div class="interactive-control-grid">
        <div class="interactive-control-label">${escapeHtml(point.label || `Point ${index + 1}`)}</div>
        <label class="interactive-control-row compact">
          <span>X</span>
          <input type="number" min="${xMin}" max="${xMax}" step="1" value="${Number(point.x) || 0}" data-role="cartesian-x" data-index="${index}" />
        </label>
        <label class="interactive-control-row compact">
          <span>Y</span>
          <input type="number" min="${yMin}" max="${yMax}" step="1" value="${Number(point.y) || 0}" data-role="cartesian-y" data-index="${index}" />
        </label>
      </div>
    `).join("")
    : "<p class='helper-text'>No points configured for this plane.</p>";

  host.innerHTML = `
    <div class="interactive-app-preview"></div>
    <div class="interactive-app-controls">${controls}</div>
    <div class="interactive-app-details"></div>
  `;

  const preview = host.querySelector(".interactive-app-preview");
  const sync = (index, axis, value) => {
    if (!points[index]) return;
    const min = axis === "x" ? xMin : yMin;
    const max = axis === "x" ? xMax : yMax;
    const next = Math.max(min, Math.min(max, Number(value)));
    points[index][axis] = next;
    const selector = axis === "x" ? "cartesian-x" : "cartesian-y";
    const control = host.querySelector(`[data-role='${selector}'][data-index='${index}']`);
    if (control) control.value = String(next);
    updateInteractivePreview(preview, app);
    updateInteractiveDetails(host, app);
  };

  host.querySelectorAll("[data-role='cartesian-x']").forEach((input) => {
    input.addEventListener("input", () => sync(Number(input.dataset.index), "x", input.value));
  });
  host.querySelectorAll("[data-role='cartesian-y']").forEach((input) => {
    input.addEventListener("input", () => sync(Number(input.dataset.index), "y", input.value));
  });

  updateInteractivePreview(preview, app);
  updateInteractiveDetails(host, app);
}

function mountStemLeafInteractive(host, app) {
  const config = app.config || {};
  const values = Array.isArray(config.values) ? config.values : [];
  host.innerHTML = `
    <div class="interactive-app-preview"></div>
    <div class="interactive-app-controls">
      <label class="interactive-control-stack">
        <span>Values</span>
        <textarea rows="3" data-role="stem-values">${escapeHtml(values.join(", "))}</textarea>
      </label>
      <label class="interactive-control-row">
        <span>Stem Unit</span>
        <input type="number" min="1" step="1" value="${Number(config.stemUnit) || 10}" data-role="stem-unit" />
      </label>
    </div>
    <div class="interactive-app-details"></div>
  `;

  const preview = host.querySelector(".interactive-app-preview");
  const valuesInput = host.querySelector("[data-role='stem-values']");
  const unitInput = host.querySelector("[data-role='stem-unit']");
  const rerender = () => {
    config.values = String(valuesInput.value || "")
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter((item) => item !== "")
      .map((item) => Number.parseFloat(item))
      .filter((item) => Number.isFinite(item));
    config.stemUnit = Math.max(1, Number.parseInt(unitInput.value, 10) || 10);
    unitInput.value = String(config.stemUnit);
    updateInteractivePreview(preview, app);
    updateInteractiveDetails(host, app);
  };

  valuesInput.addEventListener("input", rerender);
  unitInput.addEventListener("input", rerender);
  updateInteractivePreview(preview, app);
  updateInteractiveDetails(host, app);
}

function mountPythagorasInteractive(host, app) {
  const config = app.config || {};
  host.innerHTML = `
    <div class="interactive-app-preview"></div>
    <div class="interactive-app-controls interactive-three-col">
      <label class="interactive-control-row compact"><span>a</span><input type="text" value="${escapeHtml(config.sideA || "")}" data-role="py-a" /></label>
      <label class="interactive-control-row compact"><span>b</span><input type="text" value="${escapeHtml(config.sideB || "")}" data-role="py-b" /></label>
      <label class="interactive-control-row compact"><span>c</span><input type="text" value="${escapeHtml(config.sideC || "")}" data-role="py-c" /></label>
      <label class="interactive-control-stack full-width"><span>Caption</span><input type="text" value="${escapeHtml(config.caption || "")}" data-role="py-caption" /></label>
    </div>
    <div class="interactive-app-details"></div>
  `;

  const preview = host.querySelector(".interactive-app-preview");
  const rerender = () => {
    config.sideA = host.querySelector("[data-role='py-a']").value.trim();
    config.sideB = host.querySelector("[data-role='py-b']").value.trim();
    config.sideC = host.querySelector("[data-role='py-c']").value.trim();
    config.caption = host.querySelector("[data-role='py-caption']").value.trim();
    updateInteractivePreview(preview, app);
    updateInteractiveDetails(host, app);
  };

  host.querySelectorAll("input").forEach((input) => input.addEventListener("input", rerender));
  updateInteractivePreview(preview, app);
  updateInteractiveDetails(host, app);
}

function mountTrigonometryInteractive(host, app) {
  const config = app.config || {};
  const angle = Number.isFinite(Number(config.angleDeg)) ? Number(config.angleDeg) : 35;
  host.innerHTML = `
    <div class="interactive-app-preview"></div>
    <div class="interactive-app-controls interactive-three-col">
      <label class="interactive-control-row compact"><span>Angle</span><input type="range" min="1" max="89" step="1" value="${angle}" data-role="trig-angle-range" /></label>
      <label class="interactive-control-row compact"><span>Angle</span><input type="number" min="1" max="89" step="1" value="${angle}" data-role="trig-angle-number" /></label>
      <label class="interactive-control-row compact"><span>Focus</span><select data-role="trig-focus"><option value="sin" ${config.focusFunction === "sin" ? "selected" : ""}>sin</option><option value="cos" ${config.focusFunction === "cos" ? "selected" : ""}>cos</option><option value="tan" ${config.focusFunction === "tan" ? "selected" : ""}>tan</option></select></label>
      <label class="interactive-control-row compact"><span>Opp</span><input type="text" value="${escapeHtml(config.opposite || "")}" data-role="trig-opp" /></label>
      <label class="interactive-control-row compact"><span>Adj</span><input type="text" value="${escapeHtml(config.adjacent || "")}" data-role="trig-adj" /></label>
      <label class="interactive-control-row compact"><span>Hyp</span><input type="text" value="${escapeHtml(config.hypotenuse || "")}" data-role="trig-hyp" /></label>
    </div>
    <div class="interactive-app-details"></div>
  `;

  const preview = host.querySelector(".interactive-app-preview");
  const rerender = () => {
    const nextAngle = Math.max(1, Math.min(89, Number(host.querySelector("[data-role='trig-angle-number']").value) || 35));
    config.angleDeg = nextAngle;
    host.querySelector("[data-role='trig-angle-range']").value = String(nextAngle);
    host.querySelector("[data-role='trig-angle-number']").value = String(nextAngle);
    config.focusFunction = host.querySelector("[data-role='trig-focus']").value;
    config.opposite = host.querySelector("[data-role='trig-opp']").value.trim();
    config.adjacent = host.querySelector("[data-role='trig-adj']").value.trim();
    config.hypotenuse = host.querySelector("[data-role='trig-hyp']").value.trim();
    updateInteractivePreview(preview, app);
    updateInteractiveDetails(host, app);
  };

  host.querySelectorAll("input, select").forEach((input) => input.addEventListener("input", rerender));
  updateInteractivePreview(preview, app);
  updateInteractiveDetails(host, app);
}

function mountInteractiveApp(host, app) {
  if (!host || !app || !app.type) return;

  if (app.type === "number-line") {
    mountNumberLineInteractive(host, app);
    return;
  }
  if (app.type === "cartesian-plane") {
    mountCartesianInteractive(host, app);
    return;
  }
  if (app.type === "stem-and-leaf") {
    mountStemLeafInteractive(host, app);
    return;
  }
  if (app.type === "pythagoras") {
    mountPythagorasInteractive(host, app);
    return;
  }
  if (app.type === "trigonometry") {
    mountTrigonometryInteractive(host, app);
  }
}

function buildInteractiveAppMarkup(app) {
  if (!app || !app.type) return "";
  return `<div class="solution-modal-section">
    <p class="solution-modal-label">${getInteractiveAppTitle(app.type)}</p>
    <div class="interactive-app-host"></div>
  </div>`;
}

function wireInteractiveAppModal(modalBody, app) {
  if (!modalBody || !app || !app.type) return;
  const host = modalBody.querySelector(".interactive-app-host");
  if (!host) return;
  mountInteractiveApp(host, cloneInteractiveApp(app));
}
// ── End Interactive App renderer ──────────────────────────────────────────

function extractYoutubeVideoId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();

    if (host === "youtu.be") {
      return parsed.pathname.replace(/^\/+/, "").split("/")[0] || "";
    }

    if (host.endsWith("youtube.com")) {
      const idFromSearch = parsed.searchParams.get("v");
      if (idFromSearch) return idFromSearch;

      const pathParts = parsed.pathname.split("/").filter((item) => item !== "");
      if (["embed", "shorts", "live"].includes(pathParts[0] || "")) {
        return pathParts[1] || "";
      }
    }

    return "";
  } catch (error) {
    return "";
  }
}

function extractGoogleDriveFileId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (!host.includes("drive.google.com")) {
      return "";
    }

    const byQuery = parsed.searchParams.get("id") || "";
    if (byQuery) {
      return byQuery;
    }

    const pathParts = parsed.pathname.split("/").filter((item) => item !== "");
    const fileMarkerIndex = pathParts.indexOf("d");
    if (fileMarkerIndex >= 0 && pathParts[fileMarkerIndex + 1]) {
      return pathParts[fileMarkerIndex + 1];
    }

    return "";
  } catch (error) {
    return "";
  }
}

function isPdfAttachment(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  if (/^data:application\/pdf/i.test(raw)) return true;
  if (extractGoogleDriveFileId(raw)) return true;

  try {
    const parsed = new URL(raw, window.location.href);
    return /\.pdf$/i.test(parsed.pathname);
  } catch (error) {
    return /\.pdf($|\?)/i.test(raw);
  }
}

function getNotesAttachmentLabel(item) {
  const value = String(item || "").trim();
  if (!value) return "Attachment";

  const youtubeId = extractYoutubeVideoId(value);
  if (youtubeId) {
    return `YouTube video (${youtubeId})`;
  }

  if (isPdfAttachment(value)) {
    return value.startsWith("data:") ? "Embedded PDF" : `PDF: ${deriveAttachmentName(value)}`;
  }

  return deriveAttachmentName(value);
}

function isPdfSolutionAttachment(item) {
  if (!item || typeof item !== "object") return false;
  return isPdfAttachment(item.url);
}

function renderPdfAttachmentPreviews(attachments) {
  const pdfAttachments = (attachments || []).filter(isPdfSolutionAttachment);
  if (pdfAttachments.length === 0) {
    return "";
  }

  return `
    <div class="solution-modal-section">
      <p class="solution-modal-label">PDF Preview</p>
      <div class="solution-pdf-list">
        ${pdfAttachments.map((item, index) => `
          <div class="solution-pdf-item">
            <p class="solution-pdf-title">${escapeHtml(item.name || `PDF ${index + 1}`)}</p>
            <iframe
              class="solution-pdf-frame"
              src="${escapeHtml(item.url)}"
              title="${escapeHtml(item.name || `PDF ${index + 1}`)}"
              loading="lazy"
            ></iframe>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function renderAnswerInput(question) {
  if (question.resultType === "short-answer") {
    return `
      <div class="short-answer-box">
        <label for="shortAnswerInput">Your answer</label>
        <input id="shortAnswerInput" type="text" placeholder="Type your answer" autocomplete="off" />
      </div>
    `;
  }

  const type = question.resultType === "checkbox" ? "checkbox" : "radio";
  const inputName = question.resultType === "checkbox" ? "activeQuestionCheck" : "activeQuestion";
  const safeOptions = question.options.length > 0
    ? question.options
    : (question.resultType === "true-false" ? ["True", "False"] : []);

  return `
    <div class="options-list">
      ${safeOptions.map((option, optionIndex) => `
        <label class="option-item">
          <input type="${type}" name="${inputName}" value="${escapeHtml(option)}" data-index="${optionIndex}" />
          <span>${escapeHtml(option)}</span>
        </label>
      `).join("")}
    </div>
  `;
}

function renderNotesPanel(question) {
  const notesBtn = document.getElementById("notesViewerBtn");
  const notesPanel = document.getElementById("notesViewerPanel");
  const items = question.notesAttachments || [];

  if (items.length === 0) {
    notesBtn.style.display = "none";
    notesPanel.classList.add("hidden");
    notesPanel.innerHTML = "";
    return;
  }

  notesBtn.style.display = "inline-block";
  notesBtn.textContent = `Notes: ${items.length}`;
  notesPanel.innerHTML = `
    <ul class="notes-list">
      ${items.map((item) => `<li><a href="${escapeHtml(item)}" target="_blank" rel="noopener noreferrer">${escapeHtml(getNotesAttachmentLabel(item))}</a></li>`).join("")}
    </ul>
  `;
  notesPanel.classList.add("hidden");
}

function syncOptionSelectionState() {
  const optionItems = document.querySelectorAll(".option-item");
  optionItems.forEach((item) => {
    if (!(item instanceof HTMLElement)) return;
    const input = item.querySelector("input");
    if (!(input instanceof HTMLInputElement)) return;
    item.classList.toggle("is-selected", input.checked);
  });
}

function wireOptionSelectionUI(question) {
  if (question.resultType === "short-answer") return;

  const selector = question.resultType === "checkbox"
    ? "input[name='activeQuestionCheck']"
    : "input[name='activeQuestion']";
  const inputs = document.querySelectorAll(selector);
  inputs.forEach((input) => {
    if (!(input instanceof HTMLInputElement)) return;
    input.addEventListener("change", syncOptionSelectionState);
  });
  syncOptionSelectionState();
}

function renderQuestion() {
  const question = quizData.questions[currentIndex];
  const quizContainer = document.getElementById("quizContainer");
  const resultBox = document.getElementById("resultBox");
  const nextBtn = document.getElementById("nextQuestionBtn");
  const showSolutionBtn = document.getElementById("showSolutionBtn");

  answerChecked = false;
  resultBox.textContent = "";
  resultBox.className = "";
  nextBtn.disabled = true;
  showSolutionBtn.classList.add("hidden");
  nextBtn.textContent = currentIndex === quizData.questions.length - 1 ? "Finish Quiz" : "Next Question";
  closeSolutionModal();

  const imageMarkup = question.image
    ? `<img class="question-image" src="${escapeHtml(question.image)}" alt="Question visual" />`
    : "";

  quizContainer.innerHTML = `
    <div class="question-card viewer-question">
      <p class="question-label">Question ${currentIndex + 1}</p>
      <h2>${escapeHtml(question.question)}</h2>
      ${imageMarkup}
      ${renderAnswerInput(question)}
    </div>
  `;

  wireOptionSelectionUI(question);
  renderNotesPanel(question);
  updateHeader();
}

function collectUserAnswer(question) {
  if (question.resultType === "short-answer") {
    const input = document.getElementById("shortAnswerInput");
    return input ? input.value.trim() : "";
  }

  if (question.resultType === "checkbox") {
    return Array.from(document.querySelectorAll("input[name='activeQuestionCheck']:checked"))
      .map((node) => node.value);
  }

  const selected = document.querySelector("input[name='activeQuestion']:checked");
  return selected ? selected.value : "";
}

function answersMatch(question, userAnswer) {
  const expected = getExpectedAnswers(question).map(norm);

  if (question.resultType === "checkbox") {
    const picked = Array.isArray(userAnswer) ? userAnswer.map(norm).filter((x) => x !== "") : [];
    if (picked.length === 0 || expected.length === 0) return false;

    const uniquePicked = Array.from(new Set(picked)).sort();
    const uniqueExpected = Array.from(new Set(expected)).sort();
    return uniquePicked.length === uniqueExpected.length && uniquePicked.every((item, idx) => item === uniqueExpected[idx]);
  }

  const value = norm(userAnswer);
  if (!value || expected.length === 0) return false;
  return expected.includes(value);
}

function validateAnswer(question, userAnswer) {
  if (question.resultType === "checkbox") {
    return Array.isArray(userAnswer) && userAnswer.length > 0;
  }

  return String(userAnswer || "").trim() !== "";
}

function checkAnswer() {
  if (answerChecked) return;

  const question = quizData.questions[currentIndex];
  const userAnswer = collectUserAnswer(question);
  if (!validateAnswer(question, userAnswer)) {
    showToast("Please answer the question before checking.", "warning");
    return;
  }

  const isCorrect = answersMatch(question, userAnswer);
  if (isCorrect) {
    score += 1;
  }

  const expectedAnswers = getExpectedAnswers(question);

  // Visual feedback for selected options
  highlightAnswerFeedback(question, userAnswer, isCorrect, expectedAnswers);

  prepareSolutionModal(question, expectedAnswers);
  document.getElementById("showSolutionBtn").classList.remove("hidden");
  document.getElementById("nextQuestionBtn").disabled = false;
  answerChecked = true;

  updateHeader();
}

function prepareSolutionModal(question, expectedAnswers) {
  const fallback = expectedAnswers.length > 0 ? expectedAnswers.join(question.resultType === "checkbox" ? ", " : "") : "N/A";
  const rawSolution = String(question.solution || "").trim();
  const defaultSolution = `Correct answer: ${fallback}`;
  const hasDistinctSolution = rawSolution !== "" && norm(rawSolution) !== norm(defaultSolution);
  const solutionAttachments = normalizeSolutionAttachments(question.solutionAttachments);
  const modalBody = document.getElementById("solutionModalBody");
  const pdfPreviewsMarkup = renderPdfAttachmentPreviews(solutionAttachments);
  const interactiveAppMarkup = buildInteractiveAppMarkup(question.interactiveApp || null);

  modalBody.innerHTML = `
    <div class="solution-modal-section">
      <p class="solution-modal-label">Correct answer</p>
      <p class="solution-modal-answer">${escapeHtml(fallback)}</p>
    </div>
    ${hasDistinctSolution ? `
      <div class="solution-modal-section">
        <p class="solution-modal-label">Explanation</p>
        <div class="solution-modal-copy">${escapeHtml(rawSolution).replace(/\n/g, "<br>")}</div>
      </div>
    ` : ""}
    ${interactiveAppMarkup}
    ${solutionAttachments.length > 0 ? `
      <div class="solution-modal-section">
        <p class="solution-modal-label">Attachments</p>
        <ul class="solution-attachment-list">
          ${solutionAttachments.map((item) => `<li><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.name)}</a></li>`).join("")}
        </ul>
      </div>
    ` : ""}
    ${pdfPreviewsMarkup}
  `;

  wireInteractiveAppModal(modalBody, question.interactiveApp || null);
}

function openSolutionModal() {
  const modal = document.getElementById("solutionModal");
  if (!modal) return;
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function closeSolutionModal() {
  const modal = document.getElementById("solutionModal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

function highlightAnswerFeedback(question, userAnswer, isCorrect, expectedAnswers) {
  if (question.resultType === "multiple-choice" || question.resultType === "true-false") {
    const options = document.querySelectorAll(".option-item");
    options.forEach((option) => {
      const input = option.querySelector("input");
      if (!input) return;

      const isUserSelected = input.value === userAnswer;
      const isCorrectAnswer = expectedAnswers.includes(input.value);

      if (isUserSelected && isCorrect) {
        option.classList.add("feedback-correct");
        option.classList.remove("feedback-incorrect");
      } else if (isUserSelected && !isCorrect) {
        option.classList.add("feedback-incorrect");
        option.classList.remove("feedback-correct");
      } else if (isCorrectAnswer && !isCorrect) {
        option.classList.add("feedback-correct");
      }
    });
  } else if (question.resultType === "checkbox") {
    const checkboxes = document.querySelectorAll("input[name='activeQuestionCheck']");
    checkboxes.forEach((checkbox) => {
      const option = checkbox.closest(".option-item");
      if (!option) return;

      const isUserSelected = checkbox.checked;
      const isCorrectAnswer = expectedAnswers.includes(checkbox.value);

      if (isUserSelected && isCorrectAnswer) {
        option.classList.add("feedback-correct");
      } else if (isUserSelected && !isCorrectAnswer) {
        option.classList.add("feedback-incorrect");
      } else if (isCorrectAnswer && !isUserSelected) {
        option.classList.add("feedback-correct");
      }
    });
  }
}

function goNext() {
  if (!answerChecked) return;

  if (currentIndex < quizData.questions.length - 1) {
    currentIndex += 1;
    renderQuestion();
    return;
  }

  const total = quizData.questions.length;
  const percent = total === 0 ? 0 : Math.round((score / total) * 100);
  document.getElementById("quizContainer").innerHTML = `
    <div class="question-card viewer-question final-card">
      <h2>Quiz Complete</h2>
      <p>Your final score is ${score} out of ${total} (${percent}%).</p>
      <button class="btn" id="restartBtn">Restart Quiz</button>
    </div>
  `;
  document.getElementById("resultBox").textContent = "";
  document.getElementById("checkAnswerBtn").style.display = "none";
  document.getElementById("nextQuestionBtn").style.display = "none";
  document.getElementById("notesViewerBtn").style.display = "none";
  document.getElementById("showSolutionBtn").classList.add("hidden");
  document.getElementById("notesViewerPanel").classList.add("hidden");
  document.getElementById("notesViewerPanel").innerHTML = "";
  closeSolutionModal();
  document.getElementById("progressText").textContent = "Complete";
  document.getElementById("scoreText").textContent = `Final Score: ${score} / ${total}`;
  document.getElementById("viewerProgressFill").style.width = "100%";

  document.getElementById("restartBtn").addEventListener("click", () => {
    currentIndex = 0;
    score = 0;
    document.getElementById("checkAnswerBtn").style.display = "inline-block";
    document.getElementById("nextQuestionBtn").style.display = "inline-block";
    document.getElementById("notesViewerBtn").style.display = "inline-block";
    document.getElementById("showSolutionBtn").classList.add("hidden");
    renderQuestion();
  });
}

async function loadQuiz() {
  document.getElementById("quizSelectorWrap").classList.add("hidden");

  const requestedFile = getRequestedFile();
  try {
    const response = await fetch(requestedFile, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("load failed");
    }
    const rawData = await response.json();
    const parsedQuiz = parseQuizPayload(rawData);
    applySingleQuiz(parsedQuiz);
  } catch (error) {
    if (window.location.protocol === "file:") {
      try {
        const rawData = await loadQuizFromLocalHandle(requestedFile);
        const parsedQuiz = parseQuizPayload(rawData);
        applySingleQuiz(parsedQuiz);
        showToast("Loaded local quiz after folder selection.", "success");
        return;
      } catch (localError) {
        // Fall through to user-facing error below.
      }
    }

    setError(`Could not load quiz file: ${requestedFile}`);
    return;
  }
}

document.getElementById("checkAnswerBtn").addEventListener("click", checkAnswer);
document.getElementById("showSolutionBtn").addEventListener("click", openSolutionModal);
document.getElementById("nextQuestionBtn").addEventListener("click", goNext);
document.getElementById("notesViewerBtn").addEventListener("click", () => {
  const panel = document.getElementById("notesViewerPanel");
  if (panel.innerHTML.trim() === "") {
    showToast("No notes attachments.", "info");
    return;
  }
  panel.classList.toggle("hidden");
});
document.getElementById("closeSolutionBtn").addEventListener("click", closeSolutionModal);
document.getElementById("solutionModal").addEventListener("click", (event) => {
  const target = event.target;
  if (target instanceof HTMLElement && target.dataset.closeSolution === "true") {
    closeSolutionModal();
  }
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeSolutionModal();
  }
});

window.addEventListener("load", loadQuiz);