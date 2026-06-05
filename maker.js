let categorySeed = 1;
let quizSeed = 1;
const DRAFT_STORAGE_KEY = "quiz-maker-draft-v1";
const ROOT_HANDLE_DB_NAME = "quiz-maker-root-handle-db";
const ROOT_HANDLE_STORE_NAME = "handles";
const ROOT_HANDLE_KEY = "root-directory";
const DEFAULT_QUIZ_ROOT = "quizzes";
const ROOT_SOURCE_MODES = {
  AUTO: "auto",
  LOCAL: "local",
  GITHUB: "github"
};
const APP_VERSION = "2.3.1";
let rootDirectoryHandle = null;
let silentSaveTimer = null;

function openRootHandleDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }

    const request = indexedDB.open(ROOT_HANDLE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ROOT_HANDLE_STORE_NAME)) {
        db.createObjectStore(ROOT_HANDLE_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open handle database."));
  });
}

async function loadSavedRootDirectoryHandle() {
  try {
    const db = await openRootHandleDb();
    if (!db) return null;

    return await new Promise((resolve, reject) => {
      const tx = db.transaction(ROOT_HANDLE_STORE_NAME, "readonly");
      const store = tx.objectStore(ROOT_HANDLE_STORE_NAME);
      const request = store.get(ROOT_HANDLE_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("Could not load saved root handle."));
      tx.oncomplete = () => db.close();
      tx.onerror = () => reject(tx.error || new Error("Could not load saved root handle."));
    });
  } catch (error) {
    return null;
  }
}

async function saveRootDirectoryHandle(handle) {
  try {
    const db = await openRootHandleDb();
    if (!db) return false;

    await new Promise((resolve, reject) => {
      const tx = db.transaction(ROOT_HANDLE_STORE_NAME, "readwrite");
      const store = tx.objectStore(ROOT_HANDLE_STORE_NAME);
      store.put(handle, ROOT_HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Could not save root handle."));
    });
    db.close();
    return true;
  } catch (error) {
    return false;
  }
}

async function clearSavedRootDirectoryHandle() {
  try {
    const db = await openRootHandleDb();
    if (!db) return;

    await new Promise((resolve, reject) => {
      const tx = db.transaction(ROOT_HANDLE_STORE_NAME, "readwrite");
      const store = tx.objectStore(ROOT_HANDLE_STORE_NAME);
      store.delete(ROOT_HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Could not clear root handle."));
    });
    db.close();
  } catch (error) {
    // Ignore persistence cleanup failures.
  }
}

async function ensureRootHandlePermission(handle, mode = "readwrite") {
  if (!handle) return false;
  if (typeof handle.queryPermission !== "function") return true;

  try {
    const current = await handle.queryPermission({ mode });
    if (current === "granted") return true;
    if (typeof handle.requestPermission !== "function") return false;
    const next = await handle.requestPermission({ mode });
    return next === "granted";
  } catch (error) {
    return false;
  }
}

async function restoreRootDirectoryHandle({ promptForPermission = false } = {}) {
  if (rootDirectoryHandle) {
    const ok = await ensureRootHandlePermission(rootDirectoryHandle, "readwrite");
    if (ok) return rootDirectoryHandle;
  }

  const savedHandle = await loadSavedRootDirectoryHandle();
  if (!savedHandle) return null;

  const ok = promptForPermission
    ? await ensureRootHandlePermission(savedHandle, "readwrite")
    : (typeof savedHandle.queryPermission === "function"
      ? (await savedHandle.queryPermission({ mode: "readwrite" })) === "granted"
      : true);

  if (!ok) {
    return null;
  }

  rootDirectoryHandle = savedHandle;
  return rootDirectoryHandle;
}

function splitPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter((item) => item !== "");
}

const state = {
  categories: [],
  rootFolder: DEFAULT_QUIZ_ROOT,
  rootSourceMode: ROOT_SOURCE_MODES.LOCAL,
  selectedCategoryId: null,
  selectedQuizId: null,
  selectedQuestionIndex: -1,
  draggingQuestionIndex: -1,
  quizScanEnabled: false
};

function getQuizValidationIssueCount(quiz) {
  if (!quiz || !Array.isArray(quiz.questions) || quiz.questions.length === 0) {
    return 0;
  }

  return quiz.questions.reduce((total, question) => total + getQuestionValidationIssues(question).length, 0);
}

function normalizeCheckboxCorrectAnswers(question, choiceOptions) {
  if (!question) return false;
  const options = Array.isArray(choiceOptions) ? choiceOptions : [];
  const rawTokens = String(question.correctAnswer || "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");

  const normalized = [];
  rawTokens.forEach((token) => {
    const matchedOption = options.find((option) => normalizeText(option) === normalizeText(token));
    if (matchedOption) {
      normalized.push(matchedOption);
      return;
    }

    const numberMatch = token.match(/^\d+$/);
    if (numberMatch) {
      const numeric = Number.parseInt(token, 10);
      const oneBased = options[numeric - 1];
      const zeroBased = options[numeric];
      if (oneBased) {
        normalized.push(oneBased);
        return;
      }
      if (zeroBased) {
        normalized.push(zeroBased);
        return;
      }
    }

    const letterMatch = token.match(/^[a-z]$/i);
    if (letterMatch) {
      const idx = letterMatch[0].toUpperCase().charCodeAt(0) - 65;
      if (idx >= 0 && idx < options.length) {
        normalized.push(options[idx]);
      }
    }
  });

  const deduped = [];
  normalized.forEach((item) => {
    if (!deduped.some((existing) => normalizeText(existing) === normalizeText(item))) {
      deduped.push(item);
    }
  });

  const fallback = deduped.length > 0 ? deduped : (options[0] ? [options[0]] : []);
  const nextValue = fallback.join(", ");
  if (String(question.correctAnswer || "").trim() === nextValue) {
    return false;
  }

  question.correctAnswer = nextValue;
  return true;
}

function autoFixQuestionIssues(question) {
  if (!question || typeof question !== "object") {
    return { changed: false, before: 0, after: 0 };
  }

  const before = getQuestionValidationIssues(question).length;
  let changed = false;

  let normalizedType = normalizeResultType(question.resultType || "multiple-choice");
  if (question.resultType !== normalizedType) {
    question.resultType = normalizedType;
    changed = true;
  }

  if (!Array.isArray(question.options)) {
    question.options = ["", "", "", ""];
    changed = true;
  }

  if (normalizedType === "true-false") {
    const beforeOptions = JSON.stringify(question.options);
    ensureTrueFalseOptions(question);
    if (beforeOptions !== JSON.stringify(question.options)) {
      changed = true;
    }
  }

  let choiceOptions = getChoiceOptions(question);
  if (["multiple-choice", "checkbox", "true-false"].includes(normalizedType) && choiceOptions.length < 2) {
    normalizedType = "short-answer";
    if (question.resultType !== "short-answer") {
      question.resultType = "short-answer";
      changed = true;
    }
  }

  choiceOptions = getChoiceOptions(question);
  if (normalizedType === "checkbox") {
    changed = normalizeCheckboxCorrectAnswers(question, choiceOptions) || changed;
  }

  const computedAnswer = computeExpectedAnswerForQuestion(question);
  const computedValue = String(computedAnswer && computedAnswer.value ? computedAnswer.value : "").trim();
  if (computedValue) {
    const currentAnswer = String(question.correctAnswer || "").trim();
    let nextAnswer = currentAnswer;

    if (["multiple-choice", "true-false"].includes(normalizedType)) {
      const matchedOption = choiceOptions.find((item) => normalizeText(item) === normalizeText(computedValue));
      if (matchedOption) {
        nextAnswer = String(matchedOption).trim();
      }
    } else if (normalizedType === "checkbox") {
      const requested = computedValue
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item !== "");
      const resolved = requested.map((token) => {
        const hit = choiceOptions.find((item) => normalizeText(item) === normalizeText(token));
        return hit ? String(hit).trim() : token;
      });
      if (resolved.length > 0) {
        nextAnswer = resolved.join(", ");
      }
    } else {
      nextAnswer = computedValue;
    }

    if (nextAnswer && !compareAnswersForResultType(normalizedType, currentAnswer, nextAnswer)) {
      question.correctAnswer = nextAnswer;
      changed = true;

      const existingSolution = String(question.solution || "").trim();
      if (!existingSolution || /^the correct answer is\b/i.test(existingSolution)) {
        question.solution = inferSolutionFromImport(question.question, nextAnswer);
      }
    }
  }

  if (["multiple-choice", "true-false"].includes(normalizedType)) {
    const beforeAnswer = String(question.correctAnswer || "");
    ensureDefaultCorrectAnswer(question);
    if (beforeAnswer !== String(question.correctAnswer || "")) {
      changed = true;
    }
  }

  if (normalizedType === "date") {
    const raw = String(question.correctAnswer || "").trim();
    const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) {
      const converted = `${isoMatch[3]}/${isoMatch[2]}/${isoMatch[1]}`;
      if (converted !== raw) {
        question.correctAnswer = converted;
        changed = true;
      }
    }
  }

  const metadataBefore = JSON.stringify({
    category: question.category || "",
    subcategory: question.subcategory || "",
    learningOutcome: question.learningOutcome || ""
  });
  applyDetectedQuestionMetadata(question);
  const metadataAfter = JSON.stringify({
    category: question.category || "",
    subcategory: question.subcategory || "",
    learningOutcome: question.learningOutcome || ""
  });
  if (metadataBefore !== metadataAfter) {
    changed = true;
  }

  const after = getQuestionValidationIssues(question).length;
  return { changed, before, after };
}

function snapshotImportAutoFixFields(question) {
  if (!question || typeof question !== "object") return "";
  return JSON.stringify({
    resultType: question.resultType || "",
    options: Array.isArray(question.options) ? question.options : [],
    correctAnswer: question.correctAnswer || "",
    category: question.category || "",
    subcategory: question.subcategory || "",
    learningOutcome: question.learningOutcome || "",
    solution: question.solution || "",
    interactiveApp: question.interactiveApp || null
  });
}

function getImportAutoFixStatus(beforeIssues, afterIssues, changed) {
  if (afterIssues === 0 && changed) return "fixed";
  if (afterIssues < beforeIssues) return "improved";
  if (afterIssues > 0) return "unresolved";
  return changed ? "fixed" : "unchanged";
}

function describeImportAutoFixChanges(beforeSnapshot, afterSnapshot) {
  try {
    const before = beforeSnapshot ? JSON.parse(beforeSnapshot) : null;
    const after = afterSnapshot ? JSON.parse(afterSnapshot) : null;
    if (!before || !after) return "";
    const labels = [];
    const pairs = [
      ["resultType", "result type"],
      ["options", "options"],
      ["correctAnswer", "answer"],
      ["category", "category"],
      ["subcategory", "subcategory"],
      ["learningOutcome", "learning outcome"],
      ["solution", "solution"],
      ["interactiveApp", "interactive app"]
    ];
    pairs.forEach(([key, label]) => {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
        labels.push(label);
      }
    });
    return labels.join(", ");
  } catch (_error) {
    return "";
  }
}

function autoFixActiveQuizIssues() {
  const quiz = activeQuiz();
  if (!quiz || !Array.isArray(quiz.questions) || quiz.questions.length === 0) {
    showToast("Select a quiz with questions first.", "warning");
    return;
  }

  let changedCount = 0;
  let improvedCount = 0;
  let unresolvedCount = 0;

  quiz.questions.forEach((question) => {
    const result = autoFixQuestionIssues(question);
    if (result.changed) changedCount += 1;
    if (result.after < result.before) improvedCount += 1;
    if (result.after > 0) unresolvedCount += 1;
  });

  renderAll();
  scheduleSilentDiskSave();

  if (improvedCount > 0) {
    showToast(`Auto-fix updated ${changedCount} question(s). Remaining with issues: ${unresolvedCount}.`, unresolvedCount > 0 ? "warning" : "success");
    return;
  }

  if (changedCount > 0) {
    showToast(`Auto-fix normalized ${changedCount} question(s).`, "success");
    return;
  }

  showToast("No auto-fixable issues found.", "info");
}

let pendingImportRows = [];
let pendingImportSourceName = "";
let pendingImportValidation = null;
let pendingImportAutoFixReport = null;
let pendingResultValidation = null;
let pendingResultValidationSelectedIndex = -1;
let pendingResultValidationFilter = "all";
let pendingResultValidationIssueFilter = "all";

const ALLOWED_IMPORT_GRADE_CATEGORIES = [
  "Prep",
  "Grade 1",
  "Grade 2",
  "Grade 3",
  "Grade 4",
  "Grade 5",
  "Grade 6"
];

const IMPORT_TEMPLATE_HEADERS = [
  "Grade",
  "Module",
  "Lesson Part",
  "Lesson Name",
  "Category",
  "Subcategory",
  "Q No",
  "Question Type",
  "Question",
  "Options",
  "Compute",
  "Learning Outcome"
];

const IMPORT_GRADE_ALIASES = {
  prep: "Prep",
  preprimary: "Prep",
  preprimaryschool: "Prep",
  kindergarten: "Prep",
  kindy: "Prep",
  grade1: "Grade 1",
  g1: "Grade 1",
  year1: "Grade 1",
  grade2: "Grade 2",
  g2: "Grade 2",
  year2: "Grade 2",
  grade3: "Grade 3",
  g3: "Grade 3",
  year3: "Grade 3",
  grade4: "Grade 4",
  g4: "Grade 4",
  year4: "Grade 4",
  grade5: "Grade 5",
  g5: "Grade 5",
  year5: "Grade 5",
  grade6: "Grade 6",
  g6: "Grade 6",
  year6: "Grade 6"
};

const QUIZ_ORDER_MODES = {
  ORDERED: "ordered",
  RANDOM: "random"
};

function normalizeRootSourceMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === ROOT_SOURCE_MODES.GITHUB) return ROOT_SOURCE_MODES.GITHUB;
  return ROOT_SOURCE_MODES.LOCAL; // default to local (auto is no longer supported)
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
  }, 3500);
}

function isTypingInField(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function reseedCountersFromState() {
  const catTotal = state.categories.length;
  const quizTotal = state.categories.reduce((total, item) => total + (Array.isArray(item.quizzes) ? item.quizzes.length : 0), 0);
  categorySeed = Math.max(1, catTotal + 1);
  quizSeed = Math.max(1, quizTotal + 1);
}

function saveDraft() {
  const payload = {
    categories: state.categories,
    rootFolder: state.rootFolder,
    rootSourceMode: state.rootSourceMode,
    selectedCategoryId: state.selectedCategoryId,
    selectedQuizId: state.selectedQuizId,
    selectedQuestionIndex: state.selectedQuestionIndex
  };

  try {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    // Ignore storage quota errors and keep app usable.
  }
}

function loadDraft() {
  let raw = "";
  try {
    raw = localStorage.getItem(DRAFT_STORAGE_KEY) || "";
  } catch (error) {
    return false;
  }

  if (!raw) return false;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.categories)) {
      return false;
    }

    state.categories = parsed.categories.map((category) => ({
      id: category.id || `cat-${categorySeed++}`,
      name: category.name || "Category",
      quizzes: Array.isArray(category.quizzes)
        ? category.quizzes.map((quiz) => ({
          id: quiz.id || `quiz-${quizSeed++}`,
          title: quiz.title || "Untitled Quiz",
          description: normalizeQuizDescription(quiz.description),
          settings: normalizeQuizSettings(quiz.settings),
          fileName: quiz.fileName || "",
          sourcePath: quiz.sourcePath || "",
          questions: Array.isArray(quiz.questions) ? quiz.questions.map(normalizeQuestion) : []
        }))
        : []
    }));

    state.rootFolder = String(parsed.rootFolder || DEFAULT_QUIZ_ROOT).trim() || DEFAULT_QUIZ_ROOT;
    state.rootSourceMode = normalizeRootSourceMode(parsed.rootSourceMode || ROOT_SOURCE_MODES.AUTO);

    ensureQuizFileNames();

    state.selectedCategoryId = parsed.selectedCategoryId || null;
    state.selectedQuizId = parsed.selectedQuizId || null;
    state.selectedQuestionIndex = Number.isInteger(parsed.selectedQuestionIndex) ? parsed.selectedQuestionIndex : -1;

    reseedCountersFromState();
    return true;
  } catch (error) {
    return false;
  }
}

function createEmptyQuestion() {
  return {
    question: "",
    resultType: normalizeResultType("multiple-choice"),
    options: ["", "", "", ""],
    correctAnswer: "",
    category: "",
    subcategory: "",
    learningOutcome: "",
    notesAttachments: [],
    image: "",
    solution: "",
    solutionAttachments: []
  };
}

function createCategory(name) {
  return {
    id: `cat-${categorySeed++}`,
    name,
    quizzes: []
  };
}

function createQuiz(title) {
  const id = `quiz-${quizSeed++}`;
  return {
    id,
    title,
    description: "",
    settings: normalizeQuizSettings(null),
    fileName: buildUniqueQuizFileName(title, id),
    sourcePath: "",
    questions: []
  };
}

function activeCategory() {
  return state.categories.find((item) => item.id === state.selectedCategoryId) || null;
}

function activeQuiz() {
  const category = activeCategory();
  if (!category) return null;
  return category.quizzes.find((item) => item.id === state.selectedQuizId) || null;
}

function activeQuestion() {
  const quiz = activeQuiz();
  if (!quiz || state.selectedQuestionIndex < 0) return null;
  return quiz.questions[state.selectedQuestionIndex] || null;
}

function ensureQuizHasDefaultQuestion(quiz) {
  if (!quiz) return false;
  if (Array.isArray(quiz.questions) && quiz.questions.length > 0) return false;
  quiz.questions = [createEmptyQuestion()];
  return true;
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function buildQuestionUniquenessSignature(item) {
  if (!item || typeof item !== "object") return "";

  const resultType = normalizeResultType(item.resultType || "short-answer");
  const app = item.interactiveApp && typeof item.interactiveApp === "object" ? item.interactiveApp : null;
  const appType = app && app.type ? String(app.type).trim().toLowerCase() : "";
  const appConfig = app && app.config && typeof app.config === "object" ? app.config : null;

  if (appType && appConfig) {
    return `app|${appType}|${resultType}|${stableSerialize(appConfig)}`;
  }

  const questionText = normalizeText(normalizeWhitespace(item.question || ""));
  const correctAnswer = normalizeText(normalizeWhitespace(item.correctAnswer || ""));
  return `text|${resultType}|${questionText}|${correctAnswer}`;
}

function isQuestionDuplicateInSet(item, seenSignatures) {
  const signature = buildQuestionUniquenessSignature(item);
  if (!signature) {
    return false;
  }
  return seenSignatures.has(signature);
}

function normalizeResultType(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");

  if (["short-answer", "shortanswer", "short"].includes(normalized)) return "short-answer";
  if (["date", "date-answer", "dateanswer"].includes(normalized)) return "date";
  if (["plot", "graph", "graph-plot", "plot-graph"].includes(normalized)) return "plot";
  if (["true-false", "truefalse", "boolean"].includes(normalized)) return "true-false";
  if (["checkbox", "multi-select", "multiselect"].includes(normalized)) return "checkbox";
  return "multiple-choice";
}

function normalizeQuizDescription(value) {
  return String(value || "").trim();
}

function normalizeQuestionFieldValue(value) {
  return String(value || "").trim();
}

function extractQuestionNumber(value) {
  const match = String(value || "").match(/\b(\d+)\b/);
  return match ? match[1] : "";
}

function formatMetadataLabel(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function inferQuestionMetadata(question) {
  const app = question && question.interactiveApp && typeof question.interactiveApp === "object"
    ? question.interactiveApp
    : null;
  const appType = String(app && app.type || "").trim().toLowerCase();
  const appConfig = app && app.config && typeof app.config === "object" ? app.config : {};
  const questionText = normalizeWhitespace(String(question && question.question || ""));
  const lowerText = questionText.toLowerCase();
  const targetNumber = String(appConfig.targetNumber || extractQuestionNumber(questionText) || question && question.correctAnswer || "").trim();

  let category = normalizeQuestionFieldValue(question && question.category);
  let subcategory = normalizeQuestionFieldValue(question && question.subcategory);
  let learningOutcome = normalizeQuestionFieldValue(question && question.learningOutcome);
  let detectedSource = appType ? formatMetadataLabel(appType) : "Question text";

  if (appType === "number-tracing") {
    category = category || "Writing";
    subcategory = subcategory || (targetNumber ? `Draw Number ${targetNumber}` : "Draw Number");
    learningOutcome = learningOutcome || (targetNumber ? `Write ${targetNumber}` : "Write numeral");
    detectedSource = "Number Tracing";
  } else if (appType === "time") {
    const mode = formatMetadataLabel(normalizeTimeMode(appConfig.mode));
    category = category || "Time";
    subcategory = subcategory || (mode || "Time");
    learningOutcome = learningOutcome || "Read and represent time";
    detectedSource = "Time";
  } else if (appType === "number-ordering") {
    category = category || "Number Order";
    subcategory = subcategory || "Sequence";
    learningOutcome = learningOutcome || "Order numbers";
    detectedSource = "Number Ordering";
  } else if (appType === "icon-count") {
    category = category || "Counting";
    subcategory = subcategory || "Icon Count";
    learningOutcome = learningOutcome || "Count objects";
    detectedSource = "Icon Count";
  } else if (appType === "calendar-sequence") {
    category = category || "Calendar";
    subcategory = subcategory || "Sequence";
    learningOutcome = learningOutcome || "Order calendar events";
    detectedSource = "Calendar Sequence";
  } else if (appType === "arithmetic") {
    const operation = formatMetadataLabel(appConfig.operation || appConfig.visualMode || "Result");
    category = category || "Arithmetic";
    subcategory = subcategory || operation;
    learningOutcome = learningOutcome || "Solve the arithmetic question";
    detectedSource = "Arithmetic";
  } else if (appType === "fractions") {
    const operation = formatMetadataLabel(normalizeFractionOperation(appConfig.operation || "operation-result"));
    category = category || "Fractions";
    subcategory = subcategory || operation;
    learningOutcome = learningOutcome || "Solve the fraction question";
    detectedSource = "Fractions";
  } else if (appType === "matrix") {
    const operation = formatMetadataLabel(normalizeMatrixOperation(appConfig.operation || "dimensions"));
    category = category || "Matrices";
    subcategory = subcategory || operation;
    learningOutcome = learningOutcome || "Solve the matrix question";
    detectedSource = "Matrices";
  } else if (appType === "cartesian-plane-plot") {
    const preset = formatMetadataLabel(appConfig.presetType || "Plot");
    category = category || "Cartesian Plane";
    subcategory = subcategory || preset;
    learningOutcome = learningOutcome || "Plot the points";
    detectedSource = "Cartesian Plane - Plot";
  } else if (appType === "cartesian-plane") {
    category = category || "Cartesian Plane";
    subcategory = subcategory || "Graphing";
    learningOutcome = learningOutcome || "Interpret the graph";
    detectedSource = "Cartesian Plane";
  } else if (appType === "bar-chart" || appType === "histogram" || appType === "box-plot" || appType === "scatter-plot") {
    category = category || formatMetadataLabel(appType);
    subcategory = subcategory || "Data Interpretation";
    learningOutcome = learningOutcome || "Interpret the data display";
    detectedSource = formatMetadataLabel(appType);
  } else if (appType === "probability-tree" || appType === "distribution-curve" || appType === "network-graph" || appType === "stem-and-leaf" || appType === "geometry-shapes" || appType === "pythagoras" || appType === "trigonometry") {
    category = category || formatMetadataLabel(appType);
    subcategory = subcategory || "Concept Check";
    learningOutcome = learningOutcome || "Apply the concept";
    detectedSource = formatMetadataLabel(appType);
  }

  if (!appType) {
    if (/\b(draw|trace|write)\s+the\s+number\s+\d+\b/i.test(lowerText)) {
      category = category || "Writing";
      subcategory = subcategory || `Draw Number ${targetNumber || extractQuestionNumber(questionText)}`.trim();
      learningOutcome = learningOutcome || (targetNumber ? `Write ${targetNumber}` : "Write numeral");
      detectedSource = "Writing";
    } else if (/\b(select|choose)\s+the\s+correct\s+answer\b/i.test(lowerText)) {
      detectedSource = "Multiple Choice";
    }
  }

  return {
    category,
    subcategory,
    learningOutcome,
    detectedSource,
    appTypeLabel: appType ? formatMetadataLabel(appType) : "Text question"
  };
}

function applyDetectedQuestionMetadata(question) {
  if (!question) return inferQuestionMetadata(question);
  const detected = inferQuestionMetadata(question);

  if (!normalizeQuestionFieldValue(question.category) && detected.category) {
    question.category = detected.category;
  }
  if (!normalizeQuestionFieldValue(question.subcategory) && detected.subcategory) {
    question.subcategory = detected.subcategory;
  }
  if (!normalizeQuestionFieldValue(question.learningOutcome) && detected.learningOutcome) {
    question.learningOutcome = detected.learningOutcome;
  }

  return detected;
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

function applyLoadedQuizJsonToQuiz(quiz, quizJson) {
  if (!quiz || !quizJson || typeof quizJson !== "object") return;
  const nextTitle = String(quizJson.title || "").trim();
  if (nextTitle) {
    quiz.title = nextTitle;
  }
  quiz.description = normalizeQuizDescription(quizJson.description);
  quiz.settings = normalizeQuizSettings(quizJson.settings);
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "quiz";
}

function normalizeQuizFileName(value) {
  const raw = String(value || "").trim().replace(/\.json$/i, "");
  return `${slugify(raw)}.json`;
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

function parseSolutionAttachmentLines(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const divider = line.indexOf("|");
      if (divider > 0) {
        return normalizeSolutionAttachment({
          name: line.slice(0, divider).trim(),
          url: line.slice(divider + 1).trim()
        });
      }
      return normalizeSolutionAttachment(line);
    })
    .filter((item) => item && item.url);
}

function serializeManualSolutionAttachments(items) {
  return normalizeSolutionAttachments(items)
    .filter((item) => !item.embedded)
    .map((item) => {
      const defaultName = deriveAttachmentName(item.url);
      return item.name && item.name !== defaultName
        ? `${item.name} | ${item.url}`
        : item.url;
    })
    .join("\n");
}

function buildUniqueQuizFileName(value, excludedQuizId = null) {
  const normalized = normalizeQuizFileName(value);
  const usedNames = new Set();

  state.categories.forEach((category) => {
    (category.quizzes || []).forEach((quiz) => {
      if (!quiz || quiz.id === excludedQuizId) return;
      const fileName = String(quiz.fileName || "").trim().toLowerCase();
      if (fileName) {
        usedNames.add(fileName);
      }
    });
  });

  if (!usedNames.has(normalized.toLowerCase())) {
    return normalized;
  }

  const base = normalized.replace(/\.json$/i, "");
  let counter = 2;
  let candidate = `${base}-${counter}.json`;

  while (usedNames.has(candidate.toLowerCase())) {
    counter += 1;
    candidate = `${base}-${counter}.json`;
  }

  return candidate;
}

function ensureQuizFileNames() {
  const reservedNames = new Set();

  state.categories.forEach((category) => {
    (category.quizzes || []).forEach((quiz) => {
      const normalized = normalizeQuizFileName(quiz.fileName || quiz.title || "quiz");
      const base = normalized.replace(/\.json$/i, "");
      let candidate = normalized;
      let counter = 2;

      while (reservedNames.has(candidate.toLowerCase())) {
        candidate = `${base}-${counter}.json`;
        counter += 1;
      }

      quiz.fileName = candidate;
      reservedNames.add(candidate.toLowerCase());
    });
  });
}

function normalizeRootFolder(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/g, "") || DEFAULT_QUIZ_ROOT;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function extractYoutubeVideoId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();

    if (host === "youtu.be") {
      const idFromPath = parsed.pathname.replace(/^\/+/, "").split("/")[0] || "";
      return /^[a-zA-Z0-9_-]{6,}$/.test(idFromPath) ? idFromPath : "";
    }

    if (host.endsWith("youtube.com")) {
      const idFromSearch = parsed.searchParams.get("v") || "";
      if (/^[a-zA-Z0-9_-]{6,}$/.test(idFromSearch)) {
        return idFromSearch;
      }

      const pathParts = parsed.pathname.split("/").filter((item) => item !== "");
      const marker = pathParts[0] || "";
      if (["embed", "shorts", "live"].includes(marker)) {
        const idFromPath = pathParts[1] || "";
        return /^[a-zA-Z0-9_-]{6,}$/.test(idFromPath) ? idFromPath : "";
      }
    }

    return "";
  } catch (error) {
    return "";
  }
}

function normalizeYoutubeUrl(value) {
  const id = extractYoutubeVideoId(value);
  return id ? `https://www.youtube.com/watch?v=${id}` : "";
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

function normalizePdfUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^data:application\/pdf/i.test(raw)) return raw;

  const driveId = extractGoogleDriveFileId(raw);
  if (driveId) {
    return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(driveId)}`;
  }

  return raw;
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

function splitNotesAttachments(items) {
  const result = {
    youtube: "",
    pdf: [],
    other: []
  };

  const values = Array.isArray(items) ? items : [];
  values.forEach((item) => {
    const value = String(item || "").trim();
    if (!value) return;

    const youtube = normalizeYoutubeUrl(value);
    if (youtube) {
      if (!result.youtube) {
        result.youtube = youtube;
      }
      return;
    }

    if (isPdfAttachment(value)) {
      result.pdf.push(value);
      return;
    }

    result.other.push(value);
  });

  return result;
}

function buildNotesAttachments(parts) {
  const list = [];
  if (parts.youtube) {
    list.push(parts.youtube);
  }
  if (Array.isArray(parts.pdf) && parts.pdf.length > 0) {
    list.push(...parts.pdf);
  }
  if (Array.isArray(parts.other) && parts.other.length > 0) {
    list.push(...parts.other);
  }
  return list;
}

function mergeUniqueNotesAttachments(items) {
  const seen = new Set();
  const result = [];
  (Array.isArray(items) ? items : []).forEach((item) => {
    const value = String(item || "").trim();
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(value);
  });
  return result;
}

function parsePdfUrlLines(text) {
  return mergeUniqueNotesAttachments(
    String(text || "")
      .split("\n")
      .map((line) => normalizePdfUrl(line))
      .filter((line) => line !== "")
  );
}

function serializeManualNotesAttachments(items) {
  return splitNotesAttachments(items).other.join("\n");
}

function buildGithubContext(owner, repo, branch, repoPath, rootFolder) {
  const cleanRepoPath = String(repoPath || "").replace(/^\/+|\/+$/g, "");
  const rawBase = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}${cleanRepoPath ? `/${cleanRepoPath}` : ""}`;
  return {
    rootFolder,
    fetchBase: rawBase,
    supportsDirectoryScan: false,
    githubRepo: {
      owner,
      repo,
      branch,
      repoPath: cleanRepoPath
    }
  };
}

function inferGithubContextFromPages(rootFolder) {
  const host = String(window.location.hostname || "").toLowerCase();
  if (!host.endsWith(".github.io")) {
    return null;
  }

  const owner = host.replace(/\.github\.io$/i, "");
  const pathSegments = String(window.location.pathname || "")
    .split("/")
    .filter((item) => item !== "");
  const repo = pathSegments[0] || "";
  if (!owner || !repo) {
    return null;
  }

  const repoPath = normalizeRootFolder(rootFolder);
  return buildGithubContext(owner, repo, "main", repoPath, rootFolder);
}

function joinPath(base, relativePath) {
  const cleanBase = String(base || "").replace(/\/+$/g, "");
  const cleanRelative = String(relativePath || "").replace(/^\/+/, "");
  return `${cleanBase}/${cleanRelative}`;
}

function resolveRootFetchContext(rootFolder) {
  const normalized = normalizeRootFolder(rootFolder);
  const fallback = {
    rootFolder: normalized,
    fetchBase: normalized,
    supportsDirectoryScan: !isHttpUrl(normalized),
    githubRepo: null
  };

  if (!isHttpUrl(normalized)) {
    return fallback;
  }

  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase();
    const segments = parsed.pathname.split("/").filter((item) => item !== "");

    if (host === "raw.githubusercontent.com") {
      const rawSegments = parsed.pathname.split("/").filter((item) => item !== "");
      const owner = rawSegments[0] || "";
      const repo = rawSegments[1] || "";
      const branch = rawSegments[2] || "main";
      const repoPath = rawSegments.slice(3).join("/");

      return owner && repo
        ? buildGithubContext(owner, repo, branch, repoPath, normalized)
        : {
          rootFolder: normalized,
          fetchBase: `${parsed.origin}${parsed.pathname}`.replace(/\/+$/g, ""),
          supportsDirectoryScan: false,
          githubRepo: null
        };
    }

    if (host !== "github.com" || segments.length < 2) {
      return {
        rootFolder: normalized,
        fetchBase: normalized,
        supportsDirectoryScan: false,
        githubRepo: null
      };
    }

    const owner = segments[0];
    const repo = segments[1];
    let branch = "main";
    let repoPath = "";

    if (segments[2] === "tree" && segments[3]) {
      branch = segments[3];
      repoPath = segments.slice(4).join("/");
    }

    if (segments[2] === "blob" && segments[3]) {
      branch = segments[3];
      repoPath = segments.slice(4, -1).join("/");
    }

    return buildGithubContext(owner, repo, branch, repoPath, normalized);
  } catch (error) {
    return {
      rootFolder: normalized,
      fetchBase: normalized,
      supportsDirectoryScan: false,
      githubRepo: null
    };
  }
}

function toGitHubApiContentsUrl(githubRepo, path) {
  const encodedPath = String(path || "")
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const base = `https://api.github.com/repos/${encodeURIComponent(githubRepo.owner)}/${encodeURIComponent(githubRepo.repo)}/contents`;
  const target = encodedPath ? `${base}/${encodedPath}` : base;
  return `${target}?ref=${encodeURIComponent(githubRepo.branch)}`;
}

function getGitHubDownloadUrl(entry, githubRepo, path) {
  if (entry && typeof entry.download_url === "string" && entry.download_url.trim() !== "") {
    return entry.download_url;
  }

  const cleanPath = String(path || "").replace(/^\/+/, "");
  return `https://raw.githubusercontent.com/${githubRepo.owner}/${githubRepo.repo}/${githubRepo.branch}/${cleanPath}`;
}

async function readGitHubDirectoryEntries(githubRepo, path) {
  const response = await fetch(toGitHubApiContentsUrl(githubRepo, path), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Could not read ${path || githubRepo.repoPath || "/"} from GitHub`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error(`Unexpected GitHub directory payload for ${path || "/"}`);
  }

  return payload;
}

function buildGitHubCdnUrl(githubRepo, filePath) {
  const cleanPath = String(filePath || "").replace(/^\/+/, "");
  return `https://cdn.jsdelivr.net/gh/${encodeURIComponent(githubRepo.owner)}/${encodeURIComponent(githubRepo.repo)}@${encodeURIComponent(githubRepo.branch)}/${cleanPath}`;
}

async function loadLibraryFromGithubFlatIndex(context) {
  if (!context.githubRepo) {
    throw new Error("GitHub repository context is missing.");
  }

  const githubRepo = context.githubRepo;
  const baseRootPath = String(githubRepo.repoPath || "").replace(/^\/+|\/+$/g, "");
  const rootPathCandidates = [baseRootPath];
  if (!baseRootPath) {
    rootPathCandidates.push(DEFAULT_QUIZ_ROOT);
  } else if (!baseRootPath.toLowerCase().endsWith(`/${DEFAULT_QUIZ_ROOT}`) && baseRootPath.toLowerCase() !== DEFAULT_QUIZ_ROOT) {
    rootPathCandidates.push(`${baseRootPath}/${DEFAULT_QUIZ_ROOT}`);
  }

  const indexUrl = `https://data.jsdelivr.com/v1/package/gh/${encodeURIComponent(githubRepo.owner)}/${encodeURIComponent(githubRepo.repo)}@${encodeURIComponent(githubRepo.branch)}/flat`;
  const indexResponse = await fetch(indexUrl, { cache: "no-store" });
  if (!indexResponse.ok) {
    throw new Error(`Could not read ${baseRootPath || "repository root"} index from CDN (status ${indexResponse.status})`);
  }

  const indexPayload = await indexResponse.json();
  const files = Array.isArray(indexPayload && indexPayload.files) ? indexPayload.files : [];

  for (const rootPath of rootPathCandidates) {
    const rootPrefix = rootPath ? `/${rootPath}/` : "/";
    const quizFilePaths = files
      .map((entry) => String(entry && entry.name ? entry.name : ""))
      .filter((name) => name.startsWith(rootPrefix))
      .filter((name) => name.toLowerCase().endsWith(".json"))
      .filter((name) => !name.toLowerCase().endsWith("/index.json"));

    if (quizFilePaths.length === 0) {
      continue;
    }

    const groupedByFolder = new Map();
    quizFilePaths.forEach((fullPath) => {
      const relative = rootPath ? fullPath.slice(rootPrefix.length) : fullPath.replace(/^\/+/, "");
      const folder = relative.split("/")[0] || "";
      if (!folder) {
        return;
      }

      const list = groupedByFolder.get(folder) || [];
      list.push(relative);
      groupedByFolder.set(folder, list);
    });

    if (groupedByFolder.size === 0) {
      continue;
    }

    const loadedCategories = [];

    for (const [folder, relativePaths] of groupedByFolder.entries()) {
      const category = createCategory(categoryNameFromFolder(folder));

      for (const relativePath of relativePaths) {
        const repoFilePath = rootPath ? `${rootPath}/${relativePath}` : relativePath;
        const quizPath = buildGitHubCdnUrl(githubRepo, repoFilePath);
        const quizResponse = await fetch(quizPath, { cache: "no-store" });
        if (!quizResponse.ok) {
          continue;
        }

        const quizJson = await quizResponse.json();
        const quiz = createQuiz(quizTitleFromFilePath(relativePath));
        quiz.fileName = normalizeQuizFileName(baseNameFromPath(relativePath));
        quiz.sourcePath = quizPath;
        applyLoadedQuizJsonToQuiz(quiz, quizJson);
        quiz.questions = Array.isArray(quizJson.questions) ? quizJson.questions.map(normalizeQuestion) : [];
        category.quizzes.push(quiz);
      }

      if (category.quizzes.length > 0) {
        loadedCategories.push(category);
      }
    }

    if (loadedCategories.length > 0) {
      return loadedCategories;
    }
  }

  throw new Error(`No quiz JSON files found in ${baseRootPath || "repository root"}`);
}

async function loadLibraryFromGithubFolders(context) {
  if (!context.githubRepo) {
    throw new Error("GitHub repository context is missing.");
  }

  const githubRepo = context.githubRepo;
  const baseRootPath = String(githubRepo.repoPath || "").replace(/^\/+|\/+$/g, "");
  const rootPathCandidates = [baseRootPath];
  if (!baseRootPath) {
    rootPathCandidates.push(DEFAULT_QUIZ_ROOT);
  } else if (!baseRootPath.toLowerCase().endsWith(`/${DEFAULT_QUIZ_ROOT}`) && baseRootPath.toLowerCase() !== DEFAULT_QUIZ_ROOT) {
    rootPathCandidates.push(`${baseRootPath}/${DEFAULT_QUIZ_ROOT}`);
  }

  for (const rootPath of rootPathCandidates) {
    let rootEntries = [];
    try {
      rootEntries = await readGitHubDirectoryEntries(githubRepo, rootPath);
    } catch (error) {
      continue;
    }

    const categoryFolders = rootEntries
      .filter((entry) => entry && entry.type === "dir")
      .map((entry) => String(entry.name || "").trim())
      .filter((name) => name !== "");

    if (categoryFolders.length === 0) {
      continue;
    }

    const loadedCategories = [];

    for (const folder of categoryFolders) {
      const category = createCategory(categoryNameFromFolder(folder));
      const folderPath = rootPath ? `${rootPath}/${folder}` : folder;
      let folderEntries = [];

      try {
        folderEntries = await readGitHubDirectoryEntries(githubRepo, folderPath);
      } catch (error) {
        continue;
      }

      const jsonFiles = folderEntries.filter((entry) => {
        if (!entry || entry.type !== "file") return false;
        const name = String(entry.name || "").toLowerCase();
        return name.endsWith(".json") && name !== "index.json";
      });

      for (const fileEntry of jsonFiles) {
        const fileName = String(fileEntry.name || "").trim();
        if (!fileName) {
          continue;
        }

        const relativePath = `${folder}/${fileName}`;
        const repoFilePath = rootPath ? `${rootPath}/${relativePath}` : relativePath;
        const quizPath = getGitHubDownloadUrl(fileEntry, githubRepo, repoFilePath);
        const quizResponse = await fetch(quizPath, { cache: "no-store" });
        if (!quizResponse.ok) {
          continue;
        }

        const quizJson = await quizResponse.json();
        const quiz = createQuiz(quizTitleFromFilePath(relativePath));
        quiz.fileName = normalizeQuizFileName(baseNameFromPath(relativePath));
        quiz.sourcePath = quizPath;
        applyLoadedQuizJsonToQuiz(quiz, quizJson);
        quiz.questions = Array.isArray(quizJson.questions) ? quizJson.questions.map(normalizeQuestion) : [];
        category.quizzes.push(quiz);
      }

      if (category.quizzes.length > 0) {
        loadedCategories.push(category);
      }
    }

    if (loadedCategories.length > 0) {
      return loadedCategories;
    }
  }

  throw new Error(`No category folders with quiz files found in ${baseRootPath || "repository root"}`);
}

function baseNameFromPath(path) {
  const normalized = String(path || "").trim().replace(/\\/g, "/");
  if (!normalized) return "quiz.json";
  const parts = normalized.split("/").filter((item) => item !== "");
  return parts.length > 0 ? parts[parts.length - 1] : "quiz.json";
}

function quizTitleFromFilePath(path) {
  return baseNameFromPath(path).replace(/\.json$/i, "") || "Untitled Quiz";
}

function getCategoryFolderName(category) {
  const quiz = (category && Array.isArray(category.quizzes))
    ? category.quizzes.find((item) => item && typeof item.sourcePath === "string" && item.sourcePath.trim() !== "")
    : null;

  if (!quiz || !quiz.sourcePath) {
    return slugify(category && category.name ? category.name : "category");
  }

  const normalizedRoot = `${normalizeRootFolder(state.rootFolder)}/`;
  const normalizedSource = String(quiz.sourcePath).replace(/\\/g, "/");
  const relative = normalizedSource.startsWith(normalizedRoot)
    ? normalizedSource.slice(normalizedRoot.length)
    : normalizedSource;
  const folder = relative.split("/")[0] || "";
  return folder || slugify(category && category.name ? category.name : "category");
}

function supportsFolderDeletion() {
  return typeof window.showDirectoryPicker === "function";
}

async function getRootDirectoryHandle(options = {}) {
  const { allowPrompt = true, promptForPermission = true } = options;

  if (rootDirectoryHandle) {
    const ok = await ensureRootHandlePermission(rootDirectoryHandle, "readwrite");
    if (ok) {
      return rootDirectoryHandle;
    }
    rootDirectoryHandle = null;
  }

  const restoredHandle = await restoreRootDirectoryHandle({ promptForPermission });
  if (restoredHandle) {
    return restoredHandle;
  }

  if (!allowPrompt) {
    return null;
  }

  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  rootDirectoryHandle = handle;
  await saveRootDirectoryHandle(handle);
  return handle;
}

async function getConfiguredRootHandle(options = {}) {
  const { create = false, allowPrompt = true, promptForPermission = true } = options;
  const rootHandle = await getRootDirectoryHandle({ allowPrompt, promptForPermission });
  if (!rootHandle) {
    return null;
  }
  const rootSegments = splitPath(normalizeRootFolder(state.rootFolder));
  if (rootSegments.length === 0) {
    return rootHandle;
  }

  // If the user already selected the effective quiz root folder (for example picked
  // "quizzes" while rootFolder is also "quizzes"), use it directly to avoid nesting.
  const lastRootSegment = rootSegments[rootSegments.length - 1];
  if (normalizeRootSourceMode(state.rootSourceMode) === ROOT_SOURCE_MODES.LOCAL
    && String(rootHandle.name || "").trim().toLowerCase() === String(lastRootSegment || "").trim().toLowerCase()) {
    return rootHandle;
  }

  let cursor = rootHandle;
  try {
    for (const segment of rootSegments) {
      cursor = await cursor.getDirectoryHandle(segment, { create: false });
    }
    return cursor;
  } catch (error) {
    if (!create) {
      return rootHandle;
    }
  }

  cursor = rootHandle;
  for (const segment of rootSegments) {
    cursor = await cursor.getDirectoryHandle(segment, { create: true });
  }
  return cursor;
}

async function connectRootDirectoryHandle() {
  rootDirectoryHandle = null;
  try {
    const selected = await getRootDirectoryHandle();
    await saveRootDirectoryHandle(selected);
    const target = await getConfiguredRootHandle({ create: false });
    const modeText = selected.name === target.name
      ? `using ${selected.name}`
      : `using ${selected.name}/${normalizeRootFolder(state.rootFolder)}`;
    showToast(`Connected root folder (${modeText})`, "success");
    return true;
  } catch (error) {
    if (error && error.name === "AbortError") {
      showToast("Root folder selection canceled.", "info");
      return false;
    }

    await clearSavedRootDirectoryHandle();
    showToast("Could not connect root folder.", "warning");
    return false;
  }
}

async function pathExistsInHandle(rootHandle, relativePath) {
  const parts = String(relativePath || "").split("/").filter((item) => item !== "");
  if (parts.length === 0) {
    return false;
  }

  let directoryHandle = rootHandle;
  const fileName = parts.pop();

  try {
    for (const segment of parts) {
      directoryHandle = await directoryHandle.getDirectoryHandle(segment, { create: false });
    }

    await directoryHandle.getFileHandle(fileName, { create: false });
    return true;
  } catch (error) {
    return false;
  }
}

async function resolveWritableQuizRelativePath(rootHandle, quiz, category) {
  const rootFolder = normalizeRootFolder(state.rootFolder);
  const rawSourcePath = String(quiz.sourcePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const fallbackPath = `${slugify(category.name || "category")}/${normalizeQuizFileName(quiz.fileName || quiz.title || "quiz")}`;
  const candidates = [];

  if (rawSourcePath) {
    const prefix = `${rootFolder}/`;
    if (rawSourcePath.startsWith(prefix)) {
      candidates.push(rawSourcePath.slice(prefix.length));
    } else {
      candidates.push(rawSourcePath);
    }
  }

  candidates.push(fallbackPath);

  const uniqueCandidates = Array.from(new Set(candidates.filter((item) => item && item.includes("/"))));
  for (const candidate of uniqueCandidates) {
    if (await pathExistsInHandle(rootHandle, candidate)) {
      return candidate;
    }
  }

  return rawSourcePath.startsWith(`${rootFolder}/`) ? rawSourcePath.slice(rootFolder.length + 1) : (rawSourcePath || fallbackPath);
}

async function deleteCategoryFolderFromDisk(category) {
  if (!supportsFolderDeletion()) {
    showToast("Category removed in app. Browser cannot auto-delete local folders here.", "warning");
    return;
  }

  const folderName = getCategoryFolderName(category);
  if (!folderName) {
    return;
  }

  try {
    const configuredRoot = await getConfiguredRootHandle({ create: false });
    await configuredRoot.removeEntry(folderName, { recursive: true });
    showToast(`Folder deleted: ${folderName}`, "success");
  } catch (error) {
    if (error && error.name === "AbortError") {
      showToast("Category removed. Folder delete canceled.", "info");
      return;
    }

    if (error && error.name === "NotFoundError") {
      showToast(`Category removed. Folder not found: ${folderName}`, "info");
      return;
    }

    showToast("Category removed. Could not delete folder on disk.", "warning");
  }
}

async function createCategoryFolderOnDisk(category) {
  if (!supportsFolderDeletion()) {
    showToast("Category created in app. Browser cannot auto-create local folders here.", "warning");
    return;
  }

  const folderName = getCategoryFolderName(category);
  if (!folderName) {
    return;
  }

  try {
    const configuredRoot = await getConfiguredRootHandle({ create: true });
    await configuredRoot.getDirectoryHandle(folderName, { create: true });
    showToast(`Folder ready: ${folderName}`, "success");
  } catch (error) {
    if (error && error.name === "AbortError") {
      showToast("Category created. Folder create canceled.", "info");
      return;
    }

    showToast("Category created. Could not create folder on disk.", "warning");
  }
}

async function createStarterQuizFileOnDisk(category, quiz) {
  if (!supportsFolderDeletion()) {
    return;
  }

  if (!category || !quiz) {
    return;
  }

  const folderName = getCategoryFolderName(category);
  const fileName = normalizeQuizFileName(quiz.fileName || quiz.title || "new-quiz");
  const sourcePath = `${normalizeRootFolder(state.rootFolder)}/${folderName}/${fileName}`;

  try {
    const configuredRoot = await getConfiguredRootHandle({ create: true });
    const categoryHandle = await configuredRoot.getDirectoryHandle(folderName, { create: true });
    const fileHandle = await categoryHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();

    const starterPayload = {
      id: slugify(quiz.title || "new-quiz"),
      title: quiz.title || "New Quiz",
      description: normalizeQuizDescription(quiz.description),
      settings: normalizeQuizSettings(quiz.settings),
      category: category.name || "Category",
      questions: Array.isArray(quiz.questions) && quiz.questions.length > 0
        ? quiz.questions.map((item) => ({
          question: item.question || "",
          resultType: item.resultType || "multiple-choice",
          options: Array.isArray(item.options) ? item.options : ["", "", "", ""],
          correctAnswer: item.correctAnswer || "",
          notesAttachments: Array.isArray(item.notesAttachments) ? item.notesAttachments : [],
          image: item.image || "",
          solution: item.solution || "",
          solutionAttachments: Array.isArray(item.solutionAttachments) ? item.solutionAttachments : []
        }))
        : [createEmptyQuestion()]
    };

    await writable.write(`${JSON.stringify(starterPayload, null, 2)}\n`);
    await writable.close();

    quiz.fileName = fileName;
    quiz.sourcePath = sourcePath;
    showToast(`Starter quiz file created: ${folderName}/${fileName}`, "success");
  } catch (error) {
    if (error && error.name === "AbortError") {
      showToast("Category created. Starter quiz file create canceled.", "info");
      return;
    }

    showToast("Category created. Could not create starter quiz file.", "warning");
  }
}

function categoryNameFromFolder(folderName) {
  return String(folderName || "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || "Category";
}

function categorySortRank(name) {
  const normalized = String(name || "").trim().toLowerCase();
  if (/^prep\b/.test(normalized)) return 0;
  if (/^grade\b/.test(normalized)) return 1;
  if (/^year\b/.test(normalized)) return 2;
  if (/^vce\b/.test(normalized)) return 3;
  return 4;
}

function sortCategoriesForDisplay(categories) {
  const list = Array.isArray(categories) ? categories.slice() : [];
  list.sort((a, b) => {
    const leftName = String(a && a.name ? a.name : "").trim();
    const rightName = String(b && b.name ? b.name : "").trim();
    const rankDiff = categorySortRank(leftName) - categorySortRank(rightName);
    if (rankDiff !== 0) return rankDiff;
    return leftName.localeCompare(rightName, undefined, { sensitivity: "base", numeric: true });
  });
  return list;
}

function extractDirectoryEntries(html, responseUrl) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(String(html || ""), "text/html");
  const baseUrl = new URL(responseUrl, window.location.href);
  const basePath = baseUrl.pathname.endsWith("/") ? baseUrl.pathname : `${baseUrl.pathname}/`;
  const folders = new Set();
  const jsonFiles = new Set();

  Array.from(doc.querySelectorAll("a[href]")).forEach((link) => {
    const href = String(link.getAttribute("href") || "").trim();
    if (!href || href.startsWith("#") || href.startsWith("?")) {
      return;
    }

    let resolved;
    try {
      resolved = new URL(href, baseUrl.toString());
    } catch (error) {
      return;
    }

    let relativePath = decodeURIComponent(resolved.pathname);
    if (relativePath.startsWith(basePath)) {
      relativePath = relativePath.slice(basePath.length);
    }

    relativePath = relativePath.replace(/^\/+/, "");
    if (!relativePath || relativePath.startsWith("..")) {
      return;
    }

    if (relativePath.endsWith("/")) {
      const folder = relativePath.replace(/\/+$/, "").split("/")[0];
      if (folder) {
        folders.add(folder);
      }
      return;
    }

    if (relativePath.toLowerCase().endsWith(".json")) {
      jsonFiles.add(relativePath);
    }
  });

  return {
    folders: Array.from(folders),
    jsonFiles: Array.from(jsonFiles)
  };
}

async function readDirectoryEntries(folderPath) {
  const normalizedFolder = normalizeRootFolder(folderPath);
  const response = await fetch(`${normalizedFolder}/`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Could not read ${normalizedFolder}/`);
  }

  const html = await response.text();
  return extractDirectoryEntries(html, response.url);
}

async function readJsonFromFileHandle(fileHandle) {
  const file = await fileHandle.getFile();
  const text = await file.text();
  return JSON.parse(text);
}

async function getFileHandleByRelativePath(rootHandle, relativePath) {
  const parts = String(relativePath || "").replace(/\\/g, "/").split("/").filter((item) => item !== "");
  if (parts.length === 0) {
    throw new Error("Invalid relative file path.");
  }

  const fileName = parts.pop();
  let directoryHandle = rootHandle;
  for (const segment of parts) {
    directoryHandle = await directoryHandle.getDirectoryHandle(segment, { create: false });
  }

  return directoryHandle.getFileHandle(fileName, { create: false });
}

async function listDirectoryEntriesFromHandle(directoryHandle) {
  const folders = [];
  const files = [];

  // The picker-backed handle supports async iteration across child entries.
  for await (const [name, handle] of directoryHandle.entries()) {
    if (handle.kind === "directory") {
      folders.push(name);
      continue;
    }

    if (handle.kind === "file") {
      files.push(name);
    }
  }

  return { folders, files };
}

async function loadLibraryFromHandleCategoryFolders(rootHandle, rootFolder) {
  const rootEntries = await listDirectoryEntriesFromHandle(rootHandle);
  if (!Array.isArray(rootEntries.folders) || rootEntries.folders.length === 0) {
    throw new Error(`No category folders found in ${rootFolder}/`);
  }

  const loadedCategories = [];

  for (const folder of rootEntries.folders) {
    const category = createCategory(categoryNameFromFolder(folder));
    let categoryHandle;

    try {
      categoryHandle = await rootHandle.getDirectoryHandle(folder, { create: false });
    } catch (error) {
      loadedCategories.push(category);
      continue;
    }

    const categoryEntries = await listDirectoryEntriesFromHandle(categoryHandle);
    const jsonFiles = (categoryEntries.files || []).filter((name) => String(name || "").toLowerCase().endsWith(".json"));

    for (const fileName of jsonFiles) {
      let quizJson;
      try {
        const fileHandle = await categoryHandle.getFileHandle(fileName, { create: false });
        quizJson = await readJsonFromFileHandle(fileHandle);
      } catch (error) {
        continue;
      }

      const relativePath = `${folder}/${fileName}`;
      const quiz = createQuiz(quizTitleFromFilePath(relativePath));
      quiz.fileName = normalizeQuizFileName(baseNameFromPath(relativePath));
      quiz.sourcePath = `${rootFolder}/${relativePath}`;
      applyLoadedQuizJsonToQuiz(quiz, quizJson);
      quiz.questions = Array.isArray(quizJson.questions) ? quizJson.questions.map(normalizeQuestion) : [];
      category.quizzes.push(quiz);
    }

    loadedCategories.push(category);
  }

  return loadedCategories;
}

async function loadLibraryFromHandleManifest(rootHandle, rootFolder) {
  let indexHandle;
  try {
    indexHandle = await rootHandle.getFileHandle("index.json", { create: false });
  } catch (error) {
    throw new Error(`Could not read ${rootFolder}/index.json`);
  }

  const manifest = await readJsonFromFileHandle(indexHandle);
  if (!manifest || !Array.isArray(manifest.categories)) {
    throw new Error(`Invalid ${rootFolder}/index.json`);
  }

  const loadedCategories = [];

  for (const categoryInfo of manifest.categories) {
    const category = createCategory(categoryInfo.name || "Category");
    const quizEntries = Array.isArray(categoryInfo.quizzes) ? categoryInfo.quizzes : [];

    for (const entry of quizEntries) {
      const relativePath = String(entry.file || "").trim().replace(/^\/+/, "");
      if (!relativePath) {
        continue;
      }

      let quizJson;
      try {
        const fileHandle = await getFileHandleByRelativePath(rootHandle, relativePath);
        quizJson = await readJsonFromFileHandle(fileHandle);
      } catch (error) {
        continue;
      }

      const quiz = createQuiz(quizTitleFromFilePath(relativePath));
      quiz.fileName = normalizeQuizFileName(baseNameFromPath(relativePath));
      quiz.sourcePath = `${rootFolder}/${relativePath}`;
      applyLoadedQuizJsonToQuiz(quiz, quizJson);
      quiz.questions = Array.isArray(quizJson.questions) ? quizJson.questions.map(normalizeQuestion) : [];
      category.quizzes.push(quiz);
    }

    loadedCategories.push(category);
  }

  return loadedCategories;
}

async function loadLibraryFromCategoryFolders(rootFolder) {
  const rootEntries = await readDirectoryEntries(rootFolder);
  if (!Array.isArray(rootEntries.folders) || rootEntries.folders.length === 0) {
    throw new Error(`No category folders found in ${rootFolder}/`);
  }

  const loadedCategories = [];

  for (const folder of rootEntries.folders) {
    const category = createCategory(categoryNameFromFolder(folder));
    const folderEntries = await readDirectoryEntries(`${rootFolder}/${folder}`);
    const jsonFiles = (folderEntries.jsonFiles || []).filter((entry) => entry.toLowerCase().endsWith(".json"));

    for (const fileEntry of jsonFiles) {
      const relativeFilePath = fileEntry.includes("/") ? fileEntry : `${folder}/${fileEntry}`;
      const quizResponse = await fetch(`${rootFolder}/${relativeFilePath}`, { cache: "no-store" });
      if (!quizResponse.ok) {
        continue;
      }

      const quizJson = await quizResponse.json();
      const quiz = createQuiz(quizTitleFromFilePath(relativeFilePath));
      quiz.fileName = normalizeQuizFileName(baseNameFromPath(relativeFilePath));
      quiz.sourcePath = `${rootFolder}/${relativeFilePath}`;
      applyLoadedQuizJsonToQuiz(quiz, quizJson);
      quiz.questions = Array.isArray(quizJson.questions) ? quizJson.questions.map(normalizeQuestion) : [];
      category.quizzes.push(quiz);
    }

    if (category.quizzes.length > 0) {
      loadedCategories.push(category);
    }
  }

  if (loadedCategories.length === 0) {
    throw new Error(`No quiz JSON files found in ${rootFolder}/`);
  }

  return loadedCategories;
}

function pickInitialSelection(categories) {
  if (!Array.isArray(categories) || categories.length === 0) {
    return {
      categoryId: null,
      quizId: null,
      questionIndex: -1
    };
  }

  const firstCategoryWithQuiz = categories.find((category) => Array.isArray(category.quizzes) && category.quizzes.length > 0);
  const selectedCategory = firstCategoryWithQuiz || categories[0];
  const selectedQuiz = selectedCategory && Array.isArray(selectedCategory.quizzes)
    ? selectedCategory.quizzes[0] || null
    : null;

  return {
    categoryId: selectedCategory ? selectedCategory.id : null,
    quizId: selectedQuiz ? selectedQuiz.id : null,
    questionIndex: selectedQuiz && Array.isArray(selectedQuiz.questions) && selectedQuiz.questions.length > 0 ? 0 : -1
  };
}

async function loadLibraryFromManifest(context) {
  const indexPath = joinPath(context.fetchBase, "index.json");
  const response = await fetch(indexPath, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`Could not read ${indexPath}`);
  }

  const manifest = await response.json();
  if (!manifest || !Array.isArray(manifest.categories)) {
    throw new Error(`Invalid ${indexPath}`);
  }

  const loadedCategories = [];

  for (const categoryInfo of manifest.categories) {
    const category = createCategory(categoryInfo.name || "Category");
    const quizEntries = Array.isArray(categoryInfo.quizzes) ? categoryInfo.quizzes : [];

    for (const entry of quizEntries) {
      const relativePath = String(entry.file || "").trim().replace(/^\/+/, "");
      if (!relativePath) {
        continue;
      }

      const quizPath = joinPath(context.fetchBase, relativePath);
      const quizResponse = await fetch(quizPath, { cache: "no-store" });
      if (!quizResponse.ok) {
        continue;
      }

      const quizJson = await quizResponse.json();
      const quiz = createQuiz(quizTitleFromFilePath(relativePath));
      quiz.fileName = normalizeQuizFileName(baseNameFromPath(relativePath));
      quiz.sourcePath = quizPath;
      applyLoadedQuizJsonToQuiz(quiz, quizJson);
      quiz.questions = Array.isArray(quizJson.questions) ? quizJson.questions.map(normalizeQuestion) : [];
      category.quizzes.push(quiz);
    }

    if (category.quizzes.length > 0) {
      loadedCategories.push(category);
    }
  }

  if (loadedCategories.length === 0) {
    throw new Error(`No quizzes found in ${indexPath}`);
  }

  return loadedCategories;
}

function setRootStatus(message) {
  const status = document.getElementById("rootStatusText");
  if (!status) return;
  status.textContent = message;
}

function updateLocalFolderRowVisibility() {
  const row = document.getElementById("localFolderRow");
  if (!row) return;
  const isLocalMode = normalizeRootSourceMode(state.rootSourceMode) === ROOT_SOURCE_MODES.LOCAL;
  row.style.display = isLocalMode ? "flex" : "none";

  if (!isLocalMode) {
    const field = document.getElementById("localFolderPath");
    if (field) {
      field.value = "";
    }
  }
}

function resolveLocalFolderDisplayPath(handleOrName) {
  if (!handleOrName) return "";

  if (typeof handleOrName === "string") {
    return handleOrName;
  }

  // Some runtimes expose full path metadata (non-standard). Use it when available.
  if (typeof handleOrName.path === "string" && handleOrName.path.trim() !== "") {
    return handleOrName.path;
  }

  if (typeof handleOrName.fullPath === "string" && handleOrName.fullPath.trim() !== "") {
    return handleOrName.fullPath;
  }

  if (typeof handleOrName.name === "string" && handleOrName.name.trim() !== "") {
    return handleOrName.name;
  }

  return "";
}

function setLocalFolderPath(handleOrName) {
  const field = document.getElementById("localFolderPath");
  if (!field) return;

  const displayPath = resolveLocalFolderDisplayPath(handleOrName);
  const isDirectoryHandle = typeof handleOrName === "object" && handleOrName !== null;
  const hasFullPathMetadata = Boolean(
    isDirectoryHandle
    && ((typeof handleOrName.path === "string" && handleOrName.path.trim() !== "")
      || (typeof handleOrName.fullPath === "string" && handleOrName.fullPath.trim() !== ""))
  );

  if (isDirectoryHandle && !hasFullPathMetadata && displayPath) {
    field.value = `${displayPath} (full path hidden by browser security)`;
    field.title = "Full local paths are not exposed to regular web pages.";
    return;
  }

  field.value = displayPath;
  field.title = displayPath || "";
}

async function loadLibraryFromRoot({ allowPrompt = true } = {}) {
  const rootFolder = normalizeRootFolder(state.rootFolder);
  let context = resolveRootFetchContext(rootFolder);
  const rootSourceMode = normalizeRootSourceMode(state.rootSourceMode);

  console.log("[loadLibraryFromRoot] rootFolder:", rootFolder, "rootSourceMode:", rootSourceMode);
  console.log("[loadLibraryFromRoot] Initial context:", { githubRepo: context.githubRepo ? "present" : "null", supportsDirectoryScan: context.supportsDirectoryScan });

  let loadedCategories = [];
  let sourceMode = "manifest";

  if (rootSourceMode === ROOT_SOURCE_MODES.GITHUB) {
    console.log("[loadLibraryFromRoot] Entering GITHUB mode block");
    if (!context.githubRepo) {
      const inferred = inferGithubContextFromPages(rootFolder);
      if (inferred) {
        context = inferred;
      }
    }

    if (!context.githubRepo) {
      throw new Error("GitHub mode requires a GitHub URL, or running on a github.io site with a repo root like quizzes.");
    }

    try {
      loadedCategories = await loadLibraryFromGithubFolders(context);
      sourceMode = "github-folder-scan";
    } catch (githubScanError) {
      console.log("[loadLibraryFromRoot] GitHub API scan failed, trying CDN fallback: ", githubScanError.message);
      try {
        loadedCategories = await loadLibraryFromGithubFlatIndex(context);
        sourceMode = "github-flat-scan";
      } catch (cdnScanError) {
        console.error("[loadLibraryFromRoot] Both GitHub API and CDN fallback failed");
        throw new Error(`Could not read category folders from GitHub root: ${state.rootFolder}`);
      }
    }
  } else if (rootSourceMode === ROOT_SOURCE_MODES.LOCAL) {
    if (isHttpUrl(rootFolder)) {
      throw new Error("Local mode expects a local path like quizzes, not an http URL.");
    }

    // 1) Try direct category folder scan from root path first (works on HTTP/local servers).
    if (loadedCategories.length === 0) {
      try {
        loadedCategories = await loadLibraryFromCategoryFolders(rootFolder);
        sourceMode = "folder-scan";
      } catch (folderScanError) {
        // Continue to handle-based and manifest fallbacks.
      }
    }

    // 2) Try saved folder handle before prompting.
    if (loadedCategories.length === 0 && supportsFolderDeletion()) {
      try {
        const savedRoot = await getConfiguredRootHandle({ create: false, allowPrompt: false });
        if (savedRoot) {
          loadedCategories = await loadLibraryFromHandleCategoryFolders(savedRoot, rootFolder);
          sourceMode = "handle-folder-scan";
          setLocalFolderPath(savedRoot);
        }
      } catch (savedHandleError) {
        console.warn("[LOCAL] Saved handle failed:", savedHandleError.message);
      }
    }

    // 3) Prompt picker only when user-triggered refresh asks for it.
    if (loadedCategories.length === 0 && supportsFolderDeletion() && allowPrompt) {
      try {
        const freshHandle = await window.showDirectoryPicker({ mode: "readwrite" });
        rootDirectoryHandle = freshHandle;
        await saveRootDirectoryHandle(freshHandle);
        loadedCategories = await loadLibraryFromHandleCategoryFolders(freshHandle, freshHandle.name);
        sourceMode = "handle-folder-scan";
        setLocalFolderPath(freshHandle);
      } catch (pickerError) {
        if (pickerError && pickerError.name !== "AbortError") {
          console.error("[LOCAL] Folder scan after picker failed:", pickerError.message);
          throw new Error(`Could not read category folders from selected folder: ${pickerError.message}`);
        }
        // Picker canceled: continue to manifest fallback.
      }
    }

    // 4) Fallback: manifest (index.json)
    if (loadedCategories.length === 0) {
      try {
        const indexPath = `${rootFolder}/index.json`;
        const response = await fetch(indexPath, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Could not read ${indexPath}`);
        }
        const manifest = await response.json();
        if (!manifest || !Array.isArray(manifest.categories)) {
          throw new Error(`Invalid ${rootFolder}/index.json`);
        }
        loadedCategories = await loadLibraryFromManifest({ fetchBase: rootFolder });
        sourceMode = "manifest";
      } catch (manifestError) {
        throw new Error(`Could not read category folders from local root: ${state.rootFolder}. Select a folder or ensure index.json exists.`);
      }
    }
  } else {
    throw new Error("Unknown root source mode. Please select Local or GitHub.");
  }

  const orderedCategories = sortCategoriesForDisplay(loadedCategories);
  state.categories = orderedCategories;
  state.rootFolder = rootFolder;
  const initialSelection = pickInitialSelection(orderedCategories);
  state.selectedCategoryId = initialSelection.categoryId;
  state.selectedQuizId = initialSelection.quizId;
  state.selectedQuestionIndex = initialSelection.questionIndex;
  ensureQuizFileNames();
  return sourceMode;
}

async function refreshLibraryFromRoot(notify = true, allowPrompt = true) {
  const rootInput = document.getElementById("quizRootFolder");
  const rootSourceModeInput = document.getElementById("rootSourceMode");
  if (rootInput) {
    state.rootFolder = normalizeRootFolder(rootInput.value);
    rootInput.value = state.rootFolder;
  }
  if (rootSourceModeInput) {
    state.rootSourceMode = normalizeRootSourceMode(rootSourceModeInput.value);
    rootSourceModeInput.value = state.rootSourceMode;
  }

  try {
    const sourceMode = await loadLibraryFromRoot({ allowPrompt });
    renderAll();
    const sourceText = sourceMode === "github-folder-scan"
      ? `Source: auto-detected from GitHub category folders in ${state.rootFolder}`
      : sourceMode === "github-flat-scan"
        ? `Source: auto-detected from GitHub file index in ${state.rootFolder}`
      : sourceMode === "folder-scan"
        ? `Source: auto-detected from category folders in ${state.rootFolder}/`
        : sourceMode === "handle-folder-scan"
          ? `Source: auto-detected from local selected folder in ${state.rootFolder}/`
          : sourceMode === "handle-manifest"
            ? `Source: auto-detected from local selected folder manifest ${state.rootFolder}/index.json`
        : `Source: auto-detected from ${state.rootFolder}/index.json`;
    setRootStatus(sourceText);
    if (notify) {
      showToast("Root library detected and loaded.", "success");
    }
    return true;
  } catch (error) {
    setRootStatus(`Source: could not load categories from ${state.rootFolder} (folder scan and index.json fallback failed)`);
    if (notify) {
      showToast(String(error.message || "Could not load root library."), "warning");
    }
    return false;
  }
}

function getSelectedQuizFileName() {
  const selectedQuiz = activeQuiz();
  if (!selectedQuiz) {
    return "quiz.json";
  }

  return selectedQuiz.fileName || normalizeQuizFileName(selectedQuiz.title);
}

function getQuestionValidationIssues(question) {
  const issues = [];
  const resultType = normalizeResultType(question.resultType || "multiple-choice");
  const interactiveType = String(question && question.interactiveApp && question.interactiveApp.type || "").trim().toLowerCase();
  const interactiveConfig = question && question.interactiveApp && question.interactiveApp.config && typeof question.interactiveApp.config === "object"
    ? question.interactiveApp.config
    : {};
  const isCartesianPlotQuestion = Boolean(
    question
    && question.interactiveApp
    && question.interactiveApp.type === "cartesian-plane-plot"
  );
  const optionValues = Array.isArray(question.options) ? question.options.map((item) => String(item || "").trim()) : [];
  const choiceOptions = optionValues.filter((item) => item !== "");
  const answerValue = String(question.correctAnswer || "").trim();

  if (!String(question.question || "").trim()) {
    issues.push("Question text is required.");
  }

  if (interactiveType) {
    const supportedInteractiveTypes = new Set([
      "cartesian-plane-plot",
      "cartesian-plane",
      "time",
      "arithmetic",
      "fractions",
      "number-tracing",
      "number-ordering",
      "icon-count",
      "matrix"
    ]);
    if (!supportedInteractiveTypes.has(interactiveType)) {
      issues.push(`Viewer compatibility: interactive app type "${interactiveType}" is not supported by viewer answer validation.`);
    }

    const requiresShortAnswerTypes = new Set([
      "icon-count",
      "number-ordering",
      "number-tracing",
      "arithmetic",
      "fractions",
      "matrix"
    ]);
    if (requiresShortAnswerTypes.has(interactiveType) && resultType !== "short-answer") {
      issues.push(`Viewer compatibility: result type should be short-answer for interactive type "${interactiveType}".`);
    }

    if (interactiveType === "time") {
      const timeMode = String(interactiveConfig.mode || "").trim().toLowerCase();
      if (timeMode === "analog-to-digital") {
        if (!["multiple-choice", "checkbox", "true-false"].includes(resultType)) {
          issues.push("Viewer compatibility: time mode analog-to-digital requires a choice result type (multiple-choice, checkbox, or true-false).");
        }
      } else if (["multiple-choice", "checkbox", "true-false"].includes(resultType)) {
        issues.push("Viewer compatibility: time analog/digital mode should use short-answer result type.");
      }
    }

    if (interactiveType === "cartesian-plane-plot" && resultType !== "plot") {
      issues.push("Viewer compatibility: result type should be plot for Cartesian Plane - Plot questions.");
    }
  }

  if (!isCartesianPlotQuestion && ["multiple-choice", "checkbox", "true-false"].includes(resultType) && choiceOptions.length < 2) {
    issues.push("At least two options are required for this result type.");
  }

  if (isCartesianPlotQuestion) {
    const answerPoints = Array.isArray(question.interactiveApp && question.interactiveApp.config && question.interactiveApp.config.points)
      ? question.interactiveApp.config.points
      : [];
    if (answerPoints.length === 0) {
      issues.push("Cartesian Plane - Plot requires at least one answer point.");
    }
  } else if (!answerValue) {
    issues.push("Correct answer is required.");
  } else if (["multiple-choice", "true-false"].includes(resultType)) {
    const matchesChoice = choiceOptions.some((item) => normalizeText(item) === normalizeText(answerValue));
    if (!matchesChoice) {
      issues.push("Correct answer must match one option exactly.");
    }
  } else if (resultType === "date") {
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(answerValue)) {
      issues.push("Date correct answer must be in DD/MM/YYYY format.");
    }
  } else if (resultType === "checkbox") {
    const answers = answerValue.split(",").map((item) => item.trim()).filter((item) => item !== "");
    const invalid = answers.some((item) => !choiceOptions.some((option) => normalizeText(option) === normalizeText(item)));
    if (answers.length === 0 || invalid) {
      issues.push("Checkbox correct answer must be one or more comma-separated options.");
    }
  }

  return issues;
}

function renderValidationBox(question) {
  const box = document.getElementById("questionValidationBox");
  if (!question) {
    box.innerHTML = "<p class='helper-text'>Select a question to see validation.</p>";
    return;
  }

  const issues = getQuestionValidationIssues(question);
  if (issues.length === 0) {
    box.innerHTML = "<p class='validation-ok'>Ready to publish.</p>";
    return;
  }

  box.innerHTML = `
    <p class="validation-title">Needs attention:</p>
    <ul class="validation-list">
      ${issues.map((item) => `<li>${item}</li>`).join("")}
    </ul>
  `;
}

function ensureSelection() {
  if (state.categories.length === 0) {
    state.selectedCategoryId = null;
    state.selectedQuizId = null;
    state.selectedQuestionIndex = -1;
    return;
  }

  if (!state.categories.some((item) => item.id === state.selectedCategoryId)) {
    state.selectedCategoryId = state.categories[0].id;
  }

  const category = activeCategory();
  if (!category) return;

  if (!category.quizzes.some((item) => item.id === state.selectedQuizId)) {
    state.selectedQuizId = category.quizzes[0] ? category.quizzes[0].id : null;
  }

  const quiz = activeQuiz();
  if (!quiz) {
    state.selectedQuestionIndex = -1;
    return;
  }

  const createdDefaultQuestion = ensureQuizHasDefaultQuestion(quiz);
  if (createdDefaultQuestion && state.selectedQuestionIndex < 0) {
    state.selectedQuestionIndex = 0;
  }

  if (state.selectedQuestionIndex >= quiz.questions.length) {
    state.selectedQuestionIndex = quiz.questions.length - 1;
  }

  if (quiz.questions.length === 0) {
    state.selectedQuestionIndex = -1;
  }
}

function renderCategoryList() {
  const host = document.getElementById("categoryList");
  host.innerHTML = "";

  if (state.categories.length === 0) {
    host.innerHTML = "<p class='helper-text'>No categories yet.</p>";
    return;
  }

  const searchInput = document.getElementById("categorySearch");
  const term = searchInput ? searchInput.value.trim().toLowerCase() : "";
  const filtered = term
    ? state.categories.filter((category) => category.name.toLowerCase().includes(term))
    : state.categories;

  if (filtered.length === 0) {
    host.innerHTML = "<p class='helper-text'>No categories match.</p>";
    return;
  }

  filtered.forEach((category) => {
    const row = document.createElement("div");
    row.className = `list-item ${category.id === state.selectedCategoryId ? "active" : ""}`;
    row.innerHTML = `
      <button class="list-main" data-id="${category.id}" type="button">${category.name}</button>
      <button class="icon-btn danger" data-action="delete" data-id="${category.id}" type="button">x</button>
    `;
    host.appendChild(row);
  });
}

function renderQuizList() {
  const host = document.getElementById("quizList");
  host.innerHTML = "";

  const category = activeCategory();
  if (!category) {
    host.innerHTML = "<p class='helper-text'>Select a category first.</p>";
    return;
  }

  if (category.quizzes.length === 0) {
    host.innerHTML = "<p class='helper-text'>No quizzes yet.</p>";
    return;
  }

  const searchInput = document.getElementById("quizSearch");
  const term = searchInput ? searchInput.value.trim().toLowerCase() : "";
  const filtered = term
    ? category.quizzes.filter((quiz) => quiz.title.toLowerCase().includes(term))
    : category.quizzes;

  if (filtered.length === 0) {
    host.innerHTML = "<p class='helper-text'>No quizzes match.</p>";
    return;
  }

  filtered.forEach((quiz) => {
    const issueCount = getQuizValidationIssueCount(quiz);
    const isIssueHighlight = state.quizScanEnabled && issueCount > 0;
    const row = document.createElement("div");
    row.className = `list-item ${quiz.id === state.selectedQuizId ? "active" : ""} ${isIssueHighlight ? "issue-scan-hit" : ""}`.trim();
    const scanBadge = state.quizScanEnabled
      ? `<span class="status-chip ${issueCount === 0 ? "ok" : "warn"}">${issueCount === 0 ? "No issues" : `${issueCount} issue${issueCount === 1 ? "" : "s"}`}</span>`
      : "";
    row.innerHTML = `
      <button class="list-main" data-id="${quiz.id}" type="button">${quiz.title}</button>
      ${scanBadge}
      <button class="icon-btn secondary" data-action="settings" data-id="${quiz.id}" type="button">Settings</button>
      <button class="icon-btn secondary" data-action="replicate" data-id="${quiz.id}" type="button">Replicate</button>
      <button class="icon-btn secondary" data-action="auto" data-id="${quiz.id}" type="button">Auto</button>
      <button class="icon-btn danger" data-action="delete" data-id="${quiz.id}" type="button">x</button>
    `;
    host.appendChild(row);
  });
}

function buildQuizViewerUrl(quizId) {
  const category = activeCategory();
  if (!category) return null;
  const quiz = category.quizzes.find((item) => item.id === quizId);
  if (!quiz) return null;

  const fileName = quiz.sourcePath || quiz.fileName || normalizeQuizFileName(quiz.title);
  const viewerUrl = new URL("viewer.html", window.location.href);
  viewerUrl.searchParams.set("file", fileName);

  return viewerUrl;
}

function buildQuizIframeCode(quizId) {
  const viewerUrl = buildQuizViewerUrl(quizId);
  if (!viewerUrl) return "";

  return `<iframe src="${viewerUrl.toString()}" width="100%" height="640" style="border:0;" loading="lazy" allowfullscreen></iframe>`;
}

function buildQuizLinkCode(quizId) {
  const viewerUrl = buildQuizViewerUrl(quizId);
  return viewerUrl ? viewerUrl.toString() : "";
}

function getSelectedEmbedFormat() {
  const select = document.getElementById("embedFormatSelect");
  if (!(select instanceof HTMLSelectElement)) {
    return "iframe";
  }

  return select.value === "link" ? "link" : "iframe";
}

function buildEmbedCodeForQuiz(quizId, format) {
  return format === "link" ? buildQuizLinkCode(quizId) : buildQuizIframeCode(quizId);
}

function updateEmbedOutputForActiveQuiz() {
  const output = document.getElementById("iframeCodeOutput");
  if (!(output instanceof HTMLTextAreaElement)) return;

  const quiz = activeQuiz();
  if (!quiz) {
    output.value = "";
    return;
  }

  const format = getSelectedEmbedFormat();
  output.value = buildEmbedCodeForQuiz(quiz.id, format);
}

async function generateAndCopyEmbedCode(quizId) {
  const format = getSelectedEmbedFormat();

  const code = buildEmbedCodeForQuiz(quizId, format);
  if (!code) {
    showToast("Could not generate code.", "error");
    return;
  }

  const output = document.getElementById("iframeCodeOutput");
  output.value = code;

  try {
    await navigator.clipboard.writeText(code);
    showToast(`${format === "link" ? "Link" : "Iframe"} copied.`, "success");
  } catch (error) {
    showToast("Could not copy code.", "error");
  }
}

function renderQuestionsList() {
  const host = document.getElementById("questionsList");
  host.innerHTML = "";

  const quiz = activeQuiz();
  if (!quiz) {
    host.innerHTML = "<p class='helper-text'>Select a quiz first.</p>";
    return;
  }

  if (quiz.questions.length === 0) {
    host.innerHTML = "<p class='helper-text'>No questions yet.</p>";
    return;
  }

  const searchInput = document.getElementById("questionSearch");
  const term = searchInput ? searchInput.value.trim().toLowerCase() : "";

  quiz.questions.forEach((item, index) => {
    const title = item.question || `Untitled Question ${index + 1}`;
    if (term && !title.toLowerCase().includes(term)) {
      return;
    }

    const issues = getQuestionValidationIssues(item);
    const badgeClass = issues.length === 0 ? "status-chip ok" : "status-chip warn";
    const badgeText = issues.length === 0 ? "Ready" : `${issues.length} issue${issues.length === 1 ? "" : "s"}`;
    const row = document.createElement("div");
    const isIssueHighlight = state.quizScanEnabled && issues.length > 0;
    row.className = `list-item ${index === state.selectedQuestionIndex ? "active" : ""} ${isIssueHighlight ? "issue-scan-hit" : ""}`.trim();
    row.draggable = true;
    row.dataset.dragIndex = String(index);
    row.dataset.questionIndex = String(index);
    row.innerHTML = `
      <button class="list-main" data-index="${index}" type="button">Q${index + 1}: ${title}</button>
      <span class="${badgeClass}">${badgeText}</span>
      <button class="icon-btn danger" data-action="delete" data-index="${index}" type="button">x</button>
    `;
    host.appendChild(row);
  });

  if (host.children.length === 0) {
    host.innerHTML = "<p class='helper-text'>No questions match.</p>";
  }
}

function renderQuizScanToggle() {
  const btn = document.getElementById("toggleQuizScanBtn");
  if (!(btn instanceof HTMLButtonElement)) return;

  btn.classList.toggle("is-active", state.quizScanEnabled);
  btn.setAttribute("aria-pressed", state.quizScanEnabled ? "true" : "false");
}

function toggleOptionsBlock(question) {
  const isChoiceType = question && ["multiple-choice", "checkbox", "true-false"].includes(getEditorResultType(question));
  document.getElementById("optionsBlock").style.display = isChoiceType ? "block" : "none";
}

function ensureTrueFalseOptions(question) {
  if (!question) return;
  if ((question.resultType || "multiple-choice") !== "true-false") return;
  question.options = ["True", "False", "", ""];
}

function getChoiceOptions(question) {
  if (!question) return [];
  const options = Array.isArray(question.options) ? question.options : [];
  return options.map((item) => String(item || "").trim()).filter((item) => item !== "");
}

function getEditorResultType(question) {
  const resultType = normalizeResultType(question && question.resultType);
  const choiceOptions = getChoiceOptions(question);
  if (resultType === "short-answer" && choiceOptions.length > 0) {
    return String(question && question.correctAnswer || "").includes(",") ? "checkbox" : "multiple-choice";
  }
  return resultType;
}

function ensureDefaultCorrectAnswer(question) {
  if (!question) return;

  const resultType = question.resultType || "multiple-choice";
  if (resultType === "true-false") {
    ensureTrueFalseOptions(question);
  }

  if (!["multiple-choice", "true-false"].includes(resultType)) {
    return;
  }

  const choiceOptions = getChoiceOptions(question);
  if (choiceOptions.length === 0) {
    question.correctAnswer = "";
    return;
  }

  const isValidAnswer = choiceOptions.some((item) => normalizeText(item) === normalizeText(question.correctAnswer));
  if (!isValidAnswer) {
    question.correctAnswer = choiceOptions[0];
  }
}

// ── Interactive App helpers ────────────────────────────────────────────────

function escapeInteractiveHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function safeInteractiveColor(value, fallback = "#2563eb") {
  return /^#[0-9a-fA-F]{3,6}$/.test(String(value || "").trim()) ? String(value).trim() : fallback;
}

function parseLineList(text) {
  return String(text || "").split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

function splitCsvLine(line) {
  return String(line || "").split(",").map((part) => part.trim());
}

function parseNlPoints(text) {
  return parseLineList(text)
    .map((line) => {
      const parts = splitCsvLine(line);
      const value = Number.parseFloat(parts[0]);
      if (!Number.isFinite(value)) return null;
      return { value, label: parts[1] || "", color: parts[2] || "#2563eb" };
    })
    .filter(Boolean);
}

function parseNlArrows(text) {
  return parseLineList(text)
    .map((line) => {
      const match = line.match(/^(-?\d+(?:\.\d+)?)\s*(?:→|->|to)\s*(-?\d+(?:\.\d+)?)\s*(?:,\s*(.+))?$/i);
      if (!match) return null;
      return { from: Number.parseFloat(match[1]), to: Number.parseFloat(match[2]), label: match[3] ? match[3].trim() : "" };
    })
    .filter(Boolean);
}

function parseCartesianPoints(text) {
  return parseLineList(text)
    .map((line) => {
      const parts = splitCsvLine(line);
      const x = Number.parseFloat(parts[0]);
      const y = Number.parseFloat(parts[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x, y, label: parts[2] || "", color: parts[3] || "#2563eb" };
    })
    .filter(Boolean);
}

function parseCartesianSegments(text) {
  return parseLineList(text)
    .map((line) => {
      const parts = line.split(/(?:→|->)/);
      if (parts.length !== 2) return null;
      const left = splitCsvLine(parts[0]);
      const right = splitCsvLine(parts[1]);
      const x1 = Number.parseFloat(left[0]);
      const y1 = Number.parseFloat(left[1]);
      const x2 = Number.parseFloat(right[0]);
      const y2 = Number.parseFloat(right[1]);
      if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
      return { x1, y1, x2, y2, label: right[2] || "", color: right[3] || "#f59e0b" };
    })
    .filter(Boolean);
}

function parseCartesianParabolas(text) {
  return parseLineList(text)
    .map((line) => {
      const parts = splitCsvLine(line);
      if (parts.length < 3) return null;
      const a = Number.parseFloat(parts[0]);
      const b = Number.parseFloat(parts[1]);
      const c = Number.parseFloat(parts[2]);
      if (![a, b, c].every(Number.isFinite)) return null;
      return {
        a,
        b,
        c,
        label: parts[3] || "",
        color: parts[4] || "#7c3aed"
      };
    })
    .filter(Boolean);
}

function parseCartesianFunctions(text) {
  return parseLineList(text)
    .map((line) => {
      const parts = splitCsvLine(line);
      const expression = String(parts[0] || "").trim();
      if (!expression) return null;
      return {
        expression,
        label: parts[1] || "",
        color: parts[2] || "#0f766e"
      };
    })
    .filter(Boolean);
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

function parseNumericList(text) {
  return String(text || "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map((item) => Number.parseFloat(item))
    .filter((value) => Number.isFinite(value));
}

function defaultCartesianPlotPresetExpression(type) {
  if (type === "quadratic") return "x^2 - 4*x + 3";
  if (type === "cubic") return "x^3 - 2*x";
  if (type === "exponential") return "2^x";
  return "2*x + 1";
}

function defaultCartesianPlotPresetXValues(type) {
  if (type === "exponential") return "-2, -1, 0, 1, 2, 3";
  return "-2, -1, 0, 1, 2";
}

function roundTo(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function generateCartesianPlotPresetPoints(presetType, expression, xValuesText) {
  const evaluate = buildCartesianExpressionEvaluator(expression);
  if (!evaluate) {
    return { points: [], message: "Invalid expression. Use x, numbers, operators, and supported functions." };
  }

  const xValues = parseNumericList(xValuesText);
  if (xValues.length === 0) {
    return { points: [], message: "Add at least one numeric x value." };
  }

  const points = xValues
    .map((xValue, index) => {
      const yValue = evaluate(xValue);
      if (!Number.isFinite(yValue)) return null;
      const x = roundTo(xValue, 2);
      const y = roundTo(yValue, 2);
      const shortType = presetType === "quadratic" ? "Q" : presetType === "cubic" ? "C" : presetType === "exponential" ? "E" : "L";
      return { x, y, label: `${shortType}${index + 1}` };
    })
    .filter(Boolean);

  if (points.length === 0) {
    return { points: [], message: "No valid points were generated for those x values." };
  }

  return { points, message: "" };
}

function getCartesianPlotVceTemplate(templateId) {
  const templates = {
    "general-linear-intercepts": {
      presetType: "linear",
      expression: "2*x - 4",
      xValues: "0, 2, 4",
      xMin: -2,
      xMax: 6,
      yMin: -6,
      yMax: 6,
      tolerance: 0.5
    },
    "general-quadratic-turning-point": {
      presetType: "quadratic",
      expression: "x^2 - 4*x + 3",
      xValues: "1, 2, 3",
      xMin: -1,
      xMax: 5,
      yMin: -2,
      yMax: 8,
      tolerance: 0.5
    },
    "methods-transformed-parabola": {
      presetType: "quadratic",
      expression: "2*(x-1)^2 - 3",
      xValues: "-1, 1, 3",
      xMin: -3,
      xMax: 5,
      yMin: -5,
      yMax: 10,
      tolerance: 0.5
    },
    "methods-cubic-intercepts": {
      presetType: "cubic",
      expression: "x^3 - 4*x",
      xValues: "-2, 0, 2, -1, 1",
      xMin: -3,
      xMax: 3,
      yMin: -8,
      yMax: 8,
      tolerance: 0.5
    },
    "specialist-exponential-growth": {
      presetType: "exponential",
      expression: "2^x",
      xValues: "-2, -1, 0, 1, 2, 3",
      xMin: -3,
      xMax: 4,
      yMin: -1,
      yMax: 10,
      tolerance: 0.5
    }
  };
  return templates[templateId] || null;
}

const AUTO_CREATE_CARTESIAN_TEMPLATES = {
  linear: {
    easy: [
      { expression: "2*x - 4", xValues: "0, 2, 4", vceTemplate: "general-linear-intercepts" },
      { expression: "-x + 3", xValues: "0, 1, 3", vceTemplate: "general-linear-intercepts" }
    ],
    medium: [
      { expression: "3*x + 1", xValues: "-1, 0, 2", vceTemplate: "general-linear-intercepts" },
      { expression: "-2*x - 1", xValues: "-2, -1, 1", vceTemplate: "general-linear-intercepts" }
    ],
    hard: [
      { expression: "4*x - 7", xValues: "0, 1, 2", vceTemplate: "general-linear-intercepts" },
      { expression: "-3*x + 5", xValues: "0, 1, 2", vceTemplate: "general-linear-intercepts" }
    ]
  },
  quadratic: {
    easy: [
      { expression: "x^2 - 4*x + 3", xValues: "1, 2, 3", vceTemplate: "general-quadratic-turning-point" },
      { expression: "x^2 - 2*x - 3", xValues: "-1, 1, 3", vceTemplate: "general-quadratic-turning-point" }
    ],
    medium: [
      { expression: "2*(x-1)^2 - 3", xValues: "-1, 1, 3", vceTemplate: "methods-transformed-parabola" },
      { expression: "-1*(x+2)^2 + 4", xValues: "-4, -2, 0", vceTemplate: "methods-transformed-parabola" }
    ],
    hard: [
      { expression: "0.5*(x-3)^2 - 5", xValues: "1, 3, 5", vceTemplate: "methods-transformed-parabola" },
      { expression: "-2*(x-1)^2 + 6", xValues: "-1, 1, 3", vceTemplate: "methods-transformed-parabola" }
    ]
  },
  cubic: {
    easy: [
      { expression: "x^3 - 4*x", xValues: "-2, 0, 2, -1, 1", vceTemplate: "methods-cubic-intercepts" }
    ],
    medium: [
      { expression: "x^3 - x", xValues: "-1, 0, 1, -2, 2", vceTemplate: "methods-cubic-intercepts" },
      { expression: "x^3 - 3*x + 1", xValues: "-2, -1, 0, 1, 2", vceTemplate: "methods-cubic-intercepts" }
    ],
    hard: [
      { expression: "x^3 - 6*x", xValues: "-2, -1, 0, 1, 2", vceTemplate: "methods-cubic-intercepts" },
      { expression: "0.5*x^3 - 2*x", xValues: "-2, -1, 0, 1, 2", vceTemplate: "methods-cubic-intercepts" }
    ]
  },
  exponential: {
    easy: [
      { expression: "2^x", xValues: "-2, -1, 0, 1, 2", vceTemplate: "specialist-exponential-growth" }
    ],
    medium: [
      { expression: "3^x", xValues: "-2, -1, 0, 1, 2", vceTemplate: "specialist-exponential-growth" },
      { expression: "2^(x-1)", xValues: "-1, 0, 1, 2, 3", vceTemplate: "specialist-exponential-growth" }
    ],
    hard: [
      { expression: "1.5^x", xValues: "-2, -1, 0, 1, 2, 3", vceTemplate: "specialist-exponential-growth" },
      { expression: "2^(x+1)", xValues: "-2, -1, 0, 1, 2", vceTemplate: "specialist-exponential-growth" }
    ]
  },
  transformations: {
    easy: [
      { expression: "(x-2)^2", xValues: "1, 2, 3", vceTemplate: "methods-transformed-parabola" },
      { expression: "(x+1)^2 - 2", xValues: "-2, -1, 0", vceTemplate: "methods-transformed-parabola" }
    ],
    medium: [
      { expression: "2*(x-1)^2 - 3", xValues: "-1, 1, 3", vceTemplate: "methods-transformed-parabola" },
      { expression: "-1*(x+2)^2 + 4", xValues: "-4, -2, 0", vceTemplate: "methods-transformed-parabola" }
    ],
    hard: [
      { expression: "0.5*(x-3)^2 - 5", xValues: "1, 3, 5", vceTemplate: "methods-transformed-parabola" },
      { expression: "-2*(x-1)^2 + 6", xValues: "-1, 1, 3", vceTemplate: "methods-transformed-parabola" }
    ]
  },
  "domain-range": {
    easy: [
      { expression: "x^2", xValues: "-2, -1, 0, 1, 2", vceTemplate: "general-quadratic-turning-point" },
      { expression: "(x-1)^2 + 2", xValues: "-1, 0, 1, 2, 3", vceTemplate: "methods-transformed-parabola" }
    ],
    medium: [
      { expression: "-1*(x+2)^2 + 5", xValues: "-4, -3, -2, -1, 0", vceTemplate: "methods-transformed-parabola" },
      { expression: "2*(x-1)^2 - 3", xValues: "-1, 0, 1, 2, 3", vceTemplate: "methods-transformed-parabola" }
    ],
    hard: [
      { expression: "0.5*(x-3)^2 - 4", xValues: "1, 2, 3, 4, 5", vceTemplate: "methods-transformed-parabola" },
      { expression: "-2*(x-1)^2 + 7", xValues: "-1, 0, 1, 2, 3", vceTemplate: "methods-transformed-parabola" }
    ]
  },
  intercepts: {
    easy: [
      { expression: "x - 3", xValues: "0, 1, 3, 5", vceTemplate: "general-linear-graph" },
      { expression: "2*x + 4", xValues: "-3, -2, -1, 0", vceTemplate: "general-linear-graph" }
    ],
    medium: [
      { expression: "-3*x + 6", xValues: "0, 1, 2, 3", vceTemplate: "general-linear-graph" },
      { expression: "x^2 - 4", xValues: "-3, -2, 0, 2, 3", vceTemplate: "general-quadratic-turning-point" }
    ],
    hard: [
      { expression: "2*x - 5", xValues: "0, 1, 2, 3", vceTemplate: "general-linear-graph" },
      { expression: "x^2 - 2*x - 3", xValues: "-2, -1, 0, 1, 3", vceTemplate: "general-quadratic-turning-point" }
    ]
  },
  gradient: {
    easy: [
      { expression: "x + 1", xValues: "-1, 0, 1, 2", vceTemplate: "general-linear-graph" },
      { expression: "2*x - 1", xValues: "-1, 0, 1, 2", vceTemplate: "general-linear-graph" }
    ],
    medium: [
      { expression: "-3*x + 4", xValues: "-1, 0, 1", vceTemplate: "general-linear-graph" },
      { expression: "0.5*x - 2", xValues: "-2, 0, 2, 4", vceTemplate: "general-linear-graph" }
    ],
    hard: [
      { expression: "-2.5*x + 7", xValues: "0, 1, 2, 3", vceTemplate: "general-linear-graph" },
      { expression: "1.5*x - 4", xValues: "0, 2, 4", vceTemplate: "general-linear-graph" }
    ]
  },
  asymptotes: {
    easy: [
      { expression: "1/(x-2)", xValues: "-2, -1, 0, 1, 3, 4", vceTemplate: "specialist-rational-asymptote" },
      { expression: "1/(x+3)", xValues: "-5, -4, -2, -1, 0, 1", vceTemplate: "specialist-rational-asymptote" }
    ],
    medium: [
      { expression: "2/(x-1)", xValues: "-2, -1, 0, 2, 3, 4", vceTemplate: "specialist-rational-asymptote" },
      { expression: "-1/(x+2)", xValues: "-5, -4, -3, -1, 0, 1", vceTemplate: "specialist-rational-asymptote" }
    ],
    hard: [
      { expression: "1/(x-3) + 2", xValues: "0, 1, 2, 4, 5, 6", vceTemplate: "specialist-rational-asymptote" },
      { expression: "-2/(x+1) - 1", xValues: "-4, -3, -2, 0, 1, 2", vceTemplate: "specialist-rational-asymptote" }
    ]
  }
};

const AUTO_CREATE_SUBCATEGORY_OPTIONS = {
  "time": [
    { value: "digital", label: "Digital" },
    { value: "digital-by-hour", label: "Digital - by Hour" },
    { value: "analog", label: "Analog" },
    { value: "analog-by-hour", label: "Analog - by Hour" },
    { value: "mixed-by-hour", label: "Mixed - by Hour" },
    { value: "analog-to-digital", label: "Analog to Digital" }
  ],
  "cartesian-plane": [
    { value: "linear", label: "Linear" },
    { value: "quadratic", label: "Quadratic" },
    { value: "cubic", label: "Cubic" },
    { value: "exponential", label: "Exponential" },
    { value: "transformations", label: "Transformations" },
    { value: "domain-range", label: "Domain and Range" },
    { value: "intercepts", label: "Intercepts" },
    { value: "gradient", label: "Gradient" },
    { value: "asymptotes", label: "Asymptotes" },
    { value: "point-on-axes", label: "Point On Axes" },
    { value: "quadrant-identification", label: "Quadrant Identification" }
  ],
  "cartesian-plane-plot": [
    { value: "linear", label: "Linear" },
    { value: "quadratic", label: "Quadratic" },
    { value: "cubic", label: "Cubic" },
    { value: "exponential", label: "Exponential" },
    { value: "transformations", label: "Transformations" },
    { value: "intercepts", label: "Intercepts" },
    { value: "gradient", label: "Gradient" },
    { value: "asymptotes", label: "Asymptotes" }
  ],
  "number-line": [{ value: "distance", label: "Distance Between Points" }],
  "bar-chart": [{ value: "highest-category", label: "Highest Category" }],
  "histogram": [{ value: "count-values", label: "Count Values" }],
  "box-plot": [{ value: "median", label: "Median Of Dataset" }],
  "scatter-plot": [{ value: "correlation-sign", label: "Correlation Sign" }],
  "probability-tree": [{ value: "path-sum", label: "Total Path Probability" }],
  "distribution-curve": [{ value: "mean", label: "Mean" }],
  "introduction": [{ value: "cover", label: "Cover" }],
  "introduction-to-numbers": [
    { value: "identify-numbers", label: "Identify Numbers" },
    { value: "total-number", label: "Total Number" },
    { value: "order-the-numbers", label: "Order the Numbers" }
  ],
  arithmetic: [
    { value: "addition-link", label: "Addition (Link)" },
    { value: "subtraction-link", label: "Subtraction (Link)" },
    { value: "basic-addition-h", label: "Basic Addition - Horizontal" },
    { value: "basic-addition-v", label: "Basic Addition - Vertical" },
    { value: "visual-addition", label: "Visual Addition" },
    { value: "basic-subtraction-h", label: "Basic Subtraction - Horizontal" },
    { value: "basic-subtraction-v", label: "Basic Subtraction - Vertical" },
    { value: "visual-subtraction", label: "Visual Subtraction" },
    { value: "basic-multiplication-h", label: "Basic Multiplication - Horizontal" },
    { value: "basic-multiplication-v", label: "Basic Multiplication - Vertical" },
    { value: "visual-multiplication", label: "Visual Multiplication" },
    { value: "visual-division", label: "Visual Division" },
    { value: "ratios-rates", label: "Ratios and Rates" },
    { value: "division-short", label: "Division (Short)" },
    { value: "division-long", label: "Division (Long)" }
  ],
  "fractions": [
    { value: "fraction-addition", label: "Addition (+)" },
    { value: "fraction-subtraction", label: "Subtraction (-)" },
    { value: "fraction-multiplication", label: "Multiplication (x)" },
    { value: "fraction-division", label: "Division (÷)" },
    { value: "operation-result", label: "Mixed Operation (Random)" },
    { value: "improper-fraction", label: "Improper Fractions" },
    { value: "mixed-number", label: "Mixed Numbers" }
  ],
  "network-graph": [{ value: "node-count", label: "Node Count" }],
  "matrix": [
    { value: "matrix-a-dim", label: "Matrix A Dimensions" },
    { value: "matrix-add", label: "A + B" },
    { value: "matrix-subtract", label: "A - B" },
    { value: "matrix-multiply", label: "A x B" },
    { value: "matrix-transpose", label: "Transpose (A^T)" },
    { value: "matrix-determinant", label: "Determinant (det(A))" }
  ],
  "stem-and-leaf": [{ value: "value-count", label: "Value Count" }],
  "geometry-shapes": [{ value: "shape-count", label: "Shape Count" }],
  "pythagoras": [{ value: "hypotenuse", label: "Find Hypotenuse" }],
  "trigonometry": [{ value: "focus-function", label: "Focus Function Ratio" }]
};

function sortOptionItemsByLabel(items) {
  const source = Array.isArray(items) ? items.slice() : [];
  source.sort((a, b) => String(a && a.label ? a.label : "").localeCompare(String(b && b.label ? b.label : ""), undefined, { sensitivity: "base" }));
  return source;
}

function sortSelectOptionsAlphabetically(selectElement) {
  if (!(selectElement instanceof HTMLSelectElement)) return;
  const selectedValue = String(selectElement.value || "");
  const options = Array.from(selectElement.options).map((option) => ({
    value: String(option.value || ""),
    label: String(option.textContent || "").trim()
  }));

  const sorted = sortOptionItemsByLabel(options);
  selectElement.innerHTML = "";
  sorted.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    selectElement.appendChild(option);
  });

  const hasSelected = sorted.some((item) => item.value === selectedValue);
  if (hasSelected) {
    selectElement.value = selectedValue;
  }
}

function populateAutoCreateSubcategoryOptions() {
  const categorySelect = document.getElementById("autoCreateCategory");
  const subcategorySelect = document.getElementById("autoCreateSubcategory");
  if (!categorySelect || !subcategorySelect) return;
  const category = String(categorySelect.value || "cartesian-plane").trim();
  const options = sortOptionItemsByLabel(AUTO_CREATE_SUBCATEGORY_OPTIONS[category] || [{ value: "core", label: "Core" }]);
  const current = String(subcategorySelect.value || "").trim();

  subcategorySelect.innerHTML = "";
  options.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    subcategorySelect.appendChild(option);
  });

  const hasCurrent = options.some((item) => item.value === current);
  subcategorySelect.value = hasCurrent ? current : options[0].value;
}

function capitalizeWord(value) {
  const text = String(value || "").trim();
  if (!text) return "Determine";
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function normalizeCommandWordChoice(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["determine", "sketch", "interpret", "justify", "calculate", "random"].includes(normalized)) {
    return normalized;
  }
  return "random";
}

function isVisualArithmeticSubcategory(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["visual-addition", "visual-subtraction", "visual-multiplication", "visual-division", "addition-link", "subtraction-link"].includes(normalized);
}

function pickCommandWordFromChoice(choice, { resultType = "", index = 0, category = "", subcategory = "" } = {}) {
  const normalizedCategory = String(category || "").trim().toLowerCase();
  const normalizedSubcategory = String(subcategory || "").trim().toLowerCase();
  if (normalizedCategory === "arithmetic" && isVisualArithmeticSubcategory(normalizedSubcategory)) {
    return "determine";
  }
  if (normalizedCategory === "arithmetic" || normalizedCategory === "fractions") {
    return "calculate";
  }

  const normalizedChoice = normalizeCommandWordChoice(choice);
  if (normalizedChoice !== "random") {
    return normalizedChoice;
  }

  const normalizedResultType = String(resultType || "").trim().toLowerCase();
  if (normalizedResultType === "plot") {
    return "sketch";
  }

  const rotatingPool = ["determine", "interpret", "justify"];
  if (Number.isInteger(index)) {
    return rotatingPool[Math.abs(index) % rotatingPool.length];
  }

  return pickRandomItem(rotatingPool) || "determine";
}

function applyCommandWordToQuestion(questionText, commandWord) {
  const text = String(questionText || "").trim();
  const word = capitalizeWord(commandWord);
  if (!text) return `${word}.`;

  if (new RegExp(`^${word}\\b`, "i").test(text)) {
    return `${word}${text.slice(word.length)}`;
  }

  const normalized = text.charAt(0).toLowerCase() + text.slice(1);
  return `${word} ${normalized}`;
}

function formatAnswerValueByPolicy(value, policy, decimalPlaces) {
  const normalizedPolicy = String(policy || "auto").trim().toLowerCase();
  const places = Number.isInteger(Number(decimalPlaces))
    ? Math.max(0, Math.min(6, Number.parseInt(decimalPlaces, 10)))
    : 2;
  const raw = String(value || "").trim();
  if (!raw) return raw;

  if (normalizedPolicy === "exact" || normalizedPolicy === "auto") {
    return raw;
  }

  const numeric = Number.parseFloat(raw);
  if (Number.isFinite(numeric) && /^-?\d+(?:\.\d+)?$/.test(raw)) {
    return Number(numeric.toFixed(places)).toString();
  }

  const fractionMatch = raw.match(/^\s*(-?\d+)\s*\/\s*(-?\d+)\s*$/);
  if (fractionMatch && Number.parseInt(fractionMatch[2], 10) !== 0) {
    const numerator = Number.parseInt(fractionMatch[1], 10);
    const denominator = Number.parseInt(fractionMatch[2], 10);
    return Number((numerator / denominator).toFixed(places)).toString();
  }

  return raw;
}

function applyDomainRestrictionToPayload(payload, domainMin, domainMax) {
  if (!payload) return payload;
  const min = Number(domainMin);
  const max = Number(domainMax);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) return payload;

  const next = { ...payload };
  next.question = `${String(payload.question || "").trim()} Restrict the domain to ${min} <= x <= ${max}.`;

  const app = payload.interactiveApp;
  if (app && app.config && Number.isFinite(Number(app.config.xMin)) && Number.isFinite(Number(app.config.xMax))) {
    next.interactiveApp = {
      ...app,
      config: {
        ...app.config,
        xMin: Math.max(Number(app.config.xMin), min),
        xMax: Math.min(Number(app.config.xMax), max)
      }
    };
  }

  return next;
}

function applyAnswerFormatToPayload(payload, policy, decimalPlaces) {
  if (!payload) return payload;
  const next = { ...payload };
  next.correctAnswer = formatAnswerValueByPolicy(next.correctAnswer, policy, decimalPlaces);

  if (Array.isArray(next.options) && next.options.length > 0) {
    next.options = next.options.map((item) => formatAnswerValueByPolicy(item, policy, decimalPlaces));
  }

  return next;
}

function postProcessAutoPayload(payload, generationOptions = {}) {
  if (!payload) return payload;
  const commandWordChoice = normalizeCommandWordChoice(generationOptions.commandWord || "random");
  const commandWord = pickCommandWordFromChoice(commandWordChoice, {
    resultType: payload.resultType,
    index: Number.isInteger(generationOptions.questionIndex) ? generationOptions.questionIndex : null,
    category: generationOptions.category || ""
  });
  const answerPolicy = String(generationOptions.answerPolicy || "auto").trim();
  const decimalPlaces = Number.isInteger(Number(generationOptions.decimalPlaces))
    ? Number.parseInt(generationOptions.decimalPlaces, 10)
    : 2;
  const domainMin = generationOptions.domainMin;
  const domainMax = generationOptions.domainMax;
  const skipCommandWord = String(generationOptions.category || "").trim().toLowerCase() === "arithmetic"
    && isVisualArithmeticSubcategory(generationOptions.subcategory);

  let next = { ...payload };
  if (!skipCommandWord) {
    next.question = applyCommandWordToQuestion(next.question, commandWord);
  }
  next = applyDomainRestrictionToPayload(next, domainMin, domainMax);
  next = applyAnswerFormatToPayload(next, answerPolicy, decimalPlaces);
  return next;
}

function pickRandomItem(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const index = Math.floor(Math.random() * list.length);
  return list[index] || null;
}

function computeAxisFromPoints(points) {
  const values = Array.isArray(points) ? points : [];
  if (values.length === 0) {
    return { xMin: -10, xMax: 10, yMin: -10, yMax: 10 };
  }
  const xs = values.map((item) => Number(item.x)).filter((item) => Number.isFinite(item));
  const ys = values.map((item) => Number(item.y)).filter((item) => Number.isFinite(item));
  if (xs.length === 0 || ys.length === 0) {
    return { xMin: -10, xMax: 10, yMin: -10, yMax: 10 };
  }
  const xMin = Math.floor(Math.min(...xs)) - 2;
  const xMax = Math.ceil(Math.max(...xs)) + 2;
  const yMin = Math.floor(Math.min(...ys)) - 2;
  const yMax = Math.ceil(Math.max(...ys)) + 2;
  return {
    xMin: Math.max(-12, xMin),
    xMax: Math.min(12, xMax),
    yMin: Math.max(-12, yMin),
    yMax: Math.min(12, yMax)
  };
}

function shuffleList(list) {
  const next = Array.isArray(list) ? list.slice() : [];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

function formatCartesianPoint(point) {
  return `(${point.x}, ${point.y})`;
}

function buildCartesianDisplayApp(points) {
  const axis = computeAxisFromPoints(points);
  return {
    type: "cartesian-plane",
    config: {
      xMin: axis.xMin,
      xMax: axis.xMax,
      yMin: axis.yMin,
      yMax: axis.yMax,
      angleMode: "radians",
      points: points.map((point, index) => ({
        x: Number(point.x),
        y: Number(point.y),
        label: point.label || `P${index + 1}`,
        color: point.color || "#2563eb"
      })),
      segments: [],
      parabolas: [],
      functions: []
    }
  };
}

function buildCartesianFunctionDisplayApp(expression, xMin, xMax, yMin, yMax) {
  return {
    type: "cartesian-plane",
    config: {
      xMin: Number(xMin),
      xMax: Number(xMax),
      yMin: Number(yMin),
      yMax: Number(yMax),
      angleMode: "radians",
      points: [],
      segments: [],
      parabolas: [],
      functions: [{ expression: String(expression || "x"), label: `y = ${expression}`, color: "#0f766e" }]
    }
  };
}

function buildAutoCartesianPlotPayload(subcategory, difficulty) {
  const normalizedSubcategory = String(subcategory || "linear").trim().toLowerCase();
  const normalizedDifficulty = String(difficulty || "easy").trim().toLowerCase();
  const bySubcategory = AUTO_CREATE_CARTESIAN_TEMPLATES[normalizedSubcategory] || AUTO_CREATE_CARTESIAN_TEMPLATES.linear;
  const options = bySubcategory[normalizedDifficulty] || bySubcategory.easy;
  const chosen = pickRandomItem(options) || options[0];
  if (!chosen) return null;

  const presetType = normalizedSubcategory === "quadratic"
    ? "quadratic"
    : normalizedSubcategory === "cubic"
      ? "cubic"
      : normalizedSubcategory === "exponential"
        ? "exponential"
        : normalizedSubcategory === "transformations"
          ? "quadratic"
        : normalizedSubcategory === "domain-range"
          ? "quadratic"
        : "linear";

  const generated = generateCartesianPlotPresetPoints(presetType, chosen.expression, chosen.xValues);
  if (generated.message || !Array.isArray(generated.points) || generated.points.length === 0) {
    return null;
  }

  const axis = computeAxisFromPoints(generated.points);
  const pointsSummary = generated.points.map((point) => formatCartesianPoint(point)).join(", ");
  const label = normalizedSubcategory.charAt(0).toUpperCase() + normalizedSubcategory.slice(1);

  if (normalizedSubcategory === "domain-range") {
    const yValues = generated.points.map((point) => Number(point.y)).filter((value) => Number.isFinite(value));
    const minY = yValues.length > 0 ? Math.min(...yValues) : 0;
    const maxY = yValues.length > 0 ? Math.max(...yValues) : 0;
    const domainText = `${axis.xMin} <= x <= ${axis.xMax}`;
    const rangeText = `${roundTo(minY, 2)} <= y <= ${roundTo(maxY, 2)}`;
    return {
      question: `Given the graph of y = ${chosen.expression} over ${domainText}, state the domain and range.`,
      resultType: "short-answer",
      options: ["", "", "", ""],
      correctAnswer: `Domain: ${domainText}; Range: ${rangeText}`,
      solution: `From the shown graph, x spans ${domainText}. The minimum y-value is ${roundTo(minY, 2)} and maximum y-value is ${roundTo(maxY, 2)}, so range is ${rangeText}.`,
      interactiveApp: {
        type: "cartesian-plane",
        config: {
          xMin: axis.xMin,
          xMax: axis.xMax,
          yMin: axis.yMin,
          yMax: axis.yMax,
          angleMode: "radians",
          points: generated.points.map((point, index) => ({
            x: point.x,
            y: point.y,
            label: index === 0 ? "sample" : "",
            color: "#2563eb"
          })),
          segments: [],
          parabolas: [],
          functions: [{ expression: chosen.expression, label: `y = ${chosen.expression}`, color: "#0f766e" }]
        }
      }
    };
  }

  return {
    question: `On the Cartesian plane, plot the ${label.toLowerCase()} graph y = ${chosen.expression}. Use the key points and place them accurately.`,
    resultType: "plot",
    options: ["", "", "", ""],
    correctAnswer: "",
    solution: [
      `Use y = ${chosen.expression}.`,
      `Substitute the key x-values ${chosen.xValues} to calculate y-values.`,
      `Key points: ${pointsSummary}.`,
      "Plot these points and sketch the curve/line through the correct shape."
    ].join(" "),
    interactiveApp: {
      type: "cartesian-plane-plot",
      config: {
        xMin: axis.xMin,
        xMax: axis.xMax,
        yMin: axis.yMin,
        yMax: axis.yMax,
        tolerance: 0.5,
        points: generated.points,
        vceTemplate: chosen.vceTemplate || "",
        presetType,
        presetExpression: chosen.expression,
        presetXValues: chosen.xValues
      }
    }
  };
}

function buildAutoCartesianMcqPayload(subcategory, difficulty) {
  const normalizedSubcategory = String(subcategory || "point-on-axes").trim().toLowerCase();
  const normalizedDifficulty = String(difficulty || "easy").trim().toLowerCase();

  if (normalizedSubcategory === "gradient") {
    const pools = normalizedDifficulty === "hard"
      ? [{ m: -2.5, b: 7 }, { m: 1.5, b: -4 }, { m: -3.5, b: 5 }]
      : normalizedDifficulty === "medium"
        ? [{ m: -3, b: 4 }, { m: 0.5, b: -2 }, { m: 2.5, b: 1 }]
        : [{ m: 1, b: 1 }, { m: 2, b: -1 }, { m: -1, b: 3 }];
    const chosen = pickRandomItem(pools);
    const gradient = roundTo(chosen.m, 2);
    const expression = `${chosen.m}*x ${chosen.b >= 0 ? "+" : "-"} ${Math.abs(chosen.b)}`;
    const distractors = shuffleList([
      String(roundTo(-gradient, 2)),
      String(roundTo(gradient + 1, 2)),
      String(roundTo(gradient - 1, 2)),
      String(roundTo(chosen.b, 2))
    ].filter((item) => Number(item) !== Number(gradient))).slice(0, 3);
    const correctOption = String(gradient);
    const options = shuffleList([correctOption, ...distractors]).slice(0, 4);

    return {
      question: `What is the gradient of the line y = ${expression}?`,
      resultType: "multiple-choice",
      options: [options[0] || "", options[1] || "", options[2] || "", options[3] || ""],
      correctAnswer: correctOption,
      solution: `In y = mx + c form, the gradient is the coefficient of x. So the gradient is ${correctOption}.`,
      interactiveApp: buildCartesianFunctionDisplayApp(expression, -6, 6, -10, 10)
    };
  }

  if (normalizedSubcategory === "intercepts") {
    const pools = normalizedDifficulty === "hard"
      ? [{ m: 2, b: -5 }, { m: -3, b: 7 }, { m: 4, b: -9 }]
      : normalizedDifficulty === "medium"
        ? [{ m: 2, b: 4 }, { m: -3, b: 6 }, { m: 1, b: -4 }]
        : [{ m: 1, b: -3 }, { m: 2, b: 4 }, { m: -1, b: 2 }];
    const chosen = pickRandomItem(pools);
    const expression = `${chosen.m}*x ${chosen.b >= 0 ? "+" : "-"} ${Math.abs(chosen.b)}`;
    const xIntercept = roundTo((-chosen.b) / chosen.m, 2);
    const correctOption = formatCartesianPoint({ x: xIntercept, y: 0 });
    const distractorPool = [
      formatCartesianPoint({ x: roundTo(chosen.b / chosen.m, 2), y: 0 }),
      formatCartesianPoint({ x: 0, y: roundTo(chosen.b, 2) }),
      formatCartesianPoint({ x: roundTo(xIntercept + 1, 2), y: 0 }),
      formatCartesianPoint({ x: roundTo(xIntercept - 1, 2), y: 0 })
    ].filter((item) => item !== correctOption);
    const options = shuffleList([correctOption, ...distractorPool]).slice(0, 4);

    return {
      question: `What is the x-intercept of y = ${expression}?`,
      resultType: "multiple-choice",
      options: [options[0] || "", options[1] || "", options[2] || "", options[3] || ""],
      correctAnswer: correctOption,
      solution: `Set y = 0, so 0 = ${chosen.m}x ${chosen.b >= 0 ? "+" : "-"} ${Math.abs(chosen.b)}. Solving gives x = ${xIntercept}, so the intercept is ${correctOption}.`,
      interactiveApp: buildCartesianFunctionDisplayApp(expression, -8, 8, -10, 10)
    };
  }

  if (normalizedSubcategory === "asymptotes") {
    const pools = normalizedDifficulty === "hard"
      ? [{ a: 3, k: 2, p: 1 }, { a: -1, k: -1, p: -2 }]
      : normalizedDifficulty === "medium"
        ? [{ a: 1, k: 0, p: 2 }, { a: -2, k: 0, p: -1 }]
        : [{ a: 2, k: 0, p: 1 }, { a: -3, k: 0, p: 1 }];
    const chosen = pickRandomItem(pools);
    const expression = chosen.k === 0
      ? `${chosen.p}/(x${chosen.a >= 0 ? "-" : "+"}${Math.abs(chosen.a)})`
      : `${chosen.p}/(x${chosen.a >= 0 ? "-" : "+"}${Math.abs(chosen.a)}) ${chosen.k >= 0 ? "+" : "-"} ${Math.abs(chosen.k)}`;
    const correctOption = `x = ${chosen.a}`;
    const distractors = shuffleList([
      `x = ${-chosen.a}`,
      `y = ${chosen.a}`,
      `y = ${chosen.k}`,
      `x = ${chosen.a + 1}`
    ].filter((item) => item !== correctOption)).slice(0, 3);
    const options = shuffleList([correctOption, ...distractors]).slice(0, 4);

    return {
      question: `What is the vertical asymptote of y = ${expression}?`,
      resultType: "multiple-choice",
      options: [options[0] || "", options[1] || "", options[2] || "", options[3] || ""],
      correctAnswer: correctOption,
      solution: `A vertical asymptote occurs where the denominator is zero. For y = ${expression}, x ${chosen.a >= 0 ? "-" : "+"} ${Math.abs(chosen.a)} = 0, so x = ${chosen.a}.`,
      interactiveApp: buildCartesianFunctionDisplayApp(expression, -8, 8, -8, 8)
    };
  }

  if (normalizedSubcategory === "quadrant-identification") {
    const bases = normalizedDifficulty === "hard"
      ? [{ x: 5, y: -7 }, { x: -8, y: 6 }, { x: -6, y: -5 }, { x: 7, y: 9 }]
      : normalizedDifficulty === "medium"
        ? [{ x: 4, y: -3 }, { x: -5, y: 4 }, { x: -3, y: -4 }, { x: 6, y: 5 }]
        : [{ x: 2, y: 3 }, { x: -4, y: 2 }, { x: -3, y: -2 }, { x: 4, y: -1 }];
    const chosen = pickRandomItem(bases);
    const quadrant = chosen.x > 0 && chosen.y > 0
      ? "Quadrant I"
      : chosen.x < 0 && chosen.y > 0
        ? "Quadrant II"
        : chosen.x < 0 && chosen.y < 0
          ? "Quadrant III"
          : "Quadrant IV";
    const distractors = shuffleList(["Quadrant I", "Quadrant II", "Quadrant III", "Quadrant IV"].filter((item) => item !== quadrant)).slice(0, 3);
    const mcq = shuffleList([quadrant, ...distractors]);

    return {
      question: `In which quadrant is the point ${formatCartesianPoint(chosen)} located?`,
      resultType: "multiple-choice",
      options: [mcq[0] || "", mcq[1] || "", mcq[2] || "", mcq[3] || ""],
      correctAnswer: quadrant,
      solution: `${formatCartesianPoint(chosen)} has ${chosen.x > 0 ? "positive" : "negative"} x and ${chosen.y > 0 ? "positive" : "negative"} y, so it lies in ${quadrant}.`,
      interactiveApp: buildCartesianDisplayApp([
        { x: chosen.x, y: chosen.y, label: "P", color: "#2563eb" }
      ])
    };
  }

  const axisPoints = normalizedDifficulty === "hard"
    ? [{ x: 0, y: 9 }, { x: -8, y: 0 }, { x: 0, y: -7 }, { x: 6, y: 0 }]
    : normalizedDifficulty === "medium"
      ? [{ x: 0, y: 6 }, { x: -5, y: 0 }, { x: 0, y: -4 }, { x: 3, y: 0 }]
      : [{ x: 0, y: 3 }, { x: -2, y: 0 }, { x: 0, y: -2 }, { x: 4, y: 0 }];
  const target = pickRandomItem(axisPoints);
  const axisName = target.x === 0 ? "y-axis" : "x-axis";
  const distractorPool = [
    { x: target.x === 0 ? 1 : 0, y: target.y === 0 ? 1 : 0 },
    { x: target.x === 0 ? -2 : 2, y: target.y === 0 ? 2 : -2 },
    { x: target.x === 0 ? 3 : -3, y: target.y === 0 ? -1 : 4 }
  ];
  const distractors = shuffleList(distractorPool).slice(0, 3).map((point) => formatCartesianPoint(point));
  const correctOption = formatCartesianPoint(target);
  const options = shuffleList([correctOption, ...distractors]);
  return {
    question: `Which point lies on the ${axisName}?`,
    resultType: "multiple-choice",
    options: [options[0] || "", options[1] || "", options[2] || "", options[3] || ""],
    correctAnswer: correctOption,
    solution: `Points on the ${axisName} have ${axisName === "y-axis" ? "x = 0" : "y = 0"}. Therefore ${correctOption} is correct.`,
    interactiveApp: buildCartesianDisplayApp([
      { x: target.x, y: target.y, label: "A", color: "#16a34a" },
      ...distractorPool.map((point, index) => ({ x: point.x, y: point.y, label: `D${index + 1}`, color: "#dc2626" }))
    ])
  };
}

function buildAutoCartesianTrueFalsePayload(subcategory, difficulty) {
  const mcqPayload = buildAutoCartesianMcqPayload(subcategory, difficulty);
  if (!mcqPayload) return null;
  const correctPoint = String(mcqPayload.correctAnswer || "").trim();
  const wrongPoint = (mcqPayload.options || []).find((item) => String(item).trim() && String(item).trim() !== correctPoint) || "(1, 1)";
  const statementIsTrue = Math.random() < 0.5;
  const isQuadrantQuestion = String(subcategory || "").trim().toLowerCase() === "quadrant-identification";

  let statement = "";
  let solution = "";
  if (isQuadrantQuestion) {
    const expected = correctPoint;
    const shown = statementIsTrue ? expected : wrongPoint;
    statement = `The point in this question lies in ${shown}.`;
    solution = statementIsTrue
      ? `True. The point is in ${expected}.`
      : `False. The correct quadrant is ${expected}.`;
  } else {
    const axisName = mcqPayload.question.includes("y-axis") ? "y-axis" : "x-axis";
    const shownPoint = statementIsTrue ? correctPoint : wrongPoint;
    statement = `${shownPoint} lies on the ${axisName}.`;
    solution = statementIsTrue
      ? `True. ${shownPoint} satisfies the ${axisName === "y-axis" ? "x = 0" : "y = 0"} rule.`
      : `False. The point that lies on the ${axisName} is ${correctPoint}.`;
  }

  return {
    question: statement,
    resultType: "true-false",
    options: ["True", "False", "", ""],
    correctAnswer: statementIsTrue ? "True" : "False",
    solution,
    interactiveApp: mcqPayload.interactiveApp
  };
}

function buildMcqOptionsFromAnswer(correctAnswer) {
  const raw = String(correctAnswer || "").trim();
  if (!raw) return ["Option A", "Option B", "Option C", "Option D"];

  const fractionMatch = raw.match(/^\s*(-?\d+)\s*\/\s*(-?\d+)\s*$/);
  if (fractionMatch) {
    const numerator = Number.parseInt(fractionMatch[1], 10);
    const denominator = Number.parseInt(fractionMatch[2], 10);
    if (denominator !== 0) {
      const variants = [
        `${numerator}/${denominator}`,
        `${-numerator}/${denominator}`,
        `${numerator}/${Math.max(1, denominator + 1)}`,
        `${numerator + 1}/${denominator}`
      ];
      return shuffleList(Array.from(new Set(variants))).slice(0, 4);
    }
  }

  const numeric = Number.parseFloat(raw);
  if (Number.isFinite(numeric) && /^-?\d+(?:\.\d+)?$/.test(raw)) {
    const variants = [numeric, -numeric, numeric + 1, numeric - 1, numeric + 2]
      .map((value) => String(roundTo(value, 2)));
    return shuffleList(Array.from(new Set(variants))).slice(0, 4);
  }

  if (/^quadrant\s+[ivx]+$/i.test(raw)) {
    const variants = ["Quadrant I", "Quadrant II", "Quadrant III", "Quadrant IV"];
    return shuffleList(Array.from(new Set([raw, ...variants]))).slice(0, 4);
  }

  if (/^\(.+,.+\)$/.test(raw)) {
    const match = raw.match(/^\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)$/);
    if (match) {
      const x = Number.parseFloat(match[1]);
      const y = Number.parseFloat(match[2]);
      const points = [
        `(${x}, ${y})`,
        `(${y}, ${x})`,
        `(${x + 1}, ${y})`,
        `(${x}, ${y + 1})`,
        `(${x - 1}, ${y - 1})`
      ];
      return shuffleList(points);
    }
  }
  const textOptions = [raw, "None of the above", "Cannot be determined", "All of the above"];
  return shuffleList(Array.from(new Set(textOptions))).slice(0, 4);
}

function asResultTypePayload(base, desiredResultType) {
  const cleanBase = { ...base };
  delete cleanBase._generation;
  const resultType = normalizeResultType(desiredResultType || "short-answer");
  const answerPolicy = base && base._generation ? base._generation.answerPolicy : "auto";
  const decimalPlaces = base && base._generation ? base._generation.decimalPlaces : 2;
  const answerText = formatAnswerValueByPolicy(String(base.correctAnswer || "").trim(), answerPolicy, decimalPlaces);

  if (resultType === "multiple-choice") {
    const options = buildMcqOptionsFromAnswer(answerText);
    if (!options.some((item) => normalizeText(item) === normalizeText(answerText))) {
      options[0] = answerText || options[0];
    }
    return {
      ...cleanBase,
      resultType: "multiple-choice",
      options,
      correctAnswer: options.find((item) => normalizeText(item) === normalizeText(answerText)) || answerText
    };
  }

  if (resultType === "true-false") {
    const statementIsTrue = Math.random() < 0.5;
    const statement = statementIsTrue
      ? `The correct answer is ${answerText}.`
      : `The correct answer is not ${answerText}.`;
    return {
      ...cleanBase,
      question: `${base.question} ${statement}`,
      resultType: "true-false",
      options: ["True", "False", "", ""],
      correctAnswer: statementIsTrue ? "True" : "False",
      solution: statementIsTrue
        ? `${base.solution} Therefore the statement is True.`
        : `${base.solution} Therefore the statement is False.`
    };
  }

  if (resultType === "date") {
    return {
      ...cleanBase,
      resultType: "date",
      options: ["", "", "", ""],
      correctAnswer: answerText
    };
  }

  return {
    ...cleanBase,
    resultType: resultType === "plot" ? "plot" : "short-answer",
    options: ["", "", "", ""],
    correctAnswer: answerText
  };
}

function extractFirstFiniteNumber(text) {
  const match = String(text || "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return Number.NaN;
  return Number.parseFloat(match[0]);
}

function extractArithmeticExpectedAnswer(questionText) {
  const text = String(questionText || "");
  let match = text.match(/(-?\d+(?:\.\d+)?)\s*\+\s*(-?\d+(?:\.\d+)?)/);
  if (match) {
    return Number.parseFloat(match[1]) + Number.parseFloat(match[2]);
  }

  match = text.match(/(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)/);
  if (match) {
    return Number.parseFloat(match[1]) - Number.parseFloat(match[2]);
  }

  match = text.match(/(-?\d+(?:\.\d+)?)\s*[x*]\s*(-?\d+(?:\.\d+)?)/i);
  if (match) {
    return Number.parseFloat(match[1]) * Number.parseFloat(match[2]);
  }

  match = text.match(/(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/);
  if (match) {
    const denominator = Number.parseFloat(match[2]);
    if (Math.abs(denominator) < 1e-9) return Number.NaN;
    return Number.parseFloat(match[1]) / denominator;
  }

  match = text.match(/divide\s+(-?\d+(?:\.\d+)?)\s+by\s+(-?\d+(?:\.\d+)?)/i);
  if (match) {
    const denominator = Number.parseFloat(match[2]);
    if (Math.abs(denominator) < 1e-9) return Number.NaN;
    return Number.parseFloat(match[1]) / denominator;
  }

  return Number.NaN;
}

function parseCartesianPointText(value) {
  const match = String(value || "").trim().match(/^\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)$/);
  if (!match) return null;
  const x = Number.parseFloat(match[1]);
  const y = Number.parseFloat(match[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function verifyAutoPayload(category, subcategory, payload) {
  const issues = [];
  const appType = String(category || "").trim();
  const normalizedSubcategory = String(subcategory || "").trim().toLowerCase();
  const structural = getQuestionValidationIssues(payload || {});
  if (structural.length > 0) {
    issues.push(...structural);
  }

  const questionText = String(payload && payload.question || "").trim();
  const solutionText = String(payload && payload.solution || "").trim();
  if (!questionText) issues.push("Generated question text is empty.");
  if (!solutionText) issues.push("Generated solution text is empty.");

  const app = payload && payload.interactiveApp ? payload.interactiveApp : null;
  if ((appType === "cartesian-plane" || appType === "cartesian-plane-plot") && !app) {
    issues.push("Generated payload is missing interactive app configuration.");
  }

  // Verify plotted points satisfy their source expression when preset metadata exists.
  if (app && app.type === "cartesian-plane-plot") {
    const cfg = app.config || {};
    const points = Array.isArray(cfg.points) ? cfg.points : [];
    if (points.length === 0) {
      issues.push("Cartesian plot payload has no answer points.");
    }
    if (cfg.presetExpression && cfg.presetXValues) {
      const regenerated = generateCartesianPlotPresetPoints(
        String(cfg.presetType || "linear").trim() || "linear",
        String(cfg.presetExpression || "").trim(),
        String(cfg.presetXValues || "").trim()
      );
      if (regenerated.message) {
        issues.push(`Could not verify plot points: ${regenerated.message}`);
      } else {
        const expected = regenerated.points || [];
        if (expected.length !== points.length) {
          issues.push("Plot verification failed: generated points count does not match answer points.");
        } else {
          const tolerance = 0.01;
          const mismatched = expected.some((ep) =>
            !points.some((ap) => Math.abs(Number(ap.x) - Number(ep.x)) <= tolerance && Math.abs(Number(ap.y) - Number(ep.y)) <= tolerance)
          );
          if (mismatched) {
            issues.push("Plot verification failed: answer points do not match computed expression points.");
          }
        }
      }
    }
  }

  // Subcategory-specific semantic checks for deterministic Cartesian MCQ generation.
  if (appType === "cartesian-plane" && app && app.type === "cartesian-plane") {
    const functionExpr = app.config && Array.isArray(app.config.functions) && app.config.functions[0]
      ? String(app.config.functions[0].expression || "").trim()
      : "";
    const evaluator = functionExpr ? buildCartesianExpressionEvaluator(functionExpr) : null;

    if (normalizedSubcategory === "gradient" && evaluator) {
      const y0 = evaluator(0);
      const y1 = evaluator(1);
      if (Number.isFinite(y0) && Number.isFinite(y1)) {
        const expectedGradient = roundTo(y1 - y0, 2);
        const actualGradient = extractFirstFiniteNumber(payload.correctAnswer);
        if (!Number.isFinite(actualGradient) || Math.abs(actualGradient - expectedGradient) > 0.01) {
          issues.push(`Gradient verification failed: expected ${expectedGradient}, got ${payload.correctAnswer}.`);
        }
      }
    }

    if (normalizedSubcategory === "intercepts" && evaluator) {
      const y0 = evaluator(0);
      const y1 = evaluator(1);
      const m = y1 - y0;
      const b = y0;
      if (Number.isFinite(m) && Math.abs(m) > 1e-9 && Number.isFinite(b)) {
        const expectedX = roundTo((-b) / m, 2);
        const actualPoint = parseCartesianPointText(payload.correctAnswer);
        if (!actualPoint || Math.abs(actualPoint.x - expectedX) > 0.01 || Math.abs(actualPoint.y) > 0.01) {
          issues.push(`Intercept verification failed: expected (${expectedX}, 0), got ${payload.correctAnswer}.`);
        }
      }
    }

    if (normalizedSubcategory === "asymptotes") {
      const match = functionExpr.match(/\/\(\s*x\s*([+-])\s*(\d+(?:\.\d+)?)\s*\)/i);
      const expectedA = match
        ? (match[1] === "-" ? Number.parseFloat(match[2]) : -Number.parseFloat(match[2]))
        : Number.NaN;
      const answerNumber = extractFirstFiniteNumber(payload.correctAnswer);
      if (Number.isFinite(expectedA) && (!Number.isFinite(answerNumber) || Math.abs(answerNumber - expectedA) > 0.01)) {
        issues.push(`Asymptote verification failed: expected x = ${expectedA}, got ${payload.correctAnswer}.`);
      }
    }

    if (normalizedSubcategory === "domain-range") {
      const cfg = app.config || {};
      const points = Array.isArray(cfg.points) ? cfg.points : [];
      const yValues = points.map((point) => Number(point.y)).filter((value) => Number.isFinite(value));
      const expectedDomain = `${cfg.xMin} <= x <= ${cfg.xMax}`;
      const expectedRange = yValues.length > 0
        ? `${roundTo(Math.min(...yValues), 2)} <= y <= ${roundTo(Math.max(...yValues), 2)}`
        : "";
      const answerText = String(payload.correctAnswer || "");
      if (!answerText.includes(expectedDomain) || (expectedRange && !answerText.includes(expectedRange))) {
        issues.push("Domain/range verification failed: correct answer text does not match computed domain/range.");
      }
    }
  }

  if (appType === "arithmetic") {
    const cfg = app && app.type === "arithmetic" ? (app.config || {}) : {};
    const visualMode = String(cfg.visualMode || "").trim().toLowerCase();
    if (visualMode === "link-to-10") {
      const linkOperator = String(cfg.linkOperator || "+").trim() === "-" ? "-" : "+";
      const targetRaw = Number.parseInt(cfg.targetValue, 10);
      const legacyTargetRaw = Number.parseInt(cfg.targetSum, 10);
      const targetValue = Number.isInteger(targetRaw)
        ? targetRaw
        : (Number.isInteger(legacyTargetRaw) ? legacyTargetRaw : 10);
      const expectedPairs = Array.isArray(cfg.pairs)
        ? cfg.pairs
          .map((item) => ({ left: Number.parseInt(item && item.left, 10), right: Number.parseInt(item && item.right, 10) }))
          .filter((item) => Number.isInteger(item.left) && Number.isInteger(item.right))
        : [];
      if (expectedPairs.length === 0) {
        issues.push("Arithmetic link verification failed: no expected pairs configured.");
      } else {
        const expectedAnswer = expectedPairs
          .slice()
          .sort((a, b) => (a.left - b.left) || (a.right - b.right))
          .map((item) => `${item.left}:${item.right}`)
          .join("|");
        if (String(payload.correctAnswer || "").trim() !== expectedAnswer) {
          issues.push("Arithmetic link verification failed: correct answer does not match configured card pairs.");
        }
        const invalidArithmeticPair = expectedPairs.some((item) => {
          if (linkOperator === "-") {
            return (item.left - item.right) !== targetValue;
          }
          return (item.left + item.right) !== targetValue;
        });
        if (invalidArithmeticPair) {
          const expression = linkOperator === "-" ? "left - right" : "left + right";
          issues.push(`Arithmetic link verification failed: configured pairs do not satisfy ${expression} = ${targetValue}.`);
        }
      }
      return {
        ok: issues.length === 0,
        issues
      };
    }

    let expected = extractArithmeticExpectedAnswer(questionText);
    if (!Number.isFinite(expected) && app && app.type === "arithmetic") {
      const a = Number.parseFloat(cfg.operandA);
      const b = Number.parseFloat(cfg.operandB);
      const operator = String(cfg.operator || "+").trim();
      if (Number.isFinite(a) && Number.isFinite(b)) {
        if (operator === "-") expected = a - b;
        else if (operator === "x" || operator === "*") expected = a * b;
        else if ((operator === "/" || operator === "÷") && Math.abs(b) > 1e-9) expected = a / b;
        else if (operator === "+") expected = a + b;
      }
    }
    if (!Number.isFinite(expected)) {
      issues.push("Arithmetic verification failed: could not determine expected value from question text or arithmetic config.");
    } else {
      const resultType = normalizeResultType(payload && payload.resultType);
      const tolerance = 0.01;

      if (resultType === "true-false") {
        const statementMatch = questionText.match(/the\s+correct\s+answer\s+is\s+(not\s+)?(-?\d+(?:\.\d+)?)/i);
        if (!statementMatch) {
          issues.push("Arithmetic verification failed: true/false statement is missing a numeric claim.");
        } else {
          const isNegated = Boolean(statementMatch[1]);
          const claimed = Number.parseFloat(statementMatch[2]);
          const shouldBeTrue = isNegated
            ? Math.abs(expected - claimed) > tolerance
            : Math.abs(expected - claimed) <= tolerance;
          const markedTrue = normalizeText(payload.correctAnswer) === "true";
          if (shouldBeTrue !== markedTrue) {
            issues.push(`Arithmetic true/false verification failed: expected ${shouldBeTrue ? "True" : "False"}, got ${payload.correctAnswer}.`);
          }
        }
      } else {
        const actual = extractFirstFiniteNumber(payload && payload.correctAnswer);
        if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
          issues.push(`Arithmetic verification failed: expected ${roundTo(expected, 2)}, got ${payload && payload.correctAnswer}.`);
        }
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues
  };
}

function randomIntBetween(min, max) {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function deriveYearLevelFromGenerationOptions(generationOptions = {}) {
  const explicitYear = String(generationOptions.yearValue || "").trim().toLowerCase();
  if (explicitYear === "prep") return 0;
  if (/^\d+$/.test(explicitYear)) {
    return Number.parseInt(explicitYear, 10);
  }

  const grade = String(generationOptions.gradeValue || "").trim().toLowerCase();
  if (grade === "prep") return 0;
  const yearMatch = grade.match(/^year-(\d+)$/);
  if (yearMatch) {
    return Number.parseInt(yearMatch[1], 10);
  }

  return null;
}

function resolveArithmeticRanges(difficultyInput, generationOptions = {}) {
  const yearLevel = deriveYearLevelFromGenerationOptions(generationOptions);
  
  // Handle numeric difficulty (1-10) with grade scaling
  const numDifficulty = Number.parseInt(difficultyInput, 10);
  if (!Number.isNaN(numDifficulty) && numDifficulty >= 1 && numDifficulty <= 10) {
    if (yearLevel === null) {
      // No explicit grade/year selected (e.g. quick Auto Create): keep level 1 truly beginner.
      const maxAdd = Math.max(3, numDifficulty * 3);
      const maxSub = Math.max(5, numDifficulty * 4);
      const maxMulDiv = Math.max(1, Math.ceil(numDifficulty / 2));
      return {
        add: [0, maxAdd],
        sub: [0, maxSub],
        mul: [1, maxMulDiv],
        div: [1, maxMulDiv]
      };
    }

    if (yearLevel === 0) {
      // Prep: keep level 1 very gentle.
      const maxAdd = Math.max(2, numDifficulty * 2);
      const maxSub = Math.max(3, numDifficulty * 2 + 1);
      const maxMulDiv = Math.max(1, Math.floor((numDifficulty + 1) / 3));
      return { add: [0, maxAdd], sub: [0, maxSub], mul: [1, maxMulDiv], div: [1, maxMulDiv] };
    }
    
    if (yearLevel === 1) {
      // Year 1: gentle progression from simple number facts.
      const maxAdd = Math.max(4, numDifficulty * 3 + 1);
      const maxSub = Math.max(6, numDifficulty * 3 + 3);
      const maxMulDiv = Math.max(1, Math.floor((numDifficulty + 2) / 3));
      return { add: [0, maxAdd], sub: [0, maxSub], mul: [1, maxMulDiv], div: [1, maxMulDiv] };
    }
    
    if (yearLevel === 2) {
      // Year 2: start higher
      const maxAdd = numDifficulty * 5 + 10;
      const maxSub = numDifficulty * 5 + 20;
      return { add: [1, maxAdd], sub: [1, maxSub], mul: [2, Math.max(2, numDifficulty - 1)], div: [2, Math.max(2, numDifficulty - 1)] };
    }
    
    if (yearLevel !== null && yearLevel <= 4) {
      // Year 3-4: higher ranges
      const maxAdd = numDifficulty * 10;
      const maxSub = numDifficulty * 10 + 20;
      return { add: [5, maxAdd], sub: [5, maxSub], mul: [2, Math.max(2, numDifficulty)], div: [2, Math.max(2, numDifficulty)] };
    }
    
    // Default for older grades
    const maxAdd = numDifficulty * 15;
    const maxSub = numDifficulty * 15 + 50;
    return { add: [1, maxAdd], sub: [1, maxSub], mul: [4, Math.max(4, numDifficulty + 2)], div: [4, Math.max(4, numDifficulty)] };
  }
  
  // Handle string difficulty for backward compatibility
  const normalizedDifficulty = String(difficultyInput || "easy").trim().toLowerCase();
  const defaultRanges = normalizedDifficulty === "hard"
    ? { add: [60, 500], sub: [80, 600], mul: [8, 24], div: [6, 24] }
    : normalizedDifficulty === "medium"
      ? { add: [20, 200], sub: [30, 250], mul: [4, 15], div: [3, 15] }
      : { add: [1, 50], sub: [1, 80], mul: [2, 10], div: [2, 10] };

  if (yearLevel === null) {
    return defaultRanges;
  }

  if (yearLevel === 0) {
    if (normalizedDifficulty === "hard") {
      return { add: [0, 8], sub: [0, 10], mul: [1, 3], div: [1, 3] };
    }
    if (normalizedDifficulty === "medium") {
      return { add: [0, 6], sub: [0, 8], mul: [1, 2], div: [1, 2] };
    }
    return { add: [0, 4], sub: [0, 6], mul: [1, 1], div: [1, 1] };
  }

  if (yearLevel === 1) {
    if (normalizedDifficulty === "hard") {
      return { add: [0, 12], sub: [0, 16], mul: [1, 4], div: [1, 4] };
    }
    if (normalizedDifficulty === "medium") {
      return { add: [0, 9], sub: [0, 12], mul: [1, 3], div: [1, 3] };
    }
    return { add: [0, 6], sub: [0, 8], mul: [1, 2], div: [1, 2] };
  }

  if (yearLevel === 2) {
    return { add: [1, 20], sub: [1, 50], mul: [2, 10], div: [2, 10] };
  }

  if (yearLevel <= 4) {
    return { add: [5, 80], sub: [5, 120], mul: [2, 12], div: [2, 12] };
  }

  return defaultRanges;
}

const ARITHMETIC_OBJECT_CONTEXTS = [
  { kind: "ball", singular: "ball", plural: "balls" },
  { kind: "car", singular: "car", plural: "cars" },
  { kind: "star", singular: "star", plural: "stars" }
];

function pickArithmeticObjectContext() {
  return pickRandomItem(ARITHMETIC_OBJECT_CONTEXTS) || ARITHMETIC_OBJECT_CONTEXTS[0];
}

function toArithmeticObjectLabel(context, count) {
  const safeCount = Number.parseInt(count, 10);
  return safeCount === 1 ? context.singular : context.plural;
}

function toBeVerbForCount(count) {
  const safeCount = Number.parseInt(count, 10);
  return safeCount === 1 ? "is" : "are";
}

function toGroupLabel(count) {
  const safeCount = Number.parseInt(count, 10);
  return safeCount === 1 ? "group" : "groups";
}

const ARITHMETIC_PROMPT_VARIANTS = ["a", "b", "c", "d", "e", "f", "g", "h"];

function pickArithmeticPromptVariant() {
  return pickRandomItem(ARITHMETIC_PROMPT_VARIANTS) || "a";
}

function buildAdditionQuestionText({ a, b, leftLabel, rightLabel, totalLabel, isVisual, variant }) {
  const v = String(variant || "a").trim().toLowerCase();
  if (isVisual) {
    if (v === "b") return `How many ${totalLabel} are there all together when one collection has ${a} ${leftLabel} and another has ${b} ${rightLabel}?`;
    if (v === "c") return `There are ${a} ${leftLabel} in one collection and ${b} ${rightLabel} in another. How many ${totalLabel} are there in total?`;
    if (v === "d") return `One group has ${a} ${leftLabel}. Another has ${b} ${rightLabel}. How many ${totalLabel} are there altogether?`;
    if (v === "e") return `How many ${totalLabel} do you have altogether if you combine ${a} ${leftLabel} and ${b} ${rightLabel}?`;
    if (v === "f") return `You can see ${a} ${leftLabel} and ${b} ${rightLabel}. How many ${totalLabel} are there in all?`;
    if (v === "g") return `Find how many ${totalLabel} there are altogether: ${a} ${leftLabel} plus ${b} ${rightLabel}.`;
    if (v === "h") return `Altogether, how many ${totalLabel} are shown when there are ${a} ${leftLabel} and ${b} ${rightLabel}?`;
    return `How many ${totalLabel} are there altogether if one collection has ${a} ${leftLabel} and another has ${b} ${rightLabel}?`;
  }

  if (v === "b") return `A collection has ${a} ${leftLabel}, and another has ${b} ${rightLabel}. How many ${totalLabel} are there in total?`;
  if (v === "c") return `There are ${a} ${leftLabel} and ${b} ${rightLabel}. Find the total number of ${totalLabel}.`;
  if (v === "d") return `Combine ${a} ${leftLabel} with ${b} ${rightLabel}. What is the total number of ${totalLabel}?`;
  if (v === "e") return `Join ${a} ${leftLabel} and ${b} ${rightLabel}. How many ${totalLabel} are there altogether?`;
  if (v === "f") return `Add the two collections: ${a} ${leftLabel} and ${b} ${rightLabel}. Find the total ${totalLabel}.`;
  if (v === "g") return `What is the total number of ${totalLabel} when you combine ${a} ${leftLabel} and ${b} ${rightLabel}?`;
  if (v === "h") return `There are ${a} ${leftLabel} in one set and ${b} ${rightLabel} in another set. How many ${totalLabel} in all?`;
  return `A collection contains ${a} ${leftLabel}, and another collection contains ${b} ${rightLabel}. Find the total number of ${totalLabel}.`;
}

function buildSubtractionQuestionText({ top, bottom, topLabel, bottomLabel, remainLabel, variant, isVisual }) {
  const v = String(variant || "a").trim().toLowerCase();
  if (isVisual) {
    if (v === "b") return `How many ${remainLabel} are left when there are ${top} ${topLabel} and ${bottom} ${bottomLabel} are removed?`;
    if (v === "c") return `A set starts with ${top} ${topLabel}. If ${bottom} ${bottomLabel} are taken away, how many ${remainLabel} remain?`;
    if (v === "d") return `There are ${top} ${topLabel}. Take away ${bottom} ${bottomLabel}. How many ${remainLabel} are left?`;
    if (v === "e") return `How many ${remainLabel} are there after removing ${bottom} ${bottomLabel} from ${top} ${topLabel}?`;
    if (v === "f") return `Start with ${top} ${topLabel} and remove ${bottom} ${bottomLabel}. How many ${remainLabel} remain?`;
    if (v === "g") return `Find how many ${remainLabel} are left: ${top} ${topLabel} minus ${bottom} ${bottomLabel}.`;
    if (v === "h") return `After taking away ${bottom} ${bottomLabel} from ${top} ${topLabel}, how many ${remainLabel} are left?`;
    return `How many ${remainLabel} remain if there are ${top} ${topLabel} and ${bottom} ${bottomLabel} are taken away?`;
  }

  if (v === "b") return `A set has ${top} ${topLabel}. ${bottom} ${bottomLabel} are removed. How many ${remainLabel} remain?`;
  if (v === "c") return `Start with ${top} ${topLabel} and remove ${bottom} ${bottomLabel}. How many ${remainLabel} are left?`;
  if (v === "d") return `There are ${top} ${topLabel} in total. If ${bottom} ${bottomLabel} are taken away, find the remaining ${remainLabel}.`;
  if (v === "e") return `Take ${bottom} ${bottomLabel} away from ${top} ${topLabel}. How many ${remainLabel} remain?`;
  if (v === "f") return `How many ${remainLabel} are left after removing ${bottom} ${bottomLabel} from ${top} ${topLabel}?`;
  if (v === "g") return `Find the remaining ${remainLabel} when ${bottom} ${bottomLabel} are removed from ${top} ${topLabel}.`;
  if (v === "h") return `Begin with ${top} ${topLabel}. Remove ${bottom} ${bottomLabel}. What is the number of ${remainLabel} left?`;
  return `A set has ${top} ${topLabel}. If ${bottom} ${bottomLabel} are removed, how many ${remainLabel} remain?`;
}

function buildMultiplicationQuestionText({ groups, each, eachLabel, totalLabel, groupLabel, variant, isVisual }) {
  const v = String(variant || "a").trim().toLowerCase();
  if (isVisual) {
    if (v === "b") return `How many ${totalLabel} are there altogether with ${groups} ${groupLabel} and ${each} ${eachLabel} in each group?`;
    if (v === "c") return `There are ${groups} ${groupLabel}, each with ${each} ${eachLabel}. How many ${totalLabel} are there in total?`;
    if (v === "d") return `If each of the ${groups} ${groupLabel} has ${each} ${eachLabel}, how many ${totalLabel} are there altogether?`;
    if (v === "e") return `How many ${totalLabel} are there altogether when ${groups} ${groupLabel} each contain ${each} ${eachLabel}?`;
    if (v === "f") return `Count all ${totalLabel}: ${groups} ${groupLabel} with ${each} ${eachLabel} in each group.`;
    if (v === "g") return `Find the total ${totalLabel} for ${groups} ${groupLabel} of ${each} ${eachLabel} each.`;
    if (v === "h") return `There are ${groups} ${groupLabel} and each has ${each} ${eachLabel}. How many ${totalLabel} in all?`;
    return `How many ${totalLabel} are there in total if there are ${groups} ${groupLabel} with ${each} ${eachLabel} in each group?`;
  }

  if (v === "b") return `There ${toBeVerbForCount(groups)} ${groups} ${groupLabel}, each containing ${each} ${eachLabel}. Find the total number of ${totalLabel}.`;
  if (v === "c") return `A model shows ${groups} ${groupLabel} with ${each} ${eachLabel} per group. How many ${totalLabel} are there in all?`;
  if (v === "d") return `Count the total when ${groups} ${groupLabel} each have ${each} ${eachLabel}. How many ${totalLabel} are there?`;
  if (v === "e") return `How many ${totalLabel} are there altogether for ${groups} ${groupLabel} of ${each} ${eachLabel}?`;
  if (v === "f") return `Each of the ${groups} ${groupLabel} has ${each} ${eachLabel}. Find the total ${totalLabel}.`;
  if (v === "g") return `Work out the number of ${totalLabel} in all: ${groups} groups, ${each} ${eachLabel} in each.`;
  if (v === "h") return `Find the total ${totalLabel} when there are ${groups} ${groupLabel} with ${each} ${eachLabel} each.`;
  return `There ${toBeVerbForCount(groups)} ${groups} ${groupLabel}, with ${each} ${eachLabel} in each group. Find the total number of ${totalLabel}.`;
}

function pickVisualMultiplicationFactors(ranges) {
  const minFactor = Math.max(2, Math.min(Number(ranges && ranges.mul && ranges.mul[0]), 6));
  const maxFactor = Math.max(minFactor, Math.min(Number(ranges && ranges.mul && ranges.mul[1]), 8));

  let groups = randomIntBetween(minFactor, maxFactor);
  let each = randomIntBetween(minFactor, maxFactor);
  let attempts = 0;
  while (groups * each > 36 && attempts < 40) {
    groups = randomIntBetween(minFactor, maxFactor);
    each = randomIntBetween(minFactor, maxFactor);
    attempts += 1;
  }

  if (groups * each > 36) {
    groups = Math.min(groups, 6);
    each = Math.min(each, 6);
  }

  return { groups, each };
}

function buildAutoArithmeticPayload(subcategory, difficulty, generationOptions = {}) {
  const normalizedSubcategory = String(subcategory || "basic-addition").trim().toLowerCase();
  const isVisualAddition = normalizedSubcategory === "visual-addition";
  const isVisualSubtraction = normalizedSubcategory === "visual-subtraction";
  const isVisualMultiplication = normalizedSubcategory === "visual-multiplication";
  const isVisualDivision = normalizedSubcategory === "visual-division";
  
  // Pass difficulty as-is (can be numeric 1-10 or string like "easy")
  const difficultyInput = difficulty || "easy";
  const ranges = resolveArithmeticRanges(difficultyInput, generationOptions);
  
  // Determine if difficulty is "hard" for backward-compatible checks
  const numDiff = Number.parseInt(difficultyInput, 10);
  const isHardDifficulty = !Number.isNaN(numDiff) ? numDiff >= 8 : String(difficultyInput).trim().toLowerCase() === "hard";

  const resolvedSubcategory = normalizedSubcategory === "visual-addition"
    ? "basic-addition-h"
    : normalizedSubcategory === "visual-subtraction"
      ? "basic-subtraction-h"
      : normalizedSubcategory === "visual-multiplication"
        ? "basic-multiplication-h"
        : normalizedSubcategory === "visual-division"
          ? "division-short"
          : normalizedSubcategory;

  if (resolvedSubcategory === "ratios-rates") {
    const useRateQuestion = Math.random() < 0.5;

    if (useRateQuestion) {
      const distance = randomIntBetween(isHardDifficulty ? 120 : 60, isHardDifficulty ? 420 : 240);
      const time = randomIntBetween(isHardDifficulty ? 2 : 2, isHardDifficulty ? 7 : 5);
      const divisibleDistance = distance - (distance % time);
      const speed = divisibleDistance / time;
      return {
        question: `A car travels ${divisibleDistance} km in ${time} hours. What is the average speed in km/h?`,
        solution: `Average speed = distance ÷ time = ${divisibleDistance} ÷ ${time} = ${speed} km/h.`,
        correctAnswer: String(speed),
        interactiveApp: null
      };
    }

    const ratioA = randomIntBetween(2, isHardDifficulty ? 9 : 7);
    const ratioB = randomIntBetween(2, isHardDifficulty ? 9 : 7);
    const scale = randomIntBetween(isHardDifficulty ? 5 : 3, isHardDifficulty ? 12 : 9);
    const total = (ratioA + ratioB) * scale;
    const firstPart = ratioA * scale;
    return {
      question: `The ratio of apples to oranges is ${ratioA}:${ratioB}. If there are ${total} fruits in total, how many apples are there?`,
      solution: `Total ratio parts = ${ratioA} + ${ratioB} = ${ratioA + ratioB}. One part = ${total} ÷ ${ratioA + ratioB} = ${scale}. Apples = ${ratioA} × ${scale} = ${firstPart}.`,
      correctAnswer: String(firstPart),
      interactiveApp: null
    };
  }

  if (resolvedSubcategory === "addition-link" || resolvedSubcategory === "subtraction-link") {
    const isSubtractionLink = resolvedSubcategory === "subtraction-link";
    const minTarget = isSubtractionLink
      ? (isHardDifficulty ? 3 : 1)
      : (isHardDifficulty ? 11 : 7);
    const maxTarget = isSubtractionLink
      ? (isHardDifficulty ? 12 : 8)
      : (isHardDifficulty ? 19 : 14);
    const targetValue = randomIntBetween(minTarget, maxTarget);
    const pairCount = 4;
    let leftNumbers = [];
    let rightNumbers = [];
    let pairs = [];

    if (isSubtractionLink) {
      const candidateRightNumbers = Array.from({ length: isHardDifficulty ? 12 : 9 }, (_, index) => index + 1);
      const selectedRight = shuffleList(candidateRightNumbers).slice(0, Math.min(pairCount, candidateRightNumbers.length));
      leftNumbers = shuffleList(selectedRight.map((value) => value + targetValue));
      rightNumbers = shuffleList(selectedRight.slice());
      pairs = leftNumbers.map((left) => ({ left, right: left - targetValue }));
    } else {
      const candidateLeftNumbers = Array.from({ length: Math.max(2, targetValue - 1) }, (_, index) => index + 1);
      leftNumbers = shuffleList(candidateLeftNumbers).slice(0, Math.min(pairCount, candidateLeftNumbers.length));
      rightNumbers = shuffleList(leftNumbers.map((value) => targetValue - value));
      pairs = leftNumbers.map((left) => ({ left, right: targetValue - left }));
    }

    const answerText = pairs
      .slice()
      .sort((a, b) => (a.left - b.left) || (a.right - b.right))
      .map((item) => `${item.left}:${item.right}`)
      .join("|");
    const operatorText = isSubtractionLink ? "-" : "+";
    const modeLabel = isSubtractionLink ? "difference" : "sum";
    return {
      question: `Match each number in Column A to a number in Column B so every pair satisfies A ${operatorText} B = ${targetValue}.`,
      solution: `Correct links are ${pairs.map((item) => `${item.left} to ${item.right}`).join(", ")}. Every linked pair gives a ${modeLabel} of ${targetValue}.`,
      correctAnswer: answerText,
      interactiveApp: {
        type: "arithmetic",
        config: {
          layout: "horizontal",
          operator: operatorText,
          operandA: "",
          operandB: "",
          answer: answerText,
          visualMode: "link-to-10",
          linkOperator: operatorText,
          targetValue,
          targetSum: targetValue,
          leftNumbers,
          rightNumbers,
          pairs
        }
      }
    };
  }

  if (["basic-addition", "basic-addition-h", "basic-addition-v"].includes(resolvedSubcategory)) {
    const minAdd = Math.max(ranges.add[0], 1);
    const maxAdd = Math.max(minAdd, ranges.add[1]);
    const a = randomIntBetween(minAdd, maxAdd);
    const b = randomIntBetween(minAdd, maxAdd);
    const answer = a + b;
    const layout = resolvedSubcategory === "basic-addition-v" ? "vertical" : "horizontal";
    const objectContext = pickArithmeticObjectContext();
    const promptVariant = pickArithmeticPromptVariant();
    const leftLabel = toArithmeticObjectLabel(objectContext, a);
    const rightLabel = toArithmeticObjectLabel(objectContext, b);
    const totalLabel = toArithmeticObjectLabel(objectContext, answer);
    const questionText = buildAdditionQuestionText({
      a,
      b,
      leftLabel,
      rightLabel,
      totalLabel,
      isVisual: isVisualAddition,
      variant: promptVariant
    });
    return {
      question: questionText,
      solution: isVisualAddition
        ? `Combine both collections: ${a} + ${b} = ${answer}. Therefore, the total is ${answer} ${totalLabel}.`
        : `Add the numbers: ${a} + ${b} = ${answer}.`,
      correctAnswer: String(answer),
      interactiveApp: {
        type: "arithmetic",
        config: {
          layout,
          operator: "+",
          operandA: a,
          operandB: b,
          answer: String(answer),
          answerDigits: String(answer).length,
          visualMode: isVisualAddition ? "objects" : "none",
          visualKind: isVisualAddition ? objectContext.kind : "",
          visualLabel: isVisualAddition ? objectContext.plural : "",
          visualGrouping: isVisualAddition ? "addition" : "",
          promptVariant
        }
      }
    };
  }

  if (["basic-subtraction", "basic-subtraction-h", "basic-subtraction-v"].includes(resolvedSubcategory)) {
    const a = randomIntBetween(ranges.sub[0], ranges.sub[1]);
    const b = randomIntBetween(ranges.sub[0], Math.max(ranges.sub[0], Math.floor(a * 0.9)));
    const top = Math.max(a, b);
    const bottom = Math.min(a, b);
    const answer = top - bottom;
    const layout = resolvedSubcategory === "basic-subtraction-v" ? "vertical" : "horizontal";
    const objectContext = pickArithmeticObjectContext();
    const promptVariant = pickArithmeticPromptVariant();
    const topLabel = toArithmeticObjectLabel(objectContext, top);
    const bottomLabel = toArithmeticObjectLabel(objectContext, bottom);
    const remainLabel = toArithmeticObjectLabel(objectContext, answer);
    const questionText = buildSubtractionQuestionText({
      top,
      bottom,
      topLabel,
      bottomLabel,
      remainLabel,
      variant: promptVariant,
      isVisual: isVisualSubtraction
    });
    return {
      question: questionText,
      solution: isVisualSubtraction
        ? `Subtract the removed amount from the original set: ${top} - ${bottom} = ${answer}. Therefore, ${answer} ${remainLabel} remain.`
        : `Subtract the numbers: ${top} - ${bottom} = ${answer}.`,
      correctAnswer: String(answer),
      interactiveApp: {
        type: "arithmetic",
        config: {
          layout,
          operator: "-",
          operandA: top,
          operandB: bottom,
          answer: String(answer),
          answerDigits: String(answer).length,
          visualMode: isVisualSubtraction ? "objects" : "none",
          visualKind: isVisualSubtraction ? objectContext.kind : "",
          visualLabel: isVisualSubtraction ? objectContext.plural : "",
          visualGrouping: isVisualSubtraction ? "subtraction" : "",
          promptVariant
        }
      }
    };
  }

  if (["basic-multiplication", "basic-multiplication-h", "basic-multiplication-v"].includes(resolvedSubcategory)) {
    const factors = pickVisualMultiplicationFactors(ranges);
    const a = factors.groups;
    const b = factors.each;
    const answer = a * b;
    const layout = resolvedSubcategory === "basic-multiplication-v" ? "vertical" : "horizontal";
    const objectContext = pickArithmeticObjectContext();
    const promptVariant = pickArithmeticPromptVariant();
    const eachLabel = toArithmeticObjectLabel(objectContext, b);
    const totalLabel = toArithmeticObjectLabel(objectContext, answer);
    const groupLabel = toGroupLabel(a);
    const questionText = buildMultiplicationQuestionText({
      groups: a,
      each: b,
      eachLabel,
      totalLabel,
      groupLabel,
      variant: promptVariant,
      isVisual: isVisualMultiplication
    });
    return {
      question: questionText,
      solution: isVisualMultiplication
        ? `Use multiplication for equal groups: ${a} x ${b} = ${answer}. Therefore, the total is ${answer} ${totalLabel}.`
        : `Multiply the numbers: ${a} x ${b} = ${answer}.`,
      correctAnswer: String(answer),
      interactiveApp: {
        type: "arithmetic",
        config: {
          layout,
          operator: "x",
          operandA: a,
          operandB: b,
          answer: String(answer),
          answerDigits: String(answer).length,
          visualMode: isVisualMultiplication ? "objects" : "none",
          visualKind: isVisualMultiplication ? objectContext.kind : "",
          visualLabel: isVisualMultiplication ? objectContext.plural : "",
          visualGrouping: isVisualMultiplication ? "groups" : "",
          promptVariant
        }
      }
    };
  }

  if (resolvedSubcategory === "division-short") {
    const divisor = randomIntBetween(ranges.div[0], ranges.div[1]);
    const quotient = randomIntBetween(ranges.div[0], ranges.div[1] + 10);
    const dividend = divisor * quotient;
    const objectContext = pickArithmeticObjectContext();
    const itemLabel = toArithmeticObjectLabel(objectContext, dividend);
    const groupLabel = toGroupLabel(divisor);
    return {
      question: `${dividend} ${itemLabel} ${toBeVerbForCount(dividend)} shared equally into ${divisor} ${groupLabel}. How many ${itemLabel} are in each group?`,
      solution: isVisualDivision
        ? `Use division for equal sharing: ${dividend} / ${divisor} = ${quotient}. Check: ${divisor} x ${quotient} = ${dividend}.`
        : `Divide the numbers: ${dividend} / ${divisor} = ${quotient}. Check: ${divisor} x ${quotient} = ${dividend}.`,
      correctAnswer: String(quotient),
      interactiveApp: {
        type: "arithmetic",
        config: {
          layout: "horizontal",
          operator: "/",
          operandA: dividend,
          operandB: divisor,
          answer: String(quotient),
          answerDigits: String(quotient).length,
          visualMode: isVisualDivision ? "objects" : "none",
          visualKind: isVisualDivision ? objectContext.kind : "",
          visualLabel: isVisualDivision ? objectContext.plural : "",
          visualGrouping: isVisualDivision ? "division" : ""
        }
      }
    };
  }

  if (resolvedSubcategory === "division-long") {
    const divisor = randomIntBetween(ranges.div[0], ranges.div[1]);
    const quotient = randomIntBetween(ranges.div[0] + 4, ranges.div[1] + 20);
    const dividend = divisor * quotient;
    const objectContext = pickArithmeticObjectContext();
    const itemLabel = toArithmeticObjectLabel(objectContext, dividend);
    const groupLabel = toGroupLabel(divisor);
    return {
      question: `${dividend} ${itemLabel} ${toBeVerbForCount(dividend)} shared equally into ${divisor} ${groupLabel}. How many ${itemLabel} are in each group?`,
      solution: `Apply long division: ${dividend} / ${divisor} = ${quotient}. Check: ${divisor} x ${quotient} = ${dividend} with remainder 0.`,
      correctAnswer: String(quotient),
      interactiveApp: {
        type: "arithmetic",
        config: {
          layout: "vertical",
          operator: "/",
          operandA: dividend,
          operandB: divisor,
          answer: String(quotient),
          answerDigits: String(quotient).length,
          visualMode: "objects",
          visualKind: objectContext.kind,
          visualLabel: objectContext.plural,
          visualGrouping: "division"
        }
      }
    };
  }

  return null;
}

function buildAutoIntroductionPayload(subcategory) {
  const normalizedSubcategory = String(subcategory || "cover").trim().toLowerCase();
  if (normalizedSubcategory !== "cover") return null;

  return {
    question: "Welcome. Please read and accept the Terms of Use and EULA before starting this quiz.\n\nIf you find any incorrect question, answer, solution, or feedback, contact us before continuing.",
    solution: "Learner acknowledged the Terms of Use and EULA and agreed to contact support for any content issues.",
    correctAnswer: "accepted",
    options: ["", "", "", ""],
    resultType: "short-answer",
    interactiveApp: {
      type: "introduction",
      config: {
        title: "Before You Start",
        requireSupportAcknowledgement: true,
        supportLabel: "Support",
        supportEmail: ""
      }
    }
  };
}

function buildAutoIntroductionToNumbersPayload(subcategory, difficulty, generationOptions = {}) {
  const normalizedSubcategory = String(subcategory || "identify-numbers").trim().toLowerCase();

  const rawDifficulty = String(difficulty == null ? "" : difficulty).trim().toLowerCase();
  const parsedDifficulty = Number.parseInt(rawDifficulty, 10);
  const difficultyBand = Number.isFinite(parsedDifficulty)
    ? (parsedDifficulty <= 3 ? "easy" : parsedDifficulty <= 7 ? "medium" : "hard")
    : (["easy", "medium", "hard"].includes(rawDifficulty) ? rawDifficulty : "medium");

  const yearLevel = deriveYearLevelFromGenerationOptions(generationOptions);
  const isPrep = yearLevel === 0;
  const prepLevelOneToThree = [1, 2, 3, 4, 5];
  const prepLevelFourToSix = [6, 7, 8, 9, 10];
  const prepLevelSevenToTen = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
  const countingTens = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const baseNumbers = Array.from({ length: 21 }, (_, index) => index);
  const tensNumbers = [30, 40, 50, 60, 70, 80, 90, 100];
  const allNumbers = baseNumbers.concat(tensNumbers);

  const buildRandomIconGroups = (total) => {
    const safeTotal = Math.max(0, Math.min(20, Number.parseInt(total, 10) || 0));
    if (safeTotal === 0) return [0];

    const maxGroups = Math.min(5, safeTotal);
    const minGroups = safeTotal <= 2 ? 1 : 2;
    const groupCount = Math.floor(Math.random() * (maxGroups - minGroups + 1)) + minGroups;
    const groups = Array.from({ length: groupCount }, () => 1);
    let remaining = safeTotal - groupCount;

    while (remaining > 0) {
      const index = Math.floor(Math.random() * groupCount);
      if (groups[index] >= 6) continue;
      groups[index] += 1;
      remaining -= 1;
    }

    return shuffleList(groups);
  };

  if (normalizedSubcategory === "total-number") {
    const target = Math.floor(Math.random() * 21);
    const groups = buildRandomIconGroups(target);
    return {
      question: "How many icons are shown in total?",
      solution: `Count all icons across each group. The total is ${target}.`,
      correctAnswer: String(target),
      options: ["", "", "", ""],
      resultType: "short-answer",
      interactiveApp: {
        type: "icon-count",
        config: {
          prompt: "How many icons are shown in total?",
          totalCount: target,
          iconShape: "circle",
          groups
        }
      }
    };
  }

  if (normalizedSubcategory === "order-the-numbers") {
    const rangeMin = isPrep ? 0 : (difficultyBand === "easy" ? 0 : difficultyBand === "medium" ? 10 : 20);
    const rangeMax = isPrep ? 20 : (difficultyBand === "easy" ? 30 : difficultyBand === "medium" ? 60 : 100);
    const cardCount = isPrep
      ? (Number.isInteger(parsedDifficulty) && parsedDifficulty >= 7 ? 5 : 4)
      : (difficultyBand === "hard" ? 6 : difficultyBand === "medium" ? 5 : 4);
    const maxStart = Math.max(rangeMin, rangeMax - (cardCount - 1));
    const start = Math.floor(Math.random() * (maxStart - rangeMin + 1)) + rangeMin;
    const ordered = Array.from({ length: cardCount }, (_, index) => start + index);
    let cards = shuffleList(ordered);
    if (cards.every((value, index) => value === ordered[index]) && cards.length > 1) {
      cards = cards.slice(1).concat(cards[0]);
    }

    return {
      question: "Order the number cards from smallest to largest.",
      solution: `The correct ascending order is ${ordered.join(", ")}.`,
      correctAnswer: ordered.join(", "),
      options: ["", "", "", ""],
      resultType: "short-answer",
      interactiveApp: {
        type: "number-ordering",
        config: {
          prompt: "Order the number cards from smallest to largest.",
          direction: "ascending",
          cards,
          correctOrder: ordered
        }
      }
    };
  }

  if (normalizedSubcategory !== "identify-numbers") return null;

  let targets = [];
  let prompt = "Trace the dotted number and say it aloud.";
  if (isPrep) {
    if (Number.isInteger(parsedDifficulty) && parsedDifficulty >= 1 && parsedDifficulty <= 3) {
      targets = prepLevelOneToThree;
    } else if (parsedDifficulty === 4) {
      // As requested: Level 4 focuses on counting in tens.
      targets = countingTens;
      prompt = "Count in tens, then trace the dotted number and say it aloud.";
    } else if (Number.isInteger(parsedDifficulty) && parsedDifficulty >= 4 && parsedDifficulty <= 6) {
      targets = prepLevelFourToSix;
    } else if (Number.isInteger(parsedDifficulty) && parsedDifficulty >= 7 && parsedDifficulty <= 10) {
      targets = prepLevelSevenToTen;
    } else {
      targets = prepLevelOneToThree;
    }
  } else {
    targets = difficultyBand === "easy"
      ? baseNumbers
      : difficultyBand === "medium"
        ? allNumbers.filter((value) => value <= 50)
        : allNumbers;
  }

  const questionIndex = Number.parseInt(generationOptions && generationOptions.questionIndex, 10);
  const isFirstQuestion = Number.isInteger(questionIndex) && questionIndex === 0;
  const target = isFirstQuestion ? 0 : (pickRandomItem(targets) || 5);
  const questionText = isFirstQuestion
    ? "Trace the dotted circle numeral in the interactive app."
    : "Trace the dotted numeral in the interactive app.";
  const solutionText = isFirstQuestion
    ? "The numeral is 0, which is drawn as a circle. Trace the dotted circle while saying zero aloud."
    : `The dotted numeral is ${target}. Trace it while saying ${target} aloud.`;
  const promptText = isFirstQuestion
    ? "Trace the dotted circle (0) and say zero aloud."
    : prompt;

  return {
    question: questionText,
    solution: solutionText,
    correctAnswer: String(target),
    options: ["", "", "", ""],
    resultType: "short-answer",
    interactiveApp: {
      type: "number-tracing",
      config: {
        targetNumber: target,
        prompt: promptText,
        prepMode: isPrep || difficultyBand === "easy",
        showQuantityDots: isPrep || difficultyBand === "easy",
        showInstructions: false
      }
    }
  };
}

function isIntroductionQuestionItem(item) {
  if (!item || typeof item !== "object") return false;
  if (item.interactiveApp && item.interactiveApp.type === "introduction") return true;

  const prompt = String(item.question || "").trim().toLowerCase();
  if (!prompt) return false;
  const hasIntroTerms = prompt.includes("terms") || prompt.includes("conditions") || prompt.includes("eula");
  const mentionsAccept = prompt.includes("accept") || prompt.includes("acknowledge");
  return hasIntroTerms && mentionsAccept;
}

function createAutoIntroductionQuestion(generationOptions = {}) {
  const payload = buildAutoIntroductionPayload("cover");
  if (!payload) return null;

  return normalizeQuestion({
    question: payload.question || "",
    resultType: payload.resultType || "short-answer",
    options: Array.isArray(payload.options) ? payload.options : ["", "", "", ""],
    correctAnswer: payload.correctAnswer || "accepted",
    notesAttachments: [],
    image: "",
    solution: payload.solution || "",
    solutionAttachments: [],
    interactiveApp: payload.interactiveApp || null
  });
}

function resolveFractionRanges(normalizedDifficulty, generationOptions = {}) {
  const defaultRanges = normalizedDifficulty === "hard"
    ? { numerator: [2, 18], denominator: [3, 20] }
    : normalizedDifficulty === "medium"
      ? { numerator: [1, 12], denominator: [2, 14] }
      : { numerator: [1, 8], denominator: [2, 10] };

  const yearLevel = deriveYearLevelFromGenerationOptions(generationOptions);
  if (yearLevel === null) return defaultRanges;
  if (yearLevel <= 2) return { numerator: [1, 6], denominator: [2, 8] };
  if (yearLevel <= 4) return { numerator: [1, 9], denominator: [2, 12] };
  return defaultRanges;
}

function randomFractionFromRange(range) {
  const numerator = randomIntBetween(range.numerator[0], range.numerator[1]);
  const denominator = randomIntBetween(range.denominator[0], range.denominator[1]);
  const simplified = simplifyFraction(numerator, denominator);
  return simplified || { numerator: 1, denominator: 2 };
}

function buildAutoImproperFractionPayload(normalizedDifficulty, generationOptions = {}) {
  // Generate an improper fraction (numerator > denominator) and ask student to simplify/identify it
  const maxDen = normalizedDifficulty === "hard" ? 12 : normalizedDifficulty === "medium" ? 9 : 6;
  const denominator = randomIntBetween(2, maxDen);
  const maxWhole = normalizedDifficulty === "hard" ? 5 : normalizedDifficulty === "medium" ? 4 : 3;
  const whole = randomIntBetween(1, maxWhole);
  const extraNum = randomIntBetween(1, denominator - 1);
  const numerator = whole * denominator + extraNum;
  const simplified = simplifyFraction(numerator, denominator) || { numerator, denominator };
  const simplifiedText = formatFractionDisplay(simplified);
  // Compute mixed number answer
  const mixedWhole = Math.floor(simplified.numerator / simplified.denominator);
  const mixedNum = simplified.numerator % simplified.denominator;
  const mixedText = mixedNum === 0 ? `${mixedWhole}` : `${mixedWhole} and ${mixedNum}/${simplified.denominator}`;
  return {
    question: `Calculate convert the improper fraction ${numerator}/${denominator} to a mixed fraction.`,
    solution: `Divide the numerator by the denominator: ${numerator} ÷ ${denominator} = ${mixedWhole} remainder ${mixedNum}. So ${simplifiedText} = ${mixedText}.`,
    correctAnswer: mixedText,
    interactiveApp: {
      type: "fractions",
      config: {
        title: "Improper Fraction to Mixed Fraction",
        operation: "add",
        fractionA: { numerator: simplified.numerator, denominator: simplified.denominator },
        fractionB: { numerator: 0, denominator: simplified.denominator },
        answerFormat: "mixed"
      }
    }
  };
}

function buildAutoMixedNumberPayload(normalizedDifficulty, generationOptions = {}) {
  // Generate a mixed number and ask student to convert to an improper fraction
  const maxDen = normalizedDifficulty === "hard" ? 12 : normalizedDifficulty === "medium" ? 9 : 6;
  const denominator = randomIntBetween(2, maxDen);
  const maxWhole = normalizedDifficulty === "hard" ? 5 : normalizedDifficulty === "medium" ? 4 : 3;
  const whole = randomIntBetween(1, maxWhole);
  const partNum = randomIntBetween(1, denominator - 1);
  const improperNum = whole * denominator + partNum;
  const simplified = simplifyFraction(improperNum, denominator) || { numerator: improperNum, denominator };
  const simplifiedText = formatFractionDisplay(simplified);
  return {
    question: `Calculate convert the mixed number ${whole} and ${partNum}/${denominator} to an improper fraction.`,
    solution: `Multiply the whole number by the denominator and add the numerator: (${whole} x ${denominator}) + ${partNum} = ${improperNum}. So the improper fraction is ${simplifiedText}.`,
    correctAnswer: simplifiedText,
    interactiveApp: {
      type: "fractions",
      config: {
        title: "Mixed Number to Improper Fraction",
        operation: "add",
        fractionA: { numerator: simplified.numerator, denominator: simplified.denominator },
        fractionB: { numerator: 0, denominator: simplified.denominator },
        answerFormat: "improper"
      }
    }
  };
}

function buildAutoFractionsPayload(subcategory, difficulty, generationOptions = {}) {
  const normalizedSubcategory = String(subcategory || "operation-result").trim().toLowerCase();
  const normalizedDifficulty = String(difficulty || "easy").trim().toLowerCase();
  const range = resolveFractionRanges(normalizedDifficulty, generationOptions);

  // Handle improper-fraction and mixed-number subcategories separately
  if (normalizedSubcategory === "improper-fraction") {
    return buildAutoImproperFractionPayload(normalizedDifficulty, generationOptions);
  }
  if (normalizedSubcategory === "mixed-number") {
    return buildAutoMixedNumberPayload(normalizedDifficulty, generationOptions);
  }

  const operation = normalizedSubcategory === "fraction-addition"
    ? "add"
    : normalizedSubcategory === "fraction-subtraction"
      ? "subtract"
      : normalizedSubcategory === "fraction-multiplication"
        ? "multiply"
        : normalizedSubcategory === "fraction-division"
          ? "divide"
          : pickRandomItem(["add", "subtract", "multiply", "divide"]) || "add";

  const a = randomFractionFromRange(range);
  let b = randomFractionFromRange(range);
  if (operation === "divide") {
    let attempts = 0;
    while (b.numerator === 0 && attempts < 8) {
      b = randomFractionFromRange(range);
      attempts += 1;
    }
    if (b.numerator === 0) b = { numerator: 1, denominator: 2 };
  }

  const symbols = {
    add: "+",
    subtract: "-",
    multiply: "x",
    divide: "/"
  };

  let rawN = 0;
  let rawD = 1;
  let solution = "";

  if (operation === "add") {
    rawN = (a.numerator * b.denominator) + (b.numerator * a.denominator);
    rawD = a.denominator * b.denominator;
    solution = `Use a common denominator: (${a.numerator} x ${b.denominator} + ${b.numerator} x ${a.denominator}) / (${a.denominator} x ${b.denominator}) = ${rawN}/${rawD}.`;
  } else if (operation === "subtract") {
    rawN = (a.numerator * b.denominator) - (b.numerator * a.denominator);
    rawD = a.denominator * b.denominator;
    solution = `Use a common denominator: (${a.numerator} x ${b.denominator} - ${b.numerator} x ${a.denominator}) / (${a.denominator} x ${b.denominator}) = ${rawN}/${rawD}.`;
  } else if (operation === "multiply") {
    rawN = a.numerator * b.numerator;
    rawD = a.denominator * b.denominator;
    solution = `Multiply numerators and denominators: (${a.numerator} x ${b.numerator}) / (${a.denominator} x ${b.denominator}) = ${rawN}/${rawD}.`;
  } else {
    rawN = a.numerator * b.denominator;
    rawD = a.denominator * b.numerator;
    solution = `Divide by multiplying by the reciprocal: ${a.numerator}/${a.denominator} x ${b.denominator}/${b.numerator} = ${rawN}/${rawD}.`;
  }

  const simplified = simplifyFraction(rawN, rawD) || { numerator: rawN, denominator: rawD };
  const simplifiedText = formatFractionDisplay(simplified);

  return {
    question: `Calculate ${a.numerator}/${a.denominator} ${symbols[operation]} ${b.numerator}/${b.denominator}.`,
    solution: `${solution} Simplify to ${simplifiedText}.`,
    correctAnswer: simplifiedText,
    interactiveApp: {
      type: "fractions",
      config: {
        title: "Fraction Operations",
        operation,
        fractionA: { numerator: a.numerator, denominator: a.denominator },
        fractionB: { numerator: b.numerator, denominator: b.denominator }
      }
    }
  };
}

function matrixToAnswerString(matrix) {
  if (!matrixIsRectangular(matrix)) return "";
  return matrix
    .map((row) => row.map((value) => formatMatrixNumber(value)).join(","))
    .join(";");
}

function buildRandomMatrix(rows, cols, minValue, maxValue) {
  const matrix = [];
  for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
    const row = [];
    for (let colIndex = 0; colIndex < cols; colIndex += 1) {
      row.push(randomIntBetween(minValue, maxValue));
    }
    matrix.push(row);
  }
  return matrix;
}

function buildAutoMatrixPayload(subcategory, difficulty, resultTypeChoice = "auto", generationOptions = {}) {
  const normalizedSubcategory = String(subcategory || "matrix-a-dim").trim().toLowerCase();
  const normalizedDifficulty = String(difficulty || "easy").trim().toLowerCase();
  const desired = String(resultTypeChoice || "auto").trim().toLowerCase();
  const defaultResult = desired === "auto" ? "short-answer" : desired;

  const range = normalizedDifficulty === "hard"
    ? { min: -12, max: 12 }
    : normalizedDifficulty === "medium"
      ? { min: -9, max: 9 }
      : { min: -6, max: 6 };

  let operation = "multiply";
  let matrixA = [[1, 2], [3, 4]];
  let matrixB = [[5, 6], [7, 8]];
  let question = "";
  let solution = "";
  let correctAnswer = "";

  if (normalizedSubcategory === "matrix-a-dim") {
    operation = "multiply";
    const rows = normalizedDifficulty === "hard" ? 4 : normalizedDifficulty === "medium" ? 3 : 2;
    const cols = normalizedDifficulty === "hard" ? 3 : normalizedDifficulty === "medium" ? 4 : 3;
    matrixA = buildRandomMatrix(rows, cols, range.min, range.max);
    matrixB = [[1]];
    question = "What are the dimensions of Matrix A?";
    solution = `Dimensions are written as rows x columns. Matrix A has ${rows} rows and ${cols} columns, so the dimensions are ${rows} x ${cols}.`;
    correctAnswer = `${rows} x ${cols}`;
  } else if (normalizedSubcategory === "matrix-add" || normalizedSubcategory === "matrix-subtract") {
    operation = normalizedSubcategory === "matrix-add" ? "add" : "subtract";
    const rows = normalizedDifficulty === "hard" ? 3 : 2;
    const cols = normalizedDifficulty === "easy" ? 2 : 3;
    matrixA = buildRandomMatrix(rows, cols, range.min, range.max);
    matrixB = buildRandomMatrix(rows, cols, range.min, range.max);
    const result = operation === "add" ? matrixAdd(matrixA, matrixB) : matrixSubtract(matrixA, matrixB);
    if (!result) return null;
    const symbol = operation === "add" ? "+" : "-";
    question = `Calculate A ${symbol} B. Enter your matrix as rows separated by semicolons (e.g. 1,2;3,4).`;
    solution = `Compute each entry position-wise. The result is ${matrixToAnswerString(result)}.`;
    correctAnswer = matrixToAnswerString(result);
  } else if (normalizedSubcategory === "matrix-multiply") {
    operation = "multiply";
    const aRows = normalizedDifficulty === "hard" ? 3 : 2;
    const shared = normalizedDifficulty === "easy" ? 2 : 3;
    const bCols = normalizedDifficulty === "hard" ? 3 : 2;
    matrixA = buildRandomMatrix(aRows, shared, range.min, range.max);
    matrixB = buildRandomMatrix(shared, bCols, range.min, range.max);
    const result = matrixMultiply(matrixA, matrixB);
    if (!result) return null;
    question = "Calculate A x B. Enter your matrix as rows separated by semicolons (e.g. 1,2;3,4).";
    solution = `Multiply rows of A by columns of B. The result is ${matrixToAnswerString(result)}.`;
    correctAnswer = matrixToAnswerString(result);
  } else if (normalizedSubcategory === "matrix-transpose") {
    operation = "transpose";
    const rows = normalizedDifficulty === "hard" ? 4 : 3;
    const cols = normalizedDifficulty === "easy" ? 2 : 3;
    matrixA = buildRandomMatrix(rows, cols, range.min, range.max);
    matrixB = [[1]];
    const result = matrixTranspose(matrixA);
    if (!result) return null;
    question = "Find A^T (the transpose of A). Enter your matrix as rows separated by semicolons (e.g. 1,2;3,4).";
    solution = `Swap rows and columns of A. The transpose is ${matrixToAnswerString(result)}.`;
    correctAnswer = matrixToAnswerString(result);
  } else if (normalizedSubcategory === "matrix-determinant") {
    operation = "determinant";
    const size = normalizedDifficulty === "easy" ? 2 : 3;
    const detRange = normalizedDifficulty === "hard" ? { min: -6, max: 6 } : range;
    matrixA = buildRandomMatrix(size, size, detRange.min, detRange.max);
    matrixB = [[1]];
    const determinant = matrixDeterminant(matrixA);
    if (!Number.isFinite(determinant)) return null;
    question = "Find det(A).";
    solution = `Using determinant rules for a ${size}x${size} matrix, det(A) = ${formatMatrixNumber(determinant)}.`;
    correctAnswer = formatMatrixNumber(determinant);
  } else {
    return buildAutoMatrixPayload("matrix-a-dim", difficulty, resultTypeChoice, generationOptions);
  }

  return postProcessAutoPayload(
    asResultTypePayload(
      {
        question,
        solution,
        correctAnswer,
        interactiveApp: {
          type: "matrix",
          config: {
            title: "Matrix Operations",
            operation,
            matrixA,
            matrixB
          }
        },
        _generation: {
          answerPolicy: generationOptions.answerPolicy || "auto",
          decimalPlaces: generationOptions.decimalPlaces
        }
      },
      defaultResult
    ),
    generationOptions
  );
}

function buildDeterministicPayloadFromInteractiveApp(appType, app, desiredResultType = "short-answer", generationOptions = {}) {
  if (!app || app.type !== appType) return null;

  const cfg = app.config || {};
  const defaultResult = String(desiredResultType || "short-answer").trim();
  let base = null;

  if (appType === "arithmetic") {
    const operator = String(cfg.operator || "+").trim();
    const a = Number(cfg.operandA);
    const b = Number(cfg.operandB);
    const safeA = Number.isFinite(a) ? a : 0;
    const safeB = Number.isFinite(b) ? b : 0;
    let result = 0;
    if (operator === "-") result = safeA - safeB;
    else if (operator === "x" || operator === "*") result = safeA * safeB;
    else if (operator === "÷" || operator === "/") result = safeB !== 0 ? safeA / safeB : Number.NaN;
    else result = safeA + safeB;

    const answer = Number.isFinite(result) ? String(result) : "undefined";
    base = {
      question: "",
      solution: Number.isFinite(result)
        ? `Compute the operation: ${safeA} ${operator} ${safeB} = ${answer}.`
        : "Division by zero is undefined.",
      correctAnswer: answer,
      interactiveApp: app
    };
  } else if (appType === "number-line") {
    const points = Array.isArray(cfg.points) ? cfg.points : [];
    const first = points[0] || { value: -3, label: "A" };
    const second = points[1] || { value: 5, label: "B" };
    const distance = Math.abs(Number(second.value) - Number(first.value));
    base = {
      question: "",
      solution: `Distance = |${second.value} - ${first.value}| = ${distance}.`,
      correctAnswer: String(distance),
      interactiveApp: app
    };
  } else if (appType === "number-tracing") {
    const target = Number.parseInt(cfg.targetNumber, 10);
    const safeTarget = Number.isInteger(target) ? Math.max(0, Math.min(100, target)) : 5;
    const prepMode = Boolean(cfg.prepMode);
    base = {
      question: prepMode
        ? "Look at the dotted numeral. Choose the matching number, then trace it."
        : "Look at the dotted numeral in the interactive app. Identify the number and trace it.",
      solution: `The dotted numeral is ${safeTarget}. Trace it while saying ${safeTarget} aloud.`,
      correctAnswer: String(safeTarget),
      interactiveApp: app
    };
  } else if (appType === "bar-chart") {
    const items = Array.isArray(cfg.items) ? cfg.items : [];
    const top = items.slice().sort((a, b) => Number(b.frequency || 0) - Number(a.frequency || 0))[0] || { category: "Cats", frequency: 8 };
    base = {
      question: "",
      solution: `The largest bar is ${top.category} with frequency ${top.frequency}.`,
      correctAnswer: String(top.category || ""),
      interactiveApp: app
    };
  } else if (appType === "histogram") {
    const values = Array.isArray(cfg.values) ? cfg.values : [];
    base = {
      question: "",
      solution: `There are ${values.length} values in the dataset.`,
      correctAnswer: String(values.length),
      interactiveApp: app
    };
  } else if (appType === "box-plot") {
    const datasets = normalizeBoxPlotDatasets(cfg);
    const first = datasets[0] || { label: "A", values: [1, 2, 3] };
    const stats = computeFiveNumber(first.values || []);
    const median = stats ? roundTo(stats.median, 2) : 0;
    base = {
      question: "",
      solution: `For dataset ${first.label || "A"}, the median is ${median}.`,
      correctAnswer: String(median),
      interactiveApp: app
    };
  } else if (appType === "scatter-plot") {
    const points = Array.isArray(cfg.points) ? cfg.points : [];
    const regression = computeLinearRegression(points);
    const trend = !regression ? "no clear" : regression.correlation > 0 ? "positive" : regression.correlation < 0 ? "negative" : "no";
    base = {
      question: "",
      solution: `The data trend is ${trend} correlation.`,
      correctAnswer: trend === "no" ? "no correlation" : `${trend} correlation`,
      interactiveApp: app
    };
  } else if (appType === "probability-tree") {
    const paths = Array.isArray(cfg.paths) ? cfg.paths : [];
    const total = roundTo(paths.reduce((sum, path) => sum + Number(path.probability || 0), 0), 3);
    base = {
      question: "",
      solution: `Sum of listed path probabilities = ${total}.`,
      correctAnswer: String(total),
      interactiveApp: app
    };
  } else if (appType === "distribution-curve") {
    base = {
      question: "",
      solution: `The mean parameter shown is ${cfg.mean}.`,
      correctAnswer: String(cfg.mean),
      interactiveApp: app
    };
  } else if (appType === "fractions") {
    const operation = normalizeFractionOperation(cfg.operation);
    const a = simplifyFraction(cfg.fractionA && cfg.fractionA.numerator, cfg.fractionA && cfg.fractionA.denominator);
    const b = simplifyFraction(cfg.fractionB && cfg.fractionB.numerator, cfg.fractionB && cfg.fractionB.denominator);
    if (!a || !b || (operation === "divide" && b.numerator === 0)) {
      return null;
    }

    let numerator = 0;
    let denominator = 1;
    if (operation === "add") {
      numerator = a.numerator * b.denominator + b.numerator * a.denominator;
      denominator = a.denominator * b.denominator;
    } else if (operation === "subtract") {
      numerator = a.numerator * b.denominator - b.numerator * a.denominator;
      denominator = a.denominator * b.denominator;
    } else if (operation === "multiply") {
      numerator = a.numerator * b.numerator;
      denominator = a.denominator * b.denominator;
    } else {
      numerator = a.numerator * b.denominator;
      denominator = a.denominator * b.numerator;
    }
    const result = simplifyFraction(numerator, denominator);
    if (!result) return null;
    const resultText = `${result.numerator}/${result.denominator}`;
    base = {
      question: "",
      solution: `Applying the ${operation} operation gives ${resultText}.`,
      correctAnswer: resultText,
      interactiveApp: app
    };
  } else if (appType === "network-graph") {
    const nodes = Array.isArray(cfg.nodes) ? cfg.nodes : [];
    base = {
      question: "",
      solution: `There are ${nodes.length} nodes shown.`,
      correctAnswer: String(nodes.length),
      interactiveApp: app
    };
  } else if (appType === "matrix") {
    const matrixA = Array.isArray(cfg.matrixA) ? cfg.matrixA : [];
    const rows = matrixA.length;
    const cols = rows > 0 && Array.isArray(matrixA[0]) ? matrixA[0].length : 0;
    const matrixText = rows > 0
      ? `\nMatrix A:\n${matrixA.map((row) => `[${Array.isArray(row) ? row.join(" ") : ""}]`).join("\n")}`
      : "";
    base = {
      question: `What are the dimensions of Matrix A?${matrixText}`,
      solution: `Dimensions are written in the order rows x columns. Matrix A has ${rows} rows and ${cols} columns, so the dimensions are ${rows} x ${cols}.`,
      correctAnswer: `${rows} x ${cols}`,
      interactiveApp: app
    };
  } else if (appType === "stem-and-leaf") {
    const values = Array.isArray(cfg.values) ? cfg.values : [];
    base = {
      question: "",
      solution: `The dataset contains ${values.length} values.`,
      correctAnswer: String(values.length),
      interactiveApp: app
    };
  } else if (appType === "geometry-shapes") {
    const shapes = Array.isArray(cfg.shapes) ? cfg.shapes : [];
    base = {
      question: "",
      solution: `There are ${shapes.length} shape(s) configured.`,
      correctAnswer: String(shapes.length),
      interactiveApp: app
    };
  } else if (appType === "pythagoras") {
    const a = Number.parseFloat(cfg.sideA);
    const b = Number.parseFloat(cfg.sideB);
    const c = Number.parseFloat(cfg.sideC);
    let answer = "";
    let explanation = "";
    if (Number.isFinite(a) && Number.isFinite(b) && !Number.isFinite(c)) {
      const hyp = roundTo(Math.sqrt(a * a + b * b), 2);
      answer = String(hyp);
      explanation = `c = sqrt(${a}^2 + ${b}^2) = ${hyp}.`;
    } else if (Number.isFinite(a) && Number.isFinite(c) && !Number.isFinite(b)) {
      const side = roundTo(Math.sqrt(Math.max(0, c * c - a * a)), 2);
      answer = String(side);
      explanation = `b = sqrt(${c}^2 - ${a}^2) = ${side}.`;
    } else {
      answer = String(cfg.sideC || "5");
      explanation = `Use the configured sides to identify the missing value ${answer}.`;
    }
    base = {
      question: "",
      solution: explanation,
      correctAnswer: answer,
      interactiveApp: app
    };
  } else if (appType === "trigonometry") {
    const focus = String(cfg.focusFunction || "sin").trim().toLowerCase();
    const opp = Number.parseFloat(cfg.opposite);
    const adj = Number.parseFloat(cfg.adjacent);
    const hyp = Number.parseFloat(cfg.hypotenuse);
    let value = Number.NaN;
    if (focus === "sin" && Number.isFinite(opp) && Number.isFinite(hyp) && hyp !== 0) value = opp / hyp;
    if (focus === "cos" && Number.isFinite(adj) && Number.isFinite(hyp) && hyp !== 0) value = adj / hyp;
    if (focus === "tan" && Number.isFinite(opp) && Number.isFinite(adj) && adj !== 0) value = opp / adj;
    const answer = Number.isFinite(value) ? String(roundTo(value, 3)) : "not defined";
    base = {
      question: "",
      solution: `Using the side ratio for ${focus}, the value is ${answer}.`,
      correctAnswer: answer,
      interactiveApp: app
    };
  } else {
    return null;
  }

  return postProcessAutoPayload(
    asResultTypePayload(
      {
        ...base,
        _generation: {
          answerPolicy: generationOptions.answerPolicy || "auto",
          decimalPlaces: generationOptions.decimalPlaces
        }
      },
      defaultResult
    ),
    generationOptions
  );
}

function buildAutoTimePayload(subcategory, difficulty) {
  const normalizedSubcategory = String(subcategory || "digital").trim().toLowerCase();
  const resolvedSubcategory = normalizedSubcategory === "mixed-by-hour"
    ? (randomInt(0, 1) === 0 ? "analog-by-hour" : "digital-by-hour")
    : normalizedSubcategory;
  const normalizedDifficulty = String(difficulty || "medium").trim().toLowerCase();
  const safeDifficulty = ["easy", "medium", "hard"].includes(normalizedDifficulty) ? normalizedDifficulty : "medium";
  const isHourOnly = resolvedSubcategory === "analog-by-hour" || resolvedSubcategory === "digital-by-hour";
  const timeFocus = isHourOnly ? "hour-only" : "exact-time";
  const minuteStep = safeDifficulty === "easy" ? 15 : safeDifficulty === "medium" ? 5 : 1;
  const hour = randomInt(1, 12);
  const maxTicks = Math.floor(59 / minuteStep);
  const minute = isHourOnly ? 0 : randomInt(0, maxTicks) * minuteStep;
  const period = randomInt(0, 1) === 0 ? "AM" : "PM";
  const formatted = formatTimeValue(hour, minute);

  if (resolvedSubcategory === "analog" || resolvedSubcategory === "analog-by-hour") {
    return {
      question: buildDefaultTimeQuestionByMode("analog", hour, minute),
      solution: buildDefaultTimeSolutionByMode("analog", hour, minute),
      correctAnswer: formatted,
      resultType: "short-answer",
      interactiveApp: {
        type: "time",
        config: {
          mode: "analog",
          timeFocus,
          allowCustomAnswer: true,
          hour,
          minute,
          period: ""
        }
      }
    };
  }

  if (resolvedSubcategory === "analog-to-digital") {
    const correct = formatTimeValue(hour, minute);
    const options = Array.from(new Set([
      correct,
      formatTimeValue(hour, (minute + minuteStep) % 60),
      formatTimeValue(hour, (minute + 60 - minuteStep) % 60),
      formatTimeValue(((hour % 12) + 1), minute)
    ])).slice(0, 4);
    while (options.length < 4) {
      options.push(formatTimeValue(randomInt(1, 12), randomInt(0, 11) * 5));
    }

    return {
      question: buildDefaultTimeQuestionByMode("analog-to-digital", hour, minute),
      solution: buildDefaultTimeSolutionByMode("analog-to-digital", hour, minute),
      options,
      correctAnswer: correct,
      resultType: "multiple-choice",
      interactiveApp: {
        type: "time",
        config: {
          mode: "analog-to-digital",
          timeFocus,
          allowCustomAnswer: true,
          hour,
          minute,
          period: ""
        }
      }
    };
  }

  const digitalChallenge = resolvedSubcategory === "digital-by-hour"
    ? "words-to-12h"
    : ["words-to-12h", "12h-to-24h", "24h-to-12h"][randomInt(0, 2)];
  const correctAnswer = digitalChallenge === "12h-to-24h"
    ? formatTime24Value(hour, minute, period)
    : formatTimeValue(hour, minute, digitalChallenge === "24h-to-12h" ? period : "");

  return {
    question: buildDefaultTimeQuestionByMode("digital", hour, minute, period, digitalChallenge),
    solution: buildDefaultTimeSolutionByMode("digital", hour, minute, period, digitalChallenge),
    correctAnswer,
    resultType: "short-answer",
    interactiveApp: {
      type: "time",
      config: {
        mode: "digital",
        timeFocus,
        allowCustomAnswer: true,
        digitalChallenge,
        hour,
        minute,
        period
      }
    }
  };
}

function buildAutoCalendarPayload(subcategory, difficulty) {
  const normalizedSubcategory = String(subcategory || "days").trim().toLowerCase();
  const normalizedDifficulty = String(difficulty || "medium").trim().toLowerCase();
  const safeDifficulty = ["easy", "medium", "hard"].includes(normalizedDifficulty)
    ? normalizedDifficulty
    : "medium";

  const weekDays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  if (normalizedSubcategory === "years") {
    const baseYear = randomInt(1995, 2035);
    const step = safeDifficulty === "easy" ? 1 : safeDifficulty === "medium" ? 2 : 3;
    const question = `What year comes ${step === 1 ? "after" : `${step} years after`} ${baseYear}?`;
    const answer = String(baseYear + step);
    const values = Array.from({ length: 12 }, (_, index) => String(baseYear - 2 + index));
    return {
      question,
      solution: `${baseYear} + ${step} = ${answer}.`,
      correctAnswer: answer,
      options: ["", "", "", ""],
      resultType: "short-answer",
      interactiveApp: {
        type: "calendar-sequence",
        config: {
          mode: "years",
          prompt: question,
          current: String(baseYear),
          step,
          values
        }
      }
    };
  }

  if (normalizedSubcategory === "months") {
    const index = randomInt(0, months.length - 1);
    const step = safeDifficulty === "easy" ? 1 : safeDifficulty === "medium" ? 2 : 3;
    const answerIndex = (index + step) % months.length;
    const question = step === 1
      ? `If this month is ${months[index]}, what is the next month?`
      : `If this month is ${months[index]}, what month is ${step} months later?`;
    return {
      question,
      solution: `${step} month${step > 1 ? "s" : ""} after ${months[index]} is ${months[answerIndex]}.`,
      correctAnswer: months[answerIndex],
      options: ["", "", "", ""],
      resultType: "short-answer",
      interactiveApp: {
        type: "calendar-sequence",
        config: {
          mode: "months",
          prompt: question,
          current: months[index],
          step,
          values: months
        }
      }
    };
  }

  if (normalizedSubcategory === "dates") {
    const baseYear = randomInt(2024, 2028);
    const baseMonth = randomInt(1, 12);
    const baseDay = randomInt(1, 28);
    const start = new Date(baseYear, baseMonth - 1, baseDay);
    const step = safeDifficulty === "easy" ? 1 : safeDifficulty === "medium" ? 2 : 3;
    const answer = new Date(start);
    answer.setDate(start.getDate() + step);
    const startLabel = formatDateDdMmYyyy(start);
    const answerLabel = formatDateDdMmYyyy(answer);
    const values = Array.from({ length: 9 }, (_, index) => {
      const item = new Date(start);
      item.setDate(start.getDate() - 4 + index);
      return formatDateDdMmYyyy(item);
    });
    const question = step === 1
      ? `If today is ${startLabel}, what date is tomorrow? (DD/MM/YYYY)`
      : `If today is ${startLabel}, what date is ${step} days later? (DD/MM/YYYY)`;
    return {
      question,
      solution: `${startLabel} + ${step} day${step > 1 ? "s" : ""} = ${answerLabel}.`,
      correctAnswer: answerLabel,
      options: ["", "", "", ""],
      resultType: "short-answer",
      interactiveApp: {
        type: "calendar-sequence",
        config: {
          mode: "dates",
          prompt: question,
          current: startLabel,
          step,
          values
        }
      }
    };
  }

  const dayIndex = randomInt(0, weekDays.length - 1);
  const dayStep = safeDifficulty === "easy" ? 1 : safeDifficulty === "medium" ? 2 : 3;
  const dayAnswer = weekDays[(dayIndex + dayStep) % weekDays.length];
  const dayQuestion = dayStep === 1
    ? `If today is ${weekDays[dayIndex]}, what is the next day?`
    : `If today is ${weekDays[dayIndex]}, what day is ${dayStep} days later?`;
  return {
    question: dayQuestion,
    solution: `${dayStep} day${dayStep > 1 ? "s" : ""} after ${weekDays[dayIndex]} is ${dayAnswer}.`,
    correctAnswer: dayAnswer,
    options: ["", "", "", ""],
    resultType: "short-answer",
    interactiveApp: {
      type: "calendar-sequence",
      config: {
        mode: "days",
        prompt: dayQuestion,
        current: weekDays[dayIndex],
        step: dayStep,
        values: weekDays
      }
    }
  };
}

function ordinalSuffix(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n)) return "th";
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return "th";
  const mod10 = n % 10;
  if (mod10 === 1) return "st";
  if (mod10 === 2) return "nd";
  if (mod10 === 3) return "rd";
  return "th";
}

function formatDateDdMmYyyy(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "01/01/2000";
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = String(date.getFullYear());
  return `${dd}/${mm}/${yyyy}`;
}

function buildAutoPayloadForCategory(category, subcategory, difficulty, resultTypeChoice = "auto", generationOptions = {}) {
  const appType = String(category || "cartesian-plane").trim();
  const normalizedSubcategory = String(subcategory || "").trim();
  const desired = String(resultTypeChoice || "auto").trim().toLowerCase();
  const rawDifficulty = String(difficulty == null ? "" : difficulty).trim().toLowerCase();
  const parsedDifficulty = Number.parseInt(rawDifficulty, 10);
  const difficultyBand = Number.isFinite(parsedDifficulty)
    ? (parsedDifficulty <= 3 ? "easy" : parsedDifficulty <= 7 ? "medium" : "hard")
    : (["easy", "medium", "hard"].includes(rawDifficulty) ? rawDifficulty : "medium");
  // Arithmetic supports numeric 1-10 tuning. Other categories use easy/medium/hard pools.
  const effectiveDifficulty = appType === "arithmetic"
    ? (Number.isFinite(parsedDifficulty) ? parsedDifficulty : difficultyBand)
    : difficultyBand;
  const processedOptions = {
    ...generationOptions,
    category: appType,
    subcategory: normalizedSubcategory
  };

  if (appType === "introduction") {
    const base = buildAutoIntroductionPayload(subcategory);
    if (!base) return null;
    return postProcessAutoPayload(
      {
        ...base,
        _generation: {
          answerPolicy: generationOptions.answerPolicy || "auto",
          decimalPlaces: generationOptions.decimalPlaces
        }
      },
      processedOptions
    );
  }

  if (appType === "introduction-to-numbers") {
    const base = buildAutoIntroductionToNumbersPayload(subcategory, difficulty, generationOptions);
    if (!base) return null;
    return base;
  }

  if (appType === "calendar") {
    const base = buildAutoCalendarPayload(subcategory, effectiveDifficulty);
    if (!base) return null;
    return base;
  }

  if (appType === "time") {
    const base = buildAutoTimePayload(subcategory, effectiveDifficulty);
    if (!base) return null;
    const defaultResult = desired === "auto"
      ? (String(subcategory || "").trim().toLowerCase() === "analog-to-digital" ? "multiple-choice" : "short-answer")
      : desired;
    return postProcessAutoPayload(
      asResultTypePayload(
        {
          ...base,
          _generation: {
            answerPolicy: generationOptions.answerPolicy || "auto",
            decimalPlaces: generationOptions.decimalPlaces
          }
        },
        defaultResult
      ),
      processedOptions
    );
  }

  if (appType === "cartesian-plane") {
    return postProcessAutoPayload(
      buildAutoCreatedQuestionPayload(subcategory, effectiveDifficulty, resultTypeChoice),
      processedOptions
    );
  }
  if (appType === "cartesian-plane-plot") {
    return postProcessAutoPayload(
      buildAutoCartesianPlotPayload(subcategory, effectiveDifficulty),
      processedOptions
    );
  }
  if (appType === "arithmetic") {
    const base = buildAutoArithmeticPayload(subcategory, effectiveDifficulty, generationOptions);
    if (!base) return null;
    const defaultResult = desired === "auto" ? "short-answer" : desired;
    return postProcessAutoPayload(
      asResultTypePayload(
        {
          ...base,
          _generation: {
            answerPolicy: generationOptions.answerPolicy || "auto",
            decimalPlaces: generationOptions.decimalPlaces
          }
        },
        defaultResult
      ),
      processedOptions
    );
  }
  if (appType === "fractions") {
    const base = buildAutoFractionsPayload(subcategory, effectiveDifficulty, generationOptions);
    if (!base) return null;
    const defaultResult = desired === "auto" ? "short-answer" : desired;
    return postProcessAutoPayload(
      asResultTypePayload(
        {
          ...base,
          _generation: {
            answerPolicy: generationOptions.answerPolicy || "auto",
            decimalPlaces: generationOptions.decimalPlaces
          }
        },
        defaultResult
      ),
      processedOptions
    );
  }
  if (appType === "matrix") {
    return buildAutoMatrixPayload(subcategory, effectiveDifficulty, resultTypeChoice, generationOptions);
  }

  const app = buildDefaultInteractiveApp(appType);
  if (!app) return null;

  const cfg = app.config || {};
  const defaultResult = desired === "auto" ? "short-answer" : desired;
  let base = null;

  if (appType === "number-line") {
    const points = Array.isArray(cfg.points) ? cfg.points : [];
    const first = points[0] || { value: -3, label: "A" };
    const second = points[1] || { value: 5, label: "B" };
    const distance = Math.abs(Number(second.value) - Number(first.value));
    base = {
      question: `On the number line, what is the distance between ${first.label || "A"} and ${second.label || "B"}?`,
      solution: `Distance = |${second.value} - ${first.value}| = ${distance}.`,
      correctAnswer: String(distance),
      interactiveApp: app
    };
  } else if (appType === "bar-chart") {
    const items = Array.isArray(cfg.items) ? cfg.items : [];
    const top = items.slice().sort((a, b) => Number(b.frequency || 0) - Number(a.frequency || 0))[0] || { category: "Cats", frequency: 8 };
    base = {
      question: "Which category has the highest frequency in the bar chart?",
      solution: `The largest bar is ${top.category} with frequency ${top.frequency}.`,
      correctAnswer: String(top.category || ""),
      interactiveApp: app
    };
  } else if (appType === "histogram") {
    const values = Array.isArray(cfg.values) ? cfg.values : [];
    base = {
      question: "How many data values are represented in the histogram dataset?",
      solution: `There are ${values.length} values in the dataset.`,
      correctAnswer: String(values.length),
      interactiveApp: app
    };
  } else if (appType === "box-plot") {
    const datasets = normalizeBoxPlotDatasets(cfg);
    const first = datasets[0] || { label: "A", values: [1, 2, 3] };
    const stats = computeFiveNumber(first.values || []);
    const median = stats ? roundTo(stats.median, 2) : 0;
    base = {
      question: `What is the median of dataset ${first.label || "A"} in the box plot?`,
      solution: `For dataset ${first.label || "A"}, the median is ${median}.`,
      correctAnswer: String(median),
      interactiveApp: app
    };
  } else if (appType === "scatter-plot") {
    const points = Array.isArray(cfg.points) ? cfg.points : [];
    const regression = computeLinearRegression(points);
    const trend = !regression ? "no clear" : regression.correlation > 0 ? "positive" : regression.correlation < 0 ? "negative" : "no";
    base = {
      question: "What type of correlation does the scatter plot show?",
      solution: `The data trend is ${trend} correlation.`,
      correctAnswer: trend === "no" ? "no correlation" : `${trend} correlation`,
      interactiveApp: app
    };
  } else if (appType === "probability-tree") {
    const paths = Array.isArray(cfg.paths) ? cfg.paths : [];
    const total = roundTo(paths.reduce((sum, path) => sum + Number(path.probability || 0), 0), 3);
    base = {
      question: "What is the total probability of all listed paths?",
      solution: `Sum of listed path probabilities = ${total}.`,
      correctAnswer: String(total),
      interactiveApp: app
    };
  } else if (appType === "distribution-curve") {
    base = {
      question: "What is the mean of the normal distribution shown?",
      solution: `The mean parameter shown is ${cfg.mean}.`,
      correctAnswer: String(cfg.mean),
      interactiveApp: app
    };
  } else if (appType === "fractions") {
    const operation = normalizeFractionOperation(cfg.operation);
    const a = simplifyFraction(cfg.fractionA && cfg.fractionA.numerator, cfg.fractionA && cfg.fractionA.denominator);
    const b = simplifyFraction(cfg.fractionB && cfg.fractionB.numerator, cfg.fractionB && cfg.fractionB.denominator);
    let numerator = 0;
    let denominator = 1;
    if (operation === "add") {
      numerator = a.numerator * b.denominator + b.numerator * a.denominator;
      denominator = a.denominator * b.denominator;
    } else if (operation === "subtract") {
      numerator = a.numerator * b.denominator - b.numerator * a.denominator;
      denominator = a.denominator * b.denominator;
    } else if (operation === "multiply") {
      numerator = a.numerator * b.numerator;
      denominator = a.denominator * b.denominator;
    } else {
      numerator = a.numerator * b.denominator;
      denominator = a.denominator * b.numerator;
    }
    const result = simplifyFraction(numerator, denominator);
    const resultText = `${result.numerator}/${result.denominator}`;
    base = {
      question: "What is the simplified result of the fraction operation shown?",
      solution: `Applying the ${operation} operation gives ${resultText}.`,
      correctAnswer: resultText,
      interactiveApp: app
    };
  } else if (appType === "network-graph") {
    const nodes = Array.isArray(cfg.nodes) ? cfg.nodes : [];
    base = {
      question: "How many nodes are in the network graph?",
      solution: `There are ${nodes.length} nodes shown.`,
      correctAnswer: String(nodes.length),
      interactiveApp: app
    };
  } else if (appType === "matrix") {
    const matrixA = Array.isArray(cfg.matrixA) ? cfg.matrixA : [];
    const rows = matrixA.length;
    const cols = rows > 0 && Array.isArray(matrixA[0]) ? matrixA[0].length : 0;
    const matrixText = rows > 0
      ? `\nMatrix A:\n${matrixA.map((row) => `[${Array.isArray(row) ? row.join(" ") : ""}]`).join("\n")}`
      : "";
    base = {
      question: `What are the dimensions of Matrix A?${matrixText}`,
      solution: `Dimensions are written in the order rows x columns. Matrix A has ${rows} rows and ${cols} columns, so the dimensions are ${rows} x ${cols}.`,
      correctAnswer: `${rows} x ${cols}`,
      interactiveApp: app
    };
  } else if (appType === "stem-and-leaf") {
    const values = Array.isArray(cfg.values) ? cfg.values : [];
    base = {
      question: "How many values are represented in the stem-and-leaf plot?",
      solution: `The dataset contains ${values.length} values.`,
      correctAnswer: String(values.length),
      interactiveApp: app
    };
  } else if (appType === "geometry-shapes") {
    const shapes = Array.isArray(cfg.shapes) ? cfg.shapes : [];
    base = {
      question: "How many shapes are shown in the geometry diagram?",
      solution: `There are ${shapes.length} shape(s) configured.`,
      correctAnswer: String(shapes.length),
      interactiveApp: app
    };
  } else if (appType === "pythagoras") {
    const a = Number.parseFloat(cfg.sideA);
    const b = Number.parseFloat(cfg.sideB);
    const c = Number.parseFloat(cfg.sideC);
    let answer = "";
    let explanation = "";
    if (Number.isFinite(a) && Number.isFinite(b) && !Number.isFinite(c)) {
      const hyp = roundTo(Math.sqrt(a * a + b * b), 2);
      answer = String(hyp);
      explanation = `c = sqrt(${a}^2 + ${b}^2) = ${hyp}.`;
    } else if (Number.isFinite(a) && Number.isFinite(c) && !Number.isFinite(b)) {
      const side = roundTo(Math.sqrt(Math.max(0, c * c - a * a)), 2);
      answer = String(side);
      explanation = `b = sqrt(${c}^2 - ${a}^2) = ${side}.`;
    } else {
      answer = String(cfg.sideC || "5");
      explanation = `Use the configured sides to identify the missing value ${answer}.`;
    }
    base = {
      question: "Using Pythagoras' theorem, find the missing side length.",
      solution: explanation,
      correctAnswer: answer,
      interactiveApp: app
    };
  } else if (appType === "trigonometry") {
    const focus = String(cfg.focusFunction || "sin").trim().toLowerCase();
    const opp = Number.parseFloat(cfg.opposite);
    const adj = Number.parseFloat(cfg.adjacent);
    const hyp = Number.parseFloat(cfg.hypotenuse);
    let value = Number.NaN;
    if (focus === "sin" && Number.isFinite(opp) && Number.isFinite(hyp) && hyp !== 0) value = opp / hyp;
    if (focus === "cos" && Number.isFinite(adj) && Number.isFinite(hyp) && hyp !== 0) value = adj / hyp;
    if (focus === "tan" && Number.isFinite(opp) && Number.isFinite(adj) && adj !== 0) value = opp / adj;
    const answer = Number.isFinite(value) ? String(roundTo(value, 3)) : "not defined";
    base = {
      question: `What is the value of ${focus}(angle) for the triangle shown?`,
      solution: `Using the side ratio for ${focus}, the value is ${answer}.`,
      correctAnswer: answer,
      interactiveApp: app
    };
  } else {
    base = {
      question: `Use the ${appType} interactive app and determine the key result shown.`,
      solution: "Read the values from the interactive configuration and state the required result.",
      correctAnswer: "See app",
      interactiveApp: app
    };
  }

  return postProcessAutoPayload(
    asResultTypePayload(
      {
        ...base,
        _generation: {
          answerPolicy: generationOptions.answerPolicy || "auto",
          decimalPlaces: generationOptions.decimalPlaces
        }
      },
      defaultResult
    ),
    generationOptions
  );
}

function getSelectOptionLabel(selectId) {
  const select = document.getElementById(selectId);
  if (!(select instanceof HTMLSelectElement)) return "";
  const option = select.options[select.selectedIndex];
  return option ? String(option.textContent || "").trim() : "";
}

function normalizeAutoQuizQuestionCount(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return 1;
  return Math.max(1, Math.min(500, parsed));
}

function resolveAutoQuizYear(gradeValue, yearValue) {
  const year = String(yearValue || "auto").trim().toLowerCase();
  if (year !== "auto") {
    return year === "prep" ? "Prep" : `Year ${year}`;
  }

  const grade = String(gradeValue || "").trim().toLowerCase();
  if (grade === "prep") return "Prep";
  const yearMatch = grade.match(/^year-(\d+)$/);
  if (yearMatch) {
    return `Year ${yearMatch[1]}`;
  }
  return "";
}

function buildAutoQuizTemplatePool(gradeValue, yearValue = "auto") {
  const prepPool = [
    { category: "arithmetic", subcategory: "basic-addition-h", difficulty: "easy", resultType: "short-answer" },
    { category: "arithmetic", subcategory: "basic-subtraction", difficulty: "easy", resultType: "short-answer" },
    { category: "number-line", subcategory: "distance", difficulty: "easy", resultType: "short-answer" }
  ];

  const yearOnePool = [
    { category: "arithmetic", subcategory: "basic-addition-h", difficulty: "easy", resultType: "short-answer" },
    { category: "arithmetic", subcategory: "basic-addition-v", difficulty: "easy", resultType: "short-answer" },
    { category: "arithmetic", subcategory: "basic-subtraction", difficulty: "easy", resultType: "short-answer" },
    { category: "number-line", subcategory: "distance", difficulty: "easy", resultType: "short-answer" },
    { category: "bar-chart", subcategory: "highest-category", difficulty: "easy", resultType: "multiple-choice" }
  ];

  const lowerPrimaryPool = [
    { category: "arithmetic", subcategory: "basic-addition-h", difficulty: "easy", resultType: "short-answer" },
    { category: "arithmetic", subcategory: "basic-subtraction", difficulty: "easy", resultType: "short-answer" },
    { category: "arithmetic", subcategory: "basic-multiplication", difficulty: "easy", resultType: "short-answer" },
    { category: "number-line", subcategory: "distance", difficulty: "easy", resultType: "short-answer" },
    { category: "bar-chart", subcategory: "highest-category", difficulty: "easy", resultType: "multiple-choice" }
  ];

  const primaryPool = [
    { category: "arithmetic", subcategory: "basic-addition-h", difficulty: "easy", resultType: "short-answer" },
    { category: "arithmetic", subcategory: "basic-subtraction", difficulty: "easy", resultType: "short-answer" },
    { category: "arithmetic", subcategory: "basic-multiplication", difficulty: "easy", resultType: "short-answer" },
    { category: "arithmetic", subcategory: "division-short", difficulty: "easy", resultType: "short-answer" },
    { category: "fractions", subcategory: "operation-result", difficulty: "easy", resultType: "short-answer" },
    { category: "number-line", subcategory: "distance", difficulty: "easy", resultType: "short-answer" }
  ];

  const middlePool = [
    { category: "arithmetic", subcategory: "basic-multiplication", difficulty: "medium", resultType: "short-answer" },
    { category: "arithmetic", subcategory: "division-long", difficulty: "medium", resultType: "short-answer" },
    { category: "fractions", subcategory: "operation-result", difficulty: "medium", resultType: "short-answer" },
    { category: "cartesian-plane", subcategory: "point-on-axes", difficulty: "easy", resultType: "multiple-choice" },
    { category: "cartesian-plane", subcategory: "quadrant-identification", difficulty: "medium", resultType: "multiple-choice" },
    { category: "bar-chart", subcategory: "highest-category", difficulty: "easy", resultType: "multiple-choice" },
    { category: "histogram", subcategory: "count-values", difficulty: "easy", resultType: "short-answer" }
  ];

  const seniorPool = [
    { category: "cartesian-plane", subcategory: "linear", difficulty: "medium", resultType: "multiple-choice" },
    { category: "cartesian-plane", subcategory: "gradient", difficulty: "medium", resultType: "multiple-choice" },
    { category: "cartesian-plane", subcategory: "intercepts", difficulty: "medium", resultType: "multiple-choice" },
    { category: "cartesian-plane", subcategory: "domain-range", difficulty: "medium", resultType: "short-answer" },
    { category: "cartesian-plane-plot", subcategory: "linear", difficulty: "medium", resultType: "plot" },
    { category: "trigonometry", subcategory: "focus-function", difficulty: "medium", resultType: "short-answer" },
    { category: "probability-tree", subcategory: "path-sum", difficulty: "medium", resultType: "short-answer" }
  ];

  const methodsPool = [
    { category: "cartesian-plane", subcategory: "quadratic", difficulty: "medium", resultType: "multiple-choice" },
    { category: "cartesian-plane", subcategory: "transformations", difficulty: "hard", resultType: "short-answer" },
    { category: "cartesian-plane", subcategory: "gradient", difficulty: "hard", resultType: "multiple-choice" },
    { category: "cartesian-plane", subcategory: "intercepts", difficulty: "hard", resultType: "multiple-choice" },
    { category: "cartesian-plane-plot", subcategory: "quadratic", difficulty: "hard", resultType: "plot" },
    { category: "cartesian-plane-plot", subcategory: "transformations", difficulty: "hard", resultType: "plot" },
    { category: "trigonometry", subcategory: "focus-function", difficulty: "hard", resultType: "short-answer" }
  ];

  const generalUnit1Pool = [
    { category: "arithmetic", subcategory: "ratios-rates", difficulty: "medium", resultType: "short-answer" },
    { category: "fractions", subcategory: "operation-result", difficulty: "medium", resultType: "short-answer" },
    { category: "bar-chart", subcategory: "highest-category", difficulty: "medium", resultType: "multiple-choice" },
    { category: "histogram", subcategory: "count-values", difficulty: "medium", resultType: "short-answer" },
    { category: "probability-tree", subcategory: "path-sum", difficulty: "medium", resultType: "short-answer" }
  ];

  const generalPool = [
    { category: "arithmetic", subcategory: "ratios-rates", difficulty: "medium", resultType: "short-answer" },
    { category: "arithmetic", subcategory: "division-long", difficulty: "medium", resultType: "short-answer" },
    { category: "fractions", subcategory: "operation-result", difficulty: "medium", resultType: "short-answer" },
    { category: "bar-chart", subcategory: "highest-category", difficulty: "medium", resultType: "multiple-choice" },
    { category: "histogram", subcategory: "count-values", difficulty: "medium", resultType: "short-answer" },
    { category: "box-plot", subcategory: "median", difficulty: "medium", resultType: "short-answer" },
    { category: "scatter-plot", subcategory: "correlation-sign", difficulty: "medium", resultType: "multiple-choice" },
    { category: "probability-tree", subcategory: "path-sum", difficulty: "medium", resultType: "short-answer" }
  ];

  const specialistPool = [
    { category: "cartesian-plane", subcategory: "cubic", difficulty: "hard", resultType: "multiple-choice" },
    { category: "cartesian-plane", subcategory: "asymptotes", difficulty: "hard", resultType: "multiple-choice" },
    { category: "cartesian-plane-plot", subcategory: "cubic", difficulty: "hard", resultType: "plot" },
    { category: "cartesian-plane-plot", subcategory: "asymptotes", difficulty: "hard", resultType: "plot" },
    { category: "matrix", subcategory: "matrix-a-dim", difficulty: "hard", resultType: "short-answer" },
    { category: "network-graph", subcategory: "node-count", difficulty: "medium", resultType: "short-answer" },
    { category: "trigonometry", subcategory: "focus-function", difficulty: "hard", resultType: "short-answer" }
  ];

  const yearLevel = deriveYearLevelFromGenerationOptions({ gradeValue, yearValue });
  if (yearLevel === 0) {
    return prepPool;
  }
  if (yearLevel === 1) {
    return yearOnePool;
  }
  if (yearLevel === 2) {
    return lowerPrimaryPool;
  }
  if (Number.isInteger(yearLevel) && yearLevel >= 3 && yearLevel <= 6) {
    return primaryPool;
  }
  if (Number.isInteger(yearLevel) && yearLevel >= 7 && yearLevel <= 8) {
    return middlePool;
  }
  if (Number.isInteger(yearLevel) && yearLevel >= 9 && yearLevel <= 10) {
    return seniorPool;
  }

  const grade = String(gradeValue || "").trim().toLowerCase();
  if (grade.startsWith("vce-methods-")) {
    return methodsPool;
  }
  if (grade === "vce-general-unit-1") {
    return generalUnit1Pool;
  }
  if (grade.startsWith("vce-general-")) {
    return generalPool;
  }
  if (grade.startsWith("vce-specialist-")) {
    return specialistPool;
  }
  return middlePool;
}

function resolveAutoQuizDifficultyFromYear(gradeValue, yearValue) {
  const yearLevel = deriveYearLevelFromGenerationOptions({ gradeValue, yearValue });
  if (yearLevel === null) {
    const grade = String(gradeValue || "").trim().toLowerCase();
    if (grade.startsWith("vce-")) {
      return "hard";
    }
    return "medium";
  }

  if (yearLevel <= 2) return "easy";
  if (yearLevel <= 8) return "medium";
  return "hard";
}

function resolveAutoCreateDifficultyFromGrade() {
  const gradeSelect = document.getElementById("autoQuizGrade");
  const gradeValue = gradeSelect instanceof HTMLSelectElement ? String(gradeSelect.value || "year-7") : "year-7";
  return resolveAutoQuizDifficultyFromYear(gradeValue, "auto");
}

function syncAutoCreateDifficultyControl() {
  const difficultyBadge = document.getElementById("autoCreateDifficultyBadge");
  if (!(difficultyBadge instanceof HTMLElement)) return;
  const autoDifficulty = resolveAutoCreateDifficultyFromGrade();
  const normalized = ["easy", "medium", "hard"].includes(autoDifficulty) ? autoDifficulty : "medium";
  difficultyBadge.textContent = `Auto Difficulty: ${capitalizeWord(normalized)}`;
}

function buildAutoQuizQuestion(questionTemplate, index, generationOptions) {
  const commandWordChoice = normalizeCommandWordChoice(generationOptions && generationOptions.commandWord);
  const nextCommandWord = pickCommandWordFromChoice(commandWordChoice, {
    resultType: questionTemplate && questionTemplate.resultType,
    index,
    category: questionTemplate && questionTemplate.category,
    subcategory: questionTemplate && questionTemplate.subcategory
  });
  const difficultyOverride = String(generationOptions && generationOptions.yearDifficulty || "").trim().toLowerCase();
  const normalizedOverride = ["easy", "medium", "hard"].includes(difficultyOverride) ? difficultyOverride : "";
  const nextDifficulty = normalizedOverride || (questionTemplate && questionTemplate.difficulty) || "medium";
  const options = {
    ...generationOptions,
    commandWord: nextCommandWord,
    category: questionTemplate && questionTemplate.category ? questionTemplate.category : "",
    questionIndex: index
  };
  return buildAutoPayloadForCategory(
    questionTemplate.category,
    questionTemplate.subcategory,
    nextDifficulty,
    questionTemplate.resultType,
    options
  );
}

async function autoCreateEntireQuiz(quizId = state.selectedQuizId) {
  const category = activeCategory();
  if (!category) {
    showToast("Select a category first.", "warning");
    return;
  }

  if (quizId && state.selectedQuizId !== quizId) {
    state.selectedQuizId = quizId;
  }

  const quiz = activeQuiz();
  if (!quiz) {
    showToast("Select a quiz first.", "warning");
    return;
  }

  const existingQuestions = Array.isArray(quiz.questions) ? quiz.questions : [];
  const existingCount = existingQuestions.length;

  const gradeSelect = document.getElementById("autoQuizGrade");
  const countInput = document.getElementById("autoQuizQuestionCount");
  const selectedCategory = String(document.getElementById("autoCreateCategory").value || "").trim();
  const selectedSubcategory = String(document.getElementById("autoCreateSubcategory").value || "").trim();

  const gradeValue = gradeSelect instanceof HTMLSelectElement ? String(gradeSelect.value || "year-7") : "year-7";
  const gradeLabel = getSelectOptionLabel("autoQuizGrade") || "VCAA Mathematics";
  const yearValue = "auto";
  const yearLabel = resolveAutoQuizYear(gradeValue, yearValue);
  const yearDifficulty = resolveAutoQuizDifficultyFromYear(gradeValue, yearValue);
  const questionCount = normalizeAutoQuizQuestionCount(countInput instanceof HTMLInputElement ? countInput.value : 1);
  if (countInput instanceof HTMLInputElement) {
    countInput.value = String(questionCount);
  }

  const generationOptions = {
    commandWord: "random",
    answerPolicy: "auto",
    decimalPlaces: 2,
    gradeValue,
    yearValue,
    yearDifficulty,
    domainMin: null,
    domainMax: null
  };

  const focusedTemplate = selectedCategory && selectedSubcategory
    ? [{
      category: selectedCategory,
      subcategory: selectedSubcategory,
      difficulty: yearDifficulty,
      resultType: "auto"
    }]
    : null;

  const templatePool = Array.isArray(focusedTemplate) && focusedTemplate.length > 0
    ? focusedTemplate
    : buildAutoQuizTemplatePool(gradeValue, yearValue);
  if (!Array.isArray(templatePool) || templatePool.length === 0) {
    showToast("No templates available for that grade/course.", "warning");
    return;
  }

  const globalTemplatePool = buildAutoQuizTemplatePool(gradeValue, yearValue);
  const categoryExpansionPool = selectedCategory
    ? globalTemplatePool.filter((item) => String(item.category || "").trim() === selectedCategory)
    : [];
  const strictSubcategoryPool = selectedCategory && selectedSubcategory
    ? globalTemplatePool.filter((item) => {
      const itemCategory = String(item.category || "").trim();
      const itemSubcategory = String(item.subcategory || "").trim();
      return itemCategory === selectedCategory && itemSubcategory === selectedSubcategory;
    })
    : [];
  const hasFocusedTemplate = Array.isArray(focusedTemplate) && focusedTemplate.length > 0;
  const expansionPool = hasFocusedTemplate
    ? (strictSubcategoryPool.length > 0 ? strictSubcategoryPool : focusedTemplate)
    : [];

  const generatedQuestions = [];
  const failureMessages = [];
  const seenSignatures = new Set();
  existingQuestions.forEach((item) => {
    if (!item || isIntroductionQuestionItem(item)) return;
    const signature = buildQuestionUniquenessSignature(item);
    if (signature) seenSignatures.add(signature);
  });

  let activeTemplatePool = templatePool.slice();
  let expandedTemplatePool = false;
  const maxAttempts = Math.max(questionCount * 60, 1200);
  let attempts = 0;
  let cursor = 0;

  while (generatedQuestions.length < questionCount && attempts < maxAttempts) {
    if (activeTemplatePool.length === 0) {
      break;
    }

    const template = activeTemplatePool[cursor % activeTemplatePool.length];
    const payload = buildAutoQuizQuestion(template, generatedQuestions.length, generationOptions);
    attempts += 1;
    cursor += 1;

    if (!payload) {
      failureMessages.push(`${template.category}/${template.subcategory}: no payload generated`);
      continue;
    }

    const verification = verifyAutoPayload(template.category, template.subcategory, payload);
    if (!verification.ok) {
      failureMessages.push(`${template.category}/${template.subcategory}: ${verification.issues[0] || "verification failed"}`);
      continue;
    }

    const normalizedCandidate = normalizeQuestion({
      question: payload.question || "",
      resultType: payload.resultType || "short-answer",
      options: Array.isArray(payload.options) ? payload.options : ["", "", "", ""],
      correctAnswer: payload.correctAnswer || "",
      notesAttachments: [],
      image: "",
      solution: payload.solution || "",
      solutionAttachments: [],
      interactiveApp: payload.interactiveApp || null
    });

    if (isQuestionDuplicateInSet(normalizedCandidate, seenSignatures)) {
      failureMessages.push(`${template.category}/${template.subcategory}: duplicate question skipped`);
      continue;
    }

    const signature = buildQuestionUniquenessSignature(normalizedCandidate);
    if (signature) seenSignatures.add(signature);
    generatedQuestions.push(normalizedCandidate);

    // If generation stalls, only widen within allowed scope.
    if (!expandedTemplatePool && hasFocusedTemplate && generatedQuestions.length < questionCount) {
      const progressRatio = generatedQuestions.length / Math.max(1, attempts);
      const shouldExpand = attempts > Math.max(300, questionCount * 2) && progressRatio < 0.35;
      const canExpandBeyondCurrent = Array.isArray(expansionPool)
        && expansionPool.length > 0
        && expansionPool.some((item) => !activeTemplatePool.some((active) => active.category === item.category && active.subcategory === item.subcategory && active.resultType === item.resultType && active.difficulty === item.difficulty));
      if (shouldExpand && canExpandBeyondCurrent) {
        activeTemplatePool = expansionPool.slice();
        cursor = 0;
        expandedTemplatePool = true;
      }
    }
  }

  if (generatedQuestions.length === 0) {
    const firstFailure = failureMessages[0] || "No valid questions generated.";
    showToast(`Auto quiz generation failed: ${firstFailure}`, "error");
    return;
  }

  const hasIntroductionAtStart = existingQuestions.length > 0 && isIntroductionQuestionItem(existingQuestions[0]);
  const introQuestion = hasIntroductionAtStart ? null : createAutoIntroductionQuestion(generationOptions);
  if (introQuestion) {
    quiz.questions = [introQuestion].concat(existingQuestions, generatedQuestions);
  } else {
    quiz.questions = existingQuestions.concat(generatedQuestions);
  }
  if (!String(quiz.title || "").trim()) {
    quiz.title = `${gradeLabel}${yearLabel ? ` ${yearLabel}` : ""} Auto Quiz`;
  }
  quiz.description = `Auto-generated quiz aligned to VCAA style for ${gradeLabel}${yearLabel ? ` (${yearLabel})` : ""}.`;
  quiz.settings = normalizeQuizSettings({
    questionOrder: "ordered",
    questionLimit: quiz.questions.length
  });

  state.selectedQuestionIndex = (introQuestion ? 1 : 0) + existingCount;
  renderAll();
  await persistSelectedQuizAfterMutation("Auto-generated questions");

  if (generatedQuestions.length < questionCount) {
    const expandedNote = expandedTemplatePool
      ? " Unique combinations were exhausted in the selected scope."
      : "";
    showToast(`Added ${generatedQuestions.length}/${questionCount} questions. Some templates failed verification.${expandedNote}`, "warning");
    return;
  }

  showToast(`Added ${generatedQuestions.length} VCAA-aligned questions.`, "success");
}

function buildAutoCreatedQuestionPayload(subcategory, difficulty, resultTypeChoice = "auto") {
  const normalizedSubcategory = String(subcategory || "linear").trim().toLowerCase();
  const normalizedDifficulty = String(difficulty || "easy").trim().toLowerCase();
  const normalizedResultType = String(resultTypeChoice || "auto").trim().toLowerCase();
  const isPlotSubcategory = ["linear", "quadratic", "cubic", "exponential", "transformations"].includes(normalizedSubcategory);
  const desiredResultType = normalizedResultType === "auto"
    ? (isPlotSubcategory ? "plot" : "multiple-choice")
    : normalizedResultType;

  if (desiredResultType === "plot" || desiredResultType === "short-answer") {
    return buildAutoCartesianPlotPayload(normalizedSubcategory, normalizedDifficulty);
  }
  if (desiredResultType === "true-false") {
    return buildAutoCartesianTrueFalsePayload(normalizedSubcategory, normalizedDifficulty);
  }
  return buildAutoCartesianMcqPayload(normalizedSubcategory, normalizedDifficulty);
}

function applyAutoCreatedQuestionToEditor(payload) {
  if (!payload) return;
  document.getElementById("questionText").value = payload.question || "";
  document.getElementById("resultType").value = payload.resultType || "short-answer";
  document.getElementById("option1").value = payload.options && payload.options[0] ? payload.options[0] : "";
  document.getElementById("option2").value = payload.options && payload.options[1] ? payload.options[1] : "";
  document.getElementById("option3").value = payload.options && payload.options[2] ? payload.options[2] : "";
  document.getElementById("option4").value = payload.options && payload.options[3] ? payload.options[3] : "";
  document.getElementById("correctAnswer").value = payload.correctAnswer || "";
  document.getElementById("solutionText").value = payload.solution || "";

  refreshCorrectAnswerSelect({
    resultType: payload.resultType || "short-answer",
    options: payload.options || ["", "", "", ""],
    correctAnswer: payload.correctAnswer || "",
    interactiveApp: payload.interactiveApp || null
  });

  const select = document.getElementById("correctAnswerSelect");
  if ((payload.resultType === "multiple-choice" || payload.resultType === "true-false") && select) {
    const choiceOptions = (payload.options || []).map((item) => String(item || "").trim()).filter((item) => item !== "");
    const answerIndex = choiceOptions.findIndex((item) => normalizeText(item) === normalizeText(payload.correctAnswer || ""));
    select.value = answerIndex >= 0 ? String(answerIndex) : "";
  }

  const app = payload.interactiveApp || null;
  const typeSelect = document.getElementById("interactiveAppType");
  typeSelect.value = app && app.type ? app.type : "";
  if (app) {
    populateInteractiveAppForm(app);
  } else {
    setInteractiveAppConfigVisibility("");
    renderInteractiveAppPreview(null);
  }
}

function defaultBoxPlotDatasetLabel(index) {
  const offset = Number(index);
  if (Number.isInteger(offset) && offset >= 0 && offset < 26) {
    return String.fromCharCode(65 + offset);
  }
  return `Dataset ${Number.isInteger(offset) ? offset + 1 : 1}`;
}

function clampBoxPlotDatasetCount(value) {
  const count = Number.parseInt(value, 10);
  if (!Number.isInteger(count)) return 2;
  return Math.max(1, Math.min(8, count));
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
    datasets.push({
      label: rawLabel || defaultBoxPlotDatasetLabel(index),
      values: parseNumericList(rawValues)
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

function parseBarChartItems(text) {
  return parseLineList(text)
    .map((line) => {
      const parts = splitCsvLine(line);
      const category = String(parts[0] || "").trim();
      const frequency = Number.parseFloat(parts[1]);
      if (!category || !Number.isFinite(frequency)) return null;
      return {
        category,
        frequency: Math.max(0, frequency),
        color: parts[2] || "#2563eb"
      };
    })
    .filter(Boolean);
}

function parseProbabilityTreePaths(text) {
  return parseLineList(text)
    .map((line) => {
      const parts = splitCsvLine(line);
      if (parts.length < 2) return null;
      const path = String(parts[0] || "").split(">").map((item) => item.trim()).filter((item) => item !== "");
      const probability = Number.parseFloat(parts[1]);
      if (path.length === 0 || !Number.isFinite(probability)) return null;
      return { path, probability: Math.max(0, probability) };
    })
    .filter(Boolean);
}

function parseNetworkNodes(text) {
  return String(text || "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function parseNetworkEdges(text) {
  return parseLineList(text)
    .map((line) => {
      const parts = splitCsvLine(line);
      if (parts.length < 3) return null;
      const from = String(parts[0] || "").trim();
      const to = String(parts[1] || "").trim();
      const weight = Number.parseFloat(parts[2]);
      const capacity = Number.parseFloat(parts[3]);
      if (!from || !to || !Number.isFinite(weight)) return null;
      return {
        from,
        to,
        weight,
        capacity: Number.isFinite(capacity) ? Math.max(0, capacity) : Math.max(0, weight)
      };
    })
    .filter(Boolean);
}

function parseMatrixRows(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const values = line
        .replace(/,/g, " ")
        .split(/\s+/)
        .map((item) => Number.parseFloat(item));
      if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
        return null;
      }
      return values;
    })
    .filter(Boolean);
}

function normalizeGeometryShapeType(value) {
  const kind = String(value || "").trim().toLowerCase();
  if (["rectangle", "square", "circle", "triangle", "cube", "cuboid", "sphere", "cylinder"].includes(kind)) return kind;
  return "rectangle";
}

function parseGeometryShapes(text) {
  return parseLineList(text)
    .map((line) => {
      const parts = splitCsvLine(line);
      if (parts.length < 5) return null;
      const type = normalizeGeometryShapeType(parts[0]);
      const x = Number.parseFloat(parts[1]);
      const y = Number.parseFloat(parts[2]);
      const w = Number.parseFloat(parts[3]);
      const h = Number.parseFloat(parts[4]);
      const usesExtendedFormat = parts.length >= 9;
      const d = usesExtendedFormat ? Number.parseFloat(parts[5]) : Number.NaN;
      const labelIndex = usesExtendedFormat ? 6 : 5;
      const colorIndex = usesExtendedFormat ? 7 : 6;
      const fillIndex = usesExtendedFormat ? 8 : 7;
      if (![x, y, w].every(Number.isFinite)) return null;
      return {
        type,
        x,
        y,
        w,
        h: Number.isFinite(h) ? h : w,
        d: Number.isFinite(d) ? d : 0,
        label: parts[labelIndex] || "",
        color: parts[colorIndex] || "#2563eb",
        fill: parts[fillIndex] || "#dbeafe"
      };
    })
    .filter(Boolean);
}

function serializeNlPoints(points) {
  if (!Array.isArray(points)) return "";
  return points.map((point) => `${point.value}, ${point.label || ""}, ${point.color || "#2563eb"}`).join("\n");
}

function serializeNlArrows(arrows) {
  if (!Array.isArray(arrows)) return "";
  return arrows.map((arrow) => `${arrow.from} → ${arrow.to}${arrow.label ? `, ${arrow.label}` : ""}`).join("\n");
}

function serializeCartesianPoints(points) {
  if (!Array.isArray(points)) return "";
  return points.map((point) => `${point.x}, ${point.y}, ${point.label || ""}, ${point.color || "#2563eb"}`).join("\n");
}

function serializeCartesianSegments(segments) {
  if (!Array.isArray(segments)) return "";
  return segments.map((segment) => `${segment.x1}, ${segment.y1} → ${segment.x2}, ${segment.y2}${segment.label ? `, ${segment.label}` : ""}${segment.color ? `, ${segment.color}` : ""}`).join("\n");
}

function serializeCartesianParabolas(parabolas) {
  if (!Array.isArray(parabolas)) return "";
  return parabolas
    .map((item) => `${item.a}, ${item.b}, ${item.c}${item.label ? `, ${item.label}` : ""}${item.color ? `, ${item.color}` : ""}`)
    .join("\n");
}

function serializeCartesianFunctions(functionsList) {
  if (!Array.isArray(functionsList)) return "";
  return functionsList
    .map((item) => `${item.expression || ""}${item.label ? `, ${item.label}` : ""}${item.color ? `, ${item.color}` : ""}`)
    .join("\n");
}

function serializeGeometryShapes(shapes) {
  if (!Array.isArray(shapes)) return "";
  return shapes
    .map((shape) => `${shape.type || "rectangle"}, ${shape.x}, ${shape.y}, ${shape.w}, ${shape.h}, ${shape.d || 0}, ${shape.label || ""}, ${shape.color || "#2563eb"}, ${shape.fill || "#dbeafe"}`)
    .join("\n");
}

function serializeBarChartItems(items) {
  if (!Array.isArray(items)) return "";
  return items
    .map((item) => `${item.category || ""}, ${item.frequency ?? ""}${item.color ? `, ${item.color}` : ""}`)
    .join("\n");
}

function serializeProbabilityTreePaths(paths) {
  if (!Array.isArray(paths)) return "";
  return paths
    .map((item) => `${Array.isArray(item.path) ? item.path.join(">") : ""}, ${item.probability ?? ""}`)
    .join("\n");
}

function serializeNetworkEdges(edges) {
  if (!Array.isArray(edges)) return "";
  return edges
    .map((edge) => `${edge.from || ""}, ${edge.to || ""}, ${edge.weight ?? ""}, ${edge.capacity ?? ""}`)
    .join("\n");
}

function serializeMatrixRows(rows) {
  if (!Array.isArray(rows)) return "";
  return rows
    .filter((row) => Array.isArray(row) && row.length > 0)
    .map((row) => row.map((value) => Number(value)).filter((value) => Number.isFinite(value)).join(", "))
    .join("\n");
}

function buildDefaultInteractiveApp(type) {
  switch (type) {
    case "time":
      return {
        type,
        config: {
          mode: "digital",
          timeFocus: "exact-time",
          allowCustomAnswer: false,
          digitalChallenge: "words-to-12h",
          hour: 3,
          minute: 15,
          period: ""
        }
      };
    case "number-tracing":
      return {
        type,
        config: {
          targetNumber: 5,
          prompt: "Tap the matching number, then trace it.",
          prepMode: true,
          showQuantityDots: true
        }
      };
    case "number-ordering":
      return {
        type,
        config: {
          prompt: "Order the number cards from smallest to largest.",
          direction: "ascending",
          cards: [7, 3, 9, 5],
          correctOrder: [3, 5, 7, 9]
        }
      };
    case "icon-count":
      return {
        type,
        config: {
          prompt: "How many icons are shown in total?",
          totalCount: 8,
          iconShape: "circle",
          groups: [3, 2, 3]
        }
      };
    case "calendar-sequence":
      return {
        type,
        config: {
          mode: "days",
          prompt: "If today is Tuesday, what is the next day?",
          current: "Tuesday",
          step: 1,
          values: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
        }
      };
    case "arithmetic":
      return {
        type,
        config: {
          layout: "horizontal",
          operator: "+",
          operandA: 7,
          operandB: 5,
          answer: "12",
          answerDigits: 2
        }
      };
    case "number-line":
      return {
        type,
        config: {
          min: -10,
          max: 10,
          points: [{ value: -3, label: "A", color: "#dc2626" }, { value: 5, label: "B", color: "#2563eb" }],
          arrows: [{ from: -3, to: 5, label: "+8" }]
        }
      };
    case "cartesian-plane":
      return {
        type,
        config: {
          xMin: -10,
          xMax: 10,
          yMin: -10,
          yMax: 10,
          angleMode: "radians",
          points: [{ x: 3, y: -2, label: "P", color: "#2563eb" }],
          segments: [{ x1: 0, y1: 0, x2: 4, y2: 3, label: "segment", color: "#f59e0b" }],
          parabolas: [{ a: 1, b: 0, c: 0, label: "y = x^2", color: "#7c3aed" }],
          functions: [{ expression: "sin(x)", label: "y = sin(x)", color: "#0f766e" }]
        }
      };
    case "cartesian-plane-plot":
      return {
        type,
        config: {
          xMin: -10,
          xMax: 10,
          yMin: -10,
          yMax: 10,
          tolerance: 0.5,
          points: [{ x: 3, y: 4, label: "A" }, { x: -2, y: -3, label: "B" }],
          vceTemplate: "",
          presetType: "linear",
          presetExpression: "2*x + 1",
          presetXValues: "-2, -1, 0, 1, 2"
        }
      };
    case "bar-chart":
      return {
        type,
        config: {
          title: "Category Frequencies",
          yMax: null,
          orientation: "vertical",
          categoryAxisLabel: "Category",
          valueAxisLabel: "Value",
          items: [
            { category: "Cats", frequency: 8, color: "#2563eb" },
            { category: "Dogs", frequency: 12, color: "#16a34a" },
            { category: "Birds", frequency: 5, color: "#f59e0b" }
          ]
        }
      };
    case "histogram":
      return {
        type,
        config: {
          title: "Continuous Data Distribution",
          values: [12, 13, 14, 16, 18, 22, 25, 27, 29, 33],
          binCount: 8
        }
      };
    case "box-plot":
      return {
        type,
        config: {
          title: "Compare Datasets",
          datasets: [
            { label: "A", values: [8, 9, 10, 12, 14, 17, 20] },
            { label: "B", values: [6, 8, 11, 12, 13, 14, 18] }
          ]
        }
      };
    case "scatter-plot":
      return {
        type,
        config: {
          title: "Correlation and Best Fit",
          points: [
            { x: 1, y: 2, label: "P1", color: "#2563eb" },
            { x: 2, y: 3, label: "P2", color: "#2563eb" },
            { x: 3, y: 5, label: "P3", color: "#2563eb" },
            { x: 4, y: 7, label: "P4", color: "#2563eb" }
          ]
        }
      };
    case "probability-tree":
      return {
        type,
        config: {
          title: "Sequential Probabilities",
          paths: [
            { path: ["Rain", "Traffic"], probability: 0.3 },
            { path: ["Rain", "NoTraffic"], probability: 0.1 },
            { path: ["NoRain", "Traffic"], probability: 0.2 },
            { path: ["NoRain", "NoTraffic"], probability: 0.4 }
          ],
          conditionalQuery: "Traffic|Rain"
        }
      };
    case "distribution-curve":
      return {
        type,
        config: {
          title: "Normal Distribution",
          mean: 0,
          stdDev: 1,
          from: -1,
          to: 1
        }
      };
    case "fractions":
      return {
        type,
        config: {
          operation: "add",
          fractionA: { numerator: 1, denominator: 2 },
          fractionB: { numerator: 1, denominator: 3 }
        }
      };
    case "network-graph":
      return {
        type,
        config: {
          title: "Shortest Path, MST, Flow",
          nodes: ["A", "B", "C", "D", "E"],
          edges: [
            { from: "A", to: "B", weight: 4, capacity: 8 },
            { from: "A", to: "C", weight: 2, capacity: 5 },
            { from: "B", to: "D", weight: 3, capacity: 6 },
            { from: "C", to: "D", weight: 1, capacity: 4 },
            { from: "D", to: "E", weight: 2, capacity: 7 }
          ],
          source: "A",
          target: "E",
          flowSource: "A",
          flowSink: "E"
        }
      };
    case "matrix":
      return {
        type,
        config: {
          title: "Matrix Operations",
          operation: "multiply",
          matrixA: [[1, 2, 3], [4, 5, 6]],
          matrixB: [[7, 8], [9, 10], [11, 12]]
        }
      };
    case "stem-and-leaf":
      return {
        type,
        config: {
          values: [12, 13, 17, 21, 25, 29, 32],
          stemUnit: 10
        }
      };
    case "geometry-shapes":
      return {
        type,
        config: {
          canvasWidth: 360,
          canvasHeight: 260,
          unit: "unit",
          formulaNotation: "plain",
          shapes: [
            { type: "rectangle", x: 90, y: 80, w: 90, h: 60, d: 0, label: "Rect A", color: "#2563eb", fill: "#dbeafe" },
            { type: "circle", x: 240, y: 80, w: 35, h: 35, d: 0, label: "Circle B", color: "#16a34a", fill: "#dcfce7" },
            { type: "cube", x: 170, y: 190, w: 70, h: 70, d: 70, label: "Cube C", color: "#dc2626", fill: "#fee2e2" }
          ]
        }
      };
    case "pythagoras":
      return {
        type,
        config: {
          sideA: "3",
          sideB: "4",
          sideC: "5",
          caption: "Use a² + b² = c²"
        }
      };
    case "trigonometry":
      return {
        type,
        config: {
          angleDeg: 35,
          focusFunction: "sin",
          opposite: "7",
          adjacent: "10",
          hypotenuse: "12.2"
        }
      };
    default:
      return null;
  }
}

function buildNumberLineMarkup(config) {
  const min = Number(config.min ?? -10);
  const max = Number(config.max ?? 10);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
    return "<p class='helper-text'>Invalid range: min must be less than max.</p>";
  }

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
    const label = escapeInteractiveHtml(String(arrow.label || ""));
    parts.push(`<path d="M ${fx} ${lineY - 10} Q ${mx} ${peak} ${tx} ${lineY - 10}" stroke="#f59e0b" stroke-width="2" fill="none" marker-end="url(#nl-arr)"/>`);
    if (label) parts.push(`<text x="${mx}" y="${peak - 6}" text-anchor="middle" font-size="12" fill="#b45309" font-weight="bold">${label}</text>`);
  });

  points.forEach((point) => {
    const x = xPos(Number(point.value));
    if (!Number.isFinite(x)) return;
    const color = safeInteractiveColor(point.color, "#2563eb");
    const label = escapeInteractiveHtml(String(point.label || ""));
    parts.push(`<circle cx="${x}" cy="${lineY}" r="8" fill="${color}" stroke="white" stroke-width="2"/>`);
    if (label) parts.push(`<text x="${x}" y="${lineY - 16}" text-anchor="middle" font-size="11" fill="${color}" font-weight="bold">${label}</text>`);
  });

  return `<div class="nl-container"><svg viewBox="0 0 ${svgW} ${svgH}" width="100%" preserveAspectRatio="xMidYMid meet">${parts.join("")}</svg></div>`;
}

function buildCartesianPlaneMarkup(config) {
  const xMin = Number(config.xMin ?? -10);
  const xMax = Number(config.xMax ?? 10);
  const yMin = Number(config.yMin ?? -10);
  const yMax = Number(config.yMax ?? 10);
  if (![xMin, xMax, yMin, yMax].every(Number.isFinite) || xMin >= xMax || yMin >= yMax) {
    return "<p class='helper-text'>Invalid plane range.</p>";
  }

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

  if (axisX !== null) {
    parts.push(`<line x1="${axisX}" y1="${pad - 6}" x2="${axisX}" y2="${size - pad + 6}" stroke="#334155" stroke-width="2"/>`);
  }
  if (axisY !== null) {
    parts.push(`<line x1="${pad - 6}" y1="${axisY}" x2="${size - pad + 6}" y2="${axisY}" stroke="#334155" stroke-width="2"/>`);
  }

  segments.forEach((segment) => {
    const x1 = xPos(Number(segment.x1));
    const y1 = yPos(Number(segment.y1));
    const x2 = xPos(Number(segment.x2));
    const y2 = yPos(Number(segment.y2));
    if (![x1, y1, x2, y2].every(Number.isFinite)) return;
    const color = safeInteractiveColor(segment.color, "#f59e0b");
    const label = escapeInteractiveHtml(String(segment.label || ""));
    parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`);
    if (label) {
      parts.push(`<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 8}" text-anchor="middle" font-size="11" fill="${color}" font-weight="bold">${label}</text>`);
    }
  });

  parabolas.forEach((curve) => {
    const a = Number(curve.a);
    const b = Number(curve.b);
    const c = Number(curve.c);
    if (![a, b, c].every(Number.isFinite)) return;
    const color = safeInteractiveColor(curve.color, "#7c3aed");
    const label = escapeInteractiveHtml(String(curve.label || ""));
    const samples = 80;
    const pointsPath = [];
    for (let i = 0; i <= samples; i += 1) {
      const xValue = xMin + (i / samples) * (xMax - xMin);
      const yValue = a * xValue * xValue + b * xValue + c;
      const sx = xPos(xValue);
      const sy = yPos(yValue);
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
      pointsPath.push(`${i === 0 ? "M" : "L"} ${sx} ${sy}`);
    }
    if (pointsPath.length > 1) {
      parts.push(`<path d="${pointsPath.join(" ")}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>`);
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
    const label = escapeInteractiveHtml(String(curve.label || `y = ${expression}`));
    const samples = 120;
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
      const xAtLabel = xMin + 0.75 * (xMax - xMin);
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
    const label = escapeInteractiveHtml(String(point.label || ""));
    parts.push(`<circle cx="${x}" cy="${y}" r="6" fill="${color}" stroke="white" stroke-width="2"/>`);
    if (label) {
      parts.push(`<text x="${x + 10}" y="${y - 10}" font-size="11" fill="${color}" font-weight="bold">${label}</text>`);
    }
  });

  return `<div class="cartesian-container"><svg viewBox="0 0 ${size} ${size}" width="100%" preserveAspectRatio="xMidYMid meet">${parts.join("")}</svg></div>`;
}

function buildCartesianPlotMarkup(config) {
  // Preview in the maker: show the grid with the answer points marked.
  const xMin = Number(config.xMin ?? -10);
  const xMax = Number(config.xMax ?? 10);
  const yMin = Number(config.yMin ?? -10);
  const yMax = Number(config.yMax ?? 10);
  if (![xMin, xMax, yMin, yMax].every(Number.isFinite) || xMin >= xMax || yMin >= yMax) return "";
  const points = Array.isArray(config.points) ? config.points : [];
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
  points.forEach((point) => {
    const x = xPos(Number(point.x));
    const y = yPos(Number(point.y));
    if (![x, y].every(Number.isFinite)) return;
    const label = escapeInteractiveHtml(String(point.label || `(${point.x},${point.y})`));
    parts.push(`<circle cx="${x}" cy="${y}" r="7" fill="#16a34a" stroke="white" stroke-width="2"/>`);
    parts.push(`<text x="${x + 10}" y="${y - 10}" font-size="11" fill="#16a34a" font-weight="bold">${label}</text>`);
  });
  const pointSummary = points.length > 0
    ? points.map((p) => `(${p.x}, ${p.y})${p.label ? " " + p.label : ""}`).join(" · ")
    : "No answer points configured";
  return `<div class="cartesian-container"><svg viewBox="0 0 ${size} ${size}" width="100%" preserveAspectRatio="xMidYMid meet">${parts.join("")}</svg></div><p class="helper-text">Answer points: ${escapeInteractiveHtml(pointSummary)}</p>`;
}

function buildStemLeafMarkup(config) {
  const values = Array.isArray(config.values) ? config.values.slice() : [];
  const stemUnit = Math.max(1, Number.parseInt(config.stemUnit, 10) || 10);
  if (values.length === 0) {
    return "<p class='helper-text'>Add values to build the stem-and-leaf plot.</p>";
  }

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
  const title = escapeInteractiveHtml(String(config.title || "Category Frequencies"));
  const categoryAxisLabel = escapeInteractiveHtml(String(config.categoryAxisLabel || "Category"));
  const valueAxisLabel = escapeInteractiveHtml(String(config.valueAxisLabel || "Value"));
  const items = (Array.isArray(config.items) ? config.items : [])
    .map((item, index) => ({
      category: String(item.category || `Item ${index + 1}`).trim() || `Item ${index + 1}`,
      value: Math.max(0, Number(item.frequency) || 0),
      color: safeInteractiveColor(item.color, "#2563eb")
    }));
  const orientation = String(config.orientation || "vertical").trim().toLowerCase() === "horizontal" ? "horizontal" : "vertical";
  if (items.length === 0) {
    return "<p class='helper-text'>Add category-frequency items to preview the bar chart.</p>";
  }

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
        <text x="${margin.left - 8}" y="${y + barH / 2 + 4}" text-anchor="end" font-size="11" fill="#334155">${escapeInteractiveHtml(item.category)}</text>
        <rect x="${margin.left}" y="${y}" width="${w}" height="${barH}" fill="${item.color}" stroke="#1e293b" stroke-width="0.6"/>
        <text x="${Math.min(width - 4, margin.left + w + 6)}" y="${y + barH / 2 + 4}" font-size="11" fill="#0f172a">${item.value}</text>
      `;
    }).join("");

    const ticks = Array.from({ length: tickCount + 1 }, (_, index) => {
      const value = (yMax * index) / tickCount;
      const x = margin.left + (plotW * index) / tickCount;
      return `<line x1="${x}" y1="${height - margin.bottom}" x2="${x}" y2="${height - margin.bottom + 6}" stroke="#64748b"/><text x="${x}" y="${height - margin.bottom + 20}" text-anchor="middle" font-size="10" fill="#475569">${escapeInteractiveHtml(value.toFixed(0))}</text>`;
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
      <text x="${x + barW / 2}" y="${height - margin.bottom + 16}" text-anchor="middle" font-size="10" fill="#334155">${escapeInteractiveHtml(item.category)}</text>
    `;
  }).join("");

  const ticks = Array.from({ length: tickCount + 1 }, (_, index) => {
    const value = (yMax * index) / tickCount;
    const y = margin.top + plotH - (plotH * index) / tickCount;
    return `<line x1="${margin.left - 6}" y1="${y}" x2="${margin.left}" y2="${y}" stroke="#64748b"/><text x="${margin.left - 10}" y="${y + 4}" text-anchor="end" font-size="10" fill="#475569">${escapeInteractiveHtml(value.toFixed(0))}</text>`;
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

function buildHistogramMarkup(config) {
  const title = escapeInteractiveHtml(String(config.title || "Continuous Data Distribution"));
  const values = (Array.isArray(config.values) ? config.values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  const binCount = Math.max(2, Math.min(30, Number.parseInt(config.binCount, 10) || 8));
  if (values.length === 0) return "<p class='helper-text'>Add numeric values to preview the histogram.</p>";

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const width = range / binCount;
  const bins = new Array(binCount).fill(0);
  values.forEach((value) => {
    const index = Math.min(binCount - 1, Math.max(0, Math.floor((value - min) / width)));
    bins[index] += 1;
  });
  const maxFreq = Math.max(...bins, 1);
  const bars = bins.map((freq, index) => {
    const barHeight = Math.max(4, (freq / maxFreq) * 120);
    const start = min + index * width;
    const end = start + width;
    return `<div class="histogram-bin"><div class="histogram-bar" style="height:${barHeight}px"></div><span class="histogram-label">${escapeInteractiveHtml(start.toFixed(1))}-${escapeInteractiveHtml(end.toFixed(1))}</span><span class="histogram-value">${freq}</span></div>`;
  }).join("");
  return `<div class="histogram-container"><p class="bar-chart-title">${title}</p><div class="histogram-bars">${bars}</div></div>`;
}

function buildBoxPlotMarkup(config) {
  const title = escapeInteractiveHtml(String(config.title || "Compare Datasets"));
  const palette = ["#2563eb", "#16a34a", "#f59e0b", "#7c3aed", "#0f766e", "#dc2626", "#0891b2", "#9333ea"];
  const rows = normalizeBoxPlotDatasets(config).map((dataset, index) => ({
    label: dataset.label || defaultBoxPlotDatasetLabel(index),
    stats: computeFiveNumber(dataset.values || []),
    color: palette[index % palette.length]
  }));
  const statsList = rows.map((item) => item.stats).filter((item) => item);
  if (statsList.length === 0) return "<p class='helper-text'>Add dataset values to preview box plot summaries.</p>";

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
      return `<text x="14" y="${y + 4}" font-size="12" fill="#64748b">${escapeInteractiveHtml(label)}</text><text x="${left}" y="${y + 4}" font-size="12" fill="#94a3b8">no data</text>`;
    }
    const xMin = mapX(stats.min);
    const xQ1 = mapX(stats.q1);
    const xMedian = mapX(stats.median);
    const xQ3 = mapX(stats.q3);
    const xMax = mapX(stats.max);
    return `
      <text x="14" y="${y + 4}" font-size="12" fill="#0f172a" font-weight="700">${escapeInteractiveHtml(label)}</text>
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

  const summaryLine = (label, stats) => {
    if (!stats) return `<p>${escapeInteractiveHtml(label)}: no data</p>`;
    return `<p>${escapeInteractiveHtml(label)}: min=${stats.min.toFixed(2)}, Q1=${stats.q1.toFixed(2)}, median=${stats.median.toFixed(2)}, Q3=${stats.q3.toFixed(2)}, max=${stats.max.toFixed(2)}</p>`;
  };

  const renderedRows = rows.map((row, index) => renderRow(row.label, row.stats, index, row.color)).join("");
  const renderedSummary = rows.map((row) => summaryLine(row.label, row.stats)).join("");

  return `
    <div class="simple-card">
      <p class="bar-chart-title">${title}</p>
      <svg viewBox="0 0 380 ${svgHeight}" width="100%" preserveAspectRatio="xMidYMid meet">
        <rect x="0" y="0" width="380" height="${svgHeight}" fill="#f8fafc" stroke="#dbe6f3"/>
        ${renderedRows}
        <line x1="${left}" y1="${axisY}" x2="${right}" y2="${axisY}" stroke="#64748b" stroke-width="1.5"/>
        ${axisTicks}
      </svg>
      ${renderedSummary}
    </div>
  `;
}

function buildScatterPlotMarkup(config) {
  const title = escapeInteractiveHtml(String(config.title || "Correlation and Best Fit"));
  const points = (Array.isArray(config.points) ? config.points : [])
    .map((point) => ({
      x: Number(point.x),
      y: Number(point.y),
      label: point.label,
      color: point.color
    }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  const regression = computeLinearRegression(points);
  if (points.length === 0) return "<p class='helper-text'>Add points to preview scatter plot analytics.</p>";

  const xMin = Math.min(...points.map((point) => point.x));
  const xMax = Math.max(...points.map((point) => point.x));
  const yMin = Math.min(...points.map((point) => point.y));
  const yMax = Math.max(...points.map((point) => point.y));
  const xPad = (xMax - xMin || 1) * 0.12;
  const yPad = (yMax - yMin || 1) * 0.12;
  const domainXMin = xMin - xPad;
  const domainXMax = xMax + xPad;
  const domainYMin = yMin - yPad;
  const domainYMax = yMax + yPad;
  const left = 50;
  const right = 362;
  const top = 18;
  const bottom = 198;
  const mapX = (value) => left + ((value - domainXMin) / (domainXMax - domainXMin || 1)) * (right - left);
  const mapY = (value) => bottom - ((value - domainYMin) / (domainYMax - domainYMin || 1)) * (bottom - top);

  const pointsSvg = points.map((point, index) => {
    const px = mapX(point.x);
    const py = mapY(point.y);
    const color = safeInteractiveColor(point.color, "#2563eb");
    const label = escapeInteractiveHtml(String(point.label || `P${index + 1}`));
    return `<circle cx="${px}" cy="${py}" r="4" fill="${color}" stroke="#0f172a" stroke-width="0.8"/><text x="${px + 6}" y="${py - 6}" font-size="10" fill="#334155">${label}</text>`;
  }).join("");

  const fitLine = regression
    ? (() => {
      const x1 = domainXMin;
      const y1 = regression.slope * x1 + regression.intercept;
      const x2 = domainXMax;
      const y2 = regression.slope * x2 + regression.intercept;
      return `<line x1="${mapX(x1)}" y1="${mapY(y1)}" x2="${mapX(x2)}" y2="${mapY(y2)}" stroke="#dc2626" stroke-width="2" stroke-dasharray="5 4"/>`;
    })()
    : "";

  const detail = regression
    ? `r = ${regression.correlation.toFixed(3)}, best fit: y = ${regression.slope.toFixed(3)}x + ${regression.intercept.toFixed(3)}`
    : "Not enough variation for line of best fit.";
  return `
    <div class="simple-card">
      <p class="bar-chart-title">${title}</p>
      <svg viewBox="0 0 380 210" width="100%" preserveAspectRatio="xMidYMid meet">
        <rect x="0" y="0" width="380" height="210" fill="#f8fafc" stroke="#dbe6f3"/>
        <line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="#64748b" stroke-width="1.5"/>
        <line x1="${left}" y1="${top}" x2="${left}" y2="${bottom}" stroke="#64748b" stroke-width="1.5"/>
        ${fitLine}
        ${pointsSvg}
        <text x="${left}" y="206" font-size="10" fill="#64748b">x: ${escapeInteractiveHtml(domainXMin.toFixed(2))}</text>
        <text x="${right}" y="206" text-anchor="end" font-size="10" fill="#64748b">${escapeInteractiveHtml(domainXMax.toFixed(2))}</text>
        <text x="6" y="${bottom}" font-size="10" fill="#64748b">y: ${escapeInteractiveHtml(domainYMin.toFixed(2))}</text>
        <text x="6" y="${top + 10}" font-size="10" fill="#64748b">${escapeInteractiveHtml(domainYMax.toFixed(2))}</text>
      </svg>
      <p>Point count: ${points.length}</p>
      <p>${escapeInteractiveHtml(detail)}</p>
    </div>
  `;
}

function buildProbabilityTreeMarkup(config) {
  const title = escapeInteractiveHtml(String(config.title || "Sequential Probabilities"));
  const paths = Array.isArray(config.paths) ? config.paths : [];
  if (paths.length === 0) return "<p class='helper-text'>Add probability paths to preview the tree summary.</p>";
  const total = paths.reduce((sum, item) => sum + (Number(item.probability) || 0), 0);
  return `<div class="simple-card"><p class="bar-chart-title">${title}</p><p>Path count: ${paths.length}</p><p>Total probability: ${total.toFixed(3)}</p><p class="helper-text">Conditional query: ${escapeInteractiveHtml(String(config.conditionalQuery || "none"))}</p></div>`;
}

function buildDistributionCurveMarkup(config) {
  const title = escapeInteractiveHtml(String(config.title || "Normal Distribution"));
  const mean = Number(config.mean);
  const stdDev = Math.max(0.0001, Number(config.stdDev) || 1);
  const from = Number(config.from);
  const to = Number(config.to);
  if (![mean, stdDev, from, to].every(Number.isFinite)) return "<p class='helper-text'>Set mean, standard deviation, and interval to preview distribution.</p>";
  const zFrom = (from - mean) / stdDev;
  const zTo = (to - mean) / stdDev;
  const area = Math.max(0, normalCdf(zTo) - normalCdf(zFrom));
  return `<div class="simple-card"><p class="bar-chart-title">${title}</p><p>Mean = ${mean.toFixed(3)}, SD = ${stdDev.toFixed(3)}</p><p>Area from ${from.toFixed(3)} to ${to.toFixed(3)} ≈ ${area.toFixed(4)}</p></div>`;
}

function buildNetworkGraphMarkup(config) {
  const title = escapeInteractiveHtml(String(config.title || "Network Graph"));
  const nodes = Array.isArray(config.nodes) ? config.nodes : [];
  const edges = Array.isArray(config.edges) ? config.edges : [];
  if (nodes.length === 0 || edges.length === 0) return "<p class='helper-text'>Add nodes and edges to preview network analysis.</p>";
  return `<div class="simple-card"><p class="bar-chart-title">${title}</p><p>Nodes: ${nodes.length}</p><p>Edges: ${edges.length}</p><p class="helper-text">Shortest path: ${escapeInteractiveHtml(String(config.source || ""))} to ${escapeInteractiveHtml(String(config.target || ""))}</p><p class="helper-text">Flow: ${escapeInteractiveHtml(String(config.flowSource || ""))} to ${escapeInteractiveHtml(String(config.flowSink || ""))}</p></div>`;
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
      <p>${escapeInteractiveHtml(formatFractionDisplay(fractionA))} ${labels[operation]} ${escapeInteractiveHtml(formatFractionDisplay(fractionB))} = ${escapeInteractiveHtml(formatFractionDisplay(result))}</p>
      <p class="helper-text">Result (simplified): ${escapeInteractiveHtml(formatFractionDisplay(result))}</p>
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
    return `<div class="simple-card"><p>${escapeInteractiveHtml(caption)}: invalid matrix</p></div>`;
  }
  const rows = matrix
    .map((row) => `<tr>${row.map((value) => `<td>${escapeInteractiveHtml(formatMatrixNumber(value))}</td>`).join("")}</tr>`)
    .join("");
  return `
    <div class="simple-card matrix-card">
      <p><strong>${escapeInteractiveHtml(caption)}</strong> (${matrix.length}x${matrix[0].length})</p>
      <div class="matrix-wrap" role="img" aria-label="${escapeInteractiveHtml(caption)} ${matrix.length} by ${matrix[0].length}">
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
  const title = escapeInteractiveHtml(String(config.title || "Matrix Operations"));
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
      ? `<div class="simple-card"><p><strong>det(A)</strong> = ${escapeInteractiveHtml(formatMatrixNumber(determinant))}</p></div>`
      : "<p class='helper-text'>Determinant requires A to be a square matrix.</p>";
  } else {
    const result = matrixTranspose(matrixA);
    resultMarkup = result ? buildMatrixTableMarkup(result, "A^T") : "<p class='helper-text'>Transpose requires a valid matrix A.</p>";
  }

  return `
    <div class="simple-card">
      <p class="bar-chart-title">${title}</p>
      <p>Operation: ${escapeInteractiveHtml(labels[operation])}</p>
      <p class="helper-text">A dimensions: ${escapeInteractiveHtml(matrixDimensions(matrixA))}${operation === "add" || operation === "subtract" || operation === "multiply" ? ` | B dimensions: ${escapeInteractiveHtml(matrixDimensions(matrixB))}` : ""}</p>
    </div>
    ${buildMatrixTableMarkup(matrixA, "Matrix A")}
    ${(operation === "add" || operation === "subtract" || operation === "multiply") && matrixB.length > 0 ? buildMatrixTableMarkup(matrixB, "Matrix B") : ""}
    ${resultMarkup}
  `;
}

function buildGeometryShapesMarkup(config) {
  const canvasWidth = Math.max(220, Math.min(760, Number.parseInt(config.canvasWidth, 10) || 360));
  const canvasHeight = Math.max(180, Math.min(520, Number.parseInt(config.canvasHeight, 10) || 260));
  const shapes = Array.isArray(config.shapes) ? config.shapes : [];
  if (shapes.length === 0) {
    return "<p class='helper-text'>Add shapes to preview geometry.</p>";
  }

  const parts = [];
  parts.push(`<rect x="0" y="0" width="${canvasWidth}" height="${canvasHeight}" fill="#f8fbff" stroke="#dbe6f3"/>`);

  shapes.forEach((shape) => {
    const type = normalizeGeometryShapeType(shape.type);
    const x = Number(shape.x);
    const y = Number(shape.y);
    const w = Math.max(6, Number(shape.w) || 40);
    const h = Math.max(6, Number(shape.h) || w);
    if (![x, y].every(Number.isFinite)) return;
    const stroke = safeInteractiveColor(shape.color, "#2563eb");
    const fill = safeInteractiveColor(shape.fill, "#dbeafe");
    const label = escapeInteractiveHtml(String(shape.label || ""));

    if (type === "rectangle") {
      parts.push(`<rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
    } else if (type === "square") {
      parts.push(`<rect x="${x - w / 2}" y="${y - w / 2}" width="${w}" height="${w}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
    } else if (type === "circle") {
      parts.push(`<circle cx="${x}" cy="${y}" r="${w}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
    } else if (type === "triangle") {
      parts.push(`<polygon points="${x},${y - h / 2} ${x - w / 2},${y + h / 2} ${x + w / 2},${y + h / 2}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
    } else if (type === "cube" || type === "cuboid") {
      const depth = Math.max(8, Number(shape.d) || Math.min(w, h) / 2);
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

    if (label) {
      parts.push(`<text x="${x}" y="${y - Math.max(h, w) / 2 - 8}" text-anchor="middle" font-size="11" fill="${stroke}" font-weight="bold">${label}</text>`);
    }
  });

  return `<div class="geometry-shapes-container"><svg viewBox="0 0 ${canvasWidth} ${canvasHeight}" width="100%" preserveAspectRatio="xMidYMid meet">${parts.join("")}</svg></div>`;
}

function buildPythagorasMarkup(config) {
  const sideA = escapeInteractiveHtml(config.sideA || "?");
  const sideB = escapeInteractiveHtml(config.sideB || "?");
  const sideC = escapeInteractiveHtml(config.sideC || "?");
  const caption = escapeInteractiveHtml(config.caption || "Use a² + b² = c²");
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
  const opposite = escapeInteractiveHtml(config.opposite || "?");
  const adjacent = escapeInteractiveHtml(config.adjacent || "?");
  const hypotenuse = escapeInteractiveHtml(config.hypotenuse || "?");
  const summary = escapeInteractiveHtml(buildTrigSummary(config));
  return `
    <div class="triangle-demo-card">
      <svg viewBox="0 0 320 240" width="100%" preserveAspectRatio="xMidYMid meet">
        <polygon points="60,200 220,200 220,80" fill="#f0fdf4" stroke="#15803d" stroke-width="3"/>
        <polyline points="220,200 196,200 196,176 220,176" fill="none" stroke="#334155" stroke-width="2"/>
        <path d="M 90 200 A 30 30 0 0 0 84 183" fill="none" stroke="#dc2626" stroke-width="2"/>
        <text x="86" y="186" font-size="13" fill="#dc2626" font-weight="bold">${escapeInteractiveHtml(angleLabel)}</text>
        <text x="124" y="220" font-size="14" fill="#166534" font-weight="bold">adj = ${adjacent}</text>
        <text x="234" y="146" font-size="14" fill="#166534" font-weight="bold">opp = ${opposite}</text>
        <text x="146" y="128" font-size="14" fill="#b45309" font-weight="bold">hyp = ${hypotenuse}</text>
      </svg>
      <p class="triangle-demo-caption">${summary}</p>
    </div>
  `;
}

function computeArithmeticPreviewAnswer(config) {
  const a = Number.parseFloat(config && config.operandA);
  const b = Number.parseFloat(config && config.operandB);
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

function buildArithmeticObjectIconSvg(kind) {
  if (kind === "car") {
    return `
      <svg viewBox="0 0 28 20" width="24" height="18" aria-hidden="true" focusable="false">
        <rect x="4" y="8" width="18" height="7" rx="2" fill="#2563eb"></rect>
        <rect x="8" y="5" width="8" height="4" rx="1" fill="#93c5fd"></rect>
        <circle cx="9" cy="16" r="2" fill="#1f2937"></circle>
        <circle cx="19" cy="16" r="2" fill="#1f2937"></circle>
      </svg>
    `;
  }
  if (kind === "star") {
    return `
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
        <polygon points="12,2 15,9 22,9 16.5,13.5 18.5,21 12,16.5 5.5,21 7.5,13.5 2,9 9,9" fill="#f59e0b"></polygon>
      </svg>
    `;
  }
  return `
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
      <circle cx="10" cy="10" r="7" fill="#ef4444"></circle>
    </svg>
  `;
}

function buildArithmeticObjectGroup(count, kind) {
  const safeCount = Math.max(0, Math.min(24, Number.parseInt(count, 10) || 0));
  const chips = [];
  for (let index = 0; index < safeCount; index += 1) {
    chips.push(`<span class="arithmetic-object-icon">${buildArithmeticObjectIconSvg(kind)}</span>`);
  }
  return chips.join("");
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
      ? buildArithmeticObjectGroup(remaining, kind)
      : `<span class="arithmetic-object-unknown">?</span>`;
    return `
      <div class="arithmetic-object-visual" role="img" aria-label="${escapeInteractiveHtml(a)} minus ${escapeInteractiveHtml(b)} ${escapeInteractiveHtml(label)}">
        <div class="arithmetic-object-group">${buildArithmeticObjectGroup(a, kind)}</div>
        <span class="arithmetic-object-op">-</span>
        <div class="arithmetic-object-group">${buildArithmeticObjectGroup(b, kind)}</div>
        <span class="arithmetic-object-op">=</span>
        <div class="arithmetic-object-group">${totalMarkup}</div>
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
      buckets.push(`<div class="arithmetic-object-bucket">${buildArithmeticObjectGroup(shownEach, kind)}</div>`);
    }
    return `
      <div class="arithmetic-object-multiplication" role="img" aria-label="${escapeInteractiveHtml(a)} shared into ${escapeInteractiveHtml(b)} groups of ${escapeInteractiveHtml(label)}">
        ${buckets.join("")}
      </div>
    `;
  }

  if (operator === "+") {
    const total = a + b;
    const totalMarkup = revealAnswer
      ? buildArithmeticObjectGroup(total, kind)
      : `<span class="arithmetic-object-unknown">?</span>`;

    return `
      <div class="arithmetic-object-visual" role="img" aria-label="${escapeInteractiveHtml(a)} plus ${escapeInteractiveHtml(b)} ${escapeInteractiveHtml(label)}">
        <div class="arithmetic-object-group">${buildArithmeticObjectGroup(a, kind)}</div>
        <span class="arithmetic-object-op">+</span>
        <div class="arithmetic-object-group">${buildArithmeticObjectGroup(b, kind)}</div>
        <span class="arithmetic-object-op">=</span>
        <div class="arithmetic-object-group">${totalMarkup}</div>
      </div>
    `;
  }

  const groups = Math.max(0, Math.min(12, a));
  const each = Math.max(0, Math.min(12, b));
  const buckets = [];
  for (let groupIndex = 0; groupIndex < groups; groupIndex += 1) {
    buckets.push(`<div class="arithmetic-object-bucket">${buildArithmeticObjectGroup(each, kind)}</div>`);
  }
  return `
    <div class="arithmetic-object-multiplication" role="img" aria-label="${escapeInteractiveHtml(a)} groups of ${escapeInteractiveHtml(b)} ${escapeInteractiveHtml(label)}">
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
      <p class="helper-text arithmetic-why">${escapeInteractiveHtml(explanation)}</p>
      <div class="arithmetic-number-chart" role="img" aria-label="Number chart showing ${escapeInteractiveHtml(String(a))} ${escapeInteractiveHtml(operator)} ${escapeInteractiveHtml(String(b))} equals ${escapeInteractiveHtml(String(result))}">
        ${cells.join("")}
      </div>
    `;
  }

  if (operator === "x" || operator === "*") {
    const table = [];
    for (let i = 1; i <= 10; i += 1) {
      table.push(`${b} x ${i} = ${b * i}`);
    }
    return `<p class="helper-text arithmetic-why">Times table check: ${escapeInteractiveHtml(table.join(" | "))}</p>`;
  }

  if (operator === "/" && b !== 0) {
    const q = Math.floor(a / b);
    return `<p class="helper-text arithmetic-why">Equal groups check: ${escapeInteractiveHtml(String(a))} / ${escapeInteractiveHtml(String(b))} = ${escapeInteractiveHtml(String(q))}, and ${escapeInteractiveHtml(String(b))} x ${escapeInteractiveHtml(String(q))} = ${escapeInteractiveHtml(String(b * q))}.</p>`;
  }

  return "";
}

function buildArithmeticPreviewMarkup(config) {
  const visualMode = String(config && config.visualMode ? config.visualMode : "").trim().toLowerCase();
  if (visualMode === "link-to-10") {
    const operator = String(config && config.linkOperator ? config.linkOperator : "+").trim() === "-" ? "-" : "+";
    const targetRaw = Number.parseInt(config && config.targetValue, 10);
    const legacyTargetRaw = Number.parseInt(config && config.targetSum, 10);
    const safeTarget = Number.isInteger(targetRaw)
      ? targetRaw
      : (Number.isInteger(legacyTargetRaw) ? legacyTargetRaw : 10);
    const left = Array.isArray(config && config.leftNumbers)
      ? config.leftNumbers.map((item) => Number.parseInt(item, 10)).filter((item) => Number.isInteger(item))
      : [];
    const right = Array.isArray(config && config.rightNumbers)
      ? config.rightNumbers.map((item) => Number.parseInt(item, 10)).filter((item) => Number.isInteger(item))
      : [];
    const modeTitle = operator === "-" ? "Arithmetic (Subtraction Link)" : "Arithmetic (Addition Link)";
    const helperText = operator === "-"
      ? `Link cards so each pair satisfies A - B = ${escapeInteractiveHtml(String(safeTarget))}.`
      : `Link cards so each pair equals ${escapeInteractiveHtml(String(safeTarget))}.`;
    return `
      <div class="simple-card">
        <p class="bar-chart-title">${modeTitle}</p>
        <p class="helper-text">${helperText}</p>
        <div class="calendar-sequence-strip" style="justify-content:space-between;gap:18px;align-items:flex-start">
          <div>
            <p class="helper-text" style="margin:0 0 6px 0"><strong>Column A</strong></p>
            <div class="number-ordering-stage" style="display:grid;gap:8px">
              ${left.map((value) => `<span class="number-ordering-card">${escapeInteractiveHtml(String(value))}</span>`).join("")}
            </div>
          </div>
          <div>
            <p class="helper-text" style="margin:0 0 6px 0"><strong>Column B</strong></p>
            <div class="number-ordering-stage" style="display:grid;gap:8px">
              ${right.map((value) => `<span class="number-ordering-card">${escapeInteractiveHtml(String(value))}</span>`).join("")}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  const rawLayout = String(config && config.layout ? config.layout : "horizontal").trim().toLowerCase();
  const layout = rawLayout === "vertical" ? "vertical" : rawLayout === "long" ? "long" : "horizontal";
  const operator = escapeInteractiveHtml(String(config && config.operator ? config.operator : "+"));
  const a = escapeInteractiveHtml(String(config && config.operandA != null ? config.operandA : ""));
  const b = escapeInteractiveHtml(String(config && config.operandB != null ? config.operandB : ""));
  const answer = escapeInteractiveHtml(String(config && config.answer ? config.answer : computeArithmeticPreviewAnswer(config)));
  const objectVisualMarkup = buildArithmeticObjectVisualMarkup(config || {}, { revealAnswer: true });
  const reasoningMarkup = buildArithmeticReasoningMarkup(config || {}, { revealAnswer: true });
  if (layout === "long" || (layout === "vertical" && String(config && config.operator ? config.operator : "+").trim() === "/")) {
    return `<div class="simple-card"><p class="bar-chart-title">Arithmetic (long division)</p>${objectVisualMarkup}${reasoningMarkup}<p style="font-family:Consolas,monospace;line-height:1.6;text-align:right">&nbsp;&nbsp;${answer}<br>${b} ) ${a}<br>--------</p></div>`;
  }
  if (layout === "vertical") {
    return `<div class="simple-card"><p class="bar-chart-title">Arithmetic (${layout})</p>${objectVisualMarkup}${reasoningMarkup}<p style="font-family:Consolas,monospace;line-height:1.6">&nbsp;&nbsp;${a}<br>${operator} ${b}<br>-----<br>&nbsp;&nbsp;${answer}</p></div>`;
  }
  return `<div class="simple-card"><p class="bar-chart-title">Arithmetic (${layout})</p>${objectVisualMarkup}${reasoningMarkup}<p style="font-family:Consolas,monospace">${a} ${operator} ${b} = ${answer}</p></div>`;
}

function buildNumberTracingPreviewMarkup(config) {
  const target = Number.parseInt(config && config.targetNumber, 10);
  const safeTarget = Number.isInteger(target) ? Math.max(0, Math.min(100, target)) : 5;
  const prompt = escapeInteractiveHtml(String(config && config.prompt ? config.prompt : "Trace the dotted number and say it aloud."));
  const prepMode = Boolean(config && config.prepMode);
  const showQuantityDots = Boolean(config && config.showQuantityDots);
  const quantityDots = showQuantityDots && safeTarget >= 0 && safeTarget <= 20
    ? `<div class="number-tracing-dots" aria-label="${safeTarget} quantity dots">${Array.from({ length: safeTarget }).map(() => "<span class='number-tracing-dot'></span>").join("")}</div>`
    : "";
  return `
    <div class="simple-card number-tracing-card">
      <p class="bar-chart-title">Number Tracing</p>
      ${prepMode ? "<p class='helper-text'>Prep mode: recognition-first</p>" : ""}
      <p class="helper-text">${prompt}</p>
      <svg class="number-tracing-svg" viewBox="0 0 280 190" role="img" aria-label="Dotted number ${safeTarget}">
        <text x="50%" y="62%" text-anchor="middle" dominant-baseline="middle" class="number-tracing-glyph">${safeTarget}</text>
      </svg>
      ${quantityDots}
    </div>
  `;
}

function parseNumberOrderingValues(value) {
  return String(value || "")
    .split(/[\s,]+/)
    .map((item) => Number.parseInt(item, 10))
    .filter((item) => Number.isInteger(item));
}

function normalizeNumberOrderingDirection(value) {
  return String(value || "ascending").trim().toLowerCase() === "descending"
    ? "descending"
    : "ascending";
}

function buildNumberOrderingPreviewMarkup(config) {
  const direction = normalizeNumberOrderingDirection(config && config.direction);
  const cardsRaw = Array.isArray(config && config.cards) ? config.cards : [];
  const cards = cardsRaw
    .map((item) => Number.parseInt(item, 10))
    .filter((item) => Number.isInteger(item));
  const fallbackCards = [7, 3, 9, 5];
  const safeCards = cards.length > 0 ? cards : fallbackCards;
  const prompt = escapeInteractiveHtml(String(config && config.prompt ? config.prompt : "Order the number cards from smallest to largest."));
  const correctRaw = Array.isArray(config && config.correctOrder) ? config.correctOrder : [];
  const correctValues = correctRaw
    .map((item) => Number.parseInt(item, 10))
    .filter((item) => Number.isInteger(item));
  const computed = safeCards.slice().sort((a, b) => a - b);
  const fallbackOrder = direction === "descending" ? computed.reverse() : computed;
  const safeCorrect = correctValues.length > 0 ? correctValues : fallbackOrder;

  return `
    <div class="simple-card number-ordering-card">
      <p class="bar-chart-title">Number Ordering (${direction === "descending" ? "descending" : "ascending"})</p>
      <p class="helper-text">${prompt}</p>
      <div class="number-ordering-cards">
        ${safeCards.map((value) => `<span class="number-ordering-item">${escapeInteractiveHtml(String(value))}</span>`).join("")}
      </div>
      <p class="helper-text">Correct order: <strong>${escapeInteractiveHtml(safeCorrect.join(", "))}</strong></p>
    </div>
  `;
}

function parseIconCountGroups(value) {
  return String(value || "")
    .split(/[\s,]+/)
    .map((item) => Number.parseInt(item, 10))
    .filter((item) => Number.isInteger(item) && item >= 0);
}

function normalizeIconCountShape(value) {
  const shape = String(value || "circle").trim().toLowerCase();
  return ["circle", "star", "apple"].includes(shape) ? shape : "circle";
}

function normalizeIconCountConfig(config) {
  const totalRaw = Number.parseInt(config && config.totalCount, 10);
  const totalCount = Number.isInteger(totalRaw) ? Math.max(0, Math.min(20, totalRaw)) : 8;
  let groups = Array.isArray(config && config.groups)
    ? config.groups.map((item) => Number.parseInt(item, 10)).filter((item) => Number.isInteger(item) && item >= 0)
    : [];
  if (groups.length === 0) {
    groups = [totalCount];
  }
  const sum = groups.reduce((acc, value) => acc + value, 0);
  if (sum !== totalCount) {
    groups = [totalCount];
  }
  return {
    prompt: String((config && config.prompt) || "How many icons are shown in total?").trim() || "How many icons are shown in total?",
    totalCount,
    iconShape: normalizeIconCountShape(config && config.iconShape),
    groups
  };
}

function normalizeIconCountPromptForComparison(value) {
  return String(value || "")
    .replace(/[\u2600-\u27BF\u{1F300}-\u{1FAFF}]/gu, "")
    .replace(/[?!.:,;]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function buildIconCountPreviewMarkup(config, context = {}) {
  const normalized = normalizeIconCountConfig(config);
  const iconGlyph = normalized.iconShape === "star"
    ? "&#9733;"
    : normalized.iconShape === "apple"
      ? "&#127822;"
      : "";
  const questionPrompt = String(context.questionText || "").trim();
  const isDuplicatePrompt = normalizeIconCountPromptForComparison(normalized.prompt) !== ""
    && normalizeIconCountPromptForComparison(normalized.prompt) === normalizeIconCountPromptForComparison(questionPrompt);
  return `
    <div class="simple-card icon-count-card">
      <p class="bar-chart-title">Icon Count</p>
      ${isDuplicatePrompt ? "" : `<p class="helper-text">${escapeInteractiveHtml(normalized.prompt)}</p>`}
      <div class="icon-count-groups">
        ${normalized.groups.map((group, groupIndex) => `
          <div class="icon-count-group" aria-label="Group ${groupIndex + 1}: ${group} icons">
            ${Array.from({ length: group }).map(() => `<span class='icon-count-dot icon-count-dot-${normalized.iconShape}'>${iconGlyph}</span>`).join("")}
          </div>
        `).join("")}
      </div>
      <p class="helper-text">Total shown: <strong>${escapeInteractiveHtml(String(normalized.totalCount))}</strong></p>
    </div>
  `;
}

function parseCalendarSequenceValues(value) {
  return String(value || "")
    .split(",")
    .map((item) => String(item || "").trim())
    .filter((item) => item !== "");
}

function normalizeCalendarSequenceMode(value) {
  const mode = String(value || "days").trim().toLowerCase();
  return ["days", "months", "dates", "years"].includes(mode) ? mode : "days";
}

function getDefaultCalendarSequenceValues(mode) {
  const normalizedMode = normalizeCalendarSequenceMode(mode);
  if (normalizedMode === "months") {
    return [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"
    ];
  }
  if (normalizedMode === "dates") {
    return Array.from({ length: 31 }, (_, index) => String(index + 1));
  }
  if (normalizedMode === "years") {
    return Array.from({ length: 12 }, (_, index) => String(2020 + index));
  }
  return ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
}

function normalizeCalendarSequenceConfig(config) {
  const mode = normalizeCalendarSequenceMode(config && config.mode);
  const defaults = getDefaultCalendarSequenceValues(mode);
  let values = Array.isArray(config && config.values)
    ? config.values.map((item) => String(item || "").trim()).filter((item) => item !== "")
    : [];
  if (values.length === 0) values = defaults;
  const currentRaw = String((config && config.current) || "").trim();
  const current = values.includes(currentRaw) ? currentRaw : values[0];
  const stepRaw = Number.parseInt(config && config.step, 10);
  const step = Number.isInteger(stepRaw) ? Math.max(1, Math.min(10, stepRaw)) : 1;
  const promptDefault = mode === "months"
    ? `If this month is ${current}, what is the next month?`
    : mode === "years"
      ? `What year comes after ${current}?`
      : mode === "dates"
        ? `If today is the ${current}${ordinalSuffix(current)}, what date is tomorrow?`
        : `If today is ${current}, what is the next day?`;

  return {
    mode,
    current,
    step,
    values,
    prompt: String((config && config.prompt) || promptDefault).trim() || promptDefault
  };
}

function buildCalendarSequencePreviewMarkup(config) {
  const normalized = normalizeCalendarSequenceConfig(config);
  return `
    <div class="simple-card calendar-sequence-card">
      <p class="bar-chart-title">Calendar Sequence (${escapeInteractiveHtml(normalized.mode)})</p>
      <p class="helper-text">${escapeInteractiveHtml(normalized.prompt)}</p>
      <div class="calendar-sequence-strip">
        ${normalized.values.map((value) => `<span class="calendar-sequence-chip ${value === normalized.current ? "is-current" : ""}">${escapeInteractiveHtml(value)}</span>`).join("")}
      </div>
      <p class="helper-text">Step: +${escapeInteractiveHtml(String(normalized.step))}</p>
    </div>
  `;
}

function normalizeTimeMode(value) {
  const mode = String(value || "digital").trim().toLowerCase();
  if (["digital", "analog", "analog-to-digital"].includes(mode)) return mode;
  return "digital";
}

function normalizeTimeHour(value) {
  const hour = Number.parseInt(value, 10);
  if (!Number.isInteger(hour)) return 3;
  if (hour < 1) return 1;
  if (hour > 12) return 12;
  return hour;
}

function normalizeTimeMinute(value) {
  const minute = Number.parseInt(value, 10);
  if (!Number.isInteger(minute)) return 15;
  if (minute < 0) return 0;
  if (minute > 59) return 59;
  return minute;
}

function normalizeTimePeriod(value) {
  const period = String(value || "").trim().toUpperCase();
  return period === "AM" || period === "PM" ? period : "";
}

function normalizeTimeDigitalChallenge(value) {
  const challenge = String(value || "words-to-12h").trim().toLowerCase();
  if (["words-to-12h", "12h-to-24h", "24h-to-12h"].includes(challenge)) return challenge;
  return "words-to-12h";
}

function normalizeTimeFocus(value) {
  const focus = String(value || "exact-time").trim().toLowerCase();
  return focus === "hour-only" ? "hour-only" : "exact-time";
}

function formatTimeValue(hour, minute, period = "") {
  const hh = normalizeTimeHour(hour);
  const mm = String(normalizeTimeMinute(minute)).padStart(2, "0");
  const suffix = normalizeTimePeriod(period);
  return suffix ? `${hh}:${mm} ${suffix}` : `${hh}:${mm}`;
}

function formatTime24Value(hour, minute, period = "") {
  const hh12 = normalizeTimeHour(hour);
  const mm = String(normalizeTimeMinute(minute)).padStart(2, "0");
  const suffix = normalizeTimePeriod(period);
  let hh24 = hh12 % 12;
  if (suffix === "PM") {
    hh24 += 12;
  }
  const hh = String(hh24).padStart(2, "0");
  return `${hh}:${mm}`;
}

function formatTime12ValueFrom24(hour24, minute) {
  const safeHour24 = Math.max(0, Math.min(23, Number.parseInt(hour24, 10) || 0));
  const safeMinute = normalizeTimeMinute(minute);
  const period = safeHour24 >= 12 ? "PM" : "AM";
  const hour12raw = safeHour24 % 12;
  const hour12 = hour12raw === 0 ? 12 : hour12raw;
  return formatTimeValue(hour12, safeMinute, period);
}

function buildTimePhrase(hour, minute) {
  const safeHour = normalizeTimeHour(hour);
  const safeMinute = normalizeTimeMinute(minute);
  const nextHour = safeHour === 12 ? 1 : safeHour + 1;

  if (safeMinute === 0) {
    return `${safeHour} o'clock`;
  }
  if (safeMinute === 15) {
    return `quarter past ${safeHour}`;
  }
  if (safeMinute === 30) {
    return `half past ${safeHour}`;
  }
  if (safeMinute === 45) {
    return `quarter to ${nextHour}`;
  }
  if (safeMinute < 30) {
    return `${safeMinute} minute${safeMinute === 1 ? "" : "s"} past ${safeHour}`;
  }
  const remaining = 60 - safeMinute;
  return `${remaining} minute${remaining === 1 ? "" : "s"} to ${nextHour}`;
}

function buildDefaultTimeQuestionByMode(mode, hour, minute, period = "", digitalChallenge = "words-to-12h") {
  const safeMode = normalizeTimeMode(mode);
  const target = formatTimeValue(hour, minute, period);
  if (safeMode === "analog") {
    return `Set the analog clock to ${target}.`;
  }
  if (safeMode === "analog-to-digital") {
    return "Look at the analog clock and choose the correct digital time.";
  }
  const challenge = normalizeTimeDigitalChallenge(digitalChallenge);
  if (challenge === "12h-to-24h") {
    const sourcePeriod = normalizeTimePeriod(period) || "PM";
    return `Convert ${formatTimeValue(hour, minute, sourcePeriod)} to 24-hour time.`;
  }
  if (challenge === "24h-to-12h") {
    const sourcePeriod = normalizeTimePeriod(period) || "PM";
    return `Convert ${formatTime24Value(hour, minute, sourcePeriod)} to 12-hour time.`;
  }
  return `Write the digital time for: ${buildTimePhrase(hour, minute)}.`;
}

function buildDefaultTimeSolutionByMode(mode, hour, minute, period = "", digitalChallenge = "words-to-12h") {
  const safeMode = normalizeTimeMode(mode);
  const target = formatTimeValue(hour, minute, period);
  if (safeMode === "analog") {
    return `Move the hour hand to ${normalizeTimeHour(hour)} and the minute hand to ${String(normalizeTimeMinute(minute)).padStart(2, "0")}.`;
  }
  if (safeMode === "analog-to-digital") {
    return `Read the analog hands and match them to ${target}.`;
  }
  const challenge = normalizeTimeDigitalChallenge(digitalChallenge);
  if (challenge === "12h-to-24h") {
    const sourcePeriod = normalizeTimePeriod(period) || "PM";
    return `${formatTimeValue(hour, minute, sourcePeriod)} in 24-hour time is ${formatTime24Value(hour, minute, sourcePeriod)}.`;
  }
  if (challenge === "24h-to-12h") {
    const sourcePeriod = normalizeTimePeriod(period) || "PM";
    return `${formatTime24Value(hour, minute, sourcePeriod)} in 12-hour time is ${formatTimeValue(hour, minute, sourcePeriod)}.`;
  }
  const twelveHour = formatTimeValue(hour, minute);
  let twentyFourHour = formatTime24Value(hour, minute, "PM");
  if (twentyFourHour === twelveHour) {
    twentyFourHour = formatTime24Value(hour, minute, "AM");
  }
  return `${buildTimePhrase(hour, minute)} can be written as ${twelveHour} or ${twentyFourHour}.`;
}

function isLikelyDefaultTimeQuestion(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return true;
  return text === "type the digital time shown."
    || text.startsWith("set the analog clock to ")
    || text === "look at the analog clock and choose the correct digital time."
    || text.startsWith("write the digital time for:");
}

function isLikelyDefaultTimeSolution(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return true;
  return text.startsWith("the displayed digital time is ")
    || text.startsWith("move the hour hand to ")
    || text.startsWith("the minute hand points to ")
    || text.startsWith("read the analog hands and match them to ")
    || text.includes("is written as ");
}

function buildAnalogToDigitalOptions(hour, minute) {
  const safeHour = normalizeTimeHour(hour);
  const safeMinute = normalizeTimeMinute(minute);
  const deltas = [0, 5, -5, 10];
  const options = [];

  deltas.forEach((delta) => {
    let h = safeHour;
    let m = safeMinute + delta;
    while (m < 0) {
      m += 60;
      h = h === 1 ? 12 : h - 1;
    }
    while (m >= 60) {
      m -= 60;
      h = h === 12 ? 1 : h + 1;
    }
    const candidate = formatTimeValue(h, m);
    if (!options.includes(candidate)) {
      options.push(candidate);
    }
  });

  while (options.length < 4) {
    const filler = formatTimeValue(((safeHour + options.length) % 12) + 1, (safeMinute + (options.length * 10)) % 60);
    if (!options.includes(filler)) {
      options.push(filler);
    }
  }

  return options.slice(0, 4);
}

function buildTimeClockNumbersMarkup() {
  return Array.from({ length: 12 }, (_, index) => {
    const number = index + 1;
    const angle = number * 30;
    return `<span class="time-clock-number" style="--angle:${angle}deg">${number}</span>`;
  }).join("");
}

function buildTimePreviewMarkup(config) {
  const mode = normalizeTimeMode(config && config.mode);
  const hour = normalizeTimeHour(config && config.hour);
  const minute = normalizeTimeMinute(config && config.minute);
  const period = normalizeTimePeriod(config && config.period);
  const minuteAngle = minute * 6;
  const hourAngle = (hour % 12) * 30;
  const digital = formatTimeValue(hour, minute, period);
  const modeText = mode === "analog-to-digital"
    ? "Analog to Digital"
    : mode.charAt(0).toUpperCase() + mode.slice(1);

  return `
    <div class="simple-card time-preview-card">
      <p class="bar-chart-title">Time (${escapeInteractiveHtml(modeText)})</p>
      <div class="time-analog-face" aria-hidden="true">
        ${buildTimeClockNumbersMarkup()}
        <span class="time-center-dot"></span>
        <span class="time-hand hour" style="transform: translate(-50%, -100%) rotate(${hourAngle}deg);"></span>
        <span class="time-hand minute" style="transform: translate(-50%, -100%) rotate(${minuteAngle}deg);"></span>
      </div>
      <p class="helper-text">Target time: <strong>${escapeInteractiveHtml(digital)}</strong></p>
    </div>
  `;
}

function buildInteractiveAppMarkup(app, context = {}) {
  if (!app || !app.type) return "<p class='helper-text'>Choose a template to add an optional interactive math visual.</p>";
  switch (app.type) {
    case "time":
      return buildTimePreviewMarkup(app.config || {});
    case "number-tracing":
      return buildNumberTracingPreviewMarkup(app.config || {});
    case "number-ordering":
      return buildNumberOrderingPreviewMarkup(app.config || {});
    case "icon-count":
      return buildIconCountPreviewMarkup(app.config || {}, context);
    case "calendar-sequence":
      return buildCalendarSequencePreviewMarkup(app.config || {});
    case "arithmetic":
      return buildArithmeticPreviewMarkup(app.config || {});
    case "number-line":
      return buildNumberLineMarkup(app.config || {});
    case "cartesian-plane":
      return buildCartesianPlaneMarkup(app.config || {});
    case "cartesian-plane-plot":
      return buildCartesianPlotMarkup(app.config || {});
    case "bar-chart":
      return buildBarChartMarkup(app.config || {});
    case "histogram":
      return buildHistogramMarkup(app.config || {});
    case "box-plot":
      return buildBoxPlotMarkup(app.config || {});
    case "scatter-plot":
      return buildScatterPlotMarkup(app.config || {});
    case "probability-tree":
      return buildProbabilityTreeMarkup(app.config || {});
    case "distribution-curve":
      return buildDistributionCurveMarkup(app.config || {});
    case "fractions":
      return buildFractionsMarkup(app.config || {});
    case "network-graph":
      return buildNetworkGraphMarkup(app.config || {});
    case "matrix":
      return buildMatrixMarkup(app.config || {});
    case "stem-and-leaf":
      return buildStemLeafMarkup(app.config || {});
    case "geometry-shapes":
      return buildGeometryShapesMarkup(app.config || {});
    case "pythagoras":
      return buildPythagorasMarkup(app.config || {});
    case "trigonometry":
      return buildTrigonometryMarkup(app.config || {});
    default:
      return "<p class='helper-text'>This interactive template is not supported.</p>";
  }
}

let interactiveAppTypeOptionsCache = null;

function getInteractiveAppTypeOptions() {
  if (Array.isArray(interactiveAppTypeOptionsCache)) {
    return interactiveAppTypeOptionsCache;
  }

  const typeSelect = document.getElementById("interactiveAppType");
  if (!typeSelect) {
    interactiveAppTypeOptionsCache = [];
    return interactiveAppTypeOptionsCache;
  }

  interactiveAppTypeOptionsCache = Array.from(typeSelect.options)
    .map((option) => ({
      value: String(option.value || "").trim(),
      label: String(option.textContent || "").trim()
    }))
    .filter((item) => item.value !== "")
    .sort((a, b) => a.label.localeCompare(b.label));

  return interactiveAppTypeOptionsCache;
}

function renderInteractiveAppTypeOptions(forcedValue = "") {
  const typeSelect = document.getElementById("interactiveAppType");
  if (!typeSelect) return;

  const activeValue = String(forcedValue || typeSelect.value || "").trim();
  const options = getInteractiveAppTypeOptions();

  typeSelect.innerHTML = "";
  const noneOption = document.createElement("option");
  noneOption.value = "";
  noneOption.textContent = "None";
  typeSelect.appendChild(noneOption);

  options.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    typeSelect.appendChild(option);
  });

  typeSelect.value = options.some((item) => item.value === activeValue) ? activeValue : "";
}

function initializeInteractiveAppTypePicker() {
  const typeSelect = document.getElementById("interactiveAppType");
  if (!typeSelect) return;

  interactiveAppTypeOptionsCache = null;
  renderInteractiveAppTypeOptions(typeSelect.value);
}
function renderInteractiveAppPreview(app) {
  const preview = document.getElementById("interactiveAppPreview");
  if (!preview) return;
  preview.innerHTML = buildInteractiveAppMarkup(app);
}

function setInteractiveAppConfigVisibility(type) {
  const configVisibilityMap = {
    timeConfig: "time",
    arithmeticConfig: "arithmetic",
    numberTracingConfig: "number-tracing",
    numberOrderingConfig: "number-ordering",
    iconCountConfig: "icon-count",
    calendarSequenceConfig: "calendar-sequence",
    numberLineConfig: "number-line",
    cartesianPlaneConfig: "cartesian-plane",
    cartesianPlotConfig: "cartesian-plane-plot",
    barChartConfig: "bar-chart",
    histogramConfig: "histogram",
    boxPlotConfig: "box-plot",
    scatterPlotConfig: "scatter-plot",
    probabilityTreeConfig: "probability-tree",
    distributionCurveConfig: "distribution-curve",
    fractionsConfig: "fractions",
    networkGraphConfig: "network-graph",
    matrixConfig: "matrix",
    stemLeafConfig: "stem-and-leaf",
    geometryShapesConfig: "geometry-shapes",
    pythagorasConfig: "pythagoras",
    trigonometryConfig: "trigonometry"
  };

  Object.keys(configVisibilityMap).forEach((id) => {
    const element = document.getElementById(id);
    if (!element) return;
    element.classList.toggle("hidden", configVisibilityMap[id] !== type);
  });
}

function readInteractiveAppFromForm() {
  const type = String(document.getElementById("interactiveAppType").value || "").trim();
  if (!type) return null;

  switch (type) {
    case "time": {
      const mode = normalizeTimeMode(document.getElementById("timeMode").value);
      const timeFocus = normalizeTimeFocus(document.getElementById("timeFocus").value);
      const allowCustomAnswer = Boolean(document.getElementById("timeAllowCustomAnswer").checked);
      const digitalChallenge = normalizeTimeDigitalChallenge(document.getElementById("timeDigitalChallenge").value);
      const hour = normalizeTimeHour(document.getElementById("timeHour").value);
      const minuteRaw = normalizeTimeMinute(document.getElementById("timeMinute").value);
      const minute = timeFocus === "hour-only" ? 0 : minuteRaw;
      const period = normalizeTimePeriod(document.getElementById("timePeriod").value);
      return {
        type,
        config: {
          mode,
          timeFocus,
          allowCustomAnswer,
          digitalChallenge,
          hour,
          minute,
          period
        }
      };
    }
    case "number-tracing": {
      const targetNumber = Number.parseInt(document.getElementById("ntTargetNumber").value, 10);
      const prompt = String(document.getElementById("ntPrompt").value || "").trim();
      const prepMode = Boolean(document.getElementById("ntPrepMode").checked);
      const showQuantityDots = Boolean(document.getElementById("ntShowQuantityDots").checked);
      return {
        type,
        config: {
          targetNumber: Number.isInteger(targetNumber) ? Math.max(0, Math.min(100, targetNumber)) : 5,
          prompt: prompt || (prepMode ? "Tap the matching number, then trace it." : "Trace the dotted number and say it aloud."),
          prepMode,
          showQuantityDots
        }
      };
    }
    case "number-ordering": {
      const prompt = String(document.getElementById("noPrompt").value || "").trim();
      const direction = normalizeNumberOrderingDirection(document.getElementById("noDirection").value);
      const cards = parseNumberOrderingValues(document.getElementById("noCards").value).slice(0, 8);
      const safeCards = cards.length > 0 ? cards : [7, 3, 9, 5];
      const explicitCorrectOrder = parseNumberOrderingValues(document.getElementById("noCorrectOrder").value).slice(0, 8);
      const computed = safeCards.slice().sort((a, b) => a - b);
      const fallbackCorrectOrder = direction === "descending" ? computed.reverse() : computed;
      const correctOrder = explicitCorrectOrder.length > 0 ? explicitCorrectOrder : fallbackCorrectOrder;
      return {
        type,
        config: {
          prompt: prompt || "Order the number cards from smallest to largest.",
          direction,
          cards: safeCards,
          correctOrder
        }
      };
    }
    case "icon-count": {
      const prompt = String(document.getElementById("icPrompt").value || "").trim();
      const totalCountRaw = Number.parseInt(document.getElementById("icTotalCount").value, 10);
      const totalCount = Number.isInteger(totalCountRaw) ? Math.max(0, Math.min(20, totalCountRaw)) : 8;
      const iconShape = normalizeIconCountShape(document.getElementById("icIconShape").value);
      let groups = parseIconCountGroups(document.getElementById("icGroups").value).slice(0, 8);
      if (groups.length === 0) groups = [totalCount];
      const sum = groups.reduce((acc, value) => acc + value, 0);
      if (sum !== totalCount) groups = [totalCount];
      return {
        type,
        config: {
          prompt: prompt || "How many icons are shown in total?",
          totalCount,
          iconShape,
          groups
        }
      };
    }
    case "calendar-sequence": {
      const mode = normalizeCalendarSequenceMode(document.getElementById("csMode").value);
      const current = String(document.getElementById("csCurrent").value || "").trim();
      const stepRaw = Number.parseInt(document.getElementById("csStep").value, 10);
      const step = Number.isInteger(stepRaw) ? Math.max(1, Math.min(10, stepRaw)) : 1;
      const values = parseCalendarSequenceValues(document.getElementById("csValues").value);
      const normalized = normalizeCalendarSequenceConfig({
        mode,
        current,
        step,
        values,
        prompt: String(document.getElementById("csPrompt").value || "").trim()
      });
      return {
        type,
        config: {
          mode: normalized.mode,
          prompt: normalized.prompt,
          current: normalized.current,
          step: normalized.step,
          values: normalized.values
        }
      };
    }
    case "arithmetic": {
      const rawLayout = String(document.getElementById("arithLayout").value || "horizontal").trim().toLowerCase();
      const layout = rawLayout === "vertical" ? "vertical" : rawLayout === "long" ? "long" : "horizontal";
      const operator = String(document.getElementById("arithOperator").value || "+").trim() || "+";
      const operandA = Number.parseFloat(document.getElementById("arithOperandA").value);
      const operandB = Number.parseFloat(document.getElementById("arithOperandB").value);
      const answerText = String(document.getElementById("arithAnswer").value || "").trim();
      const previewAnswer = computeArithmeticPreviewAnswer({ operandA, operandB, operator });
      const resolvedAnswer = answerText || previewAnswer;
      return {
        type,
        config: {
          layout,
          operator,
          operandA: Number.isFinite(operandA) ? operandA : 0,
          operandB: Number.isFinite(operandB) ? operandB : 0,
          answer: resolvedAnswer,
          answerDigits: String(resolvedAnswer || "").length || 1
        }
      };
    }
    case "number-line": {
      const min = Number.parseFloat(document.getElementById("nlMin").value);
      const max = Number.parseFloat(document.getElementById("nlMax").value);
      return {
        type,
        config: {
          min: Number.isFinite(min) ? min : -10,
          max: Number.isFinite(max) ? max : 10,
          points: parseNlPoints(document.getElementById("nlPoints").value),
          arrows: parseNlArrows(document.getElementById("nlArrows").value)
        }
      };
    }
    case "cartesian-plane": {
      const xMin = Number.parseFloat(document.getElementById("cpXMin").value);
      const xMax = Number.parseFloat(document.getElementById("cpXMax").value);
      const yMin = Number.parseFloat(document.getElementById("cpYMin").value);
      const yMax = Number.parseFloat(document.getElementById("cpYMax").value);
      const angleMode = String(document.getElementById("cpAngleMode").value || "radians").trim() || "radians";
      return {
        type,
        config: {
          xMin: Number.isFinite(xMin) ? xMin : -10,
          xMax: Number.isFinite(xMax) ? xMax : 10,
          yMin: Number.isFinite(yMin) ? yMin : -10,
          yMax: Number.isFinite(yMax) ? yMax : 10,
          angleMode: angleMode === "degrees" ? "degrees" : "radians",
          points: parseCartesianPoints(document.getElementById("cpPoints").value),
          segments: parseCartesianSegments(document.getElementById("cpSegments").value),
          parabolas: parseCartesianParabolas(document.getElementById("cpParabolas").value),
          functions: parseCartesianFunctions(document.getElementById("cpFunctions").value)
        }
      };
    }
    case "cartesian-plane-plot": {
      const cppXMin = Number.parseFloat(document.getElementById("cppXMin").value);
      const cppXMax = Number.parseFloat(document.getElementById("cppXMax").value);
      const cppYMin = Number.parseFloat(document.getElementById("cppYMin").value);
      const cppYMax = Number.parseFloat(document.getElementById("cppYMax").value);
      const cppTolerance = Number.parseFloat(document.getElementById("cppTolerance").value);
      const cppVceTemplate = String(document.getElementById("cppVceTemplate").value || "").trim();
      const cppPresetType = String(document.getElementById("cppPresetType").value || "linear").trim() || "linear";
      const cppPresetExpression = String(document.getElementById("cppPresetExpression").value || "").trim();
      const cppPresetXValues = String(document.getElementById("cppPresetXValues").value || "").trim();
      return {
        type,
        config: {
          xMin: Number.isFinite(cppXMin) ? cppXMin : -10,
          xMax: Number.isFinite(cppXMax) ? cppXMax : 10,
          yMin: Number.isFinite(cppYMin) ? cppYMin : -10,
          yMax: Number.isFinite(cppYMax) ? cppYMax : 10,
          tolerance: Number.isFinite(cppTolerance) && cppTolerance >= 0 ? cppTolerance : 0.5,
          points: parseCartesianPoints(document.getElementById("cppPoints").value),
          vceTemplate: cppVceTemplate,
          presetType: cppPresetType,
          presetExpression: cppPresetExpression || defaultCartesianPlotPresetExpression(cppPresetType),
          presetXValues: cppPresetXValues || defaultCartesianPlotPresetXValues(cppPresetType)
        }
      };
    }
    case "bar-chart": {
      const yMaxRaw = Number.parseFloat(document.getElementById("bcYMax").value);
      const orientation = String(document.getElementById("bcOrientation").value || "vertical").trim().toLowerCase() === "horizontal" ? "horizontal" : "vertical";
      return {
        type,
        config: {
          title: document.getElementById("bcTitle").value.trim() || "Category Frequencies",
          orientation,
          categoryAxisLabel: document.getElementById("bcCategoryAxisLabel").value.trim() || "Category",
          valueAxisLabel: document.getElementById("bcValueAxisLabel").value.trim() || "Value",
          yMax: Number.isFinite(yMaxRaw) && yMaxRaw > 0 ? yMaxRaw : null,
          items: parseBarChartItems(document.getElementById("bcItems").value)
        }
      };
    }
    case "histogram": {
      const binCount = Number.parseInt(document.getElementById("histBinCount").value, 10);
      return {
        type,
        config: {
          title: document.getElementById("histTitle").value.trim() || "Continuous Data Distribution",
          values: parseNumericList(document.getElementById("histValues").value),
          binCount: Number.isInteger(binCount) ? Math.max(2, Math.min(30, binCount)) : 8
        }
      };
    }
    case "box-plot":
      {
        const datasetCount = clampBoxPlotDatasetCount(document.getElementById("boxDatasetCount").value);
        const datasets = parseBoxPlotDatasetsFromText(document.getElementById("boxDatasets").value, datasetCount);
        return {
          type,
          config: {
            title: document.getElementById("boxTitle").value.trim() || "Compare Datasets",
            datasets
          }
        };
      }
    case "scatter-plot":
      return {
        type,
        config: {
          title: document.getElementById("scTitle").value.trim() || "Correlation and Best Fit",
          points: parseCartesianPoints(document.getElementById("scPoints").value)
        }
      };
    case "probability-tree":
      return {
        type,
        config: {
          title: document.getElementById("ptTitle").value.trim() || "Sequential Probabilities",
          paths: parseProbabilityTreePaths(document.getElementById("ptPaths").value),
          conditionalQuery: document.getElementById("ptConditional").value.trim()
        }
      };
    case "distribution-curve": {
      const mean = Number.parseFloat(document.getElementById("dcMean").value);
      const stdDev = Number.parseFloat(document.getElementById("dcStdDev").value);
      const from = Number.parseFloat(document.getElementById("dcFrom").value);
      const to = Number.parseFloat(document.getElementById("dcTo").value);
      return {
        type,
        config: {
          title: document.getElementById("dcTitle").value.trim() || "Normal Distribution",
          mean: Number.isFinite(mean) ? mean : 0,
          stdDev: Number.isFinite(stdDev) && stdDev > 0 ? stdDev : 1,
          from: Number.isFinite(from) ? from : -1,
          to: Number.isFinite(to) ? to : 1
        }
      };
    }
    case "fractions": {
      const numeratorA = Number.parseInt(document.getElementById("fxNumeratorA").value, 10);
      const denominatorA = Number.parseInt(document.getElementById("fxDenominatorA").value, 10);
      const numeratorB = Number.parseInt(document.getElementById("fxNumeratorB").value, 10);
      const denominatorB = Number.parseInt(document.getElementById("fxDenominatorB").value, 10);
      return {
        type,
        config: {
          operation: normalizeFractionOperation(document.getElementById("fxOperation").value),
          fractionA: {
            numerator: Number.isInteger(numeratorA) ? numeratorA : 1,
            denominator: Number.isInteger(denominatorA) && denominatorA !== 0 ? denominatorA : 2
          },
          fractionB: {
            numerator: Number.isInteger(numeratorB) ? numeratorB : 1,
            denominator: Number.isInteger(denominatorB) && denominatorB !== 0 ? denominatorB : 3
          }
        }
      };
    }
    case "network-graph":
      return {
        type,
        config: {
          title: document.getElementById("ngTitle").value.trim() || "Shortest Path, MST, Flow",
          nodes: parseNetworkNodes(document.getElementById("ngNodes").value),
          edges: parseNetworkEdges(document.getElementById("ngEdges").value),
          source: document.getElementById("ngSource").value.trim(),
          target: document.getElementById("ngTarget").value.trim(),
          flowSource: document.getElementById("ngFlowSource").value.trim(),
          flowSink: document.getElementById("ngFlowSink").value.trim()
        }
      };
    case "matrix":
      return {
        type,
        config: {
          title: document.getElementById("mxTitle").value.trim() || "Matrix Operations",
          operation: normalizeMatrixOperation(document.getElementById("mxOperation").value),
          matrixA: parseMatrixRows(document.getElementById("mxMatrixA").value),
          matrixB: parseMatrixRows(document.getElementById("mxMatrixB").value)
        }
      };
    case "stem-and-leaf": {
      const stemUnit = Number.parseInt(document.getElementById("slStemUnit").value, 10);
      return {
        type,
        config: {
          values: parseNumericList(document.getElementById("slValues").value),
          stemUnit: Number.isInteger(stemUnit) && stemUnit > 0 ? stemUnit : 10
        }
      };
    }
    case "geometry-shapes": {
      const canvasWidth = Number.parseInt(document.getElementById("geoCanvasWidth").value, 10);
      const canvasHeight = Number.parseInt(document.getElementById("geoCanvasHeight").value, 10);
      const unit = String(document.getElementById("geoUnit").value || "unit").trim() || "unit";
      const formulaNotation = String(document.getElementById("geoFormulaNotation").value || "plain").trim() || "plain";
      return {
        type,
        config: {
          canvasWidth: Number.isInteger(canvasWidth) ? canvasWidth : 360,
          canvasHeight: Number.isInteger(canvasHeight) ? canvasHeight : 260,
          unit,
          formulaNotation,
          shapes: parseGeometryShapes(document.getElementById("geoShapesInput").value)
        }
      };
    }
    case "pythagoras":
      return {
        type,
        config: {
          sideA: document.getElementById("pySideA").value.trim(),
          sideB: document.getElementById("pySideB").value.trim(),
          sideC: document.getElementById("pySideC").value.trim(),
          caption: document.getElementById("pyCaption").value.trim()
        }
      };
    case "trigonometry": {
      const angleDeg = Number.parseFloat(document.getElementById("trigAngleDeg").value);
      return {
        type,
        config: {
          angleDeg: Number.isFinite(angleDeg) ? angleDeg : 35,
          focusFunction: document.getElementById("trigFunction").value || "sin",
          opposite: document.getElementById("trigOpposite").value.trim(),
          adjacent: document.getElementById("trigAdjacent").value.trim(),
          hypotenuse: document.getElementById("trigHypotenuse").value.trim()
        }
      };
    }
    default:
      return null;
  }
}

function populateInteractiveAppForm(app) {
  const typeSelect = document.getElementById("interactiveAppType");
  const nextApp = app || null;
  const type = nextApp ? (nextApp.type || "") : "";
  renderInteractiveAppTypeOptions(type);
  typeSelect.value = type;
  setInteractiveAppConfigVisibility(type);

  const numberLineConfig = (type === "number-line" ? nextApp : buildDefaultInteractiveApp("number-line")).config;
  const arithmeticConfig = (type === "arithmetic" ? nextApp : buildDefaultInteractiveApp("arithmetic")).config;
  const numberTracingConfig = (type === "number-tracing" ? nextApp : buildDefaultInteractiveApp("number-tracing")).config;
  const numberOrderingConfig = (type === "number-ordering" ? nextApp : buildDefaultInteractiveApp("number-ordering")).config;
  const iconCountConfig = (type === "icon-count" ? nextApp : buildDefaultInteractiveApp("icon-count")).config;
  const calendarSequenceConfig = (type === "calendar-sequence" ? nextApp : buildDefaultInteractiveApp("calendar-sequence")).config;
  const timeConfig = (type === "time" ? nextApp : buildDefaultInteractiveApp("time")).config;

  document.getElementById("timeMode").value = normalizeTimeMode(timeConfig.mode);
  document.getElementById("timeFocus").value = normalizeTimeFocus(timeConfig.timeFocus);
  document.getElementById("timeAllowCustomAnswer").checked = Boolean(timeConfig.allowCustomAnswer);
  document.getElementById("timeDigitalChallenge").value = normalizeTimeDigitalChallenge(timeConfig.digitalChallenge);
  document.getElementById("timeHour").value = normalizeTimeHour(timeConfig.hour);
  document.getElementById("timeMinute").value = normalizeTimeMinute(timeConfig.minute);
  document.getElementById("timePeriod").value = normalizeTimePeriod(timeConfig.period);

  const savedLayout = String(arithmeticConfig.layout || "horizontal").trim().toLowerCase();
  document.getElementById("arithLayout").value = savedLayout === "vertical" ? "vertical" : savedLayout === "long" ? "long" : "horizontal";
  document.getElementById("arithOperator").value = String(arithmeticConfig.operator || "+").trim() || "+";
  document.getElementById("arithOperandA").value = Number.isFinite(Number(arithmeticConfig.operandA)) ? String(arithmeticConfig.operandA) : "0";
  document.getElementById("arithOperandB").value = Number.isFinite(Number(arithmeticConfig.operandB)) ? String(arithmeticConfig.operandB) : "0";
  document.getElementById("arithAnswer").value = arithmeticConfig.answer || "";

  const tracingTarget = Number.parseInt(numberTracingConfig.targetNumber, 10);
  document.getElementById("ntTargetNumber").value = Number.isInteger(tracingTarget) ? String(Math.max(0, Math.min(100, tracingTarget))) : "5";
  document.getElementById("ntPrompt").value = String(numberTracingConfig.prompt || "Tap the matching number, then trace it.");
  document.getElementById("ntPrepMode").checked = Boolean(numberTracingConfig.prepMode);
  document.getElementById("ntShowQuantityDots").checked = Boolean(numberTracingConfig.showQuantityDots);

  const orderingDirection = normalizeNumberOrderingDirection(numberOrderingConfig.direction);
  const orderingCards = Array.isArray(numberOrderingConfig.cards)
    ? numberOrderingConfig.cards.map((item) => Number.parseInt(item, 10)).filter((item) => Number.isInteger(item))
    : [];
  const orderingCorrect = Array.isArray(numberOrderingConfig.correctOrder)
    ? numberOrderingConfig.correctOrder.map((item) => Number.parseInt(item, 10)).filter((item) => Number.isInteger(item))
    : [];
  const safeOrderingCards = orderingCards.length > 0 ? orderingCards : [7, 3, 9, 5];
  const computedOrdering = safeOrderingCards.slice().sort((a, b) => a - b);
  const safeOrderingCorrect = orderingCorrect.length > 0
    ? orderingCorrect
    : (orderingDirection === "descending" ? computedOrdering.reverse() : computedOrdering);
  document.getElementById("noPrompt").value = String(numberOrderingConfig.prompt || "Order the number cards from smallest to largest.");
  document.getElementById("noDirection").value = orderingDirection;
  document.getElementById("noCards").value = safeOrderingCards.join(", ");
  document.getElementById("noCorrectOrder").value = safeOrderingCorrect.join(", ");

  const normalizedIconCount = normalizeIconCountConfig(iconCountConfig);
  document.getElementById("icPrompt").value = normalizedIconCount.prompt;
  document.getElementById("icTotalCount").value = String(normalizedIconCount.totalCount);
  document.getElementById("icIconShape").value = normalizedIconCount.iconShape;
  document.getElementById("icGroups").value = normalizedIconCount.groups.join(", ");

  const normalizedCalendarSequence = normalizeCalendarSequenceConfig(calendarSequenceConfig);
  document.getElementById("csPrompt").value = normalizedCalendarSequence.prompt;
  document.getElementById("csMode").value = normalizedCalendarSequence.mode;
  document.getElementById("csCurrent").value = normalizedCalendarSequence.current;
  document.getElementById("csStep").value = String(normalizedCalendarSequence.step);
  document.getElementById("csValues").value = normalizedCalendarSequence.values.join(", ");

  document.getElementById("nlMin").value = numberLineConfig.min ?? -10;
  document.getElementById("nlMax").value = numberLineConfig.max ?? 10;
  document.getElementById("nlPoints").value = serializeNlPoints(numberLineConfig.points || []);
  document.getElementById("nlArrows").value = serializeNlArrows(numberLineConfig.arrows || []);

  const cartesianConfig = (type === "cartesian-plane" ? nextApp : buildDefaultInteractiveApp("cartesian-plane")).config;
  document.getElementById("cpXMin").value = cartesianConfig.xMin ?? -10;
  document.getElementById("cpXMax").value = cartesianConfig.xMax ?? 10;
  document.getElementById("cpYMin").value = cartesianConfig.yMin ?? -10;
  document.getElementById("cpYMax").value = cartesianConfig.yMax ?? 10;
  document.getElementById("cpAngleMode").value = cartesianConfig.angleMode === "degrees" ? "degrees" : "radians";
  document.getElementById("cpPoints").value = serializeCartesianPoints(cartesianConfig.points || []);
  document.getElementById("cpSegments").value = serializeCartesianSegments(cartesianConfig.segments || []);
  document.getElementById("cpParabolas").value = serializeCartesianParabolas(cartesianConfig.parabolas || []);
  document.getElementById("cpFunctions").value = serializeCartesianFunctions(cartesianConfig.functions || []);

  const cartesianPlotConfig = (type === "cartesian-plane-plot" ? nextApp : buildDefaultInteractiveApp("cartesian-plane-plot")).config;
  document.getElementById("cppXMin").value = cartesianPlotConfig.xMin ?? -10;
  document.getElementById("cppXMax").value = cartesianPlotConfig.xMax ?? 10;
  document.getElementById("cppYMin").value = cartesianPlotConfig.yMin ?? -10;
  document.getElementById("cppYMax").value = cartesianPlotConfig.yMax ?? 10;
  document.getElementById("cppTolerance").value = cartesianPlotConfig.tolerance ?? 0.5;
  document.getElementById("cppPoints").value = serializeCartesianPoints(cartesianPlotConfig.points || []);
  document.getElementById("cppVceTemplate").value = cartesianPlotConfig.vceTemplate || "";
  document.getElementById("cppPresetType").value = cartesianPlotConfig.presetType || "linear";
  document.getElementById("cppPresetExpression").value = cartesianPlotConfig.presetExpression || defaultCartesianPlotPresetExpression(cartesianPlotConfig.presetType || "linear");
  document.getElementById("cppPresetXValues").value = cartesianPlotConfig.presetXValues || defaultCartesianPlotPresetXValues(cartesianPlotConfig.presetType || "linear");

  const barChartConfig = (type === "bar-chart" ? nextApp : buildDefaultInteractiveApp("bar-chart")).config;
  document.getElementById("bcTitle").value = barChartConfig.title || "Category Frequencies";
  document.getElementById("bcYMax").value = Number.isFinite(Number(barChartConfig.yMax)) && Number(barChartConfig.yMax) > 0 ? String(barChartConfig.yMax) : "";
  document.getElementById("bcOrientation").value = String(barChartConfig.orientation || "vertical").trim().toLowerCase() === "horizontal" ? "horizontal" : "vertical";
  document.getElementById("bcCategoryAxisLabel").value = barChartConfig.categoryAxisLabel || "Category";
  document.getElementById("bcValueAxisLabel").value = barChartConfig.valueAxisLabel || "Value";
  document.getElementById("bcItems").value = serializeBarChartItems(barChartConfig.items || []);

  const histogramConfig = (type === "histogram" ? nextApp : buildDefaultInteractiveApp("histogram")).config;
  document.getElementById("histTitle").value = histogramConfig.title || "Continuous Data Distribution";
  document.getElementById("histValues").value = Array.isArray(histogramConfig.values) ? histogramConfig.values.join(", ") : "";
  document.getElementById("histBinCount").value = histogramConfig.binCount ?? 8;

  const boxPlotConfig = (type === "box-plot" ? nextApp : buildDefaultInteractiveApp("box-plot")).config;
  const boxDatasets = normalizeBoxPlotDatasets(boxPlotConfig);
  document.getElementById("boxTitle").value = boxPlotConfig.title || "Compare Datasets";
  document.getElementById("boxDatasetCount").value = String(clampBoxPlotDatasetCount(boxDatasets.length));
  document.getElementById("boxDatasets").value = serializeBoxPlotDatasets(boxDatasets);

  const scatterPlotConfig = (type === "scatter-plot" ? nextApp : buildDefaultInteractiveApp("scatter-plot")).config;
  document.getElementById("scTitle").value = scatterPlotConfig.title || "Correlation and Best Fit";
  document.getElementById("scPoints").value = serializeCartesianPoints(scatterPlotConfig.points || []);

  const probabilityConfig = (type === "probability-tree" ? nextApp : buildDefaultInteractiveApp("probability-tree")).config;
  document.getElementById("ptTitle").value = probabilityConfig.title || "Sequential Probabilities";
  document.getElementById("ptPaths").value = serializeProbabilityTreePaths(probabilityConfig.paths || []);
  document.getElementById("ptConditional").value = probabilityConfig.conditionalQuery || "";

  const distributionConfig = (type === "distribution-curve" ? nextApp : buildDefaultInteractiveApp("distribution-curve")).config;
  document.getElementById("dcTitle").value = distributionConfig.title || "Normal Distribution";
  document.getElementById("dcMean").value = distributionConfig.mean ?? 0;
  document.getElementById("dcStdDev").value = distributionConfig.stdDev ?? 1;
  document.getElementById("dcFrom").value = distributionConfig.from ?? -1;
  document.getElementById("dcTo").value = distributionConfig.to ?? 1;

  const fractionsConfig = (type === "fractions" ? nextApp : buildDefaultInteractiveApp("fractions")).config;
  document.getElementById("fxOperation").value = normalizeFractionOperation(fractionsConfig.operation);
  document.getElementById("fxNumeratorA").value = Number.isFinite(Number(fractionsConfig.fractionA && fractionsConfig.fractionA.numerator)) ? String(fractionsConfig.fractionA.numerator) : "1";
  document.getElementById("fxDenominatorA").value = Number.isFinite(Number(fractionsConfig.fractionA && fractionsConfig.fractionA.denominator)) && Number(fractionsConfig.fractionA.denominator) !== 0 ? String(fractionsConfig.fractionA.denominator) : "2";
  document.getElementById("fxNumeratorB").value = Number.isFinite(Number(fractionsConfig.fractionB && fractionsConfig.fractionB.numerator)) ? String(fractionsConfig.fractionB.numerator) : "1";
  document.getElementById("fxDenominatorB").value = Number.isFinite(Number(fractionsConfig.fractionB && fractionsConfig.fractionB.denominator)) && Number(fractionsConfig.fractionB.denominator) !== 0 ? String(fractionsConfig.fractionB.denominator) : "3";

  const networkConfig = (type === "network-graph" ? nextApp : buildDefaultInteractiveApp("network-graph")).config;
  document.getElementById("ngTitle").value = networkConfig.title || "Shortest Path, MST, Flow";
  document.getElementById("ngNodes").value = Array.isArray(networkConfig.nodes) ? networkConfig.nodes.join(", ") : "";
  document.getElementById("ngEdges").value = serializeNetworkEdges(networkConfig.edges || []);
  document.getElementById("ngSource").value = networkConfig.source || "";
  document.getElementById("ngTarget").value = networkConfig.target || "";
  document.getElementById("ngFlowSource").value = networkConfig.flowSource || "";
  document.getElementById("ngFlowSink").value = networkConfig.flowSink || "";

  const matrixConfig = (type === "matrix" ? nextApp : buildDefaultInteractiveApp("matrix")).config;
  document.getElementById("mxTitle").value = matrixConfig.title || "Matrix Operations";
  document.getElementById("mxOperation").value = normalizeMatrixOperation(matrixConfig.operation);
  document.getElementById("mxMatrixA").value = serializeMatrixRows(matrixConfig.matrixA || []);
  document.getElementById("mxMatrixB").value = serializeMatrixRows(matrixConfig.matrixB || []);

  const stemLeafConfig = (type === "stem-and-leaf" ? nextApp : buildDefaultInteractiveApp("stem-and-leaf")).config;
  document.getElementById("slValues").value = Array.isArray(stemLeafConfig.values) ? stemLeafConfig.values.join(", ") : "";
  document.getElementById("slStemUnit").value = stemLeafConfig.stemUnit ?? 10;

  const geometryConfig = (type === "geometry-shapes" ? nextApp : buildDefaultInteractiveApp("geometry-shapes")).config;
  document.getElementById("geoCanvasWidth").value = geometryConfig.canvasWidth ?? 360;
  document.getElementById("geoCanvasHeight").value = geometryConfig.canvasHeight ?? 260;
  document.getElementById("geoUnit").value = geometryConfig.unit || "unit";
  document.getElementById("geoFormulaNotation").value = geometryConfig.formulaNotation || "plain";
  document.getElementById("geoShapesInput").value = serializeGeometryShapes(geometryConfig.shapes || []);

  const pythagorasConfig = (type === "pythagoras" ? nextApp : buildDefaultInteractiveApp("pythagoras")).config;
  document.getElementById("pySideA").value = pythagorasConfig.sideA ?? "";
  document.getElementById("pySideB").value = pythagorasConfig.sideB ?? "";
  document.getElementById("pySideC").value = pythagorasConfig.sideC ?? "";
  document.getElementById("pyCaption").value = pythagorasConfig.caption ?? "";

  const trigonometryConfig = (type === "trigonometry" ? nextApp : buildDefaultInteractiveApp("trigonometry")).config;
  document.getElementById("trigAngleDeg").value = trigonometryConfig.angleDeg ?? 35;
  document.getElementById("trigFunction").value = trigonometryConfig.focusFunction || "sin";
  document.getElementById("trigOpposite").value = trigonometryConfig.opposite ?? "";
  document.getElementById("trigAdjacent").value = trigonometryConfig.adjacent ?? "";
  document.getElementById("trigHypotenuse").value = trigonometryConfig.hypotenuse ?? "";

  renderInteractiveAppPreview(nextApp);
}

// ── End Interactive App helpers ────────────────────────────────────────────

function refreshCorrectAnswerSelect(question) {
  const select = document.getElementById("correctAnswerSelect");
  const textInput = document.getElementById("correctAnswer");
  const checkboxWrap = document.getElementById("correctAnswerCheckboxWrap");
  const hint = document.getElementById("correctAnswerHint");
  const isCartesianPlotQuestion = Boolean(
    question
    && question.interactiveApp
    && question.interactiveApp.type === "cartesian-plane-plot"
  );

  if (isCartesianPlotQuestion) {
    select.style.display = "none";
    textInput.style.display = "none";
    checkboxWrap.style.display = "none";
    checkboxWrap.innerHTML = "";
    hint.textContent = "Not required for Cartesian Plane - Plot. Grading uses the Answer Points list.";
    return;
  }

  const resultType = question ? getEditorResultType(question) : "multiple-choice";
  const choiceOptions = getChoiceOptions(question);

  const useSelect = ["multiple-choice", "true-false"].includes(resultType);
  const useCheckboxPicker = resultType === "checkbox";
  select.style.display = useSelect ? "block" : "none";
  textInput.style.display = (!useSelect && !useCheckboxPicker) ? "block" : "none";
  checkboxWrap.style.display = useCheckboxPicker ? "block" : "none";

  if (resultType === "short-answer") {
    hint.textContent = "Enter the expected answer text.";
  } else if (resultType === "date") {
    hint.textContent = "Enter date as DD/MM/YYYY.";
  } else if (resultType === "plot") {
    hint.textContent = "Use this for plotting tasks. For Cartesian Plane - Plot, grading uses answer points.";
  } else if (resultType === "checkbox") {
    hint.textContent = "Choose one or more correct options.";
  } else {
    hint.textContent = "Choose the correct option from the list.";
  }

  if (useCheckboxPicker) {
    checkboxWrap.innerHTML = "";

    if (choiceOptions.length === 0) {
      checkboxWrap.innerHTML = "<p class='checkbox-answer-empty'>Add options to select correct answers.</p>";
      return;
    }

    const existingAnswers = String(question.correctAnswer || "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "")
      .map(normalizeText);

    const list = document.createElement("div");
    list.className = "checkbox-answer-list";

    choiceOptions.forEach((optionText, index) => {
      const isSelected = existingAnswers.includes(normalizeText(optionText));
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `checkbox-answer-item${isSelected ? " selected" : ""}`;
      btn.dataset.role = "correct-answer-check";
      btn.dataset.index = String(index);
      btn.dataset.value = optionText;
      btn.setAttribute("aria-pressed", isSelected ? "true" : "false");
      btn.textContent = optionText;
      btn.addEventListener("click", () => {
        const pressed = btn.getAttribute("aria-pressed") === "true";
        btn.setAttribute("aria-pressed", pressed ? "false" : "true");
        btn.classList.toggle("selected", !pressed);
        updateQuestionFromForm();
      });
      list.appendChild(btn);
    });

    checkboxWrap.appendChild(list);
  }

  if (!useSelect) {
    return;
  }

  select.innerHTML = "";
  if (choiceOptions.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No options available";
    select.appendChild(option);
    select.value = "";
    return;
  }

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select correct option";
  select.appendChild(placeholder);

  choiceOptions.forEach((item, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = item;
    select.appendChild(option);
  });

  const selectedIndex = choiceOptions.findIndex((item) => normalizeText(item) === normalizeText(question.correctAnswer));
  select.value = selectedIndex >= 0 ? String(selectedIndex) : "";
}

function updateNotesPreview(attachments) {
  const button = document.getElementById("notesBtn");
  const preview = document.getElementById("notesPreview");
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length === 0) {
    button.textContent = "Notes: N/A";
    preview.textContent = "n/a";
    return;
  }

  const parts = splitNotesAttachments(list);
  const chunks = [];
  if (parts.youtube) {
    chunks.push("YouTube: attached");
  }
  if (parts.pdf.length > 0) {
    const embeddedCount = parts.pdf.filter((item) => item.startsWith("data:")).length;
    const linkedCount = parts.pdf.length - embeddedCount;
    if (embeddedCount > 0) {
      chunks.push(`PDF embedded: ${embeddedCount}`);
    }
    if (linkedCount > 0) {
      chunks.push(`PDF linked: ${linkedCount}`);
    }
  }
  if (parts.other.length > 0) {
    chunks.push(`Other links: ${parts.other.length}`);
  }

  button.textContent = `Notes: ${list.length} attachment(s)`;
  preview.textContent = chunks.join(" | ") || "n/a";
}

function updateSolutionAttachmentsPreview(attachments) {
  const button = document.getElementById("solutionAssetsBtn");
  const preview = document.getElementById("solutionAttachmentsPreview");
  const normalized = normalizeSolutionAttachments(attachments);
  if (normalized.length === 0) {
    button.textContent = "Solution Files: N/A";
    preview.textContent = "n/a";
    return;
  }

  button.textContent = `Solution Files: ${normalized.length} attachment(s)`;
  preview.textContent = normalized.map((item) => item.name).join(" | ");
}

function renderEditor() {
  const hint = document.getElementById("editorHint");
  const selectedQuestionSummary = document.getElementById("selectedQuestionSummary");
  const editorContent = document.getElementById("questionEditorContent");
  const editorEmptyState = document.getElementById("questionEditorEmptyState");
  const metadataSummary = document.getElementById("questionMetadataSummary");
  const question = activeQuestion();
  const quiz = activeQuiz();
  const attachImageBtn = document.getElementById("attachImageBtn");
  const imageAttachHint = document.getElementById("imageAttachHint");
  const attachSolutionFileBtn = document.getElementById("attachSolutionFileBtn");
  const solutionAttachHint = document.getElementById("solutionAttachHint");
  const attachNotesPdfBtn = document.getElementById("attachNotesPdfBtn");
  const notesPdfHint = document.getElementById("notesPdfHint");

  if (editorContent) {
    editorContent.classList.toggle("hidden", !quiz);
  }
  if (editorEmptyState) {
    editorEmptyState.classList.toggle("hidden", Boolean(quiz));
    editorEmptyState.textContent = quiz
      ? ""
      : "Select or create a category and quiz to edit questions.";
  }

  if (!question) {
    hint.textContent = quiz ? "Preparing question editor..." : "Select a question to edit details.";
    if (selectedQuestionSummary) {
      selectedQuestionSummary.textContent = "No question selected.";
    }
    document.getElementById("questionText").value = "";
    document.getElementById("questionCategory").value = "";
    document.getElementById("questionSubcategory").value = "";
    document.getElementById("questionLearningOutcome").value = "";
    document.getElementById("resultType").value = "multiple-choice";
    document.getElementById("option1").value = "";
    document.getElementById("option2").value = "";
    document.getElementById("option3").value = "";
    document.getElementById("option4").value = "";
    document.getElementById("correctAnswer").value = "";
    document.getElementById("correctAnswerSelect").innerHTML = "";
    document.getElementById("correctAnswerCheckboxWrap").innerHTML = "";
    document.getElementById("attachmentsInput").value = "";
    document.getElementById("notesYoutubeInput").value = "";
    document.getElementById("notesPdfUrlsInput").value = "";
    document.getElementById("questionImage").value = "";
    document.getElementById("solutionText").value = "";
    document.getElementById("solutionAttachmentsInput").value = "";
    updateImagePreview("");
    attachImageBtn.disabled = true;
    attachSolutionFileBtn.disabled = true;
    attachNotesPdfBtn.disabled = true;
    imageAttachHint.textContent = "Select a question first to attach an image.";
    solutionAttachHint.textContent = "Select a question first to attach solution files.";
    notesPdfHint.textContent = "Select a question first to attach notes PDF.";
    updateNotesPreview([]);
    updateSolutionAttachmentsPreview([]);
    if (metadataSummary) {
      metadataSummary.textContent = "Metadata is detected from the selected question and interactive app.";
    }
    toggleOptionsBlock({ resultType: "multiple-choice" });
    refreshCorrectAnswerSelect({ resultType: "multiple-choice", options: ["", "", "", ""], correctAnswer: "" });
    renderValidationBox(null);
    populateInteractiveAppForm(null);
    return;
  }

  const questionLabel = String(question.question || "").trim() || `Untitled Question ${state.selectedQuestionIndex + 1}`;
  hint.textContent = `Editing question ${state.selectedQuestionIndex + 1}`;
  if (selectedQuestionSummary) {
    selectedQuestionSummary.textContent = `Selected: ${questionLabel}`;
  }
  const detectedMetadata = applyDetectedQuestionMetadata(question);
  ensureTrueFalseOptions(question);
  document.getElementById("questionText").value = question.question || "";
  document.getElementById("questionCategory").value = question.category || "";
  document.getElementById("questionSubcategory").value = question.subcategory || "";
  document.getElementById("questionLearningOutcome").value = question.learningOutcome || "";
  document.getElementById("resultType").value = getEditorResultType(question) || "multiple-choice";
  document.getElementById("option1").value = question.options[0] || "";
  document.getElementById("option2").value = question.options[1] || "";
  document.getElementById("option3").value = question.options[2] || "";
  document.getElementById("option4").value = question.options[3] || "";
  document.getElementById("correctAnswer").value = question.correctAnswer || "";
  document.getElementById("correctAnswerSelect").innerHTML = "";
  document.getElementById("correctAnswerCheckboxWrap").innerHTML = "";
  const notesParts = splitNotesAttachments(question.notesAttachments || []);
  document.getElementById("attachmentsInput").value = serializeManualNotesAttachments(question.notesAttachments || []);
  document.getElementById("notesYoutubeInput").value = notesParts.youtube;
  document.getElementById("notesPdfUrlsInput").value = notesParts.pdf.filter((item) => !item.startsWith("data:")).join("\n");
  document.getElementById("questionImage").value = question.image || "";
  document.getElementById("solutionText").value = question.solution || "";
  document.getElementById("solutionAttachmentsInput").value = serializeManualSolutionAttachments(question.solutionAttachments || []);
  updateImagePreview(question.image || "");
  attachImageBtn.disabled = false;
  attachSolutionFileBtn.disabled = false;
  attachNotesPdfBtn.disabled = false;
  imageAttachHint.textContent = "Attach image for the selected question, or paste a URL above.";
  solutionAttachHint.textContent = "Add links above, or attach local files to embed them in the quiz JSON.";
  notesPdfHint.textContent = notesParts.pdf.length > 0
    ? `${notesParts.pdf.length} PDF attachment(s) for this question.`
    : "Paste PDF URLs above or attach PDF files to embed them in quiz JSON.";
  updateNotesPreview(question.notesAttachments || []);
  updateSolutionAttachmentsPreview(question.solutionAttachments || []);
  if (metadataSummary) {
    const lines = [
      `Detected from: ${detectedMetadata.appTypeLabel || "Text question"}`,
      `Category: ${question.category || detectedMetadata.category || "N/A"}`,
      `Subcategory: ${question.subcategory || detectedMetadata.subcategory || "N/A"}`,
      `Learning Outcome: ${question.learningOutcome || detectedMetadata.learningOutcome || "N/A"}`
    ];
    metadataSummary.textContent = lines.join(" | ");
  }
  toggleOptionsBlock(question);
  refreshCorrectAnswerSelect(question);
  renderValidationBox(question);
  populateInteractiveAppForm(question.interactiveApp || null);
}

function getQuizData() {
  const selectedQuiz = activeQuiz();
  const category = activeCategory();
  const selectedQuestions = selectedQuiz
    ? selectedQuiz.questions.map((item) => {
      const q = {
        question: item.question || "",
        resultType: item.resultType || "multiple-choice",
        options: Array.isArray(item.options) ? item.options : ["", "", "", ""],
        correctAnswer: item.correctAnswer || "",
        category: item.category || "",
        subcategory: item.subcategory || "",
        learningOutcome: item.learningOutcome || "",
        notesAttachments: Array.isArray(item.notesAttachments) ? item.notesAttachments : [],
        image: item.image || "",
        solution: item.solution || "",
        solutionAttachments: normalizeSolutionAttachments(item.solutionAttachments)
      };
      if (item.interactiveApp) q.interactiveApp = item.interactiveApp;
      return q;
    })
    : [];

  return {
    id: selectedQuiz ? selectedQuiz.id : "",
    title: selectedQuiz ? selectedQuiz.title : "Untitled Quiz",
    description: selectedQuiz ? normalizeQuizDescription(selectedQuiz.description) : "",
    settings: selectedQuiz ? normalizeQuizSettings(selectedQuiz.settings) : normalizeQuizSettings(null),
    fileName: selectedQuiz ? getSelectedQuizFileName() : "quiz.json",
    sourcePath: selectedQuiz ? (selectedQuiz.sourcePath || "") : "",
    category: category ? category.name : "General",
    questions: selectedQuestions
  };
}

function updateGeneratedJson() {
  document.getElementById("generatedJson").value = JSON.stringify(getQuizData(), null, 2);
  document.getElementById("quizFileName").value = getSelectedQuizFileName();

  const rootInput = document.getElementById("quizRootFolder");
  if (rootInput) {
    rootInput.value = state.rootFolder;
  }

  const rootSourceModeInput = document.getElementById("rootSourceMode");
  if (rootSourceModeInput) {
    rootSourceModeInput.value = normalizeRootSourceMode(state.rootSourceMode);
  }
}

function renderAll() {
  ensureSelection();
  renderQuizScanToggle();
  renderCategoryList();
  renderQuizList();
  renderQuestionsList();
  renderEditor();
  updateGeneratedJson();
  updateEmbedOutputForActiveQuiz();
  saveDraft();
}

async function addCategory() {
  const name = prompt("Category name:", `Category ${state.categories.length + 1}`);
  if (!name || !name.trim()) return;

  const category = createCategory(name.trim());
  const quiz = createQuiz("New Quiz");
  quiz.questions.push(createEmptyQuestion());
  category.quizzes.push(quiz);
  state.categories.push(category);
  state.selectedCategoryId = category.id;
  state.selectedQuizId = category.quizzes[0].id;
  state.selectedQuestionIndex = 0;
  renderAll();

  await createCategoryFolderOnDisk(category);
  await createStarterQuizFileOnDisk(category, quiz);
  renderAll();
}

async function addQuiz() {
  const category = activeCategory();
  if (!category) {
    showToast("Create a category first.", "warning");
    return;
  }

  const title = prompt("Quiz title:", `Quiz ${category.quizzes.length + 1}`);
  if (!title || !title.trim()) return;

  const quiz = createQuiz(title.trim());
  ensureQuizHasDefaultQuestion(quiz);
  category.quizzes.push(quiz);
  state.selectedQuizId = quiz.id;
  state.selectedQuestionIndex = 0;
  renderAll();

  await createCategoryFolderOnDisk(category);
  await createStarterQuizFileOnDisk(category, quiz);
  renderAll();
}

function replicateQuiz(id) {
  const category = activeCategory();
  if (!category) return;

  const sourceIndex = category.quizzes.findIndex((item) => item.id === id);
  if (sourceIndex === -1) return;
  const source = category.quizzes[sourceIndex];

  const newId = `quiz-${quizSeed++}`;
  const newTitle = source.title + " (Copy)";
  const newFileName = buildUniqueQuizFileName(newTitle, newId);

  const copy = {
    id: newId,
    title: newTitle,
    description: source.description || "",
    settings: JSON.parse(JSON.stringify(source.settings || normalizeQuizSettings(null))),
    fileName: newFileName,
    sourcePath: "",
    questions: JSON.parse(JSON.stringify(source.questions || []))
  };

  category.quizzes.splice(sourceIndex + 1, 0, copy);
  state.selectedQuizId = newId;

  renderAll();
  showToast(`Quiz replicated as "${newTitle}".`, "success");
}

function openQuizSettingsModal(quizId = state.selectedQuizId) {
  const category = activeCategory();
  if (!category) {
    showToast("Select a category first.", "warning");
    return;
  }

  const quiz = category.quizzes.find((item) => item.id === quizId);
  if (!quiz) {
    showToast("Select a quiz first.", "warning");
    return;
  }

  const modal = document.getElementById("quizSettingsModal");
  if (!(modal instanceof HTMLElement)) return;

  modal.dataset.quizId = quiz.id;
  document.getElementById("quizSettingsTitle").value = quiz.title || "";
  document.getElementById("quizSettingsDescription").value = normalizeQuizDescription(quiz.description);

  const normalizedSettings = normalizeQuizSettings(quiz.settings);
  document.getElementById("quizSettingsOrder").value = normalizedSettings.questionOrder;
  document.getElementById("quizSettingsLimit").value = normalizedSettings.questionLimit ? String(normalizedSettings.questionLimit) : "";

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function closeQuizSettingsModal() {
  const modal = document.getElementById("quizSettingsModal");
  if (!(modal instanceof HTMLElement)) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  modal.dataset.quizId = "";
  document.body.classList.remove("modal-open");
}

function openImportModal() {
  const modal = document.getElementById("importModal");
  if (!(modal instanceof HTMLElement)) return;
  setImportModalFullscreen(false);
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function closeImportModal() {
  const modal = document.getElementById("importModal");
  if (!(modal instanceof HTMLElement)) return;
  setImportModalFullscreen(false);
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

function setImportModalFullscreen(enabled) {
  const modal = document.getElementById("importModal");
  const toggleBtn = document.getElementById("toggleImportFullscreenBtn");
  if (!(modal instanceof HTMLElement) || !(toggleBtn instanceof HTMLButtonElement)) return;

  const next = Boolean(enabled);
  modal.classList.toggle("import-fullscreen", next);
  toggleBtn.textContent = next ? "Exit Full Screen" : "Full Screen";
  toggleBtn.setAttribute("aria-pressed", next ? "true" : "false");
}

function toggleImportModalFullscreen() {
  const modal = document.getElementById("importModal");
  if (!(modal instanceof HTMLElement)) return;
  const active = modal.classList.contains("import-fullscreen");
  setImportModalFullscreen(!active);
}

function setResultValidationFullscreen(enabled) {
  const modal = document.getElementById("resultValidationModal");
  const toggleBtn = document.getElementById("toggleResultValidationFullscreenBtn");
  if (!(modal instanceof HTMLElement) || !(toggleBtn instanceof HTMLButtonElement)) return;

  const next = Boolean(enabled);
  modal.classList.toggle("result-validation-fullscreen", next);
  toggleBtn.textContent = next ? "Exit Full Screen" : "Full Screen";
  toggleBtn.setAttribute("aria-pressed", next ? "true" : "false");
  window.requestAnimationFrame(() => {
    refreshResultValidationFullscreenLayout();
  });
}

function toggleResultValidationFullscreen() {
  const modal = document.getElementById("resultValidationModal");
  if (!(modal instanceof HTMLElement)) return;
  const active = modal.classList.contains("result-validation-fullscreen");
  setResultValidationFullscreen(!active);
}

function refreshResultValidationFullscreenLayout() {
  const modal = document.getElementById("resultValidationModal");
  const dialog = modal ? modal.querySelector(".viewer-modal-dialog") : null;
  const tableContainer = document.getElementById("resultValidationTableContainer");
  const detailGrid = document.getElementById("resultValidationDetailGrid");
  if (!(modal instanceof HTMLElement)
    || !(dialog instanceof HTMLElement)
    || !(tableContainer instanceof HTMLElement)
    || !(detailGrid instanceof HTMLElement)) {
    return;
  }

  const inFullscreen = modal.classList.contains("result-validation-fullscreen") && !modal.classList.contains("hidden");
  if (!inFullscreen) {
    const defaultMaxHeight = String(tableContainer.dataset.normalMaxHeight || "520px");
    tableContainer.style.height = "";
    tableContainer.style.maxHeight = defaultMaxHeight;
    detailGrid.style.height = "";
    return;
  }

  const dialogRect = dialog.getBoundingClientRect();
  const tableTop = tableContainer.getBoundingClientRect().top;
  const tip = document.getElementById("resultValidationTip");
  const tipHeight = tip instanceof HTMLElement ? tip.getBoundingClientRect().height : 0;
  const tableBottomPadding = 14;
  const maxTableHeight = Math.max(240, Math.floor(dialogRect.bottom - tableTop - tipHeight - tableBottomPadding));
  tableContainer.style.height = `${maxTableHeight}px`;
  tableContainer.style.maxHeight = `${maxTableHeight}px`;

  const detailTop = detailGrid.getBoundingClientRect().top;
  const detailBottomPadding = 12;
  const maxDetailHeight = Math.max(220, Math.floor(dialogRect.bottom - detailTop - detailBottomPadding));
  detailGrid.style.height = `${maxDetailHeight}px`;
}

function setupResultValidationTableContainerScrollControls() {
  const modal = document.getElementById("resultValidationModal");
  const tableContainer = document.getElementById("resultValidationTableContainer");
  if (!(modal instanceof HTMLElement) || !(tableContainer instanceof HTMLElement)) return;

  tableContainer.addEventListener("wheel", (event) => {
    if (!modal.classList.contains("result-validation-fullscreen")) return;
    const canScroll = tableContainer.scrollHeight > tableContainer.clientHeight;
    if (!canScroll) return;
    event.preventDefault();
    tableContainer.scrollTop += event.deltaY;
  }, { passive: false });

  tableContainer.addEventListener("keydown", (event) => {
    if (!modal.classList.contains("result-validation-fullscreen")) return;
    const page = Math.max(120, Math.floor(tableContainer.clientHeight * 0.85));
    if (event.key === "PageDown") {
      event.preventDefault();
      tableContainer.scrollTop += page;
      return;
    }
    if (event.key === "PageUp") {
      event.preventDefault();
      tableContainer.scrollTop -= page;
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      tableContainer.scrollTop = 0;
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      tableContainer.scrollTop = tableContainer.scrollHeight;
    }
  });
}

function openResultValidationModal() {
  const quiz = activeQuiz();
  if (!quiz) {
    showToast("Select a module (quiz) first.", "warning");
    return;
  }

  const modal = document.getElementById("resultValidationModal");
  if (!(modal instanceof HTMLElement)) return;
  setResultValidationFullscreen(false);
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  window.requestAnimationFrame(() => {
    refreshResultValidationFullscreenLayout();
  });
}

function closeResultValidationModal() {
  const modal = document.getElementById("resultValidationModal");
  if (!(modal instanceof HTMLElement)) return;
  setResultValidationFullscreen(false);
  refreshResultValidationFullscreenLayout();
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

function saveQuizSettingsFromModal() {
  const modal = document.getElementById("quizSettingsModal");
  if (!(modal instanceof HTMLElement)) return;

  const quizId = String(modal.dataset.quizId || "");
  if (!quizId) return;

  const category = activeCategory();
  if (!category) return;

  const quiz = category.quizzes.find((item) => item.id === quizId);
  if (!quiz) return;

  const nextTitleRaw = document.getElementById("quizSettingsTitle").value.trim();
  if (!nextTitleRaw) {
    showToast("Quiz name is required.", "warning");
    return;
  }

  quiz.title = nextTitleRaw;
  quiz.description = normalizeQuizDescription(document.getElementById("quizSettingsDescription").value);
  quiz.settings = normalizeQuizSettings({
    questionOrder: document.getElementById("quizSettingsOrder").value,
    questionLimit: document.getElementById("quizSettingsLimit").value
  });

  renderAll();
  closeQuizSettingsModal();
  
  // Persist settings to disk
  persistSelectedQuizAfterMutation("Quiz settings updated");
  showToast("Quiz settings saved.", "success");
}

async function addQuestion() {
  const quiz = activeQuiz();
  if (!quiz) {
    showToast("Create a quiz first.", "warning");
    return;
  }

  quiz.questions.push(createEmptyQuestion());
  state.selectedQuestionIndex = quiz.questions.length - 1;
  renderAll();
  await persistSelectedQuizAfterMutation("Question list");
}

function requireDeletePhrase(scopeLabel) {
  const typed = prompt(`To delete this ${scopeLabel}, type DELETE in uppercase:`);
  if (typed === "DELETE") {
    return true;
  }

  if (typed === null) {
    showToast("Delete canceled.", "info");
  } else {
    showToast("Delete blocked. Type DELETE exactly.", "warning");
  }

  return false;
}

function requireActionPassword(scopeLabel, expectedPhrase) {
  const typed = prompt(`To clear this ${scopeLabel}, enter password: ${expectedPhrase}`);
  if (typed === expectedPhrase) {
    return true;
  }

  if (typed === null) {
    showToast("Action canceled.", "info");
  } else {
    showToast("Action blocked. Incorrect password.", "warning");
  }

  return false;
}

async function deleteCategory(id) {
  if (!requireDeletePhrase("category")) return;

  const index = state.categories.findIndex((item) => item.id === id);
  if (index === -1) return;
  const category = state.categories[index];
  state.categories.splice(index, 1);
  showToast("Category deleted.", "info");
  renderAll();

  await deleteCategoryFolderFromDisk(category);
}

async function deleteQuizFileFromDisk(quiz, category) {
  if (normalizeRootSourceMode(state.rootSourceMode) !== ROOT_SOURCE_MODES.LOCAL) {
    return;
  }

  if (!supportsFolderDeletion()) {
    showToast("Quiz removed in app. Browser cannot auto-delete local files here.", "warning");
    return;
  }

  if (!quiz || !category) {
    return;
  }

  try {
    const configuredRoot = await getConfiguredRootHandle({ create: false, allowPrompt: false });
    if (!configuredRoot) {
      showToast("Quiz removed. Connect root folder to delete file on disk.", "warning");
      return;
    }

    const relativePath = await resolveWritableQuizRelativePath(configuredRoot, quiz, category);
    const parts = String(relativePath || "").split("/").filter((item) => item !== "");
    if (parts.length < 2) {
      showToast("Quiz removed. Could not resolve quiz file path on disk.", "warning");
      return;
    }

    const fileName = parts.pop();
    let directoryHandle = configuredRoot;
    for (const segment of parts) {
      directoryHandle = await directoryHandle.getDirectoryHandle(segment, { create: false });
    }

    await directoryHandle.removeEntry(fileName);
    showToast(`Quiz file deleted: ${relativePath}`, "success");
  } catch (error) {
    if (error && error.name === "NotFoundError") {
      showToast("Quiz removed. File not found on disk.", "info");
      return;
    }

    if (error && error.name === "AbortError") {
      showToast("Quiz removed. File delete canceled.", "info");
      return;
    }

    showToast("Quiz removed. Could not delete quiz file on disk.", "warning");
  }
}

async function deleteQuiz(id) {
  if (!requireDeletePhrase("quiz")) return;

  const category = activeCategory();
  if (!category) return;
  const index = category.quizzes.findIndex((item) => item.id === id);
  if (index === -1) return;
  const quiz = category.quizzes[index];
  category.quizzes.splice(index, 1);
  showToast("Quiz deleted.", "info");
  renderAll();

  await deleteQuizFileFromDisk(quiz, category);
}

async function deleteQuestion(index) {
  const quiz = activeQuiz();
  if (!quiz || index < 0 || index >= quiz.questions.length) return;
  quiz.questions.splice(index, 1);
  renderAll();
  await persistSelectedQuizAfterMutation("Question list");
}

async function clearQuizQuestions() {
  const quiz = activeQuiz();
  if (!quiz || !Array.isArray(quiz.questions)) {
    showToast("Select a quiz first.", "warning");
    return;
  }

  if (quiz.questions.length === 0) {
    showToast("This quiz has no questions to clear.", "info");
    return;
  }

  if (!requireActionPassword("all questions in this quiz", "CLEAR")) {
    return;
  }

  quiz.questions = [createEmptyQuestion()];
  state.selectedQuestionIndex = 0;
  renderAll();
  await persistSelectedQuizAfterMutation("Quiz questions cleared");
  showToast("All questions were cleared for this quiz.", "success");
}

function scheduleSilentDiskSave(delayMs = 700) {
  if (normalizeRootSourceMode(state.rootSourceMode) !== ROOT_SOURCE_MODES.LOCAL) {
    return;
  }
  if (!supportsFolderDeletion()) {
    return;
  }

  if (silentSaveTimer) {
    window.clearTimeout(silentSaveTimer);
  }

  silentSaveTimer = window.setTimeout(async () => {
    silentSaveTimer = null;
    await writeSelectedQuizToDisk({ allowPrompt: false, notify: false });
  }, Math.max(100, Number(delayMs) || 700));
}

function updateQuestionFromForm() {
  const question = activeQuestion();
  if (!question) return;

  const previousNotesParts = splitNotesAttachments(question.notesAttachments || []);

  question.question = document.getElementById("questionText").value.trim();
  question.category = document.getElementById("questionCategory").value.trim();
  question.subcategory = document.getElementById("questionSubcategory").value.trim();
  question.learningOutcome = document.getElementById("questionLearningOutcome").value.trim();
  question.resultType = normalizeResultType(document.getElementById("resultType").value);
  question.options = [
    document.getElementById("option1").value.trim(),
    document.getElementById("option2").value.trim(),
    document.getElementById("option3").value.trim(),
    document.getElementById("option4").value.trim()
  ];

  if (question.resultType === "true-false") {
    ensureTrueFalseOptions(question);
  }

  if (["multiple-choice", "true-false"].includes(question.resultType)) {
    const select = document.getElementById("correctAnswerSelect");
    const selectedIndexFromUi = Number.parseInt(select.value, 10);

    ensureDefaultCorrectAnswer(question);
    const choiceOptions = getChoiceOptions(question);
    if (Number.isInteger(selectedIndexFromUi) && selectedIndexFromUi >= 0 && selectedIndexFromUi < choiceOptions.length) {
      question.correctAnswer = choiceOptions[selectedIndexFromUi];
    } else {
      const existingIndex = choiceOptions.findIndex((item) => normalizeText(item) === normalizeText(question.correctAnswer));
      question.correctAnswer = existingIndex >= 0 ? choiceOptions[existingIndex] : "";
    }
  } else if (question.resultType === "checkbox") {
    const choiceOptions = getChoiceOptions(question);
    const currentChecked = Array.from(document.querySelectorAll("button[data-role='correct-answer-check'][aria-pressed='true']"))
      .map((item) => String(item.dataset.value || "").trim())
      .filter((item) => item !== "");
    const fallbackChecked = String(question.correctAnswer || "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "")
      .filter((answer) => choiceOptions.some((option) => normalizeText(option) === normalizeText(answer)));
    const nextChecked = currentChecked.length > 0 ? currentChecked : fallbackChecked;
    question.correctAnswer = nextChecked.join(", ");
  } else {
    question.correctAnswer = document.getElementById("correctAnswer").value.trim();
  }

  refreshCorrectAnswerSelect(question);

  const manualNoteLinks = document.getElementById("attachmentsInput").value
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  const manualParts = splitNotesAttachments(manualNoteLinks);
  const youtubeFromField = normalizeYoutubeUrl(document.getElementById("notesYoutubeInput").value);
  const pdfFromField = parsePdfUrlLines(document.getElementById("notesPdfUrlsInput").value);
  const previousEmbeddedPdf = previousNotesParts.pdf.filter((item) => item.startsWith("data:"));
  const nextNotesParts = {
    youtube: youtubeFromField || manualParts.youtube,
    pdf: mergeUniqueNotesAttachments([...pdfFromField, ...manualParts.pdf, ...previousEmbeddedPdf]),
    other: manualParts.other
  };
  question.notesAttachments = buildNotesAttachments(nextNotesParts);
  document.getElementById("attachmentsInput").value = nextNotesParts.other.join("\n");
  document.getElementById("notesYoutubeInput").value = nextNotesParts.youtube;
  document.getElementById("notesPdfUrlsInput").value = nextNotesParts.pdf.filter((item) => !item.startsWith("data:")).join("\n");
  question.image = document.getElementById("questionImage").value.trim();
  question.solution = document.getElementById("solutionText").value.trim();
  question.solutionAttachments = [
    ...parseSolutionAttachmentLines(document.getElementById("solutionAttachmentsInput").value),
    ...normalizeSolutionAttachments(question.solutionAttachments).filter((item) => item.embedded)
  ];
  question.interactiveApp = readInteractiveAppFromForm();
  applyDetectedQuestionMetadata(question);
  document.getElementById("resultType").value = getEditorResultType(question) || "multiple-choice";

  if (question.interactiveApp && question.interactiveApp.type === "time") {
    const timeMode = normalizeTimeMode(question.interactiveApp.config && question.interactiveApp.config.mode);
    const timeConfig = question.interactiveApp.config || {};
    const timeFocus = normalizeTimeFocus(timeConfig.timeFocus);
    const allowCustomAnswer = Boolean(timeConfig.allowCustomAnswer);
    const digitalChallenge = normalizeTimeDigitalChallenge(timeConfig.digitalChallenge);
    const targetHour = normalizeTimeHour(timeConfig.hour);
    const targetMinuteRaw = normalizeTimeMinute(timeConfig.minute);
    const targetMinute = timeFocus === "hour-only" ? 0 : targetMinuteRaw;
    question.interactiveApp.config.timeFocus = timeFocus;
    question.interactiveApp.config.minute = targetMinute;
    const minuteInput = document.getElementById("timeMinute");
    if (minuteInput instanceof HTMLInputElement && timeFocus === "hour-only") {
      minuteInput.value = "0";
    }
    let targetPeriod = normalizeTimePeriod(timeConfig.period);
    if (timeMode === "digital" && ["12h-to-24h", "24h-to-12h"].includes(digitalChallenge) && !targetPeriod) {
      targetPeriod = "PM";
      question.interactiveApp.config.period = targetPeriod;
      const periodSelect = document.getElementById("timePeriod");
      if (periodSelect) periodSelect.value = targetPeriod;
    }
    const targetText = formatTimeValue(targetHour, targetMinute, targetPeriod);
    const normalizedPeriodForConversion = targetPeriod || "PM";
    const autoQuestion = buildDefaultTimeQuestionByMode(timeMode, targetHour, targetMinute, targetPeriod, digitalChallenge);
    const autoSolution = buildDefaultTimeSolutionByMode(timeMode, targetHour, targetMinute, targetPeriod, digitalChallenge);
    if (!allowCustomAnswer) {
      const resultTypeSelect = document.getElementById("resultType");
      if (timeMode === "analog-to-digital") {
        question.resultType = "multiple-choice";
        if (resultTypeSelect) resultTypeSelect.value = "multiple-choice";
        const generatedOptions = buildAnalogToDigitalOptions(targetHour, targetMinute);
        question.options = generatedOptions;
        question.correctAnswer = targetText;
        document.getElementById("option1").value = generatedOptions[0] || "";
        document.getElementById("option2").value = generatedOptions[1] || "";
        document.getElementById("option3").value = generatedOptions[2] || "";
        document.getElementById("option4").value = generatedOptions[3] || "";
        document.getElementById("correctAnswer").value = question.correctAnswer;
      } else {
        question.resultType = "short-answer";
        if (resultTypeSelect) resultTypeSelect.value = "short-answer";
        if (timeMode === "digital" && digitalChallenge === "12h-to-24h") {
          question.correctAnswer = formatTime24Value(targetHour, targetMinute, normalizedPeriodForConversion);
        } else if (timeMode === "digital" && digitalChallenge === "24h-to-12h") {
          question.correctAnswer = formatTimeValue(targetHour, targetMinute, normalizedPeriodForConversion);
        } else {
          question.correctAnswer = targetText;
        }
        document.getElementById("correctAnswer").value = question.correctAnswer;
      }
    }

    const questionInput = document.getElementById("questionText");
    const solutionInput = document.getElementById("solutionText");
    const existingQuestionText = questionInput ? String(questionInput.value || "").trim() : String(question.question || "").trim();
    const existingSolutionText = solutionInput ? String(solutionInput.value || "").trim() : String(question.solution || "").trim();

    if (isLikelyDefaultTimeQuestion(existingQuestionText)) {
      question.question = autoQuestion;
      if (questionInput) {
        questionInput.value = autoQuestion;
      }
    }

    if (isLikelyDefaultTimeSolution(existingSolutionText)) {
      question.solution = autoSolution;
      if (solutionInput) {
        solutionInput.value = autoSolution;
      }
    }
  }

  toggleOptionsBlock(question);
  const metadataSummary = document.getElementById("questionMetadataSummary");
  if (metadataSummary) {
    const detected = inferQuestionMetadata(question);
    metadataSummary.textContent = [
      `Detected from: ${detected.appTypeLabel || "Text question"}`,
      `Category: ${question.category || detected.category || "N/A"}`,
      `Subcategory: ${question.subcategory || detected.subcategory || "N/A"}`,
      `Learning Outcome: ${question.learningOutcome || detected.learningOutcome || "N/A"}`
    ].join(" | ");
  }
  updateNotesPreview(question.notesAttachments);
  updateSolutionAttachmentsPreview(question.solutionAttachments);
  updateImagePreview(question.image);
  renderInteractiveAppPreview(question.interactiveApp);
  renderQuestionsList();
  renderValidationBox(question);
  updateGeneratedJson();
  saveDraft();
  scheduleSilentDiskSave();
}

function updateImagePreview(src) {
  const preview = document.getElementById("questionImagePreview");
  if (!preview) return;
  if (src) {
    preview.src = src;
    preview.classList.remove("hidden");
  } else {
    preview.src = "";
    preview.classList.add("hidden");
  }
}

function buildPersistedQuizPayloadFrom(quiz, category) {
  if (!quiz || !category) {
    return null;
  }

  return {
    id: quiz.id || slugify(quiz.title || "quiz"),
    title: quiz.title || "Untitled Quiz",
    description: normalizeQuizDescription(quiz.description),
    settings: normalizeQuizSettings(quiz.settings),
    category: category.name || "General",
    questions: (quiz.questions || []).map((item) => {
      const question = {
        question: item.question || "",
        resultType: item.resultType || "multiple-choice",
        options: Array.isArray(item.options) ? item.options : ["", "", "", ""],
        correctAnswer: item.correctAnswer || "",
        category: item.category || "",
        subcategory: item.subcategory || "",
        learningOutcome: item.learningOutcome || "",
        notesAttachments: Array.isArray(item.notesAttachments) ? item.notesAttachments : [],
        image: item.image || "",
        solution: item.solution || "",
        solutionAttachments: normalizeSolutionAttachments(item.solutionAttachments)
      };

      if (item.interactiveApp) {
        question.interactiveApp = item.interactiveApp;
      }

      return question;
    })
  };
}

function buildPersistedQuizPayload() {
  const selectedQuiz = activeQuiz();
  const category = activeCategory();
  return buildPersistedQuizPayloadFrom(selectedQuiz, category);
}

function resolveQuizRelativePath(quiz, category) {
  const rootFolder = normalizeRootFolder(state.rootFolder);
  const rawSourcePath = String(quiz.sourcePath || "").replace(/\\/g, "/");
  if (rawSourcePath) {
    const rootPrefix = `${rootFolder}/`;
    if (rawSourcePath.startsWith(rootPrefix)) {
      return rawSourcePath.slice(rootPrefix.length);
    }

    if (!rawSourcePath.includes("/")) {
      return `${slugify(category.name || "category")}/${rawSourcePath}`;
    }

    return rawSourcePath;
  }

  return `${slugify(category.name || "category")}/${normalizeQuizFileName(quiz.fileName || quiz.title || "quiz")}`;
}

function resolveManifestQuizFilePath(quiz, category) {
  const rootFolder = normalizeRootFolder(state.rootFolder);
  const rawSourcePath = String(quiz && quiz.sourcePath ? quiz.sourcePath : "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (rawSourcePath) {
    const prefix = `${rootFolder}/`;
    if (rawSourcePath.startsWith(prefix)) {
      return rawSourcePath.slice(prefix.length);
    }
    return rawSourcePath;
  }

  const fileName = normalizeQuizFileName(quiz && (quiz.fileName || quiz.title) ? (quiz.fileName || quiz.title) : "quiz");
  return `${slugify(category && category.name ? category.name : "category")}/${fileName}`;
}

function buildIndexManifestFromState() {
  const categories = Array.isArray(state.categories) ? state.categories : [];
  return {
    categories: categories.map((category) => ({
      name: String(category && category.name ? category.name : "Category"),
      quizzes: Array.isArray(category && category.quizzes)
        ? category.quizzes.map((quiz) => ({
          title: String(quiz && quiz.title ? quiz.title : "Untitled Quiz"),
          file: resolveManifestQuizFilePath(quiz, category)
        }))
        : []
    }))
  };
}

async function writeIndexManifestToDisk(rootHandle, options = {}) {
  const { notify = false } = options;
  if (!rootHandle) return false;

  try {
    const manifest = buildIndexManifestFromState();
    const indexHandle = await rootHandle.getFileHandle("index.json", { create: true });
    const writable = await indexHandle.createWritable();
    await writable.write(`${JSON.stringify(manifest, null, 2)}\n`);
    await writable.close();
    if (notify) {
      showToast("Updated index.json", "success");
    }
    return true;
  } catch (error) {
    if (notify) {
      showToast("Could not update index.json", "warning");
    }
    return false;
  }
}

async function writeSelectedQuizToDisk(options = {}) {
  const { allowPrompt = true, notify = true } = options;
  const quiz = activeQuiz();
  const category = activeCategory();
  if (!quiz || !category) {
    if (notify) {
      showToast("Select a quiz first.", "warning");
    }
    return false;
  }

  if (!supportsFolderDeletion()) {
    return false;
  }

  try {
    const configuredRoot = await getConfiguredRootHandle({
      create: true,
      allowPrompt,
      promptForPermission: allowPrompt
    });
    if (!configuredRoot) {
      return false;
    }
    return await writeQuizToDiskWithRoot(configuredRoot, quiz, category, { notify });
  } catch (error) {
    if (error && error.name === "AbortError") {
      if (notify) {
        showToast("Save canceled.", "info");
      }
      return false;
    }

    if (notify) {
      showToast("Could not save to local folder.", "warning");
    }
    return false;
  }
}

async function writeQuizToDiskWithRoot(rootHandle, quiz, category, options = {}) {
  const { notify = true, updateIndex = true } = options;
  const payload = buildPersistedQuizPayloadFrom(quiz, category);
  if (!rootHandle || !quiz || !category || !payload) {
    return false;
  }

  try {
    const relativePath = await resolveWritableQuizRelativePath(rootHandle, quiz, category);
    const parts = relativePath.split("/").filter((item) => item !== "");
    if (parts.length === 0) {
      if (notify) {
        showToast("Could not resolve save path.", "error");
      }
      return false;
    }

    const fileName = parts.pop();
    if (!fileName || !fileName.toLowerCase().endsWith(".json")) {
      if (notify) {
        showToast("Quiz file name must end with .json", "warning");
      }
      return false;
    }

    let directoryHandle = rootHandle;
    for (const segment of parts) {
      directoryHandle = await directoryHandle.getDirectoryHandle(segment, { create: true });
    }

    const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(`${JSON.stringify(payload, null, 2)}\n`);
    await writable.close();

    quiz.fileName = normalizeQuizFileName(fileName);

    const normalizedRoot = normalizeRootFolder(state.rootFolder);
    const savedRelative = [...parts, fileName].join("/");
    quiz.sourcePath = savedRelative.startsWith(`${normalizedRoot}/`)
      ? savedRelative
      : `${normalizedRoot}/${savedRelative}`;

    updateGeneratedJson();
    saveDraft();
    if (updateIndex) {
      await writeIndexManifestToDisk(rootHandle, { notify: false });
    }
    if (notify) {
      showToast(`Saved ${[...parts, fileName].join("/")}`, "success");
    }
    return true;
  } catch (error) {
    if (error && error.name === "AbortError") {
      if (notify) {
        showToast("Save canceled.", "info");
      }
      return false;
    }

    if (notify) {
      showToast("Could not save to local folder.", "warning");
    }
    return false;
  }
}

async function persistImportedQuizzesToDisk(importedTargets, allowPrompt = true) {
  if (!supportsFolderDeletion()) {
    return { total: 0, saved: 0, skipped: 0, prompted: false };
  }

  const targets = Array.isArray(importedTargets) ? importedTargets : [];
  if (targets.length === 0) {
    return { total: 0, saved: 0, skipped: 0, prompted: false };
  }

  const configuredRoot = await getConfiguredRootHandle({
    create: true,
    allowPrompt,
    promptForPermission: allowPrompt
  });
  if (!configuredRoot) {
    return null;
  }

  const uniqueKeys = new Set();
  let saved = 0;
  let skipped = 0;

  for (const item of targets) {
    const category = state.categories.find((cat) => cat && cat.id === item.categoryId);
    const quiz = category && Array.isArray(category.quizzes)
      ? category.quizzes.find((q) => q && q.id === item.quizId)
      : null;
    if (!category || !quiz) {
      skipped += 1;
      continue;
    }

    const key = `${category.id}::${quiz.id}`;
    if (uniqueKeys.has(key)) {
      continue;
    }
    uniqueKeys.add(key);

    const ok = await writeQuizToDiskWithRoot(configuredRoot, quiz, category, { notify: false });
    if (ok) {
      saved += 1;
    } else {
      skipped += 1;
    }
  }

  return {
    total: uniqueKeys.size,
    saved,
    skipped,
    prompted: Boolean(allowPrompt)
  };
}

async function persistSelectedQuizAfterMutation(scopeLabel = "Quiz") {
  const saved = await writeSelectedQuizToDisk({ allowPrompt: false, notify: false });
  if (!saved) {
    showToast(`${scopeLabel} updated in Maker but not saved to file. Click Save Quiz or Connect Root Folder.`, "warning");
  }
  return saved;
}

function downloadSelectedQuizJson() {
  if (activeQuestion()) {
    updateQuestionFromForm();
  }
  const json = JSON.stringify(getQuizData(), null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = getSelectedQuizFileName();
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

async function saveSelectedQuiz(options = {}) {
  if (activeQuestion()) {
    updateQuestionFromForm();
  }
  const { allowPrompt = true } = options;
  const saved = await writeSelectedQuizToDisk({ allowPrompt, notify: true });
  if (!saved) {
    showToast(
      allowPrompt
        ? "Save failed. Use Connect Root Folder and try again."
        : "Save failed. Connect Root Folder first, then try again.",
      "warning"
    );
  }

  return saved;
}

function moveQuestion(fromIndex, toIndex) {
  const quiz = activeQuiz();
  if (!quiz) return;
  if (fromIndex === toIndex) return;
  if (fromIndex < 0 || toIndex < 0) return;
  if (fromIndex >= quiz.questions.length || toIndex >= quiz.questions.length) return;

  const [moved] = quiz.questions.splice(fromIndex, 1);
  quiz.questions.splice(toIndex, 0, moved);
  state.selectedQuestionIndex = toIndex;
  renderAll();
}

function attachImageToQuestion(file) {
  const question = activeQuestion();
  if (!question) {
    showToast("Select a question first. Image attaches to the active question only.", "warning");
    return;
  }

  if (!file) {
    return;
  }

  if (!file.type.startsWith("image/")) {
    showToast("Please select an image file.", "warning");
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = typeof reader.result === "string" ? reader.result : "";
    if (!dataUrl) {
      showToast("Could not read image file.", "error");
      return;
    }

    document.getElementById("questionImage").value = dataUrl;
    updateQuestionFromForm();
    showToast("Image attached to question.", "success");
  };

  reader.onerror = () => {
    showToast("Could not read image file.", "error");
  };

  reader.readAsDataURL(file);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      if (!dataUrl) {
        reject(new Error("Could not read file."));
        return;
      }
      resolve(dataUrl);
    };
    reader.onerror = () => reject(new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}

async function attachSolutionFilesToQuestion(fileList) {
  const question = activeQuestion();
  if (!question) {
    showToast("Select a question first.", "warning");
    return;
  }

  const files = Array.from(fileList || []);
  if (files.length === 0) {
    return;
  }

  updateQuestionFromForm();

  try {
    const embeddedAttachments = await Promise.all(files.map(async (file) => ({
      name: file.name || "Attachment",
      url: await readFileAsDataUrl(file),
      embedded: true
    })));
    question.solutionAttachments = [
      ...normalizeSolutionAttachments(question.solutionAttachments),
      ...embeddedAttachments
    ];
    renderEditor();
    updateGeneratedJson();
    saveDraft();
    showToast(`Attached ${embeddedAttachments.length} solution file(s).`, "success");
  } catch (error) {
    showToast("Could not read solution file.", "error");
  }
}

async function attachNotesPdfToQuestion(fileList) {
  const question = activeQuestion();
  if (!question) {
    showToast("Select a question first.", "warning");
    return;
  }

  const files = Array.from(fileList || []);
  if (files.length === 0) {
    return;
  }

  const hasInvalidFile = files.some((file) => !/application\/pdf/i.test(file.type) && !/\.pdf$/i.test(file.name || ""));
  if (hasInvalidFile) {
    showToast("Please select PDF files only.", "warning");
    return;
  }

  updateQuestionFromForm();

  try {
    const pdfDataUrls = await Promise.all(files.map((file) => readFileAsDataUrl(file)));
    const parts = splitNotesAttachments(question.notesAttachments || []);
    parts.pdf = mergeUniqueNotesAttachments([...parts.pdf, ...pdfDataUrls]);
    question.notesAttachments = buildNotesAttachments(parts);
    renderEditor();
    updateGeneratedJson();
    saveDraft();
    showToast(`Attached ${pdfDataUrls.length} notes PDF file(s).`, "success");
  } catch (error) {
    showToast("Could not read one or more PDF files.", "error");
  }
}

function setSolutionPanelCollapsed(collapsed) {
  const body = document.getElementById("solutionPanelBody");
  const button = document.getElementById("toggleSolutionPanelBtn");
  if (!(body instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) {
    return;
  }

  body.classList.toggle("hidden", collapsed);
  button.textContent = collapsed ? "Expand" : "Collapse";
  button.setAttribute("aria-expanded", collapsed ? "false" : "true");
}

function setAutoQuestionMakerOpen(open) {
  const panel = document.getElementById("autoQuestionMakerPanel");
  const openButton = document.getElementById("toggleAutoQuestionMakerBtn");
  if (!(panel instanceof HTMLElement) || !(openButton instanceof HTMLButtonElement)) {
    return;
  }

  panel.classList.toggle("hidden", !open);
  openButton.textContent = open ? "Hide Auto Question Maker" : "Open Auto Question Maker";
  openButton.setAttribute("aria-expanded", open ? "true" : "false");
}

document.getElementById("addCategoryBtn").addEventListener("click", addCategory);
document.getElementById("addQuizBtn").addEventListener("click", addQuiz);
document.getElementById("openQuizSettingsBtn").addEventListener("click", () => {
  openQuizSettingsModal();
});
document.getElementById("addQuestionBtn").addEventListener("click", addQuestion);
document.getElementById("clearQuestionBtn").addEventListener("click", () => {
  void clearQuizQuestions();
});

document.getElementById("autoFixQuizIssuesBtn").addEventListener("click", () => {
  autoFixActiveQuizIssues();
});

document.getElementById("toggleQuizScanBtn").addEventListener("click", () => {
  state.quizScanEnabled = !state.quizScanEnabled;
  renderQuizScanToggle();
  renderQuizList();
  renderQuestionsList();
});

document.getElementById("toggleAutoQuestionMakerBtn").addEventListener("click", () => {
  const panel = document.getElementById("autoQuestionMakerPanel");
  const isOpen = panel instanceof HTMLElement && !panel.classList.contains("hidden");
  setAutoQuestionMakerOpen(!isOpen);
});

document.getElementById("closeAutoQuestionMakerBtn").addEventListener("click", () => {
  setAutoQuestionMakerOpen(false);
});

document.getElementById("categorySearch").addEventListener("input", renderCategoryList);
document.getElementById("quizSearch").addEventListener("input", renderQuizList);
document.getElementById("questionSearch").addEventListener("input", renderQuestionsList);
document.getElementById("attachImageBtn").addEventListener("click", () => {
  const question = activeQuestion();
  if (!question) {
    showToast("Select a question first.", "warning");
    return;
  }

  document.getElementById("imageFileInput").click();
});

document.getElementById("attachSolutionFileBtn").addEventListener("click", () => {
  const question = activeQuestion();
  if (!question) {
    showToast("Select a question first.", "warning");
    return;
  }

  document.getElementById("solutionFileInput").click();
});

document.getElementById("attachNotesPdfBtn").addEventListener("click", () => {
  const question = activeQuestion();
  if (!question) {
    showToast("Select a question first.", "warning");
    return;
  }

  document.getElementById("notesPdfInput").click();
});

document.getElementById("imageFileInput").addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  const file = target.files && target.files[0];
  attachImageToQuestion(file || null);
  target.value = "";
});

document.getElementById("solutionFileInput").addEventListener("change", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  await attachSolutionFilesToQuestion(target.files);
  target.value = "";
});

document.getElementById("notesPdfInput").addEventListener("change", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  await attachNotesPdfToQuestion(target.files);
  target.value = "";
});

document.getElementById("categoryList").addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const id = target.dataset.id;
  if (!id) return;

  if (target.dataset.action === "delete") {
    deleteCategory(id);
    return;
  }

  state.selectedCategoryId = id;
  state.selectedQuizId = null;
  state.selectedQuestionIndex = -1;
  renderAll();
});

document.getElementById("quizList").addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const id = target.dataset.id;
  if (!id) return;

  if (target.dataset.action === "delete") {
    await deleteQuiz(id);
    return;
  }

  if (target.dataset.action === "replicate") {
    replicateQuiz(id);
    return;
  }

  if (target.dataset.action === "settings") {
    openQuizSettingsModal(id);
    return;
  }

  if (target.dataset.action === "auto") {
    autoCreateEntireQuiz(id);
    return;
  }

  state.selectedQuizId = id;
  state.selectedQuestionIndex = -1;
  const quiz = activeQuiz();
  if (ensureQuizHasDefaultQuestion(quiz)) {
    state.selectedQuestionIndex = 0;
  }
  renderAll();
});

document.getElementById("questionsList").addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const row = target.closest(".list-item");
  if (!(row instanceof HTMLElement)) return;

  const indexValue = target.dataset.index || row.dataset.questionIndex || row.dataset.dragIndex;
  if (typeof indexValue === "undefined") return;
  const index = Number.parseInt(indexValue, 10);
  if (Number.isNaN(index)) return;

  if (target.dataset.action === "delete") {
    void deleteQuestion(index);
    return;
  }

  state.selectedQuestionIndex = index;
  renderAll();
});

document.getElementById("questionsList").addEventListener("dragstart", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const row = target.closest(".list-item");
  if (!(row instanceof HTMLElement)) return;

  const dragIndex = Number.parseInt(row.dataset.dragIndex || "-1", 10);
  if (Number.isNaN(dragIndex) || dragIndex < 0) return;
  state.draggingQuestionIndex = dragIndex;
  row.classList.add("dragging");
});

document.getElementById("questionsList").addEventListener("dragover", (event) => {
  event.preventDefault();
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const row = target.closest(".list-item");
  if (!(row instanceof HTMLElement)) return;

  document.querySelectorAll("#questionsList .list-item").forEach((item) => item.classList.remove("drag-over"));
  row.classList.add("drag-over");
});

document.getElementById("questionsList").addEventListener("dragleave", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const row = target.closest(".list-item");
  if (!(row instanceof HTMLElement)) return;
  row.classList.remove("drag-over");
});

document.getElementById("questionsList").addEventListener("drop", (event) => {
  event.preventDefault();
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const row = target.closest(".list-item");
  if (!(row instanceof HTMLElement)) return;

  const targetIndex = Number.parseInt(row.dataset.dragIndex || "-1", 10);
  if (Number.isNaN(targetIndex) || targetIndex < 0) return;

  moveQuestion(state.draggingQuestionIndex, targetIndex);
  state.draggingQuestionIndex = -1;
});

document.getElementById("questionsList").addEventListener("dragend", () => {
  state.draggingQuestionIndex = -1;
  document.querySelectorAll("#questionsList .list-item").forEach((item) => {
    item.classList.remove("dragging");
    item.classList.remove("drag-over");
  });
});

document.getElementById("notesBtn").addEventListener("click", () => {
  const question = activeQuestion();
  if (!question || !question.notesAttachments || question.notesAttachments.length === 0) {
    showToast("No notes attachments.", "info");
    return;
  }

  showToast(`Attachments: ${question.notesAttachments.length}`, "success");
});

document.getElementById("saveQuestionBtn").addEventListener("click", async () => {
  const question = activeQuestion();
  if (!question) {
    showToast("Select a question first.", "warning");
    return;
  }

  updateQuestionFromForm();
  const saved = await saveSelectedQuiz({ allowPrompt: false });
  if (saved) {
    showToast("Question changes saved.", "success");
    return;
  }

  showToast("Question updated in Maker, but file save did not run. Connect Root Folder if needed.", "warning");
});

document.getElementById("autoCreateDifficultyLevel").addEventListener("input", (e) => {
  const value = String(e.target.value || "5").trim();
  const valueDisplay = document.getElementById("autoCreateDifficultyValue");
  if (valueDisplay) {
    valueDisplay.textContent = value;
  }
});

// Check if a generated question already exists in the active quiz.
function isGeneratedQuestionDuplicate(payload) {
  const quiz = activeQuiz();
  if (!quiz || !Array.isArray(quiz.questions) || !payload) {
    return false;
  }
  const seenSignatures = new Set();
  for (const existingQuestion of quiz.questions) {
    if (!existingQuestion || isIntroductionQuestionItem(existingQuestion)) continue;
    const existingSignature = buildQuestionUniquenessSignature(existingQuestion);
    if (existingSignature) seenSignatures.add(existingSignature);
  }
  return isQuestionDuplicateInSet(payload, seenSignatures);
}

document.getElementById("autoCreateQuestionBtn").addEventListener("click", async () => {
  const question = activeQuestion();
  if (!question) {
    showToast("Select a question first.", "warning");
    return;
  }

  const category = String(document.getElementById("autoCreateCategory").value || "cartesian-plane").trim();
  const subcategory = String(document.getElementById("autoCreateSubcategory").value || "linear").trim();
  const manualDifficulty = Number.parseInt(document.getElementById("autoCreateDifficultyLevel").value || "5", 10);
  const difficulty = Math.max(1, Math.min(10, manualDifficulty));
  const resultTypeChoice = String(document.getElementById("autoCreateResultType").value || "auto").trim();

  const generationOptions = {
    commandWord: "random",
    answerPolicy: "auto",
    decimalPlaces: 2,
    domainMin: null,
    domainMax: null
  };

  // Try up to 10 times to generate a unique question
  let payload = null;
  let duplicateAttempts = 0;
  const maxAttempts = 10;

  while (duplicateAttempts < maxAttempts) {
    payload = buildAutoPayloadForCategory(category, subcategory, difficulty, resultTypeChoice, generationOptions);
    if (!payload) {
      showToast("Could not generate this question for the selected category. Try a different subcategory or difficulty.", "warning");
      return;
    }

    // Check for duplicates
    if (!isGeneratedQuestionDuplicate(payload)) {
      break; // Found a unique question
    }

    duplicateAttempts += 1;
  }

  if (duplicateAttempts >= maxAttempts) {
    showToast("Could not generate a unique question after 10 attempts. This question type may have limited variation at this difficulty level.", "warning");
    return;
  }

  const verification = verifyAutoPayload(category, subcategory, payload);
  if (!verification.ok) {
    const summary = verification.issues.slice(0, 2).join(" | ");
    showToast(`Auto Create verification failed: ${summary}`, "warning");
    return;
  }

  applyAutoCreatedQuestionToEditor(payload);
  updateQuestionFromForm();
  await persistSelectedQuizAfterMutation("Auto-created question");
  showToast("Question auto-created and semantically verified.", "success");
});

document.getElementById("recalculateAnswerBtn").addEventListener("click", async () => {
  const question = activeQuestion();
  if (!question) {
    showToast("Select a question first.", "warning");
    return;
  }

  const app = readInteractiveAppFromForm();
  if (!app || !app.type) {
    showToast("Select and configure an Interactive App first.", "warning");
    return;
  }

  const resultTypeChoice = String(document.getElementById("resultType").value || "short-answer").trim();

  const payload = buildDeterministicPayloadFromInteractiveApp(
    app.type,
    app,
    resultTypeChoice,
    {
      answerPolicy: "auto",
      decimalPlaces: 2,
      commandWord: "calculate",
      domainMin: null,
      domainMax: null
    }
  );

  if (!payload) {
    showToast("Recalculate is not available for this app configuration.", "warning");
    return;
  }

  const nextResultType = normalizeResultType(resultTypeChoice);
  document.getElementById("solutionText").value = payload.solution || "";

  if (Array.isArray(payload.options) && payload.options.length > 0 && ["multiple-choice", "true-false", "checkbox"].includes(nextResultType)) {
    document.getElementById("option1").value = payload.options[0] || "";
    document.getElementById("option2").value = payload.options[1] || "";
    document.getElementById("option3").value = payload.options[2] || "";
    document.getElementById("option4").value = payload.options[3] || "";
  }

  document.getElementById("correctAnswer").value = String(payload.correctAnswer || "");
  refreshCorrectAnswerSelect({
    resultType: nextResultType,
    options: [
      document.getElementById("option1").value.trim(),
      document.getElementById("option2").value.trim(),
      document.getElementById("option3").value.trim(),
      document.getElementById("option4").value.trim()
    ],
    correctAnswer: String(payload.correctAnswer || "")
  });

  updateQuestionFromForm();
  await persistSelectedQuizAfterMutation("Recalculated answer and solution");
  showToast("Answer and solution recalculated from current app config.", "success");
});

document.getElementById("autoCreateQuizBtn").addEventListener("click", () => {
  void autoCreateEntireQuiz();
});

document.getElementById("autoCreateCategory").addEventListener("change", () => {
  populateAutoCreateSubcategoryOptions();
});

document.getElementById("autoQuizGrade").addEventListener("change", () => {
  syncAutoCreateDifficultyControl();
});

document.getElementById("validateGeneratedQuestionBtn").addEventListener("click", () => {
  const question = activeQuestion();
  if (!question) {
    showToast("Select a question first.", "warning");
    return;
  }
  updateQuestionFromForm();
  const issues = getQuestionValidationIssues(question);
  if (issues.length === 0) {
    showToast("Validation passed.", "success");
    return;
  }
  showToast(`Validation found ${issues.length} issue(s).`, "warning");
});

["questionText", "questionCategory", "questionSubcategory", "questionLearningOutcome", "resultType", "option1", "option2", "option3", "option4", "correctAnswer", "attachmentsInput", "notesYoutubeInput", "notesPdfUrlsInput", "questionImage", "solutionText", "solutionAttachmentsInput", "timeMode", "timeFocus", "timeAllowCustomAnswer", "timeDigitalChallenge", "timeHour", "timeMinute", "timePeriod", "arithLayout", "arithOperator", "arithOperandA", "arithOperandB", "arithAnswer", "nlMin", "nlMax", "nlPoints", "nlArrows", "cpXMin", "cpXMax", "cpYMin", "cpYMax", "cpAngleMode", "cpPoints", "cpSegments", "cpParabolas", "cpFunctions", "cppXMin", "cppXMax", "cppYMin", "cppYMax", "cppTolerance", "cppPoints", "cppVceTemplate", "cppPresetType", "cppPresetExpression", "cppPresetXValues", "bcTitle", "bcYMax", "bcOrientation", "bcCategoryAxisLabel", "bcValueAxisLabel", "bcItems", "histTitle", "histValues", "histBinCount", "boxTitle", "boxDatasetCount", "boxDatasets", "scTitle", "scPoints", "ptTitle", "ptPaths", "ptConditional", "dcTitle", "dcMean", "dcStdDev", "dcFrom", "dcTo", "fxOperation", "fxNumeratorA", "fxDenominatorA", "fxNumeratorB", "fxDenominatorB", "ngTitle", "ngNodes", "ngEdges", "ngSource", "ngTarget", "ngFlowSource", "ngFlowSink", "mxTitle", "mxOperation", "mxMatrixA", "mxMatrixB", "slValues", "slStemUnit", "geoCanvasWidth", "geoCanvasHeight", "geoUnit", "geoFormulaNotation", "geoShapesInput", "pySideA", "pySideB", "pySideC", "pyCaption", "trigAngleDeg", "trigFunction", "trigOpposite", "trigAdjacent", "trigHypotenuse"]
  .forEach((id) => {
    document.getElementById(id).addEventListener("input", updateQuestionFromForm);
    document.getElementById(id).addEventListener("change", updateQuestionFromForm);
  });

document.getElementById("cppPresetType").addEventListener("change", () => {
  const presetType = String(document.getElementById("cppPresetType").value || "linear").trim() || "linear";
  const expressionInput = document.getElementById("cppPresetExpression");
  const xValuesInput = document.getElementById("cppPresetXValues");
  if (!String(expressionInput.value || "").trim()) {
    expressionInput.value = defaultCartesianPlotPresetExpression(presetType);
  }
  if (!String(xValuesInput.value || "").trim()) {
    xValuesInput.value = defaultCartesianPlotPresetXValues(presetType);
  }
  updateQuestionFromForm();
});

sortSelectOptionsAlphabetically(document.getElementById("autoCreateCategory"));
populateAutoCreateSubcategoryOptions();
syncAutoCreateDifficultyControl();

document.getElementById("cppGeneratePointsBtn").addEventListener("click", () => {
  const presetType = String(document.getElementById("cppPresetType").value || "linear").trim() || "linear";
  const expression = String(document.getElementById("cppPresetExpression").value || "").trim();
  const xValuesText = String(document.getElementById("cppPresetXValues").value || "").trim();
  const generated = generateCartesianPlotPresetPoints(
    presetType,
    expression || defaultCartesianPlotPresetExpression(presetType),
    xValuesText || defaultCartesianPlotPresetXValues(presetType)
  );

  if (generated.message) {
    showToast(generated.message, "warning");
    return;
  }

  document.getElementById("cppPoints").value = serializeCartesianPoints(generated.points);
  updateQuestionFromForm();
  showToast(`Generated ${generated.points.length} key points.`, "success");
});

document.getElementById("cppApplyTemplateBtn").addEventListener("click", () => {
  const templateId = String(document.getElementById("cppVceTemplate").value || "").trim();
  if (!templateId) {
    showToast("Choose a VCE template first.", "info");
    return;
  }

  const template = getCartesianPlotVceTemplate(templateId);
  if (!template) {
    showToast("Template not found.", "warning");
    return;
  }

  document.getElementById("cppPresetType").value = template.presetType;
  document.getElementById("cppPresetExpression").value = template.expression;
  document.getElementById("cppPresetXValues").value = template.xValues;
  document.getElementById("cppXMin").value = String(template.xMin);
  document.getElementById("cppXMax").value = String(template.xMax);
  document.getElementById("cppYMin").value = String(template.yMin);
  document.getElementById("cppYMax").value = String(template.yMax);
  document.getElementById("cppTolerance").value = String(template.tolerance);

  const generated = generateCartesianPlotPresetPoints(template.presetType, template.expression, template.xValues);
  if (!generated.message) {
    document.getElementById("cppPoints").value = serializeCartesianPoints(generated.points);
  }

  updateQuestionFromForm();
  showToast(`Applied template and generated ${generated.points.length || 0} key points.`, "success");
});

document.getElementById("boxDatasetCount").addEventListener("change", () => {
  const countInput = document.getElementById("boxDatasetCount");
  const datasetsInput = document.getElementById("boxDatasets");
  const nextCount = clampBoxPlotDatasetCount(countInput.value);
  countInput.value = String(nextCount);
  datasetsInput.value = serializeBoxPlotDatasets(parseBoxPlotDatasetsFromText(datasetsInput.value, nextCount));
  updateQuestionFromForm();
});

document.getElementById("toggleSolutionPanelBtn").addEventListener("click", () => {
  const body = document.getElementById("solutionPanelBody");
  if (!(body instanceof HTMLElement)) return;
  setSolutionPanelCollapsed(!body.classList.contains("hidden"));
});

document.getElementById("correctAnswerSelect").addEventListener("change", updateQuestionFromForm);

// Checkbox answer selection is handled via click listeners on each button in refreshCorrectAnswerSelect.

document.getElementById("embedFormatSelect").addEventListener("change", () => {
  updateEmbedOutputForActiveQuiz();
});

document.getElementById("quizFileName").addEventListener("change", () => {
  const quiz = activeQuiz();
  if (!quiz) return;

  const input = document.getElementById("quizFileName");
  const nextFileName = buildUniqueQuizFileName(input.value || quiz.title, quiz.id);
  const changed = nextFileName !== quiz.fileName;

  quiz.fileName = nextFileName;
  input.value = nextFileName;
  updateGeneratedJson();
  saveDraft();

  if (changed) {
    showToast(`Filename set to ${nextFileName}`, "success");
  }
});

document.getElementById("saveQuizBtn").addEventListener("click", async () => {
  await saveSelectedQuiz();
});

document.getElementById("connectRootBtn").addEventListener("click", async () => {
  await connectRootDirectoryHandle();
});

document.getElementById("importTableBtn").addEventListener("click", () => {
  openImportModal();
});

document.getElementById("openResultValidationBtn").addEventListener("click", () => {
  openResultValidationModal();
  runResultValidation(false);
});

document.getElementById("downloadImportTemplateBtn").addEventListener("click", () => {
  downloadImportTemplateCsv();
});

document.getElementById("runResultValidationBtn").addEventListener("click", () => {
  runResultValidation(false);
});

document.getElementById("runAiResultValidationBtn").addEventListener("click", () => {
  runResultValidation(true);
});

document.getElementById("exportResultValidationBtn").addEventListener("click", () => {
  downloadResultValidationCsv();
});

document.getElementById("resultValidationBody").addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const row = target.closest("tr[data-question-index]");
  if (!(row instanceof HTMLElement)) return;
  const questionIndex = Number.parseInt(row.dataset.questionIndex || "", 10);
  if (!Number.isInteger(questionIndex) || questionIndex < 0) return;
  focusResultValidationQuestion(questionIndex);
  renderResultValidationDetail(questionIndex);
  if (pendingResultValidation) {
    renderResultValidation(pendingResultValidation);
  }
});

document.getElementById("resultValidationStatusFilter").addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) return;
  pendingResultValidationFilter = normalizeResultValidationFilter(target.value);
  if (pendingResultValidation) {
    renderResultValidation(pendingResultValidation);
  }
});

document.getElementById("resultValidationSummary").addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const card = target.closest("[data-summary-filter]");
  if (!(card instanceof HTMLElement)) return;
  const requested = normalizeResultValidationIssueFilter(card.dataset.summaryFilter || "all");
  const current = normalizeResultValidationIssueFilter(pendingResultValidationIssueFilter);
  pendingResultValidationIssueFilter = current === requested ? "all" : requested;

  if (pendingResultValidation) {
    renderResultValidation(pendingResultValidation);
  }
});

document.getElementById("applyResultValidationFixBtn").addEventListener("click", async () => {
  const button = document.getElementById("applyResultValidationFixBtn");
  if (!(button instanceof HTMLButtonElement)) return;
  const questionIndex = Number.parseInt(button.dataset.questionIndex || "", 10);
  if (!Number.isInteger(questionIndex) || questionIndex < 0) {
    showToast("Select a row first.", "warning");
    return;
  }

  const changed = await applyResultValidationFixForQuestion(questionIndex, { confirmApply: true });
  if (!changed) return;

  renderAll();
  await persistSelectedQuizAfterMutation("Validation update");
  runResultValidation(Boolean(pendingResultValidation && pendingResultValidation.aiMode));
  renderResultValidationDetail(questionIndex);
  showToast("Proposed update applied.", "success");
});

document.getElementById("saveResultValidationQuestionBtn").addEventListener("click", async () => {
  const button = document.getElementById("saveResultValidationQuestionBtn");
  const editor = document.getElementById("resultValidationQuestionEditor");
  const quiz = activeQuiz();
  if (!(button instanceof HTMLButtonElement)
    || !(editor instanceof HTMLTextAreaElement)
    || !quiz
    || !Array.isArray(quiz.questions)) {
    return;
  }

  if (String(button.dataset.editing || "") !== "true") {
    showToast("Click Edit Question first.", "info");
    return;
  }

  const questionIndex = Number.parseInt(button.dataset.questionIndex || "", 10);
  if (!Number.isInteger(questionIndex) || questionIndex < 0 || questionIndex >= quiz.questions.length) {
    showToast("Select a row first.", "warning");
    return;
  }

  const nextQuestionText = String(editor.value || "").trim();
  if (!nextQuestionText) {
    showToast("Question text cannot be empty.", "warning");
    return;
  }

  const currentQuestion = quiz.questions[questionIndex];
  const previousText = String(currentQuestion && currentQuestion.question || "").trim();
  if (normalizeWhitespace(previousText) === normalizeWhitespace(nextQuestionText)) {
    showToast("No question changes to save.", "info");
    return;
  }

  currentQuestion.question = nextQuestionText;
  state.selectedQuestionIndex = questionIndex;

  renderAll();
  await persistSelectedQuizAfterMutation("Question edit from validator");
  runResultValidation(Boolean(pendingResultValidation && pendingResultValidation.aiMode));
  renderResultValidationDetail(questionIndex);
  showToast("Question updated from validator.", "success");
});

document.getElementById("resultValidationPreviewCard").addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const actionButton = target.closest("button[data-validator-edit-action]");
  if (!(actionButton instanceof HTMLButtonElement)) return;

  const action = String(actionButton.dataset.validatorEditAction || "").trim().toLowerCase();
  const editor = document.getElementById("resultValidationQuestionEditor");
  const saveBtn = document.getElementById("saveResultValidationQuestionBtn");
  const startBtn = document.querySelector("button[data-validator-edit-action='start']");
  const cancelBtn = document.querySelector("button[data-validator-edit-action='cancel']");
  if (!(editor instanceof HTMLTextAreaElement)
    || !(saveBtn instanceof HTMLButtonElement)
    || !(startBtn instanceof HTMLButtonElement)
    || !(cancelBtn instanceof HTMLButtonElement)) {
    return;
  }

  if (action === "start") {
    editor.readOnly = false;
    editor.style.background = "#ffffff";
    editor.style.borderColor = "#1f6feb";
    saveBtn.disabled = false;
    saveBtn.dataset.editing = "true";
    startBtn.style.display = "none";
    cancelBtn.style.display = "inline-flex";
    editor.focus();
    return;
  }

  if (action === "cancel") {
    editor.value = String(editor.dataset.originalQuestion || "");
    editor.readOnly = true;
    editor.style.background = "#f8fafc";
    editor.style.borderColor = "#cbd5e1";
    saveBtn.disabled = true;
    saveBtn.dataset.editing = "false";
    startBtn.style.display = "inline-flex";
    cancelBtn.style.display = "none";
  }
});

document.getElementById("applyBulkResultValidationFixBtn").addEventListener("click", async () => {
  await applyBulkResultValidationFixes();
});

document.getElementById("closeResultValidationModalBtn").addEventListener("click", () => {
  closeResultValidationModal();
});

document.getElementById("toggleResultValidationFullscreenBtn").addEventListener("click", () => {
  toggleResultValidationFullscreen();
});

window.addEventListener("resize", () => {
  refreshResultValidationFullscreenLayout();
});

setupResultValidationTableContainerScrollControls();

window.addEventListener("message", (event) => {
  const data = event && event.data ? event.data : null;
  if (!data || data.type !== "validation-preview-ready") return;
  const sourceWindow = event.source;
  if (!sourceWindow || !pendingResultValidation || !Array.isArray(pendingResultValidation.rows)) return;
  const questionIndex = pendingResultValidationSelectedIndex;
  if (!Number.isInteger(questionIndex) || questionIndex < 0) return;

  const quiz = activeQuiz();
  const question = quiz && Array.isArray(quiz.questions) ? quiz.questions[questionIndex] : null;
  if (!question || !question.interactiveApp || typeof question.interactiveApp !== "object") return;

  const payload = buildResultValidationViewerPayload(question, questionIndex);
  if (!payload || typeof payload !== "object") return;
  sourceWindow.postMessage({
    type: "validation-preview-quiz",
    payload
  }, "*");
  window.setTimeout(() => {
    sourceWindow.postMessage({
      type: "validation-preview-open-solution"
    }, "*");
  }, 260);
});

const resultValidationBackdrop = document.querySelector("[data-close-result-validation-modal='true']");
if (resultValidationBackdrop instanceof HTMLElement) {
  resultValidationBackdrop.addEventListener("click", () => {
    closeResultValidationModal();
  });
}

document.getElementById("selectImportFileBtn").addEventListener("click", () => {
  const input = document.getElementById("importTableInput");
  if (!(input instanceof HTMLInputElement)) return;
  input.click();
});

document.getElementById("exportValidationBtn").addEventListener("click", () => {
  downloadImportValidationCsv();
});

document.getElementById("openImportReportBtn").addEventListener("click", () => {
  if (!pendingImportAutoFixReport || !Array.isArray(pendingImportAutoFixReport.rows) || pendingImportAutoFixReport.rows.length === 0) {
    showToast("No auto-fix report available yet.", "warning");
    return;
  }
  openImportReportModal();
});

document.getElementById("exportAutoFixReportBtn").addEventListener("click", () => {
  downloadImportAutoFixReportCsv();
});

document.getElementById("importValidationBody").addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const row = target.closest("tr[data-row-index]");
  if (!(row instanceof HTMLElement)) return;
  const rowIndex = Number.parseInt(row.dataset.rowIndex || "", 10);
  if (!Number.isInteger(rowIndex) || rowIndex < 0) return;
  focusImportPreviewRow(rowIndex);
});

document.getElementById("importTableInput").addEventListener("change", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  const file = target.files && target.files[0] ? target.files[0] : null;
  await handleTableImportSelection(file);
  target.value = "";
});

document.getElementById("applyImportBtn").addEventListener("click", async () => {
  if (pendingImportValidation && pendingImportValidation.errors > 0) {
    const proceed = confirm(`Validation found ${pendingImportValidation.errors} error(s). Import now anyway and fix in Result Validation?`);
    if (!proceed) {
      showToast("Import canceled. Run validation cleanup first if needed.", "info");
      return;
    }
  }
  try {
    const result = await applyPendingImportToMaker();
    if (result && result.importedQuizCount > 0) {
      closeImportModal();
      openImportReportModal();
    }
  } catch (error) {
    showToast(`Import failed: ${String(error && error.message ? error.message : error)}`, "error");
    console.error("Apply Import failed", error);
  }
});

document.getElementById("clearImportPreviewBtn").addEventListener("click", () => {
  pendingImportRows = [];
  pendingImportSourceName = "";
  pendingImportValidation = null;
  pendingImportAutoFixReport = null;
  renderImportPreview([], "spreadsheet");
  const reportBtn = document.getElementById("openImportReportBtn");
  if (reportBtn instanceof HTMLButtonElement) {
    reportBtn.disabled = true;
  }
  showToast("Import preview cleared.", "info");
});

document.getElementById("closeImportModalBtn").addEventListener("click", () => {
  closeImportModal();
});

document.getElementById("closeImportReportModalBtn").addEventListener("click", () => {
  closeImportReportModal();
});

document.getElementById("toggleImportFullscreenBtn").addEventListener("click", () => {
  toggleImportModalFullscreen();
});

const importReportBackdrop = document.querySelector("[data-close-import-report-modal='true']");
if (importReportBackdrop instanceof HTMLElement) {
  importReportBackdrop.addEventListener("click", () => {
    closeImportReportModal();
  });
}

document.querySelector("[data-close-import-modal='true']").addEventListener("click", () => {
  closeImportModal();
});

document.getElementById("downloadQuizBtn").addEventListener("click", () => {
  downloadSelectedQuizJson();
});

document.getElementById("copyJsonBtn").addEventListener("click", async () => {
  if (activeQuestion()) {
    updateQuestionFromForm();
  }
  const json = JSON.stringify(getQuizData(), null, 2);
  try {
    await navigator.clipboard.writeText(json);
    showToast("JSON copied.", "success");
  } catch (error) {
    showToast("Could not copy JSON. Use the Generated JSON box.", "error");
  }
});

document.getElementById("clearQuizBtn").addEventListener("click", () => {
  if (!confirm("Clear all categories, quizzes, and questions?")) return;
  state.categories = [];
  state.selectedCategoryId = null;
  state.selectedQuizId = null;
  state.selectedQuestionIndex = -1;
  renderAll();
});

document.getElementById("closeQuizSettingsBtn").addEventListener("click", () => {
  closeQuizSettingsModal();
});

document.getElementById("cancelQuizSettingsBtn").addEventListener("click", () => {
  closeQuizSettingsModal();
});

document.getElementById("saveQuizSettingsBtn").addEventListener("click", () => {
  saveQuizSettingsFromModal();
});

document.querySelector("[data-close-quiz-settings='true']").addEventListener("click", () => {
  closeQuizSettingsModal();
});

document.getElementById("refreshRootBtn").addEventListener("click", async () => {
  await refreshLibraryFromRoot(true);
});

document.getElementById("quizRootFolder").addEventListener("change", () => {
  const rootInput = document.getElementById("quizRootFolder");
  state.rootFolder = normalizeRootFolder(rootInput.value);
  rootInput.value = state.rootFolder;
  saveDraft();
});

document.getElementById("rootSourceMode").addEventListener("change", () => {
  const rootSourceModeInput = document.getElementById("rootSourceMode");
  state.rootSourceMode = normalizeRootSourceMode(rootSourceModeInput.value);
  rootSourceModeInput.value = state.rootSourceMode;
  updateLocalFolderRowVisibility();
  saveDraft();
});

document.getElementById("interactiveAppType").addEventListener("change", () => {
  const type = document.getElementById("interactiveAppType").value;
  const resultTypeSelect = document.getElementById("resultType");
  if (!type) {
    setInteractiveAppConfigVisibility("");
    renderInteractiveAppPreview(null);
    if (activeQuestion()) updateQuestionFromForm();
    return;
  }

  const nextApp = buildDefaultInteractiveApp(type);
  if (type === "cartesian-plane-plot" && resultTypeSelect) {
    resultTypeSelect.value = "short-answer";
  }
  populateInteractiveAppForm(nextApp);
  if (activeQuestion()) {
    updateQuestionFromForm();
  }
});

document.getElementById("previewInteractiveAppBtn").addEventListener("click", () => {
  const app = readInteractiveAppFromForm();
  renderInteractiveAppPreview(app);
});

document.getElementById("toggleInteractiveAppPanelBtn").addEventListener("click", () => {
  const body = document.getElementById("interactiveAppPanelBody");
  const btn = document.getElementById("toggleInteractiveAppPanelBtn");
  const collapsed = !body.classList.contains("hidden");
  body.classList.toggle("hidden", collapsed);
  btn.textContent = collapsed ? "Expand" : "Collapse";
  btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
});

function normalizeQuestion(item) {
  const options = Array.isArray(item.options) ? item.options.slice(0, 4) : ["", "", "", ""];
  while (options.length < 4) {
    options.push("");
  }

  const resultType = normalizeResultType(item.resultType || "multiple-choice");

  const correctAnswerValue = Number.isInteger(item.correctAnswer)
    ? (options[item.correctAnswer] || "")
    : (item.correctAnswer || "");

  if (resultType === "true-false") {
    options[0] = "True";
    options[1] = "False";
    options[2] = "";
    options[3] = "";
  }

  const normalized = {
    question: item.question || "",
    resultType,
    options,
    correctAnswer: correctAnswerValue,
    category: item.category || "",
    subcategory: item.subcategory || "",
    learningOutcome: item.learningOutcome || "",
    notesAttachments: buildNotesAttachments(splitNotesAttachments(Array.isArray(item.notesAttachments) ? item.notesAttachments : [])),
    image: item.image || "",
    solution: item.solution || "",
    solutionAttachments: normalizeSolutionAttachments(item.solutionAttachments)
  };
  if (item.interactiveApp) normalized.interactiveApp = item.interactiveApp;
  return normalized;
}

function loadImportedData(data) {
  if (Array.isArray(data.questions) && !Array.isArray(data.categories)) {
    const category = createCategory(data.category || "General");
    const quiz = createQuiz(data.title || "Imported Quiz");
    applyLoadedQuizJsonToQuiz(quiz, data);
    quiz.fileName = buildUniqueQuizFileName(data.fileName || data.title || "Imported Quiz", quiz.id);
    quiz.sourcePath = data.sourcePath || data.fileName || "";
    quiz.questions = data.questions.map(normalizeQuestion);
    category.quizzes.push(quiz);
    state.categories = [category];
    state.selectedCategoryId = category.id;
    state.selectedQuizId = quiz.id;
    state.selectedQuestionIndex = quiz.questions.length > 0 ? 0 : -1;
    ensureQuizFileNames();
    renderAll();
    return;
  }

  if (Array.isArray(data.categories)) {
    state.categories = data.categories.map((category) => ({
      id: category.id || `cat-${categorySeed++}`,
      name: category.name || "Category",
      quizzes: Array.isArray(category.quizzes)
        ? category.quizzes.map((quiz) => ({
          id: quiz.id || `quiz-${quizSeed++}`,
          title: quiz.title || "Untitled Quiz",
          description: normalizeQuizDescription(quiz.description),
          settings: normalizeQuizSettings(quiz.settings),
          fileName: quiz.fileName || "",
          sourcePath: quiz.sourcePath || "",
          questions: Array.isArray(quiz.questions) ? quiz.questions.map(normalizeQuestion) : []
        }))
        : []
    }));
    ensureQuizFileNames();
    renderAll();
    return;
  }

  if (Array.isArray(data.questions)) {
    const category = createCategory("General");
    const quiz = createQuiz(data.title || "Imported Quiz");
    applyLoadedQuizJsonToQuiz(quiz, data);
    quiz.fileName = buildUniqueQuizFileName(data.fileName || data.title || "Imported Quiz", quiz.id);
    quiz.sourcePath = data.sourcePath || data.fileName || "";
    quiz.questions = data.questions.map(normalizeQuestion);
    category.quizzes.push(quiz);
    state.categories = [category];
    state.selectedCategoryId = category.id;
    state.selectedQuizId = quiz.id;
    state.selectedQuestionIndex = quiz.questions.length > 0 ? 0 : -1;
    ensureQuizFileNames();
    renderAll();
    return;
  }

  throw new Error("Invalid quiz file");
}

function normalizeImportHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeImportGradeName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const direct = ALLOWED_IMPORT_GRADE_CATEGORIES.find((item) => normalizeText(item) === normalizeText(raw));
  if (direct) return direct;

  const lowered = raw.toLowerCase();
  const compact = lowered.replace(/[^a-z0-9]/g, "");
  const aliased = IMPORT_GRADE_ALIASES[compact];
  if (aliased) return aliased;

  if (/(^|\b)(prep|preprimary|kindergarten|kindy)(\b|$)/i.test(raw)) {
    return "Prep";
  }

  // Accept variants like "1", "01", "g1", "grade-1", "year 1", "class 1".
  const numberMatch = lowered.match(/(?:grade|g|year|class)?\s*[-:]?\s*0*([1-6])\b/);
  if (numberMatch) {
    return `Grade ${numberMatch[1]}`;
  }

  const wordMap = {
    one: "Grade 1",
    two: "Grade 2",
    three: "Grade 3",
    four: "Grade 4",
    five: "Grade 5",
    six: "Grade 6"
  };
  for (const [word, label] of Object.entries(wordMap)) {
    if (new RegExp(`(^|\\b)${word}(\\b|$)`, "i").test(raw)) {
      return label;
    }
  }

  return "";
}

function resolveImportColumnKey(normalizedHeader) {
  const map = {
    grade: "grade",
    year: "grade",
    module: "module",
    lessonpart: "lessonPart",
    lessonname: "lessonName",
    lesson: "lessonName",
    category: "category",
    questioncategory: "category",
    subcategory: "subcategory",
    questionsubcategory: "subcategory",
    qno: "qNo",
    questionno: "qNo",
    questionnumber: "qNo",
    questiontype: "questionType",
    type: "questionType",
    question: "question",
    options: "options",
    compute: "compute",
    computed: "compute",
    computedanswer: "compute",
    answer: "compute",
    correctanswer: "compute",
    learningoutcome: "learningOutcome",
    outcome: "learningOutcome"
  };
  return map[normalizedHeader] || "";
}

function parseImportOptions(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.toLowerCase() === "n/a") {
    return [];
  }
  return raw.split(",").map((item) => item.trim()).filter((item) => item !== "");
}

function countEmojiGlyphs(value) {
  const text = String(value || "");
  const matches = text.match(/\p{Extended_Pictographic}/gu);
  return Array.isArray(matches) ? matches.length : 0;
}

function firstNumberInText(value) {
  const match = String(value || "").match(/(?<!\.)\b\d+\b/);
  return match ? Number.parseInt(match[0], 10) : null;
}

function inferResultTypeFromImport(questionType, options = [], question = "", templateType = "") {
  const normalized = String(questionType || "").trim().toLowerCase();
  const questionText = String(question || "").trim().toLowerCase();
  const normalizedTemplateType = String(templateType || "").trim().toLowerCase();
  const optionList = Array.isArray(options) ? options.filter((item) => String(item || "").trim() !== "") : [];
  const hasWhichNumberMatchesCue = /\bwhich number matches\b/.test(questionText);
  const hasSelectionCue = /\b(select|choose|pick|which of the following|choose the correct|select the correct)\b/.test(questionText) || hasWhichNumberMatchesCue;
  const hasOpenResponseCue = /\b(how many|what is|find|work out|calculate|solve|trace|draw|write|complete)\b/.test(questionText);

  if (
    normalized.includes("plot")
    || normalized.includes("graph")
    || normalizedTemplateType === "cartesian-plane"
    || normalizedTemplateType === "cartesian-plane-plot"
    || /\bplot\b.*\bpoint\b/.test(questionText)
    || /\bgraph\b/.test(questionText)
  ) {
    return "plot";
  }

  if (normalizedTemplateType === "arithmetic" || normalizedTemplateType === "arithmetic-long-division") {
    return "short-answer";
  }

  if (normalized.includes("multi select") || normalized.includes("multiselect")) {
    return optionList.length >= 2 ? "checkbox" : "short-answer";
  }
  if (/\bselect all\b/.test(questionText)) return "checkbox";
  if (normalized.includes("multiple choice")) {
    return optionList.length >= 2 ? "multiple-choice" : "short-answer";
  }

  if (
    normalized.includes("true") && normalized.includes("false")
    || /\btrue\s*\/\s*false\b/.test(questionText)
    || /\btrue or false\b/.test(questionText)
  ) {
    return optionList.length >= 2 ? "true-false" : "short-answer";
  }

  if (/\btrace\b|\bdraw\b|\bwrite\b/.test(questionText) || normalizedTemplateType === "number-tracing") {
    return "short-answer";
  }

  // "Which number matches ..." is typically a choose-from-options prompt.
  // Keep it short-answer only when there are no options to choose from.
  if (hasWhichNumberMatchesCue) {
    return optionList.length >= 2 ? "multiple-choice" : "short-answer";
  }

  if (optionList.length >= 2 && hasSelectionCue && !hasOpenResponseCue) return "multiple-choice";
  return "short-answer";
}

function extractArithmeticStructureFromText(text) {
  const value = String(text || "").trim();
  if (!value) return null;

  let match = value.match(/\b(-?\d+)\s*([+\-x×*])\s*(-?\d+)\b/i);
  if (match) {
    const operandA = Number.parseInt(match[1], 10);
    const rawOperator = String(match[2] || "").trim();
    const operandB = Number.parseInt(match[3], 10);
    const operator = rawOperator === "×" || rawOperator === "*" ? "x" : rawOperator;
    if (Number.isFinite(operandA) && Number.isFinite(operandB)) {
      return { operator, operandA, operandB };
    }
  }

  match = value.match(/\b(-?\d+)\s*(?:÷|\/)\s*(-?\d+)\b/i);
  if (match) {
    const operandA = Number.parseInt(match[1], 10);
    const operandB = Number.parseInt(match[2], 10);
    if (Number.isFinite(operandA) && Number.isFinite(operandB)) {
      return { operator: "/", operandA, operandB };
    }
  }

  match = value.match(/\b(?:divide|dividing)\s+(-?\d+)\s+(?:by|into)\s+(-?\d+)\b/i);
  if (match) {
    const operandA = Number.parseInt(match[1], 10);
    const operandB = Number.parseInt(match[2], 10);
    if (Number.isFinite(operandA) && Number.isFinite(operandB)) {
      return { operator: "/", operandA, operandB };
    }
  }

  match = value.match(/\b(-?\d+)\s+(?:divided\s+by)\s+(-?\d+)\b/i);
  if (match) {
    const operandA = Number.parseInt(match[1], 10);
    const operandB = Number.parseInt(match[2], 10);
    if (Number.isFinite(operandA) && Number.isFinite(operandB)) {
      return { operator: "/", operandA, operandB };
    }
  }

  return null;
}

function inferArithmeticStructureFromImportRow(row) {
  const question = String(row && row.question ? row.question : "").trim();
  const questionType = String(row && row.questionType ? row.questionType : "").trim();
  const category = String(row && row.category ? row.category : "").trim();
  const subcategory = String(row && row.subcategory ? row.subcategory : "").trim();
  const module = String(row && row.module ? row.module : "").trim();
  const lessonPart = String(row && row.lessonPart ? row.lessonPart : "").trim();
  const lessonName = String(row && row.lessonName ? row.lessonName : "").trim();

  const combined = [question, questionType, category, subcategory, module, lessonPart, lessonName]
    .join(" ")
    .toLowerCase();

  const subcategoryHint = String(subcategory || "").toLowerCase();
  const hasLongDivisionCue = /\blong\s*division\b|\blong\s*divide\b|\bbus\s*stop\b|\bquotient\b|\bremainder\b/.test(combined)
    || subcategoryHint.includes("division-long")
    || subcategoryHint.includes("long");

  const direct = extractArithmeticStructureFromText(question) || extractArithmeticStructureFromText(combined);
  if (!direct) {
    return null;
  }

  return {
    operator: direct.operator,
    operandA: direct.operandA,
    operandB: direct.operandB,
    isLongDivision: direct.operator === "/" && hasLongDivisionCue
  };
}

function computeArithmeticAnswerFromStructure(structure) {
  if (!structure || typeof structure !== "object") return null;
  const operator = String(structure.operator || "").trim();
  const operandA = Number.parseFloat(structure.operandA);
  const operandB = Number.parseFloat(structure.operandB);
  if (!Number.isFinite(operandA) || !Number.isFinite(operandB)) return null;

  if (operator === "+") return operandA + operandB;
  if (operator === "-") return operandA - operandB;
  if (operator === "x" || operator === "*") return operandA * operandB;
  if (operator === "/") {
    if (operandB === 0) return null;
    return operandA / operandB;
  }
  return null;
}

function inferTemplateTypeFromImportRow(row) {
  const question = String(row && row.question ? row.question : "").trim();
  const questionType = String(row && row.questionType ? row.questionType : "").trim();
  const category = String(row && row.category ? row.category : "").trim();
  const subcategory = String(row && row.subcategory ? row.subcategory : "").trim();
  const lessonPart = String(row && row.lessonPart ? row.lessonPart : "").trim();
  const lessonName = String(row && row.lessonName ? row.lessonName : "").trim();
  const module = String(row && row.module ? row.module : "").trim();

  const combined = [question, questionType, category, subcategory, lessonPart, lessonName, module]
    .join(" ")
    .toLowerCase();

  const hasCartesianKeyword =
    combined.includes("cartesian")
    || combined.includes("coordinate plane")
    || combined.includes("coordinate grid")
    || combined.includes("x-axis")
    || combined.includes("x axis")
    || combined.includes("y-axis")
    || combined.includes("y axis")
    || combined.includes("quadrant")
    || combined.includes("ordered pair")
    || combined.includes("plot point")
    || combined.includes("point on")
    || /\((-?\d+)\s*,\s*(-?\d+)\)/.test(question);

  if (hasCartesianKeyword) {
    return "cartesian-plane";
  }

  const arithmeticStructure = inferArithmeticStructureFromImportRow(row);
  if (arithmeticStructure) {
    return arithmeticStructure.isLongDivision ? "arithmetic-long-division" : "arithmetic";
  }

  if (/\btrace\b|\bdraw\b|\bwrite\b/i.test(question)) {
    return "number-tracing";
  }

  const hasOrderingCue = /\b(move|drag|arrange|reorder|put)\b.*\b(order|sequence|ascending|descending)\b|\b(order|sequence)\b.*\b(move|drag|arrange|reorder|put)\b|\bmove the numbers in order\b/i.test(combined);
  if (hasOrderingCue) {
    return "number-ordering";
  }

  if (/how many|which number matches/i.test(question)) {
    return "icon-count";
  }

  return "";
}

function inferImportCategoryFromTemplateType(templateType) {
  const normalized = String(templateType || "").trim().toLowerCase();
  if (normalized === "cartesian-plane" || normalized === "cartesian-plane-plot") {
    return "cartesian-plane";
  }
  if (normalized === "arithmetic" || normalized === "arithmetic-long-division") {
    return "arithmetic";
  }
  return "";
}

function extractCartesianPointsFromQuestionText(questionText) {
  const points = [];
  const text = String(questionText || "");
  const regex = /\((-?\d+)\s*,\s*(-?\d+)\)/g;
  let match = regex.exec(text);
  while (match) {
    const x = Number.parseInt(match[1], 10);
    const y = Number.parseInt(match[2], 10);
    if (Number.isInteger(x) && Number.isInteger(y)) {
      points.push({ x, y, label: points.length === 0 ? "P" : `P${points.length + 1}`, color: "#2563eb" });
    }
    match = regex.exec(text);
  }
  return points;
}

function extractIntegersFromText(text) {
  const matches = String(text || "").match(/-?\d+/g);
  if (!Array.isArray(matches)) return [];
  return matches
    .map((item) => Number.parseInt(item, 10))
    .filter((value) => Number.isInteger(value));
}

function inferExpectedNumericAnswerFromQuestion(questionText) {
  const question = String(questionText || "").trim();
  const lower = question.toLowerCase();
  const numbers = extractIntegersFromText(question);

  if (numbers.length === 0) {
    return null;
  }

  if ((lower.includes("comes before") || /\bbefore\b/.test(lower)) && numbers.length >= 1) {
    return numbers[0] - 1;
  }

  if ((lower.includes("comes after") || /\bafter\b/.test(lower)) && numbers.length >= 1) {
    return numbers[0] + 1;
  }

  const middleMissingMatch = question.match(/(-?\d+)\s*,\s*_+\s*,\s*(-?\d+)/);
  if (middleMissingMatch) {
    const left = Number.parseInt(middleMissingMatch[1], 10);
    const right = Number.parseInt(middleMissingMatch[2], 10);
    const mid = (left + right) / 2;
    if (Number.isInteger(mid)) {
      return mid;
    }
  }

  if (/_+/.test(question) && numbers.length >= 2) {
    const diffs = [];
    for (let i = 1; i < numbers.length; i += 1) {
      diffs.push(numbers[i] - numbers[i - 1]);
    }
    const firstDiff = diffs[0];
    const isConsistent = diffs.every((value) => value === firstDiff);
    if (isConsistent) {
      return numbers[numbers.length - 1] + firstDiff;
    }
  }

  if (/what comes next\?/i.test(question) && numbers.length >= 2) {
    const diff = numbers[1] - numbers[0];
    return numbers[numbers.length - 1] + diff;
  }

  return null;
}

function inferAnswerFromImportRow(row, templateType = "") {
  const question = String(row.question || "").trim();
  const qLower = question.toLowerCase();
  const options = Array.isArray(row.options) ? row.options : [];
  const resolvedTemplateType = String(templateType || inferTemplateTypeFromImportRow(row)).trim().toLowerCase();
  const baseResultType = inferResultTypeFromImport(row.questionType, options, question, resolvedTemplateType);
  const computeValue = String(row && row.compute ? row.compute : "").trim();
  const expectedNumericFromQuestion = inferExpectedNumericAnswerFromQuestion(question);
  const arithmeticStructure = inferArithmeticStructureFromImportRow(row);
  const arithmeticAnswer = computeArithmeticAnswerFromStructure(arithmeticStructure);

  if (Number.isFinite(arithmeticAnswer)) {
    const arithmeticText = Number.isInteger(arithmeticAnswer)
      ? String(Math.trunc(arithmeticAnswer))
      : String(roundTo(arithmeticAnswer, 2));
    return { resultType: "short-answer", correctAnswer: arithmeticText };
  }

  if (computeValue && normalizeText(computeValue) !== "n/a") {
    let resolvedComputeValue = computeValue;
    if (Number.isInteger(expectedNumericFromQuestion)) {
      const semanticExpected = String(expectedNumericFromQuestion);
      if (normalizeText(computeValue) !== normalizeText(semanticExpected)) {
        resolvedComputeValue = semanticExpected;
      }
    }

    if (["multiple-choice", "true-false"].includes(baseResultType)) {
      const matched = options.find((item) => normalizeText(item) === normalizeText(resolvedComputeValue));
      return { resultType: baseResultType, correctAnswer: matched ? String(matched).trim() : resolvedComputeValue };
    }

    if (baseResultType === "checkbox") {
      const requested = resolvedComputeValue
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item !== "");
      const resolved = requested.map((token) => {
        const hit = options.find((item) => normalizeText(item) === normalizeText(token));
        return hit ? String(hit).trim() : token;
      });
      return { resultType: baseResultType, correctAnswer: resolved.join(", ") };
    }

    return { resultType: baseResultType, correctAnswer: resolvedComputeValue };
  }

  const whichNumberMatch = question.match(/which number is\s*(\d+)/i);
  if (whichNumberMatch) {
    return { resultType: baseResultType, correctAnswer: whichNumberMatch[1] };
  }

  const selectNumberMatch = question.match(/select the number\s*(\d+)/i);
  if (selectNumberMatch) {
    return { resultType: baseResultType, correctAnswer: selectNumberMatch[1] };
  }

  if (qLower.includes("means none") || qLower.includes("empty") || qLower.includes("no ")) {
    return { resultType: baseResultType, correctAnswer: "0" };
  }

  if (qLower.includes("means one")) {
    return { resultType: baseResultType, correctAnswer: "1" };
  }

  if (qLower.includes("select all")) {
    const targetMatch = question.match(/select all the\s*(\d+)s?/i);
    if (targetMatch) {
      const target = targetMatch[1];
      const hits = options.filter((item) => String(item).trim() === target);
      return { resultType: "checkbox", correctAnswer: hits.length > 0 ? hits.join(", ") : target };
    }
    const nums = options.filter((item) => /^\d+$/.test(String(item).trim()));
    return { resultType: "checkbox", correctAnswer: nums.join(", ") };
  }

  if (qLower.includes("how many") || qLower.includes("which number matches")) {
    const emojiCount = countEmojiGlyphs(question);
    if (emojiCount > 0) {
      return { resultType: baseResultType, correctAnswer: String(emojiCount) };
    }
    const extractedNumber = firstNumberInText(question);
    if (Number.isInteger(extractedNumber)) {
      return { resultType: baseResultType, correctAnswer: String(extractedNumber) };
    }
  }

  if (qLower.includes("trace") || qLower.includes("draw") || qLower.includes("write")) {
    const extractedNumber = firstNumberInText(question);
    return {
      resultType: "short-answer",
      correctAnswer: Number.isInteger(extractedNumber) ? String(extractedNumber) : ""
    };
  }

  const expectedNumeric = inferExpectedNumericAnswerFromQuestion(question);
  if (Number.isInteger(expectedNumeric)) {
    const expectedText = String(expectedNumeric);
    const matchedOption = options.find((item) => normalizeText(item) === normalizeText(expectedText));
    return { resultType: baseResultType, correctAnswer: matchedOption ? String(matchedOption).trim() : expectedText };
  }

  if (baseResultType === "multiple-choice") {
    const firstNumeric = options.find((item) => /^\d+$/.test(String(item).trim()));
    if (firstNumeric) {
      return { resultType: baseResultType, correctAnswer: String(firstNumeric).trim() };
    }
  }

  const fallbackNumber = firstNumberInText(question);
  if (Number.isInteger(fallbackNumber)) {
    return { resultType: baseResultType, correctAnswer: String(fallbackNumber) };
  }

  return { resultType: baseResultType, correctAnswer: options.length > 0 ? String(options[0]).trim() : "" };
}

function inferSolutionFromImport(question, answer) {
  const q = String(question || "").trim();
  const a = String(answer || "").trim();
  const arithmeticStructure = inferArithmeticStructureFromImportRow({ question: q });
  if (!a) return "Read the question carefully and use the lesson concept to complete it.";
  if (arithmeticStructure) {
    const operator = String(arithmeticStructure.operator || "").trim();
    const symbol = operator === "x" ? "x" : operator;
    if (operator === "/") {
      const isLongDivision = /\blong\s*division\b|\blong\s*divide\b|\bquotient\b|\bremainder\b/i.test(q);
      if (isLongDivision) {
        return `Apply long division: ${arithmeticStructure.operandA} / ${arithmeticStructure.operandB} = ${a}. Check: ${arithmeticStructure.operandB} x ${a} = ${arithmeticStructure.operandA}.`;
      }
      return `Divide the numbers: ${arithmeticStructure.operandA} / ${arithmeticStructure.operandB} = ${a}.`;
    }
    return `Compute ${arithmeticStructure.operandA} ${symbol} ${arithmeticStructure.operandB} = ${a}.`;
  }
  if (/select all/i.test(q)) return `Select every correct option. The correct selection is: ${a}.`;
  if (/what comes next/i.test(q)) return `Continue the counting pattern by 1. The next number is ${a}.`;
  if (/how many|which number matches/i.test(q)) return `Count the objects shown and match the quantity. The answer is ${a}.`;
  if (/trace|draw|write/i.test(q)) return `The target numeral is ${a}. Complete the tracing/writing step using that number.`;
  return `The correct answer is ${a}.`;
}

function summarizeModuleLearningOutcomes(rows) {
  const outcomes = Array.from(new Set(
    (Array.isArray(rows) ? rows : [])
      .map((row) => String(row && row.learningOutcome ? row.learningOutcome : "").trim())
      .filter((item) => item !== "")
  ));
  if (outcomes.length === 0) {
    return "";
  }
  return outcomes.join(" | ");
}

function buildInteractiveAppFromImport(row, answer, templateType = "") {
  const question = String(row.question || "").trim();
  const qLower = question.toLowerCase();
  const numericAnswer = Number.parseInt(String(answer || ""), 10);
  const normalizedTemplateType = String(templateType || "").trim().toLowerCase();

  if (normalizedTemplateType === "cartesian-plane" || normalizedTemplateType === "cartesian-plane-plot") {
    const base = buildDefaultInteractiveApp("cartesian-plane");
    const app = {
      type: "cartesian-plane",
      config: base && base.config ? { ...base.config } : {}
    };
    const points = extractCartesianPointsFromQuestionText(question);
    if (points.length > 0) {
      app.config.points = points;
      app.config.segments = [];
      app.config.parabolas = [];
      app.config.functions = [];
    }
    return app;
  }

  if (normalizedTemplateType === "arithmetic" || normalizedTemplateType === "arithmetic-long-division") {
    const arithmeticStructure = inferArithmeticStructureFromImportRow(row);
    if (arithmeticStructure) {
      const computedAnswer = computeArithmeticAnswerFromStructure(arithmeticStructure);
      const numericAnswerText = Number.isFinite(computedAnswer)
        ? (Number.isInteger(computedAnswer) ? String(Math.trunc(computedAnswer)) : String(roundTo(computedAnswer, 2)))
        : String(answer || "").trim();
      const isDivision = arithmeticStructure.operator === "/";
      const useLongLayout = normalizedTemplateType === "arithmetic-long-division" || (isDivision && arithmeticStructure.isLongDivision);
      return {
        type: "arithmetic",
        config: {
          layout: useLongLayout ? "vertical" : "horizontal",
          operator: arithmeticStructure.operator,
          operandA: arithmeticStructure.operandA,
          operandB: arithmeticStructure.operandB,
          answer: numericAnswerText,
          answerDigits: Math.max(1, String(numericAnswerText || "").replace(/\D/g, "").length),
          visualMode: "none"
        }
      };
    }
  }

  if ((qLower.includes("trace") || qLower.includes("draw") || qLower.includes("write")) && Number.isInteger(numericAnswer)) {
    return {
      type: "number-tracing",
      config: {
        targetNumber: Math.max(0, Math.min(100, numericAnswer)),
        prompt: question,
        prepMode: true,
        showQuantityDots: true,
        showInstructions: false
      }
    };
  }

  const hasOrderingCue = /\b(move|drag|arrange|reorder|put)\b.*\b(order|sequence|ascending|descending)\b|\b(order|sequence)\b.*\b(move|drag|arrange|reorder|put)\b|\bmove the numbers in order\b/i.test(
    [question, row && row.questionType ? row.questionType : "", row && row.category ? row.category : "", row && row.subcategory ? row.subcategory : ""].join(" ")
  );
  const nextMatch = question.match(/what comes next\?\s*(\d+)\s*,\s*(\d+)\s*,\s*__/i);
  if (normalizedTemplateType === "number-ordering" && hasOrderingCue && nextMatch) {
    const left = Number.parseInt(nextMatch[1], 10);
    const right = Number.parseInt(nextMatch[2], 10);
    const cards = [left, right, right + 1, right + 2];
    return {
      type: "number-ordering",
      config: {
        prompt: question,
        direction: "ascending",
        cards,
        correctOrder: cards.slice().sort((a, b) => a - b)
      }
    };
  }

  if ((qLower.includes("how many") || qLower.includes("which number matches")) && Number.isInteger(numericAnswer)) {
    return {
      type: "icon-count",
      config: {
        prompt: question,
        totalCount: Math.max(0, Math.min(20, numericAnswer)),
        iconShape: "circle",
        groups: [Math.max(0, Math.min(20, numericAnswer))]
      }
    };
  }

  return null;
}

function normalizeImportedRows(rawRows) {
  const normalized = [];
  rawRows.forEach((sourceRow, idx) => {
    if (!sourceRow || typeof sourceRow !== "object") return;

    const mapped = {
      grade: "",
      module: "",
      lessonPart: "",
      lessonName: "",
      category: "",
      subcategory: "",
      qNo: idx + 1,
      questionType: "",
      question: "",
      compute: "",
      learningOutcome: "",
      options: []
    };

    Object.keys(sourceRow).forEach((rawKey) => {
      const mappedKey = resolveImportColumnKey(normalizeImportHeader(rawKey));
      if (!mappedKey) return;
      const rawValue = sourceRow[rawKey];
      if (mappedKey === "options") {
        mapped.options = parseImportOptions(rawValue);
      } else if (mappedKey === "qNo") {
        const parsed = Number.parseInt(String(rawValue || "").trim(), 10);
        mapped.qNo = Number.isInteger(parsed) ? parsed : mapped.qNo;
      } else {
        mapped[mappedKey] = String(rawValue || "").trim();
      }
    });

    mapped.grade = normalizeImportGradeName(mapped.grade);

    if (!mapped.grade || !mapped.lessonPart || !mapped.question) return;
    normalized.push(mapped);
  });
  return normalized;
}

function scoreImportHeaderRow(cells) {
  if (!Array.isArray(cells) || cells.length === 0) {
    return { score: 0, mappedKeys: [] };
  }

  const mappedKeys = cells
    .map((cell) => resolveImportColumnKey(normalizeImportHeader(cell)))
    .filter((key) => key !== "");
  const uniqueMapped = Array.from(new Set(mappedKeys));
  const required = ["grade", "lessonPart", "question"];
  const hasAllRequired = required.every((key) => uniqueMapped.includes(key));

  return {
    score: uniqueMapped.length + (hasAllRequired ? 10 : 0),
    mappedKeys: uniqueMapped
  };
}

function buildObjectsFromAoa(aoa, headerRowIndex) {
  const rows = [];
  const headerCells = Array.isArray(aoa[headerRowIndex]) ? aoa[headerRowIndex] : [];
  const headerMap = headerCells.map((cell) => String(cell || "").trim());

  for (let rowIndex = headerRowIndex + 1; rowIndex < aoa.length; rowIndex += 1) {
    const row = Array.isArray(aoa[rowIndex]) ? aoa[rowIndex] : [];
    const item = {};
    let hasValue = false;

    for (let col = 0; col < headerMap.length; col += 1) {
      const key = headerMap[col];
      if (!key) continue;
      const value = String(row[col] || "").trim();
      item[key] = value;
      if (value !== "") hasValue = true;
    }

    if (hasValue) {
      rows.push(item);
    }
  }

  return rows;
}

function findBestImportTable(workbook) {
  const sheetNames = Array.isArray(workbook && workbook.SheetNames) ? workbook.SheetNames : [];
  let bestCandidate = null;

  sheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return;

    const aoa = window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false, blankrows: false });
    if (!Array.isArray(aoa) || aoa.length === 0) return;

    const scanLimit = Math.min(aoa.length, 40);
    for (let i = 0; i < scanLimit; i += 1) {
      const cells = Array.isArray(aoa[i]) ? aoa[i] : [];
      const scored = scoreImportHeaderRow(cells);
      if (!bestCandidate || scored.score > bestCandidate.score) {
        bestCandidate = {
          score: scored.score,
          mappedKeys: scored.mappedKeys,
          headerRowIndex: i,
          sheetName,
          aoa
        };
      }
    }
  });

  return bestCandidate;
}

function parseImportFileToRows(file, workbook) {
  const best = findBestImportTable(workbook);
  if (!best) throw new Error("No sheet found in workbook.");

  const { aoa, sheetName, headerRowIndex, mappedKeys } = best;
  const rawRows = buildObjectsFromAoa(aoa, headerRowIndex);
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    throw new Error(`No data rows found in ${file.name} (sheet: ${sheetName}).`);
  }

  const normalizedRows = normalizeImportedRows(rawRows);
  if (normalizedRows.length > 0) {
    return normalizedRows;
  }

  const firstRow = rawRows[0] && typeof rawRows[0] === "object" ? rawRows[0] : {};
  const headerKeys = Object.keys(firstRow);
  const expected = "Grade, Module, Lesson Part, Lesson Name, Q No, Question Type, Question";
  const detectedHeaders = headerKeys.length > 0 ? headerKeys.join(", ") : "(none)";
  const detectedMapped = mappedKeys.length > 0 ? mappedKeys.join(", ") : "(none)";

  throw new Error(
    `No valid import rows after normalization. Expected columns include: ${expected}. Detected headers: ${detectedHeaders}. Mapped fields: ${detectedMapped}. Sheet: ${sheetName}. Header row: ${headerRowIndex + 1}.`
  );
}

async function readSpreadsheetRows(file) {
  if (!file) throw new Error("No file selected.");
  if (!window.XLSX) throw new Error("Spreadsheet parser not loaded. Refresh and try again.");
  const lowerName = String(file.name || "").toLowerCase();

  if (lowerName.endsWith(".csv")) {
    const text = await file.text();
    const workbook = window.XLSX.read(text, { type: "string" });
    return parseImportFileToRows(file, workbook);
  }

  if (lowerName.endsWith(".xlsx") || lowerName.endsWith(".xls")) {
    const buffer = await file.arrayBuffer();
    const workbook = window.XLSX.read(buffer, { type: "array" });
    return parseImportFileToRows(file, workbook);
  }

  throw new Error("Unsupported file type. Use .xlsx, .xls, or .csv.");
}

function validateImportedRows(rows) {
  const issues = [];
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      errors: 0,
      warnings: 0,
      issues: []
    };
  }

  const seenQNoByModule = new Map();
  const qNoFirstRowByModule = new Map();
  const seenQuestionByModule = new Map();
  const qNoListByModule = new Map();
  const firstRowByModule = new Map();

  rows.forEach((row, rowIndex) => {
    const grade = String(row.grade || "").trim();
    const lessonPart = String(row.lessonPart || "").trim();
    const qNo = Number.parseInt(String(row.qNo || ""), 10);
    const question = String(row.question || "").trim();
    const questionType = String(row.questionType || "").trim().toLowerCase();
    const options = Array.isArray(row.options) ? row.options.filter((item) => String(item || "").trim() !== "") : [];
    const moduleKey = `${grade}::${lessonPart}`;

    if (!firstRowByModule.has(moduleKey)) {
      firstRowByModule.set(moduleKey, rowIndex);
    }

    if (!Number.isInteger(qNo) || qNo <= 0) {
      issues.push({ level: "error", grade, lessonPart, qNo: row.qNo || "", rowIndex, message: "Q No must be a positive whole number." });
    }

    if (question === "") {
      issues.push({ level: "error", grade, lessonPart, qNo: row.qNo || "", rowIndex, message: "Question text is required." });
    }

    if (!String(row.lessonName || "").trim()) {
      issues.push({ level: "warning", grade, lessonPart, qNo: row.qNo || "", rowIndex, message: "Lesson Name is blank." });
    }

    if (!String(row.learningOutcome || "").trim()) {
      issues.push({ level: "warning", grade, lessonPart, qNo: row.qNo || "", rowIndex, message: "Learning Outcome is blank." });
    }

    if (!String(row.category || "").trim()) {
      issues.push({ level: "warning", grade, lessonPart, qNo: row.qNo || "", rowIndex, message: "Category is blank." });
    }

    if (!String(row.subcategory || "").trim()) {
      issues.push({ level: "warning", grade, lessonPart, qNo: row.qNo || "", rowIndex, message: "Subcategory is blank." });
    }

    const detectedTemplateType = inferTemplateTypeFromImportRow(row);
    const inferredType = inferResultTypeFromImport(questionType, options, question, detectedTemplateType);
    const knownType = ["multiple-choice", "checkbox", "true-false", "short-answer", "matching", "ordering"].includes(inferredType);
    if (!knownType) {
      issues.push({ level: "warning", grade, lessonPart, qNo: row.qNo || "", rowIndex, message: `Unknown question type: ${row.questionType || "(blank)"}.` });
    }

    if (["multiple-choice", "checkbox"].includes(inferredType) && options.length < 2) {
      issues.push({ level: "error", grade, lessonPart, qNo: row.qNo || "", rowIndex, message: "At least 2 options are required for multiple-choice or checkbox questions." });
    }

    if (Number.isInteger(qNo) && qNo > 0) {
      if (!seenQNoByModule.has(moduleKey)) {
        seenQNoByModule.set(moduleKey, new Map());
      }
      if (!qNoFirstRowByModule.has(moduleKey)) {
        qNoFirstRowByModule.set(moduleKey, new Map());
      }
      const qNoMap = seenQNoByModule.get(moduleKey);
      const qNoFirstMap = qNoFirstRowByModule.get(moduleKey);
      const existingCount = qNoMap.get(qNo) || 0;
      qNoMap.set(qNo, existingCount + 1);
      if (!qNoFirstMap.has(qNo)) {
        qNoFirstMap.set(qNo, rowIndex);
      }

      if (!qNoListByModule.has(moduleKey)) {
        qNoListByModule.set(moduleKey, []);
      }
      qNoListByModule.get(moduleKey).push(qNo);
    }

    const questionKey = normalizeWhitespace(question).toLowerCase();
    if (questionKey) {
      if (!seenQuestionByModule.has(moduleKey)) {
        seenQuestionByModule.set(moduleKey, new Set());
      }
      const set = seenQuestionByModule.get(moduleKey);
      if (set.has(questionKey)) {
        issues.push({ level: "warning", grade, lessonPart, qNo: row.qNo || "", rowIndex, message: "Duplicate question text in the same module." });
      } else {
        set.add(questionKey);
      }
    }
  });

  seenQNoByModule.forEach((qNoMap, moduleKey) => {
    const [grade, lessonPart] = moduleKey.split("::");
    const qNoFirstMap = qNoFirstRowByModule.get(moduleKey) || new Map();
    qNoMap.forEach((count, qNo) => {
      if (count > 1) {
        issues.push({
          level: "error",
          grade,
          lessonPart,
          qNo,
          rowIndex: qNoFirstMap.has(qNo) ? qNoFirstMap.get(qNo) : -1,
          message: `Duplicate Q No ${qNo} in the same module.`
        });
      }
    });
  });

  qNoListByModule.forEach((list, moduleKey) => {
    const uniqueSorted = Array.from(new Set(list)).sort((a, b) => a - b);
    if (uniqueSorted.length <= 1) return;
    const [grade, lessonPart] = moduleKey.split("::");
    for (let i = 1; i < uniqueSorted.length; i += 1) {
      if (uniqueSorted[i] !== uniqueSorted[i - 1] + 1) {
        issues.push({
          level: "warning",
          grade,
          lessonPart,
          qNo: "",
          rowIndex: firstRowByModule.has(moduleKey) ? firstRowByModule.get(moduleKey) : -1,
          message: "Q No sequence has gaps."
        });
        break;
      }
    }
  });

  const errors = issues.filter((item) => item.level === "error").length;
  const warnings = issues.filter((item) => item.level === "warning").length;
  return { errors, warnings, issues };
}

function focusImportPreviewRow(rowIndex) {
  const previewBody = document.getElementById("importPreviewBody");
  if (!(previewBody instanceof HTMLElement)) return;

  const target = previewBody.querySelector(`tr[data-row-index="${rowIndex}"]`);
  if (!(target instanceof HTMLElement)) {
    showToast("Could not locate that preview row.", "warning");
    return;
  }

  previewBody.querySelectorAll("tr[data-row-index]").forEach((row) => {
    if (row instanceof HTMLElement) {
      row.style.outline = "";
      row.style.background = "";
    }
  });

  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.style.outline = "2px solid #1f6feb";
  target.style.background = "#eaf3ff";

  window.setTimeout(() => {
    target.style.outline = "";
    target.style.background = "";
  }, 2400);
}

function splitAnswerTokens(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function normalizeResultValidationFilter(value) {
  const filter = String(value || "all").trim().toLowerCase();
  if (filter === "red" || filter === "green") return filter;
  return "all";
}

function normalizeResultValidationIssueFilter(value) {
  const filter = String(value || "all").trim().toLowerCase();
  if (["missing-solutions", "answer-mismatches", "option-type-issues", "interactive-issues"].includes(filter)) {
    return filter;
  }
  return "all";
}

function isViewerCompatibilityIssue(message) {
  const text = String(message || "").toLowerCase();
  return text.startsWith("viewer compatibility:") || text.includes("viewer answer validation");
}

function classifyResultValidationIssueType(message) {
  const text = String(message || "").toLowerCase();
  if (text.includes("solution text is empty") || text.includes("solution mismatch")) {
    return "missing-solutions";
  }
  if (text.includes("computed answer mismatch") || text.includes("stored answer differs") || text.includes("correct answer")) {
    return "answer-mismatches";
  }
  if (text.includes("option") || text.includes("result type") || text.includes("checkbox") || text.includes("contradict") || text.includes("wording")) {
    return "option-type-issues";
  }
  if (text.includes("interactive") || text.includes("cartesian") || text.includes("plot payload") || text.includes("verification failed")) {
    return "interactive-issues";
  }
  return "other";
}

function normalizeNounStem(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  if (text.endsWith("ies") && text.length > 3) return `${text.slice(0, -3)}y`;
  if (text.endsWith("es") && text.length > 2) return text.slice(0, -2);
  if (text.endsWith("s") && text.length > 1) return text.slice(0, -1);
  return text;
}

function getQuestionSenseIssues(question) {
  const issues = [];
  const questionText = normalizeWhitespace(String(question && question.question || "")).toLowerCase();
  if (!questionText) return issues;

  const countPromptMatch = questionText.match(/how\s+many\s+([a-z][a-z\s-]{0,30}?)(?:\?|\.|,|$)/i);
  const noStatementMatches = Array.from(questionText.matchAll(/\bno\s+([a-z][a-z\s-]{0,30}?)(?:\.|,|;|\?|$)/gi));

  if (countPromptMatch && noStatementMatches.length > 0) {
    const askedObject = normalizeNounStem(countPromptMatch[1]);
    const contradicts = noStatementMatches.some((match) => {
      const statedObject = normalizeNounStem(match[1]);
      return statedObject && askedObject && (statedObject === askedObject || askedObject.includes(statedObject) || statedObject.includes(askedObject));
    });

    if (contradicts) {
      const answerValue = String(question && question.correctAnswer || "").trim();
      const answerNumber = Number.parseFloat(answerValue);
      if (Number.isFinite(answerNumber) && answerNumber !== 0) {
        issues.push("Question may not make sense: it says there are no items, but answer is not 0.");
      } else {
        issues.push("Question wording may be contradictory: it says no items, then asks to count the same items.");
      }
    }
  }

  return issues;
}

function normalizeGradeCategoryFromName(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "prep") return "prep";
  const gradeMatch = raw.match(/grade\s*([1-6])/i);
  if (gradeMatch) {
    return `grade-${gradeMatch[1]}`;
  }
  return "";
}

function getGradeLanguageIssues(question, categoryName) {
  const issues = [];
  const gradeKey = normalizeGradeCategoryFromName(categoryName);
  const text = normalizeWhitespace(String(question && question.question || "")).toLowerCase();
  if (!text || !gradeKey) return issues;

  const restrictedWordsByGrade = {
    prep: ["estimate", "determine", "evaluate", "approximate", "justify", "infer", "analyze"],
    "grade-1": ["determine", "evaluate", "approximate", "justify", "analyze"],
    "grade-2": ["evaluate", "approximate", "justify", "analyze"]
  };

  const restrictedWords = restrictedWordsByGrade[gradeKey] || [];
  if (restrictedWords.length === 0) return issues;

  const hits = restrictedWords.filter((word) => new RegExp(`\\b${word}\\b`, "i").test(text));
  if (hits.length > 0) {
    issues.push(`Grade language may be too advanced for ${String(categoryName || gradeKey)}: ${hits.join(", ")}.`);
  }

  return issues;
}

function rowMatchesResultValidationIssueFilter(row, issueFilter) {
  const normalizedFilter = normalizeResultValidationIssueFilter(issueFilter);
  if (normalizedFilter === "all") return true;
  const issues = Array.isArray(row && row.issues) ? row.issues : [];
  return issues.some((message) => classifyResultValidationIssueType(message) === normalizedFilter);
}

function getFilteredResultValidationRows(validation) {
  if (!validation || !Array.isArray(validation.rows)) return [];
  const statusFilter = normalizeResultValidationFilter(pendingResultValidationFilter);
  const issueFilter = normalizeResultValidationIssueFilter(pendingResultValidationIssueFilter);

  const statusFiltered = validation.rows.filter((row) => {
    if (statusFilter === "red") {
      return !row.isValid;
    }
    if (statusFilter === "green") {
      return row.isValid;
    }
    return true;
  });

  if (issueFilter === "all") {
    return statusFiltered;
  }

  return statusFiltered.filter((row) => rowMatchesResultValidationIssueFilter(row, issueFilter));
}

function buildResultValidationIssueSummary(validation) {
  const summary = {
    missingSolutions: 0,
    answerMismatches: 0,
    optionTypeIssues: 0,
    interactiveIssues: 0
  };

  const rows = validation && Array.isArray(validation.rows) ? validation.rows : [];
  rows.forEach((row) => {
    const issues = Array.isArray(row && row.issues) ? row.issues : [];
    issues.forEach((message) => {
      const issueType = classifyResultValidationIssueType(message);
      if (issueType === "missing-solutions") {
        summary.missingSolutions += 1;
      }
      if (issueType === "answer-mismatches") {
        summary.answerMismatches += 1;
      }
      if (issueType === "option-type-issues") {
        summary.optionTypeIssues += 1;
      }
      if (issueType === "interactive-issues") {
        summary.interactiveIssues += 1;
      }
    });
  });

  return summary;
}

function renderResultValidationSummary(validation) {
  const missing = document.getElementById("summaryMissingSolutions");
  const mismatches = document.getElementById("summaryAnswerMismatches");
  const optionType = document.getElementById("summaryOptionTypeIssues");
  const interactive = document.getElementById("summaryInteractiveIssues");
  if (!(missing instanceof HTMLElement)
    || !(mismatches instanceof HTMLElement)
    || !(optionType instanceof HTMLElement)
    || !(interactive instanceof HTMLElement)) return;

  const summary = buildResultValidationIssueSummary(validation);
  missing.textContent = String(summary.missingSolutions);
  mismatches.textContent = String(summary.answerMismatches);
  optionType.textContent = String(summary.optionTypeIssues);
  interactive.textContent = String(summary.interactiveIssues);

  const cardMap = [
    { id: "summaryCardMissingSolutions", filter: "missing-solutions" },
    { id: "summaryCardAnswerMismatches", filter: "answer-mismatches" },
    { id: "summaryCardOptionTypeIssues", filter: "option-type-issues" },
    { id: "summaryCardInteractiveIssues", filter: "interactive-issues" }
  ];

  const activeFilter = normalizeResultValidationIssueFilter(pendingResultValidationIssueFilter);
  cardMap.forEach((item) => {
    const card = document.getElementById(item.id);
    if (!(card instanceof HTMLElement)) return;
    const isActive = activeFilter === item.filter;
    card.style.boxShadow = isActive ? "inset 0 0 0 2px #1f6feb" : "";
    card.style.background = isActive ? "#eaf3ff" : "#fff";
  });
}

function compareAnswersForResultType(resultType, actualValue, expectedValue) {
  const normalizedType = normalizeResultType(resultType || "short-answer");
  const actual = String(actualValue || "").trim();
  const expected = String(expectedValue || "").trim();

  if (!expected) {
    return false;
  }

  if (normalizedType === "checkbox") {
    const actualSet = new Set(splitAnswerTokens(actual).map((item) => normalizeText(item)));
    const expectedSet = new Set(splitAnswerTokens(expected).map((item) => normalizeText(item)));
    if (actualSet.size !== expectedSet.size) return false;
    for (const token of expectedSet) {
      if (!actualSet.has(token)) return false;
    }
    return true;
  }

  return normalizeText(actual) === normalizeText(expected);
}

function computeExpectedAnswerForQuestion(question) {
  if (!question || typeof question !== "object") {
    return { value: "", source: "none" };
  }

  const app = question.interactiveApp;
  if (app && typeof app === "object" && app.type) {
    const computed = buildDeterministicPayloadFromInteractiveApp(
      String(app.type || "").trim(),
      app,
      question.resultType || "short-answer",
      { answerPolicy: "auto", decimalPlaces: 2 }
    );
    if (computed && String(computed.correctAnswer || "").trim()) {
      return {
        value: String(computed.correctAnswer || "").trim(),
        source: "interactive-app"
      };
    }
  }

  if (normalizeResultType(question.resultType) === "short-answer") {
    const arithmeticExpected = extractArithmeticExpectedAnswer(question.question || "");
    if (Number.isFinite(arithmeticExpected)) {
      return {
        value: String(roundTo(arithmeticExpected, 2)),
        source: "question-compute"
      };
    }
  }

  // Fallback heuristic for imported content when no deterministic app compute exists.
  const importLikeRow = {
    question: String(question.question || "").trim(),
    questionType: String(question.resultType || "").trim(),
    options: Array.isArray(question.options) ? question.options.slice() : [],
    category: String(question.category || "").trim(),
    subcategory: String(question.subcategory || "").trim(),
    lessonPart: "",
    lessonName: "",
    module: ""
  };
  const detectedTemplateType = inferTemplateTypeFromImportRow(importLikeRow);
  const inferred = inferAnswerFromImportRow(importLikeRow, detectedTemplateType);
  if (inferred && String(inferred.correctAnswer || "").trim()) {
    return {
      value: String(inferred.correctAnswer || "").trim(),
      source: "heuristic-text"
    };
  }

  return { value: "", source: "none" };
}

function inferImportSubcategoryFromTemplateType(templateType, questionText = "") {
  const normalized = String(templateType || "").trim().toLowerCase();
  const q = String(questionText || "").trim().toLowerCase();

  if (normalized === "cartesian-plane" || normalized === "cartesian-plane-plot") {
    if (q.includes("quadrant")) return "quadrant-identification";
    if (q.includes("point") || /\((-?\d+)\s*,\s*(-?\d+)\)/.test(q)) return "point-on-axes";
    return "linear";
  }
  if (normalized === "number-line") return "linear";
  if (normalized === "time") {
    if (q.includes("analog")) return "analog";
    if (q.includes("digital")) return "digital";
    return "digital";
  }
  if (normalized === "fractions") return "fractions";
  if (normalized === "number-tracing") return "number-tracing";
  if (normalized === "number-ordering") return "ordering";
  if (normalized === "icon-count") return "counting";
  if (normalized === "arithmetic-long-division") return "division-long";
  if (normalized === "arithmetic") {
    const structure = inferArithmeticStructureFromImportRow({ question: q, questionType: q, category: "", subcategory: "" });
    if (structure && structure.operator === "/") return "division-short";
    if (structure && structure.operator === "x") return "basic-multiplication";
    if (structure && structure.operator === "-") return "basic-subtraction";
    if (structure && structure.operator === "+") return "basic-addition-h";
    return "basic-addition-h";
  }
  return "";
}

function inferValidationCategorySubcategory(question) {
  const rowLike = {
    question: String(question && question.question || "").trim(),
    questionType: String(question && question.resultType || "").trim(),
    category: String(question && question.category || "").trim(),
    subcategory: String(question && question.subcategory || "").trim(),
    lessonPart: "",
    lessonName: "",
    module: ""
  };

  const templateType = inferTemplateTypeFromImportRow(rowLike);
  const suggestedCategory = inferImportCategoryFromTemplateType(templateType);
  const suggestedSubcategory = inferImportSubcategoryFromTemplateType(templateType, rowLike.question);

  return {
    templateType,
    suggestedCategory,
    suggestedSubcategory
  };
}

function inferValidationTemplateTypeFromQuestion(question) {
  const categoryText = String(question && question.category || "").trim().toLowerCase();
  const subcategoryText = String(question && question.subcategory || "").trim().toLowerCase();
  const combined = `${categoryText} ${subcategoryText}`;

  if (combined.includes("number-tracing") || combined.includes("tracing") || combined.includes("trace")) {
    return "number-tracing";
  }
  if (combined.includes("number-ordering") || combined.includes("ordering")) {
    return "number-ordering";
  }
  if (combined.includes("icon-count") || combined.includes("counting")) {
    return "icon-count";
  }
  if (combined.includes("cartesian") || combined.includes("coordinate") || combined.includes("quadrant")) {
    return "cartesian-plane";
  }

  return "";
}

function buildValidationInteractiveApp(question) {
  if (question && question.interactiveApp && typeof question.interactiveApp === "object" && question.interactiveApp.type) {
    return JSON.parse(JSON.stringify(question.interactiveApp));
  }

  const importLikeRow = {
    question: String(question && question.question || "").trim(),
    questionType: String(question && question.resultType || "").trim(),
    category: String(question && question.category || "").trim(),
    subcategory: String(question && question.subcategory || "").trim(),
    lessonPart: "",
    lessonName: "",
    module: "",
    options: Array.isArray(question && question.options) ? question.options : []
  };

  const inferredFromQuestion = inferTemplateTypeFromImportRow(importLikeRow);
  const inferredFromMetadata = inferValidationTemplateTypeFromQuestion(question || {});
  const templateType = inferredFromQuestion || inferredFromMetadata;
  if (!templateType) return null;

  const answer = String(question && question.correctAnswer || "").trim();
  const app = buildInteractiveAppFromImport(importLikeRow, answer, templateType);
  return app && typeof app === "object" ? app : null;
}

function extractDeclaredAnswerFromSolution(solutionText) {
  const raw = String(solutionText || "").trim();
  if (!raw) return "";

  const patterns = [
    /correct\s+selection\s+is\s*:?\s*([^.!\n\r]+)/i,
    /correct\s+answer\s+is\s*:?\s*([^.!\n\r]+)/i,
    /answer\s+is\s*:?\s*([^.!\n\r]+)/i
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match && match[1]) {
      return String(match[1]).trim();
    }
  }

  return "";
}

function buildResultValidationViewerPayload(question, questionIndex, interactiveAppOverride = null) {
  if (!question || typeof question !== "object") return "";
  const quiz = activeQuiz();
  const safeQuestion = JSON.parse(JSON.stringify(question));
  if (interactiveAppOverride && typeof interactiveAppOverride === "object") {
    safeQuestion.interactiveApp = JSON.parse(JSON.stringify(interactiveAppOverride));
  }
  return {
    title: `Validation Preview (Q${questionIndex + 1})`,
    description: "Learner runtime preview from Result Validation.",
    settings: quiz && quiz.settings && typeof quiz.settings === "object"
      ? JSON.parse(JSON.stringify(quiz.settings))
      : {},
    questions: [safeQuestion]
  };
}

function renderResultValidationDetail(questionIndex) {
  const meta = document.getElementById("resultValidationPreviewMeta");
  const card = document.getElementById("resultValidationPreviewCard");
  const fixMeta = document.getElementById("resultValidationFixMeta");
  const fixList = document.getElementById("resultValidationFixList");
  const applyBtn = document.getElementById("applyResultValidationFixBtn");
  const saveQuestionBtn = document.getElementById("saveResultValidationQuestionBtn");
  if (!(meta instanceof HTMLElement)
    || !(card instanceof HTMLElement)
    || !(fixMeta instanceof HTMLElement)
    || !(fixList instanceof HTMLElement)
    || !(applyBtn instanceof HTMLButtonElement)
    || !(saveQuestionBtn instanceof HTMLButtonElement)) return;

  if (!pendingResultValidation || !Array.isArray(pendingResultValidation.rows)) {
    meta.textContent = "Select a row to preview the question.";
    card.innerHTML = "";
    fixMeta.textContent = "No fix proposal yet.";
    fixList.innerHTML = "";
    applyBtn.disabled = true;
    applyBtn.dataset.questionIndex = "";
    applyBtn.textContent = "Yes, Apply Proposed Update";
    saveQuestionBtn.disabled = true;
    saveQuestionBtn.dataset.questionIndex = "";
    return;
  }

  const row = pendingResultValidation.rows.find((item) => item.index === questionIndex) || null;
  const quiz = activeQuiz();
  const question = quiz && Array.isArray(quiz.questions) ? (quiz.questions[questionIndex] || null) : null;
  if (!row || !question) {
    meta.textContent = "Select a row to preview the question.";
    card.innerHTML = "";
    fixMeta.textContent = "No fix proposal yet.";
    fixList.innerHTML = "";
    applyBtn.disabled = true;
    applyBtn.dataset.questionIndex = "";
    applyBtn.textContent = "Yes, Apply Proposed Update";
    saveQuestionBtn.disabled = true;
    saveQuestionBtn.dataset.questionIndex = "";
    pendingResultValidationSelectedIndex = -1;
    return;
  }

  pendingResultValidationSelectedIndex = questionIndex;
  const statusText = row.isValid ? "GREEN (valid)" : "RED (issue found)";
  const viewerCompatibilityText = row.hasViewerCompatibilityIssue
    ? `Needs fix (${row.viewerCompatibilityIssueCount} issue${row.viewerCompatibilityIssueCount === 1 ? "" : "s"})`
    : "Compatible";
  const options = Array.isArray(question.options)
    ? question.options.map((item) => String(item || "").trim()).filter((item) => item !== "")
    : [];
  const app = buildValidationInteractiveApp(question);
  const appType = app && app.type ? String(app.type) : "None";
  const hasInteractiveAnswerMode = Boolean(app && app.type);
  const interactiveMarkup = app ? buildInteractiveAppMarkup(app, { questionText: String(question && question.question || "") }) : "";
  const viewerRuntimePayload = app ? buildResultValidationViewerPayload(question, questionIndex, app) : null;
  const solutionAttachments = normalizeSolutionAttachments(question && question.solutionAttachments);
  const currentSolutionText = String(question && question.solution || "").trim();
  const questionImage = String(question && question.image || "").trim();
  const resultFeedback = row.isValid
    ? "Answer, solution, and structure are consistent."
    : row.issues.join(" | ");

  const optionListMarkup = options.length > 0
    ? `<div style="display:grid; gap:6px; margin-top:6px;">${options.map((optionText, index) => {
      const isMatch = compareAnswersForResultType(row.resultType, optionText, row.correctAnswer);
      return `<div style="display:flex; align-items:center; gap:8px; padding:6px 8px; border:1px solid #e5eaf3; border-radius:8px; background:${isMatch ? "#f0fdf4" : "#fff"};"><span style="font-size:0.85rem; color:#64748b;">${index + 1}.</span><span>${escapeInteractiveHtml(optionText)}</span></div>`;
    }).join("")}</div>`
    : "<p class='helper-text' style='margin:6px 0 0 0;'>No fixed options (free input question).</p>";

  const effectiveAnswerModeMarkup = hasInteractiveAnswerMode
    ? "<p class='helper-text' style='margin:6px 0 0 0;'>Interactive answer mode is active for this question. The learner answers using the interactive panel below.</p>"
    : optionListMarkup;

  const solutionAttachmentMarkup = solutionAttachments.length > 0
    ? `<div style="display:grid; gap:6px; margin-top:6px;">${solutionAttachments.map((item) => {
      const url = String(item.url || "").trim();
      const name = String(item.name || "Attachment").trim() || "Attachment";
      const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(url) || /^data:image\//i.test(url);
      if (isImage) {
        return `<figure style="margin:0; border:1px solid #e5eaf3; border-radius:8px; padding:8px; background:#fff;"><figcaption style="font-size:0.85rem; color:#334155; margin-bottom:6px;">${escapeInteractiveHtml(name)}</figcaption><img src="${escapeInteractiveHtml(url)}" alt="${escapeInteractiveHtml(name)}" style="max-width:100%; border-radius:6px;" /></figure>`;
      }
      return `<a href="${escapeInteractiveHtml(url)}" target="_blank" rel="noopener noreferrer" style="display:block; padding:8px; border:1px solid #e5eaf3; border-radius:8px; text-decoration:none; color:#0f172a; background:#fff;">${escapeInteractiveHtml(name)}</a>`;
    }).join("")}</div>`
    : "<p class='helper-text' style='margin:6px 0 0 0;'>No solution attachments.</p>";

  card.innerHTML = `
    <div style="margin-bottom:8px;"><strong>Status:</strong> ${escapeInteractiveHtml(statusText)}</div>
    <div style="border:1px solid #e5eaf3; border-radius:10px; padding:10px; margin-bottom:10px; background:#fff;">
      <p style="margin:0 0 6px 0; font-weight:700; color:#1e293b;">Learner Question View</p>
      <div style="margin-bottom:8px;"><strong>Question:</strong><br>${escapeInteractiveHtml(String(question.question || "")).replace(/\n/g, "<br>")}</div>
      <div style="margin-bottom:8px; border:1px solid #e5eaf3; border-radius:8px; padding:8px; background:#f8fbff;">
        <p style="margin:0 0 6px 0; font-weight:700; color:#1e293b;">Edit Question (Inline)</p>
        <div style="display:flex; gap:8px; align-items:center; margin-bottom:6px;">
          <button class="btn secondary small" type="button" data-validator-edit-action="start">Edit Question</button>
          <button class="btn secondary small" type="button" data-validator-edit-action="cancel" style="display:none;">Cancel</button>
        </div>
        <textarea id="resultValidationQuestionEditor" data-original-question="${escapeInteractiveHtml(String(question.question || ""))}" readonly style="width:100%; min-height:84px; border:1px solid #cbd5e1; border-radius:8px; padding:8px; font:inherit; box-sizing:border-box; background:#f8fafc;">${escapeInteractiveHtml(String(question.question || ""))}</textarea>
      </div>
      ${questionImage ? `<div style="margin-bottom:8px;"><img src="${escapeInteractiveHtml(questionImage)}" alt="Question visual" style="max-width:100%; border-radius:8px; border:1px solid #e5eaf3;" /></div>` : ""}
      ${effectiveAnswerModeMarkup}
      ${interactiveMarkup ? `<div style="margin-top:8px;"><strong>${escapeInteractiveHtml(appType === "None" ? "Interactive" : `Interactive: ${appType}`)}</strong><div style="margin-top:6px; border:1px solid #e5eaf3; border-radius:8px; padding:8px; background:#fff;">${interactiveMarkup}</div></div>` : ""}
      ${viewerRuntimePayload ? `
        <div style="margin-top:10px; border:1px solid #d9e3f0; border-radius:10px; padding:8px; background:#f8fbff;">
          <p style="margin:0 0 8px 0; font-weight:700; color:#1e293b;">Learner Runtime (Live Interactive)</p>
          <p class="helper-text" style="margin:0 0 8px 0;">This runs the same viewer runtime as learners. Use Check Answer inside the frame.</p>
          <iframe
            src="viewer.html?mode=validation"
            data-role="result-validation-viewer"
            title="Learner runtime preview"
            style="width:100%; min-height:560px; border:1px solid #dbe5f1; border-radius:8px; background:#fff;"
          ></iframe>
        </div>
      ` : ""}
    </div>
    <div style="border:1px solid #e5eaf3; border-radius:10px; padding:10px; margin-bottom:10px; background:${row.isValid ? "#ecfdf3" : "#fff1f1"};">
      <p style="margin:0 0 6px 0; font-weight:700; color:#1e293b;">Learner Result View</p>
      <div style="margin-bottom:6px;"><strong>Your Answer:</strong> ${escapeInteractiveHtml(String(row.correctAnswer || "(empty)"))}</div>
      <div style="margin-bottom:6px;"><strong>Expected/Computed:</strong> ${escapeInteractiveHtml(String(row.computedAnswer || "-"))}</div>
      <div style="margin-bottom:6px;"><strong>Viewer Compatibility:</strong> ${escapeInteractiveHtml(viewerCompatibilityText)}</div>
      <div><strong>Feedback:</strong> ${escapeInteractiveHtml(resultFeedback)}</div>
    </div>
    <div style="border:1px solid #e5eaf3; border-radius:10px; padding:10px; background:#fff;">
      <p style="margin:0 0 6px 0; font-weight:700; color:#1e293b;">Stored Solution Text</p>
      <p class="helper-text" style="margin:0 0 8px 0;">Type-specific live solution rendering is shown in the Viewer runtime above.</p>
      <div style="margin-bottom:8px;"><strong>Solution:</strong><br>${escapeInteractiveHtml(currentSolutionText).replace(/\n/g, "<br>")}</div>
      <div><strong>Solution Attachments:</strong>${solutionAttachmentMarkup}</div>
    </div>
  `;

  if (viewerRuntimePayload) {
    const frame = card.querySelector("iframe[data-role='result-validation-viewer']");
    if (frame instanceof HTMLIFrameElement) {
      const postPayload = () => {
        if (!frame.contentWindow) return;
        frame.contentWindow.postMessage({
          type: "validation-preview-quiz",
          payload: viewerRuntimePayload
        }, "*");
        window.setTimeout(() => {
          if (!frame.contentWindow) return;
          frame.contentWindow.postMessage({
            type: "validation-preview-open-solution"
          }, "*");
        }, 260);
      };
      frame.addEventListener("load", postPayload, { once: true });
      window.setTimeout(postPayload, 200);
    }
  }

  saveQuestionBtn.disabled = true;
  saveQuestionBtn.dataset.questionIndex = String(questionIndex);
  saveQuestionBtn.dataset.editing = "false";

  const plan = buildResultValidationFixPlan(question, row);
  const renderFixCards = (items, { editable = false } = {}) => (Array.isArray(items) ? items : []).map((change) => {
    const label = escapeInteractiveHtml(change.label || change.field || "Update");
    const before = escapeInteractiveHtml(change.before || "(empty)");
    const after = escapeInteractiveHtml(change.after || "(empty)");
    const field = escapeInteractiveHtml(change.field || "");
    if (!editable) {
      return `
        <div style="border:1px solid #e5eaf3; border-radius:8px; padding:8px; margin-bottom:8px; background:#f8fafc;">
          <div style="font-weight:600; margin-bottom:4px;">${label}</div>
          <div style="font-size:0.9rem; margin-bottom:4px;"><strong>Current:</strong> ${before}</div>
          <div style="font-size:0.9rem;"><strong>Proposed:</strong> ${after}</div>
        </div>
      `;
    }
    return `
      <div style="border:1px solid #e5eaf3; border-radius:8px; padding:8px; margin-bottom:8px; background:#fffaf2;">
        <div style="font-weight:600; margin-bottom:4px;">${label}</div>
        <div style="font-size:0.9rem; margin-bottom:6px;"><strong>Current:</strong> ${before}</div>
        <label style="display:block; font-size:0.85rem; color:#6b7280; margin-bottom:4px;">Edit proposed value</label>
        <textarea
          data-manual-proposal-field="${field}"
          style="width:100%; min-height:64px; border:1px solid #cbd5e1; border-radius:8px; padding:8px; font:inherit; box-sizing:border-box;"
        >${after}</textarea>
      </div>
    `;
  }).join("");

  if (!plan.canApply) {
    const hasManualProposals = Array.isArray(plan.proposals) && plan.proposals.length > 0;
    fixMeta.textContent = row.isValid
      ? "No update needed for this row."
      : hasManualProposals
        ? "Automatic update is not safe here. You can edit the manual proposals below, then click Yes to apply."
        : "No safe automatic update available. Fix manually in editor.";
    const noteList = plan.notes.length > 0
      ? `<ul style="margin:8px 0 0 0; padding-left:18px;">${plan.notes.map((item) => `<li>${escapeInteractiveHtml(item)}</li>`).join("")}</ul>`
      : "";
    fixList.innerHTML = `${renderFixCards(plan.proposals, { editable: true })}${noteList}`;
    applyBtn.disabled = !hasManualProposals;
    applyBtn.dataset.questionIndex = String(questionIndex);
    const manualCount = Array.isArray(plan.proposals) ? plan.proposals.length : 0;
    applyBtn.textContent = manualCount > 0
      ? `Yes, Apply Proposed Update (${manualCount})`
      : "Yes, Apply Proposed Update";
    return;
  }

  fixMeta.textContent = "Proposed update is ready. Click Yes to apply.";
  const changeCards = renderFixCards(plan.changes);
  const manualCards = renderFixCards(plan.proposals);
  const noteList = plan.notes.length > 0
    ? `<ul style="margin:8px 0 0 0; padding-left:18px;">${plan.notes.map((item) => `<li>${escapeInteractiveHtml(item)}</li>`).join("")}</ul>`
    : "";
  fixList.innerHTML = `${changeCards}${manualCards}${noteList}`;
  applyBtn.disabled = false;
  applyBtn.dataset.questionIndex = String(questionIndex);
  const changeCount = Array.isArray(plan.changes) ? plan.changes.length : 0;
  applyBtn.textContent = changeCount > 0
    ? `Yes, Apply Proposed Update (${changeCount})`
    : "Yes, Apply Proposed Update";
}

function getResultValidationManualProposalEdits(questionIndex) {
  const button = document.getElementById("applyResultValidationFixBtn");
  if (!(button instanceof HTMLButtonElement)) return [];
  const selectedIndex = Number.parseInt(button.dataset.questionIndex || "", 10);
  if (!Number.isInteger(selectedIndex) || selectedIndex !== questionIndex) return [];

  const fixList = document.getElementById("resultValidationFixList");
  if (!(fixList instanceof HTMLElement)) return [];

  const editors = Array.from(fixList.querySelectorAll("textarea[data-manual-proposal-field]"));
  return editors
    .map((editor) => {
      if (!(editor instanceof HTMLTextAreaElement)) return null;
      const field = String(editor.dataset.manualProposalField || "").trim();
      const value = String(editor.value || "").trim();
      if (!field) return null;
      return { field, value };
    })
    .filter((item) => item !== null);
}

function detectResultTypeFromValidationContext(question, contextRow = {}) {
  const questionText = String(question && question.question || "").trim();
  const questionLower = questionText.toLowerCase();
  const hasWhichNumberMatchesCue = /\bwhich number matches\b/.test(questionLower);
  const hasSelectionCue = /\b(select|choose|pick|which of the following|choose the correct|select the correct)\b/.test(questionLower) || hasWhichNumberMatchesCue;
  const hasOpenResponseCue = /\b(how many|what is|find|work out|calculate|solve|trace|draw|write|complete)\b/.test(questionLower);
  const options = getChoiceOptions(question);
  const answerValue = String(contextRow && contextRow.correctAnswer != null ? contextRow.correctAnswer : (question && question.correctAnswer) || "").trim();
  const computedValue = String(contextRow && contextRow.computedAnswer != null ? contextRow.computedAnswer : "").trim();
  const moduleType = String(contextRow && contextRow.moduleType || "").trim().toLowerCase();
  const importedCategory = String(contextRow && contextRow.importedCategory || "").trim().toLowerCase();
  const importedSubcategory = String(contextRow && contextRow.importedSubcategory || "").trim().toLowerCase();
  const suggestedCategory = String(contextRow && contextRow.suggestedCategory || "").trim().toLowerCase();
  const suggestedSubcategory = String(contextRow && contextRow.suggestedSubcategory || "").trim().toLowerCase();

  const tokenPool = [moduleType, importedCategory, importedSubcategory, suggestedCategory, suggestedSubcategory, questionLower].join(" ");
  const scores = {
    "multiple-choice": 0,
    "checkbox": 0,
    "true-false": 0,
    "short-answer": 0,
    "plot": 0
  };

  const addScore = (type, value) => {
    if (!Object.prototype.hasOwnProperty.call(scores, type)) return;
    scores[type] += Number(value) || 0;
  };

  if (tokenPool.includes("cartesian-plane-plot") || /\bplot\b/.test(questionLower)) addScore("plot", 1.2);
  if (tokenPool.includes("number-tracing") || /\btrace|draw|write\b/.test(questionLower)) addScore("short-answer", 1.1);
  if (/\bselect all\b/.test(questionLower)) addScore("checkbox", 1.2);
  if (/\btrue\s*\/\s*false\b|\btrue or false\b/.test(questionLower)) addScore("true-false", 1.1);

  if (options.length >= 2) {
    addScore("multiple-choice", 0.12);
    if (hasSelectionCue && !hasOpenResponseCue) addScore("multiple-choice", 0.65);
    if (hasWhichNumberMatchesCue) addScore("multiple-choice", 0.9);
    const answerMatchesChoice = options.some((item) => normalizeText(item) === normalizeText(answerValue));
    if (answerMatchesChoice && hasSelectionCue && !hasOpenResponseCue) addScore("multiple-choice", 0.4);
    if (hasOpenResponseCue && !hasSelectionCue) addScore("short-answer", 0.65);

    const tfOptions = options.map((item) => normalizeText(item));
    if (tfOptions.includes("true") && tfOptions.includes("false")) addScore("true-false", 0.5);
  } else {
    addScore("short-answer", 0.55);
    if (hasWhichNumberMatchesCue) addScore("short-answer", 0.3);
  }

  if (answerValue.includes(",") && options.length >= 2) {
    const answerParts = splitAnswerTokens(answerValue);
    const validMulti = answerParts.length >= 2
      && answerParts.every((item) => options.some((option) => normalizeText(option) === normalizeText(item)));
    if (validMulti) addScore("checkbox", 0.95);
  }

  if (computedValue) {
    const computedLooksAtomic = !computedValue.includes(",") && computedValue.length <= 64;
    const computedMatchesChoice = options.some((item) => normalizeText(item) === normalizeText(computedValue));
    if (computedLooksAtomic && !computedMatchesChoice && !hasSelectionCue) {
      addScore("short-answer", 0.4);
    }
  }

  if (/\b(how many|find|work out|calculate|solve|what is)\b/.test(questionLower)) {
    addScore("short-answer", 0.45);
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const best = ranked[0] || ["short-answer", 0];
  const second = ranked[1] || ["short-answer", 0];
  const margin = Number(best[1]) - Number(second[1]);

  let confidence = Math.min(1, Math.max(0, Number(best[1]) / 1.6));
  if (margin < 0.2) confidence *= 0.68;
  else if (margin < 0.35) confidence *= 0.82;

  return {
    type: String(best[0] || "short-answer"),
    confidence: Number(confidence.toFixed(2))
  };
}

function suggestValidationResultTypeCorrection(question, row) {
  const currentResultType = normalizeResultType(question && question.resultType);
  const expectedFromRow = normalizeResultType(row && row.suggestedResultType);
  const confidence = Number(row && row.suggestedResultTypeConfidence || 0);
  if (expectedFromRow && expectedFromRow !== currentResultType && confidence >= 0.85) {
    return expectedFromRow;
  }

  if (!["multiple-choice", "true-false"].includes(currentResultType)) return "";

  const issueList = Array.isArray(row && row.issues) ? row.issues : [];
  const hasOptionMismatchIssue = issueList.some((item) => /correct answer must match one option exactly/i.test(String(item || "")));
  if (!hasOptionMismatchIssue) return "";

  const questionText = String(question && question.question || "").trim();
  const questionLower = questionText.toLowerCase();
  const answerValue = String(question && question.correctAnswer || "").trim();
  const choiceOptions = getChoiceOptions(question);
  const answerMatchesChoice = choiceOptions.some((item) => normalizeText(item) === normalizeText(answerValue));
  if (answerMatchesChoice) return "";

  const hasSelectionCue = /\b(select|choose|pick|which of the following|which number matches|true\s*or\s*false)\b/.test(questionLower);
  const looksWordedMath = /\b(how many|what is|find|work out|calculate|solve|write|trace|draw|complete)\b/.test(questionLower);
  const hasInteractiveApp = Boolean(question && question.interactiveApp && question.interactiveApp.type);
  const inferredStructure = inferValidationCategorySubcategory(question || {});
  const inferredResultType = inferResultTypeFromImport(currentResultType, choiceOptions, questionText, inferredStructure.templateType);

  if (!hasSelectionCue && (looksWordedMath || hasInteractiveApp || inferredResultType === "short-answer")) {
    return "short-answer";
  }

  return "";
}

function buildResultValidationFixPlan(question, row) {
  const notes = [];
  const updates = {};
  const changes = [];
  const proposals = [];
  const resultType = normalizeResultType(question && question.resultType);
  let nextResultType = resultType;
  const choiceOptions = getChoiceOptions(question);
  let nextAnswer = String(question && question.correctAnswer || "").trim();

  const trackChange = (field, label, beforeValue, afterValue) => {
    const beforeText = String(beforeValue == null ? "" : beforeValue).trim();
    const afterText = String(afterValue == null ? "" : afterValue).trim();
    if (normalizeWhitespace(beforeText) === normalizeWhitespace(afterText)) {
      return;
    }
    changes.push({
      field,
      label,
      before: beforeText,
      after: afterText
    });
  };

  const trackProposal = (field, label, beforeValue, afterValue, noteText) => {
    const beforeText = String(beforeValue == null ? "" : beforeValue).trim();
    const afterText = String(afterValue == null ? "" : afterValue).trim();
    if (!afterText || normalizeWhitespace(beforeText) === normalizeWhitespace(afterText)) {
      return;
    }
    const duplicate = proposals.some((item) => item.field === field
      && normalizeWhitespace(String(item.after || "")) === normalizeWhitespace(afterText));
    if (duplicate) return;
    proposals.push({
      field,
      label,
      before: beforeText,
      after: afterText
    });
    if (noteText) {
      notes.push(noteText);
    }
  };

  const simplifyQuestionForLowerGrades = (text) => {
    const source = String(text || "").trim();
    if (!source) return "";
    const replacements = [
      [/\bestimate\b/gi, "find"],
      [/\bdetermine\b/gi, "find"],
      [/\bevaluate\b/gi, "work out"],
      [/\bapproximate\b/gi, "about"],
      [/\bjustify\b/gi, "explain"],
      [/\binfer\b/gi, "figure out"],
      [/\banalyze\b/gi, "look at"]
    ];
    let next = source;
    replacements.forEach(([pattern, replacement]) => {
      next = next.replace(pattern, replacement);
    });
    return normalizeWhitespace(next);
  };

  const suggestContradictionRewrite = (text, answerValue) => {
    const source = normalizeWhitespace(String(text || ""));
    if (!source) return "";
    const match = source.match(/how\s+many\s+([a-z][a-z\s-]{0,30}?)(?:\?|\.|,|$)/i);
    const objectName = match ? normalizeWhitespace(match[1]) : "items";
    const answerText = String(answerValue || "").trim();
    if (answerText && normalizeText(answerText) !== "0") {
      return `There are ${answerText} ${objectName}. How many ${objectName} are there?`;
    }
    return `There are no ${objectName}. How many ${objectName} are there?`;
  };

  const suggestedResultType = suggestValidationResultTypeCorrection(question, row);
  if (suggestedResultType && suggestedResultType !== resultType) {
    updates.resultType = suggestedResultType;
    trackChange("resultType", "Result Type", question && question.resultType, suggestedResultType);
    nextResultType = suggestedResultType;
    notes.push(`Switch result type to ${suggestedResultType} (question appears worded/open response).`);
  } else if (row && row.suggestedResultType
    && normalizeResultType(row.suggestedResultType) !== resultType
    && Number(row.suggestedResultTypeConfidence || 0) > 0) {
    notes.push(`Detected possible result type "${normalizeResultType(row.suggestedResultType)}" at ${Math.round(Number(row.suggestedResultTypeConfidence || 0) * 100)}% confidence. Auto-update requires 85%+ confidence.`);
  }

  if (row && row.computedAnswer && !compareAnswersForResultType(nextResultType, nextAnswer, row.computedAnswer)) {
    updates.correctAnswer = String(row.computedAnswer || "").trim();
    trackChange("correctAnswer", "Correct Answer", question && question.correctAnswer, updates.correctAnswer);
    nextAnswer = updates.correctAnswer;
    notes.push(`Update correct answer to computed value: ${nextAnswer}`);
  }

  if (["multiple-choice", "true-false"].includes(nextResultType) && choiceOptions.length > 0) {
    const canonical = choiceOptions.find((item) => normalizeText(item) === normalizeText(nextAnswer));
    if (!canonical) {
      updates.correctAnswer = choiceOptions[0];
      trackChange("correctAnswer", "Correct Answer", question && question.correctAnswer, updates.correctAnswer);
      nextAnswer = updates.correctAnswer;
      notes.push(`Normalize answer to a valid option: ${updates.correctAnswer}`);
    } else if (canonical !== nextAnswer) {
      updates.correctAnswer = canonical;
      trackChange("correctAnswer", "Correct Answer", question && question.correctAnswer, updates.correctAnswer);
      nextAnswer = updates.correctAnswer;
      notes.push(`Align answer text with option value: ${updates.correctAnswer}`);
    }
  }

  if (nextResultType === "checkbox" && choiceOptions.length > 0) {
    const baseTokens = splitAnswerTokens(nextAnswer);
    const normalizedMap = new Map(choiceOptions.map((item) => [normalizeText(item), item]));
    const validTokens = [];
    baseTokens.forEach((token) => {
      const canonical = normalizedMap.get(normalizeText(token));
      if (canonical && !validTokens.some((item) => normalizeText(item) === normalizeText(canonical))) {
        validTokens.push(canonical);
      }
    });

    if (validTokens.length === 0 && row && row.computedAnswer) {
      splitAnswerTokens(row.computedAnswer).forEach((token) => {
        const canonical = normalizedMap.get(normalizeText(token));
        if (canonical && !validTokens.some((item) => normalizeText(item) === normalizeText(canonical))) {
          validTokens.push(canonical);
        }
      });
    }

    if (validTokens.length === 0 && choiceOptions[0]) {
      validTokens.push(choiceOptions[0]);
    }

    const normalizedCheckboxAnswer = validTokens.join(", ");
    if (normalizedCheckboxAnswer && normalizeWhitespace(normalizedCheckboxAnswer) !== normalizeWhitespace(nextAnswer)) {
      updates.correctAnswer = normalizedCheckboxAnswer;
      trackChange("correctAnswer", "Correct Answer", question && question.correctAnswer, updates.correctAnswer);
      nextAnswer = updates.correctAnswer;
      notes.push(`Normalize checkbox answer list: ${updates.correctAnswer}`);
    }
  }

  const currentSolution = String(question && question.solution || "").trim();
  const declaredAnswer = extractDeclaredAnswerFromSolution(currentSolution);
  const shouldRegenerateSolution = !currentSolution
    || (declaredAnswer && !compareAnswersForResultType(nextResultType, nextAnswer, declaredAnswer));

  if (shouldRegenerateSolution) {
    updates.solution = inferSolutionFromImport(question && question.question, nextAnswer);
    trackChange("solution", "Solution Text", question && question.solution, updates.solution);
    notes.push(currentSolution
      ? "Regenerate solution so it matches the updated/stored answer."
      : "Generate a default solution from question and answer.");
  }

  const issueList = Array.isArray(row && row.issues) ? row.issues : [];
  if (issueList.some((item) => /grade language may be too advanced/i.test(String(item || "")))) {
    const simplifiedQuestion = simplifyQuestionForLowerGrades(question && question.question);
    trackProposal(
      "question",
      "Question Text (manual)",
      question && question.question,
      simplifiedQuestion,
      "Proposed a simpler wording for lower-grade vocabulary."
    );
  }

  if (issueList.some((item) => /question wording may be contradictory|question may not make sense/i.test(String(item || "")))) {
    const rewrittenQuestion = suggestContradictionRewrite(question && question.question, row && row.computedAnswer ? row.computedAnswer : nextAnswer);
    trackProposal(
      "question",
      "Question Text (manual)",
      question && question.question,
      rewrittenQuestion,
      "Proposed question rewrite to remove wording contradiction."
    );

    if (String(nextAnswer || "").trim() && normalizeText(nextAnswer) !== "0") {
      trackProposal(
        "correctAnswer",
        "Correct Answer (manual)",
        question && question.correctAnswer,
        "0",
        "If you keep 'no items' in the question, set result to 0."
      );
    }
  }

  if (changes.length === 0 && row && !row.isValid) {
    if (row && row.computedAnswer) {
      trackProposal(
        "correctAnswer",
        "Correct Answer (manual)",
        question && question.correctAnswer,
        row.computedAnswer,
        "Proposed aligning result with computed answer."
      );
    }

    const fallbackSolution = inferSolutionFromImport(question && question.question, row && row.computedAnswer ? row.computedAnswer : nextAnswer);
    trackProposal(
      "solution",
      "Solution Text (manual)",
      question && question.solution,
      fallbackSolution,
      "Proposed a clearer solution text aligned with the expected result."
    );
  }

  if (notes.length === 0 && row && !row.isValid) {
    notes.push("Issue detected. No safe automatic update, but manual proposals are provided below.");
  }

  if (row && row.suggestedCategory) {
    const currentCategory = String(question && question.category || "").trim();
    if (!currentCategory) {
      updates.category = String(row.suggestedCategory || "").trim();
      trackChange("category", "Category", currentCategory, updates.category);
      notes.push(`Set missing category to ${updates.category}.`);
    }
  }

  if (row && row.suggestedSubcategory) {
    const currentSubcategory = String(question && question.subcategory || "").trim();
    if (!currentSubcategory) {
      updates.subcategory = String(row.suggestedSubcategory || "").trim();
      trackChange("subcategory", "Subcategory", currentSubcategory, updates.subcategory);
      notes.push(`Set missing subcategory to ${updates.subcategory}.`);
    }
  }

  return {
    canApply: changes.length > 0,
    updates,
    notes,
    changes,
    proposals
  };
}

function getAiHeuristicIssues(question, computedAnswer) {
  const issues = [];
  const resultType = normalizeResultType(question && question.resultType);
  const options = Array.isArray(question && question.options)
    ? question.options.map((item) => String(item || "").trim()).filter((item) => item !== "")
    : [];
  const questionText = String(question && question.question || "").trim().toLowerCase();
  const answerText = String(question && question.correctAnswer || "").trim();
  const solutionText = String(question && question.solution || "").trim().toLowerCase();

  if (resultType === "short-answer" && options.length > 0) {
    issues.push("AI heuristic: question has answer options but is saved as short-answer.");
  }

  if (questionText.includes("select all") && resultType !== "checkbox") {
    issues.push("AI heuristic: question wording suggests checkbox result type.");
  }

  if (resultType === "checkbox") {
    const answerCount = splitAnswerTokens(answerText).length;
    if (answerCount === 1 && questionText.includes("all")) {
      issues.push("AI heuristic: checkbox question appears to expect multiple answers.");
    }
  }

  if (solutionText && answerText && answerText.length <= 24 && !solutionText.includes(answerText.toLowerCase())) {
    issues.push("AI heuristic: solution may not explicitly mention the final answer.");
  }

  if (computedAnswer && !compareAnswersForResultType(resultType, answerText, computedAnswer)) {
    issues.push("AI heuristic: stored answer differs from computed answer.");
  }

  return issues;
}

function buildResultValidationForActiveQuiz(aiMode = false) {
  const category = activeCategory();
  const quiz = activeQuiz();
  if (!quiz) return null;
  const categoryName = category ? String(category.name || "") : "";

  const rows = (Array.isArray(quiz.questions) ? quiz.questions : []).map((question, index) => {
    const questionIssues = getQuestionValidationIssues(question || {});
    questionIssues.push(...getQuestionSenseIssues(question || {}));
    questionIssues.push(...getGradeLanguageIssues(question || {}, categoryName));
    const solutionText = String(question && question.solution || "").trim();
    const actualAnswer = String(question && question.correctAnswer || "").trim();
    if (!solutionText) {
      questionIssues.push("Solution text is empty.");
    }

    const declaredAnswer = extractDeclaredAnswerFromSolution(solutionText);
    if (declaredAnswer && !compareAnswersForResultType(question && question.resultType, actualAnswer, declaredAnswer)) {
      questionIssues.push(`Solution mismatch: solution says \"${declaredAnswer}\" but stored answer is \"${actualAnswer || "(empty)"}\".`);
    }

    const computed = computeExpectedAnswerForQuestion(question);
    if (computed.value && !compareAnswersForResultType(question && question.resultType, actualAnswer, computed.value)) {
      questionIssues.push(`Computed answer mismatch: expected \"${computed.value}\" but found \"${actualAnswer || "(empty)"}\".`);
    }

    if (aiMode) {
      questionIssues.push(...getAiHeuristicIssues(question || {}, computed.value));
    }

    const appType = question && question.interactiveApp && question.interactiveApp.type
      ? String(question.interactiveApp.type || "").trim()
      : "";
    const categoryType = String(question && question.category || "").trim();
    const subcategoryType = String(question && question.subcategory || "").trim();
    const currentResultType = normalizeResultType(question && question.resultType);
    const moduleType = appType || categoryType || "standard";
    const inferredStructure = inferValidationCategorySubcategory(question || {});
    const inferredTemplateHint = inferValidationTemplateTypeFromQuestion(question || {});
    const detection = detectResultTypeFromValidationContext(question || {}, {
      moduleType,
      importedCategory: categoryType,
      importedSubcategory: subcategoryType,
      suggestedCategory: inferredStructure.suggestedCategory,
      suggestedSubcategory: inferredStructure.suggestedSubcategory,
      correctAnswer: actualAnswer,
      computedAnswer: computed.value
    });
    const expectedResultType = normalizeResultType(detection.type);
    const expectedResultTypeConfidence = Number(detection.confidence || 0);

    if (expectedResultType && expectedResultType !== currentResultType && expectedResultTypeConfidence >= 0.65) {
      questionIssues.push(`Result type mismatch: detected "${expectedResultType}" (${Math.round(expectedResultTypeConfidence * 100)}% confidence) from table context but current type is "${currentResultType}".`);
    }

    if (!appType && inferredTemplateHint) {
      questionIssues.push(`Interactive configuration missing: metadata suggests "${inferredTemplateHint}" but interactiveApp is empty.`);
    }

    if (!categoryType && inferredStructure.suggestedCategory) {
      questionIssues.push(`Category is missing. Suggested category: "${inferredStructure.suggestedCategory}".`);
    }
    if (!String(question && question.subcategory || "").trim() && inferredStructure.suggestedSubcategory) {
      questionIssues.push(`Subcategory is missing. Suggested subcategory: "${inferredStructure.suggestedSubcategory}".`);
    }

    const viewerCompatibilityIssues = questionIssues.filter((item) => isViewerCompatibilityIssue(item));

    return {
      index,
      question: String(question && question.question || "").trim(),
      resultType: currentResultType,
      suggestedResultType: expectedResultType,
      suggestedResultTypeConfidence: expectedResultTypeConfidence,
      moduleType,
      importedCategory: categoryType,
      importedSubcategory: subcategoryType,
      suggestedCategory: inferredStructure.suggestedCategory,
      suggestedSubcategory: inferredStructure.suggestedSubcategory,
      options: Array.isArray(question && question.options)
        ? question.options.map((item) => String(item || "").trim()).filter((item) => item !== "")
        : [],
      correctAnswer: actualAnswer,
      computedAnswer: computed.value,
      solution: solutionText,
      viewerCompatibilityIssueCount: viewerCompatibilityIssues.length,
      hasViewerCompatibilityIssue: viewerCompatibilityIssues.length > 0,
      issues: questionIssues,
      isValid: questionIssues.length === 0
    };
  });

  const errors = rows.filter((row) => !row.isValid).length;
  const valid = rows.length - errors;

  return {
    categoryId: category ? String(category.id || "") : "",
    quizId: String(quiz.id || ""),
    categoryName: category ? String(category.name || "") : "",
    quizTitle: String(quiz.title || "Untitled Quiz"),
    total: rows.length,
    valid,
    errors,
    aiMode,
    rows
  };
}

function renderResultValidation(validation) {
  const meta = document.getElementById("resultValidationMeta");
  const body = document.getElementById("resultValidationBody");
  const exportBtn = document.getElementById("exportResultValidationBtn");
  const filterSelect = document.getElementById("resultValidationStatusFilter");
  const bulkBtn = document.getElementById("applyBulkResultValidationFixBtn");
  if (!(meta instanceof HTMLElement)
    || !(body instanceof HTMLElement)
    || !(exportBtn instanceof HTMLButtonElement)
    || !(filterSelect instanceof HTMLSelectElement)
    || !(bulkBtn instanceof HTMLButtonElement)) return;

  filterSelect.value = normalizeResultValidationFilter(pendingResultValidationFilter);

  if (!validation) {
    meta.textContent = "Select a quiz/module and run validation.";
    body.innerHTML = '<tr><td colspan="13" style="padding:8px; border:1px solid #e5edf8;">No validation run yet.</td></tr>';
    exportBtn.disabled = true;
    bulkBtn.disabled = true;
    pendingResultValidationIssueFilter = "all";
    renderResultValidationSummary(null);
    renderResultValidationDetail(-1);
    return;
  }

  renderResultValidationSummary(validation);

  const visibleRows = getFilteredResultValidationRows(validation);
  const redVisible = visibleRows.filter((row) => !row.isValid).length;

  const issueFilterText = normalizeResultValidationIssueFilter(pendingResultValidationIssueFilter) !== "all"
    ? ` Issue filter: ${normalizeResultValidationIssueFilter(pendingResultValidationIssueFilter)}.`
    : "";
  meta.textContent = `${validation.categoryName} / ${validation.quizTitle}: ${validation.valid}/${validation.total} green (correct), ${validation.errors}/${validation.total} red (incorrect). Showing ${visibleRows.length} row(s).${issueFilterText} ${validation.aiMode ? "AI heuristic mode enabled." : "Deterministic mode."}`;
  exportBtn.disabled = validation.total === 0;
  bulkBtn.disabled = redVisible === 0;

  if (!Array.isArray(validation.rows) || validation.rows.length === 0) {
    body.innerHTML = '<tr><td colspan="13" style="padding:8px; border:1px solid #e5edf8;">This module has no questions.</td></tr>';
    renderResultValidationDetail(-1);
    return;
  }

  if (visibleRows.length === 0) {
    body.innerHTML = '<tr><td colspan="13" style="padding:8px; border:1px solid #e5edf8;">No rows match this filter.</td></tr>';
    renderResultValidationDetail(-1);
    return;
  }

  body.innerHTML = visibleRows.map((row) => {
    const rowBg = row.isValid ? "#ecfdf3" : "#fff1f1";
    const rowOutline = row.index === pendingResultValidationSelectedIndex
      ? "box-shadow:inset 0 0 0 2px #1f6feb;"
      : "";
    const issueText = row.isValid
      ? "No"
      : `Yes (${row.issues.length})<br>${row.issues.map((item) => escapeInteractiveHtml(item)).join("<br>")}`;
    const compatibilityTag = row.hasViewerCompatibilityIssue
      ? `<span style="display:inline-flex; align-items:center; gap:6px; padding:4px 8px; border-radius:999px; border:1px solid #f59e0b; background:#fff7ed; color:#9a3412; font-weight:700; font-size:0.78rem;">Needs fix (${row.viewerCompatibilityIssueCount})</span>`
      : `<span style="display:inline-flex; align-items:center; gap:6px; padding:4px 8px; border-radius:999px; border:1px solid #86efac; background:#ecfdf3; color:#166534; font-weight:700; font-size:0.78rem;">Compatible</span>`;
    return `
      <tr data-question-index="${row.index}" style="cursor:pointer; background:${rowBg}; ${rowOutline}">
        <td style="padding:8px; border:1px solid #e5edf8;">${row.index + 1}</td>
        <td style="padding:8px; border:1px solid #e5edf8; max-width:360px; white-space:normal;">${escapeInteractiveHtml(row.question || "")}</td>
        <td style="padding:8px; border:1px solid #e5edf8;">${escapeInteractiveHtml(row.resultType || "")}</td>
        <td style="padding:8px; border:1px solid #e5edf8;">${escapeInteractiveHtml(row.moduleType || "standard")}</td>
        <td style="padding:8px; border:1px solid #e5edf8;">${compatibilityTag}</td>
        <td style="padding:8px; border:1px solid #e5edf8;">${escapeInteractiveHtml(row.importedCategory || "-")}</td>
        <td style="padding:8px; border:1px solid #e5edf8;">${escapeInteractiveHtml(row.importedSubcategory || "-")}</td>
        <td style="padding:8px; border:1px solid #e5edf8;">${escapeInteractiveHtml(row.suggestedCategory || "-")}</td>
        <td style="padding:8px; border:1px solid #e5edf8;">${escapeInteractiveHtml(row.suggestedSubcategory || "-")}</td>
        <td style="padding:8px; border:1px solid #e5edf8; max-width:200px; white-space:normal;">${escapeInteractiveHtml(row.correctAnswer || "")}</td>
        <td style="padding:8px; border:1px solid #e5edf8; max-width:200px; white-space:normal;">${escapeInteractiveHtml(row.computedAnswer || "-")}</td>
        <td style="padding:8px; border:1px solid #e5edf8; max-width:320px; white-space:normal;">${escapeInteractiveHtml(row.solution || "")}</td>
        <td style="padding:8px; border:1px solid #e5edf8; max-width:380px; white-space:normal;">${issueText}</td>
      </tr>
    `;
  }).join("");

  const selectedStillVisible = visibleRows.some((row) => row.index === pendingResultValidationSelectedIndex);
  const defaultIndex = selectedStillVisible ? pendingResultValidationSelectedIndex : visibleRows[0].index;
  renderResultValidationDetail(defaultIndex);
}

function focusResultValidationQuestion(questionIndex) {
  const quiz = activeQuiz();
  if (!quiz || !Array.isArray(quiz.questions)) return;
  if (!Number.isInteger(questionIndex) || questionIndex < 0 || questionIndex >= quiz.questions.length) return;
  state.selectedQuestionIndex = questionIndex;
  renderAll();
}

function runResultValidation(aiMode = false) {
  if (activeQuestion()) {
    updateQuestionFromForm();
  }

  const result = buildResultValidationForActiveQuiz(aiMode);
  if (!result) {
    showToast("Select a module (quiz) first.", "warning");
    return;
  }

  pendingResultValidation = result;
  renderResultValidation(result);
  showToast(`Validation complete: ${result.valid}/${result.total} correct, ${result.errors} incorrect.`, result.errors > 0 ? "warning" : "success");
}

async function applyResultValidationFixForQuestion(questionIndex, { confirmApply = true } = {}) {
  const quiz = activeQuiz();
  if (!quiz || !Array.isArray(quiz.questions)) return false;
  if (!Number.isInteger(questionIndex) || questionIndex < 0 || questionIndex >= quiz.questions.length) return false;
  if (!pendingResultValidation || !Array.isArray(pendingResultValidation.rows)) return false;
  if (pendingResultValidation.quizId && pendingResultValidation.quizId !== String(quiz.id || "")) {
    showToast("Validation data belongs to a different quiz. Re-run validation for the selected quiz.", "warning");
    return false;
  }

  const row = pendingResultValidation.rows.find((item) => item.index === questionIndex) || null;
  const question = quiz.questions[questionIndex] || null;
  if (!row || !question) return false;

  const plan = buildResultValidationFixPlan(question, row);
  if (!plan.canApply) {
    const manualEdits = getResultValidationManualProposalEdits(questionIndex);
    if (manualEdits.length === 0) {
      const hasManualProposals = Array.isArray(plan.proposals) && plan.proposals.length > 0;
      showToast(hasManualProposals
        ? "Automatic update is not safe. Review manual proposals in the fix panel."
        : "No safe automatic update for this row.", "warning");
      return false;
    }

    if (confirmApply) {
      const proceedManual = confirm("Apply edited manual proposal to this question?");
      if (!proceedManual) return false;
    }

    let changed = false;
    manualEdits.forEach((edit) => {
      if (!edit || !edit.field) return;
      const nextValue = String(edit.value || "").trim();
      if (edit.field === "question") {
        const current = String(question.question || "").trim();
        if (normalizeWhitespace(current) !== normalizeWhitespace(nextValue)) {
          question.question = nextValue;
          changed = true;
        }
      } else if (edit.field === "correctAnswer") {
        const current = String(question.correctAnswer || "").trim();
        if (normalizeWhitespace(current) !== normalizeWhitespace(nextValue)) {
          question.correctAnswer = nextValue;
          changed = true;
        }
      } else if (edit.field === "solution") {
        const current = String(question.solution || "").trim();
        if (normalizeWhitespace(current) !== normalizeWhitespace(nextValue)) {
          question.solution = nextValue;
          changed = true;
        }
      }
    });

    if (!changed) {
      showToast("No manual changes to apply.", "info");
      return false;
    }

    state.selectedQuestionIndex = questionIndex;
    return true;
  }

  if (confirmApply) {
    const proceed = confirm("Apply proposed update to this question?");
    if (!proceed) return false;
  }

  if (Object.prototype.hasOwnProperty.call(plan.updates, "correctAnswer")) {
    question.correctAnswer = String(plan.updates.correctAnswer || "").trim();
  }
  if (Object.prototype.hasOwnProperty.call(plan.updates, "resultType")) {
    question.resultType = normalizeResultType(plan.updates.resultType);
  }
  if (Object.prototype.hasOwnProperty.call(plan.updates, "solution")) {
    question.solution = String(plan.updates.solution || "").trim();
  }
  if (Object.prototype.hasOwnProperty.call(plan.updates, "category")) {
    question.category = String(plan.updates.category || "").trim();
  }
  if (Object.prototype.hasOwnProperty.call(plan.updates, "subcategory")) {
    question.subcategory = String(plan.updates.subcategory || "").trim();
  }

  state.selectedQuestionIndex = questionIndex;
  return true;
}

async function applyBulkResultValidationFixes() {
  if (!pendingResultValidation || !Array.isArray(pendingResultValidation.rows)) {
    showToast("Run validation first.", "warning");
    return;
  }

  const quiz = activeQuiz();
  if (!quiz || !Array.isArray(quiz.questions)) {
    showToast("Select a quiz first.", "warning");
    return;
  }
  if (pendingResultValidation.quizId && pendingResultValidation.quizId !== String(quiz.id || "")) {
    showToast("Validation data belongs to a different quiz. Re-run validation for the selected quiz.", "warning");
    return;
  }

  const targets = pendingResultValidation.rows.filter((row) => !row.isValid);
  if (targets.length === 0) {
    showToast("No red rows to update.", "info");
    return;
  }

  const proceed = confirm(`Apply proposed updates to ${targets.length} red question(s)?`);
  if (!proceed) return;

  let applied = 0;
  for (const row of targets) {
    const changed = await applyResultValidationFixForQuestion(row.index, { confirmApply: false });
    if (changed) applied += 1;
  }

  if (applied === 0) {
    showToast("No automatic updates could be applied.", "warning");
    return;
  }

  renderAll();
  await persistSelectedQuizAfterMutation("Bulk validation updates");
  runResultValidation(Boolean(pendingResultValidation && pendingResultValidation.aiMode));
  showToast(`Applied updates to ${applied} question(s).`, "success");
}

function downloadResultValidationCsv() {
  if (!pendingResultValidation || !Array.isArray(pendingResultValidation.rows) || pendingResultValidation.rows.length === 0) {
    showToast("No result validation data to export.", "warning");
    return;
  }

  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const stamp = `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;

  const header = ["Q No", "Question", "Result Type", "Viewer Compatibility", "Correct Answer", "Computed Answer", "Solution", "Status", "Issues"];
  const rows = pendingResultValidation.rows.map((item) => [
    String(item.index + 1),
    item.question || "",
    item.resultType || "",
    item.hasViewerCompatibilityIssue ? `Needs fix (${item.viewerCompatibilityIssueCount || 0})` : "Compatible",
    item.correctAnswer || "",
    item.computedAnswer || "",
    item.solution || "",
    item.isValid ? "GREEN" : "RED",
    item.isValid ? "" : item.issues.join(" | ")
  ]);

  const summary = [
    "SUMMARY",
    `${pendingResultValidation.categoryName} / ${pendingResultValidation.quizTitle}`,
    "",
    "",
    "",
    "",
    "",
    "",
    `Total=${pendingResultValidation.total}; Valid=${pendingResultValidation.valid}; Invalid=${pendingResultValidation.errors}; Mode=${pendingResultValidation.aiMode ? "ai" : "deterministic"}`
  ];

  const csv = [header, ...rows, summary]
    .map((row) => row.map((cell) => escapeCsvCell(cell)).join(","))
    .join("\r\n");
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `result-validation-${slugify(pendingResultValidation.quizTitle || "module")}-${stamp}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  showToast("Result validation report downloaded.", "success");
}

function renderImportValidation(validation) {
  const meta = document.getElementById("importValidationMeta");
  const body = document.getElementById("importValidationBody");
  const applyBtn = document.getElementById("applyImportBtn");
  const exportBtn = document.getElementById("exportValidationBtn");
  if (!(meta instanceof HTMLElement)
    || !(body instanceof HTMLElement)
    || !(applyBtn instanceof HTMLButtonElement)
    || !(exportBtn instanceof HTMLButtonElement)) return;

  if (!validation) {
    meta.textContent = "No validation run yet.";
    body.innerHTML = '<tr><td colspan="5" style="padding:8px;">No issues detected.</td></tr>';
    applyBtn.disabled = true;
    exportBtn.disabled = true;
    return;
  }

  const issues = Array.isArray(validation.issues) ? validation.issues : [];
  const errors = Number(validation.errors || 0);
  const warnings = Number(validation.warnings || 0);

  if (errors === 0 && warnings === 0) {
    meta.textContent = "Validation passed. No issues found. You can apply import.";
    body.innerHTML = '<tr><td colspan="5" style="padding:8px;">No issues detected.</td></tr>';
  } else {
    meta.textContent = `Validation found ${errors} error(s) and ${warnings} warning(s). You can still apply import and clean up in Result Validation.`;
    const previewIssues = issues.slice(0, 200);
    body.innerHTML = previewIssues.map((item) => `
      <tr${Number.isInteger(item.rowIndex) && item.rowIndex >= 0 ? ` data-row-index="${item.rowIndex}" style="cursor:pointer;" title="Click to jump to this row in preview"` : ""}>
        <td style="padding:8px; border-bottom:1px solid #f0f4f8;">${escapeInteractiveHtml(String(item.level || "").toUpperCase())}</td>
        <td style="padding:8px; border-bottom:1px solid #f0f4f8;">${escapeInteractiveHtml(item.grade || "")}</td>
        <td style="padding:8px; border-bottom:1px solid #f0f4f8;">${escapeInteractiveHtml(item.lessonPart || "")}</td>
        <td style="padding:8px; border-bottom:1px solid #f0f4f8;">${escapeInteractiveHtml(String(item.qNo || ""))}</td>
        <td style="padding:8px; border-bottom:1px solid #f0f4f8; white-space:normal;">${escapeInteractiveHtml(item.message || "")}</td>
      </tr>
    `).join("");
  }

  // Keep Apply clickable so users can import first and clean up via Result Validation.
  applyBtn.disabled = pendingImportRows.length === 0;
  exportBtn.disabled = pendingImportRows.length === 0;
}

function closeImportReportModal() {
  const modal = document.getElementById("importReportModal");
  if (!(modal instanceof HTMLElement)) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

function openImportReportModal() {
  const modal = document.getElementById("importReportModal");
  if (!(modal instanceof HTMLElement)) return;
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  renderImportAutoFixReport(pendingImportAutoFixReport);
}

function renderImportAutoFixReport(report) {
  const meta = document.getElementById("importReportMeta");
  const body = document.getElementById("importReportBody");
  const exportBtn = document.getElementById("exportAutoFixReportBtn");
  if (!(meta instanceof HTMLElement) || !(body instanceof HTMLElement) || !(exportBtn instanceof HTMLButtonElement)) return;

  if (!report || !Array.isArray(report.rows) || report.rows.length === 0) {
    meta.textContent = "No import report available yet.";
    body.innerHTML = '<tr><td colspan="8" style="padding:8px;">No report rows available.</td></tr>';
    exportBtn.disabled = true;
    return;
  }

  meta.textContent = `Fixed ${report.fixedCount} | Improved ${report.improvedCount} | Unresolved ${report.unresolvedCount} | Changed ${report.changedCount}`;
  body.innerHTML = report.rows.map((row) => `
    <tr>
      <td style="padding:8px; border-bottom:1px solid #eef2f8;">${escapeInteractiveHtml(row.status || "")}</td>
      <td style="padding:8px; border-bottom:1px solid #eef2f8;">${escapeInteractiveHtml(row.category || "")}</td>
      <td style="padding:8px; border-bottom:1px solid #eef2f8;">${escapeInteractiveHtml(row.lessonPart || "")}</td>
      <td style="padding:8px; border-bottom:1px solid #eef2f8;">${escapeInteractiveHtml(String(row.qNo || ""))}</td>
      <td style="padding:8px; border-bottom:1px solid #eef2f8; max-width:280px; white-space:normal;">${escapeInteractiveHtml(row.question || "")}</td>
      <td style="padding:8px; border-bottom:1px solid #eef2f8;">${escapeInteractiveHtml(String(row.beforeIssues ?? ""))}</td>
      <td style="padding:8px; border-bottom:1px solid #eef2f8;">${escapeInteractiveHtml(String(row.afterIssues ?? ""))}</td>
      <td style="padding:8px; border-bottom:1px solid #eef2f8; max-width:180px; white-space:normal;">${escapeInteractiveHtml(row.changedFields || "")}</td>
    </tr>
  `).join("");
  exportBtn.disabled = false;
}

function downloadImportAutoFixReportCsv() {
  const report = pendingImportAutoFixReport;
  if (!report || !Array.isArray(report.rows) || report.rows.length === 0) {
    showToast("No auto-fix report available yet.", "warning");
    return;
  }

  const now = new Date();
  const stamp = `${String(now.getFullYear())}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
  const header = ["Status", "Category", "Lesson Part", "Q No", "Question", "Before Issues", "After Issues", "Changed Fields", "Result Type", "Correct Answer", "Solution"];
  const rows = report.rows.map((row) => [
    row.status || "",
    row.category || "",
    row.lessonPart || "",
    String(row.qNo || ""),
    row.question || "",
    String(row.beforeIssues ?? ""),
    String(row.afterIssues ?? ""),
    row.changedFields || "",
    row.resultType || "",
    row.correctAnswer || "",
    row.solution || ""
  ]);
  const summary = [
    "SUMMARY",
    `fixed=${report.fixedCount}; improved=${report.improvedCount}; unresolved=${report.unresolvedCount}; changed=${report.changedCount}`,
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    ""
  ];
  const csv = [header, ...rows, summary].map((row) => row.map((cell) => escapeCsvCell(cell)).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `import-autofix-report-${stamp}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  showToast("Auto-fix report downloaded.", "success");
}

function escapeCsvCell(value) {
  const text = String(value == null ? "" : value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadImportValidationCsv() {
  if (!pendingImportValidation || !Array.isArray(pendingImportValidation.issues) || pendingImportRows.length === 0) {
    showToast("No import validation data to export.", "warning");
    return;
  }

  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const stamp = `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;

  const issues = pendingImportValidation.issues;
  const header = ["Level", "Grade", "Lesson Part", "Q No", "Issue"];
  const rows = issues.map((item) => [
    String(item.level || "").toUpperCase(),
    item.grade || "",
    item.lessonPart || "",
    String(item.qNo || ""),
    item.message || ""
  ]);

  const summaryRow = [
    "SUMMARY",
    "",
    "",
    "",
    `Rows=${pendingImportRows.length}; Errors=${pendingImportValidation.errors || 0}; Warnings=${pendingImportValidation.warnings || 0}`
  ];

  const allRows = [header, ...rows, summaryRow];
  const csv = allRows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const sourceName = slugify(pendingImportSourceName || "spreadsheet");

  link.href = url;
  link.download = `import-validation-${sourceName}-${stamp}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  showToast("Validation report downloaded.", "success");
}

function downloadImportTemplateCsv() {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const stamp = `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;

  const headerRow = IMPORT_TEMPLATE_HEADERS.map((cell) => escapeCsvCell(cell)).join(",");
  const csv = `${headerRow}\r\n`;
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = `import-template-${stamp}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  showToast("Import template downloaded.", "success");
}

function renderImportPreview(rows, sourceName) {
  const meta = document.getElementById("importPreviewMeta");
  const body = document.getElementById("importPreviewBody");
  if (!(meta instanceof HTMLElement) || !(body instanceof HTMLElement)) return;

  if (!Array.isArray(rows) || rows.length === 0) {
    meta.textContent = "No valid rows detected from spreadsheet.";
    body.innerHTML = '<tr><td colspan="12" style="padding:8px;">No rows loaded.</td></tr>';
    pendingImportValidation = null;
    renderImportValidation(pendingImportValidation);
    return;
  }

  const previewRows = rows;
  const categoryCount = new Set(rows.map((item) => item.grade)).size;
  const moduleCount = new Set(rows.map((item) => `${item.grade}::${item.lessonPart}`)).size;
  meta.textContent = `${sourceName}: ${rows.length} rows detected | ${categoryCount} categories | ${moduleCount} modules. Showing all rows.`;
  body.innerHTML = previewRows.map((row, rowIndex) => `
    <tr data-row-index="${rowIndex}">
      <td style="padding:8px; border-bottom:1px solid #f0f4f8;">${escapeInteractiveHtml(row.grade)}</td>
      <td style="padding:8px; border-bottom:1px solid #f0f4f8;">${escapeInteractiveHtml(row.module)}</td>
      <td style="padding:8px; border-bottom:1px solid #f0f4f8;">${escapeInteractiveHtml(row.lessonPart)}</td>
      <td style="padding:8px; border-bottom:1px solid #f0f4f8;">${escapeInteractiveHtml(row.lessonName)}</td>
      <td style="padding:8px; border-bottom:1px solid #f0f4f8;">${escapeInteractiveHtml(row.category)}</td>
      <td style="padding:8px; border-bottom:1px solid #f0f4f8;">${escapeInteractiveHtml(row.subcategory)}</td>
      <td style="padding:8px; border-bottom:1px solid #f0f4f8;">${escapeInteractiveHtml(String(row.qNo || ""))}</td>
      <td style="padding:8px; border-bottom:1px solid #f0f4f8;">${escapeInteractiveHtml(row.questionType)}</td>
      <td style="padding:8px; border-bottom:1px solid #f0f4f8; max-width:340px; white-space:normal;">${escapeInteractiveHtml(row.question)}</td>
      <td style="padding:8px; border-bottom:1px solid #f0f4f8; max-width:280px; white-space:normal;">${escapeInteractiveHtml((row.options || []).join(", "))}</td>
      <td style="padding:8px; border-bottom:1px solid #f0f4f8; max-width:160px; white-space:normal;">${escapeInteractiveHtml(row.compute || "")}</td>
      <td style="padding:8px; border-bottom:1px solid #f0f4f8; max-width:280px; white-space:normal;">${escapeInteractiveHtml(row.learningOutcome)}</td>
    </tr>
  `).join("");

  const applyBtn = document.getElementById("applyImportBtn");
  const exportBtn = document.getElementById("exportValidationBtn");
  const reportBtn = document.getElementById("openImportReportBtn");
  if (applyBtn instanceof HTMLButtonElement) applyBtn.disabled = false;
  if (exportBtn instanceof HTMLButtonElement) exportBtn.disabled = false;
  if (reportBtn instanceof HTMLButtonElement) {
    reportBtn.disabled = !(pendingImportAutoFixReport && Array.isArray(pendingImportAutoFixReport.rows) && pendingImportAutoFixReport.rows.length > 0);
  }

  try {
    pendingImportValidation = validateImportedRows(rows);
  } catch (error) {
    pendingImportValidation = {
      errors: 0,
      warnings: 1,
      issues: [{
        level: "warning",
        grade: "",
        lessonPart: "",
        qNo: "",
        rowIndex: -1,
        message: `Validation check failed unexpectedly: ${String(error && error.message ? error.message : error)}`
      }]
    };
  }

  if (!pendingImportValidation || typeof pendingImportValidation !== "object") {
    pendingImportValidation = { errors: 0, warnings: 0, issues: [] };
  }
  renderImportValidation(pendingImportValidation);
}

function findCategoryByName(name) {
  const normalized = normalizeText(name);
  return state.categories.find((category) => normalizeText(category.name) === normalized) || null;
}

function findQuizByTitle(category, title) {
  if (!category || !Array.isArray(category.quizzes)) return null;
  const normalized = normalizeText(title);
  return category.quizzes.find((quiz) => normalizeText(quiz.title) === normalized) || null;
}

async function applyPendingImportToMaker() {
  if (!Array.isArray(pendingImportRows) || pendingImportRows.length === 0) {
    showToast("No preview data to import.", "warning");
    return { importedQuizCount: 0, importedQuestionCount: 0, saved: 0, total: 0 };
  }

  const importedTargets = [];
  let autoFixChangedCount = 0;
  let autoFixImprovedCount = 0;
  let autoFixUnresolvedCount = 0;
  const autoFixReportRows = [];

  const groupedByCategory = new Map();
  pendingImportRows.forEach((row) => {
    if (!groupedByCategory.has(row.grade)) groupedByCategory.set(row.grade, []);
    groupedByCategory.get(row.grade).push(row);
  });

  groupedByCategory.forEach((rowsInCategory, categoryName) => {
    let category = findCategoryByName(categoryName);
    if (!category) {
      category = createCategory(categoryName);
      state.categories.push(category);
    }

    const groupedByModule = new Map();
    rowsInCategory.forEach((row) => {
      const moduleKey = String(row.lessonPart || "").trim();
      if (!groupedByModule.has(moduleKey)) groupedByModule.set(moduleKey, []);
      groupedByModule.get(moduleKey).push(row);
    });

    groupedByModule.forEach((moduleRows, moduleKey) => {
      const lessonPart = moduleKey;
      const representative = moduleRows[0] || {};
      const lessonName = String(representative.lessonName || representative.module || "Imported Module").trim();
      const quizTitle = `${categoryName} ${lessonPart}`;
      const sortedRows = moduleRows.slice().sort((left, right) => {
        const l = Number.isInteger(left.qNo) ? left.qNo : 0;
        const r = Number.isInteger(right.qNo) ? right.qNo : 0;
        return l - r;
      });

      let quiz = findQuizByTitle(category, quizTitle);
      if (!quiz) {
        quiz = createQuiz(quizTitle);
        category.quizzes.push(quiz);
      }

      const outcomesSummary = summarizeModuleLearningOutcomes(sortedRows);
      quiz.description = outcomesSummary
        ? `Learning Outcomes for ${categoryName}: ${outcomesSummary}`
        : `Learning Outcomes for ${categoryName}: Not specified.`;
      quiz.settings = normalizeQuizSettings({ questionOrder: "ordered", questionLimit: sortedRows.length });

      quiz.questions = sortedRows.map((row) => {
        const templateType = inferTemplateTypeFromImportRow(row);
        const inferred = inferAnswerFromImportRow(row, templateType);
        const interactiveApp = buildInteractiveAppFromImport(row, inferred.correctAnswer, templateType);
        const inferredCategory = inferImportCategoryFromTemplateType(templateType);
        const inferredSubcategory = inferImportSubcategoryFromTemplateType(templateType, row.question);
        const payload = {
          question: row.question,
          resultType: inferred.resultType,
          options: row.options.length > 0 ? row.options : ["", "", "", ""],
          correctAnswer: inferred.correctAnswer,
          category: row.category || inferredCategory,
          subcategory: row.subcategory || inferredSubcategory,
          learningOutcome: row.learningOutcome || "",
          notesAttachments: [],
          image: "",
          solution: inferSolutionFromImport(row.question, inferred.correctAnswer),
          solutionAttachments: []
        };
        if (interactiveApp) payload.interactiveApp = interactiveApp;
        return normalizeQuestion(payload);
      });

      quiz.questions.forEach((question, questionIndex) => {
        const beforeSnapshot = snapshotImportAutoFixFields(question);
        const fixResult = autoFixQuestionIssues(question);
        const afterSnapshot = snapshotImportAutoFixFields(question);
        const row = sortedRows[questionIndex] || {};
        const changedFields = describeImportAutoFixChanges(beforeSnapshot, afterSnapshot);
        const status = getImportAutoFixStatus(fixResult.before, fixResult.after, fixResult.changed);
        autoFixReportRows.push({
          status,
          category: categoryName,
          lessonPart,
          qNo: row.qNo || "",
          question: String(question.question || ""),
          beforeIssues: fixResult.before,
          afterIssues: fixResult.after,
          changedFields,
          resultType: String(question.resultType || ""),
          correctAnswer: String(question.correctAnswer || ""),
          solution: String(question.solution || "")
        });
        if (fixResult.changed) autoFixChangedCount += 1;
        if (fixResult.after < fixResult.before) autoFixImprovedCount += 1;
        if (fixResult.after > 0) autoFixUnresolvedCount += 1;
      });

      quiz.fileName = buildUniqueQuizFileName(`lesson-part-${lessonPart}-${lessonName}`, quiz.id);
      importedTargets.push({ categoryId: category.id, quizId: quiz.id });
    });
  });

  const orderedCategories = sortCategoriesForDisplay(state.categories);
  state.categories = orderedCategories;

  const firstImportedTarget = importedTargets[0] || null;
  if (firstImportedTarget) {
    state.selectedCategoryId = firstImportedTarget.categoryId;
    state.selectedQuizId = firstImportedTarget.quizId;
    state.selectedQuestionIndex = 0;
  } else {
    const selection = pickInitialSelection(orderedCategories);
    state.selectedCategoryId = selection.categoryId;
    state.selectedQuizId = selection.quizId;
    state.selectedQuestionIndex = selection.questionIndex;
  }
  ensureQuizFileNames();
  renderAll();

  pendingImportAutoFixReport = {
    rows: autoFixReportRows,
    fixedCount: autoFixReportRows.filter((item) => item.status === "fixed").length,
    improvedCount: autoFixReportRows.filter((item) => item.status === "improved").length,
    unresolvedCount: autoFixReportRows.filter((item) => item.status === "unresolved").length,
    changedCount: autoFixReportRows.filter((item) => item.status === "fixed" || item.status === "improved").length
  };

  const reportBtn = document.getElementById("openImportReportBtn");
  if (reportBtn instanceof HTMLButtonElement) {
    reportBtn.disabled = !(pendingImportAutoFixReport && pendingImportAutoFixReport.rows && pendingImportAutoFixReport.rows.length > 0);
  }

  const saveResult = await persistImportedQuizzesToDisk(importedTargets, true);
  if (saveResult === null) {
    showToast("Import applied in Maker, but files were not saved. Connect/select root folder, then save quizzes.", "warning");
    return {
      importedQuizCount: importedTargets.length,
      importedQuestionCount: pendingImportRows.length,
      saved: 0,
      total: importedTargets.length
    };
  }

  if (saveResult.saved === saveResult.total) {
    showToast(`Spreadsheet import applied and saved ${saveResult.saved} file(s). Smart auto-fix changed ${autoFixChangedCount} question(s), improved ${autoFixImprovedCount}, unresolved ${autoFixUnresolvedCount}.`, autoFixUnresolvedCount > 0 ? "warning" : "success");
    return {
      importedQuizCount: importedTargets.length,
      importedQuestionCount: pendingImportRows.length,
      saved: saveResult.saved,
      total: saveResult.total
    };
  }

  showToast(`Import applied. Saved ${saveResult.saved}/${saveResult.total} file(s); ${saveResult.skipped} not saved. Smart auto-fix changed ${autoFixChangedCount} question(s), improved ${autoFixImprovedCount}, unresolved ${autoFixUnresolvedCount}.`, "warning");
  return {
    importedQuizCount: importedTargets.length,
    importedQuestionCount: pendingImportRows.length,
    saved: saveResult.saved,
    total: saveResult.total
  };
}

async function handleTableImportSelection(file) {
  if (!file) return;
  try {
    openImportModal();
    const importedRows = await readSpreadsheetRows(file);
    pendingImportRows = importedRows;
    pendingImportSourceName = file.name || "spreadsheet";
    renderImportPreview(importedRows, pendingImportSourceName);
    if (importedRows.length === 0) {
      showToast("No valid rows found. Allowed Grade values: Prep, Grade 1, Grade 2, Grade 3, Grade 4, Grade 5, Grade 6.", "warning");
      return;
    }
    showToast(`Imported preview ready: ${importedRows.length} row(s). Click Apply Import.`, "success");
  } catch (error) {
    pendingImportRows = [];
    pendingImportSourceName = "";
    renderImportPreview([], file && file.name ? file.name : "spreadsheet");
    showToast(String(error && error.message ? error.message : "Could not import spreadsheet."), "warning");
  }
}

async function initialize() {
  await restoreRootDirectoryHandle({ promptForPermission: false });
  updateLocalFolderRowVisibility();

  const loadedFromRoot = await refreshLibraryFromRoot(false, false);
  if (loadedFromRoot) {
    showToast("Detected quizzes from root folder.", "success");
    return;
  }

  const hasDraft = loadDraft();
  if (hasDraft) {
    renderAll();
    setRootStatus(`Source: draft data (root ${state.rootFolder})`);
    showToast("Draft restored.", "info");
    return;
  }

  const starterCategory = createCategory("General");
  const starterQuiz = createQuiz("Sample Quiz");
  starterQuiz.questions.push(createEmptyQuestion());
  starterCategory.quizzes.push(starterQuiz);

  state.categories = [starterCategory];
  state.selectedCategoryId = starterCategory.id;
  state.selectedQuizId = starterQuiz.id;
  state.selectedQuestionIndex = 0;
  renderAll();
  setRootStatus("Source: starter quiz (no root index found)");
}

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeImportModal();
    closeResultValidationModal();
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    document.getElementById("saveQuizBtn").click();
    return;
  }

  if (isTypingInField(event.target)) {
    return;
  }

  if (!event.repeat && event.key.toLowerCase() === "n") {
    event.preventDefault();
    void addQuestion();
    return;
  }

  if (!event.repeat && event.key === "Delete") {
    event.preventDefault();
    if (state.selectedQuestionIndex < 0) {
      showToast("No selected question to delete.", "warning");
      return;
    }

    void deleteQuestion(state.selectedQuestionIndex);
    showToast("Question deleted.", "info");
  }
});

window.addEventListener("load", () => {
  console.log(`Quiz Maker v${APP_VERSION} loaded`);
  const versionBadge = document.getElementById("versionBadge");
  if (versionBadge) {
    versionBadge.textContent = `v${APP_VERSION}`;
  }
  initializeInteractiveAppTypePicker();
  renderImportValidation(null);
  renderResultValidation(null);
  initialize();
});





