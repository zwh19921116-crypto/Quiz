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
      ${items.map((item) => `<li><a href="${escapeHtml(item)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item)}</a></li>`).join("")}
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
    ${solutionAttachments.length > 0 ? `
      <div class="solution-modal-section">
        <p class="solution-modal-label">Attachments</p>
        <ul class="solution-attachment-list">
          ${solutionAttachments.map((item) => `<li><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.name)}</a></li>`).join("")}
        </ul>
      </div>
    ` : ""}
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