const VIEWER_LAST_MODIFIED = "2026-05-03 23:02";
let quizData = null;
let currentIndex = 0;
let score = 0;
let answerChecked = false;
let solutionShownForCurrentQuestion = false;
let quizStarted = false;
let prestartTermsRequestId = 0;
let cartesianPlotUserPoints = [];
let currentDifficulty = 5;
let difficultyAdjustmentPending = false;
let quizAnswerLog = [];
const numberTracingCompletionByQuestion = {};
const numberTracingSnapshotByQuestion = {};
const DEFAULT_TERMS_CONDITIONS_TXT_PATH = "terms-and-conditions.txt";
const DEFAULT_EULA_TXT_PATH = "eula.txt";
const DEFAULT_TERMS_CONDITIONS_LINK_PATH = "terms-and-conditions.html";
const DEFAULT_EULA_LINK_PATH = "eula.html";
const DEFAULT_TERMS_JSON_PATH = "legal/terms.json";
const DEFAULT_TERMS_TXT_PATH = "legal/terms.txt";
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

function isNumberTracingQuestion(question) {
  return Boolean(question && question.interactiveApp && question.interactiveApp.type === "number-tracing");
}

function hasCompletedTracingForCurrentQuestion() {
  return Boolean(numberTracingCompletionByQuestion[currentIndex]);
}

function captureNumberTracingSnapshotForCurrentQuestion() {
  const quizContainer = document.getElementById("quizContainer");
  const canvas = quizContainer && quizContainer.querySelector(".number-tracing-canvas");
  if (!(canvas instanceof HTMLCanvasElement)) return;
  try {
    numberTracingSnapshotByQuestion[currentIndex] = canvas.toDataURL("image/png");
  } catch (error) {
    // Ignore snapshot failures and keep the rest of the flow working.
  }
}

function updateNextQuestionButtonState() {
  const nextBtn = document.getElementById("nextQuestionBtn");
  if (!(nextBtn instanceof HTMLButtonElement)) return;
  if (!answerChecked) {
    nextBtn.disabled = true;
    return;
  }

  const question = quizData && Array.isArray(quizData.questions) ? quizData.questions[currentIndex] : null;
  if (!isNumberTracingQuestion(question)) {
    nextBtn.disabled = false;
    return;
  }

  nextBtn.disabled = !hasCompletedTracingForCurrentQuestion();
}

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

function buildIncorrectFeedbackMessage(userAnswer, expectedAnswers) {
  const userText = formatAnswerForReport(userAnswer) || "(blank)";
  const correctText = Array.isArray(expectedAnswers) && expectedAnswers.length > 0
    ? expectedAnswers.map((item) => formatAnswerForReport(item)).filter((item) => item !== "").join(", ")
    : "N/A";
  return `Your answer: ${userText}<br>Correct answer: ${correctText}<br>${getRandomEncouragingMessage()} Press "Show Solution" to see where you went wrong.`;
}

function buildShortAnswerIncorrectFeedback(userAnswer, expectedAnswers) {
  const fallback = Array.isArray(expectedAnswers) && expectedAnswers.length > 0
    ? expectedAnswers.join(", ")
    : "N/A";
  const typed = formatAnswerForReport(userAnswer) || "(blank)";
  return {
    userAnswerText: `Your answer: ${typed}`,
    correctAnswerText: `Correct answer: ${fallback}`,
    encouragementText: `${getRandomEncouragingMessage()} Press "Show Solution" to see where you went wrong.`
  };
}

function buildFractionIncorrectFeedbackMarkup(question, expectedAnswers) {
  const summary = question && question.interactiveApp && question.interactiveApp.type === "fractions"
    ? buildFractionOperationSummary(question.interactiveApp.config || {})
    : null;
  const correctAnswerMarkup = summary && !summary.error && summary.result
    ? fractionHtmlImproperAndMixed(summary.result)
    : escapeHtml(Array.isArray(expectedAnswers) && expectedAnswers.length > 0 ? expectedAnswers.join(", ") : "N/A");
  const encouragementText = escapeHtml(`${getRandomEncouragingMessage()} Press "Show Solution" to see where you went wrong.`);

  return `Correct answer: ${correctAnswerMarkup}<br>${encouragementText}`;
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
    questionLimit: normalizeQuizQuestionLimit(settings.questionLimit),
    termsConditionsTxtPath: typeof settings.termsConditionsTxtPath === "string" ? settings.termsConditionsTxtPath.trim() : "",
    eulaTxtPath: typeof settings.eulaTxtPath === "string" ? settings.eulaTxtPath.trim() : "",
    termsConditionsLinkPath: typeof settings.termsConditionsLinkPath === "string" ? settings.termsConditionsLinkPath.trim() : "",
    eulaLinkPath: typeof settings.eulaLinkPath === "string" ? settings.eulaLinkPath.trim() : "",
    termsJsonPath: typeof settings.termsJsonPath === "string" ? settings.termsJsonPath.trim() : "",
    termsTxtPath: typeof settings.termsTxtPath === "string" ? settings.termsTxtPath.trim() : ""
  };
}

function toParagraphList(value) {
  if (Array.isArray(value)) {
    return value.map((line) => String(line || "").trim()).filter((line) => line !== "");
  }
  const raw = String(value || "").trim();
  if (!raw) return [];
  return raw.split(/\r?\n+/).map((line) => line.trim()).filter((line) => line !== "");
}

function parseTermsJsonPayload(raw) {
  if (!raw || typeof raw !== "object") return null;
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const subtitle = typeof raw.subtitle === "string" ? raw.subtitle.trim() : "";
  const supportLabel = typeof raw.supportLabel === "string" ? raw.supportLabel.trim() : "";
  const supportEmail = typeof raw.supportEmail === "string" ? raw.supportEmail.trim() : "";
  const body = toParagraphList(raw.body || raw.terms || raw.content || raw.text || "");
  if (!title && !subtitle && body.length === 0 && !supportEmail) return null;
  return {
    title,
    subtitle,
    body,
    supportLabel,
    supportEmail
  };
}

async function tryLoadTermsFromJson(path) {
  const targetPath = String(path || "").trim();
  if (!targetPath) return null;
  try {
    const response = await fetch(targetPath, { cache: "no-store" });
    if (!response.ok) return null;
    const payload = await response.json();
    return parseTermsJsonPayload(payload);
  } catch (error) {
    return null;
  }
}

async function tryLoadTermsFromTxt(path) {
  const targetPath = String(path || "").trim();
  if (!targetPath) return null;
  try {
    const response = await fetch(targetPath, { cache: "no-store" });
    if (!response.ok) return null;
    const text = await response.text();
    const body = toParagraphList(text);
    if (body.length === 0) return null;
    return { body };
  } catch (error) {
    return null;
  }
}

async function loadExternalTermsForQuiz(settings) {
  const cfg = settings && typeof settings === "object" ? settings : {};
  const termsConditionsTxtPath = String(cfg.termsConditionsTxtPath || cfg.termsTxtPath || DEFAULT_TERMS_CONDITIONS_TXT_PATH).trim();
  const eulaTxtPath = String(cfg.eulaTxtPath || DEFAULT_EULA_TXT_PATH).trim();
  const jsonPath = String(cfg.termsJsonPath || DEFAULT_TERMS_JSON_PATH).trim();
  const txtPath = String(cfg.termsTxtPath || DEFAULT_TERMS_TXT_PATH).trim();

  const fromTermsTxt = await tryLoadTermsFromTxt(termsConditionsTxtPath);
  const fromEulaTxt = await tryLoadTermsFromTxt(eulaTxtPath);
  if (fromTermsTxt || fromEulaTxt) {
    const combinedBody = [];
    if (fromTermsTxt && Array.isArray(fromTermsTxt.body) && fromTermsTxt.body.length > 0) {
      combinedBody.push("Terms and Conditions of Use");
      combinedBody.push(...fromTermsTxt.body);
    }
    if (fromEulaTxt && Array.isArray(fromEulaTxt.body) && fromEulaTxt.body.length > 0) {
      combinedBody.push("EULA");
      combinedBody.push(...fromEulaTxt.body);
    }

    if (combinedBody.length > 0) {
      return {
        subtitle: "Terms and Conditions of Use and EULA",
        body: combinedBody
      };
    }
  }

  const fromJson = await tryLoadTermsFromJson(jsonPath);
  if (fromJson) return fromJson;

  const fromTxt = await tryLoadTermsFromTxt(txtPath);
  if (fromTxt) return fromTxt;

  return null;
}

function resolveTermsAndEulaLinks(settings) {
  const cfg = settings && typeof settings === "object" ? settings : {};
  const termsHref = String(cfg.termsConditionsLinkPath || DEFAULT_TERMS_CONDITIONS_LINK_PATH).trim();
  const eulaHref = String(cfg.eulaLinkPath || DEFAULT_EULA_LINK_PATH).trim();
  return {
    termsHref: termsHref || DEFAULT_TERMS_CONDITIONS_LINK_PATH,
    eulaHref: eulaHref || DEFAULT_EULA_LINK_PATH
  };
}

function wireLegalLinksOpenBehavior(container) {
  if (!(container instanceof HTMLElement)) return;
  const links = container.querySelectorAll("a[data-legal-link]");
  links.forEach((node) => {
    if (!(node instanceof HTMLAnchorElement)) return;
    node.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const href = String(node.getAttribute("href") || "").trim();
      if (!href) return;

      const popup = window.open(href, "_blank", "noopener,noreferrer,width=980,height=760");
      if (!popup) {
        window.open(href, "_blank");
      }
    });
  });
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

function appendMatrixAToLegacyQuestion(questionText, interactiveApp) {
  const base = String(questionText || "").trim();
  const app = interactiveApp && typeof interactiveApp === "object" ? interactiveApp : null;
  if (!app || app.type !== "matrix") return base;

  const lower = base.toLowerCase();
  const isDimensionsPrompt = lower.includes("dimensions of matrix a");
  const alreadyContainsMatrix = lower.includes("matrix a:");
  if (!isDimensionsPrompt || alreadyContainsMatrix) return base;

  const config = app.config && typeof app.config === "object" ? app.config : {};
  const matrixA = Array.isArray(config.matrixA) ? config.matrixA : [];
  const safeRows = matrixA
    .filter((row) => Array.isArray(row) && row.length > 0)
    .map((row) => `[${row.map((value) => String(value)).join(" ")}]`);

  if (safeRows.length === 0) return base;
  return `${base}\nMatrix A:\n${safeRows.join("\n")}`;
}

function buildMatrixDimensionExplanation(question) {
  if (!question || !question.interactiveApp || question.interactiveApp.type !== "matrix") return "";
  const prompt = String(question.question || "").trim().toLowerCase();
  if (!prompt.includes("dimensions of matrix a")) return "";

  const config = question.interactiveApp.config && typeof question.interactiveApp.config === "object"
    ? question.interactiveApp.config
    : {};
  const matrixA = sanitizeMatrix(config.matrixA);
  if (!matrixIsRectangular(matrixA)) return "";

  const rows = matrixA.length;
  const cols = matrixA[0].length;
  return [
    "Dimensions are written in the order rows x columns.",
    `Rows in Matrix A = ${rows}.`,
    `Columns in Matrix A = ${cols}.`,
    `So the dimensions are ${rows} x ${cols}.`
  ].join("\n");
}

function buildMatrixSolutionMarkup(question) {
  if (!question || !question.interactiveApp || question.interactiveApp.type !== "matrix") return "";
  const config = question.interactiveApp.config && typeof question.interactiveApp.config === "object"
    ? question.interactiveApp.config
    : {};
  const operation = normalizeMatrixOperation(config.operation);
  const matrixA = sanitizeMatrix(config.matrixA);
  const matrixB = sanitizeMatrix(config.matrixB);
  if (!matrixIsRectangular(matrixA)) return "";

  const rows = matrixA.length;
  const cols = matrixA[0].length;
  let operationMarkup = "";

  if (operation === "add") {
    const result = matrixAdd(matrixA, matrixB);
    operationMarkup = result
      ? `
        <div class="solution-modal-section">
          <p class="solution-modal-label">A + B</p>
          ${buildMatrixTableMarkup(result, "Result", { showDimensions: false })}
        </div>
      `
      : "<div class=\"solution-modal-section\"><p class=\"solution-modal-copy\">Addition requires A and B to have the same dimensions.</p></div>";
  } else if (operation === "subtract") {
    const result = matrixSubtract(matrixA, matrixB);
    operationMarkup = result
      ? `
        <div class="solution-modal-section">
          <p class="solution-modal-label">A - B</p>
          ${buildMatrixTableMarkup(result, "Result", { showDimensions: false })}
        </div>
      `
      : "<div class=\"solution-modal-section\"><p class=\"solution-modal-copy\">Subtraction requires A and B to have the same dimensions.</p></div>";
  } else if (operation === "multiply") {
    const result = matrixMultiply(matrixA, matrixB);
    operationMarkup = result
      ? `
        <div class="solution-modal-section">
          <p class="solution-modal-label">A x B</p>
          ${buildMatrixTableMarkup(result, "Result", { showDimensions: false })}
        </div>
      `
      : "<div class=\"solution-modal-section\"><p class=\"solution-modal-copy\">Multiplication requires columns in A to equal rows in B.</p></div>";
  } else if (operation === "transpose") {
    const result = matrixTranspose(matrixA);
    operationMarkup = result
      ? `
        <div class="solution-modal-section">
          <p class="solution-modal-label">A^T</p>
          ${buildMatrixTableMarkup(result, "Transpose", { showDimensions: false })}
        </div>
      `
      : "";
  } else if (operation === "determinant") {
    const determinant = matrixDeterminant(matrixA);
    operationMarkup = Number.isFinite(determinant)
      ? `
        <div class="solution-modal-section">
          <p class="solution-modal-label">det(A)</p>
          <p class="solution-modal-answer">${escapeHtml(formatMatrixNumber(determinant))}</p>
        </div>
      `
      : "<div class=\"solution-modal-section\"><p class=\"solution-modal-copy\">Determinant is only defined for square matrices.</p></div>";
  }

  const showMatrixB = (operation === "add" || operation === "subtract" || operation === "multiply") && matrixIsRectangular(matrixB);
  return `
    <div class="solution-modal-section">
      <p class="solution-modal-label">Matrix A</p>
      ${buildMatrixTableMarkup(matrixA, "Matrix A", { showDimensions: false })}
    </div>
    ${showMatrixB ? `
      <div class="solution-modal-section">
        <p class="solution-modal-label">Matrix B</p>
        ${buildMatrixTableMarkup(matrixB, "Matrix B", { showDimensions: false })}
      </div>
    ` : ""}
    ${operation === "multiply" || operation === "add" || operation === "subtract" ? `
      <div class="solution-modal-section">
        <p class="solution-modal-label">Dimensions</p>
        <ul class="solution-step-list">
          <li>Matrix A: <strong>${rows} x ${cols}</strong>.</li>
          ${showMatrixB ? `<li>Matrix B: <strong>${matrixB.length} x ${matrixB[0].length}</strong>.</li>` : ""}
        </ul>
      </div>
    ` : ""}
    ${operation === "multiply" || operation === "add" || operation === "subtract" || operation === "transpose" || operation === "determinant" ? operationMarkup : `
      <div class="solution-modal-section">
        <p class="solution-modal-label">Why This Dimension</p>
        <ul class="solution-step-list">
          <li>Dimensions are written as rows x columns.</li>
          <li>Rows in Matrix A: <strong>${rows}</strong>.</li>
          <li>Columns in Matrix A: <strong>${cols}</strong>.</li>
          <li>Therefore, dimensions = <strong>${rows} x ${cols}</strong>.</li>
        </ul>
      </div>
    `}
  `;
}

function normalizeQuestion(item) {
  const options = Array.isArray(item.options) ? item.options.filter((opt) => String(opt).trim() !== "") : [];
  const resultType = normalizeResultType(item.resultType);
  const interactiveApp = item.interactiveApp || null;
  const sourceQuestionText = String(
    item.question
    || item.prompt
    || item.text
    || item.title
    || item.name
    || item.label
    || ""
  ).trim();
  const questionText = appendMatrixAToLegacyQuestion(sourceQuestionText || "Untitled Question", interactiveApp);

  const normalized = {
    question: questionText,
    resultType,
    options,
    correctAnswer: item.correctAnswer,
    notesAttachments: Array.isArray(item.notesAttachments) ? item.notesAttachments : [],
    solutionAttachments: normalizeSolutionAttachments(item.solutionAttachments),
    image: item.image || "",
    solution: item.solution || ""
  };

  if (interactiveApp) {
    normalized.interactiveApp = interactiveApp;
  }

  return normalized;
}

function isIntroductionQuestion(question) {
  if (question && question.interactiveApp && question.interactiveApp.type === "introduction") {
    return true;
  }

  const prompt = String(question && question.question ? question.question : "").trim().toLowerCase();
  if (!prompt) return false;
  const hasIntroTerms = prompt.includes("terms") || prompt.includes("conditions") || prompt.includes("eula");
  const mentionsAccept = prompt.includes("accept") || prompt.includes("acknowledge");
  return hasIntroTerms && mentionsAccept;
}

function buildIntroductionCardMarkup(question) {
  const config = question && question.interactiveApp && question.interactiveApp.config && typeof question.interactiveApp.config === "object"
    ? question.interactiveApp.config
    : {};
  const title = String(config.title || "Before You Start").trim() || "Before You Start";
  const supportLabel = String(config.supportLabel || "Support").trim() || "Support";
  const supportEmail = String(config.supportEmail || "").trim();
  const requireSupportAcknowledgement = config.requireSupportAcknowledgement !== false;
  const paragraphs = String(question && question.question ? question.question : "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const bodyMarkup = paragraphs.length > 0
    ? paragraphs.map((line) => `<p>${escapeHtml(line)}</p>`).join("")
    : "<p>Please review the Terms and Conditions and EULA before continuing.</p>";
  const supportLine = supportEmail
    ? `<p class=\"intro-support\"><strong>${escapeHtml(supportLabel)}:</strong> <a href=\"mailto:${escapeHtml(supportEmail)}\">${escapeHtml(supportEmail)}</a></p>`
    : "";
  const termsLinks = resolveTermsAndEulaLinks(quizData && quizData.settings ? quizData.settings : {});

  return `
    <div class="question-card viewer-question intro-card">
      <p class="question-label">Introduction</p>
      <h2>${escapeHtml(title)}</h2>
      <p class="intro-lead">Please accept to continue. If needed, open the full Terms and Conditions and EULA below.</p>
      <button class="btn secondary intro-toggle-btn" id="introToggleTermsBtn" type="button">View Terms and Conditions</button>
      <div class="intro-terms-panel hidden" id="introTermsPanel">
        <div class="intro-copy">${bodyMarkup}</div>
        ${supportLine}
      </div>
      <div class="intro-acceptance" role="group" aria-label="Terms and Conditions acceptance">
        <label class="intro-check-item">
          <input id="introAcceptTerms" type="checkbox" />
          <span>I have read and accept the <a href="${escapeHtml(termsLinks.termsHref)}" target="_blank" rel="noopener noreferrer" data-legal-link="terms">Terms and Conditions of Use</a> and <a href="${escapeHtml(termsLinks.eulaHref)}" target="_blank" rel="noopener noreferrer" data-legal-link="eula">EULA</a>.</span>
        </label>
        ${requireSupportAcknowledgement ? `
          <label class="intro-check-item">
            <input id="introAcknowledgeSupport" type="checkbox" />
            <span>I will contact support if I find incorrect questions, answers, solutions, or feedback.</span>
          </label>
        ` : ""}
      </div>
    </div>
  `;
}

function wireIntroductionCardUI(container) {
  if (!(container instanceof HTMLElement)) return;
  wireLegalLinksOpenBehavior(container);
  const toggleBtn = container.querySelector("#introToggleTermsBtn");
  const termsPanel = container.querySelector("#introTermsPanel");
  if (!(toggleBtn instanceof HTMLButtonElement) || !(termsPanel instanceof HTMLElement)) return;

  toggleBtn.addEventListener("click", () => {
    const isHidden = termsPanel.classList.contains("hidden");
    termsPanel.classList.toggle("hidden", !isHidden);
    toggleBtn.textContent = isHidden ? "Hide Terms and Conditions" : "View Terms and Conditions";
  });
}

function normalizeResultType(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");

  if (!normalized) return "multiple-choice";
  if (["multiple-choice", "multiplechoice", "mcq"].includes(normalized)) return "multiple-choice";
  if (["short-answer", "shortanswer", "short"].includes(normalized)) return "short-answer";
  if (["date", "date-answer", "dateanswer"].includes(normalized)) return "date";
  if (["plot", "graph", "graph-plot", "plot-graph"].includes(normalized)) return "plot";
  if (["true-false", "truefalse", "boolean"].includes(normalized)) return "true-false";
  if (["checkbox", "multi-select", "multiselect"].includes(normalized)) return "checkbox";

  return "multiple-choice";
}

function parseDdMmYyyyDate(text) {
  const raw = String(text || "").trim();
  const match = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;

  const day = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const year = Number.parseInt(match[3], 10);
  if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) return null;

  const candidate = new Date(year, month - 1, day);
  if (candidate.getFullYear() !== year || (candidate.getMonth() + 1) !== month || candidate.getDate() !== day) {
    return null;
  }

  return {
    day,
    month,
    year,
    canonical: `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${String(year).padStart(4, "0")}`
  };
}

function resetRuntimeForLoadedQuiz() {
  currentIndex = 0;
  score = 0;
  quizAnswerLog = [];
  answerChecked = false;
  quizStarted = false;
  document.getElementById("checkAnswerBtn").style.display = "inline-block";
  document.getElementById("nextQuestionBtn").style.display = "inline-block";
  document.getElementById("notesViewerBtn").style.display = "inline-block";
  document.getElementById("showSolutionBtn").classList.add("hidden");
  document.getElementById("resultBox").textContent = "";
  document.getElementById("resultBox").className = "";
  closeSolutionModal();
}

function buildDefaultPrestartIntro() {
  return {
    title: "Before You Start",
    body: [
      "Please read and accept the Terms and Conditions of Use and EULA before starting this quiz.",
      "If you find any incorrect question, answer, solution, or feedback, contact support."
    ],
    supportLabel: "Support",
    supportEmail: ""
  };
}

function buildPrestartIntroFromQuestion(question) {
  const config = question && question.interactiveApp && question.interactiveApp.config && typeof question.interactiveApp.config === "object"
    ? question.interactiveApp.config
    : {};
  const lines = String(question && question.question ? question.question : "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

  return {
    title: String(config.title || "Before You Start").trim() || "Before You Start",
    body: lines.length > 0 ? lines : buildDefaultPrestartIntro().body,
    supportLabel: String(config.supportLabel || "Support").trim() || "Support",
    supportEmail: String(config.supportEmail || "").trim()
  };
}

function extractPrestartIntroAndQuestions(questions) {
  const list = Array.isArray(questions) ? questions.slice() : [];
  if (list.length > 0 && isIntroductionQuestion(list[0])) {
    return {
      intro: buildPrestartIntroFromQuestion(list[0]),
      questions: list.slice(1)
    };
  }

  return {
    intro: buildDefaultPrestartIntro(),
    questions: list
  };
}

function setViewerProgressChromeVisible(visible) {
  const progressRow = document.querySelector(".progress-row");
  const progressTrack = document.querySelector(".viewer-progress-track");
  if (progressRow instanceof HTMLElement) {
    progressRow.style.display = visible ? "flex" : "none";
  }
  if (progressTrack instanceof HTMLElement) {
    progressTrack.style.display = visible ? "block" : "none";
  }
}

function renderPrestartIntroScreen() {
  const quizContainer = document.getElementById("quizContainer");
  const intro = quizData && quizData.prestartIntro ? quizData.prestartIntro : buildDefaultPrestartIntro();
  const quizTitle = String(quizData && quizData.title ? quizData.title : "Quiz Viewer").trim() || "Quiz Viewer";
  const subtitle = String(intro && intro.subtitle ? intro.subtitle : "Terms and Conditions of Use").trim() || "Terms and Conditions of Use";
  const lines = Array.isArray(intro.body) ? intro.body : [];
  const bodyMarkup = lines.length > 0
    ? lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")
    : "<p>Please read and accept the Terms and Conditions and EULA before starting.</p>";
  const supportMarkup = intro.supportEmail
    ? `<p class="intro-support"><strong>${escapeHtml(intro.supportLabel || "Support")}:</strong> <a href="mailto:${escapeHtml(intro.supportEmail)}">${escapeHtml(intro.supportEmail)}</a></p>`
    : "";
  const termsLinks = resolveTermsAndEulaLinks(quizData && quizData.settings ? quizData.settings : {});

  quizContainer.innerHTML = `
    <div class="question-card viewer-question viewer-start-card">
      <p class="question-label">Welcome</p>
      <h2 class="start-main-title">${escapeHtml(quizTitle)}</h2>
      <p class="start-subtitle">${escapeHtml(subtitle)}</p>
      <div class="intro-copy">${bodyMarkup}</div>
      ${supportMarkup}
      <div class="intro-acceptance" role="group" aria-label="Terms and Conditions acceptance">
        <label class="intro-check-item">
          <input id="startAcceptTerms" type="checkbox" />
          <span>I have read and accept the <a href="${escapeHtml(termsLinks.termsHref)}" target="_blank" rel="noopener noreferrer" data-legal-link="terms">Terms and Conditions of Use</a> and <a href="${escapeHtml(termsLinks.eulaHref)}" target="_blank" rel="noopener noreferrer" data-legal-link="eula">EULA</a>.</span>
        </label>
      </div>
      <div class="button-group start-cta-row" style="margin-top:12px;">
        <button class="btn start-quiz-btn" id="startQuizBtn" type="button">Start Quiz</button>
      </div>
    </div>
  `;

  quizContainer.classList.add("prestart-mode");
  wireLegalLinksOpenBehavior(quizContainer);
  setViewerProgressChromeVisible(false);
  document.getElementById("checkAnswerBtn").style.display = "none";
  document.getElementById("nextQuestionBtn").style.display = "none";
  document.getElementById("notesViewerBtn").style.display = "none";
  document.getElementById("showSolutionBtn").classList.add("hidden");
  document.getElementById("resultBox").textContent = "";
  document.getElementById("resultBox").className = "";

  const startBtn = document.getElementById("startQuizBtn");
  if (startBtn instanceof HTMLButtonElement) {
    startBtn.addEventListener("click", () => {
      const accepted = document.getElementById("startAcceptTerms");
      const hasAccepted = accepted instanceof HTMLInputElement && accepted.checked;
      if (!hasAccepted) {
        showToast("Please accept the Terms and Conditions before starting.", "warning");
        return;
      }

      quizStarted = true;
      quizContainer.classList.remove("prestart-mode");
  setViewerProgressChromeVisible(true);
      document.getElementById("checkAnswerBtn").style.display = "inline-block";
      document.getElementById("nextQuestionBtn").style.display = "inline-block";
      document.getElementById("notesViewerBtn").style.display = "inline-block";

      if (!Array.isArray(quizData.questions) || quizData.questions.length === 0) {
        document.getElementById("quizContainer").innerHTML = "<p>This quiz has no questions yet.</p>";
        document.getElementById("checkAnswerBtn").style.display = "none";
        document.getElementById("nextQuestionBtn").style.display = "none";
        document.getElementById("notesViewerBtn").style.display = "none";
        document.getElementById("progressText").textContent = "Question 0 of 0";
        document.getElementById("scoreText").textContent = "Score: 0";
        return;
      }

      renderQuestion();
    });
  }
}

function applySingleQuiz(quiz) {
  const normalizedSettings = normalizeQuizSettings(quiz.settings);
  const preparedQuestions = applyQuizSettingsToQuestions(quiz.questions || [], normalizedSettings);
  const prestartPayload = extractPrestartIntroAndQuestions(preparedQuestions);
  quizData = {
    ...quiz,
    description: normalizeQuizDescription(quiz.description),
    settings: normalizedSettings,
    prestartIntro: prestartPayload.intro,
    questions: prestartPayload.questions
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
    renderPrestartIntroScreen();
  } else {
    renderPrestartIntroScreen();
  }

  const requestId = ++prestartTermsRequestId;
  loadExternalTermsForQuiz(quizData.settings).then((externalTerms) => {
    if (requestId !== prestartTermsRequestId) return;
    if (!externalTerms || !quizData) return;

    quizData.prestartIntro = {
      ...quizData.prestartIntro,
      ...externalTerms,
      body: Array.isArray(externalTerms.body) && externalTerms.body.length > 0
        ? externalTerms.body
        : quizData.prestartIntro.body
    };

    if (!quizStarted) {
      renderPrestartIntroScreen();
    }
  });
}

function getRequestedFile() {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("file");
  return requested ? requested.trim() : "quiz-database.json";
}

function flattenQuizIndexEntries(indexPayload) {
  const entries = [];
  if (!indexPayload || !Array.isArray(indexPayload.categories)) return entries;

  indexPayload.categories.forEach((category) => {
    const categoryName = String((category && category.name) || "").trim();
    const quizzes = Array.isArray(category && category.quizzes) ? category.quizzes : [];
    quizzes.forEach((quiz) => {
      const file = String((quiz && quiz.file) || "").trim();
      if (!file) return;
      const title = String((quiz && quiz.title) || file).trim() || file;
      const label = categoryName ? `${categoryName} - ${title}` : title;
      entries.push({ file, label });
    });
  });

  return entries;
}

function showQuizSelectorFromIndex() {
  // Navigation is handled by menu.html — selector no longer used.
}

function buildShareQuizText() {
  const title = String((quizData && quizData.title) || "Quiz").trim() || "Quiz";
  const quizFile = getRequestedFile();
  const shareUrl = window.location.href;
  return `Try this quiz: ${title}. ${shareUrl}${quizFile ? ` (file: ${quizFile})` : ""}`;
}

async function shareQuizLink() {
  const shareText = buildShareQuizText();
  const shareTitle = String((quizData && quizData.title) || "Quiz").trim() || "Quiz";
  const shareUrl = window.location.href;

  try {
    if (navigator.share) {
      await navigator.share({
        title: shareTitle,
        text: shareText,
        url: shareUrl
      });
      showToast("Shared successfully.", "success");
      return;
    }
  } catch (error) {
    // Keep going to clipboard fallback when share is canceled or unavailable.
  }

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(shareText);
      showToast("Quiz link copied. Paste it in social media.", "success");
      return;
    }
  } catch (error) {
    // Fallback to manual copy prompt below.
  }

  window.prompt("Copy and share this quiz link:", shareText);
}

function formatAnswerForReport(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(", ");
  }

  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch (error) {
      return String(value);
    }
  }

  const text = String(value == null ? "" : value).trim();
  return text;
}

function isImageAttachmentUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return false;
  if (/^data:image\//i.test(raw)) return true;
  return /\.(png|jpe?g|gif|webp|svg)(\?.*)?$/i.test(raw);
}

function buildAttemptRecord(question, userAnswer, expectedAnswers, isCorrect, questionNumber) {
  const expectedText = Array.isArray(expectedAnswers) && expectedAnswers.length > 0
    ? expectedAnswers.join(", ")
    : "N/A";
  const solutionText = String(question && question.solution ? question.solution : "").trim();
  const questionImage = String(question && question.image ? question.image : "").trim();
  const solutionImages = normalizeSolutionAttachments(question && question.solutionAttachments)
    .filter((item) => item && isImageAttachmentUrl(item.url))
    .map((item) => ({
      name: String(item.name || "Solution image").trim() || "Solution image",
      url: String(item.url || "").trim()
    }))
    .filter((item) => item.url !== "");
  const questionType = question && question.interactiveApp && question.interactiveApp.type
    ? String(question.interactiveApp.type)
    : String(question && question.resultType ? question.resultType : "unknown");
  const interactiveApp = question && question.interactiveApp ? cloneInteractiveApp(question.interactiveApp) : null;
  const tracingSnapshot = questionType === "number-tracing"
    ? String(numberTracingSnapshotByQuestion[Math.max(0, questionNumber - 1)] || "")
    : "";

  return {
    questionNumber,
    questionText: String(question && question.question ? question.question : "").trim(),
    userAnswer: formatAnswerForReport(userAnswer),
    correctAnswer: expectedText,
    solution: solutionText || `Correct answer: ${expectedText}`,
    questionImage,
    solutionImages,
    questionType,
    interactiveApp,
    tracingSnapshot,
    isCorrect: Boolean(isCorrect),
    isIntroduction: isIntroductionQuestion(question)
  };
}

function renderAttemptReviewMarkup(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) {
    return "<p class=\"helper-text\">No graded answers yet.</p>";
  }

  return attempts.map((item, index) => {
    const statusClass = item.isCorrect ? "review-item-correct" : "review-item-incorrect";
    const statusText = item.isCorrect ? "Correct" : "Incorrect";
    const solutionImagesMarkup = Array.isArray(item.solutionImages) && item.solutionImages.length > 0
      ? `
        <div class="review-solution-images">
          ${item.solutionImages.map((image) => `
            <figure class="review-solution-figure">
              <img class="review-image" src="${escapeHtml(image.url)}" alt="${escapeHtml(image.name)}" />
              <figcaption>${escapeHtml(image.name)}</figcaption>
            </figure>
          `).join("")}
        </div>
      `
      : "";
    return `
    <article class="review-item ${statusClass}" data-result="${item.isCorrect ? "correct" : "incorrect"}" data-question-number="${Number.isInteger(item.questionNumber) ? item.questionNumber : ""}">
      <section class="review-col review-question-col">
        <p class="review-col-label">Question ${item.questionNumber}</p>
        <p class="review-status ${item.isCorrect ? "status-correct" : "status-incorrect"}">${statusText}</p>
        <p class="review-question-text">${escapeHtml(item.questionText || "")}</p>
        ${item.questionImage ? `<img class="review-image" src="${escapeHtml(item.questionImage)}" alt="Question image" />` : ""}
        ${item.interactiveApp && item.interactiveApp.type ? `<div class="review-interactive-host" data-attempt-index="${index}"></div>` : ""}
        <p class="review-answer-line"><strong>Your answer:</strong> ${escapeHtml(item.userAnswer || "(blank)")}</p>
      </section>
      <div class="review-section-break" aria-hidden="true"></div>
      <section class="review-col review-solution-col">
        <p class="review-col-label">Solution</p>
        <p class="review-answer-line"><strong>Correct answer:</strong> ${escapeHtml(item.correctAnswer || "N/A")}</p>
        <div class="review-solution-text">${escapeHtml(item.solution || "").replace(/\n/g, "<br>")}</div>
        ${item.tracingSnapshot ? `<img class="solution-tracing-image" src="${escapeHtml(item.tracingSnapshot)}" alt="Your traced number" />` : ""}
        ${solutionImagesMarkup}
      </section>
    </article>
  `;
  }).join("");
}

