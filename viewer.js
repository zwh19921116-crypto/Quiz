let quizData = null;
let currentIndex = 0;
let score = 0;
let answerChecked = false;
let solutionShownForCurrentQuestion = false;
let cartesianPlotUserPoints = [];
const QUIZ_ORDER_MODES = {
  ORDERED: "ordered",
  RANDOM: "random"
};
const ENCOURAGING_INCORRECT_MESSAGES = [
  "Nice effort. You are making progress.",
  "Great work staying focused.",
  "Good effort. You are learning well.",
  "You are building strong understanding.",
  "Solid work. Keep your confidence up.",
  "Thoughtful attempt. Your progress matters.",
  "Great mindset. You are improving steadily.",
  "Well done for staying engaged."
];
let lastEncouragingMessageIndex = -1;

function getRandomEncouragingMessage() {
  const count = ENCOURAGING_INCORRECT_MESSAGES.length;
  if (count === 0) return "Not quite, keep going!";
  if (count === 1) return ENCOURAGING_INCORRECT_MESSAGES[0];

  let index = Math.floor(Math.random() * count);
  if (index === lastEncouragingMessageIndex) {
    index = (index + 1 + Math.floor(Math.random() * (count - 1))) % count;
  }
  lastEncouragingMessageIndex = index;
  return ENCOURAGING_INCORRECT_MESSAGES[index];
}

function buildIncorrectFeedbackMessage() {
  return `${getRandomEncouragingMessage()} Press "Show Solution" to see where you went wrong.`;
}

function buildShortAnswerIncorrectFeedback(expectedAnswers) {
  const fallback = Array.isArray(expectedAnswers) && expectedAnswers.length > 0
    ? expectedAnswers.join(", ")
    : "N/A";
  return {
    correctAnswerText: `Correct answer: ${fallback}`,
    encouragementText: `${getRandomEncouragingMessage()} Press "Show Solution" to see where you went wrong.`
  };
}

function normalizeQuizDescription(value) {
  return String(value || "").trim();
}

function normalizeQuizQuestionOrder(value) {
  return String(value || "").trim().toLowerCase() === QUIZ_ORDER_MODES.RANDOM
    ? QUIZ_ORDER_MODES.RANDOM
    : QUIZ_ORDER_MODES.ORDERED;
}

