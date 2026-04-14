let quizData = null;
let currentQuestion = 0;
let answers = [];

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const SCREENS = ['welcomeScreen', 'quizScreen', 'resultScreen', 'noQuizScreen'];

function showScreen(id) {
  SCREENS.forEach(s => {
    document.getElementById(s).style.display = (s === id) ? 'block' : 'none';
  });
}

function loadQuiz() {
  const saved = localStorage.getItem("quizData");
  if (!saved) { showScreen('noQuizScreen'); return; }

  quizData = JSON.parse(saved);
  if (!quizData.questions || quizData.questions.length === 0) {
    showScreen('noQuizScreen');
    return;
  }

  answers = new Array(quizData.questions.length).fill(null);
  document.getElementById("welcomeTitle").textContent = quizData.title || "Quiz";
  document.getElementById("questionCount").textContent = quizData.questions.length;
  showScreen('welcomeScreen');
}

function showQuestion(index) {
  const q = quizData.questions[index];
  const total = quizData.questions.length;
  const progress = Math.round((index / total) * 100);
  const letters = ['A', 'B', 'C', 'D'];

  document.getElementById("progressLabel").textContent = `Question ${index + 1} of ${total}`;
  document.getElementById("progressPercent").textContent = `${progress}%`;
  document.getElementById("progressFill").style.width = `${progress}%`;
  document.getElementById("questionNumber").textContent = `QUESTION ${index + 1}`;
  document.getElementById("questionText").textContent = q.question;

  const optionsContainer = document.getElementById("optionsContainer");
  optionsContainer.innerHTML = q.options.map((option, i) => `
    <div class="option-item">
      <div class="option-label${answers[index] === i ? ' selected' : ''}" data-index="${i}">
        <span class="option-marker">${letters[i]}</span>
        <span>${escapeHtml(option)}</span>
      </div>
    </div>
  `).join('');

  optionsContainer.querySelectorAll('.option-label').forEach(el => {
    el.addEventListener('click', () => selectOption(parseInt(el.dataset.index, 10)));
  });

  const isLast = index === total - 1;
  const answered = answers[index] !== null;
  document.getElementById("nextBtn").style.display   = (!isLast && answered) ? 'inline-flex' : 'none';
  document.getElementById("submitBtn").style.display = (isLast && answered)  ? 'inline-flex' : 'none';

  // Re-trigger animation
  const card = document.getElementById("questionCard");
  card.classList.remove('slide-in');
  void card.offsetWidth;
  card.classList.add('slide-in');

  showScreen('quizScreen');
}

function selectOption(optionIndex) {
  answers[currentQuestion] = optionIndex;
  showQuestion(currentQuestion);
}

function showResults() {
  let score = 0;
  quizData.questions.forEach((q, i) => {
    if (answers[i] === q.correctAnswer) score++;
  });

  const total = quizData.questions.length;
  const percent = Math.round((score / total) * 100);

  document.getElementById("scorePercent").textContent = `${percent}%`;
  document.getElementById("resultSubtitle").textContent =
    `You answered ${score} out of ${total} questions correctly.`;

  let title;
  if (percent >= 90)      title = "Excellent! 🌟";
  else if (percent >= 70) title = "Great Job! 👏";
  else if (percent >= 50) title = "Good Effort! 💪";
  else                    title = "Keep Practicing! 📚";
  document.getElementById("resultTitle").textContent = title;

  showScreen('resultScreen');
}

function startQuiz() {
  currentQuestion = 0;
  answers = new Array(quizData.questions.length).fill(null);
  showQuestion(0);
}

document.getElementById("startQuizBtn").addEventListener("click", startQuiz);

document.getElementById("nextBtn").addEventListener("click", () => {
  if (currentQuestion < quizData.questions.length - 1) {
    currentQuestion++;
    showQuestion(currentQuestion);
  }
});

document.getElementById("submitBtn").addEventListener("click", showResults);

document.getElementById("retakeBtn").addEventListener("click", startQuiz);

window.addEventListener("load", loadQuiz);