function wireReviewInteractivePreviews(attempts) {
  const list = Array.isArray(attempts) ? attempts : [];
  const hosts = Array.from(document.querySelectorAll(".review-interactive-host"));
  hosts.forEach((host) => {
    if (!(host instanceof HTMLElement)) return;
    const index = Number.parseInt(host.dataset.attemptIndex || "-1", 10);
    if (!Number.isInteger(index) || index < 0 || index >= list.length) return;
    const attempt = list[index];
    if (!attempt || !attempt.interactiveApp || !attempt.interactiveApp.type) return;
    host.innerHTML = "";
    mountInteractiveApp(host, cloneInteractiveApp(attempt.interactiveApp));
  });
}

function buildReviewAnalyticsMarkup(attempts) {
  const list = Array.isArray(attempts) ? attempts : [];
  const total = list.length;
  const correct = list.filter((item) => item.isCorrect).length;
  const incorrect = total - correct;
  const accuracy = total === 0 ? 0 : Math.round((correct / total) * 100);

  const typeCounts = {};
  list.forEach((item) => {
    const type = String(item.questionType || "unknown").trim() || "unknown";
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  });
  const topTypes = Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([type, count]) => `${escapeHtml(type)} (${count})`)
    .join(", ");

  return `
    <div class="review-analytics">
      <div class="analytics-card"><p class="analytics-label">Total</p><p class="analytics-value">${total}</p></div>
      <div class="analytics-card"><p class="analytics-label">Correct</p><p class="analytics-value analytics-correct">${correct}</p></div>
      <div class="analytics-card"><p class="analytics-label">Incorrect</p><p class="analytics-value analytics-incorrect">${incorrect}</p></div>
      <div class="analytics-card"><p class="analytics-label">Accuracy</p><p class="analytics-value">${accuracy}%</p></div>
    </div>
    ${topTypes ? `<p class="analytics-meta"><strong>Top question types:</strong> ${topTypes}</p>` : ""}
  `;
}

function buildPdfInteractiveSummaryMarkup(attempt) {
  const app = attempt && attempt.interactiveApp ? attempt.interactiveApp : null;
  if (!app || !app.type) {
    return "<p class=\"pdf-interactive-note\">Interactive visual omitted in PDF-safe mode.</p>";
  }

  const type = String(app.type || "interactive").trim();
  const config = app && app.config && typeof app.config === "object" ? app.config : {};
  const summaryLines = [];

  if (type === "arithmetic") {
    const operator = String(config.operator || "+").trim();
    const a = Number.parseInt(config.operandA, 10);
    const b = Number.parseInt(config.operandB, 10);
    const answer = computeArithmeticAnswerFromConfig(config);
    if (Number.isInteger(a) && Number.isInteger(b)) {
      summaryLines.push(`Expression: ${a} ${operator} ${b} = ${answer}`);
    }
    const visualKind = String(config.visualKind || "objects").trim();
    summaryLines.push(`Model: ${visualKind}`);
  } else if (type === "cartesian-plane" || type === "cartesian-plane-plot") {
    summaryLines.push("Graph visual is available in the online report.");
  } else if (type === "number-ordering") {
    const normalized = getNumberOrderingConfig(config);
    summaryLines.push(`Direction: ${normalized.direction}`);
    summaryLines.push(`Cards: ${normalized.cards.join(", ")}`);
    summaryLines.push(`Correct order: ${normalized.correctOrder.join(", ")}`);
  } else if (type === "icon-count") {
    const normalized = normalizeIconCountConfig(config);
    summaryLines.push(`Total icons: ${normalized.totalCount}`);
    summaryLines.push(`Icon shape: ${normalized.iconShape}`);
    summaryLines.push(`Groups: ${normalized.groups.join(", ")}`);
  } else if (type === "fractions") {
    summaryLines.push("Fraction visual is available in the online report.");
  } else {
    summaryLines.push("Interactive visual is available in the online report.");
  }

  return `
    <div class="pdf-interactive-summary">
      <p class="pdf-interactive-title">Interactive Summary (${escapeHtml(type)})</p>
      ${summaryLines.map((line) => `<p class="pdf-interactive-note">${escapeHtml(line)}</p>`).join("")}
    </div>
  `;
}

function exportQuizResultsPdf(total, percent) {
  const quizTitle = String((quizData && quizData.title) || "Quiz").trim() || "Quiz";
  const generatedAt = new Date();
  const generatedLabel = generatedAt.toLocaleString();
  const quizUrl = window.location.href;
  const finalCard = document.querySelector("#quizContainer .final-card");
  const finalScoreNode = finalCard ? finalCard.querySelector("p") : null;
  const finalScoreText = finalScoreNode ? finalScoreNode.textContent : `Your final score is ${score} out of ${total} (${percent}%).`;
  const reviewedAttempts = Array.isArray(quizAnswerLog)
    ? quizAnswerLog.filter((item) => !item.isIntroduction)
    : [];
  const answerKeyRowsMarkup = reviewedAttempts.length > 0
    ? reviewedAttempts.map((item) => {
      const questionNumber = Number.isInteger(item && item.questionNumber) ? item.questionNumber : "-";
      const resultLabel = item && item.isCorrect ? "Correct" : "Incorrect";
      const yourAnswer = formatAnswerForReport(item && item.userAnswer ? item.userAnswer : "") || "(blank)";
      const correctAnswer = formatAnswerForReport(item && item.correctAnswer ? item.correctAnswer : "") || "N/A";
      return `
        <tr>
          <td>${escapeHtml(String(questionNumber))}</td>
          <td>${escapeHtml(resultLabel)}</td>
          <td>${escapeHtml(yourAnswer)}</td>
          <td>${escapeHtml(correctAnswer)}</td>
        </tr>
      `;
    }).join("")
    : `<tr><td colspan="4">No graded answers yet.</td></tr>`;
  const answerKeyMarkup = `
    <section class="pdf-answer-key-page">
      <h2>Detailed Results and Answers</h2>
      <table class="pdf-answer-table" aria-label="Detailed results and answers">
        <thead>
          <tr>
            <th>Question</th>
            <th>Result</th>
            <th>Your Answer</th>
            <th>Correct Answer</th>
          </tr>
        </thead>
        <tbody>
          ${answerKeyRowsMarkup}
        </tbody>
      </table>
    </section>
  `;

  // Export the exact review panel markup already rendered on the final results page.
  const reviewPanel = document.getElementById("reviewPanel");
  let reviewMarkup = "<p class=\"helper-text\">Review not available yet.</p>";
  let incorrectQuestionLinksMarkup = "";
  if (reviewPanel) {
    const clone = reviewPanel.cloneNode(true);
    if (clone instanceof HTMLElement) {
      clone.classList.remove("hidden");
      clone.removeAttribute("id");

      const incorrectLinks = [];
      const reviewItems = Array.from(clone.querySelectorAll(".review-item"));
      let incorrectAnchorCounter = 0;
      reviewItems.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        if (String(node.dataset.result || "") !== "incorrect") return;

        const datasetQuestionNumber = Number.parseInt(String(node.dataset.questionNumber || ""), 10);
        let questionNumber = datasetQuestionNumber;
        if (!Number.isInteger(questionNumber)) {
          const labelNode = node.querySelector(".review-col-label");
          const labelText = labelNode ? String(labelNode.textContent || "").trim() : "";
          const match = labelText.match(/Question\s+(\d+)/i);
          questionNumber = match ? Number.parseInt(match[1], 10) : NaN;
        }
        if (!Number.isInteger(questionNumber)) return;

        incorrectAnchorCounter += 1;
        const anchorId = `incorrect-q-anchor-${incorrectAnchorCounter}`;
        node.id = `incorrect-q-item-${incorrectAnchorCounter}`;

        const jumpAnchor = document.createElement("span");
        jumpAnchor.id = anchorId;
        jumpAnchor.className = "pdf-jump-anchor";
        jumpAnchor.setAttribute("aria-hidden", "true");
        node.insertAdjacentElement("beforebegin", jumpAnchor);

        incorrectLinks.push({ questionNumber, anchorId });
      });

      // Embedded PDF iframes are frequently truncated by browser print engines.
      // Replace them with direct links so exported PDFs are complete and stable.
      const embeddedPdfFrames = Array.from(clone.querySelectorAll(".solution-pdf-frame"));
      embeddedPdfFrames.forEach((frame, index) => {
        if (!(frame instanceof HTMLIFrameElement)) return;
        const src = String(frame.getAttribute("src") || "").trim();
        if (!src) {
          frame.remove();
          return;
        }
        const title = String(frame.getAttribute("title") || `PDF ${index + 1}`).trim() || `PDF ${index + 1}`;
        const fallback = document.createElement("p");
        fallback.className = "pdf-inline-link";
        fallback.innerHTML = `<strong>PDF attachment:</strong> <a href="${escapeHtml(src)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a>`;
        frame.replaceWith(fallback);
      });

      // Compact PDF mode: keep question + image + answers only (no full working section).
      reviewItems.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        const questionCol = node.querySelector(".review-question-col");
        const solutionCol = node.querySelector(".review-solution-col");
        const sectionBreak = node.querySelector(".review-section-break");

        if (questionCol instanceof HTMLElement) {
          const interactiveHost = questionCol.querySelector(".review-interactive-host");
          if (interactiveHost instanceof HTMLElement) {
            interactiveHost.remove();
          }
        }

        if (questionCol instanceof HTMLElement && solutionCol instanceof HTMLElement) {
          const correctAnswerLine = solutionCol.querySelector(".review-answer-line");
          if (correctAnswerLine instanceof HTMLElement) {
            const correctAnswerClone = correctAnswerLine.cloneNode(true);
            if (correctAnswerClone instanceof HTMLElement) {
              correctAnswerClone.classList.add("pdf-correct-answer-line");
              questionCol.appendChild(correctAnswerClone);
            }
          }

          const tracingImage = solutionCol.querySelector(".solution-tracing-image");
          if (tracingImage instanceof HTMLImageElement) {
            const tracingImageClone = tracingImage.cloneNode(true);
            if (tracingImageClone instanceof HTMLImageElement) {
              tracingImageClone.classList.add("review-image");
              questionCol.appendChild(tracingImageClone);
            }
          }
        }

        if (solutionCol instanceof HTMLElement) {
          solutionCol.remove();
        }
        if (sectionBreak instanceof HTMLElement) {
          sectionBreak.remove();
        }
      });

      if (incorrectLinks.length > 0) {
        const sortedLinks = incorrectLinks
          .sort((a, b) => a.questionNumber - b.questionNumber)
          .map((item) => `<a class="incorrect-link-chip" href="#${item.anchorId}">Question ${item.questionNumber}</a>`)
          .join("");
        incorrectQuestionLinksMarkup = `
          <div class="incorrect-link-row">
            <strong>Incorrect questions:</strong>
            ${sortedLinks}
          </div>
        `;
      }

      reviewMarkup = clone.outerHTML;
    }
  }

  const printHtml = `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>${escapeHtml(quizTitle)} - Results</title>
        <link rel="stylesheet" href="style.css" />
        <style>
          @page { size: auto; margin: 12mm; }
          html, body { width: auto !important; overflow: visible !important; }
          body { font-family: Arial, sans-serif; color: #0f172a; margin: 24px; }
          h1 { margin: 0 0 8px; font-size: 24px; }
          .meta { margin: 0 0 16px; color: #334155; }
          .summary { border: 1px solid #cbd5e1; border-radius: 10px; padding: 12px; margin-bottom: 16px; background: #f8fafc; }
          .summary p { margin: 4px 0; }
          .quiz-link { color: #1d4ed8; text-decoration: underline; word-break: break-all; }
          .pdf-jump-anchor { display: block; position: relative; top: -2mm; height: 0; }
          .pdf-inline-link { margin: 8px 0; font-size: 13px; }
          .pdf-inline-link a { color: #1d4ed8; text-decoration: underline; word-break: break-all; }
          .incorrect-link-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; }
          .incorrect-link-chip { display: inline-block; text-decoration: none; color: #1d4ed8; border: 1px solid #93c5fd; background: #eff6ff; border-radius: 999px; padding: 4px 10px; font-size: 12px; font-weight: 700; }
          .pdf-correct-answer-line { margin-top: 8px; padding-top: 8px; border-top: 1px dashed #cbd5e1; }
          .pdf-answer-key-page { page-break-before: always; break-before: page; margin-top: 0; }
          .pdf-answer-key-page h2 { margin: 0 0 10px; font-size: 20px; color: #0f172a; }
          .pdf-answer-table { width: 100%; border-collapse: collapse; border: 1px solid #cbd5e1; }
          .pdf-answer-table th, .pdf-answer-table td { border: 1px solid #dbe3ee; padding: 8px 10px; text-align: left; vertical-align: top; font-size: 12px; }
          .pdf-answer-table th { background: #eff6ff; color: #1e3a8a; font-weight: 800; }
          .button-group, .review-filters, #toggleReviewBtn, #shareResultBtn, #exportResultsBtn, #restartBtn { display: none !important; }
          .review-panel { margin-top: 0 !important; }
          /* Allow long solutions to flow to next page instead of clipping. */
          .review-item { break-inside: avoid-page; page-break-inside: avoid; overflow: visible !important; }
          .review-col { break-inside: avoid-page; page-break-inside: avoid; overflow: visible !important; }
          .review-image { page-break-inside: avoid; break-inside: avoid; max-height: none !important; height: auto !important; }
          .review-interactive-host, .interactive-app-preview, .solution-modal-section { page-break-inside: auto; break-inside: auto; overflow: visible !important; }
          .solution-pdf-frame { display: none !important; }
          @media print { 
            body { margin: 0; }
            .review-panel { display: block !important; }
            .review-image { display: block !important; max-width: 100% !important; }
            .review-item, .review-col { page-break-inside: avoid !important; break-inside: avoid-page !important; }
            .review-panel, .review-panel * { overflow: visible !important; }
            .review-image { max-height: none !important; height: auto !important; }
            svg, canvas, img { max-width: 100% !important; }
            iframe { display: none !important; }
          }
        </style>
      </head>
      <body id="pdf-top">
        <h1>${escapeHtml(quizTitle)} - Result Report</h1>
        <p class="meta">Generated: ${escapeHtml(generatedLabel)}</p>
        <section class="summary">
          <p><strong>${escapeHtml(String(finalScoreText || ""))}</strong></p>
          ${incorrectQuestionLinksMarkup}
          <p style="margin-top: 12px; border-top: 1px solid #cbd5e1; padding-top: 12px;"><strong>Quiz Link:</strong> <a class="quiz-link" href="${escapeHtml(quizUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(quizUrl)}</a></p>
        </section>
        ${reviewMarkup}
        ${answerKeyMarkup}
      </body>
    </html>
  `;

  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    showToast("Popup blocked. Please allow popups to export PDF.", "warning");
    return;
  }

  printWindow.document.open();
  printWindow.document.write(printHtml);
  printWindow.document.close();

  const waitForPrintReady = () => {
    const readyState = printWindow.document.readyState;
    const waitForLoad = readyState === "complete"
      ? Promise.resolve()
      : new Promise((resolve) => {
        printWindow.addEventListener("load", () => resolve(), { once: true });
        window.setTimeout(resolve, 1500);
      });

    return waitForLoad.then(() => {
      const imageNodes = Array.from(printWindow.document.images || []);
      if (imageNodes.length === 0) return Promise.resolve();
      const imagePromises = imageNodes.map((img) => {
        if (img.complete) return Promise.resolve();
        return new Promise((resolve) => {
          img.addEventListener("load", () => resolve(), { once: true });
          img.addEventListener("error", () => resolve(), { once: true });
          window.setTimeout(resolve, 1200);
        });
      });
      return Promise.all(imagePromises).then(() => undefined);
    });
  };

  waitForPrintReady().finally(() => {
    printWindow.focus();
    printWindow.print();
  });
}

function setError(message) {
  document.getElementById("quizContainer").innerHTML = `<p>${message}</p>`;
  document.getElementById("checkAnswerBtn").style.display = "none";
  document.getElementById("nextQuestionBtn").style.display = "none";
  document.getElementById("notesViewerBtn").style.display = "none";
}

function setError(message) {
  document.getElementById("quizContainer").innerHTML = `
    <div class="section-card" style="text-align:center; padding:40px 24px;">
      <p style="color:var(--danger); font-weight:700; margin:0 0 12px;">${escapeHtml(message)}</p>
      <a class="btn secondary" href="menu.html">&#8592; Back to Menu</a>
    </div>
  `;
  document.getElementById("checkAnswerBtn").style.display = "none";
  document.getElementById("nextQuestionBtn").style.display = "none";
  document.getElementById("notesViewerBtn").style.display = "none";
  document.getElementById("showSolutionBtn").classList.add("hidden");
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
  const requestedSegments = splitPath(requestedFile);
  if (requestedSegments.length === 0) {
    throw new Error("Invalid quiz path.");
  }

  const candidatePaths = [requestedSegments];
  if (requestedSegments[0] && requestedSegments[0].toLowerCase() === "quizzes" && requestedSegments.length > 1) {
    // Support users selecting either the project root folder or the quizzes folder itself.
    candidatePaths.push(requestedSegments.slice(1));
  }

  for (const pathSegments of candidatePaths) {
    try {
      const segments = [...pathSegments];
      const fileName = segments.pop();
      if (!fileName) continue;

      let directoryHandle = rootHandle;
      for (const segment of segments) {
        directoryHandle = await directoryHandle.getDirectoryHandle(segment, { create: false });
      }

      const fileHandle = await directoryHandle.getFileHandle(fileName, { create: false });
      const file = await fileHandle.getFile();
      const text = await file.text();
      return JSON.parse(text);
    } catch (pathError) {
      // Try the next candidate path.
    }
  }

  throw new Error("Could not find quiz file in selected folder.");
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

function normalizeTimeMode(value) {
  const mode = String(value || "digital").trim().toLowerCase();
  if (["digital", "analog", "analog-to-digital"].includes(mode)) return mode;
  return "digital";
}

function normalizeTimeHour(value) {
  const hour = Number.parseInt(value, 10);
  if (!Number.isInteger(hour)) return 12;
  if (hour < 1) return 1;
  if (hour > 12) return 12;
  return hour;
}

function normalizeTimeMinute(value) {
  const minute = Number.parseInt(value, 10);
  if (!Number.isInteger(minute)) return 0;
  if (minute < 0) return 0;
  if (minute > 59) return 59;
  return minute;
}

function normalizeTimePeriod(value) {
  const period = String(value || "").trim().toUpperCase();
  return period === "AM" || period === "PM" ? period : "";
}

function formatTimeDisplay(hour, minute, period = "") {
  const hh = normalizeTimeHour(hour);
  const mm = String(normalizeTimeMinute(minute)).padStart(2, "0");
  const suffix = normalizeTimePeriod(period);
  return suffix ? `${hh}:${mm} ${suffix}` : `${hh}:${mm}`;
}

function parseTimeText(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return null;

  const matched = raw.match(/^(\d{1,2})\s*[:.]\s*([0-5]?\d)(?:\s*(AM|PM))?$/i);
  if (!matched) return null;

  const originalHour = Number.parseInt(matched[1], 10);
  if (!Number.isInteger(originalHour)) return null;

  const hour = normalizeTimeHour(originalHour);
  const minute = normalizeTimeMinute(matched[2]);
  const period = normalizeTimePeriod(matched[3] || "");

  if (!period && (originalHour === 0 || originalHour > 12)) {
    const hour24 = Math.max(0, Math.min(23, originalHour));
    const derivedPeriod = hour24 >= 12 ? "PM" : "AM";
    const hour12 = ((hour24 + 11) % 12) + 1;
    return {
      hour: hour12,
      minute,
      period: derivedPeriod,
      format: "24h",
      minutesOfDay: (hour24 * 60) + minute,
      minutesOnClock: ((hour12 % 12) * 60) + minute,
      hasPeriod: true
    };
  }

  const hour24 = period === "PM"
    ? ((hour % 12) + 12)
    : period === "AM"
      ? (hour % 12)
      : null;
  return {
    hour,
    minute,
    period,
    format: period ? "12h" : "12h-implicit",
    minutesOfDay: Number.isInteger(hour24) ? (hour24 * 60) + minute : null,
    minutesOnClock: ((hour % 12) * 60) + minute,
    hasPeriod: period !== ""
  };
}

function pad2(value) {
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num)) return "00";
  return String(num).padStart(2, "0");
}

function buildInitialAnalogTime(targetHour, targetMinute) {
  const safeHour = normalizeTimeHour(targetHour);
  const safeMinute = normalizeTimeMinute(targetMinute);
  let startHour = safeHour;
  let startMinute = (safeMinute + 25) % 60;
  if (safeMinute + 25 >= 60) {
    startHour = startHour === 12 ? 1 : startHour + 1;
  }

  // Safety guard: ensure we never initialize exactly on the target time.
  if (startHour === safeHour && startMinute === safeMinute) {
    startMinute = (safeMinute + 30) % 60;
    if (safeMinute + 30 >= 60) {
      startHour = startHour === 12 ? 1 : startHour + 1;
    }
  }

  return { hour: startHour, minute: startMinute };
}

function buildTimeClockNumbersMarkup() {
  return Array.from({ length: 12 }, (_, index) => {
    const number = index + 1;
    const angle = number * 30;
    return `<span class="time-clock-number" style="--angle:${angle}deg">${number}</span>`;
  }).join("");
}

function buildTimeClockMarkup(config, { withReadout = true } = {}) {
  const safeConfig = config && typeof config === "object" ? config : {};
  const hour = normalizeTimeHour(safeConfig.hour);
  const minute = normalizeTimeMinute(safeConfig.minute);
  const period = normalizeTimePeriod(safeConfig.period);
  const minuteAngle = minute * 6;
  const hourAngle = (hour % 12) * 30;
  const display = formatTimeDisplay(hour, minute, period);

  return `
    <div class="time-clock-panel">
      <div class="time-analog-face" aria-hidden="true">
        ${buildTimeClockNumbersMarkup()}
        <span class="time-center-dot"></span>
        <span class="time-hand hour" style="transform: translate(-50%, -100%) rotate(${hourAngle}deg);"></span>
        <span class="time-hand minute" style="transform: translate(-50%, -100%) rotate(${minuteAngle}deg);"></span>
      </div>
      ${withReadout ? `<p class="helper-text">${escapeHtml(display)}</p>` : ""}
    </div>
  `;
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
  return `${fraction.numerator}/${fraction.denominator}`;
}

function fractionHtmlStacked(fraction) {
  if (!fraction) return "<span>?</span>";
  const signHtml = fraction.numerator < 0 ? '<span class="frac-sign">-</span>' : "";
  const num = escapeHtml(String(Math.abs(fraction.numerator)));
  const den = escapeHtml(String(fraction.denominator));
  return `<span class="frac-wrap">${signHtml}<span class="frac"><span class="frac-num">${num}</span><span class="frac-den">${den}</span></span></span>`;
}

function renderStepText(text) {
  return escapeHtml(String(text)).replace(/(\d+)\/(\d+)/g, '<span class="frac-wrap"><span class="frac"><span class="frac-num">$1</span><span class="frac-den">$2</span></span></span>');
}

function parseFractionText(value) {
  const text = String(value || "").trim();
  const fractionMatch = text.match(/^(-?\d+)\/(\d+)$/);
  if (fractionMatch) {
    return {
      numerator: Number(fractionMatch[1]),
      denominator: Number(fractionMatch[2])
    };
  }

  const integerMatch = text.match(/^-?\d+$/);
  if (integerMatch) {
    return {
      numerator: Number(text),
      denominator: 1
    };
  }

  return null;
}

function renderFractionValueText(value) {
  const parsed = parseFractionText(value);
  return parsed ? fractionHtmlStacked(parsed) : escapeHtml(String(value || ""));
}

function renderFractionExplanationText(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";

  const commonDenominatorPattern = raw.match(
    /^Use a common denominator:\s*\(([^()]+)\)\s*\/\s*\(([^()]+)\)\s*=\s*([^\.]+)\.\s*Simplify to\s*([^\.]+)\.?$/i
  );

  if (commonDenominatorPattern) {
    const [, numeratorExpression, denominatorExpression, unsimplifiedResult, simplifiedResult] = commonDenominatorPattern;
    return `
      <div class="fraction-explanation-blocks">
        <div class="fraction-explanation-block">
          <p class="fraction-explanation-label">Use a common denominator</p>
          <div class="fraction-explanation-math">
            <span class="fraction-explanation-work"><span class="fraction-explanation-top">(${escapeHtml(numeratorExpression.trim())})</span><span class="fraction-explanation-bottom">(${escapeHtml(denominatorExpression.trim())})</span></span>
            <span class="frac-op">=</span>
            ${renderFractionValueText(unsimplifiedResult.trim())}
          </div>
        </div>
        <div class="fraction-explanation-block">
          <p class="fraction-explanation-label">Simplify</p>
          <div class="fraction-explanation-math">
            ${renderFractionValueText(unsimplifiedResult.trim())}
            <span class="frac-op">=</span>
            ${renderFractionValueText(simplifiedResult.trim())}
          </div>
        </div>
      </div>
    `;
  }

  let html = escapeHtml(raw);

  html = html.replace(
    /Use a common denominator:\s*\(([^()]+)\)\s*\/\s*\(([^()]+)\)/gi,
    (_, numerator, denominator) => {
      const top = escapeHtml(numerator.trim());
      const bottom = escapeHtml(denominator.trim());
      return `Use a common denominator:<div class="fraction-explanation-work"><span class="fraction-explanation-top">(${top})</span><span class="fraction-explanation-bottom">(${bottom})</span></div>`;
    }
  );

  html = html.replace(/(-?\d+)\/(\d+)/g, (_, numerator, denominator) => {
    return fractionHtmlStacked({ numerator: Number(numerator), denominator: Number(denominator) });
  });

  return html.replace(/\n/g, "<br>");
}

function toMixedNumber(fraction) {
  if (!fraction || fraction.denominator === 1) return null;
  const absNum = Math.abs(fraction.numerator);
  if (absNum < fraction.denominator) return null;
  const whole = Math.floor(absNum / fraction.denominator);
  const remainder = absNum % fraction.denominator;
  const sign = fraction.numerator < 0 ? -1 : 1;
  return { whole: sign * whole, numerator: remainder, denominator: fraction.denominator };
}

function fractionHtmlMixed(fraction) {
  if (!fraction) return "<span>?</span>";
  const mixed = toMixedNumber(fraction);
  if (!mixed) return fractionHtmlStacked(fraction);
  const wholeHtml = `<span class="mixed-whole">${escapeHtml(String(mixed.whole))}</span>`;
  if (mixed.numerator === 0) return wholeHtml;
  const fracHtml = `<span class="frac-wrap"><span class="frac"><span class="frac-num">${escapeHtml(String(mixed.numerator))}</span><span class="frac-den">${escapeHtml(String(mixed.denominator))}</span></span></span>`;
  return `<span class="mixed-number">${wholeHtml}${fracHtml}</span>`;
}

function fractionHtmlImproperAndMixed(fraction) {
  if (!fraction) return "<span>?</span>";
  const mixed = toMixedNumber(fraction);
  if (!mixed || mixed.numerator === 0) return fractionHtmlStacked(fraction);
  return `<span class="fraction-dual-answer">${fractionHtmlStacked(fraction)}<span class="frac-op">=</span>${fractionHtmlMixed(fraction)}</span>`;
}

function renderQuestionText(text) {
  // Escape HTML first, then replace digit/digit patterns with stacked fraction HTML
  // After fractions are replaced, any remaining standalone / is a division operator — swap for ÷
  return escapeHtml(String(text))
    .replace(/(\d+)\/(\d+)/g, '<span class="frac-wrap"><span class="frac"><span class="frac-num">$1</span><span class="frac-den">$2</span></span></span>')
    .replace(/ \/ /g, ' ÷ ');
}

function lcmFraction(a, b) {
  const x = Math.abs(Math.trunc(Number(a)));
  const y = Math.abs(Math.trunc(Number(b)));
  if (!x || !y) return 0;
  return Math.abs(x * y) / gcdFraction(x, y);
}

function buildFractionReasonTable({ title, kind, targetValue, numberA, numberB }) {
  const size = 12;
  const target = Math.abs(Math.trunc(Number(targetValue)));
  const first = Math.abs(Math.trunc(Number(numberA)));
  const second = Math.abs(Math.trunc(Number(numberB)));

  if (!target || !first || !second) return "";

  const targetFitsLcd = kind !== "lcd" || target <= size * size;
  const targetFitsHcf = kind !== "hcf" || target <= size;
  if (!targetFitsLcd || !targetFitsHcf) return "";

  const headers = Array.from({ length: size }, (_, index) => index + 1);
  let targetMarked = false;

  const rowsMarkup = headers.map((rowValue) => {
    const cellsMarkup = headers.map((colValue) => {
      const cellValue = rowValue * colValue;
      let cellClasses = ["fraction-times-cell"];
      let isTarget = false;

      if (kind === "lcd") {
        const isMultipleA = cellValue % first === 0;
        const isMultipleB = cellValue % second === 0;
        const isCommon = isMultipleA && isMultipleB;
        if (isMultipleA) cellClasses.push("is-first");
        if (isMultipleB) cellClasses.push("is-second");
        if (isCommon) cellClasses.push("is-common");
        if (!targetMarked && isCommon && cellValue === target) {
          cellClasses.push("is-target");
          isTarget = true;
          targetMarked = true;
        }
      } else if (rowValue === 1) {
        const factorValue = colValue;
        const isFactorA = first % factorValue === 0;
        const isFactorB = second % factorValue === 0;
        const isCommon = isFactorA && isFactorB;
        if (isFactorA) cellClasses.push("is-first");
        if (isFactorB) cellClasses.push("is-second");
        if (isCommon) cellClasses.push("is-common");
        if (!targetMarked && isCommon && factorValue === target) {
          cellClasses.push("is-target");
          isTarget = true;
          targetMarked = true;
        }
      }

      return `<td class="${cellClasses.join(" ")}"${isTarget ? ' aria-label="Selected value"' : ""}>${cellValue}</td>`;
    }).join("");

    return `
      <tr>
        <th scope="row" class="fraction-times-header">${rowValue}</th>
        ${cellsMarkup}
      </tr>
    `;
  }).join("");

  const intro = kind === "lcd"
    ? `The circled ${target} is the first common multiple of ${first} and ${second} in the 12 x 12 times table, so it is the Lowest Common Denominator (LCD).`
    : `On the first row of the 12 x 12 times table, the circled ${target} is the largest number from 1 to 12 that divides both ${first} and ${second}, so it is the Highest Common Factor (HCF).`;
  const firstLegend = kind === "lcd" ? `Multiples of ${first}` : `Factors of ${first}`;
  const secondLegend = kind === "lcd" ? `Multiples of ${second}` : `Factors of ${second}`;
  const commonLegend = kind === "lcd" ? "Common multiples" : "Common factors";
  const targetLegend = kind === "lcd" ? "Chosen LCD" : "Chosen HCF";
  const toggleLabel = kind === "lcd"
    ? `Show 12 x 12 table for Lowest Common Denominator (LCD)`
    : `Show 12 x 12 table for Highest Common Factor (HCF)`;

  return `
    <details class="fraction-visual-card">
      <summary class="fraction-visual-toggle">${escapeHtml(toggleLabel)}</summary>
      <p class="fraction-visual-title">${escapeHtml(title)}</p>
      <p class="fraction-visual-note">${escapeHtml(intro)}</p>
      <div class="fraction-times-wrap">
        <table class="fraction-times-table" aria-label="${escapeHtml(title)} times table visual">
          <thead>
            <tr>
              <th class="fraction-times-corner">×</th>
              ${headers.map((value) => `<th scope="col" class="fraction-times-header">${value}</th>`).join("")}
            </tr>
          </thead>
          <tbody>
            ${rowsMarkup}
          </tbody>
        </table>
      </div>
      <div class="fraction-times-legend">
        <span class="fraction-times-key is-first">${escapeHtml(firstLegend)}</span>
        <span class="fraction-times-key is-second">${escapeHtml(secondLegend)}</span>
        <span class="fraction-times-key is-common">${escapeHtml(commonLegend)}</span>
        <span class="fraction-times-key is-target">${escapeHtml(targetLegend)}</span>
      </div>
    </details>
  `;
}

function buildLcdMultiplierMarkup(fractionA, fractionB, lcmValue) {
  const scaleA = lcmValue / fractionA.denominator;
  const scaleB = lcmValue / fractionB.denominator;
  const newNumA = fractionA.numerator * scaleA;
  const newNumB = fractionB.numerator * scaleB;

  const row = (frac, scale, newNum) => {
    const fracHtml = fractionHtmlStacked(frac);
    const scaledHtml = fractionHtmlStacked({ numerator: newNum, denominator: lcmValue });
    return `
      <div class="lcd-multiplier-row">
        ${fracHtml}
        <span class="frac-op">=</span>
        <span class="lcd-multiplier-badge">× ${scale}</span>
        <span class="frac-op lcd-multiplier-arrow">→</span>
        ${scaledHtml}
      </div>`;
  };

  return `
    <div class="lcd-multiplier-block">
      <p class="lcd-multiplier-label">Multiply both parts by the same number to reach <strong>${lcmValue}</strong></p>
      ${row(fractionA, scaleA, newNumA)}
      ${row(fractionB, scaleB, newNumB)}
    </div>`;
}

