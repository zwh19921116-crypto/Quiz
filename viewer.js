const DATABASE_FILE = "quiz-database.json?v=20260415-2";

async function loadQuiz() {
  const quizContainer = document.getElementById("quizContainer");
  const quizTitle = document.getElementById("quizTitle");
  const submitBtn = document.getElementById("submitQuizBtn");

  let quizData;

  try {
    const response = await fetch(DATABASE_FILE, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to load ${DATABASE_FILE}`);
    }
    quizData = await response.json();
  } catch (error) {
    quizContainer.innerHTML = "<p>Could not load quiz database file.</p>";
    submitBtn.style.display = "none";
    return;
  }

  if (!quizData || !Array.isArray(quizData.questions) || quizData.questions.length === 0) {
    quizContainer.innerHTML = "<p>No quiz questions found in database file.</p>";
    submitBtn.style.display = "none";
    return;
  }

  window.currentQuizData = quizData;

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
  const quizData = window.currentQuizData;
  if (!quizData || !Array.isArray(quizData.questions)) return;

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