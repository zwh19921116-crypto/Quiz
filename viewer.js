const DATABASE_FILE = "quiz-database.json?v=20260415-3";

let quizData = null;
let currentIndex = 0;
let score = 0;
let answerChecked = false;

function setError(message) {
  document.getElementById("quizContainer").innerHTML = `<p>${message}</p>`;
  document.getElementById("checkAnswerBtn").style.display = "none";
  document.getElementById("nextQuestionBtn").style.display = "none";
}

function updateHeader() {
  const total = quizData.questions.length;
  document.getElementById("progressText").textContent = `Question ${currentIndex + 1} of ${total}`;
  document.getElementById("scoreText").textContent = `Score: ${score}`;
}

function renderQuestion() {
  const question = quizData.questions[currentIndex];
  const quizContainer = document.getElementById("quizContainer");
  const solutionBox = document.getElementById("solutionBox");
  const resultBox = document.getElementById("resultBox");
  const nextBtn = document.getElementById("nextQuestionBtn");

  answerChecked = false;
  resultBox.textContent = "";
  solutionBox.classList.add("hidden");
  solutionBox.textContent = "";
  nextBtn.disabled = true;
  nextBtn.textContent = currentIndex === quizData.questions.length - 1 ? "Finish Quiz" : "Next Question";

  quizContainer.innerHTML = `
    <div class="question-card viewer-question">
      <p class="question-label">Question ${currentIndex + 1}</p>
      <h2>${question.question}</h2>
      <div class="options-list">
        ${question.options.map((option, optionIndex) => `
          <label class="option-item">
            <input type="radio" name="activeQuestion" value="${optionIndex}" />
            <span>${option}</span>
          </label>
        `).join("")}
      </div>
    </div>
  `;

  updateHeader();
}

function checkAnswer() {
  if (answerChecked) return;

  const question = quizData.questions[currentIndex];
  const selected = document.querySelector("input[name='activeQuestion']:checked");

  if (!selected) {
    alert("Please choose an answer before checking.");
    return;
  }

  const chosenIndex = parseInt(selected.value, 10);
  const isCorrect = chosenIndex === question.correctAnswer;
  const solutionText = question.solution || `Correct answer: ${question.options[question.correctAnswer]}`;

  if (isCorrect) {
    score += 1;
  }

  document.getElementById("resultBox").textContent = isCorrect ? "Correct." : "Not quite.";
  document.getElementById("solutionBox").textContent = `Solution: ${solutionText}`;
  document.getElementById("solutionBox").classList.remove("hidden");
  document.getElementById("nextQuestionBtn").disabled = false;
  answerChecked = true;

  updateHeader();
}

function goNext() {
  if (!answerChecked) return;

  if (currentIndex < quizData.questions.length - 1) {
    currentIndex += 1;
    renderQuestion();
    return;
  }

  const total = quizData.questions.length;
  document.getElementById("quizContainer").innerHTML = `
    <div class="question-card viewer-question final-card">
      <h2>Quiz Complete</h2>
      <p>Your final score is ${score} out of ${total}.</p>
      <button class="btn" id="restartBtn">Restart Quiz</button>
    </div>
  `;
  document.getElementById("solutionBox").classList.add("hidden");
  document.getElementById("resultBox").textContent = "";
  document.getElementById("checkAnswerBtn").style.display = "none";
  document.getElementById("nextQuestionBtn").style.display = "none";
  document.getElementById("progressText").textContent = "Complete";
  document.getElementById("scoreText").textContent = `Final Score: ${score} / ${total}`;

  document.getElementById("restartBtn").addEventListener("click", () => {
    currentIndex = 0;
    score = 0;
    document.getElementById("checkAnswerBtn").style.display = "inline-block";
    document.getElementById("nextQuestionBtn").style.display = "inline-block";
    renderQuestion();
  });
}

async function loadQuiz() {
  try {
    const response = await fetch(DATABASE_FILE, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("load failed");
    }
    quizData = await response.json();
  } catch (error) {
    setError("Could not load quiz database file.");
    return;
  }

  if (!quizData || !Array.isArray(quizData.questions) || quizData.questions.length === 0) {
    setError("No quiz questions found in database file.");
    return;
  }

  document.getElementById("quizTitle").textContent = quizData.title || "Quiz Viewer";
  renderQuestion();
}

document.getElementById("checkAnswerBtn").addEventListener("click", checkAnswer);
document.getElementById("nextQuestionBtn").addEventListener("click", goNext);

window.addEventListener("load", loadQuiz);