function buildStayChangeFlipMarkup(summary) {
  if (!summary || summary.error || summary.operation !== "divide") return "";

  const a = summary.fractionA;
  const b = summary.fractionB;
  const flippedB = { numerator: b.denominator, denominator: b.numerator };

  return `
    <div class="scf-combo-block">
      <div class="scf-combo-panels" role="group" aria-label="Stay Change Flip guide">
        <span class="scf-chip scf-stay">Stay: ${fractionHtmlStacked(a)}</span>
        <span class="scf-chip scf-change">Change: / to x</span>
        <span class="scf-chip scf-flip">Flip: ${fractionHtmlStacked(b)} to ${fractionHtmlStacked(flippedB)}</span>
      </div>
      <div class="scf-before-after" role="group" aria-label="Before and after Stay Change Flip">
        <div class="scf-summary-card scf-before">
          <p class="scf-summary-label">Before</p>
          <p class="scf-summary-expression">${fractionHtmlStacked(a)} <span class="frac-op">÷</span> ${fractionHtmlStacked(b)}</p>
        </div>
        <div class="scf-summary-arrow">→</div>
        <div class="scf-summary-card scf-after">
          <p class="scf-summary-label">After</p>
          <p class="scf-summary-expression">${fractionHtmlStacked(a)} <span class="frac-op">x</span> ${fractionHtmlStacked(flippedB)}</p>
        </div>
      </div>
    </div>
  `;
}

function buildFractionReasonVisuals(summary) {
  if (!summary || summary.error) return "";

  const visuals = [];
  if (summary.lcmValue) {
    visuals.push(buildFractionReasonTable({
      title: "Lowest Common Denominator (LCD)",
      kind: "lcd",
      targetValue: summary.lcmValue,
      numberA: summary.fractionA.denominator,
      numberB: summary.fractionB.denominator
    }));
  }

  const filtered = visuals.filter((item) => String(item).trim() !== "");
  return filtered.length > 0 ? `<div class="fraction-visual-stack">${filtered.join("")}</div>` : "";
}

function buildMixedToImproperArrowDiagram(summary) {
  if (!summary || summary.error || summary.conversionMode !== "mixed-to-improper" || !summary.mixedInput) {
    return "";
  }

  const whole = Number(summary.mixedInput.whole);
  const numerator = Number(summary.mixedInput.numerator);
  const denominator = Number(summary.mixedInput.denominator);
  const absWhole = Math.abs(whole);
  const product = denominator * absWhole;
  const absImproperNumerator = Math.abs(Number(summary.rawNumerator));
  const improperDenominator = Number(summary.rawDenominator);

  if (!Number.isFinite(whole) || !Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return "";
  }

  const signNote = whole < 0
    ? `<p class="mixed-arrow-sign-note">Because the whole number is negative, the final numerator stays negative.</p>`
    : "";

  const mixedFractionHtml = `
    <span class="mixed-map-expression" aria-label="mixed fraction">
      <span class="mixed-map-whole">${escapeHtml(String(whole))}</span>
      <span class="mixed-map-frac">
        <span class="mixed-map-num">${escapeHtml(String(numerator))}</span>
        <span class="mixed-map-line"></span>
        <span class="mixed-map-den">${escapeHtml(String(denominator))}</span>
      </span>
    </span>
  `;

  return `
    <div class="fraction-section">
      <p class="fraction-steps-heading">Change Mixed Number to Improper Fraction</p>
      <div class="mixed-arrow-card" role="group" aria-label="Mixed to improper conversion diagram">
        <div class="mixed-arrow-canvas">
          <p class="mixed-arrow-row-label">Use this easy 3-step recipe</p>
          <div class="mixed-map-stage" aria-label="mixed fraction map">
            <div class="mixed-map-start">
              <span class="mixed-map-start-label">Start Here</span>
              ${mixedFractionHtml}
            </div>
            <ol class="mixed-step-list" aria-label="Conversion steps">
              <li class="mixed-step-item">
                <span class="mixed-step-index">1</span>
                <div class="mixed-step-copy">
                  <p class="mixed-step-title">Multiply the bottom number (denominator) by the whole number.</p>
                  <p class="mixed-step-equation">${escapeHtml(String(denominator))} x ${escapeHtml(String(absWhole))} = ${escapeHtml(String(product))}</p>
                </div>
              </li>
              <li class="mixed-step-item">
                <span class="mixed-step-index">2</span>
                <div class="mixed-step-copy">
                  <p class="mixed-step-title">Add the top number (numerator). This gives the new top number.</p>
                  <p class="mixed-step-equation">${escapeHtml(String(product))} + ${escapeHtml(String(numerator))} = ${escapeHtml(String(absImproperNumerator))}</p>
                </div>
              </li>
              <li class="mixed-step-item">
                <span class="mixed-step-index">3</span>
                <div class="mixed-step-copy">
                  <p class="mixed-step-title">Keep the same bottom number (denominator).</p>
                  <p class="mixed-step-equation">Denominator stays ${escapeHtml(String(improperDenominator))}</p>
                </div>
              </li>
            </ol>
          </div>
        </div>
        <p class="mixed-arrow-formula">New numerator = (${escapeHtml(String(denominator))} x ${escapeHtml(String(absWhole))}) + ${escapeHtml(String(numerator))} = ${escapeHtml(String(absImproperNumerator))}</p>
        ${signNote}
        <p class="mixed-arrow-final">Improper fraction: ${fractionHtmlStacked({ numerator: summary.rawNumerator, denominator: improperDenominator })}</p>
      </div>
    </div>
  `;
}

function buildImproperToMixedDiagram(summary) {
  if (!summary || summary.error || summary.conversionMode !== "improper-to-mixed" || !summary.fractionA) {
    return "";
  }

  const numerator = Number(summary.fractionA.numerator);
  const denominator = Number(summary.fractionA.denominator);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return "";
  }

  const absNumerator = Math.abs(numerator);
  const whole = Math.floor(absNumerator / denominator);
  const remainder = absNumerator % denominator;
  const remainderText = remainder === 0
    ? "No remainder, so there is no fraction part."
    : `Remainder is ${escapeHtml(String(remainder))}, so the fraction part is ${escapeHtml(String(remainder))}/${escapeHtml(String(denominator))}.`;

  return `
    <div class="fraction-section">
      <p class="fraction-steps-heading">Change Improper Fraction to Mixed Number</p>
      <div class="mixed-arrow-card" role="group" aria-label="Improper to mixed conversion diagram">
        <div class="mixed-arrow-canvas">
          <p class="mixed-arrow-row-label">Use this easy 3-step recipe</p>
          <div class="mixed-map-stage" aria-label="improper fraction map">
            <div class="mixed-map-start">
              <span class="mixed-map-start-label">Start Here</span>
              ${fractionHtmlStacked(summary.fractionA)}
            </div>
            <ol class="mixed-step-list" aria-label="Conversion steps">
              <li class="mixed-step-item">
                <span class="mixed-step-index">1</span>
                <div class="mixed-step-copy">
                  <p class="mixed-step-title">Divide the top number by the bottom number.</p>
                  <p class="mixed-step-equation">${escapeHtml(String(absNumerator))} ÷ ${escapeHtml(String(denominator))} = ${escapeHtml(String(whole))} remainder ${escapeHtml(String(remainder))}</p>
                </div>
              </li>
              <li class="mixed-step-item">
                <span class="mixed-step-index">2</span>
                <div class="mixed-step-copy">
                  <p class="mixed-step-title">The quotient becomes the whole number.</p>
                  <p class="mixed-step-equation">Whole number = ${escapeHtml(String(whole))}</p>
                </div>
              </li>
              <li class="mixed-step-item">
                <span class="mixed-step-index">3</span>
                <div class="mixed-step-copy">
                  <p class="mixed-step-title">Use the remainder as the new top number and keep the same bottom number.</p>
                  <p class="mixed-step-equation">${remainderText}</p>
                </div>
              </li>
            </ol>
          </div>
        </div>
        <p class="mixed-arrow-final">Mixed number: ${fractionHtmlMixed(summary.result)}</p>
      </div>
    </div>
  `;
}

function extractMixedNumberFromQuestionText(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const match = raw.match(/(-?\d+)\s*(?:and\s*)?(\d+)\s*\/\s*(\d+)/i);
  if (!match) return null;

  const whole = Number.parseInt(match[1], 10);
  const numerator = Number.parseInt(match[2], 10);
  const denominator = Number.parseInt(match[3], 10);
  if (!Number.isFinite(whole) || !Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }
  if (numerator < 0) return null;

  return {
    whole,
    numerator,
    denominator: Math.abs(denominator)
  };
}

function buildFractionOperationSummary(config, questionText = "") {
  const operation = normalizeFractionOperation(config && config.operation);
  const answerFormat = String(config && config.answerFormat ? config.answerFormat : "").trim().toLowerCase();
  const titleText = String(config && config.title ? config.title : "").trim().toLowerCase();
  const fractionA = simplifyFraction(config && config.fractionA && config.fractionA.numerator, config && config.fractionA && config.fractionA.denominator);
  const fractionB = simplifyFraction(config && config.fractionB && config.fractionB.numerator, config && config.fractionB && config.fractionB.denominator);
  if (!fractionA || !fractionB) {
    return { error: "Enter two valid fractions with non-zero denominators." };
  }

  const isZeroB = fractionB.numerator === 0;
  const sameDenominator = fractionA.denominator === fractionB.denominator;
  const looksLikeImproperToMixedTemplate = titleText.includes("improper") && titleText.includes("mixed");
  const looksLikeMixedToImproperTemplate = titleText.includes("mixed") && titleText.includes("improper");
  const isImproperToMixedConversion = answerFormat === "mixed"
    && fractionA.numerator > fractionA.denominator
    && (looksLikeImproperToMixedTemplate || (operation === "add" && isZeroB && sameDenominator));
  const parsedMixedFromQuestion = extractMixedNumberFromQuestionText(questionText);
  const isMixedToImproperConversion = answerFormat === "improper"
    && !!parsedMixedFromQuestion
    && (looksLikeMixedToImproperTemplate || (operation === "add" && isZeroB));

  if (operation === "divide" && fractionB.numerator === 0) {
    return { error: "Division by zero is undefined. Fraction B numerator must not be 0." };
  }

  const symbols = { add: "+", subtract: "-", multiply: "x", divide: "÷" };
  const labels = { add: "Addition", subtract: "Subtraction", multiply: "Multiplication", divide: "Division" };
  const steps = [];
  const whyLines = [];

  let rawNumerator = 0;
  let rawDenominator = 1;
  let lcmValue = null;

  if (isImproperToMixedConversion) {
    rawNumerator = fractionA.numerator;
    rawDenominator = fractionA.denominator;
    const whole = Math.floor(Math.abs(rawNumerator) / Math.abs(rawDenominator));
    const remainder = Math.abs(rawNumerator) % Math.abs(rawDenominator);
    whyLines.push(`To change an improper fraction to a mixed number, divide top by bottom.`);
    steps.push(`Start with the improper fraction ${rawNumerator}/${rawDenominator}.`);
    steps.push(`${Math.abs(rawNumerator)} ÷ ${Math.abs(rawDenominator)} = ${whole} remainder ${remainder}.`);
    steps.push(`Whole number is ${whole}, and the fraction part is ${remainder}/${Math.abs(rawDenominator)}.`);
  } else if (isMixedToImproperConversion) {
    const mixedWhole = parsedMixedFromQuestion.whole;
    const mixedNumerator = parsedMixedFromQuestion.numerator;
    const mixedDenominator = parsedMixedFromQuestion.denominator;
    const sign = mixedWhole < 0 ? -1 : 1;
    const absWhole = Math.abs(mixedWhole);
    rawNumerator = sign * ((absWhole * mixedDenominator) + mixedNumerator);
    rawDenominator = mixedDenominator;
    whyLines.push("To change a mixed number to an improper fraction, multiply then add.");
    steps.push(`Start with mixed number ${mixedWhole} and ${mixedNumerator}/${mixedDenominator}.`);
    steps.push(`${mixedDenominator} x ${absWhole} + ${mixedNumerator} = ${Math.abs(rawNumerator)}.`);
    steps.push(`Keep the same denominator: ${rawNumerator}/${rawDenominator}.`);
  } else if (operation === "add" || operation === "subtract") {
    lcmValue = lcmFraction(fractionA.denominator, fractionB.denominator);
    const scaleA = lcmValue / fractionA.denominator;
    const scaleB = lcmValue / fractionB.denominator;
    const adjustedA = fractionA.numerator * scaleA;
    const adjustedB = fractionB.numerator * scaleB;
    rawNumerator = operation === "add" ? adjustedA + adjustedB : adjustedA - adjustedB;
    rawDenominator = lcmValue;
    whyLines.push(`Lowest Common Denominator (LCD) is ${lcmValue} because it is the smallest denominator that both ${fractionA.denominator} and ${fractionB.denominator} divide into exactly.`);
    steps.push(`Lowest Common Denominator (LCD) = ${lcmValue}, so both fractions can use the same denominator.`);
    steps.push(`${fractionA.numerator}/${fractionA.denominator} = ${adjustedA}/${lcmValue} and ${fractionB.numerator}/${fractionB.denominator} = ${adjustedB}/${lcmValue}.`);
    steps.push(`${adjustedA}/${lcmValue} ${symbols[operation]} ${adjustedB}/${lcmValue} = ${rawNumerator}/${rawDenominator}.`);
  } else if (operation === "multiply") {
    rawNumerator = fractionA.numerator * fractionB.numerator;
    rawDenominator = fractionA.denominator * fractionB.denominator;
    whyLines.push("No LCD is needed for multiplication because denominators are multiplied directly, not matched.");
    steps.push("No LCM is needed for multiplication because we multiply across directly.");
    steps.push(`Multiply the numerators: ${fractionA.numerator} x ${fractionB.numerator} = ${rawNumerator}.`);
    steps.push(`Multiply the denominators: ${fractionA.denominator} x ${fractionB.denominator} = ${rawDenominator}.`);
    steps.push(`${fractionA.numerator}/${fractionA.denominator} x ${fractionB.numerator}/${fractionB.denominator} = ${rawNumerator}/${rawDenominator}.`);
  } else {
    rawNumerator = fractionA.numerator * fractionB.denominator;
    rawDenominator = fractionA.denominator * fractionB.numerator;
    whyLines.push("Division of fractions uses Stay, Change, Flip: keep the first fraction, change ÷ to x, then flip the second fraction.");
    steps.push(`Multiply the numerators: ${fractionA.numerator} x ${fractionB.denominator} = ${rawNumerator}.`);
    steps.push(`Multiply the denominators: ${fractionA.denominator} x ${fractionB.numerator} = ${rawDenominator}.`);
    steps.push(`= ${rawNumerator}/${rawDenominator}.`);
  }

  const simplified = simplifyFraction(rawNumerator, rawDenominator);
  if (!simplified) {
    return { error: "Could not compute this fraction operation." };
  }

  const hcfValue = gcdFraction(rawNumerator, rawDenominator);
  if (hcfValue > 1) {
    whyLines.push(`Highest Common Factor (HCF) is ${hcfValue} because it is the largest number that divides both ${Math.abs(rawNumerator)} and ${Math.abs(rawDenominator)} exactly.`);
    steps.push(`Highest Common Factor (HCF) = ${hcfValue}, so divide numerator and denominator by ${hcfValue}.`);
  }

  const mixed = toMixedNumber(simplified);
  const useMixed = !!mixed && mixed.numerator > 0 && (
    answerFormat === "mixed" || operation === "multiply"
  );

  if (useMixed) {
    steps.push(`Convert to a mixed number: ${simplified.numerator}/${simplified.denominator} = ${mixed.whole} and ${mixed.numerator}/${mixed.denominator}.`);
  }

  return {
    operation,
    operationLabel: labels[operation],
    symbol: symbols[operation],
    fractionA,
    fractionB,
    rawNumerator,
    rawDenominator,
    result: simplified,
    mixed: useMixed ? mixed : null,
    conversionMode: isImproperToMixedConversion
      ? "improper-to-mixed"
      : (isMixedToImproperConversion ? "mixed-to-improper" : "operation"),
    mixedInput: isMixedToImproperConversion ? parsedMixedFromQuestion : null,
    lcmValue,
    hcfValue,
    whyLines,
    steps
  };
}

function buildFractionsMarkup(config, questionText = "") {
  const summary = buildFractionOperationSummary(config || {}, questionText);
  if (summary.error) {
    return `<p class='helper-text'>${escapeHtml(summary.error)}</p>`;
  }

  const buildFractionStepTitle = (stepText) => {
    const text = String(stepText || "");
    if (text.startsWith("Start with the improper fraction")) return "Start with the fraction";
    if (text.includes("remainder")) return "Divide and find the remainder";
    if (text.startsWith("Whole number is")) return "Write the mixed number";
    if (text.startsWith("Start with mixed number")) return "Start with the mixed number";
    if (text.includes("x") && text.includes("+") && text.includes("=")) return "Find the new numerator";
    if (text.startsWith("Put that over the same denominator")) return "Keep the same denominator";
    if (text.startsWith("Lowest Common Denominator (LCD)")) return "Find Lowest Common Denominator (LCD)";
    if (text.includes("= ") && text.includes(" and ") && text.includes("/")) return "Rewrite equivalent fractions";
    if (text.startsWith("Stay:")) return "Stay";
    if (text.startsWith("Change:")) return "Change";
    if (text.startsWith("Flip:")) return "Flip";
    if (text.startsWith("Use Stay, Change, Flip")) return "Use Stay, Change, Flip";
    if (text.startsWith("No LCM is needed")) return "Choose the operation method";
    if (text.startsWith("Multiply the numerators")) return "Calculate numerator";
    if (text.startsWith("Multiply the denominators")) return "Calculate denominator";
    if (text.startsWith("Highest Common Factor (HCF)")) return "Simplify using Highest Common Factor (HCF)";
    if (text.startsWith("Convert to a mixed number")) return "Convert to mixed number";
    if (text.startsWith("=")) return "Write the result";
    return "Calculate";
  };

  const getFractionStepToneClass = (stepTitleText) => {
    if (stepTitleText === "Stay") return "step-tone-stay";
    if (stepTitleText === "Change") return "step-tone-change";
    if (stepTitleText === "Flip") return "step-tone-flip";
    if (stepTitleText === "Calculate numerator" || stepTitleText === "Calculate denominator") return "step-tone-calc";
    if (stepTitleText === "Simplify using Highest Common Factor (HCF)") return "step-tone-simplify";
    if (stepTitleText === "Convert to mixed number") return "step-tone-mixed";
    if (stepTitleText === "Find Lowest Common Denominator (LCD)" || stepTitleText === "Rewrite equivalent fractions") return "step-tone-lcd";
    return "step-tone-neutral";
  };

  let lcdMultiplierPlaced = false;
  let scfPanelPlaced = false;
  const stepMarkup = summary.steps
    .map((step) => {
      const stepTitleText = buildFractionStepTitle(step);
      const title = escapeHtml(stepTitleText);
      const toneClass = getFractionStepToneClass(stepTitleText);
      const shouldShowLcdMultiplier =
        !lcdMultiplierPlaced
        && summary.lcmValue
        && (summary.operation === "add" || summary.operation === "subtract")
        && stepTitleText === "Calculate";
      const shouldShowHcfVisual =
        summary.hcfValue > 1
        && stepTitleText === "Simplify using Highest Common Factor (HCF)";
      const shouldShowScfPanel =
        !scfPanelPlaced
        && summary.operation === "divide"
        && stepTitleText === "Calculate numerator";

      if (shouldShowLcdMultiplier) lcdMultiplierPlaced = true;
      if (shouldShowScfPanel) scfPanelPlaced = true;

      const lcdBeforeCalculateMarkup = shouldShowLcdMultiplier
        ? `<li class="step-tone-lcd"><span class="fraction-step-title">Scale To LCD</span>${buildLcdMultiplierMarkup(summary.fractionA, summary.fractionB, summary.lcmValue)}</li>`
        : "";
      const scfBeforeCalculateMarkup = shouldShowScfPanel
        ? `<li class="step-tone-neutral"><span class="fraction-step-title">Stay + Change + Flip</span>${buildStayChangeFlipMarkup(summary)}</li>`
        : "";

      return `${lcdBeforeCalculateMarkup}${scfBeforeCalculateMarkup}<li class="${toneClass}"><span class="fraction-step-title">${title}</span><span class="fraction-step-copy">${renderStepText(step)}</span>${shouldShowHcfVisual ? buildFractionReasonTable({
        title: "Highest Common Factor (HCF)",
        kind: "hcf",
        targetValue: summary.hcfValue,
        numberA: Math.abs(summary.rawNumerator),
        numberB: Math.abs(summary.rawDenominator)
      }) : ""}</li>`;
    })
    .join("");
  const whyMarkup = (Array.isArray(summary.whyLines) ? summary.whyLines : [])
    .map((line) => `<p class="fraction-why-line">${renderStepText(line)}</p>`)
    .join("");
  const reasonVisualMarkup = buildFractionReasonVisuals(summary);
  const improperToMixedDiagramMarkup = buildImproperToMixedDiagram(summary);
  const mixedToImproperDiagramMarkup = buildMixedToImproperArrowDiagram(summary);
  const conversionDiagramMarkup = `${improperToMixedDiagramMarkup}${mixedToImproperDiagramMarkup}`;
  const isConversionQuestion = summary.conversionMode === "improper-to-mixed" || summary.conversionMode === "mixed-to-improper";
  const shouldShowGenericSteps = !isConversionQuestion;
  const whySection = whyMarkup
    ? `<div class="fraction-section"><p class="fraction-steps-heading">Why These Numbers?</p>${whyMarkup}${reasonVisualMarkup}</div>`
    : reasonVisualMarkup;
  const guidanceText = summary.conversionMode === "mixed-to-improper"
    ? "Use the 3-step recipe: multiply, add, then keep the same denominator."
    : summary.conversionMode === "improper-to-mixed"
      ? "Use the 3-step recipe: divide, use the quotient as whole number, then use the remainder over the same denominator."
      : "Follow each step in order. Find LCD/HCF first, then calculate the result.";

  const resultMarkup = fractionHtmlImproperAndMixed(summary.result);
  const finalEquation = summary.conversionMode === "improper-to-mixed"
    ? `${fractionHtmlStacked(summary.fractionA)} <span class="frac-op">=</span> ${fractionHtmlMixed(summary.result)}`
    : summary.conversionMode === "mixed-to-improper" && summary.mixedInput
      ? `${fractionHtmlMixed({ numerator: (summary.mixedInput.whole < 0 ? -1 : 1) * ((Math.abs(summary.mixedInput.whole) * summary.mixedInput.denominator) + summary.mixedInput.numerator), denominator: summary.mixedInput.denominator })} <span class="frac-op">=</span> ${fractionHtmlStacked(summary.result)}`
      : `${fractionHtmlStacked(summary.fractionA)} <span class="frac-op">${escapeHtml(summary.symbol)}</span> ${fractionHtmlStacked(summary.fractionB)} <span class="frac-op">=</span> ${resultMarkup}`;
  const questionIntro = String(questionText || "").trim();
  const questionMarkup = questionIntro
    ? `<div class="fraction-section"><p class="fraction-steps-heading">Question</p><p class="fraction-question-context">${renderQuestionText(questionIntro)}</p></div>`
    : "";
  const stepsSectionMarkup = shouldShowGenericSteps
    ? `<p class="fraction-steps-heading">Steps</p><ol class="fraction-step-list">${stepMarkup}</ol>`
    : "";

  return `
    <div class="simple-card fraction-solution-card">
      ${questionMarkup}
      <p class="fraction-guidance">${escapeHtml(guidanceText)}</p>
      ${whySection}
      ${conversionDiagramMarkup}
      ${stepsSectionMarkup}
      <p class="fraction-steps-heading">Final Answer</p>
      <p class="fraction-equation">${finalEquation}</p>
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

function buildMatrixTableMarkup(matrix, caption, options = {}) {
  const { showDimensions = true } = options || {};
  if (!matrixIsRectangular(matrix)) {
    return `<div class="simple-card"><p>${escapeHtml(caption)}: invalid matrix</p></div>`;
  }
  const rows = matrix
    .map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(formatMatrixNumber(value))}</td>`).join("")}</tr>`)
    .join("");
  return `
    <div class="simple-card matrix-card">
      <p><strong>${escapeHtml(caption)}</strong>${showDimensions ? ` (${matrix.length}x${matrix[0].length})` : ""}</p>
      <div class="matrix-wrap" role="img" aria-label="${escapeHtml(caption)} ${matrix.length} by ${matrix[0].length}">
        <span class="matrix-bracket matrix-bracket-left" aria-hidden="true"></span>
        <table class="matrix-grid">
          <tbody>${rows}</tbody>
        </table>
        <span class="matrix-bracket matrix-bracket-right" aria-hidden="true"></span>
      </div>
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
  const v = String(value || "horizontal").trim().toLowerCase();
  if (v === "vertical") return "vertical";
  if (v === "long") return "long";
  return "horizontal";
}

function parseArithmeticLinkAnswerText(value) {
  const seenLeft = new Set();
  const seenRight = new Set();
  const pairs = String(value || "")
    .split("|")
    .map((item) => String(item || "").trim())
    .filter((item) => item !== "")
    .map((entry) => {
      const parts = entry.split(":");
      if (parts.length !== 2) return null;
      const left = Number.parseInt(parts[0], 10);
      const right = Number.parseInt(parts[1], 10);
      if (!Number.isInteger(left) || !Number.isInteger(right)) return null;
      if (seenLeft.has(left) || seenRight.has(right)) return null;
      seenLeft.add(left);
      seenRight.add(right);
      return { left, right };
    })
    .filter((item) => item !== null);
  return pairs.sort((a, b) => (a.left - b.left) || (a.right - b.right));
}

function serializeArithmeticLinkAnswerPairs(pairs) {
  return (Array.isArray(pairs) ? pairs : [])
    .filter((item) => item && Number.isInteger(item.left) && Number.isInteger(item.right))
    .sort((a, b) => (a.left - b.left) || (a.right - b.right))
    .map((item) => `${item.left}:${item.right}`)
    .join("|");
}

function normalizeArithmeticLinkConfig(config) {
  const linkOperator = String(config && config.linkOperator ? config.linkOperator : "+").trim() === "-" ? "-" : "+";
  const targetValueRaw = Number.parseInt(config && config.targetValue, 10);
  const legacyTargetRaw = Number.parseInt(config && config.targetSum, 10);
  const targetValue = Number.isInteger(targetValueRaw)
    ? targetValueRaw
    : (Number.isInteger(legacyTargetRaw) ? legacyTargetRaw : 10);
  const leftNumbers = Array.isArray(config && config.leftNumbers)
    ? config.leftNumbers.map((item) => Number.parseInt(item, 10)).filter((item) => Number.isInteger(item))
    : [];
  const fallbackLeft = leftNumbers.length > 0
    ? leftNumbers
    : (linkOperator === "-" ? [6, 7, 8, 9] : [1, 2, 3, 4]);
  const rightRaw = Array.isArray(config && config.rightNumbers)
    ? config.rightNumbers.map((item) => Number.parseInt(item, 10)).filter((item) => Number.isInteger(item))
    : [];
  const rightNumbers = rightRaw.length === fallbackLeft.length
    ? rightRaw
    : fallbackLeft.map((item) => (linkOperator === "-" ? item - targetValue : targetValue - item));

  const expectedPairs = Array.isArray(config && config.pairs)
    ? config.pairs
      .map((item) => ({
        left: Number.parseInt(item && item.left, 10),
        right: Number.parseInt(item && item.right, 10)
      }))
      .filter((item) => Number.isInteger(item.left) && Number.isInteger(item.right))
    : fallbackLeft.map((left) => ({
      left,
      right: linkOperator === "-" ? left - targetValue : targetValue - left
    }));

  return {
    linkOperator,
    targetValue,
    targetSum: targetValue,
    leftNumbers: fallbackLeft,
    rightNumbers,
    expectedPairs
  };
}

function computeArithmeticAnswerFromConfig(config) {
  const explicitAnswer = String(config && config.answer != null ? config.answer : "").trim();
  if (explicitAnswer !== "") {
    return explicitAnswer;
  }

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

function normalizeArithmeticVisualKind(value) {
  const kind = String(value || "ball").trim().toLowerCase();
  if (["ball", "car", "star"].includes(kind)) return kind;
  return "ball";
}

function adjustOperandsByDifficulty(operandA, operandB, operator, difficulty) {
  const level = Math.max(1, Math.min(10, difficulty || 5));
  const multiplier = level / 5;
  let adjustedA = Math.round(operandA * multiplier);
  let adjustedB = Math.round(operandB * multiplier);
  
  if (operator === "-") {
    adjustedA = Math.max(adjustedB, adjustedA);
  }
  if (operator === "/" || operator === "x" || operator === "*") {
    adjustedA = Math.max(1, Math.min(20, adjustedA));
    adjustedB = Math.max(1, Math.min(12, adjustedB));
  } else {
    adjustedA = Math.max(0, Math.min(30, adjustedA));
    adjustedB = Math.max(0, Math.min(30, adjustedB));
  }
  
  return { a: adjustedA, b: adjustedB };
}

function toVisualItemWord(config, count) {
  const rawPlural = String(config && config.visualLabel ? config.visualLabel : "objects").trim().toLowerCase() || "objects";
  const rawSingular = rawPlural.endsWith("s") && rawPlural.length > 1
    ? rawPlural.slice(0, -1)
    : rawPlural;
  const safeCount = Number.parseInt(count, 10);
  return safeCount === 1 ? rawSingular : rawPlural;
}

function buildProfessionalVisualArithmeticPrompt(config, fallbackQuestion = "") {
  const cfg = config && typeof config === "object" ? config : {};
  const operator = String(cfg.operator || "+").trim();
  const a = Number.parseInt(cfg.operandA, 10);
  const b = Number.parseInt(cfg.operandB, 10);
  if (!Number.isInteger(a) || !Number.isInteger(b)) {
    return String(fallbackQuestion || "").trim();
  }

  const labelA = toVisualItemWord(cfg, a);
  const labelB = toVisualItemWord(cfg, b);
  if (operator === "+") {
    const totalLabel = toVisualItemWord(cfg, a + b);
    return `A collection has ${a} ${labelA}, and another collection has ${b} ${labelB}. What is the total number of ${totalLabel}?`;
  }
  if (operator === "-") {
    const remainLabel = toVisualItemWord(cfg, Math.max(0, a - b));
    return `A set contains ${a} ${labelA}. If ${b} ${labelB} are removed, how many ${remainLabel} remain?`;
  }
  if (operator === "x" || operator === "*") {
    const totalLabel = toVisualItemWord(cfg, a * b);
    const groupWord = a === 1 ? "group" : "groups";
    return `There are ${a} ${groupWord}, with ${b} ${labelB} in each group. What is the total number of ${totalLabel}?`;
  }
  if (operator === "/" && b !== 0) {
    const itemLabel = toVisualItemWord(cfg, a);
    const groupWord = b === 1 ? "group" : "groups";
    return `${a} ${itemLabel} are shared equally into ${b} ${groupWord}. How many ${toVisualItemWord(cfg, Math.floor(a / b))} are in each group?`;
  }

  return String(fallbackQuestion || "").trim();
}

function buildArithmeticObjectIconSvg(kind) {
  if (kind === "car") {
    return `
      <svg viewBox="0 0 100 70" width="60" height="42" aria-hidden="true" focusable="false" shape-rendering="geometricPrecision">
        <!-- Car body with rounded shape -->
        <path d="M 15 45 Q 10 45 10 55 L 10 60 Q 10 65 15 65 L 85 65 Q 90 65 90 60 L 90 55 Q 90 45 85 45 L 70 45 Q 68 35 60 25 L 40 25 Q 32 35 30 45 Z" fill="#dc2626"></path>
        
        <!-- Front bumper -->
        <rect x="8" y="56" width="84" height="3" fill="#991b1b"></rect>
        
        <!-- Front window -->
        <path d="M 32 30 L 50 25 L 50 45 L 32 45 Z" fill="#06b6d4" stroke="#0891b2" stroke-width="2"></path>
        
        <!-- Rear window -->
        <path d="M 50 25 L 68 30 L 68 45 L 50 45 Z" fill="#06b6d4" stroke="#0891b2" stroke-width="2"></path>
        
        <!-- Door line -->
        <line x1="50" y1="45" x2="50" y2="60" stroke="#991b1b" stroke-width="2"></line>
        
        <!-- Front door details -->
        <line x1="40" y1="50" x2="42" y2="50" stroke="#1f2937" stroke-width="1.5"></line>
        
        <!-- Front wheel -->
        <circle cx="25" cy="62" r="10" fill="#1f2937"></circle>
        <circle cx="25" cy="62" r="7" fill="#374151"></circle>
        <circle cx="25" cy="62" r="4" fill="#111827"></circle>
        
        <!-- Rear wheel -->
        <circle cx="75" cy="62" r="10" fill="#1f2937"></circle>
        <circle cx="75" cy="62" r="7" fill="#374151"></circle>
        <circle cx="75" cy="62" r="4" fill="#111827"></circle>
        
        <!-- Headlight -->
        <rect x="12" y="50" width="6" height="6" rx="1" fill="#fbbf24" stroke="#f59e0b" stroke-width="1"></rect>
        <rect x="13" y="51" width="4" height="4" fill="#fef3c7"></rect>
        
        <!-- Roofline accent -->
        <path d="M 32 30 Q 50 20 68 30" stroke="#b91c1c" stroke-width="2" fill="none"></path>
      </svg>
    `;
  }
  if (kind === "star") {
    return `
      <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" focusable="false" shape-rendering="geometricPrecision">
        <polygon points="12,2 16,10 24,10 17,16 20,24 12,18 4,24 7,16 0,10 8,10" fill="#f59e0b" stroke="#d97706" stroke-width="1"></polygon>
      </svg>
    `;
  }
  return `
    <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" focusable="false" shape-rendering="geometricPrecision">
      <circle cx="12" cy="12" r="9" fill="#ef4444" stroke="#dc2626" stroke-width="1"></circle>
      <circle cx="8" cy="9" r="2.5" fill="#fca5a5"></circle>
    </svg>
  `;
}

function calculateGridDimensions(count) {
  if (count <= 0) return { cols: 1, rows: 0 };
  if (count <= 2) return { cols: count, rows: 1 };
  if (count <= 4) return { cols: 2, rows: Math.ceil(count / 2) };
  if (count <= 6) return { cols: 3, rows: Math.ceil(count / 3) };
  if (count <= 8) return { cols: 4, rows: Math.ceil(count / 4) };
  if (count <= 12) return { cols: 4, rows: Math.ceil(count / 4) };
  return { cols: 6, rows: Math.ceil(count / 6) };
}

function buildArithmeticObjectGroup(count, kind, showNumbers = false) {
  const safeCount = Math.max(0, Math.min(24, Number.parseInt(count, 10) || 0));
  const { cols, rows } = calculateGridDimensions(safeCount);
  const chips = [];
  
  for (let index = 0; index < safeCount; index += 1) {
    if (showNumbers) {
      chips.push(`<div class="arithmetic-object-numbered"><div class="arithmetic-object-number">${index + 1}</div><span class="arithmetic-object-icon">${buildArithmeticObjectIconSvg(kind)}</span></div>`);
    } else {
      chips.push(`<span class="arithmetic-object-icon">${buildArithmeticObjectIconSvg(kind)}</span>`);
    }
  }
  
  const gridStyle = `grid-template-columns: repeat(${cols}, 1fr); grid-template-rows: repeat(${rows}, 1fr);`;
  return `<div class="arithmetic-object-group-container"><div class="arithmetic-object-group" style="${gridStyle}">${chips.join("")}</div></div>`;
}

function buildArithmeticObjectVisualMarkup(config, { revealAnswer = false } = {}) {
  const visualMode = String(config && config.visualMode ? config.visualMode : "").trim().toLowerCase();
  if (visualMode !== "objects") return "";

  const operator = String(config && config.operator ? config.operator : "+").trim();
  if (!["+", "-", "x", "*", "/"].includes(operator)) return "";

  const a = Number.parseInt(config && config.operandA, 10);
  const b = Number.parseInt(config && config.operandB, 10);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) return "";

  const kind = normalizeArithmeticVisualKind(config && config.visualKind);
  const label = String(config && config.visualLabel ? config.visualLabel : "objects").trim() || "objects";

  if (operator === "-") {
    const remaining = Math.max(0, a - b);
    const totalMarkup = revealAnswer
      ? buildArithmeticObjectGroup(remaining, kind, revealAnswer)
      : `<span class="arithmetic-object-unknown">?</span>`;

    return `
      <div class="arithmetic-object-visual" role="img" aria-label="${escapeHtml(a)} minus ${escapeHtml(b)} ${escapeHtml(label)}">
        <div class="arithmetic-object-line">
          <div>${buildArithmeticObjectGroup(a, kind, revealAnswer)}</div>
          <span class="arithmetic-object-op">-</span>
          <div>${buildArithmeticObjectGroup(b, kind, revealAnswer)}</div>
          <span class="arithmetic-object-op">=</span>
          <div>${totalMarkup}</div>
        </div>
      </div>
    `;
  }

  if (operator === "/") {
    if (b <= 0) return "";
    const quotient = Math.floor(a / b);
    const buckets = [];
    const shownGroups = Math.max(0, Math.min(12, b));
    const shownEach = Math.max(0, Math.min(12, quotient));
    for (let groupIndex = 0; groupIndex < shownGroups; groupIndex += 1) {
      buckets.push(`<div class="arithmetic-object-bucket">${buildArithmeticObjectGroup(shownEach, kind, revealAnswer)}</div>`);
    }
    return `
      <div class="arithmetic-object-multiplication" role="img" aria-label="${escapeHtml(a)} shared into ${escapeHtml(b)} groups of ${escapeHtml(label)}">
        ${buckets.join("")}
      </div>
    `;
  }

  if (operator === "+") {
    const total = a + b;
    const totalMarkup = revealAnswer
      ? buildArithmeticObjectGroup(total, kind, revealAnswer)
      : `<span class="arithmetic-object-unknown">?</span>`;

    return `
      <div class="arithmetic-object-visual" role="img" aria-label="${escapeHtml(a)} plus ${escapeHtml(b)} ${escapeHtml(label)}">
        <div class="arithmetic-object-line">
          <div>${buildArithmeticObjectGroup(a, kind, revealAnswer)}</div>
          <span class="arithmetic-object-op">+</span>
          <div>${buildArithmeticObjectGroup(b, kind, revealAnswer)}</div>
          <span class="arithmetic-object-op">=</span>
          <div>${totalMarkup}</div>
        </div>
      </div>
    `;
  }

  const groups = Math.max(0, Math.min(12, a));
  const each = Math.max(0, Math.min(12, b));
  const buckets = [];
  for (let groupIndex = 0; groupIndex < groups; groupIndex += 1) {
    buckets.push(`<div class="arithmetic-object-bucket">${buildArithmeticObjectGroup(each, kind, revealAnswer)}</div>`);
  }
  return `
    <div class="arithmetic-object-multiplication" role="img" aria-label="${escapeHtml(a)} groups of ${escapeHtml(b)} ${escapeHtml(label)}">
      ${buckets.join("")}
    </div>
  `;
}

