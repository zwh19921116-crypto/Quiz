const MAKER_PASSWORD = "zwh52cd8e"; // change this to a stronger password
let folderDB = {
  name: "root",
  folders: [],
  quizzes: [] // {title, questions}
};
let currentFolder = folderDB;
let questions = [];


function encodeData(obj) {
  try { return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))); }
  catch (e) { return encodeURIComponent(JSON.stringify(obj)); }
}

function decodeData(str) {
  try { return JSON.parse(decodeURIComponent(escape(atob(str)))); }
  catch (e) { try { return JSON.parse(decodeURIComponent(str)); } catch (e2) { return null; } }
}


function authenticate(password) {
  if (password === MAKER_PASSWORD) {
    sessionStorage.setItem("makerAuth", "true");
    const overlay = document.getElementById("loginOverlay");
    const main = document.getElementById("mainContainer");
    if (overlay) overlay.style.display = "none";
    if (main) main.style.display = "";
    // initialize after auth
    initFromStorage();
    setupEventListeners();
    return true;
  }
  return false;
}

document.addEventListener("DOMContentLoaded", () => {
  const loginBtn = document.getElementById("makerLoginBtn");
  if (loginBtn) {
    loginBtn.addEventListener("click", () => {
      const pw = document.getElementById("makerPasswordInput").value || "";
      if (!authenticate(pw)) {
        alert("Incorrect password.");
      }
    });
    const pwInput = document.getElementById("makerPasswordInput");
    if (pwInput) {
      pwInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") loginBtn.click();
      });
    }
  }

  // If already authenticated in session, show main UI immediately
  if (sessionStorage.getItem("makerAuth") === "true") {
    const overlay = document.getElementById("loginOverlay");
    const main = document.getElementById("mainContainer");
    if (overlay) overlay.style.display = "none";
    if (main) main.style.display = "";
    initFromStorage();
    setupEventListeners();
  }
});

function renderFolderTree() {
  const treeDiv = document.getElementById("folderTree");
  if (!treeDiv) return;
  function renderNode(node, path) {
    let html = `<div style='margin-left:${path.length*16}px'>
      <span class='folder' data-path='${path.join("/")}' style='cursor:pointer;font-weight:${currentFolder===node?"bold":"normal"}'>📁 ${node.name}</span>
      <button class='btn' style='padding:2px 6px;font-size:0.8em' onclick='window.selectFolderForQuiz && window.selectFolderForQuiz([${path.map(p=>`"${p}"`).join(",")}])'>Select</button>
    </div>`;
    node.folders.forEach((f,i)=>{ html += renderNode(f, path.concat([i])); });
    node.quizzes.forEach((q,qi)=>{
      html += `<div style='margin-left:${(path.length+1)*16}px'>📝 ${q.title}</div>`;
    });
    return html;
  }
  treeDiv.innerHTML = renderNode(folderDB, []);
}

window.selectFolderForQuiz = function(pathArr) {
  let node = folderDB;
  for(const idx of pathArr) node = node.folders[idx];
  currentFolder = node;
  renderFolderTree();
  renderQuestions();
}

function renderQuestions() {
  // Show quizzes in current folder
  const questionsList = document.getElementById("questionsList");
  questionsList.innerHTML = "";
  if (!currentFolder.quizzes.length) {
    questionsList.innerHTML = "<p>No quizzes in this folder.</p>";
    return;
  }
  currentFolder.quizzes.forEach((quiz, idx) => {
    const div = document.createElement("div");
    div.className = "question-card";
    div.innerHTML = `<strong>${quiz.title}</strong> <button class='btn' onclick='window.loadQuizToEditor(${idx})'>Edit</button>`;
    questionsList.appendChild(div);
  });
}

window.loadQuizToEditor = function(idx) {
  const quiz = currentFolder.quizzes[idx];
  document.getElementById("quizTitle").value = quiz.title;
  questions = quiz.questions.map(q=>({...q}));
  renderQuestions();
}

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

