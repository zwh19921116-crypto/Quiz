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

function renderQuiz(quizData) {
  activeQuiz = quizData;
  const quizContainer = document.getElementById("quizContainer");
  const quizTitle = document.getElementById("quizTitle");
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
  document.getElementById("submitQuizBtn").style.display = "inline-block";
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
  quizContainer.innerHTML = "<p>No quiz found. Waiting for data from embedding page...</p>";
  document.getElementById("submitQuizBtn").style.display = "none";

  window.addEventListener('message', (ev) => {
    try {
      const msg = ev.data;
      if (msg && msg.type === 'quiz-data' && msg.payload) {
        renderQuiz(msg.payload);
      }
    } catch (e) { /* ignore malformed messages */ }
  }, { once: false });
}

document.getElementById("submitQuizBtn").addEventListener("click", () => {
  if (!activeQuiz) return;

  let score = 0;

  activeQuiz.questions.forEach((q, qIndex) => {
    const selected = document.querySelector(`input[name="question-${qIndex}"]:checked`);
    if (selected && parseInt(selected.value, 10) === q.correctAnswer) {
      score++;
    }
  });

  document.getElementById("resultBox").textContent =
    `Your score: ${score} / ${activeQuiz.questions.length}`;
});

window.addEventListener("load", loadQuiz);