function buildArithmeticReasoningMarkup(config, { revealAnswer = false } = {}) {
  if (!revealAnswer) return "";
  const visualMode = String(config && config.visualMode ? config.visualMode : "").trim().toLowerCase();
  if (visualMode !== "objects") return "";

  const operator = String(config && config.operator ? config.operator : "+").trim();
  const a = Number.parseInt(config && config.operandA, 10);
  const b = Number.parseInt(config && config.operandB, 10);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return "";

  if (operator === "+" || operator === "-") {
    const result = operator === "+" ? a + b : a - b;
    const inRange = [a, b, result].every((value) => Number.isInteger(value) && value >= 0 && value <= 100);
    if (!inRange) return "";

    const stepStart = operator === "+" ? a + 1 : Math.max(1, result + 1);
    const stepEnd = operator === "+" ? result : a;
    const cells = [];
    for (let value = 1; value <= 100; value += 1) {
      const classes = ["arithmetic-number-chart-cell"];
      if (value === a) classes.push("start");
      if (value === result) classes.push("result");
      if (value >= stepStart && value <= stepEnd) classes.push("step");
      cells.push(`<span class="${classes.join(" ")}">${value}</span>`);
    }

    const explanation = operator === "+"
      ? `Number chart jump: start at ${a}, move forward ${b} to land on ${result}.`
      : `Number chart jump: start at ${a}, move back ${b} to land on ${result}.`;

    return `
      <p class="helper-text arithmetic-why">${escapeHtml(explanation)}</p>
      <div class="arithmetic-number-chart" role="img" aria-label="Number chart showing ${escapeHtml(String(a))} ${escapeHtml(operator)} ${escapeHtml(String(b))} equals ${escapeHtml(String(result))}">
        ${cells.join("")}
      </div>
    `;
  }

  if (operator === "x" || operator === "*") {
    const table = [];
    for (let i = 1; i <= 10; i += 1) {
      table.push(`${b} x ${i} = ${b * i}`);
    }
    return `<p class="helper-text arithmetic-why">Times table check: ${escapeHtml(table.join(" | "))}</p>`;
  }

  if (operator === "/" && b !== 0) {
    const q = Math.floor(a / b);
    return `<p class="helper-text arithmetic-why">Equal groups check: ${escapeHtml(String(a))} / ${escapeHtml(String(b))} = ${escapeHtml(String(q))}, and ${escapeHtml(String(b))} x ${escapeHtml(String(q))} = ${escapeHtml(String(b * q))}.</p>`;
  }

  return "";
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

function buildArithmeticAnswerBoxesWithCornerCarry(answerText, { readOnly = false, minDigits = 1 } = {}) {
  const cleaned = String(answerText || "").trim();
  const requiredDigits = Math.max(1, Number.parseInt(minDigits, 10) || 1);
  const inferredDigits = Math.max(1, cleaned.replace(/[^0-9-]/g, "").length || cleaned.length || 1);
  const digits = Math.max(requiredDigits, inferredDigits, 1);
  const chars = splitArithmeticDigits(cleaned, digits);
  const boxes = [];
  for (let index = 0; index < digits; index += 1) {
    const value = chars[index] || "";
    const answerAttrs = readOnly
      ? `value="${escapeHtml(value)}" readonly disabled`
      : "value=\"\"";
    boxes.push(`
      <span class="arithmetic-answer-cell-wrap">
        <input class="arithmetic-corner-carry arithmetic-corner-carry--decor" type="text" inputmode="numeric" maxlength="1" value="" readonly disabled tabindex="-1" aria-hidden="true" autocomplete="off" />
        <input class="arithmetic-digit-input" type="text" inputmode="numeric" maxlength="1" ${answerAttrs} data-index="${index}" autocomplete="off" />
      </span>
    `);
  }
  return boxes.join("");
}

function computeMultiplicationColumnSums(solutionRows, columnCount) {
  const count = Math.max(1, Number.parseInt(columnCount, 10) || 1);
  const rows = Array.isArray(solutionRows) ? solutionRows : [];
  const sums = new Array(count).fill(0);
  const colAddends = Array.from({ length: count }, () => []);
  const colCarryIn = new Array(count).fill(0);
  let carry = 0;

  for (let col = count - 1; col >= 0; col -= 1) {
    colCarryIn[col] = carry;
    let colSum = carry;
    for (let rowIdx = 0; rowIdx < rows.length; rowIdx += 1) {
      const row = rows[rowIdx];
      const digit = Number.parseInt(row && row.work ? row.work[col] : "", 10) || 0;
      colAddends[col].push(digit);
      colSum += digit;
    }
    sums[col] = colSum % 10;
    carry = Math.floor(colSum / 10);
  }

  return { sums, colAddends, colCarryIn };
}

function buildMultiplicationAnswerBoxesWithOrigins(answerText, solutionRows, columnCount, { readOnly = false } = {}) {
  const cleaned = String(answerText || "").trim();
  const requiredDigits = Math.max(1, Number.parseInt(columnCount, 10) || 1);
  const inferredDigits = Math.max(1, cleaned.replace(/[^0-9-]/g, "").length || cleaned.length || 1);
  const digits = Math.max(requiredDigits, inferredDigits, 1);
  const chars = splitArithmeticDigits(cleaned, digits);
  const { colAddends, colCarryIn } = computeMultiplicationColumnSums(solutionRows, digits);

  const boxes = [];
  for (let index = 0; index < digits; index += 1) {
    const value = chars[index] || "";
    const answerAttrs = readOnly
      ? `value="${escapeHtml(value)}" readonly disabled`
      : "value=\"\"";
    const addendsJson = escapeHtml(JSON.stringify(colAddends[index] || []));
    const carryIn = Number(colCarryIn[index]) || 0;
    boxes.push(`
      <span class="arithmetic-answer-cell-wrap arithmetic-sum-cell" data-sum-col="${index}" data-sum-addends="${addendsJson}" data-sum-carry="${carryIn}">
        <input class="arithmetic-corner-carry arithmetic-corner-carry--decor" type="text" inputmode="numeric" maxlength="1" value="" readonly disabled tabindex="-1" aria-hidden="true" autocomplete="off" />
        <input class="arithmetic-digit-input" type="text" inputmode="numeric" maxlength="1" ${answerAttrs} data-index="${index}" autocomplete="off" />
      </span>
    `);
  }
  return boxes.join("");
}

function buildArithmeticCarryBoxes(columns, { readOnly = false, values = [] } = {}) {
  const count = Math.max(1, Number.parseInt(columns, 10) || 1);
  const boxes = [];
  for (let index = 0; index < count; index += 1) {
    const value = String(values[index] || "").slice(-1);
    const attrs = readOnly
      ? `value="${escapeHtml(value)}" readonly disabled`
      : "value=\"\"";
    boxes.push(`<input class="arithmetic-carry-input" type="text" inputmode="numeric" maxlength="1" ${attrs} data-carry-index="${index}" autocomplete="off" />`);
  }
  return boxes.join("");
}

function buildArithmeticMulWorkRow(columnCount, { readOnly = false, rowData = null } = {}) {
  const count = Math.max(1, Number.parseInt(columnCount, 10) || 1);
  const carryValues = rowData && Array.isArray(rowData.carry) ? rowData.carry : [];
  const workValues = rowData && Array.isArray(rowData.work) ? rowData.work : [];
  const metadata = rowData && Array.isArray(rowData.metadata) ? rowData.metadata : [];
  const digitBoxes = Array.from({ length: count }, (_, index) => {
    const carryValue = String(carryValues[index] || "").slice(-1);
    const workValue = String(workValues[index] || "").slice(-1);
    const carryAttr = readOnly
      ? `value="${escapeHtml(carryValue)}" readonly disabled`
      : "value=\"\"";
    const workAttr = readOnly
      ? `value="${escapeHtml(workValue)}" readonly disabled`
      : "value=\"\"";
    const meta = metadata[index];
    const dataAttrs = (meta && readOnly
      ? `data-mul-idx="${meta.multiplicandIdx}" data-mul-digit="${meta.multiplierIdx}" data-mul-a-cell="${meta.aCellIdx != null ? meta.aCellIdx : -1}" data-mul-b-cell="${meta.bCellIdx != null ? meta.bCellIdx : -1}" data-mul-a-val="${meta.aVal != null ? meta.aVal : ""}" data-mul-b-val="${meta.bVal != null ? meta.bVal : ""}" data-mul-cell="work"`
      : "") + ` data-col-idx="${index}"`;
    return `
    <span class="arithmetic-work-cell-wrap" ${dataAttrs}>
      <input class="arithmetic-work-cell-carry" type="text" inputmode="numeric" maxlength="1" ${carryAttr} autocomplete="off" title="Carry" />
      <input class="arithmetic-work-input" type="text" inputmode="numeric" maxlength="1" ${workAttr} autocomplete="off" />
    </span>
  `;
  }).join("");
  const removeBtn = readOnly ? "" : `<button class="arithmetic-remove-row" type="button" title="Remove row" aria-label="Remove row">×</button>`;
  return `<div class="arithmetic-mul-work-row"><span class="arithmetic-op-spacer"></span><span class="arithmetic-work-cells">${digitBoxes}</span>${removeBtn}</div>`;
}

function buildArithmeticMulWorkContainer(columnCount, { readOnly = false, solutionRows = [] } = {}) {
  const addBtn = readOnly ? "" : `<button class="arithmetic-add-row-btn" type="button">＋ Add row</button>`;
  const rowsMarkup = Array.isArray(solutionRows)
    ? solutionRows.map((row) => buildArithmeticMulWorkRow(columnCount, { readOnly, rowData: row })).join("")
    : "";
  const hasRowsClass = rowsMarkup.trim() ? " has-rows" : "";
  const rowCount = Array.isArray(solutionRows) ? solutionRows.length : 0;
  // Only show internal divider if there are multiple rows (to avoid duplicate dividers when there's just 1 row)
  const internalDivider = rowCount > 1
    ? `<div class="arithmetic-work-divider"><span class="arithmetic-op-spacer"></span><span class="arithmetic-divider-line"></span></div>`
    : "";
  return `
    <div class="arithmetic-mul-work-container${hasRowsClass}" data-columns="${columnCount}">
      ${internalDivider}
      <div class="arithmetic-mul-work-rows">${rowsMarkup}</div>
      ${addBtn}
    </div>
  `;
}

function buildArithmeticDigitArray(value, count) {
  const digits = String(value == null ? "" : value).replace(/[^0-9]/g, "") || "0";
  const columns = Math.max(1, Number.parseInt(count, 10) || 1);
  const padded = digits.padStart(columns, "0").slice(-columns);
  return padded.split("").map((ch) => Number.parseInt(ch, 10) || 0);
}

function buildAdditionCarryValues(operandAText, operandBText, columnCount) {
  const columns = Math.max(1, Number.parseInt(columnCount, 10) || 1);
  const aDigits = buildArithmeticDigitArray(operandAText, columns);
  const bDigits = buildArithmeticDigitArray(operandBText, columns);
  const carryValues = new Array(columns).fill("");
  let carry = 0;
  for (let index = columns - 1; index >= 0; index -= 1) {
    const sum = aDigits[index] + bDigits[index] + carry;
    const nextCarry = Math.floor(sum / 10);
    if (nextCarry > 0 && index - 1 >= 0) {
      carryValues[index - 1] = String(nextCarry).slice(-1);
    }
    carry = nextCarry;
  }
  return carryValues;
}

function buildSubtractionBorrowValues(operandAText, operandBText, columnCount) {
  const columns = Math.max(1, Number.parseInt(columnCount, 10) || 1);
  const aDigits = buildArithmeticDigitArray(operandAText, columns);
  const bDigits = buildArithmeticDigitArray(operandBText, columns);
  const borrowValues = new Array(columns).fill("");
  let borrow = 0;
  for (let index = columns - 1; index >= 0; index -= 1) {
    const top = aDigits[index] - borrow;
    const bottom = bDigits[index];
    if (top < bottom) {
      if (index - 1 >= 0) {
        borrowValues[index - 1] = "1";
      }
      borrow = 1;
    } else {
      borrow = 0;
    }
  }
  return borrowValues;
}

function buildMultiplicationTopCarryValues(operandAText, operandBText, carryCount) {
  const columns = Math.max(1, Number.parseInt(carryCount, 10) || 1);
  const multiplicandDigits = String(operandAText == null ? "" : operandAText).replace(/[^0-9]/g, "") || "0";
  const multiplierDigits = String(operandBText == null ? "" : operandBText).replace(/[^0-9]/g, "") || "0";
  const multiplierDigit = Number.parseInt(multiplierDigits.slice(-1), 10);
  if (!Number.isFinite(multiplierDigit)) return new Array(columns).fill("");

  const values = new Array(columns).fill("");
  let carry = 0;
  for (let index = multiplicandDigits.length - 1; index >= 0; index -= 1) {
    const digit = Number.parseInt(multiplicandDigits[index], 10) || 0;
    const rowIndex = columns - 1 - (multiplicandDigits.length - 1 - index);
    const nextCarry = Math.floor((digit * multiplierDigit + carry) / 10);
    if (nextCarry > 0 && rowIndex - 1 >= 0) {
      values[rowIndex - 1] = String(nextCarry).slice(-1);
    }
    carry = nextCarry;
  }
  return values;
}

function buildMultiplicationSolutionRows(operandAText, operandBText, columnCount) {
  const columns = Math.max(1, Number.parseInt(columnCount, 10) || 1);
  const multiplicandDigits = String(operandAText == null ? "" : operandAText).replace(/[^0-9]/g, "") || "0";
  const multiplierDigits = String(operandBText == null ? "" : operandBText).replace(/[^0-9]/g, "") || "0";
  const rows = [];

  for (let multiplierIndex = multiplierDigits.length - 1; multiplierIndex >= 0; multiplierIndex -= 1) {
    const multiplierDigit = Number.parseInt(multiplierDigits[multiplierIndex], 10) || 0;
    const shift = (multiplierDigits.length - 1) - multiplierIndex;
    const row = createLongDivisionRow(columns);
    row.metadata = new Array(columns).fill(null); // Track operand indices for each result digit

    if (multiplierDigit === 0) {
      // For rows with 0 multiplier, show zeros matching the multiplicand width, shifted appropriately
      const bCellIdx0 = (columns - multiplierDigits.length) + multiplierIndex;
      for (let zeroIdx = 0; zeroIdx < multiplicandDigits.length; zeroIdx += 1) {
        const zeroCol = columns - 1 - shift - zeroIdx;
        if (zeroCol >= 0) {
          row.work[zeroCol] = "0";
          const rawAIdx = multiplicandDigits.length - 1 - zeroIdx;
          const aCellIdx0 = (columns - multiplicandDigits.length) + rawAIdx;
          const aVal0 = Number.parseInt(multiplicandDigits[rawAIdx], 10) || 0;
          // Track: multiplicandIdx, multiplierIdx for highlighting
          row.metadata[zeroCol] = { multiplicandIdx: zeroIdx, multiplierIdx: multiplierIndex, aVal: aVal0, bVal: multiplierDigit, aCellIdx: aCellIdx0, bCellIdx: bCellIdx0 };
        }
      }
      rows.push(row);
      continue;
    }

    let carry = 0;
    for (let index = multiplicandDigits.length - 1; index >= 0; index -= 1) {
      const digit = Number.parseInt(multiplicandDigits[index], 10) || 0;
      const offset = (multiplicandDigits.length - 1) - index;
      const targetCol = columns - 1 - shift - offset;
      if (targetCol < 0) continue;
      const product = (digit * multiplierDigit) + carry;
      row.work[targetCol] = String(product % 10);
      const aCellIdx = (columns - multiplicandDigits.length) + index;
      const bCellIdx = (columns - multiplierDigits.length) + multiplierIndex;
      row.metadata[targetCol] = { multiplicandIdx: index, multiplierIdx: multiplierIndex, aVal: digit, bVal: multiplierDigit, aCellIdx, bCellIdx };
      const nextCarry = Math.floor(product / 10);
      if (nextCarry > 0 && targetCol - 1 >= 0) {
        row.carry[targetCol - 1] = String(nextCarry).slice(-1);
      }
      carry = nextCarry;
    }

    const leadingCol = columns - 1 - shift - multiplicandDigits.length;
    if (carry > 0 && leadingCol >= 0) {
      row.work[leadingCol] = String(carry).split("").slice(-1)[0];
      const leadBCellIdx = (columns - multiplierDigits.length) + multiplierIndex;
      row.metadata[leadingCol] = { multiplicandIdx: multiplicandDigits.length, multiplierIdx: multiplierIndex, aVal: null, bVal: multiplierDigit, aCellIdx: -1, bCellIdx: leadBCellIdx };
    }

    // Fill in trailing zeros for the shift (e.g., 24 × 10 should show 240, not 24)
    for (let shiftIndex = 0; shiftIndex < shift; shiftIndex += 1) {
      const zeroCol = columns - 1 - shiftIndex;
      if (zeroCol >= 0 && row.work[zeroCol] === "") {
        row.work[zeroCol] = "0";
        // Trailing zeros represent the shift from this multiplier digit
        row.metadata[zeroCol] = { multiplicandIdx: -1, multiplierIdx: multiplierIndex, aVal: null, bVal: null, aCellIdx: -1, bCellIdx: -1 };
      }
    }

    rows.push(row);
  }

  return rows;
}

function buildMultiplicationSumRow(solutionRows, columnCount) {
  const count = Math.max(1, Number.parseInt(columnCount, 10) || 1);
  if (!Array.isArray(solutionRows) || solutionRows.length === 0) {
    return "";
  }

  const { sums, colAddends, colCarryIn } = computeMultiplicationColumnSums(solutionRows, count);

  // Build the display cells
  const digitBoxes = Array.from({ length: count }, (_, index) => {
    const sumValue = String(sums[index] || "").slice(-1);
    const addendsJson = escapeHtml(JSON.stringify(colAddends[index]));
    const carryIn = colCarryIn[index];
    return `
    <span class="arithmetic-work-cell-wrap arithmetic-sum-cell" data-sum-col="${index}" data-sum-addends="${addendsJson}" data-sum-carry="${carryIn}">
      <input class="arithmetic-work-cell-carry" type="text" inputmode="numeric" maxlength="1" value="" readonly disabled autocomplete="off" title="Carry" />
      <input class="arithmetic-work-input" type="text" inputmode="numeric" maxlength="1" value="${escapeHtml(sumValue)}" readonly disabled autocomplete="off" />
    </span>
  `;
  }).join("");

  return digitBoxes;
}

function buildArithmeticLongDivisionWorkRow(columnCount, { readOnly = false, rowData = null } = {}) {
  const count = Math.max(1, Number.parseInt(columnCount, 10) || 1);
  const inputAttr = readOnly ? "readonly disabled" : "";
  const carryValues = rowData && Array.isArray(rowData.carry) ? rowData.carry : [];
  const workValues = rowData && Array.isArray(rowData.work) ? rowData.work : [];
  const operation = rowData && typeof rowData.operation === "string" ? rowData.operation.trim() : "";
  const sideCell = operation
    ? `<span class="arithmetic-long-row-side arithmetic-long-operation-marker">${escapeHtml(operation)}</span>`
    : `<span class="arithmetic-long-row-side arithmetic-long-side-spacer"></span>`;
  const cells = Array.from({ length: count }, (_, index) => {
    const carryValue = String(carryValues[index] || "").slice(-1);
    const workValue = String(workValues[index] || "").slice(-1);
    const carryAttr = readOnly
      ? `value="${escapeHtml(carryValue)}" readonly disabled`
      : "value=\"\"";
    const workAttr = readOnly
      ? `value="${escapeHtml(workValue)}" readonly disabled`
      : "value=\"\"";
    return `<span class="arithmetic-work-cell-wrap arithmetic-long-work-cell">` +
      `<input class="arithmetic-work-cell-carry arithmetic-long-work-carry" type="text" inputmode="numeric" maxlength="1" ${carryAttr} autocomplete="off" />` +
      `<input class="arithmetic-long-work-input" type="text" inputmode="numeric" maxlength="1" ${workAttr} autocomplete="off" />` +
      `</span>`;
  }).join("");
  const removeBtn = readOnly
    ? `<span class="arithmetic-long-row-end-spacer" aria-hidden="true"></span>`
    : `<button class="arithmetic-remove-row" type="button" title="Remove row" aria-label="Remove row">×</button>`;
  return `<div class="arithmetic-long-work-row">${sideCell}<span class="arithmetic-work-cells">${cells}</span>${removeBtn}</div>`;
}

function buildArithmeticLongDivisionDividerRow() {
  return `
    <div class="arithmetic-long-work-divider-row">
      <span class="arithmetic-long-side-spacer"></span>
      <span class="arithmetic-long-step-divider" aria-hidden="true"></span>
      <span class="arithmetic-long-row-end-spacer" aria-hidden="true"></span>
    </div>
  `;
}

function buildArithmeticLongDivisionWorkContainer(columnCount, { readOnly = false, solutionRows = [] } = {}) {
  const addBtn = readOnly ? "" : `<button class="arithmetic-add-row-btn" type="button">＋ Add row</button>`;
  const rowsMarkup = Array.isArray(solutionRows)
    ? solutionRows
      .map((row) => {
        if (row && row.kind === "divider") {
          return buildArithmeticLongDivisionDividerRow();
        }
        return buildArithmeticLongDivisionWorkRow(columnCount, { readOnly, rowData: row });
      })
      .join("")
    : "";
  return `
    <div class="arithmetic-long-work-container" data-columns="${columnCount}">
      <div class="arithmetic-long-work-rows">${rowsMarkup}</div>
      ${addBtn}
    </div>
  `;
}

function createLongDivisionRow(columnCount) {
  return {
    carry: new Array(columnCount).fill(""),
    work: new Array(columnCount).fill("")
  };
}

function computeBorrowMarkers(minuendDigits, subtrahendDigits) {
  const len = Math.max(minuendDigits.length, subtrahendDigits.length, 1);
  const a = String(minuendDigits || "").padStart(len, "0").split("").map((ch) => Number.parseInt(ch, 10) || 0);
  const b = String(subtrahendDigits || "").padStart(len, "0").split("").map((ch) => Number.parseInt(ch, 10) || 0);
  const markers = new Array(len).fill("");
  let borrow = 0;
  for (let index = len - 1; index >= 0; index -= 1) {
    const top = a[index] - borrow;
    const bottom = b[index];
    if (top < bottom) {
      if (index - 1 >= 0) {
        markers[index - 1] = "1";
      }
      borrow = 1;
    } else {
      borrow = 0;
    }
  }
  return markers;
}

function buildLongDivisionSolutionRows(dividendText, divisorText, columnCount) {
  const columns = Math.max(1, Number.parseInt(columnCount, 10) || 1);
  const dividend = Number.parseInt(dividendText, 10);
  const divisor = Number.parseInt(divisorText, 10);
  if (!Number.isFinite(dividend) || !Number.isFinite(divisor) || divisor === 0 || dividend < 0 || divisor < 0) {
    return [];
  }

  const dividendDigits = String(dividend).split("").map((ch) => Number.parseInt(ch, 10) || 0);
  const rows = [];
  let remainder = 0;
  let started = false;

  for (let index = 0; index < dividendDigits.length; index += 1) {
    const digit = dividendDigits[index];
    const current = (remainder * 10) + digit;
    if (!started && current < divisor) {
      remainder = current;
      continue;
    }
    started = true;
    const qDigit = Math.floor(current / divisor);
    const product = qDigit * divisor;
    const currentText = String(current);
    const productText = String(product);
    const span = Math.max(currentText.length, productText.length, 1);
    const startCol = Math.max(0, Math.min(columns - span, index - span + 1));

    const subtractRow = createLongDivisionRow(columns);
    const borrowMarkers = computeBorrowMarkers(currentText, productText);
    const productDigits = productText.padStart(span, "0").split("");
    for (let offset = 0; offset < span; offset += 1) {
      const col = startCol + offset;
      subtractRow.work[col] = productDigits[offset] === "0" && offset < span - 1 ? "" : productDigits[offset];
      subtractRow.carry[col] = borrowMarkers[offset] || "";
    }
    subtractRow.operation = "-";
    rows.push(subtractRow);
    rows.push({ kind: "divider" });

    remainder = current - product;
    const remainderRow = createLongDivisionRow(columns);
    const remainderText = String(remainder);
    const remainderSpan = Math.max(remainderText.length, 1);
    const remainderStart = Math.max(0, Math.min(columns - remainderSpan, index - remainderSpan + 1));
    const remainderDigits = remainderText.padStart(remainderSpan, "0").split("");
    for (let offset = 0; offset < remainderSpan; offset += 1) {
      const col = remainderStart + offset;
      remainderRow.work[col] = remainderDigits[offset] === "0" && offset < remainderSpan - 1 ? "" : remainderDigits[offset];
    }
    if (index + 1 < dividendDigits.length) {
      const bringDownCol = Math.min(columns - 1, index + 1);
      remainderRow.carry[bringDownCol] = String(dividendDigits[index + 1]);
    }
    rows.push(remainderRow);
  }

  return rows;
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

function buildArithmeticLinkToTenMarkup(config, { readOnly = false, revealAnswer = false } = {}) {
  const normalized = normalizeArithmeticLinkConfig(config || {});
  const expectedAnswer = serializeArithmeticLinkAnswerPairs(normalized.expectedPairs);
  const initialAnswer = readOnly && revealAnswer ? expectedAnswer : "";
  const targetLabel = normalized.linkOperator === "-"
    ? `A - B = ${normalized.targetValue}`
    : `A + B = ${normalized.targetValue}`;
  const instruction = normalized.linkOperator === "-"
    ? `Link one card from Column A to one card from Column B so every pair satisfies A - B = ${normalized.targetValue}.`
    : `Link one card from Column A to one card from Column B so every pair adds to ${normalized.targetValue}.`;
  return `
    <div class="arith-link-workspace">
      <div class="arith-link-target">Target: ${escapeHtml(String(targetLabel))}</div>
      <div class="arith-link-board" data-role="arith-link-board" data-readonly="${readOnly ? "true" : "false"}" data-target="${escapeHtml(String(normalized.targetValue))}" data-link-operator="${escapeHtml(String(normalized.linkOperator))}">
        <svg class="arith-link-lines" data-role="arith-link-lines" aria-hidden="true"></svg>
        <div class="arith-link-column" data-role="arith-link-left">
          <p class="arith-link-heading">Column A</p>
          ${normalized.leftNumbers.map((value, index) => `
            <button type="button" class="arith-link-card" data-side="left" data-index="${index}" data-value="${escapeHtml(String(value))}" ${readOnly ? "disabled" : ""}>${escapeHtml(String(value))}</button>
          `).join("")}
        </div>
        <div class="arith-link-column" data-role="arith-link-right">
          <p class="arith-link-heading">Column B</p>
          ${normalized.rightNumbers.map((value, index) => `
            <button type="button" class="arith-link-card" data-side="right" data-index="${index}" data-value="${escapeHtml(String(value))}" ${readOnly ? "disabled" : ""}>${escapeHtml(String(value))}</button>
          `).join("")}
        </div>
      </div>
      <input type="hidden" data-role="arith-link-answer" value="${escapeHtml(initialAnswer)}" />
      <p class="helper-text">${escapeHtml(String(instruction))}</p>
    </div>
  `;
}

function buildArithmeticWorkspaceMarkup(config, { readOnly = false, revealAnswer = false, questionText = "" } = {}) {
  const layout = normalizeArithmeticLayout(config && config.layout);
  const operatorRaw = String(config && config.operator ? config.operator : "+").trim() || "+";
  const operator = escapeHtml(operatorRaw);
  const operandAText = String(config && config.operandA != null ? config.operandA : 0);
  const operandBText = String(config && config.operandB != null ? config.operandB : 0);
  const operandA = escapeHtml(operandAText);
  const operandB = escapeHtml(operandBText);
  const visualMode = String(config && config.visualMode ? config.visualMode : "").trim().toLowerCase();
  if (visualMode === "link-to-10") {
    return buildArithmeticLinkToTenMarkup(config, { readOnly, revealAnswer });
  }
  const isVisualObjects = visualMode === "objects";
  const resolvedQuestionText = String(questionText || "").trim();
  const operationLabelMap = {
    "+": "Addition",
    "-": "Subtraction",
    "x": "Multiplication",
    "*": "Multiplication",
    "/": "Division"
  };
  const visualQuestionMarkup = isVisualObjects && resolvedQuestionText
    ? `<p class="arithmetic-visual-question">${renderQuestionText(resolvedQuestionText)}</p>`
    : "";
  
  const objectVisualMarkup = buildArithmeticObjectVisualMarkup(config || {}, { revealAnswer });
  const reasoningMarkup = buildArithmeticReasoningMarkup(config || {}, { revealAnswer });
  const visualHeaderMarkup = isVisualObjects
    ? `
      <div class="arithmetic-visual-header">
        <p class="arithmetic-visual-kicker">Visual Arithmetic</p>
        <div class="arithmetic-visual-meta">
          <span class="arithmetic-visual-badge">${escapeHtml(operationLabelMap[operatorRaw] || "Arithmetic")}</span>
        </div>
      </div>
    `
    : "";
  const visualModelPanelMarkup = isVisualObjects && objectVisualMarkup
    ? `
      <section class="arithmetic-visual-panel" aria-label="Visual model">
        <p class="arithmetic-visual-panel-title">Visual Model</p>
        ${objectVisualMarkup}
      </section>
    `
    : objectVisualMarkup;
  const visualReasoningPanelMarkup = isVisualObjects && reasoningMarkup
    ? `
      <section class="arithmetic-visual-panel arithmetic-visual-panel-secondary" aria-label="Reasoning">
        <p class="arithmetic-visual-panel-title">Reasoning</p>
        ${reasoningMarkup}
      </section>
    `
    : reasoningMarkup;
  const computedAnswerText = computeArithmeticAnswerFromConfig(config || {});
  const answerText = revealAnswer ? computedAnswerText : "";
  const sizingAnswerDigits = String(computedAnswerText || "").trim();
  const operandALen = Math.max(1, operandAText.replace(/[^0-9]/g, "").length || operandAText.length || 1);
  const operandBLen = Math.max(1, operandBText.replace(/[^0-9]/g, "").length || operandBText.length || 1);
  const answerLen = Math.max(1, sizingAnswerDigits.replace(/[^0-9]/g, "").length || sizingAnswerDigits.length || 1);
  const baseColumns = Math.max(operandALen, operandBLen, answerLen, 1);
  const hasLeadingCarrySpace = ["+", "-", "x", "*"].includes(operatorRaw);
  const isMultiplication = ["x", "*"].includes(operatorRaw);
  const isLongDivision = layout === "long" || (operatorRaw === "/" && layout === "vertical");
  const columnCount = isMultiplication
    ? 10
    : hasLeadingCarrySpace
      ? Math.max(baseColumns + 1, answerLen)
      : Math.max(baseColumns, answerLen);

  let boxes = layout === "vertical"
    ? isMultiplication
      ? buildArithmeticAnswerBoxesWithCornerCarry(answerText, { readOnly, minDigits: columnCount })
      : buildArithmeticAnswerBoxes(answerText, { readOnly, minDigits: columnCount })
    : buildArithmeticSingleInput(answerText, { readOnly });

  if (isLongDivision) {
    const longColumns = Math.max(answerLen, operandALen, 1);
    const solutionRows = revealAnswer
      ? buildLongDivisionSolutionRows(operandAText, operandBText, longColumns)
      : [];
    const quotientBoxes = buildArithmeticAnswerBoxes(answerText, {
      readOnly,
      minDigits: longColumns
    });
    const dividendCells = buildArithmeticOperandCells(operandAText, longColumns);
    const workContainer = buildArithmeticLongDivisionWorkContainer(longColumns, { readOnly, solutionRows });
    return `
      <div class="arithmetic-workspace arithmetic-long-division-layout">
        ${visualHeaderMarkup}
        ${visualQuestionMarkup}
        ${visualModelPanelMarkup}
        ${visualReasoningPanelMarkup}
        <div class="arithmetic-long-division-stack">
          <div class="arithmetic-long-quotient-row">
            <span class="arithmetic-long-side-spacer"></span>
            <span class="arithmetic-answer-cells">${quotientBoxes}</span>
            <span class="arithmetic-long-row-end-spacer" aria-hidden="true"></span>
          </div>
          <div class="arithmetic-long-problem-row">
            <span class="arithmetic-long-divisor">${operandB}</span>
            <span class="arithmetic-long-dividend-shell">
              <span class="arithmetic-number-cells">${dividendCells}</span>
            </span>
            <span class="arithmetic-long-row-end-spacer" aria-hidden="true"></span>
          </div>
          ${workContainer}
        </div>
      </div>
    `;
  }

  if (layout === "vertical") {
    const topCarryValues = revealAnswer
      ? operatorRaw === "+"
        ? buildAdditionCarryValues(operandAText, operandBText, columnCount)
        : operatorRaw === "-"
          ? buildSubtractionBorrowValues(operandAText, operandBText, columnCount)
          : []
      : [];
    const mulCarryCount = operandALen + 1;
    const mulCarryValues = revealAnswer && isMultiplication
      ? buildMultiplicationTopCarryValues(operandAText, operandBText, mulCarryCount)
      : [];
    const mulSolutionRows = revealAnswer && isMultiplication
      ? buildMultiplicationSolutionRows(operandAText, operandBText, columnCount)
      : [];
    if (revealAnswer && isMultiplication) {
      boxes = buildMultiplicationAnswerBoxesWithOrigins(answerText, mulSolutionRows, columnCount, { readOnly });
    }
    const mulSumRow = revealAnswer && isMultiplication && Array.isArray(mulSolutionRows) && mulSolutionRows.length > 0
      ? buildMultiplicationSumRow(mulSolutionRows, columnCount)
      : null;
    const workContainer = isMultiplication
      ? buildArithmeticMulWorkContainer(columnCount, { readOnly, solutionRows: mulSolutionRows })
      : "";
    const sumRowMarkup = mulSumRow && !readOnly
      ? `<div class="arithmetic-work-divider"><span class="arithmetic-op-spacer"></span><span class="arithmetic-divider-line"></span></div>` +
        `<div class="arithmetic-mul-work-row"><span class="arithmetic-op-spacer"></span><span class="arithmetic-work-cells">${mulSumRow}</span></div>`
      : "";
    // Addition/subtraction: carry row at the top above operand A (full column width)
    const topCarryRow = ["+", "-"].includes(operatorRaw)
      ? `<div class="arithmetic-carry-row"><span class="arithmetic-op-spacer"></span><span class="arithmetic-carry-cells">${buildArithmeticCarryBoxes(columnCount, { readOnly, values: topCarryValues })}</span></div>`
      : "";
    // Multiplication: small carry row directly above operand A, only operandALen+1 boxes
    const mulCarryRow = isMultiplication
      ? `<div class="arithmetic-carry-row arithmetic-carry-row--small"><span class="arithmetic-op-spacer"></span><span class="arithmetic-carry-cells">${buildArithmeticCarryBoxes(mulCarryCount, { readOnly, values: mulCarryValues })}</span></div>`
      : "";
    const workDivider = isMultiplication
      ? `<div class="arithmetic-work-divider"><span class="arithmetic-op-spacer"></span><span class="arithmetic-divider-line"></span></div>`
      : "";
    return `
      <div class="arithmetic-workspace arithmetic-layout-vertical">
        ${visualHeaderMarkup}
        ${visualQuestionMarkup}
        ${visualModelPanelMarkup}
        ${visualReasoningPanelMarkup}
        <div class="arithmetic-vertical-stack">
          ${topCarryRow}
          ${mulCarryRow}
          <div class="arithmetic-row"><span class="arithmetic-op-spacer"></span><span class="arithmetic-number-cells" data-operand="a">${buildArithmeticOperandCells(operandAText, columnCount)}</span></div>
          <div class="arithmetic-row"><span class="arithmetic-operator">${operator}</span><span class="arithmetic-number-cells" data-operand="b">${buildArithmeticOperandCells(operandBText, columnCount)}</span></div>
          ${workDivider}
          ${workContainer}
          ${sumRowMarkup}
          <div class="arithmetic-answer-row"><span class="arithmetic-op-spacer"></span><span class="arithmetic-answer-cells">${boxes}</span></div>
        </div>
      </div>
    `;
  }

  return `
    <div class="arithmetic-workspace arithmetic-layout-horizontal">
      ${visualHeaderMarkup}
      ${visualQuestionMarkup}
      ${visualModelPanelMarkup}
      ${visualReasoningPanelMarkup}
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

function arithmeticLinkColorByIndex(index) {
  const palette = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#14b8a6", "#84cc16"];
  return palette[Math.abs(Number.parseInt(index, 10) || 0) % palette.length];
}

function drawArithmeticLinkLines(board, links, dragGhost = null) {
  if (!(board instanceof HTMLElement)) return;
  const svg = board.querySelector("[data-role='arith-link-lines']");
  if (!(svg instanceof SVGElement)) return;

  const boardRect = board.getBoundingClientRect();
  const width = Math.max(1, boardRect.width);
  const height = Math.max(1, boardRect.height);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));

  const leftCards = Array.from(board.querySelectorAll(".arith-link-card[data-side='left']"));
  const rightCards = Array.from(board.querySelectorAll(".arith-link-card[data-side='right']"));
  const lines = [];

  (Array.isArray(links) ? links : []).forEach((item) => {
    const left = leftCards[item.leftIndex];
    const right = rightCards[item.rightIndex];
    if (!(left instanceof HTMLElement) || !(right instanceof HTMLElement)) return;
    const lRect = left.getBoundingClientRect();
    const rRect = right.getBoundingClientRect();
    const x1 = lRect.right - boardRect.left;
    const y1 = lRect.top + (lRect.height / 2) - boardRect.top;
    const x2 = rRect.left - boardRect.left;
    const y2 = rRect.top + (rRect.height / 2) - boardRect.top;
    const stroke = item.color || arithmeticLinkColorByIndex(item.leftIndex);
    lines.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="arith-link-line" stroke="${stroke}" />`);
  });

  if (dragGhost && Number.isFinite(dragGhost.x1) && Number.isFinite(dragGhost.y1) && Number.isFinite(dragGhost.x2) && Number.isFinite(dragGhost.y2)) {
    const stroke = dragGhost.color || arithmeticLinkColorByIndex(dragGhost.leftIndex);
    lines.push(`<line x1="${dragGhost.x1}" y1="${dragGhost.y1}" x2="${dragGhost.x2}" y2="${dragGhost.y2}" class="arith-link-line is-ghost" stroke="${stroke}" />`);
  }

  svg.innerHTML = lines.join("");
}

