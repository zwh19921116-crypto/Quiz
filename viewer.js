function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Accept base64 or URI-encoded JSON in the fragment
function decodeData(str) {
  try { return JSON.parse(decodeURIComponent(escape(atob(str)))); }
  catch (e) { try { return JSON.parse(decodeURIComponent(str)); } catch (e2) { return null; } }
}

function getQuizDataFromHash() {
  if (location.hash && location.hash.length > 1) {
    const hash = location.hash.slice(1);
    return decodeData(hash);
  }
  return null;
}

let activeQuiz = null;

function updateProgress() {
  if (!activeQuiz) return;
  const total = activeQuiz.questions.length;
  const answered = activeQuiz.questions.filter((_, i) =>
    document.querySelector(`input[name="question-${i}"]:checked`)
  ).length;
  const pct = total > 0 ? Math.round(answered / total * 100) : 0;
  const fill = document.getElementById("progressBarFill");
  const label = document.getElementById("progressLabel");
  if (fill) fill.style.width = pct + "%";
  if (label) label.textContent = `${answered} of ${total} answered`;
}

function renderQuiz(quizData) {
  activeQuiz = quizData;
  const quizContainer = document.getElementById("quizContainer");
  const quizTitleEl = document.getElementById("quizTitle");
  quizTitleEl.textContent = quizData.title || "Quiz Viewer";
  quizContainer.innerHTML = "";

  const resultBox = document.getElementById("resultBox");
  resultBox.className = "";
  resultBox.innerHTML = "";

  const progressEl = document.getElementById("quizProgress");
  if (progressEl) progressEl.style.display = "block";

  quizData.questions.forEach((q, qIndex) => {
    const card = document.createElement("div");
    card.className = "question-card";

    card.innerHTML = `
      <p><strong>Q${qIndex + 1}. ${escapeHtml(q.question)}</strong></p>
      ${q.options.map((option, oIndex) => `
        <div class="option-item">
          <label>
            <input type="radio" name="question-${qIndex}" value="${oIndex}" />
            ${escapeHtml(option)}
          </label>
        </div>
      `).join("")}
    `;

    quizContainer.appendChild(card);
  });

  // Update progress on any answer change
  quizContainer.addEventListener("change", updateProgress);
  updateProgress();

  const submitBtn = document.getElementById("submitQuizBtn");
  submitBtn.style.display = "inline-flex";
  submitBtn.textContent = "Submit Quiz";
}

function loadQuiz() {
  const hashQuiz = getQuizDataFromHash();
  if (hashQuiz) {
    renderQuiz(hashQuiz);
    return;
  }

  const saved = localStorage.getItem("quizData");
  if (saved) {
    try { renderQuiz(JSON.parse(saved)); return; } catch (e) { /* ignore */ }
  }

  // No data found: wait for postMessage from parent (embedding page)
  const quizContainer = document.getElementById("quizContainer");
  quizContainer.innerHTML = "<p style='color:var(--text-muted)'>No quiz found. Waiting for data from embedding page…</p>";
  document.getElementById("submitQuizBtn").style.display = "none";
  document.getElementById("quizProgress").style.display = "none";

  window.addEventListener("message", (ev) => {
    try {
      const msg = ev.data;
      if (msg && msg.type === "quiz-data" && msg.payload) {
        renderQuiz(msg.payload);
      }
    } catch (e) { /* ignore malformed messages */ }
  }, { once: false });
}

document.getElementById("submitQuizBtn").addEventListener("click", () => {
  if (!activeQuiz) return;

  let score = 0;
  const cards = document.querySelectorAll(".question-card");

  activeQuiz.questions.forEach((q, qIndex) => {
    const selected = document.querySelector(`input[name="question-${qIndex}"]:checked`);
    const card = cards[qIndex];

    const isCorrect = selected && parseInt(selected.value, 10) === q.correctAnswer;
    if (isCorrect) score++;

    // Disable all options for this question
    document.querySelectorAll(`input[name="question-${qIndex}"]`).forEach(inp => {
      inp.disabled = true;
    });

    // Highlight correct answer
    const correctInput = document.querySelector(`input[name="question-${qIndex}"][value="${q.correctAnswer}"]`);
    if (correctInput) correctInput.closest(".option-item").classList.add("option-correct");

    // Highlight wrong selection
    if (selected && !isCorrect) selected.closest(".option-item").classList.add("option-wrong");

    // Mark card
    if (card) card.classList.add(isCorrect ? "correct" : "incorrect");
  });

  const total = activeQuiz.questions.length;
  const pct = total > 0 ? Math.round(score / total * 100) : 0;
  const passed = pct >= 70;

  const resultBox = document.getElementById("resultBox");
  resultBox.innerHTML = `
    <div class="score-circle">
      <span>${pct}%</span>
      <span class="score-label">SCORE</span>
    </div>
    <div style="font-size:1.2rem;margin-bottom:6px">You scored <strong>${score} / ${total}</strong></div>
    <div style="font-size:0.95rem;color:inherit;opacity:0.8">${passed ? "🎉 Great job! Well done!" : "📚 Keep practising — you'll get there!"}</div>
    <div style="margin-top:20px">
      <button class="btn" onclick="retakeQuiz()">🔄 Retake Quiz</button>
    </div>
  `;
  resultBox.className = "show " + (passed ? "pass" : "fail");

  document.getElementById("submitQuizBtn").style.display = "none";

  // Scroll to result
  resultBox.scrollIntoView({ behavior: "smooth", block: "start" });
});

window.retakeQuiz = function() {
  if (activeQuiz) renderQuiz(activeQuiz);
};

window.addEventListener("load", loadQuiz);