function setupEventListeners() {
  document.getElementById("addFolderBtn").addEventListener("click", () => {
    const name = prompt("Folder name?");
    if (!name) return;
    currentFolder.folders.push({name, folders:[], quizzes:[]});
    renderFolderTree();
  });
  document.getElementById("moveQuizBtn").addEventListener("click", () => {
    // Simple move: move last quiz to root for demo
    if (!currentFolder.quizzes.length) return alert("No quiz to move");
    const quiz = currentFolder.quizzes.pop();
    folderDB.quizzes.push(quiz);
    renderFolderTree();
  });

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
    // Save quiz to current folder
    const quizTitle = document.getElementById("quizTitle").value.trim() || "Untitled Quiz";
    const quizData = { title: quizTitle, questions: questions.map(q=>({...q})) };
    // If editing, replace; else, add
    const idx = currentFolder.quizzes.findIndex(q=>q.title===quizTitle);
    if(idx>-1) currentFolder.quizzes[idx]=quizData;
    else currentFolder.quizzes.push(quizData);
    renderFolderTree();
    renderQuestions();
  });
    const quizTitle = document.getElementById("quizTitle").value.trim() || "Untitled Quiz";

    const quizData = {
      title: quizTitle,
      questions
    };

    localStorage.setItem("quizData", JSON.stringify(quizData));
    alert("Quiz saved.");

    const viewerBase = `${window.location.origin}${window.location.pathname.replace("maker.html", "viewer.html")}`;
    const encoded = encodeData(quizData);
    const viewerUrlWithHash = `${viewerBase}#${encoded}`;
    const fragIframe = `<iframe src="${viewerUrlWithHash}" width="100%" height="600" frameborder="0"></iframe>`;
    const postMessageSnippet = `<script>(function(){\n  const quiz = ${JSON.stringify(quizData)};\n  const iframe = document.createElement('iframe');\n  iframe.src = '${viewerBase}';\n  iframe.width = '100%'; iframe.height = '600'; iframe.frameBorder = 0;\n  document.body.appendChild(iframe);\n  iframe.onload = () => iframe.contentWindow.postMessage({type:'quiz-data', payload: quiz}, '*');\n})();</script>`;
    document.getElementById("embedLink").value = viewerBase;
    document.getElementById("iframeCode").value = postMessageSnippet + "\n\n<!-- Alternative (URL fragment): -->\n" + fragIframe;
  });

  document.getElementById("exportQuizBtn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(folderDB, null, 2)], {type: 'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `quiz_database.json`;
    a.click();
  });

  document.getElementById("importQuizBtn").addEventListener("click", () => {
    document.getElementById("importQuizInput").click();
  });

  document.getElementById("importQuizInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(evt) {
      try {
        const data = JSON.parse(evt.target.result);
        if(data.folders && data.quizzes) {
          folderDB = data;
          currentFolder = folderDB;
          renderFolderTree();
          renderQuestions();
          alert("Database imported!");
        } else {
          alert("Invalid database file.");
        }
      } catch (err) {
        alert("Invalid JSON file.");
      }
    };
    reader.readAsText(file);
  });

  document.getElementById("clearQuizBtn").addEventListener("click", () => {
    questions = [];
    document.getElementById("quizTitle").value = "";
    renderQuestions();
  });
    if (!confirm("Clear current quiz?")) return;

    questions = [];
    document.getElementById("quizTitle").value = "";
    localStorage.removeItem("quizData");
    renderQuestions();
    document.getElementById("embedLink").value = "";
    document.getElementById("iframeCode").value = "";
  });
}

function initFromStorage() {
  renderFolderTree();
  renderQuestions();

  const saved = localStorage.getItem("quizData");
  if (saved) {
    const quizData = JSON.parse(saved);
    document.getElementById("quizTitle").value = quizData.title || "";
    questions = quizData.questions || [];
    renderQuestions();

    const viewerBase = `${window.location.origin}${window.location.pathname.replace("maker.html", "viewer.html")}`;
    const viewerQuizData = { title: document.getElementById("quizTitle").value.trim() || "Untitled Quiz", questions };
    const encoded = encodeData(viewerQuizData);
    const viewerUrlWithHash = `${viewerBase}#${encoded}`;
    const fragIframe = `<iframe src="${viewerUrlWithHash}" width="100%" height="600" frameborder="0"></iframe>`;
    const postMessageSnippet = `<script>(function(){\n  const quiz = ${JSON.stringify(viewerQuizData)};\n  const iframe = document.createElement('iframe');\n  iframe.src = '${viewerBase}';\n  iframe.width = '100%'; iframe.height = '600'; iframe.frameBorder = 0;\n  document.body.appendChild(iframe);\n  iframe.onload = () => iframe.contentWindow.postMessage({type:'quiz-data', payload: quiz}, '*');\n})();</script>`;
    document.getElementById("embedLink").value = viewerBase;
    document.getElementById("iframeCode").value = postMessageSnippet + "\n\n<!-- Alternative (URL fragment): -->\n" + fragIframe;
  }
}