function wireArithmeticLinkToTenInputs(scope = document) {
  const boards = Array.from(scope.querySelectorAll("[data-role='arith-link-board'][data-readonly='false']"));
  boards.forEach((board) => {
    if (!(board instanceof HTMLElement)) return;
    const leftCards = Array.from(board.querySelectorAll(".arith-link-card[data-side='left']"));
    const rightCards = Array.from(board.querySelectorAll(".arith-link-card[data-side='right']"));
    const hiddenInput = board.parentElement && board.parentElement.querySelector("[data-role='arith-link-answer']");
    const links = [];
    let selectedLeftIndex = -1;
    let dragGhost = null;
    let activePointerId = null;
    let activeDragMode = null;
    let hoveredRightIndex = -1;

    const cardCenterInBoard = (card) => {
      if (!(card instanceof HTMLElement)) return null;
      const boardRect = board.getBoundingClientRect();
      const rect = card.getBoundingClientRect();
      return {
        x: rect.right - boardRect.left,
        y: rect.top + (rect.height / 2) - boardRect.top
      };
    };

    const removeLinkByLeft = (leftIndex) => {
      for (let i = links.length - 1; i >= 0; i -= 1) {
        if (links[i].leftIndex === leftIndex) links.splice(i, 1);
      }
    };

    const removeLinkByRight = (rightIndex) => {
      for (let i = links.length - 1; i >= 0; i -= 1) {
        if (links[i].rightIndex === rightIndex) links.splice(i, 1);
      }
    };

    const syncUi = () => {
      leftCards.forEach((node, index) => {
        if (!(node instanceof HTMLElement)) return;
        const isLinked = links.some((item) => item.leftIndex === index);
        node.classList.toggle("is-linked", isLinked);
        node.classList.toggle("is-active", selectedLeftIndex === index);
      });
      rightCards.forEach((node, index) => {
        if (!(node instanceof HTMLElement)) return;
        const isLinked = links.some((item) => item.rightIndex === index);
        node.classList.toggle("is-linked", isLinked);
      });

      const answerPairs = links
        .map((item) => {
          const leftValue = Number.parseInt(String(leftCards[item.leftIndex] && leftCards[item.leftIndex].dataset.value || ""), 10);
          const rightValue = Number.parseInt(String(rightCards[item.rightIndex] && rightCards[item.rightIndex].dataset.value || ""), 10);
          return Number.isInteger(leftValue) && Number.isInteger(rightValue)
            ? { left: leftValue, right: rightValue }
            : null;
        })
        .filter((item) => item !== null);

      if (hiddenInput instanceof HTMLInputElement) {
        hiddenInput.value = serializeArithmeticLinkAnswerPairs(answerPairs);
      }

      drawArithmeticLinkLines(board, links, dragGhost);
    };

    const applyLink = (leftIndex, rightIndex) => {
      const samePairIndex = links.findIndex((item) => item.leftIndex === leftIndex && item.rightIndex === rightIndex);
      if (samePairIndex >= 0) {
        links.splice(samePairIndex, 1);
        return;
      }
      removeLinkByLeft(leftIndex);
      removeLinkByRight(rightIndex);
      links.push({ leftIndex, rightIndex, color: arithmeticLinkColorByIndex(leftIndex) });
    };

    const startDragFromLeft = (leftIndex, pointerId, eventTarget) => {
      const leftCard = leftCards[leftIndex];
      const start = cardCenterInBoard(leftCard);
      if (!start) return;
      activePointerId = pointerId;
      dragGhost = {
        leftIndex,
        x1: start.x,
        y1: start.y,
        x2: start.x,
        y2: start.y,
        color: arithmeticLinkColorByIndex(leftIndex)
      };
      syncUi();
    };

    const startMouseDragFromLeft = (leftIndex) => {
      const leftCard = leftCards[leftIndex];
      const start = cardCenterInBoard(leftCard);
      if (!start) return;
      activeDragMode = "mouse";
      activePointerId = "mouse";
      dragGhost = {
        leftIndex,
        x1: start.x,
        y1: start.y,
        x2: start.x,
        y2: start.y,
        color: arithmeticLinkColorByIndex(leftIndex)
      };
      syncUi();
    };

    const startTouchDragFromLeft = (leftIndex) => {
      const leftCard = leftCards[leftIndex];
      const start = cardCenterInBoard(leftCard);
      if (!start) return;
      activeDragMode = "touch";
      activePointerId = "touch";
      dragGhost = {
        leftIndex,
        x1: start.x,
        y1: start.y,
        x2: start.x,
        y2: start.y,
        color: arithmeticLinkColorByIndex(leftIndex)
      };
      syncUi();
    };

    const clearDrag = () => {
      dragGhost = null;
      activePointerId = null;
      activeDragMode = null;
      hoveredRightIndex = -1;
      selectedLeftIndex = -1;
      syncUi();
    };

    const updateDragPosition = (clientX, clientY) => {
      if (!dragGhost) return;
      const boardRect = board.getBoundingClientRect();
      dragGhost.x2 = Math.max(0, Math.min(boardRect.width, clientX - boardRect.left));
      dragGhost.y2 = Math.max(0, Math.min(boardRect.height, clientY - boardRect.top));
      syncUi();
    };

    const findRightIndexAtViewportPoint = (clientX, clientY) => {
      return rightCards.findIndex((node) => {
        if (!(node instanceof HTMLElement)) return false;
        const rect = node.getBoundingClientRect();
        return clientX >= rect.left
          && clientX <= rect.right
          && clientY >= rect.top
          && clientY <= rect.bottom;
      });
    };

    const updateHoveredRightByPoint = (clientX, clientY) => {
      const nextIndex = findRightIndexAtViewportPoint(clientX, clientY);
      hoveredRightIndex = Number.isInteger(nextIndex) ? nextIndex : -1;
    };

    const endDragAtPoint = (clientX, clientY) => {
      if (!dragGhost) return;
      let rightIndex = findRightIndexAtViewportPoint(clientX, clientY);

      if (!Number.isInteger(rightIndex) || rightIndex < 0) {
        const dropNode = document.elementFromPoint(clientX, clientY);
        const rightCard = dropNode instanceof HTMLElement ? dropNode.closest(".arith-link-card[data-side='right']") : null;
        if (rightCard instanceof HTMLElement) {
          rightIndex = Number.parseInt(String(rightCard.dataset.index || "-1"), 10);
        }
      }

      if ((!Number.isInteger(rightIndex) || rightIndex < 0) && Number.isInteger(hoveredRightIndex) && hoveredRightIndex >= 0) {
        rightIndex = hoveredRightIndex;
      }

      if (Number.isInteger(rightIndex) && rightIndex >= 0) {
        applyLink(dragGhost.leftIndex, rightIndex);
      }
      clearDrag();
    };

    const handlePointerMoveGlobal = (event) => {
      if (!dragGhost || activeDragMode !== "pointer" || activePointerId == null || event.pointerId !== activePointerId) return;
      updateHoveredRightByPoint(event.clientX, event.clientY);
      updateDragPosition(event.clientX, event.clientY);
    };

    const handlePointerUpGlobal = (event) => {
      if (!dragGhost || activeDragMode !== "pointer" || activePointerId == null || event.pointerId !== activePointerId) return;
      endDragAtPoint(event.clientX, event.clientY);
    };

    const handlePointerCancelGlobal = (event) => {
      if (!dragGhost || activeDragMode !== "pointer" || activePointerId == null || event.pointerId !== activePointerId) return;
      clearDrag();
    };

    const handleMouseMoveGlobal = (event) => {
      if (!dragGhost || activeDragMode !== "mouse") return;
      updateHoveredRightByPoint(event.clientX, event.clientY);
      updateDragPosition(event.clientX, event.clientY);
    };

    const handleMouseUpGlobal = (event) => {
      if (!dragGhost || activeDragMode !== "mouse") return;
      endDragAtPoint(event.clientX, event.clientY);
    };

    const handleTouchMoveGlobal = (event) => {
      if (!dragGhost || activeDragMode !== "touch") return;
      const touch = event.touches && event.touches[0];
      if (!touch) return;
      updateHoveredRightByPoint(touch.clientX, touch.clientY);
      updateDragPosition(touch.clientX, touch.clientY);
      event.preventDefault();
    };

    const handleTouchEndGlobal = (event) => {
      if (!dragGhost || activeDragMode !== "touch") return;
      const touch = event.changedTouches && event.changedTouches[0];
      if (!touch) {
        clearDrag();
        return;
      }
      endDragAtPoint(touch.clientX, touch.clientY);
    };

    document.addEventListener("pointermove", handlePointerMoveGlobal);
    document.addEventListener("pointerup", handlePointerUpGlobal);
    document.addEventListener("pointercancel", handlePointerCancelGlobal);
    document.addEventListener("mousemove", handleMouseMoveGlobal);
    document.addEventListener("mouseup", handleMouseUpGlobal);
    document.addEventListener("touchmove", handleTouchMoveGlobal, { passive: false });
    document.addEventListener("touchend", handleTouchEndGlobal);
    document.addEventListener("touchcancel", handleTouchEndGlobal);

    leftCards.forEach((node, index) => {
      if (!(node instanceof HTMLButtonElement)) return;
      node.addEventListener("click", () => {
        const existingLinkIndex = links.findIndex((item) => item.leftIndex === index);
        if (selectedLeftIndex < 0 && existingLinkIndex >= 0) {
          links.splice(existingLinkIndex, 1);
          syncUi();
          return;
        }
        selectedLeftIndex = selectedLeftIndex === index ? -1 : index;
        syncUi();
      });

      node.addEventListener("pointerdown", (event) => {
        if (!event.isPrimary) return;
        event.preventDefault();
        selectedLeftIndex = index;
        activeDragMode = "pointer";
        startDragFromLeft(index, event.pointerId, node);
      });

      node.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;
        if (activeDragMode === "pointer") return;
        event.preventDefault();
        selectedLeftIndex = index;
        startMouseDragFromLeft(index);
      });

      node.addEventListener("touchstart", (event) => {
        if (activeDragMode === "pointer") return;
        event.preventDefault();
        selectedLeftIndex = index;
        startTouchDragFromLeft(index);
      }, { passive: false });
    });

    rightCards.forEach((node, index) => {
      if (!(node instanceof HTMLButtonElement)) return;

      node.addEventListener("pointerenter", () => {
        if (!dragGhost) return;
        hoveredRightIndex = index;
      });

      node.addEventListener("pointerleave", () => {
        if (!dragGhost) return;
        if (hoveredRightIndex === index) hoveredRightIndex = -1;
      });

      node.addEventListener("pointerup", (event) => {
        if (!event.isPrimary || !dragGhost) return;
        applyLink(dragGhost.leftIndex, index);
        clearDrag();
      });

      node.addEventListener("mouseup", () => {
        if (!dragGhost) return;
        applyLink(dragGhost.leftIndex, index);
        clearDrag();
      });

      node.addEventListener("touchend", (event) => {
        if (!dragGhost) return;
        event.preventDefault();
        applyLink(dragGhost.leftIndex, index);
        clearDrag();
      }, { passive: false });

      node.addEventListener("click", () => {
        if (selectedLeftIndex < 0) {
          const existingLinkIndex = links.findIndex((item) => item.rightIndex === index);
          if (existingLinkIndex >= 0) {
            links.splice(existingLinkIndex, 1);
            syncUi();
          }
          return;
        }

        applyLink(selectedLeftIndex, index);
        selectedLeftIndex = -1;
        syncUi();
      });
    });

    window.addEventListener("resize", () => drawArithmeticLinkLines(board, links));
    board.addEventListener("DOMNodeRemoved", () => {
      document.removeEventListener("pointermove", handlePointerMoveGlobal);
      document.removeEventListener("pointerup", handlePointerUpGlobal);
      document.removeEventListener("pointercancel", handlePointerCancelGlobal);
      document.removeEventListener("mousemove", handleMouseMoveGlobal);
      document.removeEventListener("mouseup", handleMouseUpGlobal);
      document.removeEventListener("touchmove", handleTouchMoveGlobal);
      document.removeEventListener("touchend", handleTouchEndGlobal);
      document.removeEventListener("touchcancel", handleTouchEndGlobal);
    });
    syncUi();
  });
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
  const linkBoards = Array.from(document.querySelectorAll("[data-role='arith-link-board'][data-readonly='false']"));
  if (linkBoards.length > 0) {
    wireArithmeticLinkToTenInputs(document);
    return;
  }
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
  const longWorkInputs = Array.from(document.querySelectorAll(".arithmetic-long-work-input"))
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

  longWorkInputs.forEach((input, index) => {
    blockNonTypingInput(input);
    input.addEventListener("input", () => {
      input.value = String(input.value || "").slice(-1);
      if (input.value && index < longWorkInputs.length - 1) {
        longWorkInputs[index + 1].focus();
      }
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Backspace" && !input.value && index > 0) {
        longWorkInputs[index - 1].focus();
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

  function wireMulWorkRow(row) {
    const rowInputs = Array.from(row.querySelectorAll(".arithmetic-work-input, .arithmetic-work-cell-carry"))
      .filter((n) => n instanceof HTMLInputElement && !n.disabled);
    rowInputs.forEach((input) => {
      blockNonTypingInput(input);
      input.addEventListener("input", () => {
        input.value = String(input.value || "").slice(-1);
      });
    });
    const removeBtn = row.querySelector(".arithmetic-remove-row");
    if (removeBtn) {
      removeBtn.addEventListener("click", () => {
        row.remove();
        queueMicrotask(() => {
          const activeMulContainer = document.querySelector(".arithmetic-mul-work-container");
          const activeRowsHost = activeMulContainer ? activeMulContainer.querySelector(".arithmetic-mul-work-rows") : null;
          const rowCount = activeRowsHost ? activeRowsHost.querySelectorAll(".arithmetic-mul-work-row").length : 0;
          if (activeMulContainer) {
            activeMulContainer.classList.toggle("has-rows", rowCount > 0);
          }
        });
      });
    }
  }

  const mulContainer = document.querySelector(".arithmetic-mul-work-container");
  if (mulContainer) {
    const rowsHost = mulContainer.querySelector(".arithmetic-mul-work-rows");
    const syncMulWorkState = () => {
      const rowCount = rowsHost ? rowsHost.querySelectorAll(".arithmetic-mul-work-row").length : 0;
      mulContainer.classList.toggle("has-rows", rowCount > 0);
    };

    // Add highlighting for multiplication cells
    const addMulHighlighting = (workContainer) => {
      const workCells = workContainer.querySelectorAll("[data-mul-cell='work']");
      workCells.forEach((cell) => {
        cell.style.cursor = "pointer";
        cell.addEventListener("click", (e) => {
          e.stopPropagation();
          const mulIdx = cell.dataset.mulIdx;
          const mulDigit = cell.dataset.mulDigit;
          if (mulIdx === undefined || mulDigit === undefined) return;

          // Clear previous highlights
          document.querySelectorAll(".arithmetic-mul-highlight").forEach(el => {
            el.classList.remove("arithmetic-mul-highlight");
          });

          // Highlight the multiplicand digit (operand A) - only if not a shift zero
          if (Number(mulIdx) !== -1) {
            const operandAContainer = document.querySelector(".arithmetic-number-cells[data-operand='a']");
            if (operandAContainer) {
              const cells = Array.from(operandAContainer.querySelectorAll(".arithmetic-cell"));
              if (cells[mulIdx]) {
                cells[mulIdx].classList.add("arithmetic-mul-highlight");
              }
            }
          }

          // Highlight the multiplier digit (operand B)
          const operandBContainer = document.querySelector(".arithmetic-number-cells[data-operand='b']");
          if (operandBContainer) {
            const cells = Array.from(operandBContainer.querySelectorAll(".arithmetic-cell"));
            if (cells[mulDigit]) {
              cells[mulDigit].classList.add("arithmetic-mul-highlight");
            }
          }

          // Highlight the current work cell
          cell.classList.add("arithmetic-mul-highlight");
        });
        cell.addEventListener("mouseenter", () => { applyMulCircle(cell, mulContainer, true); showMulTooltip(cell); });
        cell.addEventListener("mouseleave", () => { applyMulCircle(cell, mulContainer, false); hideMulTooltip(); });
      });
    };

    // Apply highlighting to existing rows (including solution rows)
    if (rowsHost) {
      Array.from(rowsHost.querySelectorAll(".arithmetic-mul-work-row")).forEach(row => {
        addMulHighlighting(row);
      });
    }
    wireMulSumHover(mulContainer);

    Array.from(mulContainer.querySelectorAll(".arithmetic-mul-work-row")).forEach(wireMulWorkRow);
    syncMulWorkState();

    const addBtn = mulContainer.querySelector(".arithmetic-add-row-btn");
    if (addBtn) {
      addBtn.addEventListener("click", () => {
        const existingRows = rowsHost ? rowsHost.querySelectorAll(".arithmetic-mul-work-row") : [];
        if (existingRows.length >= 15) return;
        const columns = Number.parseInt(mulContainer.dataset.columns, 10) || 4;
        const template = document.createElement("template");
        template.innerHTML = buildArithmeticMulWorkRow(columns, { readOnly: false }).trim();
        const newRow = template.content.firstChild;
        if (rowsHost) {
          rowsHost.appendChild(newRow);
        }
        wireMulWorkRow(newRow);
        syncMulWorkState();
        const firstInput = newRow.querySelector(".arithmetic-work-input");
        if (firstInput) firstInput.focus();
      });
    }

  }

  function wireLongDivisionWorkRow(row) {
    const rowInputs = Array.from(row.querySelectorAll(".arithmetic-long-work-input, .arithmetic-long-work-carry"))
      .filter((n) => n instanceof HTMLInputElement && !n.disabled);
    rowInputs.forEach((input) => {
      blockNonTypingInput(input);
      input.addEventListener("input", () => {
        input.value = String(input.value || "").slice(-1);
      });
    });
    const removeBtn = row.querySelector(".arithmetic-remove-row");
    if (removeBtn) {
      removeBtn.addEventListener("click", () => {
        row.remove();
        const host = row.parentElement;
        if (host) {
          syncLongDivisionDividers(host);
        }
      });
    }
  }

  function syncLongDivisionDividers(rowsHost) {
    if (!rowsHost) return;
    Array.from(rowsHost.querySelectorAll(".arithmetic-long-work-divider-row")).forEach((node) => node.remove());
    const rows = Array.from(rowsHost.querySelectorAll(".arithmetic-long-work-row"));
    rows.forEach((row, index) => {
      const sideCell = row.querySelector(".arithmetic-long-row-side");
      if (sideCell) {
        const isSubtractionRow = index % 2 === 0;
        sideCell.textContent = isSubtractionRow ? "-" : "";
        sideCell.classList.toggle("arithmetic-long-operation-marker", isSubtractionRow);
        sideCell.classList.toggle("arithmetic-long-side-spacer", !isSubtractionRow);
      }
      const shouldShowDividerAfterRow = index % 2 === 0;
      if (shouldShowDividerAfterRow) {
        const template = document.createElement("template");
        template.innerHTML = buildArithmeticLongDivisionDividerRow().trim();
        const divider = template.content.firstChild;
        row.insertAdjacentElement("afterend", divider);
      }
    });
  }

  const longDivisionContainer = document.querySelector(".arithmetic-long-work-container");
  if (longDivisionContainer) {
    const rowsHost = longDivisionContainer.querySelector(".arithmetic-long-work-rows");
    Array.from(longDivisionContainer.querySelectorAll(".arithmetic-long-work-row")).forEach(wireLongDivisionWorkRow);

    const addBtn = longDivisionContainer.querySelector(".arithmetic-add-row-btn");
    if (addBtn) {
      addBtn.addEventListener("click", () => {
        const existingRows = rowsHost ? rowsHost.querySelectorAll(".arithmetic-long-work-row") : [];
        if (existingRows.length >= 15) return;
        const columns = Number.parseInt(longDivisionContainer.dataset.columns, 10) || 6;
        const rowTemplate = document.createElement("template");
        rowTemplate.innerHTML = buildArithmeticLongDivisionWorkRow(columns, { readOnly: false }).trim();
        const newRow = rowTemplate.content.firstChild;
        if (rowsHost) {
          rowsHost.appendChild(newRow);
          syncLongDivisionDividers(rowsHost);
        }
        wireLongDivisionWorkRow(newRow);
        const firstInput = newRow.querySelector(".arithmetic-long-work-input");
        if (firstInput) firstInput.focus();
      });
    }
  }

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
  const linkAnswer = scope.querySelector("[data-role='arith-link-answer']");
  if (linkAnswer instanceof HTMLInputElement) {
    return String(linkAnswer.value || "").trim();
  }
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

function normalizeTracingTargetNumber(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return 5;
  return Math.max(0, Math.min(100, parsed));
}

function numberToSimpleWord(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 0 || n > 100) return String(value || "");
  const words0To19 = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"
  ];
  const tensWords = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  if (n < 20) return words0To19[n];
  if (n === 100) return "one hundred";
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return ones === 0 ? tensWords[tens] : `${tensWords[tens]}-${words0To19[ones]}`;
}

function getDigitTracePaths(digitChar) {
  const paths = {
    "0": [
      "M 25 12 C 8 28 8 76 25 92 C 42 108 68 108 85 92 C 102 76 102 28 85 12 C 68 -4 42 -4 25 12"
    ],
    "1": [
      "M 35 22 L 52 8 L 52 96"
    ],
    "2": [
      "M 18 24 C 30 6 72 6 84 24 C 90 34 86 48 76 56 L 22 96 L 88 96"
    ],
    "3": [
      "M 20 20 C 42 4 78 4 84 26 C 88 40 76 52 58 56 C 76 60 90 72 84 90 C 76 112 40 112 20 94"
    ],
    "4": [
      "M 24 66 L 66 14 L 66 98",
      "M 24 66 L 86 66"
    ],
    "5": [
      "M 82 10 L 28 10 L 24 52 C 34 44 46 42 58 44 C 82 48 90 76 74 94 C 58 112 30 108 18 92"
    ],
    "6": [
      "M 78 16 C 60 2 30 8 22 34 C 16 52 20 76 36 92 C 50 106 74 104 84 84 C 94 64 82 46 62 46 C 44 46 30 56 28 74"
    ],
    "7": [
      "M 16 12 L 88 12 L 42 96"
    ],
    "8": [
      "M 50 10 C 32 10 20 22 20 36 C 20 48 30 58 50 62 C 70 58 80 48 80 36 C 80 22 68 10 50 10",
      "M 50 62 C 24 66 16 80 20 92 C 26 108 74 108 80 92 C 84 80 76 66 50 62"
    ],
    "9": [
      "M 42 20 C 50 12 64 12 72 20 C 80 28 80 42 72 50 C 64 58 50 58 42 50 C 34 42 34 28 42 20",
      "M 74 32 L 74 104"
    ]
  };
  return paths[String(digitChar)] || paths["0"];
}

function extractPathStartPoint(pathDef) {
  const match = String(pathDef || "").match(/M\s*(-?\d+(?:\.\d+)?)\s*(-?\d+(?:\.\d+)?)/i);
  if (!match) return null;
  return {
    x: Number.parseFloat(match[1]),
    y: Number.parseFloat(match[2])
  };
}

function buildNumberTracingSvgMarkup(targetNumber) {
  const digits = String(Math.max(0, Number.parseInt(targetNumber, 10) || 0)).split("").filter((ch) => /\d/.test(ch));
  const safeDigits = digits.length > 0 ? digits : ["0"];
  const digitWidth = 110;
  const gap = 20;
  const leftPad = 22;
  const topPad = 6;
  const viewHeight = 120;
  const totalWidth = leftPad * 2 + (safeDigits.length * digitWidth) + ((safeDigits.length - 1) * gap);

  const traceParts = [];
  safeDigits.forEach((digit, index) => {
    const offsetX = leftPad + index * (digitWidth + gap);
    const offsetY = topPad;
    const paths = getDigitTracePaths(digit);
    paths.forEach((pathDef) => {
      traceParts.push(`<path class="number-tracing-shadow-path" d="${pathDef}" transform="translate(${offsetX}, ${offsetY})"></path>`);
      traceParts.push(`<path class="number-tracing-dotted-path" d="${pathDef}" transform="translate(${offsetX}, ${offsetY})"></path>`);
    });
  });

  return `
    <svg class="number-tracing-svg" viewBox="0 0 ${totalWidth} ${viewHeight}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Trace number ${targetNumber}">
      <line class="number-tracing-guide-line" x1="0" y1="18" x2="${totalWidth}" y2="18"></line>
      <line class="number-tracing-guide-line number-tracing-guide-line-mid" x1="0" y1="60" x2="${totalWidth}" y2="60"></line>
      <line class="number-tracing-guide-line" x1="0" y1="104" x2="${totalWidth}" y2="104"></line>
      ${traceParts.join("")}
    </svg>
  `;
}

function getDigitStrokeCount(digitChar) {
  return getDigitTracePaths(digitChar).length;
}

function getTracingExpectedStrokes(targetNumber) {
  const digits = String(Math.max(0, Number.parseInt(targetNumber, 10) || 0)).split("").filter((ch) => /\d/.test(ch));
  if (digits.length === 0) return 1;
  return digits.reduce((sum, ch) => sum + getDigitStrokeCount(ch), 0);
}

function buildNumberTracingMarkup(config = {}) {
  const target = normalizeTracingTargetNumber(config.targetNumber);
  const prompt = String(config.prompt || "Trace the dotted number and say it aloud.").trim();
  const targetLabel = `Trace number: ${target}`;
  const prepMode = Boolean(config.prepMode);
  const showInstructions = config.showInstructions === true;
  const minDotsPercent = Number.isFinite(Number(config.minDotsPercent))
    ? Math.max(1, Math.min(100, Number(config.minDotsPercent)))
    : 95;
  const guidanceMarkup = `
    <div class="number-tracing-assist" role="note" aria-label="Stroke guidance">
      <p class="number-tracing-assist-title">How to write</p>
      <p class="number-tracing-assist-step">1. Trace directly over the dotted number.</p>
      <p class="number-tracing-assist-step">2. Touch the pink guide dots with your drawing.</p>
      <p class="number-tracing-strokes">Touch requirement: ${Math.round(minDotsPercent)}% of dots.</p>
    </div>
  `;
  return `
    <div class="number-tracing-card">
      ${showInstructions && prepMode ? "<p class='helper-text number-tracing-prep'>Prep mode: tap, say, trace.</p>" : ""}
      ${showInstructions ? `<p class="helper-text number-tracing-prompt">${escapeHtml(prompt)}</p>` : ""}
      ${showInstructions ? `<p class="number-tracing-target">${escapeHtml(targetLabel)}</p>` : ""}
      ${showInstructions ? guidanceMarkup : ""}
      <div class="number-tracing-stage" data-tracing-stage="true">
        ${buildNumberTracingSvgMarkup(target)}
        <canvas class="number-tracing-canvas" width="280" height="190" aria-label="Tracing canvas"></canvas>
      </div>
    </div>
  `;
}

function wireNumberTracingCanvas(container, options = {}) {
  if (!container) return;
  const { onTraceProgress } = options;
  const stage = container.querySelector("[data-tracing-stage='true']");
  const canvas = container.querySelector(".number-tracing-canvas");
  if (!(stage instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) return;

  const context = canvas.getContext("2d");
  if (!context) return;

  let guideSamples = [];
  let coveredGuideSampleCount = 0;
  let traceCoveragePercent = 0;

  const minDotsPercent = Number.isFinite(Number(options.minDotsPercent))
    ? Math.max(1, Math.min(100, Number(options.minDotsPercent)))
    : 95;
  const brushSize = Number.isFinite(Number(options.brushSize)) ? Math.max(6, Number(options.brushSize)) : 10;

  const pointToSegmentDistance = (point, start, end) => {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (dx === 0 && dy === 0) {
      const sx = point.x - start.x;
      const sy = point.y - start.y;
      return Math.sqrt((sx * sx) + (sy * sy));
    }
    const t = Math.max(0, Math.min(1, (((point.x - start.x) * dx) + ((point.y - start.y) * dy)) / ((dx * dx) + (dy * dy))));
    const projX = start.x + (t * dx);
    const projY = start.y + (t * dy);
    const px = point.x - projX;
    const py = point.y - projY;
    return Math.sqrt((px * px) + (py * py));
  };

  const recalcCoveragePercent = () => {
    if (!guideSamples.length) {
      traceCoveragePercent = 0;
      return;
    }
    traceCoveragePercent = (coveredGuideSampleCount / guideSamples.length) * 100;
  };

  const getRequiredDotCount = () => {
    if (!guideSamples.length) return 1;
    return Math.max(1, Math.ceil(guideSamples.length * (minDotsPercent / 100)));
  };

  const rebuildGuideSamples = () => {
    guideSamples = [];
    coveredGuideSampleCount = 0;
    traceCoveragePercent = 0;

    const svg = stage.querySelector(".number-tracing-svg");
    if (!(svg instanceof SVGSVGElement)) return;
    const canvasRect = canvas.getBoundingClientRect();
    if (!canvasRect.width || !canvasRect.height) return;
    const sampleStep = 4;

    svg.querySelectorAll(".number-tracing-dotted-path").forEach((pathNode) => {
      if (!(pathNode instanceof SVGPathElement)) return;
      const ctm = pathNode.getScreenCTM();
      if (!ctm) return;
      const totalLength = pathNode.getTotalLength();
      for (let d = 0; d <= totalLength; d += sampleStep) {
        const point = pathNode.getPointAtLength(d);
        const screenX = (ctm.a * point.x) + (ctm.c * point.y) + ctm.e;
        const screenY = (ctm.b * point.x) + (ctm.d * point.y) + ctm.f;
        guideSamples.push({
          x: screenX - canvasRect.left,
          y: screenY - canvasRect.top,
          covered: false
        });
      }
    });

    recalcCoveragePercent();
  };

  const markCoverageForSegment = (start, end) => {
    if (!guideSamples.length) return;
    const threshold = Math.max(7.5, (context.lineWidth * 1.25));
    let hasNewCoverage = false;
    for (let i = 0; i < guideSamples.length; i += 1) {
      const sample = guideSamples[i];
      if (sample.covered) continue;
      if (pointToSegmentDistance(sample, start, end) <= threshold) {
        sample.covered = true;
        coveredGuideSampleCount += 1;
        hasNewCoverage = true;
      }
    }
    if (hasNewCoverage) {
      recalcCoveragePercent();
    }
  };

  const setCanvasSize = () => {
    const rect = stage.getBoundingClientRect();
    const width = Math.max(200, Math.round(rect.width));
    const height = Math.max(140, Math.round(rect.height));
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.scale(dpr, dpr);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = brushSize;
    context.strokeStyle = "#0284c7";
    rebuildGuideSamples();
    notifyProgress();
  };

  const toPoint = (event) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
  };

  let drawing = false;
  let lastPoint = null;
  let traceMotionCount = 0;
  let traceTotalDistance = 0;
  let traceMinX = Number.POSITIVE_INFINITY;
  let traceMaxX = Number.NEGATIVE_INFINITY;
  let traceMinY = Number.POSITIVE_INFINITY;
  let traceMaxY = Number.NEGATIVE_INFINITY;
  let completedStrokeCount = 0;
  let currentStrokeMoved = false;
  let hasSignificantTrace = false;
  const notifyProgress = () => {
    if (typeof onTraceProgress === "function") {
      onTraceProgress(hasSignificantTrace, traceMotionCount, {
        strokeCount: completedStrokeCount,
        coveragePercent: traceCoveragePercent,
        coveredGuideDots: coveredGuideSampleCount,
        totalGuideDots: guideSamples.length,
        requiredDots: getRequiredDotCount(),
        minDotsPercent
      });
    }
  };

  const onDown = (event) => {
    drawing = true;
    lastPoint = toPoint(event);
    currentStrokeMoved = false;
    markCoverageForSegment(lastPoint, lastPoint);
    notifyProgress();
    canvas.setPointerCapture(event.pointerId);
  };

  const onMove = (event) => {
    if (!drawing || !lastPoint) return;
    const next = toPoint(event);
    context.beginPath();
    context.moveTo(lastPoint.x, lastPoint.y);
    context.lineTo(next.x, next.y);
    context.stroke();

    const dx = next.x - lastPoint.x;
    const dy = next.y - lastPoint.y;
    const distance = Math.sqrt((dx * dx) + (dy * dy));
    if (distance >= 1.5) {
      currentStrokeMoved = true;
      traceMotionCount += 1;
      traceTotalDistance += distance;
      traceMinX = Math.min(traceMinX, lastPoint.x, next.x);
      traceMaxX = Math.max(traceMaxX, lastPoint.x, next.x);
      traceMinY = Math.min(traceMinY, lastPoint.y, next.y);
      traceMaxY = Math.max(traceMaxY, lastPoint.y, next.y);
      markCoverageForSegment(lastPoint, next);
      const hasGuideCoverage = coveredGuideSampleCount >= getRequiredDotCount();
      if (!hasSignificantTrace && hasGuideCoverage) {
        hasSignificantTrace = true;
      }
      notifyProgress();
    }

    lastPoint = next;
  };

  const onUp = (event) => {
    drawing = false;
    if (lastPoint) {
      // Count simple tap interactions by checking coverage at the tap point.
      markCoverageForSegment(lastPoint, lastPoint);
    }
    if (currentStrokeMoved) {
      completedStrokeCount += 1;
      currentStrokeMoved = false;
    }

    const hasGuideCoverage = coveredGuideSampleCount >= getRequiredDotCount();
    if (!hasSignificantTrace && hasGuideCoverage) {
      hasSignificantTrace = true;
    }
    notifyProgress();

    lastPoint = null;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  };

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("pointerleave", onUp);

  setCanvasSize();
  window.addEventListener("resize", setCanvasSize);
  notifyProgress();
}

function normalizeNumberOrderingDirection(value) {
  return String(value || "ascending").trim().toLowerCase() === "descending"
    ? "descending"
    : "ascending";
}

function parseNumberOrderingValues(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => Number.parseInt(item, 10))
      .filter((item) => Number.isInteger(item));
  }

  return String(value || "")
    .split(/[\s,]+/)
    .map((item) => Number.parseInt(item, 10))
    .filter((item) => Number.isInteger(item));
}