function normalizeQuizQuestionLimit(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeQuizSettings(value) {
  const settings = value && typeof value === "object" ? value : {};
  return {
    questionOrder: normalizeQuizQuestionOrder(settings.questionOrder),
    questionLimit: normalizeQuizQuestionLimit(settings.questionLimit)
  };
}

function shuffleQuestions(items) {
  const list = Array.isArray(items) ? items.slice() : [];
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function applyQuizSettingsToQuestions(questions, settings) {
  const normalizedSettings = normalizeQuizSettings(settings);
  let next = Array.isArray(questions) ? questions.slice() : [];

  if (normalizedSettings.questionOrder === QUIZ_ORDER_MODES.RANDOM) {
    next = shuffleQuestions(next);
  }

  if (normalizedSettings.questionLimit) {
    next = next.slice(0, normalizedSettings.questionLimit);
  }

  return next;
}

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
  if (["plot", "graph", "graph-plot", "plot-graph"].includes(normalized)) return "plot";
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
  const normalizedSettings = normalizeQuizSettings(quiz.settings);
  const preparedQuestions = applyQuizSettingsToQuestions(quiz.questions || [], normalizedSettings);
  quizData = {
    ...quiz,
    description: normalizeQuizDescription(quiz.description),
    settings: normalizedSettings,
    questions: preparedQuestions
  };

  resetRuntimeForLoadedQuiz();
  document.getElementById("quizTitle").textContent = quizData.title || "Quiz Viewer";

  const quizDescription = document.getElementById("quizDescription");
  if (quizDescription) {
    if (quizData.description) {
      quizDescription.textContent = quizData.description;
      quizDescription.classList.remove("hidden");
    } else {
      quizDescription.textContent = "";
      quizDescription.classList.add("hidden");
    }
  }

  if (!Array.isArray(quizData.questions) || quizData.questions.length === 0) {
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
    description: normalizeQuizDescription(rawData.description),
    settings: normalizeQuizSettings(rawData.settings),
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

function buildCartesianExpressionEvaluator(rawExpression) {
  let expression = String(rawExpression || "").trim();
  if (!expression) return null;
  expression = expression.replace(/^y\s*=\s*/i, "");
  if (!expression) return null;

  if (!/^[0-9a-zA-Z_+\-*/().,\s^%]+$/.test(expression)) {
    return null;
  }

  const lowered = expression.toLowerCase();
  const tokens = lowered.match(/[a-z_]+/g) || [];
  const allowed = new Set(["x", "sin", "cos", "tan", "asin", "acos", "atan", "sqrt", "abs", "log", "ln", "exp", "pow", "pi", "e", "floor", "ceil", "round", "min", "max"]);
  if (!tokens.every((token) => allowed.has(token))) {
    return null;
  }

  let normalized = lowered
    .replace(/\^/g, "**")
    .replace(/(\d)\s*x\b/g, "$1*x")
    .replace(/\)\s*\(/g, ")*(")
    .replace(/\bx\s*\(/g, "x*(")
    .replace(/\)\s*x\b/g, ")*x")
    .replace(/\bpi\b/g, "PI")
    .replace(/\be\b/g, "E")
    .replace(/\bln\b/g, "log");

  try {
    const fn = new Function("x", "const {sin,cos,tan,asin,acos,atan,sqrt,abs,log,exp,pow,PI,E,floor,ceil,round,min,max}=Math; return (" + normalized + ");");
    return (x) => {
      const result = Number(fn(x));
      return Number.isFinite(result) ? result : Number.NaN;
    };
  } catch (error) {
    return null;
  }
}

function normalizeGeometryShapeType(value) {
  const kind = String(value || "").trim().toLowerCase();
  if (["rectangle", "square", "circle", "triangle", "cube", "cuboid", "sphere", "cylinder"].includes(kind)) {
    return kind;
  }
  return "rectangle";
}

function roundInteractive(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function normalizeGeometryUnit(value) {
  const unit = String(value || "unit").trim().toLowerCase();
  if (["unit", "cm", "m", "in", "ft"].includes(unit)) return unit;
  return "unit";
}

function normalizeGeometryFormulaNotation(value) {
  const mode = String(value || "plain").trim().toLowerCase();
  return mode === "math" ? "math" : "plain";
}

function formatMeasure(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "?";
  const rounded = roundInteractive(num, 2);
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function formatGeometryUnit(unit, power = 1, notation = "plain") {
  const normalized = normalizeGeometryUnit(unit);
  if (normalized === "unit") return "";
  if (power <= 1) return ` ${normalized}`;
  if (notation === "math") {
    return power === 2 ? ` ${normalized}²` : ` ${normalized}³`;
  }
  return ` ${normalized}^${power}`;
}

function formatGeometryResult(value, unit, power = 1, notation = "plain") {
  return `${formatMeasure(value)}${formatGeometryUnit(unit, power, notation)}`;
}

function buildGeometryFormulaLine(label, plainFormula, mathFormula, value, unit, power, notation) {
  const renderedFormula = notation === "math" ? mathFormula : plainFormula;
  return `${label}: ${renderedFormula} = ${formatGeometryResult(value, unit, power, notation)}`;
}

function computeGeometryMetrics(shape, options = {}) {
  const type = normalizeGeometryShapeType(shape.type);
  const w = Math.max(1, Number(shape.w) || 1);
  const h = Math.max(1, Number(shape.h) || w);
  const d = Math.max(1, Number(shape.d) || w);
  const unit = normalizeGeometryUnit(options.unit);
  const notation = normalizeGeometryFormulaNotation(options.formulaNotation);

  if (type === "rectangle") {
    const area = w * h;
    const perimeter = 2 * (w + h);
    return {
      type,
      lines: [
        buildGeometryFormulaLine("Area", `A = l x w = ${formatMeasure(w)} x ${formatMeasure(h)}`, `A = l × w = ${formatMeasure(w)} × ${formatMeasure(h)}`, area, unit, 2, notation),
        buildGeometryFormulaLine("Perimeter", `P = 2(l + w) = 2(${formatMeasure(w)} + ${formatMeasure(h)})`, `P = 2(l + w) = 2(${formatMeasure(w)} + ${formatMeasure(h)})`, perimeter, unit, 1, notation)
      ]
    };
  }

  if (type === "square") {
    const area = w * w;
    const perimeter = 4 * w;
    return {
      type,
      lines: [
        buildGeometryFormulaLine("Area", `A = s^2 = ${formatMeasure(w)}^2`, `A = s² = ${formatMeasure(w)}²`, area, unit, 2, notation),
        buildGeometryFormulaLine("Perimeter", `P = 4s = 4 x ${formatMeasure(w)}`, `P = 4s = 4 × ${formatMeasure(w)}`, perimeter, unit, 1, notation)
      ]
    };
  }

  if (type === "circle") {
    const area = Math.PI * w * w;
    const circumference = 2 * Math.PI * w;
    return {
      type,
      lines: [
        buildGeometryFormulaLine("Area", `A = pi r^2 = pi x ${formatMeasure(w)}^2`, `A = πr² = π × ${formatMeasure(w)}²`, area, unit, 2, notation),
        buildGeometryFormulaLine("Perimeter", `C = 2pi r = 2pi x ${formatMeasure(w)}`, `C = 2πr = 2π × ${formatMeasure(w)}`, circumference, unit, 1, notation)
      ]
    };
  }

  if (type === "triangle") {
    const area = 0.5 * w * h;
    const side = Math.sqrt((w / 2) ** 2 + h ** 2);
    const perimeter = w + 2 * side;
    return {
      type,
      lines: [
        buildGeometryFormulaLine("Area", `A = 1/2 b x h = 1/2 x ${formatMeasure(w)} x ${formatMeasure(h)}`, `A = 1/2 bh = 1/2 × ${formatMeasure(w)} × ${formatMeasure(h)}`, area, unit, 2, notation),
        buildGeometryFormulaLine("Perimeter", "P ≈ b + 2sqrt((b/2)^2 + h^2)", "P ≈ b + 2√((b/2)² + h²)", perimeter, unit, 1, notation)
      ]
    };
  }

  if (type === "cube") {
    const surfaceArea = 6 * w * w;
    const volume = w ** 3;
    return {
      type,
      lines: [
        buildGeometryFormulaLine("Surface area", `SA = 6s^2 = 6 x ${formatMeasure(w)}^2`, `SA = 6s² = 6 × ${formatMeasure(w)}²`, surfaceArea, unit, 2, notation),
        buildGeometryFormulaLine("Volume", `V = s^3 = ${formatMeasure(w)}^3`, `V = s³ = ${formatMeasure(w)}³`, volume, unit, 3, notation)
      ]
    };
  }

  if (type === "cuboid") {
    const surfaceArea = 2 * (w * h + w * d + h * d);
    const volume = w * h * d;
    return {
      type,
      lines: [
        buildGeometryFormulaLine("Surface area", "SA = 2(lw + lh + wh)", "SA = 2(lw + lh + wh)", surfaceArea, unit, 2, notation),
        buildGeometryFormulaLine("Volume", `V = l x w x h = ${formatMeasure(w)} x ${formatMeasure(h)} x ${formatMeasure(d)}`, `V = l × w × h = ${formatMeasure(w)} × ${formatMeasure(h)} × ${formatMeasure(d)}`, volume, unit, 3, notation)
      ]
    };
  }

  if (type === "sphere") {
    const surfaceArea = 4 * Math.PI * w * w;
    const volume = (4 / 3) * Math.PI * w ** 3;
    return {
      type,
      lines: [
        buildGeometryFormulaLine("Surface area", `SA = 4pi r^2 = 4pi x ${formatMeasure(w)}^2`, `SA = 4πr² = 4π × ${formatMeasure(w)}²`, surfaceArea, unit, 2, notation),
        buildGeometryFormulaLine("Volume", `V = 4/3 pi r^3 = 4/3 pi x ${formatMeasure(w)}^3`, `V = 4/3πr³ = 4/3π × ${formatMeasure(w)}³`, volume, unit, 3, notation)
      ]
    };
  }

  const surfaceArea = 2 * Math.PI * w * (w + h);
  const volume = Math.PI * w * w * h;
  return {
    type: "cylinder",
    lines: [
      buildGeometryFormulaLine("Surface area", `SA = 2pi r(r + h) = 2pi x ${formatMeasure(w)}(${formatMeasure(w)} + ${formatMeasure(h)})`, `SA = 2πr(r + h) = 2π × ${formatMeasure(w)}(${formatMeasure(w)} + ${formatMeasure(h)})`, surfaceArea, unit, 2, notation),
      buildGeometryFormulaLine("Volume", `V = pi r^2 h = pi x ${formatMeasure(w)}^2 x ${formatMeasure(h)}`, `V = πr²h = π × ${formatMeasure(w)}² × ${formatMeasure(h)}`, volume, unit, 3, notation)
    ]
  };
}

function buildGeometryShapesSvgString(config) {
  const canvasWidth = Math.max(220, Math.min(760, Number.parseInt(config.canvasWidth, 10) || 360));
  const canvasHeight = Math.max(180, Math.min(520, Number.parseInt(config.canvasHeight, 10) || 260));
  const shapes = Array.isArray(config.shapes) ? config.shapes : [];
  if (shapes.length === 0) return "";

  const parts = [];
  parts.push(`<rect x="0" y="0" width="${canvasWidth}" height="${canvasHeight}" fill="#f8fbff" stroke="#dbe6f3"/>`);

  shapes.forEach((shape, index) => {
    const type = normalizeGeometryShapeType(shape.type);
    const x = Number(shape.x);
    const y = Number(shape.y);
    const w = Math.max(6, Number(shape.w) || 40);
    const h = Math.max(6, Number(shape.h) || w);
    const d = Math.max(6, Number(shape.d) || w);
    if (![x, y].every(Number.isFinite)) return;
    const stroke = safeInteractiveColor(shape.color, "#2563eb");
    const fill = safeInteractiveColor(shape.fill, "#dbeafe");
    const label = escapeHtml(String(shape.label || `${type} ${index + 1}`));
    const metrics = computeGeometryMetrics({ type, w, h, d }, config || {});
    const formula = escapeHtml((metrics.lines[0] || "").replace(/^Area:\s*|^Surface area:\s*/, ""));

    if (type === "rectangle") {
      parts.push(`<rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
    } else if (type === "square") {
      parts.push(`<rect x="${x - w / 2}" y="${y - w / 2}" width="${w}" height="${w}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
    } else if (type === "circle") {
      parts.push(`<circle cx="${x}" cy="${y}" r="${w}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
    } else if (type === "triangle") {
      parts.push(`<polygon points="${x},${y - h / 2} ${x - w / 2},${y + h / 2} ${x + w / 2},${y + h / 2}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
    } else if (type === "cube" || type === "cuboid") {
      const depth = Math.max(8, d);
      const left = x - w / 2;
      const top = y - h / 2;
      parts.push(`<rect x="${left}" y="${top}" width="${w}" height="${h}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
      parts.push(`<polygon points="${left},${top} ${left + depth},${top - depth} ${left + w + depth},${top - depth} ${left + w},${top}" fill="${fill}" fill-opacity="0.75" stroke="${stroke}" stroke-width="2"/>`);
      parts.push(`<polygon points="${left + w},${top} ${left + w + depth},${top - depth} ${left + w + depth},${top + h - depth} ${left + w},${top + h}" fill="${fill}" fill-opacity="0.6" stroke="${stroke}" stroke-width="2"/>`);
    } else if (type === "sphere") {
      parts.push(`<circle cx="${x}" cy="${y}" r="${w}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
      parts.push(`<ellipse cx="${x}" cy="${y}" rx="${w}" ry="${Math.max(6, w * 0.32)}" fill="none" stroke="${stroke}" stroke-opacity="0.45" stroke-width="1.5"/>`);
    } else if (type === "cylinder") {
      const radius = w;
      const bodyH = h;
      parts.push(`<ellipse cx="${x}" cy="${y - bodyH / 2}" rx="${radius}" ry="${Math.max(6, radius * 0.35)}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
      parts.push(`<rect x="${x - radius}" y="${y - bodyH / 2}" width="${radius * 2}" height="${bodyH}" fill="${fill}" fill-opacity="0.7" stroke="${stroke}" stroke-width="2"/>`);
      parts.push(`<ellipse cx="${x}" cy="${y + bodyH / 2}" rx="${radius}" ry="${Math.max(6, radius * 0.35)}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
    }

    parts.push(`<circle cx="${x}" cy="${y}" r="7" fill="${stroke}" stroke="white" stroke-width="2" class="interactive-draggable-point" data-point-index="${index}" data-point-type="geometry-shapes"/>`);
    parts.push(`<text x="${x}" y="${y - Math.max(h, w) / 2 - 10}" text-anchor="middle" font-size="11" fill="${stroke}" font-weight="bold">${label}</text>`);
    parts.push(`<text x="${x + Math.max(w, h) / 2 + 8}" y="${y + 4}" text-anchor="start" font-size="10" fill="#334155">${formula}</text>`);
  });

  return `<div class="geometry-shapes-container"><svg viewBox="0 0 ${canvasWidth} ${canvasHeight}" width="100%" preserveAspectRatio="xMidYMid meet">${parts.join("")}</svg></div>`;
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
    parts.push(`<circle cx="${x}" cy="${lineY}" r="10" fill="${color}" stroke="white" stroke-width="2" class="interactive-draggable-point" data-point-index="${points.indexOf(point)}" data-point-type="number-line"/>`);
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
  const parabolas = Array.isArray(config.parabolas) ? config.parabolas : [];
  const functionsList = Array.isArray(config.functions) ? config.functions : [];
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

  parabolas.forEach((curve) => {
    const a = Number(curve.a);
    const b = Number(curve.b);
    const c = Number(curve.c);
    if (![a, b, c].every(Number.isFinite)) return;
    const color = safeInteractiveColor(curve.color, "#7c3aed");
    const label = escapeHtml(String(curve.label || ""));
    const samples = 100;
    const pathParts = [];
    for (let i = 0; i <= samples; i += 1) {
      const xValue = xMin + (i / samples) * (xMax - xMin);
      const yValue = a * xValue * xValue + b * xValue + c;
      const sx = xPos(xValue);
      const sy = yPos(yValue);
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
      pathParts.push(`${i === 0 ? "M" : "L"} ${sx} ${sy}`);
    }
    if (pathParts.length > 1) {
      parts.push(`<path d="${pathParts.join(" ")}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>`);
      if (label) {
        const xAtLabel = (xMin + xMax) / 2;
        const yAtLabel = a * xAtLabel * xAtLabel + b * xAtLabel + c;
        const lx = xPos(xAtLabel);
        const ly = yPos(yAtLabel);
        if (Number.isFinite(lx) && Number.isFinite(ly)) {
          parts.push(`<text x="${lx + 8}" y="${ly - 8}" font-size="11" fill="${color}" font-weight="bold">${label}</text>`);
        }
      }
    }
  });

  functionsList.forEach((curve) => {
    const expression = String(curve.expression || "").trim();
    if (!expression) return;
    const evaluate = buildCartesianExpressionEvaluator(expression);
    if (!evaluate) return;
    const color = safeInteractiveColor(curve.color, "#0f766e");
    const label = escapeHtml(String(curve.label || `y = ${expression}`));
    const samples = 140;
    const pathParts = [];
    for (let i = 0; i <= samples; i += 1) {
      const xValue = xMin + (i / samples) * (xMax - xMin);
      const yValue = evaluate(xValue);
      const sx = xPos(xValue);
      const sy = yPos(yValue);
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
      pathParts.push(`${i === 0 ? "M" : "L"} ${sx} ${sy}`);
    }
    if (pathParts.length > 1) {
      parts.push(`<path d="${pathParts.join(" ")}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-dasharray="6 3"/>`);
      const xAtLabel = xMin + 0.72 * (xMax - xMin);
      const yAtLabel = evaluate(xAtLabel);
      const lx = xPos(xAtLabel);
      const ly = yPos(yAtLabel);
      if (Number.isFinite(lx) && Number.isFinite(ly)) {
        parts.push(`<text x="${lx + 8}" y="${ly - 8}" font-size="11" fill="${color}" font-weight="bold">${label}</text>`);
      }
    }
  });

  points.forEach((point) => {
    const x = xPos(Number(point.x));
    const y = yPos(Number(point.y));
    if (![x, y].every(Number.isFinite)) return;
    const color = safeInteractiveColor(point.color, "#2563eb");
    const label = escapeHtml(String(point.label || ""));
    parts.push(`<circle cx="${x}" cy="${y}" r="8" fill="${color}" stroke="white" stroke-width="2" class="interactive-draggable-point" data-point-index="${points.indexOf(point)}" data-point-type="cartesian-plane"/>`);
    if (label) parts.push(`<text x="${x + 10}" y="${y - 10}" font-size="11" fill="${color}" font-weight="bold">${label}</text>`);
  });

  return `<div class="cartesian-container"><svg viewBox="0 0 ${size} ${size}" width="100%" preserveAspectRatio="xMidYMid meet">${parts.join("")}</svg></div>`;
}

function buildCartesianPlotSvgString(config, userPoints, revealAnswers) {
  const xMin = Number(config.xMin ?? -10);
  const xMax = Number(config.xMax ?? 10);
  const yMin = Number(config.yMin ?? -10);
  const yMax = Number(config.yMax ?? 10);
  if (![xMin, xMax, yMin, yMax].every(Number.isFinite) || xMin >= xMax || yMin >= yMax) return "";
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
    const xc = xPos(x);
    parts.push(`<line x1="${xc}" y1="${pad}" x2="${xc}" y2="${size - pad}" stroke="#dbe6f3" stroke-width="1"/>`);
    parts.push(`<text x="${xc}" y="${size - pad + 18}" text-anchor="middle" font-size="11" fill="#64748b">${x}</text>`);
  }
  for (let y = yMin; y <= yMax; y += yStep) {
    const yc = yPos(y);
    parts.push(`<line x1="${pad}" y1="${yc}" x2="${size - pad}" y2="${yc}" stroke="#dbe6f3" stroke-width="1"/>`);
    parts.push(`<text x="${pad - 10}" y="${yc + 4}" text-anchor="end" font-size="11" fill="#64748b">${y}</text>`);
  }
  if (axisX !== null) parts.push(`<line x1="${axisX}" y1="${pad - 6}" x2="${axisX}" y2="${size - pad + 6}" stroke="#334155" stroke-width="2"/>`);
  if (axisY !== null) parts.push(`<line x1="${pad - 6}" y1="${axisY}" x2="${size - pad + 6}" y2="${axisY}" stroke="#334155" stroke-width="2"/>`);
  const placed = Array.isArray(userPoints) ? userPoints : [];
  placed.forEach((point) => {
    const x = xPos(Number(point.x));
    const y = yPos(Number(point.y));
    if (![x, y].every(Number.isFinite)) return;
    parts.push(`<circle cx="${x}" cy="${y}" r="7" fill="#f59e0b" stroke="white" stroke-width="2"/>`);
    parts.push(`<text x="${x + 10}" y="${y - 8}" font-size="10" fill="#b45309" font-weight="bold">(${escapeHtml(String(point.x))},${escapeHtml(String(point.y))})</text>`);
  });
  if (revealAnswers) {
    const answerPts = Array.isArray(config.points) ? config.points : [];
    answerPts.forEach((point) => {
      const x = xPos(Number(point.x));
      const y = yPos(Number(point.y));
      if (![x, y].every(Number.isFinite)) return;
      const label = escapeHtml(String(point.label || `(${point.x},${point.y})`));
      parts.push(`<circle cx="${x}" cy="${y}" r="9" fill="none" stroke="#16a34a" stroke-width="2.5" stroke-dasharray="4 2"/>`);
      parts.push(`<text x="${x + 12}" y="${y - 12}" font-size="10" fill="#16a34a" font-weight="bold">${label}</text>`);
    });
  }
  return `<div class="cartesian-container"><svg id="cartesianPlotSvg" viewBox="0 0 ${size} ${size}" width="100%" preserveAspectRatio="xMidYMid meet" style="cursor:crosshair">${parts.join("")}</svg></div>`;
}

function mountCartesianPlotAnswer(container, question) {
  const config = (question.interactiveApp && question.interactiveApp.config) || {};
  const xMin = Number(config.xMin ?? -10);
  const xMax = Number(config.xMax ?? 10);
  const yMin = Number(config.yMin ?? -10);
  const yMax = Number(config.yMax ?? 10);
  const size = 320;
  const pad = 36;
  const usable = size - pad * 2;
  const answerCount = Array.isArray(config.points) ? config.points.length : 0;

  const redraw = () => {
    const wrapper = container.querySelector(".cartesian-plot-answer");
    if (!wrapper) return;
    wrapper.innerHTML = buildCartesianPlotSvgString(config, cartesianPlotUserPoints, false);
    const helpEl = container.querySelector(".cartesian-plot-help");
    if (helpEl) {
      helpEl.textContent = cartesianPlotUserPoints.length === 0
        ? `Click the grid to place ${answerCount} point${answerCount !== 1 ? "s" : ""}. Click a placed point to remove it.`
        : `${cartesianPlotUserPoints.length} point${cartesianPlotUserPoints.length !== 1 ? "s" : ""} placed. Click to add more or click a point to remove it.`;
    }
    attachSvgClickHandler();
  };

  const attachSvgClickHandler = () => {
    const svg = container.querySelector("#cartesianPlotSvg");
    if (!svg) return;
    svg.addEventListener("click", (event) => {
      const pos = getSvgPointerPosition(svg, event);
      if (!pos) return;
      const gx = Math.round(((pos.x - pad) / usable) * (xMax - xMin) + xMin);
      const gy = Math.round((1 - (pos.y - pad) / usable) * (yMax - yMin) + yMin);
      if (!Number.isFinite(gx) || !Number.isFinite(gy) || gx < xMin || gx > xMax || gy < yMin || gy > yMax) return;
      const existingIdx = cartesianPlotUserPoints.findIndex((p) => p.x === gx && p.y === gy);
      if (existingIdx >= 0) {
        cartesianPlotUserPoints.splice(existingIdx, 1);
      } else {
        cartesianPlotUserPoints.push({ x: gx, y: gy });
      }
      redraw();
    });
  };

  redraw();
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

function buildBarChartMarkup(config) {
  const title = escapeHtml(String(config.title || "Category Frequencies"));
  const categoryAxisLabel = escapeHtml(String(config.categoryAxisLabel || "Category"));
  const valueAxisLabel = escapeHtml(String(config.valueAxisLabel || "Value"));
  const items = (Array.isArray(config.items) ? config.items : [])
    .map((item, index) => ({
      category: String(item.category || `Item ${index + 1}`).trim() || `Item ${index + 1}`,
      value: Math.max(0, Number(item.frequency) || 0),
      color: safeInteractiveColor(item.color, "#2563eb")
    }));
  const orientation = String(config.orientation || "vertical").trim().toLowerCase() === "horizontal" ? "horizontal" : "vertical";
  if (items.length === 0) return "";

  const maxItem = Math.max(...items.map((item) => item.value), 1);
  const yMax = Number.isFinite(Number(config.yMax)) && Number(config.yMax) > 0
    ? Number(config.yMax)
    : Math.ceil(maxItem / 5) * 5;
  const tickCount = 5;

  if (orientation === "horizontal") {
    const width = 560;
    const height = 300;
    const margin = { top: 26, right: 24, bottom: 54, left: 130 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    const step = plotH / items.length;
    const barH = Math.max(12, step * 0.62);

    const bars = items.map((item, index) => {
      const y = margin.top + index * step + (step - barH) / 2;
      const w = Math.max(2, (item.value / yMax) * plotW);
      return `
        <text x="${margin.left - 8}" y="${y + barH / 2 + 4}" text-anchor="end" font-size="11" fill="#334155">${escapeHtml(item.category)}</text>
        <rect x="${margin.left}" y="${y}" width="${w}" height="${barH}" fill="${item.color}" stroke="#1e293b" stroke-width="0.6"/>
        <text x="${Math.min(width - 4, margin.left + w + 6)}" y="${y + barH / 2 + 4}" font-size="11" fill="#0f172a">${item.value}</text>
      `;
    }).join("");

    const ticks = Array.from({ length: tickCount + 1 }, (_, index) => {
      const value = (yMax * index) / tickCount;
      const x = margin.left + (plotW * index) / tickCount;
      return `<line x1="${x}" y1="${height - margin.bottom}" x2="${x}" y2="${height - margin.bottom + 6}" stroke="#64748b"/><text x="${x}" y="${height - margin.bottom + 20}" text-anchor="middle" font-size="10" fill="#475569">${escapeHtml(value.toFixed(0))}</text>`;
    }).join("");

    return `
      <div class="bar-chart-container">
        <p class="bar-chart-title">${title}</p>
        <svg class="bar-chart-svg" viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="xMidYMid meet">
          <rect x="1" y="1" width="${width - 2}" height="${height - 2}" fill="#ffffff" stroke="#cbd5e1"/>
          <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" stroke="#334155" stroke-width="1.4"/>
          <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#334155" stroke-width="1.4"/>
          ${bars}
          ${ticks}
          <text x="${margin.left + plotW / 2}" y="${height - 12}" text-anchor="middle" font-size="12" font-weight="700" fill="#1e293b">${valueAxisLabel}</text>
          <text x="22" y="${margin.top + plotH / 2}" text-anchor="middle" font-size="12" font-weight="700" fill="#1e293b" transform="rotate(-90 22 ${margin.top + plotH / 2})">${categoryAxisLabel}</text>
        </svg>
      </div>
    `;
  }

  const width = 560;
  const height = 320;
  const margin = { top: 26, right: 22, bottom: 84, left: 62 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const step = plotW / items.length;
  const barW = Math.max(14, step * 0.62);

  const bars = items.map((item, index) => {
    const x = margin.left + index * step + (step - barW) / 2;
    const h = Math.max(2, (item.value / yMax) * plotH);
    const y = margin.top + plotH - h;
    return `
      <rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${item.color}" stroke="#1e293b" stroke-width="0.6"/>
      <text x="${x + barW / 2}" y="${Math.max(14, y - 6)}" text-anchor="middle" font-size="10" fill="#0f172a">${item.value}</text>
      <text x="${x + barW / 2}" y="${height - margin.bottom + 16}" text-anchor="middle" font-size="10" fill="#334155">${escapeHtml(item.category)}</text>
    `;
  }).join("");

  const ticks = Array.from({ length: tickCount + 1 }, (_, index) => {
    const value = (yMax * index) / tickCount;
    const y = margin.top + plotH - (plotH * index) / tickCount;
    return `<line x1="${margin.left - 6}" y1="${y}" x2="${margin.left}" y2="${y}" stroke="#64748b"/><text x="${margin.left - 10}" y="${y + 4}" text-anchor="end" font-size="10" fill="#475569">${escapeHtml(value.toFixed(0))}</text>`;
  }).join("");

  return `
    <div class="bar-chart-container">
      <p class="bar-chart-title">${title}</p>
      <svg class="bar-chart-svg" viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="xMidYMid meet">
        <rect x="1" y="1" width="${width - 2}" height="${height - 2}" fill="#ffffff" stroke="#cbd5e1"/>
        <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotH}" stroke="#334155" stroke-width="1.4"/>
        <line x1="${margin.left}" y1="${margin.top + plotH}" x2="${width - margin.right}" y2="${margin.top + plotH}" stroke="#334155" stroke-width="1.4"/>
        ${bars}
        ${ticks}
        <text x="${margin.left + plotW / 2}" y="${height - 12}" text-anchor="middle" font-size="12" font-weight="700" fill="#1e293b">${categoryAxisLabel}</text>
        <text x="18" y="${margin.top + plotH / 2}" text-anchor="middle" font-size="12" font-weight="700" fill="#1e293b" transform="rotate(-90 18 ${margin.top + plotH / 2})">${valueAxisLabel}</text>
      </svg>
    </div>
  `;
}

function quantile(sortedValues, q) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return Number.NaN;
  const position = (sortedValues.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return sortedValues[low];
  const weight = position - low;
  return sortedValues[low] * (1 - weight) + sortedValues[high] * weight;
}

function medianOfSorted(sortedValues) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return Number.NaN;
  const mid = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 0) {
    return (sortedValues[mid - 1] + sortedValues[mid]) / 2;
  }
  return sortedValues[mid];
}

function computeFiveNumber(values) {
  const sorted = (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;

  const median = medianOfSorted(sorted);
  if (!Number.isFinite(median)) return null;

  const mid = Math.floor(sorted.length / 2);
  const lowerHalf = sorted.length % 2 === 0 ? sorted.slice(0, mid) : sorted.slice(0, mid);
  const upperHalf = sorted.length % 2 === 0 ? sorted.slice(mid) : sorted.slice(mid + 1);
  const q1 = lowerHalf.length > 0 ? medianOfSorted(lowerHalf) : median;
  const q3 = upperHalf.length > 0 ? medianOfSorted(upperHalf) : median;

  return {
    min: sorted[0],
    q1,
    median,
    q3,
    max: sorted[sorted.length - 1]
  };
}

function defaultBoxPlotDatasetLabel(index) {
  const offset = Number(index);
  if (Number.isInteger(offset) && offset >= 0 && offset < 26) {
    return String.fromCharCode(65 + offset);
  }
  return `Dataset ${Number.isInteger(offset) ? offset + 1 : 1}`;
}

function normalizeBoxPlotDatasets(config) {
  const fromArray = Array.isArray(config && config.datasets) ? config.datasets : [];
  const normalizedFromArray = fromArray.map((item, index) => ({
    label: String(item && item.label ? item.label : "").trim() || defaultBoxPlotDatasetLabel(index),
    values: (Array.isArray(item && item.values) ? item.values : [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
  }));

  if (normalizedFromArray.length > 0) {
    return normalizedFromArray;
  }

  return [
    {
      label: String((config && config.labelA) || "").trim() || "A",
      values: (Array.isArray(config && config.valuesA) ? config.valuesA : [])
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
    },
    {
      label: String((config && config.labelB) || "").trim() || "B",
      values: (Array.isArray(config && config.valuesB) ? config.valuesB : [])
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
    }
  ];
}

function clampBoxPlotDatasetCount(value) {
  const count = Number.parseInt(value, 10);
  if (!Number.isInteger(count)) return 2;
  return Math.max(1, Math.min(8, count));
}

function parseBoxPlotDatasetsFromText(text, datasetCount) {
  const count = clampBoxPlotDatasetCount(datasetCount);
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim());
  const datasets = [];

  for (let index = 0; index < count; index += 1) {
    const line = lines[index] || "";
    const delimiterIndex = line.indexOf(":");
    const hasDelimiter = delimiterIndex >= 0;
    const rawLabel = hasDelimiter ? line.slice(0, delimiterIndex).trim() : "";
    const rawValues = hasDelimiter ? line.slice(delimiterIndex + 1) : line;
    const values = String(rawValues || "")
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter((item) => item !== "")
      .map((item) => Number.parseFloat(item))
      .filter((item) => Number.isFinite(item));

    datasets.push({
      label: rawLabel || defaultBoxPlotDatasetLabel(index),
      values
    });
  }

  return datasets;
}

function serializeBoxPlotDatasets(datasets) {
  if (!Array.isArray(datasets)) return "";
  return datasets
    .map((item, index) => {
      const label = String(item && item.label ? item.label : "").trim() || defaultBoxPlotDatasetLabel(index);
      const values = Array.isArray(item && item.values) ? item.values : [];
      return `${label}: ${values.join(", ")}`;
    })
    .join("\n");
}

function computeLinearRegression(points) {
  const valid = (Array.isArray(points) ? points : [])
    .map((point) => ({ x: Number(point.x), y: Number(point.y) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (valid.length < 2) return null;

  const n = valid.length;
  const sumX = valid.reduce((sum, item) => sum + item.x, 0);
  const sumY = valid.reduce((sum, item) => sum + item.y, 0);
  const sumXY = valid.reduce((sum, item) => sum + item.x * item.y, 0);
  const sumXX = valid.reduce((sum, item) => sum + item.x * item.x, 0);
  const sumYY = valid.reduce((sum, item) => sum + item.y * item.y, 0);
  const denominator = n * sumXX - sumX * sumX;
  if (Math.abs(denominator) < 1e-12) return null;
  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;
  const corrDen = Math.sqrt((n * sumXX - sumX * sumX) * (n * sumYY - sumY * sumY));
  const correlation = corrDen > 0 ? (n * sumXY - sumX * sumY) / corrDen : 0;
  return { slope, intercept, correlation };
}

function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
  const prob = 1 - d * (0.319381530 * t - 0.356563782 * t ** 2 + 1.781477937 * t ** 3 - 1.821255978 * t ** 4 + 1.330274429 * t ** 5);
  return z >= 0 ? prob : 1 - prob;
}

function computeHistogramBins(values, binCount) {
  const nums = (Array.isArray(values) ? values : []).map((v) => Number(v)).filter((v) => Number.isFinite(v));
  if (nums.length === 0) return null;
  const binsN = Math.max(2, Math.min(30, Number.parseInt(binCount, 10) || 8));
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const width = (max - min || 1) / binsN;
  const bins = new Array(binsN).fill(0);
  nums.forEach((value) => {
    const idx = Math.min(binsN - 1, Math.max(0, Math.floor((value - min) / width)));
    bins[idx] += 1;
  });
  return { min, max, width, bins };
}

function buildHistogramMarkup(config) {
  const title = escapeHtml(String(config.title || "Continuous Data Distribution"));
  const hist = computeHistogramBins(config.values || [], config.binCount);
  if (!hist) return "";
  const maxFreq = Math.max(...hist.bins, 1);
  const bars = hist.bins.map((freq, index) => {
    const barHeight = Math.max(4, (freq / maxFreq) * 120);
    const start = hist.min + index * hist.width;
    const end = start + hist.width;
    return `<div class="histogram-bin"><div class="histogram-bar" style="height:${barHeight}px"></div><span class="histogram-label">${escapeHtml(start.toFixed(1))}-${escapeHtml(end.toFixed(1))}</span><span class="histogram-value">${freq}</span></div>`;
  }).join("");
  return `<div class="histogram-container"><p class="bar-chart-title">${title}</p><div class="histogram-bars">${bars}</div></div>`;
}

function buildBoxPlotMarkup(config) {
  const title = escapeHtml(String(config.title || "Compare Datasets"));
  const rows = normalizeBoxPlotDatasets(config).map((dataset, index) => ({
    label: dataset.label || defaultBoxPlotDatasetLabel(index),
    stats: computeFiveNumber(dataset.values || []),
    color: ["#2563eb", "#16a34a", "#f59e0b", "#7c3aed", "#0f766e", "#dc2626", "#0891b2", "#9333ea"][index % 8]
  }));
  const statsList = rows.map((item) => item.stats).filter((item) => item);
  if (statsList.length === 0) return "";

  const minValue = Math.min(...statsList.map((item) => item.min));
  const maxValue = Math.max(...statsList.map((item) => item.max));
  const axisMin = Math.floor(minValue);
  const axisMax = Math.ceil(maxValue);
  const axisRange = axisMax - axisMin || 1;
  const left = 92;
  const right = 360;
  const rowStart = 52;
  const rowGap = 40;
  const axisY = rowStart + Math.max(0, rows.length - 1) * rowGap + 30;
  const svgHeight = Math.max(172, axisY + 22);
  const mapX = (value) => left + ((value - axisMin) / axisRange) * (right - left);

  const renderRow = (label, stats, index, color) => {
    const y = rowStart + index * rowGap;
    if (!stats) {
      return `<text x="14" y="${y + 4}" font-size="12" fill="#64748b">${escapeHtml(label)}</text><text x="${left}" y="${y + 4}" font-size="12" fill="#94a3b8">no data</text>`;
    }
    const xMin = mapX(stats.min);
    const xQ1 = mapX(stats.q1);
    const xMedian = mapX(stats.median);
    const xQ3 = mapX(stats.q3);
    const xMax = mapX(stats.max);
    return `
      <text x="14" y="${y + 4}" font-size="12" fill="#0f172a" font-weight="700">${escapeHtml(label)}</text>
      <g style="cursor:pointer" class="box-plot-hover">
        <title>Min: ${stats.min.toFixed(2)}</title>
        <rect x="${xMin - 8}" y="${y - 15}" width="16" height="30" fill="transparent" stroke="none"/>
        <line x1="${xMin}" y1="${y - 10}" x2="${xMin}" y2="${y + 10}" stroke="#64748b" stroke-width="2"/>
      </g>
      <line x1="${xMin}" y1="${y}" x2="${xQ1}" y2="${y}" stroke="#64748b" stroke-width="2"/>
      <g style="cursor:pointer" class="box-plot-hover">
        <title>Q1: ${stats.q1.toFixed(2)}</title>
        <rect x="${Math.min(xQ1, xQ3)}" y="${y - 12}" width="${Math.max(2, Math.abs(xQ3 - xQ1))}" height="24" fill="transparent" stroke="none" pointer-events="all"/>
        <rect x="${Math.min(xQ1, xQ3)}" y="${y - 12}" width="${Math.max(2, Math.abs(xQ3 - xQ1))}" height="24" fill="${color}" fill-opacity="0.25" stroke="${color}" stroke-width="2" pointer-events="none"/>
      </g>
      <g style="cursor:pointer" class="box-plot-hover">
        <title>Median: ${stats.median.toFixed(2)}</title>
        <rect x="${xMedian - 8}" y="${y - 15}" width="16" height="30" fill="transparent" stroke="none"/>
        <line x1="${xMedian}" y1="${y - 12}" x2="${xMedian}" y2="${y + 12}" stroke="${color}" stroke-width="2"/>
      </g>
      <g style="cursor:pointer" class="box-plot-hover">
        <title>Q3: ${stats.q3.toFixed(2)}</title>
        <rect x="${Math.min(xQ1, xQ3)}" y="${y - 12}" width="${Math.max(2, Math.abs(xQ3 - xQ1))}" height="24" fill="transparent" stroke="none" pointer-events="all"/>
      </g>
      <line x1="${xQ3}" y1="${y}" x2="${xMax}" y2="${y}" stroke="#64748b" stroke-width="2"/>
      <g style="cursor:pointer" class="box-plot-hover">
        <title>Max: ${stats.max.toFixed(2)}</title>
        <rect x="${xMax - 8}" y="${y - 15}" width="16" height="30" fill="transparent" stroke="none"/>
        <line x1="${xMax}" y1="${y - 10}" x2="${xMax}" y2="${y + 10}" stroke="#64748b" stroke-width="2"/>
      </g>
      <text x="${xMin}" y="${y - 15}" text-anchor="middle" font-size="9" fill="#64748b" font-weight="600">min</text>
      <text x="${xQ1}" y="${y - 15}" text-anchor="middle" font-size="9" fill="#64748b" font-weight="600">Q1</text>
      <text x="${xMedian}" y="${y - 20}" text-anchor="middle" font-size="9" fill="${color}" font-weight="700">median</text>
      <text x="${xQ3}" y="${y - 15}" text-anchor="middle" font-size="9" fill="#64748b" font-weight="600">Q3</text>
      <text x="${xMax}" y="${y - 15}" text-anchor="middle" font-size="9" fill="#64748b" font-weight="600">max</text>
    `;
  };

  const axisTickValues = [];
  for (let value = axisMin; value <= axisMax; value += 1) {
    axisTickValues.push(value);
  }
  const labelSkip = axisTickValues.length > 24 ? Math.ceil(axisTickValues.length / 24) : 1;
  const axisTicks = axisTickValues.map((value, index) => {
    const x = mapX(value);
    const label = index % labelSkip === 0
      ? `<text x="${x}" y="${axisY + 15}" text-anchor="middle" font-size="10" fill="#64748b">${value}</text>`
      : "";
    return `<line x1="${x}" y1="${axisY - 4}" x2="${x}" y2="${axisY + 2}" stroke="#94a3b8"/>${label}`;
  }).join("");

  const line = (label, stats) => stats
    ? `<p>${escapeHtml(label)}: min=${stats.min.toFixed(2)}, Q1=${stats.q1.toFixed(2)}, median=${stats.median.toFixed(2)}, Q3=${stats.q3.toFixed(2)}, max=${stats.max.toFixed(2)}</p>`
    : `<p>${escapeHtml(label)}: no data</p>`;

  return `
    <div class="simple-card">
      <p class="bar-chart-title">${title}</p>
      <svg viewBox="0 0 380 ${svgHeight}" width="100%" preserveAspectRatio="xMidYMid meet">
        <rect x="0" y="0" width="380" height="${svgHeight}" fill="#f8fafc" stroke="#dbe6f3"/>
        ${rows.map((row, index) => renderRow(row.label, row.stats, index, row.color)).join("")}
        <line x1="${left}" y1="${axisY}" x2="${right}" y2="${axisY}" stroke="#64748b" stroke-width="1.5"/>
        ${axisTicks}
      </svg>
      ${rows.map((row) => line(row.label, row.stats)).join("")}
    </div>
  `;
}

function buildScatterPlotMarkup(config) {
  const title = escapeHtml(String(config.title || "Correlation and Best Fit"));
  const points = Array.isArray(config.points) ? config.points : [];
  if (points.length === 0) return "";
  const regression = computeLinearRegression(points);
  const detail = regression
    ? `r = ${regression.correlation.toFixed(3)}, best fit: y = ${regression.slope.toFixed(3)}x + ${regression.intercept.toFixed(3)}`
    : "Not enough variation for line of best fit.";
  return `<div class="simple-card"><p class="bar-chart-title">${title}</p><p>Point count: ${points.length}</p><p>${escapeHtml(detail)}</p></div>`;
}

function computeConditionalProbability(paths, query) {
  const raw = String(query || "").trim();
  if (!raw || !raw.includes("|")) return null;
  const [leftRaw, rightRaw] = raw.split("|");
  const left = leftRaw.trim();
  const right = rightRaw.trim();
  if (!left || !right) return null;

  const totalRight = paths
    .filter((item) => Array.isArray(item.path) && item.path.some((segment) => segment === right))
    .reduce((sum, item) => sum + (Number(item.probability) || 0), 0);
  if (totalRight <= 0) return null;

  const both = paths
    .filter((item) => Array.isArray(item.path)
      && item.path.some((segment) => segment === left)
      && item.path.some((segment) => segment === right))
    .reduce((sum, item) => sum + (Number(item.probability) || 0), 0);
  return both / totalRight;
}

function buildProbabilityTreeMarkup(config) {
  const title = escapeHtml(String(config.title || "Sequential Probabilities"));
  const paths = Array.isArray(config.paths) ? config.paths : [];
  if (paths.length === 0) return "";
  const total = paths.reduce((sum, item) => sum + (Number(item.probability) || 0), 0);
  const conditional = computeConditionalProbability(paths, config.conditionalQuery || "");
  const condLine = conditional === null ? "Conditional probability: n/a" : `Conditional probability: ${conditional.toFixed(4)}`;
  return `<div class="simple-card"><p class="bar-chart-title">${title}</p><p>Path count: ${paths.length}</p><p>Total probability: ${total.toFixed(3)}</p><p>${escapeHtml(condLine)}</p></div>`;
}

function buildDistributionCurveMarkup(config) {
  const title = escapeHtml(String(config.title || "Normal Distribution"));
  const mean = Number(config.mean);
  const stdDev = Math.max(0.0001, Number(config.stdDev) || 1);
  const from = Number(config.from);
  const to = Number(config.to);
  if (![mean, stdDev, from, to].every(Number.isFinite)) return "";
  const area = Math.max(0, normalCdf((to - mean) / stdDev) - normalCdf((from - mean) / stdDev));
  return `<div class="simple-card"><p class="bar-chart-title">${title}</p><p>Mean = ${mean.toFixed(3)}, SD = ${stdDev.toFixed(3)}</p><p>Area from ${from.toFixed(3)} to ${to.toFixed(3)} ≈ ${area.toFixed(4)}</p></div>`;
}

function dijkstra(nodes, edges, source, target) {
  const dist = {};
  const prev = {};
  const unvisited = new Set(nodes);
  nodes.forEach((node) => { dist[node] = Number.POSITIVE_INFINITY; });
  dist[source] = 0;

  while (unvisited.size > 0) {
    let current = null;
    let best = Number.POSITIVE_INFINITY;
    unvisited.forEach((node) => {
      if (dist[node] < best) {
        best = dist[node];
        current = node;
      }
    });
    if (!current || best === Number.POSITIVE_INFINITY) break;
    unvisited.delete(current);
    if (current === target) break;

    edges.forEach((edge) => {
      if (edge.from !== current && edge.to !== current) return;
      const neighbor = edge.from === current ? edge.to : edge.from;
      if (!unvisited.has(neighbor)) return;
      const alt = dist[current] + Math.max(0, Number(edge.weight) || 0);
      if (alt < dist[neighbor]) {
        dist[neighbor] = alt;
        prev[neighbor] = current;
      }
    });
  }

  if (!Number.isFinite(dist[target])) return null;
  const path = [];
  let cursor = target;
  while (cursor) {
    path.unshift(cursor);
    cursor = prev[cursor];
  }
  return { distance: dist[target], path };
}

function computeMstWeight(nodes, edges) {
  const parent = {};
  const find = (x) => {
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return false;
    parent[rb] = ra;
    return true;
  };

  nodes.forEach((node) => { parent[node] = node; });
  let weight = 0;
  let count = 0;
  edges
    .slice()
    .sort((a, b) => (Number(a.weight) || 0) - (Number(b.weight) || 0))
    .forEach((edge) => {
      if (union(edge.from, edge.to)) {
        weight += Math.max(0, Number(edge.weight) || 0);
        count += 1;
      }
    });
  return count === Math.max(0, nodes.length - 1) ? weight : null;
}

function computeMaxFlow(nodes, edges, source, sink) {
  const nodeSet = new Set(nodes);
  if (!nodeSet.has(source) || !nodeSet.has(sink)) return null;

  const capacity = {};
  const neighbors = {};
  nodes.forEach((node) => {
    capacity[node] = {};
    neighbors[node] = new Set();
  });

  edges.forEach((edge) => {
    const c = Math.max(0, Number(edge.capacity) || 0);
    if (!capacity[edge.from][edge.to]) capacity[edge.from][edge.to] = 0;
    if (!capacity[edge.to][edge.from]) capacity[edge.to][edge.from] = 0;
    capacity[edge.from][edge.to] += c;
    neighbors[edge.from].add(edge.to);
    neighbors[edge.to].add(edge.from);
  });

  let flow = 0;
  while (true) {
    const parent = {};
    const queue = [source];
    parent[source] = null;
    let found = false;
    while (queue.length > 0 && !found) {
      const u = queue.shift();
      neighbors[u].forEach((v) => {
        if (found || Object.prototype.hasOwnProperty.call(parent, v)) return;
        if ((capacity[u][v] || 0) <= 0) return;
        parent[v] = u;
        if (v === sink) {
          found = true;
          return;
        }
        queue.push(v);
      });
    }
    if (!found) break;

    let pathFlow = Number.POSITIVE_INFINITY;
    let v = sink;
    while (v !== source) {
      const u = parent[v];
      pathFlow = Math.min(pathFlow, capacity[u][v] || 0);
      v = u;
    }

    v = sink;
    while (v !== source) {
      const u = parent[v];
      capacity[u][v] -= pathFlow;
      capacity[v][u] += pathFlow;
      neighbors[v].add(u);
      v = u;
    }
    flow += pathFlow;
  }
  return flow;
}

function buildNetworkGraphMarkup(config) {
  const title = escapeHtml(String(config.title || "Network Graph"));
  const nodes = Array.isArray(config.nodes) ? config.nodes : [];
  const edges = Array.isArray(config.edges) ? config.edges : [];
  if (nodes.length === 0 || edges.length === 0) return "";
  const shortest = dijkstra(nodes, edges, config.source, config.target);
  const mst = computeMstWeight(nodes, edges);
  const maxFlow = computeMaxFlow(nodes, edges, config.flowSource, config.flowSink);
  const shortestLine = shortest ? `${shortest.path.join(" -> ")} (cost ${shortest.distance.toFixed(2)})` : "unavailable";
  return `<div class="simple-card"><p class="bar-chart-title">${title}</p><p>Nodes: ${nodes.length}, Edges: ${edges.length}</p><p>Shortest path: ${escapeHtml(shortestLine)}</p><p>MST total weight: ${mst === null ? "unavailable" : mst.toFixed(2)}</p><p>Max flow: ${maxFlow === null ? "unavailable" : maxFlow.toFixed(2)}</p></div>`;
}
function normalizeFractionOperation(value) {
  const operation = String(value || "add").trim().toLowerCase();
  return ["add", "subtract", "multiply", "divide"].includes(operation) ? operation : "add";
}

function gcdFraction(a, b) {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1;
}

function simplifyFraction(numerator, denominator) {
  const n = Math.trunc(Number(numerator));
  const d = Math.trunc(Number(denominator));
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  let nextN = n;
  let nextD = d;
  if (nextD < 0) {
    nextN *= -1;
    nextD *= -1;
  }
  const divisor = gcdFraction(nextN, nextD);
  return {
    numerator: nextN / divisor,
    denominator: nextD / divisor
  };
}

function formatFractionDisplay(fraction) {
  if (!fraction) return "invalid";
  if (fraction.denominator === 1) return `${fraction.numerator}`;
  return `${fraction.numerator}/${fraction.denominator}`;
}

function buildFractionsMarkup(config) {
  const title = escapeHtml(String(config.title || "Fraction Operations"));
  const operation = normalizeFractionOperation(config.operation);
  const labels = {
    add: "+",
    subtract: "-",
    multiply: "x",
    divide: "�"
  };

  const fractionA = simplifyFraction(config.fractionA && config.fractionA.numerator, config.fractionA && config.fractionA.denominator);
  const fractionB = simplifyFraction(config.fractionB && config.fractionB.numerator, config.fractionB && config.fractionB.denominator);

  if (!fractionA || !fractionB) {
    return "<p class='helper-text'>Enter two valid fractions with non-zero denominators.</p>";
  }

  if (operation === "divide" && fractionB.numerator === 0) {
    return "<p class='helper-text'>Division by zero is undefined. Fraction B numerator must not be 0.</p>";
  }

  let rawResult = null;
  if (operation === "add") {
    rawResult = {
      numerator: fractionA.numerator * fractionB.denominator + fractionB.numerator * fractionA.denominator,
      denominator: fractionA.denominator * fractionB.denominator
    };
  } else if (operation === "subtract") {
    rawResult = {
      numerator: fractionA.numerator * fractionB.denominator - fractionB.numerator * fractionA.denominator,
      denominator: fractionA.denominator * fractionB.denominator
    };
  } else if (operation === "multiply") {
    rawResult = {
      numerator: fractionA.numerator * fractionB.numerator,
      denominator: fractionA.denominator * fractionB.denominator
    };
  } else {
    rawResult = {
      numerator: fractionA.numerator * fractionB.denominator,
      denominator: fractionA.denominator * fractionB.numerator
    };
  }

  const result = simplifyFraction(rawResult.numerator, rawResult.denominator);
  if (!result) {
    return "<p class='helper-text'>Could not compute this fraction operation.</p>";
  }

  return `
    <div class="simple-card">
      <p class="bar-chart-title">${title}</p>
      <p>${escapeHtml(formatFractionDisplay(fractionA))} ${labels[operation]} ${escapeHtml(formatFractionDisplay(fractionB))} = ${escapeHtml(formatFractionDisplay(result))}</p>
      <p class="helper-text">Result (simplified): ${escapeHtml(formatFractionDisplay(result))}</p>
    </div>
  `;
}

function normalizeMatrixOperation(value) {
  const operation = String(value || "multiply").trim().toLowerCase();
  return ["add", "subtract", "multiply", "determinant", "transpose"].includes(operation) ? operation : "multiply";
}

function sanitizeMatrix(matrix) {
  if (!Array.isArray(matrix)) return [];
  return matrix
    .map((row) => (Array.isArray(row) ? row : []))
    .map((row) => row.map((value) => Number(value)).filter((value) => Number.isFinite(value)))
    .filter((row) => row.length > 0);
}

function matrixIsRectangular(matrix) {
  if (!Array.isArray(matrix) || matrix.length === 0) return false;
  const width = matrix[0].length;
  return width > 0 && matrix.every((row) => Array.isArray(row) && row.length === width && row.every((value) => Number.isFinite(value)));
}

function matrixDimensions(matrix) {
  if (!matrixIsRectangular(matrix)) return "invalid";
  return `${matrix.length}x${matrix[0].length}`;
}

function matrixAdd(a, b) {
  if (!matrixIsRectangular(a) || !matrixIsRectangular(b)) return null;
  if (a.length !== b.length || a[0].length !== b[0].length) return null;
  return a.map((row, rowIndex) => row.map((value, colIndex) => value + b[rowIndex][colIndex]));
}

function matrixSubtract(a, b) {
  if (!matrixIsRectangular(a) || !matrixIsRectangular(b)) return null;
  if (a.length !== b.length || a[0].length !== b[0].length) return null;
  return a.map((row, rowIndex) => row.map((value, colIndex) => value - b[rowIndex][colIndex]));
}

function matrixMultiply(a, b) {
  if (!matrixIsRectangular(a) || !matrixIsRectangular(b)) return null;
  if (a[0].length !== b.length) return null;
  return a.map((row) => b[0].map((_, colIndex) => row.reduce((sum, value, k) => sum + value * b[k][colIndex], 0)));
}

function matrixTranspose(a) {
  if (!matrixIsRectangular(a)) return null;
  return a[0].map((_, colIndex) => a.map((row) => row[colIndex]));
}

function matrixDeterminant(matrix) {
  if (!matrixIsRectangular(matrix)) return Number.NaN;
  const size = matrix.length;
  if (size !== matrix[0].length) return Number.NaN;
  if (size === 1) return matrix[0][0];
  if (size === 2) return matrix[0][0] * matrix[1][1] - matrix[0][1] * matrix[1][0];
  let total = 0;
  for (let col = 0; col < size; col += 1) {
    const minor = matrix.slice(1).map((row) => row.filter((_, index) => index !== col));
    total += (col % 2 === 0 ? 1 : -1) * matrix[0][col] * matrixDeterminant(minor);
  }
  return total;
}

function formatMatrixNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "?";
  const rounded = Math.round(numeric * 1000) / 1000;
  return String(rounded);
}

function buildMatrixTableMarkup(matrix, caption) {
  if (!matrixIsRectangular(matrix)) {
    return `<div class="simple-card"><p>${escapeHtml(caption)}: invalid matrix</p></div>`;
  }
  const rows = matrix
    .map((row) => `<tr>${row.map((value) => `<td style="border:1px solid #cbd5e1;padding:4px 8px;text-align:right;">${escapeHtml(formatMatrixNumber(value))}</td>`).join("")}</tr>`)
    .join("");
  return `
    <div class="simple-card">
      <p><strong>${escapeHtml(caption)}</strong> (${matrix.length}x${matrix[0].length})</p>
      <table style="border-collapse:collapse; margin-top:6px;">
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function buildMatrixMarkup(config) {
  const title = escapeHtml(String(config.title || "Matrix Operations"));
  const operation = normalizeMatrixOperation(config.operation);
  const matrixA = sanitizeMatrix(config.matrixA);
  const matrixB = sanitizeMatrix(config.matrixB);

  if (!matrixIsRectangular(matrixA)) {
    return "<p class='helper-text'>Enter a valid rectangular matrix A to preview matrix operations.</p>";
  }

  const labels = {
    add: "A + B",
    subtract: "A - B",
    multiply: "A x B",
    determinant: "det(A)",
    transpose: "A^T"
  };

  let resultMarkup = "";
  if (operation === "add") {
    const result = matrixAdd(matrixA, matrixB);
    resultMarkup = result
      ? buildMatrixTableMarkup(result, "Result")
      : "<p class='helper-text'>For addition, A and B must have the same dimensions.</p>";
  } else if (operation === "subtract") {
    const result = matrixSubtract(matrixA, matrixB);
    resultMarkup = result
      ? buildMatrixTableMarkup(result, "Result")
      : "<p class='helper-text'>For subtraction, A and B must have the same dimensions.</p>";
  } else if (operation === "multiply") {
    const result = matrixMultiply(matrixA, matrixB);
    resultMarkup = result
      ? buildMatrixTableMarkup(result, "Result")
      : "<p class='helper-text'>For multiplication, columns in A must equal rows in B.</p>";
  } else if (operation === "determinant") {
    const determinant = matrixDeterminant(matrixA);
    resultMarkup = Number.isFinite(determinant)
      ? `<div class="simple-card"><p><strong>det(A)</strong> = ${escapeHtml(formatMatrixNumber(determinant))}</p></div>`
      : "<p class='helper-text'>Determinant requires A to be a square matrix.</p>";
  } else {
    const result = matrixTranspose(matrixA);
    resultMarkup = result ? buildMatrixTableMarkup(result, "A^T") : "<p class='helper-text'>Transpose requires a valid matrix A.</p>";
  }

  return `
    <div class="simple-card">
      <p class="bar-chart-title">${title}</p>
      <p>Operation: ${escapeHtml(labels[operation])}</p>
      <p class="helper-text">A dimensions: ${escapeHtml(matrixDimensions(matrixA))}${operation === "add" || operation === "subtract" || operation === "multiply" ? ` | B dimensions: ${escapeHtml(matrixDimensions(matrixB))}` : ""}</p>
    </div>
    ${buildMatrixTableMarkup(matrixA, "Matrix A")}
    ${(operation === "add" || operation === "subtract" || operation === "multiply") && matrixB.length > 0 ? buildMatrixTableMarkup(matrixB, "Matrix B") : ""}
    ${resultMarkup}
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

function normalizeArithmeticLayout(value) {
  return String(value || "horizontal").trim().toLowerCase() === "vertical" ? "vertical" : "horizontal";
}

function computeArithmeticAnswerFromConfig(config) {
  const a = Number.parseInt(config && config.operandA, 10);
  const b = Number.parseInt(config && config.operandB, 10);
  const operator = String(config && config.operator ? config.operator : "+").trim();
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return String(config && config.answer ? config.answer : "").trim();
  }

  if (operator === "-") return String(a - b);
  if (operator === "x" || operator === "*") return String(a * b);
  if (operator === "/" && b !== 0) return String(a / b);
  return String(a + b);
}

function buildArithmeticAnswerBoxes(answerText, { readOnly = false, minDigits = 1 } = {}) {
  const cleaned = String(answerText || "").trim();
  const requiredDigits = Math.max(1, Number.parseInt(minDigits, 10) || 1);
  const inferredDigits = Math.max(1, cleaned.replace(/[^0-9-]/g, "").length || cleaned.length || 1);
  const digits = Math.max(requiredDigits, inferredDigits, 1);
  // Right-align answer digits so the last digit lands in the last box
  const chars = splitArithmeticDigits(cleaned, digits);
  const boxes = [];
  for (let index = 0; index < digits; index += 1) {
    const value = chars[index] || "";
    const attrs = readOnly
      ? `value="${escapeHtml(value)}" readonly disabled`
      : "value=\"\"";
    boxes.push(`<input class="arithmetic-digit-input" type="text" inputmode="numeric" maxlength="1" ${attrs} data-index="${index}" autocomplete="off" />`);
  }
  return boxes.join("");
}

function buildArithmeticCarryBoxes(columns, { readOnly = false } = {}) {
  const count = Math.max(1, Number.parseInt(columns, 10) || 1);
  const attrs = readOnly ? "readonly disabled" : "";
  const boxes = [];
  for (let index = 0; index < count; index += 1) {
    boxes.push(`<input class="arithmetic-carry-input" type="text" inputmode="numeric" maxlength="1" value="" ${attrs} data-carry-index="${index}" autocomplete="off" />`);
  }
  return boxes.join("");
}

function buildArithmeticWorkBoxes(columns, { readOnly = false, rowIndex = 0 } = {}) {
  const count = Math.max(1, Number.parseInt(columns, 10) || 1);
  const attrs = readOnly ? "readonly disabled" : "value=\"\"";
  const boxes = [];
  for (let index = 0; index < count; index += 1) {
    boxes.push(`<input class="arithmetic-work-input" type="text" inputmode="numeric" maxlength="1" ${attrs} data-work-row="${rowIndex}" data-work-index="${index}" autocomplete="off" />`);
  }
  return boxes.join("");
}

function buildArithmeticWorkRows(columns, rowCount, { readOnly = false } = {}) {
  const count = Math.max(0, Number.parseInt(rowCount, 10) || 0);
  if (count === 0) return "";
  const rows = [];
  for (let rowIndex = 0; rowIndex < count; rowIndex += 1) {
    rows.push(`<div class="arithmetic-work-row"><span class="arithmetic-op-spacer"></span><span class="arithmetic-work-cells">${buildArithmeticWorkBoxes(columns, { readOnly, rowIndex })}</span></div>`);
  }
  return rows.join("");
}

function splitArithmeticDigits(value, columns) {
  const count = Math.max(1, Number.parseInt(columns, 10) || 1);
  const text = String(value == null ? "" : value).trim().replace(/\s+/g, "");
  if (!text) return new Array(count).fill("");
  const chars = text.split("");
  const clipped = chars.slice(-count);
  const padding = new Array(Math.max(0, count - clipped.length)).fill("");
  return padding.concat(clipped);
}

function buildArithmeticOperandCells(value, columns) {
  const chars = splitArithmeticDigits(value, columns);
  return chars
    .map((char) => `<span class="arithmetic-cell">${escapeHtml(char)}</span>`)
    .join("");
}

function buildArithmeticOperandCellsWithCornerCarry(value, columns, { readOnly = false } = {}) {
  const chars = splitArithmeticDigits(value, columns);
  return chars
    .map((char, index) => {
      const carry = readOnly
        ? `<input class="arithmetic-corner-carry" type="text" inputmode="numeric" maxlength="1" value="" readonly disabled data-corner-index="${index}" autocomplete="off" />`
        : `<input class="arithmetic-corner-carry" type="text" inputmode="numeric" maxlength="1" value="" data-corner-index="${index}" autocomplete="off" />`;
      return `<span class="arithmetic-cell arithmetic-cell-with-carry">${escapeHtml(char)}${carry}</span>`;
    })
    .join("");
}

function buildArithmeticSingleInput(answerText, { readOnly = false } = {}) {
  const value = String(answerText || "").trim();
  const minLength = Math.max(2, value.length, 2);
  const attrs = readOnly
    ? `value="${escapeHtml(value)}" readonly disabled`
    : "value=\"\"";
  return `<input class="arithmetic-single-input" type="text" inputmode="numeric" ${attrs} autocomplete="off" style="min-width:${minLength}ch" />`;
}

function buildArithmeticWorkspaceMarkup(config, { readOnly = false, revealAnswer = false } = {}) {
  const layout = normalizeArithmeticLayout(config && config.layout);
  const operatorRaw = String(config && config.operator ? config.operator : "+").trim() || "+";
  const operator = escapeHtml(operatorRaw);
  const operandAText = String(config && config.operandA != null ? config.operandA : "").trim();
  const operandBText = String(config && config.operandB != null ? config.operandB : "").trim();
  const operandA = escapeHtml(operandAText);
  const operandB = escapeHtml(operandBText);
  const answerText = revealAnswer
    ? computeArithmeticAnswerFromConfig(config || {})
    : "";
  const answerDigits = String(answerText || "").trim();
  const operandALen = Math.max(1, operandAText.replace(/[^0-9]/g, "").length || operandAText.length || 1);
  const operandBLen = Math.max(1, operandBText.replace(/[^0-9]/g, "").length || operandBText.length || 1);
  const answerLen = Math.max(1, answerDigits.replace(/[^0-9]/g, "").length || answerDigits.length || 1);
  const baseColumns = Math.max(operandALen, operandBLen, answerLen, 1);
  const hasLeadingCarrySpace = ["+", "-", "x", "*"].includes(operatorRaw);
  const columnCount = hasLeadingCarrySpace ? Math.max(baseColumns + 1, answerLen) : Math.max(baseColumns, answerLen);

  const boxes = layout === "vertical"
    ? buildArithmeticAnswerBoxes(answerText, { readOnly, minDigits: columnCount })
    : buildArithmeticSingleInput(answerText, { readOnly });

  if (layout === "vertical") {
    const isMultiplication = ["x", "*"].includes(operatorRaw);
    const workRows = isMultiplication
      ? buildArithmeticWorkRows(columnCount, Math.max(1, operandBLen), { readOnly })
      : "";
    // Multiplication: small corner carry boxes on operand A cells; addition/subtraction: separate carry row above
    const operandACells = isMultiplication
      ? buildArithmeticOperandCellsWithCornerCarry(operandAText, columnCount, { readOnly })
      : buildArithmeticOperandCells(operandAText, columnCount);
    const showCarryRow = ["+", "-"].includes(operatorRaw);
    const carryRow = showCarryRow
      ? `<div class="arithmetic-carry-row"><span class="arithmetic-op-spacer"></span><span class="arithmetic-carry-cells">${buildArithmeticCarryBoxes(columnCount, { readOnly })}</span></div>`
      : "";
    return `
      <div class="arithmetic-workspace arithmetic-layout-vertical">
        <div class="arithmetic-vertical-stack">
          ${carryRow}
          <div class="arithmetic-row"><span class="arithmetic-op-spacer"></span><span class="arithmetic-number-cells">${operandACells}</span></div>
          <div class="arithmetic-row"><span class="arithmetic-operator">${operator}</span><span class="arithmetic-number-cells">${buildArithmeticOperandCells(operandBText, columnCount)}</span></div>
          ${workRows}
          <div class="arithmetic-answer-row"><span class="arithmetic-op-spacer"></span><span class="arithmetic-answer-cells">${boxes}</span></div>
        </div>
      </div>
    `;
  }

  return `
    <div class="arithmetic-workspace arithmetic-layout-horizontal">
      <div class="arithmetic-horizontal-expression">
        <span class="arithmetic-number">${operandA}</span>
        <span class="arithmetic-operator">${operator}</span>
        <span class="arithmetic-number">${operandB}</span>
        <span class="arithmetic-equals">=</span>
        <span class="arithmetic-answer-row arithmetic-answer-inline">${boxes}</span>
      </div>
    </div>
  `;
}

function wireArithmeticAnswerInputs() {
  const blockNonTypingInput = (input) => {
    input.addEventListener("beforeinput", (event) => {
      if (event.inputType === "insertFromPaste" || event.inputType === "insertFromDrop") {
        event.preventDefault();
      }
    });

    input.addEventListener("paste", (event) => {
      event.preventDefault();
    });

    input.addEventListener("drop", (event) => {
      event.preventDefault();
    });

    input.addEventListener("keydown", (event) => {
      const key = String(event.key || "").toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "v") {
        event.preventDefault();
      }
      if (event.shiftKey && key === "insert") {
        event.preventDefault();
      }
    });
  };

  const singleInputs = Array.from(document.querySelectorAll(".arithmetic-single-input"))
    .filter((node) => node instanceof HTMLInputElement && !node.disabled);
  singleInputs.forEach((input) => {
    blockNonTypingInput(input);
    input.addEventListener("input", () => {
      input.value = String(input.value || "").replace(/\s+/g, "");
    });
  });

  const inputs = Array.from(document.querySelectorAll(".arithmetic-digit-input"))
    .filter((node) => node instanceof HTMLInputElement && !node.disabled);
  const workInputs = Array.from(document.querySelectorAll(".arithmetic-work-input"))
    .filter((node) => node instanceof HTMLInputElement && !node.disabled);
  const carryInputs = Array.from(document.querySelectorAll(".arithmetic-carry-input"))
    .filter((node) => node instanceof HTMLInputElement && !node.disabled);
  if (singleInputs.length > 0) {
    singleInputs[0].focus();
    return;
  }
  if (inputs.length === 0) return;

  inputs.forEach((input, index) => {
    blockNonTypingInput(input);
    input.addEventListener("input", () => {
      input.value = String(input.value || "").slice(-1);
      if (input.value && index < inputs.length - 1) {
        inputs[index + 1].focus();
      }
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Backspace" && !input.value && index > 0) {
        inputs[index - 1].focus();
      }
    });
  });

  carryInputs.forEach((input, index) => {
    blockNonTypingInput(input);
    input.addEventListener("input", () => {
      input.value = String(input.value || "").slice(-1);
      if (input.value && index < carryInputs.length - 1) {
        carryInputs[index + 1].focus();
      }
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Backspace" && !input.value && index > 0) {
        carryInputs[index - 1].focus();
      }
    });
  });

  workInputs.forEach((input, index) => {
    blockNonTypingInput(input);
    input.addEventListener("input", () => {
      input.value = String(input.value || "").slice(-1);
      if (input.value && index < workInputs.length - 1) {
        workInputs[index + 1].focus();
      }
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Backspace" && !input.value && index > 0) {
        workInputs[index - 1].focus();
      }
    });
  });

  const cornerInputs = Array.from(document.querySelectorAll(".arithmetic-corner-carry"))
    .filter((node) => node instanceof HTMLInputElement && !node.disabled);
  cornerInputs.forEach((input) => {
    blockNonTypingInput(input);
    input.addEventListener("input", () => {
      input.value = String(input.value || "").slice(-1);
    });
  });

  inputs[0].focus();
}

function stripLeadingZeros(value) {
  const str = String(value || "").trim();
  if (!str) return str;
  const negative = str.startsWith("-");
  const digits = negative ? str.slice(1) : str;
  const stripped = digits.replace(/^0+/, "") || "0";
  return negative ? "-" + stripped : stripped;
}

function collectArithmeticWorkspaceAnswer(root) {
  const scope = root || document;
  const singleInput = scope.querySelector(".arithmetic-single-input");
  if (singleInput instanceof HTMLInputElement) {
    return stripLeadingZeros(singleInput.value);
  }
  const inputs = Array.from(scope.querySelectorAll(".arithmetic-digit-input"))
    .filter((node) => node instanceof HTMLInputElement);
  if (inputs.length === 0) return "";
  const raw = inputs.map((input) => String(input.value || "").trim()).join("");
  return stripLeadingZeros(raw);
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
    if (type === "cartesian-plane-plot") return "Interactive: Cartesian Plane - Plot";
  if (type === "arithmetic") return "Interactive: Arithmetic Workspace";
  if (type === "bar-chart") return "Interactive: Bar Chart";
  if (type === "histogram") return "Interactive: Histogram";
  if (type === "box-plot") return "Interactive: Box Plot";
  if (type === "scatter-plot") return "Interactive: Scatter Plot";
  if (type === "probability-tree") return "Interactive: Probability Tree";
  if (type === "distribution-curve") return "Interactive: Distribution Curve";
  if (type === "fractions") return "Interactive: Fractions";
  if (type === "network-graph") return "Interactive: Network Graph";
  if (type === "matrix") return "Interactive: Matrices";
  if (type === "stem-and-leaf") return "Interactive: Stem-and-Leaf Plot";
  if (type === "geometry-shapes") return "Interactive: Geometry Shapes";
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
    } else if (app.type === "cartesian-plane-plot") {
      content = buildCartesianPlotSvgString(app.config || {}, [], true);
  } else if (app.type === "arithmetic") {
    content = buildArithmeticWorkspaceMarkup(app.config || {}, { readOnly: true, revealAnswer: true });
  } else if (app.type === "bar-chart") {
    content = buildBarChartMarkup(app.config || {});
  } else if (app.type === "histogram") {
    content = buildHistogramMarkup(app.config || {});
  } else if (app.type === "box-plot") {
    content = buildBoxPlotMarkup(app.config || {});
  } else if (app.type === "scatter-plot") {
    content = buildScatterPlotMarkup(app.config || {});
  } else if (app.type === "probability-tree") {
    content = buildProbabilityTreeMarkup(app.config || {});
  } else if (app.type === "distribution-curve") {
    content = buildDistributionCurveMarkup(app.config || {});
  } else if (app.type === "fractions") {
    content = buildFractionsMarkup(app.config || {});
  } else if (app.type === "network-graph") {
    content = buildNetworkGraphMarkup(app.config || {});
  } else if (app.type === "matrix") {
    content = buildMatrixMarkup(app.config || {});
  } else if (app.type === "stem-and-leaf") {
    content = buildStemLeafMarkup(app.config || {});
  } else if (app.type === "geometry-shapes") {
    content = buildGeometryShapesSvgString(app.config || {});
  } else if (app.type === "pythagoras") {
    content = buildPythagorasMarkup(app.config || {});
  } else if (app.type === "trigonometry") {
    content = buildTrigonometryMarkup(app.config || {});
  }

  preview.innerHTML = content || "<p class='helper-text'>No interactive preview available.</p>";
}

function getSvgPointerPosition(svg, event) {
  if (!(svg instanceof SVGElement)) return null;
  const viewBox = svg.viewBox && svg.viewBox.baseVal
    ? svg.viewBox.baseVal
    : { x: 0, y: 0, width: svg.clientWidth || 1, height: svg.clientHeight || 1 };
  const rect = svg.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    x: viewBox.x + ((event.clientX - rect.left) / rect.width) * viewBox.width,
    y: viewBox.y + ((event.clientY - rect.top) / rect.height) * viewBox.height
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function syncNumberLineControls(host, app) {
  const points = Array.isArray(app.config && app.config.points) ? app.config.points : [];
  points.forEach((point, index) => {
    host.querySelectorAll(`[data-index="${index}"]`).forEach((input) => {
      input.value = String(point.value);
    });
  });
}

function syncCartesianControls(host, app) {
  const points = Array.isArray(app.config && app.config.points) ? app.config.points : [];
  points.forEach((point, index) => {
    const xInput = host.querySelector(`[data-role='cartesian-x'][data-index='${index}']`);
    const yInput = host.querySelector(`[data-role='cartesian-y'][data-index='${index}']`);
    if (xInput) xInput.value = String(point.x);
    if (yInput) yInput.value = String(point.y);
  });
}

function attachNumberLineDragging(host, app, render) {
  const svg = host.querySelector(".interactive-app-preview svg");
  const points = Array.isArray(app.config && app.config.points) ? app.config.points : [];
  const min = Number.isFinite(Number(app.config && app.config.min)) ? Number(app.config.min) : -10;
  const max = Number.isFinite(Number(app.config && app.config.max)) ? Number(app.config.max) : 10;
  if (!(svg instanceof SVGElement) || points.length === 0) return;

  svg.querySelectorAll(".interactive-draggable-point[data-point-type='number-line']").forEach((node) => {
    node.addEventListener("pointerdown", (event) => {
      const index = Number.parseInt(node.dataset.pointIndex || "", 10);
      if (!Number.isInteger(index) || !points[index]) return;
      event.preventDefault();

      const move = (moveEvent) => {
        const pos = getSvgPointerPosition(svg, moveEvent);
        if (!pos) return;
        const usable = 600 - 50 * 2;
        const rawValue = min + ((pos.x - 50) / usable) * (max - min);
        points[index].value = Math.round(clamp(rawValue, min, max));
        render();
      };

      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop);
    });
  });
}

function attachCartesianDragging(host, app, render) {
  const svg = host.querySelector(".interactive-app-preview svg");
  const points = Array.isArray(app.config && app.config.points) ? app.config.points : [];
  const xMin = Number.isFinite(Number(app.config && app.config.xMin)) ? Number(app.config.xMin) : -10;
  const xMax = Number.isFinite(Number(app.config && app.config.xMax)) ? Number(app.config.xMax) : 10;
  const yMin = Number.isFinite(Number(app.config && app.config.yMin)) ? Number(app.config.yMin) : -10;
  const yMax = Number.isFinite(Number(app.config && app.config.yMax)) ? Number(app.config.yMax) : 10;
  if (!(svg instanceof SVGElement) || points.length === 0) return;

  svg.querySelectorAll(".interactive-draggable-point[data-point-type='cartesian-plane']").forEach((node) => {
    node.addEventListener("pointerdown", (event) => {
      const index = Number.parseInt(node.dataset.pointIndex || "", 10);
      if (!Number.isInteger(index) || !points[index]) return;
      event.preventDefault();

      const move = (moveEvent) => {
        const pos = getSvgPointerPosition(svg, moveEvent);
        if (!pos) return;
        const pad = 36;
        const usable = 320 - pad * 2;
        const xValue = xMin + ((pos.x - pad) / usable) * (xMax - xMin);
        const yValue = yMin + ((320 - pad - pos.y) / usable) * (yMax - yMin);
        points[index].x = Math.round(clamp(xValue, xMin, xMax));
        points[index].y = Math.round(clamp(yValue, yMin, yMax));
        render();
      };

      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop);
    });
  });
}

function attachGeometryDragging(host, app, render) {
  const svg = host.querySelector(".interactive-app-preview svg");
  const config = app.config || {};
  const shapes = Array.isArray(config.shapes) ? config.shapes : [];
  const width = Math.max(220, Math.min(760, Number.parseInt(config.canvasWidth, 10) || 360));
  const height = Math.max(180, Math.min(520, Number.parseInt(config.canvasHeight, 10) || 260));
  if (!(svg instanceof SVGElement) || shapes.length === 0) return;

  svg.querySelectorAll(".interactive-draggable-point[data-point-type='geometry-shapes']").forEach((node) => {
    node.addEventListener("pointerdown", (event) => {
      const index = Number.parseInt(node.dataset.pointIndex || "", 10);
      if (!Number.isInteger(index) || !shapes[index]) return;
      event.preventDefault();

      const move = (moveEvent) => {
        const pos = getSvgPointerPosition(svg, moveEvent);
        if (!pos) return;
        shapes[index].x = roundInteractive(clamp(pos.x, 8, width - 8), 1);
        shapes[index].y = roundInteractive(clamp(pos.y, 8, height - 8), 1);
        render();
      };

      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop);
    });
  });
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

function formatGraphValue(value) {
  return String(roundInteractive(value, 3));
}

function evaluateSimpleMathExpression(raw, xValue = null) {
  const source = String(raw || "").trim();
  if (!source) return Number.NaN;
  if (!/^[0-9x+\-*/().\s^pie]+$/i.test(source)) {
    return Number.NaN;
  }

  const normalized = source
    .toLowerCase()
    .replace(/\^/g, "**")
    .replace(/(\d)\s*x\b/g, "$1*x")
    .replace(/\)\s*x\b/g, ")*x")
    .replace(/\bx\s*\(/g, "x*(")
    .replace(/(\d)\s*\(/g, "$1*(")
    .replace(/\bpi\b/g, "PI")
    .replace(/\be\b/g, "E");

  try {
    const fn = new Function("x", "const {PI,E}=Math; return (" + normalized + ");");
    const value = Number(fn(xValue));
    return Number.isFinite(value) ? value : Number.NaN;
  } catch (error) {
    return Number.NaN;
  }
}

function parseTrigFunctionParameters(expression) {
  const raw = String(expression || "").trim();
  if (!raw) return null;
  const normalized = raw.toLowerCase().replace(/^y\s*=\s*/, "").replace(/\s+/g, "");
  const trigMatch = normalized.match(/(sin|cos|tan)\(/);
  if (!trigMatch) return null;

  const trigType = trigMatch[1];
  const fnStart = trigMatch.index;
  const openIndex = fnStart + trigType.length;
  let depth = 0;
  let closeIndex = -1;
  for (let i = openIndex; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        closeIndex = i;
        break;
      }
    }
  }
  if (closeIndex < 0) return null;

  const prefixRaw = normalized.slice(0, fnStart);
  const insideRaw = normalized.slice(openIndex + 1, closeIndex);
  const suffixRaw = normalized.slice(closeIndex + 1);

  const prefix = prefixRaw.endsWith("*") ? prefixRaw.slice(0, -1) : prefixRaw;
  const aValue = prefix === "" || prefix === "+" ? 1 : prefix === "-" ? -1 : evaluateSimpleMathExpression(prefix);
  if (!Number.isFinite(aValue)) return null;

  const dValue = suffixRaw === "" ? 0 : evaluateSimpleMathExpression(suffixRaw);
  if (!Number.isFinite(dValue)) return null;

  const k0 = evaluateSimpleMathExpression(insideRaw, 0);
  const k1 = evaluateSimpleMathExpression(insideRaw, 1);
  const k2 = evaluateSimpleMathExpression(insideRaw, 2);
  if (![k0, k1, k2].every(Number.isFinite)) return null;
  const bValue = k1 - k0;
  if (!Number.isFinite(bValue) || Math.abs(bValue) < 1e-9) return null;
  const linearAt2 = 2 * bValue + k0;
  if (Math.abs(linearAt2 - k2) > 1e-4) return null;

  const cValue = -k0 / bValue;
  const period = (trigType === "tan" ? Math.PI : 2 * Math.PI) / Math.abs(bValue);
  return {
    trigType,
    a: aValue,
    b: bValue,
    c: cValue,
    d: dValue,
    period
  };
}

function normalizeAngleMode(value) {
  return String(value || "radians").trim().toLowerCase() === "degrees" ? "degrees" : "radians";
}

function gcd(a, b) {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1;
}

function formatRadiansAsPi(value) {
  const radians = Number(value);
  if (!Number.isFinite(radians)) return `${formatGraphValue(value)} rad`;
  if (Math.abs(radians) < 1e-10) return "0";

  const sign = radians < 0 ? "-" : "";
  const ratio = Math.abs(radians) / Math.PI;
  const maxDen = 24;
  let bestNum = 0;
  let bestDen = 1;
  let bestErr = Number.POSITIVE_INFINITY;

  for (let den = 1; den <= maxDen; den += 1) {
    const num = Math.round(ratio * den);
    const err = Math.abs(ratio - num / den);
    if (err < bestErr) {
      bestErr = err;
      bestNum = num;
      bestDen = den;
    }
  }

  if (bestErr > 0.003) {
    return `${formatGraphValue(radians)} rad`;
  }

  const divisor = gcd(bestNum, bestDen);
  const num = bestNum / divisor;
  const den = bestDen / divisor;
  if (den === 1) {
    if (num === 1) return `${sign}π`;
    return `${sign}${num}π`;
  }
  if (num === 1) return `${sign}π/${den}`;
  return `${sign}${num}π/${den}`;
}

function formatAngleDual(value, preferredMode) {
  const radiansText = formatRadiansAsPi(value);
  const degreesText = `${formatGraphValue((Number(value) * 180) / Math.PI)}°`;
  if (normalizeAngleMode(preferredMode) === "degrees") {
    return `${degreesText} (${radiansText})`;
  }
  return `${radiansText} (${degreesText})`;
}

function describeTrigFunctionInsights(item, index, angleMode = "radians") {
  const label = String(item.label || `f${index + 1}`).trim();
  const parsed = parseTrigFunctionParameters(item.expression || "");
  if (!parsed) {
    return `${label}: trig parameters unavailable (use standard form like A*sin(B*(x-C))+D).`;
  }

  const mode = normalizeAngleMode(angleMode);
  const periodText = formatAngleDual(parsed.period, mode);
  const phaseText = formatAngleDual(parsed.c, mode);

  if (parsed.trigType === "tan") {
    return `${label}: tan graph, stretch |A|=${formatGraphValue(Math.abs(parsed.a))}, period=${periodText}, phase shift=${phaseText}, vertical shift=${formatGraphValue(parsed.d)}.`;
  }

  return `${label}: ${parsed.trigType} graph, amplitude=${formatGraphValue(Math.abs(parsed.a))}, period=${periodText}, phase shift=${phaseText}, vertical shift=${formatGraphValue(parsed.d)}.`;
}

function describeParabolaInsights(curve, index) {
  const a = Number(curve.a);
  const b = Number(curve.b);
  const c = Number(curve.c);
  if (![a, b, c].every(Number.isFinite)) return "";

  const name = String(curve.label || `p${index + 1}`).trim();
  if (a === 0) {
    return `${name}: not quadratic (a = 0).`;
  }

  const vx = -b / (2 * a);
  const vy = a * vx * vx + b * vx + c;
  const discriminant = b * b - 4 * a * c;
  let rootsText = "no real roots";

  if (discriminant > 0) {
    const root1 = (-b - Math.sqrt(discriminant)) / (2 * a);
    const root2 = (-b + Math.sqrt(discriminant)) / (2 * a);
    rootsText = `roots x = ${formatGraphValue(root1)}, ${formatGraphValue(root2)}`;
  } else if (discriminant === 0) {
    const root = -b / (2 * a);
    rootsText = `double root x = ${formatGraphValue(root)}`;
  }

  const turningType = a > 0 ? "minimum" : "maximum";
  return `${name}: turning point (${formatGraphValue(vx)}, ${formatGraphValue(vy)}) [${turningType}], ${rootsText}`;
}

function approximateFunctionRoots(evaluate, xMin, xMax, samples = 160) {
  if (typeof evaluate !== "function") return [];
  const roots = [];
  let prevX = xMin;
  let prevY = evaluate(prevX);
  const step = (xMax - xMin) / samples;

  for (let i = 1; i <= samples; i += 1) {
    const x = xMin + i * step;
    const y = evaluate(x);
    if (!Number.isFinite(y) || !Number.isFinite(prevY)) {
      prevX = x;
      prevY = y;
      continue;
    }

    if (Math.abs(y) < 1e-6) {
      roots.push(x);
    } else if (Math.abs(prevY) < 1e-6) {
      roots.push(prevX);
    } else if ((prevY < 0 && y > 0) || (prevY > 0 && y < 0)) {
      let leftX = prevX;
      let rightX = x;
      let leftY = prevY;
      for (let j = 0; j < 16; j += 1) {
        const midX = (leftX + rightX) / 2;
        const midY = evaluate(midX);
        if (!Number.isFinite(midY)) break;
        if ((leftY < 0 && midY > 0) || (leftY > 0 && midY < 0)) {
          rightX = midX;
        } else {
          leftX = midX;
          leftY = midY;
        }
      }
      roots.push((leftX + rightX) / 2);
    }

    prevX = x;
    prevY = y;
  }

  const unique = [];
  roots
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b)
    .forEach((value) => {
      if (unique.length === 0 || Math.abs(unique[unique.length - 1] - value) > 0.12) {
        unique.push(value);
      }
    });
  return unique;
}

function buildCartesianDetailLines(app) {
  const config = app.config || {};
  const angleMode = normalizeAngleMode(config.angleMode || "radians");
  const points = Array.isArray(config.points) ? config.points : [];
  const segments = Array.isArray(config.segments) ? config.segments : [];
  const parabolas = Array.isArray(config.parabolas) ? config.parabolas : [];
  const functionsList = Array.isArray(config.functions) ? config.functions : [];
  const pointSummary = points.length > 0
    ? `Current coordinates: ${points.map((point, index) => `${point.label || `Point ${index + 1}`} (${point.x}, ${point.y})`).join(", ")}`
    : "Current coordinates: none";
  const segmentSummary = segments.length > 0
    ? `Reference segments: ${segments.map((segment) => `${segment.label || "segment"} [(${segment.x1}, ${segment.y1}) to (${segment.x2}, ${segment.y2})]`).join(" | ")}`
    : "Reference segments: none";
  const parabolaSummary = parabolas.length > 0
    ? `Parabolas: ${parabolas.map((curve, index) => `${curve.label || `p${index + 1}`}: y = ${curve.a}x^2 + ${curve.b}x + ${curve.c}`).join(" | ")}`
    : "Parabolas: none";
  const parabolaInsights = parabolas.length > 0
    ? `Parabola analysis: ${parabolas.map((curve, index) => describeParabolaInsights(curve, index)).filter((line) => line !== "").join(" | ") || "not available"}`
    : "Parabola analysis: none";
  const functionSummary = functionsList.length > 0
    ? `Functions: ${functionsList.map((item, index) => `${item.label || `f${index + 1}`}: y = ${item.expression}`).join(" | ")}`
    : "Functions: none";
  const trigSummary = functionsList.length > 0
    ? `Trig analysis (${angleMode}): ${functionsList.map((item, index) => describeTrigFunctionInsights(item, index, angleMode)).join(" | ")}`
    : "Trig analysis: none";
  const xMin = Number.isFinite(Number(config.xMin)) ? Number(config.xMin) : -10;
  const xMax = Number.isFinite(Number(config.xMax)) ? Number(config.xMax) : 10;
  const functionRootSummary = functionsList.length > 0
    ? `Function roots (approx): ${functionsList.map((item, index) => {
      const evaluator = buildCartesianExpressionEvaluator(item.expression || "");
      const roots = evaluator ? approximateFunctionRoots(evaluator, xMin, xMax) : [];
      return `${item.label || `f${index + 1}`}: ${roots.length > 0 ? roots.map((root) => formatGraphValue(root)).join(", ") : "none in range"}`;
    }).join(" | ")}`
    : "Function roots (approx): none";
  return [pointSummary, segmentSummary, parabolaSummary, parabolaInsights, functionSummary, trigSummary, functionRootSummary, `Angle mode: ${angleMode}`, `Axes range: x ${config.xMin} to ${config.xMax}, y ${config.yMin} to ${config.yMax}`];
}

function buildBarChartDetailLines(app) {
  const config = app.config || {};
  const items = Array.isArray(config.items) ? config.items : [];
  if (items.length === 0) {
    return ["Categories: none", "Frequencies: none"];
  }

  const maxItem = Math.max(...items.map((item) => Number(item.frequency) || 0), 1);
  const yMax = Number.isFinite(Number(config.yMax)) && Number(config.yMax) > 0
    ? Number(config.yMax)
    : Math.ceil(maxItem / 5) * 5;
  const total = items.reduce((sum, item) => sum + Math.max(0, Number(item.frequency) || 0), 0);
  const rows = items.map((item) => `${item.category || "Item"} = ${Math.max(0, Number(item.frequency) || 0)}`);
  return [
    `Chart title: ${config.title || "Category Frequencies"}`,
    `Orientation: ${String(config.orientation || "vertical").trim().toLowerCase() === "horizontal" ? "horizontal" : "vertical"}`,
    `Category axis label: ${config.categoryAxisLabel || "Category"}`,
    `Value axis label: ${config.valueAxisLabel || "Value"}`,
    `Categories: ${items.length}`,
    `Frequencies: ${rows.join(", ")}`,
    `Total frequency: ${roundInteractive(total, 2)}`,
    `Y max: ${yMax}`
  ];
}

function buildHistogramDetailLines(app) {
  const config = app.config || {};
  const hist = computeHistogramBins(config.values || [], config.binCount);
  if (!hist) return ["Histogram values: none"];
  const binsText = hist.bins.map((freq, index) => {
    const start = hist.min + index * hist.width;
    const end = start + hist.width;
    return `[${roundInteractive(start, 2)}, ${roundInteractive(end, 2)}): ${freq}`;
  }).join(" | ");
  return [
    `Chart title: ${config.title || "Continuous Data Distribution"}`,
    `Value count: ${(Array.isArray(config.values) ? config.values : []).length}`,
    `Bin count: ${hist.bins.length}`,
    `Bins: ${binsText}`
  ];
}

function buildBoxPlotDetailLines(app) {
  const config = app.config || {};
  const rows = normalizeBoxPlotDatasets(config).map((dataset, index) => ({
    label: dataset.label || defaultBoxPlotDatasetLabel(index),
    stats: computeFiveNumber(dataset.values || [])
  }));
  const fmt = (label, stats) => {
    if (!stats) return `${label}: no data`;
    return `${label}: min=${roundInteractive(stats.min, 2)}, Q1=${roundInteractive(stats.q1, 2)}, median=${roundInteractive(stats.median, 2)}, Q3=${roundInteractive(stats.q3, 2)}, max=${roundInteractive(stats.max, 2)}`;
  };
  return [
    `Chart title: ${config.title || "Compare Datasets"}`,
    ...rows.map((row) => fmt(row.label, row.stats))
  ];
}

function buildScatterPlotDetailLines(app) {
  const config = app.config || {};
  const points = Array.isArray(config.points) ? config.points : [];
  const regression = computeLinearRegression(points);
  const base = [
    `Chart title: ${config.title || "Correlation and Best Fit"}`,
    `Point count: ${points.length}`
  ];
  if (!regression) {
    base.push("Line of best fit: unavailable");
    return base;
  }
  base.push(`Correlation coefficient r: ${roundInteractive(regression.correlation, 4)}`);
  base.push(`Best fit equation: y = ${roundInteractive(regression.slope, 4)}x + ${roundInteractive(regression.intercept, 4)}`);
  return base;
}

function buildProbabilityTreeDetailLines(app) {
  const config = app.config || {};
  const paths = Array.isArray(config.paths) ? config.paths : [];
  const total = paths.reduce((sum, item) => sum + (Number(item.probability) || 0), 0);
  const conditional = computeConditionalProbability(paths, config.conditionalQuery || "");
  const pathSummary = paths.length > 0
    ? paths.map((item) => `${(Array.isArray(item.path) ? item.path.join(" -> ") : "path")} = ${roundInteractive(Number(item.probability) || 0, 4)}`).join(" | ")
    : "none";
  return [
    `Chart title: ${config.title || "Sequential Probabilities"}`,
    `Path summary: ${pathSummary}`,
    `Total probability: ${roundInteractive(total, 4)}`,
    `Conditional query: ${config.conditionalQuery || "none"}`,
    `Conditional result: ${conditional === null ? "unavailable" : roundInteractive(conditional, 4)}`
  ];
}

function buildDistributionCurveDetailLines(app) {
  const config = app.config || {};
  const mean = Number(config.mean);
  const stdDev = Math.max(0.0001, Number(config.stdDev) || 1);
  const from = Number(config.from);
  const to = Number(config.to);
  if (![mean, stdDev, from, to].every(Number.isFinite)) {
    return ["Distribution parameters are incomplete."];
  }
  const zFrom = (from - mean) / stdDev;
  const zTo = (to - mean) / stdDev;
  const area = Math.max(0, normalCdf(zTo) - normalCdf(zFrom));
  return [
    `Chart title: ${config.title || "Normal Distribution"}`,
    `Mean: ${roundInteractive(mean, 4)}, SD: ${roundInteractive(stdDev, 4)}`,
    `Bounds: from ${roundInteractive(from, 4)} to ${roundInteractive(to, 4)}`,
    `Z-range: ${roundInteractive(zFrom, 4)} to ${roundInteractive(zTo, 4)}`,
    `Area under curve: ${roundInteractive(area, 5)}`
  ];
}

function buildNetworkGraphDetailLines(app) {
  const config = app.config || {};
  const nodes = Array.isArray(config.nodes) ? config.nodes : [];
  const edges = Array.isArray(config.edges) ? config.edges : [];
  const shortest = dijkstra(nodes, edges, config.source, config.target);
  const mst = computeMstWeight(nodes, edges);
  const maxFlow = computeMaxFlow(nodes, edges, config.flowSource, config.flowSink);
  return [
    `Chart title: ${config.title || "Network Graph"}`,
    `Nodes: ${nodes.join(", ") || "none"}`,
    `Edges: ${edges.map((edge) => `${edge.from}-${edge.to}(w=${edge.weight}, c=${edge.capacity})`).join(" | ") || "none"}`,
    `Shortest path ${config.source || "?"} -> ${config.target || "?"}: ${shortest ? `${shortest.path.join(" -> ")} (cost ${roundInteractive(shortest.distance, 3)})` : "unavailable"}`,
    `MST total weight: ${mst === null ? "unavailable" : roundInteractive(mst, 3)}`,
    `Max flow ${config.flowSource || "?"} -> ${config.flowSink || "?"}: ${maxFlow === null ? "unavailable" : roundInteractive(maxFlow, 3)}`
  ];
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

function buildGeometryDetailLines(app) {
  const config = app.config || {};
  const shapes = Array.isArray(config.shapes) ? config.shapes : [];
  if (shapes.length === 0) return ["No shapes configured."];

  const notation = normalizeGeometryFormulaNotation(config.formulaNotation || "plain");
  const unit = normalizeGeometryUnit(config.unit || "unit");
  const lines = [
    `Canvas: ${config.canvasWidth || 360} x ${config.canvasHeight || 260}`,
    `Formula style: ${notation === "math" ? "Math style" : "Plain"}`,
    `Unit: ${unit === "unit" ? "No unit" : unit}`
  ];
  shapes.forEach((shape, index) => {
    const type = normalizeGeometryShapeType(shape.type);
    const label = String(shape.label || `${type} ${index + 1}`).trim();
    const metrics = computeGeometryMetrics(shape, config || {});
    lines.push(`${label} (${type}): ${metrics.lines.join(" | ")}`);
  });
  return lines;
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

function buildFractionsDetailLines(app) {
  const config = app.config || {};
  const operation = normalizeFractionOperation(config.operation);
  const fractionA = simplifyFraction(config.fractionA && config.fractionA.numerator, config.fractionA && config.fractionA.denominator);
  const fractionB = simplifyFraction(config.fractionB && config.fractionB.numerator, config.fractionB && config.fractionB.denominator);
  const labels = { add: "Addition", subtract: "Subtraction", multiply: "Multiplication", divide: "Division" };
  return [
    `Operation: ${labels[operation]}`,
    `Fraction A: ${formatFractionDisplay(fractionA)}`,
    `Fraction B: ${formatFractionDisplay(fractionB)}`
  ];
}

function buildMatrixDetailLines(app) {
  const config = app.config || {};
  const operation = normalizeMatrixOperation(config.operation);
  const matrixA = sanitizeMatrix(config.matrixA);
  const matrixB = sanitizeMatrix(config.matrixB);
  const labels = { add: "A + B", subtract: "A - B", multiply: "A x B", determinant: "det(A)", transpose: "A^T" };
  return [
    `Operation: ${labels[operation]}`,
    `A dimensions: ${matrixDimensions(matrixA)}`,
    operation === "add" || operation === "subtract" || operation === "multiply" ? `B dimensions: ${matrixDimensions(matrixB)}` : ""
  ].filter((line) => line);
}

function buildArithmeticDetailLines(app) {
  const config = app.config || {};
  const a = Number.parseInt(config.operandA, 10);
  const b = Number.parseInt(config.operandB, 10);
  const operator = String(config.operator || "+").trim() || "+";
  const layout = normalizeArithmeticLayout(config.layout);
  const answer = computeArithmeticAnswerFromConfig(config);

  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return [`Layout: ${layout}`, `Operator: ${operator}`, "Expression data is incomplete."];
  }

  return [
    `Layout: ${layout}`,
    `Expression: ${a} ${operator} ${b}`,
    `Expected answer: ${answer}`
  ];
}

function updateInteractiveDetails(host, app) {
  if (!host || !app || !app.type) return;
  let lines = [];
  if (app.type === "arithmetic") {
    lines = buildArithmeticDetailLines(app);
  } else if (app.type === "number-line") {
    lines = buildNumberLineDetailLines(app);
  } else if (app.type === "cartesian-plane") {
    lines = buildCartesianDetailLines(app);
    } else if (app.type === "cartesian-plane-plot") {
      const cfg = app.config || {};
      const pts = Array.isArray(cfg.points) ? cfg.points : [];
      lines = [
        `Answer points: ${pts.length > 0 ? pts.map((p) => `${p.label ? p.label + " " : ""}(${p.x}, ${p.y})`).join(", ") : "none"}`,
        `Tolerance: ±${cfg.tolerance ?? 0.5} units`,
        `Axes: x ${cfg.xMin ?? -10} to ${cfg.xMax ?? 10}, y ${cfg.yMin ?? -10} to ${cfg.yMax ?? 10}`
      ];
  } else if (app.type === "bar-chart") {
    lines = buildBarChartDetailLines(app);
  } else if (app.type === "histogram") {
    lines = buildHistogramDetailLines(app);
  } else if (app.type === "box-plot") {
    lines = buildBoxPlotDetailLines(app);
  } else if (app.type === "scatter-plot") {
    lines = buildScatterPlotDetailLines(app);
  } else if (app.type === "probability-tree") {
    lines = buildProbabilityTreeDetailLines(app);
  } else if (app.type === "distribution-curve") {
    lines = buildDistributionCurveDetailLines(app);
  } else if (app.type === "fractions") {
    lines = buildFractionsDetailLines(app);
  } else if (app.type === "network-graph") {
    lines = buildNetworkGraphDetailLines(app);
  } else if (app.type === "matrix") {
    lines = buildMatrixDetailLines(app);
  } else if (app.type === "stem-and-leaf") {
    lines = buildStemLeafDetailLines(app);
  } else if (app.type === "geometry-shapes") {
    lines = buildGeometryDetailLines(app);
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
  const render = () => {
    updateInteractivePreview(preview, app);
    updateInteractiveDetails(host, app);
    syncNumberLineControls(host, app);
    attachNumberLineDragging(host, app, render);
  };
  const sync = (index, value) => {
    if (!points[index]) return;
    const next = Math.max(min, Math.min(max, Number(value)));
    points[index].value = next;
    render();
  };

  host.querySelectorAll("[data-role='point-range']").forEach((input) => {
    input.addEventListener("input", () => sync(Number(input.dataset.index), input.value));
  });
  host.querySelectorAll("[data-role='point-number']").forEach((input) => {
    input.addEventListener("input", () => sync(Number(input.dataset.index), input.value));
  });

  render();
}

function mountCartesianInteractive(host, app) {
  const config = app.config || {};
  config.angleMode = normalizeAngleMode(config.angleMode || "radians");
  const points = Array.isArray(config.points) ? config.points : [];
  const parabolas = Array.isArray(config.parabolas) ? config.parabolas : [];
  const functionsList = Array.isArray(config.functions) ? config.functions : [];
  const xMin = Number.isFinite(Number(config.xMin)) ? Number(config.xMin) : -10;
  const xMax = Number.isFinite(Number(config.xMax)) ? Number(config.xMax) : 10;
  const yMin = Number.isFinite(Number(config.yMin)) ? Number(config.yMin) : -10;
  const yMax = Number.isFinite(Number(config.yMax)) ? Number(config.yMax) : 10;

  const pointControls = points.length > 0
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

  const parabolaControls = parabolas.length > 0
    ? parabolas.map((curve, index) => `
      <div class="interactive-control-grid">
        <div class="interactive-control-label">${escapeHtml(curve.label || `Parabola ${index + 1}`)}</div>
        <label class="interactive-control-row compact">
          <span>a</span>
          <input type="number" step="0.1" value="${Number(curve.a) || 0}" data-role="parabola-a" data-index="${index}" />
        </label>
        <label class="interactive-control-row compact">
          <span>b</span>
          <input type="number" step="0.1" value="${Number(curve.b) || 0}" data-role="parabola-b" data-index="${index}" />
        </label>
        <label class="interactive-control-row compact">
          <span>c</span>
          <input type="number" step="0.1" value="${Number(curve.c) || 0}" data-role="parabola-c" data-index="${index}" />
        </label>
      </div>
    `).join("")
    : "<p class='helper-text'>No parabolas configured for this plane.</p>";

  const functionControls = functionsList.length > 0
    ? functionsList.map((curve, index) => `
      <div class="interactive-control-grid">
        <div class="interactive-control-label">${escapeHtml(curve.label || `Function ${index + 1}`)}</div>
        <label class="interactive-control-stack full-width">
          <span>Expression y = f(x)</span>
          <input type="text" value="${escapeHtml(curve.expression || "")}" data-role="function-expression" data-index="${index}" />
        </label>
      </div>
    `).join("")
    : "<p class='helper-text'>No functions configured for this plane.</p>";

  const controls = `${pointControls}${parabolaControls}${functionControls}`;

  host.innerHTML = `
    <div class="interactive-app-preview"></div>
    <div class="interactive-app-controls">
      <div class="interactive-control-grid">
        <label class="interactive-control-row compact">
          <span>Angles</span>
          <select data-role="cartesian-angle-mode">
            <option value="radians" ${config.angleMode === "radians" ? "selected" : ""}>Radians</option>
            <option value="degrees" ${config.angleMode === "degrees" ? "selected" : ""}>Degrees</option>
          </select>
        </label>
      </div>
      ${controls}
    </div>
    <div class="interactive-app-details"></div>
  `;

  const preview = host.querySelector(".interactive-app-preview");
  const render = () => {
    updateInteractivePreview(preview, app);
    updateInteractiveDetails(host, app);
    syncCartesianControls(host, app);
    attachCartesianDragging(host, app, render);
  };
  const sync = (index, axis, value) => {
    if (!points[index]) return;
    const min = axis === "x" ? xMin : yMin;
    const max = axis === "x" ? xMax : yMax;
    const next = Math.max(min, Math.min(max, Number(value)));
    points[index][axis] = next;
    render();
  };

  host.querySelectorAll("[data-role='cartesian-x']").forEach((input) => {
    input.addEventListener("input", () => sync(Number(input.dataset.index), "x", input.value));
  });
  host.querySelectorAll("[data-role='cartesian-y']").forEach((input) => {
    input.addEventListener("input", () => sync(Number(input.dataset.index), "y", input.value));
  });

  const syncParabola = (index, key, value) => {
    if (!parabolas[index]) return;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    parabolas[index][key] = roundInteractive(parsed, 2);
    render();
  };

  host.querySelectorAll("[data-role='parabola-a']").forEach((input) => {
    input.addEventListener("input", () => syncParabola(Number(input.dataset.index), "a", input.value));
  });
  host.querySelectorAll("[data-role='parabola-b']").forEach((input) => {
    input.addEventListener("input", () => syncParabola(Number(input.dataset.index), "b", input.value));
  });
  host.querySelectorAll("[data-role='parabola-c']").forEach((input) => {
    input.addEventListener("input", () => syncParabola(Number(input.dataset.index), "c", input.value));
  });

  const syncFunction = (index, value) => {
    if (!functionsList[index]) return;
    functionsList[index].expression = String(value || "").trim();
    render();
  };

  host.querySelectorAll("[data-role='function-expression']").forEach((input) => {
    input.addEventListener("input", () => syncFunction(Number(input.dataset.index), input.value));
  });

  const angleModeInput = host.querySelector("[data-role='cartesian-angle-mode']");
  if (angleModeInput) {
    angleModeInput.addEventListener("input", () => {
      config.angleMode = normalizeAngleMode(angleModeInput.value);
      render();
    });
  }

  render();
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

function mountBarChartInteractive(host, app) {
  const config = app.config || {};
  config.orientation = String(config.orientation || "vertical").trim().toLowerCase() === "horizontal" ? "horizontal" : "vertical";
  config.categoryAxisLabel = String(config.categoryAxisLabel || "Category").trim() || "Category";
  config.valueAxisLabel = String(config.valueAxisLabel || "Value").trim() || "Value";
  if (!Array.isArray(config.items)) config.items = [];
  const items = config.items;
  const computeRangeMax = () => {
    const currentMax = Math.max(0, ...items.map((item) => Math.max(0, Number(item.frequency) || 0)));
    const explicitYMax = Number(config.yMax);
    const base = Number.isFinite(explicitYMax) && explicitYMax > 0 ? explicitYMax : Math.ceil(Math.max(10, currentMax) / 5) * 5;
    return Math.max(10, Math.ceil(base));
  };
  let sliderMax = computeRangeMax();

  const itemControls = items.length > 0
    ? items.map((item, index) => {
      const safeLabel = escapeHtml(item.category || `Category ${index + 1}`);
      const value = Math.max(0, Number(item.frequency) || 0);
      return `
      <div class="interactive-control-grid">
        <div class="interactive-control-label">${safeLabel}</div>
        <label class="interactive-control-row compact">
          <span>Freq</span>
          <input type="range" min="0" max="${sliderMax}" step="1" value="${Math.min(sliderMax, value)}" data-role="bar-range" data-index="${index}" />
        </label>
        <label class="interactive-control-row compact">
          <span>Freq</span>
          <input type="number" min="0" step="1" value="${value}" data-role="bar-number" data-index="${index}" />
        </label>
      </div>
    `;
    }).join("")
    : "<p class='helper-text'>No bars configured for this chart.</p>";

  host.innerHTML = `
    <div class="interactive-app-preview"></div>
    <div class="interactive-app-controls">
      <label class="interactive-control-stack">
        <span>Chart Title</span>
        <input type="text" value="${escapeHtml(config.title || "Category Frequencies")}" data-role="bar-title" />
      </label>
      <label class="interactive-control-row compact">
        <span>Y Max</span>
        <input type="number" min="1" step="1" value="${Number.isFinite(Number(config.yMax)) && Number(config.yMax) > 0 ? Number(config.yMax) : ""}" data-role="bar-ymax" placeholder="Auto" />
      </label>
      <label class="interactive-control-row compact">
        <span>Orientation</span>
        <select data-role="bar-orientation">
          <option value="vertical" ${config.orientation === "vertical" ? "selected" : ""}>Vertical</option>
          <option value="horizontal" ${config.orientation === "horizontal" ? "selected" : ""}>Horizontal</option>
        </select>
      </label>
      <label class="interactive-control-stack">
        <span>Category Axis Label</span>
        <input type="text" value="${escapeHtml(config.categoryAxisLabel)}" data-role="bar-axis-category" />
      </label>
      <label class="interactive-control-stack">
        <span>Value Axis Label</span>
        <input type="text" value="${escapeHtml(config.valueAxisLabel)}" data-role="bar-axis-value" />
      </label>
      ${itemControls}
    </div>
    <div class="interactive-app-details"></div>
  `;

  const preview = host.querySelector(".interactive-app-preview");
  const render = () => {
    sliderMax = computeRangeMax();
    host.querySelectorAll("[data-role='bar-range']").forEach((input) => {
      input.max = String(sliderMax);
      const index = Number(input.dataset.index);
      const current = items[index] ? Math.max(0, Number(items[index].frequency) || 0) : 0;
      input.value = String(Math.min(sliderMax, Math.round(current)));
    });
    updateInteractivePreview(preview, app);
    updateInteractiveDetails(host, app);
  };

  const syncFrequency = (index, value) => {
    if (!items[index]) return;
    const next = Math.max(0, Number(value) || 0);
    items[index].frequency = next;
    const numberInput = host.querySelector(`[data-role='bar-number'][data-index='${index}']`);
    const rangeInput = host.querySelector(`[data-role='bar-range'][data-index='${index}']`);
    if (numberInput) numberInput.value = String(Math.round(next));
    if (rangeInput) {
      const cap = Number(rangeInput.max) || sliderMax;
      rangeInput.value = String(Math.max(0, Math.min(cap, Math.round(next))));
    }
    render();
  };

  host.querySelectorAll("[data-role='bar-range']").forEach((input) => {
    input.addEventListener("input", () => syncFrequency(Number(input.dataset.index), input.value));
  });
  host.querySelectorAll("[data-role='bar-number']").forEach((input) => {
    input.addEventListener("input", () => syncFrequency(Number(input.dataset.index), input.value));
  });

  const titleInput = host.querySelector("[data-role='bar-title']");
  if (titleInput) {
    titleInput.addEventListener("input", () => {
      config.title = String(titleInput.value || "").trim();
      render();
    });
  }

  const yMaxInput = host.querySelector("[data-role='bar-ymax']");
  if (yMaxInput) {
    yMaxInput.addEventListener("input", () => {
      const value = Number(yMaxInput.value);
      config.yMax = Number.isFinite(value) && value > 0 ? value : null;
      render();
    });
  }

  const orientationInput = host.querySelector("[data-role='bar-orientation']");
  if (orientationInput) {
    orientationInput.addEventListener("input", () => {
      config.orientation = String(orientationInput.value || "vertical").trim().toLowerCase() === "horizontal" ? "horizontal" : "vertical";
      render();
    });
  }

  const categoryAxisInput = host.querySelector("[data-role='bar-axis-category']");
  if (categoryAxisInput) {
    categoryAxisInput.addEventListener("input", () => {
      config.categoryAxisLabel = String(categoryAxisInput.value || "").trim() || "Category";
      render();
    });
  }

  const valueAxisInput = host.querySelector("[data-role='bar-axis-value']");
  if (valueAxisInput) {
    valueAxisInput.addEventListener("input", () => {
      config.valueAxisLabel = String(valueAxisInput.value || "").trim() || "Value";
      render();
    });
  }

  render();
}

function mountHistogramInteractive(host, app) {
  const config = app.config || {};
  if (!Array.isArray(config.values)) config.values = [];
  host.innerHTML = `
    <div class="interactive-app-preview"></div>
    <div class="interactive-app-controls">
      <label class="interactive-control-stack">
        <span>Chart Title</span>
        <input type="text" value="${escapeHtml(config.title || "Continuous Data Distribution")}" data-role="hist-title" />
      </label>
      <label class="interactive-control-stack">
        <span>Values (comma separated)</span>
        <textarea rows="3" data-role="hist-values">${escapeHtml(config.values.join(", "))}</textarea>
      </label>
      <label class="interactive-control-row compact">
        <span>Bin Count</span>
        <input type="number" min="2" max="30" step="1" value="${Math.max(2, Math.min(30, Number.parseInt(config.binCount, 10) || 8))}" data-role="hist-bins" />
      </label>
    </div>
    <div class="interactive-app-details"></div>
  `;

  const preview = host.querySelector(".interactive-app-preview");
  const rerender = () => {
    const titleInput = host.querySelector("[data-role='hist-title']");
    const valuesInput = host.querySelector("[data-role='hist-values']");
    const binsInput = host.querySelector("[data-role='hist-bins']");
    config.title = String(titleInput.value || "").trim();
    config.values = String(valuesInput.value || "")
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter((item) => item !== "")
      .map((item) => Number.parseFloat(item))
      .filter((item) => Number.isFinite(item));
    config.binCount = Math.max(2, Math.min(30, Number.parseInt(binsInput.value, 10) || 8));
    binsInput.value = String(config.binCount);
    updateInteractivePreview(preview, app);
    updateInteractiveDetails(host, app);
  };

  host.querySelectorAll("input, textarea").forEach((input) => input.addEventListener("input", rerender));
  rerender();
}

function mountBoxPlotInteractive(host, app) {
  const config = app.config || {};
  const normalizedDatasets = normalizeBoxPlotDatasets(config);
  config.datasets = normalizedDatasets;
  host.innerHTML = `
    <div class="interactive-app-preview"></div>
    <div class="interactive-app-controls">
      <label class="interactive-control-row compact"><span>Dataset Count</span><input type="number" min="1" max="8" step="1" value="${clampBoxPlotDatasetCount(normalizedDatasets.length)}" data-role="box-count" style="width:64px" /></label>
      <label class="interactive-control-stack"><span>Datasets (one per line: label: values)</span><textarea rows="5" data-role="box-datasets">${escapeHtml(serializeBoxPlotDatasets(normalizedDatasets))}</textarea></label>
    </div>
    <div class="interactive-app-details"></div>
  `;

  const preview = host.querySelector(".interactive-app-preview");
  const rerender = (normalize) => {
    const countInput = host.querySelector("[data-role='box-count']");
    const datasetsInput = host.querySelector("[data-role='box-datasets']");
    const count = clampBoxPlotDatasetCount(countInput.value);
    countInput.value = String(count);
    config.datasets = parseBoxPlotDatasetsFromText(datasetsInput.value, count);
    // Only rewrite the textarea on blur/change so typing commas and spaces isn't interrupted.
    if (normalize) datasetsInput.value = serializeBoxPlotDatasets(config.datasets);

    // Keep legacy fields synced for older consumers.
    config.labelA = config.datasets[0] ? config.datasets[0].label : "A";
    config.valuesA = config.datasets[0] ? config.datasets[0].values : [];
    config.labelB = config.datasets[1] ? config.datasets[1].label : "B";
    config.valuesB = config.datasets[1] ? config.datasets[1].values : [];

    updateInteractivePreview(preview, app);
    updateInteractiveDetails(host, app);
  };

  host.querySelectorAll("input, textarea").forEach((input) => input.addEventListener("input", () => rerender(false)));
  host.querySelectorAll("input, textarea").forEach((input) => input.addEventListener("change", () => rerender(true)));
  rerender(true);
}

function mountScatterPlotInteractive(host, app) {
  const config = app.config || {};
  if (!Array.isArray(config.points)) config.points = [];
  const stringifyPoints = () => config.points
    .map((point) => `${Number(point.x) || 0}:${Number(point.y) || 0}:${point.label || ""}:${point.color || "#2563eb"}`)
    .join("\n");
  host.innerHTML = `
    <div class="interactive-app-preview"></div>
    <div class="interactive-app-controls">
      <label class="interactive-control-stack"><span>Chart Title</span><input type="text" value="${escapeHtml(config.title || "Correlation and Best Fit")}" data-role="sc-title" /></label>
      <label class="interactive-control-stack">
        <span>Points (x:y:label:color, one per line)</span>
        <textarea rows="5" data-role="sc-points">${escapeHtml(stringifyPoints())}</textarea>
      </label>
    </div>
    <div class="interactive-app-details"></div>
  `;

  const preview = host.querySelector(".interactive-app-preview");
  const rerender = () => {
    config.title = String(host.querySelector("[data-role='sc-title']").value || "").trim();
    const lines = String(host.querySelector("[data-role='sc-points']").value || "").split(/\r?\n/);
    config.points = lines.map((line, index) => {
      const [xRaw, yRaw, labelRaw, colorRaw] = line.split(":");
      const x = Number.parseFloat(xRaw);
      const y = Number.parseFloat(yRaw);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return {
        x,
        y,
        label: String(labelRaw || `P${index + 1}`).trim() || `P${index + 1}`,
        color: safeInteractiveColor(String(colorRaw || "").trim() || "#2563eb", "#2563eb")
      };
    }).filter((item) => item);
    updateInteractivePreview(preview, app);
    updateInteractiveDetails(host, app);
  };

  host.querySelectorAll("input, textarea").forEach((input) => input.addEventListener("input", rerender));
  rerender();
}

function mountProbabilityTreeInteractive(host, app) {
  const config = app.config || {};
  if (!Array.isArray(config.paths)) config.paths = [];
  const stringifyPaths = () => config.paths
    .map((item) => `${(Array.isArray(item.path) ? item.path.join(">"): "")}:${Number(item.probability) || 0}`)
    .join("\n");
  host.innerHTML = `
    <div class="interactive-app-preview"></div>
    <div class="interactive-app-controls">
      <label class="interactive-control-stack"><span>Chart Title</span><input type="text" value="${escapeHtml(config.title || "Sequential Probabilities")}" data-role="pt-title" /></label>
      <label class="interactive-control-stack"><span>Paths (A>B:0.3 one per line)</span><textarea rows="5" data-role="pt-paths">${escapeHtml(stringifyPaths())}</textarea></label>
      <label class="interactive-control-row"><span>Conditional Query</span><input type="text" value="${escapeHtml(config.conditionalQuery || "")}" placeholder="A|B" data-role="pt-query" /></label>
    </div>
    <div class="interactive-app-details"></div>
  `;

  const preview = host.querySelector(".interactive-app-preview");
  const rerender = () => {
    config.title = String(host.querySelector("[data-role='pt-title']").value || "").trim();
    config.conditionalQuery = String(host.querySelector("[data-role='pt-query']").value || "").trim();
    config.paths = String(host.querySelector("[data-role='pt-paths']").value || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => {
        const [pathRaw, probRaw] = line.split(":");
        const probability = Number.parseFloat(probRaw);
        if (!Number.isFinite(probability)) return null;
        const path = String(pathRaw || "").split(">" ).map((segment) => segment.trim()).filter((segment) => segment !== "");
        if (path.length === 0) return null;
        return { path, probability };
      })
      .filter((item) => item);
    updateInteractivePreview(preview, app);
    updateInteractiveDetails(host, app);
  };

  host.querySelectorAll("input, textarea").forEach((input) => input.addEventListener("input", rerender));
  rerender();
}

function mountDistributionCurveInteractive(host, app) {
  const config = app.config || {};
  host.innerHTML = `
    <div class="interactive-app-preview"></div>
    <div class="interactive-app-controls">
      <label class="interactive-control-stack"><span>Chart Title</span><input type="text" value="${escapeHtml(config.title || "Normal Distribution")}" data-role="dc-title" /></label>
      <div class="interactive-control-grid">
        <label class="interactive-control-row compact"><span>Mean</span><input type="number" step="0.1" value="${Number.isFinite(Number(config.mean)) ? Number(config.mean) : 0}" data-role="dc-mean" /></label>
        <label class="interactive-control-row compact"><span>SD</span><input type="number" min="0.0001" step="0.1" value="${Number.isFinite(Number(config.stdDev)) && Number(config.stdDev) > 0 ? Number(config.stdDev) : 1}" data-role="dc-std" /></label>
        <label class="interactive-control-row compact"><span>From</span><input type="number" step="0.1" value="${Number.isFinite(Number(config.from)) ? Number(config.from) : -1}" data-role="dc-from" /></label>
        <label class="interactive-control-row compact"><span>To</span><input type="number" step="0.1" value="${Number.isFinite(Number(config.to)) ? Number(config.to) : 1}" data-role="dc-to" /></label>
      </div>
    </div>
    <div class="interactive-app-details"></div>
  `;

  const preview = host.querySelector(".interactive-app-preview");
  const rerender = () => {
    config.title = String(host.querySelector("[data-role='dc-title']").value || "").trim();
    config.mean = Number(host.querySelector("[data-role='dc-mean']").value) || 0;
    config.stdDev = Math.max(0.0001, Number(host.querySelector("[data-role='dc-std']").value) || 1);
    config.from = Number(host.querySelector("[data-role='dc-from']").value) || 0;
    config.to = Number(host.querySelector("[data-role='dc-to']").value) || 0;
    updateInteractivePreview(preview, app);
    updateInteractiveDetails(host, app);
  };

  host.querySelectorAll("input").forEach((input) => input.addEventListener("input", rerender));
  rerender();
}

function mountNetworkGraphInteractive(host, app) {
  const config = app.config || {};
  if (!Array.isArray(config.nodes)) config.nodes = [];
  if (!Array.isArray(config.edges)) config.edges = [];
  const stringifyEdges = () => config.edges
    .map((edge) => `${edge.from}-${edge.to}:${Number(edge.weight) || 0}:${Number(edge.capacity) || 0}`)
    .join("\n");
  host.innerHTML = `
    <div class="interactive-app-preview"></div>
    <div class="interactive-app-controls">
      <label class="interactive-control-stack"><span>Chart Title</span><input type="text" value="${escapeHtml(config.title || "Shortest Path, MST, Flow")}" data-role="ng-title" /></label>
      <label class="interactive-control-stack"><span>Nodes (comma separated)</span><input type="text" value="${escapeHtml(config.nodes.join(", "))}" data-role="ng-nodes" /></label>
      <label class="interactive-control-stack"><span>Edges (A-B:weight:capacity one per line)</span><textarea rows="5" data-role="ng-edges">${escapeHtml(stringifyEdges())}</textarea></label>
      <div class="interactive-control-grid">
        <label class="interactive-control-row compact"><span>Shortest source</span><input type="text" value="${escapeHtml(config.source || "")}" data-role="ng-source" /></label>
        <label class="interactive-control-row compact"><span>Shortest target</span><input type="text" value="${escapeHtml(config.target || "")}" data-role="ng-target" /></label>
        <label class="interactive-control-row compact"><span>Flow source</span><input type="text" value="${escapeHtml(config.flowSource || "")}" data-role="ng-flow-source" /></label>
        <label class="interactive-control-row compact"><span>Flow sink</span><input type="text" value="${escapeHtml(config.flowSink || "")}" data-role="ng-flow-sink" /></label>
      </div>
    </div>
    <div class="interactive-app-details"></div>
  `;

  const preview = host.querySelector(".interactive-app-preview");
  const rerender = () => {
    config.title = String(host.querySelector("[data-role='ng-title']").value || "").trim();
    config.nodes = String(host.querySelector("[data-role='ng-nodes']").value || "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");
    config.edges = String(host.querySelector("[data-role='ng-edges']").value || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => {
        const [pairRaw, weightRaw, capacityRaw] = line.split(":");
        const [fromRaw, toRaw] = String(pairRaw || "").split("-");
        const from = String(fromRaw || "").trim();
        const to = String(toRaw || "").trim();
        if (!from || !to) return null;
        const weight = Number.parseFloat(weightRaw);
        const capacity = Number.parseFloat(capacityRaw);
        return {
          from,
          to,
          weight: Number.isFinite(weight) ? weight : 1,
          capacity: Number.isFinite(capacity) ? capacity : Math.max(1, Number.isFinite(weight) ? weight : 1)
        };
      })
      .filter((item) => item);
    config.source = String(host.querySelector("[data-role='ng-source']").value || "").trim();
    config.target = String(host.querySelector("[data-role='ng-target']").value || "").trim();
    config.flowSource = String(host.querySelector("[data-role='ng-flow-source']").value || "").trim();
    config.flowSink = String(host.querySelector("[data-role='ng-flow-sink']").value || "").trim();
    updateInteractivePreview(preview, app);
    updateInteractiveDetails(host, app);
  };

  host.querySelectorAll("input, textarea").forEach((input) => input.addEventListener("input", rerender));
  rerender();
}

function buildGeometryControlTypeOptions(selectedType) {
  return ["rectangle", "square", "circle", "triangle", "cube", "cuboid", "sphere", "cylinder"]
    .map((type) => `<option value="${type}" ${type === selectedType ? "selected" : ""}>${type}</option>`)
    .join("");
}

function mountGeometryInteractive(host, app) {
  const config = app.config || {};
  if (!Array.isArray(config.shapes)) config.shapes = [];
  config.unit = normalizeGeometryUnit(config.unit || "unit");
  config.formulaNotation = normalizeGeometryFormulaNotation(config.formulaNotation || "plain");
  const shapes = config.shapes;

  const controls = shapes.length > 0
    ? shapes.map((shape, index) => {
      const type = normalizeGeometryShapeType(shape.type);
      return `
      <div class="interactive-control-grid geometry-shape-control" data-index="${index}">
        <div class="interactive-control-label">${escapeHtml(shape.label || `Shape ${index + 1}`)}</div>
        <label class="interactive-control-row compact"><span>Type</span><select data-role="geo-type" data-index="${index}">${buildGeometryControlTypeOptions(type)}</select></label>
        <label class="interactive-control-row compact"><span>X</span><input type="number" step="1" value="${Number(shape.x) || 0}" data-role="geo-x" data-index="${index}" /></label>
        <label class="interactive-control-row compact"><span>Y</span><input type="number" step="1" value="${Number(shape.y) || 0}" data-role="geo-y" data-index="${index}" /></label>
        <label class="interactive-control-row compact"><span>W/r</span><input type="number" min="1" step="1" value="${Number(shape.w) || 1}" data-role="geo-w" data-index="${index}" /></label>
        <label class="interactive-control-row compact"><span>H</span><input type="number" min="1" step="1" value="${Number(shape.h) || Number(shape.w) || 1}" data-role="geo-h" data-index="${index}" /></label>
        <label class="interactive-control-row compact"><span>D</span><input type="number" min="1" step="1" value="${Number(shape.d) || Number(shape.w) || 1}" data-role="geo-d" data-index="${index}" /></label>
        <div class="interactive-formula-list" data-role="geo-formulas" data-index="${index}"></div>
      </div>
    `;
    }).join("")
    : "<p class='helper-text'>No shapes configured for this geometry activity.</p>";

  host.innerHTML = `
    <div class="interactive-app-preview"></div>
    <div class="interactive-app-controls">
      <div class="interactive-control-grid">
        <label class="interactive-control-row compact">
          <span>Unit</span>
          <select data-role="geo-unit">
            <option value="unit" ${config.unit === "unit" ? "selected" : ""}>No unit</option>
            <option value="cm" ${config.unit === "cm" ? "selected" : ""}>cm</option>
            <option value="m" ${config.unit === "m" ? "selected" : ""}>m</option>
            <option value="in" ${config.unit === "in" ? "selected" : ""}>in</option>
            <option value="ft" ${config.unit === "ft" ? "selected" : ""}>ft</option>
          </select>
        </label>
        <label class="interactive-control-row compact">
          <span>Formula</span>
          <select data-role="geo-notation">
            <option value="plain" ${config.formulaNotation === "plain" ? "selected" : ""}>Plain</option>
            <option value="math" ${config.formulaNotation === "math" ? "selected" : ""}>Math style</option>
          </select>
        </label>
      </div>
      ${controls}
    </div>
    <div class="interactive-app-details"></div>
  `;

  const preview = host.querySelector(".interactive-app-preview");
  const updateFormulaPanels = () => {
    host.querySelectorAll("[data-role='geo-formulas']").forEach((panel) => {
      const index = Number.parseInt(panel.dataset.index || "", 10);
      if (!Number.isInteger(index) || !shapes[index]) return;
      const metrics = computeGeometryMetrics(shapes[index], config || {});
      panel.innerHTML = metrics.lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
    });
  };

  const render = () => {
    updateInteractivePreview(preview, app);
    updateInteractiveDetails(host, app);
    updateFormulaPanels();
    attachGeometryDragging(host, app, render);
  };

  const sync = (index, key, value) => {
    if (!Number.isInteger(index) || !shapes[index]) return;
    if (key === "type") {
      shapes[index].type = normalizeGeometryShapeType(value);
    } else if (key === "x" || key === "y") {
      shapes[index][key] = roundInteractive(Number(value) || 0, 1);
    } else {
      shapes[index][key] = Math.max(1, Number(value) || 1);
    }
    render();
  };

  const syncSettings = (key, value) => {
    if (key === "unit") {
      config.unit = normalizeGeometryUnit(value);
    } else if (key === "formulaNotation") {
      config.formulaNotation = normalizeGeometryFormulaNotation(value);
    }
    render();
  };

  const unitInput = host.querySelector("[data-role='geo-unit']");
  if (unitInput) {
    unitInput.addEventListener("input", () => syncSettings("unit", unitInput.value));
  }
  const notationInput = host.querySelector("[data-role='geo-notation']");
  if (notationInput) {
    notationInput.addEventListener("input", () => syncSettings("formulaNotation", notationInput.value));
  }

  host.querySelectorAll("[data-role='geo-type']").forEach((input) => {
    input.addEventListener("input", () => sync(Number(input.dataset.index), "type", input.value));
  });
  host.querySelectorAll("[data-role='geo-x']").forEach((input) => {
    input.addEventListener("input", () => sync(Number(input.dataset.index), "x", input.value));
  });
  host.querySelectorAll("[data-role='geo-y']").forEach((input) => {
    input.addEventListener("input", () => sync(Number(input.dataset.index), "y", input.value));
  });
  host.querySelectorAll("[data-role='geo-w']").forEach((input) => {
    input.addEventListener("input", () => sync(Number(input.dataset.index), "w", input.value));
  });
  host.querySelectorAll("[data-role='geo-h']").forEach((input) => {
    input.addEventListener("input", () => sync(Number(input.dataset.index), "h", input.value));
  });
  host.querySelectorAll("[data-role='geo-d']").forEach((input) => {
    input.addEventListener("input", () => sync(Number(input.dataset.index), "d", input.value));
  });

  render();
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

function mountFractionsInteractive(host, app) {
  const config = app.config || {};
  config.operation = normalizeFractionOperation(config.operation);
  if (!config.fractionA) config.fractionA = { numerator: 1, denominator: 2 };
  if (!config.fractionB) config.fractionB = { numerator: 1, denominator: 3 };

  host.innerHTML = `
    <div class="interactive-app-preview"></div>
    <div class="interactive-app-controls">
      <label class="interactive-control-stack">
        <span>Title</span>
        <input type="text" data-role="fraction-title" value="${escapeHtml(config.title || "Fraction Operations")}" />
      </label>
      <label class="interactive-control-row compact">
        <span>Operation</span>
        <select data-role="fraction-operation">
          <option value="add" ${config.operation === "add" ? "selected" : ""}>Addition (+)</option>
          <option value="subtract" ${config.operation === "subtract" ? "selected" : ""}>Subtraction (-)</option>
          <option value="multiply" ${config.operation === "multiply" ? "selected" : ""}>Multiplication (x)</option>
          <option value="divide" ${config.operation === "divide" ? "selected" : ""}>Division (�)</option>
        </select>
      </label>
      <label class="interactive-control-row compact">
        <span>A numerator</span>
        <input type="number" step="1" data-role="fraction-a-num" value="${Number(config.fractionA.numerator) || 1}" />
      </label>
      <label class="interactive-control-row compact">
        <span>A denominator</span>
        <input type="number" step="1" data-role="fraction-a-den" value="${Number(config.fractionA.denominator) || 2}" />
      </label>
      <label class="interactive-control-row compact">
        <span>B numerator</span>
        <input type="number" step="1" data-role="fraction-b-num" value="${Number(config.fractionB.numerator) || 1}" />
      </label>
      <label class="interactive-control-row compact">
        <span>B denominator</span>
        <input type="number" step="1" data-role="fraction-b-den" value="${Number(config.fractionB.denominator) || 3}" />
      </label>
    </div>
    <div class="interactive-app-details"></div>
  `;

  const preview = host.querySelector(".interactive-app-preview");
  const titleInput = host.querySelector("[data-role='fraction-title']");
  const operationInput = host.querySelector("[data-role='fraction-operation']");
  const aNumInput = host.querySelector("[data-role='fraction-a-num']");
  const aDenInput = host.querySelector("[data-role='fraction-a-den']");
  const bNumInput = host.querySelector("[data-role='fraction-b-num']");
  const bDenInput = host.querySelector("[data-role='fraction-b-den']");

  const rerender = () => {
    config.title = String(titleInput.value || "").trim() || "Fraction Operations";
    config.operation = normalizeFractionOperation(operationInput.value);
    config.fractionA = {
      numerator: Number.parseInt(aNumInput.value, 10) || 1,
      denominator: Number.parseInt(aDenInput.value, 10) || 2
    };
    config.fractionB = {
      numerator: Number.parseInt(bNumInput.value, 10) || 1,
      denominator: Number.parseInt(bDenInput.value, 10) || 3
    };
    updateInteractivePreview(preview, app);
    updateInteractiveDetails(host, app);
  };

  host.querySelectorAll("input, select").forEach((input) => input.addEventListener("input", rerender));
  updateInteractivePreview(preview, app);
  updateInteractiveDetails(host, app);
}

function mountMatrixInteractive(host, app) {
  const config = app.config || {};
  config.operation = normalizeMatrixOperation(config.operation);
  config.matrixA = sanitizeMatrix(config.matrixA);
  config.matrixB = sanitizeMatrix(config.matrixB);

  host.innerHTML = `
    <div class="interactive-app-preview"></div>
    <div class="interactive-app-controls">
      <label class="interactive-control-stack">
        <span>Title</span>
        <input type="text" data-role="matrix-title" value="${escapeHtml(config.title || "Matrix Operations")}" />
      </label>
      <label class="interactive-control-row compact">
        <span>Operation</span>
        <select data-role="matrix-operation">
          <option value="add" ${config.operation === "add" ? "selected" : ""}>A + B</option>
          <option value="subtract" ${config.operation === "subtract" ? "selected" : ""}>A - B</option>
          <option value="multiply" ${config.operation === "multiply" ? "selected" : ""}>A x B</option>
          <option value="determinant" ${config.operation === "determinant" ? "selected" : ""}>det(A)</option>
          <option value="transpose" ${config.operation === "transpose" ? "selected" : ""}>A^T</option>
        </select>
      </label>
      <label class="interactive-control-stack">
        <span>Matrix A</span>
        <textarea rows="4" data-role="matrix-a">${escapeHtml((config.matrixA || []).map((row) => row.join(", ")).join("\n"))}</textarea>
      </label>
      <label class="interactive-control-stack">
        <span>Matrix B</span>
        <textarea rows="4" data-role="matrix-b">${escapeHtml((config.matrixB || []).map((row) => row.join(", ")).join("\n"))}</textarea>
      </label>
    </div>
    <div class="interactive-app-details"></div>
  `;

  const preview = host.querySelector(".interactive-app-preview");
  const titleInput = host.querySelector("[data-role='matrix-title']");
  const operationInput = host.querySelector("[data-role='matrix-operation']");
  const matrixAInput = host.querySelector("[data-role='matrix-a']");
  const matrixBInput = host.querySelector("[data-role='matrix-b']");

  const parseRows = (text) => String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => line.replace(/,/g, " ").split(/\s+/).map((item) => Number.parseFloat(item)))
    .filter((row) => row.length > 0 && row.every((value) => Number.isFinite(value)));

  const rerender = () => {
    config.title = String(titleInput.value || "").trim() || "Matrix Operations";
    config.operation = normalizeMatrixOperation(operationInput.value);
    config.matrixA = parseRows(matrixAInput.value);
    config.matrixB = parseRows(matrixBInput.value);
    updateInteractivePreview(preview, app);
    updateInteractiveDetails(host, app);
  };

  host.querySelectorAll("input, select, textarea").forEach((input) => input.addEventListener("input", rerender));
  updateInteractivePreview(preview, app);
  updateInteractiveDetails(host, app);
}

function mountInteractiveApp(host, app) {
  if (!host || !app || !app.type) return;

  if (app.type === "arithmetic") {
    host.innerHTML = `
      <div class="interactive-app-preview"></div>
      <div class="interactive-app-details"></div>
    `;
    const preview = host.querySelector(".interactive-app-preview");
    updateInteractivePreview(preview, app);
    updateInteractiveDetails(host, app);
    return;
  }

  if (app.type === "number-line") {
    mountNumberLineInteractive(host, app);
    return;
  }
  if (app.type === "cartesian-plane") {
    mountCartesianInteractive(host, app);
      if (app.type === "cartesian-plane-plot") {
        const config = app.config || {};
        host.innerHTML = `
          <div class="interactive-app-preview"></div>
          <div class="interactive-app-details"></div>
        `;
        const preview = host.querySelector(".interactive-app-preview");
        preview.innerHTML = buildCartesianPlotSvgString(config, cartesianPlotUserPoints, true);
        updateInteractiveDetails(host, app);
        return;
      }
    return;
  }
  if (app.type === "bar-chart") {
    mountBarChartInteractive(host, app);
    return;
  }
  if (app.type === "histogram") {
    mountHistogramInteractive(host, app);
    return;
  }
  if (app.type === "box-plot") {
    mountBoxPlotInteractive(host, app);
    return;
  }
  if (app.type === "scatter-plot") {
    mountScatterPlotInteractive(host, app);
    return;
  }
  if (app.type === "probability-tree") {
    mountProbabilityTreeInteractive(host, app);
    return;
  }
  if (app.type === "distribution-curve") {
    mountDistributionCurveInteractive(host, app);
    return;
  }
  if (app.type === "fractions") {
    mountFractionsInteractive(host, app);
    return;
  }
  if (app.type === "network-graph") {
    mountNetworkGraphInteractive(host, app);
    return;
  }
  if (app.type === "matrix") {
    mountMatrixInteractive(host, app);
    return;
  }
  if (app.type === "stem-and-leaf") {
    mountStemLeafInteractive(host, app);
    return;
  }
  if (app.type === "geometry-shapes") {
    mountGeometryInteractive(host, app);
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
  // Cartesian Plane - Plot: the interactive IS the answer input
  if (question.interactiveApp && question.interactiveApp.type === "cartesian-plane-plot") {
    const config = question.interactiveApp.config || {};
    const answerCount = Array.isArray(config.points) ? config.points.length : 0;
    return `
      <div class="cartesian-plot-answer"></div>
      <p class="cartesian-plot-help helper-text">Click the grid to place ${answerCount} point${answerCount !== 1 ? "s" : ""}. Click a placed point to remove it.</p>
    `;
  }

  if (question.interactiveApp && question.interactiveApp.type === "arithmetic") {
    const config = question.interactiveApp.config || {};
    return buildArithmeticWorkspaceMarkup(config, { readOnly: false, revealAnswer: false });
  }

  // Interactive apps should only appear in the solution modal, not in the main question
  // So we skip them here and show the regular answer input instead
  
  if (question.resultType === "short-answer" || question.resultType === "plot") {
    return `
      <div class="short-answer-box">
        <label for="shortAnswerInput">Your answer</label>
        <input id="shortAnswerInput" type="text" placeholder="Type your answer" autocomplete="off" />
      </div>
    `;
  }

  const type = question.resultType === "checkbox" ? "checkbox" : "radio";
  const inputName = question.resultType === "checkbox" ? "activeQuestionCheck" : "activeQuestion";
  const options = question.options || [];
  const safeOptions = options.length > 0
    ? options
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
  if (question.interactiveApp && question.interactiveApp.type === "arithmetic") return;
  if (question.resultType === "short-answer" || question.resultType === "plot") return;

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

function getAnswerTextInputs(scope = document) {
  return Array.from(scope.querySelectorAll("#shortAnswerInput, .arithmetic-single-input, .arithmetic-digit-input"))
    .filter((node) => node instanceof HTMLInputElement && !node.disabled);
}

function refreshAnswerInputPendingState(scope = document) {
  const inputs = getAnswerTextInputs(scope);
  inputs.forEach((input) => {
    if (!(input instanceof HTMLInputElement)) return;
    input.classList.remove("answer-input-correct", "answer-input-incorrect");
    const hasValue = String(input.value || "").trim() !== "";
    input.classList.toggle("answer-input-pending", !answerChecked && !hasValue);
  });
}

function wireAnswerInputVisualState(scope = document) {
  const inputs = getAnswerTextInputs(scope);
  if (inputs.length === 0) return;

  const sync = () => refreshAnswerInputPendingState(scope);
  inputs.forEach((input) => {
    input.addEventListener("input", sync);
    input.addEventListener("change", sync);
  });

  refreshAnswerInputPendingState(scope);
}

function applyAnswerInputResultState(isCorrect, scope = document) {
  const inputs = getAnswerTextInputs(scope);
  inputs.forEach((input) => {
    if (!(input instanceof HTMLInputElement)) return;
    input.classList.remove("answer-input-pending", "answer-input-correct", "answer-input-incorrect");
    input.classList.add(isCorrect ? "answer-input-correct" : "answer-input-incorrect");
  });
}

function renderQuestion() {
  const question = quizData.questions[currentIndex];
  const quizContainer = document.getElementById("quizContainer");
  const resultBox = document.getElementById("resultBox");
  const nextBtn = document.getElementById("nextQuestionBtn");
  const showSolutionBtn = document.getElementById("showSolutionBtn");

  answerChecked = false;
  solutionShownForCurrentQuestion = false;
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

  if (question.interactiveApp && question.interactiveApp.type === "cartesian-plane-plot") {
    cartesianPlotUserPoints = [];
    mountCartesianPlotAnswer(quizContainer, question);
  }
  if (question.interactiveApp && question.interactiveApp.type === "arithmetic") {
    wireArithmeticAnswerInputs();
  }

  wireAnswerInputVisualState(quizContainer);

  renderNotesPanel(question);
  updateHeader();
}

function collectUserAnswer(question) {
  if (question.interactiveApp && question.interactiveApp.type === "arithmetic") {
    return collectArithmeticWorkspaceAnswer(document.getElementById("quizContainer"));
  }
  if (question.interactiveApp && question.interactiveApp.type === "cartesian-plane-plot") {
    return cartesianPlotUserPoints.slice();
  }
  if (question.resultType === "short-answer" || question.resultType === "plot") {
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
  if (question.interactiveApp && question.interactiveApp.type === "cartesian-plane-plot") {
    const config = question.interactiveApp.config || {};
    const answerPoints = Array.isArray(config.points) ? config.points : [];
    const tolerance = Number.isFinite(Number(config.tolerance)) ? Number(config.tolerance) : 0.5;
    const placed = Array.isArray(userAnswer) ? userAnswer : [];
    if (placed.length !== answerPoints.length) return false;
    return answerPoints.every((ap) =>
      placed.some((up) => Math.abs(up.x - Number(ap.x)) <= tolerance && Math.abs(up.y - Number(ap.y)) <= tolerance)
    );
  }
  const expected = getExpectedAnswers(question).map(norm);

  if (question.resultType === "checkbox") {
    const picked = Array.isArray(userAnswer) ? userAnswer.map(norm).filter((x) => x !== "") : [];
    if (picked.length === 0 || expected.length === 0) return false;

    const uniquePicked = Array.from(new Set(picked)).sort();
    const uniqueExpected = Array.from(new Set(expected)).sort();
    return uniquePicked.length === uniqueExpected.length && uniquePicked.every((item, idx) => item === uniqueExpected[idx]);
  }

  const isArithmetic = Boolean(
    question.interactiveApp && question.interactiveApp.type === "arithmetic"
  );
  const normalizeForMatch = (v) => {
    const n = norm(v);
    return isArithmetic ? stripLeadingZeros(n) : n;
  };
  const value = normalizeForMatch(userAnswer);
  if (!value || expected.length === 0) return false;
  return expected.map(normalizeForMatch).includes(value);
}

function validateAnswer(question, userAnswer) {
  if (question.interactiveApp && question.interactiveApp.type === "arithmetic") {
    return String(userAnswer || "").trim() !== "";
  }
  if (question.interactiveApp && question.interactiveApp.type === "cartesian-plane-plot") {
    return Array.isArray(userAnswer) && userAnswer.length > 0;
  }
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

  const resultBox = document.getElementById("resultBox");
  if (resultBox) {
    if (isCorrect) {
      resultBox.textContent = "Correct";
    } else if (question.resultType === "short-answer" || question.resultType === "plot") {
      const shortAnswerFeedback = buildShortAnswerIncorrectFeedback(expectedAnswers);
      resultBox.innerHTML = `${escapeHtml(shortAnswerFeedback.correctAnswerText)}<br>${escapeHtml(shortAnswerFeedback.encouragementText)}`;
    } else {
      resultBox.textContent = buildIncorrectFeedbackMessage();
    }
    resultBox.className = isCorrect ? "result-correct" : "result-incorrect";
  }

  // Visual feedback for selected options
  highlightAnswerFeedback(question, userAnswer, isCorrect, expectedAnswers);
  applyAnswerInputResultState(isCorrect, document.getElementById("quizContainer"));

  // Store expected answers for later use in solution modal
  window.currentExpectedAnswers = expectedAnswers;

  document.getElementById("showSolutionBtn").classList.remove("hidden");
  document.getElementById("nextQuestionBtn").disabled = false;
  answerChecked = true;

  if (question.interactiveApp && question.interactiveApp.type === "cartesian-plane-plot") {
    const config = question.interactiveApp.config || {};
    const wrapper = document.querySelector(".cartesian-plot-answer");
    if (wrapper) {
      wrapper.innerHTML = buildCartesianPlotSvgString(config, cartesianPlotUserPoints, true);
    }
  }

  updateHeader();
}

function shouldHandleQuestionEnterHotkey(event) {
  if (!event || event.key !== "Enter" || event.isComposing) return false;
  if (event.altKey || event.ctrlKey || event.metaKey) return false;

  const target = event.target;
  if (!(target instanceof HTMLElement)) return true;
  if (target instanceof HTMLTextAreaElement) return false;
  if (target.isContentEditable) return false;
  if (target instanceof HTMLInputElement && (target.disabled || target.readOnly)) return false;
  return true;
}

function handleQuestionEnterHotkey(event) {
  if (!shouldHandleQuestionEnterHotkey(event)) return;
  if (!quizData || !Array.isArray(quizData.questions) || quizData.questions.length === 0) return;

  const checkBtn = document.getElementById("checkAnswerBtn");
  if (!checkBtn || checkBtn.style.display === "none") return;

  event.preventDefault();

  if (!answerChecked) {
    checkAnswer();
    return;
  }

  if (!solutionShownForCurrentQuestion) {
    openSolutionModal();
    return;
  }

  goNext();
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
  const question = quizData.questions[currentIndex];
  const expectedAnswers = window.currentExpectedAnswers || getExpectedAnswers(question);
  
  // Prepare modal content when user clicks Show Solution
  prepareSolutionModal(question, expectedAnswers);
  
  const modal = document.getElementById("solutionModal");
  if (!modal) return;
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  solutionShownForCurrentQuestion = true;
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
  if (event.key === "Enter") {
    handleQuestionEnterHotkey(event);
    return;
  }
  if (event.key === "Escape") {
    closeSolutionModal();
  }
});

window.addEventListener("load", loadQuiz);




