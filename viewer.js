function loadQuiz() {
  const saved = localStorage.getItem("quizData");
  const quizContainer = document.getElementById("quizContainer");
  const quizTitle = document.getElementById("quizTitle");

  if (!saved) {
    quizContainer.innerHTML = "<p>No quiz found. Please create one in Quiz Maker.</p>";
    document.getElementById("submitQuizBtn").style.display = "none";
    return;
  }

  const quizData = JSON.parse(saved);
  quizTitle.textContent = quizData.title || "Quiz Viewer";

  quizContainer.innerHTML = "";

  quizData.questions.forEach((q, qIndex) => {
    const card = document.createElement("div");
    card.className = "question-card";

    card.innerHTML = `
      <p><strong>Q${qIndex + 1}. ${q.question}</strong></p>
      ${q.options.map((option, oIndex) => `
        <div class="option-item">
          <label>
            <input type="radio" name="question-${qIndex}" value="${oIndex}" />
            ${option}
          </label>
        </div>
      `).join("")}
    `;

    quizContainer.appendChild(card);
  });
}

document.getElementById("submitQuizBtn").addEventListener("click", () => {
  const saved = localStorage.getItem("quizData");
  if (!saved) return;

  const quizData = JSON.parse(saved);
  let score = 0;

  quizData.questions.forEach((q, qIndex) => {
    const selected = document.querySelector(`input[name="question-${qIndex}"]:checked`);
    if (selected && parseInt(selected.value, 10) === q.correctAnswer) {
      score++;
    }
  });

  document.getElementById("resultBox").textContent =
    `Your score: ${score} / ${quizData.questions.length}`;
});

window.addEventListener("load", loadQuiz);