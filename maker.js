let categorySeed = 1;
let quizSeed = 1;
const DRAFT_STORAGE_KEY = "quiz-maker-draft-v1";

const state = {
  categories: [],
  selectedCategoryId: null,
  selectedQuizId: null,
  selectedQuestionIndex: -1,
  draggingQuestionIndex: -1
};

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
          questions: Array.isArray(quiz.questions) ? quiz.questions.map(normalizeQuestion) : []
        }))
        : []
    }));

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
    resultType: "multiple-choice",
    options: ["", "", "", ""],
    correctAnswer: "",
    notesAttachments: [],
    image: "",
    solution: ""
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
  return {
    id: `quiz-${quizSeed++}`,
    title,
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

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "quiz";
}

function getSelectedQuizFileName() {
  const selectedQuiz = activeQuiz();
  if (!selectedQuiz) {
    return "quiz.json";
  }

  return `${slugify(selectedQuiz.title)}.json`;
}

function getQuestionValidationIssues(question) {
  const issues = [];
  const resultType = question.resultType || "multiple-choice";
  const optionValues = Array.isArray(question.options) ? question.options.map((item) => String(item || "").trim()) : [];
  const choiceOptions = optionValues.filter((item) => item !== "");
  const answerValue = String(question.correctAnswer || "").trim();

  if (!String(question.question || "").trim()) {
    issues.push("Question text is required.");
  }

  if (["multiple-choice", "checkbox", "true-false"].includes(resultType) && choiceOptions.length < 2) {
    issues.push("At least two options are required for this result type.");
  }

  if (!answerValue) {
    issues.push("Correct answer is required.");
  } else if (["multiple-choice", "true-false"].includes(resultType)) {
    const matchesChoice = choiceOptions.some((item) => normalizeText(item) === normalizeText(answerValue));
    if (!matchesChoice) {
      issues.push("Correct answer must match one option exactly.");
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

  state.categories.forEach((category) => {
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

  category.quizzes.forEach((quiz) => {
    const row = document.createElement("div");
    row.className = `list-item ${quiz.id === state.selectedQuizId ? "active" : ""}`;
    row.innerHTML = `
      <button class="list-main" data-id="${quiz.id}" type="button">${quiz.title}</button>
      <button class="icon-btn secondary" data-action="embed" data-id="${quiz.id}" type="button">Link</button>
      <button class="icon-btn danger" data-action="delete" data-id="${quiz.id}" type="button">x</button>
    `;
    host.appendChild(row);
  });
}

function buildQuizIframeCode(quizId) {
  const category = activeCategory();
  if (!category) return "";
  const quiz = category.quizzes.find((item) => item.id === quizId);
  if (!quiz) return "";

  const fileName = `${slugify(quiz.title)}.json`;
  const viewerUrl = new URL("viewer.html", window.location.href);
  viewerUrl.searchParams.set("file", fileName);

  return `<iframe src="${viewerUrl.toString()}" width="100%" height="640" style="border:0;" loading="lazy" allowfullscreen></iframe>`;
}

async function generateAndCopyIframeCode(quizId) {
  const code = buildQuizIframeCode(quizId);
  if (!code) {
    showToast("Could not generate iframe code.", "error");
    return;
  }

  const output = document.getElementById("iframeCodeOutput");
  output.value = code;

  try {
    await navigator.clipboard.writeText(code);
    showToast("Iframe code copied.", "success");
  } catch (error) {
    showToast("Could not copy iframe code.", "error");
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

  quiz.questions.forEach((item, index) => {
    const title = item.question || `Untitled Question ${index + 1}`;
    const issues = getQuestionValidationIssues(item);
    const badgeClass = issues.length === 0 ? "status-chip ok" : "status-chip warn";
    const badgeText = issues.length === 0 ? "Ready" : `${issues.length} issue${issues.length === 1 ? "" : "s"}`;
    const row = document.createElement("div");
    row.className = `list-item ${index === state.selectedQuestionIndex ? "active" : ""}`;
    row.draggable = true;
    row.dataset.dragIndex = String(index);
    row.innerHTML = `
      <button class="list-main" data-index="${index}" type="button">Q${index + 1}: ${title}</button>
      <span class="${badgeClass}">${badgeText}</span>
      <button class="icon-btn danger" data-action="delete" data-index="${index}" type="button">x</button>
    `;
    host.appendChild(row);
  });
}

function toggleOptionsBlock(question) {
  const isChoiceType = question && ["multiple-choice", "checkbox", "true-false"].includes(question.resultType);
  document.getElementById("optionsBlock").style.display = isChoiceType ? "block" : "none";
}

function getChoiceOptions(question) {
  if (!question) return [];
  const options = Array.isArray(question.options) ? question.options : [];
  return options.map((item) => String(item || "").trim()).filter((item) => item !== "");
}

function ensureDefaultCorrectAnswer(question) {
  if (!question) return;

  const resultType = question.resultType || "multiple-choice";
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

function refreshCorrectAnswerSelect(question) {
  const select = document.getElementById("correctAnswerSelect");
  const textInput = document.getElementById("correctAnswer");
  const checkboxWrap = document.getElementById("correctAnswerCheckboxWrap");
  const hint = document.getElementById("correctAnswerHint");
  const resultType = question ? (question.resultType || "multiple-choice") : "multiple-choice";
  const choiceOptions = getChoiceOptions(question);

  const useSelect = ["multiple-choice", "true-false"].includes(resultType);
  const useCheckboxPicker = resultType === "checkbox";
  select.style.display = useSelect ? "block" : "none";
  textInput.style.display = (!useSelect && !useCheckboxPicker) ? "block" : "none";
  checkboxWrap.style.display = useCheckboxPicker ? "block" : "none";

  if (resultType === "short-answer") {
    hint.textContent = "Enter the expected answer text.";
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
      const label = document.createElement("label");
      label.className = "checkbox-answer-item";
      label.innerHTML = `
        <input type="checkbox" data-role="correct-answer-check" data-index="${index}" value="${optionText}" />
        <span>${optionText}</span>
      `;

      const input = label.querySelector("input");
      if (input) {
        input.checked = existingAnswers.includes(normalizeText(optionText));
      }

      list.appendChild(label);
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
  if (!attachments || attachments.length === 0) {
    button.textContent = "Notes: N/A";
    preview.textContent = "n/a";
    return;
  }

  button.textContent = `Notes: ${attachments.length} attachment(s)`;
  preview.textContent = attachments.join(" | ");
}

function renderEditor() {
  const hint = document.getElementById("editorHint");
  const question = activeQuestion();
  const attachImageBtn = document.getElementById("attachImageBtn");
  const imageAttachHint = document.getElementById("imageAttachHint");

  if (!question) {
    hint.textContent = "Select a question to edit details.";
    document.getElementById("questionText").value = "";
    document.getElementById("resultType").value = "multiple-choice";
    document.getElementById("option1").value = "";
    document.getElementById("option2").value = "";
    document.getElementById("option3").value = "";
    document.getElementById("option4").value = "";
    document.getElementById("correctAnswer").value = "";
    document.getElementById("correctAnswerSelect").innerHTML = "";
    document.getElementById("correctAnswerCheckboxWrap").innerHTML = "";
    document.getElementById("attachmentsInput").value = "";
    document.getElementById("questionImage").value = "";
    document.getElementById("solutionText").value = "";
    updateImagePreview("");
    attachImageBtn.disabled = true;
    imageAttachHint.textContent = "Select a question first to attach an image.";
    updateNotesPreview([]);
    toggleOptionsBlock({ resultType: "multiple-choice" });
    refreshCorrectAnswerSelect({ resultType: "multiple-choice", options: ["", "", "", ""], correctAnswer: "" });
    renderValidationBox(null);
    return;
  }

  hint.textContent = `Editing question ${state.selectedQuestionIndex + 1}`;
  document.getElementById("questionText").value = question.question || "";
  document.getElementById("resultType").value = question.resultType || "multiple-choice";
  document.getElementById("option1").value = question.options[0] || "";
  document.getElementById("option2").value = question.options[1] || "";
  document.getElementById("option3").value = question.options[2] || "";
  document.getElementById("option4").value = question.options[3] || "";
  document.getElementById("correctAnswer").value = question.correctAnswer || "";
  document.getElementById("correctAnswerSelect").innerHTML = "";
  document.getElementById("correctAnswerCheckboxWrap").innerHTML = "";
  document.getElementById("attachmentsInput").value = (question.notesAttachments || []).join("\n");
  document.getElementById("questionImage").value = question.image || "";
  document.getElementById("solutionText").value = question.solution || "";
  updateImagePreview(question.image || "");
  attachImageBtn.disabled = false;
  imageAttachHint.textContent = "Attach image for the selected question, or paste a URL above.";
  updateNotesPreview(question.notesAttachments || []);
  toggleOptionsBlock(question);
  refreshCorrectAnswerSelect(question);
  renderValidationBox(question);
}

function getQuizData() {
  const selectedQuiz = activeQuiz();
  const category = activeCategory();
  const selectedQuestions = selectedQuiz
    ? selectedQuiz.questions.map((item) => ({
      question: item.question || "",
      resultType: item.resultType || "multiple-choice",
      options: Array.isArray(item.options) ? item.options : ["", "", "", ""],
      correctAnswer: item.correctAnswer || "",
      notesAttachments: Array.isArray(item.notesAttachments) ? item.notesAttachments : [],
      image: item.image || "",
      solution: item.solution || ""
    }))
    : [];

  return {
    id: selectedQuiz ? selectedQuiz.id : "",
    title: selectedQuiz ? selectedQuiz.title : "Untitled Quiz",
    category: category ? category.name : "General",
    questions: selectedQuestions
  };
}

function updateGeneratedJson() {
  document.getElementById("generatedJson").value = JSON.stringify(getQuizData(), null, 2);
  document.getElementById("quizFileName").value = getSelectedQuizFileName();
}

function renderAll() {
  ensureSelection();
  renderCategoryList();
  renderQuizList();
  renderQuestionsList();
  renderEditor();
  updateGeneratedJson();
  saveDraft();
}

function addCategory() {
  const name = prompt("Category name:", `Category ${state.categories.length + 1}`);
  if (!name || !name.trim()) return;

  const category = createCategory(name.trim());
  category.quizzes.push(createQuiz("New Quiz"));
  state.categories.push(category);
  state.selectedCategoryId = category.id;
  state.selectedQuizId = category.quizzes[0].id;
  state.selectedQuestionIndex = -1;
  renderAll();
}

function addQuiz() {
  const category = activeCategory();
  if (!category) {
    showToast("Create a category first.", "warning");
    return;
  }

  const title = prompt("Quiz title:", `Quiz ${category.quizzes.length + 1}`);
  if (!title || !title.trim()) return;

  const quiz = createQuiz(title.trim());
  category.quizzes.push(quiz);
  state.selectedQuizId = quiz.id;
  state.selectedQuestionIndex = -1;
  renderAll();
}

function addQuestion() {
  const quiz = activeQuiz();
  if (!quiz) {
    showToast("Create a quiz first.", "warning");
    return;
  }

  quiz.questions.push(createEmptyQuestion());
  state.selectedQuestionIndex = quiz.questions.length - 1;
  renderAll();
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

function deleteCategory(id) {
  if (!requireDeletePhrase("category")) return;

  const index = state.categories.findIndex((item) => item.id === id);
  if (index === -1) return;
  state.categories.splice(index, 1);
  showToast("Category deleted.", "info");
  renderAll();
}

function deleteQuiz(id) {
  if (!requireDeletePhrase("quiz")) return;

  const category = activeCategory();
  if (!category) return;
  const index = category.quizzes.findIndex((item) => item.id === id);
  if (index === -1) return;
  category.quizzes.splice(index, 1);
  showToast("Quiz deleted.", "info");
  renderAll();
}

function deleteQuestion(index) {
  const quiz = activeQuiz();
  if (!quiz || index < 0 || index >= quiz.questions.length) return;
  quiz.questions.splice(index, 1);
  renderAll();
}

function updateQuestionFromForm() {
  const question = activeQuestion();
  if (!question) return;

  question.question = document.getElementById("questionText").value.trim();
  question.resultType = document.getElementById("resultType").value;
  question.options = [
    document.getElementById("option1").value.trim(),
    document.getElementById("option2").value.trim(),
    document.getElementById("option3").value.trim(),
    document.getElementById("option4").value.trim()
  ];

  if (question.resultType === "true-false") {
    question.options = ["True", "False", "", ""];
  }

  ensureDefaultCorrectAnswer(question);

  refreshCorrectAnswerSelect(question);

  if (["multiple-choice", "true-false"].includes(question.resultType)) {
    const select = document.getElementById("correctAnswerSelect");
    const index = Number.parseInt(select.value, 10);
    const choiceOptions = getChoiceOptions(question);
    question.correctAnswer = Number.isInteger(index) && index >= 0 && index < choiceOptions.length
      ? choiceOptions[index]
      : "";
  } else if (question.resultType === "checkbox") {
    const checked = Array.from(document.querySelectorAll("input[data-role='correct-answer-check']:checked"))
      .map((item) => item.value.trim())
      .filter((item) => item !== "");
    question.correctAnswer = checked.join(", ");
  } else {
    question.correctAnswer = document.getElementById("correctAnswer").value.trim();
  }

  question.notesAttachments = document.getElementById("attachmentsInput").value
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  question.image = document.getElementById("questionImage").value.trim();
  question.solution = document.getElementById("solutionText").value.trim();

  toggleOptionsBlock(question);
  updateNotesPreview(question.notesAttachments);
  updateImagePreview(question.image);
  renderQuestionsList();
  renderValidationBox(question);
  updateGeneratedJson();
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

document.getElementById("addCategoryBtn").addEventListener("click", addCategory);
document.getElementById("addQuizBtn").addEventListener("click", addQuiz);
document.getElementById("addQuestionBtn").addEventListener("click", addQuestion);
document.getElementById("attachImageBtn").addEventListener("click", () => {
  const question = activeQuestion();
  if (!question) {
    showToast("Select a question first.", "warning");
    return;
  }

  document.getElementById("imageFileInput").click();
});

document.getElementById("imageFileInput").addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  const file = target.files && target.files[0];
  attachImageToQuestion(file || null);
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

document.getElementById("quizList").addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const id = target.dataset.id;
  if (!id) return;

  if (target.dataset.action === "delete") {
    deleteQuiz(id);
    return;
  }

  if (target.dataset.action === "embed") {
    generateAndCopyIframeCode(id);
    return;
  }

  state.selectedQuizId = id;
  state.selectedQuestionIndex = -1;
  renderAll();
});

document.getElementById("questionsList").addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const indexValue = target.dataset.index;
  if (typeof indexValue === "undefined") return;
  const index = Number.parseInt(indexValue, 10);
  if (Number.isNaN(index)) return;

  if (target.dataset.action === "delete") {
    deleteQuestion(index);
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

["questionText", "resultType", "option1", "option2", "option3", "option4", "correctAnswer", "attachmentsInput", "questionImage", "solutionText"]
  .forEach((id) => {
    document.getElementById(id).addEventListener("input", updateQuestionFromForm);
    document.getElementById(id).addEventListener("change", updateQuestionFromForm);
  });

document.getElementById("correctAnswerSelect").addEventListener("change", updateQuestionFromForm);

document.getElementById("correctAnswerCheckboxWrap").addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.dataset.role !== "correct-answer-check") return;
  updateQuestionFromForm();
});

document.getElementById("downloadQuizBtn").addEventListener("click", () => {
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
});

document.getElementById("copyJsonBtn").addEventListener("click", async () => {
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

function normalizeQuestion(item) {
  const options = Array.isArray(item.options) ? item.options.slice(0, 4) : ["", "", "", ""];
  while (options.length < 4) {
    options.push("");
  }

  const correctAnswerValue = Number.isInteger(item.correctAnswer)
    ? (options[item.correctAnswer] || "")
    : (item.correctAnswer || "");

  return {
    question: item.question || "",
    resultType: item.resultType || "multiple-choice",
    options,
    correctAnswer: correctAnswerValue,
    notesAttachments: Array.isArray(item.notesAttachments) ? item.notesAttachments : [],
    image: item.image || "",
    solution: item.solution || ""
  };
}

function loadImportedData(data) {
  if (Array.isArray(data.questions) && !Array.isArray(data.categories)) {
    const category = createCategory(data.category || "General");
    const quiz = createQuiz(data.title || "Imported Quiz");
    quiz.questions = data.questions.map(normalizeQuestion);
    category.quizzes.push(quiz);
    state.categories = [category];
    state.selectedCategoryId = category.id;
    state.selectedQuizId = quiz.id;
    state.selectedQuestionIndex = quiz.questions.length > 0 ? 0 : -1;
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
          questions: Array.isArray(quiz.questions) ? quiz.questions.map(normalizeQuestion) : []
        }))
        : []
    }));
    renderAll();
    return;
  }

  if (Array.isArray(data.questions)) {
    const category = createCategory("General");
    const quiz = createQuiz(data.title || "Imported Quiz");
    quiz.questions = data.questions.map(normalizeQuestion);
    category.quizzes.push(quiz);
    state.categories = [category];
    state.selectedCategoryId = category.id;
    state.selectedQuizId = quiz.id;
    state.selectedQuestionIndex = quiz.questions.length > 0 ? 0 : -1;
    renderAll();
    return;
  }

  throw new Error("Invalid quiz file");
}

document.getElementById("importQuizFile").addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);
    loadImportedData(data);
    showToast("Quiz imported.", "success");
  } catch (error) {
    showToast("Invalid JSON file.", "error");
  }

  event.target.value = "";
});

function initialize() {
  const hasDraft = loadDraft();

  if (hasDraft) {
    renderAll();
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
}

window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    document.getElementById("downloadQuizBtn").click();
    showToast(`Downloaded ${getSelectedQuizFileName()}`, "success");
    return;
  }

  if (isTypingInField(event.target)) {
    return;
  }

  if (!event.repeat && event.key.toLowerCase() === "n") {
    event.preventDefault();
    addQuestion();
    return;
  }

  if (!event.repeat && event.key === "Delete") {
    event.preventDefault();
    if (state.selectedQuestionIndex < 0) {
      showToast("No selected question to delete.", "warning");
      return;
    }

    deleteQuestion(state.selectedQuestionIndex);
    showToast("Question deleted.", "info");
  }
});

window.addEventListener("load", initialize);