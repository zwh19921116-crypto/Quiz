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

  return {
    question: item.question || "Untitled Question",
    resultType,
    options,
    correctAnswer: item.correctAnswer,
    notesAttachments: Array.isArray(item.notesAttachments) ? item.notesAttachments : [],
    solutionAttachments: normalizeSolutionAttachments(item.solutionAttachments),
    image: item.image || "",
    solution: item.solution || ""
  };
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
function buildNumberLineSvgString(config) {
  const min = Number(config.min ?? -10);
  const max = Number(config.max ?? 10);
  if (isNaN(min) || isNaN(max) || min >= max) return "";
  const points = Array.isArray(config.points) ? config.points : [];
  const arrows = Array.isArray(config.arrows) ? config.arrows : [];
  const svgW = 600;
  const svgH = 130;
  const padX = 50;
  const lineY = 75;
  const tickH = 10;
  const usable = svgW - padX * 2;

  function xPos(val) { return padX + ((val - min) / (max - min)) * usable; }
  function safeColor(c) { return /^#[0-9a-fA-F]{3,6}$/.test(c) ? c : "#2563eb"; }

  const p = [];
  p.push(`<defs><marker id="nl-arr" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="#f59e0b"/></marker></defs>`);
  p.push(`<line x1="${padX - 12}" y1="${lineY}" x2="${svgW - padX + 12}" y2="${lineY}" stroke="#334155" stroke-width="2"/>`);
  p.push(`<polygon points="${padX - 22},${lineY} ${padX - 12},${lineY - 5} ${padX - 12},${lineY + 5}" fill="#334155"/>`);
  p.push(`<polygon points="${svgW - padX + 22},${lineY} ${svgW - padX + 12},${lineY - 5} ${svgW - padX + 12},${lineY + 5}" fill="#334155"/>`);

  const range = max - min;
  let step = 1;
  if (range > 40) step = 5;
  else if (range > 20) step = 2;

  for (let i = min; i <= max; i += step) {
    const x = xPos(i);
    const isZero = i === 0;
    p.push(`<line x1="${x}" y1="${lineY - tickH}" x2="${x}" y2="${lineY + tickH}" stroke="#334155" stroke-width="${isZero ? 2 : 1}"/>`);
    p.push(`<text x="${x}" y="${lineY + 26}" text-anchor="middle" font-size="12" fill="${isZero ? "#1e293b" : "#64748b"}" font-weight="${isZero ? "bold" : "normal"}">${i}</text>`);
  }

  arrows.forEach((arrow) => {
    const fx = xPos(Number(arrow.from));
    const tx = xPos(Number(arrow.to));
    const mx = (fx + tx) / 2;
    const peak = lineY - 38;
    const label = escapeHtml(String(arrow.label || ""));
    p.push(`<path d="M ${fx} ${lineY - 10} Q ${mx} ${peak} ${tx} ${lineY - 10}" stroke="#f59e0b" stroke-width="2" fill="none" marker-end="url(#nl-arr)"/>`);
    if (label) p.push(`<text x="${mx}" y="${peak - 6}" text-anchor="middle" font-size="12" fill="#b45309" font-weight="bold">${label}</text>`);
  });

  points.forEach((pt) => {
    const val = Number(pt.value);
    if (isNaN(val)) return;
    const x = xPos(val);
    const color = safeColor(pt.color || "#2563eb");
    const label = escapeHtml(String(pt.label || ""));
    p.push(`<circle cx="${x}" cy="${lineY}" r="8" fill="${color}" stroke="white" stroke-width="2"><title>${val}</title></circle>`);
    if (label) p.push(`<text x="${x}" y="${lineY - 16}" text-anchor="middle" font-size="11" fill="${color}" font-weight="bold">${label}</text>`);
  });

  return `<div class="nl-container"><svg viewBox="0 0 ${svgW} ${svgH}" width="100%" preserveAspectRatio="xMidYMid meet">${p.join("")}</svg></div>`;
}

function buildInteractiveAppMarkup(app) {
  if (!app || !app.type) return "";
  if (app.type === "number-line") {
    const svg = buildNumberLineSvgString(app.config || {});
    if (!svg) return "";
    return `<div class="solution-modal-section">
      <p class="solution-modal-label">Interactive: Number Line</p>
      <div class="interactive-app-preview">${svg}</div>
    </div>`;
  }
  return "";
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