function getNumberOrderingConfig(appOrConfig) {
  const config = appOrConfig && appOrConfig.config ? appOrConfig.config : appOrConfig;
  const direction = normalizeNumberOrderingDirection(config && config.direction);
  const cards = parseNumberOrderingValues(config && config.cards);
  const safeCards = cards.length > 0 ? cards : [7, 3, 9, 5];
  const explicitOrder = parseNumberOrderingValues(config && config.correctOrder);
  const fallbackOrder = safeCards.slice().sort((a, b) => a - b);
  if (direction === "descending") {
    fallbackOrder.reverse();
  }
  const correctOrder = explicitOrder.length > 0 ? explicitOrder : fallbackOrder;
  const defaultPrompt = direction === "descending"
    ? "Order the number cards from largest to smallest."
    : "Order the number cards from smallest to largest.";
  const prompt = String((config && config.prompt) || defaultPrompt).trim() || defaultPrompt;
  return {
    direction,
    cards: safeCards,
    correctOrder,
    prompt
  };
}

function buildNumberOrderingMarkup(config = {}) {
  const normalized = getNumberOrderingConfig(config);
  const currentOrderText = normalized.cards.join(", ");
  return `
    <div class="number-ordering-card" data-number-ordering-root="true">
      <p class="helper-text number-ordering-prompt">${escapeHtml(normalized.prompt)}</p>
      <div class="number-ordering-cards" data-number-ordering-stage="true" aria-label="Number ordering cards"></div>
      <p class="number-ordering-current">Current order: <strong data-role="number-ordering-current">${escapeHtml(currentOrderText)}</strong></p>
      <p class="helper-text number-ordering-tip">Drag cards to reorder. You can also use left/right buttons.</p>
    </div>
  `;
}

function normalizeIconCountConfig(config = {}) {
  const totalRaw = Number.parseInt(config.totalCount, 10);
  const totalCount = Number.isInteger(totalRaw) ? Math.max(0, Math.min(20, totalRaw)) : 8;
  const iconShapeRaw = String(config.iconShape || "circle").trim().toLowerCase();
  const iconShape = ["circle", "star", "apple"].includes(iconShapeRaw) ? iconShapeRaw : "circle";
  let groups = Array.isArray(config.groups)
    ? config.groups.map((item) => Number.parseInt(item, 10)).filter((item) => Number.isInteger(item) && item >= 0)
    : [];
  if (groups.length === 0) {
    groups = [totalCount];
  }
  const sum = groups.reduce((acc, value) => acc + value, 0);
  if (sum !== totalCount) {
    groups = [totalCount];
  }
  const prompt = String(config.prompt || "How many icons are shown in total?").trim() || "How many icons are shown in total?";
  return {
    totalCount,
    groups,
    iconShape,
    prompt
  };
}

function buildIconCountMarkup(config = {}) {
  const normalized = normalizeIconCountConfig(config);
  const iconGlyph = normalized.iconShape === "star"
    ? "&#9733;"
    : normalized.iconShape === "apple"
      ? "&#127822;"
      : "";
  return `
    <div class="icon-count-card">
      <p class="helper-text icon-count-prompt">${escapeHtml(normalized.prompt)}</p>
      <div class="icon-count-groups" aria-label="Icon groups for counting">
        ${normalized.groups.map((group, groupIndex) => `
          <div class="icon-count-group" aria-label="Group ${groupIndex + 1} with ${group} icons">
            ${Array.from({ length: group }).map(() => `<span class='icon-count-dot icon-count-dot-${normalized.iconShape}'>${iconGlyph}</span>`).join("")}
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function wireNumberOrderingInteraction(container, app, options = {}) {
  if (!(container instanceof HTMLElement)) return;
  const normalized = getNumberOrderingConfig(app && app.config ? app.config : app);
  const stage = container.querySelector("[data-number-ordering-stage='true']");
  if (!(stage instanceof HTMLElement)) return;

  const currentLabel = container.querySelector("[data-role='number-ordering-current']");
  const answerInput = container.querySelector("[data-role='number-ordering-answer']")
    || (container.parentElement && container.parentElement.querySelector("[data-role='number-ordering-answer']"));
  const onChange = typeof options.onChange === "function" ? options.onChange : null;
  let currentOrder = normalized.cards.slice();
  let draggingIndex = -1;
  let touchDragIndex = -1;

  const updateStateUi = () => {
    const text = currentOrder.join(", ");
    if (currentLabel instanceof HTMLElement) {
      currentLabel.textContent = text;
    }
    if (answerInput instanceof HTMLInputElement) {
      answerInput.value = text;
    }
    stage.dataset.order = text;
    if (onChange) {
      onChange(currentOrder.slice());
    }
  };

  const moveCard = (fromIndex, toIndex) => {
    if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) return;
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= currentOrder.length || toIndex >= currentOrder.length) return;
    if (fromIndex === toIndex) return;
    const next = currentOrder.slice();
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    currentOrder = next;
    renderCards();
  };

  const renderCards = () => {
    stage.innerHTML = currentOrder.map((value, index) => `
      <div class="number-ordering-item-wrap" data-index="${index}">
        <button
          type="button"
          class="number-ordering-item"
          draggable="true"
          data-role="number-ordering-card"
          data-index="${index}"
          aria-label="Card ${escapeHtml(String(value))}"
        >${escapeHtml(String(value))}</button>
        <div class="number-ordering-shift-controls">
          <button type="button" class="number-ordering-shift-btn" data-role="number-ordering-left" data-index="${index}" aria-label="Move left">&#9664;</button>
          <button type="button" class="number-ordering-shift-btn" data-role="number-ordering-right" data-index="${index}" aria-label="Move right">&#9654;</button>
        </div>
      </div>
    `).join("");

    stage.querySelectorAll("[data-role='number-ordering-card']").forEach((node) => {
      if (!(node instanceof HTMLButtonElement)) return;
      node.addEventListener("dragstart", (event) => {
        draggingIndex = Number.parseInt(node.dataset.index || "-1", 10);
        node.classList.add("is-dragging");
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", String(draggingIndex));
        }
      });
      node.addEventListener("dragend", () => {
        draggingIndex = -1;
        node.classList.remove("is-dragging");
      });
      node.addEventListener("pointerdown", (event) => {
        if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
        touchDragIndex = Number.parseInt(node.dataset.index || "-1", 10);
        node.classList.add("is-dragging");
        if (node.setPointerCapture) {
          node.setPointerCapture(event.pointerId);
        }
      });
      node.addEventListener("pointermove", (event) => {
        if (touchDragIndex < 0) return;
        if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
        event.preventDefault();
      });
      node.addEventListener("pointerup", (event) => {
        if (touchDragIndex < 0) return;
        if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
        const sourceIndex = touchDragIndex;
        touchDragIndex = -1;
        node.classList.remove("is-dragging");
        if (node.releasePointerCapture && node.hasPointerCapture && node.hasPointerCapture(event.pointerId)) {
          node.releasePointerCapture(event.pointerId);
        }
        const dropTarget = document.elementFromPoint(event.clientX, event.clientY);
        const targetCard = dropTarget instanceof HTMLElement
          ? dropTarget.closest("[data-role='number-ordering-card']")
          : null;
        const targetIndex = targetCard instanceof HTMLElement
          ? Number.parseInt(targetCard.dataset.index || "-1", 10)
          : sourceIndex;
        moveCard(sourceIndex, targetIndex);
      });
      node.addEventListener("pointercancel", (event) => {
        touchDragIndex = -1;
        node.classList.remove("is-dragging");
        if (node.releasePointerCapture && node.hasPointerCapture && node.hasPointerCapture(event.pointerId)) {
          node.releasePointerCapture(event.pointerId);
        }
      });
      node.addEventListener("dragover", (event) => {
        event.preventDefault();
      });
      node.addEventListener("drop", (event) => {
        event.preventDefault();
        const targetIndex = Number.parseInt(node.dataset.index || "-1", 10);
        const fromData = event.dataTransfer ? Number.parseInt(event.dataTransfer.getData("text/plain"), 10) : draggingIndex;
        const sourceIndex = Number.isInteger(fromData) && fromData >= 0 ? fromData : draggingIndex;
        moveCard(sourceIndex, targetIndex);
      });
    });

    stage.querySelectorAll("[data-role='number-ordering-left']").forEach((node) => {
      if (!(node instanceof HTMLButtonElement)) return;
      node.addEventListener("click", () => {
        const index = Number.parseInt(node.dataset.index || "-1", 10);
        moveCard(index, Math.max(0, index - 1));
      });
    });

    stage.querySelectorAll("[data-role='number-ordering-right']").forEach((node) => {
      if (!(node instanceof HTMLButtonElement)) return;
      node.addEventListener("click", () => {
        const index = Number.parseInt(node.dataset.index || "-1", 10);
        moveCard(index, Math.min(currentOrder.length - 1, index + 1));
      });
    });

    updateStateUi();
  };

  renderCards();
}

