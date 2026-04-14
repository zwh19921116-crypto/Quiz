let questions = [];

function getQuizData() {
  const title = document.getElementById("quizTitle").value.trim() || "Untitled Quiz";
  return {
    title,
    questions
  };
}

function updateGeneratedJson() {
  const jsonBox = document.getElementById("generatedJson");
  jsonBox.value = JSON.stringify(getQuizData(), null, 2);
}

function clearQuestionForm() {
  document.getElementById("questionText").value = "";
  document.getElementById("option1").value = "";
  document.getElementById("option2").value = "";
  document.getElementById("option3").value = "";
  document.getElementById("option4").value = "";
  document.getElementById("correctAnswer").value = "0";
}

function renderQuestions() {
  const questionsList = document.getElementById("questionsList");
  questionsList.innerHTML = "";

  if (questions.length === 0) {
    questionsList.innerHTML = "<p>No questions added yet.</p>";
    updateGeneratedJson();
    return;
  }

  questions.forEach((q, index) => {
    const div = document.createElement("div");
    div.className = "question-card";

    div.innerHTML = `
      <strong>Q${index + 1}: ${q.question}</strong>
      <ul>
        ${q.options.map((opt, i) => `
          <li>${opt}${i === q.correctAnswer ? " ✅" : ""}</li>
        `).join("")}
      </ul>
      <button class="btn danger" data-index="${index}">Delete</button>
    `;

    const deleteBtn = div.querySelector("button");
    deleteBtn.addEventListener("click", () => {
      questions.splice(index, 1);
      renderQuestions();
    });

    questionsList.appendChild(div);
  });

  updateGeneratedJson();
}

document.getElementById("addQuestionBtn").addEventListener("click", () => {
  const question = document.getElementById("questionText").value.trim();
  const option1 = document.getElementById("option1").value.trim();
  const option2 = document.getElementById("option2").value.trim();
  const option3 = document.getElementById("option3").value.trim();
  const option4 = document.getElementById("option4").value.trim();
  const correctAnswer = parseInt(document.getElementById("correctAnswer").value, 10);
  const options = [option1, option2, option3, option4];

  if (!question || options.some((opt) => !opt)) {
    alert("Please fill in question and all 4 options.");
    return;
  }

  questions.push({
    question,
    options,
    correctAnswer
  });

  clearQuestionForm();
  renderQuestions();
});

document.getElementById("downloadQuizBtn").addEventListener("click", () => {
  const json = JSON.stringify(getQuizData(), null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = "quiz-database.json";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
});

document.getElementById("copyJsonBtn").addEventListener("click", async () => {
  const json = JSON.stringify(getQuizData(), null, 2);

  try {
    await navigator.clipboard.writeText(json);
    alert("JSON copied.");
  } catch (error) {
    alert("Could not copy JSON. Please copy from the Generated JSON box.");
  }
});

document.getElementById("clearQuizBtn").addEventListener("click", () => {
  if (!confirm("Clear current quiz?")) return;

  questions = [];
  document.getElementById("quizTitle").value = "";
  clearQuestionForm();
  renderQuestions();
});

document.getElementById("importQuizFile").addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);

    if (!Array.isArray(data.questions)) {
      throw new Error("Invalid quiz file");
    }

    document.getElementById("quizTitle").value = data.title || "";
    questions = data.questions;
    renderQuestions();
  } catch (error) {
    alert("Invalid JSON file. Please choose a valid quiz-database.json file.");
  }

  event.target.value = "";
});

document.getElementById("quizTitle").addEventListener("input", updateGeneratedJson);

window.addEventListener("load", () => {
  renderQuestions();
});