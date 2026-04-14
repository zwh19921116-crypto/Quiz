let questions = [];
let editingIndex = null;

/* ── Toast helper ──────────────────────────────────────────── */
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2400);
}

/* ── Render the question list ──────────────────────────────── */
function renderQuestions() {
  const list = document.getElementById("questionsList");
  const countEl = document.getElementById("questionCount");
  countEl.textContent = questions.length
    ? `(${questions.length} question${questions.length > 1 ? "s" : ""})`
    : "";

  if (questions.length === 0) {
    list.innerHTML = "<p style='color:#6b7280;'>No questions added yet.</p>";
    return;
  }

  list.innerHTML = "";
  const letters = ["A", "B", "C", "D"];

  questions.forEach((q, index) => {
    const div = document.createElement("div");
    div.className = "question-card";

    div.innerHTML = `
      <div class="q-header">
        <strong>Q${index + 1}. ${escapeHtml(q.question)}</strong>
        <div class="q-actions">
          <button class="btn outline" data-action="edit" data-index="${index}">✏️ Edit</button>
          <button class="btn danger"  data-action="delete" data-index="${index}">🗑️</button>
        </div>
      </div>
      <ul style="margin:10px 0 4px;padding-left:20px;">
        ${q.options.map((opt, i) => `
          <li style="${i === q.correctAnswer ? "font-weight:700;color:#15803d;" : ""}">
            ${letters[i]}. ${escapeHtml(opt)}${i === q.correctAnswer ? " ✅" : ""}
          </li>
        `).join("")}
      </ul>
    `;

    list.appendChild(div);
  });
}

/* ── Start editing a question ──────────────────────────────── */
function startEdit(index) {
  const q = questions[index];
  document.getElementById("questionText").value = q.question;
  document.getElementById("option1").value = q.options[0];
  document.getElementById("option2").value = q.options[1];
  document.getElementById("option3").value = q.options[2];
  document.getElementById("option4").value = q.options[3];
  document.getElementById("correctAnswer").value = String(q.correctAnswer);
  editingIndex = index;
  const btn = document.getElementById("addQuestionBtn");
  btn.textContent = "💾 Update Question";
  btn.classList.add("secondary");
  document.getElementById("questionText").focus();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function cancelEdit() {
  editingIndex = null;
  clearForm();
  const btn = document.getElementById("addQuestionBtn");
  btn.textContent = "➕ Add Question";
  btn.classList.remove("secondary");
}

function clearForm() {
  document.getElementById("questionText").value = "";
  document.getElementById("option1").value = "";
  document.getElementById("option2").value = "";
  document.getElementById("option3").value = "";
  document.getElementById("option4").value = "";
  document.getElementById("correctAnswer").value = "0";
}

/* ── Delete a question ─────────────────────────────────────── */
function deleteQuestion(index) {
  if (!confirm("Delete this question?")) return;
  questions.splice(index, 1);
  if (editingIndex === index) cancelEdit();
  renderQuestions();
  showToast("Question deleted.");
}

/* ── Add / Update question ─────────────────────────────────── */
document.getElementById("addQuestionBtn").addEventListener("click", () => {
  const question = document.getElementById("questionText").value.trim();
  const option1  = document.getElementById("option1").value.trim();
  const option2  = document.getElementById("option2").value.trim();
  const option3  = document.getElementById("option3").value.trim();
  const option4  = document.getElementById("option4").value.trim();
  const correctAnswer = parseInt(document.getElementById("correctAnswer").value, 10);

  if (!question || !option1 || !option2 || !option3 || !option4) {
    showToast("⚠️ Please fill in all fields.");
    return;
  }

  const entry = { question, options: [option1, option2, option3, option4], correctAnswer };

  if (editingIndex !== null) {
    questions[editingIndex] = entry;
    showToast("Question updated!");
    cancelEdit();
  } else {
    questions.push(entry);
    showToast("Question added!");
    clearForm();
  }

  renderQuestions();
});

/* ── Save & Publish quiz ───────────────────────────────────── */
document.getElementById("saveQuizBtn").addEventListener("click", () => {
  if (questions.length === 0) {
    showToast("⚠️ Add at least one question first.");
    return;
  }

  const quizTitle = document.getElementById("quizTitle").value.trim() || "Untitled Quiz";
  const quizData  = { title: quizTitle, questions };

  localStorage.setItem("quizData", JSON.stringify(quizData));

  const viewerUrl = `${window.location.origin}${window.location.pathname.replace("maker.html", "viewer.html")}`;
  document.getElementById("embedLink").value = viewerUrl;
  document.getElementById("iframeCode").value =
    `<iframe src="${viewerUrl}" width="100%" height="700" frameborder="0" allowfullscreen></iframe>`;

  showToast("✅ Quiz saved!");
});

/* ── Clear quiz ────────────────────────────────────────────── */
document.getElementById("clearQuizBtn").addEventListener("click", () => {
  if (!confirm("Clear the entire quiz? This cannot be undone.")) return;
  questions = [];
  editingIndex = null;
  document.getElementById("quizTitle").value = "";
  localStorage.removeItem("quizData");
  clearForm();
  renderQuestions();
  document.getElementById("embedLink").value = "";
  document.getElementById("iframeCode").value = "";
  showToast("Quiz cleared.");
});

/* ── Load on page open ─────────────────────────────────────── */
window.addEventListener("load", () => {
  // Event delegation for Edit / Delete buttons in the questions list
  document.getElementById("questionsList").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const index = parseInt(btn.dataset.index, 10);
    if (btn.dataset.action === "edit")   startEdit(index);
    if (btn.dataset.action === "delete") deleteQuestion(index);
  });

  const saved = localStorage.getItem("quizData");
  if (saved) {
    const quizData = JSON.parse(saved);
    document.getElementById("quizTitle").value = quizData.title || "";
    questions = quizData.questions || [];
    renderQuestions();

    const viewerUrl = `${window.location.origin}${window.location.pathname.replace("maker.html", "viewer.html")}`;
    document.getElementById("embedLink").value = viewerUrl;
    document.getElementById("iframeCode").value =
      `<iframe src="${viewerUrl}" width="100%" height="700" frameborder="0" allowfullscreen></iframe>`;
  } else {
    renderQuestions();
  }
});