let questions = [];

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function showToast(message, type) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = 'toast' + (type ? ' ' + type : '') + ' show';
  setTimeout(() => { toast.className = 'toast' + (type ? ' ' + type : ''); }, 3000);
}

function updateCountBadge() {
  const badge = document.getElementById('questionCountBadge');
  if (badge) badge.textContent = `${questions.length} question${questions.length !== 1 ? 's' : ''}`;
}

function renderQuestions() {
  const questionsList = document.getElementById("questionsList");
  questionsList.innerHTML = "";
  updateCountBadge();

  if (questions.length === 0) {
    questionsList.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📭</div>
        <p>No questions added yet. Add your first question above.</p>
      </div>
    `;
    return;
  }

  const letters = ['A', 'B', 'C', 'D'];
  questions.forEach((q, index) => {
    const div = document.createElement("div");
    div.className = "maker-question-card";
    div.innerHTML = `
      <div class="maker-question-content">
        <div class="maker-question-num">Q${index + 1}</div>
        <div class="maker-question-text">${escapeHtml(q.question)}</div>
        <div class="maker-question-options">
          ${q.options.map((opt, i) => `
            <span class="${i === q.correctAnswer ? 'correct-option' : 'wrong-option'}">${letters[i]}. ${escapeHtml(opt)}</span>
          `).join('')}
        </div>
      </div>
      <button class="btn btn-ghost" onclick="deleteQuestion(${index})" title="Delete question" style="color:var(--danger); flex-shrink:0; font-size:1rem;">✕</button>
    `;
    questionsList.appendChild(div);
  });
}

function deleteQuestion(index) {
  questions.splice(index, 1);
  renderQuestions();
  showToast('Question removed.', 'error');
}

document.getElementById("addQuestionBtn").addEventListener("click", () => {
  const question = document.getElementById("questionText").value.trim();
  const option1 = document.getElementById("option1").value.trim();
  const option2 = document.getElementById("option2").value.trim();
  const option3 = document.getElementById("option3").value.trim();
  const option4 = document.getElementById("option4").value.trim();
  const correctAnswer = parseInt(document.getElementById("correctAnswer").value, 10);

  if (!question || !option1 || !option2 || !option3 || !option4) {
    showToast('Please fill in all fields.', 'error');
    return;
  }

  questions.push({ question, options: [option1, option2, option3, option4], correctAnswer });

  document.getElementById("questionText").value = "";
  document.getElementById("option1").value = "";
  document.getElementById("option2").value = "";
  document.getElementById("option3").value = "";
  document.getElementById("option4").value = "";
  document.getElementById("correctAnswer").value = "0";

  renderQuestions();
  showToast(`Question ${questions.length} added! ✓`, 'success');
  document.getElementById("questionText").focus();
});

document.getElementById("saveQuizBtn").addEventListener("click", () => {
  if (questions.length === 0) {
    showToast('Add at least one question before saving.', 'error');
    return;
  }

  const quizTitle = document.getElementById("quizTitle").value.trim() || "Untitled Quiz";
  const quizData = { title: quizTitle, questions };
  localStorage.setItem("quizData", JSON.stringify(quizData));

  const viewerUrl = `${window.location.origin}${window.location.pathname.replace("maker.html", "viewer.html")}`;
  document.getElementById("embedLink").value = viewerUrl;
  document.getElementById("iframeCode").value =
    `<iframe src="${viewerUrl}" width="100%" height="600" frameborder="0"></iframe>`;

  showToast('Quiz saved successfully! 🎉', 'success');
});

document.getElementById("clearQuizBtn").addEventListener("click", () => {
  if (!confirm("Clear all questions and reset the quiz?")) return;

  questions = [];
  document.getElementById("quizTitle").value = "";
  localStorage.removeItem("quizData");
  renderQuestions();
  document.getElementById("embedLink").value = "";
  document.getElementById("iframeCode").value = "";
  showToast('Quiz cleared.', 'info');
});

window.addEventListener("load", () => {
  const saved = localStorage.getItem("quizData");
  if (saved) {
    const quizData = JSON.parse(saved);
    document.getElementById("quizTitle").value = quizData.title || "";
    questions = quizData.questions || [];
    renderQuestions();

    const viewerUrl = `${window.location.origin}${window.location.pathname.replace("maker.html", "viewer.html")}`;
    document.getElementById("embedLink").value = viewerUrl;
    document.getElementById("iframeCode").value =
      `<iframe src="${viewerUrl}" width="100%" height="600" frameborder="0"></iframe>`;
  } else {
    renderQuestions();
  }
});