let questions = [];

function renderQuestions() {
  const questionsList = document.getElementById("questionsList");
  questionsList.innerHTML = "";

  if (questions.length === 0) {
    questionsList.innerHTML = "<p>No questions added yet.</p>";
    return;
  }

  questions.forEach((q, index) => {
    const div = document.createElement("div");
    div.className = "question-card";

    div.innerHTML = `
      <strong>Q${index + 1}: ${q.question}</strong>
      <ul>
        ${q.options.map((opt, i) => `
          <li>${opt} ${i === q.correctAnswer ? "✅" : ""}</li>
        `).join("")}
      </ul>
      <button class="btn danger" onclick="deleteQuestion(${index})">Delete</button>
    `;

    questionsList.appendChild(div);
  });
}

function deleteQuestion(index) {
  questions.splice(index, 1);
  renderQuestions();
}

document.getElementById("addQuestionBtn").addEventListener("click", () => {
  const question = document.getElementById("questionText").value.trim();
  const option1 = document.getElementById("option1").value.trim();
  const option2 = document.getElementById("option2").value.trim();
  const option3 = document.getElementById("option3").value.trim();
  const option4 = document.getElementById("option4").value.trim();
  const correctAnswer = parseInt(document.getElementById("correctAnswer").value, 10);

  if (!question || !option1 || !option2 || !option3 || !option4) {
    alert("Please fill in all fields.");
    return;
  }

  questions.push({
    question,
    options: [option1, option2, option3, option4],
    correctAnswer
  });

  document.getElementById("questionText").value = "";
  document.getElementById("option1").value = "";
  document.getElementById("option2").value = "";
  document.getElementById("option3").value = "";
  document.getElementById("option4").value = "";
  document.getElementById("correctAnswer").value = "0";

  renderQuestions();
});

document.getElementById("saveQuizBtn").addEventListener("click", () => {
  const quizTitle = document.getElementById("quizTitle").value.trim() || "Untitled Quiz";

  const quizData = {
    title: quizTitle,
    questions
  };

  localStorage.setItem("quizData", JSON.stringify(quizData));
  alert("Quiz saved.");

  const viewerUrl = `${window.location.origin}${window.location.pathname.replace("maker.html", "viewer.html")}`;
  document.getElementById("embedLink").value = viewerUrl;
  document.getElementById("iframeCode").value =
    `<iframe src="${viewerUrl}" width="100%" height="600" frameborder="0"></iframe>`;
});

document.getElementById("clearQuizBtn").addEventListener("click", () => {
  if (!confirm("Clear current quiz?")) return;

  questions = [];
  document.getElementById("quizTitle").value = "";
  localStorage.removeItem("quizData");
  renderQuestions();
  document.getElementById("embedLink").value = "";
  document.getElementById("iframeCode").value = "";
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
  }
});