/* ── Helpers ────────────────────────────────────────────────── */

function gradeInfo(pct) {
  if (pct === 100) return { emoji: "🏆", grade: "Perfect Score!", msg: "Outstanding! You got every question right." };
  if (pct >= 80)  return { emoji: "🌟", grade: "Excellent",      msg: "Great job! You really know your stuff." };
  if (pct >= 60)  return { emoji: "👍", grade: "Good",           msg: "Well done! Keep reviewing to improve further." };
  if (pct >= 40)  return { emoji: "📖", grade: "Keep Studying",  msg: "Not bad — a bit more review and you'll nail it." };
  return                 { emoji: "💪", grade: "Keep Going",     msg: "Don't give up! Review the material and try again." };
}

/* ── Load & render quiz ─────────────────────────────────────── */
function loadQuiz() {
  const saved = localStorage.getItem("quizData");
  const quizContainer = document.getElementById("quizContainer");
  const submitRow     = document.getElementById("submitRow");
  const progressWrap  = document.getElementById("progressWrap");

  if (!saved) {
    quizContainer.innerHTML =
      "<p style='color:#6b7280;'>No quiz found. Please ask your teacher to create one in the Quiz Maker.</p>";
    return;
  }

  const quizData = JSON.parse(saved);
  document.getElementById("quizTitle").textContent = quizData.title || "Quiz";
  document.title = quizData.title || "Quiz";

  const total = quizData.questions.length;

  // Progress bar
  progressWrap.style.display = "block";
  document.getElementById("progressText").textContent = `${total} question${total > 1 ? "s" : ""}`;
  document.getElementById("progressPct").textContent  = "";
  document.getElementById("progressFill").style.width = "0%";

  quizContainer.innerHTML = "";

  quizData.questions.forEach((q, qIndex) => {
    const card = document.createElement("div");
    card.className = "question-card";
    card.id = `qcard-${qIndex}`;

    const letters = ["A","B","C","D"];
    card.innerHTML = `
      <p style="margin:0 0 12px;"><strong>Q${qIndex + 1}. ${escapeHtml(q.question)}</strong></p>
      ${q.options.map((option, oIndex) => `
        <div class="option-item" id="opt-${qIndex}-${oIndex}">
          <label>
            <input type="radio" name="question-${qIndex}" value="${oIndex}" />
            <strong>${letters[oIndex]}.</strong> ${escapeHtml(option)}
          </label>
        </div>
      `).join("")}
    `;

    quizContainer.appendChild(card);
  });

  // Track answered questions for progress bar
  quizData.questions.forEach((_, qIndex) => {
    const radios = document.querySelectorAll(`input[name="question-${qIndex}"]`);
    radios.forEach(r => r.addEventListener("change", updateProgress));
  });

  submitRow.style.display = "flex";
}

/* ── Update progress bar as user answers ───────────────────── */
function updateProgress() {
  const saved = localStorage.getItem("quizData");
  if (!saved) return;
  const quizData = JSON.parse(saved);
  const total    = quizData.questions.length;
  let answered   = 0;

  quizData.questions.forEach((_, i) => {
    if (document.querySelector(`input[name="question-${i}"]:checked`)) answered++;
  });

  const pct = Math.round((answered / total) * 100);
  document.getElementById("progressText").textContent = `${answered} / ${total} answered`;
  document.getElementById("progressPct").textContent  = `${pct}%`;
  document.getElementById("progressFill").style.width = `${pct}%`;
}

/* ── Submit quiz ────────────────────────────────────────────── */
document.getElementById("submitQuizBtn").addEventListener("click", () => {
  const saved = localStorage.getItem("quizData");
  if (!saved) return;

  const quizData = JSON.parse(saved);
  let score = 0;
  const letters = ["A","B","C","D"];

  quizData.questions.forEach((q, qIndex) => {
    const selected  = document.querySelector(`input[name="question-${qIndex}"]:checked`);
    const card      = document.getElementById(`qcard-${qIndex}`);
    const answered  = selected ? parseInt(selected.value, 10) : -1;
    const isCorrect = answered === q.correctAnswer;

    if (isCorrect) score++;

    // Colour the card
    card.classList.add(isCorrect ? "correct" : "incorrect");

    // Colour each option
    q.options.forEach((_, oIndex) => {
      const optDiv = document.getElementById(`opt-${qIndex}-${oIndex}`);
      if (oIndex === q.correctAnswer) {
        optDiv.classList.add("correct-opt");
      } else if (oIndex === answered && !isCorrect) {
        optDiv.classList.add("wrong-opt");
      }
    });

    // Disable all radio inputs for this question
    document.querySelectorAll(`input[name="question-${qIndex}"]`)
      .forEach(r => r.disabled = true);
  });

  // Hide submit button
  document.getElementById("submitRow").style.display = "none";

  // Show score card
  const total = quizData.questions.length;
  const pct   = Math.round((score / total) * 100);
  const info  = gradeInfo(pct);

  const resultBox = document.getElementById("resultBox");
  resultBox.style.display = "block";
  resultBox.innerHTML = `
    <div class="score-card">
      <div class="score-emoji">${info.emoji}</div>
      <div class="score-number">${score} / ${total}</div>
      <div class="score-label">${pct}% correct</div>
      <div class="score-grade">${info.grade}</div>
      <div class="score-msg">${info.msg}</div>
      <div class="score-retake">
        <button class="btn outline retake-btn">🔄 Retake Quiz</button>
      </div>
    </div>
  `;

  resultBox.querySelector(".retake-btn").addEventListener("click", retakeQuiz);
  resultBox.scrollIntoView({ behavior: "smooth", block: "start" });
});

/* ── Retake quiz ────────────────────────────────────────────── */
function retakeQuiz() {
  document.getElementById("resultBox").style.display = "none";
  document.getElementById("resultBox").innerHTML     = "";
  document.getElementById("quizContainer").innerHTML = "";
  document.getElementById("submitRow").style.display = "none";
  document.getElementById("progressWrap").style.display = "none";
  loadQuiz();
}

/* ── Init ───────────────────────────────────────────────────── */
window.addEventListener("load", loadQuiz);