function getInteractiveAppTitle(type) {
  if (type === "time") return "Interactive: Time";
  if (type === "number-tracing") return "Interactive: Number Tracing";
  if (type === "number-ordering") return "Interactive: Number Ordering";
  if (type === "icon-count") return "Interactive: Icon Count";
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

function updateInteractivePreview(preview, app, options = {}) {
  if (!preview || !app || !app.type) return;

  let content = "";
  if (app.type === "number-tracing") {
    content = buildNumberTracingMarkup(app.config || {});
  } else if (app.type === "number-ordering") {
    content = buildNumberOrderingMarkup(app.config || {});
  } else if (app.type === "icon-count") {
    content = buildIconCountMarkup(app.config || {});
  } else if (app.type === "time") {
    content = buildTimeClockMarkup(app.config || {}, { withReadout: true });
  } else if (app.type === "number-line") {
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

  if (app.type === "number-tracing") {
    const config = app.config || {};
    const minDotsPercent = Number.isFinite(Number(config.minDotsPercent))
      ? Math.max(1, Math.min(100, Number(config.minDotsPercent)))
      : 95;
    wireNumberTracingCanvas(preview, {
      onTraceProgress: typeof options.onTracingProgress === "function"
        ? options.onTracingProgress
        : null,
      minDotsPercent,
      brushSize: 10
    });
  }

  if (app.type === "number-ordering") {
    wireNumberOrderingInteraction(preview, app, {
      onChange: typeof options.onNumberOrderingChange === "function"
        ? options.onNumberOrderingChange
        : null
    });
  }

  if (app.type === "fractions") {
    wireFractionsPreviewInputs(preview);
  }

  if (app.type === "arithmetic") {
    const config = app.config || {};
    const visualMode = String(config.visualMode || "").trim().toLowerCase();
    if (visualMode === "link-to-10") {
      const board = preview.querySelector("[data-role='arith-link-board']");
      if (board instanceof HTMLElement) {
        const leftCards = Array.from(board.querySelectorAll(".arith-link-card[data-side='left']"));
        const rightCards = Array.from(board.querySelectorAll(".arith-link-card[data-side='right']"));
        const normalizedLinkConfig = normalizeArithmeticLinkConfig(config);
        const fallbackAnswer = serializeArithmeticLinkAnswerPairs(normalizedLinkConfig.expectedPairs);
        const answerText = String(config.answer || fallbackAnswer || "");
        const pairs = parseArithmeticLinkAnswerText(answerText);
        const usedLeftIndices = new Set();
        const usedRightIndices = new Set();
        const links = pairs
          .map((pair) => {
            const leftIndex = leftCards.findIndex((node, index) => {
              if (usedLeftIndices.has(index)) return false;
              return Number.parseInt(String(node.dataset.value || ""), 10) === pair.left;
            });
            const rightIndex = rightCards.findIndex((node, index) => {
              if (usedRightIndices.has(index)) return false;
              return Number.parseInt(String(node.dataset.value || ""), 10) === pair.right;
            });
            if (leftIndex < 0 || rightIndex < 0) return null;
            usedLeftIndices.add(leftIndex);
            usedRightIndices.add(rightIndex);
            return { leftIndex, rightIndex, color: arithmeticLinkColorByIndex(leftIndex) };
          })
          .filter((item) => item !== null);

        leftCards.forEach((node, index) => {
          if (!(node instanceof HTMLElement)) return;
          node.classList.toggle("is-linked", links.some((item) => item.leftIndex === index));
        });
        rightCards.forEach((node, index) => {
          if (!(node instanceof HTMLElement)) return;
          node.classList.toggle("is-linked", links.some((item) => item.rightIndex === index));
        });
        drawArithmeticLinkLines(board, links);
      }
    }
  }
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
  const summary = buildFractionOperationSummary(app && app.config ? app.config : {});
  if (summary.error) {
    return [summary.error];
  }
  return [
    `Operation: ${summary.operationLabel}`,
    `Fraction A: ${formatFractionDisplay(summary.fractionA)}`,
    `Fraction B: ${formatFractionDisplay(summary.fractionB)}`,
    summary.lcmValue ? `LCM used: ${summary.lcmValue} (needed to match denominators before ${summary.operationLabel.toLowerCase()}).` : "LCM not required for this operation.",
    `HCF used: ${summary.hcfValue} (${summary.hcfValue > 1 ? "used to simplify" : "already simplest form"}).`,
    `Final result: ${formatFractionDisplay(summary.result)}`
  ];
}

function isImproperToMixedConversionQuestion(question, summary = null) {
  if (!question || !question.interactiveApp || question.interactiveApp.type !== "fractions") return false;

  const config = (question.interactiveApp && question.interactiveApp.config) || {};
  const operation = normalizeFractionOperation(config.operation);
  const answerFormat = String(config.answerFormat || "").trim().toLowerCase();
  const fractionB = config.fractionB || {};
  const bNumerator = Number.parseInt(fractionB.numerator, 10);
  const bDenominator = Number.parseInt(fractionB.denominator, 10);
  const hasZeroSecondFraction = Number.isFinite(bNumerator) && bNumerator === 0 && Number.isFinite(bDenominator) && bDenominator !== 0;

  const questionText = String((question && question.question) || "").trim().toLowerCase();
  const textSuggestsConversion = questionText.includes("improper fraction")
    && (questionText.includes("mixed number") || questionText.includes("mixed fraction"));

  const resolvedSummary = summary && !summary.error ? summary : buildFractionOperationSummary(config);
  const hasMixedResult = !!(resolvedSummary && !resolvedSummary.error && resolvedSummary.result && toMixedNumber(resolvedSummary.result));

  return hasMixedResult && answerFormat === "mixed" && (textSuggestsConversion || (operation === "add" && hasZeroSecondFraction));
}

function isMixedToImproperConversionQuestion(question, summary = null) {
  if (!question || !question.interactiveApp || question.interactiveApp.type !== "fractions") return false;
  const config = (question.interactiveApp && question.interactiveApp.config) || {};
  const resolvedSummary = summary && !summary.error
    ? summary
    : buildFractionOperationSummary(config, question.question || "");
  return !!(resolvedSummary && !resolvedSummary.error && resolvedSummary.conversionMode === "mixed-to-improper");
}

function wireFractionsPreviewInputs(preview) {
  if (!preview) return;
  const panel = preview.querySelector(".fraction-answer-panel");
  if (!panel) return;

  const correctN = Number.parseInt(panel.dataset.fractionCorrectNum, 10);
  const correctD = Number.parseInt(panel.dataset.fractionCorrectDen, 10);
  const correctMixed = toMixedNumber({ numerator: correctN, denominator: correctD });
  const canBeMixed = panel.dataset.fractionCanBeMixed === "true";

  // Step 1: improper fraction
  const step1 = panel.querySelector("[data-step='1']");
  const step2 = panel.querySelector("[data-step='2']");
  const checkBtn = step1 && step1.querySelector("[data-role='fraction-check-btn']");
  const feedback = step1 && step1.querySelector("[data-role='fraction-feedback']");
  const numInput = step1 && step1.querySelector("[data-role='fraction-answer-num']");
  const denInput = step1 && step1.querySelector("[data-role='fraction-answer-den']");

  if (checkBtn instanceof HTMLButtonElement && feedback instanceof HTMLElement &&
      numInput instanceof HTMLInputElement && denInput instanceof HTMLInputElement) {
    checkBtn.addEventListener("click", () => {
      const userN = Number.parseInt(numInput.value, 10);
      const userD = Number.parseInt(denInput.value, 10);
      if (!Number.isFinite(userN) || !Number.isFinite(userD) || userD === 0) {
        feedback.textContent = "Enter valid numerator and denominator (denominator cannot be 0).";
        return;
      }
      const isEquivalent = (userN * correctD) === (correctN * userD);
      const userSimple = simplifyFraction(userN, userD);
      const isSimplified = !!userSimple && userSimple.numerator === correctN && userSimple.denominator === correctD;
      if (isEquivalent && isSimplified) {
        feedback.textContent = "Correct!";
        if (canBeMixed && step2) {
          step2.style.display = "";
          const firstInput = step2.querySelector("input");
          if (firstInput) firstInput.focus();
        }
      } else if (isEquivalent) {
        feedback.textContent = `Equivalent, but simplify to ${correctN}/${correctD}.`;
      } else {
        feedback.textContent = "Not quite. Try again.";
      }
    });
  }

  // Step 2: mixed number (hidden until step 1 correct)
  if (canBeMixed && step2) {
    const mixedCheckBtn = step2.querySelector("[data-role='fraction-mixed-check-btn']");
    const mixedFeedback = step2.querySelector("[data-role='fraction-mixed-feedback']");
    const wholeInput = step2.querySelector("[data-role='fraction-answer-whole']");
    const mixedNumInput = step2.querySelector("[data-role='fraction-mixed-num']");
    const mixedDenInput = step2.querySelector("[data-role='fraction-mixed-den']");

    if (mixedCheckBtn instanceof HTMLButtonElement && mixedFeedback instanceof HTMLElement &&
        wholeInput instanceof HTMLInputElement && mixedNumInput instanceof HTMLInputElement && mixedDenInput instanceof HTMLInputElement) {
      const cw = correctMixed ? correctMixed.whole : 0;
      const cn = correctMixed ? correctMixed.numerator : 0;
      const cd = correctD;
      mixedCheckBtn.addEventListener("click", () => {
        const userW = Number.parseInt(wholeInput.value, 10);
        const userN = Number.parseInt(mixedNumInput.value, 10);
        const userD = Number.parseInt(mixedDenInput.value, 10);
        if (!Number.isFinite(userW) || !Number.isFinite(userN) || !Number.isFinite(userD) || userD === 0) {
          mixedFeedback.textContent = "Fill in all three boxes. Denominator cannot be 0.";
          return;
        }
        if (userN < 0 || userN >= userD) {
          mixedFeedback.textContent = "The fraction part must be proper (numerator less than denominator).";
          return;
        }
        const isCorrect = userW === cw && userN === cn && userD === cd;
        const userImproper = Math.abs(userW) * userD + userN;
        const userSign = userW < 0 ? -1 : 1;
        const isEquivalent = (userSign * userImproper * correctD) === (correctN * userD);
        if (isCorrect) {
          mixedFeedback.textContent = "Correct!";
        } else if (isEquivalent) {
          mixedFeedback.textContent = `Equivalent, but write as ${cw} and ${cn}/${cd}.`;
        } else {
          mixedFeedback.textContent = "Not quite. Try again.";
        }
      });
    }
  }
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
  const visualMode = String(config.visualMode || "").trim().toLowerCase();
  if (visualMode === "link-to-10") {
    const normalized = normalizeArithmeticLinkConfig(config);
    const isSubtraction = normalized.linkOperator === "-";
    return [
      `Mode: ${isSubtraction ? "Subtraction Link" : "Addition Link"}`,
      `Target ${isSubtraction ? "difference" : "sum"}: ${normalized.targetValue}`,
      `Column A: ${normalized.leftNumbers.join(", ")}`,
      `Column B: ${normalized.rightNumbers.join(", ")}`
    ];
  }

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

function buildNumberTracingDetailLines(app) {
  const config = app.config || {};
  const target = normalizeTracingTargetNumber(config.targetNumber);
  const prompt = String(config.prompt || "Trace the dotted number and say it aloud.").trim();
  const prepMode = Boolean(config.prepMode);
  const showQuantityDots = Boolean(config.showQuantityDots);
  return [
    `Target number: ${target}`,
    `Instruction: ${prompt}`,
    `Prep mode: ${prepMode ? "on" : "off"}`,
    `Quantity dots: ${showQuantityDots ? "on" : "off"}`
  ];
}

function updateInteractiveDetails(host, app) {
  if (!host || !app || !app.type) return;
  let lines = [];
  if (app.type === "number-tracing") {
    lines = buildNumberTracingDetailLines(app);
  } else if (app.type === "arithmetic") {
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

  host.querySelectorAll(".interactive-app-controls input, .interactive-app-controls select").forEach((input) => input.addEventListener("input", rerender));
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

function getMulTooltipEl() {
  let tip = document.getElementById("mul-hover-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "mul-hover-tip";
    tip.className = "mul-hover-tip";
    document.body.appendChild(tip);
  }
  return tip;
}

function positionMulTooltip(anchorEl, tip) {
  if (!anchorEl || !tip) return;
  const rect = anchorEl.getBoundingClientRect();
  const tipW = tip.offsetWidth || 100;
  const tipH = tip.offsetHeight || 32;
  const gap = 10;
  const minPad = 4;

  // Prefer placing on the right so it does not block the working column.
  let left = rect.right + gap;
  if (left + tipW > window.innerWidth - minPad) {
    left = rect.left - tipW - gap;
  }
  if (left < minPad) {
    left = minPad;
  }

  let top = rect.top + (rect.height / 2) - (tipH / 2);
  if (top < minPad) top = minPad;
  if (top + tipH > window.innerHeight - minPad) {
    top = window.innerHeight - tipH - minPad;
  }

  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function showMulTooltip(cell) {
  const aVal = cell.dataset.mulAVal;
  const bVal = cell.dataset.mulBVal;
  let text;
  if (aVal === "" || aVal === undefined || bVal === "" || bVal === undefined) {
    // trailing place-value zero — find bVal from bCellIdx
    const bCellIdx = Number(cell.dataset.mulBCell);
    if (bCellIdx < 0) return;
    text = "Place value zero (shift)";
  } else {
    const product = Number(aVal) * Number(bVal);
    text = `${aVal} × ${bVal} = ${product}`;
  }
  const tip = getMulTooltipEl();
  tip.textContent = text;
  tip.style.display = "block";
  positionMulTooltip(cell, tip);
}

function hideMulTooltip() {
  const tip = document.getElementById("mul-hover-tip");
  if (tip) tip.style.display = "none";
}

function wireMulSumHover(container) {
  if (!container) return;
  container.querySelectorAll(".arithmetic-sum-cell[data-sum-col]").forEach((sumCell) => {
    sumCell.style.cursor = "pointer";
    sumCell.addEventListener("mouseenter", () => {
      const col = Number(sumCell.dataset.sumCol);
      let addends;
      try { addends = JSON.parse(sumCell.dataset.sumAddends || "[]"); } catch (e) { addends = []; }
      const carryIn = Number(sumCell.dataset.sumCarry) || 0;

      // Circle all partial-product work cells in the same column
      container.querySelectorAll(`[data-col-idx="${col}"][data-mul-cell="work"]`).forEach((workWrap) => {
        const inp = workWrap.querySelector(".arithmetic-work-input");
        if (inp) inp.classList.add("arithmetic-mul-circle");
      });

      const resultInput = sumCell.querySelector(".arithmetic-work-input, .arithmetic-digit-input");
      if (resultInput) resultInput.classList.add("arithmetic-mul-circle");

      // Build tooltip: e.g. "7 + 4 = 11" or "7 + 4 + 1 (carry) = 12"
      let parts = [...addends.map(String)];
      if (carryIn > 0) parts.push(`${carryIn} (carry)`);
      const total = addends.reduce((a, b) => a + b, 0) + carryIn;
      const text = parts.length > 1 ? `${parts.join(" + ")} = ${total}` : `${total}`;

      const tip = getMulTooltipEl();
      tip.textContent = text;
      tip.style.display = "block";
      positionMulTooltip(sumCell, tip);
    });
    sumCell.addEventListener("mouseleave", () => {
      container.querySelectorAll(".arithmetic-mul-circle").forEach(el => el.classList.remove("arithmetic-mul-circle"));
      hideMulTooltip();
    });
  });
}

function applyMulCircle(cell, container, add) {
  if (add) {
    const aCellIdx = Number(cell.dataset.mulACell);
    const bCellIdx = Number(cell.dataset.mulBCell);
    if (aCellIdx >= 0) {
      const operandAEl = container.querySelector(".arithmetic-number-cells[data-operand='a']");
      if (operandAEl) {
        const cells = Array.from(operandAEl.querySelectorAll(".arithmetic-cell"));
        if (cells[aCellIdx]) cells[aCellIdx].classList.add("arithmetic-mul-circle");
      }
    }
    if (bCellIdx >= 0) {
      const operandBEl = container.querySelector(".arithmetic-number-cells[data-operand='b']");
      if (operandBEl) {
        const cells = Array.from(operandBEl.querySelectorAll(".arithmetic-cell"));
        if (cells[bCellIdx]) cells[bCellIdx].classList.add("arithmetic-mul-circle");
      }
    }
    const workInput = cell.querySelector(".arithmetic-work-input");
    if (workInput) workInput.classList.add("arithmetic-mul-circle");
  } else {
    container.querySelectorAll(".arithmetic-mul-circle").forEach(el => el.classList.remove("arithmetic-mul-circle"));
  }
}

function wireMulHighlighting(container) {
  if (!container) return;
  const workCells = container.querySelectorAll("[data-mul-cell='work']");
  workCells.forEach((cell) => {
    cell.style.cursor = "pointer";
    cell.addEventListener("click", (e) => {
      e.stopPropagation();
      const mulIdx = cell.dataset.mulIdx;
      const mulDigit = cell.dataset.mulDigit;
      if (mulIdx === undefined || mulDigit === undefined) return;

      // Clear previous highlights within this container
      container.querySelectorAll(".arithmetic-mul-highlight").forEach(el => {
        el.classList.remove("arithmetic-mul-highlight");
      });

      // Highlight multiplicand digit (operand A) - skip if trailing zero (mulIdx === "-1")
      if (String(mulIdx) !== "-1") {
        const operandAContainer = container.querySelector(".arithmetic-number-cells[data-operand='a']");
        if (operandAContainer) {
          const cells = Array.from(operandAContainer.querySelectorAll(".arithmetic-cell"));
          if (cells[Number(mulIdx)]) cells[Number(mulIdx)].classList.add("arithmetic-mul-highlight");
        }
      }

      // Highlight multiplier digit (operand B)
      const operandBContainer = container.querySelector(".arithmetic-number-cells[data-operand='b']");
      if (operandBContainer) {
        const cells = Array.from(operandBContainer.querySelectorAll(".arithmetic-cell"));
        if (cells[Number(mulDigit)]) cells[Number(mulDigit)].classList.add("arithmetic-mul-highlight");
      }

      // Highlight the clicked cell itself
      cell.classList.add("arithmetic-mul-highlight");
    });
    cell.addEventListener("mouseenter", () => { applyMulCircle(cell, container, true); showMulTooltip(cell); });
    cell.addEventListener("mouseleave", () => { applyMulCircle(cell, container, false); hideMulTooltip(); });
  });
  wireMulSumHover(container);
}

function mountInteractiveApp(host, app, options = {}) {
  if (!host || !app || !app.type) return;
  const { onTracingProgress } = options;

  if (app.type === "time") {
    host.innerHTML = `
      <div class="interactive-app-preview"></div>
    `;
    const preview = host.querySelector(".interactive-app-preview");
    updateInteractivePreview(preview, app);
    return;
  }

  if (app.type === "number-tracing") {
    host.innerHTML = `
      <div class="interactive-app-preview"></div>
      <div class="interactive-app-controls">
        <button class="btn secondary" type="button" data-role="tracing-clear">Clear Tracing</button>
      </div>
    `;

    const preview = host.querySelector(".interactive-app-preview");
    updateInteractivePreview(preview, app, {
      onTracingProgress
    });

    const clearBtn = host.querySelector("[data-role='tracing-clear']");
    if (clearBtn instanceof HTMLButtonElement) {
      clearBtn.addEventListener("click", () => {
        updateInteractivePreview(preview, app, {
          onTracingProgress
        });
      });
    }
    return;
  }

  if (app.type === "number-ordering") {
    host.innerHTML = `
      <div class="interactive-app-preview"></div>
    `;
    const preview = host.querySelector(".interactive-app-preview");
    updateInteractivePreview(preview, app, {
      onNumberOrderingChange: typeof options.onNumberOrderingChange === "function"
        ? options.onNumberOrderingChange
        : null
    });
    return;
  }

  if (app.type === "icon-count") {
    host.innerHTML = `
      <div class="interactive-app-preview"></div>
    `;
    const preview = host.querySelector(".interactive-app-preview");
    updateInteractivePreview(preview, app);
    return;
  }

  if (app.type === "arithmetic") {
    host.innerHTML = `
      <div class="interactive-app-preview"></div>
      <div class="interactive-app-details"></div>
    `;
    const preview = host.querySelector(".interactive-app-preview");
    updateInteractivePreview(preview, app);
    updateInteractiveDetails(host, app);
    wireMulHighlighting(preview);
    wireMulSumHover(preview);
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

  if (question.interactiveApp && question.interactiveApp.type === "time") {
    const config = question.interactiveApp.config || {};
    const mode = normalizeTimeMode(config.mode);
    const targetHour = normalizeTimeHour(config.hour);
    const targetMinute = normalizeTimeMinute(config.minute);
    const period = normalizeTimePeriod(config.period);

    if (mode === "analog") {
      const initial = buildInitialAnalogTime(targetHour, targetMinute);
      return `
        <div class="time-answer-panel" data-role="time-analog-panel" data-start-hour="${initial.hour}" data-start-minute="${initial.minute}">
          <div class="time-analog-face" data-role="time-live-clock" aria-hidden="true">
            ${buildTimeClockNumbersMarkup()}
            <span class="time-center-dot"></span>
            <span class="time-hand hour is-draggable" data-role="time-hour-hand" data-hand="hour"></span>
            <span class="time-hand minute is-draggable" data-role="time-minute-hand" data-hand="minute"></span>
          </div>
          <p class="helper-text">Drag the clock hands to set the time.</p>
          <p class="helper-text">Your selected time: <strong data-role="time-live-label">${escapeHtml(formatTimeDisplay(initial.hour, initial.minute, period))}</strong></p>
        </div>
      `;
    }

    if (mode === "analog-to-digital") {
      const type = question.resultType === "checkbox" ? "checkbox" : "radio";
      const inputName = question.resultType === "checkbox" ? "activeQuestionCheck" : "activeQuestion";
      const options = question.options || [];
      return `
        <div class="time-answer-panel">
          ${buildTimeClockMarkup(config, { withReadout: false })}
          <div class="options-list">
            ${options.map((option, optionIndex) => `
              <label class="option-item">
                <input type="${type}" name="${inputName}" value="${escapeHtml(option)}" data-index="${optionIndex}" />
                <span>${escapeHtml(option)}</span>
              </label>
            `).join("")}
          </div>
        </div>
      `;
    }

    return `
      <div class="time-answer-panel">
        <div class="time-digital-canvas" data-role="time-digital-canvas" aria-live="polite">
          <input
            class="time-digital-input"
            data-role="time-digital-hour"
            type="text"
            inputmode="numeric"
            maxlength="2"
            placeholder="00"
            aria-label="Hour"
            autocomplete="off"
          />
          <span class="time-digital-colon" aria-hidden="true">:</span>
          <input
            class="time-digital-input"
            data-role="time-digital-minute"
            type="text"
            inputmode="numeric"
            maxlength="2"
            placeholder="00"
            aria-label="Minute"
            autocomplete="off"
          />
          <select class="time-digital-period" data-role="time-digital-period" aria-label="AM or PM">
            <option value="">--</option>
            <option value="AM">AM</option>
            <option value="PM">PM</option>
          </select>
        </div>
        <p class="helper-text">${(() => {
          const challenge = String((config && config.digitalChallenge) || "words-to-12h").trim().toLowerCase();
          if (challenge === "12h-to-24h") return "Enter answer in 24-hour format (HH:MM).";
          if (challenge === "24h-to-12h") return "Enter answer in 12-hour format (H:MM AM/PM).";
          return "Enter the time in HH:MM format.";
        })()}</p>
      </div>
    `;
  }

  if (question.interactiveApp && question.interactiveApp.type === "arithmetic") {
    const config = question.interactiveApp.config || {};
    const visualMode = String(config.visualMode || "").trim().toLowerCase();
    return buildArithmeticWorkspaceMarkup(config, {
      readOnly: false,
      revealAnswer: false,
      questionText: visualMode === "objects" ? "" : (question.question || "")
    });
  }

  if (question.interactiveApp && question.interactiveApp.type === "fractions") {
    const summary = buildFractionOperationSummary((question.interactiveApp && question.interactiveApp.config) || {}, question.question || "");
    const mixed = summary && !summary.error ? toMixedNumber(summary.result) : null;
    const canBeMixed = !!mixed && mixed.numerator > 0;
    const conversionOnlyMixed = isImproperToMixedConversionQuestion(question, summary);
    const conversionToImproper = isMixedToImproperConversionQuestion(question, summary);
    const shouldShowMixedFollowUp = canBeMixed && !conversionOnlyMixed && !conversionToImproper;

    if (conversionOnlyMixed && canBeMixed) {
      return `
        <div class="fraction-answer-panel mixed-only">
          <div class="fraction-step-block" data-role="fraction-mixed-stage">
            <p class="fraction-steps-heading">Enter Mixed Fraction</p>
            <div class="fraction-input-widget mixed-input">
              <input type="number" step="1" placeholder="Whole" data-role="fraction-answer-whole" aria-label="Whole number" />
              <span class="mixed-input-and">and</span>
              <div class="fraction-input-stacked">
                <input type="number" step="1" placeholder="Num" data-role="fraction-mixed-num" aria-label="Mixed numerator" />
                <div class="fraction-input-line"></div>
                <input type="number" step="1" placeholder="Den" data-role="fraction-mixed-den" aria-label="Mixed denominator" />
              </div>
            </div>
            <p class="helper-text" data-role="fraction-mixed-feedback"></p>
          </div>
        </div>
      `;
    }

    return `
      <div class="fraction-answer-panel two-stage">
        <div class="fraction-step-block">
          <div class="fraction-input-widget">
            <input type="number" step="1" placeholder="?" data-role="fraction-answer-num" aria-label="Numerator" />
            <div class="fraction-input-line"></div>
            <input type="number" step="1" placeholder="?" data-role="fraction-answer-den" aria-label="Denominator" />
          </div>
        </div>
        ${shouldShowMixedFollowUp ? `
          <div class="fraction-step-block hidden" data-role="fraction-mixed-stage">
            <p class="fraction-steps-heading">Mixed Fraction (if required)</p>
            <div class="fraction-input-widget mixed-input">
              <input type="number" step="1" placeholder="Whole" data-role="fraction-answer-whole" aria-label="Whole number" />
              <span class="mixed-input-and">and</span>
              <div class="fraction-input-stacked">
                <input type="number" step="1" placeholder="Num" data-role="fraction-mixed-num" aria-label="Mixed numerator" />
                <div class="fraction-input-line"></div>
                <input type="number" step="1" placeholder="Den" data-role="fraction-mixed-den" aria-label="Mixed denominator" />
              </div>
              <button type="button" class="btn secondary small" data-role="fraction-mixed-check-btn">Check mixed</button>
            </div>
            <p class="helper-text" data-role="fraction-mixed-feedback"></p>
          </div>
        ` : ""}
      </div>
    `;
  }

  if (question.interactiveApp && question.interactiveApp.type === "number-tracing") {
    return `
      <div class="interactive-app-host" data-role="number-tracing-host"></div>
      <p class="number-tracing-status" data-role="tracing-status" aria-live="polite">Trace status: not complete</p>
    `;
  }

  if (question.interactiveApp && question.interactiveApp.type === "number-ordering") {
    return `
      <div class="interactive-app-host" data-role="number-ordering-host"></div>
      <input type="hidden" data-role="number-ordering-answer" value="" />
    `;
  }

  if (question.interactiveApp && question.interactiveApp.type === "icon-count") {
    return `
      <div class="interactive-app-host" data-role="icon-count-host"></div>
      <div class="short-answer-box">
        <label for="shortAnswerInput">Your answer</label>
        <input id="shortAnswerInput" type="text" inputmode="numeric" placeholder="Type your answer" autocomplete="off" />
      </div>
    `;
  }

  // Interactive apps should only appear in the solution modal, not in the main question
  // So we skip them here and show the regular answer input instead

  if (
    question.resultType === "short-answer"
    && question.interactiveApp
    && question.interactiveApp.type === "matrix"
  ) {
    const matrixPrompt = String(question.question || "").trim().toLowerCase();
    const asksForDimensions = matrixPrompt.includes("dimensions of matrix a");
    if (asksForDimensions) {
      return `
        <div class="short-answer-box matrix-dimension-box">
          <div class="matrix-dimension-input">
            <input type="number" min="1" step="1" inputmode="numeric" data-role="matrix-dim-rows" aria-label="Matrix rows" autocomplete="off" />
            <span class="matrix-dimension-sep">x</span>
            <input type="number" min="1" step="1" inputmode="numeric" data-role="matrix-dim-cols" aria-label="Matrix columns" autocomplete="off" />
          </div>
        </div>
      `;
    }

    const matrixConfig = question.interactiveApp.config && typeof question.interactiveApp.config === "object"
      ? question.interactiveApp.config
      : {};
    const operation = normalizeMatrixOperation(matrixConfig.operation);
    const placeholder = operation === "determinant" ? "Example: -12" : "Example: 1,2;3,4";

    return `
      <div class="short-answer-box">
        <label for="matrixResultInput">Your answer</label>
        <input id="matrixResultInput" type="text" placeholder="${escapeHtml(placeholder)}" autocomplete="off" />
      </div>
    `;
  }

  if (question.resultType === "short-answer" || question.resultType === "plot") {
    return `
      <div class="short-answer-box">
        <label for="shortAnswerInput">Your answer</label>
        <input id="shortAnswerInput" type="text" placeholder="Type your answer" autocomplete="off" />
      </div>
    `;
  }

  if (question.resultType === "date") {
    return `
      <div class="short-answer-box date-answer-box">
        <label>Date answer (DD/MM/YYYY)</label>
        <div class="date-answer-grid">
          <input type="text" inputmode="numeric" maxlength="2" placeholder="DD" data-role="date-day" aria-label="Day" autocomplete="off" />
          <span class="date-answer-sep" aria-hidden="true">/</span>
          <input type="text" inputmode="numeric" maxlength="2" placeholder="MM" data-role="date-month" aria-label="Month" autocomplete="off" />
          <span class="date-answer-sep" aria-hidden="true">/</span>
          <input type="text" inputmode="numeric" maxlength="4" placeholder="YYYY" data-role="date-year" aria-label="Year" autocomplete="off" />
        </div>
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
  if (question.resultType === "short-answer" || question.resultType === "plot" || question.resultType === "date") return;

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
  return Array.from(scope.querySelectorAll("#shortAnswerInput, #matrixResultInput, .arithmetic-single-input, .arithmetic-digit-input, [data-role='fraction-answer-num'], [data-role='fraction-answer-den'], [data-role='fraction-answer-whole'], [data-role='fraction-mixed-num'], [data-role='fraction-mixed-den'], [data-role='matrix-dim-rows'], [data-role='matrix-dim-cols'], [data-role='time-digital-hour'], [data-role='time-digital-minute'], [data-role='date-day'], [data-role='date-month'], [data-role='date-year']"))
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

function wireFractionMixedAnswerInput(question) {
  const container = document.getElementById("quizContainer");
  if (!container || !question || !question.interactiveApp || question.interactiveApp.type !== "fractions") return;

  const mixedStage = container.querySelector("[data-role='fraction-mixed-stage']");
  if (!mixedStage) return;
  mixedStage.dataset.mixedChecked = "false";

  const summary = buildFractionOperationSummary((question.interactiveApp && question.interactiveApp.config) || {});
  if (!summary || summary.error || !summary.result) return;
  const mixed = toMixedNumber(summary.result);
  if (!mixed || mixed.numerator <= 0) return;

  const checkBtn = mixedStage.querySelector("[data-role='fraction-mixed-check-btn']");
  const feedback = mixedStage.querySelector("[data-role='fraction-mixed-feedback']");
  const wholeInput = mixedStage.querySelector("[data-role='fraction-answer-whole']");
  const numInput = mixedStage.querySelector("[data-role='fraction-mixed-num']");
  const denInput = mixedStage.querySelector("[data-role='fraction-mixed-den']");

  if (!(checkBtn instanceof HTMLButtonElement)
    || !(feedback instanceof HTMLElement)
    || !(wholeInput instanceof HTMLInputElement)
    || !(numInput instanceof HTMLInputElement)
    || !(denInput instanceof HTMLInputElement)) {
    return;
  }

  checkBtn.addEventListener("click", () => {
    const userWhole = Number.parseInt(wholeInput.value, 10);
    const userNum = Number.parseInt(numInput.value, 10);
    const userDen = Number.parseInt(denInput.value, 10);

    if (!Number.isFinite(userWhole) || !Number.isFinite(userNum) || !Number.isFinite(userDen) || userDen === 0) {
      feedback.textContent = "Enter a valid mixed fraction.";
      return;
    }
    if (userNum < 0) {
      feedback.textContent = "Numerator must be 0 or greater.";
      return;
    }

    const expectedDen = Math.abs(mixed.denominator);
    const isCorrect = userWhole === mixed.whole && userNum === mixed.numerator && Math.abs(userDen) === expectedDen;
    mixedStage.dataset.mixedChecked = isCorrect ? "true" : "false";
    feedback.textContent = isCorrect
      ? "Great! Mixed fraction is correct."
      : `Not quite. Try ${mixed.whole} and ${mixed.numerator}/${expectedDen}.`;
  });
}

function wireTimeAnalogAnswerInput(question) {
  if (!question || !question.interactiveApp || question.interactiveApp.type !== "time") return;
  const config = question.interactiveApp.config || {};
  if (normalizeTimeMode(config.mode) !== "analog") return;

  const container = document.getElementById("quizContainer");
  if (!container) return;

  const panel = container.querySelector("[data-role='time-analog-panel']");
  const clock = panel && panel.querySelector("[data-role='time-live-clock']");
  const hourHand = panel && panel.querySelector("[data-role='time-hour-hand']");
  const minuteHand = panel && panel.querySelector("[data-role='time-minute-hand']");
  const label = panel && panel.querySelector("[data-role='time-live-label']");
  if (!(clock instanceof HTMLElement)
    || !(hourHand instanceof HTMLElement)
    || !(minuteHand instanceof HTMLElement)
    || !(label instanceof HTMLElement)) {
    return;
  }

  const period = normalizeTimePeriod(config.period);
  const startHour = panel instanceof HTMLElement ? normalizeTimeHour(panel.dataset.startHour) : normalizeTimeHour(config.hour);
  const startMinute = panel instanceof HTMLElement ? normalizeTimeMinute(panel.dataset.startMinute) : normalizeTimeMinute(config.minute);
  let hour = startHour;
  let minute = startMinute;
  let activeHand = "";
  let lastDraggedMinute = null;

  const sync = () => {
    const minuteAngle = minute * 6;
    const hourAngle = (hour % 12) * 30;
    hourHand.style.transform = `translate(-50%, -100%) rotate(${hourAngle}deg)`;
    minuteHand.style.transform = `translate(-50%, -100%) rotate(${minuteAngle}deg)`;
    label.textContent = formatTimeDisplay(hour, minute, period);
    panel.dataset.timeHour = String(hour);
    panel.dataset.timeMinute = String(minute);
  };

  const pointerToAngle = (event) => {
    const rect = clock.getBoundingClientRect();
    const cx = rect.left + (rect.width / 2);
    const cy = rect.top + (rect.height / 2);
    const dx = event.clientX - cx;
    const dy = event.clientY - cy;
    const radians = Math.atan2(dy, dx);
    return (radians * 180 / Math.PI + 90 + 360) % 360;
  };

  const updateFromPointer = (event) => {
    if (!activeHand) return;
    const angle = pointerToAngle(event);
    if (activeHand === "minute") {
      const nextMinute = Math.round(angle / 6) % 60;
      if (Number.isInteger(lastDraggedMinute)) {
        const delta = nextMinute - lastDraggedMinute;
        if (delta <= -30) {
          hour = hour === 12 ? 1 : hour + 1;
        } else if (delta >= 30) {
          hour = hour === 1 ? 12 : hour - 1;
        }
      }
      minute = nextMinute;
      lastDraggedMinute = nextMinute;
    } else if (activeHand === "hour") {
      const roundedHour = Math.round(angle / 30) % 12;
      hour = roundedHour === 0 ? 12 : roundedHour;
      lastDraggedMinute = null;
    }
    sync();
  };

  const beginDrag = (hand, event) => {
    event.preventDefault();
    activeHand = hand;
    if (hand === "minute") {
      lastDraggedMinute = minute;
    } else {
      lastDraggedMinute = null;
    }
    updateFromPointer(event);
  };

  hourHand.addEventListener("pointerdown", (event) => beginDrag("hour", event));
  minuteHand.addEventListener("pointerdown", (event) => beginDrag("minute", event));

  window.addEventListener("pointermove", updateFromPointer);
  window.addEventListener("pointerup", () => {
    activeHand = "";
    lastDraggedMinute = null;
  });

  sync();
}

function wireTimeDigitalAnswerInput(question) {
  if (!question || !question.interactiveApp || question.interactiveApp.type !== "time") return;
  const config = question.interactiveApp.config || {};
  if (normalizeTimeMode(config.mode) !== "digital") return;

  const container = document.getElementById("quizContainer");
  if (!container) return;

  const hourInput = container.querySelector("[data-role='time-digital-hour']");
  const minuteInput = container.querySelector("[data-role='time-digital-minute']");
  const periodSelect = container.querySelector("[data-role='time-digital-period']");
  if (!(hourInput instanceof HTMLInputElement)
    || !(minuteInput instanceof HTMLInputElement)) {
    return;
  }

  const challenge = String(config.digitalChallenge || "words-to-12h").trim().toLowerCase();
  const uses24HourInput = challenge === "12h-to-24h";
  const requiresPeriod = challenge === "24h-to-12h";
  const allows24HourInput = uses24HourInput || !requiresPeriod;
  const sanitizeDigits = (input) => {
    input.value = String(input.value || "").replace(/\D+/g, "").slice(0, 2);
  };

  const selectAll = (input) => {
    if (!(input instanceof HTMLInputElement)) return;
    try {
      input.setSelectionRange(0, input.value.length);
    } catch (_error) {
      // Some mobile browsers may not support setSelectionRange for all states.
    }
  };

  const enableOverwriteOnClick = (input) => {
    if (!(input instanceof HTMLInputElement)) return;
    input.addEventListener("focus", () => {
      requestAnimationFrame(() => selectAll(input));
    });
    input.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" || event.pointerType === "pen") {
        event.preventDefault();
        input.focus();
        selectAll(input);
      }
    });
  };

  const normalizeBounds = () => {
    const rawHour = hourInput.value === "" ? 0 : Number.parseInt(hourInput.value, 10);
    const rawMinute = minuteInput.value === "" ? 0 : Number.parseInt(minuteInput.value, 10);
    if (allows24HourInput) {
      hourInput.value = String(Math.max(0, Math.min(23, Number.isFinite(rawHour) ? rawHour : 0))).padStart(2, "0");
      minuteInput.value = String(Math.max(0, Math.min(59, Number.isFinite(rawMinute) ? rawMinute : 0))).padStart(2, "0");
    } else {
      hourInput.value = String(Math.max(1, Math.min(12, Number.isFinite(rawHour) && rawHour !== 0 ? rawHour : 12))).padStart(2, "0");
      minuteInput.value = String(Math.max(0, Math.min(59, Number.isFinite(rawMinute) ? rawMinute : 0))).padStart(2, "0");
    }
  };

  const updateModeUi = () => {
    if (periodSelect instanceof HTMLSelectElement) {
      periodSelect.classList.toggle("hidden", !requiresPeriod);
      if (!requiresPeriod) {
        periodSelect.value = "";
      } else if (!periodSelect.value) {
        periodSelect.value = "AM";
      }
    }

  };

  const handleInput = (event) => {
    if (event && event.target instanceof HTMLInputElement) {
      sanitizeDigits(event.target);
      if (event.target.value.length === 2) {
        if (event.target === hourInput) {
          minuteInput.focus();
          minuteInput.select();
        } else if (event.target === minuteInput && periodSelect instanceof HTMLSelectElement && !periodSelect.classList.contains("hidden")) {
          periodSelect.focus();
        }
      }
    }
  };

  hourInput.addEventListener("input", handleInput);
  minuteInput.addEventListener("input", handleInput);
  hourInput.addEventListener("keydown", (event) => {
    if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      minuteInput.focus();
      selectAll(minuteInput);
    }
  });
  minuteInput.addEventListener("keydown", (event) => {
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      hourInput.focus();
      selectAll(hourInput);
      return;
    }
    if (event.key === "Tab" && !event.shiftKey && periodSelect instanceof HTMLSelectElement && !periodSelect.classList.contains("hidden")) {
      event.preventDefault();
      periodSelect.focus();
    }
  });
  hourInput.addEventListener("blur", normalizeBounds);
  minuteInput.addEventListener("blur", normalizeBounds);
  enableOverwriteOnClick(hourInput);
  enableOverwriteOnClick(minuteInput);
  if (periodSelect instanceof HTMLSelectElement) {
    periodSelect.addEventListener("change", () => {
      if (!periodSelect.value) periodSelect.value = "AM";
    });
  }

  updateModeUi();
  if (!hourInput.value) hourInput.value = "00";
  if (!minuteInput.value) minuteInput.value = "00";
  normalizeBounds();
}

function renderQuestion() {
  setViewerProgressChromeVisible(true);
  const question = quizData.questions[currentIndex];
  const quizContainer = document.getElementById("quizContainer");
  quizContainer.classList.remove("prestart-mode");
  const resultBox = document.getElementById("resultBox");
  const nextBtn = document.getElementById("nextQuestionBtn");
  const showSolutionBtn = document.getElementById("showSolutionBtn");
  const checkBtn = document.getElementById("checkAnswerBtn");

  answerChecked = false;
  solutionShownForCurrentQuestion = false;
  if (isNumberTracingQuestion(question)) {
    numberTracingCompletionByQuestion[currentIndex] = false;
  }
  resultBox.textContent = "";
  resultBox.className = "";
  nextBtn.disabled = true;
  showSolutionBtn.classList.add("hidden");
  nextBtn.textContent = currentIndex === quizData.questions.length - 1 ? "Finish Quiz" : "Next Question";
  closeSolutionModal();

  if (checkBtn instanceof HTMLButtonElement) {
    checkBtn.style.display = question && question.interactiveApp && question.interactiveApp.type === "number-tracing"
      ? "none"
      : "inline-block";
  }

  const imageMarkup = question.image
    ? `<img class="question-image" src="${escapeHtml(question.image)}" alt="Question visual" />`
    : "";

  let promptText = String(question.question || "").trim();

  let matrixQuestionMarkup = "";
  if (isIntroductionQuestion(question)) {
    quizContainer.innerHTML = buildIntroductionCardMarkup(question);
    wireIntroductionCardUI(quizContainer);
    wireAnswerInputVisualState(quizContainer);
    renderNotesPanel(question);
    updateHeader();
    return;
  }

  if (question.interactiveApp && question.interactiveApp.type === "matrix") {
    const matrixConfig = question.interactiveApp.config && typeof question.interactiveApp.config === "object"
      ? question.interactiveApp.config
      : {};
    const operation = normalizeMatrixOperation(matrixConfig.operation);
    const matrixA = sanitizeMatrix(matrixConfig.matrixA);
    const matrixB = sanitizeMatrix(matrixConfig.matrixB);
    const labels = { add: "A + B", subtract: "A - B", multiply: "A x B", determinant: "det(A)", transpose: "A^T" };
    promptText = String(question.question || "").split(/\nmatrix a:/i)[0].trim() || promptText;

    if (matrixIsRectangular(matrixA)) {
      const showMatrixB = (operation === "add" || operation === "subtract" || operation === "multiply") && matrixIsRectangular(matrixB);
      matrixQuestionMarkup = `
        <div class="matrix-question-block">
          <p class="helper-text">Operation: ${escapeHtml(labels[operation] || "Matrix")}</p>
          ${buildMatrixTableMarkup(matrixA, "Matrix A", { showDimensions: false })}
          ${showMatrixB ? buildMatrixTableMarkup(matrixB, "Matrix B", { showDimensions: false }) : ""}
        </div>
      `;
    }
  }

  if (question.interactiveApp && question.interactiveApp.type === "arithmetic") {
    const arithmeticConfig = question.interactiveApp.config || {};
    const visualMode = String(arithmeticConfig.visualMode || "").trim().toLowerCase();
    if (visualMode === "objects") {
      promptText = buildProfessionalVisualArithmeticPrompt(arithmeticConfig, promptText) || promptText;
    }
  }

  quizContainer.innerHTML = `
    <div class="question-card viewer-question">
      <p class="question-label">Question ${currentIndex + 1}</p>
      <h2>${renderQuestionText(promptText)}</h2>
      ${matrixQuestionMarkup}
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
  if (question.interactiveApp && question.interactiveApp.type === "fractions") {
    wireFractionMixedAnswerInput(question);
  }
  if (question.interactiveApp && question.interactiveApp.type === "time") {
    wireTimeAnalogAnswerInput(question);
    wireTimeDigitalAnswerInput(question);
  }
  if (question.interactiveApp && question.interactiveApp.type === "number-tracing") {
    const tracingHost = quizContainer.querySelector("[data-role='number-tracing-host']");
    const tracingStatus = quizContainer.querySelector("[data-role='tracing-status']");
    const tracingConfig = (question.interactiveApp && question.interactiveApp.config) || {};
    const minDotsPercent = Number.isFinite(Number(tracingConfig.minDotsPercent))
      ? Math.max(1, Math.min(100, Number(tracingConfig.minDotsPercent)))
      : 95;
    const updateTracingStatus = (isComplete, progress = {}) => {
      if (!(tracingStatus instanceof HTMLElement)) return;
      const coveredGuideDots = Number.isFinite(Number(progress.coveredGuideDots)) ? Number(progress.coveredGuideDots) : 0;
      const totalGuideDots = Number.isFinite(Number(progress.totalGuideDots)) ? Number(progress.totalGuideDots) : 0;
      const requiredDots = Number.isFinite(Number(progress.requiredDots))
        ? Number(progress.requiredDots)
        : Math.max(1, Math.ceil(totalGuideDots * (minDotsPercent / 100)));
      const completionPercent = totalGuideDots > 0
        ? Math.round((Math.min(coveredGuideDots, totalGuideDots) / totalGuideDots) * 100)
        : 0;
      if (isComplete) {
        tracingStatus.textContent = `Good job! Tracing complete. Completion: ${completionPercent}%.`;
      } else {
        tracingStatus.textContent = `Trace status: not complete. Completion: ${completionPercent}%.`;
      }
      tracingStatus.classList.toggle("is-complete", Boolean(isComplete));
    };

    updateTracingStatus(hasCompletedTracingForCurrentQuestion(), {
      strokeCount: 0
    });

    if (tracingHost instanceof HTMLElement) {
      mountInteractiveApp(tracingHost, cloneInteractiveApp(question.interactiveApp), {
        onTracingProgress: (isComplete, _traceMoves, progress) => {
          numberTracingCompletionByQuestion[currentIndex] = Boolean(numberTracingCompletionByQuestion[currentIndex] || isComplete);
          const completed = hasCompletedTracingForCurrentQuestion();
          updateTracingStatus(completed, progress);
          if (completed && !answerChecked) {
            checkAnswer();
          }
          updateNextQuestionButtonState();
        }
      });
    }
  }
  if (question.interactiveApp && question.interactiveApp.type === "number-ordering") {
    const orderingHost = quizContainer.querySelector("[data-role='number-ordering-host']");
    const orderingAnswerInput = quizContainer.querySelector("[data-role='number-ordering-answer']");
    if (orderingHost instanceof HTMLElement) {
      mountInteractiveApp(orderingHost, cloneInteractiveApp(question.interactiveApp), {
        onNumberOrderingChange: (order) => {
          if (!(orderingAnswerInput instanceof HTMLInputElement)) return;
          const values = Array.isArray(order)
            ? order.map((item) => Number.parseInt(item, 10)).filter((item) => Number.isInteger(item))
            : [];
          orderingAnswerInput.value = values.join(", ");
        }
      });
      if (orderingAnswerInput instanceof HTMLInputElement) {
        const initialOrder = getNumberOrderingConfig(question.interactiveApp).cards;
        orderingAnswerInput.value = initialOrder.join(", ");
      }
    }
  }
  if (question.interactiveApp && question.interactiveApp.type === "icon-count") {
    const iconCountHost = quizContainer.querySelector("[data-role='icon-count-host']");
    if (iconCountHost instanceof HTMLElement) {
      mountInteractiveApp(iconCountHost, cloneInteractiveApp(question.interactiveApp));
    }
  }

  wireAnswerInputVisualState(quizContainer);

  renderNotesPanel(question);
  updateHeader();
}

function collectUserAnswer(question) {
  if (isIntroductionQuestion(question)) {
    const termsInput = document.getElementById("introAcceptTerms");
    const supportInput = document.getElementById("introAcknowledgeSupport");
    return {
      acceptedTerms: Boolean(termsInput && termsInput.checked),
      acknowledgedSupport: supportInput ? Boolean(supportInput.checked) : true
    };
  }

  if (isNumberTracingQuestion(question)) {
    return hasCompletedTracingForCurrentQuestion()
      ? String(question && question.correctAnswer != null ? question.correctAnswer : "traced")
      : "";
  }

  if (question.interactiveApp && question.interactiveApp.type === "number-ordering") {
    const container = document.getElementById("quizContainer");
    const answerInput = container && container.querySelector("[data-role='number-ordering-answer']");
    const raw = answerInput instanceof HTMLInputElement
      ? String(answerInput.value || "")
      : "";
    return parseNumberOrderingValues(raw);
  }

  if (question.interactiveApp && question.interactiveApp.type === "arithmetic") {
    return collectArithmeticWorkspaceAnswer(document.getElementById("quizContainer"));
  }
  if (question.interactiveApp && question.interactiveApp.type === "time") {
    const config = question.interactiveApp.config || {};
    const mode = normalizeTimeMode(config.mode);
    const period = normalizeTimePeriod(config.period);
    if (mode === "analog") {
      const container = document.getElementById("quizContainer");
      const panel = container && container.querySelector("[data-role='time-analog-panel']");
      const hour = panel instanceof HTMLElement ? normalizeTimeHour(panel.dataset.timeHour) : normalizeTimeHour(config.hour);
      const minute = panel instanceof HTMLElement ? normalizeTimeMinute(panel.dataset.timeMinute) : normalizeTimeMinute(config.minute);
      return formatTimeDisplay(hour, minute, period);
    }
    if (mode === "digital") {
      const container = document.getElementById("quizContainer");
      const hourInput = container && container.querySelector("[data-role='time-digital-hour']");
      const minuteInput = container && container.querySelector("[data-role='time-digital-minute']");
      const periodSelect = container && container.querySelector("[data-role='time-digital-period']");
      const hh = hourInput instanceof HTMLInputElement ? String(hourInput.value || "").trim() : "";
      const mm = minuteInput instanceof HTMLInputElement ? String(minuteInput.value || "").trim() : "";
      const pp = periodSelect instanceof HTMLSelectElement ? String(periodSelect.value || "").trim() : "";
      if (!hh || !mm) return "";
      return pp ? `${hh}:${mm} ${pp}` : `${hh}:${mm}`;
    }
  }
  if (question.interactiveApp && question.interactiveApp.type === "cartesian-plane-plot") {
    return cartesianPlotUserPoints.slice();
  }
  if (question.interactiveApp && question.interactiveApp.type === "fractions") {
    const container = document.getElementById("quizContainer");
    const numInput = container && container.querySelector("[data-role='fraction-answer-num']");
    const denInput = container && container.querySelector("[data-role='fraction-answer-den']");
    const wholeInput = container && container.querySelector("[data-role='fraction-answer-whole']");
    const mixedNumInput = container && container.querySelector("[data-role='fraction-mixed-num']");
    const mixedDenInput = container && container.querySelector("[data-role='fraction-mixed-den']");

    const wholeValue = wholeInput ? String(wholeInput.value).trim() : "";
    const mixedNumValue = mixedNumInput ? String(mixedNumInput.value).trim() : "";
    const mixedDenValue = mixedDenInput ? String(mixedDenInput.value).trim() : "";
    if (mixedNumValue !== "" && mixedDenValue !== "") {
      const normalizedWhole = wholeValue !== "" ? wholeValue : "0";
      return `${normalizedWhole} and ${mixedNumValue}/${mixedDenValue}`;
    }

    const n = numInput ? String(numInput.value).trim() : "";
    const d = denInput ? String(denInput.value).trim() : "";
    if (n === "" || d === "") return "";
    return d === "1" ? n : `${n}/${d}`;
  }
  if (
    question.resultType === "short-answer"
    && question.interactiveApp
    && question.interactiveApp.type === "matrix"
  ) {
    const matrixPrompt = String(question.question || "").trim().toLowerCase();
    const asksForDimensions = matrixPrompt.includes("dimensions of matrix a");
    if (!asksForDimensions) {
      const matrixInput = document.getElementById("matrixResultInput");
      return matrixInput ? String(matrixInput.value || "").trim() : "";
    }

    const container = document.getElementById("quizContainer");
    const rowsInput = container && container.querySelector("[data-role='matrix-dim-rows']");
    const colsInput = container && container.querySelector("[data-role='matrix-dim-cols']");
    const rows = rowsInput ? String(rowsInput.value || "").trim() : "";
    const cols = colsInput ? String(colsInput.value || "").trim() : "";
    if (!rows || !cols) return "";
    return `${rows} x ${cols}`;
  }
  if (question.resultType === "date") {
    const container = document.getElementById("quizContainer");
    const dayInput = container && container.querySelector("[data-role='date-day']");
    const monthInput = container && container.querySelector("[data-role='date-month']");
    const yearInput = container && container.querySelector("[data-role='date-year']");
    const day = dayInput ? String(dayInput.value || "").trim() : "";
    const month = monthInput ? String(monthInput.value || "").trim() : "";
    const year = yearInput ? String(yearInput.value || "").trim() : "";
    if (!day || !month || !year) return "";
    return `${day.padStart(2, "0")}/${month.padStart(2, "0")}/${year.padStart(4, "0")}`;
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

function parseAnswerFraction(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  const mixedMatch = raw.match(/^(-?\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (mixedMatch) {
    const whole = Number.parseInt(mixedMatch[1], 10);
    const numerator = Number.parseInt(mixedMatch[2], 10);
    const denominator = Number.parseInt(mixedMatch[3], 10);
    if (!Number.isFinite(whole) || !Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
    if (numerator < 0) return null;
    const sign = whole < 0 ? -1 : 1;
    const absWhole = Math.abs(whole);
    return {
      n: sign * (absWhole * Math.abs(denominator) + numerator),
      d: Math.abs(denominator)
    };
  }

  const mixedAndMatch = raw.match(/^(-?\d+)\s+and\s+(\d+)\s*\/\s*(\d+)$/i);
  if (mixedAndMatch) {
    const whole = Number.parseInt(mixedAndMatch[1], 10);
    const numerator = Number.parseInt(mixedAndMatch[2], 10);
    const denominator = Number.parseInt(mixedAndMatch[3], 10);
    if (!Number.isFinite(whole) || !Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
    if (numerator < 0) return null;
    const sign = whole < 0 ? -1 : 1;
    const absWhole = Math.abs(whole);
    return {
      n: sign * (absWhole * Math.abs(denominator) + numerator),
      d: Math.abs(denominator)
    };
  }

  const fractionMatch = raw.match(/^(-?\d+)\s*\/\s*(-?\d+)$/);
  if (fractionMatch) {
    const n = Number.parseInt(fractionMatch[1], 10);
    const dRaw = Number.parseInt(fractionMatch[2], 10);
    if (!Number.isFinite(n) || !Number.isFinite(dRaw) || dRaw === 0) return null;
    const sign = dRaw < 0 ? -1 : 1;
    return { n: n * sign, d: Math.abs(dRaw) };
  }

  if (/^-?\d+$/.test(raw)) {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return null;
    return { n, d: 1 };
  }

  return null;
}

function answersMatch(question, userAnswer) {
  if (isIntroductionQuestion(question)) {
    const answerObj = userAnswer && typeof userAnswer === "object" ? userAnswer : {};
    return Boolean(answerObj.acceptedTerms) && Boolean(answerObj.acknowledgedSupport);
  }

  if (isNumberTracingQuestion(question)) {
    return hasCompletedTracingForCurrentQuestion();
  }

  if (question.interactiveApp && question.interactiveApp.type === "number-ordering") {
    const expectedFromConfig = getNumberOrderingConfig(question.interactiveApp).correctOrder;
    const expectedFromAnswer = parseNumberOrderingValues(getExpectedAnswers(question)[0] || "");
    const expected = expectedFromAnswer.length > 0 ? expectedFromAnswer : expectedFromConfig;
    const typed = Array.isArray(userAnswer) ? userAnswer : parseNumberOrderingValues(userAnswer);
    if (typed.length !== expected.length || expected.length === 0) return false;
    return typed.every((value, index) => Number(value) === Number(expected[index]));
  }

  if (question.interactiveApp && question.interactiveApp.type === "time") {
    const config = question.interactiveApp.config || {};
    const mode = normalizeTimeMode(config.mode);
    const challenge = String(config.digitalChallenge || "words-to-12h").trim().toLowerCase();
    const expectedFromConfig = parseTimeText(formatTimeDisplay(
      normalizeTimeHour(config.hour),
      normalizeTimeMinute(config.minute),
      normalizeTimePeriod(config.period)
    ));
    const expectedAnswers = getExpectedAnswers(question);
    const expectedFromAnswer = parseTimeText(expectedAnswers[0] || "");
    const expected = expectedFromAnswer || expectedFromConfig;
    if (!expected) return false;

    if (mode === "analog-to-digital") {
      const selected = parseTimeText(userAnswer);
      if (!selected) return false;
      if (Number.isInteger(selected.minutesOfDay) && Number.isInteger(expected.minutesOfDay)) {
        return selected.minutesOfDay === expected.minutesOfDay;
      }
      return selected.minutesOnClock === expected.minutesOnClock;
    }

    const typed = parseTimeText(userAnswer);
    if (!typed) return false;
    if (mode === "digital" && challenge === "words-to-12h") {
      if (typed.hasPeriod && Number.isInteger(expected.minutesOfDay)) {
        return typed.minutesOfDay === expected.minutesOfDay;
      }
      return typed.minutesOnClock === expected.minutesOnClock;
    }
    if (Number.isInteger(expected.minutesOfDay)) {
      if (!Number.isInteger(typed.minutesOfDay)) return false;
      return typed.minutesOfDay === expected.minutesOfDay;
    }
    return typed.minutesOnClock === expected.minutesOnClock;
  }

  if (question.interactiveApp && question.interactiveApp.type === "fractions") {
    // Compare as equivalent fractions (cross-multiply), supporting mixed forms like "2 3/5".
    const user = parseAnswerFraction(userAnswer);
    const expected = getExpectedAnswers(question)[0];
    const fallbackSummary = buildFractionOperationSummary((question.interactiveApp && question.interactiveApp.config) || {});
    const fallbackExpected = !fallbackSummary.error && fallbackSummary.result
      ? `${fallbackSummary.result.numerator}/${fallbackSummary.result.denominator}`
      : "";
    const correct = parseAnswerFraction(expected || fallbackExpected);
    if (!user || !correct || !Number.isFinite(user.n) || !Number.isFinite(user.d) || user.d === 0) return false;
    return (user.n * correct.d) === (correct.n * user.d);
  }
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

  if (question.resultType === "date") {
    const userDate = parseDdMmYyyyDate(userAnswer);
    if (!userDate) return false;
    const expectedDates = getExpectedAnswers(question)
      .map((item) => parseDdMmYyyyDate(item))
      .filter((item) => item && item.canonical)
      .map((item) => item.canonical);
    if (expectedDates.length === 0) return false;
    return expectedDates.includes(userDate.canonical);
  }

  const isArithmetic = Boolean(
    question.interactiveApp && question.interactiveApp.type === "arithmetic"
  );
  const isMatrix = Boolean(
    question.interactiveApp && question.interactiveApp.type === "matrix"
  );
  const normalizeForMatch = (v) => {
    const n = norm(v);
    return isArithmetic ? stripLeadingZeros(n) : n;
  };
  const normalizeMatrixDimension = (v) => {
    const raw = String(v || "").trim().toLowerCase();
    const compact = raw.replace(/\s+/g, "");
    let match = compact.match(/^(\d+)(?:x|\*|×)(\d+)$/);
    if (!match) {
      match = raw.match(/^(\d+)\s*(?:x|\*|×|by)\s*(\d+)$/i);
    }
    return match ? `${Number.parseInt(match[1], 10)}x${Number.parseInt(match[2], 10)}` : null;
  };
  const parseNumericToken = (v) => {
    const raw = String(v || "").trim();
    if (!/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(raw)) return null;
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : null;
  };

  if (isArithmetic) {
    const arithmeticConfig = question.interactiveApp && question.interactiveApp.config
      ? question.interactiveApp.config
      : {};
    const visualMode = String(arithmeticConfig.visualMode || "").trim().toLowerCase();
    if (visualMode === "link-to-10") {
      const expectedPairs = normalizeArithmeticLinkConfig(arithmeticConfig).expectedPairs;
      const expectedText = serializeArithmeticLinkAnswerPairs(expectedPairs);
      const userText = serializeArithmeticLinkAnswerPairs(parseArithmeticLinkAnswerText(userAnswer));
      return expectedText !== "" && userText === expectedText;
    }
  }

  const parseMatrixAnswer = (v) => {
    const raw = String(v || "").trim();
    if (!raw) return null;
    const normalized = raw
      .replace(/\[/g, "")
      .replace(/\]/g, "")
      .replace(/\|/g, ";")
      .replace(/\r/g, "")
      .trim();

    const rows = normalized.includes(";")
      ? normalized.split(";")
      : normalized.split("\n");
    const parsedRows = rows
      .map((row) => row.trim())
      .filter((row) => row !== "")
      .map((row) => {
        const tokens = row.includes(",")
          ? row.split(",")
          : row.split(/\s+/);
        const numbers = tokens
          .map((token) => token.trim())
          .filter((token) => token !== "")
          .map((token) => Number.parseFloat(token));
        return numbers.every((num) => Number.isFinite(num)) ? numbers : null;
      });

    if (parsedRows.length === 0 || parsedRows.some((row) => !Array.isArray(row) || row.length === 0)) return null;
    const width = parsedRows[0].length;
    if (!parsedRows.every((row) => row.length === width)) return null;
    return parsedRows;
  };
  const matricesEqual = (a, b) => {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return false;
    if (a[0].length !== b[0].length) return false;
    const tolerance = 0.001;
    for (let r = 0; r < a.length; r += 1) {
      for (let c = 0; c < a[r].length; c += 1) {
        if (Math.abs(Number(a[r][c]) - Number(b[r][c])) > tolerance) return false;
      }
    }
    return true;
  };
  const value = normalizeForMatch(userAnswer);
  if (!value || expected.length === 0) return false;

  if (question.resultType === "short-answer") {
    if (isMatrix) {
      const userDim = normalizeMatrixDimension(userAnswer);
      const expectedDims = expected
        .map((item) => normalizeMatrixDimension(item))
        .filter((item) => item !== null);
      if (userDim && expectedDims.length > 0) {
        return expectedDims.includes(userDim);
      }

       const userMatrix = parseMatrixAnswer(userAnswer);
       const expectedMatrices = expected
         .map((item) => parseMatrixAnswer(item))
         .filter((item) => item !== null);
       if (userMatrix && expectedMatrices.length > 0) {
         return expectedMatrices.some((matrix) => matricesEqual(userMatrix, matrix));
       }
    }

    const userNumeric = parseNumericToken(value);
    const expectedNumeric = expected.map(parseNumericToken);
    if (userNumeric !== null && expectedNumeric.every((item) => item !== null)) {
      const tolerance = 0.001;
      return expectedNumeric.some((item) => Math.abs(item - userNumeric) <= tolerance);
    }
  }

  return expected.map(normalizeForMatch).includes(value);
}

function validateAnswer(question, userAnswer) {
  if (isIntroductionQuestion(question)) {
    const answerObj = userAnswer && typeof userAnswer === "object" ? userAnswer : {};
    return Boolean(answerObj.acceptedTerms) && Boolean(answerObj.acknowledgedSupport);
  }

  if (isNumberTracingQuestion(question)) {
    return hasCompletedTracingForCurrentQuestion();
  }

  if (question.interactiveApp && question.interactiveApp.type === "number-ordering") {
    return Array.isArray(userAnswer) && userAnswer.length > 0;
  }

  if (question.interactiveApp && question.interactiveApp.type === "fractions") {
    return !!parseAnswerFraction(userAnswer);
  }
  if (question.interactiveApp && question.interactiveApp.type === "time") {
    const mode = normalizeTimeMode(question.interactiveApp.config && question.interactiveApp.config.mode);
    if (mode === "analog") return true;
    if (mode === "digital") return !!parseTimeText(userAnswer);
  }
  if (question.interactiveApp && question.interactiveApp.type === "arithmetic") {
    const config = question.interactiveApp.config || {};
    const visualMode = String(config.visualMode || "").trim().toLowerCase();
    if (visualMode === "link-to-10") {
      const normalized = normalizeArithmeticLinkConfig(config);
      const pairs = parseArithmeticLinkAnswerText(userAnswer);
      return pairs.length === normalized.leftNumbers.length && normalized.leftNumbers.length > 0;
    }
    return String(userAnswer || "").trim() !== "";
  }
  if (question.interactiveApp && question.interactiveApp.type === "cartesian-plane-plot") {
    return Array.isArray(userAnswer) && userAnswer.length > 0;
  }
  if (question.resultType === "checkbox") {
    return Array.isArray(userAnswer) && userAnswer.length > 0;
  }

  if (question.resultType === "date") {
    return !!parseDdMmYyyyDate(userAnswer);
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
  if (isCorrect && !isIntroductionQuestion(question)) {
    score += 1;
    currentDifficulty = Math.min(10, currentDifficulty + 1);
    difficultyAdjustmentPending = true;
  } else if (!isCorrect && !isIntroductionQuestion(question)) {
    currentDifficulty = Math.max(1, currentDifficulty - 1);
    difficultyAdjustmentPending = true;
  }

  const expectedAnswers = getExpectedAnswers(question);
  if (isNumberTracingQuestion(question)) {
    captureNumberTracingSnapshotForCurrentQuestion();
  }
  const attemptRecord = buildAttemptRecord(
    question,
    userAnswer,
    expectedAnswers,
    isCorrect,
    currentIndex + 1
  );
  quizAnswerLog.push(attemptRecord);

  const resultBox = document.getElementById("resultBox");
  if (resultBox) {
    if (isIntroductionQuestion(question)) {
      if (isCorrect) {
        resultBox.textContent = "Accepted. You can continue to the quiz.";
        resultBox.className = "result-correct";
      } else {
        resultBox.textContent = "Please accept the Terms and Conditions and the support acknowledgement before continuing.";
        resultBox.className = "result-incorrect";
      }
    } else if (isCorrect) {
      if (question.interactiveApp && question.interactiveApp.type === "fractions") {
        const userFraction = parseAnswerFraction(userAnswer);
        const isImproperAnswer = !!userFraction && Math.abs(userFraction.n) > Math.abs(userFraction.d);
        const summary = buildFractionOperationSummary((question.interactiveApp && question.interactiveApp.config) || {}, question.question || "");
        const conversionOnlyMixed = isImproperToMixedConversionQuestion(question, summary);
        const conversionToImproper = isMixedToImproperConversionQuestion(question, summary);
        const mixed = summary && !summary.error ? toMixedNumber(summary.result) : null;
        const mixedStage = document.getElementById("quizContainer") && document.getElementById("quizContainer").querySelector("[data-role='fraction-mixed-stage']");
        if (mixedStage && mixed && mixed.numerator > 0 && isImproperAnswer && !conversionOnlyMixed && !conversionToImproper) {
          mixedStage.classList.remove("hidden");
          mixedStage.dataset.mixedChecked = "false";
          const mixedWholeInput = mixedStage.querySelector("[data-role='fraction-answer-whole']");
          if (mixedWholeInput instanceof HTMLInputElement) mixedWholeInput.focus();
          resultBox.textContent = "Correct improper fraction. Now enter the mixed fraction.";
        } else {
          if (conversionOnlyMixed && mixedStage instanceof HTMLElement) {
            mixedStage.dataset.mixedChecked = "true";
          }
          resultBox.textContent = "Correct";
        }
      } else {
        resultBox.textContent = "Correct";
      }
    } else if (question.interactiveApp && question.interactiveApp.type === "fractions") {
      resultBox.innerHTML = buildFractionIncorrectFeedbackMarkup(question, expectedAnswers);
    } else if (question.resultType === "short-answer" || question.resultType === "plot" || question.resultType === "date") {
      const shortAnswerFeedback = buildShortAnswerIncorrectFeedback(userAnswer, expectedAnswers);
      resultBox.innerHTML = `${escapeHtml(shortAnswerFeedback.userAnswerText)}<br>${escapeHtml(shortAnswerFeedback.correctAnswerText)}<br>${escapeHtml(shortAnswerFeedback.encouragementText)}`;
    } else {
      resultBox.innerHTML = buildIncorrectFeedbackMessage(userAnswer, expectedAnswers);
    }
    resultBox.className = isCorrect ? "result-correct" : "result-incorrect";
  }

  // Visual feedback for selected options
  if (!isIntroductionQuestion(question)) {
    highlightAnswerFeedback(question, userAnswer, isCorrect, expectedAnswers);
  }
  applyAnswerInputResultState(isCorrect, document.getElementById("quizContainer"));

  // Store expected answers for later use in solution modal
  window.currentExpectedAnswers = expectedAnswers;

  if (isIntroductionQuestion(question)) {
    document.getElementById("showSolutionBtn").classList.add("hidden");
  } else {
    document.getElementById("showSolutionBtn").classList.remove("hidden");
  }
  answerChecked = true;
  updateNextQuestionButtonState();
  if (isNumberTracingQuestion(question) && !hasCompletedTracingForCurrentQuestion()) {
    showToast("Trace the number to unlock Next Question.", "info");
  }

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

function handleSolutionArrowScrollHotkey(event) {
  if (!event || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return false;

  const modal = document.getElementById("solutionModal");
  if (!modal || modal.classList.contains("hidden")) return false;

  const dialog = modal.querySelector(".viewer-modal-dialog");
  if (!(dialog instanceof HTMLElement)) return false;

  event.preventDefault();
  const amount = event.key === "ArrowDown" ? 80 : -80;
  dialog.scrollBy({ top: amount, behavior: "smooth" });
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

  const activeQuestion = quizData.questions[currentIndex];
  if (!solutionShownForCurrentQuestion
    && activeQuestion
    && activeQuestion.interactiveApp
    && activeQuestion.interactiveApp.type === "fractions") {
    const quizContainer = document.getElementById("quizContainer");
    const mixedStage = quizContainer && quizContainer.querySelector("[data-role='fraction-mixed-stage']");
    const mixedCheckBtn = mixedStage && mixedStage.querySelector("[data-role='fraction-mixed-check-btn']");
    const isMixedStageVisible = !!(mixedStage instanceof HTMLElement && !mixedStage.classList.contains("hidden"));
    const isMixedChecked = !!(mixedStage instanceof HTMLElement && mixedStage.dataset.mixedChecked === "true");
    if (isMixedStageVisible && !isMixedChecked && mixedCheckBtn instanceof HTMLButtonElement) {
      mixedCheckBtn.click();
      return;
    }
  }

  if (!solutionShownForCurrentQuestion) {
    openSolutionModal();
    return;
  }

  const nextBtn = document.getElementById("nextQuestionBtn");
  if (nextBtn instanceof HTMLButtonElement && nextBtn.disabled) {
    return;
  }

  goNext();
}

function prepareSolutionModal(question, expectedAnswers) {
  const fallback = expectedAnswers.length > 0 ? expectedAnswers.join(question.resultType === "checkbox" ? ", " : "") : "N/A";
  const rawSolution = String(question.solution || "").trim();
  const matrixDimensionExplanation = buildMatrixDimensionExplanation(question);
  const matrixSolutionMarkup = buildMatrixSolutionMarkup(question);
  const defaultSolution = `Correct answer: ${fallback}`;
  const isNumberTracingApp = question.interactiveApp && question.interactiveApp.type === "number-tracing";
  const hasDistinctSolution = !isNumberTracingApp && (matrixDimensionExplanation !== "" || matrixSolutionMarkup !== "" || (rawSolution !== "" && norm(rawSolution) !== norm(defaultSolution)));
  const solutionAttachments = normalizeSolutionAttachments(question.solutionAttachments);
  const tracingSnapshot = isNumberTracingApp ? String(numberTracingSnapshotByQuestion[currentIndex] || "") : "";
  const modalBody = document.getElementById("solutionModalBody");
  const pdfPreviewsMarkup = renderPdfAttachmentPreviews(solutionAttachments);
  const isFractionsApp = question.interactiveApp && question.interactiveApp.type === "fractions";
  const isMatrixApp = question.interactiveApp && question.interactiveApp.type === "matrix";
  const solutionInteractiveApp = question.interactiveApp ? cloneInteractiveApp(question.interactiveApp) : null;
  
  // For arithmetic questions, display the original unadjusted question as presented to student
  if (solutionInteractiveApp && solutionInteractiveApp.type === "arithmetic" && expectedAnswers.length > 0) {
    const normalizedConfig = solutionInteractiveApp.config && typeof solutionInteractiveApp.config === "object"
      ? solutionInteractiveApp.config
      : {};
    normalizedConfig.answer = String(expectedAnswers[0]);
    solutionInteractiveApp.config = normalizedConfig;
  }
  const interactiveAppMarkup = (isFractionsApp || isMatrixApp || isNumberTracingApp) ? "" : buildInteractiveAppMarkup(solutionInteractiveApp || null);
  let correctAnswerMarkup = escapeHtml(fallback);
  const explanationText = isNumberTracingApp ? "" : (matrixDimensionExplanation || rawSolution);
  const explanationMarkup = question.interactiveApp && question.interactiveApp.type === "fractions"
    ? renderFractionExplanationText(rawSolution)
    : escapeHtml(explanationText).replace(/\n/g, "<br>");

  if (isNumberTracingApp) {
    const tracingConfig = (question.interactiveApp && question.interactiveApp.config) || {};
    const numeral = normalizeTracingTargetNumber(tracingConfig.targetNumber != null ? tracingConfig.targetNumber : fallback);
    const numeralWord = numberToSimpleWord(numeral);
    correctAnswerMarkup = `
      <span class="solution-number-word">${escapeHtml(numeralWord)}</span>
      <span class="solution-number-digit">${escapeHtml(String(numeral))}</span>
    `;
  }

  let fractionSolutionMarkup = "";
  if (isFractionsApp) {
    fractionSolutionMarkup = buildFractionsMarkup(
      question.interactiveApp.config || {},
      question.question || ""
    );
  } else {
    const summary = buildFractionOperationSummary(question.interactiveApp && question.interactiveApp.config || {});
    if (question.interactiveApp && question.interactiveApp.type === "fractions" && !summary.error && summary.result) {
      correctAnswerMarkup = fractionHtmlMixed(summary.result);
    }
  }

  modalBody.innerHTML = `
    ${isFractionsApp ? fractionSolutionMarkup : `
      <div class="solution-modal-section">
        <p class="solution-modal-label">Correct answer</p>
        <p class="solution-modal-answer">${correctAnswerMarkup}</p>
      </div>
      ${matrixSolutionMarkup}
      ${hasDistinctSolution && !isMatrixApp ? `
        <div class="solution-modal-section">
          <p class="solution-modal-label">Explanation</p>
          <div class="solution-modal-copy">${explanationMarkup}</div>
        </div>
      ` : ""}
      ${interactiveAppMarkup}
    `}
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

  if (!isFractionsApp && !isMatrixApp) wireInteractiveAppModal(modalBody, solutionInteractiveApp || null);
}

function openSolutionModal() {
  const question = quizData.questions[currentIndex];
  const expectedAnswers = window.currentExpectedAnswers || getExpectedAnswers(question);

  if (isNumberTracingQuestion(question)) {
    captureNumberTracingSnapshotForCurrentQuestion();
  }
  
  // Prepare modal content when user clicks Show Solution
  prepareSolutionModal(question, expectedAnswers);
  
  const modal = document.getElementById("solutionModal");
  const solutionNextBtn = document.getElementById("solutionNextBtn");
  if (!modal) return;
  const dialog = modal.querySelector(".viewer-modal-dialog");
  const body = document.getElementById("solutionModalBody");
  if (dialog instanceof HTMLElement) dialog.scrollTop = 0;
  if (body instanceof HTMLElement) body.scrollTop = 0;
  if (solutionNextBtn) {
    solutionNextBtn.textContent = currentIndex === quizData.questions.length - 1 ? "Finish Quiz" : "Next Question";
  }
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  solutionShownForCurrentQuestion = true;
}

function closeSolutionModal() {
  const modal = document.getElementById("solutionModal");
  if (!modal) return;
  const dialog = modal.querySelector(".viewer-modal-dialog");
  const body = document.getElementById("solutionModalBody");
  if (dialog instanceof HTMLElement) dialog.scrollTop = 0;
  if (body instanceof HTMLElement) body.scrollTop = 0;
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

  const nextBtn = document.getElementById("nextQuestionBtn");
  if (nextBtn instanceof HTMLButtonElement && nextBtn.disabled) return;

  if (currentIndex < quizData.questions.length - 1) {
    currentIndex += 1;
    renderQuestion();
    return;
  }

  const total = quizData.questions.length;
  const percent = total === 0 ? 0 : Math.round((score / total) * 100);
  const reviewedAttempts = quizAnswerLog.filter((item) => !item.isIntroduction);
  const mistakes = reviewedAttempts.filter((item) => !item.isCorrect);
  const reviewMarkup = renderAttemptReviewMarkup(reviewedAttempts);
  const analyticsMarkup = buildReviewAnalyticsMarkup(reviewedAttempts);
  document.getElementById("quizContainer").innerHTML = `
    <div class="question-card viewer-question final-card">
      <h2>Quiz Complete</h2>
      <p>Your final score is ${score} out of ${total} (${percent}%).</p>
      <div class="button-group" style="justify-content:center; gap:10px;">
        <button class="btn secondary" id="shareResultBtn">Share Quiz Link</button>
        <button class="btn secondary" id="exportResultsBtn">Export PDF</button>
        <button class="btn secondary" id="toggleReviewBtn">${mistakes.length > 0 ? `Hide Review (${mistakes.length})` : "Show Review"}</button>
        <button class="btn" id="restartBtn">Restart Quiz</button>
      </div>
      <section id="reviewPanel" class="review-panel${mistakes.length > 0 ? "" : " hidden"}">
        <h3>Review and Analytics</h3>
        ${analyticsMarkup}
        <div class="review-filters" role="group" aria-label="Review filters">
          <button class="btn secondary review-filter-btn is-active" data-filter="all" type="button">Show All</button>
          <button class="btn secondary review-filter-btn" data-filter="correct" type="button">Show Correct</button>
          <button class="btn secondary review-filter-btn" data-filter="incorrect" type="button">Show Incorrect</button>
        </div>
        <div class="review-grid">
          ${reviewMarkup}
        </div>
      </section>
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

  wireReviewInteractivePreviews(reviewedAttempts);

  const shareBtn = document.getElementById("shareResultBtn");
  if (shareBtn instanceof HTMLButtonElement) {
    shareBtn.addEventListener("click", async () => {
      await shareQuizLink();
    });
  }

  const exportBtn = document.getElementById("exportResultsBtn");
  if (exportBtn instanceof HTMLButtonElement) {
    exportBtn.addEventListener("click", () => {
      exportQuizResultsPdf(total, percent);
      showToast("PDF export opened.", "success");
    });
  }

  const reviewPanel = document.getElementById("reviewPanel");
  const toggleReviewBtn = document.getElementById("toggleReviewBtn");
  if (reviewPanel instanceof HTMLElement && toggleReviewBtn instanceof HTMLButtonElement) {
    toggleReviewBtn.addEventListener("click", () => {
      reviewPanel.classList.toggle("hidden");
      const hidden = reviewPanel.classList.contains("hidden");
      toggleReviewBtn.textContent = hidden
        ? (mistakes.length > 0 ? `Show Review (${mistakes.length})` : "Show Review")
        : (mistakes.length > 0 ? `Hide Review (${mistakes.length})` : "Hide Review");
    });
  }

  const filterButtons = Array.from(document.querySelectorAll(".review-filter-btn"));
  const reviewItems = Array.from(document.querySelectorAll(".review-item"));
  filterButtons.forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) return;
    button.addEventListener("click", () => {
      const targetFilter = String(button.dataset.filter || "all").toLowerCase();
      filterButtons.forEach((btn) => {
        if (btn instanceof HTMLButtonElement) {
          btn.classList.toggle("is-active", btn === button);
        }
      });

      reviewItems.forEach((item) => {
        if (!(item instanceof HTMLElement)) return;
        const result = String(item.dataset.result || "").toLowerCase();
        const shouldShow = targetFilter === "all" || result === targetFilter;
        item.classList.toggle("hidden", !shouldShow);
      });
    });
  });

  document.getElementById("restartBtn").addEventListener("click", () => {
    currentIndex = 0;
    score = 0;
    quizAnswerLog = [];
    Object.keys(numberTracingCompletionByQuestion).forEach((key) => {
      delete numberTracingCompletionByQuestion[key];
    });
    Object.keys(numberTracingSnapshotByQuestion).forEach((key) => {
      delete numberTracingSnapshotByQuestion[key];
    });
    document.getElementById("checkAnswerBtn").style.display = "inline-block";
    document.getElementById("nextQuestionBtn").style.display = "inline-block";
    document.getElementById("notesViewerBtn").style.display = "inline-block";
    document.getElementById("showSolutionBtn").classList.add("hidden");
    renderQuestion();
  });
}

async function loadQuiz() {
  const requestedFile = getRequestedFile();
  try {
    const response = await fetch(requestedFile, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Quiz file not found (${response.status}).`);
    }
    const rawData = await response.json();
    const parsedQuiz = parseQuizPayload(rawData);
    applySingleQuiz(parsedQuiz);
  } catch (error) {
    setError(`Could not load quiz: ${error.message}`);
  }
}

document.getElementById("checkAnswerBtn").addEventListener("click", checkAnswer);
document.getElementById("showSolutionBtn").addEventListener("click", openSolutionModal);
document.getElementById("nextQuestionBtn").addEventListener("click", goNext);
document.getElementById("shareQuizLinkBtn").addEventListener("click", () => {
  shareQuizLink();
});
document.getElementById("notesViewerBtn").addEventListener("click", () => {
  const panel = document.getElementById("notesViewerPanel");
  if (panel.innerHTML.trim() === "") {
    showToast("No notes attachments.", "info");
    return;
  }
  panel.classList.toggle("hidden");
});
document.getElementById("closeSolutionBtn").addEventListener("click", closeSolutionModal);
document.getElementById("solutionNextBtn").addEventListener("click", () => {
  closeSolutionModal();
  goNext();
});
document.getElementById("solutionModal").addEventListener("click", (event) => {
  const target = event.target;
  if (target instanceof HTMLElement && target.dataset.closeSolution === "true") {
    closeSolutionModal();
  }
});
window.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (handleSolutionArrowScrollHotkey(event)) {
      return;
    }
  }
  if (event.key === "Enter") {
    handleQuestionEnterHotkey(event);
    return;
  }
  if (event.key === "Escape") {
    closeSolutionModal();
  }
});

window.addEventListener("load", loadQuiz);




